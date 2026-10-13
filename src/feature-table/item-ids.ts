// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ids of the features of a group or a layer held as rows, read from the rows
 *
 * A group or a layer held as rows lists no member and no item: what selects one and needs the
 * ids of its features reads them here, in the order of the layer (deleted rows left out).
 */

import type { FeatureTables } from '../api/tables.js';
import type { HitShape } from '../shared/math/position-runs.js';
import type { Coordinate } from '../shared/types/model.js';
import { ROW_FLAG_DELETED, ROW_FLAG_LOCKED } from '../table/row-group-types.js';
import { featureTablesInternals } from './feature-tables.js';
import { rowHitShape } from './hit-test.js';
import { STATE_HIDDEN_MASK } from './row-state.js';

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
  const view = tables?.layer(group.layerId);
  if (!internals || !view || !tables) return [];
  const handle = internals.groups.handleOfId(group.id);
  if (handle < 0) return [];
  const members = view.groupMembersInOrder(handle, 0, view.groupMemberCount(handle));
  return Array.from(members, (row) => tables.idOf(row) as string);
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
    for (const handle of batch) out.push(tables.idOf(handle) as string);
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
  const view = tables?.layer(group.layerId);
  if (!internals || !view) return 0;
  const handle = internals.groups.handleOfId(group.id);
  return handle < 0 ? 0 : view.groupMemberCount(handle);
}

/**
 * The number of the features of a layer held as rows (deleted rows left out)
 *
 * @internal
 */
export function tableLayerFeatureCount(tables: FeatureTables | undefined, layerId: string): number {
  const view = tables?.layer(layerId);
  if (!view) return 0;
  const items = view.itemsInOrder(0, view.itemCount);
  let count = 0;
  for (let i = 0; i < items.kinds.length; i++) {
    count += items.kinds[i] === 0 ? 1 : view.groupMemberCount(items.handles[i]);
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
        if (shape && hasVertexAt(shape, x, y)) out.add(tables.idOf(handle) as string);
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
export function tableLayerHasLockedRow(tables: FeatureTables | undefined, layerId: string): boolean {
  const internals = featureTablesInternals(tables);
  const table = internals?.layerTable(layerId);
  if (!table) return false;
  const order = table.rowOrder();
  for (let i = 0; i < order.handles.length; i++) {
    const flags = order.groups[i].data.flags[order.rows[i]];
    if ((flags & ROW_FLAG_DELETED) === 0 && (flags & ROW_FLAG_LOCKED) !== 0) return true;
  }
  return false;
}
