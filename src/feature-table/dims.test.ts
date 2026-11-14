// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows of layers whose coordinates have a `z`, an `m` or both
 *
 * - Writes of every kind at random, groups of features put in another place, with the next
 *   versions made in between, on the main thread and in a Worker: every read gives the
 *   reference, every value of the positions included, in layers of `xy`, `xyz`, `xym` and `xyzm`
 *
 * - A write of a `z` or an `m` only is written in place and draws nothing again
 * - The values read are the values written back: `snapshot` and `writeRows` keep the `z` and the `m`
 * - A row of a layer of `z` or `m` is not made a feature, and a row group or a row of other
 *   dimensions is refused
 */

import { mergePages } from '@sakuzu/kasane';
import type { InPlaceRowWrite } from '@sakuzu/kasane/render';
import { type CoordinateDimensions, planarRowBox } from '@sakuzu/tabane';
import type { Geometry, Position } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { FeatureTablesWorker } from '../api/tables.js';
import { circleRowRings } from '../table/circle-rings.js';
import { geometryColumnOf } from '../table/feature-row-columns.js';
import { FEATURE_TABLE_COLUMNS } from '../table/tabane/columns.js';
import { tablesBuilderOptionsOf, tablesMergeOf } from '../table/tables-values.js';
import {
  featureRowDataBuilder as createPageDataBuilder,
  expectTablesMatch,
  referenceKey as key,
  type RandomGeometry,
  type ReferenceRow,
  ReferenceRows,
  randomReference,
  randomRowGeometry,
  randomRowWrites,
  rowPatch,
  seededRandom,
  tablesOfReference,
} from '../test-utils.js';

const ALL_DIMS: readonly CoordinateDimensions[] = ['xy', 'xyz', 'xym', 'xyzm'];

/**
 * The positions of the geometries at random of a layer of dimensions: some with every value,
 * some without the ones after x and y (read back without them), and in `xyzm` some with an `m`
 * and no `z`
 */
function geometryOf(dims: CoordinateDimensions): RandomGeometry {
  const extra = (random: () => number): number[] => {
    const pick = random();
    const z = Math.round(random() * 1000) / 10;
    const m = 1.7e12 + Math.floor(random() * 1e6);
    switch (dims) {
      case 'xy':
        return [];
      case 'xyz':
        return pick < 0.2 ? [] : [z];
      case 'xym':
        return pick < 0.2 ? [] : [m];
      case 'xyzm':
        return pick < 0.15 ? [] : pick < 0.3 ? [z] : pick < 0.45 ? [Number.NaN, m] : [z, m];
    }
  };
  return (random, type) => {
    const geometry = randomRowGeometry(random, type);
    const lift = (position: Position): Position => [position[0], position[1], ...extra(random)];
    switch (geometry.type) {
      case 'Point':
        return { type: 'Point', coordinates: lift(geometry.coordinates) };
      case 'LineString':
        return { type: 'LineString', coordinates: geometry.coordinates.map(lift) };
      case 'Polygon': {
        // The closing position is the first one, with its values
        const ring = geometry.coordinates[0].slice(0, -1).map(lift);
        return { type: 'Polygon', coordinates: [[...ring, [...ring[0]]]] };
      }
      default:
        return geometry;
    }
  };
}

/** A Worker of the host in the same thread: what it is sent is cloned, as a message is */
function cloningWorker(): FeatureTablesWorker & { calls: number } {
  const worker = {
    calls: 0,
    merge: async (merge: Parameters<FeatureTablesWorker['merge']>[0]) => {
      worker.calls++;
      return mergePages(tablesMergeOf(structuredClone(merge)));
    },
    build: async (
      rows: Parameters<FeatureTablesWorker['build']>[0],
      options: Parameters<FeatureTablesWorker['build']>[1],
    ) => {
      worker.calls++;
      const builder = createPageDataBuilder({
        columns: FEATURE_TABLE_COLUMNS,
        ...tablesBuilderOptionsOf(structuredClone(options)),
        rings: circleRowRings,
      });
      for (const row of structuredClone(rows)) builder.addRow(row);
      return builder.finish();
    },
  };
  return worker;
}

/** A budget of `n` steps */
function steps(n: number) {
  let left = n;
  return {
    canStep: () => left > 0,
    step: <T>(work: (deadline: number) => T): T => {
      left--;
      return work(Number.POSITIVE_INFINITY);
    },
  };
}

