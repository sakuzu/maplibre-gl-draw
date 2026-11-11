// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The write marks of the rows (`write-marks.ts`)
 *
 * - The mark of a Store of rows goes up once in a frame of writes that writes values, however
 *   many writes it makes, rows opened as features among them: an outermost transaction, each step
 *   of a restore written in steps, each step of a write of rows selected in bulk in steps, a call
 *   of the writer of the tables outside a transaction
 * - A frame that writes no value (the selection, the hiding on this client, nothing) leaves it
 * - The tables refuse a mark below the one before
 * - The rows written and their row groups get the mark of their frame; a row placed elsewhere
 *   gets it in the delta, and so do the delta and the group the row left
 * - The next versions take the rows of the deltas as before: a row of the delta written while a
 *   version waits, under its mark or a later one, stays in the delta, and so does a row held when
 *   the version started; the rows of a version keep the marks they had
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureTables, RowField } from '../api/tables.js';
import { BULK_SLICE_ROWS, writeKindsInSlices } from '../operations/bulk-sliced.js';
import { type BulkKinds, transformKinds } from '../operations/bulk-transform.js';
import type { DrawStore } from '../store/draw-store.js';
import type { TransformEdit } from '../store/store.js';
import { createTableStore } from '../store/table-memory.js';
import type { Feature } from '../store/types.js';
import { writeMarkKeeperOf } from '../store/write-mark-keeper.js';
import { KasaneError } from '../table/kasane-error.js';
import {
  expectTablesMatch,
  referenceKey as key,
  type ReferenceRow,
  ReferenceRows,
  rowPatch,
  tablesOfReference,
} from '../test-utils.js';
import { type FeatureTablesInternals, featureTablesInternals } from './feature-tables.js';
import { TableSelection } from './selection.js';
import type { TableWorkBudget } from './types.js';
import type { GroupVersion, GroupVersionReceiver } from './versions.js';

/** A move of one degree to the east along the equator: one degree of longitude at any latitude */
const EAST_ONE_DEGREE: TransformEdit = { kind: 'translate', from: [0, 0], to: [1, 0] };

function point(i: number, layerId = 'a'): Feature {
  return {
    id: `p${i}`,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [i * 0.001, 1] },
    layerId,
    groupId: undefined,
    properties: { n: i },
    style: {},
    visible: true,
    locked: false,
  };
}

