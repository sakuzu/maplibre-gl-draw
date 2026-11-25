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
 * group and of a layer, and of the place of a feature
 */
export type SelectionDocument = DocumentAccess &
  Pick<
    InstanceDocument,
    | 'countGroupFeatures'
    | 'listGroupFeatureIds'
    | 'countFeatures'
    | 'iterateFeatures'
    | 'getFeaturePlace'
  >;

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
 * without an array of their IDs: the set of the selection itself for a feature selection, and the
 * members of the groups or the layers selected otherwise. The members are counted by the reads
 * that count, a feature is one of them by its place (its group or its layer), and they are listed
 * only when they are iterated, as the document is then.
 *
 * @internal
 */
export function getSelectedFeatureIdSet(store: SelectionDocument): SelectedFeatureIds {
  const selection = store.getSelection();
  switch (selection.type) {
    case 'feature':
      return selection.ids;
    case 'group':
      return membersOfGroups(store, selection.ids);
    case 'layer':
      return featuresOfLayers(store, selection.ids);
    default:
      return NO_FEATURES;
  }
}

/** No feature */
const NO_FEATURES: SelectedFeatureIds = Object.freeze({
  count: () => 0,
  has: () => false,
  iterate: () => [][Symbol.iterator](),
});

/** The members of the groups selected */
function membersOfGroups(store: SelectionDocument, groupIds: IdSet): SelectedFeatureIds {
  return {
    count: () => {
      let count = 0;
      for (const id of groupIds.iterate()) count += store.countGroupFeatures(id);
      return count;
    },
    has: (id) => {
      const groupId = store.getFeaturePlace(id)?.groupId;
      return groupId !== undefined && groupIds.has(groupId);
    },
    *iterate() {
      for (const id of groupIds.iterate()) {
        yield* store.listGroupFeatureIds(id, 0, store.countGroupFeatures(id));
      }
    },
  };
}

/**
 * The features of the layers selected, each layer in stacking order (the members of its groups at
 * their place)
 */
function featuresOfLayers(store: SelectionDocument, layerIds: IdSet): SelectedFeatureIds {
  return {
    count: () => {
      let count = 0;
      for (const layerId of layerIds.iterate()) {
        if (store.getLayer(layerId)) count += store.countFeatures({ layerId });
      }
      return count;
    },
    has: (id) => {
      const layerId = store.getFeaturePlace(id)?.layerId;
      return (
        layerId !== undefined && layerIds.has(layerId) && store.getLayer(layerId) !== undefined
      );
    },
    *iterate() {
      for (const layerId of layerIds.iterate()) {
        if (!store.getLayer(layerId)) continue;
        for (const feature of store.iterateFeatures({ layerId })) yield feature.id;
      }
    },
  };
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
