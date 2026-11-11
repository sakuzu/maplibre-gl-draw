// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ids of the features of a group or a layer held as rows, read from the rows
 *
 * A group or a layer held as rows lists no member and no item: what selects one and needs the
 * ids of its features reads them here, in the order of the layer (deleted rows left out).
 */

import type { ItemWalk } from '@sakuzu/kasane/render';
import { compareRowKeys, ROW_FLAG_DELETED } from '@sakuzu/kasane/render';
import type { FeatureTables } from '../api/tables.js';
import type { HitShape } from '../shared/math/position-runs.js';
import type { Coordinate } from '../shared/types/model.js';
import { ROW_FLAG_LOCKED } from '../table/feature-row-columns.js';
import { STATE_HIDDEN_MASK } from './feature-row-states.js';
import { featureTablesInternals } from './feature-tables.js';
import { rowHitShape } from './hit-test.js';

/**
 * The ids of the members of a group of features of a layer held as rows, in their order (none
 * when the tables do not know the group)
 *
 * @internal
 */
export function tableGroupMemberIds(
  tables: FeatureTables | undefined,
  group: { readonly id: string; readonly layerId: string },
): string[] {
  const internals = featureTablesInternals(tables);
  const view = tables?.get(group.layerId);
  if (!internals || !view || !tables) return [];
  const handle = internals.groups.handleOfId(group.id);
  if (handle < 0) return [];
  const members = view.listGroupMembers(handle, 0, view.countGroupMembers(handle));
  return Array.from(members, (row) => tables.getRowId(row) as string);
}

/**
 * The ids of the features of a layer held as rows, in their order: its rows outside a group and
 * the members of its groups (none for a layer that holds no row)
 *
 * @internal
 */
export function tableLayerFeatureIds(tables: FeatureTables | undefined, layerId: string): string[] {
  const out: string[] = [];
  if (!tables) return out;
  const cursor = tables.scan({ layerIds: [layerId] });
  for (let batch = cursor.next(); batch; batch = cursor.next()) {
    for (const handle of batch) out.push(tables.getRowId(handle) as string);
  }
  return out;
}

/**
 * The number of the features of a group of features of a layer held as rows
 *
 * @internal
 */
export function tableGroupMemberCount(
  tables: FeatureTables | undefined,
  group: { readonly id: string; readonly layerId: string },
): number {
  const internals = featureTablesInternals(tables);
  const view = tables?.get(group.layerId);
  if (!internals || !view) return 0;
  const handle = internals.groups.handleOfId(group.id);
  return handle < 0 ? 0 : view.countGroupMembers(handle);
}

/**
 * The number of the features of a layer held as rows (deleted rows left out)
 *
 * @internal
 */
export function tableLayerFeatureCount(tables: FeatureTables | undefined, layerId: string): number {
  const view = tables?.get(layerId);
  if (!view) return 0;
  const items = view.listItems(0, view.itemCount);
  let count = 0;
  for (let i = 0; i < items.kinds.length; i++) {
    count += items.kinds[i] === 0 ? 1 : view.countGroupMembers(items.handles[i]);
  }
  return count;
}

/**
 * The ids of the rows held as columns that have a vertex exactly at one of the positions (read on
 * their columns, no feature made), deleted and hidden rows left out
 *
 * @internal
 */
export function tableRowIdsWithVertexAt(
  tables: FeatureTables | undefined,
  positions: readonly Coordinate[],
): string[] {
  const internals = featureTablesInternals(tables);
  if (!internals || !tables) return [];
  const out = new Set<string>();
  for (const [x, y] of positions) {
    const cursor = tables.scan({ bbox: [x, y, x, y], order: 'any' });
    for (let batch = cursor.next(); batch; batch = cursor.next()) {
      for (const handle of batch) {
        const place = internals.placeOf(handle);
        if (!place || (place.group.state[place.row] & STATE_HIDDEN_MASK) !== 0) continue;
        const shape = rowHitShape(place.group, place.row);
        if (shape && hasVertexAt(shape, x, y)) out.add(tables.getRowId(handle) as string);
      }
    }
  }
  return [...out];
}

/** Whether a shape has a vertex exactly at a position */
function hasVertexAt(shape: HitShape, x: number, y: number): boolean {
  for (const runs of shape.parts) {
    for (const run of runs) {
      for (let i = 0; i < run.length; i++) if (run.x(i) === x && run.y(i) === y) return true;
    }
  }
  return false;
}

/**
 * Whether a row of a layer held as rows is locked itself (deleted rows left out)
 *
 * @internal
 */
export function tableLayerHasLockedRow(
  tables: FeatureTables | undefined,
  layerId: string,
): boolean {
  const internals = featureTablesInternals(tables);
  const table = internals?.rowTable(layerId);
  if (!table) return false;
  const order = table.rowOrder();
  for (let i = 0; i < order.handles.length; i++) {
    const flags = order.groups[i].data.flags[order.rows[i]];
    if ((flags & ROW_FLAG_DELETED) === 0 && (flags & ROW_FLAG_LOCKED) !== 0) return true;
  }
  return false;
}

/** The walk of the items of a layer held as rows (null for a layer that holds no row) */
function walkOf(tables: FeatureTables, layerId: string): ItemWalk | null {
  return featureTablesInternals(tables)?.walkItems(layerId) ?? null;
}