/** Lets the promises of a Worker settle */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the rows of layers of every dimensions', () => {
  for (const dims of ALL_DIMS) {
    it(`read as the reference through writes of every kind and the next versions (${dims})`, () => {
      for (const seed of [1, 2]) {
        const random = seededRandom(seed);
        const layerIds = ['a', 'b'];
        const geometry = geometryOf(dims);
        const reference = randomReference(random, 120, layerIds, geometry);
        const setup = tablesOfReference(reference, layerIds, 8, { dimensionsOf: () => dims });
        const { tables, internals, groupHandleOf } = setup;
        const writes = randomRowWrites(random, {
          ...setup,
          reference,
          layerIds,
          geometryOf: geometry,
        });
        for (let step = 0; step < 150; step++) {
          writes.step(step);
          if (step % 50 === 49) {
            expectTablesMatch(tables, reference, layerIds, groupHandleOf);
            internals.rebuild(steps(3));
          }
          if (step % 50 === 24) {
            // A group of features put in another place: its members are cut out of their row
            // groups, as they are
            const order = key(random() * 1e6);
            setup.writer.writeGroups({
              groups: Int32Array.of(groupHandleOf('ga')),
              fields: new Map([['key', [order]]]),
            });
            const group = reference.groups.get('ga');
            if (group) group.order = order;
          }
        }
        expectTablesMatch(tables, reference, layerIds, groupHandleOf);
        internals.flushVersions();
        expect(internals.deltaRowCount()).toBe(0);
        expectTablesMatch(tables, reference, layerIds, groupHandleOf);
        for (const layerId of layerIds) {
          const table = internals.rowTable(layerId);
          for (let g = 0; g < (table?.groupCount ?? 0); g++) {
            for (const child of geometryColumnOf(table!.groupAt(g).data)!.children ?? []) {
              expect(child.dimensions).toBe(dims);
            }
          }
        }
      }
    });

    it(`read as the reference with the merges and the builds in a Worker (${dims})`, async () => {
      const random = seededRandom(7);
      const layerIds = ['a'];
      const geometry = geometryOf(dims);
      const reference = randomReference(random, 40, layerIds, geometry);
      const worker = cloningWorker();
      const setup = tablesOfReference(reference, layerIds, 8, { dimensionsOf: () => dims, worker });
      const { tables, writer, internals, groupHandleOf } = setup;
      // Many new rows at once: built in the Worker
      const ids = Array.from({ length: 200 }, (_, i) => `w${i}`);
      const handles = writer.allocateRowRefs(
        (await import('@sakuzu/tabane')).byteColumnFromStrings(ids),
      );
      const rows: ReferenceRow[] = ids.map((id, i) => ({
        id,
        layerId: 'a',
        type: 'LineString',
        geometry: geometry(random, 'LineString'),
        order: key(2_000_000 + i),
        groupId: undefined,
        member: '',
        style: {},
        properties: {},
        visible: true,
        locked: false,
        deleted: false,
      }));
      writer.writeRows(
        rowPatch(Array.from(handles), {
          type: rows.map((row) => row.type),
          parent: rows.map(() => 'a'),
          geometry: rows.map((row) => row.geometry),
          key: rows.map((row) => row.order),
        }),
      );
      for (const row of rows) reference.rows.set(row.id, row);
      for (let i = 0; i < 6; i++) {
        internals.rebuild(steps(10));
        internals.advanceQueuedBlocks(steps(10));
        await settle();
      }
      internals.addQueuedPages();
      expectTablesMatch(tables, reference, layerIds, groupHandleOf);
      // A merge past the rows of the main thread: in the Worker
      const all = [...reference.rows.values()];
      const moved = all.slice(0, 30);
      writer.writeRows(
        rowPatch(
          moved.map((row) => tables.getRowRef(row.id) as number),
          { key: moved.map((_, i) => key(1_000_000 + i)) },
        ),
      );
      moved.forEach((row, i) => {
        // The key of a member orders it among the members of its group
        if (row.groupId !== undefined) row.member = key(1_000_000 + i);
        else row.order = key(1_000_000 + i);
      });
      for (let i = 0; i < 8; i++) {
        internals.rebuild(steps(10));
        await settle();
      }
      internals.flushVersions();
      expect(worker.calls).toBeGreaterThan(0);
      expectTablesMatch(tables, reference, layerIds, groupHandleOf);
    });
  }
});

