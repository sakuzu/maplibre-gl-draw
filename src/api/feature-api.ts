// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Feature API
 *
 * Provides the Feature CRUD operations of MapLibreGLDraw.
 * It is composed into createDrawAPI by spreading.
 */

import { listShownFeatures } from '../store/local-visibility.js';
import { isFeatureLocked } from '../store/lock.js';
import { listEveryFeatureInOrder } from '../store/ordering.js';
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
        groupId: undefined,
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
      return listEveryFeatureInOrder(store);
    },

    getVisibleFeatures(): Feature[] {
      return listShownFeatures(store);
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
      const features = store.listFeatures();
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
