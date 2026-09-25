// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the reading of a columnar table
 */

import { describe, expect, it } from 'vitest';
import { ColumnarTable, columnValue } from './table.js';
import type { DatasetColumnarInput } from './types.js';

const lines = (): DatasetColumnarInput => ({
  length: 2,
  geometry: {
    type: 'LineString',
    coords: Float64Array.of(0, 0, 1, 1, 2, 2, 3, 3, 4, 4),
    offsets: [Int32Array.of(0, 2, 5)],
  },
});

describe('the checks of the shape', () => {
  it('accepts a table that adds up', () => {
    expect(() => new ColumnarTable(lines())).not.toThrow();
  });

  it('refuses a wrong number of offset arrays', () => {
    const input = lines();
    input.geometry.offsets = [];
    expect(() => new ColumnarTable(input)).toThrow(/offset arrays/);
  });

  it('refuses an offset array shorter than the rows', () => {
    const input = lines();
    input.geometry.offsets = [Int32Array.of(0, 2)];
    expect(() => new ColumnarTable(input)).toThrow(/entries/);
  });

  it('refuses offsets beyond the coordinates', () => {
    const input = lines();
    input.geometry.offsets = [Int32Array.of(0, 2, 6)];
    expect(() => new ColumnarTable(input)).toThrow(/reach coordinate/);
  });

  it('refuses coordinates that are not a Float64Array, and an unknown type', () => {
    const input = lines();
    expect(
      () =>
        new ColumnarTable({
          ...input,
          geometry: { ...input.geometry, coords: [0, 0] as unknown as Float64Array },
        }),
    ).toThrow(/Float64Array/);
    expect(
      () =>
        new ColumnarTable({
          ...input,
          geometry: { ...input.geometry, type: 'Circle' as never },
        }),
    ).toThrow(/unknown geometry type/);
  });

  it('refuses a column shorter than the table', () => {
    expect(() => new ColumnarTable({ ...lines(), columns: { v: Float64Array.of(1) } })).toThrow(
      /column "v"/,
    );
  });
});

describe('the rows', () => {
  it('reads the coordinates of every type, skipping z', () => {
    const polygon = new ColumnarTable({
      length: 1,
      geometry: {
        type: 'MultiPolygon',
        dimensions: 3,
        coords: Float64Array.of(
          0,
          0,
          9,
          1,
          0,
          9,
          1,
          1,
          9,
          0,
          0,
          9,
          5,
          5,
          9,
          6,
          5,
          9,
          6,
          6,
          9,
          5,
          5,
          9,
        ),
        offsets: [Int32Array.of(0, 2), Int32Array.of(0, 1, 2), Int32Array.of(0, 4, 8)],
      },
    });
    expect(polygon.coordinatesOf(0)).toEqual([
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
      [
        [
          [5, 5],
          [6, 5],
          [6, 6],
          [5, 5],
        ],
      ],
    ]);
    expect(Array.from(polygon.computeBounds())).toEqual([0, 0, 6, 6]);
  });

  it('a row without a geometry has NaN bounds (an empty run, a NaN point, a validity bit)', () => {
    const table = new ColumnarTable({
      length: 3,
      geometry: { type: 'Point', coords: Float64Array.of(0, 0, Number.NaN, Number.NaN, 2, 2) },
      validity: Uint8Array.of(0b011),
    });
    const bounds = table.computeBounds();
    expect(Array.from(bounds.subarray(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Number.isNaN(bounds[4])).toBe(true);
    expect(Number.isNaN(bounds[8])).toBe(true);
    expect(table.featureAt(2, false).visible).toBe(false);
  });

  it('the values of the columns and the ids', () => {
    const table = new ColumnarTable({
      ...lines(),
      ids: Int32Array.of(10, 20),
      columns: {
        name: ['a', 'b'],
        kind: { codes: Uint8Array.of(1, 200), dictionary: ['x', 'y'] },
        value: Float64Array.of(1.5, Number.NaN),
      },
    });
    expect(table.idOf(1)).toBe('20');
    expect(table.propertiesOf(0)).toEqual({ name: 'a', kind: 'y', value: 1.5 });
    // A code outside the dictionary and NaN in a float column mean no value
    expect(table.propertiesOf(1)).toEqual({ name: 'b', kind: null, value: null });
    expect(columnValue(Int32Array.of(7), 0)).toBe(7);
  });
});
