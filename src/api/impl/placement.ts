// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a move goes, and the writes that move features and groups there
 *
 * A move is one transaction. The features and groups keep their stacking order among
 * themselves, and go one after the other to the place of the target (`Store.moveItems`): the
 * items just below and above it, or `index`, their position within the destination once they
 * have left it (a layer of objects only).
 */

import { itemNeighbors, placeAtIndex } from '../../store/item-lists.js';
import type { Store } from '../../store/store.js';
import type { Feature, Group, ItemPlacement, Layer } from '../../store/types.js';
import type { MoveTarget } from '../model.js';
import {
  groupLocked,
  invalidInput,
  invalidState,
  isRecord,
  layerLocked,
  notFound,
  optionalIndex,
  requireId,
} from './shared.js';

/**
 * Where in the destination: a position, or the items just below and above
 *
 * @internal
 */
export type PlaceRequest =
  | { index: number | undefined }
  | { below?: string | null; above?: string | null };

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
  | { kind: 'layer'; layer: Layer; place: PlaceRequest; locked: boolean }
  | { kind: 'group'; group: Group; place: PlaceRequest; locked: boolean }
  | { kind: 'ungroup'; index: number | undefined; locked: false };

/** An optional item of a place: an ID, null, or nothing */
function optionalNeighbor(value: unknown, name: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  return requireId(value, name);
}

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
  // A place named by the items around it: `{ layerId, groupId?, below?, above? }`
  if (hasLayer && ('below' in to || 'above' in to || hasGroup)) {
    const placement = to as ItemPlacement & { index?: unknown };
    if (placement.index !== undefined) {
      throw invalidInput('A place is named by an index or by the items around it, not both');
    }
    const layerId = requireId(placement.layerId, 'layerId');
    const layer = store.getLayer(layerId);
    if (!layer) throw notFound('layer', layerId);
    const place = {
      below: optionalNeighbor(placement.below, 'below'),
      above: optionalNeighbor(placement.above, 'above'),
    };
    if (placement.groupId === undefined) {
      return { kind: 'layer', layer, place, locked: layerLocked(store, layer) };
    }
    const groupId = requireId(placement.groupId, 'groupId');
    const group = store.getGroup(groupId);
    if (!group) throw notFound('group', groupId);
    if (group.layerId !== layerId) {
      throw invalidInput(`The group ${groupId} is not in the layer ${layerId}`);
    }
    return { kind: 'group', group, place, locked: groupLocked(store, group) };
  }
  if (hasLayer === hasGroup) {
    throw invalidInput('The target must have either layerId or groupId');
  }
  const index = optionalIndex((to as { index?: unknown }).index);
  if (hasLayer) {
    const layerId = requireId((to as { layerId: unknown }).layerId, 'layerId');
    const layer = store.getLayer(layerId);
    if (!layer) throw notFound('layer', layerId);
    return { kind: 'layer', layer, place: { index }, locked: layerLocked(store, layer) };
  }
  const target = to as { groupId: unknown };
  if (target.groupId === null) return { kind: 'ungroup', index, locked: false };
  const groupId = requireId(target.groupId, 'groupId');
  const group = store.getGroup(groupId);
  if (!group) throw notFound('group', groupId);
  return { kind: 'group', group, place: { index }, locked: groupLocked(store, group) };
}

/**
 * The place of a target in a layer or a group, by the items around it
 *
 * @throws DrawError `invalid-state` for a position by index in a layer held as rows
 */
function placementOf(
  store: Store,
  layerId: string,
  groupId: string | undefined,
  place: PlaceRequest,
  moving: ReadonlySet<string>,
): ItemPlacement {
  if (!('index' in place)) return { layerId, groupId, ...place };
  // The front, when no position is given
  if (place.index === undefined) return { layerId, groupId, above: null };
  if (store.getLayer(layerId)?.kind === 'table') {
    throw invalidState(
      'A layer held as rows takes a place by the items around it ({ below, above }), not an index',
    );
  }
  return { layerId, groupId, ...placeAtIndex(store, layerId, groupId, place.index, moving) };
}

/**
 * Moves features to a target, in one transaction
 *
 * @param features The features, in stacking order
 * @internal
 */
export function moveFeatures(store: Store, features: Feature[], target: ResolvedTarget): void {
  const ids = features.map((feature) => feature.id);
  const moving = new Set(ids);
  store.transact(() => {
    if (target.kind === 'layer') {
      const layerId = target.layer.id;
      store.moveItems(ids, placementOf(store, layerId, undefined, target.place, moving));
      return;
    }

    if (target.kind === 'group') {
      const { group } = target;
      store.moveItems(ids, placementOf(store, group.layerId, group.id, target.place, moving));
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
      if (target.index !== undefined) {
        const layerIds = inLayer.map((feature) => feature.id);
        const place = placementOf(store, layerId, undefined, { index: target.index }, moving);
        store.moveItems(layerIds, place);
        continue;
      }
      // Just in front of their group, or in its place when it was left empty and deleted
      const blocks = new Map<string, string[]>();
      for (const feature of inLayer) {
        if (feature.groupId === undefined) continue;
        const block = blocks.get(feature.groupId) ?? [];
        block.push(feature.id);
        blocks.set(feature.groupId, block);
      }
      for (const [groupId, block] of blocks) {
        const around = itemNeighbors(store, layerId, undefined, groupId);
        store.moveItems(block, { layerId, below: groupId, above: around?.above ?? null });
      }
    }
  });
}

/**
 * Moves groups to a layer, in one transaction
 *
 * @param groups The groups, in stacking order
 * @internal
 */
export function moveGroups(
  store: Store,
  groups: Group[],
  layer: Layer,
  place: PlaceRequest = { index: undefined },
): void {
  const ids = groups.map((group) => group.id);
  store.transact(() => {
    store.moveItems(ids, placementOf(store, layer.id, undefined, place, new Set(ids)));
  });
}
