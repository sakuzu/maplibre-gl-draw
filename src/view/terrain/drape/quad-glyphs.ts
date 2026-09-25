// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Precomputation of the text (glyphs) placed on the analytic drape
 *
 * The text of a quad with a fill and text is drawn by "looking up the glyph's occupancy
 * rectangle from the pixel's local coordinates and referencing the SDF atlas,
 * within the same per-pixel evaluation as the fill". Because the fill and the
 * text become pixels of a single surface, neither a tear caused by a subdivision
 * mismatch nor a missing stroke can exist in principle, and since SDF is
 * resolution-independent the text stays crisp even on a huge quad.
 *
 * It is impossible for the fragment shader to sweep through every glyph each
 * time, so the quad's local coordinates are cut into a grid in the same manner as
 * the edge binning of polygons and lines (`binning.ts`), and "the list of glyphs
 * that cover that cell" is computed in advance for each cell. The lists are laid
 * out contiguously in cell order, and a cell holds only (start, count) (the same
 * way of holding data as the run of the edge binning). Because no separate index
 * array is needed, there is one texture fewer.
 *
 * This runs only when the content, style or size of such a quad changes. It does
 * not run every frame (the caller caches it by key).
 */

/**
 * The number of elements per glyph in {@link QuadDrapeGlyphs.glyphs}: 8.
 *
 * The occupancy rectangle (x0, y0, x1, y1) and the atlas UV (u0, v0, u1, v1). The
 * occupancy rectangle is in the quad's local 0..1 coordinates.
 */
export const QUAD_GLYPH_STRIDE = 8;

/** The upper limit of the grid subdivision count of the bins (per side) */
export const QUAD_GLYPH_MAX_GRID = 32;

/**
 * The upper limit of the glyphs one cell can hold
 *
 * Anything beyond it is discarded. Dozens of glyphs overlapping in one cell happens
 * only when extremely small text is packed onto an extremely large quad, and in that
 * case many characters fall into a single pixel, so discarding them does not show.
 */
export const QUAD_GLYPH_MAX_PER_CELL = 64;

/** The result of the binning */
export interface QuadGlyphBins {
  /** The grid subdivision count (per side). 0 means there is no text */
  readonly grid: number;
  /** (start, count, 0, 0) per cell. Length = grid * grid * 4 */
  readonly cells: Float32Array;
  /** The glyphs laid out in cell order (QUAD_GLYPH_STRIDE elements each) */
  readonly entries: Float32Array;
  /** The number of glyphs contained in entries (duplicates included) */
  readonly entryCount: number;
}

/**
 * Decides the grid subdivision count from the number of glyphs
 *
 * It aims for a coarseness of roughly one glyph per cell. Making it too fine only
 * increases the duplication of "glyphs that straddle several cells", so it is
 * stopped at the upper limit.
 */
export function chooseQuadGlyphGrid(count: number): number {
  if (count <= 0) return 0;
  return Math.min(QUAD_GLYPH_MAX_GRID, Math.max(1, Math.ceil(Math.sqrt(count))));
}

/** Rounds a value to an integer in 0..max */
function clampCell(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.floor(value)));
}

/**
 * Bins the glyphs into the grid of local coordinates
 *
 * @param glyphs The glyph array (QUAD_GLYPH_STRIDE elements each)
 * @param count The number of glyphs
 */
export function binQuadGlyphs(glyphs: Float32Array, count: number): QuadGlyphBins {
  const grid = chooseQuadGlyphGrid(count);
  if (grid === 0) {
    return { grid: 0, cells: new Float32Array(0), entries: new Float32Array(0), entryCount: 0 };
  }

  // The glyph numbers per cell (put into every cell it covers. Same as the edge
  // binning)
  const buckets: number[][] = [];
  for (let i = 0; i < grid * grid; i++) buckets.push([]);

  for (let g = 0; g < count; g++) {
    const base = g * QUAD_GLYPH_STRIDE;
    const x0 = glyphs[base];
    const y0 = glyphs[base + 1];
    const x1 = glyphs[base + 2];
    const y1 = glyphs[base + 3];
    if (!(x1 > x0) || !(y1 > y0)) continue;

    // A glyph that sticks out of the fill is pulled into the edge cell (it is
    // rejected by the rectangle test, so it does no harm)
    const cx0 = clampCell(x0 * grid, grid - 1);
    const cx1 = clampCell(x1 * grid, grid - 1);
    const cy0 = clampCell(y0 * grid, grid - 1);
    const cy1 = clampCell(y1 * grid, grid - 1);

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const bucket = buckets[cy * grid + cx];
        if (bucket.length >= QUAD_GLYPH_MAX_PER_CELL) continue;
        bucket.push(g);
      }
    }
  }

  let entryCount = 0;
  for (const bucket of buckets) entryCount += bucket.length;

  const cells = new Float32Array(grid * grid * 4);
  const entries = new Float32Array(entryCount * QUAD_GLYPH_STRIDE);
  let cursor = 0;

  for (let c = 0; c < buckets.length; c++) {
    const bucket = buckets[c];
    cells[c * 4] = cursor;
    cells[c * 4 + 1] = bucket.length;
    for (const g of bucket) {
      const src = g * QUAD_GLYPH_STRIDE;
      const dst = cursor * QUAD_GLYPH_STRIDE;
      for (let k = 0; k < QUAD_GLYPH_STRIDE; k++) entries[dst + k] = glyphs[src + k];
      cursor++;
    }
  }

  return { grid, cells, entries, entryCount };
}
