// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A drape index made of partitions (`PartitionedDrapeIndex`), and the tables of its copies
 * (`DrapeCopyTables`)
 *
 * The elements of the drape are kept in partitions: runs of the order whose elements change
 * together. A tile holds the bins of each partition that touches it, built on one grid and one
 * quantization the tile decides from the sum over its partitions, and the runs of a cell are
 * the runs of its partitions joined in the order of the partitions. The runs of a partition are
 * in the order of its elements, so the joined runs are in the order of the drape and the
 * fragment composes them as they come.
 *
 * A run names the copy its element draws (`DrapePartitionElement.ref`), not a place in the
 * order: the style, the place in the order and the state of a copy are texels of the tables
 * read by its number. So
 *
 * - a change of the shape of an element bins again its partition in the tiles it touches, before
 *   and after, and joins those tiles again: the rest of the index is kept
 * - a change of the color, of the place in the order or of the state (hidden) of an element
 *   writes its texels, and the index is not touched
 * - a change of the order of the partitions writes the table of the order and joins again the
 *   tiles that hold them
 *
 * Where the arrays are kept: every tile has its places in the arrays of the cells and of the
 * runs, and every partition of a tile its place in the array of the edges, each with room to
 * grow. A place is written over where the new contents fit and moved to the end of its array
 * where they do not. The arrays are packed again (the tiles out of view dropped) once the
 * places left behind are half of an array, or an array nears what the textures of the GPU hold.
 */

import { DRAPE_DASH_TEXEL, DRAPE_STYLE_TEXELS, drapeTileKey } from './bin-store.js';
import {
  binDrapePartition,
  chooseGrid,
  DRAPE_LOD_TRIGGER,
  DRAPE_MAX_EDGES_PER_TILE,
  DRAPE_MAX_RUNS_PER_CELL,
  DRAPE_POSITION_SLOTS,
  DRAPE_RETRY_MAX_CELLS,
  type DrapePartitionElement,
  type DrapePartitionEstimate,
  type DrapeTile,
  drapeCellWorkBudget,
  drapeMarginOf,
  drapeQuantizeLevel,
  estimateDrapePartition,
  type TileBins,
} from './binning.js';
import type { DrapeBounds } from './geometry.js';

/** The number of ranges of copies (the upper bits of a ref) */
export const DRAPE_COPY_RANGES = 4;

/** The bit of the state of a copy: not drawn */
export const DRAPE_STATE_HIDDEN = 1;

/** The factor of the place of a partition in the order over the place of an element in it */
const ORDER_KEY_FACTOR = 2 ** 34;

/** The tiles kept at most (beyond it, the arrays are packed again with the tiles in view) */
const MAX_CACHED_TILES = 96;

/** The texels of the edges kept at most (16 bytes each, as the drape of the other elements) */
export const PARTITIONED_MAX_EDGE_TEXELS = 1_048_576;

/** The width of the data textures (texels) */
export const PARTITIONED_DATA_WIDTH = 2048;

/** The room a place is given over what it holds (a quarter, and a few texels) */
function withRoom(n: number): number {
  return n + Math.ceil(n / 4) + 8;
}

/** A place in an array of the index: its first texel and the texels it may hold */
interface Slot {
  offset: number;
  capacity: number;
}

/**
 * One array of the index (texels of `channels` floats), written in places with room, with the
 * texels written since the last upload
 */
export class DrapeSlotArray {
  data: Float32Array<ArrayBuffer>;
  /** The texels in use (the end of the last place) */
  top = 0;
  /** The texels of places left behind */
  garbage = 0;
  /** The texels written since the last upload, `[dirtyFrom, dirtyTo)` */
  dirtyFrom = Number.POSITIVE_INFINITY;
  dirtyTo = 0;

  constructor(readonly channels: number) {
    this.data = new Float32Array(1024 * channels);
  }

  /** Makes a place for `n` texels at the end (with room to grow) */
  alloc(n: number): Slot {
    const capacity = withRoom(n);
    const offset = this.top;
    this.top += capacity;
    this.ensure(this.top);
    return { offset, capacity };
  }

  /** Leaves a place behind */
  release(slot: Slot | null): void {
    if (slot) this.garbage += slot.capacity;
  }

  /** A place for `n` texels: the one given where they fit, a new one otherwise */
  fit(slot: Slot | null, n: number): Slot {
    if (slot && n <= slot.capacity) return slot;
    this.release(slot);
    return this.alloc(n);
  }

  /** Marks texels written */
  touch(from: number, to: number): void {
    if (to <= from) return;
    if (from < this.dirtyFrom) this.dirtyFrom = from;
    if (to > this.dirtyTo) this.dirtyTo = to;
  }

  /** Forgets the texels written (they were uploaded) */
  clean(): void {
    this.dirtyFrom = Number.POSITIVE_INFINITY;
    this.dirtyTo = 0;
  }

  /** Throws every place away */
  reset(): void {
    this.top = 0;
    this.garbage = 0;
    this.clean();
  }

