// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Selection operations
 *
 * Deletes what is selected. The Delete key of the select mode (modes/) and
 * `draw.deleteSelection()` (api/) both call this, so the two paths delete the same things.
 */

import { coordinatesOf, geometryFromCoordinates } from '../shared/utils/coordinates.js';
import { isFeatureLocked, isGroupLocked } from '../store/lock.js';
import type { Store } from '../store/store.js';
import type { FeatureCoordinates, VertexSelection } from '../store/types.js';
import { deleteVertex as deleteVertexOp, sortVertexRefsForDeletion } from './vertex.js';

/**
 * Deletes what is selected, as one change. The Delete key of the select mode and
 * `draw.deleteSelection()` both run this.
 *
 * - vertices selected: deletes those vertices
 * - feature: deletes the selected features
 * - group: deletes the contents of the group (its features) (a group that becomes empty is
 *   deleted automatically)
 * - layer: deletes the layer (the features / groups under it are deleted too). At least one
 *   layer is kept
 *
 * A deletion never removes a locked feature: a group loses only its unlocked members (it
 * stays with the locked ones), and a layer that holds a locked feature or group is not
 * deleted.
 *
 * @returns true when something was deleted; false while read-only or the interaction lock is
 *   on, when nothing is selected, or when everything selected is locked
 */
export function deleteSelection(store: Store): boolean {
  // Do not start a deletion while readOnly / the interaction lock is on (group and layer
  // deletion does not go through the per-feature isFeatureLocked).
  if (store.isReadOnly() || store.isInteractionLocked()) return false;

  // Delete the vertices when vertices are selected
  const selectedVertices = store.getVertexSelection();
  if (selectedVertices && selectedVertices.vertices.length > 0) {
    return deleteSelectedVertices(store, selectedVertices) > 0;
  }

  const selection = store.getSelection();
  if (selection.ids.length === 0) return false;

  if (selection.type === 'feature') {
    // Locked features (themselves / their group / their layer) are not deleted
    const selectedIds = selection.ids.filter((id) => {
      const feature = store.getFeature(id);
      return feature !== undefined && !isFeatureLocked(feature, store);
    });
    if (selectedIds.length === 0) return false;
    store.transact(() => {
      store.setSelection(null, []);
      for (const id of selectedIds) {
        store.deleteFeature(id);
      }
    });
    return true;
  }

  if (selection.type === 'group') {
    // Locked groups (themselves / the layer they belong to) are not deleted
    const findLayerOfGroup = (groupId: string) =>
      store.listLayers().find((l) => l.items.includes(groupId));
    const groupIds = selection.ids.filter((groupId) => {
      const group = store.getGroup(groupId);
      return group !== undefined && !isGroupLocked(group, findLayerOfGroup);
    });
    if (groupIds.length === 0) return false;
    store.transact(() => {
      store.setSelection(null, []);
      for (const groupId of groupIds) {
        const group = store.getGroup(groupId);
        if (!group) continue;
        // Delete the unlocked contents of the group. The group itself is deleted automatically
        // the moment the last feature is removed.
        for (const featureId of [...group.featureIds]) {
          const feature = store.getFeature(featureId);
          if (feature && isFeatureLocked(feature, store)) continue;
          store.deleteFeature(featureId);
        }
        // When an empty group (a group with no contents) was selected, delete the group itself
        // (a group that keeps locked members stays)
        if (store.getGroup(groupId)?.featureIds.length === 0) {
          store.deleteGroup(groupId);
        }
      }
    });
    return true;
  }

  if (selection.type === 'layer') {
    // Locked layers, and layers holding a locked feature or group, are not deleted.
    // At least one layer is kept (prevents deleting every layer).
    const layerIds = [...new Set(selection.ids)].filter((layerId) => {
      const layer = store.getLayer(layerId);
      return layer !== undefined && !layer.locked && !holdsLockedItem(store, layerId);
    });
    const deletable = layerIds.slice(0, Math.max(0, store.listLayers().length - 1));
    if (deletable.length === 0) return false;
    store.transact(() => {
      store.setSelection(null, []);
      for (const layerId of deletable) {
        store.deleteLayer(layerId);
      }
    });
    return true;
  }

  return false;
}

/**
 * Whether a layer holds a feature or a group that is locked on its own
 */
function holdsLockedItem(store: Store, layerId: string): boolean {
  const layer = store.getLayer(layerId);
  if (!layer) return false;
  for (const itemId of layer.items) {
    const group = store.getGroup(itemId);
    if (group?.locked) return true;
  }
  return store.listFeatures().some((f) => f.layerId === layerId && isFeatureLocked(f, store));
}

/**
 * Deletes the selected vertices of one feature as one change
 *
 * @returns The number of vertices deleted
 */
function deleteSelectedVertices(store: Store, selection: VertexSelection): number {
  const feature = store.getFeature(selection.featureId);
  if (!feature) return 0;

  // The vertices of a locked feature are not deleted
  if (isFeatureLocked(feature, store)) return 0;

  // Within the same part and the same ring, deletion goes in descending index order
  // (avoiding the shift caused by what was already removed. For MultiPoint the part itself
  // disappears, so parts are in descending order too)
  const sortedRefs = sortVertexRefsForDeletion(selection.vertices);

  // deleteVertex does not mutate its input and returns a new coordinate structure
  // (copy-on-write), so no upfront copy is needed. Successive deletions only need the return
  // value fed into the next input
  let coords: FeatureCoordinates = coordinatesOf(feature);
  let deletedCount = 0;

  for (const ref of sortedRefs) {
    const result = deleteVertexOp(
      { ...feature, geometry: geometryFromCoordinates(feature.type, coords) },
      ref,
    );
    if (result !== null) {
      coords = result;
      deletedCount++;
    }
  }

  if (deletedCount > 0) {
    store.transact(() => {
      store.updateFeature(selection.featureId, {
        geometry: geometryFromCoordinates(feature.type, coords),
      });
      store.setSelectedVertices(null);
    });
  }

  return deletedCount;
}
