// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Derivation of local visibility
 *
 * Resolves the visibility hidden only on this client (the set accumulated by
 * setLocallyHidden) through a 3-step cascade of the feature (the ids of itself / the
 * group it belongs to / the layer it belongs to). It is a layer separate from the shared
 * visible, and rendering, hit testing and box selection respect it.
 *
 * A pure function with the same standing as lock.ts (isFeatureLocked). It does not change
 * the shared data (feature.visible and so on) at all. getOrderedFeatures is kept pure and
 * this is derived separately here.
 */

import type { Feature } from './types.js';

/** The minimal interface that isLocallyHidden requires. */
export interface LocalHiddenStore {
  isLocallyHidden(id: string): boolean;
}

/** The minimal interface that getDisplayFeatures requires. */
export interface DisplayStore extends LocalHiddenStore {
  getOrderedFeatures(): Feature[];
}

/**
 * Whether the feature is locally hidden on this client (true if itself / the group it
 * belongs to / the layer it belongs to is in the hidden set).
 *
 * @internal
 */
export function isLocallyHidden(feature: Feature, store: LocalHiddenStore): boolean {
  if (store.isLocallyHidden(feature.id)) return true;
  if (feature.groupId && store.isLocallyHidden(feature.groupId)) return true;
  if (store.isLocallyHidden(feature.layerId)) return true;
  return false;
}

/**
 * The list of features that should be displayed, for rendering and hit testing.
 * getOrderedFeatures (the pure list narrowed by the shared visible) with the locally
 * hidden ones removed on top of that.
 *
 * @internal
 */
export function getDisplayFeatures(store: DisplayStore): Feature[] {
  return store.getOrderedFeatures().filter((feature) => !isLocallyHidden(feature, store));
}
