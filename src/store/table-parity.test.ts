// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the Store of rows does, written down once and compared after every rework of its tables
 *
 * Each case runs one kind of write (the writes of the Store, and the ones of the writer of its
 * tables from elsewhere) on a document of every type of feature, and records what is read after
 * it: the notification, the document (the items of every layer in their order, every feature),
 * the values of the rows, what the rows of a layer read (drawn, by a box, a value, a style), a
 * scan, the deletion kept and let go of, the next versions of the row blocks, and the rows
 * written into Tabane blocks and read back. The record is compared with the one written before
 * the rework (`__snapshots__/table-parity.jsonl`), so a rework that changes the internals and not
 * what the Store does keeps it as it is.
 *
 * Only `record` and the few lines that reach the internals (`settle`) read the tables by the
 * names of the code; a rework that renames them changes those lines, never the record.
 */

import { readTabaneBlock, utf8ColumnFromStrings } from '@sakuzu/tabane';
import type { Geometry } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { FeatureTables, FeatureTablesWriter, RowField } from '../api/tables.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { createRowBlockBuilder } from '../table/row-group-builder.js';
import { writeTabaneFeatureBlocks } from '../table/tabane/blocks.js';
import { rowBlockOfTabane } from '../table/tabane/rows.js';
import { rowPatch } from '../test-utils.js';
import type { Store } from './store.js';
import { createTableStore } from './table-memory.js';
import type { Feature, RestoreToken, RowValues, StoreChange } from './types.js';

/** The geometries of the document, by type */
const SHAPES: ReadonlyArray<readonly [string, Geometry]> = [
  ['Point', { type: 'Point', coordinates: [1, 1] }],
  [
    'LineString',
    {
      type: 'LineString',
      coordinates: [
        [2, 0],
        [3, 1],
      ],
    },
  ],
  [
    'Polygon',
    {
      type: 'Polygon',
      coordinates: [
        [
          [4, 0],
          [5, 0],
          [5, 1],
          [4, 1],
          [4, 0],
        ],
      ],
    },
  ],
  [
    'MultiPoint',
    {
      type: 'MultiPoint',
      coordinates: [
        [6, 0],
        [6.5, 0.5],
      ],
    },
  ],
  [
    'MultiLineString',
    {
      type: 'MultiLineString',
      coordinates: [
        [
          [7, 0],
          [7.5, 0.5],
        ],
        [
          [7, 1],
          [7.5, 1.5],
        ],
      ],
    },
  ],
  [
    'MultiPolygon',
    {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [8, 0],
            [9, 0],
            [9, 1],
            [8, 0],
          ],
        ],
      ],
    },
  ],
  ['Circle', { type: 'Point', coordinates: [10, 0.5] }],
  [
    'Freehand',
    {
      type: 'LineString',
      coordinates: [
        [11, 0],
        [11.2, 0.4],
        [11.5, 0.2],
      ],
    },
  ],
];

/** The features of the document: one of each type in layer `a`, and two points in layer `b` */
function features(): Feature[] {
  const out: Feature[] = SHAPES.map(
    ([type, geometry], i): Feature => ({
      id: `f${i}`,
      type,
      geometry,
      layerId: 'a',
      groupId: undefined,
      properties: type === 'Circle' ? { n: i, radius: 5000 } : { n: i, name: `F ${i}` },
      style: i % 3 === 0 ? {} : i % 3 === 1 ? { strokeColor: '#ff0000' } : { fillColor: '#00ff00' },
      visible: true,
      locked: false,
    }),
  );
  for (let i = 0; i < 2; i++) {
    out.push({
      id: `b${i}`,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [20 + i, 5] },
      layerId: 'b',
      groupId: undefined,
      properties: { n: 100 + i },
      style: {},
      visible: true,
      locked: false,
    });
  }
  return out;
}

