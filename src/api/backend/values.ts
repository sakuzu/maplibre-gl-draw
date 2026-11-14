// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The values a storage receives: one commit sent as JSON (`ValueBatch`), the values of the
 * records of a document, the operations that change them, and the one way they apply
 * (`applyOperations`), which runs as it is on a server
 *
 * Every target is an ID. A feature is its geometry and its properties, the values of the
 * library under the keys of `maplibre-gl-draw:` among them, as the main entry reads a feature;
 * `key` is the key of its order under its parent, compared byte by byte.
 */

import type { Geometry } from 'geojson';
import { setOwnProperty } from '../../shared/utils/own-property.js';
import type { FeatureStyle, JsonObject, JsonValue, StyleRule } from '../model.js';

/** The key of the style of a feature among its properties */
const STYLE_KEY = 'maplibre-gl-draw:style';
/** The key of the layer of a feature among its properties */
const LAYER_KEY = 'maplibre-gl-draw:layerId';
/** The key of the group of a feature among its properties */
const GROUP_KEY = 'maplibre-gl-draw:groupId';

/**
 * One send of one commit. With the operations it carries, it is enough to play the commit again
 * on another device. It is JSON.
 */
export interface BatchHeader {
  /** The version of the shape: it goes up only when a value is added to a closed union */
  readonly schema: 1;
  /** The same when the batch is sent again, so it is the key that leaves out a duplicate */
  readonly id: string;
  /** The commit it belongs to (`Write.id`) */
  readonly commit: string;
  /**
   * A large commit comes in parts, one after the other: all of them together are the commit.
   * `index` counts from 0, and `count` is the number of parts of the commit
   */
  readonly part: { readonly index: number; readonly count: number };
  /** The `label` of the write that made the commit */
  readonly label?: string;
  /** When the commit was made, in milliseconds since the epoch */
  readonly writtenAtMilliseconds: number;
}

/** A batch of operations on values */
export interface ValueBatch extends BatchHeader {
  /** The operations, applied in this order */
  readonly operations: readonly ValueOperation[];
}

/** What a storage receives to send */
export type Batch = ValueBatch;

/**
 * The values of a feature: the same `geometry` and `properties` as the feature the main entry
 * reads, and the key of its order among the items of its parent (its group, or its layer)
 */
export interface FeatureRecord {
  readonly geometry: Geometry;
  /**
   * The keys of `maplibre-gl-draw:` included, as they are: the layer and the group of the feature
   * are there too. A value JSON has no kind for is held in its JSON form (`{ "$integer": "12" }`)
   */
  readonly properties: JsonObject;
  /** The key of its order under its parent */
  readonly key: string;
}

/** The values of a layer */
export interface LayerRecord {
  readonly name: string;
  readonly visible: boolean;
  readonly locked: boolean;
  /** The look of the features of the layer */
  readonly style: FeatureStyle;
  /** The rule that colors its features from their attributes */
  readonly styleRule: StyleRule | null;
  /** The key of its order among the layers */
  readonly key: string;
}

/** The values of a group of features */
export interface GroupRecord {
  readonly name: string;
  /** The layer it is in */
  readonly layerId: string;
  /** The group it is in, or `null` for a group of its layer */
  readonly parentId: string | null;
  readonly visible: boolean;
  readonly locked: boolean;
  /** The key of its order under its parent */
  readonly key: string;
}

/** A file of the document, such as an image */
export interface FileRecord {
  /** Its media type, such as `image/webp` */
  readonly mediaType: string;
  /** Its bytes, in base64 */
  readonly content: string;
}

/** The keys a `set` removes, after it merged its values */
export interface UnsetKeys {
  /** Keys of `properties` */
  readonly properties?: readonly string[];
  /** Keys of the style (`maplibre-gl-draw:style` of a feature) */
  readonly style?: readonly string[];
}

/**
 * An operation on values: a closed union, whose shape is set by the kind of record it writes
 * (`kind`). Every target is an ID.
 *
 * How a `set` applies is what `applyOperations` does:
 *
 * - what a `set` does not name does not change
 * - `set.properties` is merged key by key, and so is the style under `maplibre-gl-draw:style`
 * - `geometry` is replaced as a whole
 * - then the keys of `unset` are removed; `unset.style` names keys of the style
 *   (`maplibre-gl-draw:style` of a feature)
 * - `place` also writes `maplibre-gl-draw:layerId` and `groupId` of a feature from its parent
 *
 * For example `{ type: 'set', kind: 'feature', ids: ['a'], set: { properties: { h: 3 } },
 * unset: { properties: ['old'] } }`.
 */
