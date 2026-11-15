// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `FeatureRow`: one feature read without making it, from a row held as columns where it is, or
 * from a feature there is already
 *
 * A row is read where it is written: its ID, its type, its place, its flags and its values come
 * from its columns, and its feature is made only by `toFeature`. One reader is moved from row to
 * row (`at`), so a read of many rows makes no object for each.
 */

import {
  type FeatureTablesInternals,
  featureTablesInternals,
} from '../../feature-table/feature-tables.js';
import { builtInGeometryKind } from '../../shared/utils/coordinates.js';
import { ROW_FLAG_HIDDEN, ROW_FLAG_LOCKED } from '../../table/feature-row-columns.js';
import { DrawError } from '../errors.js';
import type { Feature, FeatureRow, FeatureType } from '../model.js';
import type { FeatureTables, LayerTableView, RowRef } from '../tables.js';
import { FIELD_KEYS, readFeatureFields } from './feature-shape.js';

/**
 * A row read from a feature: its fields read from the feature itself
 *
 * @param bboxOf - The extent of the feature, read only when it is asked for
 * @internal
 */
export function featureRowOf(
  feature: Feature,
  bboxOf: (feature: Feature) => [number, number, number, number] | null,
): FeatureRow {
  const fields = readFeatureFields(feature);
  let bbox: [number, number, number, number] | null | undefined;
  return {
    id: feature.id,
    featureType: fields.featureType,
    layerId: fields.layerId ?? '',
    groupId: fields.groupId,
    visible: fields.visible,
    locked: fields.locked,
    get bbox() {
      bbox ??= bboxOf(feature);
      return bbox;
    },
    property: (key) => (feature.properties as Record<PropertyKey, unknown>)[key] as never,
    toFeature: () => feature,
  };
}

/**
 * A reader of the rows of tables, moved from row to row: what it reads is read from the row it is
 * at, where the row is written
 *
 * @internal
 */
export interface RowReader extends FeatureRow {
  /**
   * Moves the reader to a row
   *
   * @param view - The rows of its layer (the layer the row is in, found once asked, when left out)
   * @returns The reader
   */
  at(row: RowRef, view?: LayerTableView): RowReader;
}

/**
 * Creates a reader of the rows of tables
 *
 * @param toFeature - Makes the feature of a row (once it is asked for)
 * @internal
 */
export function createRowReader(
  tables: FeatureTables,
  toFeature: (row: RowRef, view: LayerTableView, id: string) => Feature | undefined,
): RowReader {
  const internals: FeatureTablesInternals | undefined = featureTablesInternals(tables);
  let handle = -1;
  let rows: LayerTableView | undefined;
  /** The flags of the row, read where it is */
  const flags = (): number => {
    const place = internals?.placeOf(handle);
    return place ? place.group.data.flags[place.row] : 0;
  };
  const view = (): LayerTableView => {
    if (!rows) {
      const layerId = internals?.placeOf(handle)?.table.tableId;
      rows = layerId === undefined ? undefined : tables.get(layerId);
    }
    if (!rows) throw new DrawError('notFound', 'The row is gone');
    return rows;
  };
  const reader: RowReader = {
    at(row, layer) {
      handle = row;
      rows = layer;
      return reader;
    },
    get id() {
      return tables.getRowId(handle) as string;
    },
    get featureType() {
      return view().getRowType(handle) as FeatureType;
    },
    get layerId() {
      return view().layerId;
    },
    get groupId() {
      const place = internals?.placeOf(handle);
      const group = place ? place.group.data.groups[place.row] : -1;
      return group >= 0 ? (tables.getGroupId(group) ?? null) : null;
    },
    get visible() {
      return (flags() & ROW_FLAG_HIDDEN) === 0;
    },
    get locked() {
      return (flags() & ROW_FLAG_LOCKED) !== 0;
    },
    get bbox() {
      return view().getRowBBox(handle) as [number, number, number, number] | null;
    },
    property(key) {
      // A key of the library that holds a field of the row is read from the field, as the feature
      // of the row holds it (no key for a value that is the default); every other key from the
      // values of the row
      switch (key) {
        case FIELD_KEYS.layerId:
          return reader.layerId as never;
        case FIELD_KEYS.groupId:
          return (reader.groupId ?? undefined) as never;
        case FIELD_KEYS.featureType: {
          const type = reader.featureType;
          // A built-in type of a GeoJSON geometry is the type of the geometry
          return (builtInGeometryKind(type) === type ? undefined : type) as never;
        }
        case FIELD_KEYS.style: {
          const style = view().getRowStyle(handle);
          return (style && Object.keys(style).length > 0 ? style : undefined) as never;
        }
        case FIELD_KEYS.visible:
          return (reader.visible ? undefined : false) as never;
        case FIELD_KEYS.locked:
          return (reader.locked ? true : undefined) as never;
        default:
          return view().getRowValue(handle, String(key)) as never;
      }
    },
    toFeature() {
      const id = tables.getRowId(handle);
      const feature = id === undefined ? undefined : toFeature(handle, view(), id);
      if (!feature) throw new DrawError('notFound', 'The row is gone');
      return feature;
    },
  };
  return reader;
}
