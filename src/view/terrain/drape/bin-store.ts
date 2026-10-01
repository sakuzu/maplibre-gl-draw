// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Storage of the binning results of the analytic drape
 *
 * The analytic drape of polygons and lines is built on "a per-tile index (the bins)". The
 * index changes only on an edit or a change of the view, so it is cached per tile and only the
 * tiles that newly entered the view are built, within the frame's budget.
 *
 * Two disciplines are upheld here.
 *
 * - No re-binning every frame. Even during a pan, only the new tiles are rebuilt
 * - Drawing continues with the previous version while a rebuild is in progress. When the
 *   features or the styles change, the old version (active) is drawn until the new version
 *   (pending) has all the tiles of the view. The index and the element order are swapped as a
 *   pair (mixing them midway swaps the colors)
 *
 * Once the amount retained exceeds the upper bound, only the tiles of the view are kept and
 * the arrays are repacked (the bins are still held, so it takes only a repacking of the
 * arrays, not a rebuild).
 */

import type { DrapeElement, DrapeQuadBreak, DrapeTile, TileBins } from './binning.js';
import { binTile, drapeCellWorkBudget } from './binning.js';

/** The number of style texels per element */
export const DRAPE_STYLE_TEXELS = 5;

/**
 * The index of the texel the selection highlight uses within the style table
 *
 * 0 = fill, 1 = stroke, 2 = specifications (width, kind, source, reference zoom), 3 =
 * selection, 4 = the dash pattern (`DRAPE_DASH_TEXEL`). The selection alone is put in a separate texel so that the index (the binning)
 * need not be touched at all when the selection changes. Mixing it into the same texel as the
 * color or the width would mean rebuilding the other values too on every rewrite.
 */
export const DRAPE_SELECTION_TEXEL = 3;

/**
 * The index of the texel of the dash pattern within the style table
 *
 * (a, b, c, pixel ratio): the coefficients of the pattern (`DrapeDash` in `binning.ts`) and the
 * physical pixels of the width per CSS pixel. A pixel ratio of 0 marks a solid outline.
 */
export const DRAPE_DASH_TEXEL = 4;

/** The upper bound on the tiles retained (beyond it, those outside the view are dropped and
 * the arrays are repacked) */
const MAX_CACHED_TILES = 96;

/** The upper bound on the number of edge texels (16 bytes per texel, so 1M is 16MB) */
export const DRAPE_MAX_EDGE_TEXELS = 1_048_576;

/** The key of a tile */
export function drapeTileKey(tile: DrapeTile): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

/** The position of one packed tile */
export interface DrapeTileEntry {
  /** A tile that cannot be put through the analytic evaluation (it is not drawn) */
  readonly unfit: boolean;
  readonly grid: number;
  /** The starting position within the cell index texture (in texels) */
  readonly cellOffset: number;
  /** The binning result (used when repacking) */
  readonly bins: TileBins;
  /** The number of the frame it was used in most recently */
  lastUsed: number;
}

/**
 * The arrays packed into the data textures (append-only)
 *
 * Adding a tile only piles it onto the end, so the transfer to the GPU is limited to the rows
 * that were added (the renderer remembers the position it has transferred up to).
 */
export class DrapePackBuilder {
  private static nextId = 1;

  /** The identity of this version (with which the renderer tells whether it has been
   * transferred) */
  readonly id = DrapePackBuilder.nextId++;

  edges: Float32Array<ArrayBuffer> = new Float32Array(4 * 4096);
  /** Where each edge starts along its path (one number per edge, in step with `edges`) */
  edgeStarts: Float32Array<ArrayBuffer> = new Float32Array(4096);
  edgeCount = 0;
  runs: Float32Array<ArrayBuffer> = new Float32Array(4 * 2048);
  runCount = 0;
  cells: Float32Array<ArrayBuffer> = new Float32Array(4 * 4096);
  cellCount = 0;
  styles: Float32Array<ArrayBuffer> = new Float32Array(0);
  elementCount = 0;

  /**
   * The version of the selection (when it changes, the style table is sent again)
   *
   * Edges, runs and cells are append-only so sending only the added rows is enough, but the
   * selection rewrites rows that have already been sent. The renderer tells a rewrite apart by
   * this version.
   */
  selectionVersion = 0;

