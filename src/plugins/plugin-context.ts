// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugin Context
 *
 * Creates the context through which a plugin accesses the Store, the
 * EventEmitter and the other components.
 */

import type { Feature as GeoJSONFeature } from 'geojson';
import type { MapLibreGLDraw } from '../api/api.js';
import type { ModeManager } from '../modes/manager.js';
import type { EventEmitter } from '../shared/utils/event-emitter.js';
import { createId } from '../shared/utils/id.js';
import type { AutoNameGenerator } from '../shared/utils/name-generator.js';
import type { StoreSpatialIndex } from '../store/spatial/store-spatial-index.js';
import type { Store } from '../store/store.js';
import type { Feature, Group, Layer, Mode, UpdateSource } from '../store/types.js';
import {
  anchorElevationMeters,
  getAnchorElevationGeneration,
  projectAnchor,
} from '../view/terrain/anchor.js';
import type { TerrainContext } from '../view/terrain/context.js';
import {
  computeBoundingBox,
  type SelectionExtensionRegistry,
} from '../view/ui/selection-ui/index.js';
import type { PluginContext } from './plugin.js';

/**
 * Dependencies required to create a PluginContext
 *
 * @internal
 */
export interface PluginContextDependencies {
  store: Store;
  eventEmitter: EventEmitter;
  /** The automatic naming of this draw instance */
  autoNameGenerator: AutoNameGenerator;
  /** The spatial index derived from the Store (only its invalidation is used) */
  spatialIndex: Pick<StoreSpatialIndex, 'invalidateType'>;
  getActiveLayerId: () => string;
  findLayerForItem: (itemId: string) => string | undefined;
  findGroupForFeature: (featureId: string) => string | undefined;
  getModeManager: () => ModeManager;
  /**
   * Obtains the MapLibreGLDraw instance itself lazily (because createDrawAPI
   * runs after createPluginContext)
   */
  getDraw: () => MapLibreGLDraw;
  /** The terrain state of this draw instance (read by the anchor projection) */
  terrain: TerrainContext;
  /** The selection extension points of this draw instance (custom bounding boxes) */
  selectionExtensions: SelectionExtensionRegistry;
}

/**
 * Create a PluginContext
 *
 * @internal
 */
