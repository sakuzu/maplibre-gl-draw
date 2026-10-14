// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SelectionHelper
 *
 * Helper functions for obtaining the selected features and computing the bounding box.
 */

import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import { tableGroupMemberIds, tableLayerFeatureIds } from '../../feature-table/item-ids.js';
import type { Store } from '../../store/store.js';
import type { Feature } from '../../store/types.js';
import type { BoundingBoxCoords, SelectionExtensionRegistry } from './selection-ui/index.js';
import {
  computeBoundingBox,
  computeCombinedBoundingBox,
  hasZeroArea,
} from './selection-ui/index.js';

/**
 * Returns the ids of the features the current selection covers, resolving a group or layer
 * selection into its member features.
 *
 * The SSoT of the selection carries a kind (feature / group / layer). Selection display and
 * manipulation on the map happen per feature, so a group / layer selection is resolved into
 * the feature IDs of its members. This makes it "the SSoT holds a group/layer selection ->
 * the map selects those members", so the display follows the SSoT (feature stays as is).
 *
 * @param store The Store to read the selection from
 * @returns The feature ids. An empty array when nothing is selected
 */
export function getSelectedFeatureIds(store: Store): readonly string[] {
  const selection = store.getSelection();
  switch (selection.type) {
    case 'feature':
      return selection.ids;
    case 'group':
      return selection.ids.flatMap((id) => groupFeatureIds(store, id));
    case 'layer':
      return selection.ids.flatMap((id) => featureIdsInLayer(store, id));
    default:
      return [];
  }
}

/**
 * The ids of the rows of a Store of rows marked as in the box being drawn (the select mode marks
 * them in place of selecting them while the box is drawn): what the selection UI shows as
 * selected until the box is let go. Null when no box is drawn, or the Store holds no rows
 *
 * @internal
 */
export function getBoxMarkedFeatureIds(store: Store): readonly string[] | null {
  const tables = store.tables;
  if (!tables || !store.getBoxSelection()) return null;
  const marked = featureTablesInternals(tables)?.states.bulkHandles();
  if (!marked) return null;
  const ids: string[] = [];
  for (const handle of marked) {
    const id = tables.idOf(handle);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

// The feature IDs of a group (read from the rows for a group of a layer held as rows)
function groupFeatureIds(store: Store, groupId: string): readonly string[] {
  const group = store.getGroup(groupId);
  if (!group) return [];
  return group.kind === 'table' ? tableGroupMemberIds(store.tables, group) : group.featureIds;
}

// All feature IDs under a layer (the features in order + the members of the groups; read from
// the rows for a layer held as rows).
function featureIdsInLayer(store: Store, layerId: string): string[] {
  const layer = store.getLayer(layerId);
  if (!layer) return [];
  if (layer.kind === 'table') return tableLayerFeatureIds(store.tables, layerId);
  const ids: string[] = [];
  for (const itemId of layer.items) {
    if (store.getFeature(itemId)) {
      ids.push(itemId);
    } else {
      ids.push(...groupFeatureIds(store, itemId));
    }
  }
  return ids;
}

/**
 * Obtain the selected features (a group / layer selection is resolved to its members)
 *
 * @internal
 */
export function getSelectedFeatures(store: Store): Feature[] {
  return getSelectedFeatureIds(store)
    .map((id) => store.getFeature(id))
    .filter((f): f is Feature => f !== undefined);
}

/**
 * Compute the bounding box from the selected features
 * When there are features other than Point, the bbox is computed from those alone
 *
 * @internal
 */
export function computeSelectionBoundingBox(
  selectedFeatures: Feature[],
  extensions?: SelectionExtensionRegistry,
): BoundingBoxCoords | null {
  if (selectedFeatures.length === 0) {
    return null;
  }

  // Exclude features with zero area (a single coordinate)
  const nonPointFeatures = selectedFeatures.filter((f) => {
    const bbox = computeBoundingBox(f, extensions);
    return bbox !== null && !hasZeroArea(bbox);
  });
  if (nonPointFeatures.length > 0) {
    return computeCombinedBoundingBox(nonPointFeatures, extensions);
  }
  return computeCombinedBoundingBox(selectedFeatures, extensions);
}
