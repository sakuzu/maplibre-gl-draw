// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reading every row and every item of the tables, and writing rows in place (`writer.writeRows`)
 *
 * - `scan` reads the rows of the layers in their order a batch at a time, the deleted ones left
 *   out, and the rows whose bbox meets a box (a moved row where it is now)
 * - The items of a layer are its rows outside a group and its groups, each at its place, with
 *   the members of a group in their order
 * - `writer.writeRows` writes the geometry, the style, shown, locked, the attributes and the deletion
 *   of rows in place, and tells the drawing; it refuses whole a patch with a row it does not
 *   hold (a new row without what it needs), or a group of features it does not know
 * - Writes at random, applied to the tables and to a list of features: every read of the tables
 *   gives the features
 */

import {
  type InPlaceRowWrite,
  ROW_WRITE_GEOMETRY,
  ROW_WRITE_STATE,
  ROW_WRITE_STYLE,
} from '@sakuzu/kasane/render';
import { byteColumnFromStrings, type Value } from '@sakuzu/tabane';
import type { Geometry } from 'geojson';
import { describe, expect, it } from 'vitest';
import { ITEM_GROUP, ITEM_ROW, type RowField, type RowValues } from '../api/tables.js';
import { drawPropertyKey } from '../shared/properties.js';
import type { Feature } from '../shared/types/model.js';
import { FEATURE_TABLE_COLUMNS } from '../table/tabane/columns.js';
import { tablesValuesOf } from '../table/tables-values.js';
import {
  featureRowDataBuilder as createPageDataBuilder,
  feature,
  orderKey,
  rowOfFeature,
  seededRandom,
  tablesOfFeatures,
} from '../test-utils.js';
import { createFeatureTablesStore } from './feature-row-tables.js';
import {
  createTables,
  type FeatureTablesInternals,
  featureTablesInternals,
} from './feature-tables.js';

/** Points in a row, `count` of them */
function points(count: number): Feature[] {
  return Array.from({ length: count }, (_, i) =>
    feature(`p${i}`, 'Point', [i, 0], { properties: { n: i } }),
  );
}

/** Every handle a cursor reads */
function readAll(cursor: { next(): Int32Array | null }): number[] {
  const out: number[] = [];
  for (let batch = cursor.next(); batch; batch = cursor.next()) out.push(...batch);
  return out;
}

/** A patch of one field of rows */
function patchOf(handles: number[], field: RowField, values: unknown[]): RowValues {
  return { handles: Int32Array.from(handles), fields: new Map([[field, values]]) };
}

describe('scan', () => {
  it('reads the rows of a layer in its order, a batch at a time, the deleted ones left out', () => {
    const { tables, writer, internals } = tablesOfFeatures('layer', points(50), 8);
    const ids = (handles: number[]) => handles.map((h) => tables.getRowId(h));
    const batches: number[] = [];
    const cursor = tables.scan({ layerIds: ['layer'], batchSize: 7 });
    for (let batch = cursor.next(); batch; batch = cursor.next()) batches.push(batch.length);
    expect(batches.slice(0, -1).every((n) => n === 7)).toBe(true);
    expect(ids(readAll(tables.scan()))).toEqual(points(50).map((f) => f.id));
    const handle = internals.ids.handleOf('p3');
    writer.writeRows({
      handles: Int32Array.of(handle),
      fields: new Map(),
      deleted: Uint8Array.of(1),
    });
    expect(ids(readAll(tables.scan()))).not.toContain('p3');
    expect(readAll(tables.scan())).toHaveLength(49);
  });

  it('reads the rows whose bbox meets a box, a row moved where it is now', () => {
    const { tables, writer, internals } = tablesOfFeatures('layer', points(30), 8);
    const ids = (box: [number, number, number, number], order?: 'any') =>
      readAll(tables.scan({ bbox: box, order })).map((h) => tables.getRowId(h));
    expect(ids([4.5, -1, 9.5, 1])).toEqual(['p5', 'p6', 'p7', 'p8', 'p9']);
    writer.writeRows(
      patchOf([internals.ids.handleOf('p20')], 'geometry', [
        { type: 'Point', coordinates: [7, 0] },
      ]),
    );
    expect(ids([6.5, -1, 7.5, 1])).toEqual(['p7', 'p20']);
    expect(ids([19.5, -1, 20.5, 1])).toEqual([]);
    expect(new Set(ids([4.5, -1, 9.5, 1], 'any'))).toEqual(
      new Set(['p5', 'p6', 'p7', 'p8', 'p9', 'p20']),
    );
  });
});

