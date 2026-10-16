// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reading the values of a row held as columns
 *
 * A row becomes a feature only when one is asked for (a hit, the features drawn at once, a
 * reader that needs one); the drawing and the hit testing read its columns as they are. Every
 * read looks first at what was written of the row in place since its group was built
 * (`value-overrides.ts`), then at the columns.
 */

import type { Geometry } from 'geojson';
import { DrawError } from '../shared/draw-error.js';
import type { Coordinate, Feature, FeatureType } from '../shared/types/model.js';
import { setOwnProperty } from '../shared/utils/own-property.js';
import type { CoordinateDimensions } from '../table/coordinates.js';
import type { RowInput } from '../table/row-group-builder.js';
import {
  ROW_FLAG_DELETED,
  ROW_FLAG_LOCKED,
  ROW_FLAG_VISIBLE,
  type RowBlockData,
} from '../table/row-group-types.js';
import { utf8String } from '../table/utf8-column.js';
import type { Value } from '../table/value.js';
import {
  readNumberValue,
  readValue,
  VALUE_NUMBER,
  type ValueStringCache,
} from '../table/value-column.js';
import type { GroupTable } from './group-table.js';
import { geometryAt, type RowGroup } from './layer-table.js';
import type { StyleTable } from './style-table.js';
import { decodeOverrideValue } from './value-overrides.js';

/**
 * What reading a row needs besides the row
 *
 * @internal
 */
export interface RowReadContext {
  readonly styles: StyleTable;
  readonly groups: GroupTable;
  readonly strings: ValueStringCache;
  /** The dimensions of the coordinates of a layer */
  dimensionsOf(layerId: string): CoordinateDimensions;
}

/**
 * The type of a row
 *
 * @internal
 */
export function rowType(data: RowBlockData, row: number): FeatureType {
  return data.typeNames[data.types[row]] as FeatureType;
}

/**
 * The value of an attribute of a row (undefined when the row does not hold the key)
 *
 * @internal
 */
export function rowValue(
  group: RowGroup,
  row: number,
  key: string,
  strings?: ValueStringCache,
): unknown {
  const written = group.values?.get(row, key);
  if (written) return decodeOverrideValue(written);
  const column = group.propertyIndex.get(key);
  if (column === undefined) return undefined;
  return readValue(group.data.properties.columns[column], row, strings);
}

/**
 * The value of an attribute of a row when it is a number
 *
 * @internal
 */
export function rowNumber(group: RowGroup, row: number, key: string): number | undefined {
  const written = group.values?.get(row, key);
  if (written) return written.tag === VALUE_NUMBER ? written.number : undefined;
  const column = group.propertyIndex.get(key);
  if (column === undefined) return undefined;
  return readNumberValue(group.data.properties.columns[column], row);
}

/**
 * Every attribute of a row
 *
 * @internal
 */
export function rowProperties(
  group: RowGroup,
  row: number,
  strings?: ValueStringCache,
): Record<string, Value> {
  const { keys, columns } = group.data.properties;
  const out: Record<string, Value> = {};
  for (let i = 0; i < keys.length; i++) {
    // A column holds values only
    const value = readValue(columns[i], row, strings) as Value | undefined;
    if (value !== undefined) setOwnProperty(out, keys[i], value);
  }
  group.values?.forEach(row, (key, written) => {
    const value = decodeOverrideValue(written);
    if (value === undefined) delete out[key];
    else setOwnProperty(out, key, value);
  });
  return out;
}

/**
 * Whether a row has a geometry
 *
 * @internal
 */
export function rowHasGeometry(group: RowGroup, row: number): boolean {
  return group.data.geometry.types[row] >= 0 || group.geometries?.geometry(row) !== undefined;
}

/**
 * The indices of the triangles of the fill of a row (the ones written in place when there are)
 *
 * @internal
 */
