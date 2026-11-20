// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The work of the bulk edits, which does not grow with the number of features where it must not
 *
 * Each scene runs on an instance over 1,000 and over 10,000 points, with an edit of the tests
 * that appends a tag to an attribute of each feature and takes a fixed time per feature on the
 * clock of the tests: the rows one part writes, the parts in tasks of their own, the rows a write
 * of one feature touches while an edit is written, and what starting an edit makes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCountedInstance,
  expectNotProportional,
  expectPartsWithin,
  gridPoints,
  runInParts,
  storeWorkDuring,
  WORK_SIZES,
  workDuring,
} from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { EditCounts } from '../features.js';
import type { Feature } from '../model.js';
import { BULK_PART_BUDGET_MS, type BulkEdits, bulkEditsOf } from './bulk-edits.js';

type Instance = ReturnType<typeof createCountedInstance>;

/** The time the edit of the tests takes per feature (ms, on the clock of the tests) */
const ROW_TIME = 1;
/** The rows one part writes at most at that time */
const PART_ROWS = BULK_PART_BUDGET_MS / ROW_TIME;

let clock = 0;
const instances: Instance[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  for (const instance of instances.splice(0)) instance.draw.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** An instance over `size` points, with their IDs in the order they were created */
function instanceOf(size: number): {
  instance: Instance;
  edits: BulkEdits;
  ids: string[];
  layerId: string;
} {
  const instance = createCountedInstance();
  instances.push(instance);
  const ids = (instance.draw.features.createMany(gridPoints(size)) as Feature[]).map((f) => f.id);
  return {
    instance,
    edits: bulkEditsOf(instance.draw) as BulkEdits,
    ids,
    layerId: instance.draw.layers.list()[0].id,
  };
}

/** The edit of the tests: appends `<tag>;` to the attribute `log`, taking `ROW_TIME` per feature */
function tag(draw: Draw, name: string) {
  return {
    writeFeature(id: string): boolean {
      clock += ROW_TIME;
      const log = (draw.features.getProperty(id, 'log') as string | undefined) ?? '';
      return draw.features.update(id, { properties: { log: `${log}${name};` } }) !== null;
    },
  };
}

/** Leaves a promise of an edit unwaited for: the destroy of the instance at the end rejects it */
function ignored(promise: Promise<unknown>): void {
  promise.catch(() => {});
}

describe('the parts of a bulk edit', () => {
  it.each([WORK_SIZES.small, WORK_SIZES.large])(
    'writes at most the rows of the budget in one part, each part in a task of its own (%i)',
    async (size) => {
      const { instance, edits, ids } = instanceOf(size);
      let frames = 0;
      let result: EditCounts | null = null;
      const run = await runInParts({
        counts: instance.counts,
        run: async () => {
          result = await edits.start(ids, undefined, tag(instance.draw, 'A'));
        },
        frame: () => {
          frames += 1;
        },
      });
      expectPartsWithin(run, PART_ROWS);
      expect(run.parts.reduce((sum, part) => sum + part, 0)).toBe(size);
      expect(run.parts.length).toBeGreaterThanOrEqual(size / PART_ROWS);
      expect(frames).toBeGreaterThanOrEqual(size / PART_ROWS - 1);
      expect((result as EditCounts | null)?.changedCount).toBe(size);
    },
  );
});

describe('a write of one feature while an edit is written', () => {
  it('touches rows that do not grow with the features of the edit', async () => {
    const touched = expectNotProportional((size) => {
      const { instance, edits, ids } = instanceOf(size);
      ignored(edits.start(ids, undefined, tag(instance.draw, 'A')));
      // The edit has reached none of the features: the write applies it to its feature only
      const last = ids[ids.length - 1];
      let through = { featuresRead: 0, featuresWritten: 0, calls: 0 };
      const counted = workDuring(instance.counts, () => {
        through = storeWorkDuring(instance.storeWork, () => {
          instance.draw.features.update(last, { geometry: { type: 'Point', coordinates: [3, 3] } });
        });
      });
      expect(instance.draw.features.getProperty(last, 'log')).toBe('A;');
      return through.featuresRead + through.featuresWritten + counted.rowsWritten;
    }, 'the rows a write touches');
    expect(touched.large).toBeGreaterThan(0);
  });
});

describe('the start of an edit', () => {
  it.each([
    ['the features of a layer', 'layer'],
    ['the features selected', 'selection'],
    ['the layer selected', 'selected layer'],
  ] as const)('makes objects that do not grow with the features of %s', (_name, kind) => {
    expectNotProportional((size) => {
      const { instance, edits, ids, layerId } = instanceOf(size);
      if (kind === 'selection') instance.draw.selection.set('feature', ids);
      if (kind === 'selected layer') instance.draw.selection.set('layer', [layerId]);
      const target = kind === 'layer' ? { layerIds: [layerId] } : ({ selection: true } as const);
      return workDuring(instance.counts, () => {
        ignored(edits.start(target, undefined, tag(instance.draw, 'A')));
      }).objectsCreated;
    }, 'the objects made when the edit starts');
  });
});
