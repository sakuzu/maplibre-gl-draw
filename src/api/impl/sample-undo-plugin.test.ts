// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sample of a small undo and redo written with the main entry alone
 * (`api/samples/sample-undo-plugin.ts`), run as it is on an instance: one edit, a move of every
 * feature in parts, deletions and the deletion of a layer, an edit of vertices with a vertex
 * moved elsewhere, the groups, a writing back refused or stopped (its step kept), and values
 * never written back twice
 */

import type { LineString } from 'geojson';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { FeatureRowField, RowValues, Store } from '../../store/built-in/types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { Plugin } from '../extension/plugin.js';
import type { EditCounts, EditOptions } from '../features.js';
import type { Feature, FeatureValues } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';
import { toEngineOptions } from './options.js';

/** What the plugin of the sample offers */
interface UndoApi {
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  canUndo(): boolean;
  canRedo(): boolean;
}

/** The sample, imported as it is (it imports only types from the package) */
const SAMPLE = new URL('../../../api/samples/sample-undo-plugin.ts', import.meta.url).pathname;
let undoPlugin: (options?: { maxSteps?: number; maxBytes?: number }) => Plugin<UndoApi>;

beforeAll(async () => {
  ({ undoPlugin } = (await import(/* @vite-ignore */ SAMPLE)) as { undoPlugin: typeof undoPlugin });
});

let clock = 0;
/** Whether a row written takes time on the clock of the tests (the edits then go in parts) */
let slow = false;
let base: Store;
let draw: Draw;
let undo: UndoApi;
/** The values given to `restore`, with what each `restore` ended with */
let restores: Array<{ values: readonly FeatureValues[]; counts?: EditCounts | null }>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  clock = 0;
  slow = false;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  base = createStore();
  const store: Store = {
    ...base,
    writeRows(values: RowValues) {
      if (slow) clock += values.rows.length * 0.05;
      return base.writeRows(values);
    },
  };
  const engine = createEngine(
    createMapStub().map as unknown as Parameters<typeof createEngine>[0],
    toEngineOptions({ store }, () => false),
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store });
  engine.enterDefaultMode();
  // What the sample gives to `restore`, through the public entry
  restores = [];
  const restore = draw.features.restore.bind(draw.features);
  vi.spyOn(draw.features, 'restore').mockImplementation(
    (values: readonly FeatureValues[], options?: EditOptions) => {
      const entry: (typeof restores)[number] = { values: [...values] };
      restores.push(entry);
      return restore(values, options).then((counts) => {
        entry.counts = counts;
        return counts;
      });
    },
  );
  draw.extensions.plugins.add(undoPlugin());
  undo = draw.extensions.plugins.getApi<UndoApi>('undo') as UndoApi;
});

