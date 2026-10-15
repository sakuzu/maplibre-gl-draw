// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows held as columns in the notifications of a transaction: one entry per row, a row
 * created and deleted within the transaction dropped, the fields and the keys of the styles
 * gathered
 */

import { describe, expect, it } from 'vitest';
import type { LayerRowsChange, RowField, RowsChange } from '../../api/tables.js';
import type { StoreChange } from '../types.js';
import { ChangeBus, mergeRowsChanges } from './change-bus.js';

function rows(
  layerId: string,
  change: Partial<Record<'created' | 'updated' | 'deleted', number[]>> & {
    fields?: RowField[];
    styleKeys?: string[];
  },
): RowsChange {
  const entry: LayerRowsChange = {
    created: Int32Array.from(change.created ?? []),
    updated: Int32Array.from(change.updated ?? []),
    deleted: Int32Array.from(change.deleted ?? []),
    fields: new Set(change.fields ?? []),
    styleKeys: new Set(change.styleKeys ?? []),
  };
  return { layers: new Map([[layerId, entry]]) };
}

describe('the rows in the notifications of a transaction', () => {
  it('are one entry per row, a row created and deleted within it dropped', () => {
    const bus = new ChangeBus();
    const seen: StoreChange[] = [];
    bus.subscribe((change) => seen.push(change));
    bus.transact(() => {
      bus.merge({ rows: rows('a', { created: [1, 2], fields: ['geometry'] }) });
      bus.merge({
        rows: rows('a', { updated: [2, 3], fields: ['style'], styleKeys: ['fillColor'] }),
      });
      bus.merge({ rows: rows('a', { deleted: [1, 4] }) });
      bus.merge({ rows: rows('b', { updated: [9] }) });
    });
    expect(seen).toHaveLength(1);
    const a = seen[0].rows?.layers.get('a');
    expect(Array.from(a?.created ?? [])).toEqual([2]);
    expect(Array.from(a?.updated ?? [])).toEqual([3]);
    expect(Array.from(a?.deleted ?? [])).toEqual([4]);
    expect([...(a?.fields ?? [])]).toEqual(['geometry', 'style']);
    expect([...(a?.styleKeys ?? [])]).toEqual(['fillColor']);
    expect(Array.from(seen[0].rows?.layers.get('b')?.updated ?? [])).toEqual([9]);
  });

  it('fold many writes of rows of a transaction as the writes fold two by two, in time linear in them', () => {
    // A random sequence of writes of rows of two layers: the notification is the fold of the
    // writes two by two (mergeRowsChanges)
    let seed = 7;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const writes: RowsChange[] = [];
    for (let w = 0; w < 300; w++) {
      const pick = () => Array.from({ length: random(6) }, () => random(40));
      writes.push(
        rows(w % 3 === 0 ? 'b' : 'a', {
          created: pick(),
          updated: pick(),
          deleted: pick(),
          fields: random(2) ? ['geometry'] : ['style'],
          styleKeys: random(2) ? ['fillColor'] : [],
        }),
      );
    }
    const bus = new ChangeBus();
    const seen: StoreChange[] = [];
    bus.subscribe((change) => seen.push(change));
    bus.transact(() => {
      for (const write of writes) bus.merge({ rows: write });
    });
    const folded = writes.reduce((a, b) => mergeRowsChanges(a, b));
    const plain = (change: RowsChange | undefined) =>
      [...(change?.layers ?? [])].map(([layerId, entry]) => [
        layerId,
        [...entry.created],
        [...entry.updated],
        [...entry.deleted],
        [...entry.fields],
        [...entry.styleKeys],
      ]);
    expect(plain(seen[0]?.rows)).toEqual(plain(folded));
    // 100,000 rows deleted in writes of 500 (a layer deleted a batch at a time)
    const large = new ChangeBus();
    const started = performance.now();
    large.transact(() => {
      for (let w = 0; w < 200; w++) {
        large.merge({
          rows: rows('a', { deleted: Array.from({ length: 500 }, (_, i) => w * 500 + i) }),
        });
      }
    });
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe('a notification held for writes over several tasks', () => {
  /** A bus that holds the transaction it is in, and whose writes go on until finished */
  function heldBus() {
    const bus = new ChangeBus();
    const told: StoreChange[] = [];
    bus.subscribe((change) => told.push(change));
    let left = 2;
    const step = () =>
      bus.continueHeld(() => {
        bus.merge({ rows: rows('l', { created: [10 - left] }) });
        left--;
        if (left === 0) bus.release();
      });
    const finish = () => {
      while (left > 0) step();
    };
    bus.transact(() => {
      bus.merge({ rows: rows('l', { created: [7] }) });
      bus.hold(finish);
    }, 'undo');
    return { bus, told, step };
  }

  it('goes out once, with the source of its transaction, when let go of', () => {
    const { bus, told, step } = heldBus();
    expect(told).toHaveLength(0);
    expect(bus.held).toBe(true);
    step();
    expect(told).toHaveLength(0);
    step();
    expect(told).toHaveLength(1);
    expect(told[0]?.source).toBe('undo');
    expect(Array.from(told[0]?.rows?.layers.get('l')?.created ?? [])).toEqual([7, 8, 9]);
  });

  it('has the writes finished before another transaction, told before it', () => {
    const { bus, told } = heldBus();
    bus.transact(() => bus.merge({ metadata: { metadata: {}, previous: {} } }), 'local');
    expect(told.map((change) => change.source)).toEqual(['undo', 'local']);
    expect(told[0]?.rows?.layers.get('l')?.created.length).toBe(3);
    expect(told[1]?.rows).toBeUndefined();
  });

  it('has the writes finished before a change merged outside a transaction', () => {
    const { bus, told } = heldBus();
    bus.merge({ uiStateChanged: true });
    expect(told).toHaveLength(2);
    expect(told[0]?.source).toBe('undo');
    expect(told[1]?.uiStateChanged).toBe(true);
  });
});
