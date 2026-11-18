// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `validateRowValues`: the first value of rows that breaks the rule of its field
 * (`FeatureRowField`), without a Store, and `null` for values that keep every rule
 */

import { describe, expect, it } from 'vitest';
import { DrawError } from '../../shared/errors.js';
import type { FeatureRowField, GeometryColumn, NewRows, RowValues } from './types.js';
import { validateRowValues } from './validate.js';

/** A column of the geometries of rows, from its arrays */
function column(
  types: number[],
  partStarts: number[],
  ringStarts: number[],
  positionStarts: number[],
  coordinates: number[],
  valuesPerPosition = 2,
): GeometryColumn {
  return {
    types: Uint8Array.from(types),
    coordinates: Float64Array.from(coordinates),
    valuesPerPosition,
    partStarts: Int32Array.from(partStarts),
    ringStarts: Int32Array.from(ringStarts),
    positionStarts: Int32Array.from(positionStarts),
  };
}

/** Two points */
const TWO_POINTS = column([0, 0], [0, 1, 2], [0, 1, 2], [0, 1, 2], [0, 0, 1, 1]);

/** A square, closed, and the same square with its last position moved */
const SQUARE = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0];
const OPEN_SQUARE = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0.5];

/** Values written to two rows */
function written(
  fields: ReadonlyArray<[string, unknown[]]>,
  more: { geometry?: GeometryColumn; deleted?: Uint8Array } = {},
): RowValues {
  return {
    rows: Int32Array.of(0, 1),
    fields: new Map(fields as Array<[FeatureRowField, unknown[]]>),
    ...more,
  };
}

/** Two new rows of the layer `a` */
function created(
  fields: ReadonlyArray<[string, unknown[]]> = [],
  geometry: GeometryColumn = TWO_POINTS,
): NewRows {
  return {
    ids: ['x', 'y'],
    fields: new Map([
      ['type', ['Point', 'Point']],
      ['parent', ['a', 'a']],
      ['orderKey', ['k1', 'k2']],
      ...fields,
    ] as Array<[FeatureRowField, unknown[]]>),
    geometry,
  };
}

