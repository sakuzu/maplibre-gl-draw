// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The writes of the rows in place and the overrides of a group
 *
 * - An attribute written reads back, through every reader, as the same row of a group built
 *   with the value (the next version of the group), whatever its kind: a string of another
 *   length, a number in a column without numbers, a value in a sparse column for a row without
 *   the key, a key the group has no column of, another kind, a key taken off
 * - A geometry of the same shape is written into the column; of another shape, into the
 *   overrides; both read back as the geometry, with the triangles the builder makes of it, and
 *   the row is found at its new place and not at the old one
 * - The bytes held are counted for the attributes and the geometry together
 */

import type { Geometry } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { Feature } from '../shared/types/model.js';
import { feature, tablesOfFeatures } from '../test-utils.js';
import { hitTestLayerTable } from './hit-test.js';
import { overrideBytesOf } from './layer-table.js';
import {
  rowFeature,
  rowGeometry,
  rowNumber,
  rowProperties,
  rowTriangles,
  rowValue,
} from './row-read.js';
import { writeRowGeometry, writeRowValue } from './row-write.js';
import { OVERRIDE_BYTES_LIMIT } from './value-overrides.js';

/** Points whose attributes are the ones given */
function points(properties: Array<Record<string, unknown>>): Feature[] {
  return properties.map((p, i) => feature(`p${i}`, 'Point', [i, i], { properties: p }));
}

/** The values of every key of every row, through the readers of one value and of a row */
function readAll(features: Feature[], tables: ReturnType<typeof tablesOfFeatures>, keys: string[]) {
  const group = tables.table.groupAt(0);
  return features.map((_, row) => ({
    values: keys.map((key) => rowValue(group, row, key, tables.internals.strings)),
    numbers: keys.map((key) => rowNumber(group, row, key)),
    properties: rowProperties(group, row, tables.internals.strings),
    feature: rowFeature(tables.internals.readContext, 'layer', group, row).properties,
  }));
}

describe('the attributes written in place', () => {
  it('read back as the same rows built with the values, through every reader', () => {
    // A dense `name`, a `height` without numbers, a sparse `tag`, and rows of 20 values
    const before = points(
      Array.from({ length: 20 }, (_, i) => ({
        name: `n${i}`,
        height: null,
        ...(i === 3 ? { tag: 'a' } : {}),
        kind: 'shop',
      })),
    );
    const writes: Array<[number, string, unknown]> = [
      [0, 'name', 'a much longer name than before'],
      [1, 'height', 12.5],
      [2, 'tag', 'b'],
      [4, 'brand-new', { nested: [1, 'two', null] }],
      [5, 'kind', 42],
      [6, 'name', undefined],
      [7, 'height', true],
      [3, 'tag', undefined],
    ];
    const tables = tablesOfFeatures('layer', before);
    const group = tables.table.groupAt(0);
    for (const [row, key, value] of writes) {
      expect(writeRowValue(group, row, key, value)).toBe(true);
    }
    const after = before.map((f) => ({ ...f, properties: { ...f.properties } }));
    for (const [row, key, value] of writes) {
      if (value === undefined) delete after[row].properties[key];
      else after[row].properties[key] = value;
    }
    const rebuilt = tablesOfFeatures('layer', after);
    const keys = ['name', 'height', 'tag', 'brand-new', 'kind', 'missing'];
    expect(readAll(before, tables, keys)).toEqual(readAll(after, rebuilt, keys));
  });

  it('takes off what was written when the value of the column is written back', () => {
    const tables = tablesOfFeatures('layer', points([{ name: 'a' }, { name: 'b' }]));
    const group = tables.table.groupAt(0);
    expect(overrideBytesOf(group)).toBe(0);
    writeRowValue(group, 0, 'name', 'something else');
    expect(overrideBytesOf(group)).toBeGreaterThan(0);
    // The same value again changes nothing
    expect(writeRowValue(group, 0, 'name', 'something else')).toBe(false);
    expect(writeRowValue(group, 0, 'name', 'a')).toBe(true);
    expect(overrideBytesOf(group)).toBe(0);
    expect(group.values?.empty).toBe(true);
  });

  it('counts the bytes written, past the limit of a group', () => {
    const tables = tablesOfFeatures('layer', points([{ name: 'a' }]));
    const group = tables.table.groupAt(0);
    const long = 'x'.repeat(4096);
    let written = 0;
    for (let i = 0; overrideBytesOf(group) <= OVERRIDE_BYTES_LIMIT; i++) {
      writeRowValue(group, 0, `key${i}`, long);
      written++;
    }
    // About the bytes of the strings, each with what its entry costs
    expect(written).toBeGreaterThan(OVERRIDE_BYTES_LIMIT / (4096 + 256));
    expect(written).toBeLessThan(OVERRIDE_BYTES_LIMIT / 4096 + 2);
  });
});

/** A square ring of a side at a corner */
const square = (x: number, y: number, side: number): number[][] => [
  [x, y],
  [x + side, y],
  [x + side, y + side],
  [x, y + side],
  [x, y],
];