describe('a next version merged in a Worker', () => {
  it('copies every value of the coordinates, and is sent nothing it cannot be posted', async () => {
    const random = seededRandom(11);
    const geometry = geometryOf('xyzm');
    const reference = new ReferenceRows();
    for (let i = 0; i < 9000; i++) {
      reference.rows.set(`p${i}`, {
        id: `p${i}`,
        layerId: 'a',
        type: 'Point',
        geometry: geometry(random, 'Point'),
        order: key(i * 10),
        groupId: undefined,
        member: '',
        style: {},
        properties: {},
        visible: true,
        locked: false,
        deleted: false,
      });
    }
    const worker = cloningWorker();
    const setup = tablesOfReference(reference, ['a'], 10_000, {
      dimensionsOf: () => 'xyzm',
      worker,
      coordinateSystem: { rowBox: (...args) => planarRowBox(...args) },
    });
    const { tables, writer, internals, groupHandleOf } = setup;
    expect(internals.rowTable('a')?.groupCount).toBe(1);
    const moved = reference.rows.get('p5') as ReferenceRow;
    moved.order = key(50_005);
    moved.geometry = { type: 'Point', coordinates: [3, 4, Number.NaN, 5] };
    writer.writeRows(
      rowPatch([tables.getRowRef('p5') as number], {
        key: [moved.order],
        geometry: [moved.geometry],
      }),
    );
    for (let i = 0; i < 6; i++) {
      internals.rebuild(steps(10));
      await settle();
    }
    expect(worker.calls).toBe(1);
    internals.flushVersions();
    expect(internals.deltaRowCount()).toBe(0);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
  });
});

/** Tables of one layer of dimensions holding a few rows */
function smallTables(dims: CoordinateDimensions, rows: Array<[string, Geometry]>) {
  const reference = new ReferenceRows();
  rows.forEach(([id, geometry], i) => {
    reference.rows.set(id, {
      id,
      layerId: 'a',
      type: geometry.type,
      geometry,
      order: key(i * 1000),
      groupId: undefined,
      member: '',
      style: {},
      properties: {},
      visible: true,
      locked: false,
      deleted: false,
    });
  });
  const setup = tablesOfReference(reference, ['a'], 8, {
    dimensionsOf: (layerId) => (layerId === 'a' ? dims : 'xy'),
  });
  const at = (id: string) => setup.tables.getRowRef(id) as number;
  const geometryOf = (id: string) =>
    setup.tables.readValues(rowPatch([at(id)], { geometry: [0] })).fields.get('geometry')?.[0];
  return { ...setup, reference, at, geometryOf };
}

describe('a write of the coordinates of a layer of z or m', () => {
  it('of a z only is written in place, and draws nothing again', () => {
    const line = (z: number): Geometry => ({
      type: 'LineString',
      coordinates: [
        [0, 0, z],
        [1, 1, z],
      ],
    });
    const { writer, internals, at, geometryOf } = smallTables('xyz', [['l', line(1)]]);
    const written: InPlaceRowWrite[] = [];
    internals.onRowsWritten((_, writes) => written.push(...writes));
    writer.writeRows(rowPatch([at('l')], { geometry: [line(2)] }));
    expect(written).toHaveLength(1);
    expect(written[0].sameShape).toBe(true);
    expect(written[0].to - written[0].from).toBe(0);
    expect(geometryOf('l')).toEqual(line(2));
    expect(internals.overrideBytes()).toBe(0);
    // A move of x and y is drawn again, the coordinates it moved only
    writer.writeRows(
      rowPatch([at('l')], {
        geometry: [
          {
            type: 'LineString',
            coordinates: [
              [0, 0, 2],
              [5, 1, 3],
            ],
          },
        ],
      }),
    );
    expect([written[1].from, written[1].to]).toEqual([1, 2]);
  });

  it('keeps the z and the m through snapshot and apply, and of 2 values reads back 2 values', () => {
    const point = (...position: number[]): Geometry => ({ type: 'Point', coordinates: position });
    const { tables, writer, internals, at, geometryOf } = smallTables('xyzm', [
      ['p', point(1, 2, 3, 4)],
      ['q', point(1, 2)],
      ['r', point(1, 2, Number.NaN, 9)],
    ]);
    expect(geometryOf('p')).toEqual(point(1, 2, 3, 4));
    expect(geometryOf('q')).toEqual(point(1, 2));
    expect(geometryOf('r')).toEqual(point(1, 2, Number.NaN, 9));
    const before = tables.readValues(rowPatch([at('p'), at('r')], { geometry: [0, 0] }));
    writer.writeRows(rowPatch([at('p'), at('r')], { geometry: [point(7, 7), point(8, 8, 1)] }));
    expect(geometryOf('p')).toEqual(point(7, 7));
    writer.writeRows({ rows: before.rows, fields: before.fields });
    expect(geometryOf('p')).toEqual(point(1, 2, 3, 4));
    expect(geometryOf('r')).toEqual(point(1, 2, Number.NaN, 9));
    // Of another shape: kept aside, with its values, until the next version
    const line: Geometry = {
      type: 'LineString',
      coordinates: [
        [0, 0, 1, 2],
        [1, 1, 3],
      ],
    };
    writer.writeRows(rowPatch([at('q')], { type: ['LineString'], geometry: [line] }));
    expect(geometryOf('q')).toEqual(line);
    internals.flushVersions();
    expect(geometryOf('q')).toEqual(line);
    expect(geometryOf('p')).toEqual(point(1, 2, 3, 4));
  });

  it('of more values than the dimensions of the layer is refused, nothing written', () => {
    const { writer, at, geometryOf } = smallTables('xyz', [
      ['p', { type: 'Point', coordinates: [1, 2, 3] }],
    ]);
    expect(() =>
      writer.writeRows(
        rowPatch([at('p')], { geometry: [{ type: 'Point', coordinates: [1, 2, 3, 4] }] }),
      ),
    ).toThrow(/does not fit coordinates of xyz/);
    expect(geometryOf('p')).toEqual({ type: 'Point', coordinates: [1, 2, 3] });
    const xy = smallTables('xy', [['p', { type: 'Point', coordinates: [1, 2] }]]);
    expect(() =>
      xy.writer.writeRows(
        rowPatch([xy.at('p')], { geometry: [{ type: 'Point', coordinates: [1, 2, 3] }] }),
      ),
    ).toThrow(/does not fit coordinates of xy/);
  });
});

