// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows of features as rows of the Tabane format: the one place that names the columns a
 * feature is written as, their kinds, and which way a flag reads
 *
 * A row of Tabane holds its id, its place, what created it, the revisions of its cells and
 * whether it is deleted. Everything else of a feature is a column of a name:
 *
 * - `type` (`whole`): the type of the feature (`'Polygon'`, `'Circle'`, the type of an
 *   extension), a string
 * - `geometry` (`shape`): the geometry, the name of the shape its GeoJSON type and its points the
 *   coordinates, nested as deep as the type (its rings closed, as a row holds them)
 * - `hidden` (`flag`): the rows that are not shown, the opposite of `visible`
 * - `locked` (`flag`): the rows that are locked
 * - `style` (`whole`): the style, an object (`{}` for a row without one)
 * - `properties` (`keyed`): the attributes, a column per key
 *
 * The rows are read as columns (`toPage`), without an object per row; the functions here
 * that read and write a row as an object are for the rows written and for a row read alone.
 *
 * A pure module: it depends on nothing outside `/table` but its error and `@sakuzu/tabane`, so it
 * runs in a Worker as well.
 */

import type { TableColumns } from '@sakuzu/kasane';
import {
  CANONICAL_OBJECT,
  decodeCanonicalValue,
  type PropertyColumns,
  type TabaneColumnKind,
  type TabaneRevision,
  type TabaneRow,
  type TabaneRowBlock,
  type TabaneShape,
  type TabaneShapeColumn,
  type TabaneWholeColumn,
} from '@sakuzu/tabane';
import type { Geometry } from 'geojson';
import { DrawError } from '../../shared/draw-error.js';
import type { GeometryType } from '../types.js';

/**
 * The columns a feature is written as in a row of Tabane, by their names, and their kinds
 *
 * @experimental
 */
export const TABANE_FEATURE_COLUMNS: Readonly<Record<string, TabaneColumnKind>> = Object.freeze({
  type: 'whole',
  geometry: 'shape',
  hidden: 'flag',
  locked: 'flag',
  style: 'whole',
  properties: 'keyed',
});

/**
 * The columns of the rows of features as the tables hold them (`TableColumns`): those of
 * {@link TABANE_FEATURE_COLUMNS}, with where the values of each `whole` column are kept. The
 * types are few and differ from a page to another, so each page keeps its own; the
 * styles are shared by rows of every table, so the tables keep one dictionary of them
 *
 * @internal
 */
export const FEATURE_TABLE_COLUMNS: TableColumns = Object.freeze({
  ...TABANE_FEATURE_COLUMNS,
  type: Object.freeze({ kind: 'whole', dictionary: 'page' }),
  style: Object.freeze({ kind: 'whole', dictionary: 'tables' }),
});

/**
 * The columns of the groups of features as the tables hold them, besides the fixed fields of a
 * group (its id, its parent and its key): whether a group is not shown, and whether it is locked.
 * The name of a group is kept by the Store, not by the tables
 *
 * @internal
 */
export const FEATURE_GROUP_COLUMNS: TableColumns = Object.freeze({
  hidden: 'flag',
  locked: 'flag',
});

/** The kinds of the columns of a feature, by their names */
const KIND_OF: ReadonlyMap<string, TabaneColumnKind> = new Map(
  Object.entries(TABANE_FEATURE_COLUMNS),
);

/** The depth of the points of each GeoJSON geometry type, as the depth of a shape */
const GEOMETRY_DEPTH: Readonly<Record<GeometryType, 0 | 1 | 2 | 3>> = {
  Point: 0,
  LineString: 1,
  MultiPoint: 1,
  Polygon: 2,
  MultiLineString: 2,
  MultiPolygon: 3,
};

const GEOMETRY_TYPES: ReadonlySet<string> = new Set(Object.keys(GEOMETRY_DEPTH));

/** Whether a name is a GeoJSON geometry type a row holds */
function isGeometryType(name: string): name is GeometryType {
  return GEOMETRY_TYPES.has(name);
}

/**
 * A feature as a row of Tabane: its id, the members of a row, and the values of its columns
 * ({@link TABANE_FEATURE_COLUMNS})
 *
 * @experimental
 */
export interface TabaneFeatureRow {
  /** The id of the row as text (the origin, `-`, the number in base 32) */
  readonly id: string;
  /** The type of the feature (`'Polygon'`, `'Circle'`, the type of an extension) */
  readonly type: string;
  /**
   * The GeoJSON geometry of one of the six types, or null. The values of a position are those of
   * the dimensions of its layer, in their order
   */
  readonly geometry: Geometry | null;
  /** The style (`{}` when omitted) */
  readonly style?: Readonly<Record<string, unknown>>;
  /** The attributes */
  readonly properties?: Readonly<Record<string, unknown>>;
  /** Whether the row is shown (true when omitted) */
  readonly visible?: boolean;
  /** Whether the row is locked (false when omitted) */
  readonly locked?: boolean;
  /** Whether the row is deleted (kept for what refers to it) */
  readonly deleted?: boolean;
  /** What created the row (every row of a page has one, or none has) */
  readonly created?: TabaneRevision;
  /** The revision of each cell changed after the row was created, by the name of the cell */
  readonly revisions?: Readonly<Record<string, TabaneRevision>>;
}

