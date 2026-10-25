// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The boxes of every row of a set of tables, in one spatial index (`RowBoxIndex`)
 *
 * A row is found where it is drawn by the box it covers: the box of its positions, or for a type
 * whose extent is worked out from the feature (an Image, the type of an extension that covers a
 * box around its point, a Circle), the box its calculation gives; for a row held as a feature,
 * the box of that feature as it is now. Every row of the tables is in the one index, whatever
 * group, delta or set of new rows it is read from, so the rows a click or a box may meet are the
 * rows whose boxes meet it, and nothing else is looked at.
 *
 * The index holds the handles of the rows (as `handle + 1`: rbush leaves out an item that is
 * falsy), the boxes beside them in an array by handle. The tables tell it which rows to look at
 * again (`mark`); it reads their boxes when it is next searched (a write costs nothing until
 * then).
 *
 * When every row is to be read (the rows of a document opened, many rows changed), the index is
 * built again in slices while the page is idle, so that the first search after an open does not
 * wait for it: the boxes of the rows are read, the rows are put in the order of the Hilbert curve
 * of the centers of their boxes, and loaded into the tree a run of neighbours at a time. A search
 * that comes before the build ends finishes it first, so it answers what the index answers once
 * built. A small build is left to the first search.
 */

import RBush from 'rbush';
import type { BoundingBox } from '../shared/types/model.js';
import { type IdleScheduler, idleNow, whenIdle } from '../shared/utils/idle.js';
import { HILBERT_SIDE, hilbertIndex } from '../table/packed-rtree.js';
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
   *
   * @param inBuild Whether it is read in a build of every row (rather than as a row marked)
   */
  boxOf(handle: RowHandle, out: Float64Array, inBuild: boolean): number | null;
  /**
   * The handles of every row of the tables, an array per layer (to build the index again); the
   * arrays are not changed afterwards
   */
  rowLists(): readonly Int32Array[];
  /** About the number of rows of the tables, read often: whether a build is left to idle time */
  countRows(): number;
}

/**
 * How the index is built
 *
 * @internal
 */
export interface RowBoxIndexOptions {
  /** Runs a slice of a build while the page is idle (`whenIdle` when omitted) */
  readonly whenIdle?: IdleScheduler;
  /** The clock the deadlines of the slices are read with (`idleNow` when omitted) */
  readonly now?: () => number;
  /**
   * The key the rows are put in order by, from the center of their boxes: that of the system of
   * the coordinates of the tables (`CoordinateSystem.sortKey`; the Hilbert curve of the centers
   * over their extent when omitted)
   */
  readonly sortKey?: (centerX: number, centerY: number) => number;
}

/** The bytes of a number, to read its bits */
const KEY_BITS = new DataView(new ArrayBuffer(8));

/**
 * The upper 32 bits of a number made to sort as the number does: the bits of a key sorted as
 * unsigned integers are in the order of the keys (two keys that differ in their lower bits only
 * may come in either order, which changes no row the index finds)
 *
 * @internal
 */
export function orderedKeyBits(key: number): number {
  KEY_BITS.setFloat64(0, key);
  const high = KEY_BITS.getUint32(0);
  // A negative number has its bits flipped, a positive one its sign bit set
  return (high & 0x80000000 ? ~high : high | 0x80000000) >>> 0;
}

/** From how many rows marked the index is built again rather than written row by row */
const REBUILD_FROM = 4096;

/** From how many rows a build is done while the page is idle rather than by the first search */
export const IDLE_BUILD_FROM = 16384;

/** The longest a slice of a build works (ms), whatever time the idle period leaves */
const SLICE_MS = 8;

/** The number of rows loaded into the tree at a time (a run of neighbours on the curve) */
const LOAD_RUN = 2048;

/** The rows read, or keyed, or moved by a pass of the sort, between two looks at the clock */
const READ_STEP = 512;
const PASS_STEP = 16384;