export type ValueOperation =
  | {
      readonly type: 'create';
      readonly kind: 'feature';
      readonly id: string;
      readonly record: FeatureRecord;
    }
  | {
      readonly type: 'create';
      readonly kind: 'layer';
      readonly id: string;
      readonly record: LayerRecord;
    }
  | {
      readonly type: 'create';
      readonly kind: 'group';
      readonly id: string;
      readonly record: GroupRecord;
    }
  | {
      readonly type: 'create';
      readonly kind: 'file';
      readonly id: string;
      readonly record: FileRecord;
    }
  | {
      readonly type: 'set';
      readonly kind: 'feature';
      readonly ids: readonly string[];
      readonly set: Partial<Omit<FeatureRecord, 'key'>>;
      readonly unset?: UnsetKeys;
    }
  | {
      readonly type: 'set';
      readonly kind: 'layer';
      readonly ids: readonly string[];
      readonly set: Partial<Omit<LayerRecord, 'key'>>;
      readonly unset?: Pick<UnsetKeys, 'style'>;
    }
  | {
      readonly type: 'set';
      readonly kind: 'group';
      readonly ids: readonly string[];
      readonly set: Partial<Pick<GroupRecord, 'name' | 'visible' | 'locked'>>;
    }
  | {
      readonly type: 'set';
      readonly kind: 'document';
      readonly set: { readonly title?: string; readonly description?: string };
    }
  | {
      readonly type: 'delete';
      readonly kind: 'feature' | 'layer' | 'group' | 'file';
      readonly ids: readonly string[];
    }
  | {
      readonly type: 'place';
      readonly kind: 'feature' | 'layer' | 'group';
      readonly ids: readonly string[];
      /** The ID of the parent (a layer or a group); `null` for a layer */
      readonly parentId: string | null;
      /** The keys of the order, as many as `ids` */
      readonly keys: readonly string[];
    };

/** The records `applyOperations` writes, by ID */
export interface StoredDocument {
  readonly features: Map<string, FeatureRecord>;
  readonly layers: Map<string, LayerRecord>;
  readonly groups: Map<string, GroupRecord>;
  readonly files: Map<string, FileRecord>;
  title: string;
  description: string;
}

/** An empty document to apply operations to */
export function createStoredDocument(): StoredDocument {
  return {
    features: new Map(),
    layers: new Map(),
    groups: new Map(),
    files: new Map(),
    title: '',
    description: '',
  };
}

/**
 * Applies operations on values, in their order: what a storage applies, on a server as well.
 *
 * - `create` makes a record when there is none of its ID (one there is left as it is, and its ID
 *   is returned as skipped)
 * - `set` and `place` skip an ID there is no record of, and `place` an ID whose parent there is
 *   none of
 * - `delete` does not mind an ID there is no record of. It removes the records named only: the
 *   commit that deletes a layer or a group names what it held as well
 *
 * @returns The IDs it skipped, once each, in the order they were met
 */
export function applyOperations(
  document: StoredDocument,
  operations: readonly ValueOperation[],
): { readonly skipped: readonly string[] } {
  const skipped: string[] = [];
  const seen = new Set<string>();
  const skip = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    skipped.push(id);
  };
  for (const operation of operations) {
    switch (operation.type) {
      case 'create':
        create(document, operation, skip);
        break;
      case 'set':
        set(document, operation, skip);
        break;
      case 'delete':
        for (const id of operation.ids) mapOf(document, operation.kind).delete(id);
        break;
      case 'place':
        place(document, operation, skip);
        break;
    }
  }
  return { skipped };
}

/** The records of a kind */
function mapOf(
  document: StoredDocument,
  kind: 'feature' | 'layer' | 'group' | 'file',
): Map<string, unknown> {
  switch (kind) {
    case 'feature':
      return document.features;
    case 'layer':
      return document.layers;
    case 'group':
      return document.groups;
    case 'file':
      return document.files;
  }
}

function create(
  document: StoredDocument,
  operation: Extract<ValueOperation, { type: 'create' }>,
  skip: (id: string) => void,
): void {
  const map = mapOf(document, operation.kind);
  if (map.has(operation.id)) {
    skip(operation.id);
    return;
  }
  map.set(operation.id, operation.record);
}

function set(
  document: StoredDocument,
  operation: Extract<ValueOperation, { type: 'set' }>,
  skip: (id: string) => void,
): void {
  switch (operation.kind) {
    case 'document':
      if (operation.set.title !== undefined) document.title = operation.set.title;
      if (operation.set.description !== undefined) document.description = operation.set.description;
      return;
    case 'feature':
      for (const id of operation.ids) {
        const record = document.features.get(id);
        if (!record) skip(id);
        else document.features.set(id, setFeature(record, operation.set, operation.unset));
      }
      return;
    case 'layer':
      for (const id of operation.ids) {
        const record = document.layers.get(id);
        if (!record) skip(id);
        else document.layers.set(id, setLayer(record, operation.set, operation.unset));
      }
      return;
    case 'group':
      for (const id of operation.ids) {
        const record = document.groups.get(id);
        if (!record) skip(id);
        else document.groups.set(id, { ...record, ...definedOf(operation.set) });
      }
      return;
  }
}

