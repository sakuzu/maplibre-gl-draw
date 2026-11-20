// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A nested transaction that gives `hasMoreParts: true` makes the change of the transaction a
 * part that more follow, whatever the outermost call gave; the number of the operation and
 * `stopped` stay those of the outermost call
 */

import { describe, expect, it } from 'vitest';
import type { Layer } from '../../api/model.js';
import { createStore } from './create-store.js';
import type { Store, StoreChange } from './types.js';

const layer = (id: string): Layer => ({
  id,
  name: id,
  visible: true,
  locked: false,
  opacity: 1,
  styleRule: undefined,
  metadata: undefined,
});

/** The changes the Store tells from now on */
function record(store: Store): StoreChange[] {
  const out: StoreChange[] = [];
  store.subscribe((change) => out.push(change));
  return out;
}

describe('a nested transaction that gives hasMoreParts: true', () => {
  it('makes the change a part that more follow when the outer call gave no options', () => {
    const store = createStore();
    const changes = record(store);
    const ignored = store.newOperationId();
    store.transact(() => {
      store.createLayer(layer('a'));
      store.transact(() => store.createLayer(layer('b')), 'local', {
        operationId: ignored,
        hasMoreParts: true,
        stopped: true,
      });
    }, 'local');
    expect(changes).toHaveLength(1);
    expect(changes[0].hasMoreParts).toBe(true);
    // The number and stopped are those of the outer call
    expect(changes[0].operationId).not.toBe(ignored);
    expect(changes[0].stopped).toBe(false);
    expect(changes[0].layers?.created?.map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('makes it so over the hasMoreParts: false of the outer call, and a later part ends it', () => {
    const store = createStore();
    const changes = record(store);
    const operationId = store.newOperationId();
    store.transact(
      () => {
        store.createLayer(layer('a'));
        store.transact(() => {}, 'local', { hasMoreParts: true });
      },
      'local',
      { operationId, hasMoreParts: false },
    );
    store.transact(() => store.createLayer(layer('b')), 'local', { operationId });
    expect(changes.map((c) => [c.operationId, c.hasMoreParts])).toEqual([
      [operationId, true],
      [operationId, false],
    ]);
  });

  it('leaves the change as it is for a nested call that gives hasMoreParts: false', () => {
    const store = createStore();
    const changes = record(store);
    const operationId = store.newOperationId();
    store.transact(
      () => {
        store.createLayer(layer('a'));
        store.transact(() => store.createLayer(layer('b')), 'local', { hasMoreParts: false });
      },
      'local',
      { operationId, hasMoreParts: true },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].hasMoreParts).toBe(true);
  });

  it('tells the last part of an operation whose number the Store gave, even with nothing in it', () => {
    const store = createStore();
    const changes = record(store);
    store.transact(() => {
      store.createLayer(layer('a'));
      store.transact(() => {}, 'local', { hasMoreParts: true });
    }, 'local');
    const [first] = changes;
    store.transact(() => {}, 'local', { operationId: first.operationId });
    expect(changes.map((c) => [c.operationId, c.hasMoreParts])).toEqual([
      [first.operationId, true],
      [first.operationId, false],
    ]);
  });
});
