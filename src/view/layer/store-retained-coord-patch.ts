// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Incremental update of the coordinate texture of a retained line chunk
 *
 * A vertex drag moves only a few vertices. Rebuilding a line chunk with many vertices every frame
 * would overflow the frame, so the diff of the vertices that moved is queued on the chunk and,
 * right before drawing, only the corresponding texels of the coordinate texture are rewritten
 * (see SDFLineRenderer.patchRetainedBatchCoords).
 */

import { coordinatesOf } from '../../shared/utils/coordinates.js';
import type { Coordinate, Feature } from '../../store/types.js';
import type { RetainedLineBatch } from '../renderers/line/line-types.js';
import type { SDFLineRenderer } from '../renderers/line/sdf-line.js';
import type { RetainedLineRenderer } from '../renderers/retained.js';
import { type ChunkBBox, expandBBox } from './store-retained-bbox.js';

/**
 * Upper limit of the number of vertices that one update may put into the incremental update of
 * the coordinate texture
 *
 * A change beyond this (moving vertices in bulk, cut and paste) rebuilds the whole chunk.
 * The incremental update targets the case where "one vertex drag moves only a few points".
 */
export const MAX_PATCHED_VERTICES = 8;

/**
 * Position of a feature within the coordinate texture of a line chunk
 */
export interface LineCoordSlot {
  /** Serial index of the first texel in the coordinate texture */
  offset: number;
  /** Number of vertices (this many are stored consecutively) */
  count: number;
}

/**
 * Diff of one vertex to write back into the coordinate texture
 */
export interface CoordPatch {
  coordIndex: number;
  lngLat: [number, number];
}

/**
 * A line renderer that supports partial updates of the coordinate texture
 *
 * It is not included in `RetainedLineRenderer` (renderers/retained.ts), so whether the
 * implementation is present is checked at runtime before it is used.
 */
export type LineCoordPatcher = Pick<SDFLineRenderer, 'patchRetainedBatchCoords'>;

/**
 * Extracts the line renderer if it supports partial updates of the coordinate texture
 */
export function asCoordPatcher(line: RetainedLineRenderer): LineCoordPatcher | null {
  const candidate = line as Partial<LineCoordPatcher>;
  return typeof candidate.patchRetainedBatchCoords === 'function'
    ? (candidate as LineCoordPatcher)
    : null;
}

/**
 * Computes the diff of a coordinate list (the indices of the vertices that moved)
 *
 * A vertex drag is an update where "the number of vertices is the same and only a few values
 * differ". Anything else (vertices added or removed, many of them moved) cannot be applied as a
 * diff, so null is returned.
 *
 * The comparison is done in a single pass. If the element references are the same, that vertex
 * has not moved (the Store reuses the arrays of the vertices it does not change). The values are
 * looked at only when the references differ.
 *
 * @param maxChanged Upper limit of the number of changed vertices allowed as a diff
 * @returns The indices of the vertices that moved (an empty array when none moved). null when
 *   the number of vertices differs or the upper limit is exceeded
 */
export function computeCoordinateDiff(
  prev: readonly Coordinate[],
  next: readonly Coordinate[],
  maxChanged: number,
): number[] | null {
  if (!Array.isArray(prev) || !Array.isArray(next)) return null;
  if (prev.length !== next.length) return null;

  const changed: number[] = [];

  for (let i = 0; i < next.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (a === b) continue;
    if (!a || !b) return null;
    if (a[0] === b[0] && a[1] === b[1]) continue;
    // Beyond the upper limit it is not handled as a diff
    if (changed.length >= maxChanged) return null;
    changed.push(i);
  }

  return changed;
}

/**
 * Computes the "feature → position in the coordinate texture" of a line chunk
 *
 * The coordinate texture is packed with the coordinates in the order of the items returned by
 * collectLineItems. Therefore this must count in the same order and with the same exclusion rule
 * as collectLineItems (fewer than 2 vertices are not pushed).
 *
 * Only the types where one feature becomes one item and the coordinate list goes in as it is
 * (LineString / Freehand) are recorded. A MultiLineString splits into several items and its
 * indices interleave, so it is not a target of the diff (only the coordinate count is advanced).
 */
