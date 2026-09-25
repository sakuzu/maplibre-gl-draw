// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mutation hooks
 *
 * Fires the after-mutation hooks of the plugins (feature / group / layer create, update and
 * delete, and the selection change) from the change notification of the Store. Every write
 * reaches the Store, so a hook sees every mutation whatever made it: the public API, a
 * drawing mode, a drag, the Delete key, import, a plugin, or a change applied from outside to
 * a replaced Store.
 *
 * The hooks run after the Store has changed, once per notification (one transaction), and
 * the hooks of one notification share its batchId and its source. The intermediate updates
 * of an edit in progress (isIntermediate) are not reported; the committing update that
 * follows them is.
 */

import type { Store } from '../store/store.js';
import type { Feature, StateChanges } from '../store/types.js';
import type { MutationContext } from './plugin.js';
import type { PluginManager } from './plugin-manager.js';

/**
 * Subscribes to the Store and fires the mutation hooks of the plugins
 *
 * @returns the function that stops it
 */
export function subscribeMutationHooks(store: Store, pluginManager: PluginManager): () => void {
  let notification = 0;
  return store.subscribe((changes) => {
    runMutationHooks(pluginManager, changes, {
      source: changes.source ?? 'local',
      batchId: `change_${++notification}`,
    });
  });
}

/**
 * Fires the mutation hooks for one change notification of the Store
 */
export function runMutationHooks(
  pluginManager: PluginManager,
  changes: StateChanges,
  ctx: MutationContext,
): void {
  const { features, groups, layers, selection } = changes;

  if (features) {
    if (features.created && features.created.length > 0) {
      pluginManager.runHook('feature:afterCreate', [...features.created], ctx);
    }
    const committed = foldCommittedUpdates(features.updated);
    if (committed.updated.length > 0) {
      pluginManager.runHook('feature:afterUpdate', committed.updated, committed.original, ctx);
    }
    if (features.deleted && features.deleted.length > 0) {
      pluginManager.runHook('feature:afterDelete', [...features.deleted], ctx);
    }
  }

  if (groups) {
    for (const group of groups.created ?? []) {
      pluginManager.runHook('group:afterCreate', group, ctx);
    }
    for (const entry of groups.updated ?? []) {
      pluginManager.runHook('group:afterUpdate', entry.group, entry.previous, ctx);
    }
    for (const group of groups.deleted ?? []) {
      pluginManager.runHook('group:afterDelete', group, ctx);
    }
  }

  if (layers) {
    for (const layer of layers.created ?? []) {
      pluginManager.runHook('layer:afterCreate', layer, ctx);
    }
    for (const entry of layers.updated ?? []) {
      pluginManager.runHook('layer:afterUpdate', entry.layer, entry.previous, ctx);
    }
    for (const layer of layers.deleted ?? []) {
      pluginManager.runHook('layer:afterDelete', layer, ctx);
    }
  }

  if (selection) {
    pluginManager.runHook(
      'selection:afterChange',
      [...selection.ids],
      [...selection.previousIds],
      ctx,
    );
  }
}

type FeatureUpdates = NonNullable<StateChanges['features']>['updated'];

/**
 * Folds the committed updates of one notification into one entry per feature (the last
 * state, and the state before the first update), in the order of their first update
 */
function foldCommittedUpdates(updates: FeatureUpdates): {
  updated: Feature[];
  original: Feature[];
} {
  const byId = new Map<string, { feature: Feature; previous: Feature }>();
  for (const entry of updates ?? []) {
    if (entry.isIntermediate) continue;
    const existing = byId.get(entry.id);
    if (existing) {
      existing.feature = entry.feature;
    } else {
      byId.set(entry.id, { feature: entry.feature, previous: entry.previous });
    }
  }
  const updated: Feature[] = [];
  const original: Feature[] = [];
  for (const { feature, previous } of byId.values()) {
    updated.push(feature);
    original.push(previous);
  }
  return { updated, original };
}
