// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The builder and the merge of the pages of the features (`createFeaturePageBuilder`,
 * `mergeFeaturePages`): those of the tables, with what the library declares of its features
 *
 * What the library declares of its features for the builder and the merge of the tables
 * (`row-group-builder.ts`, `row-group-merge.ts`) is given here: the rings of the Circles as the
 * rings of the rows when none are given (`circleRowRings`; the tables have none of their own),
 * the triangles of the fills as a cache of the rows (`FEATURE_CACHES`), and what they throw for
 * the rows as a `DrawError`, as every error of the library. A Worker of
 * the host imports these: a function cannot be sent to it, so what the library declares is held
 * here, where the Worker runs them.
 *
 * The rings given to the builder here are read from the type, the point and the attributes of a
 * row (`PointRowRings`), and given to the builder of the tables as rings that read a row. A
 * feature added is given to the builder of the tables as the values of its columns, its GeoJSON
 * geometry as a shape of Tabane (`rowInputOfFeature`).
 */

import type {
  Page,
  PageBuilderOptions as TablesPageBuilderOptions,
  PageMerge as TablesPageMerge,
  TablesWorker,
} from '@sakuzu/kasane';
import { createPageBuilder, KasaneError, mergePages, type RowInput } from '@sakuzu/kasane';
import { rowRingsOfPoint } from '@sakuzu/kasane/render';
import type { TabaneShape } from '@sakuzu/tabane';
import type { Geometry } from 'geojson';
import { circleRowRings } from './circle-rings.js';
import { drawErrorOf } from './draw-error-of.js';
import { FEATURE_CACHES } from './fill-triangles.js';
import { GEOMETRY_DEPTHS } from './row-geometry.js';
import { FEATURE_TABLE_COLUMNS } from './tabane/columns.js';
import {
  groupsOfTables,
  type PageBuilderOptions,
  type PageMerge,
  tablesBuilderOptionsOf,
  tablesMergeOf,
} from './tables-values.js';

/**
 * One row given to the builder
 */
export interface FeatureRowInput {
  /** The id of the row (unique in the document) */
  readonly id: string;
  /** The type of the feature (`'Point'`, `'Circle'`, the type of an extension) */
  readonly type: string;
  /**
   * The GeoJSON geometry (a Circle and an Image give the Point of their center, a Freehand a
   * LineString), or null for a row without one
   */
  readonly geometry: Geometry | null;
  /**
   * The key of the order of the row: among the members of its group when it is in
   * one, among the items of its table otherwise
   */
  readonly key: string;
  /**
   * The reference of the group of the row (`GroupEntry.group`; outside a group when
   * omitted or negative)
   */
  readonly group?: number;
  /** The style of the row */
  readonly style?: Readonly<Record<string, unknown>>;
  /** The attributes of the row */
  readonly properties?: Readonly<Record<string, unknown>>;
  /** Whether the row is hidden (false when omitted) */
  readonly hidden?: boolean;
  /** Whether the row is locked (false when omitted) */
  readonly locked?: boolean;
  /** Whether the row is deleted (false when omitted) */
  readonly deleted?: boolean;
}

/**
 * Builds the pages of one layer
 */
export interface FeaturePageBuilder {
  /** The number of rows added */
  readonly length: number;
  /**
   * Adds a row
   *
   * @throws an error with the code `invalidInput` when the id was already added, when the
   *   geometry is not a GeoJSON geometry of one of the six types, or when a value of the style or
   *   the attributes cannot be held (a number that is not finite, a function)
   */
  addRow(row: FeatureRowInput): void;
  /**
   * Puts the rows in the order of the table and cuts them into pages
   *
   * @throws an error with the code `notFound` when a row names a group the options do not give
   */
  finish(): Page[];
}

/**
 * The work the tables hand to a Worker of the host: the functions of the
 * `@sakuzu/maplibre-gl-draw/table` subpath, run there on copies of the columns.
 *
 * What is handed over can be posted as it is: it holds no function. The Worker gives the
 * system of the coordinates to the builder when the tables are given one
 * (`TablesOptions.coordinateSystem`); the builder of the entry draws the rings the
 * tables draw.
 *
 * @example A Worker of the host
 * ```ts
 * // in the Worker
 * import {
 *   createPageBuilder,
 *   mergePages,
 *   transferList,
 * } from '@sakuzu/maplibre-gl-draw/kasane';
 * self.onmessage = ({ data }) => {
 *   const blocks = data.merge
 *     ? mergePages(data.merge)
 *     : build(data.rows, data.options); // createPageBuilder, addRow, finish
 *   self.postMessage({ id: data.id, blocks }, transferList(blocks));
 * };
 * ```
 */
export interface FeatureTablesWorker {
  /** Merges rows of blocks (`mergePages`): the next version of blocks */
  merge(merge: PageMerge): Promise<Page[]>;
  /** Builds rows into blocks (`createPageBuilder`): many new rows written at once */
  build(rows: readonly FeatureRowInput[], options: PageBuilderOptions): Promise<Page[]>;
}

/**
 * The Worker of the host as the tables hand it their work: the rows it builds are given to it as
 * features (`featureRowInputOf`)
 *
 * @internal
 */