  private ensure(texels: number): void {
    const needed = texels * this.channels;
    if (this.data.length >= needed) return;
    let size = this.data.length;
    while (size < needed) size *= 2;
    const out = new Float32Array(size);
    out.set(this.data);
    this.data = out;
  }
}

/** The arrays the index writes to the textures of the GPU */
export class DrapeSlotStorage {
  private static nextId = 1;
  /** Changes whenever the arrays were packed again (the GPU writes them whole) */
  id = DrapeSlotStorage.nextId++;
  readonly edges = new DrapeSlotArray(4);
  /** Where each edge starts along its path, in step with the edges */
  readonly edgeStarts = new DrapeSlotArray(1);
  readonly runs = new DrapeSlotArray(4);
  readonly cells = new DrapeSlotArray(4);

  /** Packs again from nothing (the next upload writes everything) */
  reset(): void {
    this.id = DrapeSlotStorage.nextId++;
    this.edges.reset();
    this.edgeStarts.reset();
    this.runs.reset();
    this.cells.reset();
  }

  /** Makes a place for the edges of a partition in a tile (in both arrays of the edges) */
  fitEdges(slot: Slot | null, n: number): Slot {
    const fitted = this.edges.fit(slot, n);
    if (fitted !== slot) {
      // The array of the starts follows the array of the edges, place for place
      this.edgeStarts.top = this.edges.top;
      this.edgeStarts.garbage = this.edges.garbage;
      ensureLength(this.edgeStarts, this.edges.top);
    }
    return fitted;
  }
}

function ensureLength(array: DrapeSlotArray, texels: number): void {
  if (array.data.length >= texels * array.channels) return;
  let size = Math.max(1024, array.data.length);
  while (size < texels * array.channels) size *= 2;
  const out = new Float32Array(size);
  out.set(array.data);
  array.data = out;
}

/** The style a copy is drawn with (the fields of a drape element the table of styles holds) */
export type DrapeCopyStyle = Pick<
  DrapePartitionElement,
  'fill' | 'stroke' | 'strokeWidthPx' | 'kind' | 'source' | 'widthZoom' | 'dash'
>;

/**
 * The tables of the copies: the style of each copy (`DRAPE_STYLE_TEXELS` texels), its place in
 * the order and its state (one texel: the partition, the slot, the order at the slot and the bits
 * of the state), and the place of each partition in the order (one texel each)
 *
 * Each range of copies has a region of its own in each table, given by its first texel (a
 * uniform). A range that outgrows its region is moved to the end, twice as large, and the other
 * ranges stay where they are.
 */
export class DrapeCopyTables {
  private static nextId = 1;
  /** Changes whenever a region moved (the GPU writes the tables whole) */
  id = DrapeCopyTables.nextId++;
  readonly styles = new DrapeSlotArray(4);
  readonly ranks = new DrapeSlotArray(4);
  /** The first texel of each range in the table of styles, and in the table of ranks */
  readonly styleBase = new Int32Array(DRAPE_COPY_RANGES);
  readonly rankBase = new Int32Array(DRAPE_COPY_RANGES);
  /** The copies each range holds */
  private readonly capacity = new Int32Array(DRAPE_COPY_RANGES);
  /** The first texel of the table of the order of the partitions, and the partitions it holds */
  orderBase = 0;
  private orderCapacity = 0;

  constructor() {
    for (let r = 0; r < DRAPE_COPY_RANGES; r++) this.growRange(r, 1024);
    this.growOrder(256);
  }

  /** Writes the style of a copy */
  setStyle(range: number, copy: number, style: DrapeCopyStyle): void {
    this.ensureCopy(range, copy);
    const texel = this.styleBase[range] + copy * DRAPE_STYLE_TEXELS;
    const at = texel * 4;
    const s = this.styles.data;
    s[at] = style.fill[0];
    s[at + 1] = style.fill[1];
    s[at + 2] = style.fill[2];
    s[at + 3] = style.fill[3];
    s[at + 4] = style.stroke[0];
    s[at + 5] = style.stroke[1];
    s[at + 6] = style.stroke[2];
    s[at + 7] = style.stroke[3];
    s[at + 8] = style.strokeWidthPx;
    s[at + 9] = style.kind;
    s[at + 10] = style.source;
    s[at + 11] = style.widthZoom;
    s.fill(0, at + 12, at + DRAPE_STYLE_TEXELS * 4);
    const dash = style.strokeWidthPx > 0 ? style.dash : null;
    if (dash) {
      const dashAt = at + DRAPE_DASH_TEXEL * 4;
      s[dashAt] = dash.a;
      s[dashAt + 1] = dash.b;
      s[dashAt + 2] = dash.c;
      s[dashAt + 3] = dash.pixelRatio;
    }
    this.styles.touch(texel, texel + DRAPE_STYLE_TEXELS);
  }

  /** Writes the place of a copy in the order (its partition and its place there) and its state */
  setRank(range: number, copy: number, partition: number, position: number, state: number): void {
    this.ensureCopy(range, copy);
    const texel = this.rankBase[range] + copy;
    const at = texel * 4;
    const r = this.ranks.data;
    r[at] = partition;
    r[at + 1] = Math.floor(position / DRAPE_POSITION_SLOTS);
    r[at + 2] = position % DRAPE_POSITION_SLOTS;
    r[at + 3] = state;
    this.ranks.touch(texel, texel + 1);
  }

