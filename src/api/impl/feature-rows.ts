// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Features as the values of rows, and back: the fields of a row of a feature, its geometry as a
 * column of positions, and a feature made from the values read from rows
 *
 * The functions here read and make plain values only; the layer over the Store reads and
 * writes the rows (see `document-access.ts`).
 */

import type { Geometry, Position } from 'geojson';
import type { FeatureRowField, GeometryColumn, RowValues } from '../../store/built-in/types.js';
import { GEOMETRY_TYPES } from '../../store/built-in/types.js';
import type { Feature, FeatureStyle } from '../../store/types.js';

/** The prefix of the fields of the attributes of a row */
export const PROPERTY_FIELD = 'properties:';

/** The prefix of the field of a key of the style (`style:<key>`) */
const STYLE_FIELD = 'style:';

/** The fields every feature is read with, besides its attributes */
export const FEATURE_FIELDS: readonly FeatureRowField[] = Object.freeze([
  'type',
  'geometry',
  'visible',
  'locked',
  'style',
  'parent',
] as const);

/** The type of geometry of a row that has none */
const NO_GEOMETRY = 255;

/** The index of each type of geometry in `GEOMETRY_TYPES` */
const GEOMETRY_INDEX: ReadonlyMap<string, number> = new Map(
  GEOMETRY_TYPES.map((type, index) => [type, index]),
);

/**
 * Returns a deeply frozen copy of a value read from a row (an attribute, a style): arrays and
 * plain objects are copied and frozen, a value already frozen is taken as it is
 */
export function frozenValue<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    const copy = new Array(value.length);
    for (let i = 0; i < value.length; i++) copy[i] = frozenValue(value[i]);
    return Object.freeze(copy) as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy: Record<string, unknown> = prototype === null ? Object.create(null) : {};
  for (const key of Object.keys(value)) {
    const item = frozenValue((value as Record<string, unknown>)[key]);
    if (key === '__proto__') {
      Object.defineProperty(copy, key, {
        value: item,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      copy[key] = item;
    }
  }
  return Object.freeze(copy) as T;
}

/**
 * A frozen feature made from a base and the fields that change, copying only those fields (the
 * base is already frozen)
 */
export function frozenFeature(base: Feature | undefined, changes: Partial<Feature>): Feature {
  const feature = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(changes)) {
    feature[key] = frozenValue((changes as Record<string, unknown>)[key]);
  }
  return Object.freeze(feature) as unknown as Feature;
}

// ============================================================================
// Geometries
// ============================================================================

/** The parts of a geometry, each a list of rings, each a list of positions */
function partsOf(geometry: Geometry): Position[][][] {
  switch (geometry.type) {
    case 'Point':
      return [[[geometry.coordinates]]];
    case 'LineString':
      return [[geometry.coordinates]];
    case 'Polygon':
      return [geometry.coordinates];
    case 'MultiPoint':
      return geometry.coordinates.map((position) => [[position]]);
    case 'MultiLineString':
      return geometry.coordinates.map((line) => [line]);
    case 'MultiPolygon':
      return geometry.coordinates;
    default:
      return [];
  }
}

/**
 * The geometries as a column of positions, one row each, with `valuesPerPosition` values per
 * position
 */
