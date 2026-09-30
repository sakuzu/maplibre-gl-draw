// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the building of a table from GeoJSON (`createTableBuilder`, `tableFromFeatures`)
 *
 * A built table is read back with the reader the datasets use, so a row reads back as the
 * geometry and the properties it was added with.
 */

import type { Feature, Geometry } from 'geojson';
import { describe, expect, it } from 'vitest';
import { createTableBuilder, tableFromFeatures } from './builder.js';
import { prepareTable, transferList } from './prepare.js';
import { TableReader } from './table.js';
import type { TableGeometry, TableMixedGeometry } from './types.js';

const line = (coordinates: number[][]): Geometry => ({ type: 'LineString', coordinates });
const point = (x: number, y: number): Geometry => ({ type: 'Point', coordinates: [x, y] });
const polygon = (coordinates: number[][][]): Geometry => ({ type: 'Polygon', coordinates });

const SQUARE = [
  [0, 0],
  [2, 0],
  [2, 2],
  [0, 0],
];
const HOLE = [
  [0.5, 0.5],
  [1, 0.5],
  [1, 1],
  [0.5, 0.5],
];

describe('createTableBuilder: the geometry', () => {
  it('rows of one type give one geometry column in the layout of GeoArrow', () => {
    const builder = createTableBuilder();
    builder.add(
      line([
        [0, 0],
        [1, 1],
      ]),
    );
    builder.add(
      line([
        [2, 2],
        [3, 3],
        [4, 4],
      ]),
    );
    const table = builder.finish();
    expect(table.length).toBe(2);
    const geometry = table.geometry as TableGeometry;
    expect(geometry.type).toBe('LineString');
    expect(Array.from(geometry.coords)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    expect(geometry.offsets?.map((o) => Array.from(o))).toEqual([[0, 2, 5]]);
    // The arrays hold exactly the rows (no spare capacity to transfer)
    expect(geometry.coords.buffer.byteLength).toBe(10 * 8);
  });

  it('polygons and multipolygons keep their rings and parts', () => {
    const multi: Geometry = { type: 'MultiPolygon', coordinates: [[SQUARE, HOLE], [SQUARE]] };
    const table = tableFromFeatures([
      { type: 'Feature', geometry: multi, properties: {} },
      { type: 'Feature', geometry: multi, properties: {} },
    ]);
    const geometry = table.geometry as TableGeometry;
    expect(geometry.offsets?.map((o) => Array.from(o))).toEqual([
      [0, 2, 4],
      [0, 2, 3, 5, 6],
      [0, 4, 8, 12, 16, 20, 24],
    ]);
    const reader = new TableReader(table);
    expect(reader.coordinatesOf(1)).toEqual(multi.coordinates);
  });

  it('rows of different types give a mixed geometry column', () => {
    const geometries = [
      point(1, 1),
      line([
        [0, 0],
        [1, 1],
      ]),
      polygon([SQUARE, HOLE]),
      point(2, 2),
    ];
    const builder = createTableBuilder();
    for (const geometry of geometries) builder.add(geometry);
    const table = builder.finish();
    const geometry = table.geometry as TableMixedGeometry;
    expect(geometry.type).toBe('Mixed');
    expect(Array.from(geometry.types)).toEqual([0, 1, 2, 0]);
    expect(Array.from(geometry.offsets)).toEqual([0, 0, 0, 1]);
    expect(geometry.children.map((child) => child.type)).toEqual([
      'Point',
      'LineString',
      'Polygon',
    ]);
    const reader = new TableReader(table);
    geometries.forEach((g, row) => {
      expect(reader.columnOf(row)?.type).toBe(g.type);
      expect(reader.coordinatesOf(row)).toEqual((g as { coordinates: unknown }).coordinates);
    });
  });

  it('a row without a geometry keeps its place: an empty run in a table of one type', () => {
    const builder = createTableBuilder();
    builder.add(null, { n: 0 });
    builder.add(
      line([
        [0, 0],
        [1, 1],
      ]),
      { n: 1 },
    );
    builder.add({ type: 'GeometryCollection', geometries: [] }, { n: 2 });
    const table = builder.finish();
    const geometry = table.geometry as TableGeometry;
    expect(geometry.type).toBe('LineString');
    expect(geometry.offsets?.map((o) => Array.from(o))).toEqual([[0, 0, 2, 2]]);
    const bounds = prepareTable(table).rowBounds;
    expect(Number.isNaN(bounds[0])).toBe(true);
    expect(Array.from(bounds.subarray(4, 8))).toEqual([0, 0, 1, 1]);
    expect(Number.isNaN(bounds[8])).toBe(true);
  });

  it('a Point row without a geometry has NaN coordinates', () => {
    const builder = createTableBuilder();
    builder.add(point(1, 2));
    builder.add(null);
    builder.add(point(3, 4));
    const geometry = builder.finish().geometry as TableGeometry;
    expect(geometry.type).toBe('Point');
    expect(Array.from(geometry.coords)).toEqual([1, 2, Number.NaN, Number.NaN, 3, 4]);
  });

  it('a row without a geometry has a negative type in a mixed column', () => {
    const builder = createTableBuilder();
    builder.add(point(1, 2));
    builder.add(null);
    builder.add(
      line([
        [0, 0],
        [1, 1],
      ]),
    );
    const table = builder.finish();
    const geometry = table.geometry as TableMixedGeometry;
    expect(Array.from(geometry.types)).toEqual([0, -1, 1]);
    const reader = new TableReader(table);
    expect(reader.columnOf(1)).toBeUndefined();
    expect(reader.coordinatesOf(2)).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it('a table without any geometry takes the given type, or Point', () => {
    const empty = createTableBuilder().finish();
    expect(empty).toMatchObject({ length: 0, geometry: { type: 'Point' } });

    const builder = createTableBuilder({ geometryType: 'Polygon' });
    builder.add(null);
    builder.add(null);
    const table = builder.finish();
    expect((table.geometry as TableGeometry).type).toBe('Polygon');
    expect(() => new TableReader(table)).not.toThrow();
    expect(Number.isNaN(prepareTable(table).rowBounds[0])).toBe(true);
  });

  it('keeps only the first two values of a position', () => {
    const builder = createTableBuilder();
    builder.add({ type: 'Point', coordinates: [1, 2, 30] });
    expect(Array.from((builder.finish().geometry as TableGeometry).coords)).toEqual([1, 2]);
  });

  it('grows past its capacity', () => {
    const builder = createTableBuilder({ capacity: 1 });
    for (let i = 0; i < 1000; i++) {
      builder.add(
        line([
          [i, 0],
          [i, 1],
        ]),
        { i },
      );
    }
    const table = builder.finish();
    expect(table.length).toBe(1000);
    expect(new TableReader(table).coordinatesOf(999)).toEqual([
      [999, 0],
      [999, 1],
    ]);
    expect(Array.from((table.columns!.i as Float64Array).subarray(997))).toEqual([997, 998, 999]);
  });

  it('refuses a geometry of another type than the one given, and a use after finish', () => {
    const builder = createTableBuilder({ geometryType: 'Point' });
    expect(() =>
      builder.add(
        line([
          [0, 0],
          [1, 1],
        ]),
      ),
    ).toThrow(/LineString/);
    builder.finish();
    expect(() => builder.add(point(0, 0))).toThrow(/finish/);
    expect(() => builder.finish()).toThrow(/finish/);
  });
});

describe('createTableBuilder: the attributes and the ids', () => {
  it('numbers become a Float64Array (NaN for null), anything else a plain array', () => {
    const builder = createTableBuilder();
    builder.add(point(0, 0), { a: 1, b: 'x', c: true });
    builder.add(point(1, 1), { a: null, b: 2 });
    builder.add(point(2, 2), { a: 3, d: 4 });
    const table = builder.finish();
    const columns = table.columns ?? {};
    expect(columns.a).toBeInstanceOf(Float64Array);
    expect(Array.from(columns.a as Float64Array)).toEqual([1, Number.NaN, 3]);
    expect(columns.b).toEqual(['x', 2, null]);
    expect(columns.c).toEqual([true, null, null]);
    // A property that first appears later is null in the rows before it
    expect(Array.from(columns.d as Float64Array)).toEqual([Number.NaN, Number.NaN, 4]);
    const reader = new TableReader(table);
    expect(reader.propertiesOf(1)).toEqual({ a: null, b: 2, c: null, d: null });
  });

  it('keeps the ids when they are given, and has none otherwise', () => {
    const withIds = createTableBuilder();
    withIds.add(point(0, 0), {}, 'a');
    withIds.add(point(1, 1), {}, 7);
    const reader = new TableReader(withIds.finish());
    expect([reader.idOf(0), reader.idOf(1)]).toEqual(['a', '7']);

    const partly = createTableBuilder();
    partly.add(point(0, 0));
    partly.add(point(1, 1), {}, 'b');
    partly.add(point(2, 2));
    expect(partly.finish().ids).toEqual([0, 'b', 2]);

    const without = createTableBuilder();
    without.add(point(0, 0));
    expect(without.finish().ids).toBeUndefined();
  });

  it('columns limits the properties that become columns, and creates every one', () => {
    const builder = createTableBuilder({ columns: ['b', 'missing'] });
    builder.add(point(0, 0), { a: 1, b: 'x' });
    builder.add(point(1, 1), { a: 2 });
    const columns = builder.finish().columns ?? {};
    expect(Object.keys(columns)).toEqual(['b', 'missing']);
    expect(columns.b).toEqual(['x', null]);
    expect(Array.from(columns.missing as Float64Array)).toEqual([Number.NaN, Number.NaN]);
  });
});

describe('tableFromFeatures', () => {
  const features: Feature<Geometry | null>[] = [
    { type: 'Feature', id: 'p', geometry: point(1, 2), properties: { name: 'a', size: 3 } },
    {
      type: 'Feature',
      id: 'l',
      geometry: line([
        [0, 0],
        [1, 1],
      ]),
      properties: { name: 'b', size: 5 },
    },
    { type: 'Feature', id: 'n', geometry: null, properties: null },
  ];

  it('makes one row per feature, with its geometry, properties and id', () => {
    const table = tableFromFeatures(features);
    expect(table.length).toBe(3);
    expect(table.geometry.type).toBe('Mixed');
    const reader = new TableReader(table);
    expect(reader.featureAt(0, true)).toMatchObject({
      id: 'p',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 2] },
      properties: { name: 'a', size: 3 },
    });
    expect(reader.featureAt(1, true)).toMatchObject({ id: 'l', type: 'LineString' });
    expect(reader.idOf(2)).toBe('n');
    expect(reader.columnOf(2)).toBeUndefined();
  });

  it('columns limits the properties', () => {
    const table = tableFromFeatures(features, { columns: ['size'] });
    expect(Object.keys(table.columns ?? {})).toEqual(['size']);
    expect(Array.from(table.columns!.size as Float64Array)).toEqual([3, 5, Number.NaN]);
  });

  it('gives a table that can be prepared and transferred', () => {
    const table = tableFromFeatures(features);
    const prepared = prepareTable(table);
    expect(prepared.table).toBe(table);
    const buffers = transferList(prepared);
    expect(new Set(buffers).size).toBe(buffers.length);
    const mixed = table.geometry as TableMixedGeometry;
    expect(buffers).toContain(mixed.types.buffer);
    expect(buffers).toContain(mixed.children[1].coords.buffer);
    expect(buffers).toContain((table.columns!.size as Float64Array).buffer);
    expect(buffers).toContain(prepared.rowBounds.buffer);
  });
});