/** The bits of the keys sorted by one pass (two passes sort the 32 bits of a key) */
const RADIX_BITS = 16;
const RADIX = 1 << RADIX_BITS;

/** Where a build is: reading the boxes of the rows */
const READ = 0;
/** Working out the key of each row (the Hilbert curve, or the key of the system of the coordinates) */
const KEY = 1;
/** Counting the keys of a pass of the sort */
const COUNT = 2;
/** Moving the rows to their places of a pass of the sort */
const MOVE = 3;
/** Loading the rows into the tree */
const LOAD = 4;

/** A build of the index from every row, done in slices */
interface Build {
  phase: number;
  /** The handles of every row, an array per layer, and where the reading is */
  readonly lists: readonly Int32Array[];
  list: number;
  at: number;
  /** The rows read with a box (`handle + 1`), `count` of them */
  items: Int32Array;
  count: number;
  /** The extent of the centers of their boxes */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** The key of each row read, the rows and the keys in the order of the pass, and the pass */
  keys: Uint32Array;
  sortedItems: Int32Array;
  sortedKeys: Uint32Array;
  counts: Uint32Array;
  pass: number;
  /** Where the current step of the phase is */
  i: number;
}

/**
 * The boxes of every row of a set of tables, in one rbush
 *
 * @internal
 */
export class RowBoxIndex {
  readonly #source: RowBoxSource;
  readonly #whenIdle: IdleScheduler;
  readonly #now: () => number;
  readonly #sortKey: ((centerX: number, centerY: number) => number) | undefined;
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
  /** The build going on (the tree holds part of the rows) */
  #build: Build | null = null;
  /** Cancels the slice of a build waiting for an idle period */
  #cancelIdle: (() => void) | null = null;
  #count = 0;
  readonly #scratch = new Float64Array(4);

