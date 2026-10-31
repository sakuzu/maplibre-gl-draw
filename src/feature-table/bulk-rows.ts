// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reading the rows of a selection of many rows on their columns, without making features: their
 * number, layers and extent, their order, whether each can be seen and edited
 */

import type { BBox } from '../geometry/types.js';
import { ROW_FLAG_DELETED, ROW_FLAG_LOCKED } from '../table/row-group-types.js';
import type { FeatureTablesInternals, RowPlace } from './feature-tables.js';
import { STATE_UNHIT_MASK } from './row-state.js';
import type { TableSelection } from './selection.js';
import type { RowHandle } from './types.js';

/**
 * What the document says of the layers and the groups a row is in: whether each is shown and
 * locked, and whether this client hides an item (a row, a group or a layer, by its id)
 *
 * @internal
 */
export interface RowContainers {
  /** Whether a layer is visible in the document (false for a layer that is not there) */
  layerVisible(layerId: string): boolean;
  /** Whether a layer is locked */
  layerLocked(layerId: string): boolean;
  /** Whether this client hides the item of this id */
  hidden(id: string): boolean;
}

/**
 * The number, the layers and the extent of the rows of a selection
 *
 * @internal
 */
export interface RowsSummary {
  readonly count: number;
  /** The layers, in the order they are first met in the set */
  readonly layerIds: readonly string[];
  /** The union of the extents of the rows, `[west, south, east, north]` (null when none has one) */
  readonly bbox: BBox | null;
  /** Whether a row has an extent with an area (not a single position) */
  readonly hasArea: boolean;
}

/**
 * Sums up the rows of a selection: the rows there are, their layers and their extent
 *
 * @internal
 */
export function summarizeRows(
  internals: FeatureTablesInternals,
  rows: TableSelection,
): RowsSummary {
  const layers = new Set<string>();
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let count = 0;
  let hasArea = false;
  for (const handle of rows.handles) {
    const place = internals.placeOf(handle);
    if (!place || (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0) continue;
    count++;
    layers.add(place.layer.layerId);
    const b = place.group.data.rowBounds;
    const at = place.row * 4;
    if (Number.isNaN(b[at])) continue;
    if (b[at + 2] > b[at] || b[at + 3] > b[at + 1]) hasArea = true;
    if (b[at] < minX) minX = b[at];
    if (b[at + 1] < minY) minY = b[at + 1];
    if (b[at + 2] > maxX) maxX = b[at + 2];
    if (b[at + 3] > maxY) maxY = b[at + 3];
  }
  return {
    count,
    layerIds: [...layers],
    bbox: minX <= maxX ? [minX, minY, maxX, maxY] : null,
    hasArea,
  };
}

/**
 * The place of a row there is (undefined for a handle of no row, or of a deleted one)
 *
 * @internal
 */
export function livePlaceOf(
  internals: FeatureTablesInternals,
  handle: RowHandle,
): RowPlace | undefined {
  const place = internals.placeOf(handle);
  if (!place || (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0) return undefined;
  return place;
}

/**
 * Whether a row can be seen: it is there, its own visible flag and the ones of its group and its
 * layer are on, and neither it nor its group nor its layer is hidden by this client (the rule the
 * selection keeps: what cannot be seen is not selected)
 *
 * @internal
 */
export function isRowShown(
  internals: FeatureTablesInternals,
  containers: RowContainers,
  handle: RowHandle,
): boolean {
  const place = livePlaceOf(internals, handle);
  if (!place) return false;
  // Hidden by its own flag, by its group, deleted, or by this client
  if ((place.group.state[place.row] & STATE_UNHIT_MASK) !== 0) return false;
  const layerId = place.layer.layerId;
  if (!containers.layerVisible(layerId) || containers.hidden(layerId)) return false;
  const group = place.group.data.groups[place.row];
  if (group >= 0) {
    if (!internals.groups.isVisible(group)) return false;
    const groupId = internals.groups.idOf(group);
    if (groupId !== undefined && containers.hidden(groupId)) return false;
  }
  return true;
}

/**
 * Whether a row is locked: itself, its group or its layer
 *
 * @internal
 */
export function isRowLocked(
  internals: FeatureTablesInternals,
  containers: RowContainers,
  handle: RowHandle,
): boolean {
  const place = livePlaceOf(internals, handle);
  if (!place) return false;
  if ((place.group.data.flags[place.row] & ROW_FLAG_LOCKED) !== 0) return true;
  const group = place.group.data.groups[place.row];
  if (group >= 0 && internals.groups.isLocked(group)) return true;
  return containers.layerLocked(place.layer.layerId);
}

/**
 * The rows of a selection by layer, each in the order of its layer (from the back), the layers in
 * the order they are first met in the set
 *
 * The order of a layer is read once per layer, so the cost is the rows of the layers the set is
 * in.
 *
 * @internal
 */
export function rowsByLayerInOrder(
  internals: FeatureTablesInternals,
  rows: TableSelection,
): Map<string, Int32Array> {
  const layers = new Map<string, true>();
  for (const handle of rows.handles) {
    const place = livePlaceOf(internals, handle);
    if (place) layers.set(place.layer.layerId, true);
  }
  const out = new Map<string, Int32Array>();
  for (const layerId of layers.keys()) {
    const table = internals.layerTable(layerId);
    if (!table) continue;
    const order = table.rowOrder();
    const picked: number[] = [];
    for (let i = 0; i < order.handles.length; i++) {
      const handle = order.handles[i];
      if ((order.groups[i].data.flags[order.rows[i]] & ROW_FLAG_DELETED) !== 0) continue;
      if (rows.has(handle)) picked.push(handle);
    }
    out.set(layerId, Int32Array.from(picked));
  }
  return out;
}
