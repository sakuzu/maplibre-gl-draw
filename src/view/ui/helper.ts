// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SelectionHelper
 *
 * Helper functions for obtaining the selected features and computing the bounding box.
 */

import type { IdSet } from '../../api/model.js';
import type { DocumentAccess, InstanceDocument } from '../../store/document-access.js';
import type { Feature } from '../../store/types.js';
import type { BoundingBoxCoords, SelectionExtensionRegistry } from './selection-ui/index.js';
import {
  computeBoundingBox,
  computeCombinedBoundingBox,
  hasZeroArea,
} from './selection-ui/index.js';

/**
 * What the selection is read from: the layer over the Store, with its reads of the features of a
 * group and of a layer
 */
export type SelectionDocument = DocumentAccess &
  Pick<InstanceDocument, 'countGroupFeatures' | 'listGroupFeatureIds' | 'iterateFeatures'>;

/**
 * The features the current selection covers, read without an array of their IDs: the selection
 * itself for a feature selection, the members of the groups or the layers selected otherwise
 */
export type SelectedFeatureIds = Pick<IdSet, 'count' | 'has' | 'iterate'>;

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
export function getSelectedFeatureIds(store: SelectionDocument): readonly string[] {
  return [...getSelectedFeatureIdSet(store).iterate()];
}

/**
 * The features the current selection covers, as `getSelectedFeatureIds` resolves them, read
 * without an array of their IDs for a feature selection (the set of the selection itself)
 *
 * @internal
 */
export function getSelectedFeatureIdSet(store: SelectionDocument): SelectedFeatureIds {
  const selection = store.getSelection();
  switch (selection.type) {
    case 'feature':
      return selection.ids;
    case 'group':
      return setOf(
        [...selection.ids.iterate()].flatMap((id) =>
          store.listGroupFeatureIds(id, 0, store.countGroupFeatures(id)),
        ),
      );
    case 'layer':
      return setOf([...selection.ids.iterate()].flatMap((id) => featureIdsInLayer(store, id)));
    default:
      return setOf([]);
  }
}

/** The IDs of the members of groups or layers, read as a set */
function setOf(ids: readonly string[]): SelectedFeatureIds {
  let lookup: Set<string> | null = null;
  return {
    count: () => ids.length,
    has: (id) => {
      lookup ??= new Set(ids);
      return lookup.has(id);
    },
    iterate: () => ids[Symbol.iterator](),
  };
}

// All feature IDs under a layer, in stacking order (the members of its groups at their place)
function featureIdsInLayer(store: SelectionDocument, layerId: string): string[] {
  if (!store.getLayer(layerId)) return [];
  const ids: string[] = [];
  for (const feature of store.iterateFeatures({ layerId })) ids.push(feature.id);
  return ids;
}

/**
 * Obtain the selected features (a group / layer selection is resolved to its members)
 *
 * @internal
 */
export function getSelectedFeatures(store: SelectionDocument): Feature[] {
  const features: Feature[] = [];
  for (const id of getSelectedFeatureIdSet(store).iterate()) {
    const feature = store.getFeature(id);
    if (feature !== undefined) features.push(feature);
  }
  return features;
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
