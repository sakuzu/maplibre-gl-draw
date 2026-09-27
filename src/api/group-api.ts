// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Group API
 *
 * Provides the Group CRUD and grouping operations of MapLibreGLDraw.
 */

import {
  addFeatureToGroup as addFeatureToGroupImpl,
  groupSelection as groupSelectionImpl,
  removeFeatureFromGroup as removeFeatureFromGroupImpl,
  ungroupGroup as ungroupGroupImpl,
  ungroupSelection as ungroupSelectionImpl,
} from '../operations/layer-operations.js';
import type { AutoNameGenerator } from '../shared/utils/name-generator.js';
import { isGroupLocked } from '../store/lock.js';
import type { Store } from '../store/store.js';
import type { Group } from '../store/types.js';
import type { MapLibreGLDraw } from './api.js';
import { onlyLockOrVisibility } from './feature-api.js';

export type GroupApi = Pick<
  MapLibreGLDraw,
  | 'getAllGroups'
  | 'getGroup'
  | 'addGroup'
  | 'updateGroup'
  | 'deleteGroup'
  | 'reorderInGroup'
  | 'addFeatureToGroup'
  | 'removeFeatureFromGroup'
  | 'groupSelection'
  | 'ungroupSelection'
  | 'ungroupGroup'
>;

export interface GroupApiDeps {
  store: Store;
  generateFeatureId: () => string;
  autoNameGenerator: AutoNameGenerator;
}

export function createGroupApi(deps: GroupApiDeps): GroupApi {
  const { store, generateFeatureId, autoNameGenerator } = deps;

  return {
    getAllGroups(): Group[] {
      return store.listGroups();
    },

    getGroup(id: string): Group | undefined {
      return store.getGroup(id);
    },

    addGroup(featureIds: string[], layerId: string, name?: string): string | null {
      // While read-only every write below would be refused: report it as null up front
      if (store.isReadOnly()) return null;
      const id = generateFeatureId();
      const groupName = name || autoNameGenerator.generateGroupName();
      const group: Group = {
        id,
        layerId,
        name: groupName,
        featureIds: [...featureIds],
        locked: false,
        visible: true,
      };

      // Remove the features from the order of the layer
      const layer = store.getLayer(layerId);
      if (layer) {
        const newOrder = layer.items.filter((itemId) => !featureIds.includes(itemId));
        // Add the group to the order
        newOrder.push(id);
        store.updateLayer(layerId, { items: newOrder });
      }

      // Create the group (this sets groupId on the features)
      return store.createGroup(group) ? id : null;
    },

    updateGroup(id: string, updates: Partial<Group>): boolean {
      const group = store.getGroup(id);
      if (group && !onlyLockOrVisibility(updates)) {
        // While locked (itself or its layer), reject any change other than locked/visible
        // (full protection)
        const findLayerOfGroup = (gid: string) =>
          store.listLayers().find((l) => l.items.includes(gid));
        if (isGroupLocked(group, findLayerOfGroup)) return false;
      }
      return store.updateGroup(id, updates);
    },

    deleteGroup(id: string): boolean {
      // The Store puts the features of the group in its place in the order of its layer
      return store.deleteGroup(id);
    },

    reorderInGroup(featureId: string, groupId: string, newIndex: number): boolean {
      return store.reorderInGroup(featureId, groupId, newIndex);
    },

    addFeatureToGroup(featureId: string, groupId: string, index?: number): void {
      addFeatureToGroupImpl(store, featureId, groupId, index);
    },

    removeFeatureFromGroup(featureId: string): void {
      removeFeatureFromGroupImpl(store, featureId);
    },

    groupSelection(): string | null {
      return groupSelectionImpl(store, generateFeatureId, autoNameGenerator);
    },

    ungroupSelection(): void {
      ungroupSelectionImpl(store);
    },

    ungroupGroup(groupId: string): void {
      ungroupGroupImpl(store, groupId);
    },
  };
}
