// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Operations written to a Store keep their keys: random runs of commits, some taken back by
 * writing their inverse to the Store, leave the Store as a storage that never had them has the
 * document, the keys of the order included, on a Store of objects and on a Store of rows
 */

import { afterEach, describe, expect, it } from 'vitest';
import { featuresInOrder } from '../../store/feature-stream.js';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import { random, step } from '../../test-support/random-commits.js';
import { createMapStub } from '../../test-utils.js';
import { createDraw, type Draw } from '../draw.js';
import { CommitValues, fileRecordOf } from './commit-values.js';
import { writeOperations } from './store-writes.js';
import {
  applyOperations,
  createStoredDocument,
  type StoredDocument,
  type ValueOperation,
} from './values.js';

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
});

const KINDS: ReadonlyArray<readonly [string, () => Store]> = [
  ['objects', () => new MemoryStore()],
  ['rows', () => createTableStore().store],
];

/** The document of a Store as records, the keys of the order as they are kept now */
function liveRecords(store: Store, values: CommitValues) {
  const sorted = <T>(entries: Array<[string, T]>) =>
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const metadata = store.getMetadata();
  return {
    features: sorted(
      [...featuresInOrder(store)].map((f) => [f.id, values.recordOf('feature', f.id)]),
    ),
    layers: sorted(store.listLayers().map((l) => [l.id, values.recordOf('layer', l.id)])),
    groups: sorted(store.listGroups().map((g) => [g.id, values.recordOf('group', g.id)])),
    files: sorted(store.listFiles().map((file) => [file.id, fileRecordOf(file)])),
    title: typeof metadata.title === 'string' ? metadata.title : '',
    description: typeof metadata.description === 'string' ? metadata.description : '',
  };
}

function recordsOf(document: StoredDocument) {
  const sorted = <T>(map: Map<string, T>) =>
    [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    features: sorted(document.features),
    layers: sorted(document.layers),
    groups: sorted(document.groups),
    files: sorted(document.files),
    title: document.title,
    description: document.description,
  };
}

describe('writeOperations', () => {
  for (const [kind, makeStore] of KINDS) {
    it(`takes commits back to the document a storage has, keys included (${kind})`, async () => {
      let taken = 0;
      for (const seed of [31, 32, 33, 34, 35, 36]) {
        const next = random(seed);
        const store = makeStore();
        draw = createDraw(createMapStub().map, { store, initDefaultLayer: false });
        await draw.write(async (tx) => {
          await tx.layers.create({ id: 'a', name: 'A' });
          await tx.layers.create({ id: 'b', name: 'B' });
        });
        const values = new CommitValues(store);
        // The storage: every commit of this client, none of those taken back
        const storage = createStoredDocument();
        applyOperations(storage, values.documentOperations());
        let last: { operations: ValueOperation[]; inverse: ValueOperation[] } | null = null;
        const stop = store.subscribe((changes) => {
          const own = changes.source !== 'refused';
          const reading = values.readChange(changes, Number.POSITIVE_INFINITY, own);
          if (!reading) throw new Error('The document was replaced');
          reading.step(Number.POSITIVE_INFINITY);
          if (own) last = { operations: reading.operations(), inverse: reading.inverse() };
          reading.release();
        });
        const ids = { feature: 0, layer: 0, group: 0 };
        for (let i = 0; i < 80; i++) {
          last = null;
          await step(draw, next, ids);
          const commit = last as { operations: ValueOperation[]; inverse: ValueOperation[] } | null;
          if (!commit || commit.operations.length === 0) continue;
          if (next() < 0.3) {
            store.transact(() => writeOperations(store, values, commit.inverse), 'refused');
            taken++;
          } else {
            applyOperations(storage, commit.operations);
          }
          expect({ seed, step: i, document: liveRecords(store, values) }).toEqual({
            seed,
            step: i,
            document: recordsOf(storage),
          });
        }
        stop();
        draw.destroy();
        draw = undefined;
      }
      expect(taken).toBeGreaterThan(60);
    });
  }
});
