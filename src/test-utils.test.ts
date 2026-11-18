// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the tools that bound the work of a scene: the comparison of the two sizes fails on
 * work proportional to the features and passes on work that is not, and the run in parts on
 * the fake clock fails on an operation that writes everything in one task and passes on one
 * that gives the task back between its parts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countWork } from './shared/work-counts.js';
import { MemoryStore } from './store/memory.js';
import {
  compareWork,
  countsOf,
  createCountedInstance,
  createCountingGL,
  createCountingStore,
  expectNotProportional,
  expectPartsWithin,
  gridPoints,
  runInParts,
  storeWorkDuring,
  WORK_SIZES,
  workDuring,
} from './test-utils.js';

describe('the comparison of the two sizes', () => {
  /** A scene that does `work(size)` on a Store and returns what one number counted */
  function scene(work: (counts: ReturnType<typeof countsOf>, size: number) => void) {
    return (size: number): number => {
      const counts = countsOf(new MemoryStore());
      return workDuring(counts, () => work(counts, size)).objectsCreated;
    };
  }

  it('passes work that does not depend on the number of features', () => {
    const comparison = expectNotProportional(
      scene((counts) => countWork(counts, 'objectsCreated', 3)),
    );
    expect(comparison).toEqual({ small: 3, large: 3, ratio: 1 });
  });

  it('passes no work at all when the test names it', () => {
    expect(expectNotProportional(() => 0, 'the work', { zero: true }).ratio).toBe(0);
  });

  it('fails an amount that nothing counted at either size', () => {
    expect(() => expectNotProportional(() => 0, 'the rows touched')).toThrow(
      /nothing was counted at 1000 or at 10000 features: the comparison checks nothing/,
    );
    expect(() => compareWork(() => 0)).toThrow(/checks nothing/);
  });

  it('fails a scene that makes an array as long as the features', () => {
    const made = scene((counts, size) => {
      const ids = Array.from({ length: size }, (_, i) => `f${i}`);
      countWork(counts, 'objectsCreated', ids.length);
    });
    expect(() => expectNotProportional(made, 'the arrays')).toThrow(
      /the arrays grows with the number of features: 1000 at 1000, 10000 at 10000/,
    );
  });

  it('fails a scene that touches every row', () => {
    const touched = (size: number): number => {
      const counts = countsOf(new MemoryStore());
      return workDuring(counts, () => {
        for (let row = 0; row < size; row++) countWork(counts, 'rowsTouched');
      }).rowsTouched;
    };
    expect(() => expectNotProportional(touched)).toThrow(/grows with the number of features/);
  });

  it('fails work that grows by a square root', () => {
    // 10,000 / 1,000 grows the square root about 3.2 times
    expect(compareWork((size) => Math.round(Math.sqrt(size))).ratio).toBeGreaterThan(3);
    expect(() => expectNotProportional((size) => Math.sqrt(size))).toThrow();
  });

  it('compares 1,000 features with 10,000', () => {
    expect(WORK_SIZES).toEqual({ small: 1_000, large: 10_000 });
  });
});

describe('the run in parts on the fake clock', () => {
  const ROWS = 1_000;
  const LIMIT = 100;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails an operation that writes every row in one task', async () => {
    const counts = countsOf(new MemoryStore());
    const run = await runInParts({
      counts,
      run: () => {
        for (let row = 0; row < ROWS; row++) countWork(counts, 'rowsWritten');
      },
    });
    expect(run.parts).toEqual([ROWS]);
    expect(() => expectPartsWithin(run, LIMIT)).toThrow(/a part wrote 1000 rows, more than 100/);
  });

  it('fails an operation that only awaits promises between its parts', async () => {
    const counts = countsOf(new MemoryStore());
    const run = await runInParts({
      counts,
      run: async () => {
        for (let row = 0; row < ROWS; row += LIMIT) {
          countWork(counts, 'rowsWritten', LIMIT);
          await Promise.resolve();
        }
      },
    });
    // The map cannot draw until the task is given back: all of it is one part
    expect(run.parts).toEqual([ROWS]);
    expect(() => expectPartsWithin(run, LIMIT)).toThrow(/more than 100/);
  });

  it('passes an operation that writes its parts in separate tasks, with a frame between', async () => {
    const counts = countsOf(new MemoryStore());
    const seen: number[] = [];
    const run = await runInParts({
      counts,
      run: async () => {
        for (let row = 0; row < ROWS; row += LIMIT) {
          countWork(counts, 'rowsWritten', LIMIT);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      },
      frame: () => seen.push(counts.rowsWritten),
    });
    expect(() => expectPartsWithin(run, LIMIT)).not.toThrow();
    expect(Math.max(...run.parts)).toBe(LIMIT);
    expect(run.parts.reduce((sum, part) => sum + part, 0)).toBe(ROWS);
    // A frame was drawn after each part but the last, on what was written so far
    expect(seen.slice(0, 10)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    expect(run.frames).toEqual(seen);
  });

  it('gives back the failure of the operation', async () => {
    const counts = countsOf(new MemoryStore());
    await expect(
      runInParts({
        counts,
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          throw new Error('broken');
        },
      }),
    ).rejects.toThrow('broken');
  });

  it('needs the fake timers', async () => {
    vi.useRealTimers();
    const counts = countsOf(new MemoryStore());
    await expect(runInParts({ counts, run: () => {} })).rejects.toThrow(/fake timers/);
  });
});