describe('the rows of a layer of z or m', () => {
  it('of a layer declared of z with no rows yet hold the rows it is given', () => {
    const { writer, internals } = tablesOfReference(new ReferenceRows(), [], 8, {
      dimensionsOf: (tableId) => (tableId === 'a' ? 'xyz' : 'xy'),
    });
    const builder = createPageDataBuilder({
      columns: FEATURE_TABLE_COLUMNS,
      dimensions: 'xyz',
    });
    builder.addRow({
      id: 'p',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 2, 3] },
      key: key(1),
    });
    writer.addPages('a', builder.finish());
    internals.addQueuedPages();
    const table = internals.rowTable('a');
    expect(table?.dims).toBe('xyz');
    expect(
      geometryColumnOf(table!.groupAt(0).data)!.children.map((child) => child.dimensions),
    ).toEqual(['xyz']);
  });

  it('are not made features: read as one, hit as one', () => {
    const { tables } = smallTables('xyz', [['p', { type: 'Point', coordinates: [1, 2, 3] }]]);
    const handle = tables.getRowRef('p') as number;
    expect(() => tables.get('a')?.getRow(handle)).toThrow(/is not a feature/);
    // What is read without a feature: x and y
    expect(tables.get('a')?.getRowPoint(handle)).toEqual([1, 2]);
    expect(tables.get('a')?.getRowBBox(handle)).toEqual([1, 2, 1, 2]);
  });

  it('refuse a row group of other dimensions, and a row moved from a layer they do not read', () => {
    const { writer, at } = smallTables('xyz', [['p', { type: 'Point', coordinates: [1, 2, 3] }]]);
    const builder = createPageDataBuilder({ columns: FEATURE_TABLE_COLUMNS });
    builder.addRow({
      id: 'q',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 2] },
      key: key(5),
    });
    expect(() => writer.addPages('a', builder.finish())).toThrow(
      /coordinates of xy, its table xyz/,
    );
    // Into a layer of xy: its z would be lost
    expect(() => writer.writeRows(rowPatch([at('p')], { parent: ['b'], key: [key(1)] }))).toThrow(
      /coordinates of xyz, the table "b" of xy/,
    );
  });

  it('take a row moved from a layer of xy, with a geometry or without', () => {
    const reference = new ReferenceRows();
    for (const [id, layerId] of [
      ['p', 'a'],
      ['q', 'a'],
      ['r', 'b'],
    ] as const) {
      reference.rows.set(id, {
        id,
        layerId,
        type: 'Point',
        geometry: { type: 'Point', coordinates: [1, 2] },
        order: key(id.charCodeAt(0)),
        groupId: undefined,
        member: '',
        style: {},
        properties: {},
        visible: true,
        locked: false,
        deleted: false,
      });
    }
    const setup = tablesOfReference(reference, ['a', 'b'], 8, {
      dimensionsOf: (layerId) => (layerId === 'b' ? 'xyz' : 'xy'),
    });
    const { tables, writer, internals, groupHandleOf } = setup;
    const at = (id: string) => tables.getRowRef(id) as number;
    writer.writeRows(rowPatch([at('p')], { parent: ['b'], key: [key(1)] }));
    Object.assign(reference.rows.get('p') as ReferenceRow, { layerId: 'b', order: key(1) });
    const geometry: Geometry = { type: 'Point', coordinates: [4, 5, 6] };
    writer.writeRows(rowPatch([at('q')], { parent: ['b'], key: [key(2)], geometry: [geometry] }));
    Object.assign(reference.rows.get('q') as ReferenceRow, {
      layerId: 'b',
      order: key(2),
      geometry,
    });
    expectTablesMatch(tables, reference, ['a', 'b'], groupHandleOf);
    internals.flushVersions();
    expectTablesMatch(tables, reference, ['a', 'b'], groupHandleOf);
  });
});
