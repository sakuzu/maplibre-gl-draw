// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Items put in a place by the lists of the layers and the groups
 *
 * A layer of objects lists its items and a group its members: putting items in a place
 * (`moveItems`) takes them to the layer and the group of the place, then writes the list of the
 * place with them where they go. The Store of objects of core does so, and so does the Store of
 * core over a Store given by a host that does not put items in a place itself.
 */

import type { Feature, Group, ItemPlacement, Layer } from './types.js';

/**
 * What putting items in a place by the lists reads and writes
 *
 * @internal
 */
export interface ListStore {
  getFeature(id: string): Feature | undefined;
  getGroup(id: string): Group | undefined;
  getLayer(id: string): Layer | undefined;
  updateFeature(id: string, updates: Partial<Feature>): unknown;
  updateLayer(id: string, updates: Partial<Layer>): unknown;
  updateGroup(id: string, updates: Partial<Group>): unknown;
}

/**
 * The place in a list, without the items put there, where they go: just above `below`, or just
 * below `above` when `below` is left out or not in the list, at the back for a `below` of null and
 * at the front for an `above` of null; at the front when neither decides
 *
 * @internal
 */
export function placeIndex(
  list: readonly string[],
  to: Pick<ItemPlacement, 'below' | 'above'>,
): number {
  if (to.below === null) return 0;
  if (to.below !== undefined) {
    const at = list.indexOf(to.below);
    if (at >= 0) return at + 1;
  }
  if (to.above === null || to.above === undefined) return list.length;
  const at = list.indexOf(to.above);
  return at >= 0 ? at : list.length;
}

/**
 * Checks a place and the items put there
 *
 * @returns The group of the place (undefined for a place in a layer)
 * @throws when the layer or the group of the place does not exist, the group is not in the layer,
 *   an item does not exist, or a group is put into a group
 * @internal
 */
export function checkPlacement(
  store: Pick<ListStore, 'getFeature' | 'getGroup' | 'getLayer'>,
  itemIds: readonly string[],
  to: ItemPlacement,
): Group | undefined {
  if (!store.getLayer(to.layerId)) throw new Error(`Layer with id "${to.layerId}" not found`);
  const group = to.groupId === undefined ? undefined : store.getGroup(to.groupId);
  if (to.groupId !== undefined && !group)
    throw new Error(`Group with id "${to.groupId}" not found`);
  if (group && group.layerId !== to.layerId) {
    throw new Error(`The group "${group.id}" is not in the layer "${to.layerId}"`);
  }
  for (const id of itemIds) {
    if (store.getFeature(id)) continue;
    if (!store.getGroup(id)) throw new Error(`Item with id "${id}" not found`);
    if (group) throw new Error(`The group "${id}" cannot go into the group "${group.id}"`);
  }
  return group;
}

/**
 * Puts items in a place by the lists of the layers and the groups (see the module)
 *
 * @throws as {@link checkPlacement}, and when the layer of the place is held as rows
 * @internal
 */
export function moveItemsByLists(
  store: ListStore,
  itemIds: readonly string[],
  to: ItemPlacement,
): void {
  const ids = [...new Set(itemIds)];
  const group = checkPlacement(store, ids, to);
  const moving = new Set(ids);
  // The items go to the layer and the group of the place
  for (const id of ids) {
    const feature = store.getFeature(id);
    if (feature) {
      if (feature.layerId !== to.layerId || (feature.groupId ?? undefined) !== to.groupId) {
        store.updateFeature(id, { layerId: to.layerId, groupId: to.groupId });
      }
      continue;
    }
    const moved = store.getGroup(id) as Group;
    if (moved.layerId === to.layerId) continue;
    const source = store.getLayer(moved.layerId);
    if (source) {
      store.updateLayer(source.id, { items: listOf(source).filter((item) => item !== id) });
    }
    for (const member of membersOf(moved)) store.updateFeature(member, { layerId: to.layerId });
  }
  // The list of the place without them, and them where they go in it
  if (group) {
    const now = store.getGroup(group.id) as Group;
    const list = membersOf(now).filter((id) => !moving.has(id));
    list.splice(placeIndex(list, to), 0, ...ids);
    store.updateGroup(group.id, { featureIds: list });
    return;
  }
  const layer = store.getLayer(to.layerId) as Layer;
  const list = listOf(layer).filter((id) => !moving.has(id));
  list.splice(placeIndex(list, to), 0, ...ids);
  store.updateLayer(layer.id, { items: list });
}

/** The items a layer lists */
function listOf(layer: Layer): string[] {
  if (layer.kind === 'table') {
    throw new Error(`The layer "${layer.id}" is held as rows: its items are put in place by keys`);
  }
  return [...layer.items];
}

/** The members a group lists */
function membersOf(group: Group): string[] {
  if (group.kind === 'table') {
    throw new Error(`The group "${group.id}" is of a layer held as rows: its members have keys`);
  }
  return [...group.featureIds];
}