  /** Writes the state of a copy (returns whether it changed) */
  setState(range: number, copy: number, state: number): boolean {
    this.ensureCopy(range, copy);
    const texel = this.rankBase[range] + copy;
    const at = texel * 4 + 3;
    if (this.ranks.data[at] === state) return false;
    this.ranks.data[at] = state;
    this.ranks.touch(texel, texel + 1);
    return true;
  }

  /** The state of a copy */
  stateOf(range: number, copy: number): number {
    if (copy >= this.capacity[range]) return DRAPE_STATE_HIDDEN;
    return this.ranks.data[(this.rankBase[range] + copy) * 4 + 3] as number;
  }

  /** Clears a copy given back (hidden, so a run that still names it draws nothing) */
  clear(range: number, copy: number): void {
    if (copy >= this.capacity[range]) return;
    const texel = this.rankBase[range] + copy;
    const at = texel * 4;
    this.ranks.data.fill(0, at, at + 4);
    this.ranks.data[at + 3] = DRAPE_STATE_HIDDEN;
    this.ranks.touch(texel, texel + 1);
  }

  /** Writes the place of a partition in the order */
  setOrder(partition: number, orderIndex: number): void {
    if (partition >= this.orderCapacity)
      this.growOrder(Math.max(partition + 1, this.orderCapacity * 2));
    const texel = this.orderBase + partition;
    const at = texel * 4;
    if (this.ranks.data[at] === orderIndex) return;
    this.ranks.data[at] = orderIndex;
    this.ranks.touch(texel, texel + 1);
  }

  /** The texels the table of styles and the table of ranks hold */
  get styleTexels(): number {
    return this.styles.top;
  }

  get rankTexels(): number {
    return this.ranks.top;
  }

  private ensureCopy(range: number, copy: number): void {
    if (copy < this.capacity[range]) return;
    let capacity = this.capacity[range] * 2;
    while (capacity <= copy) capacity *= 2;
    this.growRange(range, capacity);
  }

  /** Moves a range to the end of the tables, with room for `capacity` copies */
  private growRange(range: number, capacity: number): void {
    const before = this.capacity[range];
    const styleFrom = this.styleBase[range];
    const rankFrom = this.rankBase[range];
    const style = this.styles.alloc(capacity * DRAPE_STYLE_TEXELS);
    const rank = this.ranks.alloc(capacity);
    if (before > 0) {
      this.styles.data.copyWithin(
        style.offset * 4,
        styleFrom * 4,
        (styleFrom + before * DRAPE_STYLE_TEXELS) * 4,
      );
      this.ranks.data.copyWithin(rank.offset * 4, rankFrom * 4, (rankFrom + before) * 4);
      this.styles.garbage += before * DRAPE_STYLE_TEXELS;
      this.ranks.garbage += before;
    }
    const held = Math.min(Math.floor(style.capacity / DRAPE_STYLE_TEXELS), rank.capacity);
    // The copies not written yet are hidden
    for (let c = before; c < held; c++) {
      this.ranks.data[(rank.offset + c) * 4 + 3] = DRAPE_STATE_HIDDEN;
    }
    this.styleBase[range] = style.offset;
    this.rankBase[range] = rank.offset;
    this.capacity[range] = held;
    this.moved();
  }

  private growOrder(capacity: number): void {
    const before = this.orderCapacity;
    const slot = this.ranks.alloc(capacity);
    if (before > 0) {
      this.ranks.data.copyWithin(
        slot.offset * 4,
        this.orderBase * 4,
        (this.orderBase + before) * 4,
      );
      this.ranks.garbage += before;
    }
    this.orderBase = slot.offset;
    this.orderCapacity = slot.capacity;
    this.moved();
  }

  private moved(): void {
    this.id = DrapeCopyTables.nextId++;
    this.styles.touch(0, this.styles.top);
    this.ranks.touch(0, this.ranks.top);
  }
}

/** A partition as the index sees it */
export interface DrapePartitionSource {
  /** Its number: what the texels of its copies name, and its texel in the table of the order */
  readonly id: number;
  /** Its elements, in its order */
  readonly elements: readonly DrapePartitionElement[];
  /** The box of its elements (null when it has none) */
  readonly bounds: DrapeBounds | null;
}

/** What a partition holds in a tile */
interface TilePart {
  bins: TileBins;
  edgeSlot: Slot | null;
  /** What it holds at the original geometry, and at the quantization of the tile */
  readonly estimate: DrapePartitionEstimate;
}

