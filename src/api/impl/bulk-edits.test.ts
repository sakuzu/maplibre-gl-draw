// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The bulk edits of an instance, run with an edit of the tests (it appends a tag to an attribute
 * of each feature): the parts and their changes, the order of the edits, the writes of a few
 * features meanwhile, the counts, read-only, destroy, `draw.transact` and `waitForWrites`
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { Store, StoreChange } from '../../store/built-in/types.js';
import type { InstanceDocument } from '../../store/document-access.js';
import { createMapStub, createParityMap, readRowFeature } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { DocumentChange } from '../events.js';
import type { EditCounts } from '../features.js';
import { createIdSet } from '../model.js';
import { BULK_PART_BUDGET_MS, type BulkEdits, bulkEditsOf } from './bulk-edits.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';
import { toEngineOptions } from './options.js';

/** The time an edit of the tests takes per feature (ms, on the clock of the tests) */
const ROW_TIME = 10;
/** The features one part writes at that time */
const PART_ROWS = BULK_PART_BUDGET_MS / ROW_TIME;

let clock = 0;
let store: Store;
let draw: Draw;
let edits: BulkEdits;
/** The layer over the Store of the instance, as the operations of its modes write it */
let layer: InstanceDocument;

beforeEach(() => {
  // The tasks are those of the fake timers; the clock of the budget is the one of the tests
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  store = createStore();
  // Built as createDraw builds it, with the engine kept for its layer
  const engine = createEngine(
    createMapStub().map as unknown as Parameters<typeof createEngine>[0],
    toEngineOptions({ store }, () => false),
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store });
  engine.enterDefaultMode();
  layer = engine.context.store;
  edits = bulkEditsOf(draw) as BulkEdits;
});

afterEach(() => {
  draw.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** An edit of the tests: appends `<tag>;` to the attribute `log`, taking `time` per feature */
function tag(name: string, time = ROW_TIME, target: Draw = draw) {
  return {
    writeFeature(id: string): boolean {
      clock += time;
      const feature = target.features.get(id);
      const log = (feature?.properties.log as string | undefined) ?? '';
      return target.features.update(id, { properties: { log: `${log}${name};` } }) !== null;
    },
  };
}

/** An edit of the tests that moves each point by `dx` degrees to the east */
function shift(dx: number, target: Draw = draw) {
  return {
    writeFeature(id: string): boolean {
      clock += ROW_TIME;
      const [x, y] = xyOf(id, target);
      const geometry = { type: 'Point' as const, coordinates: [x + dx, y] };
      return target.features.update(id, { geometry }) !== null;
    },
  };
}

/** An edit of the tests that moves each feature, of any shape, by `dx` degrees to the east */
function shiftShape(dx: number) {
  const moved = (value: unknown): unknown => {
    const list = value as unknown[];
    return typeof list[0] === 'number'
      ? [(list[0] as number) + dx, ...list.slice(1)]
      : list.map(moved);
  };
  return {
    writeFeature(id: string): boolean {
      clock += ROW_TIME;
      const geometry = draw.features.get(id)?.geometry as { coordinates: unknown } | undefined;
      if (!geometry) return false;
      const next = { ...geometry, coordinates: moved(geometry.coordinates) } as never;
      return draw.features.update(id, { geometry: next }) !== null;
    },
  };
}

/** The west and east ends of the positions of a geometry */
function westEastOf(geometry: unknown): [number, number] {
  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  const visit = (value: unknown): void => {
    const list = value as unknown[];
    if (typeof list[0] === 'number') {
      west = Math.min(west, list[0] as number);
      east = Math.max(east, list[0] as number);
    } else {
      for (const item of list) visit(item);
    }
  };
  visit((geometry as { coordinates: unknown }).coordinates);
  return [west, east];
}

/** Creates a square area and returns its ID */
function square(west: number, south: number, size: number): string {
  const ring = [
    [west, south],
    [west + size, south],
    [west + size, south + size],
    [west, south + size],
    [west, south],
  ];
  const feature = draw.features.create({
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [ring] },
  });
  if (!feature) throw new Error('not created');
  return feature.id;
}

/** The position of a point */
const xyOf = (id: string, target: Draw = draw): [number, number] => {
  const geometry = target.features.get(id)?.geometry;
  if (geometry?.type !== 'Point') throw new Error(`${id} is not a point`);
  return [geometry.coordinates[0], geometry.coordinates[1]];
};

/** The log of a feature */
const logOf = (id: string): string =>
  (draw.features.get(id)?.properties.log as string | undefined) ?? '';

/** Creates points and returns their IDs */
function points(count: number, layerId?: string): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const feature = draw.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i * 0.01, 0] },
      ...(layerId !== undefined && { layerId }),
    });
    if (!feature) throw new Error('not created');
    ids.push(feature.id);
  }
  return ids;
}

