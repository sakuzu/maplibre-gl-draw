// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.selection` and `draw.vertexSelection`: what this client has selected
 */

import { groupSelection, ungroupSelection } from '../../operations/layer-operations.js';
import {
  deleteSelectedItems,
  deleteSelectedVertices,
} from '../../operations/selection-operations.js';
import { coordinatesOf, supportsVertexEditing } from '../../shared/utils/coordinates.js';
import { listEveryFeatureInOrder } from '../../store/ordering.js';
import type { Feature as StoredFeature, VertexRef } from '../../store/types.js';
import type { FeaturesCollection } from '../features.js';
import type { GroupsCollection } from '../groups.js';
import type { Feature } from '../model.js';
import type { SelectionResource, VertexSelectionResource } from '../selection.js';
import type { SelectionType } from '../state.js';
import type { ResourceDeps } from './shared.js';
import {
  featureLocked,
  getItem,
  invalidInput,
  isRecord,
  isShown,
  notFound,
  requireId,
  requireIds,
} from './shared.js';

const SELECTION_TYPES: readonly SelectionType[] = ['feature', 'group', 'layer'];

/**
 * Creates `draw.selection`
 *
 * The selection holds only what can be seen: an item that is hidden (by its visible flag, the
 * one of its group or layer, or by this client) cannot be selected.
 *
 * @internal
 */
export function createSelection(
  deps: ResourceDeps,
  collections: { features: FeaturesCollection; groups: GroupsCollection },
): SelectionResource {
  const { store } = deps;

  /** Throws unless every ID names an item of the type */
  const requireItems = (type: SelectionType, ids: unknown): string[] => {
    const list = requireIds(ids);
    for (const id of list) {
      if (!getItem(store, type, id)) throw notFound(type, id);
    }
    return list;
  };

  return {
    get: () => store.getSelection(),

    set(type, ids) {
      if (!SELECTION_TYPES.includes(type)) {
        throw invalidInput('type must be feature, group or layer');
      }
      const selectable = requireItems(type, ids).filter((id) => isShown(store, type, id));
      if (selectable.length === 0) return false;
      store.setSelection(type, selectable);
      return true;
    },

    add(ids) {
      const current = store.getSelection();
      const list = requireIds(ids);
      // With nothing selected, the type is the one of the first ID
      const type = current.type ?? SELECTION_TYPES.find((t) => getItem(store, t, list[0] ?? ''));
      if (type === undefined) {
        if (list.length === 0) return false;
        throw notFound('feature, group or layer', list[0]);
      }
      const added = requireItems(type, list).filter(
        (id) => !current.ids.includes(id) && isShown(store, type, id),
      );
      if (added.length === 0) return false;
      store.setSelection(type, [...current.ids, ...added]);
      return true;
    },

    remove(ids) {
      const current = store.getSelection();
      const removed = new Set(requireIds(ids).filter((id) => current.ids.includes(id)));
      if (removed.size === 0) return false;
      const kept = current.ids.filter((id) => !removed.has(id));
      store.setSelection(kept.length > 0 ? current.type : null, kept);
      return true;
    },

    clear() {
      store.setSelection(null, []);
    },

    features() {
      const { type, ids } = store.getSelection();
      if (type === 'feature') {
        return ids
          .map((id) => store.getFeature(id))
          .filter((feature): feature is StoredFeature => feature !== undefined);
      }
      if (type === null) return [];
      const wanted = new Set(ids);
      const inside = (feature: StoredFeature): boolean =>
        type === 'group'
          ? feature.groupId !== undefined && wanted.has(feature.groupId)
          : wanted.has(feature.layerId);
      return listEveryFeatureInOrder(store).filter(inside) as Feature[];
    },

    delete() {
      return deleteSelectedItems(store);
    },

    group() {
      if (store.isReadOnly()) return null;
      const id = groupSelection(store, deps.generateId, deps.autoNameGenerator);
      return id === null ? null : (store.getGroup(id) ?? null);
    },

    ungroup() {
      // The same operation as the ungroup shortcut
      if (store.isReadOnly()) return false;
      return ungroupSelection(store);
    },

    move(to) {
      const { type, ids } = store.getSelection();
      if (type === 'feature' && ids.length > 0) return collections.features.moveMany(ids, to);
      if (type === 'group' && ids.length > 0) return collections.groups.moveMany(ids, to);
      return false;
    },
  };
}

/**
 * Creates `draw.vertexSelection`
 *
 * @internal
 */
export function createVertexSelection(deps: Pick<ResourceDeps, 'store'>): VertexSelectionResource {
  const { store } = deps;
  return {
    get: () => store.getVertexSelection(),

    set(featureId, vertices) {
      const id = requireId(featureId, 'featureId');
      const feature = store.getFeature(id);
      if (!feature) throw notFound('feature', id);
      if (!Array.isArray(vertices)) throw invalidInput('The vertices must be an array');
      const refs = vertices.map((vertex) => {
        if (!isVertexRef(vertex)) throw invalidInput('A vertex must be { part?, ring, index }');
        if (!vertexExists(feature, vertex)) {
          throw notFound('vertex', vertex);
        }
        return { ...vertex };
      });
      if (featureLocked(store, feature)) return false;
      store.setSelectedVertices(refs.length > 0 ? { featureId: id, vertices: refs } : null);
      return true;
    },

    clear() {
      store.setSelectedVertices(null);
    },

    delete() {
      const selection = store.getVertexSelection();
      if (!selection || selection.vertices.length === 0) return false;
      if (store.isReadOnly() || store.isInteractionLocked()) return false;
      return deleteSelectedVertices(store, selection) > 0;
    },
  };
}

/** Whether the value has the shape of a vertex reference */
function isVertexRef(value: unknown): value is VertexRef {
  if (!isRecord(value)) return false;
  const isIndex = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  return (
    (value.part === undefined || isIndex(value.part)) && isIndex(value.ring) && isIndex(value.index)
  );
}

/** Whether the vertex exists on the feature (the closing position of a ring is not a vertex) */
function vertexExists(feature: StoredFeature, ref: VertexRef): boolean {
  if (!supportsVertexEditing(feature.type)) return false;
  const part = ref.part ?? 0;
  const coordinates = coordinatesOf(feature) as unknown[];
  const ringVertices = (ring: unknown): number =>
    Array.isArray(ring) ? Math.max(0, ring.length - 1) : 0;
  switch (feature.geometry.type) {
    case 'LineString':
      return part === 0 && ref.ring === 0 && ref.index < coordinates.length;
    case 'Polygon':
      return part === 0 && ref.index < ringVertices(coordinates[ref.ring]);
    case 'MultiPoint':
      return ref.ring === 0 && ref.index === 0 && part < coordinates.length;
    case 'MultiLineString': {
      const line = coordinates[part];
      return ref.ring === 0 && Array.isArray(line) && ref.index < line.length;
    }
    case 'MultiPolygon': {
      const polygon = coordinates[part];
      return Array.isArray(polygon) && ref.index < ringVertices(polygon[ref.ring]);
    }
    default:
      return false;
  }
}
