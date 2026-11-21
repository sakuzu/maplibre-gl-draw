// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.selection` and `draw.vertexSelection`: what this client has selected
 */

import { startSelectionDeletion } from '../../operations/bulk-deletion.js';
import type { BulkEditStarter } from '../../operations/bulk-work.js';
import { groupSelection, ungroupSelection } from '../../operations/layer-operations.js';
import { deleteSelectedVertices } from '../../operations/selection-operations.js';
import { coordinatesOf, supportsVertexEditing } from '../../shared/utils/coordinates.js';
import { isFeatureLocked } from '../../store/lock.js';
import { listEveryFeatureInOrder } from '../../store/ordering.js';
import type { Feature as StoredFeature, VertexRef } from '../../store/types.js';
import { DrawError } from '../errors.js';
import type { FeaturesCollection } from '../features.js';
import type { GroupsCollection } from '../groups.js';
import type { Feature, IdSet } from '../model.js';
import type { SelectionResource, VertexSelectionResource } from '../selection.js';
import type { SelectionType } from '../state.js';
import type { ResourceDeps } from './shared.js';
import {
  getItem,
  invalidInput,
  isRecord,
  isShown,
  notFound,
  requireId,
  requireIds,
} from './shared.js';

const SELECTION_TYPES: readonly SelectionType[] = ['feature', 'group', 'layer'];

/** The most features `features()` returns in one array */
const LIST_LIMIT = 10_000;

/** IDs given to the selection, read once each: an array of them, or a set (kept to be reused) */
interface IdsGiven {
  iterate(): IterableIterator<string>;
  /** The set given, when one was */
  readonly set?: IdSet;
}

/** Reads IDs given as an array of strings or as a set (throws `invalidInput` for anything else) */
function readIds(ids: unknown): IdsGiven {
  if (isRecord(ids) && !Array.isArray(ids) && typeof ids.iterate === 'function') {
    const set = ids as unknown as IdSet;
    return { iterate: () => set.iterate(), set };
  }
  const list = requireIds(ids);
  return { iterate: () => list[Symbol.iterator]() };
}

/** The layers named by `{ layerIds }`, or undefined for IDs given otherwise */
function layerIdsOf(ids: unknown): readonly string[] | undefined {
  if (!isRecord(ids) || Array.isArray(ids) || typeof ids.iterate === 'function') return undefined;
  const keys = Object.keys(ids);
  if (keys.length !== 1 || keys[0] !== 'layerIds') {
    throw invalidInput('The IDs must be an array of IDs, an IdSet or { layerIds }');
  }
  return requireIds(ids.layerIds, 'layerIds');
}

/** The number of IDs of a set or an array */
function countOf(ids: IdSet | readonly string[]): number {
  return Array.isArray(ids) ? ids.length : (ids as IdSet).count();
}

