// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The pages of rows built in a Worker: the builder (`createRowPageBuilder`), the buffers to
 * transfer (`getRowPageTransferList`), the merge (`mergeRowPages`), and the Worker of the
 * application as the tables hand it their work (`tablesWorkerOf`).
 *
 * A page is a page of the tables of `@sakuzu/kasane`, built with the columns of the rows of the
 * features (`row-columns.ts`), that also holds what the Store needs to take it in: the ids of the
 * groups its rows name, the number of values of its positions and what the third one is. A Worker
 * cannot know the
 * references the Store gives the groups, so a row of a page built here names its group by its
 * place in the groups the builder was given (`RowPageBuilderOptions.groups`); the Store writes
 * the references of the groups over them when it takes the page in (`writeGroupRefs`), in place.
 * Nothing else of a page is copied or changed by the Store.
 *
 * The work the tables hand to a Worker (`TablesWorker`) is given to the Worker of the application
 * in the form of the store entry: the rows to build as `RowInput`, and the merge as it is (it
 * holds no function and is posted whole). What runs in the Worker is what this module exports, so
 * a page built there is the page the main thread would build.
 *
 * A pure module: it depends on neither WebGL nor the DOM, so a Worker runs it.
 *
 * @internal
 */

import {
  createPageBuilder,
  type GroupEntry,
  KasaneError,
  mergePages,
  type Page,
  type PageMerge,
  type RowInput as TablesRowInput,
  type TablesWorker,
  transferList,
} from '@sakuzu/kasane';
import type { Geometry } from 'geojson';
import { DrawError } from '../../shared/errors.js';
import { dimensionsOfValues, ROW_COLUMNS } from './row-columns.js';
import type {
  RowInput,
  RowPage,
  RowPageBuilder,
  RowPageBuilderOptions,
  RowPageMergeTask,
  RowPageWorker,
  RowSpatialIndexing,
} from './types.js';
import { isPlainObject, isWellFormed, jsonProblem, styleProblem } from './validate.js';

/**
 * A page as the builder makes it: a page of the tables, with the ids of the groups its rows name
 * (a row names the place of its group in `groupIds`, or -1), the number of values of its
 * positions and what the third one is
 *
 * @internal
 */
export interface BuiltPage extends Page {
  /** The ids of the groups the rows can name, by the number a row names */
  readonly groupIds: readonly string[];
  /** The number of values of the positions */
  readonly valuesPerPosition: 2 | 3 | 4;
  /** What the third value of the positions is when there are 3 (a height for 2 and 4) */
  readonly thirdValue: 'height' | 'measure';
}

/** The depth of the shape of each type of geometry: the number of its levels of arrays */
const SHAPE_DEPTHS: ReadonlyMap<string, 0 | 1 | 2 | 3> = new Map([
  ['Point', 0],
  ['LineString', 1],
  ['MultiPoint', 1],
  ['Polygon', 2],
  ['MultiLineString', 2],
  ['MultiPolygon', 3],
]);

/** Runs a call of the tables, throwing an error of the tables as a `DrawError` of the same code */
function tables<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof KasaneError) throw new DrawError(error.code, error.message, error);
    throw error;
  }
}

/** Throws a `DrawError` with the code `invalidInput` */
function invalid(message: string): never {
  throw new DrawError('invalidInput', message);
}

/** Whether a value is an object (not null) */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Whether a value is a non-empty string */
function isId(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** Throws unless a string holds no lone surrogate */
function checkWellFormed(what: string, value: string): void {
  if (!isWellFormed(value)) invalid(`${what} holds a lone surrogate`);
}

/** Why a value is not a position of `n` finite numbers (null when it is) */
function positionProblem(position: unknown, n: number): string | null {
  if (!Array.isArray(position)) return 'a position is not an array';
  if (position.length !== n) {
    return `a position has ${position.length} values, the layer ${n}`;
  }
  for (let k = 0; k < n; k++) {
    const value = position[k];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return 'a position has a value that is not a finite number';
    }
  }
  return null;
}

