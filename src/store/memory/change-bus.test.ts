// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows held as columns in the notifications of a transaction: one entry per row, a row
 * created and deleted within the transaction dropped, the fields and the keys of the styles
 * gathered. The features, layers, groups and rows deleted and created again within a transaction
 * are told as updated, by what was there before it and what is there after it
 */

import { describe, expect, it } from 'vitest';
import type { LayerRowsChange, RowField, RowsChange } from '../../api/tables.js';
import type { Feature, Group, Layer, StoreChange } from '../types.js';
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

describe('the rows of a transaction whose writes only create rows', () => {
  const plain = (change: RowsChange | undefined) =>
    [...(change?.layers ?? [])].map(([layerId, entry]) => [
      layerId,
      [...entry.created],
      [...entry.updated],
      [...entry.deleted],
      [...entry.fields],
      [...entry.styleKeys],
    ]);
  const told = (writes: RowsChange[]): StoreChange => {
    const bus = new ChangeBus();
    const seen: StoreChange[] = [];
    bus.subscribe((change) => seen.push(change));
    bus.transact(() => {
      for (const write of writes) bus.merge({ rows: write });
    });
    expect(seen).toHaveLength(1);
    return seen[0];
  };

  it('are the rows created, each once in the order they first come, the fields and keys gathered', () => {
    const change = told([
      rows('a', { created: [5, 3, 5], fields: ['geometry'] }),
      rows('b', { created: [1] }),
      rows('a', { created: [3, 7, 2], fields: ['style'], styleKeys: ['fillColor'] }),
    ]);
    expect(plain(change.rows)).toEqual([
      ['a', [5, 3, 7, 2], [], [], ['geometry', 'style'], ['fillColor']],
      ['b', [1], [], [], [], []],
    ]);
  });

  it('are each once for rows of large numbers too', () => {
    const big = 2_000_000_000;
    const change = told([rows('a', { created: [big, 4, big] }), rows('a', { created: [4, 9] })]);
    expect(plain(change.rows)).toEqual([['a', [big, 4, 9], [], [], [], []]]);
  });

  it('fold as the writes fold two by two once a write does more than create', () => {
    let seed = 11;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let run = 0; run < 50; run++) {
      const writes: RowsChange[] = [];
      const pick = () => Array.from({ length: random(6) }, () => random(30));
      // Writes that only create rows, then any writes
      const creating = 1 + random(4);
      for (let w = 0; w < creating; w++) {
        writes.push(rows('a', { created: pick(), fields: random(2) ? ['geometry'] : [] }));
      }
      for (let w = 0; w < random(4); w++) {
        writes.push(
          rows('a', {
            created: pick(),
            updated: pick(),
            deleted: pick(),
            fields: random(2) ? ['style'] : ['geometry'],
            styleKeys: random(2) ? ['fillColor'] : [],
          }),
        );
      }
      const folded = writes.reduce((a, b) => mergeRowsChanges(a, b));
      const change = told(writes);
      if (writes.length > 1) {
        expect(plain(change.rows)).toEqual(plain(folded));
      } else {
        // One write: its rows each once
        const entry = writes[0].layers.get('a') as LayerRowsChange;
        expect([...(change.rows?.layers.get('a')?.created ?? [])]).toEqual([
          ...new Set(entry.created),
        ]);
      }
    }
  });

  it('take 100,000 rows created in writes of 1,000 in time linear in them', () => {
    const bus = new ChangeBus();
    const seen: StoreChange[] = [];
    bus.subscribe((change) => seen.push(change));
    const started = performance.now();
    bus.transact(() => {
      for (let w = 0; w < 100; w++) {
        bus.merge({
          rows: rows('a', { created: Array.from({ length: 1000 }, (_, i) => w * 1000 + i) }),
        });
      }
    });
    expect(performance.now() - started).toBeLessThan(100);
    const created = seen[0].rows?.layers.get('a')?.created;
    expect(created?.length).toBe(100_000);
    expect(created?.[0]).toBe(0);
    expect(created?.[99_999]).toBe(99_999);
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

/** The rows of the layers of a notification, as plain lists */
function plainRows(change: StoreChange | undefined) {
  return [...(change?.rows?.layers ?? [])].map(([layerId, entry]) => [
    layerId,
    [...entry.created],
    [...entry.updated],
    [...entry.deleted],
  ]);
}

/** The one notification of a transaction of the writes given */
function toldOf(write: (bus: ChangeBus) => void): StoreChange {
  const bus = new ChangeBus();
  const seen: StoreChange[] = [];
  bus.subscribe((change) => seen.push(change));
  bus.transact(() => write(bus));
  expect(seen).toHaveLength(1);
  return seen[0];
}

describe('the rows of a transaction deleted and created again', () => {
  it('are updated when deleted and created again, in their layer', () => {
    const change = toldOf((bus) => {
      bus.merge({ rows: rows('a', { deleted: [1, 2] }) });
      bus.merge({ rows: rows('a', { created: [1], fields: ['geometry'] }) });
    });
    expect(plainRows(change)).toEqual([['a', [], [1], [2]]]);
    expect([...(change.rows?.layers.get('a')?.fields ?? [])]).toEqual(['geometry']);
  });

  it('are updated in the layer they are created again in, when deleted from another one', () => {
    const change = toldOf((bus) => {
      bus.merge({ rows: rows('a', { deleted: [1, 2] }) });
      bus.merge({ rows: rows('b', { created: [1, 3], fields: ['geometry'] }) });
    });
    expect(plainRows(change)).toEqual([
      ['a', [], [], [2]],
      ['b', [3], [1], []],
    ]);
  });

  it('are deleted when deleted, created and deleted again, and created when created, deleted and created again', () => {
    const change = toldOf((bus) => {
      bus.merge({ rows: rows('a', { deleted: [1], created: [5] }) });
      bus.merge({ rows: rows('a', { created: [1], deleted: [5] }) });
      bus.merge({ rows: rows('a', { deleted: [1], created: [5] }) });
    });
    expect(plainRows(change)).toEqual([['a', [5], [], [1]]]);
  });

  it('are updated when updated, deleted, created again and updated, and dropped when created, updated and deleted', () => {
    const change = toldOf((bus) => {
      bus.merge({ rows: rows('a', { updated: [1], created: [5] }) });
      bus.merge({ rows: rows('a', { deleted: [1], updated: [5] }) });
      bus.merge({ rows: rows('a', { created: [1], deleted: [5] }) });
      bus.merge({ rows: rows('a', { updated: [1] }) });
    });
    expect(plainRows(change)).toEqual([['a', [], [1], []]]);
  });

  it('fold as the writes fold two by two', () => {
    const writes = [
      rows('a', { created: [7], deleted: [1] }),
      rows('b', { created: [1, 2] }),
      rows('a', { deleted: [7] }),
      rows('b', { deleted: [2] }),
    ];
    const change = toldOf((bus) => {
      for (const write of writes) bus.merge({ rows: write });
    });
    expect(plainRows(change)).toEqual(plainRows({ rows: writes.reduce(mergeRowsChanges) }));
    expect(plainRows(change)).toEqual([
      ['a', [], [], []],
      ['b', [], [1], []],
    ]);
  });
});

const feature = (id: string, name: string): Feature => ({
  id,
  type: 'Point',
  geometry: { type: 'Point', coordinates: [0, 0] },
  layerId: 'l',
  groupId: undefined,
  properties: { name },
  style: {},
  visible: true,
  locked: false,
});

const layer = (id: string, name: string): Layer => ({
  id,
  name,
  visible: true,
  locked: false,
  opacity: 1,
  items: [],
  metadata: undefined,
  styleRule: undefined,
});

const group = (id: string, name: string): Group => ({
  id,
  layerId: 'l',
  name,
  visible: true,
  locked: false,
  featureIds: [],
});

describe('the features, layers and groups of a transaction deleted and created again', () => {
  it('are told as updated, from what they were before it to what they are after it', () => {
    const [f1, f2] = [feature('f', 'before'), feature('f', 'after')];
    const [l1, l2] = [layer('l', 'before'), layer('l', 'after')];
    const [g1, g2] = [group('g', 'before'), group('g', 'after')];
    const change = toldOf((bus) => {
      bus.merge({
        features: { deleted: [f1] },
        layers: { deleted: [l1] },
        groups: { deleted: [g1] },
      });
      bus.merge({ layers: { created: [l2] } });
      bus.merge({ features: { created: [f2] }, groups: { created: [g2] } });
    });
    expect(change.features).toEqual({ updated: [{ id: 'f', feature: f2, previous: f1 }] });
    expect(change.layers).toEqual({ updated: [{ id: 'l', layer: l2, previous: l1 }] });
    expect(change.groups).toEqual({ updated: [{ id: 'g', group: g2, previous: g1 }] });
  });

  it('take what they were before the first write of them and what they are after the last one', () => {
    const f = ['first', 'second', 'third', 'last'].map((name) => feature('f', name));
    const l = ['first', 'second', 'third', 'last'].map((name) => layer('l', name));
    const change = toldOf((bus) => {
      bus.merge({ features: { updated: [{ id: 'f', feature: f[1], previous: f[0] }] } });
      bus.mergeLayerUpdate(l[1], l[0]);
      bus.merge({ features: { deleted: [f[1]] }, layers: { deleted: [l[1]] } });
      bus.merge({ features: { created: [f[2]] }, layers: { created: [l[2]] } });
      // An update of the layer created again is an entry of its own, from what it was created
      expect(bus.hasPendingLayerUpdate('l')).toBe(false);
      bus.merge({ features: { updated: [{ id: 'f', feature: f[3], previous: f[2] }] } });
      bus.mergeLayerUpdate(l[3], l[2]);
    });
    expect(change.features).toEqual({ updated: [{ id: 'f', feature: f[3], previous: f[0] }] });
    expect(change.layers).toEqual({ updated: [{ id: 'l', layer: l[3], previous: l[0] }] });
  });

  it('are deleted when deleted, created and deleted again, and created when created, deleted and created again', () => {
    const [a1, a2] = [feature('a', 'first'), feature('a', 'again')];
    const [b1, b2] = [feature('b', 'first'), feature('b', 'again')];
    const other = feature('c', 'other');
    const change = toldOf((bus) => {
      bus.merge({ features: { updated: [{ id: 'a', feature: a1, previous: a1 }] } });
      bus.merge({ features: { deleted: [a1], created: [b1] } });
      bus.merge({
        features: { created: [a2], updated: [{ id: 'c', feature: other, previous: other }] },
      });
      bus.merge({ features: { deleted: [a2, b1] } });
      bus.merge({ features: { created: [b2] } });
      bus.merge({ features: { updated: [{ id: 'b', feature: b2, previous: b2 }] } });
    });
    expect(change.features).toEqual({
      created: [b2],
      updated: [
        { id: 'a', feature: a1, previous: a1 },
        { id: 'c', feature: other, previous: other },
        { id: 'b', feature: b2, previous: b2 },
      ],
      deleted: [a1],
    });
  });

  it('are not told when created and deleted again', () => {
    const change = toldOf((bus) => {
      bus.merge({ layers: { created: [layer('l', 'l')] }, groups: { created: [group('g', 'g')] } });
      bus.merge({ features: { created: [feature('f', 'f')] } });
      bus.merge({ features: { deleted: [feature('f', 'f')] } });
      bus.merge({ layers: { deleted: [layer('l', 'l')] }, groups: { deleted: [group('g', 'g')] } });
      bus.merge({ uiStateChanged: true });
    });
    expect(change.features).toBeUndefined();
    expect(change.layers).toBeUndefined();
    expect(change.groups).toBeUndefined();
  });

  it('are told as they came when one change merged both their creation and their deletion', () => {
    // The order of the two is not known: a Store given in the options may tell them so
    const [f1, f2] = [feature('f', 'one'), feature('f', 'two')];
    const change = toldOf((bus) => {
      bus.merge({ features: { created: [f2], deleted: [f1] } });
    });
    expect(change.features).toEqual({ created: [f2], deleted: [f1] });
  });

  it('tell nothing when nothing else is told', () => {
    const bus = new ChangeBus();
    const seen: StoreChange[] = [];
    bus.subscribe((change) => seen.push(change));
    bus.transact(() => {
      bus.merge({ features: { created: [feature('f', 'f')] } });
      bus.merge({ features: { deleted: [feature('f', 'f')] } });
    });
    expect(seen).toEqual([]);
  });

  it('settle 100,000 features deleted and created again in time linear in them', () => {
    const before = Array.from({ length: 100_000 }, (_, i) => feature(`f${i}`, 'before'));
    const after = before.map((f) => feature(f.id, 'after'));
    const started = performance.now();
    const change = toldOf((bus) => {
      bus.merge({ features: { deleted: before } });
      bus.merge({ features: { created: after } });
    });
    expect(performance.now() - started).toBeLessThan(500);
    expect(change.features?.created).toBeUndefined();
    expect(change.features?.deleted).toBeUndefined();
    expect(change.features?.updated?.length).toBe(100_000);
    expect(change.features?.updated?.[99_999]).toEqual({
      id: 'f99999',
      feature: after[99_999],
      previous: before[99_999],
    });
  });
});

describe('the stacking order of the layers changed many times in a transaction', () => {
  it('is told from the order before the first change to the order after the last one', () => {
    const change = toldOf((bus) => {
      bus.merge({ layers: { orderChanged: { order: ['a', 'b', 'c'], previous: ['a', 'b'] } } });
      bus.merge({
        layers: { orderChanged: { order: ['c', 'a', 'b'], previous: ['a', 'b', 'c'] } },
      });
      bus.merge({
        layers: { orderChanged: { order: ['c', 'b', 'a'], previous: ['c', 'a', 'b'] } },
      });
    });
    expect(change.layers?.orderChanged).toEqual({
      order: ['c', 'b', 'a'],
      previous: ['a', 'b'],
    });
  });

  it('is told as it came when it changed once', () => {
    const once = { order: ['b', 'a'], previous: ['a', 'b'] };
    const change = toldOf((bus) => bus.merge({ layers: { orderChanged: once } }));
    expect(change.layers?.orderChanged).toEqual(once);
  });
});

describe('the metadata changed many times in a transaction', () => {
  it('is told from the metadata before the first change to the metadata after the last one', () => {
    const change = toldOf((bus) => {
      bus.merge({ metadata: { metadata: { title: 'b' }, previous: { title: 'a' } } });
      bus.merge({ metadata: { metadata: { title: 'c' }, previous: { title: 'b' } } });
      bus.merge({ metadata: { metadata: { title: 'd' }, previous: { title: 'c' } } });
    });
    expect(change.metadata).toEqual({ metadata: { title: 'd' }, previous: { title: 'a' } });
  });

  it('is told as it came when it changed once', () => {
    const once = { metadata: { title: 'b' }, previous: { title: 'a' } };
    const change = toldOf((bus) => bus.merge({ metadata: once }));
    expect(change.metadata).toEqual(once);
  });
});