/** A tile of the index */
interface TileState {
  readonly tile: DrapeTile;
  readonly key: string;
  grid: number;
  /** The grid the sum over the partitions asked for at the last build (before it was made finer) */
  baseGrid: number;
  quantizeLevel: number;
  /** The partitions that touch the tile */
  readonly parts: Map<number, TilePart>;
  /** The partitions to bin again */
  readonly dirty: Set<number>;
  /** Whether the tile is to be joined again */
  joinStale: boolean;
  cellSlot: Slot | null;
  runSlot: Slot | null;
  /** Whether it is too heavy for the drape (it is not drawn) */
  unfit: boolean;
  cellWork: number;
  edgeEstimate: number;
  truncatedCells: number;
  maxRunsPerCell: number;
  maxEdgesPerCell: number;
  /** The key of the last run (the highest in the order) of each cell */
  cover: Float64Array;
  /** The key of each run joined, in the order of the place of the tile in the array of runs */
  runKeys: Float64Array;
  lastUsed: number;
}

/** What preparing the tiles of a view gives */
export interface PartitionedPrepareResult {
  /** Whether every tile of the view is built and up to date */
  readonly complete: boolean;
  /** Whether work is left for the next frames */
  readonly pending: boolean;
  /** Whether the tiles too heavy for the drape are more than a quarter of the view */
  readonly overflow: boolean;
  /** The tiles built from nothing and the partitions binned again in tiles, in this frame */
  readonly built: number;
  readonly rebinned: number;
  readonly unfitTiles: number;
  readonly maxTileEdges: number;
  readonly truncatedCells: number;
  readonly maxRunsPerCell: number;
  readonly maxEdgesPerCell: number;
}

/** The position of a tile of the index, for its draw */
export interface PartitionedTileEntry {
  readonly unfit: boolean;
  readonly grid: number;
  readonly cellOffset: number;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** The Mercator box of a tile */
function tileBox(tile: DrapeTile): DrapeBounds {
  const size = 1 / 2 ** tile.z;
  return {
    minX: tile.x * size,
    minY: tile.y * size,
    maxX: (tile.x + 1) * size,
    maxY: (tile.y + 1) * size,
  };
}

/** Whether two boxes meet, the first widened by `margin` */
function boxesMeet(a: DrapeBounds, b: DrapeBounds, margin: number): boolean {
  return (
    a.minX - margin <= b.maxX &&
    a.maxX + margin >= b.minX &&
    a.minY - margin <= b.maxY &&
    a.maxY + margin >= b.minY
  );
}

/**
 * The drape index of partitions
 *
 * @internal
 */
export class PartitionedDrapeIndex {
  readonly storage: DrapeSlotStorage;
  /** Whether it packs the arrays again (the index that owns them) */
  private readonly owner: boolean;
  /** The indices that write in the same arrays (their tiles are dropped when they are packed) */
  private readonly sharing: PartitionedDrapeIndex[] = [];

  /**
   * @param shared The index whose arrays it writes in (its tiles are dropped whenever that one
   *   packs them again; it never packs them itself)
   */
  constructor(shared?: PartitionedDrapeIndex) {
    this.storage = shared?.storage ?? new DrapeSlotStorage();
    this.owner = shared === undefined;
    shared?.sharing.push(this);
  }

  /** Forgets every tile without leaving their places behind (the arrays were packed again) */
  private forgetTiles(): void {
    this.tiles.clear();
    this.revision++;
  }
  private readonly partitions = new Map<number, DrapePartitionSource>();
  /** The place of each partition in the order */
  private readonly orderOf = new Map<number, number>();
  /** The element of each copy */
  private readonly elementOf = new Map<number, DrapePartitionElement>();
  private readonly tiles = new Map<string, TileState>();
  private frame = 0;
  /** The tiles of the view of the last preparation */
  private viewKeys = new Set<string>();
  /** Changes whenever a tile is joined again or the order changes (what reads the covers waits it) */
  revision = 0;
  /** The partitions binned into tiles since the index was made (for the tests of the work) */
  binCount = 0;

  /** The partitions, by number */
  partition(id: number): DrapePartitionSource | undefined {
    return this.partitions.get(id);
  }

  /** The number of partitions */
  get partitionCount(): number {
    return this.partitions.size;
  }

  /** The place of a partition in the order (-1 for none) */
  orderIndexOf(id: number): number {
    return this.orderOf.get(id) ?? -1;
  }

  /**
   * The key of an element in the order of the drape (a number that compares as its place: the
   * place of its partition, then its place in it)
   */
  rankKey(partition: number, position: number): number {
    return (this.orderOf.get(partition) ?? -1) * ORDER_KEY_FACTOR + position;
  }

  /**
   * Puts a partition (new, or with new elements)
   *
   * @param changed The boxes of what changed in it (null: everything): the tiles that meet them,
   *   or the box of the partition before and after for null, bin it again
   */
  setPartition(source: DrapePartitionSource, changed: readonly DrapeBounds[] | null): void {
    const before = this.partitions.get(source.id);
    this.partitions.set(source.id, source);
    if (before) for (const element of before.elements) this.elementOf.delete(element.ref);
    for (const element of source.elements) this.elementOf.set(element.ref, element);
    const boxes: DrapeBounds[] = [];
    if (changed) boxes.push(...changed);
    else {
      if (before?.bounds) boxes.push(before.bounds);
      if (source.bounds) boxes.push(source.bounds);
    }
    if (boxes.length === 0) return;
    for (const state of [...this.tiles.values()]) {
      const box = tileBox(state.tile);
      const margin = 2 ** -state.tile.z;
      if (!boxes.some((b) => boxesMeet(b, box, margin))) continue;
      if (!this.viewKeys.has(state.key)) {
        // A tile out of view is not kept stale: it is built again when it comes back
        this.dropTile(state);
        continue;
      }
      state.dirty.add(source.id);
    }
  }