export function computeLineCoordSlots(features: readonly Feature[]): Map<string, LineCoordSlot> {
  const slots = new Map<string, LineCoordSlot>();
  let offset = 0;

  for (const feature of features) {
    if (feature.type === 'MultiLineString') {
      for (const part of (coordinatesOf(feature) as Coordinate[][] | undefined) ?? []) {
        if (!part || part.length < 2) continue;
        offset += part.length;
      }
      continue;
    }

    const coords = coordinatesOf(feature) as Coordinate[] | undefined;
    if (!coords || coords.length < 2) continue;

    if (feature.type === 'LineString' || feature.type === 'Freehand') {
      slots.set(feature.id, { offset, count: coords.length });
    }
    offset += coords.length;
  }

  return slots;
}

/**
 * The part of a chunk that the incremental update reads and writes
 *
 * The chunk of the cache satisfies it structurally.
 */
export interface PatchableLineChunk {
  readonly kind: string;
  line: RetainedLineBatch | null;
  /** Whether a rebuild is needed (a dirty chunk takes no patches) */
  dirty: boolean;
  lineOffsets: Map<string, LineCoordSlot> | null;
  pendingCoordPatches: CoordPatch[] | null;
  bbox: ChunkBBox | null;
}

/**
 * Queues a vertex movement as a diff patch against the retained batch
 *
 * It can be queued only when all of the following hold. If even one of them fails, false is
 * returned and the caller rebuilds the whole chunk (rebuilding too much still renders
 * correctly).
 *
 * - A type whose coordinate list goes into the coordinate texture as one contiguous run
 *   (LineString / Freehand)
 * - No other item that affects the appearance (properties = the input of the style rules) has
 *   changed
 * - The number of vertices is unchanged and between 1 and MAX_PATCHED_VERTICES vertices moved
 * - The chunk it belongs to has a retained line batch and is not waiting for a rebuild
 * - The renderer used for drawing supports partial updates of the coordinate texture
 *
 * The drag being committed (up) does not trigger another rebuild. The patch queued by the last
 * movement becomes the committed value as it is.
 *
 * @param chunk The chunk that carries the feature (undefined when there is none)
 * @param line The line renderer used most recently (null before the first draw)
 */
export function queueCoordPatch(
  chunk: PatchableLineChunk | undefined,
  feature: Feature,
  previous: Feature,
  line: RetainedLineRenderer | null,
): boolean {
  if (feature.type !== 'LineString' && feature.type !== 'Freehand') return false;
  // properties is the input of the style rules, so a change there can change the color
  if (previous.properties !== feature.properties) return false;

  if (!chunk) return false;
  if (chunk.kind !== 'line' || !chunk.line || chunk.dirty || !chunk.lineOffsets) return false;

  const slot = chunk.lineOffsets.get(feature.id);
  if (!slot) return false;

  const coords = coordinatesOf(feature) as Coordinate[];
  // If the vertex count differs from when the index table was built, the positions of the
  // following features are off as well
  if (!Array.isArray(coords) || coords.length !== slot.count) return false;

  const changed = computeCoordinateDiff(
    coordinatesOf(previous) as Coordinate[],
    coords,
    MAX_PATCHED_VERTICES,
  );
  if (!changed) return false;
  // An update where no vertex moved (a change of locked, for example) is not treated as a diff;
  // the chunk is rebuilt as before (erring on the conservative side)
  if (changed.length === 0) return false;

  // With a renderer that has no partial update, a queued diff could never be applied
  if (!line || !asCoordPatcher(line)) return false;

  const patches = chunk.pendingCoordPatches ?? [];
  chunk.pendingCoordPatches = patches;

  for (const i of changed) {
    const coord = coords[i];
    patches.push({ coordIndex: slot.offset + i, lngLat: [coord[0], coord[1]] });
    chunk.bbox = expandBBox(chunk.bbox, coord);
  }

  return true;
}

/**
 * Applies the queued vertex diff to the coordinate texture
 *
 * It is not called for a chunk thinned away off-screen, but the patches stay queued, so they
 * are all applied on the first frame where the chunk comes into view.
 */
export function flushCoordPatches(chunk: PatchableLineChunk, line: RetainedLineRenderer): void {
  const patches = chunk.pendingCoordPatches;
  if (!patches || !chunk.line) return;
  chunk.pendingCoordPatches = null;

  const patcher = asCoordPatcher(line);
  if (!patcher) {
    // Safety net for the case where the renderer was swapped for one without partial updates.
    // This frame keeps the stale picture, but the next frame rebuilds it.
    chunk.dirty = true;
    return;
  }

  patcher.patchRetainedBatchCoords(chunk.line, patches);
}
