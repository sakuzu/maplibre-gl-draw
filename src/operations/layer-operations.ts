// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Layer / group operation API
 *
 * Provides operations such as moving items between layers, adding features to / removing
 * features from a group, and grouping / ungrouping the selected features.
 */

import type { AutoNameGenerator } from '../shared/utils/name-generator.js';
import type { InstanceDocument } from '../store/document-access.js';
import type { Feature, Group } from '../store/types.js';

/**
 * Takes a feature out of its group: it stands just in front of the group in the layer, or in its
 * place when it was the last feature of the group, which goes then
 *
 * @returns False when the Store refused the write
 * @internal
 */
export function takeOutOfGroup(store: InstanceDocument, featureId: string): boolean {
  // The edit being written in parts is applied first to the feature read to be written
  store.applyEditFirst?.(featureId);
  const feature = store.getFeature(featureId);
  if (!feature?.groupId || !store.getGroup(feature.groupId)) return true;
  return store.moveFeatures([featureId], { kind: 'ungroup' });
}

/**
 * Groups the selected features
 *
 * @returns The group ID, or null when grouping was not possible
 *
 * @internal
 */
export function groupSelection(
  store: InstanceDocument,
  generateFeatureId: () => string,
  autoNameGenerator: AutoNameGenerator,
): string | null {
  const selection = store.getSelection();

  // Do nothing when it is not a feature selection
  if (selection.type !== 'feature') return null;

  const selectedIds = [...selection.ids.iterate()];

  // The group writes the features read: the edit being written in parts is applied to them first
  for (const id of selectedIds) store.applyEditFirst?.(id);

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

  // Create the group: it stands where the frontmost of the features stood, and they keep their
  // stacking order in it
  const groupId = generateFeatureId();
  const groupName = autoNameGenerator.generateGroupName();

  const group: Group = {
    id: groupId,
    layerId,
    name: groupName,
    locked: false,
    visible: true,
  };

  // A write the Store refused makes no group, as read-only does
  if (!store.createGroupWith(group, selectedIds)) return null;
  return groupId;
}

/**
 * Takes the selection out of the group structure (following Felt).
 *
 * - When a group is selected -> that group is dissolved (its children are expanded into the
 *   original position)
 * - When a member feature of a group is selected -> only that feature is taken out of the
 *   group (the group is kept; the member is placed right in front of the group by
 *   takeOutOfGroup, and the group is deleted automatically when it becomes empty).
 *   The group is not dissolved as a whole
 * - Otherwise (a feature that is not a member / no selection) -> nothing is done
 *
 * Even with several targets it is gathered into one transaction, making it one undo unit.
 *
 * @returns Whether a group was dissolved or a feature taken out of its group
 * @internal
 */
export function ungroupSelection(store: InstanceDocument): boolean {
  const selection = store.getSelection();
  if (selection.ids.count() === 0) return false;

  // A group selection -> dissolve: its features take its place in the layer
  if (selection.type === 'group') {
    const groupIds = [...selection.ids.iterate()].filter((id) => store.getGroup(id) !== undefined);
    if (groupIds.length === 0) return false;
    // A write the Store refuses stops the operation, which returns what read-only returns
    const done = store.transactUntilRefused(() => {
      for (const groupId of groupIds) {
        if (store.getGroup(groupId) && !store.deleteGroup(groupId)) return false;
      }
      return true;
    });
    return done === true;
  }

  // A feature selection -> take only the selected members out of the group (do not dissolve)
  if (selection.type === 'feature') {
    // Before the transaction opens, the edit being written in parts is applied first to the
    // features read to be taken out of their group
    const selectedIds = [...selection.ids.iterate()];
    for (const id of selectedIds) store.applyEditFirst?.(id);
    const memberIds = selectedIds.filter((id) => store.getFeature(id)?.groupId !== undefined);
    if (memberIds.length === 0) return false;

    // One at a time, each just in front of its group; a write the Store refuses stops them, and
    // the operation returns what read-only returns
    const done = store.transactUntilRefused(() => {
      for (const id of memberIds) {
        if (!takeOutOfGroup(store, id)) return false;
      }
      return true;
    });
    return done === true;
  }
  return false;
}
