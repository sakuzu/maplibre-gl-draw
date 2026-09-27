// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Layer / group operation API
 *
 * Provides operations such as moving items between layers, adding features to / removing
 * features from a group, and grouping / ungrouping the selected features.
 */

import type { AutoNameGenerator } from '../shared/utils/name-generator.js';
import type { Store } from '../store/store.js';
import type { Feature, Group } from '../store/types.js';

/**
 * Deletes the group if it has become empty (the standard behavior of canvas tools).
 * Called at the end of each path that moves or removes a feature out of a group.
 */
function deleteGroupIfEmpty(store: Store, groupId: string): void {
  const group = store.getGroup(groupId);
  if (group && group.featureIds.length === 0) {
    store.deleteGroup(groupId);
  }
}

/**
 * Moves a feature or a group to another layer
 *
 * @internal
 */
export function moveToLayer(store: Store, itemId: string, targetLayerId: string): void {
  const feature = store.getFeature(itemId);
  const group = store.getGroup(itemId);

  if (feature) {
    moveFeatureToLayer(store, feature, itemId, targetLayerId);
  } else if (group) {
    moveGroupToLayer(store, group, itemId, targetLayerId);
  }
}

function moveFeatureToLayer(
  store: Store,
  feature: Feature,
  itemId: string,
  targetLayerId: string,
): void {
  const targetLayer = store.getLayer(targetLayerId);
  if (!targetLayer) return;

  // Do nothing when it is already in the same layer
  if (feature.layerId === targetLayerId && !feature.groupId) return;

  const previousGroupId = feature.groupId;
  store.transact(() => {
    // When it belongs to a group, remove it from the group
    if (feature.groupId) {
      const currentGroup = store.getGroup(feature.groupId);
      if (currentGroup) {
        store.updateGroup(feature.groupId, {
          featureIds: currentGroup.featureIds.filter((id) => id !== itemId),
        });
      }
    } else {
      // When it is a standalone feature, remove it from the original layer
      const sourceLayer = store.getLayer(feature.layerId);
      if (sourceLayer) {
        const sourceOrder = sourceLayer.items.filter((id) => id !== itemId);
        store.updateLayer(sourceLayer.id, { items: sourceOrder });
      }
    }

    // Add it to the new layer
    store.updateLayer(targetLayerId, { items: [...targetLayer.items, itemId] });

    // Update the layerId of the feature and clear its groupId
    store.updateFeature(itemId, { layerId: targetLayerId, groupId: undefined });

    // Delete the source group when it has become empty
    if (previousGroupId) {
      deleteGroupIfEmpty(store, previousGroupId);
    }
  });
}

function moveGroupToLayer(store: Store, group: Group, itemId: string, targetLayerId: string): void {
  // Find the layer the group belongs to
  let sourceLayerId: string | null = null;
  for (const layer of store.listLayers()) {
    if (layer.items.includes(itemId)) {
      sourceLayerId = layer.id;
      break;
    }
  }

  if (sourceLayerId && sourceLayerId !== targetLayerId) {
    const sourceLayer = store.getLayer(sourceLayerId);
    const targetLayer = store.getLayer(targetLayerId);

    if (sourceLayer && targetLayer) {
      store.transact(() => {
        // Remove it from the original layer
        const sourceOrder = sourceLayer.items.filter((id) => id !== itemId);
        store.updateLayer(sourceLayerId, { items: sourceOrder });

        // Add it to the new layer
        store.updateLayer(targetLayerId, { items: [...targetLayer.items, itemId] });

        // Update the layerId of the features inside the group
        for (const featureId of group.featureIds) {
          store.updateFeature(featureId, { layerId: targetLayerId });
        }
      });
    }
  }
}

/**
 * Adds a feature to a group
 *
 * @internal
 */