/** A Store of rows with points in a layer `a` (and an empty layer `b`) */
function storeWith(count: number, selectionIdsLimit?: number) {
  const { store, writer } = createTableStore(
    selectionIdsLimit === undefined ? {} : { selectionIdsLimit },
  );
  for (const id of ['a', 'b']) {
    store.createLayer({
      id,
      name: id,
      visible: true,
      locked: false,
      opacity: 1,
      kind: 'table',
      styleRule: undefined,
      metadata: undefined,
    });
  }
  store.createFeatures(Array.from({ length: count }, (_, i) => point(i)));
  const tables = store.tables as FeatureTables;
  const internals = featureTablesInternals(tables) as FeatureTablesInternals;
  internals.addQueuedRowBlocks();
  internals.flushVersions();
  const keeper = writeMarkKeeperOf(tables);
  if (!keeper) throw new Error('no keeper of the write marks');
  const given: number[] = [];
  const setWriteMark = internals.setWriteMark.bind(internals);
  vi.spyOn(internals, 'setWriteMark').mockImplementation((mark) => {
    given.push(mark);
    setWriteMark(mark);
  });
  /** The marks of the row of an id and of its group, where it is read */
  const marksOf = (id: string): [number, number] | undefined => {
    const handle = internals.ids.handleOf(id);
    const place = handle < 0 ? undefined : internals.placeOf(handle);
    return place ? [place.group.marks[place.row], place.group.mark] : undefined;
  };
  return { store: store as DrawStore, writer, tables, internals, keeper, given, marksOf };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the write mark of a Store of rows', () => {
  it('goes up once in a transaction that writes many times', () => {
    const { store, keeper, given, marksOf } = storeWith(8);
    const before = keeper.mark;
    store.transact(() => {
      store.updateFeature('p1', { properties: { n: 10 } });
      store.updateFeature('p2', { properties: { n: 20 } });
      store.updateFeature('p1', { properties: { n: 11 } });
      store.createFeature(point(100));
      store.deleteFeature('p3');
    });
    expect(given).toEqual([before + 1]);
    expect(keeper.mark).toBe(before + 1);
    for (const id of ['p1', 'p2', 'p3']) expect(marksOf(id)).toEqual([before + 1, before + 1]);
    // A row not written keeps its mark
    expect(marksOf('p5')?.[0]).toBeLessThan(before + 1);
  });

  it('goes up once when rows selected are written with the others', () => {
    const { store, keeper, given } = storeWith(8);
    store.setSelection('feature', ['p1', 'p2']);
    const before = keeper.mark;
    store.transact(() => {
      store.updateFeature('p1', { properties: { n: 10 } });
      store.updateFeature('p4', { properties: { n: 40 } });
      store.updateFeature('p2', { properties: { n: 20 } });
    });
    expect(given).toEqual([before + 1]);
    expect(store.getFeature('p2')?.properties).toEqual({ n: 20 });
  });

  it('goes up once in each step of a restore written in steps', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Each look at the clock is 13 ms later: a step writes one run of rows
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      clock += 13;
      return clock;
    });
    const count = BULK_SLICE_ROWS * 3;
    const { store, tables, keeper, given, marksOf } = storeWith(count);
    const before = keeper.mark;
    const handles = Int32Array.from({ length: count }, (_, i) => tables.findRow(`p${i}`) as number);
    const values = Array.from({ length: count }, (_, i) => i + 1000);
    store.restoreRows({
      handles,
      fields: new Map<RowField, unknown[]>([['properties:n', values]]),
    });
    expect(given).toEqual([before + 1]);
    vi.runAllTimers();
    // A step per run of rows, the last one writing nothing (the end)
    expect(given).toEqual([before + 1, before + 2, before + 3]);
    for (let i = 0; i < count; i++) {
      const mark = before + 1 + Math.floor(i / BULK_SLICE_ROWS);
      expect(marksOf(`p${i}`)?.[0]).toBe(mark);
    }
    expect(store.getFeature(`p${count - 1}`)?.properties).toEqual({ n: count - 1 + 1000 });
  });

  it('goes up once in each step of a write of rows selected in bulk in steps', () => {
    const count = BULK_SLICE_ROWS * 2 + 10;
    const { store, tables, keeper, given, marksOf } = storeWith(count, 3);
    const handles = Array.from({ length: count }, (_, i) => tables.findRow(`p${i}`) as number);
    store.selectRows(TableSelection.of(handles));
    const rows = store.getSelectedRows() as TableSelection;
    const steps: Array<() => void> = [];
    const before = keeper.mark;
    writeKindsInSlices(store, rows, transformKinds(store, EAST_ONE_DEGREE, rows) as BulkKinds, {
      onDone: () => {},
      budgetMs: 0,
      schedule: (step) => steps.push(step),
    });
    expect(given).toEqual([before + 1]);
    while (steps.length > 0) steps.shift()?.();
    expect(given).toEqual([before + 1, before + 2, before + 3]);
    expect(marksOf('p0')?.[0]).toBe(before + 1);
    expect(marksOf(`p${BULK_SLICE_ROWS}`)?.[0]).toBe(before + 2);
    expect(marksOf(`p${count - 1}`)?.[0]).toBe(before + 3);
  });

  it('makes a frame of each call of its writer outside a transaction', () => {
    const { store, writer, tables, keeper, given } = storeWith(8);
    const before = keeper.mark;
    const handle = tables.findRow('p1') as number;
    writer.apply(rowPatch([handle], { 'properties:n': [10] }));
    writer.apply(rowPatch([handle], { 'properties:n': [11] }));
    const other = tables.findRow('p2') as number;
    writer.apply(rowPatch([other], { 'properties:n': [20] }));
    expect(given).toEqual([before + 1, before + 2, before + 3]);
    // Inside a transaction, the calls are part of its frame
    store.transact(() => {
      writer.apply(rowPatch([handle], { 'properties:n': [12] }));
      writer.apply(rowPatch([other], { 'properties:n': [21] }));
    });
    expect(given).toEqual([before + 1, before + 2, before + 3, before + 4]);
  });

  it('stays for a frame that writes no value', () => {
    const { store, keeper, given } = storeWith(8);
    const before = keeper.mark;
    store.setSelection('feature', ['p1']);
    store.setLocallyHidden('p2', true);
    store.transact(() => {
      store.setSelection('feature', ['p3']);
      store.setLocallyHidden('p2', false);
    });
    store.transact(() => {});
    expect(given).toEqual([]);
    expect(keeper.mark).toBe(before);
  });
});