/** Why a value is not a list of positions (null when it is) */
function positionsProblem(positions: unknown, n: number): string | null {
  if (!Array.isArray(positions)) return 'a list of positions is not an array';
  for (const position of positions) {
    const problem = positionProblem(position, n);
    if (problem !== null) return problem;
  }
  return null;
}

/** Whether the first and the last position of a ring are the same, every value of them */
function isClosed(ring: readonly (readonly number[])[], n: number): boolean {
  if (ring.length === 0) return false;
  const first = ring[0];
  const last = ring[ring.length - 1];
  for (let k = 0; k < n; k++) if (first[k] !== last[k]) return false;
  return true;
}

/** Why a value is not a list of rings, or of lines (null when it is) */
function ringsProblem(rings: unknown, n: number, closed: boolean): string | null {
  if (!Array.isArray(rings)) return 'a list of rings is not an array';
  for (let r = 0; r < rings.length; r++) {
    const problem = positionsProblem(rings[r], n);
    if (problem !== null) return problem;
    if (closed && !isClosed(rings[r], n)) return `the ring ${r} is not closed`;
  }
  return null;
}

/**
 * Why a value is not a GeoJSON geometry of one of the six types a row holds, with positions of `n`
 * finite numbers and the rings of its polygons closed (null when it is): the rules the writes of
 * the Store keep (`validateRowValues`)
 */
function geometryProblem(geometry: unknown, n: number): string | null {
  if (!isObject(geometry)) return 'the geometry is not an object';
  const { type, coordinates } = geometry;
  if (typeof type !== 'string' || !SHAPE_DEPTHS.has(type)) {
    return `${JSON.stringify(type)} is not one of the six types of geometry`;
  }
  switch (type) {
    case 'Point':
      return positionProblem(coordinates, n);
    case 'LineString':
    case 'MultiPoint':
      return positionsProblem(coordinates, n);
    case 'Polygon':
    case 'MultiLineString':
      return ringsProblem(coordinates, n, type === 'Polygon');
    default: {
      if (!Array.isArray(coordinates)) return 'the polygons are not an array';
      for (const polygon of coordinates) {
        const problem = ringsProblem(polygon, n, true);
        if (problem !== null) return problem;
      }
      return null;
    }
  }
}

/**
 * Why a value is not the attributes of a row (null when they are): a plain object whose values are
 * values JSON holds (a key whose value is `undefined` is no attribute)
 */
function attributesProblem(properties: unknown): string | null {
  if (!isPlainObject(properties)) return 'the attributes are not a plain object';
  const within: unknown[] = [];
  for (const key in properties) {
    const value = properties[key];
    if (value === undefined) continue;
    within.length = 0;
    const problem = jsonProblem(value, within);
    if (problem !== null) return `the attribute ${JSON.stringify(key)}: ${problem}`;
  }
  return null;
}

/** The attributes without their keys whose value is `undefined` (the same object when none) */
function definedAttributes(
  properties: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  let out: Record<string, unknown> | null = null;
  for (const key in properties) {
    if (properties[key] !== undefined) continue;
    out ??= { ...properties };
    delete out[key];
  }
  return out ?? properties;
}

/**
 * Creates the builder of the pages of one layer: what a Worker of the application runs to build a
 * large document, so that the main thread only takes the pages in.
 *
 * @example
 * ```ts
 * // worker.ts
 * const builder = createRowPageBuilder();
 * for (const row of rows) builder.addRow(row);
 * const pages = builder.finish();
 * self.postMessage(pages, { transfer: getRowPageTransferList(pages) });
 *
 * // main.ts
 * worker.onmessage = (event) => {
 *   store.transact(() => store.createRowsFromPages('buildings', event.data), 'remote');
 * };
 * ```
 */
