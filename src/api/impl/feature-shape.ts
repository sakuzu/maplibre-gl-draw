// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one shape of a feature, a GeoJSON Feature, and the feature as the Store holds it
 *
 * The Store holds the values of the library in fields of a feature (its layer, group, type,
 * style, visibility and lock); the public shape holds them in `properties`, under the keys of
 * the library (`maplibre-gl-draw:layerId` and the rest), and holds no key for a value that is the
 * default (visible, not locked, in no group, of the type of its geometry, no style of its own).
 * A feature of the public shape is made only when it is read, from the feature of the Store, and
 * a feature given is turned into the input of the Store before it is checked and written.
 *
 * The rings of a polygon follow the right-hand rule as they are written (the outer ring
 * counter-clockwise, the holes clockwise), so that what is read is RFC 7946 as it is.
 */

import type { Geometry } from 'geojson';
import { orientRings } from '../../geometry/simplify.js';
import { DRAW_PROPERTY_PREFIX } from '../../shared/properties.js';
import { setOwnProperty } from '../../shared/utils/own-property.js';
import type { FeaturePatch as StorePatch } from '../../store/store.js';
import type { Feature as StoreFeature, FeatureStyle as StoreStyle } from '../../store/types.js';
import type {
  Feature,
  FeatureFields,
  FeatureInput,
  FeaturePatch,
  StoredFeatureInput,
} from '../model.js';
import { invalidInput, isRecord } from './shared.js';

/** The keys of `properties` that hold the fields of a feature of the Store */
export const FIELD_KEYS = {
  layerId: `${DRAW_PROPERTY_PREFIX}layerId`,
  groupId: `${DRAW_PROPERTY_PREFIX}groupId`,
  featureType: `${DRAW_PROPERTY_PREFIX}featureType`,
  style: `${DRAW_PROPERTY_PREFIX}style`,
  visible: `${DRAW_PROPERTY_PREFIX}visible`,
  locked: `${DRAW_PROPERTY_PREFIX}locked`,
} as const;

/** The keys of the place of a feature, which `place` changes and a patch does not */
const PLACE_KEYS: ReadonlySet<string> = new Set([
  FIELD_KEYS.layerId,
  FIELD_KEYS.groupId,
  FIELD_KEYS.featureType,
]);

const FIELD_KEY_SET: ReadonlySet<string> = new Set(Object.values(FIELD_KEYS));

/**
 * The feature of the Store in the one public shape: a new object (its `properties` too), the
 * geometry and the style shared with the Store, which does not change what it gave
 *
 * @internal
 */
export function toFeature(stored: StoreFeature): Feature {
  // A spread defines each key as an own property, `__proto__` included, without a setter
  const properties: Record<string, unknown> = { ...(stored.properties ?? {}) };
  properties[FIELD_KEYS.layerId] = stored.layerId;
  if (stored.groupId != null) properties[FIELD_KEYS.groupId] = stored.groupId;
  if (stored.type !== stored.geometry.type) properties[FIELD_KEYS.featureType] = stored.type;
  // A shape drawn may come with no style of its own
  if (stored.style && Object.keys(stored.style).length > 0) {
    properties[FIELD_KEYS.style] = stored.style;
  }
  if (stored.visible === false) properties[FIELD_KEYS.visible] = false;
  if (stored.locked === true) properties[FIELD_KEYS.locked] = true;
  return { type: 'Feature', id: stored.id, geometry: stored.geometry, properties } as Feature;
}

/** The feature each feature of the Store was given to the extensions as, while it is the same */
const SHOWN = new WeakMap<StoreFeature, Feature>();
/** The feature of the Store each feature given to the extensions was made from */
const SOURCES = new WeakMap<Feature, StoreFeature>();

/**
 * The feature of the Store in the public shape, as the extensions are given it: frozen, and the
 * same object while the Store gives the same feature, so that what draws a feature each frame
 * makes no new object for it
 *
 * @internal
 */
export function featureForExtension(stored: StoreFeature): Feature {
  let shown = SHOWN.get(stored);
  if (shown === undefined) {
    shown = toFeature(stored);
    Object.freeze(shown.properties);
    Object.freeze(shown);
    SHOWN.set(stored, shown);
    SOURCES.set(shown, stored);
  }
  return shown;
}

/**
 * The feature of the Store a feature given to the extensions was made from (undefined for one
 * that was not given so)
 *
 * @internal
 */
export function storedOfExtensionFeature(feature: Feature): StoreFeature | undefined {
  return SOURCES.get(feature);
}

/**
 * A feature of the public shape as a feature of the Store, its values of the library read into
 * fields (a feature an extension made itself, say)
 *
 * @internal
 */
export function storedFeatureOf(feature: Feature): StoreFeature {
  const fields = readFeatureFields(feature);
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(feature.properties ?? {})) {
    if (!isFieldKey(key)) setOwnProperty(properties, key, value);
  }
  return {
    id: feature.id,
    type: fields.featureType,
    geometry: feature.geometry,
    layerId: fields.layerId ?? '',
    groupId: fields.groupId ?? undefined,
    properties: properties as StoreFeature['properties'],
    style: fields.style as StoreFeature['style'],
    visible: fields.visible,
    locked: fields.locked,
  };
}