describe('the geometry written in place', () => {
  const features = (): Feature[] => [
    feature('line', 'LineString', [
      [0, 0],
      [1, 0],
      [2, 0],
    ]),
    feature('building', 'Polygon', [square(5, 5, 1)]),
    feature('point', 'Point', [9, 9]),
    feature('circle', 'Circle', [20, 20], {
      properties: { 'maplibre-gl-draw:radiusMeters': 1000 },
    }),
  ];

  /** The reads of the geometry of every row, with its triangles and its bbox */
  const readGeometry = (tables: ReturnType<typeof tablesOfFeatures>) => {
    const group = tables.table.groupAt(0);
    return Array.from({ length: group.data.length }, (_, row) => ({
      geometry: rowGeometry(group, row),
      triangles: Array.from(rowTriangles(group, row)),
      bounds: Array.from(group.data.rowBounds.subarray(row * 4, row * 4 + 4)),
    }));
  };

  it('writes a geometry of the same shape into the column, and of another into the overrides', () => {
    const tables = tablesOfFeatures('layer', features());
    const group = tables.table.groupAt(0);
    const coords = group.data.geometry.children.map((c) => c.coords);
    // A corner of the building moved: the same shape, its triangles kept
    const corner: Geometry = {
      type: 'Polygon',
      coordinates: [
        [
          [5, 5],
          [6.2, 5],
          [6, 6],
          [5, 6],
          [5, 5],
        ],
      ],
    };
    expect(writeRowGeometry(tables.table, group, 1, corner)).toEqual({
      sameShape: true,
      from: 1,
      to: 2,
    });
    // A vertex added to the line: another shape
    const longer: Geometry = {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 0],
        [1.5, 0.5],
        [2, 0],
      ],
    };
    expect(writeRowGeometry(tables.table, group, 0, longer).sameShape).toBe(false);
    expect(group.geometries?.geometry(0)).toBeDefined();
    expect(group.geometries?.geometry(1)).toBeUndefined();
    // The arrays of the column are the ones of the group (written, not replaced)
    expect(group.data.geometry.children.map((c) => c.coords)).toEqual(coords);

    const next = features();
    next[0] = { ...next[0], geometry: longer as Feature['geometry'] };
    next[1] = { ...next[1], geometry: corner as Feature['geometry'] };
    expect(readGeometry(tables)).toEqual(readGeometry(tablesOfFeatures('layer', next)));
  });

  it('writes a polygon of another number of corners with the triangles the builder makes', () => {
    const tables = tablesOfFeatures('layer', features());
    const group = tables.table.groupAt(0);
    const notched: Geometry = {
      type: 'Polygon',
      coordinates: [
        [
          [5, 5],
          [6, 5],
          [5.5, 5.5],
          [6, 6],
          [5, 6],
          [5, 5],
        ],
      ],
    };
    expect(writeRowGeometry(tables.table, group, 1, notched).sameShape).toBe(false);
    const next = features();
    next[1] = { ...next[1], geometry: notched as Feature['geometry'] };
    expect(readGeometry(tables)).toEqual(readGeometry(tablesOfFeatures('layer', next)));
    // Back to the shape of the column: written there, and the override is dropped
    writeRowGeometry(tables.table, group, 1, {
      type: 'Polygon',
      coordinates: [square(5, 5, 2)],
    });
    expect(group.geometries?.geometry(1)).toBeUndefined();
  });

  it('moves the ring of a Circle with its center, and reports a move of nothing as empty', () => {
    const tables = tablesOfFeatures('layer', features());
    const group = tables.table.groupAt(0);
    const moved = writeRowGeometry(tables.table, group, 3, {
      type: 'Point',
      coordinates: [21, 20],
    });
    expect(moved.sameShape).toBe(true);
    expect(moved.from).toBe(0);
    expect(moved.to).toBeGreaterThan(60);
    expect(group.data.rowBounds[3 * 4]).toBeGreaterThan(20.9);
    const still = writeRowGeometry(tables.table, group, 2, { type: 'Point', coordinates: [9, 9] });
    expect(still).toEqual({ sameShape: true, from: 0, to: 0 });
  });

  it('finds a moved row at its new place, not at the old one', () => {
    const tables = tablesOfFeatures('layer', features());
    const group = tables.table.groupAt(0);
    const input = (x: number, y: number) => ({
      coordinate: [x, y] as [number, number],
      reach: 0.1,
      toleranceOf: () => 0.1,
      test: (f: Feature, c: [number, number] | number[]) => {
        const g = f.geometry as { type: string; coordinates: number[] };
        return (
          g.type === 'Point' &&
          Math.abs(g.coordinates[0] - c[0]) < 0.1 &&
          Math.abs(g.coordinates[1] - c[1]) < 0.1
        );
      },
    });
    expect(hitTestLayerTable(tables.internals, tables.table, input(9, 9))?.row).toBe(2);
    writeRowGeometry(tables.table, group, 2, { type: 'Point', coordinates: [30, 30] });
    expect(hitTestLayerTable(tables.internals, tables.table, input(9, 9))).toBeNull();
    expect(hitTestLayerTable(tables.internals, tables.table, input(30, 30))?.row).toBe(2);
    expect(tables.table.movedRowCount).toBe(1);
    // The bbox of the group only widens
    expect(group.bounds?.maxX).toBeGreaterThanOrEqual(30);
  });

  it('counts the geometry written into the overrides with the attributes', () => {
    const tables = tablesOfFeatures('layer', features());
    const group = tables.table.groupAt(0);
    writeRowValue(group, 2, 'name', 'x');
    const values = overrideBytesOf(group);
    const coordinates: number[][] = [];
    for (let i = 0; i < 1000; i++) coordinates.push([i / 1000, 0]);
    writeRowGeometry(tables.table, group, 0, { type: 'LineString', coordinates });
    // The 1,000 coordinates of 16 bytes each, and what the attribute took
    expect(overrideBytesOf(group)).toBeGreaterThan(values + 16_000);
  });
});