  /** The number of elements with the selection mark raised (for diagnostics) */
  markedCount = 0;

  /** Builds the style table (only when the element order changes) */
  setElements(elements: readonly DrapeElement[]): void {
    const styles = new Float32Array(Math.max(1, elements.length) * DRAPE_STYLE_TEXELS * 4);
    for (let f = 0; f < elements.length; f++) {
      const at = f * DRAPE_STYLE_TEXELS * 4;
      const element = elements[f];
      styles[at] = element.fill[0];
      styles[at + 1] = element.fill[1];
      styles[at + 2] = element.fill[2];
      styles[at + 3] = element.fill[3];
      styles[at + 4] = element.stroke[0];
      styles[at + 5] = element.stroke[1];
      styles[at + 6] = element.stroke[2];
      styles[at + 7] = element.stroke[3];
      // The width has already been converted into physical pixels at dataset time
      styles[at + 8] = element.strokeWidthPx;
      styles[at + 9] = element.kind;
      styles[at + 10] = element.source;
      styles[at + 11] = element.widthZoom;
      const dash = element.dash;
      if (dash) {
        const dashAt = at + DRAPE_DASH_TEXEL * 4;
        styles[dashAt] = dash.a;
        styles[dashAt + 1] = dash.b;
        styles[dashAt + 2] = dash.c;
        styles[dashAt + 3] = dash.pixelRatio;
      }
    }
    this.styles = styles;
    this.elementCount = elements.length;
  }

  /**
   * Rewrites the marks of the selection highlight
   *
   * What is rewritten is only one texel of the style table (`DRAPE_SELECTION_TEXEL`); the
   * index (edges, runs, cells) is not touched at all. The selection changes with a single
   * click, whereas rebuilding the index takes several hundred milliseconds for 8,172
   * administrative boundaries, so it cannot be rebuilt on every selection.
   *
   * @returns Whether anything actually changed (it is transferred again only when it did)
   */
  setSelection(elements: readonly DrapeElement[], selected: ReadonlySet<string>): boolean {
    let changed = false;
    let marked = 0;
    const count = Math.min(elements.length, this.elementCount);
    for (let f = 0; f < count; f++) {
      const key = elements[f].selectionKey;
      const on = key !== '' && selected.has(key) ? 1 : 0;
      if (on === 1) marked++;
      const at = (f * DRAPE_STYLE_TEXELS + DRAPE_SELECTION_TEXEL) * 4;
      if (this.styles[at] === on) continue;
      this.styles[at] = on;
      changed = true;
    }
    this.markedCount = marked;
    if (changed) this.selectionVersion++;
    return changed;
  }

  /** Piles one tile onto the end */
  addTile(bins: TileBins): number {
    const edgeBase = this.edgeCount;
    const runBase = this.runCount;
    const cellOffset = this.cellCount;

    const edgeTexels = bins.edges.length / 4;
    this.edges = ensureCapacity(this.edges, (this.edgeCount + edgeTexels) * 4);
    this.edges.set(bins.edges, edgeBase * 4);
    this.edgeStarts = ensureCapacity(this.edgeStarts, this.edgeCount + edgeTexels);
    this.edgeStarts.set(bins.edgeStarts, edgeBase);
    this.edgeCount += edgeTexels;

    const runTexels = bins.runs.length / 4;
    this.runs = ensureCapacity(this.runs, (this.runCount + runTexels) * 4);
    for (let i = 0; i < runTexels; i++) {
      const at = (runBase + i) * 4;
      this.runs[at] = bins.runs[i * 4];
      this.runs[at + 1] = bins.runs[i * 4 + 1] + edgeBase;
      this.runs[at + 2] = bins.runs[i * 4 + 2];
      this.runs[at + 3] = bins.runs[i * 4 + 3];
    }
    this.runCount += runTexels;

    const cellTexels = bins.grid * bins.grid;
    this.cells = ensureCapacity(this.cells, (this.cellCount + cellTexels) * 4);
    for (let c = 0; c < cellTexels; c++) {
      const at = (cellOffset + c) * 4;
      this.cells[at] = bins.cells[c * 2] + runBase;
      this.cells[at + 1] = bins.cells[c * 2 + 1];
      this.cells[at + 2] = 0;
      this.cells[at + 3] = 0;
    }
    this.cellCount += cellTexels;

    return cellOffset;
  }
}

