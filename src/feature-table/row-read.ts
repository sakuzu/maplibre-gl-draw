// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reading the values of a row held as columns
 *
 * A row becomes a feature only when one is asked for (a hit, the features drawn at once, a
 * reader that needs one); the drawing and the hit testing read its columns as they are.
 */

import type { Geometry } from 'geojson';
import type { Coordinate, Feature, FeatureType } from '../shared/types/model.js';
import { ROW_FLAG_LOCKED, ROW_FLAG_VISIBLE, type RowGroupData } from '../table/row-group-types.js';
import { utf8String } from '../table/utf8-column.js';
import { readNumberValue, readValue, type ValueStringCache } from '../table/value-column.js';
import type { GroupTable } from './group-table.js';
import { geometryReaderOf, type RowGroup } from './layer-table.js';
import type { StyleTable } from './style-table.js';

/**
 * What reading a row needs besides the row
 *
 * @internal
 */
export interface RowReadContext {
  readonly styles: StyleTable;
  readonly groups: GroupTable;
  readonly strings: ValueStringCache;
}

/**
 * The type of a row
 *
 * @internal
 */
export function rowType(data: RowGroupData, row: number): FeatureType {
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
): Record<string, unknown> {
  const { keys, columns } = group.data.properties;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < keys.length; i++) {
    const value = readValue(columns[i], row, strings);
    if (value !== undefined) out[keys[i]] = value;
  }
  return out;
}

/**
 * The GeoJSON geometry of a row (null for a row without one)
 *
 * @internal
 */
export function rowGeometry(group: RowGroup, row: number): Geometry | null {
  const reader = geometryReaderOf(group, row);
  if (!reader) return null;
  const at = group.data.geometry.offsets[row];
  return { type: reader.type, coordinates: reader.coordinatesOf(at) } as Geometry;
}

/**
 * The first coordinate of a row whose geometry is a Point (null for any other row)
 *
 * @internal
 */
export function rowPoint(group: RowGroup, row: number): Coordinate | null {
  const reader = geometryReaderOf(group, row);
  if (reader?.type !== 'Point') return null;
  return reader.position(group.data.geometry.offsets[row]);
}

/**
 * A row as a feature (a new object every time)
 *
 * @internal
 */
export function rowFeature(
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