/** The changes `document.changed` gives from now on */
function documentChanges(): DocumentChange[] {
  const out: DocumentChange[] = [];
  draw.on('document.changed', (change) => out.push(change));
  return out;
}

/** The changes the Store tells its subscribers from now on */
function storeChanges(): StoreChange[] {
  const out: StoreChange[] = [];
  store.subscribe((change) => out.push(change));
  return out;
}

/** The number, the more parts and the stop of each change of an operation */
const partsOf = (changes: readonly (DocumentChange | StoreChange)[], operationId: number) =>
  changes
    .filter((change) => change.operationId === operationId)
    .map((change) => [change.hasMoreParts, change.stopped]);

/** Runs the task waiting now, and the promises it settles */
const nextTask = () => vi.runOnlyPendingTimersAsync();

/** Runs every task until none is left */
const allTasks = () => vi.runAllTimersAsync();

/** Records what a promise settles with */
function settled<T>(promise: Promise<T>): { value?: T; error?: unknown; done: boolean } {
  const out: { value?: T; error?: unknown; done: boolean } = { done: false };
  promise.then(
    (value) => {
      out.value = value;
      out.done = true;
    },
    (error: unknown) => {
      out.error = error;
      out.done = true;
    },
  );
  return out;
}

/** The code of a DrawError (undefined for anything else) */
function codeOf(error: unknown): string | undefined {
  return error instanceof DrawError ? error.code : undefined;
}

describe('the parts of a bulk edit', () => {
  it('writes each part in a task of its own, with one number, and tells each part', async () => {
    const ids = points(12);
    const changes = documentChanges();
    const told = storeChanges();
    const run = settled(edits.start(ids, undefined, tag('A')));
    // Nothing is written in the task that starts it
    expect(logOf(ids[0])).toBe('');
    await nextTask();
    expect(ids.map(logOf).filter((log) => log === 'A;')).toHaveLength(PART_ROWS);
    expect(run.done).toBe(false);
    await allTasks();
    expect(ids.every((id) => logOf(id) === 'A;')).toBe(true);
    const counts = run.value as EditCounts;
    expect(counts).toEqual({
      operationId: expect.any(Number),
      changedCount: 12,
      lockedCount: 0,
      missingCount: 0,
      stopped: false,
    });
    // Every change but the last has hasMoreParts, for the Store and for the instance alike
    const expected = [
      [true, false],
      [true, false],
      [false, false],
    ];
    expect(partsOf(told, counts.operationId)).toEqual(expected);
    expect(partsOf(changes, counts.operationId)).toEqual(expected);
    expect(changes.map((change) => change.features.updated.count())).toEqual([5, 5, 2]);
  });

  it('tells a last part that writes nothing, once a part of the edit was told', async () => {
    const ids = points(6);
    const changes = documentChanges();
    const run = settled(edits.start(ids, undefined, tag('A')));
    await nextTask();
    // The last feature is deleted from elsewhere before the edit reaches it: its last part
    // writes nothing (a delete of this client would apply the edit to it first)
    const ref = store.tables.getRowRef(ids[5]) as number;
    store.writeRows({ rows: Int32Array.of(ref), fields: new Map(), deleted: Uint8Array.of(1) });
    await allTasks();
    const counts = run.value as EditCounts;
    expect(counts.changedCount).toBe(PART_ROWS);
    // A deleted feature is not counted as missing
    expect(counts.missingCount).toBe(0);
    const own = changes.filter((change) => change.operationId === counts.operationId);
    expect(own.map((change) => [change.hasMoreParts, change.features.updated.count()])).toEqual([
      [true, 5],
      [false, 0],
    ]);
  });

  it('resolves an edit of no feature with its counts, and tells no change of it', async () => {
    points(2);
    const changes = documentChanges();
    const run = settled(edits.start(['gone', 'none'], undefined, tag('A')));
    await allTasks();
    expect(run.value).toEqual(
      expect.objectContaining({ changedCount: 0, missingCount: 2, stopped: false }),
    );
    expect(changes).toHaveLength(0);
  });

  it('cuts a part at the budget, and makes the next part from the time a feature took', async () => {
    const ids = points(40);
    const changes = documentChanges();
    // The listeners take time as well: 15 ms per change on top of 5 ms per feature
    draw.on('document.changed', () => {
      clock += 15;
    });
    const run = settled(edits.start(ids, undefined, tag('A', 5)));
    await allTasks();
    const counts = run.value as EditCounts;
    const sizes = changes
      .filter((change) => change.operationId === counts.operationId)
      .map((change) => change.features.updated.count());
    // The first part stops at the budget of its writes (10 features of 5 ms); with the 15 ms of
    // the listeners a feature took 6.5 ms, so the next parts take 7
    expect(sizes[0]).toBe(10);
    expect(sizes.slice(1, -1).every((size) => size === 7)).toBe(true);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(40);
  });

  it('writes one feature in a part when one feature takes longer than the budget', async () => {
    const ids = points(3);
    const changes = documentChanges();
    const run = settled(edits.start(ids, undefined, tag('A', BULK_PART_BUDGET_MS * 2)));
    await allTasks();
    const counts = run.value as EditCounts;
    expect(
      changes
        .filter((change) => change.operationId === counts.operationId)
        .map((change) => change.features.updated.count()),
    ).toEqual([1, 1, 1]);
  });
});

