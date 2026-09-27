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
 * Removes a feature from a group
 *
 * @internal
 */
export function takeOutOfGroup(store: Store, featureId: string): void {
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
 * Takes the selection out of the group structure (following Felt).
 *
 * - When a group is selected -> that group is dissolved (its children are expanded into the
 *   original position)
 * - When a member feature of a group is selected -> only that feature is taken out of the
 *   group (the group is kept; the member is placed right after the group by
 *   takeOutOfGroup, and the group is deleted automatically when it becomes empty).
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
        takeOutOfGroup(store, id);
      }
    });
  }
}
