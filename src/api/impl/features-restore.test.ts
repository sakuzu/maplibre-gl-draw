// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.features.restore`: the values of features held as rows written back through the gate of
 * the instance (read-only and the locks), returning the values they had, which written back put
 * them back; `draw.features.releaseRestore`, which lets go of the rows a deletion kept; and the
 * writes of `draw.features` of rows that are not selected, notified with the values before
 * (`DocumentChange.previousValues`), undone by writing them back.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import { createRowValues as createRows, featureValuesOf, rowValuesOf } from '../../kasane/index.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature, RestoreToken, StoreChange } from '../../store/types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { FeatureValues } from '../model.js';
import type { FeatureTables, RowField } from '../tables.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

/** Values of rows made as values of features, which `draw.features.restore` writes back */
function createRowValues(values: Parameters<typeof createRows>[0]): FeatureValues {
  return featureValuesOf(createRows(values));
}

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
});

function point(id: string, x: number): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [x, 0] },
    layerId: 'rows',
    groupId: undefined,
    properties: { n: x },
    style: {},
    visible: true,
    locked: false,
  };
}

function drawOn(store: Store): Draw {
  const engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  return draw;
}

function setup() {
  const { store } = createTableStore();
  store.createLayer({
    id: 'rows',
    name: 'rows',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  });
  for (let i = 0; i < 4; i++) store.createFeature(point(`p${i}`, i));
  const tables = store.tables as FeatureTables;
  const instance = drawOn(store);
  const notified: StoreChange[] = [];
  instance.getStore().subscribe((change) => notified.push(change));
  return { draw: instance, tables, notified };
}

/** The rows as features, in their order */
function rowsOf(instance: Draw, tables: FeatureTables): Feature[] {
  const view = tables.get('rows');
  return Array.from(
    view?.listRowHandles(0, 100) ?? [],
    (handle) => tables.getRowId(handle) as string,
  )
    .filter((id) => tables.getRowRef(id) !== undefined)
    .map((id) => instance.getStore().getFeature(id) as Feature);
}

describe('draw.features.restore', () => {
  it('writes the rows, notifies the values before as previousValues and returns them', () => {
    const { draw, tables, notified } = setup();
    const start = rowsOf(draw, tables);
    const handles = Int32Array.from(['p1', 'p2'], (id) => tables.getRowRef(id) as number);
    const before = draw.features.restore(
      createRowValues({
        handles,
        fields: new Map<RowField, unknown[]>([
          ['style', [{ pointColor: '#ff0000' }, { pointColor: '#00ff00' }]],
          ['properties:n', [10, 20]],
        ]),
      }),
    );
    expect(before && rowValuesOf(before).fields.get('properties:n')).toEqual([1, 2]);
    expect(notified[notified.length - 1].previousValues).toBe(before);
    expect(notified[notified.length - 1].rows?.layers.get('rows')).toBeDefined();
    expect(draw.getStore().getFeature('p2')?.properties).toEqual({ n: 20 });
    // Written back
    draw.features.restore(before as FeatureValues);
    expect(rowsOf(draw, tables)).toEqual(start);
  });

  it('brings back a row deleted where it was', () => {
    const { draw, tables, notified } = setup();
    const start = rowsOf(draw, tables);
    expect(draw.features.delete('p1')).toBe(true);
    const before = notified[notified.length - 1].previousValues as FeatureValues;
    expect(Array.from(rowValuesOf(before).deleted ?? [])).toEqual([0]);
    draw.features.restore(before);
    expect(rowsOf(draw, tables)).toEqual(start);
  });

  it('is refused while read-only', () => {
    const { draw, tables } = setup();
    draw.setReadOnly(true);
    const handle = tables.getRowRef('p1') as number;
    expect(
      draw.features.restore(
        createRowValues({
          handles: Int32Array.of(handle),
          fields: new Map([['hidden', [true]]]),
        }),
      ),
    ).toBeNull();
    expect(draw.getStore().getFeature('p1')?.visible).toBe(true);
  });

  it('is refused while a row, its group or its layer is locked, unless the locks are ignored', () => {
    const { draw, tables } = setup();
    const values = (id: string) =>
      createRowValues({
        handles: Int32Array.of(tables.getRowRef(id) as number),
        fields: new Map([['properties:n', [99]]]),
      });
    draw.features.update('p1', { locked: true });
    expect(draw.features.restore(values('p1'))).toBeNull();
    expect(draw.getStore().getFeature('p1')?.properties).toEqual({ n: 1 });
    const group = draw.groups.create({ featureIds: ['p2'] });
    draw.groups.update(group?.id as string, { locked: true });
    expect(draw.features.restore(values('p2'))).toBeNull();
    draw.layers.update('rows', { locked: true });
    expect(draw.features.restore(values('p3'))).toBeNull();
    expect(draw.getStore().getFeature('p3')?.properties).toEqual({ n: 3 });
    // In a transaction that ignores the locks, every one is written
    draw.transact(
      () => {
        for (const id of ['p1', 'p2', 'p3'])
          expect(draw.features.restore(values(id))).not.toBeNull();
      },
      { ignoreLocks: true },
    );
    for (const id of ['p1', 'p2', 'p3']) {
      expect(draw.getStore().getFeature(id)?.properties).toEqual({ n: 99 });
    }
  });

  it('throws on values of the wrong shape or a handle of no row, writing nothing', () => {
    const { draw, tables, notified } = setup();
    const handle = tables.getRowRef('p1') as number;
    const count = notified.length;
    const call = (values: unknown) => () => draw.features.restore(values as FeatureValues);
    expect(call(null)).toThrow(expect.objectContaining({ code: 'invalid-input' }));
    expect(call({ handles: [handle], fields: new Map() })).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(call({ handles: Int32Array.of(handle), fields: new Map([['hidden', []]]) })).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(call({ handles: Int32Array.of(handle), fields: new Map([['size', [1]]]) })).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(
      call({ handles: Int32Array.of(handle), fields: new Map(), deleted: Uint8Array.of(1, 1) }),
    ).toThrow(expect.objectContaining({ code: 'invalid-input' }));
    expect(call({ handles: Int32Array.of(9999), fields: new Map() })).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
    expect(notified).toHaveLength(count);
  });

  it('throws invalid-state on a Store of objects, and after destroy', () => {
    const empty = createRowValues({ handles: new Int32Array(0), fields: new Map() });
    const instance = drawOn(createTableStore().store);
    instance.destroy();
    expect(() => instance.features.restore(empty)).toThrow(
      expect.objectContaining({ code: 'invalid-state' }),
    );
    draw = undefined;
    const objects = drawOn(undefined as unknown as Store);
    expect(() => objects.features.restore(empty)).toThrow(
      expect.objectContaining({ code: 'invalid-state' }),
    );
    expect(() => objects.features.releaseRestore(1 as RestoreToken)).toThrow(
      expect.objectContaining({ code: 'invalid-state' }),
    );
  });

  it('leaves no tables resource on the instance', () => {
    const { draw } = setup();
    expect('tables' in draw).toBe(false);
  });
});