describe('the items of a layer', () => {
  it('are the rows outside a group and the groups at their places, with their members', () => {
    const { tables, writer } = createFeatureTablesStore();
    const internals = featureTablesInternals(tables);
    internals?.groups.set(7, {
      id: 'g',
      order: 'k000003',
      tableId: 'layer',
      flags: 0,
    });
    const builder = createPageDataBuilder({
      columns: FEATURE_TABLE_COLUMNS,
      groups: [{ group: 7, id: 'g', key: 'k000003' }],
      targetRows: 2,
    });
    for (let i = 0; i < 6; i++) {
      const row = rowOfFeature(feature(`f${i}`, 'Point', [i, i]), orderKey(i));
      // f1, f2 and f4 are the members of the group (at the place of its key, k000003)
      const member = i === 1 || i === 2 || i === 4;
      builder.addRow(member ? { ...row, group: 7 } : row);
    }
    writer.addPages('layer', builder.finish());
    internals?.addQueuedPages();
    const view = tables.get('layer');
    if (!view) throw new Error('no layer');
    expect(view.itemCount).toBe(4);
    const items = view.listItems(0, 10);
    const handle = (id: string) => tables.getRowRef(id) as number;
    expect(Array.from(items.kinds)).toEqual([ITEM_ROW, ITEM_ROW, ITEM_GROUP, ITEM_ROW]);
    expect(Array.from(items.handles)).toEqual([handle('f0'), handle('f3'), 7, handle('f5')]);
    expect(view.countGroupMembers(7)).toBe(3);
    expect(Array.from(view.listGroupMembers(7, 1, 5))).toEqual([handle('f2'), handle('f4')]);
    expect(Array.from(view.listItems(1, 2).handles)).toEqual([handle('f3'), 7]);
    // A deleted member leaves the group, and a deleted row its item
    writer.writeRows({
      handles: Int32Array.of(handle('f2'), handle('f3')),
      fields: new Map(),
      deleted: Uint8Array.of(1, 1),
    });
    expect(view.itemCount).toBe(3);
    expect(view.countGroupMembers(7)).toBe(2);
  });
});