export function rowTriangles(group: RowGroup, row: number): Uint16Array | Uint32Array {
  const written = group.geometries?.rowTriangles(row);
  if (written) return written;
  const t = group.data.triangles;
  const start = t.offsets[row];
  const end = t.offsets[row + 1];
  if (end > start) return t.indices.subarray(start, end);
  const wide = indexOfRow(t.wideRows, row);
  if (wide < 0) return t.indices.subarray(start, start);
  return t.wideIndices.subarray(t.wideOffsets[wide], t.wideOffsets[wide + 1]);
}

/**
 * The place of a row in an ascending list of rows (-1 when it is not there)
 *
 * @internal
 */
export function indexOfRow(rows: Int32Array, row: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid] === row) return mid;
    if (rows[mid] < row) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * The GeoJSON geometry of a row with every value of its coordinates (`fullPosition`: a `z` and
 * an `m` it has), null for a row without one
 *
 * @internal
 */
export function rowGeometry(group: RowGroup, row: number): Geometry | null {
  const geometry = geometryAt(group, row);
  if (!geometry) return null;
  const { reader, at } = geometry;
  return { type: reader.type, coordinates: reader.fullCoordinatesOf(at) } as Geometry;
}

/**
 * The first coordinate of a row whose geometry is a Point (null for any other row)
 *
 * @internal
 */
export function rowPoint(group: RowGroup, row: number): Coordinate | null {
  const geometry = geometryAt(group, row);
  if (geometry?.reader.type !== 'Point') return null;
  return geometry.reader.position(geometry.at);
}

/**
 * A row as a feature (a new object every time)
 *
 * A feature holds coordinates of `x` and `y`: a row of a layer whose coordinates have a `z` or
 * an `m` is not made a feature, so that a feature written back does not lose them
 *
 * @throws when the coordinates of the layer are not `xy`
 * @internal
 */
export function rowFeature(
  context: RowReadContext,
  layerId: string,
  group: RowGroup,
  row: number,
): Feature {
  const dims = context.dimensionsOf(layerId);
  if (dims !== 'xy') {
    throw new DrawError(
      'invalid-state',
      `FeatureTables: a row of a layer of ${dims} coordinates is not a feature`,
    );
  }
  return rowFeatureToRead(context, layerId, group, row);
}

/**
 * A row as a feature to read only, its positions with every value of the dimensions of its
 * layer (a `z`, an `m`): what the drawing gives an extension that answers from a feature and the
 * renderers of the rows drawn at once, never the paths that edit (a new object every time)
 *
 * @internal
 */
export function rowFeatureToRead(
  context: RowReadContext,
  layerId: string,
  group: RowGroup,
  row: number,
): Feature {
  const data = group.data;
  const groupHandle = data.groups[row];
  const geometry = rowGeometry(group, row) ?? { type: 'Point', coordinates: [NaN, NaN] };
  return {
    id: utf8String(data.ids, row),
    type: rowType(data, row),
    geometry: geometry as Feature['geometry'],
    layerId,
    groupId: groupHandle >= 0 ? context.groups.idOf(groupHandle) : undefined,
    properties: rowProperties(group, row, context.strings),
    style: context.styles.get(data.styles[row]),
    locked: (data.flags[row] & ROW_FLAG_LOCKED) !== 0,
    visible: (data.flags[row] & ROW_FLAG_VISIBLE) !== 0,
  };
}

/**
 * A row as the builder of the row groups takes it: its values as they are read now (what was
 * written in place included), to build it again on its own
 *
 * @internal
 */
export function rowInputOf(context: RowReadContext, group: RowGroup, row: number): RowInput {
  const data = group.data;
  const flags = data.flags[row];
  const groupHandle = data.groups[row];
  return {
    id: utf8String(data.ids, row),
    type: rowType(data, row),
    geometry: rowGeometry(group, row),
    order: utf8String(data.itemKeys, row),
    member: groupHandle >= 0 ? utf8String(data.memberKeys, row) : undefined,
    group: groupHandle,
    style: context.styles.get(data.styles[row]) as Readonly<Record<string, unknown>>,
    properties: rowProperties(group, row),
    visible: (flags & ROW_FLAG_VISIBLE) !== 0,
    locked: (flags & ROW_FLAG_LOCKED) !== 0,
    deleted: (flags & ROW_FLAG_DELETED) !== 0,
  };
}
