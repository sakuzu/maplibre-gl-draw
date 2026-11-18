// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rules of the values of the fields of rows (`FeatureRowField`), checked without a Store:
 * `validateRowValues`, which the writes of the built-in Store run before they write anything, so
 * that a value that breaks a rule makes the whole write refused.
 *
 * The values are walked row by row, and in a row field by field (in the order of `fields`), then
 * the geometry, then the deletion: the first value that breaks a rule is the one told. Nothing is
 * made per row: the values of an attribute that holds arrays and objects are walked in place.
 *
 * @internal
 */

import { DrawError } from '../../shared/errors.js';
import type { FeatureRowField, GeometryColumn, NewRows, RowValues } from './types.js';

/** What `validateRowValues` tells of the first value that breaks a rule */
type RowValuesError = {
  readonly row: number;
  readonly field: FeatureRowField | 'deleted';
  readonly reason: string;
} | null;

/** The type of a row without a geometry, in `GeometryColumn.types` */
const NO_TYPE = 255;

/** The index of each type of geometry in `GEOMETRY_TYPES` */
const POINT = 0;
const LINE_STRING = 1;
const POLYGON = 2;
const MULTI_POINT = 3;
const MULTI_LINE_STRING = 4;
const MULTI_POLYGON = 5;

/** The start of the fields of the attributes */
const PROPERTY_FIELD = 'properties:';

/** The start of the fields of the keys of the style */
const STYLE_KEY_FIELD = 'style:';

/** The fields of a row that are not keys of the style or attributes */
const PLAIN_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'visible',
  'locked',
  'style',
  'parent',
  'orderKey',
]);

/** The fields a new row is not made without (besides its geometry) */
const NEEDED_FIELDS: readonly FeatureRowField[] = ['type', 'parent', 'orderKey'];

/** The error of one value */
function error(row: number, field: FeatureRowField | 'deleted', reason: string): RowValuesError {
  return { row, field, reason };
}

/**
 * Whether a field is one of a row, and how it is checked: `plain` for the fields of
 * {@link PLAIN_FIELDS}, `style` for a key of the style, `property` for an attribute
 */
export function fieldKind(field: string): 'plain' | 'style' | 'property' | null {
  if (PLAIN_FIELDS.has(field)) return 'plain';
  if (field.startsWith(STYLE_KEY_FIELD) && field.length > STYLE_KEY_FIELD.length) return 'style';
  if (field.startsWith(PROPERTY_FIELD) && field.length > PROPERTY_FIELD.length) return 'property';
  return null;
}

/**
 * Whether a value is a plain object (made by `{}`, or with no prototype)
 *
 * @internal
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Whether a value is one a key of the style holds: a string or a finite number */
function isStyleValue(value: unknown): boolean {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Why a style is not one (null when it is): an object whose values are strings and finite numbers
 *
 * @internal
 */
export function styleProblem(style: unknown): string | null {
  if (!isPlainObject(style)) return 'the style is not an object';
  // A plain object inherits no key it lists
  for (const key in style) {
    if (!isStyleValue(style[key])) {
      return `the key ${JSON.stringify(key)} of the style is neither a string nor a finite number`;
    }
  }
  return null;
}

/**
 * Why a value of an attribute is not one JSON holds (null when it is): a string, a finite number,
 * a boolean, `null`, or arrays and plain objects of them
 *
 * @param within - The arrays and objects the value is in, from the value of the attribute: a value
 *   that is in itself is not one JSON holds
 * @internal
 */
export function jsonProblem(value: unknown, within: unknown[]): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? null : `${value} is not a finite number`;
  }
  if (typeof value === 'function') return 'a function is not a value JSON holds';
  if (typeof value !== 'object') return `a ${typeof value} is not a value JSON holds`;
  if (within.includes(value)) return 'the value is in itself';
  if (Array.isArray(value)) {
    within.push(value);
    for (let i = 0; i < value.length; i++) {
      const problem = i in value ? jsonProblem(value[i], within) : `the array has no entry ${i}`;
      if (problem !== null) return problem;
    }
    within.pop();
    return null;
  }
  if (!isPlainObject(value))
    return 'an object that is not a plain object is not a value JSON holds';
  within.push(value);
  for (const key in value) {
    const item = value[key];
    const problem =
      item === undefined
        ? `the key ${JSON.stringify(key)} has no value`
        : jsonProblem(item, within);
    if (problem !== null) return problem;
  }
  within.pop();
  return null;
}

/**
 * Why a value of a field is not one of the field (null when it is)
 *
 * @param created - Whether the row is a new one: a value `undefined` takes the value of a new
 *   feature then, and a field it is not made without is missing
 */
