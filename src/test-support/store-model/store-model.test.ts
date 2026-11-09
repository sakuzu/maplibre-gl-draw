// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Stores of core compared with the reference model of the Store, after every step
 *
 * The fixed sequences come first: written by hand for what a rewrite of the rows must keep, and
 * the sequences that failed made short (`shrinkSteps`) and written down. Then sequences made from
 * fixed seeds. Every sequence runs on four Stores:
 *
 * - `rows`: the Store of rows without a sync, the time it waits for let go by after each step
 *   (the rows held for the selection let go of)
 * - `rows-held`: the same, the time never let go by (the rows selected stay held)
 * - `rows-bulk`: the same with a hold limit of 2, so that most selections are selections in bulk
 * - `objects`: the Store of objects
 *
 * What differs now is listed: the fixed sequences that fail, by Store (`KNOWN_FAILURES`), and the
 * number of seeds that fail, by Store (`KNOWN_RANDOM_FAILURES`). A fixed sequence must pass or fail
 * as listed, and the number of seeds that fail must not grow. With `STORE_MODEL_REPORT` set, the
 * failures are printed, the random ones made short.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import {
  randomSteps,
  runSteps,
  shrinkSteps,
  storeSubject,
  type TableStep,
  type TableSubject,
} from './index.js';

type StoreKind = 'rows' | 'rows-held' | 'rows-bulk' | 'objects';

const KINDS: readonly StoreKind[] = ['rows', 'rows-held', 'rows-bulk', 'objects'];

function subjectOf(kind: StoreKind): () => TableSubject {
  const settle = (): void => {
    vi.advanceTimersByTime(1_000);
  };
  switch (kind) {
    case 'rows':
      return () => storeSubject(createTableStore().store, settle);
    case 'rows-held':
      return () => storeSubject(createTableStore().store);
    case 'rows-bulk':
      return () => storeSubject(createTableStore({ selectionIdsLimit: 2 }).store, settle);
    case 'objects':
      return () => storeSubject(new MemoryStore() as Store);
  }
}

// The steps pick among what is there: `layer: 0` is the first layer, `feature: 0` the first
// feature of the document (layers back to front, then their items), and so on. The styles a step
// writes are, by `value`: 0 none, 1 a stroke color, 2 a fill color and a dashed line, 3 a stroke
// color, width and a dotted line, 4 a point color and radius.

const layer: TableStep = { kind: 'createLayer' };
const point = (x = 0): TableStep => ({ kind: 'createFeature', layer: 0, group: null, shape: 0, x });
const polygon = (x = 0): TableStep => ({
  kind: 'createFeature',
  layer: 0,
  group: null,
  shape: 2,
  x,
});
const style = (feature: number, value: number): TableStep => ({
  kind: 'updateFeature',
  feature,
  field: 'style',
  value,
});
const select = (...features: number[]): TableStep => ({ kind: 'select', features });

/** The fixed sequences, by name */
const FIXED: Readonly<Record<string, readonly TableStep[]>> = {
  // Written by hand
  'a style written while the feature is selected is read': [
    layer,
    polygon(),
    select(0),
    style(0, 1),
  ],
  'a dashed polygon selected and deleted leaves the document and the selection': [
    layer,
    polygon(),
    style(0, 2),
    select(0),
    { kind: 'deleteFeature', feature: 0 },
  ],
  'the fill and then the line style of a selected polygon are read once it is let go of': [
    layer,
    polygon(),
    select(0),
    style(0, 2),
    style(0, 3),
    { kind: 'clearSelection' },
  ],
  'a group takes the place of its first feature, its features in the order given': [
    layer,
    point(0),
    point(1),
    point(2),
    point(3),
    { kind: 'createGroup', features: [2, 0] },
  ],
  'a feature created into a group goes to its front': [
    layer,
    point(0),
    point(1),
    { kind: 'createGroup', features: [0, 1] },
    { kind: 'createFeature', layer: 0, group: 0, shape: 1, x: 2 },
  ],
  'the last feature moved out of a group deletes the group': [
    layer,
    point(0),
    point(1),
    { kind: 'createGroup', features: [0] },
    { kind: 'moveItems', items: [0], layer: 0, group: null, near: null, byBelow: false },
  ],
  'a deleted group puts its members in its place': [
    layer,
    point(0),
    point(1),
    point(2),
    { kind: 'createGroup', features: [1, 2] },
    { kind: 'deleteGroup', group: 0 },
  ],
  'items moved to another layer go just above the item named': [
    layer,
    layer,
    point(0),
    point(1),
    { kind: 'createFeature', layer: 1, group: null, shape: 2, x: 3 },
    { kind: 'createFeature', layer: 1, group: null, shape: 2, x: 4 },
    { kind: 'moveItems', items: [0, 1], layer: 1, group: null, near: 0, byBelow: true },
  ],
  'a group moved to another layer takes its members with it': [
    layer,
    layer,
    point(0),
    point(1),
    { kind: 'createGroup', features: [0, 1] },
    { kind: 'moveItems', items: [2], layer: 1, group: null, near: null, byBelow: true },
  ],
  'a hidden layer takes its features out of the selection': [
    layer,
    point(0),
    point(1),
    select(0, 1),
    { kind: 'updateLayer', layer: 0, field: 'visible', value: 1 },
  ],
  'a deleted layer takes its groups, its features and their selection with it': [
    layer,
    layer,
    point(0),
    point(1),
    { kind: 'createGroup', features: [0, 1] },
    { kind: 'createFeature', layer: 1, group: null, shape: 0, x: 2 },
    select(0, 2),
    { kind: 'deleteLayer', layer: 0 },
  ],
  'a feature created and selected in one transaction is selected': [
    layer,
    { kind: 'transact', steps: [point(0), select(0)] },
  ],
  'the layers put in another order are read in it': [
    layer,
    layer,
    layer,
    { kind: 'reorderLayers', from: 2, to: 0 },
  ],
  // Made short from seeds that failed
  'a group hidden and deleted in one transaction leaves its members out of the selection': [
    layer,
    point(0),
    { kind: 'createGroup', features: [0] },
    select(0),
    {
      kind: 'transact',
      steps: [
        { kind: 'updateGroup', group: 0, field: 'visible', value: 1 },
        { kind: 'deleteGroup', group: 0 },
      ],
    },
  ],
  'a feature selected in bulk and deleted in one transaction leaves the selection': [
    layer,
    point(0),
    point(1),
    {
      kind: 'transact',
      steps: [point(2), select(2, 0, 1), { kind: 'deleteFeature', feature: 2 }],
    },
  ],
  'a group of features not in their order takes the place of its first feature': [
    layer,
    point(0),
    point(1),
    point(2),
    { kind: 'createGroup', features: [1, 0] },
  ],
  'a group created and deleted in one transaction puts its member back in its place': [
    layer,
    point(0),
    {
      kind: 'transact',
      steps: [point(1), { kind: 'createGroup', features: [0] }, { kind: 'deleteGroup', group: 0 }],
    },
  ],
};

