// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where items stand among the items of a layer or the members of a group, read from the lists of
 * a layer of objects or from the rows of a layer held as rows alike
 *
 * What puts items in a place (`moveItems`) names it by the items just below and above it: these
 * read them for an item that stands somewhere, without listing a layer held as rows.
 */

import type { FeatureTables } from '../api/tables.js';
import type { BulkOperation } from '../feature-table/bulk-plan.js';
import {
  tableFrontmostItem,
  tableGroupsInOrder,
  tableIdsInOrder,
  tableItemNeighbors,
  tableLayerGroupIds,
} from '../feature-table/item-ids.js';
import { TableSelection } from '../feature-table/selection.js';
import { listEveryFeatureInOrder } from './ordering.js';
import type { Feature, Group, ItemPlacement, Layer } from './types.js';

/** What the places of the items are read from */
export interface ItemListStore {
  readonly tables?: FeatureTables;
  getLayer(id: string): Layer | undefined;
  getGroup(id: string): Group | undefined;
  getLayerOrder(): readonly string[];
  listGroups(): Group[];
  listFeatures(): Feature[];
  listFeaturesInOrder(): Feature[];
}

/** The items a layer of objects lists, or the members a group of it lists (none otherwise) */
function listOf(
  store: ItemListStore,
  layerId: string,
  groupId: string | undefined,
): readonly string[] {
  if (groupId !== undefined) {
    const group = store.getGroup(groupId);
    return group && group.kind !== 'table' ? group.featureIds : [];
  }
  const layer = store.getLayer(layerId);
  return layer && layer.kind !== 'table' ? layer.items : [];
}

/** Whether a layer is held as rows */
function heldAsRows(store: ItemListStore, layerId: string): boolean {
  return store.getLayer(layerId)?.kind === 'table';
}

/**
 * Where an item of a layer (or of a group of it) stands: the items just below and above it, the
 * ones `skip` names left out (null when the item is not there)
 *
 * @internal
 */
export function itemNeighbors(
  store: ItemListStore,
  layerId: string,
  groupId: string | undefined,
  itemId: string,
  skip: ReadonlySet<string> = new Set(),
): { below: string | null; above: string | null } | null {
  if (heldAsRows(store, layerId)) {
    return tableItemNeighbors(store.tables, layerId, groupId, itemId, skip);
  }
  const list = listOf(store, layerId, groupId);
  const at = list.indexOf(itemId);
  if (at < 0) return null;
  let below: string | null = null;
  for (let i = at - 1; i >= 0 && below === null; i--) if (!skip.has(list[i])) below = list[i];
  let above: string | null = null;
  for (let i = at + 1; i < list.length && above === null; i++) {
    if (!skip.has(list[i])) above = list[i];
  }
  return { below, above };
}

/**
 * The frontmost of items of a layer (undefined when none of them is an item of it)
 *
 * @internal
 */
export function frontmostItem(
  store: ItemListStore,
  layerId: string,
  itemIds: ReadonlySet<string>,
): string | undefined {
  if (heldAsRows(store, layerId)) return tableFrontmostItem(store.tables, layerId, itemIds);
  const list = listOf(store, layerId, undefined);
  for (let i = list.length - 1; i >= 0; i--) if (itemIds.has(list[i])) return list[i];
  return undefined;
}

/**
 * The place `index` names among the items of a layer of objects (or the members of a group of
 * it), the ones `moving` names left out: the items just below and above it
 *
 * @throws when the layer is held as rows (a place there is named by the items around it)
 * @internal
 */
export function placeAtIndex(
  store: ItemListStore,
  layerId: string,
  groupId: string | undefined,
  index: number,
  moving: ReadonlySet<string>,
): { below: string | null; above: string | null } {
  if (heldAsRows(store, layerId)) {
    throw new Error(
      `The layer "${layerId}" is held as rows: a place in it is named by the items around it, not by an index`,
    );
  }
  const list = listOf(store, layerId, groupId).filter((id) => !moving.has(id));
  const at = Math.max(0, Math.min(index, list.length));
  return { below: at > 0 ? list[at - 1] : null, above: at < list.length ? list[at] : null };
}

/**
 * Features in the order they are drawn, from the back
 *
 * @internal
 */
export function featuresInStackingOrder<T extends Feature>(
  store: ItemListStore,
  features: readonly T[],
): T[] {
  if (store.tables) {
    const byId = new Map(features.map((feature) => [feature.id, feature]));
    return tableIdsInOrder(
      store.tables,
      store.getLayerOrder(),
      features.map((feature) => feature.id),
    ).map((id) => byId.get(id) as T);
  }
  const position = new Map(listEveryFeatureInOrder(store).map((f, index) => [f.id, index]));
  return [...features].sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
}

/**
 * Every group in the order of the layers and of their items, from the back; a group no layer
 * lists (a group of rows without a member) comes last
 *
 * @internal
 */
