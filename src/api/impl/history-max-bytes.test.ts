// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The limit of the bytes of the local undo (`history.maxBytes`): past it, the oldest steps are
 * let go of first, the last one kept; without it, the steps are kept up to `maxSteps`
 *
 * - Each step counts the bytes it keeps: a budget of two steps keeps two, of three and a half
 *   keeps three, the newest ones
 * - The steps to take back and to make again share the budget: once one step to take back is
 *   left, the farthest step to make again is let go of first
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import { createTableStore } from '../../store/table-memory.js';
import { writesOf } from '../../test-support/writes.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import type { FeatureInput } from '../model.js';
import { MEMORY_FACTORS } from './memory.js';

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
});

/** A line of many positions, so that a step that keeps it keeps many bytes */
const line = (positions: number): FeatureInput => ({
  type: 'Feature',
  geometry: {
    type: 'LineString',
    coordinates: Array.from({ length: positions }, (_, i) => [i * 0.001, 0]),
  },
  properties: {},
});

/** Points in a row */
const points = (count: number, y: number): FeatureInput[] =>
  Array.from({ length: count }, (_, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [i * 0.001, y] },
    properties: {},
  }));

/** How many steps can be taken back */
async function undos(draw: Draw): Promise<number> {
  let n = 0;
  while (draw.status.value.history.canUndo) {
    await draw.undo();
    n++;
  }
  return n;
}

