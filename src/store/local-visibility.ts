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
 * the shared data (feature.visible and so on) at all. listFeaturesInOrder lists every feature,
 * and the visible flags and local hiding are applied here.
 */

import type { Feature, Group, Layer } from './types.js';

/** The minimal interface that isLocallyHidden requires. */
export interface LocalHiddenStore {
  isHidden(id: string): boolean;
}

/** The minimal interface that listShownFeatures requires. */
export interface OrderedStore {
  listFeaturesInOrder(): Feature[];
  getLayer(id: string): Layer | undefined;
  getGroup(id: string): Group | undefined;
}

/** The minimal interface that getDisplayFeatures requires. */
export interface DisplayStore extends LocalHiddenStore, OrderedStore {}

/**
 * Whether the feature is locally hidden on this client (true if itself / the group it
 * belongs to / the layer it belongs to is in the hidden set).
 *
 * @internal
 */
export function isLocallyHidden(feature: Feature, store: LocalHiddenStore): boolean {
  if (store.isHidden(feature.id)) return true;
  if (feature.groupId && store.isHidden(feature.groupId)) return true;
  if (store.isHidden(feature.layerId)) return true;
  return false;
}

/**
 * The features the document shows, in stacking order: listFeaturesInOrder without the ones
 * whose own visible flag, or the one of their group or layer, is off. Local hiding is not
 * applied.
 *
 * @internal
 */
export function listShownFeatures(store: OrderedStore): Feature[] {
  const layers = new Map<string, boolean>();
  const groups = new Map<string, boolean>();
  const layerShown = (id: string): boolean => {
    let shown = layers.get(id);
    if (shown === undefined) {
      shown = store.getLayer(id)?.visible === true;
      layers.set(id, shown);
    }
    return shown;
  };
  const groupShown = (id: string): boolean => {
    let shown = groups.get(id);
    if (shown === undefined) {
      shown = store.getGroup(id)?.visible !== false;
      groups.set(id, shown);
    }
    return shown;
  };
  return store
    .listFeaturesInOrder()
    .filter(
      (feature) =>
        feature.visible &&
        layerShown(feature.layerId) &&
        (feature.groupId === undefined || groupShown(feature.groupId)),
    );
}

/**
 * The list of features that should be displayed, for rendering and hit testing:
 * listShownFeatures with the locally hidden ones removed on top of that.
 *
 * @internal
 */
export function getDisplayFeatures(store: DisplayStore): Feature[] {
  return listShownFeatures(store).filter((feature) => !isLocallyHidden(feature, store));
}
