// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The bulk edits mixed at random with the writes of a few features, the deletions, the locks,
 * read-only and destroy: the document they leave is the one the edits give applied one at a time,
 * in the order they were started
 *
 * The edit of the tests appends its tag to an attribute of each feature, so the attribute of a
 * feature lists the edits applied to it, in the order they were applied. A model applies each edit
 * whole when it starts being written (the earlier edits have ended), to the features of its target
 * there then and not locked; the writes of this client meanwhile (a lock, a deletion, a new
 * geometry) come after it, as the edit is applied first to the feature they touch. An edit that
 * read-only or destroy stops has written a part of its features: those must be features the model
 * applies it to. The random numbers come from a generator of a fixed seed, so a failure repeats.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { Store } from '../../store/built-in/types.js';
import { createMapStub, readRowFeature } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import type { EditCounts } from '../features.js';
import { type BulkEdits, bulkEditsOf } from './bulk-edits.js';

/** The features of each run */
const FEATURES = 24;
/** The steps of each run */
const STEPS = 60;
/** The seeds of the runs */
const SEEDS = Array.from({ length: 40 }, (_, i) => 1_000 + i * 7);

let clock = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A generator of numbers in [0, 1) from a seed (mulberry32) */
function randomOf(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** An edit of the model */
interface ModelEdit {
  readonly tag: string;
  /** The features of its target there when it started, each once, in its order */
  readonly targets: readonly string[];
  readonly missing: number;
  /** What its promise settled with */
  readonly result: { value?: EditCounts | null; error?: unknown; done: boolean };
  /** The features it is applied to and those it leaves locked, once it starts being written */
  applied: Set<string> | null;
  locked: Set<string> | null;
  /** Whether read-only or destroy stopped it */
  stopped: boolean;
  /** Whether destroy stopped it */
  destroyed: boolean;
}

/** One run of random steps, checked against the model */
async function runOnce(seed: number): Promise<void> {
  const random = randomOf(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const store: Store = createStore();
  const draw: Draw = createDraw(createMapStub().map, { store });
  const edits = bulkEditsOf(draw) as BulkEdits;
  const ids: string[] = [];
  for (let i = 0; i < FEATURES; i++) {
    const feature = draw.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i * 0.01, 0] },
    });
    if (!feature) throw new Error('not created');
    ids.push(feature.id);
  }
  const alive = new Set(ids);
  const locked = new Set<string>();
  let readOnly = false;
  let destroyed = false;
  const model: ModelEdit[] = [];
  /** The edits started and not ended, in the order they were started */
  const queue: ModelEdit[] = [];

  const tag = (name: string) => ({
    writeFeature(id: string): boolean {
      clock += 10;
      const log = (draw.features.getProperty(id, 'log') as string | undefined) ?? '';
      return draw.features.update(id, { properties: { log: `${log}${name};` } }) !== null;
    },
  });

  /** The edit at the head of the queue starts being written: the model applies it whole */
  const begin = (): void => {
    const head = queue[0];
    if (!head || head.applied) return;
    head.applied = new Set(head.targets.filter((id) => alive.has(id) && !locked.has(id)));
    head.locked = new Set(head.targets.filter((id) => alive.has(id) && locked.has(id)));
  };

  /** Takes the edits that ended out of the queue, and begins the next */
  const settle = (): void => {
    while (queue.length > 0 && queue[0].result.done) {
      queue.shift();
      begin();
    }
  };

  /** The promises settle, and the edits that ended leave the queue */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    settle();
  };

  /** Every edit of the queue stops: read-only or destroy */
  const stopAll = (byDestroy: boolean): void => {
    for (const edit of queue) {
      edit.stopped = true;
      edit.destroyed = byDestroy;
      // An edit that waited applies to nothing
      if (!edit.applied) {
        edit.applied = new Set();
        edit.locked = new Set();
      }
    }
  };

  for (let step = 0; step < STEPS; step++) {
    const roll = random();
    const living = [...alive];
    if (roll < 0.25) {
      // Starts an edit of some features, a missing ID and an ID given twice among them
      const given: string[] = [];
      const size = 1 + Math.floor(random() * FEATURES);
      for (let i = 0; i < size; i++) given.push(pick(ids));
      if (random() < 0.5) given.push(`none-${step}`);
      const targets = [...new Set(given)].filter((id) => alive.has(id));
      const missing = [...new Set(given)].length - targets.length;
      const name = `E${step}`;
      settle();
      const promise = edits.start(given, undefined, tag(name));
      const result: ModelEdit['result'] = { done: false };
      promise.then(
        (value) => {
          result.value = value;
          result.done = true;
        },
        (error: unknown) => {
          result.error = error;
          result.done = true;
        },
      );
      const refused = readOnly || (targets.length > 0 && targets.every((id) => locked.has(id)));
      const edit: ModelEdit = {
        tag: name,
        targets,
        missing,
        result,
        applied: refused ? new Set() : null,
        locked: refused ? new Set() : null,
        stopped: false,
        destroyed: false,
      };
      model.push(edit);
      if (!refused) {
        queue.push(edit);
        begin();
      }
      await flush();
    } else if (roll < 0.55) {
      await vi.runOnlyPendingTimersAsync();
      await flush();
    } else if (roll < 0.7 && living.length > 0) {
      // Locks or unlocks a feature: a write of this client
      const id = pick(living);
      const value = !locked.has(id);
      const written = draw.features.update(id, { locked: value });
      if (!readOnly) {
        expect(written).not.toBeNull();
        if (value) locked.add(id);
        else locked.delete(id);
      }
    } else if (roll < 0.8 && living.length > 0) {
      const id = pick(living);
      const deleted = draw.features.delete(id);
      if (!readOnly && !locked.has(id)) {
        expect(deleted).toBe(true);
        alive.delete(id);
      }
    } else if (roll < 0.85) {
      readOnly = !readOnly;
      draw.setReadOnly(readOnly);
      if (readOnly) stopAll(false);
      await flush();
    } else if (living.length > 0) {
      const id = pick(living);
      draw.features.update(id, {
        geometry: { type: 'Point', coordinates: [random(), random()] },
      });
    }
  }
  if (random() < 0.3) {
    draw.destroy();
    destroyed = true;
    stopAll(true);
  }
  await vi.runAllTimersAsync();
  settle();

  // The document: every edit applied whole, in the order the edits were started
  const logOf = (id: string): string =>
    ((destroyed ? readRowFeature(store, id) : draw.features.get(id))?.properties.log as
      | string
      | undefined) ?? '';
  const seen = new Map<ModelEdit, Set<string>>();
  for (const edit of model) seen.set(edit, new Set());
  for (const id of alive) {
    const tags = logOf(id)
      .split(';')
      .filter((name) => name !== '');
    const expected = model
      .filter((edit) => (edit.stopped ? tags.includes(edit.tag) : edit.applied?.has(id)))
      .map((edit) => edit.tag);
    expect(tags, `the edits applied to ${id} (seed ${seed})`).toEqual(expected);
    for (const edit of model) if (tags.includes(edit.tag)) seen.get(edit)?.add(id);
  }
  for (const edit of model) {
    const { result } = edit;
    expect(result.done, `${edit.tag} has ended (seed ${seed})`).toBe(true);
    const applied = edit.applied ?? new Set<string>();
    if (edit.stopped) {
      // What a stopped edit wrote is a part of what the model applies it to
      for (const id of seen.get(edit) ?? []) expect(applied.has(id)).toBe(true);
      if (edit.destroyed) {
        expect(result.error, `${edit.tag} rejects (seed ${seed})`).toBeDefined();
      } else {
        expect(result.value?.stopped, `${edit.tag} stopped (seed ${seed})`).toBe(true);
      }
      continue;
    }
    if (applied.size === 0 && (edit.locked?.size ?? 0) === 0 && result.value === null) continue;
    expect(result.value, `the counts of ${edit.tag} (seed ${seed})`).toEqual({
      operationId: expect.any(Number),
      changedCount: applied.size,
      lockedCount: edit.locked?.size ?? 0,
      missingCount: edit.missing,
      stopped: false,
    });
  }
  if (!destroyed) draw.destroy();
}

describe('bulk edits mixed with the other writes at random', () => {
  it('leave the document the edits give applied one at a time, in the order they were started', async () => {
    for (const seed of SEEDS) await runOnce(seed);
  });
});
