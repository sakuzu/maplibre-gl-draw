// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Feature API
 *
 * Provides the Feature CRUD operations of MapLibreGLDraw.
 * It is composed into createDrawAPI by spreading.
 */

import { isFeatureLocked } from '../store/lock.js';
import type { Store } from '../store/store.js';
import type { Feature, FeatureInput } from '../store/types.js';
import type { MapLibreGLDraw } from './api.js';

export type FeatureApi = Pick<
  MapLibreGLDraw,
  | 'addFeature'
  | 'getFeature'
  | 'getAllFeatures'
  | 'getVisibleFeatures'
  | 'updateFeature'
  | 'deleteFeature'
  | 'deleteAllFeatures'
>;

export interface FeatureApiDeps {
  store: Store;
  generateFeatureId: () => string;
  getActiveLayerId: () => string;
}

export function createFeatureApi(deps: FeatureApiDeps): FeatureApi {
  const { store, generateFeatureId, getActiveLayerId } = deps;

  return {
    addFeature(input: FeatureInput): string | null {
      const feature: Feature = {
        id: input.id ?? generateFeatureId(),
        type: input.type,
        geometry: input.geometry,
        layerId: input.layerId ?? getActiveLayerId(),
        properties: input.properties ?? {},
        style: input.style ?? {},
        locked: input.locked ?? false,
        visible: input.visible ?? true,
      };
      // A write refused because the Store is read-only returns null
      return store.createFeature(feature) ? feature.id : null;
    },

    getFeature(id: string): Feature | undefined {
      return store.getFeature(id);
    },

    getAllFeatures(): Feature[] {
      return featuresInDisplayOrder(store);
    },

    getVisibleFeatures(): Feature[] {
      return store.getOrderedFeatures();
    },

    updateFeature(id: string, updates: Partial<Feature>): boolean {
      // While locked (either itself, its group or its layer), reject changes to any
      // attribute other than locked/visible (Miro-style full protection). locked/visible are
      // allowed so that it can be unlocked and its visibility toggled.
      const feature = store.getFeature(id);
      if (feature && isFeatureLocked(feature, store) && !onlyLockOrVisibility(updates)) {
        return false;
      }
      // An id that does not exist throws in the Store (unless it is read-only)
      return store.updateFeature(id, updates);
    },

    deleteFeature(id: string): boolean {
      return store.deleteFeature(id);
    },

    deleteAllFeatures(): boolean {
      const features = store.getAllFeatures();
      return store.transact(() => {
        let applied = true;
        for (const feature of features) {
          if (!store.getFeature(feature.id)) continue;
          applied = store.deleteFeature(feature.id) && applied;
        }
        return applied;
      });
    },
  };
}

/** Whether an update changes nothing but `locked` / `visible` (what a lock still allows) */
export function onlyLockOrVisibility(updates: object): boolean {
  return Object.keys(updates).every((key) => key === 'locked' || key === 'visible');
}

/**
 * Every feature in display order (layer order -> order within the layer -> order within the
 * group), whatever the visible flags say. A feature that no container lists (which the
 * Store's containment invariant rules out) is appended at the end.
 */
function featuresInDisplayOrder(store: Store): Feature[] {
  const result: Feature[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    const feature = store.getFeature(id);
    if (feature && !seen.has(id)) {
      seen.add(id);
      result.push(feature);
    }
  };
  for (const layerId of store.getLayerOrder()) {
    const layer = store.getLayer(layerId);
    if (!layer) continue;
    for (const itemId of layer.items) {
      const group = store.getGroup(itemId);
      if (group) {
        for (const featureId of group.featureIds) push(featureId);
      } else {
        push(itemId);
      }
    }
  }
  for (const feature of store.getAllFeatures()) push(feature.id);
  return result;
}