export function createRowPageBuilder(options: RowPageBuilderOptions = {}): RowPageBuilder {
  const what = 'createRowPageBuilder';
  if (!isObject(options)) invalid(`${what}: the options are not an object`);
  const { groups = [], valuesPerPosition = 2, thirdValue = 'height' } = options;
  const spatialIndexing: unknown = options.spatialIndexing;
  if (valuesPerPosition !== 2 && valuesPerPosition !== 3 && valuesPerPosition !== 4) {
    invalid(`${what}: ${String(valuesPerPosition)} is not a number of values of a position`);
  }
  if (thirdValue !== 'height' && thirdValue !== 'measure') {
    invalid(`${what}: the third value is neither height nor measure`);
  }
  /** What the third value is: a measure only for positions of 3 values */
  const third = valuesPerPosition === 3 ? thirdValue : 'height';
  if (!Array.isArray(groups)) invalid(`${what}: the groups are not an array`);
  if (
    spatialIndexing !== undefined &&
    (!isObject(spatialIndexing) || typeof spatialIndexing.rowBox !== 'function')
  ) {
    invalid(`${what}: the spatial indexing has no rowBox`);
  }
  /** The number each group is named by in the rows, by its id */
  const numbers = new Map<string, number>();
  const entries: GroupEntry[] = [];
  for (const group of groups) {
    if (!isObject(group) || !isId(group.id)) invalid(`${what}: a group has no id`);
    if (!isId(group.orderKey)) {
      invalid(`${what}: the group ${JSON.stringify(group.id)} has no key of its order`);
    }
    checkWellFormed(`${what}: the id of a group`, group.id);
    checkWellFormed(`${what}: the key of the order of a group`, group.orderKey);
    if (numbers.has(group.id)) invalid(`${what}: the group ${JSON.stringify(group.id)} is twice`);
    numbers.set(group.id, entries.length);
    entries.push({ group: entries.length, id: group.id, key: group.orderKey });
  }
  const groupIds: readonly string[] = Object.freeze(entries.map((entry) => entry.id));
  const builder = tables(() =>
    createPageBuilder({
      columns: ROW_COLUMNS,
      groups: entries,
      dimensions: dimensionsOfValues(valuesPerPosition, third),
      ...(spatialIndexing !== undefined && {
        coordinateSystem: spatialIndexing as unknown as RowSpatialIndexing,
      }),
    }),
  );
  /** The first id of a group that is not given which a row named */
  let missingGroup: string | undefined;

  return {
    get length() {
      return builder.length;
    },
    addRow(row: RowInput): void {
      const where = 'RowPageBuilder.addRow';
      if (!isObject(row)) invalid(`${where}: the row is not an object`);
      const { id, type, geometry, orderKey, groupId, style, properties, visible, locked } = row;
      if (!isId(id)) invalid(`${where}: the id is not a non-empty string`);
      checkWellFormed(`${where}: the id`, id);
      const of = `${where}: the row ${JSON.stringify(id)}`;
      if (!isId(type)) invalid(`${of}: the type is not a non-empty string`);
      checkWellFormed(`${of}: the type`, type);
      if (!isId(orderKey)) invalid(`${of}: the key of the order is not a non-empty string`);
      checkWellFormed(`${of}: the key of the order`, orderKey);
      if (groupId !== undefined && !isId(groupId)) {
        invalid(`${of}: the group is not the id of a group`);
      }
      if (groupId !== undefined) checkWellFormed(`${of}: the group`, groupId);
      if (visible !== undefined && typeof visible !== 'boolean') {
        invalid(`${of}: visible is not a boolean`);
      }
      if (locked !== undefined && typeof locked !== 'boolean') {
        invalid(`${of}: locked is not a boolean`);
      }
      if (geometry !== null) {
        const problem = geometryProblem(geometry, valuesPerPosition);
        if (problem !== null) invalid(`${of}: ${problem}`);
      }
      if (style !== undefined) {
        const problem = styleProblem(style);
        if (problem !== null) invalid(`${of}: ${problem}`);
      }
      if (properties !== undefined) {
        const problem = attributesProblem(properties);
        if (problem !== null) invalid(`${of}: ${problem}`);
      }
      let group = -1;
      if (groupId !== undefined) {
        const number = numbers.get(groupId);
        if (number === undefined) missingGroup ??= groupId;
        else group = number;
      }
      const shape =
        geometry === null
          ? null
          : {
              name: (geometry as Geometry).type,
              depth: SHAPE_DEPTHS.get((geometry as Geometry).type),
              points: (geometry as { coordinates: unknown }).coordinates,
            };
      const input: TablesRowInput = {
        id,
        key: orderKey,
        group,
        values: {
          type,
          geometry: shape,
          style,
          properties: properties === undefined ? undefined : definedAttributes(properties),
          hidden: visible === false,
          locked: locked === true,
        },
      };
      tables(() => builder.add(input));
    },
    finish(): RowPage[] {
      if (missingGroup !== undefined) {
        throw new DrawError(
          'notFound',
          `RowPageBuilder.finish: a row names the group ${JSON.stringify(missingGroup)}, which the options do not give`,
        );
      }
      const pages = tables(() => builder.build());
      for (const page of pages)
        Object.assign(page, { groupIds, valuesPerPosition, thirdValue: third });
      return pages as unknown as RowPage[];
    },
  };
}

