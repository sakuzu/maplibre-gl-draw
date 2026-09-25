// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  binQuadGlyphs,
  chooseQuadGlyphGrid,
  QUAD_GLYPH_MAX_GRID,
  QUAD_GLYPH_MAX_PER_CELL,
  QUAD_GLYPH_STRIDE,
} from './quad-glyphs.js';

/** Builds the array for a single glyph (occupancy rectangle + atlas UV) */
function glyph(x0: number, y0: number, x1: number, y1: number): number[] {
  return [x0, y0, x1, y1, 0, 0, 1, 1];
}

/** Collects the top left of the occupancy rectangles of the glyphs in cell (cx, cy) */
function cellRects(
  bins: ReturnType<typeof binQuadGlyphs>,
  cx: number,
  cy: number,
): [number, number][] {
  const cell = (cy * bins.grid + cx) * 4;
  const start = bins.cells[cell];
  const count = bins.cells[cell + 1];
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const base = (start + i) * QUAD_GLYPH_STRIDE;
    // They are narrowed to Float32, so compare after rounding
    out.push([
      Math.round(bins.entries[base] * 1000) / 1000,
      Math.round(bins.entries[base + 1] * 1000) / 1000,
    ]);
  }
  return out;
}

describe('chooseQuadGlyphGrid', () => {
  it('has no grid when there is no text', () => {
    expect(chooseQuadGlyphGrid(0)).toBe(0);
  });

  it('chooses a coarseness of roughly one glyph per cell', () => {
    expect(chooseQuadGlyphGrid(1)).toBe(1);
    expect(chooseQuadGlyphGrid(16)).toBe(4);
    expect(chooseQuadGlyphGrid(100)).toBe(10);
  });

  it('stops at the upper limit', () => {
    expect(chooseQuadGlyphGrid(100000)).toBe(QUAD_GLYPH_MAX_GRID);
  });
});

describe('binQuadGlyphs', () => {
  it('returns empty when there is no text', () => {
    const bins = binQuadGlyphs(new Float32Array(0), 0);
    expect(bins.grid).toBe(0);
    expect(bins.entryCount).toBe(0);
  });

  it('has contiguous per-cell spans that cover every glyph', () => {
    // 4 glyphs = a 2x2 grid. Each is placed small enough to fit in one cell
    const source = new Float32Array([
      ...glyph(0.05, 0.05, 0.2, 0.2),
      ...glyph(0.6, 0.05, 0.8, 0.2),
      ...glyph(0.05, 0.6, 0.2, 0.8),
      ...glyph(0.6, 0.6, 0.8, 0.8),
    ]);
    const bins = binQuadGlyphs(source, 4);

    expect(bins.grid).toBe(2);
    expect(bins.entryCount).toBe(4);
    expect(cellRects(bins, 0, 0)).toEqual([[0.05, 0.05]]);
    expect(cellRects(bins, 1, 0)).toEqual([[0.6, 0.05]]);
    expect(cellRects(bins, 0, 1)).toEqual([[0.05, 0.6]]);
    expect(cellRects(bins, 1, 1)).toEqual([[0.6, 0.6]]);

    // The spans are packed from the beginning (the shape that avoids an index array)
    let cursor = 0;
    for (let c = 0; c < bins.grid * bins.grid; c++) {
      expect(bins.cells[c * 4]).toBe(cursor);
      cursor += bins.cells[c * 4 + 1];
    }
    expect(cursor).toBe(bins.entryCount);
  });

  it('puts a glyph straddling several cells into all of them', () => {
    const source = new Float32Array([...glyph(0.1, 0.1, 0.9, 0.9), ...glyph(0.1, 0.1, 0.2, 0.2)]);
    const bins = binQuadGlyphs(source, 2);

    expect(bins.grid).toBe(2);
    // The larger one goes into all 4 cells, the smaller one only into the top left
    expect(bins.entryCount).toBe(5);
    expect(cellRects(bins, 1, 1)).toEqual([[0.1, 0.1]]);
    expect(cellRects(bins, 0, 0)).toHaveLength(2);
  });

  it('puts a glyph outside the paper into the edge cell (the rectangle test rejects it)', () => {
    const source = new Float32Array([...glyph(-0.5, 1.2, -0.2, 1.4)]);
    const bins = binQuadGlyphs(source, 1);
    expect(bins.entryCount).toBe(1);
    expect(cellRects(bins, 0, 0)).toEqual([[-0.5, 1.2]]);
  });

  it('does not put in glyphs with zero area (whitespace and the like)', () => {
    const source = new Float32Array([...glyph(0.1, 0.1, 0.1, 0.1)]);
    const bins = binQuadGlyphs(source, 1);
    expect(bins.entryCount).toBe(0);
  });

  it('truncates at the per-cell upper limit', () => {
    const count = QUAD_GLYPH_MAX_PER_CELL + 10;
    const source = new Float32Array(count * QUAD_GLYPH_STRIDE);
    for (let i = 0; i < count; i++) {
      source.set(glyph(0.4, 0.4, 0.6, 0.6), i * QUAD_GLYPH_STRIDE);
    }
    const bins = binQuadGlyphs(source, count);
    for (let c = 0; c < bins.grid * bins.grid; c++) {
      expect(bins.cells[c * 4 + 1]).toBeLessThanOrEqual(QUAD_GLYPH_MAX_PER_CELL);
    }
  });
});