/** The fixed sequences that fail now, by Store, with what differs */
const KNOWN_FAILURES: Readonly<Record<string, readonly StoreKind[]>> = {
  // The selection is cut to what is shown once the transaction ends, not after each write in it
  'a group hidden and deleted in one transaction leaves its members out of the selection': [
    'rows',
    'rows-held',
    'rows-bulk',
    'objects',
  ],
  // A row deleted keeps its place in a selection in bulk made in the same transaction
  'a feature selected in bulk and deleted in one transaction leaves the selection': ['rows-bulk'],
  // The Store of objects puts the group at the index its first feature had, counted before its
  // features leave the items, not at the place of the first feature
  'a group takes the place of its first feature, its features in the order given': ['objects'],
  'a group of features not in their order takes the place of its first feature': ['objects'],
  // The Store of objects lists a group created in a transaction at the end of the transaction
  'a group created and deleted in one transaction puts its member back in its place': ['objects'],
};

/** The seeds, the length of their sequences, and the number of seeds that fail now, by Store */
const SEEDS = 200;
const LENGTH = 60;
const KNOWN_RANDOM_FAILURES: Readonly<Record<StoreKind, number>> = {
  rows: 0,
  'rows-held': 0,
  'rows-bulk': 0,
  // The places of the groups created (as `KNOWN_FAILURES` lists them)
  objects: 30,
};

const report = Boolean(process.env.STORE_MODEL_REPORT);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the reference model of the Store', () => {
  it('finds a Store that writes something else than the model', () => {
    const make = (): TableSubject => {
      const subject = storeSubject(createTableStore().store);
      return {
        ...subject,
        // A Store that leaves out the deletions of features
        apply: (operation) => {
          if (operation.op !== 'deleteFeature') subject.apply(operation);
        },
      };
    };
    const failure = runSteps([layer, point(), { kind: 'deleteFeature', feature: 0 }], make);
    expect(failure?.step).toBe(2);
    expect(failure?.reason).toContain('features[0]');
  });

  it('makes a sequence that fails as short as it goes on failing', () => {
    // Fails once a polygon is deleted, whatever else the sequence holds
    const steps = randomSteps(7, { length: 40 });
    const fails = (s: readonly TableStep[]): boolean =>
      s.some((step) => step.kind === 'deleteFeature');
    if (!fails(steps)) return;
    const short = shrinkSteps(steps, fails);
    expect(short).toHaveLength(1);
    expect(short[0].kind).toBe('deleteFeature');
  });

  for (const kind of KINDS) {
    describe(`on the Store ${kind}`, () => {
      for (const [name, steps] of Object.entries(FIXED)) {
        const known = KNOWN_FAILURES[name]?.includes(kind) ?? false;
        it(`${known ? 'fails as known: ' : ''}${name}`, () => {
          const failure = runSteps(steps, subjectOf(kind));
          if (report && failure)
            console.log(`${kind} | ${name} | step ${failure.step}: ${failure.reason}`);
          expect(failure !== null).toBe(known);
        });
      }

      it(`fails on no more seeds than the ${KNOWN_RANDOM_FAILURES[kind]} known`, () => {
        let failed = 0;
        for (let seed = 1; seed <= SEEDS; seed++) {
          const steps = randomSteps(seed, { length: LENGTH });
          const failure = runSteps(steps, subjectOf(kind));
          if (!failure) continue;
          failed += 1;
          if (report) {
            const short = shrinkSteps(steps, (s) => runSteps(s, subjectOf(kind)) !== null);
            const again = runSteps(short, subjectOf(kind));
            console.log(
              `${kind} | seed ${seed} | ${JSON.stringify(short)} | step ${again?.step}: ${again?.reason}`,
            );
          }
        }
        if (report) console.log(`${kind} | ${failed} of ${SEEDS} seeds fail`);
        expect(failed).toBeLessThanOrEqual(KNOWN_RANDOM_FAILURES[kind]);
      });
    });
  }
});