/**
 * The feature of the Store in the public shape, as the extensions are given it, or null
 *
 * @internal
 */
export function featureForExtensionOrNull(stored: StoreFeature | null | undefined): Feature | null {
  return stored ? featureForExtension(stored) : null;
}

/**
 * The feature of the Store in the public shape, or undefined
 *
 * @internal
 */
export function toFeatureOrUndefined(stored: StoreFeature | undefined): Feature | undefined {
  return stored === undefined ? undefined : toFeature(stored);
}

/**
 * The values of the library of a feature, under short names, with the defaults filled in
 *
 * @internal
 */
export function readFeatureFields(feature: {
  readonly geometry: Geometry;
  readonly properties: object | null;
}): FeatureFields {
  if (!isRecord(feature) || !isRecord(feature.geometry)) {
    throw invalidInput('readFeature reads a feature with a geometry');
  }
  const properties = (isRecord(feature.properties) ? feature.properties : {}) as Record<
    string,
    unknown
  >;
  const read = (name: string) => properties[`${DRAW_PROPERTY_PREFIX}${name}`];
  const fields: Record<string, unknown> = {
    featureType:
      typeof read('featureType') === 'string' ? read('featureType') : feature.geometry.type,
    layerId: typeof read('layerId') === 'string' ? read('layerId') : null,
    groupId: typeof read('groupId') === 'string' ? read('groupId') : null,
    style: isRecord(read('style')) ? read('style') : {},
    visible: read('visible') !== false,
    locked: read('locked') === true,
  };
  for (const name of [
    'createdZoom',
    'rotation',
    'scale',
    'radiusMeters',
    'radiusHandleAngle',
    'imageWidth',
    'imageHeight',
  ]) {
    if (typeof read(name) === 'number') fields[name] = read(name);
  }
  if (typeof read('imageFileId') === 'string') fields.imageFileId = read('imageFileId');
  return fields as unknown as FeatureFields;
}

// ============================================================================
// Rings
// ============================================================================

/**
 * The geometry with the rings of its polygons in the right-hand rule: the same object when they
 * already are
 *
 * @internal
 */
export function orientedGeometry<G extends Geometry>(geometry: G): G {
  return orientRings(geometry);
}

// ============================================================================
// Inputs
// ============================================================================

/**
 * A GeoJSON Feature given to be created, as the input of the Store: the fields read from the keys
 * of the library, the rings oriented. Its own checks are of the GeoJSON shape; the rest (the
 * geometry against the type, the layer, the ID) is checked as an input of the Store is.
 *
 * @throws DrawError `invalidInput` for anything but a GeoJSON Feature, a `null` geometry, a
 *   GeometryCollection, or a value of the library of the wrong type
 * @internal
 */
export function storedInputOf(input: FeatureInput): StoredFeatureInput {
  if (!isRecord(input)) throw invalidInput('A feature is a GeoJSON Feature object');
  if (input.type !== 'Feature') {
    throw invalidInput("A feature is a GeoJSON Feature: its type must be 'Feature'");
  }
  const geometry = input.geometry as Geometry | null | undefined;
  if (!isRecord(geometry)) throw invalidInput('The feature must have a geometry');
  if (geometry.type === 'GeometryCollection') {
    throw invalidInput('A feature cannot hold a GeometryCollection');
  }
  const out: Record<string, unknown> = {};
  const id = input.id as unknown;
  if (typeof id === 'number') {
    if (!Number.isFinite(id)) throw invalidInput('The ID must be a string or a finite number');
    out.id = String(id);
  } else if (id !== undefined) {
    out.id = id;
  }
  const given = input.properties as unknown;
  if (given !== null && given !== undefined && !isRecord(given)) {
    throw invalidInput('properties must be an object or null');
  }
  const properties: Record<string, unknown> = {};
  let featureType: unknown;
  for (const [key, value] of Object.entries((given ?? {}) as Record<string, unknown>)) {
    switch (key) {
      case FIELD_KEYS.layerId:
        if (value !== undefined) out.layerId = value;
        break;
      case FIELD_KEYS.groupId:
        if (value !== undefined && value !== null) out.groupId = value;
        break;
      case FIELD_KEYS.featureType:
        featureType = value;
        break;
      case FIELD_KEYS.style:
        if (value !== undefined) {
          if (!isRecord(value)) throw invalidInput(`${FIELD_KEYS.style} must be an object`);
          out.style = value;
        }
        break;
      case FIELD_KEYS.visible:
        if (value !== undefined) out.visible = booleanOf(value, key);
        break;
      case FIELD_KEYS.locked:
        if (value !== undefined) out.locked = booleanOf(value, key);
        break;
      default:
        setOwnProperty(properties, key, value);
    }
  }
  if (featureType !== undefined && (typeof featureType !== 'string' || featureType === '')) {
    throw invalidInput(`${FIELD_KEYS.featureType} must be a non-empty string`);
  }
  out.type = featureType ?? geometry.type;
  out.geometry = orientedGeometry(geometry);
  out.properties = properties;
  return out as unknown as StoredFeatureInput;
}