afterEach(() => {
  draw.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Runs a promise and every task until it settles */
async function done<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const out = promise.finally(() => {
    settled = true;
  });
  for (let i = 0; i < 10_000 && !settled; i++) await vi.runAllTimersAsync();
  return out;
}

const coords = (n: number): number[][] => Array.from({ length: n }, (_, i) => [i, 0]);

const positionsOf = (id: string): number[][] =>
  ((draw.features.get(id) as Feature).geometry as LineString).coordinates;

/** `count` points written to the Store at once in the layer `many`; their IDs */
function manyPoints(count: number): string[] {
  base.createLayer({
    id: 'many',
    name: 'many',
    visible: true,
    locked: false,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
  } as Parameters<Store['createLayer']>[0]);
  const ids: string[] = [];
  const coordinates = new Float64Array(count * 2);
  const starts = new Int32Array(count + 1);
  for (let i = 0; i < count; i++) {
    ids.push(`p${i}`);
    coordinates[i * 2] = 139 + (i % 1000) * 0.0001;
    coordinates[i * 2 + 1] = 35 + Math.floor(i / 1000) * 0.0001;
    starts[i + 1] = i + 1;
  }
  base.createRows({
    ids,
    fields: new Map<FeatureRowField, unknown[]>([
      ['type', ids.map(() => 'Point')],
      ['parent', ids.map(() => 'many')],
      ['orderKey', ids.map((_, i) => `k${String(i).padStart(7, '0')}`)],
    ]),
    geometry: {
      types: new Uint8Array(count),
      coordinates,
      valuesPerPosition: 2,
      partStarts: starts,
      ringStarts: starts,
      positionStarts: starts,
    },
  });
  return ids;
}

describe('the undo plugin of the sample', () => {
  it('takes back one edit, and makes it again', async () => {
    draw.features.create({
      id: 'a',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { name: 'one' },
    });
    draw.features.update('a', { properties: { name: 'two' } });
    expect(await done(undo.undo())).toBe(true);
    expect(draw.features.get('a')?.properties.name).toBe('one');
    expect(await done(undo.redo())).toBe(true);
    expect(draw.features.get('a')?.properties.name).toBe('two');
    expect(await done(undo.undo())).toBe(true);
    expect(await done(undo.undo())).toBe(true);
    expect(draw.features.has('a')).toBe(false);
  });

  it('takes back a move of every feature written in parts as one step', async () => {
    const ids = manyPoints(3000);
    slow = true;
    await done(
      draw.features.translate({ layerIds: ['many'] }, { from: [139, 35], to: [139.01, 35] }),
    );
    expect(draw.features.get(ids[0])?.geometry).not.toEqual({
      type: 'Point',
      coordinates: [139, 35],
    });
    expect(await done(undo.undo())).toBe(true);
    expect(restores).toHaveLength(1);
    expect(restores[0].values.length).toBeGreaterThan(1);
    for (const i of [0, 1500, 2999]) {
      const { geometry } = draw.features.get(ids[i]) as Feature;
      const [x] = (geometry as { coordinates: number[] }).coordinates;
      expect(x).toBeCloseTo(139 + (i % 1000) * 0.0001, 9);
    }
    expect(undo.canUndo()).toBe(false);
    expect(undo.canRedo()).toBe(true);
  });

  it('brings back deleted features, and a deleted layer at its place in the order', async () => {
    manyPoints(10);
    const layers = draw.layers.list().map((layer) => layer.id);
    await done(draw.features.deleteMany(['p1', 'p2']));
    await done(draw.layers.delete('many'));
    expect(draw.layers.has('many')).toBe(false);
    expect(await done(undo.undo())).toBe(true);
    expect(draw.layers.list().map((layer) => layer.id)).toEqual(layers);
    expect(draw.features.count({ layerId: 'many' })).toBe(8);
    expect(await done(undo.undo())).toBe(true);
    expect(draw.features.count({ layerId: 'many' })).toBe(10);
  });

  it('takes back the vertex it moved, and leaves the vertex moved elsewhere', async () => {
    draw.features.create({
      id: 'a',
      type: 'LineString',
      geometry: { type: 'LineString', coordinates: coords(6) },
    });
    const mine = coords(6).map((p, i) => (i === 2 ? [2, 5] : p));
    draw.features.update('a', { geometry: { type: 'LineString', coordinates: mine } });
    // Elsewhere, the vertex 4 moves: a change the plugin does not record
    const elsewhere = mine.map((p, i) => (i === 4 ? [4, 9] : p));
    draw.transact(
      () => draw.features.update('a', { geometry: { type: 'LineString', coordinates: elsewhere } }),
      { source: 'remote' },
    );
    expect(await done(undo.undo())).toBe(true);
    expect(positionsOf('a')).toEqual(coords(6).map((p, i) => (i === 4 ? [4, 9] : p)));
  });

  it('takes back the groups with the features', async () => {
    manyPoints(3);
    draw.groups.create({ id: 'g', featureIds: ['p0', 'p1'] });
    draw.groups.update('g', { name: 'Renamed' });
    expect(await done(undo.undo())).toBe(true);
    expect(draw.groups.get('g')?.name).not.toBe('Renamed');
    expect(await done(undo.undo())).toBe(true);
    expect(draw.groups.has('g')).toBe(false);
    expect(draw.features.get('p0')?.groupId).toBeUndefined();
  });

  it('keeps the step when the writing back is refused, and writes it at the next undo', async () => {
    draw.features.create({
      id: 'a',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { name: 'one' },
    });
    draw.features.update('a', { properties: { name: 'two' } });
    const refused = undo.undo();
    // Read-only before it writes back: `restore` resolves with null
    draw.setReadOnly(true);
    expect(await done(refused)).toBe(false);
    expect(restores[0].counts).toBeNull();
    draw.setReadOnly(false);
    expect(undo.canUndo()).toBe(true);
    expect(await done(undo.undo())).toBe(true);
    expect(draw.features.get('a')?.properties.name).toBe('one');
  });

  it('keeps the step when the writing back stops, and the next undo writes the rest', async () => {
    const ids = manyPoints(3000);
    draw.features.updateMany(ids.map((id) => ({ id, patch: { properties: { n: 1 } } })));
    slow = true;
    const stopping = undo.undo();
    // The first part written, read-only stops the rest
    for (let i = 0; i < 20 && restores.length === 0; i++) await Promise.resolve();
    await vi.advanceTimersToNextTimerAsync();
    await vi.advanceTimersToNextTimerAsync();
    draw.setReadOnly(true);
    expect(await done(stopping)).toBe(false);
    expect(restores[0].counts?.stopped).toBe(true);
    const left = ids.filter((id) => draw.features.get(id)?.properties.n === 1).length;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(3000);
    draw.setReadOnly(false);
    expect(await done(undo.undo())).toBe(true);
    expect(ids.every((id) => draw.features.get(id)?.properties.n === undefined)).toBe(true);
    // The rest only: the second writes what the first left
    expect(restores[1].counts?.changedCount).toBe(left);
    // The stopped writing back and the rest make one step the other way
    expect(await done(undo.redo())).toBe(true);
    expect(ids.every((id) => draw.features.get(id)?.properties.n === 1)).toBe(true);
  });

  it('never writes back the same values twice once they were written back whole', async () => {
    draw.features.create({
      id: 'a',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
    });
    for (const name of ['one', 'two', 'three']) {
      draw.features.update('a', { properties: { name } });
    }
    for (let i = 0; i < 3; i++) await done(undo.undo());
    for (let i = 0; i < 3; i++) await done(undo.redo());
    for (let i = 0; i < 2; i++) await done(undo.undo());
    expect(draw.features.get('a')?.properties.name).toBe('one');
    const whole = restores.filter((entry) => entry.counts && !entry.counts.stopped);
    const given = whole.flatMap((entry) => entry.values);
    expect(new Set(given).size).toBe(given.length);
  });
});