describe('the order of the edits', () => {
  it('writes a second edit only once the last change of the first has arrived', async () => {
    const ids = points(12);
    const changes = documentChanges();
    const first = settled(edits.start(ids, undefined, tag('A')));
    const second = settled(edits.start(ids, undefined, tag('B')));
    await allTasks();
    const a = (first.value as EditCounts).operationId;
    const b = (second.value as EditCounts).operationId;
    expect(changes.map((change) => change.operationId)).toEqual([a, a, a, b, b, b]);
    expect(ids.every((id) => logOf(id) === 'A;B;')).toBe(true);
  });

  it('applies the edit being written first to a feature a write touches, and to it only', async () => {
    const ids = points(12);
    const changes = documentChanges();
    const run = settled(edits.start(ids, undefined, tag('A')));
    await nextTask();
    // The edit has not reached the last two features: a write of the last applies it there first
    expect(draw.features.update(ids[11], { geometry: { type: 'Point', coordinates: [5, 5] } })).not
      .toBeNull;
    expect(logOf(ids[11])).toBe('A;');
    expect(logOf(ids[10])).toBe('');
    // Outside a transaction, as a part of the edit, with its number; then the change of the write
    const operationId = (changes[0] as DocumentChange).operationId;
    const [early, written] = changes.slice(-2);
    expect([early.operationId, early.hasMoreParts]).toEqual([operationId, true]);
    expect([...early.features.updated.iterate()]).toEqual([ids[11]]);
    expect(written.operationId).not.toBe(operationId);
    expect([...written.features.updated.iterate()]).toEqual([ids[11]]);
    await allTasks();
    // The later parts leave it out: the edit is applied to it once
    expect(logOf(ids[11])).toBe('A;');
    expect(draw.features.get(ids[11])?.geometry).toEqual({ type: 'Point', coordinates: [5, 5] });
    expect(ids.every((id) => logOf(id) === 'A;')).toBe(true);
    expect((run.value as EditCounts).changedCount).toBe(12);
  });

  it('applies it before a write reads the feature, so a write of the same field keeps it', async () => {
    const ids = points(12);
    const told = storeChanges();
    const run = settled(edits.start(ids, undefined, tag('A')));
    await nextTask();
    const { operationId } = told[0];
    // update reads the attributes of the feature and writes them with its own
    expect(draw.features.update(ids[11], { properties: { x: 1 } })).not.toBeNull();
    expect(draw.features.get(ids[11])?.properties).toEqual({ log: 'A;', x: 1 });
    // What was applied first is a transaction of its own, a part of the edit, with its number
    const [early, written] = told.slice(-2);
    expect([early.operationId, early.hasMoreParts]).toEqual([operationId, true]);
    expect(written.operationId).not.toBe(operationId);
    await allTasks();
    expect(draw.features.get(ids[11])?.properties).toEqual({ log: 'A;', x: 1 });
    expect(ids.every((id) => logOf(id) === 'A;')).toBe(true);
    expect(partsOf(told, operationId)).toEqual([
      [true, false],
      [true, false],
      [true, false],
      [false, false],
    ]);
    expect((run.value as EditCounts).changedCount).toBe(12);
  });

  it('applies it before an arrow key reads the features it moves', async () => {
    const input = createParityMap();
    const keyed = createDraw(input.map, { store });
    const keyedEdits = bulkEditsOf(keyed) as BulkEdits;
    const ids = createIn(keyed, 12);
    // How far one press of the arrow key moves a point, read on a point no edit touches
    const probe = createIn(keyed, 1)[0];
    keyed.selection.set('feature', [probe]);
    input.key('ArrowRight');
    const step = xyOf(probe, keyed)[0];
    expect(step).toBeGreaterThan(0);
    const start = xyOf(ids[11], keyed)[0];
    const run = settled(keyedEdits.start(ids, undefined, shift(1, keyed)));
    await nextTask();
    // The edit has not reached the last feature: the key moves it from where the edit put it
    keyed.selection.set('feature', [ids[11]]);
    input.key('ArrowRight');
    expect(xyOf(ids[11], keyed)[0]).toBeCloseTo(start + 1 + step, 9);
    await allTasks();
    expect(xyOf(ids[11], keyed)[0]).toBeCloseTo(start + 1 + step, 9);
    expect(xyOf(ids[10], keyed)[0]).toBeCloseTo(0.1 + 1, 9);
    expect((run.value as EditCounts).changedCount).toBe(12);
    keyed.destroy();
  });

  it('applies it first as well for a write an operation of the instance makes on the layer', async () => {
    const ids = points(12);
    const run = settled(edits.start(ids, undefined, tag('A')));
    await nextTask();
    // As the operations of the modes write: on the layer, in a transaction of their own
    layer.transact(() => {
      layer.deleteFeature(ids[10]);
      layer.updateFeature(ids[11], { visible: false });
    });
    expect(logOf(ids[11])).toBe('A;');
    expect(draw.features.get(ids[11])?.visible).toBe(false);
    await allTasks();
    // The deleted feature was reached first, and counted
    expect(run.value).toEqual(expect.objectContaining({ changedCount: 12, missingCount: 0 }));
  });

  it('applies it to a feature buffer only reads, so the result is made where the edit put it', async () => {
    const ids = points(12);
    const run = settled(edits.start(ids, undefined, shift(1)));
    await nextTask();
    // The edit has not reached the last point: the buffer is made around it once it has moved
    const results = draw.features.buffer([ids[11]], { distanceMeters: 1_000 });
    expect(results).toHaveLength(1);
    const [west, east] = westEastOf(results?.[0].geometry);
    expect((west + east) / 2).toBeCloseTo(0.11 + 1, 6);
    await allTasks();
    // The later parts leave it out: the edit moved it once
    expect(xyOf(ids[11])[0]).toBeCloseTo(0.11 + 1, 9);
    expect((run.value as EditCounts).changedCount).toBe(12);
  });

  it('applies it to the area difference subtracts, which stays', async () => {
    const ids = points(12);
    const subject = square(0, 0, 2);
    // Far to the east of the area subtracted from, until the edit moves it 10 degrees to the west
    const cutter = square(9, 0, 2);
    const run = settled(edits.start([...ids, cutter], undefined, shiftShape(-10)));
    await nextTask();
    const result = draw.features.difference(subject, [cutter]);
    // Subtracted where the edit put it: the west half of the area goes
    const [west, east] = westEastOf(result?.geometry);
    expect(west).toBeCloseTo(1, 9);
    expect(east).toBeCloseTo(2, 9);
    expect(westEastOf(draw.features.get(cutter)?.geometry)).toEqual([-1, 1]);
    await allTasks();
    // The later parts leave it out: the edit moved it once
    expect(westEastOf(draw.features.get(cutter)?.geometry)).toEqual([-1, 1]);
    expect((run.value as EditCounts).changedCount).toBe(13);
  });

  it('does not apply it before a write made to the Store directly', async () => {
    const ids = points(12);
    const run = settled(edits.start(ids, undefined, tag('A')));
    await nextTask();
    const ref = store.tables.getRowRef(ids[11]) as number;
    store.transact(() => {
      store.writeRows({ rows: Int32Array.of(ref), fields: new Map([['visible', [false]]]) });
    }, 'remote');
    expect(logOf(ids[11])).toBe('');
    await allTasks();
    // A later part reads the values the feature has then
    expect(logOf(ids[11])).toBe('A;');
    expect(draw.features.get(ids[11])?.visible).toBe(false);
    expect((run.value as EditCounts).changedCount).toBe(12);
  });
});