function booleanOf(value: unknown, key: string): boolean {
  if (typeof value !== 'boolean') throw invalidInput(`${key} must be a boolean`);
  return value;
}

/**
 * A patch of the public shape as the patch of the Store of a feature: the keys of `properties`
 * set, the ones of `unset` removed (a key given `undefined` is refused, so that nothing is
 * removed without being named), the fields of the library read from their keys
 *
 * @param feature - The feature the patch is given to (a `unset` of the style removes its keys)
 * @throws DrawError `invalidInput` for an empty patch, a value `undefined`, a key of the place
 *   (`layerId`, `groupId`, `featureType`: `place` puts a feature elsewhere), or a value of the
 *   library of the wrong type
 * @internal
 */
export function storedPatchOf(patch: FeaturePatch, feature: StoreFeature): StorePatch {
  if (!isRecord(patch)) throw invalidInput('The patch must be an object');
  const record = patch as Record<string, unknown>;
  const keys = Object.keys(record);
  for (const key of keys) {
    if (key !== 'geometry' && key !== 'properties' && key !== 'unset') {
      throw invalidInput(`The patch cannot have the key ${key}`);
    }
  }
  if (keys.every((key) => record[key] === undefined)) {
    throw invalidInput('The patch changes nothing: give geometry, properties or unset');
  }
  const out: { -readonly [K in keyof StorePatch]: StorePatch[K] } = {};
  const properties: Record<string, unknown> = {};
  const style: Record<string, unknown> = {};
  let touchedProperties = false;
  let touchedStyle = false;

  if (record.geometry !== undefined) {
    if (!isRecord(record.geometry)) throw invalidInput('geometry must be a GeoJSON geometry');
    if (record.geometry.type === 'GeometryCollection') {
      throw invalidInput('A feature cannot hold a GeometryCollection');
    }
    out.geometry = orientedGeometry(record.geometry as unknown as Geometry);
  }

  if (record.properties !== undefined) {
    const given = record.properties;
    if (!isRecord(given)) throw invalidInput('properties must be an object');
    const entries = Object.entries(given);
    if (entries.length === 0) throw invalidInput('properties is empty: it changes nothing');
    for (const [key, value] of entries) {
      if (value === undefined) {
        throw invalidInput(`The property ${key} is undefined: remove a key with unset`);
      }
      if (PLACE_KEYS.has(key)) {
        throw invalidInput(`${key} is the place of the feature: change it with place`);
      }
      if (key === FIELD_KEYS.style) {
        if (!isRecord(value)) throw invalidInput(`${key} must be an object`);
        for (const [name, styleValue] of Object.entries(value)) {
          if (styleValue === undefined) {
            throw invalidInput(`The style key ${name} is undefined: remove it with unset`);
          }
          setOwnProperty(style, name, styleValue);
        }
        touchedStyle = true;
      } else if (key === FIELD_KEYS.visible) {
        out.visible = booleanOf(value, key);
      } else if (key === FIELD_KEYS.locked) {
        out.locked = booleanOf(value, key);
      } else {
        setOwnProperty(properties, key, value);
        touchedProperties = true;
      }
    }
  }

  if (record.unset !== undefined) {
    const unset = record.unset;
    if (!isRecord(unset)) throw invalidInput('unset must be an object');
    for (const key of Object.keys(unset)) {
      if (key !== 'properties' && key !== 'style') {
        throw invalidInput(`unset cannot have the key ${key}`);
      }
    }
    const names = (list: unknown, what: string): string[] => {
      if (list === undefined) return [];
      if (!Array.isArray(list) || list.some((key) => typeof key !== 'string')) {
        throw invalidInput(`unset.${what} must be an array of keys`);
      }
      if (list.length === 0) throw invalidInput(`unset.${what} is empty: it removes nothing`);
      return list as string[];
    };
    for (const key of names(unset.properties, 'properties')) {
      if (PLACE_KEYS.has(key)) {
        throw invalidInput(`${key} is the place of the feature: change it with place`);
      }
      if (key === FIELD_KEYS.style) {
        for (const name of Object.keys(feature.style)) style[name] = undefined;
        touchedStyle = true;
      } else if (key === FIELD_KEYS.visible) {
        out.visible = true;
      } else if (key === FIELD_KEYS.locked) {
        out.locked = false;
      } else {
        properties[key] = undefined;
        touchedProperties = true;
      }
    }
    for (const name of names(unset.style, 'style')) {
      style[name] = undefined;
      touchedStyle = true;
    }
  }

  if (touchedProperties) out.properties = properties as StorePatch['properties'];
  if (touchedStyle) out.style = style as StoreStyle;
  return out;
}

/** Whether a key of `properties` holds a field of a feature of the Store */
export function isFieldKey(key: string): boolean {
  return FIELD_KEY_SET.has(key);
}
