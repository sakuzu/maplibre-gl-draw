// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.editingFeatures`: the features this client marks as being edited
 */

import type { EditingFeaturesResource } from '../model.js';
import { makeIdSet } from './id-set.js';
import type { ResourceDeps } from './shared.js';
import { notFound, requireIds } from './shared.js';

/**
 * Creates `draw.editingFeatures`
 *
 * The marks are the state of this client, held by the instance, so read-only and the locks do
 * not refuse them. A feature deleted leaves them, and the select mode, when it is entered, tells
 * the marked features to the plugins and takes the marks off (see `SelectMode`).
 *
 * @internal
 */
export function createEditingFeatures(deps: Pick<ResourceDeps, 'store'>): EditingFeaturesResource {
  const { store } = deps;
  const { client } = store;
  return {
    get: () => makeIdSet(client.getEditingIds()),
    add(ids) {
      const list = requireIds(ids);
      // All of them or none
      for (const id of list) {
        if (!store.getFeature(id)) throw notFound('feature', id);
      }
      client.startEditing(list);
    },
    remove(ids) {
      client.endEditing(requireIds(ids));
    },
  };
}
