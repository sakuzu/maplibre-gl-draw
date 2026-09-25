// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A static R-tree packed into typed arrays (the spatial index of a dataset)
 *
 * The rows are ordered along a Hilbert curve of the centers of their bboxes and grouped bottom up
 * into nodes of a fixed size. The whole tree is three typed arrays, so it is built in one pass
 * without an object per row, and it can be built in a Worker and sent to the main thread without
 * a copy (`prepareDatasetColumnar`). The contents of a dataset are replaced as a
 * whole, so a tree that cannot be updated in place is enough.
 *
 * A pure module: it depends on nothing.
 */

/** The number of entries of one node */
const DEFAULT_NODE_SIZE = 16;

/** The side of the Hilbert grid the centers are snapped to (2^16 cells) */
const HILBERT_SIDE = 1 << 16;

/**
 * The arrays of a packed R-tree
 *
 * Leaves come first (one per row with a geometry), then the nodes of each level up to the root.
 *
 * @internal
 */
export interface PackedRTree {
  /** The number of entries of one node */
  nodeSize: number;
  /** The number of leaves (the rows with a geometry) */
  numItems: number;
  /** The box of every leaf and node: `[minX, minY, maxX, maxY]` per entry */
  boxes: Float64Array;
  /** For a leaf the row, for a node the position of its first child */
  indices: Int32Array;
  /** The end position of each level, from the leaves up */
  levelBounds: Int32Array;
}

/**
 * Builds a packed R-tree over the bboxes of the rows
 *
 * A row whose bbox is NaN (a row without a geometry) is left out.
 *
 * @param bounds `[minX, minY, maxX, maxY]` per row
 *
 * @internal
 */
export function buildPackedRTree(
  bounds: Float64Array,
  nodeSize: number = DEFAULT_NODE_SIZE,
): PackedRTree {
  const rowCount = bounds.length >> 2;
  let numItems = 0;
  for (let row = 0; row < rowCount; row++) {
    if (!Number.isNaN(bounds[row * 4])) numItems++;
  }

  // The level structure: leaves, then ceil(n / nodeSize) nodes per level up to a single root
  // (an empty tree has the root alone)
  let n = numItems;
  let numNodes = n;
  const levels = [n];
  do {
    n = Math.max(1, Math.ceil(n / nodeSize));
    numNodes += n;
    levels.push(numNodes);
  } while (n !== 1);

  const boxes = new Float64Array(numNodes * 4);
  const indices = new Int32Array(numNodes);
  const levelBounds = Int32Array.from(levels);

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let leaf = 0;
  for (let row = 0; row < rowCount; row++) {
    const at = row * 4;
    if (Number.isNaN(bounds[at])) continue;
    boxes[leaf * 4] = bounds[at];
    boxes[leaf * 4 + 1] = bounds[at + 1];
    boxes[leaf * 4 + 2] = bounds[at + 2];
    boxes[leaf * 4 + 3] = bounds[at + 3];
    indices[leaf] = row;
    if (bounds[at] < minX) minX = bounds[at];
    if (bounds[at + 1] < minY) minY = bounds[at + 1];
    if (bounds[at + 2] > maxX) maxX = bounds[at + 2];
    if (bounds[at + 3] > maxY) maxY = bounds[at + 3];
    leaf++;
  }

  if (numItems === 0) {
    // An empty tree: a root that nothing intersects
    boxes.set([
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]);
    return { nodeSize, numItems, boxes, indices, levelBounds };
  }

  if (numItems > nodeSize) {
    // Order the leaves along the Hilbert curve of their centers
    const width = maxX - minX || 1;
    const height = maxY - minY || 1;
    const values = new Float64Array(numItems);
    const scale = HILBERT_SIDE - 1;
    for (let i = 0; i < numItems; i++) {
      const cx = (boxes[i * 4] + boxes[i * 4 + 2]) / 2;
      const cy = (boxes[i * 4 + 1] + boxes[i * 4 + 3]) / 2;
      const x = Math.floor((scale * (cx - minX)) / width);
      const y = Math.floor((scale * (cy - minY)) / height);
      values[i] = hilbertIndex(x, y);
    }
    sortLeaves(values, boxes, indices, 0, numItems - 1, nodeSize);
  }

  // Build the nodes level by level, bottom up
  let pos = 0;
  let write = numItems;
  for (let level = 0; level < levelBounds.length - 1; level++) {
    const end = levelBounds[level];
    while (pos < end) {
      const first = pos;
      let nodeMinX = Number.POSITIVE_INFINITY;
      let nodeMinY = Number.POSITIVE_INFINITY;
      let nodeMaxX = Number.NEGATIVE_INFINITY;
      let nodeMaxY = Number.NEGATIVE_INFINITY;
      for (let j = 0; j < nodeSize && pos < end; j++, pos++) {
        if (boxes[pos * 4] < nodeMinX) nodeMinX = boxes[pos * 4];
        if (boxes[pos * 4 + 1] < nodeMinY) nodeMinY = boxes[pos * 4 + 1];
        if (boxes[pos * 4 + 2] > nodeMaxX) nodeMaxX = boxes[pos * 4 + 2];
        if (boxes[pos * 4 + 3] > nodeMaxY) nodeMaxY = boxes[pos * 4 + 3];
      }
      boxes[write * 4] = nodeMinX;
      boxes[write * 4 + 1] = nodeMinY;
      boxes[write * 4 + 2] = nodeMaxX;
      boxes[write * 4 + 3] = nodeMaxY;
      indices[write] = first;
      write++;
    }
  }

  return { nodeSize, numItems, boxes, indices, levelBounds };
}