export function geometryColumnOf(
  geometries: readonly (Geometry | null)[],
  valuesPerPosition: number,
): GeometryColumn {
  const all = geometries.map((geometry) => (geometry ? partsOf(geometry) : []));
  let partCount = 0;
  let ringCount = 0;
  let positionCount = 0;
  for (const parts of all) {
    partCount += parts.length;
    for (const rings of parts) {
      ringCount += rings.length;
      for (const ring of rings) positionCount += ring.length;
    }
  }
  const types = new Uint8Array(geometries.length);
  const partStarts = new Int32Array(geometries.length + 1);
  const ringStarts = new Int32Array(partCount + 1);
  const positionStarts = new Int32Array(ringCount + 1);
  const coordinates = new Float64Array(positionCount * valuesPerPosition);
  let part = 0;
  let ring = 0;
  let position = 0;
  for (let row = 0; row < geometries.length; row++) {
    const geometry = geometries[row];
    types[row] = geometry ? (GEOMETRY_INDEX.get(geometry.type) ?? NO_GEOMETRY) : NO_GEOMETRY;
    partStarts[row] = part;
    for (const rings of all[row]) {
      ringStarts[part] = ring;
      part += 1;
      for (const positions of rings) {
        positionStarts[ring] = position;
        ring += 1;
        for (const at of positions) {
          const base = position * valuesPerPosition;
          for (let k = 0; k < valuesPerPosition; k++) {
            coordinates[base + k] = at[k] ?? Number.NaN;
          }
          position += 1;
        }
      }
    }
  }
  partStarts[geometries.length] = part;
  ringStarts[partCount] = ring;
  positionStarts[ringCount] = position;
  return { types, coordinates, valuesPerPosition, partStarts, ringStarts, positionStarts };
}

/** The GeoJSON geometry of one row of a column, or null for a row without one */
export function geometryOfColumn(column: GeometryColumn, row: number): Geometry | null {
  const type = GEOMETRY_TYPES[column.types[row]];
  if (type === undefined) return null;
  const { coordinates, valuesPerPosition, partStarts, ringStarts, positionStarts } = column;
  const positionAt = (index: number): Position => {
    const base = index * valuesPerPosition;
    const position: number[] = new Array(valuesPerPosition);
    for (let k = 0; k < valuesPerPosition; k++) position[k] = coordinates[base + k];
    return position;
  };
  const ringAt = (index: number): Position[] => {
    const out: Position[] = [];
    for (let p = positionStarts[index]; p < positionStarts[index + 1]; p++) out.push(positionAt(p));
    return out;
  };
  const partAt = (index: number): Position[][] => {
    const out: Position[][] = [];
    for (let r = ringStarts[index]; r < ringStarts[index + 1]; r++) out.push(ringAt(r));
    return out;
  };
  const parts: Position[][][] = [];
  for (let p = partStarts[row]; p < partStarts[row + 1]; p++) parts.push(partAt(p));
  switch (type) {
    case 'Point':
      return { type, coordinates: parts[0]?.[0]?.[0] ?? [] };
    case 'LineString':
      return { type, coordinates: parts[0]?.[0] ?? [] };
    case 'Polygon':
      return { type, coordinates: parts[0] ?? [] };
    case 'MultiPoint':
      return { type, coordinates: parts.map((rings) => rings[0]?.[0] ?? []) };
    case 'MultiLineString':
      return { type, coordinates: parts.map((rings) => rings[0] ?? []) };
    case 'MultiPolygon':
      return { type, coordinates: parts };
  }
}

// ============================================================================
// The fields of rows
// ============================================================================

/** The attributes of a feature as the fields of a row: one field per key that holds a value */
export function propertyFieldsOf(properties: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const key of Object.keys(properties)) {
    if (properties[key] !== undefined) keys.push(key);
  }
  return keys;
}

/**
 * The fields of the rows of new features, one value per feature: their type, flags, style,
 * attributes, parent and key of order. A key of the attributes a feature does not hold is
 * `undefined` for it.
 *
 * @param places - The parent (a group or the layer) and the key of order of each feature
 */
export function newRowFields(
  features: readonly Feature[],
  places: readonly { parent: string; orderKey: string }[],
): Map<FeatureRowField, unknown[]> {
  const fields = new Map<FeatureRowField, unknown[]>([
    ['type', features.map((feature) => feature.type)],
    ['visible', features.map((feature) => feature.visible !== false)],
    ['locked', features.map((feature) => feature.locked === true)],
    ['style', features.map((feature) => (feature.style ?? {}) as unknown)],
    ['parent', places.map((place) => place.parent)],
    ['orderKey', places.map((place) => place.orderKey)],
  ]);
  features.forEach((feature, i) => {
    const properties = feature.properties ?? {};
    for (const key of propertyFieldsOf(properties)) {
      const field = `${PROPERTY_FIELD}${key}` as FeatureRowField;
      let column = fields.get(field);
      if (!column) {
        column = new Array<unknown>(features.length).fill(undefined);
        fields.set(field, column);
      }
      column[i] = properties[key];
    }
  });
  return fields;
}