export function tablesWorkerOf(worker: FeatureTablesWorker): TablesWorker {
  return {
    merge: (merge) => worker.merge(mergeOfTables(merge)),
    build: (rows, options) =>
      worker.build(rows.map(featureRowInputOf), builderOptionsOfTables(options)),
  };
}

/** A merge of the tables as the Worker of the host takes it: the groups named by their references */
function mergeOfTables(merge: TablesPageMerge): PageMerge {
  const { groups, ...rest } = merge;
  return groups ? { ...rest, groups: groupsOfTables(groups) } : rest;
}

/** Options of the builder of the tables as the Worker of the host takes them */
function builderOptionsOfTables(options: TablesPageBuilderOptions): PageBuilderOptions {
  const { groups, ...rest } = options;
  return groups ? { ...rest, groups: groupsOfTables(groups) } : rest;
}

/**
 * A row the tables give the builder, as a feature given to it (`rowInputOfFeature` read back)
 *
 * @internal
 */
export function featureRowInputOf(row: RowInput): FeatureRowInput {
  const { values } = row;
  const shape = values.geometry as TabaneShape | null | undefined;
  return {
    id: row.id,
    type: values.type as string,
    geometry: shape ? ({ type: shape.name, coordinates: shape.points } as Geometry) : null,
    key: row.key,
    ...(row.group === undefined ? {} : { group: row.group }),
    style: values.style as Readonly<Record<string, unknown>> | undefined,
    properties: values.properties as Readonly<Record<string, unknown>> | undefined,
    hidden: values.hidden === true,
    locked: values.locked === true,
    deleted: row.deleted === true,
  };
}

/** The depth of the shape of each GeoJSON geometry type a row holds */
const DEPTH_OF_TYPE: ReadonlyMap<string, number> = new Map(Object.entries(GEOMETRY_DEPTHS));

/**
 * A value of the geometry of a feature as the tables take it: a GeoJSON geometry as a shape of
 * Tabane, the name of its form its type (a type that is not one of the six has no depth of a
 * shape, so the tables refuse it); anything else as it is, for the tables to refuse
 *
 * @internal
 */
export function shapeOfGeometry(geometry: unknown): unknown {
  if (typeof geometry !== 'object' || geometry === null || !('type' in geometry)) return geometry;
  const { type, coordinates } = geometry as { type: unknown; coordinates?: unknown };
  const name = String(type);
  const depth = DEPTH_OF_TYPE.get(name) ?? -1;
  return { name, depth, points: coordinates } as unknown as TabaneShape;
}

/**
 * A feature given to the builder as the row the builder of the tables takes: its values by the
 * names of the columns of the features
 *
 * @internal
 */
export function rowInputOfFeature(row: FeatureRowInput): RowInput {
  return {
    id: row.id,
    key: row.key,
    ...(row.group === undefined ? {} : { group: row.group }),
    values: {
      type: row.type,
      geometry: row.geometry === null ? null : shapeOfGeometry(row.geometry),
      style: row.style,
      properties: row.properties,
      hidden: row.hidden,
      locked: row.locked,
    },
    ...(row.deleted === undefined ? {} : { deleted: row.deleted }),
  };
}

/**
 * The options of {@link createFeaturePageBuilder}: those of the builder of the tables, whose
 * rings are the rings of the Circles when omitted
 *
 * @internal
 */
export type FeaturePageBuilderOptions = PageBuilderOptions;

/**
 * An error of the tables (`KasaneError`) as a `DrawError`; what a function given in the options
 * threw (the system of coordinates, the rings) as it is
 */
function rowsError(error: unknown): unknown {
  return error instanceof KasaneError ? drawErrorOf(error) : error;
}

/**
 * Creates the builder of the pages of the features of one layer
 *
 * Its methods throw `DrawError`: with the code `invalidInput` when a row is refused (an id added
 * twice, a geometry or a value that cannot be held, more than 255 types), or `notFound` when a
 * row names a group the options do not give.
 *
 * @internal
 */
export function createFeaturePageBuilder(
  options: FeaturePageBuilderOptions = {},
): FeaturePageBuilder {
  const builder = createPageBuilder({
    ...tablesBuilderOptionsOf(options),
    columns: FEATURE_TABLE_COLUMNS,
    rings: options.rings ? rowRingsOfPoint(options.rings) : circleRowRings,
    caches: FEATURE_CACHES,
  });
  return {
    get length() {
      return builder.length;
    },
    addRow(row: FeatureRowInput): void {
      try {
        builder.add(rowInputOfFeature(row));
      } catch (error) {
        throw rowsError(error);
      }
    },
    finish(): Page[] {
      try {
        return builder.build();
      } catch (error) {
        throw rowsError(error);
      }
    },
  };
}

/**
 * Merges rows of pages of the features into new pages, in the order of the layer
 *
 * @returns The new pages (none for no row); their references are those of the rows
 * @throws `DrawError` with the code `invalidInput` when a source holds styles not numbered yet,
 *   or `notFound` when a row names a group of features the keys do not give
 * @internal
 */
export function mergeFeaturePages(merge: PageMerge): Page[] {
  try {
    return mergePages(tablesMergeOf(merge));
  } catch (error) {
    throw rowsError(error);
  }
}
