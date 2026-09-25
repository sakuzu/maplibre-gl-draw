// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The chunk of the retained cache and the building and releasing of its batch
 *
 * A chunk is a run of at most STORE_CHUNK_TARGET features of one kind. It owns at most one
 * retained batch (a GPU resource); an immediate chunk owns none and is drawn one feature at a time.
 */

import type { Feature, Layer } from '../../store/types.js';
import type { RetainedLineBatch } from '../renderers/line/line-types.js';
import {
  type PointShape,
  type RetainedPointBatch,
  toInstancedPointShape,
} from '../renderers/point/point-instance.js';
import type { RetainedPolygonBatch } from '../renderers/polygon/sdf-polygon.js';
import type { RetainedRendererSet } from '../renderers/retained.js';
import type { ChunkBBox } from './store-retained-bbox.js';
import type { RunKind } from './store-retained-classify.js';
import { collectLineItems, collectPoints, collectPolygons } from './store-retained-collect.js';
import {
  type CoordPatch,
  computeLineCoordSlots,
  type LineCoordSlot,
} from './store-retained-coord-patch.js';

/** Upper limit of the number of features per chunk */
export const STORE_CHUNK_TARGET = 512;

/**
 * One chunk (= one retained batch, or a list of features drawn immediately)
 */
export interface ChunkEntry {
  readonly kind: RunKind;
  readonly featureIds: string[];
  /** The retained batch (null for immediate, or when the contents are empty) */
  line: RetainedLineBatch | null;
  polygon: RetainedPolygonBatch | null;
  point: RetainedPointBatch | null;
  /** Whether a rebuild is needed (the retained batch is not used while this is true) */
  dirty: boolean;
  /**
   * "feature → position in the coordinate texture" of a line chunk
   *
   * Used for the incremental update of vertices. Only the types whose coordinate list goes in as
   * one contiguous run (LineString / Freehand) are recorded. It is null for anything but a line
   * chunk and for a chunk without a batch.
   */
  lineOffsets: Map<string, LineCoordSlot> | null;
  /**
   * Vertices to write into the coordinate texture on the next draw (the diff during a drag)
   *
   * The chunk does not become dirty while they are queued (it is not rebuilt).
   */
  pendingCoordPatches: CoordPatch[] | null;
  /**
   * Longitude/latitude bbox of every feature in the chunk
   *
   * Used for the thinning by the viewport. It is null for a chunk without a single coordinate,
   * and such a chunk is always drawn without thinning (the safe side).
   */
  bbox: ChunkBBox | null;
  /**
   * The origin the retained batch was built with (null before the first build)
   *
   * The vertices are baked relative to it, so the precision on screen depends on how far it is
   * from what is on screen (see `view/shaders/retained-origin.ts`).
   */
  origin: [number, number] | null;
  /**
   * The origin chosen for the view by the last rebase (null = the center of the bbox)
   *
   * Kept across rebuilds, so a change of the data does not move the origin away from the view.
   */
  viewOrigin: [number, number] | null;
  /** The frame of the last rebase (a chunk is rebased at most once per frame) */
  rebasedFrame: number;
}

/**
 * Cache for a single layer
 */
export interface LayerCache {
  readonly chunks: ChunkEntry[];
  /** featureId → chunk index (for partial invalidation) */
  readonly featureToChunk: Map<string, number>;
}

/** Result of building a chunk */
export type ChunkBuildResult =
  /** A retained batch was built */
  | 'built'
  /** There was nothing to draw (no retained batch is needed) */
  | 'empty'
  /** The GPU resource could not be created (shaders not initialized). Retry on the next frame */
  | 'retry'
  /** The classification disagreed with the kind of the chunk. Rebuild the whole layer */
  | 'mismatch';

/**
 * A new chunk of the given kind, waiting for its first build
 */
export function createChunkEntry(kind: RunKind): ChunkEntry {
  return {
    kind,
    featureIds: [],
    line: null,
    polygon: null,
    point: null,
    dirty: true,
    lineOffsets: null,
    pendingCoordPatches: null,
    bbox: null,
    origin: null,
    viewOrigin: null,
    rebasedFrame: -1,
  };
}

/**
 * Builds the retained batch that matches the kind of the chunk
 */
export function buildChunkBatch(
  chunk: ChunkEntry,
  features: Feature[],
  layer: Layer | undefined,
  origin: [number, number],
  renderers: RetainedRendererSet,
): ChunkBuildResult {
  const styles = renderers.styles;

  if (chunk.kind === 'line') {
    const items = collectLineItems(features, styles, layer);
    if (items.length === 0) return 'empty';
    const batch = renderers.line.buildRetainedBatch(items, { lineStyle: 'solid' }, { origin });
    if (!batch) return 'retry';
    chunk.line = batch;
    // Index table used for the incremental update of a vertex drag (kept in step with the order
    // of items)
    chunk.lineOffsets = computeLineCoordSlots(features);
    return 'built';
  }

  if (chunk.kind === 'polygon') {
    const polygons = collectPolygons(features, styles, layer);
    if (polygons.length === 0) return 'empty';
    const batch = renderers.polygon.buildRetained(polygons, { origin });
    if (!batch) return 'retry';
    chunk.polygon = batch;
    return 'built';
  }

  const shape = pointShapeOfRun(chunk.kind);
  if (shape) {
    const points = collectPoints(features, styles, layer);
    if (points.length === 0) return 'empty';
    const batch = renderers.point.buildRetained(points, shape, { origin });
    if (!batch) return 'retry';
    chunk.point = batch;
    return 'built';
  }

  return 'empty';
}

/**
 * The point shape of a point run (null for any other kind)
 */
function pointShapeOfRun(kind: RunKind): PointShape | null {
  return kind.startsWith('point-') ? toInstancedPointShape(kind.slice('point-'.length)) : null;
}

/**
 * Releases the retained batch of a chunk
 *
 * @param renderers Where to release the GPU resources (null = only the references are dropped)
 */
export function disposeChunkBatches(
  chunk: ChunkEntry,
  renderers: RetainedRendererSet | null,
): void {
  if (renderers) {
    if (chunk.polygon) renderers.polygon.disposeRetained(chunk.polygon);
    if (chunk.line) renderers.line.disposeRetainedBatch(chunk.line);
    if (chunk.point) renderers.point.disposeRetained(chunk.point);
  }
  chunk.polygon = null;
  chunk.line = null;
  chunk.point = null;
  // Once the batch is gone, both the index table and the queued patches lose their meaning
  chunk.lineOffsets = null;
  chunk.pendingCoordPatches = null;
}