/**
 * A feature as the row the writer of Tabane takes
 *
 * @throws `DrawError` with the code `invalid-input` when the geometry is not of one of the six
 *   GeoJSON types a row holds
 * @experimental
 */
export function tabaneRowOf(row: TabaneFeatureRow): TabaneRow {
  const geometry = row.geometry;
  let shape: TabaneShape | undefined;
  if (geometry !== null && geometry !== undefined) {
    if (!isGeometryType(geometry.type)) {
      throw new DrawError(
        'invalid-input',
        `Tabane: a ${geometry.type} geometry cannot be a row (${row.id})`,
      );
    }
    shape = {
      name: geometry.type,
      depth: GEOMETRY_DEPTH[geometry.type],
      points: (geometry as { coordinates: TabaneShape['points'] }).coordinates,
    };
  }
  return {
    id: row.id,
    ...(row.deleted === true && { deleted: true }),
    ...(row.created !== undefined && { created: row.created }),
    ...(row.revisions !== undefined && { revisions: row.revisions }),
    values: {
      type: row.type,
      ...(shape && { geometry: shape }),
      hidden: row.visible === false,
      locked: row.locked === true,
      style: row.style ?? {},
      properties: row.properties ?? {},
    },
  };
}

/**
 * A row of Tabane read back as a feature (`tabaneRowsOf` of `@sakuzu/tabane` reads the rows of a
 * page as objects)
 *
 * @throws `DrawError` with the code `invalid-input` when the row is not one of a feature: a column
 *   that is not one of {@link TABANE_FEATURE_COLUMNS}, no type, a geometry of another name or
 *   depth, or a style that is not an object
 * @experimental
 */
export function featureRowOfTabane(row: TabaneRow): TabaneFeatureRow {
  const values = row.values ?? {};
  for (const name of Object.keys(values)) {
    if (!KIND_OF.has(name)) throw unknownColumn(name);
  }
  const type = values.type;
  if (typeof type !== 'string') throw invalidRow(row.id, 'has no type');
  const shape = values.geometry as TabaneShape | undefined;
  let geometry: Geometry | null = null;
  if (shape !== undefined) {
    geometryTypeOf(shape.name, shape.depth);
    geometry = { type: shape.name, coordinates: shape.points } as Geometry;
  }
  const style = values.style ?? {};
  if (style === null || typeof style !== 'object' || Array.isArray(style))
    throw invalidRow(row.id, 'has a style that is not an object');
  return {
    id: row.id,
    type,
    geometry,
    style: style as Readonly<Record<string, unknown>>,
    properties: (values.properties ?? {}) as Readonly<Record<string, unknown>>,
    visible: values.hidden !== true,
    locked: values.locked === true,
    ...(row.deleted === true && { deleted: true }),
    ...(row.created !== undefined && { created: row.created }),
    ...(row.revisions !== undefined && { revisions: row.revisions }),
  };
}

function invalidRow(id: string, what: string): DrawError {
  return new DrawError('invalid-input', `Tabane: the row ${id} ${what}`);
}

function unknownColumn(name: string): DrawError {
  return new DrawError('invalid-input', `Tabane: a column that is not one of a feature: ${name}`);
}

/**
 * The GeoJSON type of a shape of a name and a depth
 *
 * @throws `DrawError` with the code `invalid-input` when the name is not a GeoJSON type a row
 *   holds, or the depth not its depth
 */
export function geometryTypeOf(name: string, depth: number): GeometryType {
  if (!isGeometryType(name) || GEOMETRY_DEPTH[name] !== depth) {
    throw new DrawError('invalid-input', `Tabane: a shape ${name} of the depth ${depth}`);
  }
  return name;
}

/**
 * The columns of a feature of a page read, by their names: null for a column the page
 * does not hold (no row holds a value of it)
 *
 * @internal
 */
export interface FeatureColumns {
  readonly type: TabaneWholeColumn | null;
  readonly geometry: TabaneShapeColumn | null;
  /** The bits of the rows not shown */
  readonly hidden: Uint8Array | null;
  /** The bits of the locked rows */
  readonly locked: Uint8Array | null;
  readonly style: TabaneWholeColumn | null;
  readonly properties: PropertyColumns;
}