describe('draw.features.releaseRestore', () => {
  it('lets go of the rows a deletion kept: once their blocks are made again, they are gone', () => {
    const { draw, tables, notified } = setup();
    draw.features.delete('p1');
    const change = notified[notified.length - 1];
    const token = change.restoreToken as RestoreToken;
    expect(token).toBeDefined();
    // Kept through the next versions of the blocks
    featureTablesInternals(tables)?.flushVersions();
    expect(tables.getRowId(tables.getRowRef('p0') as number)).toBe('p0');
    draw.features.releaseRestore(token);
    featureTablesInternals(tables)?.flushVersions();
    expect(() => draw.features.restore(change.previousValues as FeatureValues)).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
  });

  it('throws invalid-input for a value that is not a token', () => {
    const { draw } = setup();
    expect(() => draw.features.releaseRestore('t' as unknown as RestoreToken)).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
  });
});

describe('the writes of draw.features of rows that are not selected', () => {
  it('are notified with the values before, and undone by writing them back', () => {
    const { draw, tables, notified } = setup();
    // The steps of the writes of this client, to undo them
    const steps: FeatureValues[] = [];
    draw.getStore().subscribe((change) => {
      if (change.source === 'local' && change.previousValues) steps.push(change.previousValues);
    });
    const start = rowsOf(draw, tables);
    expect(draw.selection.value.ids).toEqual([]);
    draw.features.update('p2', {
      geometry: { type: 'Point', coordinates: [7, 7] },
      properties: { n: 70 },
      style: { pointColor: '#123456' },
    });
    const change = notified[notified.length - 1];
    expect(change.features?.updated ?? []).toEqual([]);
    expect(Array.from(change.rows?.layers.get('rows')?.updated ?? [])).toEqual([
      tables.getRowRef('p2'),
    ]);
    draw.features.update('p3', { visible: false });
    expect(steps).toHaveLength(2);
    // Undone, the last first
    for (const step of [...steps].reverse()) {
      draw.transact(() => draw.features.restore(step), { source: 'history', ignoreLocks: true });
    }
    expect(rowsOf(draw, tables)).toEqual(start);
  });
});