/** Whether a value is a column of bytes: the offsets and the bytes of a list of byte strings */
function isByteColumn(value: unknown, length: number): boolean {
  return (
    isObject(value) &&
    value.offsets instanceof Int32Array &&
    value.offsets.length === length + 1 &&
    value.bytes instanceof Uint8Array
  );
}

/**
 * Whether a value has the columns of a page of the tables, each of its length (what the tables
 * check of it besides is checked when they take it in)
 *
 * @internal
 */
export function isPageShape(value: unknown): value is Page {
  if (!isObject(value)) return false;
  const { length, rows, ids, idHashes, groups } = value;
  return (
    typeof length === 'number' &&
    Number.isInteger(length) &&
    length >= 0 &&
    rows instanceof Int32Array &&
    rows.length === length &&
    isByteColumn(ids, length) &&
    idHashes instanceof Uint32Array &&
    idHashes.length === length &&
    groups instanceof Int32Array &&
    groups.length === length &&
    Array.isArray(value.shapes) &&
    Array.isArray(value.wholes) &&
    Array.isArray(value.keyed) &&
    isByteColumn(value.keys, length) &&
    value.flags instanceof Uint8Array &&
    value.flags.length === length &&
    value.rowBounds instanceof Float64Array &&
    Array.isArray(value.caches)
  );
}

/**
 * Whether a value is a page the builder made and the tables have not taken in: the columns of a
 * page, the ids of its groups, the number of values of its positions, rows not given references
 * yet, and groups named by their places among its ids of groups
 *
 * @internal
 */
export function isBuiltPage(value: unknown): value is BuiltPage {
  if (!isPageShape(value)) return false;
  const { groupIds, valuesPerPosition, thirdValue } = value as unknown as Record<string, unknown>;
  if (!Array.isArray(groupIds) || !groupIds.every(isId)) return false;
  if (valuesPerPosition !== 2 && valuesPerPosition !== 3 && valuesPerPosition !== 4) return false;
  if (thirdValue !== 'height' && thirdValue !== 'measure') return false;
  const { rows, groups } = value;
  for (let r = 0; r < rows.length; r++) {
    if (rows[r] !== -1) return false;
    if (groups[r] < -1 || groups[r] >= groupIds.length) return false;
  }
  return true;
}

/**
 * Writes the references of the groups over the places of the groups the rows of a page name, in
 * place (`refs[i]` for the place `i`)
 *
 * @internal
 */
export function writeGroupRefs(page: BuiltPage, refs: Int32Array): void {
  const groups = page.groups;
  for (let r = 0; r < groups.length; r++) {
    const at = groups[r];
    if (at >= 0) groups[r] = refs[at];
  }
}

/**
 * Writes the places of the groups back over the references written by {@link writeGroupRefs}
 *
 * @internal
 */
export function writeGroupPlaces(page: BuiltPage, refs: Int32Array): void {
  const places = new Map<number, number>();
  for (let i = 0; i < refs.length; i++) places.set(refs[i], i);
  const groups = page.groups;
  for (let r = 0; r < groups.length; r++) {
    const ref = groups[r];
    if (ref >= 0) groups[r] = places.get(ref) ?? -1;
  }
}

