// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The items of a layer and the members of a group read by position (`layers.listItems`,
 * `layers.countItems`, `groups.listMembers`): from the lists of a layer and a group of objects,
 * and from the tables of a layer held as rows, without making features
 */

import { type DocumentSnapshot, snapshotOf } from '../../store/read-snapshot.js';
import type { Store } from '../../store/store.js';
import type { Group, Layer } from '../../store/types.js';
import type { ItemListOptions } from '../model.js';
import { ITEM_ROW } from '../tables.js';
import { invalidInput, onlyKeys, requireRecord } from './shared.js';

/** A range of positions, checked */
interface Range {
  readonly offset: number;
  /** The most items read (undefined for every one after `offset`) */
  readonly limit: number | undefined;
}

/** A non-negative integer, or undefined; throws DrawError for anything else */
function optionalCount(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidInput(`${key} must be a non-negative integer`);
  }
  return value;
}

/**
 * Checks the range of a reading by position
 *
 * @internal
 */
export function rangeOf(options: ItemListOptions | undefined): Range {
  if (options === undefined) return { offset: 0, limit: undefined };
  requireRecord(options, 'The options');
  onlyKeys(options as unknown as Record<string, unknown>, ['offset', 'limit'], 'The options');
  return {
    offset: optionalCount(options.offset, 'offset') ?? 0,
    limit: optionalCount(options.limit, 'limit'),
  };
}

/** The part of a list in a range */
function slice(list: readonly string[], range: Range): string[] {
  const end = range.limit === undefined ? list.length : range.offset + range.limit;
  return list.slice(range.offset, end);
}

/**
 * The IDs of the items of a layer in a range, from the back
 *
 * @internal
 */
export function layerItemIds(store: Store, layer: Layer, range: Range): string[] {
  // The document before a write over several tasks, or a transaction over it
  const snapshot = store.tables ? snapshotOf(store) : undefined;
  if (snapshot) return slice(itemsAt(store, snapshot, layer.id), range);
  if (layer.kind !== 'table') return slice(layer.items, range);
  const tables = store.tables;
  const view = tables?.get(layer.id);
  if (!tables || !view) return [];
  const count = range.limit ?? Math.max(0, view.itemCount - range.offset);
  const items = view.listItems(range.offset, count);
  const out: string[] = [];
  for (let i = 0; i < items.kinds.length; i++) {
    const handle = items.handles[i];
    const id = items.kinds[i] === ITEM_ROW ? tables.getRowId(handle) : tables.getGroupId(handle);
    if (id !== undefined) out.push(id);
  }
  return out;
}

/**
 * The number of the items of a layer
 *
 * @internal
 */
export function layerItemCount(store: Store, layer: Layer): number {
  const snapshot = store.tables ? snapshotOf(store) : undefined;
  if (snapshot) return itemsAt(store, snapshot, layer.id).length;
  if (layer.kind !== 'table') return layer.items.length;
  return store.tables?.get(layer.id)?.itemCount ?? 0;
}

/**
 * The IDs of the members of a group in a range, from the back
 *
 * @internal
 */
export function groupMemberIds(store: Store, group: Group, range: Range): string[] {
  const snapshot = store.tables ? snapshotOf(store) : undefined;
  if (snapshot) return slice(membersAt(store, snapshot, group), range);
  if (group.kind !== 'table') return slice(group.featureIds, range);
  const tables = store.tables;
  const view = tables?.get(group.layerId);
  const handle = tables?.findGroup(group.id);
  if (!tables || !view || handle === undefined) return [];
  const count = range.limit ?? Math.max(0, view.countGroupMembers(handle) - range.offset);
  const members = view.listGroupMembers(handle, range.offset, count);
  return Array.from(members, (row) => tables.getRowId(row) as string);
}

/**
 * The IDs of the items of a layer held as rows as they were when the write over several tasks
 * under way began (`Store.readSnapshot`), from the back: a row on its own, or the group of the rows
 * of a group, at the place of its first member
 *
 * @internal
 */
export function itemsAt(store: Store, snapshot: DocumentSnapshot, layerId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  snapshot.read(() => {
    const tables = store.tables;
    if (!tables) return;
    snapshot.forEachRow(layerId, (handle, changed) => {
      const groupId = changed ? changed.groupId : snapshot.groupOfRow(handle);
      if (groupId === undefined) {
        out.push(changed ? changed.id : (tables.getRowId(handle) as string));
      } else if (!seen.has(groupId)) {
        seen.add(groupId);
        out.push(groupId);
      }
      return true;
    });
  });
  return out;
}

/** The IDs of the members of a group held as rows as they were then, from the back */
function membersAt(store: Store, snapshot: DocumentSnapshot, group: Group): string[] {
  const out: string[] = [];
  snapshot.read(() => {
    const tables = store.tables;
    if (!tables) return;
    snapshot.forEachRow(group.layerId, (handle, changed) => {
      const groupId = changed ? changed.groupId : snapshot.groupOfRow(handle);
      if (groupId === group.id)
        out.push(changed ? changed.id : (tables.getRowId(handle) as string));
      return true;
    });
  });
  return out;
}