describe('the write mark of the tables', () => {
  it('refuses a mark below the one before', () => {
    const { internals, keeper } = storeWith(2);
    expect(() => internals.setWriteMark(keeper.mark)).not.toThrow();
    let thrown: unknown;
    try {
      internals.setWriteMark(keeper.mark - 1);
    } catch (error) {
      thrown = error;
    }
    // The internals are of the tables: their error is wrapped by the entries of core
    expect(thrown).toBeInstanceOf(KasaneError);
    expect((thrown as KasaneError).code).toBe('invalid-state');
    expect(internals.writeMarks.mark).toBe(keeper.mark);
    expect(() => internals.setWriteMark(0.5 + keeper.mark)).toThrow(KasaneError);
  });

  it('is stamped on a row placed elsewhere in the delta, on the delta, and on the group it left', () => {
    const reference = pointsReference(32);
    const { tables, writer, internals } = tablesOfReference(reference, ['a'], 8);
    const at = (id: string) => tables.findRow(id) as number;
    const left = internals.placeOf(at('p3'))?.group;
    const other = internals.placeOf(at('p20'))?.group;
    internals.setWriteMark(5);
    writer.apply(rowPatch([at('p3')], { key: [key(9500)] }));
    const delta = internals.layerTable('a')?.delta;
    const place = internals.placeOf(at('p3'));
    expect(place?.group).toBe(delta?.group);
    expect(place?.group.marks[place.row]).toBe(5);
    expect(delta?.group?.mark).toBe(5);
    expect(left?.mark).toBe(5);
    expect(other?.mark).toBe(0);
    // Written in place: the row and its group
    internals.setWriteMark(6);
    writer.apply(rowPatch([at('p21')], { hidden: [true] }));
    const hidden = internals.placeOf(at('p21'));
    expect(hidden?.group.marks[hidden.row]).toBe(6);
    expect(hidden?.group.mark).toBe(6);
    // The row of the delta that stays keeps its mark when the delta is made again
    internals.setWriteMark(7);
    writer.apply(rowPatch([at('p12')], { key: [key(10_500)] }));
    const kept = internals.placeOf(at('p3'));
    expect(kept?.group.marks[kept.row]).toBe(5);
    expect(kept?.group.mark).toBe(7);
  });
});

/** A budget of `n` steps */
function steps(n: number): TableWorkBudget {
  let left = n;
  return {
    canStep: () => left > 0,
    step: (work) => {
      left--;
      return work(Number.POSITIVE_INFINITY);
    },
  };
}

/** A side that draws the rows, whose GPU side is up once the test says */
function gate(internals: FeatureTablesInternals) {
  let all = false;
  const receiver: GroupVersionReceiver = {
    uploaded: () => all,
    swapped: () => {},
    dropped: () => {},
  };
  internals.attachReceiver(receiver);
  return {
    allowAll(): void {
      all = true;
    },
  };
}

