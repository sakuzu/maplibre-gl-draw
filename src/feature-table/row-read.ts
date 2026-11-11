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

import type { RowRead } from '@sakuzu/kasane';
import type { RowReadContext as TablesReadContext } from '@sakuzu/kasane/engine';
import {
  geometryAt,
  ROW_FLAG_DELETED,
  type RowBlockData,
  type RowBlockDictionary,
  type RowBlockValues,
  type RowGroup,
  rowCacheNumbers,
  rowProperties,
  groupRowRead as tablesRowRead,
} from '@sakuzu/kasane/engine';
import { utf8String } from '@sakuzu/tabane';
import type { Geometry } from 'geojson';
import { DrawError } from '../shared/draw-error.js';
import type { Coordinate, Feature, FeatureStyle, FeatureType } from '../shared/types/model.js';
import type { FeatureRowInput } from '../table/feature-row-blocks.js';
import {
  GEOMETRY_COLUMN,
  ROW_FLAG_HIDDEN,
  ROW_FLAG_LOCKED,
  STYLE_COLUMN,
  TYPE_COLUMN,
} from '../table/feature-row-columns.js';
import { FILL_TRIANGLES_AT } from '../table/fill-triangles.js';

export { rowCacheNumbers, rowNumber, rowProperties, rowValue } from '@sakuzu/kasane/engine';

/** The places of the columns of a feature, read once rather than through the import at every row */
const STYLE = STYLE_COLUMN;
const TYPE = TYPE_COLUMN;
const GEOMETRY = GEOMETRY_COLUMN;

/**
 * What reading a row needs besides the row: that of the tables, whose values they keep are the
 * styles
 *
 * @internal
 */
export type RowReadContext = TablesReadContext<FeatureStyle>;

/**
 * The type of a row
 *
 * @internal
 */
export function rowType(data: RowBlockData, row: number): FeatureType {
  const column = data.wholes[TYPE] as RowBlockValues;
  return column.values[column.indexes[row]] as FeatureType;
}

/**
 * A row of a group as what the user of the tables gives reads it (`RowRead`): its values as they
 * are read now, what was written in place included
 *
 * @internal
 */
export function groupRowRead(group: RowGroup, row: number): RowRead {
  return tablesRowRead(group, row, TYPE);
}

/**
 * Whether a row has a geometry
 *
 * @internal
 */
export function rowHasGeometry(group: RowGroup, row: number): boolean {
  const geometry = group.data.shapes[GEOMETRY];
  return (
    (geometry !== null && geometry.types[row] >= 0) || group.geometries?.geometry(row) !== undefined
  );
}

/**
 * The indices of the triangles of the fill of a row (the ones written in place when there are)
 *
 * @internal
 */
export function rowTriangles(group: RowGroup, row: number): Uint16Array | Uint32Array {
  return rowCacheNumbers(group, row, FILL_TRIANGLES_AT);
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
    style: context.styles.get((data.wholes[STYLE] as RowBlockDictionary).indexes[row]),
    locked: (data.flags[row] & ROW_FLAG_LOCKED) !== 0,
    visible: (data.flags[row] & ROW_FLAG_HIDDEN) === 0,
  };
}

/**
 * A row as the builder of the row groups takes it: its values as they are read now (what was
 * written in place included), to build it again on its own
 *
 * @internal
 */
export function rowInputOf(
  context: TablesReadContext,
  group: RowGroup,
  row: number,
): FeatureRowInput {
  const data = group.data;
  const flags = data.flags[row];
  const groupHandle = data.groups[row];
  return {
    id: utf8String(data.ids, row),
    type: rowType(data, row),
    geometry: rowGeometry(group, row),
    key: utf8String(data.keys, row),
    group: groupHandle,
    style: context.styles.get((data.wholes[STYLE] as RowBlockDictionary).indexes[row]) as Readonly<
      Record<string, unknown>
    >,
    properties: rowProperties(group, row),
    hidden: (flags & ROW_FLAG_HIDDEN) !== 0,
    locked: (flags & ROW_FLAG_LOCKED) !== 0,
    deleted: (flags & ROW_FLAG_DELETED) !== 0,
  };
}