/**
 * Every buffer of pages, for `postMessage` with transfer, each one once. After the transfer the
 * arrays are empty in the Worker that posted them.
 */
export function getRowPageTransferList(pages: readonly RowPage[]): ArrayBuffer[] {
  if (!Array.isArray(pages)) invalid('getRowPageTransferList: the pages are not an array');
  for (const page of pages) {
    if (!isPageShape(page)) invalid('getRowPageTransferList: a value is not a page');
  }
  return transferList(pages as unknown as readonly Page[]);
}

/** Merges rows of pages into new pages: what a Worker runs for {@link RowPageWorker.merge}. */
export function mergeRowPages(merge: RowPageMergeTask): RowPage[] {
  const task = merge as unknown as Partial<PageMerge>;
  if (!isObject(task) || !Array.isArray(task.sources) || !(task.rows instanceof Int32Array)) {
    invalid('mergeRowPages: the value is not a merge the Store handed out');
  }
  return tables(() => mergePages(task as PageMerge)) as unknown as RowPage[];
}

/** The number of values of a position of the dimensions of the tables */
function valuesOfDimensions(dimensions: string | undefined): 2 | 3 | 4 {
  if (dimensions === 'xyzm') return 4;
  return dimensions === 'xyz' || dimensions === 'xym' ? 3 : 2;
}

/**
 * A row the tables build, as the builder of the store entry takes it: its geometry as GeoJSON,
 * its group by its id
 */
function rowInputOf(row: TablesRowInput, idOfRef: ReadonlyMap<number, string>): RowInput {
  if (row.deleted === true) {
    throw new DrawError('invalidInput', `the row ${JSON.stringify(row.id)} to build is deleted`);
  }
  const { values } = row;
  const shape = values.geometry as { name: string; points: unknown } | null | undefined;
  const groupId = row.group !== undefined && row.group >= 0 ? idOfRef.get(row.group) : undefined;
  return {
    id: row.id,
    type: values.type as string,
    geometry: shape ? ({ type: shape.name, coordinates: shape.points } as Geometry) : null,
    orderKey: row.key,
    ...(groupId !== undefined && { groupId }),
    ...(values.style !== undefined && { style: values.style as RowInput['style'] }),
    ...(values.properties !== undefined && {
      properties: values.properties as RowInput['properties'],
    }),
    visible: values.hidden !== true,
    locked: values.locked === true,
  };
}

/**
 * The Worker of the application as the tables hand it their work: the rows to build given to it as
 * rows of the store entry, the groups by their ids, and the pages it built given the references of
 * their groups; a merge posted as it is
 *
 * @internal
 */
export function tablesWorkerOf(worker: RowPageWorker): TablesWorker {
  return {
    merge: (merge) =>
      worker
        .merge(merge as unknown as RowPageMergeTask)
        .then((pages) => pages as unknown as Page[]),
    build: (rows, options) => {
      const entries = options.groups ?? [];
      const idOfRef = new Map<number, string>();
      for (const entry of entries) idOfRef.set(entry.group, entry.id);
      let inputs: RowInput[];
      try {
        inputs = rows.map((row) => rowInputOf(row, idOfRef));
      } catch (error) {
        return Promise.reject(error);
      }
      const groups = entries.map((entry) => ({ id: entry.id, orderKey: entry.key }));
      const refOfId = new Map<string, number>();
      for (const entry of entries) refOfId.set(entry.id, entry.group);
      return worker
        .build(inputs, {
          groups,
          valuesPerPosition: valuesOfDimensions(options.dimensions),
          // A third value that is a measure; a height is the one left out
          ...(options.dimensions === 'xym' && { thirdValue: 'measure' as const }),
        })
        .then((pages) => {
          for (const page of pages) {
            if (!isBuiltPage(page)) {
              throw new DrawError('invalidInput', 'the Worker gave a value that is not a page');
            }
            const refs = new Int32Array(page.groupIds.length);
            for (let i = 0; i < refs.length; i++) refs[i] = refOfId.get(page.groupIds[i]) ?? -1;
            writeGroupRefs(page, refs);
          }
          return pages as unknown as Page[];
        });
    },
  };
}