function valueProblem(
  field: FeatureRowField,
  kind: 'plain' | 'style' | 'property',
  value: unknown,
  created: boolean,
  within: unknown[],
): string | null {
  if (kind === 'property') {
    if (value === undefined) return null;
    within.length = 0;
    return jsonProblem(value, within);
  }
  if (kind === 'style') {
    return value === undefined || isStyleValue(value)
      ? null
      : 'a key of the style is neither a string nor a finite number';
  }
  if (value === undefined) {
    if (created) return NEEDED_FIELDS.includes(field) ? 'a new row needs it' : null;
    return 'the value is missing';
  }
  switch (field) {
    case 'type':
      return typeof value === 'string' && value !== ''
        ? null
        : 'the type is not a non-empty string';
    case 'visible':
    case 'locked':
      return typeof value === 'boolean' ? null : `${field} is not a boolean`;
    case 'style':
      return styleProblem(value);
    case 'parent':
      return typeof value === 'string' && value !== ''
        ? null
        : 'the parent is not the id of a layer or a group';
    default:
      return typeof value === 'string' && value !== ''
        ? null
        : 'the key of the order is not a non-empty string';
  }
}

/** Whether a value is an array of `Int32Array` */
function isInt32(value: unknown): value is Int32Array {
  return value instanceof Int32Array;
}

/**
 * Why the arrays of a geometry column do not hold the geometries of `rows` rows (null when they
 * do): the starts of the parts, the rings and the positions from 0 and never decreasing, one more
 * entry than what they start, and the values of every position
 */
function columnProblem(
  geometry: GeometryColumn,
  rows: number,
  valuesPerPosition: number,
): string | null {
  const { types, coordinates, partStarts, ringStarts, positionStarts } = geometry;
  if (!(types instanceof Uint8Array) || types.length !== rows) {
    return `the types are not a Uint8Array of ${rows} entries`;
  }
  if (!(coordinates instanceof Float64Array)) return 'the coordinates are not a Float64Array';
  if (geometry.valuesPerPosition !== valuesPerPosition) {
    return `the positions have ${geometry.valuesPerPosition} values, the layer ${valuesPerPosition}`;
  }
  const levels: Array<[string, unknown, number]> = [
    ['parts', partStarts, rows],
    ['rings', ringStarts, isInt32(partStarts) ? partStarts[partStarts.length - 1] : 0],
    ['positions', positionStarts, isInt32(ringStarts) ? ringStarts[ringStarts.length - 1] : 0],
  ];
  for (const [name, starts, count] of levels) {
    if (!isInt32(starts) || starts.length !== count + 1 || starts[0] !== 0) {
      return `the starts of the ${name} are not an Int32Array of ${count + 1} entries from 0`;
    }
    for (let i = 1; i < starts.length; i++) {
      if (starts[i] < starts[i - 1]) return `the starts of the ${name} decrease at ${i}`;
    }
  }
  const positions = positionStarts[positionStarts.length - 1];
  if (coordinates.length !== positions * valuesPerPosition) {
    return `the coordinates have ${coordinates.length} values for ${positions} positions`;
  }
  return null;
}

/** Whether the first and the last position of a ring are the same, every value of them */
function isClosed(geometry: GeometryColumn, ring: number): boolean {
  const { coordinates, positionStarts, valuesPerPosition: n } = geometry;
  const first = positionStarts[ring];
  const last = positionStarts[ring + 1] - 1;
  if (last < first) return false;
  for (let k = 0; k < n; k++) {
    if (coordinates[first * n + k] !== coordinates[last * n + k]) return false;
  }
  return true;
}

/**
 * Why the geometry of one row is not one (null when it is): a type of `GEOMETRY_TYPES` with its
 * parts, rings and positions (a Point one part of one ring of one position, a LineString one part
 * of one ring, a Polygon one part, a MultiPoint parts of one ring of one position, a
 * MultiLineString parts of one ring), every value finite, the rings of the polygons closed; a row
 * of none has no part
 *
 * @param created - Whether the row is a new one, which needs a geometry
 */
