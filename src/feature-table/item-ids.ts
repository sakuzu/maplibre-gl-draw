// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ids of the features of a group or a layer held as rows, read from the rows
 *
 * A group or a layer held as rows lists no member and no item: what selects one and needs the
 * ids of its features reads them here, in the order of the layer (deleted rows left out).
 */

import type { FeatureTables } from '../api/tables.js';
import { featureTablesInternals } from './feature-tables.js';

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