/** A layer held as rows */
function layer(id: string) {
  return {
    id,
    name: id.toUpperCase(),
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table' as const,
    metadata: undefined,
    styleRule: undefined,
  };
}

/** A Store of rows with the document, a group of two features in it, and what it notifies */
function setup(): {
  store: Store;
  writer: FeatureTablesWriter;
  tables: FeatureTables;
  notified: StoreChange[];
} {
  const { store, writer } = createTableStore();
  store.createLayer(layer('a'));
  store.createLayer(layer('b'));
  for (const f of features()) store.createFeature(f);
  store.createGroup({
    id: 'g',
    layerId: 'a',
    name: 'G',
    featureIds: ['f2', 'f3'],
    visible: true,
    locked: false,
  });
  const tables = store.tables;
  if (!tables) throw new Error('a Store of rows has tables');
  const notified: StoreChange[] = [];
  store.subscribe((change) => notified.push(change));
  return { store, writer, tables, notified };
}

/** Builds and swaps in every next version of the row blocks, and takes in the ones queued */
function settle(tables: FeatureTables): void {
  const internals = featureTablesInternals(tables);
  internals?.addQueuedRowBlocks();
  internals?.flushVersions();
}

/** The fields every row is read with */
const READ_FIELDS: readonly RowField[] = [
  'type',
  'layerId',
  'groupId',
  'order',
  'member',
  'geometry',
  'visible',
  'locked',
  'style',
  'property:n',
  'property:name',
  'property:radius',
];