/** The IDs of a set or an array, one at a time */
function iterateOf(ids: IdSet | readonly string[]): Iterable<string> {
  return Array.isArray(ids) ? ids : (ids as IdSet).iterate();
}

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
  collections: {
    features: FeaturesCollection;
    groups: GroupsCollection;
    /** The bulk edits of the instance; `delete` throws `invalidState` without them */
    edits?: BulkEditStarter;
  },
): SelectionResource {
  const { store } = deps;
  // The selection and read-only are the state of this client, held by the instance
  const { client } = store;

  /** Throws unless every ID names an item of the type */
  const requireItems = (type: SelectionType, ids: IdsGiven): void => {
    for (const id of ids.iterate()) {
      const there = type === 'feature' ? store.hasFeature(id) : getItem(store, type, id);
      if (!there) throw notFound(type, id);
    }
  };

  /** The items of a type that can be seen, as a set (the features as their rows) */
  const shownOf = (type: SelectionType, ids: IdsGiven): IdSet | readonly string[] => {
    if (type === 'feature') {
      return store.shownFeatureSetOf(store.featureSetOf(ids.set ?? ids.iterate()));
    }
    return [...ids.iterate()].filter((id) => isShown(store, type, id));
  };

  return {
    get: () => client.getSelection(),

    set(type, ids) {
      if (!SELECTION_TYPES.includes(type)) {
        throw invalidInput('type must be feature, group or layer');
      }
      const layerIds = layerIdsOf(ids);
      if (layerIds) {
        // Every feature of the layers that can be seen, as a copy of their rows
        if (type !== 'feature') {
          throw invalidInput('{ layerIds } selects features: the type must be feature');
        }
        for (const layerId of layerIds) {
          if (!store.getLayer(layerId)) throw notFound('layer', layerId);
        }
        const selected = store.shownFeatureSetOfLayers(layerIds);
        if (selected.count() === 0) return false;
        client.setSelection('feature', selected);
        return true;
      }
      const given = readIds(ids);
      requireItems(type, given);
      const selectable = shownOf(type, given);
      if (countOf(selectable) === 0) return false;
      client.setSelection(type, selectable);
      return true;
    },

    add(ids) {
      const current = client.getSelection();
      const given = readIds(ids);
      const first = given.iterate().next();
      // With nothing selected, the type is the one of the first ID
      const type =
        current.type ??
        (first.done === true
          ? undefined
          : SELECTION_TYPES.find((t) => getItem(store, t, first.value)));
      if (type === undefined) {
        if (first.done === true) return false;
        throw notFound('feature, group or layer', first.value);
      }
      requireItems(type, given);
      const shown = shownOf(type, given);
      const added: string[] = [];
      for (const id of iterateOf(shown)) if (!current.ids.has(id)) added.push(id);
      if (added.length === 0) return false;
      const all = (function* () {
        yield* current.ids.iterate();
        yield* added;
      })();
      client.setSelection(type, type === 'feature' ? store.featureSetOf(all) : [...all]);
      return true;
    },

    remove(ids) {
      const current = client.getSelection();
      const given = readIds(ids);
      const removed = new Set<string>();
      for (const id of given.iterate()) if (current.ids.has(id)) removed.add(id);
      if (removed.size === 0) return false;
      const kept = (function* () {
        for (const id of current.ids.iterate()) if (!removed.has(id)) yield id;
      })();
      const left = current.type === 'feature' ? store.featureSetOf(kept) : [...kept];
      client.setSelection(countOf(left) > 0 ? current.type : null, left);
      return true;
    },

    clear() {
      client.setSelection(null, []);
    },

    features() {
      const { type, ids } = client.getSelection();
      if (type === null) return [];
      // The features are counted before they are made: a list is never cut short
      let count = 0;
      if (type === 'feature') count = ids.count();
      else {
        for (const id of ids.iterate()) {
          count += store.countFeatures(type === 'group' ? { groupId: id } : { layerId: id });
        }
      }
      if (count > LIST_LIMIT) {
        throw new DrawError(
          'tooManyItems',
          `${count} features are selected, more than the ${LIST_LIMIT} a list returns; read them with features.iterate or get().ids.iterate`,
          { count },
        );
      }
      if (type === 'feature') {
        const out: StoredFeature[] = [];
        for (const id of ids.iterate()) {
          const feature = store.getFeature(id);
          if (feature !== undefined) out.push(feature);
        }
        return out as Feature[];
      }
      const wanted = new Set(ids.iterate());
      const inside = (feature: StoredFeature): boolean =>
        type === 'group'
          ? feature.groupId !== undefined && wanted.has(feature.groupId)
          : wanted.has(feature.layerId);
      return listEveryFeatureInOrder(store).filter(inside) as Feature[];
    },

    delete() {
      const { edits } = collections;
      if (!edits) {
        throw new DrawError('invalidState', 'The bulk edits are not available on this selection');
      }
      return startSelectionDeletion(edits);
    },

    group() {
      if (client.isReadOnly()) return null;
      const id = groupSelection(store, deps.generateId, deps.autoNameGenerator);
      return id === null ? null : (store.getGroup(id) ?? null);
    },

    ungroup() {
      // The same operation as the ungroup shortcut
      if (client.isReadOnly()) return false;
      return ungroupSelection(store);
    },

    move(to) {
      const { type, ids } = client.getSelection();
      if (ids.count() === 0) return false;
      if (type === 'feature') return collections.features.moveMany([...ids.iterate()], to);
      if (type === 'group') return collections.groups.moveMany([...ids.iterate()], to);
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
  // The vertex selection, read-only and the lock are the state of this client, of the instance
  const { client } = store;
  return {
    get: () => client.getVertexSelection(),

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
      if (isFeatureLocked(feature, store)) return false;
      client.setSelectedVertices(refs.length > 0 ? { featureId: id, vertices: refs } : null);
      return true;
    },

    clear() {
      client.setSelectedVertices(null);
    },

    delete() {
      const selection = client.getVertexSelection();
      if (!selection || selection.vertices.length === 0) return false;
      if (client.isReadOnly() || client.isInteractionLocked()) return false;
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
