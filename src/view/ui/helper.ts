// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SelectionHelper
 *
 * Helper functions for obtaining the selected features and computing the bounding box.
 */

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
export function getSelectedFeatureIds(store: Store): string[] {
  const selection = store.getSelection();
  switch (selection.type) {
    case 'feature':
      return selection.ids;
    case 'group':
      return selection.ids.flatMap((id) => store.getGroup(id)?.featureIds ?? []);
    case 'layer':
      return selection.ids.flatMap((id) => featureIdsInLayer(store, id));
    default:
      return [];
  }
}

// All feature IDs under a layer (the features in order + the members of the groups).
function featureIdsInLayer(store: Store, layerId: string): string[] {
  const layer = store.getLayer(layerId);
  if (!layer) return [];
  const ids: string[] = [];
  for (const itemId of layer.items) {
    if (store.getFeature(itemId)) {
      ids.push(itemId);
    } else {
      const group = store.getGroup(itemId);
      if (group) ids.push(...group.featureIds);
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