/**
 * Returns the rows whose bbox intersects the box (the edges count as intersecting), in no
 * particular order
 *
 * @param out The array the rows are appended to
 *
 * @internal
 */
export function searchPackedRTree(
  tree: PackedRTree,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  out: number[] = [],
): number[] {
  const { boxes, indices, levelBounds, nodeSize, numItems } = tree;
  if (numItems === 0) return out;

  const queue: number[] = [];
  let node: number | undefined = levelBounds[levelBounds.length - 1] - 1;
  while (node !== undefined) {
    const end = Math.min(node + nodeSize, levelEnd(levelBounds, node));
    for (let pos = node; pos < end; pos++) {
      const at = pos * 4;
      if (
        maxX < boxes[at] ||
        maxY < boxes[at + 1] ||
        minX > boxes[at + 2] ||
        minY > boxes[at + 3]
      ) {
        continue;
      }
      if (node < numItems) out.push(indices[pos]);
      else queue.push(indices[pos]);
    }
    node = queue.pop();
  }
  return out;
}

/** The end of the level that the position belongs to */
function levelEnd(levelBounds: Int32Array, position: number): number {
  let lo = 0;
  let hi = levelBounds.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (levelBounds[mid] > position) hi = mid;
    else lo = mid + 1;
  }
  return levelBounds[lo];
}

/**
 * The distance along the Hilbert curve of a cell of the 2^16 grid
 */
function hilbertIndex(cellX: number, cellY: number): number {
  let x = cellX;
  let y = cellY;
  let d = 0;
  for (let s = HILBERT_SIDE >> 1; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = HILBERT_SIDE - 1 - x;
        y = HILBERT_SIDE - 1 - y;
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d;
}

/**
 * Sorts the leaves by their Hilbert value (quicksort on the parallel arrays)
 *
 * The order only matters between nodes, so a range that falls within one node is left as it is.
 */
function sortLeaves(
  values: Float64Array,
  boxes: Float64Array,
  indices: Int32Array,
  left: number,
  right: number,
  nodeSize: number,
): void {
  let lo = left;
  let hi = right;
  while (Math.floor(lo / nodeSize) < Math.floor(hi / nodeSize)) {
    const pivot = values[(lo + hi) >> 1];
    let i = lo - 1;
    let j = hi + 1;
    while (true) {
      do i++;
      while (values[i] < pivot);
      do j--;
      while (values[j] > pivot);
      if (i >= j) break;
      swapLeaves(values, boxes, indices, i, j);
    }
    // Recurse into the smaller side, loop on the larger one (the stack stays shallow)
    if (j - lo < hi - j) {
      sortLeaves(values, boxes, indices, lo, j, nodeSize);
      lo = j + 1;
    } else {
      sortLeaves(values, boxes, indices, j + 1, hi, nodeSize);
      hi = j;
    }
  }
}

function swapLeaves(
  values: Float64Array,
  boxes: Float64Array,
  indices: Int32Array,
  i: number,
  j: number,
): void {
  const value = values[i];
  values[i] = values[j];
  values[j] = value;

  const index = indices[i];
  indices[i] = indices[j];
  indices[j] = index;

  const a = i * 4;
  const b = j * 4;
  for (let k = 0; k < 4; k++) {
    const box = boxes[a + k];
    boxes[a + k] = boxes[b + k];
    boxes[b + k] = box;
  }
}