describe('validateRowValues', () => {
  it('is null for values that keep every rule', () => {
    expect(validateRowValues(created(), 2)).toBeNull();
    expect(
      validateRowValues(
        written([
          ['type', ['Polygon', 'my-type']],
          ['visible', [true, false]],
          ['locked', [false, true]],
          ['style', [{}, { fillColor: '#f00', strokeWidth: 2, custom: 'kept' }]],
          ['style:fillColor', ['#0f0', undefined]],
          ['properties:name', ['A', undefined]],
          ['properties:nested', [{ a: [1, 'x', null, true, { b: 2.5 }] }, []]],
          ['parent', ['a', 'g']],
          ['orderKey', ['V', 'W1']],
        ]),
        2,
      ),
    ).toBeNull();
    // A value undefined of a new row takes the value of a new feature
    expect(
      validateRowValues(
        created([
          ['visible', [undefined, false]],
          ['style', [undefined, {}]],
        ]),
        2,
      ),
    ).toBeNull();
  });

  it('tells the first value that breaks a rule: its row, its field and why', () => {
    // An array with no entry 1
    const sparse: unknown[] = [1];
    sparse[2] = 3;
    const cases: Array<[RowValues | NewRows, number, string]> = [
      [written([['type', ['Point', '']]]), 1, 'type'],
      [written([['type', ['Point', 3]]]), 1, 'type'],
      [written([['visible', [true, 'yes']]]), 1, 'visible'],
      [written([['locked', [0, false]]]), 0, 'locked'],
      [written([['style', [{}, { fillColor: Number.NaN }]]]), 1, 'style'],
      [written([['style', [{}, { fillColor: { r: 1 } }]]]), 1, 'style'],
      [written([['style', [[], {}]]]), 0, 'style'],
      [written([['style', [null, {}]]]), 0, 'style'],
      [written([['style:fillColor', ['#f00', Number.POSITIVE_INFINITY]]]), 1, 'style:fillColor'],
      [written([['properties:f', ['ok', () => 1]]]), 1, 'properties:f'],
      [written([['properties:n', [1, Number.NaN]]]), 1, 'properties:n'],
      [written([['properties:o', [{ when: new Date(0) }, 1]]]), 0, 'properties:o'],
      [written([['properties:o', [{ a: undefined }, 1]]]), 0, 'properties:o'],
      [written([['properties:a', [1, sparse]]]), 1, 'properties:a'],
      [written([['properties:b', [1n, 1]]]), 0, 'properties:b'],
      [written([['parent', ['a', '']]]), 1, 'parent'],
      [written([['orderKey', ['', 'k']]]), 0, 'orderKey'],
      // A value of a row not created is not left out
      [written([['visible', [true, undefined]]]), 1, 'visible'],
      // The first row first, then the fields in their order
      [
        written([
          ['visible', [true, 1]],
          ['type', ['', 'Point']],
        ]),
        0,
        'type',
      ],
    ];
    for (const [values, row, field] of cases) {
      const problem = validateRowValues(values, 2);
      expect(problem, `${field} of row ${row}`).toEqual({ row, field, reason: expect.any(String) });
      expect(problem?.reason.length).toBeGreaterThan(0);
    }
  });

  it('refuses a value of an attribute that is in itself', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const list: unknown[] = [];
    list.push(list);
    expect(validateRowValues(written([['properties:x', [loop, 1]]]), 2)?.row).toBe(0);
    expect(validateRowValues(written([['properties:x', [1, list]]]), 2)?.row).toBe(1);
    // The same object twice side by side is not in itself
    const shared = { a: 1 };
    expect(validateRowValues(written([['properties:x', [[shared, shared], 1]]]), 2)).toBeNull();
  });

  it('tells a field that is not one of a row, the geometry given as a field, and missing fields of new rows', () => {
    expect(validateRowValues(written([['hidden', [true, true]]]), 2)).toEqual(
      expect.objectContaining({ row: 0, field: 'hidden' }),
    );
    expect(validateRowValues(written([['properties:', [1, 1]]]), 2)?.field).toBe('properties:');
    expect(validateRowValues(written([['geometry', [null, null]]]), 2)?.field).toBe('geometry');
    expect(validateRowValues(written([['visible', [true]]]), 2)?.field).toBe('visible');
    const missing = created();
    (missing.fields as Map<FeatureRowField, unknown[]>).delete('orderKey');
    expect(validateRowValues(missing, 2)?.field).toBe('orderKey');
    expect(validateRowValues(created([['parent', ['a', undefined]]]), 2)).toEqual(
      expect.objectContaining({ row: 1, field: 'parent' }),
    );
    expect(
      validateRowValues({ ...created(), geometry: undefined } as unknown as NewRows, 2)?.field,
    ).toBe('geometry');
    expect(validateRowValues(written([], { deleted: new Uint8Array(3) }), 2)?.field).toBe(
      'deleted',
    );
  });

  it('checks the geometries: their types, parts, rings, finite values and closed rings', () => {
    const geometry = (g: GeometryColumn) => validateRowValues(written([], { geometry: g }), 2);
    expect(geometry(TWO_POINTS)).toBeNull();
    // A polygon closed, and one whose ring is not
    const polygon = (coordinates: number[]) =>
      column([0, 2], [0, 1, 2], [0, 1, 2], [0, 1, 6], [5, 5, ...coordinates]);
    expect(geometry(polygon(SQUARE))).toBeNull();
    expect(geometry(polygon(OPEN_SQUARE))).toEqual(
      expect.objectContaining({ row: 1, field: 'geometry' }),
    );
    // A value that is not finite
    expect(
      geometry(column([0, 0], [0, 1, 2], [0, 1, 2], [0, 1, 2], [0, 0, Number.NaN, 1])),
    ).toEqual(expect.objectContaining({ row: 1, field: 'geometry' }));
    // A point of two positions, a point of two parts, a type that is not one
    expect(geometry(column([0, 0], [0, 1, 2], [0, 1, 2], [0, 2, 3], [0, 0, 1, 1, 2, 2]))?.row).toBe(
      0,
    );
    expect(
      geometry(column([0, 0], [0, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3], [0, 0, 1, 1, 2, 2]))?.row,
    ).toBe(0);
    expect(geometry(column([0, 9], [0, 1, 2], [0, 1, 2], [0, 1, 2], [0, 0, 1, 1]))?.row).toBe(1);
    // A row without a geometry has no part; a new row needs one
    expect(geometry(column([0, 255], [0, 1, 1], [0, 1], [0, 1], [0, 0]))).toBeNull();
    expect(geometry(column([0, 255], [0, 1, 2], [0, 1, 2], [0, 1, 2], [0, 0, 1, 1]))?.row).toBe(1);
    expect(
      validateRowValues(created([], column([0, 255], [0, 1, 1], [0, 1], [0, 1], [0, 0])), 2),
    ).toEqual(expect.objectContaining({ row: 1, field: 'geometry' }));
    // The arrays of the column: the starts, the coordinates and the values of a position
    expect(geometry(column([0, 0], [0, 1, 2], [0, 1, 2], [0, 1, 2], [0, 0, 1]))?.field).toBe(
      'geometry',
    );
    expect(geometry(column([0, 0], [0, 2, 1], [0, 1, 2], [0, 1, 2], [0, 0, 1, 1]))?.field).toBe(
      'geometry',
    );
    expect(geometry(column([0], [0, 1], [0, 1], [0, 1], [0, 0]))?.field).toBe('geometry');
    expect(validateRowValues(written([], { geometry: TWO_POINTS }), 3)).toEqual(
      expect.objectContaining({ row: 0, field: 'geometry' }),
    );
    // The multi geometries: parts of one ring (of one position for points), rings closed
    const multi = column(
      [3, 4, 5],
      [0, 2, 4, 5],
      [0, 1, 2, 3, 4, 5],
      [0, 1, 2, 4, 6, 11],
      [0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 3, 3, ...SQUARE],
    );
    expect(
      validateRowValues({ ...written([]), rows: Int32Array.of(0, 1, 2), geometry: multi }, 2),
    ).toBeNull();
    const openMulti = {
      ...multi,
      coordinates: Float64Array.from([0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 3, 3, ...OPEN_SQUARE]),
    };
    expect(
      validateRowValues({ ...written([]), rows: Int32Array.of(0, 1, 2), geometry: openMulti }, 2),
    ).toEqual(expect.objectContaining({ row: 2, field: 'geometry' }));
  });

  it('checks the positions with the number of values of the layer, every value of them', () => {
    const three = column(
      [0, 2],
      [0, 1, 2],
      [0, 1, 2],
      [0, 1, 6],
      [5, 5, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0],
      3,
    );
    expect(validateRowValues(written([], { geometry: three }), 3)).toBeNull();
    // A ring whose last position has another height is not closed
    const values = Float64Array.from(three.coordinates);
    values[values.length - 1] = 7;
    expect(
      validateRowValues(written([], { geometry: { ...three, coordinates: values } }), 3),
    ).toEqual(expect.objectContaining({ row: 1, field: 'geometry' }));
  });

  it('throws for what is not values of rows, or a number of values of a position that is not one', () => {
    expect(() => validateRowValues(created(), 5 as 2)).toThrow(DrawError);
    expect(() => validateRowValues(null as unknown as NewRows, 2)).toThrow(DrawError);
    expect(() =>
      validateRowValues({ rows: Int32Array.of(0), fields: {} } as unknown as RowValues, 2),
    ).toThrow(DrawError);
  });
});