/** Doubles the capacity and copies when it is not enough */
function ensureCapacity(
  array: Float32Array<ArrayBuffer>,
  needed: number,
): Float32Array<ArrayBuffer> {
  if (array.length >= needed) return array;
  let size = Math.max(1024, array.length);
  while (size < needed) size *= 2;
  const out = new Float32Array(size);
  out.set(array);
  return out;
}

/** One version (the element order and the index built with that order) */
interface PackState {
  readonly revision: string;
  readonly elements: readonly DrapeElement[];
  /**
   * The breaks in the stacking order (the positions of the images)
   *
   * Held as a pair with the element list. A break is an index into the element order, so
   * "drawing the old index with the new breaks" while the versions are being swapped would
   * paint a different element or paint nothing. The rendering side must always use the breaks
   * of the version it draws.
   */
  readonly quadBreaks: readonly DrapeQuadBreak[];
  /**
   * The starting position of each entry of the stack (an index into the element list) and the
   * index at which the datasets above the stack begin. Like the breaks, they are held as a
   * pair with the element list, and the rendering side always uses those of the version it
   * draws (the index that lets a frame paint only the elements of its interval)
   */
  readonly entryStarts: ReadonlyMap<string, number>;
  readonly aboveStoreStart: number;
  readonly builder: DrapePackBuilder;
  readonly entries: Map<string, DrapeTileEntry>;
  overflow: boolean;
}

/** The result of the preparation */
export interface DrapePrepareResult {
  /** The estimate of the tile with the most edges among the tiles of the view (diagnostic) */
  readonly maxTileEdges: number;
  /** The maximum number of edges that fell into one cell (diagnostic) */
  readonly maxEdgesPerCell: number;
  /** The maximum number of runs that fell into one cell (diagnostic) */
  readonly maxRunsPerCell: number;
  /** The number of cells truncated for exceeding the budget (diagnostic) */
  readonly truncatedCells: number;
  /** The number of tiles that could not be put through the analytic evaluation (diagnostic) */
  readonly unfitTiles: number;
  /** Whether all the tiles drawable in this frame are ready (it draws even when they are
   * not) */
  readonly complete: boolean;
  /** Whether anything is left over (it then requests another frame) */
  readonly pending: boolean;
  /** Whether there was a cell that exceeded the budget */
  readonly overflow: boolean;
  /** The number of tiles built in this frame */
  readonly built: number;
}

/** The set used when nothing is selected (so that one is not created every time) */
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

/** Whether the selection sets are the same (judged by the size and the elements) */
function sameSelection(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const key of a) {
    if (!b.has(key)) return false;
  }
  return true;
}

/**
 * The current time (in ms)
 */
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * The store of the tile indices
 */
export class DrapeTileStore {
  private active: PackState | null = null;
  private pending: PackState | null = null;
  private frame = 0;
  /** The keys of the features currently selected (drapeSelectionKey in `binning.ts`) */
  private selection: ReadonlySet<string> = EMPTY_SELECTION;

  /**
   * Announces the element order
   *
   * When the version changes, a new version is started. The old version can keep being drawn
   * as it is.
   */
  sync(
    revision: string,
    elements: readonly DrapeElement[],
    quadBreaks: readonly DrapeQuadBreak[] = [],
    entryStarts: ReadonlyMap<string, number> = new Map(),
    aboveStoreStart: number = elements.length,
  ): void {
    if (this.active && this.active.revision === revision) {
      if (this.pending) this.pending = null;
      return;
    }
    if (this.pending?.revision === revision) return;
    const state = createState(revision, elements, quadBreaks, entryStarts, aboveStoreStart);
    // The current selection is copied into the version that was just started too (without
    // this, the highlight drops for exactly one frame right after the element order changes)
    state.builder.setSelection(state.elements, this.selection);
    if (this.active) this.pending = state;
    else this.active = state;
  }

