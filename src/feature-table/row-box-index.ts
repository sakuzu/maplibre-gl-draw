// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The boxes of every row of a set of tables, in one spatial index (`RowBoxIndex`)
 *
 * A row is found where it is drawn by the box it covers: the box of its positions, or for a type
 * whose extent is worked out from the feature (an Image, the type of an extension that covers a
 * box around its point, a Circle), the box its calculation gives; for a row held as a feature,
 * the box of that feature as it is now. Every row of the tables is in the one index, whatever
 * group, delta or set of new rows it is read from, so the rows a click may hit are the rows whose
 * boxes meet it, and nothing else is looked at.
 *
 * The index holds the handles of the rows (as `handle + 1`: rbush leaves out an item that is
 * falsy), the boxes beside them in an array by handle. The
 * tables tell it which rows to look at again (`mark`); it reads their boxes when it is next
 * searched (a write costs nothing until then), and builds itself again in one load when many
 * rows changed (an import).
 */

import RBush from 'rbush';
import type { BoundingBox } from '../shared/types/model.js';
import type { RowHandle } from './types.js';

/**
 * What the index reads of the tables
 *
 * @internal
 */
export interface RowBoxSource {
  /**
   * The box of a row as it is drawn now and the number of its layer, or null for no row (deleted,
   * gone): written into `out` (minX, minY, maxX, maxY)
   */
  boxOf(handle: RowHandle, out: Float64Array): number | null;
  /** Calls `visit` with the handle of every row of the tables (to build the index again) */
  forEachRow(visit: (handle: RowHandle) => void): void;
}

/** From how many rows marked the index is built again rather than written row by row */
const REBUILD_FROM = 4096;

/**
 * The boxes of every row of a set of tables, in one rbush
 *
 * @internal
 */
export class RowBoxIndex {
  readonly #source: RowBoxSource;
  /** The box each handle is indexed with (minX, minY, maxX, maxY) */
  #boxes = new Float64Array(0);
  /** The layer each handle is indexed in, -1 for a handle not indexed */
  #layers = new Int32Array(0);
  /** The handles of the rows, each as `handle + 1` */
  readonly #tree: RBush<number>;
  /** The handles to look at again */
  #marked = new Set<RowHandle>();
  /** Whether every row is to be read again */
  #all = true;
  #count = 0;
  readonly #scratch = new Float64Array(4);

  constructor(source: RowBoxSource) {
    this.#source = source;
    // rbush calls these unbound: they read the arrays of the index through it
    const index = this;
    class Tree extends RBush<number> {
      override toBBox(item: number): BoundingBox {
        const b = index.#boxes;
        const at = (item - 1) * 4;
        return { minX: b[at], minY: b[at + 1], maxX: b[at + 2], maxY: b[at + 3] };
      }
      override compareMinX(a: number, b: number): number {
        return index.#boxes[(a - 1) * 4] - index.#boxes[(b - 1) * 4];
      }
      override compareMinY(a: number, b: number): number {
        return index.#boxes[(a - 1) * 4 + 1] - index.#boxes[(b - 1) * 4 + 1];
      }
    }
    this.#tree = new Tree();
  }

  /** The number of rows indexed */
  get size(): number {
    return this.#count;
  }

  /** Tells that the boxes of rows may have changed (they are read when the index is searched) */
  mark(handles: Iterable<RowHandle>): void {
    if (this.#all) return;
    for (const handle of handles) this.#marked.add(handle);
  }

  /** Tells that the box of a row may have changed */
  markOne(handle: RowHandle): void {
    if (!this.#all) this.#marked.add(handle);
  }

  /** Tells that every row is to be read again */
  markAll(): void {
    this.#all = true;
    this.#marked.clear();
  }

  /**
   * The rows of a layer whose boxes meet a box (in no particular order)
   *
   * @param layer The number of the layer (`RowBoxSource.boxOf`)
   */
  search(layer: number, minX: number, minY: number, maxX: number, maxY: number): RowHandle[] {
    this.#flush();
    const out: RowHandle[] = [];
    for (const item of this.#tree.search({ minX, minY, maxX, maxY })) {
      if (this.#layers[item - 1] === layer) out.push(item - 1);
    }
    return out;
  }

  /** The bytes the index holds about (the arrays by handle and the nodes of the tree) */
  get bytes(): number {
    // A node of the tree holds up to 9 children: about one node per 5 rows, of about 100 bytes
    return this.#boxes.byteLength + this.#layers.byteLength + Math.ceil(this.#count / 5) * 100;
  }

  /** Reads the rows marked, or every row */
  #flush(): void {
    if (this.#all || this.#marked.size > Math.max(REBUILD_FROM, this.#count / 4)) {
      this.#rebuild();
      return;
    }
    if (this.#marked.size === 0) return;
    const marked = this.#marked;
    this.#marked = new Set();
    const box = this.#scratch;
    for (const handle of marked) {
      // A row is taken out with the box it was put in with
      if (handle < this.#layers.length && this.#layers[handle] >= 0) {
        this.#tree.remove(handle + 1);
        this.#layers[handle] = -1;
        this.#count--;
      }
      const layer = this.#source.boxOf(handle, box);
      if (layer === null) continue;
      this.#reserve(handle + 1);
      this.#boxes.set(box, handle * 4);
      this.#layers[handle] = layer;
      this.#tree.insert(handle + 1);
      this.#count++;
    }
  }

  /** Builds the index again from every row, in one load */
  #rebuild(): void {
    this.#all = false;
    this.#marked.clear();
    this.#tree.clear();
    this.#layers.fill(-1);
    this.#count = 0;
    const handles: RowHandle[] = [];
    const box = this.#scratch;
    this.#source.forEachRow((handle) => {
      const layer = this.#source.boxOf(handle, box);
      if (layer === null) return;
      this.#reserve(handle + 1);
      if (this.#layers[handle] >= 0) return;
      this.#boxes.set(box, handle * 4);
      this.#layers[handle] = layer;
      handles.push(handle + 1);
    });
    this.#count = handles.length;
    this.#tree.load(handles);
  }

  /** Makes the arrays by handle hold `n` handles at least */
  #reserve(n: number): void {
    if (this.#layers.length >= n) return;
    const size = Math.max(n, this.#layers.length * 2, 64);
    const boxes = new Float64Array(size * 4);
    boxes.set(this.#boxes);
    const layers = new Int32Array(size).fill(-1);
    layers.set(this.#layers);
    this.#boxes = boxes;
    this.#layers = layers;
  }
}
