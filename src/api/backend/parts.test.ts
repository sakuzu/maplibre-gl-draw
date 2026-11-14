// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { DrawError } from '../../shared/draw-error.js';
import { batchesOf, createPartCollector } from './parts.js';
import type { ValueBatch, ValueOperation } from './values.js';

const HEADER = { commit: 'c1', label: 'Move', writtenAtMilliseconds: 1000 };

/** Operations on values of about `n` bytes each */
function operations(count: number, bytes = 100): ValueOperation[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'set',
    kind: 'feature',
    ids: [`f${i}`],
    set: { properties: { text: 'x'.repeat(bytes) } },
  }));
}

describe('batchesOf', () => {
  it('cuts a commit into batches no larger than the bound, in the order of its operations', () => {
    const list = operations(100);
    const batches = batchesOf(HEADER, list, 2000);
    expect(batches.length).toBeGreaterThan(5);
    for (const batch of batches) {
      expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThanOrEqual(2000);
      expect(batch).toMatchObject({ schema: 1, commit: 'c1', label: 'Move' });
      expect(batch.part.count).toBe(batches.length);
    }
    expect(batches.map((batch) => batch.part.index)).toEqual(batches.map((_, i) => i));
    expect(batches.map((batch) => batch.id)).toEqual(batches.map((_, i) => `c1.${i}`));
    expect(batches.flatMap((batch) => batch.operations)).toEqual(list);
  });

  it('keeps a small commit in one batch, and makes none of no operation', () => {
    expect(batchesOf(HEADER, operations(3), 1 << 20)).toHaveLength(1);
    expect(batchesOf(HEADER, [], 1 << 20)).toEqual([]);
  });

  it('cuts an operation on many IDs by its IDs, its keys with them', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `feature-${i}`);
    const keys = ids.map((_, i) => `k${i}`);
    const batches = batchesOf(
      HEADER,
      [{ type: 'place', kind: 'feature', ids, parentId: 'a', keys }],
      4000,
    );
    expect(batches.length).toBeGreaterThan(4);
    const pieces = batches.flatMap((batch) => batch.operations);
    expect(pieces.flatMap((op) => (op.type === 'place' ? op.ids : []))).toEqual(ids);
    expect(pieces.flatMap((op) => (op.type === 'place' ? op.keys : []))).toEqual(keys);
    for (const batch of batches) {
      expect(JSON.stringify(batch).length).toBeLessThanOrEqual(4000);
    }
  });

  it('puts an operation on one ID larger than the bound alone in its batch', () => {
    const list = [...operations(1, 50), ...operations(1, 5000), ...operations(1, 50)];
    const batches = batchesOf(HEADER, list, 1000);
    expect(batches.map((batch) => batch.operations.length)).toEqual([1, 1, 1]);
  });
});

describe('createPartCollector', () => {
  const parts = (): ValueBatch[] => batchesOf(HEADER, operations(30), 1500);

  it('gives every operation of a commit once its last part is there, in any order', () => {
    const batches = parts();
    expect(batches.length).toBeGreaterThan(2);
    const collector = createPartCollector();
    const order = [...batches].reverse();
    const answers = order.map((batch) => collector.add(batch));
    expect(answers.slice(0, -1).every((answer) => answer === null)).toBe(true);
    expect(answers[answers.length - 1]).toEqual(operations(30));
  });

  it('gives a batch of one part at once, and not again', () => {
    const [batch] = batchesOf(HEADER, operations(2), 1 << 20);
    const collector = createPartCollector();
    expect(collector.add(batch)).toEqual(operations(2));
    expect(collector.add(batch)).toBeNull();
  });

  it('does not count again a part of a commit it gave', () => {
    const batches = parts();
    const collector = createPartCollector();
    for (const batch of batches.slice(0, -1)) collector.add(batch);
    expect(collector.add(batches[batches.length - 1])).toEqual(operations(30));
    for (const batch of batches) expect(collector.add(batch)).toBeNull();
  });

  it('does not count a part sent again', () => {
    const batches = parts();
    const collector = createPartCollector();
    collector.add(batches[0]);
    expect(collector.add(batches[0])).toBeNull();
    for (const batch of batches.slice(1, -1)) expect(collector.add(batch)).toBeNull();
    expect(collector.add(batches[batches.length - 1])).toEqual(operations(30));
  });

  it('lets go of a commit abandoned: its parts sent again start it anew', () => {
    const batches = parts();
    const collector = createPartCollector();
    collector.add(batches[0]);
    collector.add(batches[1]);
    collector.abandon('c1');
    for (const batch of batches.slice(1)) expect(collector.add(batch)).toBeNull();
    expect(collector.add(batches[0])).toEqual(operations(30));
  });

  it('keeps the commits apart', () => {
    const a = parts();
    const b = batchesOf({ ...HEADER, commit: 'c2' }, operations(30), 1500);
    const collector = createPartCollector();
    for (let i = 0; i < a.length - 1; i++) {
      expect(collector.add(a[i])).toBeNull();
      expect(collector.add(b[i])).toBeNull();
    }
    expect(collector.add(b[b.length - 1])).toHaveLength(30);
    expect(collector.add(a[a.length - 1])).toHaveLength(30);
  });

  it('refuses a part that is not one of its commit', () => {
    const batches = parts();
    const collector = createPartCollector();
    collector.add(batches[0]);
    const wrong = { ...batches[1], part: { index: 1, count: batches.length + 1 } };
    expect(() => collector.add(wrong)).toThrow(DrawError);
    const outside = { ...batches[1], part: { index: batches.length, count: batches.length } };
    expect(() => collector.add(outside)).toThrow(/outside/);
  });
});
