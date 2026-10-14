// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Layer / group operation API
 *
 * Provides operations such as moving items between layers, adding features to / removing
 * features from a group, and grouping / ungrouping the selected features.
 */

import type { AutoNameGenerator } from '../shared/utils/name-generator.js';
import { insertGroup, itemNeighbors } from '../store/item-lists.js';
import type { Store } from '../store/store.js';
import type { Feature, ObjectGroup } from '../store/types.js';
import { groupBulkSelection, ungroupBulkSelection } from './bulk-selection.js';

/**
 * Removes a feature from a group: it goes just in front of the group in the layer (or to the
 * place of the group, when it was the last member and the group is deleted)
 *
 * @internal
 */
export function takeOutOfGroup(store: Store, featureId: string): void {
  const feature = store.getFeature(featureId);
  if (!feature?.groupId) return;

  const group = store.getGroup(feature.groupId);
  if (!group) return;

  const around = itemNeighbors(store, group.layerId, undefined, group.id);
  store.moveItems([featureId], {
    layerId: group.layerId,
    below: group.id,
    above: around?.above ?? null,
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

  // Features selected in bulk: grouped on their rows
  if (selection.bulk) return groupBulkSelection(store, generateFeatureId, autoNameGenerator);

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

  const group: ObjectGroup = {
    id: groupId,
    layerId,
    name: groupName,
    featureIds: [...selectedIds],
    locked: false,
    visible: true,
  };

  // The group takes the place of the frontmost selected feature in the layer
  store.transact(() => insertGroup(store, group));

  return groupId;
}

/**
 * Dissolves a group (outside a transaction): its member features take its place in the order of
 * its layer, and it is deleted. The caller wraps it in store.transact.
 */
function dissolveGroup(store: Store, groupId: string): void {
  if (!store.getGroup(groupId)) return;
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
 * @returns Whether a group was dissolved or a feature taken out of its group
 * @internal
 */
export function ungroupSelection(store: Store): boolean {
  const selection = store.getSelection();
  // Features selected in bulk: taken out of their groups on their rows
  if (selection.bulk && selection.type === 'feature') return ungroupBulkSelection(store);
  if (selection.ids.length === 0) return false;

  // A group selection -> dissolve
  if (selection.type === 'group') {
    const groupIds = selection.ids.filter((id) => store.getGroup(id) !== undefined);
    if (groupIds.length === 0) return false;
    store.transact(() => {
      for (const groupId of groupIds) {
        dissolveGroup(store, groupId);
      }
    });
    return true;
  }

  // A feature selection -> take only the selected members out of the group (do not dissolve)
  if (selection.type === 'feature') {
    const memberIds = selection.ids.filter((id) => store.getFeature(id)?.groupId !== undefined);
    if (memberIds.length === 0) return false;

    store.transact(() => {
      for (const id of memberIds) {
        takeOutOfGroup(store, id);
      }
    });
    return true;
  }
  return false;
}