  constructor(source: RowBoxSource, options: RowBoxIndexOptions = {}) {
    this.#source = source;
    this.#whenIdle = options.whenIdle ?? whenIdle;
    this.#now = options.now ?? idleNow;
    this.#sortKey = options.sortKey;
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

  /** Whether a build is going on or waits for an idle period */
  get building(): boolean {
    return this.#build !== null || this.#cancelIdle !== null;
  }

  /** Tells that the boxes of rows may have changed (they are read when the index is searched) */
  mark(handles: Iterable<RowHandle>): void {
    if (this.#all) {
      this.#scheduleBuild();
      return;
    }
    for (const handle of handles) this.#marked.add(handle);
    if (this.#tooManyMarked()) this.#scheduleBuild();
  }

  /** Tells that the box of a row may have changed */
  markOne(handle: RowHandle): void {
    if (this.#all) return;
    this.#marked.add(handle);
    if (this.#tooManyMarked()) this.#scheduleBuild();
  }

  /** Tells that every row is to be read again */
  markAll(): void {
    this.#all = true;
    this.#build = null;
    this.#marked.clear();
    this.#scheduleBuild();
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

  /**
   * Works on the build going on until a deadline (at most `SLICE_MS` from now)
   *
   * @param deadline The time the slice ends by (`RowBoxIndexOptions.now`)
   * @returns Whether the build goes on
   */
  advance(deadline: number): boolean {
    if (this.#all || this.#tooManyMarked()) this.#startBuild();
    const build = this.#build;
    if (!build) return false;
    const end = Math.min(deadline, this.#now() + SLICE_MS);
    while (this.#build === build && this.#now() < end) this.#step(build, false);
    return this.#build !== null;
  }

  /** Whether the rows marked are many enough to build the index again */
  #tooManyMarked(): boolean {
    return this.#marked.size > Math.max(REBUILD_FROM, this.#count / 4);
  }

  /** Asks for an idle period for the next slice of a build, unless the build is small */
  #scheduleBuild(): void {
    if (this.#cancelIdle) return;
    if (!this.#build && this.#source.countRows() < IDLE_BUILD_FROM) return;
    this.#cancelIdle = this.#whenIdle((deadline) => {
      this.#cancelIdle = null;
      if (this.advance(deadline)) this.#scheduleBuild();
    });
  }

  /** Reads the rows marked, or every row, the build going on finished first */
  #flush(): void {
    if (this.#all || this.#tooManyMarked()) this.#startBuild();
    const build = this.#build;
    if (build) {
      while (this.#build === build) this.#step(build, true);
    }
    if (this.#tooManyMarked()) {
      // Rows marked while the build went on, many enough to build it again
      this.#startBuild();
      const again = this.#build as Build | null;
      while (again && this.#build === again) this.#step(again, true);
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
      const layer = this.#source.boxOf(handle, box, false);
      if (layer === null) continue;
      this.#reserve(handle + 1);
      this.#boxes.set(box, handle * 4);
      this.#layers[handle] = layer;
      this.#tree.insert(handle + 1);
      this.#count++;
    }
  }

  /** Starts a build from every row: the tree is emptied, the rows are read afresh */
  #startBuild(): void {
    this.#all = false;
    this.#marked.clear();
    this.#tree.clear();
    this.#layers.fill(-1);
    this.#count = 0;
    const lists = this.#source.rowLists();
    let total = 0;
    let top = -1;
    for (const list of lists) {
      total += list.length;
      for (let i = 0; i < list.length; i++) if (list[i] > top) top = list[i];
    }
    // The arrays by handle grown once rather than as the rows are read
    this.#reserve(top + 1);
    this.#build = {
      phase: READ,
      lists,
      list: 0,
      at: 0,
      items: new Int32Array(total),
      count: 0,
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      keys: new Uint32Array(0),
      sortedItems: new Int32Array(0),
      sortedKeys: new Uint32Array(0),
      counts: new Uint32Array(0),
      pass: 0,
      i: 0,
    };
  }

  /**
   * Does a step of a build: a few rows read, keyed or moved, or a run loaded
   *
   * @param all Whether the step does the whole of its phase (a search waits for the build)
   */
  #step(build: Build, all: boolean): void {
    switch (build.phase) {
      case READ:
        this.#read(build, all ? Number.POSITIVE_INFINITY : READ_STEP);
        return;
      case KEY:
        this.#key(build, all ? build.count : PASS_STEP);
        return;
      case COUNT:
        this.#countKeys(build, all ? build.count : PASS_STEP);
        return;
      case MOVE:
        this.#move(build, all ? build.count : PASS_STEP);
        return;
      case LOAD:
        this.#load(build, all ? build.count : LOAD_RUN);
        return;
    }
  }

  /** Reads the boxes of up to `n` rows */
  #read(build: Build, n: number): void {
    const box = this.#scratch;
    let left = n;
    while (left > 0 && build.list < build.lists.length) {
      const list = build.lists[build.list];
      const end = Math.min(list.length, build.at + left);
      for (let i = build.at; i < end; i++) {
        const handle = list[i];
        const layer = this.#source.boxOf(handle, box, true);
        if (layer === null) continue;
        this.#reserve(handle + 1);
        if (this.#layers[handle] >= 0) continue;
        this.#boxes.set(box, handle * 4);
        this.#layers[handle] = layer;
        build.items[build.count++] = handle + 1;
        const cx = (box[0] + box[2]) / 2;
        const cy = (box[1] + box[3]) / 2;
        if (cx < build.minX) build.minX = cx;
        if (cy < build.minY) build.minY = cy;
        if (cx > build.maxX) build.maxX = cx;
        if (cy > build.maxY) build.maxY = cy;
      }
      left -= end - build.at;
      build.at = end;
      if (build.at >= list.length) {
        build.list++;
        build.at = 0;
      }
    }
    if (build.list < build.lists.length) return;
    this.#count = build.count;
    build.i = 0;
    if (build.count <= LOAD_RUN) {
      // Few enough to load at once
      build.phase = LOAD;
      return;
    }
    build.keys = new Uint32Array(build.count);
    build.phase = KEY;
  }

  /**
   * Works out the keys of up to `n` rows from the centers of their boxes: the key of the system of
   * the coordinates, or the Hilbert curve of the centers
   */
  #key(build: Build, n: number): void {
    const boxes = this.#boxes;
    const width = build.maxX - build.minX || 1;
    const height = build.maxY - build.minY || 1;
    const scale = HILBERT_SIDE - 1;
    const sortKey = this.#sortKey;
    const end = Math.min(build.count, build.i + n);
    for (let i = build.i; i < end; i++) {
      const at = (build.items[i] - 1) * 4;
      const cx = (boxes[at] + boxes[at + 2]) / 2;
      const cy = (boxes[at + 1] + boxes[at + 3]) / 2;
      if (sortKey) {
        build.keys[i] = orderedKeyBits(sortKey(cx, cy));
        continue;
      }
      const x = Math.floor((scale * (cx - build.minX)) / width);
      const y = Math.floor((scale * (cy - build.minY)) / height);
      build.keys[i] = hilbertIndex(x, y);
    }
    build.i = end;
    if (end < build.count) return;
    build.sortedItems = new Int32Array(build.count);
    build.sortedKeys = new Uint32Array(build.count);
    build.counts = new Uint32Array(RADIX + 1);
    build.pass = 0;
    build.i = 0;
    build.phase = COUNT;
  }

  /** Counts the digits of the pass of up to `n` keys (a radix sort, the low digits first) */
  #countKeys(build: Build, n: number): void {
    const shift = build.pass * RADIX_BITS;
    const counts = build.counts;
    const end = Math.min(build.count, build.i + n);
    for (let i = build.i; i < end; i++) counts[((build.keys[i] >>> shift) & (RADIX - 1)) + 1]++;
    build.i = end;
    if (end < build.count) return;
    // The place of the first row of each digit
    for (let d = 1; d <= RADIX; d++) counts[d] += counts[d - 1];
    build.i = 0;
    build.phase = MOVE;
  }

  /** Moves up to `n` rows to their places of the pass (the order of equal digits kept) */
  #move(build: Build, n: number): void {
    const shift = build.pass * RADIX_BITS;
    const counts = build.counts;
    const end = Math.min(build.count, build.i + n);
    for (let i = build.i; i < end; i++) {
      const key = build.keys[i];
      const to = counts[(key >>> shift) & (RADIX - 1)]++;
      build.sortedItems[to] = build.items[i];
      build.sortedKeys[to] = key;
    }
    build.i = end;
    if (end < build.count) return;
    // The sorted rows are read by the next pass
    [build.items, build.sortedItems] = [build.sortedItems, build.items];
    [build.keys, build.sortedKeys] = [build.sortedKeys, build.keys];
    build.i = 0;
    build.pass++;
    if (build.pass * RADIX_BITS < 32) {
      build.counts.fill(0);
      build.phase = COUNT;
      return;
    }
    build.keys = new Uint32Array(0);
    build.sortedKeys = new Uint32Array(0);
    build.sortedItems = new Int32Array(0);
    build.counts = new Uint32Array(0);
    build.phase = LOAD;
  }

  /** Loads up to `n` rows into the tree, a run of neighbours at a time */
  #load(build: Build, n: number): void {
    const end = Math.min(build.count, build.i + n);
    while (build.i < end) {
      const to = Math.min(end, build.i + LOAD_RUN);
      this.#tree.load(Array.from(build.items.subarray(build.i, to)));
      build.i = to;
    }
    if (build.i < build.count) return;
    this.#build = null;
    // A slice asked for (the build was finished by a search) has nothing left to do
    this.#cancelIdle?.();
    this.#cancelIdle = null;
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
