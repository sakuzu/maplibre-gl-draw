// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the reading of a columnar table
 */

import { describe, expect, it } from 'vitest';
import { ColumnarTable, columnValue } from './table.js';
import type {
  DatasetColumnarGeometry,
  DatasetColumnarInput,
  DatasetColumnarMixedGeometry,
} from './types.js';

const lines = (): DatasetColumnarInput & { geometry: DatasetColumnarGeometry } => ({
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

/** A point, a line with z values and a polygon; the rows of the table in another order */
const mixed = (): DatasetColumnarInput & { geometry: DatasetColumnarMixedGeometry } => ({
  length: 5,
  geometry: {
    type: 'Mixed',
    types: Int8Array.of(2, 0, -1, 1, 0),
    offsets: Int32Array.of(0, 1, 0, 0, 0),
    children: [
      { type: 'Point', coords: Float64Array.of(7, 7, 8, 8) },
      {
        type: 'LineString',
        dimensions: 3,
        coords: Float64Array.of(0, 0, 9, 1, 2, 9),
        offsets: [Int32Array.of(0, 2)],
      },
      {
        type: 'Polygon',
        coords: Float64Array.of(3, 3, 4, 3, 4, 5, 3, 3),
        offsets: [Int32Array.of(0, 1), Int32Array.of(0, 4)],
      },
    ],
  },
});

describe('a mixed geometry column', () => {
  it('reads each row from its child, at its row within the child', () => {
    const table = new ColumnarTable(mixed());
    expect(table.featureAt(0, true).type).toBe('Polygon');
    expect(table.coordinatesOf(0)).toEqual([
      [
        [3, 3],
        [4, 3],
        [4, 5],
        [3, 3],
      ],
    ]);
    expect(table.coordinatesOf(1)).toEqual([8, 8]);
    expect(table.coordinatesOf(3)).toEqual([
      [0, 0],
      [1, 2],
    ]);
    expect(table.coordinatesOf(4)).toEqual([7, 7]);
    const bounds = Array.from(table.computeBounds());
    expect(bounds.slice(0, 8)).toEqual([3, 3, 4, 5, 8, 8, 8, 8]);
    // A negative type is a row without a geometry
    expect(bounds.slice(8, 12).every(Number.isNaN)).toBe(true);
    expect(bounds.slice(12)).toEqual([0, 0, 1, 2, 7, 7, 7, 7]);
    expect(Array.from(table.computeVertexCounts())).toEqual([4, 1, 0, 2, 1]);
    expect(table.featureAt(2, false)).toMatchObject({ type: 'Point', visible: false });
  });

  it('validity still applies on top', () => {
    const table = new ColumnarTable({ ...mixed(), validity: Uint8Array.of(0b11101) });
    const bounds = table.computeBounds();
    expect(Number.isNaN(bounds[4])).toBe(true);
    expect(Array.from(bounds.subarray(0, 4))).toEqual([3, 3, 4, 5]);
  });

  it('refuses arrays of the wrong type or shorter than the table', () => {
    const input = mixed();
    const geometry = input.geometry;
    const at = (patch: Partial<DatasetColumnarMixedGeometry>) => () =>
      new ColumnarTable({ ...input, geometry: { ...geometry, ...patch } });
    expect(at({ types: Int32Array.of(0) as unknown as Int8Array })).toThrow(/types must be/);
    expect(at({ offsets: [0] as unknown as Int32Array })).toThrow(/offsets must be/);
    expect(at({ types: Int8Array.of(0, 0) })).toThrow(/types is shorter/);
    expect(at({ offsets: Int32Array.of(0, 0) })).toThrow(/offsets is shorter/);
  });

  it('refuses a missing child, a row past the end of its child, and a broken child', () => {
    const input = mixed();
    const geometry = input.geometry;
    const at = (patch: Partial<DatasetColumnarMixedGeometry>) => () =>
      new ColumnarTable({ ...input, geometry: { ...geometry, ...patch } });
    expect(at({ types: Int8Array.of(2, 0, -1, 3, 0) })).toThrow(
      /geometry\.types\[3\] is 3, but there are 3 children/,
    );
    expect(at({ offsets: Int32Array.of(0, 2, 0, 0, 0) })).toThrow(
      /geometry\.offsets\[1\] is 2, but geometry\.children\[0\] has 2 rows/,
    );
    expect(at({ offsets: Int32Array.of(0, 1, 0, -1, 0) })).toThrow(/offsets\[3\] is -1/);
    const children = [...geometry.children];
    children[1] = { ...children[1], offsets: [Int32Array.of(0, 3)] };
    expect(at({ children })).toThrow(/geometry\.children\[1\]: the offsets reach coordinate 3/);
    children[1] = { ...children[1], type: 'Mixed' as never };
    expect(at({ children })).toThrow(/geometry\.children\[1\]: unknown geometry type "Mixed"/);
  });
});
