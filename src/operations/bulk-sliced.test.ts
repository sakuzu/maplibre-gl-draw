// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The write of a drag of many features selected in bulk once let go, made in steps: one
 * transaction per step, each row told in the task it is written in, the end told once after the
 * last rows; another write of this client finishes the rest before it is made, a write from
 * elsewhere does not, and the rows it changed, deleted or locked between two steps are written
 * from their values then, left out, or left as they are.
 */

import { describe, expect, it } from 'vitest';
import type { FeatureTables } from '../api/tables.js';
import { TableSelection } from '../feature-table/selection.js';
import { DrawStore } from '../store/draw-store.js';
import type { TransformEdit } from '../store/store.js';
import { TableContractStore } from '../store/table-memory.js';
import type { Feature, StoreChange } from '../store/types.js';
import { BULK_SLICE_ROWS, writeKindsInSlices } from './bulk-sliced.js';
import { type BulkKinds, transformKinds } from './bulk-transform.js';

/** A move of one degree to the east along the equator: one degree of longitude at any latitude */
const EAST_ONE_DEGREE: TransformEdit = { kind: 'translate', from: [0, 0], to: [1, 0] };

const COUNT = BULK_SLICE_ROWS * 2 + 100;

function point(i: number): Feature {
  return {
    id: `f${i}`,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [i * 0.001, 1] },
    layerId: 'l',
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked: false,
  };
}

function setup() {
  const contract = new TableContractStore();
  const store = new DrawStore(contract, { selectionIdsLimit: 3 });
  store.createLayer({
    id: 'l',
    name: 'l',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  });
  store.transact(() => {
    for (let i = 0; i < COUNT; i++) store.createFeature(point(i));
  });
  const tables = store.tables as FeatureTables;
  const handles = Array.from({ length: COUNT }, (_, i) => tables.getRowRef(`f${i}`) as number);
  store.selectRows(TableSelection.of(handles));
  const rows = store.getSelectedRows() as TableSelection;
  const changes: StoreChange[] = [];
  store.subscribe((change) => changes.push(change));
  const steps: Array<() => void> = [];
  const written: number[][] = [];
  const done: boolean[] = [];
  /** Writes a move of every row one degree to the east in steps of one slice each */
  const start = (): boolean =>
    writeKindsInSlices(store, rows, transformKinds(store, EAST_ONE_DEGREE, rows) as BulkKinds, {
      onWritten: (list) => written.push([...list]),
      onDone: (wrote) => done.push(wrote),
      budgetMs: 0,
      schedule: (step) => steps.push(step),
    });
  const x = (i: number): number | undefined =>
    (store.getFeature(`f${i}`)?.geometry as { coordinates: number[] } | undefined)?.coordinates[0];
  return { contract, store, tables, rows, changes, steps, written, done, start, x };
}

describe('the write in steps of a drag of features selected in bulk', () => {
  it('writes a slice of rows per step, each in its own change, and tells the end once', () => {
    const { store, changes, steps, written, done, start, x } = setup();
    const bounds = store.getSelection().bulk?.bbox;
    expect(start()).toBe(true);
    // The first step is made at once, the next ones in later tasks
    expect(x(0)).toBeCloseTo(1, 9);
    expect(x(COUNT - 1)).toBeCloseTo((COUNT - 1) * 0.001, 9);
    expect(written.map((list) => list.length)).toEqual([BULK_SLICE_ROWS]);
    expect(changes).toHaveLength(1);
    expect(store.slicedWritePending).toBe(true);
    // The extent of the selection is kept while the rows are written (they are drawn by it)
    expect(store.getSelection().bulk?.bbox).toEqual(bounds);
    expect(done).toEqual([]);
    steps.shift()?.();
    steps.shift()?.();
    expect(steps).toHaveLength(0);
    expect(written.map((list) => list.length)).toEqual([BULK_SLICE_ROWS, BULK_SLICE_ROWS, 100]);
    expect(changes).toHaveLength(3);
    expect(done).toEqual([true]);
    expect(store.slicedWritePending).toBe(false);
    for (const i of [0, BULK_SLICE_ROWS, COUNT - 1]) expect(x(i)).toBeCloseTo(i * 0.001 + 1, 9);
    expect(store.getSelection().bulk?.bbox?.[0]).toBeCloseTo(1, 9);
  });

  it('is finished at once by another write of this client, before that write', () => {
    const { store, changes, steps, done, start, x } = setup();
    start();
    store.createFeature({ ...point(COUNT), id: 'other' });
    expect(done).toEqual([true]);
    expect(x(COUNT - 1)).toBeCloseTo((COUNT - 1) * 0.001 + 1, 9);
    // The rest of the rows in one change, then the feature created
    expect(changes).toHaveLength(3);
    expect(changes[1].rows).toBeDefined();
    expect(changes[2].rows?.layers.get('l')?.created.length ?? 0).toBe(1);
    // The steps left do nothing
    for (const step of steps.splice(0)) step();
    expect(done).toEqual([true]);
    expect(changes).toHaveLength(3);
  });

  it('writes from their values then the rows changed from elsewhere between two steps', () => {
    const { contract, store, steps, written, done, start, x } = setup();
    start();
    const last = COUNT - 1;
    const moved = COUNT - 2;
    const locked = COUNT - 3;
    contract.transact(() => {
      contract.deleteFeature(`f${last}`);
      contract.updateFeature(`f${moved}`, {
        geometry: { type: 'Point', coordinates: [50, 1] },
      });
      contract.updateFeature(`f${locked}`, { locked: true });
    }, 'remote');
    // A write from elsewhere does not finish the rest
    expect(store.slicedWritePending).toBe(true);
    while (steps.length > 0) steps.shift()?.();
    expect(done).toEqual([true]);
    expect(store.getFeature(`f${last}`)).toBeUndefined();
    expect(x(moved)).toBeCloseTo(51, 9);
    expect(x(locked)).toBeCloseTo(locked * 0.001, 9);
    // Every row was told, those left out too (they leave the moving set)
    expect(written.flat()).toHaveLength(COUNT);
  });

  it('leaves a row locked when it starts as it is, and writes the others', () => {
    const { store, steps, written, done, start, x } = setup();
    store.updateFeature('f5', { locked: true });
    expect(start()).toBe(true);
    while (steps.length > 0) steps.shift()?.();
    expect(done).toEqual([true]);
    expect(x(5)).toBeCloseTo(0.005, 9);
    expect(x(6)).toBeCloseTo(1.006, 9);
    expect(written.flat()).toHaveLength(COUNT);
    expect(store.slicedWritePending).toBe(false);
  });

  it('is refused at once without rows', () => {
    const { store, done, steps } = setup();
    expect(
      writeKindsInSlices(store, TableSelection.empty, [], {
        onDone: (wrote) => done.push(wrote),
        schedule: (step) => steps.push(step),
      }),
    ).toBe(false);
    expect(done).toEqual([false]);
    expect(store.slicedWritePending).toBe(false);
  });
});
