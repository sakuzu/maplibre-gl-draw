// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The splitting of the rows of a dataset into spatial chunks
 *
 * A pure function over typed arrays: it depends on neither the features, nor maplibre, nor
 * WebGL, so it runs in a Worker as well (`prepareTable` calls it there). Both kinds of contents
 * use it: the features (`dataset/chunk.ts` computes the per-row arrays from them) and the tables
 * (`prepare.ts`).
 *
 * The rule: the rows are cut in half at the median of the centers of their bboxes (the way a k-d
 * tree is built) until a range holds at most the target number of rows and the target number of
 * vertices. Within a chunk the rows keep their original order (the draw order), and the chunks
 * are ordered by the first row they hold.
 */

/**
 * Target number of features per chunk
 *
 * A chunk is also "the unit of work built in one frame". With terrain, building a chunk includes
 * the subdivision and takes 0.2 to 0.5 seconds for 500 features (measured). Lowering the count
 * makes the hitch per frame smaller at the cost of more draw calls. 96 was taken from "about
 * 50 ms per chunk with terrain" (it was lowered from 192 because building got heavier once the
 * step was matched to the real mesh of the tiles).
 *
 * @internal
 */
export const CHUNK_TARGET_SIZE = 96;

/**
 * Target number of vertices per chunk
 *
 * Cutting by the count alone lets a single feature such as a municipal boundary with 130,000
 * vertices bring in the work of dozens of features. Measured, building the chunk that contained
 * that one feature (63 features, 226,000 vertices in total) took 1.4 seconds even with the
 * terrain off. A chunk is "the unit of work built in one frame", so it is cut by the number of
 * vertices as well.
 *
 * 40,000 was taken from "about 0.2 seconds per chunk with the terrain off". A feature that
 * exceeds it on its own cannot be split any further, so it becomes a chunk of that one feature.
 *
 * @internal
 */
export const CHUNK_TARGET_VERTICES = 40_000;

/**
 * Target number of features per chunk for a large dataset
 *
 * @internal
 */
export const LARGE_CHUNK_TARGET_SIZE = 4096;

/**
 * The count at which the target number is raised
 *
 * @internal
 */
export const LARGE_DATASET_THRESHOLD = 50_000;

/**
 * Returns the target number of features per chunk for the total count of a dataset
 *
 * A chunk is also the unit of drawing, so as their number grows, "switching the program and
 * setting the uniforms" happens that many times per frame. Cutting 260,000 features in steps of
 * 512 gives several hundred visible chunks, and that procedure costs more than the drawing
 * itself.
 *
 * The culling gets coarser, but the bbox intersection of a chunk is cheap per frame and, coarse
 * or not, the total number of vertices the GPU processes does not change (the vertices outside
 * the screen are dropped at the clipping stage). The target number is therefore raised for a
 * large dataset.
 *
 * @internal
 */
export function chunkTargetSizeFor(count: number): number {
  return count > LARGE_DATASET_THRESHOLD ? LARGE_CHUNK_TARGET_SIZE : CHUNK_TARGET_SIZE;
}

/**
 * The chunks of a set of rows, in flat typed arrays (so that they can be sent between threads
 * without a copy)
 *
 * @internal
 */
export interface PartitionedRows {
  /** The rows of every chunk, chunk after chunk; the rows of one chunk are in ascending order */
  rows: Int32Array;
  /** Chunk `i` holds `rows[offsets[i]]` to `rows[offsets[i + 1] - 1]` (chunk count + 1 entries) */
  offsets: Int32Array;
  /** The union of the bboxes of the rows of each chunk: `[minX, minY, maxX, maxY]` per chunk */
  bounds: Float64Array;
}

/**
 * Splits the rows into spatial chunks
 *
 * A row whose bbox is NaN (a row without a geometry) is left out.
 *
 * It used to be "cut the whole bbox into a grid and assign a feature to the cell its bbox center
 * falls into". That form breaks as soon as a single extremely wide feature (the outline of a
 * whole country, a feature crossing the date line) is mixed in. The whole bbox grows to the size
 * of the world because of that one feature, and so do the cells of the grid, so everything else
 * falls into a single cell. Cutting at the median evens out the counts regardless of the
 * distribution. An outlier goes into its own side as a single row and does not distort the rest
 * of the splitting.
 *
 * @param bounds The bboxes, `[minX, minY, maxX, maxY]` per row
 * @param vertexCounts The number of vertices per row (the estimate of the work)
 * @param targetSize The target number of rows per chunk (decided from the number of rows with a
 *   geometry when omitted)
 *
 * @internal
 */
