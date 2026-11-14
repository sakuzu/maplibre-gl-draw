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
import {
  applyOperations,
  createStoredDocument,
  type StoredDocument,
  type ValueBatch,
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

/** A document of records as one value to compare, the keys of the order included */
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

/** The paths where two values differ, and the two values there */
function differences(a: unknown, b: unknown, path = ''): unknown[] {
  if (a === b) return [];
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return [{ path, a, b }];
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return [{ path, a, b }];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((key) =>
    differences(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      `${path}/${key}`,
    ),
  );
}

describe('CommitValues', () => {
  for (const [kind, makeStore] of KINDS) {
    it(`takes each commit back with its inverse, the keys of the order included (${kind})`, async () => {
      let checked = 0;
      for (const seed of [21, 22, 23, 24, 25, 26]) {
        const next = random(seed);
        const store = makeStore();
        draw = createDraw(createMapStub().map, { store, initDefaultLayer: false });
        await draw.write(async (tx) => {
          await tx.layers.create({ id: 'a', name: 'A' });
          await tx.layers.create({ id: 'b', name: 'B' });
        });
        const values = new CommitValues(store);
        const document = createStoredDocument();
        applyOperations(document, values.documentOperations());
        const failures: unknown[] = [];
        const stop = store.subscribe((changes) => {
          const reading = values.readChange(changes, Number.POSITIVE_INFINITY);
          if (!reading) throw new Error('The document was replaced');
          reading.step(Number.POSITIVE_INFINITY);
          const operations = reading.operations();
          const inverse = reading.inverse();
          reading.release();
          if (operations.length === 0) return;
          const before = structuredClone(recordsOf(document));
          applyOperations(document, operations);
          const back = structuredClone(document);
          applyOperations(back, inverse);
          const after = structuredClone(recordsOf(back));
          const differ = differences(before, after);
          if (differ.length > 0) failures.push({ seed, operations, inverse, differ });
          checked++;
        });
        const ids = { feature: 0, layer: 0, group: 0 };
        for (let i = 0; i < 80; i++) await step(draw, next, ids);
        stop();
        expect(failures.slice(0, 1)).toEqual([]);
        draw.destroy();
        draw = undefined;
      }
      expect(checked).toBeGreaterThan(300);
    });

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