/** The fields of a `set` that it gives a value */
function definedOf<T extends object>(values: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(values) as (keyof T)[]) {
    if (values[key] !== undefined) out[key] = values[key];
  }
  return out;
}

/** A feature with the values of a `set` merged into it, then the keys of `unset` removed */
function setFeature(
  record: FeatureRecord,
  values: Partial<Omit<FeatureRecord, 'key'>>,
  unset: UnsetKeys | undefined,
): FeatureRecord {
  const properties: Record<string, JsonValue> = { ...record.properties };
  let style = isObject(properties[STYLE_KEY]) ? (properties[STYLE_KEY] as JsonObject) : undefined;
  for (const [key, value] of Object.entries(values.properties ?? {})) {
    if (value === undefined) continue;
    if (key === STYLE_KEY && isObject(value)) {
      style = mergedStyle(style ?? {}, value as JsonObject, undefined);
      continue;
    }
    setOwnProperty(properties, key, value);
    if (key === STYLE_KEY) style = undefined;
  }
  for (const key of unset?.properties ?? []) {
    delete properties[key];
    if (key === STYLE_KEY) style = undefined;
  }
  if (style !== undefined && unset?.style) style = mergedStyle(style, {}, unset.style);
  // The style is under its key as merged; a style left with no key is not held
  if (style !== undefined) {
    if (Object.keys(style).length > 0) setOwnProperty(properties, STYLE_KEY, style);
    else delete properties[STYLE_KEY];
  }
  return {
    geometry: values.geometry ?? record.geometry,
    properties,
    key: record.key,
  };
}

/** A layer with the values of a `set` merged into it, then the keys of the style removed */
function setLayer(
  record: LayerRecord,
  values: Partial<Omit<LayerRecord, 'key'>>,
  unset: Pick<UnsetKeys, 'style'> | undefined,
): LayerRecord {
  const { style, ...rest } = values;
  const merged =
    style !== undefined || unset?.style
      ? (mergedStyle(
          record.style as JsonObject,
          (style ?? {}) as JsonObject,
          unset?.style,
        ) as FeatureStyle)
      : record.style;
  return { ...record, ...definedOf(rest), style: merged };
}

/** A style with the keys of another merged into it, then the keys given removed */
function mergedStyle(
  style: JsonObject,
  values: JsonObject,
  removed: readonly string[] | undefined,
): JsonObject {
  const out: Record<string, JsonValue> = { ...style };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) setOwnProperty(out, key, value);
  }
  for (const key of removed ?? []) delete out[key];
  return out;
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function place(
  document: StoredDocument,
  operation: Extract<ValueOperation, { type: 'place' }>,
  skip: (id: string) => void,
): void {
  const { ids, keys, parentId } = operation;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const key = keys[i];
    if (typeof key !== 'string') {
      skip(id);
      continue;
    }
    switch (operation.kind) {
      case 'layer': {
        const record = document.layers.get(id);
        if (!record) skip(id);
        else document.layers.set(id, { ...record, key });
        break;
      }
      case 'group': {
        const record = document.groups.get(id);
        const parent = parentOf(document, parentId);
        if (!record || !parent) skip(id);
        else document.groups.set(id, { ...record, ...parent, key });
        break;
      }
      case 'feature': {
        const record = document.features.get(id);
        const parent = parentOf(document, parentId);
        if (!record || !parent) {
          skip(id);
          break;
        }
        const properties: Record<string, JsonValue> = { ...record.properties };
        setOwnProperty(properties, LAYER_KEY, parent.layerId);
        if (parent.parentId === null) delete properties[GROUP_KEY];
        else setOwnProperty(properties, GROUP_KEY, parent.parentId);
        document.features.set(id, { geometry: record.geometry, properties, key });
        break;
      }
    }
  }
}

/** The layer and the group of a parent: a layer, or a group and its layer */
function parentOf(
  document: StoredDocument,
  parentId: string | null,
): { readonly layerId: string; readonly parentId: string | null } | null {
  if (parentId === null) return null;
  if (document.layers.has(parentId)) return { layerId: parentId, parentId: null };
  const group = document.groups.get(parentId);
  return group ? { layerId: group.layerId, parentId } : null;
}