/**
 * The columns of a feature of a page, each checked to be of its kind
 *
 * @throws `DrawError` with the code `invalid-input` when the page holds a column that is not
 *   one of {@link TABANE_FEATURE_COLUMNS}, or one of another kind
 * @internal
 */
export function featureColumnsOf(rowBlock: TabaneRowBlock): FeatureColumns {
  let type: TabaneWholeColumn | null = null;
  let geometry: TabaneShapeColumn | null = null;
  let hidden: Uint8Array | null = null;
  let locked: Uint8Array | null = null;
  let style: TabaneWholeColumn | null = null;
  let properties: PropertyColumns = { keys: [], columns: [] };
  for (const column of rowBlock.columns) {
    const kind = KIND_OF.get(column.name);
    if (kind === undefined) throw unknownColumn(column.name);
    if (kind !== column.kind) {
      throw new DrawError(
        'invalid-input',
        `Tabane: the column ${column.name} is of the kind ${column.kind}, not ${kind}`,
      );
    }
    switch (column.kind) {
      case 'shape':
        geometry = column;
        break;
      case 'flag':
        if (column.name === 'hidden') hidden = column.bits;
        else locked = column.bits;
        break;
      case 'whole':
        if (column.name === 'type') type = column;
        else style = column;
        break;
      case 'keyed':
        properties = { keys: column.keys, columns: column.columns };
        break;
    }
  }
  return { type, geometry, hidden, locked, style, properties };
}

/**
 * The names of the types of a column of types, and the type of each row as an index into them
 *
 * @throws `DrawError` with the code `invalid-input` when a row has no type, or a type that is not a
 *   string
 * @internal
 */
export function typesOf(
  column: TabaneWholeColumn | null,
  rows: number,
): { typeNames: string[]; types: Uint8Array } {
  if (column === null) throw new DrawError('invalid-input', 'Tabane: rows without a type');
  const { offsets, bytes } = column.values;
  const typeNames: string[] = [];
  for (let k = 0; k + 1 < offsets.length; k++) {
    const name = decodeCanonicalValue(bytes, offsets[k], offsets[k + 1]);
    if (typeof name !== 'string')
      throw new DrawError('invalid-input', 'Tabane: a type not a string');
    typeNames.push(name);
  }
  if (typeNames.length > 256) throw new DrawError('invalid-input', 'Tabane: more than 256 types');
  const types = new Uint8Array(rows);
  for (let r = 0; r < rows; r++) {
    const t = column.valueIndex[r];
    if (t < 0) throw new DrawError('invalid-input', 'Tabane: a row without a type');
    types[r] = t;
  }
  return { typeNames, types };
}

/** The canonical bytes of the empty object, the style of a row without one */
const EMPTY_STYLE = Uint8Array.of(CANONICAL_OBJECT, 0);

/**
 * The styles of a column of styles, as their canonical bytes, and the style of each row as an
 * index into them (a row without one has `{}`)
 *
 * @throws `DrawError` with the code `invalid-input` when a style is not an object
 * @internal
 */
export function stylesOf(
  column: TabaneWholeColumn | null,
  rows: number,
): { styleDictionary: { offsets: Int32Array; bytes: Uint8Array }; styles: Uint32Array } {
  const styles = new Uint32Array(rows);
  if (column === null) {
    return {
      styleDictionary: { offsets: Int32Array.of(0, EMPTY_STYLE.length), bytes: EMPTY_STYLE },
      styles,
    };
  }
  const { offsets, bytes } = column.values;
  const count = offsets.length - 1;
  let empty = -1;
  for (let k = 0; k < count; k++) {
    if (bytes[offsets[k]] !== CANONICAL_OBJECT)
      throw new DrawError('invalid-input', 'Tabane: a style that is not an object');
    if (
      empty < 0 &&
      offsets[k + 1] - offsets[k] === EMPTY_STYLE.length &&
      bytes[offsets[k] + 1] === EMPTY_STYLE[1]
    )
      empty = k;
  }
  let missing = false;
  for (let r = 0; r < rows; r++) {
    const s = column.valueIndex[r];
    if (s >= 0) styles[r] = s;
    else missing = true;
  }
  if (!missing) return { styleDictionary: column.values, styles };
  // The rows without a style have `{}`, added once when no row holds it
  let dictionary = column.values;
  if (empty < 0) {
    empty = count;
    const grown = new Uint8Array(bytes.length + EMPTY_STYLE.length);
    grown.set(bytes);
    grown.set(EMPTY_STYLE, bytes.length);
    const grownOffsets = new Int32Array(count + 2);
    grownOffsets.set(offsets);
    grownOffsets[count + 1] = grown.length;
    dictionary = { offsets: grownOffsets, bytes: grown };
  }
  for (let r = 0; r < rows; r++) if (column.valueIndex[r] < 0) styles[r] = empty;
  return { styleDictionary: dictionary, styles };
}