/** Points in a row, one per key */
function pointsReference(count: number): ReferenceRows {
  const reference = new ReferenceRows();
  for (let i = 0; i < count; i++) {
    reference.rows.set(`p${i}`, {
      id: `p${i}`,
      layerId: 'a',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i, 0] },
      order: key(i * 1000),
      groupId: undefined,
      member: '',
      style: {},
      properties: {},
      visible: true,
      locked: false,
      deleted: false,
    });
  }
  return reference;
}

/**
 * The tables of points with rows in the delta, and a next version built and waiting (`before`
 * runs before it starts)
 */
function waitingVersion(mark: number, before?: (internals: FeatureTablesInternals) => void) {
  const reference = pointsReference(32);
  const setup = tablesOfReference(reference, ['a'], 8);
  const { tables, writer, internals } = setup;
  const sides = gate(internals);
  const at = (id: string) => tables.findRow(id) as number;
  const write = (id: string, order: number): void => {
    writer.apply(rowPatch([at(id)], { key: [key(order)] }));
    (reference.rows.get(id) as ReferenceRow).order = key(order);
  };
  internals.setWriteMark(mark);
  write('p3', 9500);
  write('p11', 9700);
  before?.(internals);
  for (let i = 0; i < 4; i++) internals.advanceVersions(steps(10));
  const versions: GroupVersion[] = internals.builtVersions('a');
  expect(versions.length).toBeGreaterThan(0);
  return { ...setup, reference, sides, at, write };
}

describe('the next versions with the write marks', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('leave a row of the delta written while they wait, under their mark or a later one', () => {
    for (const later of [false, true]) {
      const { tables, internals, reference, sides, write, groupHandleOf } = waitingVersion(3);
      // Under the mark the version started under (another write of the same frame), or a later
      if (later) internals.setWriteMark(4);
      write('p3', 9600);
      sides.allowAll();
      internals.swapVersions();
      // p11, not written since, left the delta; p3 stays
      expect(internals.deltaRowCount()).toBe(1);
      expect(internals.placeOf(tables.findRow('p3') as number)?.group.delta).toBe(true);
      expectTablesMatch(tables, reference, ['a'], groupHandleOf);
      internals.flushVersions();
      expect(internals.deltaRowCount()).toBe(0);
      expectTablesMatch(tables, reference, ['a'], groupHandleOf);
    }
  });

  it('give the rows of a version the marks they had', () => {
    const reference = pointsReference(32);
    const { tables, writer, internals } = tablesOfReference(reference, ['a'], 8);
    const at = (id: string) => tables.findRow(id) as number;
    internals.setWriteMark(1);
    writer.apply(rowPatch([at('p9')], { 'properties:name': ['kept'] }));
    internals.setWriteMark(2);
    writer.apply(rowPatch([at('p3')], { key: [key(9500)] }));
    internals.flushVersions();
    expect(internals.deltaRowCount()).toBe(0);
    const marksOf = (id: string): number | undefined => {
      const place = internals.placeOf(at(id));
      return place?.group.marks[place.row];
    };
    expect(marksOf('p9')).toBe(1);
    expect(marksOf('p3')).toBe(2);
    expect(marksOf('p10')).toBe(0);
    expect(internals.placeOf(at('p3'))?.group.mark).toBe(2);
  });

  it('go in with the mark of when they are swapped in, past the rows written while they wait', () => {
    const { tables, writer, internals, sides } = waitingVersion(3);
    const [version] = internals.builtVersions('a');
    const handle = (version.groups ?? [])[0].data.handles[0];
    // A row of the version written in place under a later mark while it waits
    internals.setWriteMark(4);
    writer.apply(rowPatch([handle], { 'properties:name': ['later'] }));
    sides.allowAll();
    internals.swapVersions();
    const place = internals.placeOf(handle);
    expect(place?.group).toBe((version.groups ?? [])[0]);
    expect(place?.group.marks[place.row]).toBe(4);
    expect(place?.group.mark).toBe(4);
    expect(tables.get('a')?.getRowValue(handle, 'name')).toBe('later');
  });
});