  /** Takes a partition out */
  removePartition(id: number): void {
    const before = this.partitions.get(id);
    if (!before) return;
    this.partitions.delete(id);
    for (const element of before.elements) this.elementOf.delete(element.ref);
    this.orderOf.delete(id);
    for (const state of this.tiles.values()) {
      const part = state.parts.get(id);
      state.dirty.delete(id);
      if (!part) continue;
      this.storage.edges.release(part.edgeSlot);
      state.parts.delete(id);
      state.joinStale = true;
    }
  }

  /**
   * Puts the partitions in their order (the ones not named are not drawn)
   *
   * @returns Whether the order changed
   */
  setOrder(ids: readonly number[]): boolean {
    let same = ids.length === this.orderOf.size;
    if (same) {
      for (let i = 0; i < ids.length; i++) {
        if (this.orderOf.get(ids[i] as number) !== i) {
          same = false;
          break;
        }
      }
    }
    if (same) return false;
    this.orderOf.clear();
    ids.forEach((id, i) => {
      this.orderOf.set(id, i);
    });
    for (const state of this.tiles.values()) state.joinStale = true;
    this.revision++;
    return true;
  }

  /** The position of a tile for its draw (undefined until it is built) */
  entryOf(tile: DrapeTile): PartitionedTileEntry | undefined {
    const state = this.tiles.get(drapeTileKey(tile));
    if (!state?.cellSlot) return undefined;
    return { unfit: state.unfit, grid: state.grid, cellOffset: state.cellSlot.offset };
  }

  /** The most runs a cell of a tile holds (0 until it is built) */
  maxRunsPerCellOf(tile: DrapeTile): number {
    return this.tiles.get(drapeTileKey(tile))?.maxRunsPerCell ?? 0;
  }

