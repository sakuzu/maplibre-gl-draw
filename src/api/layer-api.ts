// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Layer API
 *
 * Provides the Layer CRUD and Active Layer operations of MapLibreGLDraw.
 */

import { moveToLayer as moveToLayerImpl } from '../operations/layer-operations.js';
import type { AutoNameGenerator } from '../shared/utils/name-generator.js';
import type { Store } from '../store/store.js';
import type { Layer } from '../store/types.js';
import type { MapLibreGLDraw } from './api.js';
import { onlyLockOrVisibility } from './feature-api.js';

export type LayerApi = Pick<
  MapLibreGLDraw,
  | 'getAllLayers'
  | 'getLayer'
  | 'addLayer'
  | 'updateLayer'
  | 'deleteLayer'
  | 'getLayerOrder'
  | 'setLayerOrder'
  | 'reorderInLayer'
  | 'moveToLayer'
  | 'getActiveLayer'
  | 'setActiveLayer'
>;

export interface LayerApiDeps {
  store: Store;
  generateFeatureId: () => string;
  autoNameGenerator: AutoNameGenerator;
  getActiveLayerId: () => string;
  setActiveLayerId: (id: string) => void;
}

export function createLayerApi(deps: LayerApiDeps): LayerApi {
  const { store, generateFeatureId, autoNameGenerator, getActiveLayerId, setActiveLayerId } = deps;

  return {
    getAllLayers(): Layer[] {
      return store.getAllLayers();
    },

    getLayer(id: string): Layer | undefined {
      return store.getLayer(id);
    },

    addLayer(name?: string): string | null {
      const id = generateFeatureId();
      const layerName = name || autoNameGenerator.generateLayerName();
      const layer: Layer = {
        id,
        name: layerName,
        visible: true,
        locked: false,
        opacity: 1,
        order: [],
      };
      // A write refused because the Store is read-only returns null
      return store.createLayer(layer) ? id : null;
    },

    updateLayer(id: string, updates: Partial<Layer>): boolean {
      // While locked, reject any change other than locked/visible (full protection)
      const layer = store.getLayer(id);
      if (layer?.locked && !onlyLockOrVisibility(updates)) return false;
      return store.updateLayer(id, updates);
    },

    deleteLayer(id: string): boolean {
      return store.deleteLayer(id);
    },

    getLayerOrder(): readonly string[] {
      return store.getLayerOrder();
    },

    setLayerOrder(order: string[]): boolean {
      return store.setLayerOrder(order);
    },

    reorderInLayer(itemId: string, layerId: string, newIndex: number): boolean {
      return store.reorderInLayer(itemId, layerId, newIndex);
    },

    moveToLayer(itemId: string, targetLayerId: string): void {
      moveToLayerImpl(store, itemId, targetLayerId);
    },

    getActiveLayer(): string {
      return getActiveLayerId();
    },

    setActiveLayer(layerId: string): void {
      setActiveLayerId(layerId);
    },
  };
}