  /**
   * Announces the targets of the selection highlight (the rendering side calls it every frame)
   *
   * It does nothing when the contents are the same. Scanning all the elements every frame with
   * the same set would be a wasted scan per frame for 8,172 administrative boundaries. How
   * they are drawn is held in the per-version style table, so the same selection is copied
   * into the version under construction (pending) as well.
   */
  setSelection(selected: ReadonlySet<string>): void {
    if (sameSelection(this.selection, selected)) return;
    // A copy is held so that it does not waver if the caller later rewrites the set it
    // passes around
    this.selection = new Set(selected);
    if (this.active) this.active.builder.setSelection(this.active.elements, this.selection);
    if (this.pending) this.pending.builder.setSelection(this.pending.elements, this.selection);
  }

  /**
   * Prepares the indices of the tiles of the view
   *
   * @param tiles The terrain tiles of the view
   * @param budgetMs The time that may be used in this frame (at least one tile is always
   *   built; at 0 or less, not a single one is built)
   * @param zoom The current zoom (used to estimate the line width, which decides the margin of
   *   the index)
   */
  prepare(tiles: readonly DrapeTile[], budgetMs: number, zoom = 0): DrapePrepareResult {
    this.frame++;
    const target = this.pending ?? this.active;
    if (!target) {
      return {
        complete: false,
        pending: false,
        overflow: false,
        built: 0,
        maxTileEdges: 0,
        maxEdgesPerCell: 0,
        maxRunsPerCell: 0,
        truncatedCells: 0,
        unfitTiles: 0,
      };
    }

    const start = nowMs();
    // The screen is shared among the tiles, so the more tiles there are the fewer pixels
    // each one has
    const maxCellWork = drapeCellWorkBudget(tiles.length);
    let built = 0;
    for (const tile of tiles) {
      const key = drapeTileKey(tile);
      const hit = target.entries.get(key);
      if (hit) {
        hit.lastUsed = this.frame;
        continue;
      }
      // A budget of 0 or less is an explicit skip meaning "build not a single one"
      // (the deferral while the camera is moving). With a normal budget at least one is
      // always built (so that progress does not stall).
      if (budgetMs <= 0) continue;
      if (built > 0 && nowMs() - start >= budgetMs) continue;
      const bins = binTile(target.elements, tile, { maxCellWork, zoom });
      const cellOffset = target.builder.addTile(bins);
      target.entries.set(key, {
        unfit: bins.overflow,
        grid: bins.grid,
        cellOffset,
        bins,
        lastUsed: this.frame,
      });
      built++;
    }

    // The new version replaces the old one once it covers the view better.
    //
    // The principle is "draw with the old version until it is ready", but when the old version
    // does not cover the current view at all (the zoom or the place moved a lot), waiting for
    // the old version only leaves the fill missing. Comparing the number of tiles covered
    // picks "whichever can draw more" in either case.
    if (this.pending && this.active) {
      const covered = (state: PackState): number => {
        let n = 0;
        for (const tile of tiles) if (state.entries.has(drapeTileKey(tile))) n++;
        return n;
      };
      if (covered(this.pending) >= covered(this.active)) {
        this.active = this.pending;
        this.pending = null;
      }
    }

    const active = this.active;
    if (active) {
      this.compactIfNeeded(active, tiles);
      // Whether there are still tiles not built in the current version
      let activeMissing = 0;
      let unfit = 0;
      let maxTileEdges = 0;
      let maxEdgesPerCell = 0;
      let maxRunsPerCell = 0;
      let truncatedCells = 0;
      for (const tile of tiles) {
        const entry = active.entries.get(drapeTileKey(tile));
        if (!entry) {
          activeMissing++;
          continue;
        }
        if (entry.unfit) unfit++;
        maxTileEdges = Math.max(maxTileEdges, entry.bins.edgeEstimate);
        maxEdgesPerCell = Math.max(maxEdgesPerCell, entry.bins.maxEdgesPerCell);
        maxRunsPerCell = Math.max(maxRunsPerCell, entry.bins.maxRunsPerCell);
        truncatedCells += entry.bins.truncatedCells;
      }
      // Once the tiles that do not go through the analytic evaluation exceed a quarter of the
      // view, the whole map is handed to the vertex displacement path (a zoomed-out view falls
      // into this case; each tile is so wide that dropping a single one loses half the
      // picture). In a pitched view a single coarse tile in the distance can fall out, and
      // that one tile is simply not drawn (it is a strip at the corner of the screen, and the
      // rest can be kept on the analytic evaluation)
      return {
        complete: activeMissing === 0,
        pending: activeMissing > 0 || this.pending !== null,
        overflow: tiles.length > 0 && unfit * 4 > tiles.length,
        built,
        maxTileEdges,
        maxEdgesPerCell,
        maxRunsPerCell,
        truncatedCells,
        unfitTiles: unfit,
      };
    }
    return {
      complete: false,
      pending: true,
      overflow: false,
      built,
      maxTileEdges: 0,
      maxEdgesPerCell: 0,
      maxRunsPerCell: 0,
      truncatedCells: 0,
      unfitTiles: 0,
    };
  }