function geometryProblem(geometry: GeometryColumn, row: number, created: boolean): string | null {
  const { types, coordinates, partStarts, ringStarts, positionStarts } = geometry;
  const n = geometry.valuesPerPosition;
  const type = types[row];
  const firstPart = partStarts[row];
  const parts = partStarts[row + 1] - firstPart;
  if (type === NO_TYPE) {
    if (created) return 'a new row needs a geometry';
    return parts === 0 ? null : 'a row without a geometry has parts';
  }
  if (type > MULTI_POLYGON) return `${type} is not the index of a type of geometry`;
  if ((type === POINT || type === LINE_STRING || type === POLYGON) && parts !== 1) {
    return `the geometry has ${parts} parts, its type one`;
  }
  const single = type === POINT || type === LINE_STRING || type === MULTI_POINT;
  const oneRing = single || type === MULTI_LINE_STRING;
  for (let part = firstPart; part < firstPart + parts; part++) {
    const rings = ringStarts[part + 1] - ringStarts[part];
    if (oneRing && rings !== 1)
      return `the part ${part - firstPart} has ${rings} rings, its type one`;
    for (let ring = ringStarts[part]; ring < ringStarts[part + 1]; ring++) {
      const from = positionStarts[ring];
      const to = positionStarts[ring + 1];
      if ((type === POINT || type === MULTI_POINT) && to - from !== 1) {
        return `a point has ${to - from} positions`;
      }
      for (let at = from * n; at < to * n; at++) {
        if (!Number.isFinite(coordinates[at])) {
          return 'a position has a value that is not a finite number';
        }
      }
      if ((type === POLYGON || type === MULTI_POLYGON) && !isClosed(geometry, ring)) {
        return `the ring ${ring - ringStarts[firstPart]} is not closed`;
      }
    }
  }
  return null;
}

/**
 * Checks values of rows against the rules of their fields ({@link FeatureRowField}) before they
 * are written, without a Store: for a caller that writes values that came from elsewhere (from
 * another program), so that one wrong value does not make a whole write refused. It checks the
 * values themselves (their kinds, the geometries and their number of values per position), not
 * what depends on the document (an id in use, a parent that is not there).
 *
 * @param values - The values, as they would be given to `writeRows` or `createRows`
 * @param valuesPerPosition - The number of values of a position of the layer they go to
 * @returns The first value that breaks a rule: the index of its row in the values, its field and
 *   the reason in English, for logs; or `null` when every value keeps the rules
 */
export function validateRowValues(
  values: RowValues | NewRows,
  valuesPerPosition: 2 | 3 | 4,
): {
  readonly row: number;
  readonly field: FeatureRowField | 'deleted';
  readonly reason: string;
} | null {
  if (valuesPerPosition !== 2 && valuesPerPosition !== 3 && valuesPerPosition !== 4) {
    throw new DrawError(
      'invalidInput',
      `validateRowValues: ${String(valuesPerPosition)} is not a number of values of a position (2, 3 or 4)`,
    );
  }
  if (typeof values !== 'object' || values === null) {
    throw new DrawError('invalidInput', 'validateRowValues: the values are not values of rows');
  }
  const created = 'ids' in values;
  const count = created ? (values as NewRows).ids?.length : (values as RowValues).rows?.length;
  if (typeof count !== 'number') {
    throw new DrawError(
      'invalidInput',
      `validateRowValues: the values have no ${created ? 'ids' : 'rows'}`,
    );
  }
  const { fields, geometry } = values;
  if (!(fields instanceof Map)) {
    throw new DrawError('invalidInput', 'validateRowValues: the fields are not a Map');
  }

  // The fields, their kinds and their values, once
  const names: FeatureRowField[] = [];
  const kinds: Array<'plain' | 'style' | 'property'> = [];
  const columns: Array<readonly unknown[]> = [];
  for (const [field, column] of fields) {
    if (field === 'geometry') {
      return error(0, 'geometry', 'the geometries are given as a GeometryColumn, not as values');
    }
    const kind = typeof field === 'string' ? fieldKind(field) : null;
    if (kind === null) return error(0, field, `${JSON.stringify(field)} is not a field of a row`);
    if (!Array.isArray(column) || column.length !== count) {
      return error(0, field, `the field has no array of ${count} values`);
    }
    names.push(field);
    kinds.push(kind);
    columns.push(column);
  }
  if (created) {
    if (geometry === undefined) return error(0, 'geometry', 'new rows need their geometries');
    for (const field of NEEDED_FIELDS) {
      if (!fields.has(field)) return error(0, field, 'a new row needs it');
    }
  }
  if (geometry !== undefined) {
    if (typeof geometry !== 'object' || geometry === null) {
      return error(0, 'geometry', 'the geometries are not a GeometryColumn');
    }
    const problem = columnProblem(geometry, count, valuesPerPosition);
    if (problem !== null) return error(0, 'geometry', problem);
  }
  const deleted = created ? undefined : (values as RowValues).deleted;
  if (deleted !== undefined && (!(deleted instanceof Uint8Array) || deleted.length !== count)) {
    return error(0, 'deleted', `the deletion is not a Uint8Array of ${count} entries`);
  }

  // The arrays and objects an attribute is walked in (one for every value)
  const within: unknown[] = [];
  for (let row = 0; row < count; row++) {
    for (let f = 0; f < names.length; f++) {
      const problem = valueProblem(names[f], kinds[f], columns[f][row], created, within);
      if (problem !== null) return error(row, names[f], problem);
    }
    if (geometry !== undefined) {
      const problem = geometryProblem(geometry, row, created);
      if (problem !== null) return error(row, 'geometry', problem);
    }
  }
  return null;
}