/** A value as JSON can hold it: typed arrays as arrays, undefined as a mark, NaN as a mark */
function plain(value: unknown): unknown {
  if (value === undefined) return '<undefined>';
  if (typeof value === 'number' && Number.isNaN(value)) return '<NaN>';
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([k, v]) => [String(k), plain(v)]));
  }
  if (value instanceof Set) return [...value].map(String).sort();
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, plain((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** The ids of handles of rows */
function idsOf(tables: FeatureTables, handles: ArrayLike<number> | undefined): string[] {
  return Array.from(handles ?? [], (h) => tables.getRowId(h) ?? `<${h}>`);
}

/** Values of rows, the rows by their ids */
function valuesOf(tables: FeatureTables, values: RowValues | undefined): unknown {
  if (!values) return undefined;
  return {
    rows: idsOf(tables, values.handles),
    fields: plain(values.fields),
    ...(values.deleted && { deleted: Array.from(values.deleted) }),
  };
}

/** A notification, the rows by their ids */
function notificationOf(tables: FeatureTables, change: StoreChange): unknown {
  const out: Record<string, unknown> = { keys: Object.keys(change).sort() };
  if (change.source) out.source = change.source;
  if (change.reset) out.reset = true;
  if (change.restoreToken !== undefined) out.restoreToken = true;
  if (change.rows) {
    out.rows = Object.fromEntries(
      [...change.rows.layers].map(([layerId, rows]) => [
        layerId,
        {
          created: idsOf(tables, rows.created),
          updated: idsOf(tables, rows.updated),
          deleted: idsOf(tables, rows.deleted),
          fields: [...rows.fields].sort(),
          styleKeys: [...rows.styleKeys].sort(),
        },
      ]),
    );
  }
  if (change.previousValues)
    out.previousValues = valuesOf(tables, change.previousValues as RowValues);
  if (change.features) {
    out.features = {
      created: change.features.created?.map((f) => f.id),
      updated: change.features.updated?.map((u) => u.id),
      deleted: change.features.deleted?.map((f) => f.id),
    };
  }
  if (change.groups) {
    out.groups = {
      created: change.groups.created?.map((g) => g.id),
      updated: change.groups.updated?.map((u) => [u.id, plain(u.group), plain(u.previous)]),
      deleted: change.groups.deleted?.map((g) => g.id),
    };
  }
  if (change.order) {
    out.order = change.order.map((move) =>
      move.kind === 'item'
        ? {
            item: move.itemId,
            from: plain(move.from),
            to: plain(move.to),
            before: valuesOf(tables, move.before),
          }
        : {
            rows: idsOf(tables, move.handles),
            layerId: move.layerId,
            to: plain(move.to),
            belows: move.belows && plain(move.belows),
            before: valuesOf(tables, move.before),
          },
    );
  }
  if (change.selection) out.selection = plain(change.selection);
  return out;
}

/** What is read of the document now */
function record(store: Store, tables: FeatureTables): unknown {
  const layers: Record<string, unknown> = {};
  const handles: number[] = [];
  for (const layerId of store.getLayerOrder()) {
    const view = tables.get(layerId);
    if (!view) {
      layers[layerId] = null;
      continue;
    }
    const items = view.listItems(0, view.itemCount);
    const rows = view.listRowHandles(0, view.rowCountWithDeleted);
    handles.push(...rows);
    layers[layerId] = {
      rowCount: view.rowCount,
      rowCountWithDeleted: view.rowCountWithDeleted,
      itemCount: view.itemCount,
      items: Array.from(items.handles, (h, i) => {
        if (items.kinds[i] === 0) return tables.getRowId(h);
        const n = view.countGroupMembers(h);
        return {
          group: tables.getGroupId(h),
          members: idsOf(tables, view.listGroupMembers(h, 0, n)),
        };
      }),
      rows: idsOf(tables, rows),
      drawn: idsOf(tables, view.listDrawnRows([-180, -90, 180, 90])),
      drawnInBox: idsOf(tables, view.listDrawnRows([3.5, -1, 7.2, 2])),
      byRow: Object.fromEntries(
        Array.from(rows, (h) => [
          tables.getRowId(h),
          {
            bbox: plain(view.getRowBBox(h)),
            type: view.getRowType(h),
            point: plain(view.getRowPoint(h)),
            n: plain(view.getRowValue(h, 'n')),
            style: plain(view.getRowStyle(h)),
          },
        ]),
      ),
    };
  }
  const all = new Set<string>();
  for (const id of ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'b0', 'b1', 'n0', 'n1']) {
    all.add(id);
  }
  const scanned: string[] = [];
  const cursor = tables.scan({ bbox: [0, -1, 12, 2], order: 'any', batchSize: 3 });
  for (let batch = cursor.next(); batch; batch = cursor.next())
    scanned.push(...idsOf(tables, batch));
  const sorted = Int32Array.from(handles).sort();
  const read = tables.readValues({
    handles: sorted,
    fields: new Map(READ_FIELDS.map((f) => [f, Array.from(sorted, () => undefined)])),
    deleted: new Uint8Array(sorted.length),
  });
  return {
    layerOrder: [...store.getLayerOrder()],
    layers,
    groups: store
      .listGroups()
      .map((g) => plain(g))
      .sort((a, b) => String((a as { id: string }).id).localeCompare((b as { id: string }).id)),
    features: Object.fromEntries([...all].sort().map((id) => [id, plain(store.getFeature(id))])),
    found: Object.fromEntries([...all].sort().map((id) => [id, tables.findRow(id) !== undefined])),
    scanned: scanned.sort(),
    values: valuesOf(tables, read),
  };
}

/** A case: the writes, and what is recorded of them */
interface Case {
  readonly name: string;
  run(s: ReturnType<typeof setup>, step: (label: string) => void): void;
}

const CASES: readonly Case[] = [
  {
    name: 'opened',
    run: () => {},
  },
  {
    name: 'update of each field by the Store',
    run: ({ store }, step) => {
      store.updateFeature('f0', { properties: { n: 50, name: 'P' } });
      step('properties');
      store.updateFeature('f1', { style: { strokeColor: '#0000ff', strokeWidth: 4 } });
      step('style');
      store.updateFeature('f2', {
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [4, 0],
              [6, 0],
              [6, 2],
              [4, 0],
            ],
          ],
        },
      });
      step('geometry');
      store.updateFeature('f4', { visible: false });
      step('hidden');
      store.updateFeature('f5', { locked: true });
      step('locked');
      store.updateFeature('f6', { properties: { n: 6, radius: 9000 } });
      step('radius of a circle');
      store.updateFeature('f0', { type: 'Circle', properties: { n: 0, radius: 100 } });
      step('type');
    },
  },
  {
    name: 'creation and deletion by the Store',
    run: ({ store }, step) => {
      store.createFeature({
        id: 'n0',
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [0.5, 0.5],
          ],
        },
        layerId: 'a',
        groupId: undefined,
        properties: { n: 1000 },
        style: {},
        visible: true,
        locked: false,
      });
      step('created');
      store.createFeature({
        id: 'n1',
        type: 'Point',
        geometry: { type: 'Point', coordinates: [4.5, 0.5] },
        layerId: 'a',
        groupId: 'g',
        properties: { n: 1001 },
        style: {},
        visible: true,
        locked: false,
      });
      step('created in a group');
      store.deleteFeature('f1');
      step('deleted');
      store.transact(() => {
        store.deleteFeature('f2');
        store.deleteFeature('f3');
        store.deleteFeature('n1');
      });
      step('the members of a group deleted');
    },
  },
  {
    name: 'order',
    run: ({ store }, step) => {
      store.moveItems?.(['f5', 'f0'], { layerId: 'a', below: 'f1' });
      step('moved in the layer');
      store.moveItems?.(['f4'], { layerId: 'a', groupId: 'g', below: null });
      step('moved into a group');
      store.moveItems?.(['f6'], { layerId: 'b', above: null });
      step('moved to another layer');
      store.moveItems?.(['g'], { layerId: 'a', below: null });
      step('the group moved');
      store.setLayerOrder(['b', 'a']);
      step('the layers ordered');
    },
  },
  {
    name: 'groups',
    run: ({ store }, step) => {
      store.updateGroup('g', { name: 'H', visible: false });
      step('hidden');
      store.updateGroup('g', { visible: true, locked: true });
      step('shown and locked');
      store.createGroup({
        id: 'h',
        layerId: 'a',
        name: 'H2',
        featureIds: ['f6', 'f7'],
        visible: true,
        locked: false,
      });
      step('created');
      store.deleteGroup('g');
      step('deleted');
    },
  },
  {
    name: 'writes from elsewhere',
    run: ({ store, writer, tables }, step) => {
      const h = (id: string) => tables.findRow(id) ?? -1;
      store.transact(
        () =>
          writer.apply(
            rowPatch([h('f0'), h('f7')], {
              'property:n': [7, 8],
              style: [{ pointColor: '#123456' }, {}],
            }),
          ),
        'remote',
      );
      step('values');
      store.transact(() => writer.apply(rowPatch([h('f1')], {}, [1])), 'remote');
      step('deleted');
      let refused = 'none';
      try {
        store.transact(
          () =>
            writer.apply(
              rowPatch([h('b1')], { geometry: [{ type: 'Point', coordinates: [21, 6, 3] }] }),
            ),
          'remote',
        );
      } catch (e) {
        refused = (e as { code?: string }).code ?? String(e);
      }
      step(`a position of more values: ${refused}`);
    },
  },
  {
    name: 'deletion kept and let go of',
    run: ({ store, writer, tables }, step) => {
      const h = (id: string) => tables.findRow(id) ?? -1;
      const handles = [h('f2'), h('f5')];
      const token: RestoreToken = writer.createRestoreToken();
      store.transact(() => writer.apply(rowPatch(handles, {}, [1, 1]), { restoreToken: token }));
      step('deleted with a token');
      settle(tables);
      step('the versions after it');
      store.transact(() => writer.apply(rowPatch(handles, {}, [0, 0])));
      step('put back');
      const again = writer.createRestoreToken();
      store.transact(() => writer.apply(rowPatch([handles[0]], {}, [1]), { restoreToken: again }));
      tables.release(again);
      step('deleted again and let go of');
      settle(tables);
      step('the versions after it');
      const known = writer.lookup('f2');
      writer.forget(Int32Array.of(known?.handle ?? -1));
      step(`forgotten (${known?.deleted})`);
    },
  },
  {
    name: 'row blocks added and cleared',
    run: ({ store, writer, tables }, step) => {
      const builder = createRowBlockBuilder();
      builder.addRow({
        id: 'n0',
        type: 'Point',
        geometry: { type: 'Point', coordinates: [30, 5] },
        order: 'z0',
        style: {},
        properties: { n: 2000 },
        visible: true,
        locked: false,
      });
      builder.addRow({
        id: 'n1',
        type: 'Polygon',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [31, 5],
              [32, 5],
              [32, 6],
              [31, 5],
            ],
          ],
        },
        order: 'z1',
        style: { fillColor: '#abcdef' },
        properties: { n: 2001 },
        visible: false,
        locked: false,
      });
      store.transact(() => writer.addRowBlocks('b', builder.finish()), 'load');
      settle(tables);
      step('added');
      const ids = ['f0', 'n0', 'zz'];
      const given = Array.from(writer.allocateHandles(utf8ColumnFromStrings(ids)));
      step(`handles ${JSON.stringify(given.map((x, i) => x === tables.findRow(ids[i])))}`);
      store.transact(() => writer.clear(), 'remote');
      step('cleared');
    },
  },
];