export function addFeatureToGroup(
  store: Store,
  featureId: string,
  groupId: string,
  index?: number,
): void {
  const feature = store.getFeature(featureId);
  const group = store.getGroup(groupId);

  if (!feature || !group) return;
  // Do nothing when it is already included in this group
  if (group.featureIds.includes(featureId)) return;

  // Find the layer the group belongs to
  let targetLayerId: string | null = null;
  for (const layer of store.listLayers()) {
    if (layer.items.includes(groupId)) {
      targetLayerId = layer.id;
      break;
    }
  }

  store.transact(() => {
    // When the feature already belongs to another group, remove it from that group
    if (feature.groupId && feature.groupId !== groupId) {
      const oldGroupId = feature.groupId;
      const oldGroup = store.getGroup(oldGroupId);
      if (oldGroup) {
        store.updateGroup(oldGroupId, {
          featureIds: oldGroup.featureIds.filter((id) => id !== featureId),
        });
        // Delete the source group when it has become empty
        deleteGroupIfEmpty(store, oldGroupId);
      }
    }

    // Remove the feature from the order of the layer (when it is included in order on its own)
    const layer = store.getLayer(feature.layerId);
    if (layer?.items.includes(featureId)) {
      const newOrder = layer.items.filter((id) => id !== featureId);
      store.updateLayer(layer.id, { items: newOrder });
    }

    // Add the feature to the group (when an index is given, insert it at that position)
    const newFeatureIds = [...group.featureIds];
    if (index !== undefined && index >= 0 && index <= newFeatureIds.length) {
      newFeatureIds.splice(index, 0, featureId);
    } else {
      newFeatureIds.push(featureId);
    }
    store.updateGroup(groupId, { featureIds: newFeatureIds });

    // Set the groupId and the layerId (when needed) on the feature
    const updates: { groupId: string; layerId?: string } = { groupId };
    if (targetLayerId && feature.layerId !== targetLayerId) {
      updates.layerId = targetLayerId;
    }
    store.updateFeature(featureId, updates);
  });
}

/**
 * Removes a feature from a group
 *
 * @internal
 */
export function removeFeatureFromGroup(store: Store, featureId: string): void {
  const feature = store.getFeature(featureId);
  if (!feature?.groupId) return;

  const group = store.getGroup(feature.groupId);
  if (!group) return;

  // Find the layer the group belongs to
  let layerId: string | null = null;
  for (const layer of store.listLayers()) {
    if (layer.items.includes(group.id)) {
      layerId = layer.id;
      break;
    }
  }

  store.transact(() => {
    // Remove the feature from the group
    const newFeatureIds = group.featureIds.filter((id) => id !== featureId);
    store.updateGroup(group.id, { featureIds: newFeatureIds });

    // Remove the groupId from the feature
    store.updateFeature(featureId, { groupId: undefined });

    // Add the feature to the order of the layer (right after the group)
    if (layerId) {
      const layer = store.getLayer(layerId);
      if (layer) {
        const groupIndex = layer.items.indexOf(group.id);
        const newOrder = [...layer.items];
        newOrder.splice(groupIndex + 1, 0, featureId);
        store.updateLayer(layerId, { items: newOrder });
      }
    }

    // Delete the group when it has become empty (after the feature has been moved out
    // directly under the layer)
    deleteGroupIfEmpty(store, group.id);
  });
}

/**
 * Groups the selected features
 *
 * @returns The group ID, or null when grouping was not possible
 *
 * @internal
 */
