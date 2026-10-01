// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The CPU-side precomputation (binning) for the analytic drape
 *
 * The fragment shader solves "is this pixel inside the feature, and how far is
 * it from an edge" on the spot every time. Sweeping every edge of every feature
 * for each pixel is impossible, so the inside of a tile is cut into a coarse
 * grid (grid x grid) and, for each cell, "the list of edges that touch that
 * cell" and "whether the origin of the cell is inside that feature" are
 * computed in advance.
 *
 * The inside/outside test for a pixel starts from "the inside/outside of the
 * cell origin" and is decided by the number of crossings between the edges and
 * the segment drawn from the cell origin to the pixel. The segment fits
 * entirely inside the cell, so an edge that could cross it is always in the
 * list of that cell (because every cell an edge passes through gets it). This
 * is what keeps the inside/outside test from breaking when edges are thinned.
 *
 * The resolution of the grid is decided per tile. The polygons and lines of
 * datasets are now placed here as well, and the number of edges
 * touching a single tile therefore varies by three orders of magnitude. With a
 * fixed 8x8, thousands of edges would go into a single cell and exceed the
 * budget; conversely, applying a fine grid to every tile makes the index alone
 * bloat on empty tiles.
 *
 * The amount of scanning is proportional to "the edges relevant to the tile".
 * Elements are dropped by their bounding box, and edges are dropped by the
 * bounding box of chunks of 64 edges (the blocks in geometry.ts), so even for a
 * dataset with a million vertices the work per tile amounts only to the
 * outlines that run through it. This runs on edit and when a new tile enters
 * the view, and only then (not every frame; `bin-store.ts` caches per tile).
 */

import type { DrapeBounds, DrapeGeometry, DrapeGeometryPath } from './geometry.js';
import { DRAPE_BLOCK_EDGES, drapePathStarts, drapeQuantizedGeometry } from './geometry.js';

/** The minimum number of divisions of the grid (per side) */
export const DRAPE_MIN_CELLS = 8;

/** The maximum number of divisions of the grid (per side) */
export const DRAPE_MAX_CELLS = 64;

/**
 * The maximum number of divisions of the grid (per side) allowed on a retry
 *
 * Only when cells that exceed the budget remain is the grid made this fine and rebuilt.
 */
export const DRAPE_RETRY_MAX_CELLS = 128;

/**
 * The target number of edges to put into one cell (the grid is made finer so as not to exceed it)
 *
 * It is set at half of the upper limit of the work per pixel (DRAPE_MAX_CELL_WORK). If the
 * target were the same as the limit, even a single straightforward feature would sit right at
 * the limit and unnecessary quantization would be applied.
 */
export const DRAPE_TARGET_EDGES_PER_CELL = 12;

/** The target number of elements to put into one cell (this decides the number of runs) */
export const DRAPE_TARGET_ELEMENTS_PER_CELL = 4;

/** The maximum number of edges one cell can hold (a cell that exceeds it signals degradation) */
export const DRAPE_MAX_EDGES_PER_CELL = 256;

/**
 * The maximum number of runs (the span of one feature) one cell can hold
 *
 * A cell that exceeds it is truncated inside that cell alone (the elements at the back of the
 * draw order = in front are dropped). The only cells this applies to are those of a coarse
 * distant tile where dozens of items overlap in a single pixel. The map as a whole is never
 * degraded.
 */
export const DRAPE_MAX_RUNS_PER_CELL = 128;

/**
 * The maximum number of edges handled by a single tile
 *
 * First the vertices are quantized onto a grid (LOD) to make them fit. A tile that still
 * exceeds the limit is not built and returns the degradation signal instead (discarding it
 * after building would stall the frame for exactly that long).
 *
 * The value was taken from measurements. Putting 8,172 administrative boundaries (about 1.1
 * million vertices) through a single tile, building the index takes 0.8ms at z13, 1.2ms at
 * z12, 4.0ms at z11, 15.6ms at z10 and 23.4ms at z9. 200,000 edges is roughly 20ms, and the
 * only tiles that reach this amount are the coarse ones, of which there are just a few in the
 * view (they are built only once, and after that the cache of the tile index takes over). The
 * amount for the whole view is held down separately by the budget of the edge texture
 * (DRAPE_MAX_EDGE_TEXELS in bin-store).
 */
export const DRAPE_MAX_EDGES_PER_TILE = 200_000;