describe('the target and the counts', () => {
  it('reads an IdSet, the selection and layers, once, when the edit starts', async () => {
    const layerA = draw.layers.getActive()?.id as string;
    const layerB = draw.layers.create({ name: 'B' })?.id as string;
    const inA = points(3, layerA);
    const inB = points(2, layerB);
    const group = draw.groups.create({ featureIds: [inB[0], inB[1]] });
    if (!group) throw new Error('not created');

    const bySet = settled(edits.start(createIdSet([inA[0], inA[1]]), undefined, tag('S')));
    draw.selection.set('feature', [inA[2]]);
    const bySelection = settled(edits.start({ selection: true }, undefined, tag('F')));
    draw.selection.set('group', [group.id]);
    const byGroup = settled(edits.start({ selection: true }, undefined, tag('G')));
    const byLayers = settled(edits.start({ layerIds: [layerB, 'none'] }, undefined, tag('L')));
    // A feature created afterwards is not part of the targets
    const later = points(1, layerB)[0];
    draw.selection.set('layer', [layerA]);
    await allTasks();
    expect(inA.map(logOf)).toEqual(['S;', 'S;', 'F;']);
    expect(inB.map(logOf)).toEqual(['G;L;', 'G;L;']);
    expect(logOf(later)).toBe('');
    expect(bySet.value?.changedCount).toBe(2);
    expect(bySelection.value?.changedCount).toBe(1);
    expect(byGroup.value?.changedCount).toBe(2);
    // A layer that names nothing is counted as missing
    expect(byLayers.value).toEqual(expect.objectContaining({ changedCount: 2, missingCount: 1 }));
  });

  it('refuses a target of the wrong shape, writing nothing', () => {
    points(1);
    for (const target of [
      [1],
      'a',
      { selection: false },
      { layerIds: 'a' },
      { layerIds: ['a'], selection: true },
      null,
    ]) {
      expect(codeOf(catchOf(() => edits.start(target as never, undefined, tag('A'))))).toBe(
        'invalidInput',
      );
    }
    expect(codeOf(catchOf(() => edits.start([], { source: 1 } as never, tag('A'))))).toBe(
      'invalidInput',
    );
  });

  it('counts the missing IDs, leaves out the features deleted meanwhile, keeps the locked ones', async () => {
    const ids = points(12);
    draw.features.update(ids[0], { locked: true });
    const group = draw.groups.create({ featureIds: [ids[1]] });
    if (!group) throw new Error('not created');
    draw.groups.update(group.id, { locked: true });
    const later = draw.groups.create({ featureIds: [ids[9]] });
    if (!later) throw new Error('not created');
    const run = settled(edits.start([...ids, 'none', ids[2]], undefined, tag('A')));
    await nextTask();
    // Locked while the edit writes: through its group, and from the Store directly
    draw.groups.update(later.id, { locked: true });
    const ref = store.tables.getRowRef(ids[10]) as number;
    store.writeRows({ rows: Int32Array.of(ref), fields: new Map([['locked', [true]]]) });
    // Deleted while the edit writes, from the Store directly
    const gone = store.tables.getRowRef(ids[11]) as number;
    store.writeRows({ rows: Int32Array.of(gone), fields: new Map(), deleted: Uint8Array.of(1) });
    await allTasks();
    expect(run.value).toEqual({
      operationId: expect.any(Number),
      changedCount: 7,
      lockedCount: 4,
      missingCount: 1,
      stopped: false,
    });
    expect(logOf(ids[0])).toBe('');
    expect(logOf(ids[2])).toBe('A;');
    expect(logOf(ids[9])).toBe('');
    expect(logOf(ids[10])).toBe('');
  });

  it('writes locked features with ignoreLocks', async () => {
    const ids = points(2);
    draw.features.update(ids[0], { locked: true });
    const run = settled(edits.start(ids, { ignoreLocks: true }, tag('A')));
    await allTasks();
    expect(run.value).toEqual(expect.objectContaining({ changedCount: 2, lockedCount: 0 }));
    expect(logOf(ids[0])).toBe('A;');
  });

  it('gives null at once when the document is read-only or every feature is locked', async () => {
    const ids = points(2);
    for (const id of ids) draw.features.update(id, { locked: true });
    expect(await edits.start(ids, undefined, tag('A'))).toBeNull();
    draw.features.update(ids[0], { locked: false });
    draw.setReadOnly(true);
    expect(await edits.start(ids, undefined, tag('A'))).toBeNull();
  });
});

