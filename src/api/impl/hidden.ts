// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.hidden`: what this client hides without changing the document
 */

import type { HiddenCollection } from '../hidden.js';
import { makeIdSet } from './id-set.js';
import type { ResourceDeps } from './shared.js';
import { isTaken, notFound, requireIds } from './shared.js';

/**
 * Creates `draw.hidden`
 *
 * Hiding is local to this client, so read-only and the locks do not refuse it.
 *
 * @internal
 */
export function createHidden(deps: Pick<ResourceDeps, 'store'>): HiddenCollection {
  const { store } = deps;
  // What this client hides is the state of this client, held by the instance
  const { client } = store;

  /** Throws unless every ID names a feature, a group or a layer of the document */
  const requireItems = (ids: unknown): string[] => {
    const list = requireIds(ids);
    for (const id of list) {
      if (!isTaken(store, id)) throw notFound('feature, group or layer', id);
    }
    return list;
  };

  const removeMany = (ids: readonly string[]): boolean => {
    const hidden = requireItems(ids).filter((id) => client.isHidden(id));
    if (hidden.length === 0) return false;
    store.transact(() => {
      for (const id of hidden) client.setLocallyHidden(id, false);
    });
    return true;
  };

  return {
    get: (id) => client.isHidden(id),
    list: () => makeIdSet(client.listHidden()),
    count: () => client.listHidden().size,
    has: (id) => client.isHidden(id),
    add(id) {
      const [item] = requireItems([id]);
      client.setLocallyHidden(item, true);
    },
    addMany(ids) {
      const items = requireItems(ids);
      store.transact(() => {
        for (const id of items) client.setLocallyHidden(id, true);
      });
    },
    remove: (id) => removeMany([id]),
    removeMany,
    clear() {
      const hidden = [...client.listHidden()];
      if (hidden.length === 0) return;
      store.transact(() => {
        for (const id of hidden) client.setLocallyHidden(id, false);
      });
    },
  };
}
