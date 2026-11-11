// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.features.restore` of many rows: written in steps, a task each, and told once with the
 * last of them. Another write, a read of the rows and another restore made meanwhile write the
 * rest first: what is read is what the restore leaves, and the writes keep their order.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import { createRowValues as createRows, featureValuesOf, rowValuesOf } from '../../kasane/index.js';
import { BULK_SLICE_ROWS } from '../../operations/bulk-sliced.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature, SelectionTarget, StoreChange } from '../../store/types.js';
import { ROW_FLAG_DELETED } from '../../table/row-group-types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { FeatureValues } from '../model.js';
import type { FeatureTables, LayerTableView, RowField, RowWrite } from '../tables.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

/** Values of rows made as values of features, which `draw.features.restore` writes back */
function createRowValues(values: Parameters<typeof createRows>[0]): FeatureValues {
  return featureValuesOf(createRows(values));
}

/** The rows of the layer: more than are written at a time in a step */
const COUNT = BULK_SLICE_ROWS * 4;

let draw: Draw | undefined;
let clock = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // Each look at the clock is 13 ms later: a step writes one run of rows
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => {
    clock += 13;
    return clock;
  });
});

afterEach(() => {
  draw?.destroy();
  draw = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
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

/**
 * A layer of rows, every one of them deleted (by a write that is not a restore): the values the
 * deletion read before, which a restore brings them back with
 */
function setup(options: { selectionIdsLimit?: number; prepare?: (draw: Draw) => void } = {}) {
  const { store } = createTableStore(
    options.selectionIdsLimit === undefined ? {} : { selectionIdsLimit: options.selectionIdsLimit },
  );
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
  store.transact(() => {
    for (let i = 0; i < COUNT; i++) store.createFeature(point(`p${i}`, i));
  });
  const tables = store.tables as FeatureTables;
  const handles = Int32Array.from({ length: COUNT }, (_, i) => tables.findRow(`p${i}`) as number);
  const instance = drawOn(store);
  options.prepare?.(instance);
  const notified: StoreChange[] = [];
  instance.getStore().subscribe((change) => notified.push(change));
  const patch = createRowValues({
    handles,
    fields: new Map(),
    deleted: new Uint8Array(COUNT).fill(1),
  });
  const write: RowWrite = {
    patch: rowValuesOf(patch),
    before: tables.readValues(rowValuesOf(patch)),
  };
  store.applyRows(write);
  const deletion = notified[notified.length - 1];
  notified.length = 0;
  return {
    draw: instance,
    store,
    tables,
    handles,
    notified,
    before: deletion.previousValues as FeatureValues,
  };
}

/** The rows written back so far, read from the rows themselves (not through the tables) */
function rowsBack(tables: FeatureTables, handles: Int32Array): number {
  const internals = featureTablesInternals(tables);
  let back = 0;
  for (const handle of handles) {
    const place = internals?.placeOf(handle);
    if (place && (place.group.data.flags[place.row] & ROW_FLAG_DELETED) === 0) back++;
  }
  return back;
}

/** Runs the steps waiting, one task after another, until none is left */
function runSteps(): number {
  let tasks = 0;
  while (vi.getTimerCount() > 0 && tasks < 1000) {
    vi.advanceTimersToNextTimer();
    tasks++;
  }
  return tasks;
}

describe('draw.features.restore of many rows', () => {
  it('writes them over several tasks and tells it once, with the source of its transaction', () => {
    const { draw, store, tables, handles, notified, before } = setup();
    let returned: FeatureValues | null = null;
    draw.transact(
      () => {
        returned = draw.features.restore(before);
      },
      { source: 'history' },
    );
    // A part is written in the task of the call, nothing is told yet
    const first = rowsBack(tables, handles);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(COUNT);
    expect(notified).toHaveLength(0);
    expect(store.slicedWritePending).toBe(true);
    // What the rows had before, read once for all of them
    expect(returned && Array.from(rowValuesOf(returned).deleted ?? [])).toEqual(
      new Array(COUNT).fill(1),
    );
    expect(runSteps()).toBeGreaterThan(1);
    expect(rowsBack(tables, handles)).toBe(COUNT);
    expect(store.slicedWritePending).toBe(false);
    expect(notified).toHaveLength(1);
    const change = notified[0] as StoreChange;
    expect(change.source).toBe('history');
    expect(change.rows?.layers.get('rows')?.created.length).toBe(COUNT);
    expect(rowValuesOf(change.previousValues as FeatureValues).handles.length).toBe(COUNT);
  });

  it('writes few rows at once, as one notification', () => {
    const { draw, store, tables, handles, notified, before } = setup();
    const few = rowValuesOf(before);
    const values = createRowValues({
      handles: few.handles.slice(0, BULK_SLICE_ROWS),
      fields: new Map(),
      deleted: (few.deleted as Uint8Array).slice(0, BULK_SLICE_ROWS),
    });
    draw.features.restore(values);
    expect(rowsBack(tables, handles)).toBe(BULK_SLICE_ROWS);
    expect(notified).toHaveLength(1);
    expect(store.slicedWritePending).toBe(false);
  });

  it('reads the rows as the restore leaves them while it is under way', () => {
    const { draw, tables, handles, notified, before } = setup();
    draw.features.restore(before);
    expect(rowsBack(tables, handles)).toBeLessThan(COUNT);
    // The last row, read through the instance: the rest is written first, and told
    expect(draw.features.get(`p${COUNT - 1}`)?.properties).toEqual({ n: COUNT - 1 });
    expect(rowsBack(tables, handles)).toBe(COUNT);
    expect(notified).toHaveLength(1);
    expect(runSteps()).toBe(0);
  });

  it('reads the rows through the tables as the restore leaves them', () => {
    const { draw, tables, handles, notified, before } = setup();
    draw.features.restore(before);
    const read = tables.readValues({
      handles,
      fields: new Map<RowField, unknown[]>(),
      deleted: new Uint8Array(0),
    });
    expect(Array.from(read.deleted ?? []).every((flag) => flag === 0)).toBe(true);
    expect(notified).toHaveLength(1);
  });

  it('writes the rest first when another write comes, which is told after it', () => {
    const { draw, store, tables, handles, notified, before } = setup();
    draw.features.restore(before);
    expect(rowsBack(tables, handles)).toBeLessThan(COUNT);
    store.setMetadata({ title: 'after' });
    expect(rowsBack(tables, handles)).toBe(COUNT);
    expect(notified).toHaveLength(2);
    expect(notified[0]?.rows?.layers.get('rows')?.created.length).toBe(COUNT);
    expect(notified[1]?.metadata?.metadata).toEqual({ title: 'after' });
    expect(runSteps()).toBe(0);
  });

  it('writes the rest first when a write comes from elsewhere', () => {
    const { draw, store, tables, handles, notified, before } = setup();
    draw.features.restore(before);
    store.transact(() => store.setMetadata({ title: 'remote' }), 'remote');
    expect(rowsBack(tables, handles)).toBe(COUNT);
    expect(notified.map((change) => change.source)).toEqual(['local', 'remote']);
  });

  it('writes the rest of a restore first when another restore comes', () => {
    const { draw, tables, handles, notified, before } = setup();
    draw.features.restore(before);
    const first = rowValuesOf(before);
    // The first rows deleted again
    const again = createRowValues({
      handles: first.handles.slice(0, 10),
      fields: new Map(),
      deleted: new Uint8Array(10).fill(1),
    });
    draw.features.restore(again);
    expect(notified).toHaveLength(2);
    expect(notified[0]?.rows?.layers.get('rows')?.created.length).toBe(COUNT);
    expect(rowsBack(tables, handles)).toBe(COUNT - 10);
    expect(runSteps()).toBe(0);
  });

  it('tells the selection written meanwhile after the restore', () => {
    const { draw, tables, handles, notified, before } = setup();
    draw.features.restore(before);
    draw.selection.set('feature', ['p0']);
    expect(rowsBack(tables, handles)).toBe(COUNT);
    expect(notified[0]?.rows?.layers.get('rows')?.created.length).toBe(COUNT);
    expect(notified[notified.length - 1]?.selection?.ids).toEqual(['p0']);
  });

  it('deletes many rows in steps, kept by one token, and brings them back', () => {
    const { draw, store, tables, handles, notified, before } = setup();
    draw.features.restore(before);
    runSteps();
    notified.length = 0;
    // Deleted again, in steps
    draw.features.restore(
      createRowValues({ handles, fields: new Map(), deleted: new Uint8Array(COUNT).fill(1) }),
    );
    expect(store.slicedWritePending).toBe(true);
    runSteps();
    expect(rowsBack(tables, handles)).toBe(0);
    expect(notified).toHaveLength(1);
    const change = notified[0] as StoreChange;
    expect(change.restoreToken).toBeDefined();
    draw.features.restore(change.previousValues as FeatureValues);
    runSteps();
    expect(rowsBack(tables, handles)).toBe(COUNT);
  });

  it('deletes a group its rows left once the last of them is written', () => {
    const { draw, store, tables, handles, notified, before } = setup();
    draw.features.restore(before);
    runSteps();
    store.createGroup({
      id: 'g',
      name: 'g',
      layerId: 'rows',
      featureIds: Array.from({ length: COUNT }, (_, i) => `p${i}`),
      visible: true,
      locked: false,
    } as never);
    notified.length = 0;
    draw.features.restore(
      createRowValues({ handles, fields: new Map(), deleted: new Uint8Array(COUNT).fill(1) }),
    );
    // Between two steps, the group is there
    vi.advanceTimersToNextTimer();
    expect(store.slicedWritePending).toBe(true);
    expect(store.getGroup('g')).toBeDefined();
    runSteps();
    expect(store.getGroup('g')).toBeUndefined();
    expect(notified).toHaveLength(1);
    expect(notified[0]?.groups?.deleted?.map((group) => group.id)).toEqual(['g']);
    expect(rowsBack(tables, handles)).toBe(0);
  });

  it('writes the rest first when the selection is written in the same transaction', () => {
    let selected: SelectionTarget | null = null;
    const { draw, tables, handles, notified, before } = setup({
      selectionIdsLimit: 10,
      prepare: (instance) => {
        instance.selection.setAll();
        selected = instance.selection.target;
      },
    });
    expect((selected as SelectionTarget | null)?.count).toBe(COUNT);
    // The features selected in bulk put back after the rows, as an undo does
    draw.transact(() => {
      draw.features.restore(before);
      draw.selection.set(selected as SelectionTarget);
    });
    expect(rowsBack(tables, handles)).toBe(COUNT);
    expect(notified).toHaveLength(1);
    expect(draw.selection.value.count).toBe(COUNT);
  });

  it('tells the changes of the order a write of every row at once tells', () => {
    const steps = setup();
    steps.draw.features.restore(steps.before);
    runSteps();
    draw?.destroy();
    draw = undefined;
    const once = setup();
    once.store.applyRows({
      patch: rowValuesOf(once.before),
      before: once.tables.readValues(rowValuesOf(once.before)),
    });
    expect(steps.notified).toHaveLength(1);
    expect(once.notified).toHaveLength(1);
    expect(steps.notified[0]?.order ?? []).toEqual(once.notified[0]?.order ?? []);
    expect(steps.notified[0]?.rows?.layers.get('rows')?.created.length).toBe(COUNT);
  });

  it('reads the rows as the restore leaves them through a view held from before', () => {
    const reads: Array<(view: LayerTableView) => unknown> = [
      (view) => view.rowCount,
      (view) => view.itemCount,
      (view) => view.getRow(view.listRowHandles(COUNT - 1, 1)[0] as number)?.id,
      (view) => view.listItems(0, COUNT).handles.length,
      (view) => view.listRowHandles(0, COUNT).length,
    ];
    const expected: unknown[] = [COUNT, COUNT, `p${COUNT - 1}`, COUNT, COUNT];
    reads.forEach((read, k) => {
      draw?.destroy();
      draw = undefined;
      const { draw: instance, tables, notified, before } = setup();
      const view = tables.get('rows') as LayerTableView;
      instance.features.restore(before);
      expect(notified).toHaveLength(0);
      expect(read(view)).toEqual(expected[k]);
      expect(notified).toHaveLength(1);
    });
  });

  it('reads the rows as the restore leaves them through a scan started before', () => {
    const { draw, tables, notified, before } = setup();
    const cursor = tables.scan({ layerIds: ['rows'] });
    draw.features.restore(before);
    let count = 0;
    for (let batch = cursor.next(); batch; batch = cursor.next()) count += batch.length;
    expect(count).toBe(COUNT);
    expect(notified).toHaveLength(1);
  });
});