/** The id of an item numbered as the walk numbers it */
function idOfCode(tables: FeatureTables, code: number): string | undefined {
  if ((code & 1) === 0) return tables.getRowId(code >> 1);
  return featureTablesInternals(tables)?.groups.idOf(code >> 1);
}

/** The number of an item by its id (-1 for none) */
function codeOfId(tables: FeatureTables, id: string): number {
  const handle = tables.getRowRef(id);
  if (handle !== undefined) return handle * 2;
  const group = featureTablesInternals(tables)?.groups.handleOfId(id) ?? -1;
  return group >= 0 ? group * 2 + 1 : -1;
}

/**
 * Where an item of a layer held as rows (or of a group of it) stands: the items just below and
 * above it, the ones `skip` names left out (null when the item is not there). Read from the rows
 * next to it, not from the list of the items of the layer
 *
 * @internal
 */
export function tableItemNeighbors(
  tables: FeatureTables | undefined,
  layerId: string,
  groupId: string | undefined,
  itemId: string,
  skip: ReadonlySet<string> = new Set(),
): { below: string | null; above: string | null } | null {
  if (!tables) return null;
  const walk = walkOf(tables, layerId);
  const code = codeOfId(tables, itemId);
  const container =
    groupId === undefined ? -1 : (featureTablesInternals(tables)?.groups.handleOfId(groupId) ?? -1);
  if (!walk || code < 0 || (groupId !== undefined && container < 0)) return null;
  if (!walk.span(code, container)) return null;
  const skipped = new Set<number>();
  for (const id of skip) {
    const other = codeOfId(tables, id);
    if (other >= 0) skipped.add(other);
  }
  const below = walk.below(code, container, skipped);
  const above = walk.above(code, container, skipped);
  return {
    below: below === null ? null : (idOfCode(tables, below) ?? null),
    above: above === null ? null : (idOfCode(tables, above) ?? null),
  };
}

/**
 * The frontmost of items of a layer held as rows (undefined when none of them is an item of it),
 * read where each of them stands
 *
 * @internal
 */
export function tableFrontmostItem(
  tables: FeatureTables | undefined,
  layerId: string,
  itemIds: ReadonlySet<string>,
): string | undefined {
  if (!tables) return undefined;
  const walk = walkOf(tables, layerId);
  if (!walk) return undefined;
  let front = -1;
  for (const id of itemIds) {
    const code = codeOfId(tables, id);
    if (code < 0 || !walk.span(code, -1)) continue;
    if (front < 0 || walk.compare(code, front) > 0) front = code;
  }
  return front < 0 ? undefined : idOfCode(tables, front);
}

/**
 * Of groups of features, the ones that are items of a layer held as rows (a group with a member),
 * in their order: read where each of them stands
 *
 * @internal
 */
export function tableGroupsInOrder(
  tables: FeatureTables | undefined,
  layerId: string,
  groupIds: readonly string[],
): string[] {
  const internals = featureTablesInternals(tables);
  const walk = tables ? walkOf(tables, layerId) : null;
  if (!internals || !walk) return [];
  const codes: number[] = [];
  for (const id of groupIds) {
    const group = internals.groups.handleOfId(id);
    if (group >= 0 && walk.span(group * 2 + 1, -1)) codes.push(group * 2 + 1);
  }
  codes.sort((a, b) => walk.compare(a, b));
  return codes.map((code) => internals.groups.idOf(code >> 1) as string);
}

/**
 * The groups of features of a layer held as rows that are its items (a group with a member), in
 * their order
 *
 * @internal
 */
export function tableLayerGroupIds(tables: FeatureTables | undefined, layerId: string): string[] {
  const internals = featureTablesInternals(tables);
  const items = internals?.rowTable(layerId)?.itemsOf();
  if (!internals || !items) return [];
  const out: string[] = [];
  for (let i = 0; i < items.kinds.length; i++) {
    if (items.kinds[i] !== 1) continue;
    const id = internals.groups.idOf(items.handles[i]);
    if (id !== undefined) out.push(id);
  }
  return out;
}

/**
 * Ids of rows held as columns in the order they are drawn: by the stacking order of their layers
 * (a layer not on it after), then by their order in their layer; an id of no row comes last
 *
 * @internal
 */
export function tableIdsInOrder(
  tables: FeatureTables | undefined,
  layerOrder: readonly string[],
  ids: readonly string[],
): string[] {
  const internals = featureTablesInternals(tables);
  if (!internals || !tables) return [...ids];
  const layerRank = new Map(layerOrder.map((id, i) => [id, i]));
  const entries = ids.map((id) => {
    const handle = tables.getRowRef(id);
    const place = handle === undefined ? undefined : internals.placeOf(handle);
    return { id, place };
  });
  return entries
    .sort((a, b) => {
      if (!a.place || !b.place) return (a.place ? 0 : 1) - (b.place ? 0 : 1);
      const la = layerRank.get(a.place.table.tableId) ?? Number.MAX_SAFE_INTEGER;
      const lb = layerRank.get(b.place.table.tableId) ?? Number.MAX_SAFE_INTEGER;
      if (la !== lb) return la - lb;
      if (a.place.table !== b.place.table) {
        return a.place.table.tableId < b.place.table.tableId ? -1 : 1;
      }
      return compareRowKeys(
        a.place.group.data,
        a.place.row,
        b.place.group.data,
        b.place.row,
        internals.groups,
      );
    })
    .map((entry) => entry.id);
}
