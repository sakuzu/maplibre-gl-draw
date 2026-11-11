// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The places of the columns of a feature in a row block, read once from the declaration of the
 * library (`FEATURE_TABLE_COLUMNS`)
 *
 * A row block holds its columns by kind, in the order they are declared (`rowColumnLayoutOf`).
 * What the library reads of a row (the drawing, the hit testing, the walks, the reads of a
 * feature) reads its columns at these places, never by a name: the geometry is a `shape` column,
 * the type and the style are `whole` columns (the types kept by each row block, the styles by the
 * tables, as their numbers), the attributes a `keyed` column, and `hidden` and `locked` bits of the
 * flags of a row, as they are of the flags of a group.
 *
 * A pure module, so it runs in a Worker as well.
 */

import type {
  GroupTable,
  RowBlockData,
  RowBlockDictionary,
  RowBlockValues,
} from '@sakuzu/kasane/engine';
import {
  flagBitOf,
  groupFlagBitOf,
  keyedColumnOf,
  type RowColumnLayout,
  rowColumnLayoutOf,
  shapeColumnOf,
  wholeColumnOf,
} from '@sakuzu/kasane/engine';
import type { PropertyColumns } from '@sakuzu/tabane';
import { FEATURE_GROUP_COLUMNS, FEATURE_TABLE_COLUMNS } from './tabane/columns.js';

/**
 * The places of the columns of a feature
 *
 * @internal
 */
export const FEATURE_COLUMN_LAYOUT: RowColumnLayout = rowColumnLayoutOf(FEATURE_TABLE_COLUMNS);

/** The place of the geometry in `RowBlockData.shapes` @internal */
export const GEOMETRY_COLUMN = shapeColumnOf(FEATURE_COLUMN_LAYOUT, 'geometry');
/** The place of the type in `RowBlockData.wholes` @internal */
export const TYPE_COLUMN = wholeColumnOf(FEATURE_COLUMN_LAYOUT, 'type');
/** The place of the style in `RowBlockData.wholes` @internal */
export const STYLE_COLUMN = wholeColumnOf(FEATURE_COLUMN_LAYOUT, 'style');
/**
 * The start of the fields of the attributes of a row (`properties:<key>`)
 *
 * @internal
 */
export const PROPERTY_FIELD = 'properties:';
/** The place of the attributes in `RowBlockData.keyed` @internal */
export const PROPERTIES_COLUMN = keyedColumnOf(FEATURE_COLUMN_LAYOUT, 'properties');
/** The bit of {@link RowBlockData.flags} of a row that is not shown @internal */
export const ROW_FLAG_HIDDEN = flagBitOf(FEATURE_COLUMN_LAYOUT, 'hidden');
/** The bit of {@link RowBlockData.flags} of a row that is locked @internal */
export const ROW_FLAG_LOCKED = flagBitOf(FEATURE_COLUMN_LAYOUT, 'locked');

/**
 * The places of the columns of a group of features
 *
 * @internal
 */
export const FEATURE_GROUP_LAYOUT: RowColumnLayout = rowColumnLayoutOf(FEATURE_GROUP_COLUMNS);

/** The bit of the flags of a group (`GroupTable.flagsOf`) that is not shown @internal */
export const GROUP_FLAG_HIDDEN = groupFlagBitOf(FEATURE_GROUP_LAYOUT, 'hidden');
/** The bit of the flags of a group (`GroupTable.flagsOf`) that is locked @internal */
export const GROUP_FLAG_LOCKED = groupFlagBitOf(FEATURE_GROUP_LAYOUT, 'locked');

/**
 * Whether a group of features is not shown (false for an unknown handle)
 *
 * @internal
 */
export function isGroupHidden(groups: GroupTable, group: number): boolean {
  return (groups.flagsOf(group) & GROUP_FLAG_HIDDEN) !== 0;
}

/**
 * Whether a group of features is locked (false for an unknown handle)
 *
 * @internal
 */
export function isGroupLocked(groups: GroupTable, group: number): boolean {
  return (groups.flagsOf(group) & GROUP_FLAG_LOCKED) !== 0;
}

/** The attributes of a row block none of whose rows holds one (shared, never changed) */
const NO_PROPERTIES: PropertyColumns = Object.freeze({
  keys: Object.freeze([]),
  columns: Object.freeze([]),
});

/**
 * The geometry of the rows of a row block (null when no row has one)
 *
 * @internal
 */
export function geometryColumnOf(data: RowBlockData): RowBlockData['shapes'][number] {
  return data.shapes[GEOMETRY_COLUMN];
}

/**
 * The types of the rows of a row block (every row of a feature has one)
 *
 * @internal
 */
export function typeColumnOf(data: RowBlockData): RowBlockValues {
  return data.wholes[TYPE_COLUMN] as RowBlockValues;
}

/**
 * The styles of the rows of a row block (every row of a feature has one, `{}` when it was given
 * none)
 *
 * @internal
 */
export function styleColumnOf(data: RowBlockData): RowBlockDictionary {
  return data.wholes[STYLE_COLUMN] as RowBlockDictionary;
}

/**
 * The attributes of the rows of a row block, a column per key (none when no row holds one)
 *
 * @internal
 */
export function propertyColumnsOf(data: RowBlockData): PropertyColumns {
  return data.keyed[PROPERTIES_COLUMN] ?? NO_PROPERTIES;
}

/**
 * The type of a row of a row block
 *
 * @internal
 */
export function typeOfRow(data: RowBlockData, row: number): string {
  const column = data.wholes[TYPE_COLUMN] as RowBlockValues;
  return column.values[column.indexes[row]] as string;
}

/**
 * The number of the style of a row of a row block (in the table of the styles of the tables once
 * they have taken the row block in)
 *
 * @internal
 */
export function styleOfRow(data: RowBlockData, row: number): number {
  return (data.wholes[STYLE_COLUMN] as RowBlockDictionary).indexes[row];
}