describe('history.maxBytes', () => {
  for (const rows of [false, true]) {
    const kind = rows ? 'a Store of rows' : 'a Store of objects';

    it(`lets go of the oldest steps past the budget, the last one kept (${kind})`, async () => {
      const store = rows ? createTableStore().store : new MemoryStore();
      draw = createDraw(createMapStub().map, { store, history: { maxBytes: 50_000 } });
      const batches: (readonly string[])[] = [];
      for (let i = 0; i < 4; i++) {
        batches.push(await draw.write((tx) => tx.features.create(points(100, i))));
      }
      // Each deletion keeps 100 features to take it back: one of them fits in the budget
      for (const ids of batches) await draw.write((tx) => tx.features.delete(ids));
      expect(await undos(draw)).toBe(1);
      // The newest step is the one kept: the last deletion is taken back
      expect(draw.features.count()).toBe(100);
      expect(draw.features.has(batches[3]?.[0] as string)).toBe(true);
    });
  }

  /** Points of a long name, so that a step that keeps them keeps far more than their IDs */
  const named = (batch: number, count = 100) =>
    points(count, batch).map((point, i) => ({
      ...point,
      properties: { name: `${'n'.repeat(200)}${String(batch * 1000 + i).padStart(4, '0')}` },
    }));

  /** An instance whose IDs are given in order, its Store of rows or of objects */
  function openWith(rows: boolean, maxBytes: number): Draw {
    let n = 0;
    const opened = createDraw(createMapStub().map, {
      ...(rows && { store: createTableStore().store }),
      history: { maxBytes },
      generateId: () => `f${String(++n).padStart(6, '0')}`,
    });
    return opened;
  }

  /**
   * Four deletions of `count` points each (the points written without a step), taken back as far
   * as they are kept: the batches back, in the order they came back
   */
  async function deletionsTakenBack(
    rows: boolean,
    maxBytes: number,
    count = 100,
  ): Promise<number[]> {
    const opened = openWith(rows, maxBytes);
    try {
      const writes = writesOf(opened);
      const layerId = opened.layers.list()[0]?.id as string;
      const batches = Array.from({ length: 4 }, (_, batch) =>
        writes.transact(
          () =>
            writes.features.createMany(
              named(batch, count).map((point) => ({
                type: 'Point' as const,
                geometry: point.geometry,
                layerId,
                properties: point.properties,
              })),
            ),
          { source: 'silent' },
        ),
      );
      const ids = batches.map((made) => (made ?? []).map((feature) => feature.id));
      for (const batch of ids) await opened.write((tx) => tx.features.delete(batch));
      const back: number[] = [];
      while (opened.status.value.history.canUndo) {
        await opened.undo();
        back.push(
          ids.findIndex(
            (batch, at) => !back.includes(at) && opened.features.has(batch[0] as string),
          ),
        );
      }
      // Only the batches taken back are there
      expect(opened.features.count()).toBe(back.length * count);
      return back;
    } finally {
      opened.destroy();
    }
  }

  /** The least budget that keeps two deletions (found by halving) */
  async function budgetOfTwo(rows: boolean, count = 100): Promise<number> {
    let low = 0;
    let high = 10_000_000;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if ((await deletionsTakenBack(rows, middle, count)).length >= 2) high = middle;
      else low = middle;
    }
    return high;
  }

  for (const rows of [false, true]) {
    const kind = rows ? 'a Store of rows' : 'a Store of objects';

    it(`counts each step by the bytes it keeps, the newest kept (${kind})`, async () => {
      const two = await budgetOfTwo(rows);
      // A deletion of 100 points of a long name keeps them: some hundreds of bytes each
      const perPoint = two / 2 / 100;
      expect(perPoint).toBeGreaterThan(400);
      expect(perPoint).toBeLessThan(10_000);
      expect(await deletionsTakenBack(rows, two - 1)).toEqual([3]);
      expect(await deletionsTakenBack(rows, two)).toEqual([3, 2]);
      // Three steps and a half: three, the oldest let go of
      expect(await deletionsTakenBack(rows, Math.round(two * 1.75))).toEqual([3, 2, 1]);
      expect(await deletionsTakenBack(rows, Math.round(two * 2.25))).toEqual([3, 2, 1, 0]);
      // What a step keeps is counted: twice the points keep each point more, its name of 200
      // characters (2 bytes each), or the bytes of a row the Store keeps for the step
      const more = await budgetOfTwo(rows, 200);
      expect(more - two).toBeGreaterThanOrEqual(2 * 100 * MEMORY_FACTORS.rows.jsPerFeature);
    }, 30_000);

    it(`lets go of the farthest step to make again once one step to take back is left (${kind})`, async () => {
      const two = await budgetOfTwo(rows);
      // Three creations keep their IDs; each one taken back keeps its 100 points to make it again.
      // Two and a half deletions: once the third is taken back, the three to make again are past
      // the budget, and the farthest one (the newest creation) is let go of
      draw = openWith(rows, Math.round(two * 1.25));
      const batches: (readonly string[])[] = [];
      for (let batch = 0; batch < 3; batch++) {
        batches.push(
          (await draw.write((tx) => tx.features.create(named(batch)))) as readonly string[],
        );
      }
      expect(await undos(draw)).toBe(3);
      expect(draw.features.count()).toBe(0);
      let redone = 0;
      while (draw.status.value.history.canRedo) {
        await draw.redo();
        redone++;
      }
      expect(redone).toBe(2);
      expect(batches.map((ids) => draw?.features.has(ids[0] as string))).toEqual([
        true,
        true,
        false,
      ]);
    }, 30_000);
  }

  it('keeps the last step however many bytes it keeps', async () => {
    draw = createDraw(createMapStub().map, { history: { maxBytes: 0 } });
    const a = await draw.write((tx) => tx.features.create(line(10)));
    await draw.write((tx) => tx.features.update(a.id, { properties: { n: 1 } }));
    expect(await undos(draw)).toBe(1);
    expect(draw.features.get(a.id)?.properties).not.toHaveProperty('n');
    // The step made again is the last one too
    expect(draw.status.value.history.canRedo).toBe(true);
    await draw.redo();
    expect(draw.features.get(a.id)?.properties).toMatchObject({ n: 1 });
  });

  it('keeps every step up to maxSteps without it', async () => {
    draw = createDraw(createMapStub().map);
    for (let i = 0; i < 6; i++) await draw.write((tx) => tx.features.create(line(1000)));
    expect(await undos(draw)).toBe(6);
  });

  it('refuses a budget that is not a number from 0', () => {
    for (const maxBytes of [-1, Number.NaN, '1']) {
      expect(() =>
        createDraw(createMapStub().map, { history: { maxBytes: maxBytes as number } }),
      ).toThrow(expect.objectContaining({ code: 'invalidInput' }));
    }
  });
});
