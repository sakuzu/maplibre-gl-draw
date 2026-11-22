// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `features.restore` of features moved to another layer, written in parts on the clock of the
 * tests: a `restore` that stops leaves the rest in the layer they were moved to, and the same
 * values given again take the rest back to their layer, at their places there
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
import { toEngineOptions } from './options.js';

let clock = 0;
let draw: Draw;

/** The time a row written takes on the clock of the tests (ms) */
const ROW_MS = 0.05;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
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
});

afterEach(() => {
  draw.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Records what a promise settles with */
function settled<T>(promise: Promise<T>): { value?: T; done: boolean } {
  const out: { value?: T; done: boolean } = { done: false };
  promise.then((value) => {
    out.value = value;
    out.done = true;
  });
  return out;
}

describe('a restore of features moved to another layer, in parts', () => {
  it('stops with the rest in the other layer, and the same values given again take it back', async () => {
    const first = draw.layers.list()[0].id;
    const other = draw.layers.create({ name: 'other' })?.id as string;
    const count = 3000;
    const ids = Array.from({ length: count }, (_, i) => `p${i}`);
    draw.features.createMany(
      ids.map((id, i) => ({
        id,
        type: 'Point' as const,
        geometry: { type: 'Point' as const, coordinates: [i * 0.001, 0] },
      })),
    );
    const order = draw.layers.listItemIds(first, { start: 0, end: count });
    const changes: DocumentChange[] = [];
    draw.document.subscribe((change) => changes.push(change), { previousValues: true });
    draw.features.moveMany(ids, { layerId: other });
    expect(draw.layers.listItemIds(first, { start: 0, end: 1 })).toEqual([]);
    const values = changes.flatMap((change) =>
      change.previousValues ? [change.previousValues] : [],
    ) as FeatureValues[];
    const run = settled(draw.features.restore(values));
    await vi.advanceTimersToNextTimerAsync();
    const back = ids.filter((id) => draw.features.get(id)?.layerId === first).length;
    expect(back).toBeGreaterThan(0);
    expect(back).toBeLessThan(count);
    draw.setReadOnly(true);
    await vi.runAllTimersAsync();
    expect(run.value).toEqual(expect.objectContaining({ stopped: true }));
    draw.setReadOnly(false);
    const rest = settled(draw.features.restore(values));
    await vi.runAllTimersAsync();
    expect((rest.value as EditCounts).changedCount).toBe(count - back);
    expect(draw.layers.listItemIds(first, { start: 0, end: count })).toEqual(order);
    expect(draw.layers.listItemIds(other, { start: 0, end: 1 })).toEqual([]);
  });
});