export function createPluginContext(deps: PluginContextDependencies): PluginContext {
  const {
    store,
    eventEmitter,
    autoNameGenerator,
    spatialIndex,
    getActiveLayerId,
    findLayerForItem,
    findGroupForFeature,
    getModeManager,
    getDraw,
    terrain,
    selectionExtensions,
  } = deps;

  /**
   * Runs a write in a transaction whose notification carries the given source (the source
   * of the outermost transaction applies, so inside batch() it is that of the batch)
   */
  function write(fn: () => void, source: UpdateSource | undefined): void {
    store.transact(fn, source ?? 'local');
  }

  /**
   * Convert features from the GeoJSON Feature form to Feature and add them to
   * the Store
   */
  function addFeaturesToStore(features: GeoJSONFeature[], source?: UpdateSource): string[] {
    const ids: string[] = [];
    const layerId = getActiveLayerId();

    write(() => {
      for (const feature of features) {
        const id = (feature.id as string) ?? createId();
        const drawFeature: Feature = {
          id,
          type: feature.geometry.type as Feature['type'],
          coordinates:
            feature.geometry.type === 'Point'
              ? ((feature.geometry as GeoJSON.Point).coordinates as [number, number])
              : ((feature.geometry as GeoJSON.LineString | GeoJSON.Polygon)
                  .coordinates as Feature['coordinates']),
          layerId,
          properties: feature.properties ?? {},
          locked: false,
          visible: true,
        };

        // Note: adding to layer.order happens automatically inside createFeature().
        // A write refused because the Store is read-only is not listed.
        if (store.createFeature(drawFeature)) ids.push(id);
      }
    }, source);

    return ids;
  }

  return {
    // === Reference to the MapLibreGLDraw instance itself (to call the extension point APIs) ===
    get draw() {
      return getDraw();
    },
    getStore: () => store,
    autoNameGenerator,

    // === Read API ===
    getFeature: (id) => store.getFeature(id),
    getAllFeatures: () => store.getAllFeatures(),
    getGroup: (id) => store.getGroup(id),
    getAllGroups: () => store.getAllGroups(),
    getLayer: (id) => store.getLayer(id),
    getAllLayers: () => store.getAllLayers(),
    getSelection: () => store.getSelection(),
    getSelectedIds: () => {
      const selection = store.getSelection();
      return selection.type === 'feature' ? [...selection.ids] : [];
    },
    // The name is confusing, but this is the order inside the active layer.
    // Use getLayerIds for the stacking order of the layers.
    getLayerOrder: () => {
      const layer = store.getLayer(getActiveLayerId());
      return layer?.order ?? [];
    },
    getLayerIds: () => store.getLayerOrder(),
    getMode: () => store.getMode(),

    // === Feature mutations ===
    addFeatures: (features, source) => addFeaturesToStore(features, source),

    updateFeature: (id, feature, source) => {
      const existing = store.getFeature(id);
      if (existing) {
        const merged: Feature = {
          ...existing,
          ...feature,
          properties: { ...existing.properties, ...feature.properties },
        };
        write(() => store.updateFeature(id, merged), source);
      }
    },

    deleteFeatures: (ids, source) => {
      const idsArray = Array.isArray(ids) ? ids : [ids];
      if (!idsArray.some((id) => store.getFeature(id) !== undefined)) return;

      write(() => {
        // Remove from the selection state (only when features are selected)
        const selection = store.getSelection();
        if (selection.type === 'feature') {
          const remainingSelection = selection.ids.filter((id) => !idsArray.includes(id));
          if (remainingSelection.length !== selection.ids.length) {
            if (remainingSelection.length === 0) {
              store.setSelection(null, []);
            } else {
              store.setSelection('feature', remainingSelection);
            }
          }
        }

        for (const id of idsArray) {
          // Remove from the group
          const groupId = findGroupForFeature(id);
          if (groupId) {
            const group = store.getGroup(groupId);
            if (group) {
              store.updateGroup(groupId, {
                featureIds: group.featureIds.filter((fid) => fid !== id),
              });
            }
          }

          // Remove from the order of the layer
          const layerId = findLayerForItem(id);
          if (layerId) {
            const layer = store.getLayer(layerId);
            if (layer) {
              store.updateLayer(layerId, { order: layer.order.filter((i) => i !== id) });
            }
          }

          store.deleteFeature(id);
        }
      }, source);
    },

    // === Group mutations ===
    createGroup: (group, source) => {
      const newGroup: Group = {
        id: group.id ?? createId(),
        name: group.name,
        visible: group.visible ?? true,
        locked: group.locked ?? false,
        featureIds: group.featureIds ?? [],
      };
      write(() => store.createGroup(newGroup), source);
    },

    updateGroup: (id, updates, source) => {
      if (!store.getGroup(id)) return;
      write(() => store.updateGroup(id, updates), source);
    },

    deleteGroup: (id, source) => {
      if (!store.getGroup(id)) return;
      write(() => store.deleteGroup(id), source);
    },

    addFeatureToGroup: (groupId, featureId, index, source) => {
      write(() => {
        const feature = store.getFeature(featureId);
        const group = store.getGroup(groupId);
        if (!feature || !group) return;
        if (group.featureIds.includes(featureId)) return; // Already contained in the group

        // When the feature already belongs to another group, remove it from that group
        if (feature.groupId && feature.groupId !== groupId) {
          const oldGroup = store.getGroup(feature.groupId);
          if (oldGroup) {
            store.updateGroup(feature.groupId, {
              featureIds: oldGroup.featureIds.filter((id) => id !== featureId),
            });
          }
        }

        // Remove the feature from the order of the layer (when it is contained
        // in the order on its own)
        const currentLayerId = findLayerForItem(featureId);
        if (currentLayerId) {
          const currentLayer = store.getLayer(currentLayerId);
          if (currentLayer?.order.includes(featureId)) {
            store.updateLayer(currentLayerId, {
              order: currentLayer.order.filter((id) => id !== featureId),
            });
          }
        }

        // Add it to the featureIds of the group
        const newFeatureIds = [...group.featureIds];
        if (index !== undefined) {
          newFeatureIds.splice(index, 0, featureId);
        } else {
          newFeatureIds.push(featureId);
        }
        store.updateGroup(groupId, { featureIds: newFeatureIds });

        // Get the layer the group belongs to
        const targetLayerId = findLayerForItem(groupId);

        // Update the groupId and the layerId of the feature
        const updates: { groupId: string; layerId?: string } = { groupId };
        if (targetLayerId && feature.layerId !== targetLayerId) {
          updates.layerId = targetLayerId;
        }
        store.updateFeature(featureId, updates);
      }, source);
    },

    removeFeatureFromGroup: (groupId, featureId, source) => {
      write(() => {
        const group = store.getGroup(groupId);
        const feature = store.getFeature(featureId);
        if (!group || !feature || feature.groupId !== groupId) return;

        // Find the layer the group belongs to
        const layerId = findLayerForItem(groupId);

        // Remove the feature from the group
        store.updateGroup(groupId, {
          featureIds: group.featureIds.filter((id) => id !== featureId),
        });

        // Clear the groupId of the feature
        store.updateFeature(featureId, { groupId: undefined });

        // Add the feature to the order of the layer (right after the group)
        if (layerId) {
          const layer = store.getLayer(layerId);
          if (layer) {
            const groupIndex = layer.order.indexOf(groupId);
            const newOrder = [...layer.order];
            newOrder.splice(groupIndex + 1, 0, featureId);
            store.updateLayer(layerId, { order: newOrder });
          }
        }
      }, source);
    },

    findGroupForFeature,

    // === Layer mutations ===
    createLayer: (layer, source) => {
      const newLayer: Layer = {
        id: layer.id ?? createId(),
        name: layer.name,
        visible: layer.visible ?? true,
        locked: layer.locked ?? false,
        opacity: layer.opacity ?? 1.0,
        order: layer.order ?? [],
      };
      write(() => store.createLayer(newLayer), source);
    },

    updateLayer: (id, updates, source) => {
      if (!store.getLayer(id)) return;
      write(() => store.updateLayer(id, updates), source);
    },

    deleteLayer: (id, source) => {
      if (!store.getLayer(id)) return;
      write(() => store.deleteLayer(id), source);
    },

    addToLayer: (layerId, featureId, source) => {
      const layer = store.getLayer(layerId);
      if (layer && !layer.order.includes(featureId)) {
        write(() => store.updateLayer(layerId, { order: [...layer.order, featureId] }), source);
      }
    },

    removeFromLayer: (layerId, featureId, source) => {
      const layer = store.getLayer(layerId);
      if (layer) {
        const order = layer.order.filter((id) => id !== featureId);
        write(() => store.updateLayer(layerId, { order }), source);
      }
    },

    findLayerForFeature: findLayerForItem,

    moveItemToLayer: (itemId, targetLayerId, targetIndex, source) => {
      write(() => {
        // Remove from the order of the current layer
        const currentLayerId = findLayerForItem(itemId);
        if (currentLayerId) {
          const currentLayer = store.getLayer(currentLayerId);
          if (currentLayer) {
            store.updateLayer(currentLayerId, {
              order: currentLayer.order.filter((id) => id !== itemId),
            });
          }
        }

        // When it belongs to a group, remove it from the group and clear the groupId as well
        const groupId = findGroupForFeature(itemId);
        if (groupId) {
          const group = store.getGroup(groupId);
          if (group) {
            store.updateGroup(groupId, {
              featureIds: group.featureIds.filter((id) => id !== itemId),
            });
          }
          // Clear the groupId of the feature
          const feature = store.getFeature(itemId);
          if (feature) {
            store.updateFeature(itemId, { groupId: undefined, layerId: targetLayerId });
          }
        } else {
          // When it does not belong to a group, update only the layerId
          const feature = store.getFeature(itemId);
          if (feature) {
            store.updateFeature(itemId, { layerId: targetLayerId });
          }
        }

        // Add it to the order of the target layer
        const targetLayer = store.getLayer(targetLayerId);
        if (targetLayer) {
          const newOrder = [...targetLayer.order];
          if (targetIndex !== undefined) {
            newOrder.splice(targetIndex, 0, itemId);
          } else {
            newOrder.push(itemId);
          }
          store.updateLayer(targetLayerId, { order: newOrder });
        }

        // For a group, update the layerId of every feature inside the group as well
        const group = store.getGroup(itemId);
        if (group) {
          for (const featureId of group.featureIds) {
            const groupFeature = store.getFeature(featureId);
            if (groupFeature) {
              store.updateFeature(featureId, { layerId: targetLayerId });
            }
          }
        }
      }, source);
    },

    setLayerItemOrder: (layerId, order, source) => {
      const layer = store.getLayer(layerId);
      if (!layer) return;
      write(() => store.updateLayer(layerId, { order: [...order] }), source);
    },

    setSelection: (type, ids, source) => {
      write(() => store.setSelection(type, ids), source);
      getModeManager().notifySelectionChange();
    },

    // === Event API ===
    emit: (event, data) => eventEmitter.emit(event, data),
    on: (event, handler) => {
      eventEmitter.on(event, handler);
      return () => eventEmitter.off(event, handler);
    },
    off: (event, handler) => eventEmitter.off(event, handler),

    // === Batch mutations ===
    // Wrapping in store.transact merges the StateChanges notifications into a
    // single one, so a subscriber that groups changes (into steps, for example)
    // sees one unit, and
    // the mutation hooks of the batch share one batchId
    batch: <T>(fn: () => T): T => store.transact(fn),

    // === Mode control ===
    setMode: (mode: Mode): boolean => getModeManager().setMode(mode),

    // === Notification of external state change ===
    notifyStateReset: () => {
      getModeManager().notifyStateReset();
    },

    // === Vertex undo/redo ===
    undoVertex: () => {
      return getModeManager().undoVertex();
    },

    redoVertex: () => {
      return getModeManager().redoVertex();
    },

    // === Derived state ===
    invalidateFeatures: (type: string) => {
      spatialIndex.invalidateType(type);
    },

    // === Terrain anchors of this draw instance ===
    projectAnchor: (lng: number, lat: number) => projectAnchor(terrain, lng, lat),
    anchorElevationMeters: (lng: number, lat: number) => anchorElevationMeters(terrain, lng, lat),
    getAnchorElevationGeneration: () => getAnchorElevationGeneration(terrain),

    // === Selection extents of this draw instance ===
    computeBoundingBox: (feature: Feature) => computeBoundingBox(feature, selectionExtensions),
  };
}
