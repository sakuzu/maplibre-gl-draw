// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a move goes, and the writes that move features and groups there
 *
 * A move is one transaction. The features and groups keep their stacking order among
 * themselves, and `index` is their position within the destination once they have left it.
 */

import type { Store } from '../../../store/store.js';
import type { Feature, Group, Layer } from '../../../store/types.js';
import type { MoveTarget } from '../model.js';
import {
  groupLocked,
  invalidInput,
  isRecord,
  notFound,
  optionalIndex,
  requireId,
} from './shared.js';

/**
 * A resolved move target
 *
 * - `layer`: the layer, as items of their own
 * - `group`: into the group
 * - `ungroup`: out of their group, staying in their layer
 *
 * @internal
 */
export type ResolvedTarget =
  | { kind: 'layer'; layer: Layer; index: number | undefined; locked: boolean }
  | { kind: 'group'; group: Group; index: number | undefined; locked: boolean }
  | { kind: 'ungroup'; index: number | undefined; locked: false };

/**
 * Checks a move target and looks up what it names
 *
 * @throws DrawError `invalid-input` for a target of the wrong shape, `not-found` for a layer
 *   or a group that does not exist
 * @internal
 */
export function resolveMoveTarget(store: Store, to: MoveTarget): ResolvedTarget {
  if (!isRecord(to)) throw invalidInput('The target must be an object');
  const hasLayer = 'layerId' in to;
  const hasGroup = 'groupId' in to;
  if (hasLayer === hasGroup) {
    throw invalidInput('The target must have either layerId or groupId');
  }
  const index = optionalIndex(to.index);
  if (hasLayer) {
    const layerId = requireId(to.layerId, 'layerId');
    const layer = store.getLayer(layerId);
    if (!layer) throw notFound('layer', layerId);
    return { kind: 'layer', layer, index, locked: layer.locked };
  }
  if (to.groupId === null) return { kind: 'ungroup', index, locked: false };
  const groupId = requireId(to.groupId, 'groupId');
  const group = store.getGroup(groupId);
  if (!group) throw notFound('group', groupId);
  return { kind: 'group', group, index, locked: groupLocked(store, group) };
}

/** Inserts the IDs into the list at the index, or at the end when it is undefined */
function insertAt(list: string[], ids: readonly string[], index: number | undefined): string[] {
  const at = index === undefined ? list.length : Math.min(index, list.length);
  list.splice(at, 0, ...ids);
  return list;
}

/**
 * Moves features to a target, in one transaction
 *
 * @param features The features, in stacking order
 * @internal
 */
export function moveFeatures(store: Store, features: Feature[], target: ResolvedTarget): void {
  const ids = features.map((feature) => feature.id);
  const moved = new Set(ids);
  store.transact(() => {
    if (target.kind === 'layer') {
      const layerId = target.layer.id;
      for (const feature of features) {
        if (feature.layerId !== layerId || feature.groupId !== undefined) {
          store.updateFeature(feature.id, { layerId, groupId: undefined });
        }
      }
      const items = (store.getLayer(layerId)?.items ?? []).filter((id) => !moved.has(id));
      store.updateLayer(layerId, { items: insertAt(items, ids, target.index) });
      return;
    }

    if (target.kind === 'group') {
      const { group } = target;
      for (const feature of features) {
        if (feature.groupId !== group.id) {
          store.updateFeature(feature.id, { layerId: group.layerId, groupId: group.id });
        }
      }
      const featureIds = (store.getGroup(group.id)?.featureIds ?? []).filter(
        (id) => !moved.has(id),
      );
      store.updateGroup(group.id, { featureIds: insertAt(featureIds, ids, target.index) });
      return;
    }

    // Out of their groups: each feature stays in its layer
    const byLayer = new Map<string, Feature[]>();
    for (const feature of features) {
      const list = byLayer.get(feature.layerId) ?? [];
      list.push(feature);
      byLayer.set(feature.layerId, list);
    }
    for (const [layerId, inLayer] of byLayer) {
      const before = [...(store.getLayer(layerId)?.items ?? [])];
      const blocks = new Map<string, string[]>();
      for (const feature of inLayer) {
        if (feature.groupId === undefined) continue;
        const block = blocks.get(feature.groupId) ?? [];
        block.push(feature.id);
        blocks.set(feature.groupId, block);
      }
      for (const feature of inLayer) {
        if (feature.groupId !== undefined) store.updateFeature(feature.id, { groupId: undefined });
      }
      let items: string[];
      if (target.index === undefined) {
        // Just in front of their group, or in its place when it was left empty and deleted
        items = [];
        for (const itemId of before) {
          if (!blocks.has(itemId) || store.getGroup(itemId)) items.push(itemId);
          items.push(...(blocks.get(itemId) ?? []));
        }
      } else {
        const layerIds = inLayer.map((feature) => feature.id);
        const inThisLayer = new Set(layerIds);
        items = (store.getLayer(layerId)?.items ?? []).filter((id) => !inThisLayer.has(id));
        insertAt(items, layerIds, target.index);
      }
      store.updateLayer(layerId, { items });
    }
  });
}

/**
 * Moves groups to a layer, in one transaction
 *
 * @param groups The groups, in stacking order
 * @internal
 */
export function moveGroups(store: Store, groups: Group[], layer: Layer, index?: number): void {
  const ids = groups.map((group) => group.id);
  const moved = new Set(ids);
  store.transact(() => {
    for (const group of groups) {
      if (group.layerId === layer.id) continue;
      const source = store.getLayer(group.layerId);
      if (source) {
        store.updateLayer(source.id, { items: source.items.filter((id) => id !== group.id) });
      }
      for (const featureId of group.featureIds) {
        store.updateFeature(featureId, { layerId: layer.id });
      }
    }
    const items = (store.getLayer(layer.id)?.items ?? []).filter((id) => !moved.has(id));
    store.updateLayer(layer.id, { items: insertAt(items, ids, index) });
  });
}