  /** The version used for rendering */
  get pack(): DrapePackBuilder | null {
    return this.active?.builder ?? null;
  }

  /** The number of elements of the version used for rendering */
  get elementCount(): number {
    return this.active?.elements.length ?? 0;
  }

  /**
   * The breaks in the stacking order of the version used for rendering (the positions of the
   * images)
   *
   * It returns those of the version being drawn right now, not of the version that was just
   * collected. While a rebuild is in progress the old version keeps being drawn, so making
   * only the breaks new would make the indices disagree with the element list and the
   * segmented rendering would paint a different element or paint nothing.
   */
  get quadBreaks(): readonly DrapeQuadBreak[] {
    return this.active?.quadBreaks ?? [];
  }

  /** The starting position of each entry of the stack, in the version being drawn */
  get entryStarts(): ReadonlyMap<string, number> {
    return this.active?.entryStarts ?? EMPTY_ENTRY_STARTS;
  }

  /** The index at which the datasets above the stack begin, in the version being drawn */
  get aboveStoreStart(): number {
    return this.active?.aboveStoreStart ?? this.elementCount;
  }

  /** The position of one tile */
  entryOf(tile: DrapeTile): DrapeTileEntry | undefined {
    return this.active?.entries.get(drapeTileKey(tile));
  }

  /** Throws everything away */
  clear(): void {
    this.active = null;
    this.pending = null;
  }

  /**
   * Once the amount retained exceeds the upper bound, keeps only the tiles of the view and
   * repacks
   *
   * The bins are still held, so it takes only a repacking of the arrays, not a rebuild.
   */
  private compactIfNeeded(state: PackState, tiles: readonly DrapeTile[]): void {
    if (
      state.entries.size <= MAX_CACHED_TILES &&
      state.builder.edgeCount <= DRAPE_MAX_EDGE_TEXELS
    ) {
      return;
    }

    const keep = new Set(tiles.map(drapeTileKey));
    const builder = new DrapePackBuilder();
    builder.setElements(state.elements);
    // The repacked builder rebuilds the style table, so the selection marks are copied again
    // as well. Forgetting to copy them means setSelection returns early as long as the set
    // does not change and the highlight never comes back (it shows up as a selection that
    // "disappears when you zoom")
    builder.setSelection(state.elements, this.selection);
    const entries = new Map<string, DrapeTileEntry>();
    for (const [key, entry] of state.entries) {
      if (!keep.has(key)) continue;
      const cellOffset = builder.addTile(entry.bins);
      entries.set(key, { ...entry, cellOffset });
    }

    const replaced: PackState = {
      revision: state.revision,
      elements: state.elements,
      quadBreaks: state.quadBreaks,
      entryStarts: state.entryStarts,
      aboveStoreStart: state.aboveStoreStart,
      builder,
      entries,
      overflow: state.overflow,
    };
    // If it still does not fit after repacking, the view itself exceeds the budget. The
    // degradation flag is raised and it is handed to the vertex displacement path
    if (builder.edgeCount > DRAPE_MAX_EDGE_TEXELS) replaced.overflow = true;

    if (this.active === state) this.active = replaced;
    if (this.pending === state) this.pending = replaced;
  }
}

/** Starts a version */
function createState(
  revision: string,
  elements: readonly DrapeElement[],
  quadBreaks: readonly DrapeQuadBreak[],
  entryStarts: ReadonlyMap<string, number>,
  aboveStoreStart: number,
): PackState {
  const builder = new DrapePackBuilder();
  builder.setElements(elements);
  return {
    revision,
    elements,
    quadBreaks,
    entryStarts,
    aboveStoreStart,
    builder,
    entries: new Map(),
    overflow: false,
  };
}

const EMPTY_ENTRY_STARTS: ReadonlyMap<string, number> = new Map();