export function groupSelection(
  store: Store,
  generateFeatureId: () => string,
  autoNameGenerator: AutoNameGenerator,
): string | null {
  const selection = store.getSelection();

  // Do nothing when it is not a feature selection
  if (selection.type !== 'feature') return null;

  const selectedIds = selection.ids;

  // Condition 1: two or more features are selected
  const features = selectedIds
    .map((id) => store.getFeature(id))
    .filter((f): f is Feature => f !== undefined);

  if (features.length < 2) return null;

  // Condition 2: they all belong to the same layer
  const layerIds = new Set(features.map((f) => f.layerId));
  if (layerIds.size !== 1) return null;
  const layerId = features[0].layerId;

  // Condition 3: they do not yet belong to a group that actually exists.
  // When the groupId is a stale value that points to a deleted group, it is regarded as
  // belonging to nothing and regrouping is allowed (createGroup overwrites the groupId of the
  // members with the new value, so it is repaired automatically here).
  if (features.some((f) => f.groupId !== undefined && store.getGroup(f.groupId) !== undefined)) {
    return null;
  }

  // Create the group
  const groupId = generateFeatureId();
  const groupName = autoNameGenerator.generateGroupName();

  const group: Group = {
    id: groupId,
    layerId,
    name: groupName,
    featureIds: [...selectedIds],
    locked: false,
    visible: true,
  };

  store.transact(() => {
    // Remove the feature IDs from the order of the layer and add the group ID
    const layer = store.getLayer(layerId);
    if (layer) {
      // Find the frontmost one (the largest index) among the selected features
      let frontmostSelectedId: string | null = null;
      for (let i = layer.items.length - 1; i >= 0; i--) {
        if (selectedIds.includes(layer.items[i])) {
          frontmostSelectedId = layer.items[i];
          break;
        }
      }

      // Build the new order (insert the group at the position of the frontmost selected feature)
      const newOrder: string[] = [];
      for (const id of layer.items) {
        if (selectedIds.includes(id)) {
          // Insert the group at the position of the frontmost selected feature
          if (id === frontmostSelectedId) {
            newOrder.push(groupId);
          }
          // The selected features are excluded from the order
        } else {
          newOrder.push(id);
        }
      }
      // Even when not a single selected feature is included in order (for example when they
      // are missing from order because of stale data), the group is appended at the tail so
      // that it is not left out of order.
      if (frontmostSelectedId === null) {
        newOrder.push(groupId);
      }
      store.updateLayer(layerId, { items: newOrder });
    }

    // Create the group
    store.createGroup(group);
  });

  return groupId;
}

/**
 * Dissolves a group (outside a transaction, a pure mutation).
 * It removes the group from the order, expands its member features into the same position,
 * and then deletes the group itself. The caller must wrap it in store.transact.
 */
function dissolveGroup(store: Store, groupId: string): void {
  const group = store.getGroup(groupId);
  if (!group) return;

  // Identify the layer the group belongs to
  let targetLayerId: string | null = null;
  for (const layer of store.listLayers()) {
    if (layer.items.includes(groupId)) {
      targetLayerId = layer.id;
      break;
    }
  }

  if (!targetLayerId) return;

  // Remove the group ID from the order of the layer and expand the feature IDs into the same
  // position
  const layer = store.getLayer(targetLayerId);
  if (layer) {
    const groupIndex = layer.items.indexOf(groupId);
    const newOrder = [...layer.items];
    newOrder.splice(groupIndex, 1, ...group.featureIds);
    store.updateLayer(targetLayerId, { items: newOrder });
  }

  // Delete the group
  store.deleteGroup(groupId);
}

/**
 * Dissolves the given group (it does not depend on the selection).
 * For "ungroup that group" in a panel menu and the like.
 *
 * @internal
 */
export function ungroupGroup(store: Store, groupId: string): void {
  store.transact(() => {
    dissolveGroup(store, groupId);
  });
}

/**
 * Takes the selection out of the group structure (following Felt).
 *
 * - When a group is selected -> that group is dissolved (its children are expanded into the
 *   original position)
 * - When a member feature of a group is selected -> only that feature is taken out of the
 *   group (the group is kept; the member is placed right after the group by
 *   removeFeatureFromGroup, and the group is deleted automatically when it becomes empty).
 *   The group is not dissolved as a whole
 * - Otherwise (a feature that is not a member / no selection) -> nothing is done
 *
 * Even with several targets it is gathered into one transaction, making it one undo unit.
 *
 * @internal
 */
export function ungroupSelection(store: Store): void {
  const selection = store.getSelection();
  if (selection.ids.length === 0) return;

  // A group selection -> dissolve
  if (selection.type === 'group') {
    store.transact(() => {
      for (const groupId of selection.ids) {
        dissolveGroup(store, groupId);
      }
    });
    return;
  }

  // A feature selection -> take only the selected members out of the group (do not dissolve)
  if (selection.type === 'feature') {
    const memberIds = selection.ids.filter((id) => store.getFeature(id)?.groupId !== undefined);
    if (memberIds.length === 0) return;

    store.transact(() => {
      for (const id of memberIds) {
        removeFeatureFromGroup(store, id);
      }
    });
  }
}
