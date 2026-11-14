// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The commits of the instance as operations on values: random runs of commits, cut into parts,
 * put together again and applied with `applyOperations`, give the document the instance writes
 * out, on a Store of objects and on a Store of rows
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import { random, step, storedOf, writtenOf } from '../../test-support/random-commits.js';
import { createMapStub } from '../../test-utils.js';
import { createDraw, type Draw } from '../draw.js';
import { CommitValues, fileRecordOf } from './commit-values.js';
import { batchesOf, createPartCollector } from './parts.js';
import { applyOperations, createStoredDocument, type ValueBatch } from './values.js';

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
});

const KINDS: ReadonlyArray<readonly [string, () => Store]> = [
  ['objects', () => new MemoryStore()],
  ['rows', () => createTableStore().store],
];

// ============================================================================
// A storage that receives the commits
// ============================================================================

/**
 * The commits of the instance read as operations, cut into small parts, sent in an order mixed
 * within each commit with some parts sent twice, put together again and applied
 */
function receiver(store: Store, next: () => number) {
  const values = new CommitValues(store);
  const document = createStoredDocument();
  applyOperations(document, values.documentOperations());
  const collector = createPartCollector();
  let commits = 0;
  let parts = 0;
  const stop = store.subscribe((changes) => {
    const operations = values.changeOperations(changes);
    if (operations === null) throw new Error('The document was replaced');
    commits++;
    const batches = batchesOf(
      { commit: `c${commits}`, writtenAtMilliseconds: commits },
      operations,
      700,
    );
    parts += batches.length;
    const sent: ValueBatch[] = [...batches];
    if (sent.length > 1 && next() < 0.5) sent.push(sent[0]);
    for (let i = sent.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [sent[i], sent[j]] = [sent[j], sent[i]];
    }
    let applied = 0;
    for (const batch of sent) {
      const complete = collector.add(batch);
      if (complete === null) continue;
      applied++;
      const { skipped } = applyOperations(document, complete);
      if (skipped.length > 0) throw new Error(`Skipped ${skipped.join(', ')}`);
    }
    if (batches.length > 0 && applied !== 1) throw new Error('A commit was applied twice');
  });
  return { document, stop, counts: () => ({ commits, parts }) };
}

describe('CommitValues', () => {
  for (const [kind, makeStore] of KINDS) {
    it(`gives, applied part by part, the document written out (${kind})`, async () => {
      let total = { commits: 0, parts: 0 };
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const next = random(seed);
        const store = makeStore();
        draw = createDraw(createMapStub().map, { store, initDefaultLayer: false });
        await draw.write(async (tx) => {
          await tx.layers.create({ id: 'a', name: 'A' });
          await tx.layers.create({ id: 'b', name: 'B' });
        });
        const storage = receiver(store, next);
        const ids = { feature: 0, layer: 0, group: 0 };
        for (let i = 0; i < 80; i++) {
          await step(draw, next, ids);
          const written = writtenOf(draw.document.toJSON());
          const stored = storedOf(storage.document);
          if (JSON.stringify(stored) !== JSON.stringify(written)) {
            expect({ seed, step: i, stored }).toEqual({ seed, step: i, stored: written });
          }
        }
        const counts = storage.counts();
        total = { commits: total.commits + counts.commits, parts: total.parts + counts.parts };
        storage.stop();
        draw.destroy();
        draw = undefined;
      }
      // The runs made commits cut into more than one part
      expect(total.parts).toBeGreaterThan(total.commits);
    });

    it(`reads a document as the operations that create it (${kind})`, async () => {
      const store = makeStore();
      draw = createDraw(createMapStub().map, { store, initDefaultLayer: false });
      const next = random(9);
      await draw.write(async (tx) => {
        await tx.layers.create({ id: 'a', name: 'A' });
        await tx.layers.create({ id: 'b', name: 'B' });
      });
      const ids = { feature: 0, layer: 0, group: 0 };
      for (let i = 0; i < 40; i++) await step(draw, next, ids);
      const document = createStoredDocument();
      const { skipped } = applyOperations(document, new CommitValues(store).documentOperations());
      expect(skipped).toEqual([]);
      expect(storedOf(document)).toEqual(writtenOf(draw.document.toJSON()));
    });
  }

  it('gives a file its bytes in base64', () => {
    expect(
      fileRecordOf({ id: 'i', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAEC' }),
    ).toEqual({ mediaType: 'image/png', content: 'AAEC' });
    expect(
      fileRecordOf({ id: 's', mimeType: 'image/svg+xml', dataURL: 'data:image/svg+xml,%3Csvg%3E' }),
    ).toEqual({ mediaType: 'image/svg+xml', content: btoa('<svg>') });
  });
});