/**
 * The upper limit of the amount solved per cell (the average of runs + edges)
 *
 * A fragment walks the runs of its own cell in order and, for each run, sweeps the edges of
 * that cell. The work per pixel is therefore roughly "the number of runs + the number of edges
 * of that cell". When the map is zoomed far out, nested administrative areas (prefectures,
 * districts, municipalities) and neighboring areas pile up dozens deep in a single cell and
 * this amount jumps. In measurements it reached 500ms per frame over the whole Kanto region at
 * z8.7.
 *
 * A tile that exceeds this is not suited to the analytic evaluation. The vertex displacement
 * path takes it over (in a zoomed-out view the relief of the terrain is small on screen, so
 * vertex displacement does not break down either).
 *
 * The actual limit is scaled up by the number of tiles in the view. The screen is shared out
 * among the tiles, so the more tiles there are the fewer pixels each one has, and the same
 * work per pixel costs less for the frame as a whole (`drapeCellWorkBudget`).
 */
export const DRAPE_MAX_CELL_WORK = 24;

/**
 * Derives the upper limit of the work per cell from the number of tiles in the view
 */
export function drapeCellWorkBudget(tileCount: number): number {
  const factor = Math.min(8, Math.max(1, tileCount / 4));
  return DRAPE_MAX_CELL_WORK * factor;
}

/**
 * The number of edges at which the vertices start being quantized onto a grid
 *
 * A tile below this solves the original geometry as it is (every view at a normal zoom is on
 * this side, and quantization applies only to coarse distant tiles).
 */
export const DRAPE_LOD_TRIGGER = 16_000;

/** The resolution of the quantization grid (a single tile is stepped by 2^9 = 512) */
const DRAPE_TILE_SAMPLES_LOG2 = 9;

/**
 * The lower bound of the quantization (a single tile is never made coarser than 2^8 = 256)
 *
 * A terrain tile is drawn at roughly 512 pixels on screen, so this step corresponds to 2
 * pixels. Quantizing more coarsely than this makes polygons look like staircase-shaped blocks
 * (verified in the field, the whole Kanto region at z8.7). A tile that does not fit even when
 * made coarser is not suited to the analytic evaluation, so it is handed to the vertex
 * displacement path.
 */
const DRAPE_MIN_SAMPLES_LOG2 = 8;

/**
 * The smallest size a terrain tile is assumed to occupy on screen (physical pixels)
 *
 * Outlines are drawn with a width in screen pixels, so even an edge outside a cell can paint
 * pixels inside the cell. This is the conservative estimate used to convert that margin into
 * in-tile coordinates (an actual tile is often drawn larger than this, and the margin comes out
 * on the safe side by that much).
 */
const TILE_SCREEN_PX = 256;

/**
 * The lower and upper bounds of the margin (in-tile coordinates)
 *
 * Outlines are drawn with a width in screen pixels, so even an edge outside a cell can paint
 * pixels inside the cell. The lower bound is the minimum needed to keep that from being missed
 * (the drawn range fits inside the tile's [0, 1], so the margin is decided by the thickness of
 * the outline alone).
 */
const MIN_MARGIN = 0.0025;
// The upper bound is the size of the coarsest cell (1 / DRAPE_MIN_CELLS). A margin larger than
// that would amount to "handing a single edge out to the whole tile", and only the index bloats
const MAX_MARGIN = 1 / DRAPE_MIN_CELLS;

/** The color (0..1, with the opacity already folded in) */
export type DrapeColor = readonly [number, number, number, number];

/**
 * The dash pattern of an outline that is not solid
 *
 * The coefficients are those of `DASH_COEFFICIENTS` in `view/renderers/line/dash.ts`: the shader
 * works the dash and the gap out of the width the line has in the frame, with the same formulas
 * as the subdividing path.
 */
export interface DrapeDash {
  /** The shortest dash (CSS px) */
  readonly a: number;
  /** The dash per pixel of width */
  readonly b: number;
  /** The gap per pixel of width */
  readonly c: number;
  /**
   * The physical pixels of `strokeWidthPx` per CSS pixel (the pixel ratio the width was
   * resolved with). The pattern is measured in CSS pixels, so the shader divides it back out
   */
  readonly pixelRatio: number;
}

/**
 * An element handed to the analytic drape (a feature of the Store and a feature of a
 * dataset have the same shape)
 */
