// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The write of the same patch to any number of features (the bulk edit `features.updateAll`):
 * what an edit writes to each batch of its features
 *
 * - The patch is checked before the edit starts; the values it writes are made once per kind of
 *   row (its type and its style, as the rows hold them), not once per row, so that a hundred
 *   thousand rows of a few kinds ask for a few of them. The attributes are merged with those of
 *   each feature when it is written, as `update` merges them.
 * - A feature for which the patch changes nothing is not written, nor counted.
 * - The values are written through the layer, feature by feature (`updateFeature`): the locks,
 *   the values before and the writes of the instance are those of every write.
 */

import type { Geometry } from 'geojson';
import type { FeatureRowField } from '../store/built-in/types.js';
import type { InstanceDocument } from '../store/document-access.js';
import type { Feature, FeatureStyle } from '../store/types.js';
import type { BulkBatchWork } from './bulk-work.js';

/**
 * A patch checked, as the bulk edit writes it to every feature: the keys of `properties` and
 * `style` merged key by key (one given `undefined` taken off)
 *
 * @internal
 */
export interface SamePatch {
  readonly geometry?: Geometry;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly style?: Readonly<Record<string, unknown>>;
  readonly visible?: boolean;
  readonly locked?: boolean;
}

/** The fields of a row the kinds of rows are read from */
const KIND_FIELDS: readonly FeatureRowField[] = ['type', 'style', 'visible', 'locked'];

/** What a kind of row is written: the values of the patch made for it, once */
interface KindWrite {
  /** The values written, the attributes left out (merged per feature) */
  readonly updates: Partial<Feature>;
  /** Whether the style of the kind changes */
  readonly styleChanges: boolean;
}

/**
 * The keys of `base` with the keys of `patch` set, and removed where they are undefined (a key
 * such as `__proto__` is an own key of the result)
 *
 * @internal
 */
export function mergedKeys(
  base: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const set = (key: string, value: unknown): void => {
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };
  for (const [key, value] of Object.entries(base)) set(key, value);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete result[key];
    else set(key, value);
  }
  return result;
}

/** Whether two values read from rows or given in a patch are the same (as JSON values) */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((value, i) => sameValue(value, other[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  const bRecord = b as Record<string, unknown>;
  const own = new Set(bKeys);
  return aKeys.every(
    (key) => own.has(key) && sameValue((a as Record<string, unknown>)[key], bRecord[key]),
  );
}

/**
 * Makes the work of a write of the same patch
 *
 * @param layer - The layer over the Store, through which the rows are read and the features
 *   written
 * @param patch - The patch, checked
 * @param patchMade - Called each time the values of a kind of row are made (what the tests
 *   count)
 * @internal
 */
export function createUpdateAllWork(
  layer: Pick<
    InstanceDocument,
    'readFeatureValues' | 'getFeature' | 'getFeatureProperty' | 'updateFeature'
  >,
  patch: SamePatch,
  patchMade: () => void = () => {},
): BulkBatchWork {
  /** The values of each kind of row, by its style as the rows hold it and its type */
  const kinds = new Map<unknown, Map<string, KindWrite>>();
  const kindOf = (type: string, style: unknown): KindWrite => {
    let byType = kinds.get(style);
    if (!byType) {
      byType = new Map();
      kinds.set(style, byType);
    }
    let kind = byType.get(type);
    if (!kind) {
      const updates: Partial<Feature> = {};
      let styleChanges = false;
      if (patch.geometry !== undefined) updates.geometry = patch.geometry;
      if (patch.style !== undefined) {
        const base = (style ?? {}) as Record<string, unknown>;
        const next = mergedKeys(base, patch.style);
        styleChanges = !sameValue(base, next);
        updates.style = next as FeatureStyle;
      }
      if (patch.visible !== undefined) updates.visible = patch.visible;
      if (patch.locked !== undefined) updates.locked = patch.locked;
      kind = { updates, styleChanges };
      byType.set(type, kind);
      patchMade();
    }
    return kind;
  };

  /** Whether the patch changes the attributes of a feature */
  const propertiesChange = (id: string): boolean => {
    const properties = patch.properties;
    if (!properties) return false;
    for (const [key, value] of Object.entries(properties)) {
      if (!sameValue(layer.getFeatureProperty(id, key), value)) return true;
    }
    return false;
  };

  return {
    writeFeatures(ids, changed) {
      let start = 0;
      while (start < ids.length) {
        const read = layer.readFeatureValues(ids, KIND_FIELDS, start);
        const { fields } = read.values;
        const types = fields.get('type') ?? [];
        const styles = fields.get('style') ?? [];
        const visibles = fields.get('visible') ?? [];
        const lockeds = fields.get('locked') ?? [];
        for (let k = 0; k < read.indices.length; k++) {
          const at = read.indices[k];
          const id = ids[at];
          const kind = kindOf(String(types[k]), styles[k]);
          let changes = kind.styleChanges;
          if (!changes && patch.visible !== undefined) {
            changes = (visibles[k] !== false) !== patch.visible;
          }
          if (!changes && patch.locked !== undefined) {
            changes = (lockeds[k] === true) !== patch.locked;
          }
          if (!changes && propertiesChange(id)) changes = true;
          let feature: Feature | undefined;
          if (!changes && patch.geometry !== undefined) {
            feature = layer.getFeature(id);
            changes = feature !== undefined && !sameValue(feature.geometry, patch.geometry);
          }
          if (!changes) continue;
          let updates = kind.updates;
          if (patch.properties) {
            feature ??= layer.getFeature(id);
            if (!feature) continue;
            updates = { ...updates, properties: mergedKeys(feature.properties, patch.properties) };
          }
          if (layer.updateFeature(id, updates)) changed[at] = 1;
        }
        // An ID that is no feature any more ends a run without being read: it is passed over
        start = read.end > start ? read.end : start + 1;
      }
    },
  };
}