describe('the counting GL', () => {
  it('counts the calls by name and the draw calls', () => {
    const counting = createCountingGL();
    const { gl } = counting;
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, 10);
    expect(counting.draws()).toBe(2);
    expect(counting.calls.get('bindBuffer')).toBe(1);
    expect(counting.total()).toBe(4);
    expect(counting.callsPerDraw()).toBe(2);
    counting.reset();
    expect(counting.draws()).toBe(0);
  });

  it('of two tests never share the counts', () => {
    const first = createCountingGL();
    const second = createCountingGL();
    first.gl.drawArrays(first.gl.TRIANGLES, 0, 3);
    expect(second.draws()).toBe(0);
  });
});

describe('the Store that counts', () => {
  /** A counting wrapper over a Store of `size` points */
  function countedStore(size: number) {
    const target = new MemoryStore();
    target.createLayer({
      id: 'l1',
      name: 'Layer',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
      styleRule: undefined,
      metadata: undefined,
    });
    for (const [i, input] of gridPoints(size).entries()) {
      target.createFeature({
        id: `f${i}`,
        type: 'Point',
        geometry: input.geometry,
        layerId: 'l1',
        groupId: undefined,
        properties: {},
        locked: false,
        visible: true,
        style: {},
      });
    }
    return { target, ...createCountingStore(target) };
  }

  it('counts the calls by name, the features given back and the features given to write', () => {
    const { store, work } = countedStore(3);
    expect(store.getFeature('f1')?.id).toBe('f1');
    expect(store.getFeature('none')).toBeUndefined();
    expect(store.listFeatures()).toHaveLength(3);
    store.updateFeature('f1', { properties: { a: 1 } });
    store.deleteFeature('f2');
    expect(work.calls.get('getFeature')).toBe(2);
    expect(work.calls.get('listFeatures')).toBe(1);
    expect(work.featuresRead).toBe(4);
    expect(work.featuresWritten).toBe(2);
  });

  it('stands for the Store: its class, its numbers and the writes on it', () => {
    const { target, store } = countedStore(1);
    expect(store).toBeInstanceOf(MemoryStore);
    expect(countsOf(store)).toBe(countsOf(target));
    store.updateFeature('f0', { properties: { b: 2 } });
    expect(target.getFeature('f0')?.properties).toEqual({ b: 2 });
  });

  it('fails a scene whose click reads every feature through the Store', () => {
    const readAll = (size: number): number => {
      const { store, work } = countedStore(size);
      // The click of the scene: one feature is hit, and every feature is read
      return storeWorkDuring(work, () => {
        store.getFeature('f5');
        store.listFeatures();
      }).featuresRead;
    };
    expect(() => expectNotProportional(readAll, 'the features read')).toThrow(
      /the features read grows with the number of features: 1001 at 1000, 10001 at 10000/,
    );
  });

  it('passes a scene whose click reads the feature it hits', () => {
    const readOne = (size: number): number => {
      const { store, work } = countedStore(size);
      return storeWorkDuring(work, () => store.getFeature('f5')).featuresRead;
    };
    expect(expectNotProportional(readOne)).toEqual({ small: 1, large: 1, ratio: 1 });
  });

  it('counts what an instance reads through the Store it was given, without a mark', () => {
    const readAll = (size: number): number => {
      const instance = createCountedInstance();
      instance.draw.features.createMany(gridPoints(size));
      const read = storeWorkDuring(instance.storeWork, () => instance.draw.features.list());
      instance.draw.destroy();
      return read.featuresRead;
    };
    expect(() => expectNotProportional(readAll)).toThrow(/grows with the number of features/);
  });
});
