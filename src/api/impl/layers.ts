// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.layers`: the layers of the document
 */

import type { Store } from '../../store/store.js';
import type { Layer as StoredLayer, StyleRule } from '../../store/types.js';
import { DrawError } from '../errors.js';
import type { LayersCollection } from '../layers.js';
import type { Layer, LayerFilter, LayerInput, LayerPatch } from '../model.js';
import type { ResourceDeps } from './shared.js';
import {
  featureLocked,
  filterEntries,
  invalidInput,
  isRecord,
  isTaken,
  layerLocked,
  locksIgnored,
  matches,
  notFound,
  onlyKeys,
  onlyLockOrVisibility,
  optionalBoolean,
  optionalIndex,
  optionalString,
  requireId,
  requireIds,
  requireRecord,
} from './shared.js';

const INPUT_KEYS = [
  'id',
  'name',
  'visible',
  'locked',
  'opacity',
  'styleRule',
  'metadata',
  'index',
] as const;
const PATCH_KEYS = ['name', 'visible', 'locked', 'opacity', 'styleRule', 'metadata'] as const;
const FILTER_KEYS = ['visible', 'locked'] as const;

/**
 * Creates `draw.layers`
 *
 * @param isStackEntry - Whether an ID that is not a layer may stand in the stacking order: a
 *   dataset whose order is `layer-order`, or an entry the `isExternalEntry` option recognizes
 * @internal
 */
export function createLayers(
  deps: ResourceDeps,
  isStackEntry: (id: string) => boolean = () => false,
): LayersCollection {
  const { store } = deps;

  const require = (id: unknown): StoredLayer => {
    const layer = typeof id === 'string' ? store.getLayer(id) : undefined;
    if (!layer) throw notFound('layer', id);
    return layer;
  };

  /** Every layer in stacking order, from the back; a layer off the order comes last */
  const inOrder = (): StoredLayer[] => {
    const result: StoredLayer[] = [];
    for (const id of store.getLayerOrder()) {
      const layer = store.getLayer(id);
      if (layer) result.push(layer);
    }
    if (result.length < store.listLayers().length) {
      const listed = new Set(result.map((layer) => layer.id));
      result.push(...store.listLayers().filter((layer) => !listed.has(layer.id)));
    }
    return result;
  };

  const list = (filter?: LayerFilter): Layer[] => {
    const entries = filterEntries(filter, FILTER_KEYS);
    return inOrder().filter((layer) => matches(layer, entries));
  };

  /** Creates prepared layers and puts each at its index of the stacking order */
  const createAll = (prepared: Array<{ layer: StoredLayer; index: number | undefined }>) => {
    store.transact(() => {
      for (const { layer, index } of prepared) {
        store.createLayer(layer);
        if (index !== undefined) {
          const order = store.getLayerOrder().filter((id) => id !== layer.id);
          order.splice(Math.min(index, order.length), 0, layer.id);
          store.setLayerOrder(order);
        }
      }
    });
    return prepared.map(({ layer }) => store.getLayer(layer.id) as StoredLayer);
  };

  return {
    get: (id) => store.getLayer(id),
    getMany(ids) {
      if (!Array.isArray(ids)) throw invalidInput('The IDs must be an array');
      return ids.map((id) => store.getLayer(id));
    },
    list,
    count: (filter) => list(filter).length,
    has: (id) => store.getLayer(id) !== undefined,

    create(input) {
      const prepared = prepareLayer(deps, input, new Set());
      if (store.isReadOnly()) return null;
      return createAll([prepared])[0] ?? null;
    },

    createMany(inputs) {
      if (!Array.isArray(inputs)) throw invalidInput('The inputs must be an array');
      const pending = new Set<string>();
      const prepared = inputs.map((input) => {
        const entry = prepareLayer(deps, input, pending);
        pending.add(entry.layer.id);
        return entry;
      });
      if (store.isReadOnly()) return null;
      return createAll(prepared);
    },

    update(id, patch) {
      const layer = require(id);
      const updates = prepareLayerPatch(patch);
      if (store.isReadOnly()) return null;
      if (layerLocked(store, layer) && !onlyLockOrVisibility(patch)) return null;
      store.updateLayer(layer.id, updates);
      return store.getLayer(layer.id) ?? null;
    },

    updateMany(patches) {
      if (!Array.isArray(patches)) throw invalidInput('The patches must be an array');
      const seen = new Set<string>();
      const prepared = patches.map((entry) => {
        requireRecord(entry, 'Each entry');
        const layer = require((entry as { id: unknown }).id);
        if (seen.has(layer.id)) throw invalidInput(`The ID ${layer.id} is given twice`);
        seen.add(layer.id);
        return { layer, patch: entry.patch, updates: prepareLayerPatch(entry.patch) };
      });
      if (store.isReadOnly()) return null;
      if (
        prepared.some(
          ({ layer, patch }) => layerLocked(store, layer) && !onlyLockOrVisibility(patch),
        )
      ) {
        return null;
      }
      store.transact(() => {
        for (const { layer, updates } of prepared) store.updateLayer(layer.id, updates);
      });
      return prepared.map(({ layer }) => store.getLayer(layer.id) as StoredLayer);
    },

    delete(id) {
      const layer = require(id);
      if (store.isReadOnly() || holdsLock(store, layer)) return false;
      return store.deleteLayer(layer.id);
    },

    deleteMany(ids) {
      const layers = requireIds(ids).map(require);
      if (store.isReadOnly() || layers.some((layer) => holdsLock(store, layer))) return false;
      store.transact(() => {
        for (const layer of layers) store.deleteLayer(layer.id);
      });
      return true;
    },

    reorder(order) {
      if (!Array.isArray(order) || order.some((id) => typeof id !== 'string')) {
        throw invalidInput('The order must be an array of strings');
      }
      for (const id of order) {
        if (!store.getLayer(id) && !isStackEntry(id)) throw notFound('layer', id);
      }
      const listed = new Set(order);
      const layerCount = order.filter((id) => store.getLayer(id)).length;
      if (listed.size !== order.length || layerCount !== store.listLayers().length) {
        throw invalidInput('The order must list every layer once, and no entry twice');
      }
      if (store.isReadOnly()) return false;
      // An entry left out of the order keeps its position; the entries given fill the rest
      const next = [...order];
      const current = store.getLayerOrder();
      const merged = current.map((id) =>
        listed.has(id) || store.getLayer(id) ? (next.shift() as string) : id,
      );
      merged.push(...next);
      return store.setLayerOrder(merged);
    },

    getActive() {
      const id = deps.getActiveLayerId();
      return store.getLayer(id) ?? null;
    },

    setActive(id) {
      const layer = require(id);
      if (layer.locked) return false;
      deps.setActiveLayerId(layer.id);
      return true;
    },
  };
}

