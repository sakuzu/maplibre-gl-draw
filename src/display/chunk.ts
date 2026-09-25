// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Spatial chunks of a dataset
 *
 * Retained-mode rendering is structured so that "the GPU resources are built per chunk and a
 * frame only tests the bbox of a chunk against the viewport". Culling each feature one by one
 * (searching the spatial index) drops out of the rendering path (the hit testing path keeps using
 * the spatial index as before).
 *
 * A chunk holds the numbers of its rows (the positions in the contents of the dataset), not
 * the features, so the same chunks serve every kind of contents (`source.ts`). The splitting rule
 * itself is in `partition.ts`, a pure module that also runs in a Worker.
 *
 * The target count is an average per chunk, not an upper limit. With a distribution concentrated
 * in one place, a single chunk can exceed the target.
 */

import type { BoundingBox, Feature } from '../shared/types/model.js';
import { getBoundingBox } from '../shared/utils/feature-bbox.js';
import { CHUNK_TARGET_SIZE, type PartitionedRows, partitionRows } from './partition.js';

export {
  CHUNK_TARGET_SIZE,
  CHUNK_TARGET_VERTICES,
  chunkTargetSizeFor,
  LARGE_CHUNK_TARGET_SIZE,
  LARGE_DATASET_THRESHOLD,
} from './partition.js';

/**
 * A spatial chunk
 *
 * @internal
 */
export interface DisplayChunk {
  /** The rows contained in the chunk (in draw order) */
  readonly rows: Int32Array;
  /** The union of the bboxes of the rows contained */
  readonly bounds: BoundingBox;
  /** The first row contained (the draw order between chunks) */
  readonly firstIndex: number;
}

/**
 * Whether two bboxes intersect
 *
 * @internal
 */
export function boundsIntersect(a: BoundingBox, b: BoundingBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/**
 * Number of vertices of a feature (an estimate of the amount of work)
 *
 * @internal
 */
export function countVertices(feature: Feature): number {
  const geometry = feature as { type: string; coordinates?: unknown };
  const walk = (value: unknown, depth: number): number => {
    if (!Array.isArray(value)) return 0;
    if (depth === 0) return 1;
    let total = 0;
    for (const item of value) total += walk(item, depth - 1);
    return total;
  };
  switch (geometry.type) {
    case 'Point':
      return 1;
    case 'LineString':
    case 'MultiPoint':
      return walk(geometry.coordinates, 1);
    case 'Polygon':
    case 'MultiLineString':
      return walk(geometry.coordinates, 2);
    case 'MultiPolygon':
      return walk(geometry.coordinates, 3);
    default:
      return 1;
  }
}

/**
 * Computes the bboxes of the features all at once, `[minX, minY, maxX, maxY]` per feature
 *
 * The spatial index and the splitting both read this one array (it is not computed twice).
 *
 * @internal
 */
export function computeFeatureBounds(features: readonly Feature[]): Float64Array {
  const bounds = new Float64Array(features.length * 4);
  for (let i = 0; i < features.length; i++) {
    const bbox = getBoundingBox(features[i]);
    bounds[i * 4] = bbox.minX;
    bounds[i * 4 + 1] = bbox.minY;
    bounds[i * 4 + 2] = bbox.maxX;
    bounds[i * 4 + 3] = bbox.maxY;
  }
  return bounds;
}

/**
 * Turns the flat result of the splitting into chunks
 *
 * @internal
 */
export function toDisplayChunks(partitioned: PartitionedRows): DisplayChunk[] {
  const { rows, offsets, bounds } = partitioned;
  const chunks: DisplayChunk[] = new Array(offsets.length - 1);
  for (let c = 0; c < chunks.length; c++) {
    const chunkRows = rows.subarray(offsets[c], offsets[c + 1]);
    chunks[c] = {
      rows: chunkRows,
      bounds: {
        minX: bounds[c * 4],
        minY: bounds[c * 4 + 1],
        maxX: bounds[c * 4 + 2],
        maxY: bounds[c * 4 + 3],
      },
      firstIndex: chunkRows[0],
    };
  }
  return chunks;
}

/**
 * Splits the features into spatial chunks (`partitionRows` over their bboxes)
 *
 * @param features The features in draw order
 * @param targetSize The target number of features per chunk
 * @param featureBounds The precomputed bboxes (computed here when omitted)
 *
 * @internal
 */
export function partitionIntoChunks(
  features: readonly Feature[],
  targetSize: number = CHUNK_TARGET_SIZE,
  featureBounds?: Float64Array,
): DisplayChunk[] {
  if (features.length === 0) return [];
  const bounds = featureBounds ?? computeFeatureBounds(features);
  const vertexCounts = new Float64Array(features.length);
  for (let i = 0; i < features.length; i++) vertexCounts[i] = countVertices(features[i]);
  return toDisplayChunks(partitionRows(bounds, vertexCounts, targetSize));
}