export interface DrapeElement {
  /** 0 = polygon, 1 = line */
  readonly kind: 0 | 1;
  /** The bounding box in Mercator (this alone is enough to narrow the tiles down) */
  readonly bounds: DrapeBounds;
  /**
   * The geometry in Mercator coordinates (built at the point it becomes necessary)
   *
   * The coordinates of a feature that does not enter the view are not converted. Converting
   * every feature up front comes as a single hit of 76ms for 1.1 million vertices (measured).
   */
  geometry(): DrapeGeometry;
  /** The color of the fill (lines do not use it) */
  readonly fill: DrapeColor;
  /** The color of the outline */
  readonly stroke: DrapeColor;
  /** The width of the outline (physical pixels). 0 means the outline is not drawn */
  readonly strokeWidthPx: number;
  /**
   * The dash pattern of the outline (absent or null for a solid outline)
   *
   * Only an element with a pattern has the lengths along its paths worked out and binned next
   * to its edges (`TileBins.edgeStarts`).
   */
  readonly dash?: DrapeDash | null;
  /**
   * The origin of the coefficients (0 = the Store, 1 and above = datasets)
   *
   * The zoom-linked opacity and scale change from frame to frame, so instead of being baked
   * into the element they are applied through a uniform at draw time. Baking them in would
   * mean redoing the binning of every tile each time the zoom moves.
   */
  readonly source: number;
  /**
   * The reference zoom of the line width (an element without one has -1 = fixed in screen pixels)
   *
   * The retained batch path changes the thickness by `2^(zoom - createdZoom)`, so the drape
   * applies the same formula in the shader as well (the thickness does not change with or
   * without the terrain).
   */
  readonly widthZoom: number;
  /**
   * The identifier of the selection highlight (an empty string = not a target of highlighting)
   *
   * Only a feature of a dataset has one. A selection changes with a single
   * click, whereas the index (the binning) is rebuilt only on edit and when the view swaps
   * tiles. The selection therefore cannot be baked into the element, and instead a single texel
   * of the style table is rewritten on every draw (`setSelection` in `bin-store.ts`). This is
   * the key used to match them up.
   *
   * A feature of the Store uses an empty string. A selection in the Store is expressed by the
   * selection UI (the box and the handles) rather than by a red overpaint, so the drape never
   * changes its color.
   */
  readonly selectionKey: string;
}

/**
 * The break of the stacking order (the position of an image)
 *
 * An image (Image) is not carried by the analytic evaluation (a texture cannot be brought into
 * the per-pixel compositing loop), but it can be pasted onto the ground surface by the quad
 * drape. To preserve the stacking order it is enough to split the element list at the position
 * of an image and draw each section by range, slipping the image in between. The position of
 * that break is remembered at the time of dataset.
 *
 * The position is an index within the ordering of the elements, so it must always be handled
 * together with the element list of the same version (drawing an old index with a new break
 * while the version of the index is being swapped would paint a different element, or paint
 * nothing at all). That is why `bin-store.ts` holds it together with the element list.
 */
export interface DrapeQuadBreak {
  /** The feature ID of the image */
  readonly featureId: string;
  /** The number of elements stacked below this image (= the position of the break) */
  readonly afterElements: number;
}

/**
 * Builds the key of the selection highlight
 *
 * So that IDs colliding across datasets are never mistaken for one another, the dataset
 * ID and the feature ID are tied together with a delimiter. The side that builds the elements
 * (`pass.ts`) and the side that collects the selection (`view/layer/drape-planner.ts`) use the
 * same function.
 */
export function drapeSelectionKey(datasetId: string, featureId: string): string {
  return `${datasetId}\u0000${featureId}`;
}

/** The binning result for a single tile */
export interface TileBins {
  /** The number of divisions of the grid (per side) */
  readonly grid: number;
  /** (runStart, runCount) per cell. Length = grid * grid * 2 */
  readonly cells: Int32Array;
  /** (elementIndex, edgeStart, edgeCount, baseInside) per run */
  readonly runs: Float32Array;
  /** (x0, y0, x1, y1) per edge. In-tile 0..1 coordinates */
  readonly edges: Float32Array;
  /**
   * Where each edge starts along its path, one per edge (Mercator units, the 0..1 world; not
   * in-tile). 0 for an edge of an element without a dash pattern
   */
  readonly edgeStarts: Float32Array;
  /** Whether a limit was exceeded (if it was, the caller degrades) */
  readonly overflow: boolean;
  /** The number of cells truncated for exceeding the budget (a local degradation. Diagnostic) */
  readonly truncatedCells: number;
  /** The average amount solved per cell (runs + edges). A guide to the cost of the fragment */
  readonly cellWork: number;
  /** The estimate of the edges relevant to this tile (used for diagnostics and budget checks) */
  readonly edgeEstimate: number;
  /** The largest number of edges that went into one cell (diagnostic) */
  readonly maxEdgesPerCell: number;
  /** The largest number of runs that went into one cell (diagnostic) */
  readonly maxRunsPerCell: number;
}

