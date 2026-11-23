// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.isTransacting`: true while the `fn` of a `draw.transact` of the instance runs, nested
 * ones included, and false after it returned or threw, inside a transaction opened on the Store
 * directly, and in the parts of a bulk edit that follow after `fn` returned; it throws on a
 * destroyed instance
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { FeatureRowField, RowValues, Store } from '../../store/built-in/types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { EditCounts } from '../features.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';
import { toEngineOptions } from './options.js';

let clock = 0;
let base: Store;
let draw: Draw;

/** The time a row written takes on the clock of the tests (ms), so that an edit has parts */
const ROW_MS = 0.05;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  base = createStore();
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
});

afterEach(() => {
  draw.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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
      ['visible', ids.map(() => true)],
      ['locked', ids.map(() => false)],
      ['style', ids.map(() => ({}))],
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

describe('isTransacting', () => {
  it('is true inside the fn of a draw.transact, nested ones included, and false after it', () => {
    expect(draw.isTransacting()).toBe(false);
    const seen: boolean[] = [];
    draw.transact(() => {
      seen.push(draw.isTransacting());
      draw.transact(() => {
        seen.push(draw.isTransacting());
      });
      seen.push(draw.isTransacting());
    });
    expect(seen).toEqual([true, true, true]);
    expect(draw.isTransacting()).toBe(false);
  });

  it('is false after the fn threw', () => {
    expect(() =>
      draw.transact(() => {
        expect(draw.isTransacting()).toBe(true);
        throw new Error('thrown');
      }),
    ).toThrow('thrown');
    expect(draw.isTransacting()).toBe(false);
    // Thrown from a nested one, the outer one still runs
    draw.transact(() => {
      expect(() =>
        draw.transact(() => {
          throw new Error('inner');
        }),
      ).toThrow('inner');
      expect(draw.isTransacting()).toBe(true);
    });
    expect(draw.isTransacting()).toBe(false);
  });

  it('is false inside a transaction opened on the Store directly', () => {
    const seen: boolean[] = [];
    draw.getStore().transact(() => {
      seen.push(draw.isTransacting());
      draw.transact(() => {
        seen.push(draw.isTransacting());
      });
      seen.push(draw.isTransacting());
    }, 'local');
    expect(seen).toEqual([false, true, false]);
  });

  it('is false in the listeners of the parts of a bulk edit that follow after fn returned', async () => {
    manyPoints(3000);
    const parts: Array<{ hasMoreParts: boolean; transacting: boolean }> = [];
    draw.document.subscribe((change) => {
      parts.push({ hasMoreParts: change.hasMoreParts, transacting: draw.isTransacting() });
    });
    let edit: Promise<EditCounts | null> | undefined;
    draw.transact(() => {
      edit = draw.features.translate({ layerIds: ['many'] }, { from: [139, 35], to: [139.01, 35] });
    });
    expect(draw.isTransacting()).toBe(false);
    await vi.runAllTimersAsync();
    const counts = await edit;
    expect(counts?.changedCount).toBe(3000);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts.slice(1)) expect(part.transacting).toBe(false);
    expect(parts[parts.length - 1].hasMoreParts).toBe(false);
  });

  it('throws invalidState on a destroyed instance, as every other method does', () => {
    draw.destroy();
    expect(() => draw.isTransacting()).toThrow(expect.objectContaining({ code: 'invalidState' }));
  });
});