/** Whether two values read from JSON are the same, key by key */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((value, i) => sameValue(value, other[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (key) =>
      Object.getOwnPropertyDescriptor(b, key) !== undefined &&
      sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/**
 * The fields of a row that an update of a feature writes: the fields of the values that differ
 * from the feature before it, and the geometry when it is given. The style is written by the
 * keys that differ (`style:<key>`), as the attributes are, so that a change names the keys it
 * wrote. The place (`parent` and `orderKey`) is written by the caller.
 */
export function updatedRowFields(
  previous: Feature,
  updated: Feature,
  updates: Partial<Feature>,
): { fields: Map<FeatureRowField, unknown[]>; geometry: Geometry | undefined } {
  const fields = new Map<FeatureRowField, unknown[]>();
  if ('type' in updates && updated.type !== previous.type) fields.set('type', [updated.type]);
  if ('visible' in updates && updated.visible !== previous.visible) {
    fields.set('visible', [updated.visible !== false]);
  }
  if ('locked' in updates && updated.locked !== previous.locked) {
    fields.set('locked', [updated.locked === true]);
  }
  if ('style' in updates && !sameValue(updated.style, previous.style)) {
    const before = (previous.style ?? {}) as Record<string, unknown>;
    const after = (updated.style ?? {}) as Record<string, unknown>;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (sameValue(after[key], before[key])) continue;
      fields.set(`${STYLE_FIELD}${key}` as FeatureRowField, [after[key]]);
    }
  }
  if ('properties' in updates) {
    const before = previous.properties ?? {};
    const after = updated.properties ?? {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const value = after[key];
      if (sameValue(value, before[key])) continue;
      fields.set(`${PROPERTY_FIELD}${key}` as FeatureRowField, [value]);
    }
  }
  const geometry = 'geometry' in updates ? updated.geometry : undefined;
  return { fields, geometry };
}

/**
 * The features of rows read with their values (`FEATURE_FIELDS` and the attributes), by their
 * ids, layers and groups
 *
 * @param ids - The id of each row
 * @param placeOf - The layer and the group of a parent
 */
export function featuresOfValues(
  values: RowValues,
  ids: readonly string[],
  placeOf: (parent: unknown) => { layerId: string; groupId: string | undefined },
): Feature[] {
  const { fields, geometry } = values;
  const types = fields.get('type') ?? [];
  const visible = fields.get('visible') ?? [];
  const locked = fields.get('locked') ?? [];
  const styles = fields.get('style') ?? [];
  const parents = fields.get('parent') ?? [];
  const properties: Array<[string, readonly unknown[]]> = [];
  for (const [field, column] of fields) {
    if (field.startsWith(PROPERTY_FIELD)) {
      properties.push([field.slice(PROPERTY_FIELD.length), column]);
    }
  }
  const out: Feature[] = [];
  for (let i = 0; i < ids.length; i++) {
    const own: Record<string, unknown> = {};
    for (const [key, column] of properties) {
      const value = column[i];
      if (value === undefined) continue;
      if (key === '__proto__') {
        Object.defineProperty(own, key, {
          value: frozenValue(value),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        own[key] = frozenValue(value);
      }
    }
    const { layerId, groupId } = placeOf(parents[i]);
    const shape = geometry ? geometryOfColumn(geometry, i) : null;
    out.push(
      Object.freeze({
        id: ids[i],
        type: types[i] as string,
        geometry: frozenValue(shape ?? ({ type: 'Point', coordinates: [] } as Geometry)),
        layerId,
        groupId,
        properties: Object.freeze(own),
        style: frozenValue(((styles[i] as FeatureStyle | undefined) ?? {}) as FeatureStyle),
        visible: visible[i] !== false,
        locked: locked[i] === true,
      }) as Feature,
    );
  }
  return out;
}
