// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The take-out of a refused commit: writing again only the later commits that touch what it
 * touched gives the document that writing every later commit again gives, and the one the storage
 * has without the refused commits (read by the rules of `kept.ts`)
 */

import { afterEach, describe, expect, it } from 'vitest';
import { featuresInOrder } from '../../store/feature-stream.js';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import { random, step } from '../../test-support/random-commits.js';
import { createMapStub } from '../../test-utils.js';
import { createDraw, type Draw } from '../draw.js';
import { CommitValues } from './commit-values.js';
import { readStoredDocument } from './kept.js';
import { type CommitOperations, dependentsOf, takeOut, touching } from './take-out.js';
import { applyOperations, createStoredDocument, type StoredDocument } from './values.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
});

const KINDS: ReadonlyArray<readonly [string, () => Store]> = [
  ['objects', () => new MemoryStore()],
  ['rows', () => createTableStore().store],
];

/** The document of a Store as records, the keys of the order as they are kept now */
function liveRecords(store: Store, values: CommitValues) {
  const sorted = <T>(entries: Array<[string, T]>) =>
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    features: sorted(
      [...featuresInOrder(store)].map((f) => [f.id, values.recordOf('feature', f.id)]),
    ),
    layers: sorted(store.listLayers().map((l) => [l.id, values.recordOf('layer', l.id)])),
    groups: sorted(store.listGroups().map((g) => [g.id, values.recordOf('group', g.id)])),
  };
}

function recordsOf(document: StoredDocument) {
  const sorted = <T>(map: Map<string, T>) =>
    [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    features: sorted(document.features),
    layers: sorted(document.layers),
    groups: sorted(document.groups),
  };
}

/** The commits not sent at the end of a run */
const UNSENT = 12;

/**
 * A random run of commits, the last ones not sent and the first of those refused (with what
 * depends on it), taken out
 */
async function takenOut(makeStore: () => Store, seed: number, every: boolean) {
  const store = makeStore();
  const d = createDraw(createMapStub().map, { store, initDefaultLayer: false });
  draws.push(d);
  await d.write(async (tx) => {
    await tx.layers.create({ id: 'a', name: 'A' });
    await tx.layers.create({ id: 'b', name: 'B' });
  });
  const values = new CommitValues(store);
  const storage = createStoredDocument();
  applyOperations(storage, values.documentOperations());
  const commits: CommitOperations[] = [];
  store.subscribe((changes) => {
    const own = changes.source !== 'refused';
    const reading = values.readChange(changes, Number.POSITIVE_INFINITY, own);
    if (!reading) throw new Error('The document was replaced');
    reading.step(Number.POSITIVE_INFINITY);
    const operations = reading.operations();
    if (own && operations.length > 0) commits.push({ operations, inverse: reading.inverse() });
    reading.release();
  });
  const next = random(seed);
  const ids = { feature: 0, layer: 0, group: 0 };
  for (let i = 0; i < 40; i++) await step(d, next, ids);
  const at = Math.max(0, commits.length - UNSENT);
  for (const commit of commits.slice(0, at)) applyOperations(storage, commit.operations);
  const unsent = commits.slice(at);
  const refused = new Set([
    unsent[0],
    ...dependentsOf(unsent[0], unsent.slice(1)).map((i) => unsent[i + 1]),
  ]);
  const again = touching(unsent, refused).length;
  store.transact(() => takeOut(store, values, unsent, refused, every), 'refused');
  for (const commit of unsent) {
    if (!refused.has(commit)) applyOperations(storage, commit.operations);
  }
  return {
    live: liveRecords(store, values),
    stored: recordsOf(readStoredDocument(storage).shown),
    skipped: unsent.length - again,
  };
}

describe('the take-out of a refused commit', () => {
  for (const [kind, makeStore] of KINDS) {
    it(`gives the same document writing again only the commits that touch it (${kind})`, async () => {
      let skipped = 0;
      for (let seed = 1; seed <= 30; seed++) {
        const touched = await takenOut(makeStore, seed, false);
        const every = await takenOut(makeStore, seed, true);
        expect({ seed, live: touched.live }).toEqual({ seed, live: every.live });
        expect({ seed, live: touched.live }).toEqual({ seed, live: touched.stored });
        skipped += touched.skipped;
      }
      // The commits left as they are, written again by the other
      expect(skipped).toBeGreaterThan(60);
    });
  }
});
