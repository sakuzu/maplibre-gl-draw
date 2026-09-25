// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Visibility lookup for hit testing
 *
 * Whether a feature can be selected is decided by the visible flag of the feature itself,
 * its layer and its group. A single hit test asks this once per feature, so looking the
 * store up for every feature makes one test O(N^2) on implementations where reading a
 * layer costs time proportional to the feature count N (such as a replaced DocumentStore
 * that copies the order array on every read). Here each layer and group is looked up only
 * once per hit test, and features reuse the result of that lookup.
 *
 * The lookup is built for each hit test call (it is never carried over across store changes).
 */

import type { Store } from '../../store/store.js';
import type { Feature } from '../../store/types.js';

export type VisibilityLookup = (feature: Feature) => boolean;

/**
 * Builds the lookup for a single hit test.
 *
 * Features that are not visible (any of feature / layer / group has visible=false) are not
 * drawn, so they are excluded from the targets. A lock forbids interaction, not selection,
 * so it is not consulted here.
 */
export function createVisibilityLookup(store: Store): VisibilityLookup {
  const layers = new Map<string, boolean>();
  const groups = new Map<string, boolean>();

  const layerVisible = (id: string): boolean => {
    let visible = layers.get(id);
    if (visible === undefined) {
      const layer = store.getLayer(id);
      visible = !layer || layer.visible;
      layers.set(id, visible);
    }
    return visible;
  };

  const groupVisible = (id: string): boolean => {
    let visible = groups.get(id);
    if (visible === undefined) {
      const group = store.getGroup(id);
      visible = !group || group.visible;
      groups.set(id, visible);
    }
    return visible;
  };

  return (feature) => {
    if (!feature.visible) return false;
    if (!layerVisible(feature.layerId)) return false;
    if (feature.groupId && !groupVisible(feature.groupId)) return false;
    return true;
  };
}