/** Whether a deletion of the layer is refused: it, or a feature or group in it, is locked */
function holdsLock(store: Store, layer: StoredLayer): boolean {
  if (locksIgnored(store)) return false;
  if (layer.locked) return true;
  for (const itemId of layer.items) {
    if (store.getGroup(itemId)?.locked) return true;
  }
  return store
    .listFeatures()
    .some((feature) => feature.layerId === layer.id && featureLocked(store, feature));
}

/** Checks an input and builds the layer to store; throws DrawError on a wrong input */
function prepareLayer(
  deps: ResourceDeps,
  input: LayerInput,
  pending: ReadonlySet<string>,
): { layer: StoredLayer; index: number | undefined } {
  const { store } = deps;
  requireRecord(input, 'The input');
  const record = input as unknown as Record<string, unknown>;
  onlyKeys(record, INPUT_KEYS, 'The input');
  checkLayerFields(record);
  const index = optionalIndex(input.index);

  let id: string;
  if (input.id === undefined) {
    id = deps.generateId();
  } else {
    id = requireId(input.id);
    if (isTaken(store, id) || pending.has(id) || store.getLayerOrder().includes(id)) {
      throw new DrawError('already-exists', `The ID ${JSON.stringify(id)} is already taken`, {
        id,
      });
    }
  }

  return {
    layer: {
      id,
      name: input.name ?? deps.autoNameGenerator.generateLayerName(),
      visible: input.visible ?? true,
      locked: input.locked ?? false,
      opacity: input.opacity ?? 1,
      items: [],
      styleRule: input.styleRule as StyleRule | undefined,
      metadata: input.metadata,
    },
    index,
  };
}

/** Checks a patch and builds the updates of the Store; throws DrawError on a wrong patch */
function prepareLayerPatch(patch: LayerPatch): Partial<StoredLayer> {
  requireRecord(patch, 'The patch');
  const record = patch as unknown as Record<string, unknown>;
  onlyKeys(record, PATCH_KEYS, 'The patch');
  checkLayerFields(record);
  const updates: Partial<StoredLayer> = {};
  for (const key of PATCH_KEYS) {
    if (!(key in record)) continue;
    // A styleRule or a metadata given as undefined removes it; the other keys keep their value
    if (record[key] === undefined && key !== 'styleRule' && key !== 'metadata') continue;
    (updates as Record<string, unknown>)[key] = record[key];
  }
  return updates;
}

/** Checks the fields of a layer input or patch */
function checkLayerFields(record: Record<string, unknown>): void {
  optionalString(record, 'name');
  optionalBoolean(record, 'visible');
  optionalBoolean(record, 'locked');
  const { opacity, styleRule, metadata } = record;
  if (opacity !== undefined && (typeof opacity !== 'number' || !(opacity >= 0 && opacity <= 1))) {
    throw invalidInput('opacity must be a number from 0 to 1');
  }
  if (styleRule !== undefined && !isStyleRule(styleRule)) {
    throw invalidInput('styleRule is not a valid style rule');
  }
  if (metadata !== undefined && !isRecord(metadata)) {
    throw invalidInput('metadata must be an object');
  }
}

/** Whether the value has the shape of a style rule */
function isStyleRule(value: unknown): value is StyleRule {
  if (!isRecord(value)) return false;
  const isString = (v: unknown) => typeof v === 'string';
  const isNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  switch (value.kind) {
    case 'single':
      return isString(value.color);
    case 'categorical':
      return (
        isString(value.property) &&
        isRecord(value.map) &&
        Object.values(value.map).every(isString) &&
        isString(value.other)
      );
    case 'graduated':
      return (
        isString(value.property) &&
        Array.isArray(value.breaks) &&
        value.breaks.every(isNumber) &&
        Array.isArray(value.colors) &&
        value.colors.every(isString) &&
        value.colors.length === value.breaks.length + 1 &&
        isString(value.other)
      );
    case 'continuous':
      return (
        isString(value.property) &&
        isNumber(value.min) &&
        isNumber(value.max) &&
        Array.isArray(value.ramp) &&
        value.ramp.length === 2 &&
        value.ramp.every(isString) &&
        isString(value.other)
      );
    default:
      return false;
  }
}