export function groupsInStackingOrder(store: ItemListStore): Group[] {
  const result: Group[] = [];
  for (const layerId of store.getLayerOrder()) {
    const layer = store.getLayer(layerId);
    if (!layer) continue;
    const ids = layer.kind === 'table' ? tableLayerGroupIds(store.tables, layerId) : layer.items;
    for (const itemId of ids) {
      const group = store.getGroup(itemId);
      if (group) result.push(group);
    }
  }
  if (result.length < store.listGroups().length) {
    const listed = new Set(result.map((group) => group.id));
    result.push(...store.listGroups().filter((group) => !listed.has(group.id)));
  }
  return result;
}

/**
 * Groups in the order `groupsInStackingOrder` lists them in, read where each of them stands (not
 * from the items of every layer held as rows)
 *
 * @internal
 */
export function groupsInStackingOrderOf(store: ItemListStore, groups: readonly Group[]): Group[] {
  const wanted = new Map(groups.map((group) => [group.id, group]));
  const result: Group[] = [];
  for (const layerId of store.getLayerOrder()) {
    const layer = store.getLayer(layerId);
    if (!layer) continue;
    const ids =
      layer.kind === 'table'
        ? tableGroupsInOrder(store.tables, layerId, [...wanted.keys()])
        : layer.items.filter((id) => wanted.has(id));
    for (const id of ids) {
      const group = wanted.get(id);
      if (group && store.getGroup(id)) result.push(group);
    }
  }
  if (result.length < wanted.size) {
    // A group no layer lists comes last, in the order of the groups
    const listed = new Set(result.map((group) => group.id));
    for (const group of store.listGroups()) {
      if (wanted.has(group.id) && !listed.has(group.id)) result.push(group);
    }
  }
  return result;
}

/** What creating a group at the place of its frontmost member writes */
export interface GroupInsertStore extends ItemListStore {
  createGroup(group: Group): unknown;
  moveItems(itemIds: readonly string[], to: ItemPlacement): unknown;
  /** Writes an operation on rows (a Store that holds its features as rows) */
  applyBulk?(op: BulkOperation, rows?: TableSelection): unknown;
}

/**
 * The number of members past which a new group of rows takes them as rows selected in bulk are
 * grouped: in one write that reads the order of the layer, cheaper for many members than placing
 * each of them by the items around it (which reads only the rows next to them, for a few)
 */
const BULK_MEMBERS = 2_000;

/**
 * The rows of the members of a new group of a layer held as rows, when there are many of them and
 * all of them are rows of the tables (null otherwise)
 */
function memberRows(store: GroupInsertStore, members: ReadonlySet<string>): Int32Array | null {
  const tables = store.tables;
  if (!tables || !store.applyBulk || members.size <= BULK_MEMBERS) return null;
  const handles = new Int32Array(members.size);
  let at = 0;
  for (const id of members) {
    const handle = tables.getRowRef(id);
    if (handle === undefined) return null;
    handles[at++] = handle;
  }
  return handles;
}

/**
 * Creates a group where its frontmost member was (between the items just below and above it that
 * are not members; at the front when no member stands in the layer), in the transaction of the
 * caller. A group of a layer held as rows deleted whose rows are kept is created again at the
 * place it had, which the Store gives it
 *
 * @param options - `membersInOrder`: its members are listed in stacking order and stand in the
 *   layer, so the last is the frontmost
 * @internal
 */
export function insertGroup(
  store: GroupInsertStore,
  group: Group,
  options?: { readonly membersInOrder?: boolean },
): void {
  const members = new Set(group.kind === 'table' ? [] : group.featureIds);
  const layerId = group.layerId;
  const kept =
    heldAsRows(store, layerId) &&
    store.getGroup(group.id) === undefined &&
    store.tables?.findGroup(group.id) !== undefined;
  // The last of members listed in stacking order is the frontmost
  const listed = group.kind === 'table' ? [] : group.featureIds;
  const frontmost =
    options?.membersInOrder === true && listed.length > 0
      ? listed[listed.length - 1]
      : frontmostItem(store, layerId, members);
  const around = frontmost ? itemNeighbors(store, layerId, undefined, frontmost, members) : null;
  // A new group of rows: made empty at the place of its frontmost member, its members put into
  // it as rows in one write (by the keys of their order, without naming each of them)
  const rows = !kept && heldAsRows(store, layerId) ? memberRows(store, members) : null;
  if (rows) {
    const { featureIds: _members, ...fields } = group as Group & { featureIds?: unknown };
    store.createGroup({ ...fields, kind: 'table' } as Group);
    store.moveItems(
      [group.id],
      around ? { layerId, below: around.below, above: around.above } : { layerId, above: null },
    );
    store.applyBulk?.(
      { kind: 'place', to: { layerId, groupId: group.id } },
      TableSelection.of(rows),
    );
    return;
  }
  store.createGroup(group);
  if (!kept && store.getLayer(layerId)) {
    store.moveItems(
      [group.id],
      around ? { layerId, below: around.below, above: around.above } : { layerId, above: null },
    );
  }
}