describe('the Store of rows, as it was before its tables were reworked', () => {
  it('reads the same after every write of every case', async () => {
    // One line per step: the case, the step, and what is read after it
    const lines: string[] = [];
    for (const c of CASES) {
      const s = setup();
      const step = (label: string) => {
        const notified = s.notified.map((n) => notificationOf(s.tables, n));
        lines.push(JSON.stringify({ case: c.name, step: label, notified }));
        lines.push(JSON.stringify(record(s.store, s.tables)));
        s.notified.length = 0;
      };
      c.run(s, step);
      step('end');
      settle(s.tables);
      step('the next versions swapped in');
    }
    await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot('./__snapshots__/table-parity.jsonl');
  });

  it('reads the rows written into Tabane blocks as they were', async () => {
    const s = setup();
    const view = s.tables.get('a');
    if (!view) throw new Error('layer a holds rows');
    const rows = Array.from(view.listRowHandles(0, view.rowCountWithDeleted), (h) => {
      const f = view.getRow(h);
      if (!f) throw new Error('a row of the layer');
      return {
        id: `1AAAAAAAAAAAA-${h + 1}`,
        type: f.type,
        geometry: f.geometry,
        style: f.style as Readonly<Record<string, unknown>>,
        properties: f.properties as Readonly<Record<string, unknown>>,
        visible: f.visible,
        locked: f.locked,
      };
    });
    const written = writeTabaneFeatureBlocks({ parent: 'a', head: 'V', rows, targetRows: 3 });
    const { store, writer } = createTableStore();
    store.createLayer(layer('a'));
    for (const w of written) {
      const rowBlocks = readTabaneBlock(w.block.content).map((b) => rowBlockOfTabane(b));
      store.transact(() => writer.addRowBlocks('a', rowBlocks), 'load');
    }
    const tables = store.tables as FeatureTables;
    settle(tables);
    const back = tables.get('a');
    const read = Array.from(back?.listRowHandles(0, back.rowCountWithDeleted) ?? [], (h) =>
      plain(back?.getRow(h)),
    );
    const lines = [
      JSON.stringify({ blocks: written.length }),
      ...read.map((r) => JSON.stringify(r)),
    ];
    await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot(
      './__snapshots__/table-parity-tabane.jsonl',
    );
  });
});
