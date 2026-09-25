// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Derivation of the locked state
 *
 * Determines the "effective lock" of a feature. A lock is inherited top-down: if the
 * feature itself, the group it belongs to, or the layer it belongs to is locked, then
 * that feature is regarded as not operable (move/resize/rotate/vertex editing/delete).
 *
 * A lock is "forbidding operations", not "forbidding selection or display". Selection is
 * allowed, and the operation side (drag/delete/handle display) uses this predicate to
 * reject the operation.
 */

import type { Feature, Group, Layer } from './types.js';

/**
 * What {@link isFeatureLocked} reads: the groups and the layers
 *
 * {@link StoreView}, {@link Store} and {@link PluginContext} all satisfy it, so the lock
 * decision can be made from the host and from plugins as well.
 */
export interface FeatureLockStore {
  /** Returns the group with this ID, or undefined */
  getGroup(id: string): Group | undefined;
  /** Returns the layer with this ID, or undefined */
  getLayer(id: string): Layer | undefined;
}

/**
 * Whether the feature is effectively locked: by itself, by its group or by its layer
 *
 * A lock is inherited top-down. A locked feature can still be selected; it cannot be moved,
 * resized, rotated, reshaped or deleted by the user.
 *
 * @example
 * ```ts
 * const feature = draw.getFeature(id);
 * if (feature && !isFeatureLocked(feature, draw.getStore())) draw.deleteFeature(id);
 * ```
 */
export function isFeatureLocked(feature: Feature, store: FeatureLockStore): boolean {
  if (feature.locked) return true;

  if (feature.groupId) {
    const group = store.getGroup(feature.groupId);
    if (group?.locked) return true;
  }

  const layer = store.getLayer(feature.layerId);
  if (layer?.locked) return true;

  return false;
}

/**
 * What {@link isInteractionBlocked} reads: {@link FeatureLockStore} plus read-only and the
 * interaction lock
 */
export interface InteractionGateStore extends FeatureLockStore {
  /** Whether the Store is read-only */
  isReadOnly(): boolean;
  /** Whether the interaction lock is on */
  isInteractionLocked(): boolean;
}

/**
 * Whether the "start" of an editing interaction on this feature should be suppressed.
 *
 * True if any of readOnly, the interaction lock or the effective lock is set.
 * readOnly means "an operation whose start is meaningless because writing is a no-op",
 * the interaction lock means "suppressing operations in a read-only state", and feature
 * locked means "the lock of that individual feature".
 * All of them are suppression decisions at the starting point, orthogonal to the Store's
 * write gate (which readOnly is responsible for).
 * This predicate is used to reject at the origin of user input, such as the start of a
 * drag or the display of selection handles.
 */
export function isInteractionBlocked(feature: Feature, store: InteractionGateStore): boolean {
  return store.isReadOnly() || store.isInteractionLocked() || isFeatureLocked(feature, store);
}

/**
 * Whether the group is effectively locked: by itself or by the layer it belongs to
 *
 * @param findLayerOfGroup A function that returns the layer the group belongs to
 *   (because groups are stored in layer.order, the caller resolves it and passes it in)
 */
export function isGroupLocked(
  group: Group,
  findLayerOfGroup: (groupId: string) => Layer | undefined,
): boolean {
  if (group.locked) return true;
  const layer = findLayerOfGroup(group.id);
  return layer?.locked ?? false;
}