describe('read-only and destroy', () => {
  it('stops at read-only: the parts written stay, and the last change is stopped', async () => {
    const ids = points(12);
    const changes = documentChanges();
    const told = storeChanges();
    const first = settled(edits.start(ids, undefined, tag('A')));
    const second = settled(edits.start(ids, undefined, tag('B')));
    await nextTask();
    draw.setReadOnly(true);
    await allTasks();
    const a = first.value as EditCounts;
    const b = second.value as EditCounts;
    expect(a).toEqual(expect.objectContaining({ changedCount: PART_ROWS, stopped: true }));
    expect(b).toEqual(expect.objectContaining({ changedCount: 0, stopped: true }));
    expect(ids.map(logOf).filter((log) => log === 'A;')).toHaveLength(PART_ROWS);
    expect(ids.some((id) => logOf(id).includes('B'))).toBe(false);
    expect(partsOf(changes, a.operationId)).toEqual([
      [true, false],
      [false, true],
    ]);
    // The edit that waited stops with a last change of its own
    expect(partsOf(changes, b.operationId)).toEqual([[false, true]]);
    expect(partsOf(told, a.operationId)).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it('on destroy, writes the stopped last part, then rejects; the edits waiting write nothing', async () => {
    const other = createDraw(createMapStub().map, { store });
    const otherEdits = bulkEditsOf(other) as BulkEdits;
    const ids = other.features.list().length === 0 ? createIn(other, 12) : [];
    const order: string[] = [];
    const told: StoreChange[] = [];
    store.subscribe((change) => {
      told.push(change);
      order.push(`change ${change.hasMoreParts} ${change.stopped}`);
    });
    const first = otherEdits.start(ids, undefined, tag('A', ROW_TIME, other));
    const second = otherEdits.start(ids, undefined, tag('B', ROW_TIME, other));
    first.catch((error: unknown) => order.push(`first ${codeOf(error)}`));
    second.catch((error: unknown) => order.push(`second ${codeOf(error)}`));
    await nextTask();
    other.destroy();
    await allTasks();
    expect(order).toEqual([
      'change true false',
      'change false true',
      'first invalidState',
      'second invalidState',
    ]);
    // Only the first edit wrote, and its operation ended for the subscribers of the Store
    expect(told.every((change) => change.operationId === told[0].operationId)).toBe(true);
  });
});

describe('a bulk edit started in draw.transact', () => {
  it('takes the number of the transaction, whose change is its first part', async () => {
    const ids = points(12);
    const changes = documentChanges();
    const told = storeChanges();
    let run: ReturnType<typeof settled<EditCounts | null>> | undefined;
    draw.transact(() => {
      draw.features.update(ids[0], { properties: { first: true } });
      run = settled(edits.start(ids, undefined, tag('A')));
    });
    await allTasks();
    const counts = run?.value as EditCounts;
    expect(changes[0].operationId).toBe(counts.operationId);
    expect([...changes[0].features.updated.iterate()]).toEqual([ids[0]]);
    expect(partsOf(changes, counts.operationId)).toEqual([
      [true, false],
      [true, false],
      [true, false],
      [false, false],
    ]);
    expect(partsOf(told, counts.operationId)).toEqual(partsOf(changes, counts.operationId));
    expect(counts.changedCount).toBe(12);
  });

  it('takes the source and ignoreLocks of the transaction, and refuses another source', async () => {
    const ids = points(2);
    draw.features.update(ids[0], { locked: true });
    const changes = documentChanges();
    let run: ReturnType<typeof settled<EditCounts | null>> | undefined;
    draw.transact(
      () => {
        expect(codeOf(catchOf(() => edits.start(ids, { source: 'other' }, tag('A'))))).toBe(
          'invalidState',
        );
        run = settled(edits.start(ids, undefined, tag('A')));
      },
      { source: 'batch', ignoreLocks: true },
    );
    await allTasks();
    expect(run?.value).toEqual(expect.objectContaining({ changedCount: 2, lockedCount: 0 }));
    expect(changes.every((change) => change.source === 'batch')).toBe(true);
  });

  it('throws invalidState at once for a second edit started in the same transaction', async () => {
    const ids = points(2);
    let run: ReturnType<typeof settled<EditCounts | null>> | undefined;
    let thrown: unknown;
    draw.transact(() => {
      run = settled(edits.start(ids, undefined, tag('A')));
      try {
        edits.start(ids, undefined, tag('B'));
      } catch (error) {
        thrown = error;
      }
    });
    expect(codeOf(thrown)).toBe('invalidState');
    await allTasks();
    expect(run?.value?.changedCount).toBe(2);
    expect(ids.map(logOf)).toEqual(['A;', 'A;']);
  });

  it('does not start the edit when fn throws, and leaves no operation open', async () => {
    const ids = points(2);
    const told = storeChanges();
    let run: ReturnType<typeof settled<EditCounts | null>> | undefined;
    expect(() =>
      draw.transact(() => {
        draw.features.update(ids[0], { properties: { first: true } });
        run = settled(edits.start(ids, undefined, tag('A')));
        throw new Error('stop');
      }),
    ).toThrow('stop');
    await allTasks();
    expect(run?.value).toBeNull();
    expect(ids.map(logOf)).toEqual(['', '']);
    expect(told.map((change) => change.hasMoreParts)).toEqual([false]);
  });

  it('does not start the edit when fn destroys the instance: it rejects, and no part follows', async () => {
    const ids = points(3);
    const told = storeChanges();
    let run: ReturnType<typeof settled<EditCounts | null>> | undefined;
    draw.transact(() => {
      draw.features.update(ids[0], { properties: { first: true } });
      run = settled(edits.start(ids, undefined, tag('A')));
      draw.destroy();
    });
    await allTasks();
    expect(codeOf(run?.error)).toBe('invalidState');
    // The change of the transaction is no part that more follow, and nothing else is written
    expect(told.map((change) => change.hasMoreParts)).toEqual([false]);
    expect(ids.map((id) => readRowFeature(store, id)?.properties.log)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(readRowFeature(store, ids[0])?.properties.first).toBe(true);
  });

  it('ends the edit being written when fn destroys the instance, once the transaction has closed', async () => {
    const ids = points(12);
    const [elsewhere] = points(1);
    const order: string[] = [];
    const told: StoreChange[] = [];
    store.subscribe((change) => {
      told.push(change);
      order.push(`change ${change.operationId} ${change.hasMoreParts} ${change.stopped}`);
    });
    const run = edits.start(ids, undefined, tag('A'));
    run.catch((error: unknown) => order.push(`rejected ${codeOf(error)}`));
    await nextTask();
    const { operationId } = told[0];
    draw.transact(() => {
      draw.features.update(elsewhere, { properties: { first: true } });
      draw.destroy();
    });
    // The stopped last part has come before draw.transact returned, after the transaction
    const transaction = told[1].operationId;
    expect(transaction).not.toBe(operationId);
    expect(order).toEqual([
      `change ${operationId} true false`,
      `change ${transaction} false false`,
      `change ${operationId} false true`,
    ]);
    await allTasks();
    expect(order.slice(3)).toEqual(['rejected invalidState']);
    expect(ids.map((id) => readRowFeature(store, id)?.properties.log)).toEqual([
      ...Array.from({ length: PART_ROWS }, () => 'A;'),
      ...Array.from({ length: ids.length - PART_ROWS }, () => undefined),
    ]);
  });

  it('leaves the edit being written open when destroyed in a transaction of the Store', async () => {
    const ids = points(12);
    const told = storeChanges();
    const run = settled(edits.start(ids, undefined, tag('A')));
    await nextTask();
    const { operationId } = told[0];
    store.transact(() => draw.destroy(), 'remote');
    await allTasks();
    // No last part is written, then or in a later task; the promise rejects all the same
    expect(codeOf(run.error)).toBe('invalidState');
    expect(partsOf(told, operationId)).toEqual([[true, false]]);
    expect(told).toHaveLength(1);
  });

  it('is stopped by the Store between a transaction of the Store and draw.transact', () => {
    points(1);
    let thrown: unknown;
    draw.transact(() => {
      try {
        store.transact(() => store.setMetadata({ title: 'x' }), 'remote');
      } catch (error) {
        thrown = error;
      }
    });
    expect(codeOf(thrown)).toBe('invalidState');
    expect(store.getMetadata().title).toBeUndefined();
  });
});

describe('waitForWrites', () => {
  it('resolves at once when no edit is written', async () => {
    let done = false;
    void draw.waitForWrites().then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it('waits for the edits started when it was called, those waiting included, and no later one', async () => {
    const ids = points(12);
    const first = settled(edits.start(ids, undefined, tag('A')));
    const second = settled(edits.start(ids, undefined, tag('B')));
    const waited = settled(draw.waitForWrites());
    await nextTask();
    const third = settled(edits.start(ids, undefined, tag('C')));
    while (!waited.done) await nextTask();
    expect(first.done && second.done).toBe(true);
    expect(third.done).toBe(false);
    await allTasks();
    expect(third.done).toBe(true);
  });
});

describe('the empty changes the layer tells', () => {
  it('tells the empty last part of an operation written to the Store directly, once a part was told', () => {
    const layerId = draw.layers.getActive()?.id as string;
    const changes = documentChanges();
    const operationId = store.newOperationId();
    store.transact(() => store.updateLayer(layerId, { name: 'A' }), 'remote', {
      operationId,
      hasMoreParts: true,
    });
    store.transact(() => {}, 'remote', { operationId });
    // An operation no part of which was told: its empty last part is not told
    const unseen = store.newOperationId();
    store.transact(() => {}, 'remote', { operationId: unseen, hasMoreParts: true });
    store.transact(() => {}, 'remote', { operationId: unseen });
    // A stopped one is told
    const stopped = store.newOperationId();
    store.transact(() => {}, 'remote', { operationId: stopped, stopped: true });
    expect(
      changes.map((change) => [change.operationId, change.hasMoreParts, change.stopped]),
    ).toEqual([
      [operationId, true, false],
      [operationId, false, false],
      [stopped, false, true],
    ]);
    expect(changes[1].features.updated.count()).toBe(0);
  });

  it('lets go on destroy of the operations a caller of the Store left open', () => {
    const layerId = draw.layers.getActive()?.id as string;
    const other = createDraw(createMapStub().map, { store });
    const seen: DocumentChange[] = [];
    other.on('document.changed', (change) => seen.push(change));
    const operationId = store.newOperationId();
    store.transact(() => store.updateLayer(layerId, { name: 'A' }), 'remote', {
      operationId,
      hasMoreParts: true,
    });
    other.destroy();
    store.transact(() => {}, 'remote', { operationId });
    expect(seen.map((change) => change.hasMoreParts)).toEqual([true]);
  });
});

/** The error a call throws (undefined when it returns) */
function catchOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Creates points in another instance and returns their IDs */
function createIn(target: Draw, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const feature = target.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i * 0.01, 1] },
    });
    if (!feature) throw new Error('not created');
    ids.push(feature.id);
  }
  return ids;
}
