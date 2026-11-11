// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The counting of the styles the rows use, and the numbers given again
 *
 * - The palette counts the rows of each resolved style, takes back a number no row uses and gives
 *   it to the next style; it writes only the lines of its texture written since the last upload
 * - The resolved styles are numbered once per style, type and rule color, and a number taken back
 *   is forgotten; a number of the table of styles given to another style is never read with the
 *   resolution of the style it had
 * - A new pixel ratio writes the values again under the same numbers
 * - The rows packed count their resolved styles, a draft dropped stops counting them
 */

import { StyleTable } from '@sakuzu/kasane/engine';
import { describe, expect, it } from 'vitest';
import type { FeatureStyle } from '../../shared/types/model.js';
import { createTestDrawer, feature, tablesOfFeatures } from '../../test-utils.js';
import { ROWS_STYLE_FLOATS, RowsPalette } from '../renderers/rows/rows-format.js';
import { TerrainContext } from '../terrain/context.js';
import { collectRow, ROWS_LAYOUT, RowStyleSlots, RowsDraft, RowsStyles } from './table-collect.js';

describe('RowsPalette', () => {
  it('takes back a number no row uses, and gives it to the next style added', () => {
    const palette = new RowsPalette();
    const freed: number[] = [];
    palette.onFree = (n) => freed.push(n);
    const a = palette.add(new Array(ROWS_STYLE_FLOATS).fill(1));
    const b = palette.add(new Array(ROWS_STYLE_FLOATS).fill(2));
    palette.retain(a);
    palette.retain(a);
    palette.retain(b);
    palette.release(a);
    expect(freed).toEqual([]);
    palette.release(a);
    expect(freed).toEqual([a]);
    expect(palette.size).toBe(1);
    const c = palette.add(new Array(ROWS_STYLE_FLOATS).fill(3));
    expect(c).toBe(a);
    expect(palette.count).toBe(2);
    expect(palette.values[c * ROWS_STYLE_FLOATS]).toBe(3);
  });

  it('marks the lines of the texture written', () => {
    const palette = new RowsPalette();
    // 256 styles per line of 1,024 texels
    for (let i = 0; i < 300; i++) palette.add(new Array(ROWS_STYLE_FLOATS).fill(i));
    expect([...palette.dirty].sort()).toEqual([0, 1]);
    palette.dirty.clear();
    palette.write(270, new Array(ROWS_STYLE_FLOATS).fill(0));
    expect([...palette.dirty]).toEqual([1]);
  });
});

/** The styles of a layer of the tests, with the table of styles of the rows */
function stylesOf(styles = new StyleTable<FeatureStyle>(), pixelRatio = 1) {
  const slots = new RowStyleSlots(createTestDrawer(), styles, undefined);
  const palette = new RowsPalette();
  return { styles, slots, palette, rows: new RowsStyles(slots, palette, pixelRatio, styles) };
}

describe('RowsStyles', () => {
  it('numbers a style, type and rule color once, and forgets a number taken back', () => {
    const { styles, palette, rows } = stylesOf();
    const red = styles.intern({ fillColor: '#ff0000' });
    const n = rows.polygon(red, 'Polygon', null);
    expect(rows.polygon(red, 'Polygon', null)).toBe(n);
    expect(rows.polygon(red, 'Polygon', '#00ff00')).not.toBe(n);
    expect(rows.layoutOf(n) & ROWS_LAYOUT.fill).toBe(ROWS_LAYOUT.fill);
    palette.retain(n);
    palette.release(n);
    // Forgotten: resolved again under a new number (here the same one, given again)
    expect(rows.layoutOf(n)).toBe(0);
    expect(rows.polygon(red, 'Polygon', null)).toBe(n);
  });

  it('never reads the resolution of a style for a number the table of styles gave to another', () => {
    const { styles, palette, rows } = stylesOf();
    const red = styles.intern({ pointColor: '#ff0000' });
    styles.retain(red);
    const resolved = rows.point(red, 'Point', null) as number;
    palette.retain(resolved);
    styles.release(red);
    const blue = styles.intern({ pointColor: '#0000ff' });
    expect(blue).toBe(red);
    const again = rows.point(blue, 'Point', null) as number;
    expect(again).not.toBe(resolved);
    // The fill of the point is the blue one
    expect(palette.values[again * ROWS_STYLE_FLOATS + 2]).toBeGreaterThan(0.9);
    expect(palette.values[resolved * ROWS_STYLE_FLOATS]).toBeGreaterThan(0.9);
  });

  it('writes the values again for a new pixel ratio, under the same numbers', () => {
    const { styles, palette, rows } = stylesOf(new StyleTable<FeatureStyle>(), 1);
    const style = styles.intern({ strokeWidth: 3 });
    const n = rows.line(style, 'LineString', null);
    // The width fixed on screen, in device pixels
    expect(palette.values[n * ROWS_STYLE_FLOATS + 5]).toBe(-3);
    palette.dirty.clear();
    expect(rows.setPixelRatio(2)).toBe(true);
    expect(rows.line(style, 'LineString', null)).toBe(n);
    expect(palette.values[n * ROWS_STYLE_FLOATS + 5]).toBe(-6);
    expect(palette.dirty.size).toBe(1);
    expect(rows.setPixelRatio(2)).toBe(false);
  });
});

describe('the rows packed count their resolved styles', () => {
  it('counts each row once, and stops counting the rows of a draft dropped', () => {
    const features = [
      feature('a', 'Point', [0, 0], { style: { pointColor: '#ff0000' } }),
      feature('b', 'Point', [1, 1], { style: { pointColor: '#ff0000' } }),
      feature('c', 'LineString', [
        [0, 0],
        [1, 1],
      ]),
    ];
    const { internals, table } = tablesOfFeatures('layer', features);
    const { palette, rows, slots } = stylesOf(internals.styles);
    const group = table.groupAt(0);
    const draft = new RowsDraft(3, 0, undefined, palette);
    const context = {
      slots,
      strings: internals.strings,
      pixelRatio: 1,
      terrain: new TerrainContext(),
      rowsStyles: rows,
      spriteSourceOf: () => undefined,
    };
    for (let row = 0; row < 3; row++) collectRow(group, row, row, draft, [0, 0], context);
    const point = draft.rowStyle[0];
    expect(draft.rowStyle[1]).toBe(point);
    expect(palette.usesOf(point)).toBe(2);
    expect(palette.usesOf(draft.rowStyle[2])).toBe(1);
    draft.releaseStyles();
    expect(palette.size).toBe(0);
  });
});
