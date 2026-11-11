// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reading the values of a row of a row group, as the tables hold it
 *
 * Every read looks first at what was written of the row in place since its group was built
 * (`value-overrides.ts`), then at the columns. A row is read back as the builder takes it
 * (`rowInputOfGroup`) when it is built again on its own: a row of the delta made again, a row
 * moved, a row of a next version.
 */

import {
  type PropertyColumns,
  readNumberValue,
  readValue,
  setOwnProperty,
  utf8String,
  VALUE_NUMBER,
  type Value,
  type ValueStringCache,
} from '@sakuzu/tabane';
import { cacheNumbersOf, noCacheNumbers, type RowCacheNumbers } from '../table/row-caches.js';
import type { RowColumnLayout } from '../table/row-columns.js';
import type { RowInput } from '../table/row-group-builder.js';
import {
  ROW_FLAG_DELETED,
  type RowBlockData,
  type RowBlockDictionary,
  type RowBlockValues,
} from '../table/row-group-types.js';
import type { RowRead, RowShape } from '../table/row-read-type.js';
import type { ShapeDepth } from '../table/row-shape.js';
import { geometryAt, KEYED_COLUMN, type RowGroup } from './row-table.js';
import type { StyleTable } from './style-table.js';
import { decodeOverrideValue } from './value-overrides.js';

/** The keys of a row block none of whose rows holds a key of the keyed column */
const NO_KEYS: PropertyColumns = Object.freeze({
  keys: Object.freeze([]),
  columns: Object.freeze([]),
});

/**
 * The value of a `whole` column a row block keeps, of a row
 *
 * @param place The place of the column in `RowBlockData.wholes`
 * @internal
 */
export function rowWholeValue(data: RowBlockData, row: number, place: number): unknown {
  const column = data.wholes[place] as RowBlockValues;
  return column.values[column.indexes[row]];
}

/**
 * The value of a key of the `keyed` column of a row (undefined when the row does not hold the
 * key)
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
  return readValue(
    (group.data.keyed[KEYED_COLUMN] as PropertyColumns).columns[column],
    row,
    strings,
  );
}

/**
 * The value of a key of the `keyed` column of a row when it is a number
 *
 * @internal
 */
export function rowNumber(group: RowGroup, row: number, key: string): number | undefined {
  const written = group.values?.get(row, key);
  if (written) return written.tag === VALUE_NUMBER ? written.number : undefined;
  const column = group.propertyIndex.get(key);
  if (column === undefined) return undefined;
  return readNumberValue((group.data.keyed[KEYED_COLUMN] as PropertyColumns).columns[column], row);
}

/**
 * Every key of the `keyed` column of a row, with its value
 *
 * @internal
 */
export function rowProperties(
  group: RowGroup,
  row: number,
  strings?: ValueStringCache,
): Record<string, Value> {
  const keyed = group.data.keyed[KEYED_COLUMN];
  if (!keyed && !group.values) return {};
  const { keys, columns } = keyed ?? NO_KEYS;
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
 * The numbers of a cache of a row (the ones written in place when there are; none for a row of
 * tables without the cache)
 *
 * @param cache The place of the cache in the caches of the tables
 * @internal
 */
export function rowCacheNumbers(group: RowGroup, row: number, cache: number): RowCacheNumbers {
  const written = group.geometries?.cacheNumbers(cache, row);
  if (written) return written;
  const column = group.data.caches[cache];
  return column ? cacheNumbersOf(column, row) : noCacheNumbers();
}

/**
 * A row of a group as what the user of the tables gives reads it (`RowRead`): its values as they
 * are read now, what was written in place included
 *
 * @param typeAt The place in `RowBlockData.wholes` of the column of the type of the rows (`type`;
 *   -1 for none: the type is the empty string)
 * @internal
 */
export function groupRowRead(group: RowGroup, row: number, typeAt: number): RowRead {
  return {
    handle: group.data.handles[row],
    type: typeAt < 0 ? '' : (rowWholeValue(group.data, row, typeAt) as string),
    value: (key) => rowValue(group, row, key),
    shape: (): RowShape | null => {
      const geometry = geometryAt(group, row);
      return geometry ? { column: geometry.reader, at: geometry.at } : null;
    },
  };
}

/**
 * The columns of the rows as a row is read back as the builder takes it: the names of the columns
 * of each kind, and where a row block holds them
 *
 * @internal
 */
export interface RowInputColumns {
  /** The name of the `shape` column (null for none) */
  readonly shape: string | null;
  /** The `whole` columns: their names, and whether the tables keep their values (`'tables'`) */
  readonly wholes: ReadonlyArray<{ readonly name: string; readonly kept: boolean }>;
  /** The name of the `keyed` column (null for none) */
  readonly keyed: string | null;
  /** The `flag` columns: their names and their bits in `RowBlockData.flags` */
  readonly flags: ReadonlyArray<{ readonly name: string; readonly bit: number }>;
}

/**
 * The columns of the rows as a row is read back, from the layout of the columns declared
 *
 * @internal
 */
export function rowInputColumnsOf(layout: RowColumnLayout): RowInputColumns {
  return {
    shape: layout.shapes[0] ?? null,
    wholes: layout.wholes.map((name, w) => ({
      name,
      kept: layout.dictionaries[w] === 'tables',
    })),
    keyed: layout.keyed[0] ?? null,
    flags: layout.flags.map((name, f) => ({ name, bit: ROW_FLAG_DELETED << (f + 1) })),
  };
}

/**
 * A row as the builder of the row groups takes it: its values as they are read now (what was
 * written in place included), to build it again on its own
 *
 * @param columns The columns of the rows (`rowInputColumnsOf`)
 * @param kept The values of the `whole` column the tables keep, numbered
 * @internal
 */
export function rowInputOfGroup(
  columns: RowInputColumns,
  kept: StyleTable,
  group: RowGroup,
  row: number,
): RowInput {
  const data = group.data;
  const flags = data.flags[row];
  const values: Record<string, unknown> = {};
  if (columns.shape !== null) {
    const geometry = geometryAt(group, row);
    values[columns.shape] = geometry
      ? {
          name: geometry.reader.type,
          depth: geometry.reader.depth as ShapeDepth,
          points: geometry.reader.fullCoordinatesOf(geometry.at),
        }
      : null;
  }
  for (let w = 0; w < columns.wholes.length; w++) {
    const whole = columns.wholes[w];
    values[whole.name] = whole.kept
      ? kept.get((data.wholes[w] as RowBlockDictionary).indexes[row])
      : rowWholeValue(data, row, w);
  }
  if (columns.keyed !== null) values[columns.keyed] = rowProperties(group, row);
  for (const flag of columns.flags) values[flag.name] = (flags & flag.bit) !== 0;
  return {
    id: utf8String(data.ids, row),
    key: utf8String(data.keys, row),
    group: data.groups[row],
    values,
    deleted: (flags & ROW_FLAG_DELETED) !== 0,
  };
}