describe('writer.writeRows', () => {
  it('writes the values of rows in place and tells the drawing what it wrote', () => {
    const features = [
      feature('a', 'Point', [0, 0], { style: { pointColor: '#ff0000' } }),
      feature('b', 'LineString', [
        [0, 0],
        [1, 1],
      ]),
    ];
    const { tables, writer, internals } = tablesOfFeatures('layer', features);
    const told: Array<[string, readonly InPlaceRowWrite[]]> = [];
    internals.onRowsWritten((layerId, writes) => told.push([layerId, writes]));
    const a = internals.ids.handleOf('a');
    const b = internals.ids.handleOf('b');
    writer.writeRows({
      handles: Int32Array.of(a, b),
      fields: new Map<RowField, unknown[]>([
        [
          'geometry',
          [
            { type: 'Point', coordinates: [5, 5] },
            {
              type: 'LineString',
              coordinates: [
                [0, 0],
                [2, 2],
                [3, 1],
              ],
            },
          ],
        ],
        ['style', [{ pointColor: '#00ff00' }, {}]],
        ['hidden', [false, true]],
        ['locked', [true, false]],
        ['properties:name', ['A', undefined]],
      ]),
    });
    const view = tables.get('layer');
    const rowA = view?.getRow(a);
    expect(rowA?.geometry).toEqual({ type: 'Point', coordinates: [5, 5] });
    expect(rowA?.style).toEqual({ pointColor: '#00ff00' });
    expect(rowA?.locked).toBe(true);
    expect(rowA?.properties).toEqual({ name: 'A' });
    expect(view?.getRow(b)?.visible).toBe(false);
    expect(view?.getRowValue(a, 'name')).toBe('A');
    expect(told).toHaveLength(1);
    const [layerId, writes] = told[0];
    expect(layerId).toBe('layer');
    expect(writes.map((w) => [w.row, w.what & (ROW_WRITE_GEOMETRY | ROW_WRITE_STYLE)])).toEqual([
      [0, ROW_WRITE_GEOMETRY | ROW_WRITE_STYLE],
      [1, ROW_WRITE_GEOMETRY],
    ]);
    expect(writes[1].sameShape).toBe(false);
    expect(writes[1].what & ROW_WRITE_STATE).toBe(ROW_WRITE_STATE);
    // The red style no row uses any more is taken back
    expect(internals.styles.size).toBe(2);
  });

  it('refuses whole a patch with a row it does not hold, or a group of features it does not know', () => {
    const { tables, writer, internals } = tablesOfFeatures('layer', points(3));
    const handle = internals.ids.handleOf('p1');
    // A known row and an unknown one: nothing is written
    const patch: RowValues = {
      handles: Int32Array.of(handle, 999),
      fields: new Map([['properties:name', ['x', 'y']]]),
    };
    expect(() => writer.writeRows(patch)).toThrow(/no row/);
    expect(tables.get('layer')?.getRowValue(handle, 'name')).toBeUndefined();
    // A new row without what it needs
    const [fresh] = writer.allocateHandles(byteColumnFromStrings(['new']));
    expect(() => writer.writeRows(patchOf([fresh], 'properties:name', ['x']))).toThrow(
      /a new row needs type, parent, geometry, key/,
    );
    expect(() => writer.writeRows(patchOf([handle], 'parent', ['']))).toThrow(/is not an id/);
    expect(internals.deltaRowCount()).toBe(0);
    const created = `properties:${drawPropertyKey('createdZoom')}` as RowField;
    expect(internals.placeOf(handle)?.group.delta).toBe(false);
    writer.writeRows(patchOf([handle], created, [12]));
    // The created zoom is read by the cutting of the rows: the row is placed again
    expect(internals.placeOf(handle)?.group.delta).toBe(true);
  });

  it('places a row again for a new type or created zoom, and writes the rest in place', () => {
    const created = `properties:${drawPropertyKey('createdZoom')}` as RowField;
    const inDelta = (internals: ReturnType<typeof tablesOfFeatures>['internals'], id: string) =>
      internals.placeOf(internals.ids.handleOf(id))?.group.delta;
    const { writer, internals } = tablesOfFeatures(
      'layer',
      points(4).map((f) => ({
        ...f,
        properties: { ...f.properties, [drawPropertyKey('createdZoom')]: 10 },
      })),
    );
    const [p0, p1, p2, p3] = ['p0', 'p1', 'p2', 'p3'].map((id) => internals.ids.handleOf(id));
    // The same type, the same created zoom, another attribute: in place
    writer.writeRows(patchOf([p0], 'type', ['Point']));
    writer.writeRows(patchOf([p0], created, [10]));
    writer.writeRows(patchOf([p0], 'properties:name', ['x']));
    writer.writeRows(patchOf([p0, p1], 'type', [undefined, 'Point']));
    expect(['p0', 'p1', 'p2', 'p3'].map((id) => inDelta(internals, id))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    // Another type, another created zoom, a created zoom taken off: placed again
    writer.writeRows(patchOf([p1], 'type', ['Marker']));
    writer.writeRows(patchOf([p2], created, [11]));
    writer.writeRows(patchOf([p3], created, [undefined]));
    expect(['p0', 'p1', 'p2', 'p3'].map((id) => inDelta(internals, id))).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(internals.deltaRowCount()).toBe(3);
  });

  it('places a row again for a new type only, in tables told of no field that places it', () => {
    const created = `properties:${drawPropertyKey('createdZoom')}` as RowField;
    const { tables, writer } = createTables({ columns: FEATURE_TABLE_COLUMNS });
    const builder = createPageDataBuilder({ columns: FEATURE_TABLE_COLUMNS });
    points(2).forEach((f, i) => {
      builder.addRow(
        rowOfFeature(
          { ...f, properties: { ...f.properties, [drawPropertyKey('createdZoom')]: 10 } },
          orderKey(i),
        ),
      );
    });
    writer.addPages('layer', builder.finish());
    const internals = featureTablesInternals(tables) as FeatureTablesInternals;
    internals.addQueuedPages();
    const [p0, p1] = ['p0', 'p1'].map((id) => internals.ids.handleOf(id));
    writer.writeRows(tablesValuesOf(patchOf([p0], created, [11])));
    writer.writeRows(tablesValuesOf(patchOf([p1], 'type', ['Marker'])));
    expect(internals.placeOf(p0)?.group.delta).toBe(false);
    expect(tables.get('layer')?.getRowValue(p0, drawPropertyKey('createdZoom'))).toBe(11);
    expect(internals.placeOf(p1)?.group.delta).toBe(true);
    expect(tables.get('layer')?.getRowType(p1)).toBe('Marker');
  });

  it('marks a group due for its next version past the limit of its overrides', () => {
    const { writer, internals, table } = tablesOfFeatures('layer', points(4));
    const handle = internals.ids.handleOf('p0');
    const long = 'x'.repeat(1024);
    for (let i = 0; internals.groupsDue.size === 0 && i < 1000; i++) {
      writer.writeRows(patchOf([handle], `properties:k${i}`, [long]));
    }
    expect(internals.groupsDue.has(table.groupAt(0).handle)).toBe(true);
  });

  it('keeps the styles of the table to the ones the rows use, however often a color changes', () => {
    const { writer, internals } = tablesOfFeatures('layer', points(10));
    const handle = internals.ids.handleOf('p4');
    for (let i = 0; i < 200; i++) {
      const color = `#${(i * 997).toString(16).padStart(6, '0').slice(-6)}`;
      writer.writeRows(patchOf([handle], 'style', [{ pointColor: color }]));
    }
    // The style of the other rows and the one of p4
    expect(internals.styles.size).toBe(2);
    expect(internals.styles.capacity).toBeLessThanOrEqual(3);
  });

  it('gives a row the style the row before it in the patch leaves, as its last user', () => {
    const { tables, writer, internals } = tablesOfFeatures('layer', points(3));
    const [a, b, c] = ['p0', 'p1', 'p2'].map((id) => internals.ids.handleOf(id));
    const red = { pointColor: '#ff0000' };
    const green = { pointColor: '#00ff00' };
    writer.writeRows(patchOf([a], 'style', [red]));
    writer.writeRows(patchOf([a, b], 'style', [green, { ...red }]));
    const view = tables.get('layer');
    expect(view?.getRow(a)?.style).toEqual(green);
    expect(view?.getRow(b)?.style).toEqual(red);
    expect(view?.getRow(c)?.style).toEqual({});
    // Each style is counted for its rows alone: the write holds none of them when it ends
    expect(internals.styles.size).toBe(3);
    expect(internals.styles.usesOf(internals.styles.intern(red))).toBe(1);
    expect(internals.styles.usesOf(internals.styles.intern(green))).toBe(1);
  });

  it('swaps the styles of two rows in a patch', () => {
    const { tables, writer, internals } = tablesOfFeatures('layer', points(2));
    const [a, b] = ['p0', 'p1'].map((id) => internals.ids.handleOf(id));
    const red = { pointColor: '#ff0000' };
    const green = { pointColor: '#00ff00' };
    writer.writeRows(patchOf([a, b], 'style', [red, green]));
    writer.writeRows(patchOf([a, b], 'style', [green, red]));
    expect(tables.get('layer')?.getRow(a)?.style).toEqual(green);
    expect(tables.get('layer')?.getRow(b)?.style).toEqual(red);
    expect(internals.styles.size).toBe(2);
  });

  it('leaves a style to the rows that hold it when a patch places its row elsewhere', () => {
    const { tables, writer, internals } = tablesOfFeatures('layer', points(2));
    const a = internals.ids.handleOf('p0');
    const red = { pointColor: '#ff0000' };
    writer.writeRows({
      handles: Int32Array.of(a),
      fields: new Map<RowField, unknown[]>([
        ['style', [red]],
        ['key', [orderKey(5)]],
      ]),
    });
    expect(internals.placeOf(a)?.group.delta).toBe(true);
    expect(tables.get('layer')?.getRow(a)?.style).toEqual(red);
    expect(internals.styles.size).toBe(2);
    expect(internals.styles.usesOf(internals.styles.intern(red))).toBe(1);
  });
});

describe('writes at random against a list of features', () => {
  /** A geometry for a row at random: of the same shape as it has, or of another */
  function geometryAt(random: () => number, f: Feature): Geometry {
    const x = random() * 10;
    const y = random() * 10;
    if (f.type === 'Point') return { type: 'Point', coordinates: [x, y] };
    if (f.type === 'LineString') {
      const n = 2 + Math.floor(random() * 4);
      return {
        type: 'LineString',
        coordinates: Array.from({ length: n }, (_, k) => [x + k * 0.1, y + random() * 0.1]),
      };
    }
    const n = 3 + Math.floor(random() * 4);
    const ring = Array.from({ length: n }, (_, k) => {
      const a = (k / n) * Math.PI * 2;
      return [x + Math.cos(a), y + Math.sin(a)];
    });
    ring.push(ring[0]);
    return { type: 'Polygon', coordinates: [ring] };
  }

  it('reads every row, every item and every value as the features written', () => {
    for (const seed of [1, 2, 3]) {
      const random = seededRandom(seed);
      const features: Feature[] = Array.from({ length: 60 }, (_, i) => {
        const kind = i % 3;
        const f =
          kind === 0
            ? feature(`f${i}`, 'Point', [i, 0])
            : kind === 1
              ? feature(`f${i}`, 'LineString', [
                  [i, 0],
                  [i, 1],
                ])
              : feature(`f${i}`, 'Polygon', [
                  [
                    [i, 0],
                    [i + 1, 0],
                    [i, 1],
                    [i, 0],
                  ],
                ]);
        return { ...f, properties: { n: i, name: `name ${i}` } };
      });
      const { tables, writer } = tablesOfFeatures('layer', features, 16);
      const alive = features.map((f) => ({ ...f }) as Feature | null);
      for (let step = 0; step < 300; step++) {
        const i = Math.floor(random() * features.length);
        const current = alive[i];
        if (!current) continue;
        const handle = tables.getRowRef(current.id) as number;
        const pick = random();
        let field: RowField;
        let value: unknown;
        if (pick < 0.3) {
          field = 'geometry';
          value = geometryAt(random, current);
          alive[i] = { ...current, geometry: value as Feature['geometry'] };
        } else if (pick < 0.5) {
          field = 'style';
          value = {
            pointColor: `#${Math.floor(random() * 0xffffff)
              .toString(16)
              .padStart(6, '0')}`,
          };
          alive[i] = { ...current, style: value as Feature['style'] };
        } else if (pick < 0.6) {
          field = 'hidden';
          value = random() < 0.5;
          alive[i] = { ...current, visible: !(value as boolean) };
        } else if (pick < 0.9) {
          const key = ['n', 'name', 'extra'][Math.floor(random() * 3)];
          field = `properties:${key}`;
          value = random() < 0.2 ? undefined : random() < 0.5 ? random() * 100 : `v${step}`;
          const properties = { ...current.properties };
          if (value === undefined) delete properties[key];
          else properties[key] = value as Value;
          alive[i] = { ...current, properties };
        } else {
          writer.writeRows({
            handles: Int32Array.of(handle),
            fields: new Map(),
            deleted: Uint8Array.of(1),
          });
          alive[i] = null;
          continue;
        }
        writer.writeRows(patchOf([handle], field, [value]));
      }
      const view = tables.get('layer');
      if (!view) throw new Error('no layer');
      const expected = alive.filter((f): f is Feature => f !== null);
      const scanned = readAll(tables.scan());
      expect(scanned.map((h) => tables.getRowId(h))).toEqual(expected.map((f) => f.id));
      expect(Array.from(view.listItems(0, 1000).handles)).toEqual(scanned);
      for (const f of expected) {
        const handle = tables.getRowRef(f.id) as number;
        const row = view.getRow(handle);
        expect(row?.geometry).toEqual(f.geometry);
        expect(row?.properties).toEqual(f.properties);
        expect(row?.style).toEqual(f.style);
        expect(row?.visible).toBe(f.visible);
        for (const key of ['n', 'name', 'extra']) {
          expect(view.getRowValue(handle, key)).toEqual(f.properties[key]);
        }
      }
    }
  });
});