  /**
   * The highest key in the order (`rankKey`) of the elements of a tile within a Mercator box
   * (-Infinity for none): what in the tile is drawn over what is in the box
   */
  maxKeyIn(tile: DrapeTile, box: DrapeBounds): number {
    const state = this.tiles.get(drapeTileKey(tile));
    if (!state || state.cover.length === 0) return Number.NEGATIVE_INFINITY;
    const scale = 2 ** tile.z;
    const n = Math.max(1, state.grid);
    const x0 = Math.max(0, Math.floor((box.minX * scale - tile.x) * n));
    const x1 = Math.min(n - 1, Math.floor((box.maxX * scale - tile.x) * n));
    const y0 = Math.max(0, Math.floor((box.minY * scale - tile.y) * n));
    const y1 = Math.min(n - 1, Math.floor((box.maxY * scale - tile.y) * n));
    let max = Number.NEGATIVE_INFINITY;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = state.cover[y * n + x] as number;
        if (key > max) max = key;
      }
    }
    return max;
  }

  /**
   * Whether an element after a key in the order (`rankKey`) is drawn within a Mercator box in a
   * tile: an element of a cell the box meets whose box, widened by the reach of its outline,
   * meets it
   *
   * @param zoom The zoom the reach of the outlines is taken at
   * @param deeperThan Only the cells holding more runs than this (0: every cell)
   */
  coversBox(
    tile: DrapeTile,
    box: DrapeBounds,
    afterKey: number,
    zoom: number,
    deeperThan = 0,
  ): boolean {
    const state = this.tiles.get(drapeTileKey(tile));
    if (!state?.runSlot || state.cover.length === 0) return false;
    const scale = 2 ** tile.z;
    const n = Math.max(1, state.grid);
    const x0 = Math.max(0, Math.floor((box.minX * scale - tile.x) * n));
    const x1 = Math.min(n - 1, Math.floor((box.maxX * scale - tile.x) * n));
    const y0 = Math.max(0, Math.floor((box.minY * scale - tile.y) * n));
    const y1 = Math.min(n - 1, Math.floor((box.maxY * scale - tile.y) * n));
    const cells = this.storage.cells.data;
    const runs = this.storage.runs.data;
    const runBase = state.runSlot.offset;
    const cellBase = (state.cellSlot as Slot).offset;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const c = y * n + x;
        if ((state.cover[c] as number) <= afterKey) continue;
        const at = (cellBase + c) * 4;
        const start = cells[at] as number;
        const count = cells[at + 1] as number;
        if (count <= deeperThan) continue;
        for (let r = count - 1; r >= 0; r--) {
          const local = start + r - runBase;
          if ((state.runKeys[local] as number) <= afterKey) break;
          const element = this.elementOf.get(runs[(start + r) * 4] as number);
          if (!element) return true;
          const margin = drapeMarginOf(element.strokeWidthPx, element.widthZoom, zoom) / scale;
          const b = element.bounds;
          if (
            b.minX - margin <= box.maxX &&
            b.maxX + margin >= box.minX &&
            b.minY - margin <= box.maxY &&
            b.maxY + margin >= box.minY
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /** Throws every tile away (the partitions are kept) */
  clearTiles(): void {
    if (!this.owner) {
      for (const state of [...this.tiles.values()]) this.dropTile(state);
      this.revision++;
      return;
    }
    this.tiles.clear();
    this.storage.reset();
    for (const index of this.sharing) index.forgetTiles();
    this.revision++;
  }

  /**
   * Prepares the tiles of a view: builds the new ones and bins again the partitions that changed
   * in them, within the budget (at least one tile is built in a frame), and joins them
   *
   * @param budgetMs The time the frame may spend (0 or less builds nothing)
   * @param zoom The zoom (the margins of the outlines follow it)
   * @param edgeLimit The texels of edges the textures hold
   */
  prepare(
    tiles: readonly DrapeTile[],
    budgetMs: number,
    zoom: number,
    edgeLimit = PARTITIONED_MAX_EDGE_TEXELS,
  ): PartitionedPrepareResult {
    this.frame++;
    this.viewKeys = new Set(tiles.map(drapeTileKey));
    const start = nowMs();
    const maxCellWork = drapeCellWorkBudget(tiles.length);
    let built = 0;
    let rebinned = 0;
    let missing = 0;
    const spent = (): boolean => (built > 0 || rebinned > 0) && nowMs() - start >= budgetMs;
    for (const tile of tiles) {
      const key = drapeTileKey(tile);
      let state = this.tiles.get(key);
      if (state) state.lastUsed = this.frame;
      if (!state) {
        if (budgetMs <= 0 || spent()) {
          missing++;
          continue;
        }
        state = this.newTile(tile, key);
        this.buildTile(state, zoom);
        built++;
      } else if (state.dirty.size > 0) {
        if (budgetMs <= 0 || spent()) {
          missing++;
          continue;
        }
        rebinned += this.rebinTile(state, zoom);
      }
      if (state.joinStale) this.joinTile(state);
    }

    this.compactIfNeeded(tiles, zoom, edgeLimit);

    let unfit = 0;
    let maxTileEdges = 0;
    let truncatedCells = 0;
    let maxRunsPerCell = 0;
    let maxEdgesPerCell = 0;
    for (const tile of tiles) {
      const state = this.tiles.get(drapeTileKey(tile));
      if (!state?.cellSlot) continue;
      state.unfit = state.edgeEstimate > DRAPE_MAX_EDGES_PER_TILE || state.cellWork > maxCellWork;
      if (state.unfit) unfit++;
      maxTileEdges = Math.max(maxTileEdges, state.edgeEstimate);
      truncatedCells += state.truncatedCells;
      maxRunsPerCell = Math.max(maxRunsPerCell, state.maxRunsPerCell);
      maxEdgesPerCell = Math.max(maxEdgesPerCell, state.maxEdgesPerCell);
    }
    return {
      complete: missing === 0,
      pending: missing > 0,
      overflow:
        (tiles.length > 0 && unfit * 4 > tiles.length) || this.storage.edges.top > edgeLimit,
      built,
      rebinned,
      unfitTiles: unfit,
      maxTileEdges,
      truncatedCells,
      maxRunsPerCell,
      maxEdgesPerCell,
    };
  }

  private newTile(tile: DrapeTile, key: string): TileState {
    const state: TileState = {
      tile: { x: tile.x, y: tile.y, z: tile.z },
      key,
      grid: 0,
      baseGrid: 0,
      quantizeLevel: 0,
      parts: new Map(),
      dirty: new Set(),
      joinStale: true,
      cellSlot: null,
      runSlot: null,
      unfit: false,
      cellWork: 0,
      edgeEstimate: 0,
      truncatedCells: 0,
      maxRunsPerCell: 0,
      maxEdgesPerCell: 0,
      cover: new Float64Array(0),
      runKeys: new Float64Array(0),
      lastUsed: this.frame,
    };
    this.tiles.set(key, state);
    return state;
  }

  /** The partitions that may touch a tile, in no particular order */
  private partitionsNear(tile: DrapeTile): DrapePartitionSource[] {
    const box = tileBox(tile);
    const margin = 2 ** -tile.z;
    const out: DrapePartitionSource[] = [];
    for (const source of this.partitions.values()) {
      if (source.bounds && boxesMeet(source.bounds, box, margin)) out.push(source);
    }
    return out;
  }

  /**
   * Builds a tile from nothing: the quantization and the grid from the sum over the partitions
   * that touch it, and the bins of each (made finer while cells are cut short)
   */
  private buildTile(state: TileState, zoom: number): void {
    for (const part of state.parts.values()) this.storage.edges.release(part.edgeSlot);
    state.parts.clear();
    state.dirty.clear();
    const sources = this.partitionsNear(state.tile);
    const at0 = sources.map((s) => estimateDrapePartition(s.elements, state.tile, 0, zoom));
    const level = drapeQuantizeLevel(state.tile.z, (l) =>
      l === 0
        ? sum(at0, (e) => e.edges)
        : sum(sources, (s) => estimateDrapePartition(s.elements, state.tile, l, zoom).edges),
    );
    const estimates =
      level === 0
        ? at0
        : sources.map((s) => estimateDrapePartition(s.elements, state.tile, level, zoom));
    state.quantizeLevel = level;
    state.edgeEstimate = sum(estimates, (e) => e.edges);
    state.grid = chooseGrid(
      state.edgeEstimate,
      Math.max(0, ...estimates.map((e) => e.maxMargin)),
      sum(estimates, (e) => e.count),
    );
    state.baseGrid = state.grid;
    if (state.edgeEstimate > DRAPE_MAX_EDGES_PER_TILE) {
      // Too heavy even quantized: not built (it is not drawn)
      state.joinStale = true;
      return;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      sources.forEach((source, i) => {
        const estimate = estimates[i] as DrapePartitionEstimate;
        if (estimate.count === 0) return;
        this.binPart(state, source, estimate, zoom);
      });
      this.joinTile(state);
      if (state.truncatedCells === 0 || state.grid >= DRAPE_RETRY_MAX_CELLS) break;
      state.grid *= 2;
    }
  }

  /**
   * Bins again the partitions that changed in a tile: the tile is built from nothing when the sum
   * over its partitions asks for another grid or another quantization
   *
   * @returns The partitions binned again
   */
  private rebinTile(state: TileState, zoom: number): number {
    const dirty = [...state.dirty];
    state.dirty.clear();
    const next = new Map<number, DrapePartitionEstimate>();
    for (const id of dirty) {
      const source = this.partitions.get(id);
      if (!source) continue;
      next.set(id, estimateDrapePartition(source.elements, state.tile, state.quantizeLevel, zoom));
    }
    let edges = 0;
    let count = 0;
    let margin = 0;
    for (const [id, part] of state.parts) {
      if (next.has(id)) continue;
      edges += part.estimate.edges;
      count += part.estimate.count;
      margin = Math.max(margin, part.estimate.maxMargin);
    }
    for (const estimate of next.values()) {
      edges += estimate.edges;
      count += estimate.count;
      margin = Math.max(margin, estimate.maxMargin);
    }
    // The sum crossed a bound of what the tile decides for all of its partitions (its grid, its
    // quantization): every partition of the tile is binned again
    const level = state.quantizeLevel;
    const levelHolds = level === 0 ? edges <= DRAPE_LOD_TRIGGER : edges <= DRAPE_MAX_EDGES_PER_TILE;
    if (
      chooseGrid(edges, margin, count) !== state.baseGrid ||
      !levelHolds ||
      state.edgeEstimate > DRAPE_MAX_EDGES_PER_TILE
    ) {
      this.buildTile(state, zoom);
      return this.partitionsNear(state.tile).length;
    }
    state.edgeEstimate = edges;
    for (const [id, estimate] of next) {
      const source = this.partitions.get(id) as DrapePartitionSource;
      if (estimate.count === 0) {
        const part = state.parts.get(id);
        if (part) {
          this.storage.edges.release(part.edgeSlot);
          state.parts.delete(id);
        }
      } else {
        this.binPart(state, source, estimate, zoom);
      }
    }
    state.joinStale = true;
    return next.size;
  }

  /** Bins a partition into a tile and writes its edges in its place */
  private binPart(
    state: TileState,
    source: DrapePartitionSource,
    estimate: DrapePartitionEstimate,
    zoom: number,
  ): void {
    this.binCount++;
    const bins = binDrapePartition(source.elements, state.tile, {
      grid: state.grid,
      quantizeLevel: state.quantizeLevel,
      zoom,
    });
    const part = state.parts.get(source.id);
    const texels = bins.edges.length / 4;
    const slot = texels === 0 ? null : this.storage.fitEdges(part?.edgeSlot ?? null, texels);
    if (texels === 0 && part?.edgeSlot) this.storage.edges.release(part.edgeSlot);
    if (slot) {
      const { edges, edgeStarts } = this.storage;
      edges.data.set(bins.edges, slot.offset * 4);
      edgeStarts.data.set(bins.edgeStarts, slot.offset);
      edges.touch(slot.offset, slot.offset + texels);
      edgeStarts.touch(slot.offset, slot.offset + texels);
    }
    state.parts.set(source.id, { bins, edgeSlot: slot, estimate });
    state.joinStale = true;
  }

  /**
   * Joins a tile: the runs of each cell are the runs of its partitions, in the order of the
   * partitions, written in the place of the tile (moved to the end where they do not fit)
   */
  private joinTile(state: TileState): void {
    state.joinStale = false;
    this.revision++;
    const grid = Math.max(1, state.grid);
    const cellCount = grid * grid;
    const ordered = [...state.parts]
      .filter(([id]) => this.orderOf.has(id))
      .sort((a, b) => (this.orderOf.get(a[0]) as number) - (this.orderOf.get(b[0]) as number));
    // Parts binned for another grid (before a full build) are not joined
    const parts = ordered.filter(([, part]) => part.bins.grid === grid);

    let total = 0;
    for (const [, part] of parts) total += part.bins.runs.length / 4;
    const { runs, cells } = this.storage;
    state.runSlot = runs.fit(state.runSlot, total);
    state.cellSlot = cells.fit(state.cellSlot, cellCount);
    const runBase = state.runSlot.offset;
    const cellBase = state.cellSlot.offset;
    const runData = runs.data;
    const cellData = cells.data;
    if (state.cover.length !== cellCount) state.cover = new Float64Array(cellCount);
    if (state.runKeys.length < total) state.runKeys = new Float64Array(total);
    const runKeys = state.runKeys;
    const cover = state.cover;
    cover.fill(Number.NEGATIVE_INFINITY);

    let written = 0;
    let truncated = 0;
    let maxRuns = 0;
    let maxEdges = 0;
    let work = 0;
    for (let c = 0; c < cellCount; c++) {
      const first = written;
      let count = 0;
      let lastKey = Number.NEGATIVE_INFINITY;
      let cut = false;
      for (const [id, part] of parts) {
        const bins = part.bins;
        const from = bins.cells[c * 2] as number;
        const n = bins.cells[c * 2 + 1] as number;
        const edgeBase = part.edgeSlot?.offset ?? 0;
        const order = (this.orderOf.get(id) as number) * ORDER_KEY_FACTOR;
        for (let i = 0; i < n; i++) {
          if (count >= DRAPE_MAX_RUNS_PER_CELL) {
            cut = true;
            break;
          }
          const src = (from + i) * 4;
          const dst = (runBase + written) * 4;
          runData[dst] = bins.runs[src] as number;
          runData[dst + 1] = (bins.runs[src + 1] as number) + edgeBase;
          runData[dst + 2] = bins.runs[src + 2] as number;
          runData[dst + 3] = bins.runs[src + 3] as number;
          const edgesOfRun = bins.runs[src + 2] as number;
          work += 1 + edgesOfRun;
          if (edgesOfRun > maxEdges) maxEdges = edgesOfRun;
          lastKey = order + (bins.runPositions?.[from + i] ?? 0);
          runKeys[written] = lastKey;
          written++;
          count++;
        }
      }
      if (cut) truncated++;
      if (count > maxRuns) maxRuns = count;
      const at = (cellBase + c) * 4;
      cellData[at] = runBase + first;
      cellData[at + 1] = count;
      cellData[at + 2] = 0;
      cellData[at + 3] = 0;
      cover[c] = lastKey;
    }
    runs.touch(runBase, runBase + written);
    cells.touch(cellBase, cellBase + cellCount);
    state.truncatedCells = truncated;
    state.maxRunsPerCell = maxRuns;
    state.maxEdgesPerCell = maxEdges;
    state.cellWork = work / cellCount;
  }

  /** Forgets a tile and leaves its places behind */
  private dropTile(state: TileState): void {
    for (const part of state.parts.values()) this.storage.edges.release(part.edgeSlot);
    this.storage.runs.release(state.runSlot);
    this.storage.cells.release(state.cellSlot);
    this.tiles.delete(state.key);
  }

  /**
   * Packs the arrays again when the places left behind are half of an array, an array nears what
   * the textures hold or too many tiles are kept: the tiles out of view are dropped, and the
   * others written again from their bins (nothing is binned again)
   */
  private compactIfNeeded(tiles: readonly DrapeTile[], zoom: number, edgeLimit: number): void {
    if (!this.owner) return;
    const { edges, runs, cells } = this.storage;
    const crowded =
      this.tiles.size > MAX_CACHED_TILES ||
      edges.top > edgeLimit * 0.75 ||
      (edges.top > 65_536 && edges.garbage * 2 > edges.top) ||
      (runs.top > 65_536 && runs.garbage * 2 > runs.top) ||
      (cells.top > 65_536 && cells.garbage * 2 > cells.top);
    if (!crowded) return;
    const keep = new Set(tiles.map(drapeTileKey));
    const kept = [...this.tiles.values()].filter((state) => keep.has(state.key));
    this.tiles.clear();
    this.storage.reset();
    // The indices that write in the same arrays build their tiles again
    for (const index of this.sharing) index.forgetTiles();
    for (const state of kept) {
      this.tiles.set(state.key, state);
      state.runSlot = null;
      state.cellSlot = null;
      for (const part of state.parts.values()) {
        const texels = part.bins.edges.length / 4;
        part.edgeSlot = texels === 0 ? null : this.storage.fitEdges(null, texels);
        if (part.edgeSlot) {
          this.storage.edges.data.set(part.bins.edges, part.edgeSlot.offset * 4);
          this.storage.edgeStarts.data.set(part.bins.edgeStarts, part.edgeSlot.offset);
        }
      }
      if (state.dirty.size > 0) this.rebinTile(state, zoom);
      this.joinTile(state);
    }
    this.storage.edges.touch(0, this.storage.edges.top);
    this.storage.edgeStarts.touch(0, this.storage.edgeStarts.top);
  }
}

function sum<T>(list: readonly T[], of: (item: T) => number): number {
  let total = 0;
  for (const item of list) total += of(item);
  return total;
}
