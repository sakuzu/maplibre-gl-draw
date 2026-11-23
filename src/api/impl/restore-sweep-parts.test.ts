// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `features.restore` feature by feature, written in parts on the clock of the tests, with a client
 * elsewhere (another source) writing in between: a writing back that stops goes on and leaves
 * the features written first as they are since, and the making again of a writing back whose
 * parts hold features of different fields (some renamed, the others moved) writes each feature
 * what its own change wrote. The values of a move of every feature tell no row apart.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { RowValues, Store } from '../../store/built-in/types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { DocumentChange } from '../events.js';
import type { EditCounts } from '../features.js';
import type { FeatureValues } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';
import { sharedValuesOf } from './feature-values.js';
import { toEngineOptions } from './options.js';

let clock = 0;
let draw: Draw;
let changes: DocumentChange[];

/** The time a row written takes on the clock of the tests (ms) */
const ROW_MS = 0.05;
const N = 2000;

/** A seeded random number generator (mulberry32) */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Makes the instance over a Store whose writes take `ROW_MS` a row */
function open(): void {
  const base = createStore();
  const store: Store = {
    ...base,
    writeRows(values: RowValues) {
      clock += values.rows.length * ROW_MS;
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
  changes = [];
  draw.document.subscribe((c) => changes.push(c), { previousValues: true });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  draw.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The values of the changes of a source since a mark */
const valuesSince = (mark: number, source = 'local'): FeatureValues[] =>
  changes
    .slice(mark)
    .filter((c) => c.source === source)
    .flatMap((c) => (c.previousValues ? [c.previousValues] : []));

/** `N` points, `name` n0 and `n` and `m` 0 each; their IDs */
function points(): string[] {
  const ids = Array.from({ length: N }, (_, i) => `p${i}`);
  draw.features.createMany(
    ids.map((id, i) => ({
      id,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i * 0.001, 0] },
      properties: { name: 'n0', n: 0, m: 0 },
    })),
  );
  return ids;
}

/** Runs a bulk edit to its end on the clock of the tests */
async function settled<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

const propertiesOf = (id: string) => draw.features.get(id)?.properties;

describe('a writing back in parts, feature by feature', () => {
  it('goes on after it stopped, leaving the features written first as they are since', async () => {
    for (let seed = 1; seed <= 10; seed++) {
      const r = rng(seed);
      open();
      const ids = points();
      let mark = changes.length;
      await settled(draw.features.updateAll(ids, { properties: { n: 1, m: 1 } }));
      const values = valuesSince(mark);
      const except = seed % 2 === 0 ? ['m'] : undefined;
      const options = { source: 'back', ...(except && { exceptProperties: except }) };
      mark = changes.length;
      const first = draw.features.restore(values, options);
      await vi.advanceTimersToNextTimerAsync();
      draw.setReadOnly(true);
      const stopped = (await settled(first)) as EditCounts;
      draw.setReadOnly(false);
      expect(stopped.stopped).toBe(true);
      const written = new Set(ids.filter((id) => propertiesOf(id)?.n === 0));
      expect(written.size).toBeGreaterThan(0);
      expect(written.size).toBeLessThan(N);
      // The client elsewhere writes `n` of features written first and of features not yet
      const touched = new Set(ids.filter(() => r() < 0.05));
      draw.transact(
        () => {
          for (const id of touched) draw.features.update(id, { properties: { n: 'elsewhere' } });
        },
        { source: 'elsewhere' },
      );
      await settled(draw.features.restore(values, options));
      for (const id of ids) {
        const n = written.has(id) && touched.has(id) ? 'elsewhere' : 0;
        expect(propertiesOf(id), id).toEqual({ name: 'n0', n, m: except ? 1 : 0 });
      }
      draw.destroy();
    }
    open();
  });

  it('makes again the writing back of a rename and a move, each feature what its change wrote', async () => {
    for (let seed = 1; seed <= 5; seed++) {
      const r = rng(seed + 100);
      open();
      const ids = points();
      const renamed = ids.filter(() => r() < 0.5);
      const moved = ids.filter((id) => !renamed.includes(id));
      let mark = changes.length;
      await settled(draw.features.updateAll(renamed, { properties: { name: 'n1' } }));
      const rename = valuesSince(mark);
      mark = changes.length;
      await settled(draw.features.translate(moved, { from: [0, 0], to: [0, 1] }));
      const move = valuesSince(mark);
      mark = changes.length;
      await settled(draw.features.restore([...rename, ...move], { source: 'back' }));
      const back = valuesSince(mark, 'back');
      expect(back.length).toBeGreaterThan(1);
      // The client elsewhere renames some moved features and moves some renamed ones
      const namedElsewhere = moved.filter(() => r() < 0.1);
      const movedElsewhere = renamed.filter(() => r() < 0.1);
      draw.transact(
        () => {
          for (const id of namedElsewhere) {
            draw.features.update(id, { properties: { name: 'elsewhere' } });
          }
          for (const id of movedElsewhere) {
            draw.features.update(id, { geometry: { type: 'Point', coordinates: [9, 9] } });
          }
        },
        { source: 'elsewhere' },
      );
      await settled(draw.features.restore(back, { source: 'again' }));
      for (const id of namedElsewhere) expect(propertiesOf(id)?.name, id).toBe('elsewhere');
      for (const id of movedElsewhere) {
        expect(draw.features.get(id)?.geometry, id).toEqual({ type: 'Point', coordinates: [9, 9] });
        expect(propertiesOf(id)?.name, id).toBe('n1');
      }
      draw.destroy();
    }
    open();
  });

  it('keeps the values of a move of every feature as they were: no row told apart', async () => {
    open();
    const ids = points();
    const mark = changes.length;
    await settled(draw.features.translate(ids, { from: [0, 0], to: [0, 1] }));
    const values = valuesSince(mark);
    expect(values.length).toBeGreaterThan(1);
    for (const value of values) {
      const shared = sharedValuesOf(value);
      for (const before of shared?.byLayer.values() ?? []) expect(before.written).toBeUndefined();
    }
  });
});