export function partitionRows(
  bounds: Float64Array,
  vertexCounts: ArrayLike<number>,
  targetSize?: number,
): PartitionedRows {
  const rowCount = bounds.length >> 2;
  const order = new Int32Array(rowCount);
  let count = 0;
  for (let row = 0; row < rowCount; row++) {
    if (!Number.isNaN(bounds[row * 4])) order[count++] = row;
  }
  if (count === 0) {
    return { rows: new Int32Array(0), offsets: new Int32Array(1), bounds: new Float64Array(0) };
  }
  const target = targetSize ?? chunkTargetSizeFor(count);

  const centerX = new Float64Array(rowCount);
  const centerY = new Float64Array(rowCount);
  for (let i = 0; i < count; i++) {
    const at = order[i] * 4;
    centerX[order[i]] = (bounds[at] + bounds[at + 2]) / 2;
    centerY[order[i]] = (bounds[at + 1] + bounds[at + 3]) / 2;
  }

  /** The ranges of `order` that became chunks */
  const ranges: Array<[number, number]> = [];
  splitRange(0, count);

  // Put the rows of each chunk back into the draw order, then order the chunks by their first row
  for (const [from, to] of ranges) order.subarray(from, to).sort();
  ranges.sort((a, b) => order[a[0]] - order[b[0]]);

  const rows = new Int32Array(count);
  const offsets = new Int32Array(ranges.length + 1);
  const chunkBounds = new Float64Array(ranges.length * 4);
  let written = 0;
  for (let c = 0; c < ranges.length; c++) {
    const [from, to] = ranges[c];
    offsets[c] = written;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let i = from; i < to; i++) {
      const row = order[i];
      rows[written++] = row;
      const at = row * 4;
      if (bounds[at] < minX) minX = bounds[at];
      if (bounds[at + 1] < minY) minY = bounds[at + 1];
      if (bounds[at + 2] > maxX) maxX = bounds[at + 2];
      if (bounds[at + 3] > maxY) maxY = bounds[at + 3];
    }
    chunkBounds[c * 4] = minX;
    chunkBounds[c * 4 + 1] = minY;
    chunkBounds[c * 4 + 2] = maxX;
    chunkBounds[c * 4 + 3] = maxY;
  }
  offsets[ranges.length] = written;
  return { rows, offsets, bounds: chunkBounds };

  /**
   * Cuts the range [from, to) at the median down to the target count
   */
  function splitRange(from: number, to: number): void {
    const size = to - from;
    if (size <= 1) {
      ranges.push([from, to]);
      return;
    }
    let vertices = 0;
    for (let i = from; i < to; i++) vertices += vertexCounts[order[i]];
    if (size <= target && vertices <= CHUNK_TARGET_VERTICES) {
      ranges.push([from, to]);
      return;
    }

    // Cut along the axis with the larger extent
    let minCX = Number.POSITIVE_INFINITY;
    let maxCX = Number.NEGATIVE_INFINITY;
    let minCY = Number.POSITIVE_INFINITY;
    let maxCY = Number.NEGATIVE_INFINITY;
    for (let i = from; i < to; i++) {
      const row = order[i];
      if (centerX[row] < minCX) minCX = centerX[row];
      if (centerX[row] > maxCX) maxCX = centerX[row];
      if (centerY[row] < minCY) minCY = centerY[row];
      if (centerY[row] > maxCY) maxCY = centerY[row];
    }

    // If the centers are concentrated at a single point, cutting does not separate them (it only
    // adds chunks with the same bbox), so it stops there
    if (maxCX === minCX && maxCY === minCY) {
      ranges.push([from, to]);
      return;
    }

    const axis = maxCX - minCX >= maxCY - minCY ? centerX : centerY;
    const mid = from + (size >> 1);
    selectNth(axis, from, to, mid);
    splitRange(from, mid);
    splitRange(mid, to);
  }

  /**
   * Rearranges the range so that the element at mid becomes the median (quickselect)
   */
  function selectNth(axis: Float64Array, from: number, to: number, nth: number): void {
    let lo = from;
    let hi = to - 1;
    while (lo < hi) {
      // The middle value is used as the pivot (so that sorted input does not hit the worst case)
      const pivot = axis[order[(lo + hi) >> 1]];
      let i = lo;
      let j = hi;
      while (i <= j) {
        while (axis[order[i]] < pivot) i++;
        while (axis[order[j]] > pivot) j--;
        if (i <= j) {
          const swap = order[i];
          order[i] = order[j];
          order[j] = swap;
          i++;
          j--;
        }
      }
      if (nth <= j) hi = j;
      else if (nth >= i) lo = i;
      else return;
    }
  }
}
