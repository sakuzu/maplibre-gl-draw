// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.layers`: the layers of the document
 */

import { startLayerDeletion } from '../../operations/bulk-deletion.js';
import type { BulkEditStarter } from '../../operations/bulk-work.js';
import type { DocumentAccess } from '../../store/document-access.js';
import type { Layer as StoredLayer, StyleRule } from '../../store/types.js';
import { DrawError } from '../errors.js';
import type { EditOptions } from '../features.js';
import type { LayersCollection } from '../layers.js';
import type { Layer, LayerFilter, LayerInput, LayerPatch } from '../model.js';
import type { ResourceDeps } from './shared.js';
import {
  filterEntries,
  invalidInput,
  isRecord,
  isTaken,
  layerLocked,
  matches,
  notFound,
  onlyKeys,
  onlyLockOrVisibility,
  optionalBoolean,
  optionalIndex,
  optionalString,
  requireId,
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

/** The most IDs a range returns at once */
const RANGE_LIMIT = 10_000;

/**
 * Checks a range of positions and returns it
 *
 * @throws DrawError `invalidInput` for a range that is not two integers from 0 with start <= end,
 *   `tooManyItems` for a range of more than 10,000 positions
 * @internal
 */
export function requireRange(range: unknown): { start: number; end: number } {
  if (!isRecord(range)) throw invalidInput('The range must be an object');
  const { start, end } = range;
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start
  ) {
    throw invalidInput('The range must be two integers from 0 with start <= end');
  }
  if (end - start > RANGE_LIMIT) {
    throw new DrawError(
      'tooManyItems',
      `The range spans ${end - start} positions, more than the ${RANGE_LIMIT} it returns at once`,
      { count: end - start },
    );
  }
  return { start, end };
}

/**
 * Creates `draw.layers`
 *
 * @param isStackEntry - Whether an ID that is not a layer may stand in the stacking order: a
 *   dataset whose order is `layerOrder`, or an entry the `isExternalEntry` option recognizes
 * @internal
 */
export function createLayers(
  deps: ResourceDeps,
  isStackEntry: (id: string) => boolean = () => false,
  edits?: BulkEditStarter,
): LayersCollection {
  const { store } = deps;

  /** Starts the deletion of layers, a bulk edit (a wrong input rejects the promise) */
  const startDeletion = (ids: readonly string[], options: EditOptions | undefined) => {
    if (!edits) {
      throw new DrawError('invalidState', 'The bulk edits are not available on these layers');
    }
    try {
      return startLayerDeletion(edits, ids, options);
    } catch (error) {
      if (error instanceof DrawError && error.code === 'invalidInput') return Promise.reject(error);
      throw error;
    }
  };

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
  const createAll = (prepared: PreparedLayer[]): StoredLayer[] | null => {
    const written = store.transactUntilRefused(() => {
      for (const entry of prepared) insertLayer(store, entry);
      return true;
    });
    if (written === null) return null;
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
    countItems(id) {
      return store.countItems(require(id).id);
    },
    listItemIds(id, range) {
      const layer = require(id);
      const { start, end } = requireRange(range);
      return store.listItemIds(layer.id, start, end);
    },

    create(input) {
      const prepared = prepareLayer(deps, input, new Set());
      if (store.isReadOnly()) return null;
      return createAll([prepared])?.[0] ?? null;
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
      if (!store.updateLayer(layer.id, updates)) return null;
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
      const written = store.transactUntilRefused(() => {
        for (const { layer, updates } of prepared) store.updateLayer(layer.id, updates);
        return true;
      });
      if (written === null) return null;
      return prepared.map(({ layer }) => store.getLayer(layer.id) as StoredLayer);
    },

    delete: (id, options) => startDeletion([id], options),

    deleteMany: (ids, options) => startDeletion(ids, options),

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

    getOrder() {
      return Object.freeze(
        store.getLayerOrder().filter((id) => store.getLayer(id) !== undefined || isStackEntry(id)),
      );
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

/**
 * A layer checked and built from an input, with its position in the stacking order
 *
 * @internal
 */
export interface PreparedLayer {
  /** The layer to store */
  layer: StoredLayer;
  /** The position in the stacking order, 0 at the back; the front when undefined */
  index: number | undefined;
}

/**
 * Creates a prepared layer and puts it at its index of the stacking order, in the transaction
 * of the caller
 *
 * @internal
 */
export function insertLayer(store: DocumentAccess, { layer, index }: PreparedLayer): void {
  store.createLayer(layer);
  if (index !== undefined) {
    const order = store.getLayerOrder().filter((id) => id !== layer.id);
    order.splice(Math.min(index, order.length), 0, layer.id);
    store.setLayerOrder(order);
  }
}

/**
 * Checks an input and builds the layer to store; throws DrawError on a wrong input
 *
 * @param pending - The IDs taken by the other entries of the same write
 * @internal
 */
export function prepareLayer(
  deps: Pick<ResourceDeps, 'store' | 'generateId' | 'autoNameGenerator'>,
  input: LayerInput,
  pending: ReadonlySet<string>,
): PreparedLayer {
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
      throw new DrawError('alreadyExists', `The ID ${JSON.stringify(id)} is already taken`, {
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