/** The identity of a tile */
export interface DrapeTile {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * The margin of an element (in-tile coordinates)
 *
 * A line is drawn with a thickness in screen pixels, so even an edge outside a cell paints
 * pixels inside the cell. This is the margin used to hand that reach out to the cells. For an
 * element that has a reference zoom the thickness changes by `2^(zoom - widthZoom)`, so the
 * same factor is applied to the estimate as well. Forgetting to apply it eats the fringe of a
 * thickened, zoomed-in line at the cell boundaries and chips it away into a jagged edge.
 *
 * @param strokeWidthPx The thickness at the reference zoom (physical pixels)
 * @param widthZoom The reference zoom of the thickness (negative means fixed in screen pixels)
 * @param zoom The current zoom
 */
export function drapeMarginOf(strokeWidthPx: number, widthZoom = -1, zoom = 0): number {
  const scale = widthZoom >= 0 ? 2 ** (zoom - widthZoom) : 1;
  const half = strokeWidthPx * scale * 0.5 + 1;
  return Math.min(MAX_MARGIN, Math.max(MIN_MARGIN, half / TILE_SCREEN_PX));
}

/**
 * Decides the number of divisions of the grid (a power of two)
 *
 * From the number of edges it picks a resolution that fits within "the target number per cell",
 * and holds it back to the range where a cell does not become smaller than the margin (if the
 * margin were larger than a cell, a single edge would be scattered as far as the cell after
 * the next one and only the index would bloat).
 */
export function chooseGrid(edgeCount: number, margin: number, elementCount = 0): number {
  let grid = DRAPE_MIN_CELLS;
  const want = Math.max(
    Math.sqrt(Math.max(1, edgeCount) / DRAPE_TARGET_EDGES_PER_CELL),
    Math.sqrt(Math.max(1, elementCount) / DRAPE_TARGET_ELEMENTS_PER_CELL),
  );
  while (grid < DRAPE_MAX_CELLS && grid < want) grid *= 2;
  while (grid > DRAPE_MIN_CELLS && 1 / grid < margin) grid /= 2;
  return grid;
}

/**
 * Performs the binning for a single tile
 *
 * @param elements The elements in draw order (the whole ordering. The index becomes the row of
 *   the style)
 * @param tile The tile
 * @param candidates The indices of the elements narrowed down in advance (when omitted, every
 *   element is looked at)
 */
export function binTile(
  elements: readonly DrapeElement[],
  tile: DrapeTile,
  options?: { candidates?: readonly number[]; maxCellWork?: number; zoom?: number },
): TileBins {
  const candidates = options?.candidates;
  const maxCellWork = options?.maxCellWork ?? DRAPE_MAX_CELL_WORK;
  const zoom = options?.zoom ?? 0;
  const scale = 2 ** tile.z;
  const floorLevel = tile.z + DRAPE_MIN_SAMPLES_LOG2;

  // Pass 1: pick the relevant elements and estimate the amount of edges. If the amount is
  // large, swap in geometry whose vertices have been quantized onto a grid (LOD) matching the
  // resolution of that tile.
  let quantizeLevel = 0;
  let picked = pickElements(elements, candidates, tile, scale, quantizeLevel, zoom);

  if (picked.edgeEstimate > DRAPE_LOD_TRIGGER) {
    // Start from a grid that steps a single tile by roughly 512 and make it coarser one level
    // at a time until it fits the budget. It must not skip ahead. The number of edges does not
    // fall in proportion to the coarseness of the quantization; past a certain coarseness
    // whole polygons collapse and it drops all at once. Skipping would pick a grid far coarser
    // than necessary and polygons would look like square blocks (verified in the field, the
    // whole Kanto region at z8.7)
    for (
      quantizeLevel = tile.z + DRAPE_TILE_SAMPLES_LOG2;
      quantizeLevel >= floorLevel;
      quantizeLevel--
    ) {
      picked = pickElements(elements, candidates, tile, scale, quantizeLevel, zoom);
      if (picked.edgeEstimate <= DRAPE_MAX_EDGES_PER_TILE) break;
    }
    if (quantizeLevel < floorLevel) quantizeLevel = floorLevel;
  }

  if (picked.edgeEstimate > DRAPE_MAX_EDGES_PER_TILE) {
    // It does not fit even after quantization. Building alone takes hundreds of milliseconds,
    // so it is degraded without being built
    return emptyBins(DRAPE_MIN_CELLS, picked.edgeEstimate, true);
  }

  let grid = chooseGrid(picked.edgeEstimate, picked.maxMargin, picked.indices.length);
  if (picked.indices.length === 0) return emptyBins(grid, picked.edgeEstimate, false);

  // Pass 2: actually build it. If cells that exceed the budget of a cell remain, those cells
  // end up "solving inside/outside with too few edges" and show up as square blotches where a
  // whole cell is painted. While truncation remains the grid is made finer, and if that is
  // still not enough the quantization is made coarser and it is rebuilt. Only when there is
  // nothing left to try does it return the degradation signal.
  for (let attempt = 0; attempt < 10; attempt++) {
    const bins = assembleBins(elements, picked, tile, scale, grid, zoom);
    // A tile with too much work per pixel does not get any lighter whether the quantization is
    // applied or the grid is made finer (the sheer number of deeply overlapping polygons is
    // the cost). It is not suited to the analytic evaluation, so it returns the degradation
    // signal as it is
    if (bins.cellWork > maxCellWork) return { ...bins, overflow: true };
    if (bins.truncatedCells === 0) return bins;

    if (grid < DRAPE_RETRY_MAX_CELLS) {
      grid *= 2;
      continue;
    }
    if (quantizeLevel === 0) {
      quantizeLevel = tile.z + DRAPE_TILE_SAMPLES_LOG2;
    } else if (quantizeLevel > floorLevel) {
      quantizeLevel -= 1;
    } else {
      return { ...bins, overflow: true };
    }
    picked = pickElements(elements, candidates, tile, scale, quantizeLevel, zoom);
    // A grid that has once been made finer is never put back (putting it back would only
    // repeat the work of making it finer)
    grid = Math.max(grid, chooseGrid(picked.edgeEstimate, picked.maxMargin, picked.indices.length));
  }

  return emptyBins(DRAPE_MIN_CELLS, picked.edgeEstimate, true);
}

/** Empty bins (the common way to return for a degradation and for no relevant elements) */
function emptyBins(grid: number, edgeEstimate: number, overflow: boolean): TileBins {
  return {
    grid,
    cells: new Int32Array(grid * grid * 2),
    runs: new Float32Array(0),
    edges: new Float32Array(0),
    edgeStarts: new Float32Array(0),
    overflow,
    truncatedCells: 0,
    cellWork: 0,
    edgeEstimate,
    maxEdgesPerCell: 0,
    maxRunsPerCell: 0,
  };
}

/**
 * Actually builds the picked elements into the index with the grid that was decided
 */
function assembleBins(
  elements: readonly DrapeElement[],
  picked: PickedElements,
  tile: DrapeTile,
  scale: number,
  grid: number,
  zoom: number,
): TileBins {
  const tileX = tile.x;
  const tileY = tile.y;
  const cellCount = grid * grid;
  const cellSize = 1 / grid;
  const cells = new Int32Array(cellCount * 2);

  /** The edges in in-tile coordinates (four numbers per edge). Stacked across elements */
  const edgeXY: number[] = [];
  /** Where each edge starts along its path (one number per edge) */
  const edgeS: number[] = [];
  /** The runs per cell. Triples of (elementIndex, inside, edgeListIndex) laid out in a row */
  const cellRuns: Array<number[] | undefined> = new Array(cellCount);
  /** The lists of edge indices that the runs point to */
  const runEdges: number[][] = [];
  /** The inside/outside difference per row (width grid + 1) */
  const rowDiff = new Int8Array(grid * (grid + 1));
  const rowTouched = new Uint8Array(grid);
  const touchedRows: number[] = [];
  /** The cell assignment for a single element */
  const scratch = new Map<number, number[]>();
  /** The number of cells truncated for exceeding the budget */
  let truncatedCells = 0;
  /** The diagnostic values */
  let maxEdgesPerCell = 0;
  let maxRunsPerCell = 0;

  const pushRun = (cell: number, elementIndex: number, inside: number, list?: number[]): void => {
    let target = cellRuns[cell];
    if (!target) {
      target = [];
      cellRuns[cell] = target;
    }
    let edgeListIndex = -1;
    if (list !== undefined && list.length > 0) {
      edgeListIndex = runEdges.length;
      runEdges.push(list);
    }
    target.push(elementIndex, inside, edgeListIndex);
  };

  for (let p = 0; p < picked.indices.length; p++) {
    const index = picked.indices[p];
    const element = elements[index];
    const margin = drapeMarginOf(element.strokeWidthPx, element.widthZoom, zoom);
    scratch.clear();
    touchedRows.length = 0;
    rowTouched.fill(0);

    const dashed = element.dash != null;
    for (const path of picked.geometries[p].paths) {
      scanPath(
        path,
        element.kind,
        tileX,
        tileY,
        scale,
        margin,
        grid,
        cellSize,
        { xy: edgeXY, starts: edgeS },
        dashed ? drapePathStarts(path) : null,
        scratch,
        rowDiff,
        rowTouched,
        touchedRows,
      );
    }

    // Turn the cells that are inside and the cells the edges touch into runs (they are stacked
    // in the order of the elements, so this comes out as the draw order)
    const emitted = new Set<number>();
    for (const row of touchedRows) {
      const base = row * (grid + 1);
      let inside = 0;
      for (let i = 0; i < grid; i++) {
        inside ^= rowDiff[base + i];
        const cell = row * grid + i;
        const list = scratch.get(cell);
        if (inside === 0 && list === undefined) continue;
        emitted.add(cell);
        pushRun(cell, index, inside, list);
      }
      rowDiff.fill(0, base, base + grid + 1);
    }
    for (const [cell, list] of scratch) {
      if (emitted.has(cell)) continue;
      pushRun(cell, index, 0, list);
    }
  }

  // Repacking (laid out in the order cell -> run -> edge)
  const runs: number[] = [];
  const edges: number[] = [];
  const edgeStarts: number[] = [];
  for (let c = 0; c < cellCount; c++) {
    const list = cellRuns[c];
    cells[c * 2] = runs.length / 4;
    if (!list) {
      cells[c * 2 + 1] = 0;
      continue;
    }
    let runCount = 0;
    let truncated = false;
    for (let i = 0; i + 2 < list.length; i += 3) {
      if (runCount >= DRAPE_MAX_RUNS_PER_CELL) {
        truncated = true;
        break;
      }
      const edgeListIndex = list[i + 2];
      const edgeStart = edges.length / 4;
      let edgeCount = 0;
      if (edgeListIndex >= 0) {
        for (const at of runEdges[edgeListIndex]) {
          if (edgeCount >= DRAPE_MAX_EDGES_PER_CELL) {
            truncated = true;
            break;
          }
          edges.push(edgeXY[at * 4], edgeXY[at * 4 + 1], edgeXY[at * 4 + 2], edgeXY[at * 4 + 3]);
          edgeStarts.push(edgeS[at]);
          edgeCount++;
        }
      }
      runs.push(list[i], edgeStart, edgeCount, list[i + 1]);
      runCount++;
      if (edgeCount > maxEdgesPerCell) maxEdgesPerCell = edgeCount;
    }
    if (truncated) truncatedCells++;
    if (runCount > maxRunsPerCell) maxRunsPerCell = runCount;
    cells[c * 2 + 1] = runCount;
  }

  return {
    grid,
    cells,
    runs: new Float32Array(runs),
    edges: new Float32Array(edges),
    edgeStarts: new Float32Array(edgeStarts),
    overflow: false,
    truncatedCells,
    cellWork: (runs.length / 4 + edges.length / 4) / cellCount,
    edgeEstimate: picked.edgeEstimate,
    maxEdgesPerCell,
    maxRunsPerCell,
  };
}

/** The result of selecting the elements relevant to a tile */
interface PickedElements {
  /** The indices of the relevant elements */
  readonly indices: number[];
  /** The geometries in the same order as the indices (the quantized ones when quantized) */
  readonly geometries: DrapeGeometry[];
  /** The estimate of the number of edges */
  readonly edgeEstimate: number;
  /** The largest of the margins */
  readonly maxMargin: number;
}

/**
 * Picks the elements relevant to a tile by their bounding box
 *
 * @param quantizeLevel 0 uses the original geometry, anything else uses the geometry quantized
 *   to that resolution
 */
function pickElements(
  elements: readonly DrapeElement[],
  candidates: readonly number[] | undefined,
  tile: DrapeTile,
  scale: number,
  quantizeLevel: number,
  zoom: number,
): PickedElements {
  const indices: number[] = [];
  const geometries: DrapeGeometry[] = [];
  let edgeEstimate = 0;
  let maxMargin = MIN_MARGIN;
  // Quantization can move a vertex outward by half a step of the grid, so it is added to the
  // margin used for the selection
  const quantizeSlack = quantizeLevel > 0 ? 2 ** -quantizeLevel : 0;

  const length = candidates ? candidates.length : elements.length;
  for (let n = 0; n < length; n++) {
    const index = candidates ? candidates[n] : n;
    const element = elements[index];
    const margin = drapeMarginOf(element.strokeWidthPx, element.widthZoom, zoom);
    const m = margin / scale + quantizeSlack;
    const box = element.bounds;
    if (
      box.maxX < tile.x / scale - m ||
      box.minX > (tile.x + 1) / scale + m ||
      box.maxY < tile.y / scale - m ||
      box.minY > (tile.y + 1) / scale + m
    ) {
      continue;
    }
    // This is where the coordinates are converted for the first time (only the features that
    // touch the view)
    const base = element.geometry();
    if (base.edgeCount === 0) continue;
    const geometry = quantizeLevel > 0 ? drapeQuantizedGeometry(base, quantizeLevel) : base;
    if (geometry.edgeCount === 0) continue;
    indices.push(index);
    geometries.push(geometry);
    if (margin > maxMargin) maxMargin = margin;
    edgeEstimate += countNearEdges(geometry, tile.x, tile.y, scale, m);
  }

  return { indices, geometries, edgeEstimate, maxMargin };
}

/**
 * Streams a single path into the grid of the tile
 *
 * A polygon does two jobs at once. One is the assignment of edges to cells, the other is the
 * tallying of "the inside/outside of the cell origin". The latter counts the crossings to the
 * right of the origin, so an edge outside the tile on the right also counts (it becomes a flip
 * of a whole row). An edge outside on the left flips nothing, so it can be dropped.
 */
function scanPath(
  path: DrapeGeometryPath,
  kind: 0 | 1,
  tileX: number,
  tileY: number,
  scale: number,
  margin: number,
  grid: number,
  cellSize: number,
  out: EdgeSink,
  starts: Float64Array | null,
  scratch: Map<number, number[]>,
  rowDiff: Int8Array,
  rowTouched: Uint8Array,
  touchedRows: number[],
): void {
  const xy = path.xy;
  const vertexCount = xy.length / 2;
  const blockCount = path.blocks.length / 4;

  for (let b = 0; b < blockCount; b++) {
    const by0 = path.blocks[b * 4 + 1] * scale - tileY;
    const by1 = path.blocks[b * 4 + 3] * scale - tileY;
    if (by1 < -margin || by0 > 1 + margin) continue;
    const bx0 = path.blocks[b * 4] * scale - tileX;
    const bx1 = path.blocks[b * 4 + 2] * scale - tileX;
    if (bx1 < -margin) continue;
    if (kind === 1 && bx0 > 1 + margin) continue;

    const from = b * DRAPE_BLOCK_EDGES;
    const to = Math.min(path.edgeCount, from + DRAPE_BLOCK_EDGES);
    for (let e = from; e < to; e++) {
      const v1 = e + 1 < vertexCount ? e + 1 : 0;
      const x0 = xy[e * 2] * scale - tileX;
      const y0 = xy[e * 2 + 1] * scale - tileY;
      const x1 = xy[v1 * 2] * scale - tileX;
      const y1 = xy[v1 * 2 + 1] * scale - tileY;
      if (x0 === x1 && y0 === y1) continue;

      if (kind === 0) {
        accumulateInside(x0, y0, x1, y1, grid, cellSize, rowDiff, rowTouched, touchedRows);
      }
      scatterEdge(x0, y0, x1, y1, starts ? starts[e] : 0, margin, grid, cellSize, out, scratch);
    }
  }
}

/**
 * Adds "the crossings to the right of the cell origin" for a single edge to the row difference
 *
 * Every cell whose origin lies to the left of the crossing point xint is flipped. The range
 * that is flipped is [0, k), so by setting 0 and k in the difference array and afterwards
 * taking the exclusive OR from the left in order, the inside/outside of the whole row comes
 * out.
 */
function accumulateInside(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  grid: number,
  cellSize: number,
  rowDiff: Int8Array,
  rowTouched: Uint8Array,
  touchedRows: number[],
): void {
  if (y0 === y1) return;
  const yLo = Math.min(y0, y1);
  const yHi = Math.max(y0, y1);
  let jLo = Math.ceil(yLo / cellSize);
  let jHi = Math.floor(yHi / cellSize);
  if (jLo < 0) jLo = 0;
  if (jHi > grid - 1) jHi = grid - 1;
  if (jLo > jHi) return;

  const inv = 1 / (y1 - y0);
  for (let j = jLo; j <= jHi; j++) {
    const yj = j * cellSize;
    if (y0 > yj === y1 > yj) continue;
    const t = (yj - y0) * inv;
    const xint = x0 + t * (x1 - x0);
    let k = Math.ceil(xint / cellSize);
    if (k <= 0) continue;
    if (k > grid) k = grid;
    const base = j * (grid + 1);
    if (rowTouched[j] === 0) {
      rowTouched[j] = 1;
      touchedRows.push(j);
    }
    rowDiff[base] ^= 1;
    rowDiff[base + k] ^= 1;
  }
}

/** Where the edges of a tile are stacked: the in-tile coordinates and the starts along the path */
interface EdgeSink {
  readonly xy: number[];
  readonly starts: number[];
}

/**
 * Assigns a single edge to the cells it passes through (including the margin)
 *
 * Sweeping the bounding box as it is would touch a whole rectangle of cells for a single edge
 * that crosses the tile diagonally. The segment is cut per row to obtain the range of x, and
 * only the columns in that range are touched.
 */
function scatterEdge(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  start: number,
  margin: number,
  grid: number,
  cellSize: number,
  out: EdgeSink,
  scratch: Map<number, number[]>,
): void {
  const exLo = Math.min(x0, x1) - margin;
  const exHi = Math.max(x0, x1) + margin;
  const eyLo = Math.min(y0, y1) - margin;
  const eyHi = Math.max(y0, y1) + margin;
  if (exHi < 0 || exLo > 1 || eyHi < 0 || eyLo > 1) return;

  let jLo = Math.floor(eyLo / cellSize);
  let jHi = Math.floor(eyHi / cellSize);
  if (jLo < 0) jLo = 0;
  if (jHi > grid - 1) jHi = grid - 1;
  if (jLo > jHi) return;

  const at = out.starts.length;
  out.xy.push(x0, y0, x1, y1);
  out.starts.push(start);

  const horizontal = y0 === y1;
  const inv = horizontal ? 0 : 1 / (y1 - y0);
  for (let j = jLo; j <= jHi; j++) {
    let xa: number;
    let xb: number;
    if (horizontal) {
      xa = Math.min(x0, x1);
      xb = Math.max(x0, x1);
    } else {
      let t0 = (j * cellSize - margin - y0) * inv;
      let t1 = ((j + 1) * cellSize + margin - y0) * inv;
      if (t0 > t1) {
        const swap = t0;
        t0 = t1;
        t1 = swap;
      }
      if (t0 < 0) t0 = 0;
      if (t1 > 1) t1 = 1;
      if (t0 > t1) continue;
      const xt0 = x0 + t0 * (x1 - x0);
      const xt1 = x0 + t1 * (x1 - x0);
      xa = Math.min(xt0, xt1);
      xb = Math.max(xt0, xt1);
    }
    xa -= margin;
    xb += margin;
    if (xb < 0 || xa > 1) continue;

    let iLo = Math.floor(xa / cellSize);
    let iHi = Math.floor(xb / cellSize);
    if (iLo < 0) iLo = 0;
    if (iHi > grid - 1) iHi = grid - 1;
    for (let i = iLo; i <= iHi; i++) {
      const cell = j * grid + i;
      const list = scratch.get(cell);
      // No limit is applied here. Applying one would create "a cell that silently lost edges",
      // the inside/outside test would go wrong and a whole cell would be painted. Truncation
      // is detected during the repacking
      if (list) list.push(at);
      else scratch.set(cell, [at]);
    }
  }
}

/**
 * Counts the number of edges near the tile (an estimate for deciding the resolution of the grid)
 */
function countNearEdges(
  geometry: DrapeGeometry,
  tileX: number,
  tileY: number,
  scale: number,
  margin: number,
): number {
  const x0 = tileX / scale - margin;
  const y0 = tileY / scale - margin;
  const x1 = (tileX + 1) / scale + margin;
  const y1 = (tileY + 1) / scale + margin;

  let count = 0;
  for (const path of geometry.paths) {
    const blockCount = path.blocks.length / 4;
    for (let b = 0; b < blockCount; b++) {
      if (
        path.blocks[b * 4 + 2] < x0 ||
        path.blocks[b * 4] > x1 ||
        path.blocks[b * 4 + 3] < y0 ||
        path.blocks[b * 4 + 1] > y1
      ) {
        continue;
      }
      count += Math.min(DRAPE_BLOCK_EDGES, path.edgeCount - b * DRAPE_BLOCK_EDGES);
    }
  }
  return count;
}
