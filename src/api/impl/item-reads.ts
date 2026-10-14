// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The items of a layer and the members of a group read by position (`layers.listItems`,
 * `layers.countItems`, `groups.listMembers`): from the lists of a layer and a group of objects,
 * and from the tables of a layer held as rows, without making features
 */

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
  if (layer.kind !== 'table') return layer.items.length;
  return store.tables?.get(layer.id)?.itemCount ?? 0;
}

/**
 * The IDs of the members of a group in a range, from the back
 *
 * @internal
 */
export function groupMemberIds(store: Store, group: Group, range: Range): string[] {
  if (group.kind !== 'table') return slice(group.featureIds, range);
  const tables = store.tables;
  const view = tables?.get(group.layerId);
  const handle = tables?.findGroup(group.id);
  if (!tables || !view || handle === undefined) return [];
  const count = range.limit ?? Math.max(0, view.countGroupMembers(handle) - range.offset);
  const members = view.listGroupMembers(handle, range.offset, count);
  return Array.from(members, (row) => tables.getRowId(row) as string);
}
