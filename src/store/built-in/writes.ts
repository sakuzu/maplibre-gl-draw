// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The writes of the built-in Store: the rows of the features (`createRows`, `writeRows`), the whole
 * document (`clear`), the layers, the groups, the stacking order, the files and the metadata, with
 * the transactions, the numbers of the operations and the subscription to the changes.
 *
 * A write checks everything before it writes anything, so that it applies to all its rows or to
 * none: the kinds of its arguments, the rules of the values of the fields (`validateRowValues`),
 * the layer of its rows, and the ids it takes. A write whose argument cannot apply throws a
 * `DrawError` (`invalidInput` for a value of the wrong kind, `notFound` for an id or a row that
 * names nothing); one that takes an id in use returns false. Each write runs in the transaction
 * under way, or in one of its own of the source `'remote'`, and adds what it wrote to its change.
 *
 * The Store does nothing by itself, with one exception: a group given another layer takes its
 * members there, as they must stay in the layer of their group. It does not delete a group that
 * has no member left, nor move the members of a group it deletes.
 *
 * The rows of one write go to the tables in one write of theirs, with what the write was given:
 * the fields under the names of the columns, and the geometries as the columns of their shapes.
 * Nothing is made per row. The style written by its keys (`style:<key>`) goes to the tables as the
 * whole style of each row: its style now with the keys written, one object for every row whose
 * style was the same object and that is given the same values, so the rows of one style given one
 * value of a key share one new style.
 *
 * While a listener asks for the values before, each write of rows reads the values its rows have
 * before it writes them (`values-before.ts`); while a listener keeps the deleted rows, each write
 * gives the token of the tables of its transaction, and marks the rows it deleted and brought back
 * (`kept-rows.ts`). A deleted row is written only when something keeps it, and only to bring it
 * back (`deleted` 0); its id stays in use while a change told keeps it.
 *
 * A row the transaction open deleted is kept by nothing yet, whatever the listeners asked for:
 * `createRows` takes its id with the reference of the row, in the parent given, with the values
 * given alone (the fields it held and the write does not give take the values of a new row). The
 * ids of the deleted rows nothing keeps are forgotten once the change of the transaction has been
 * told (see `changes.ts`), and afterwards a new row, or a row of a page, takes such an id with a
 * new reference.
 *
 * @internal
 */

import { KasaneError, type RowValues as TablesRowValues } from '@sakuzu/kasane';
import type { FileData, Layer, Metadata } from '../../api/model.js';
import { DrawError } from '../../shared/errors.js';
import { countWork, type WorkCounts } from '../../shared/work-counts.js';
import {
  addCleared,
  addFileCreated,
  addFileDeleted,
  addGroupCreated,
  addGroupDeleted,
  addGroupUpdated,
  addLayerCreated,
  addLayerDeleted,
  addLayerUpdated,
  addMetadata,
  addOrderChanged,
  addRows,
  forgetWhenOperationEnds,
  forgetWhenTold,
  markDeletionWritten,
  newOperationId,
  readsValuesBefore,
  readValuesBefore,
  subscribe,
  tablesTokenOf,
  transact,
  write,
} from './changes.js';
import { dimensionsOfPositions, positionsOf, type StoreDocument } from './document.js';
import { readRowValues } from './feature-tables.js';
import {
  forgetKept,
  isKept,
  isKeptByChangeTold,
  markCreatedAgain,
  type ReleaseTablesToken,
  releaseToken,
} from './kept-rows.js';
import { createRowsFromPagesOf } from './page-writes.js';
import { shapeValuesOf } from './shape-values.js';
import type {
  FeatureRowField,
  GeometryColumn,
  NewRows,
  RowValues,
  Store,
  StoreGroup,
} from './types.js';
import { fieldKind, isWellFormed, validateRowValues } from './validate.js';

/** The type of a row without a geometry, in `GeometryColumn.types` */
const NO_TYPE = 255;

/** The style of a row that has none */
const NO_STYLE: Readonly<Record<string, never>> = Object.freeze({});

/** A key of the style written `undefined` (taken off), as the value of a step of the styles made */
const TAKEN_OFF = Symbol('taken off');

/** The number -0 as the value of a step of the styles made (a Map does not tell it from 0) */
const NEGATIVE_ZERO = Symbol('-0');

/** The start of the fields of the keys of the style */
const STYLE_KEY_FIELD = 'style:';

/** The fields of a row written under another name in the tables */
const TABLE_NAMES: ReadonlyMap<string, string> = new Map([['orderKey', 'key']]);

/**
 * Runs a write of the tables, throwing an error of the tables as a `DrawError` of the same code
 */
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

/** Throws a `DrawError` with the code `notFound` */
function notFound(message: string): never {
  throw new DrawError('notFound', message);
}

/** Whether a value is an object (not null) */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Whether a value is an id: a non-empty string */
function isId(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * Throws unless the fields of a write of rows are fields it writes: the fields of a row, and not
 * the geometry, which is given as a column; the whole style and keys of it are not written
 * together
 */
function checkFields(
  what: string,
  fields: unknown,
): asserts fields is ReadonlyMap<FeatureRowField, readonly unknown[]> {
  if (!(fields instanceof Map)) invalid(`${what}: the fields are not a Map`);
  let styleKey: string | undefined;
  for (const field of fields.keys()) {
    if (field === 'geometry') {
      invalid(`${what}: the geometries are given as a GeometryColumn (geometry), not as a field`);
    }
    const kind = typeof field === 'string' ? fieldKind(field) : null;
    if (kind === null) invalid(`${what}: ${JSON.stringify(field)} is not a field of a row`);
    if (kind === 'style') styleKey ??= field as string;
  }
  if (styleKey !== undefined && fields.has('style')) {
    invalid(
      `${what}: the whole style and its key ${JSON.stringify(styleKey)} are written together; write one of them`,
    );
  }
}

/** The fields of the keys of the style among the fields of a write, with their values */
function styleKeysOf(
  fields: ReadonlyMap<FeatureRowField, readonly unknown[]>,
): Array<[FeatureRowField, readonly unknown[]]> {
  const out: Array<[FeatureRowField, readonly unknown[]]> = [];
  for (const entry of fields) {
    if (entry[0].startsWith(STYLE_KEY_FIELD) && entry[0].length > STYLE_KEY_FIELD.length) {
      out.push(entry);
    }
  }
  return out;
}

/** A step of the styles made: the style made once the values that led here are written */
interface StyleStep {
  readonly next: Map<unknown, StyleStep>;
  style: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The whole styles of rows with the keys of the style written: for each row, its style (`before`)
 * with the values of the keys given, `undefined` taking a key off. The rows whose style was the
 * same object and that are given the same values share one new style, made once
 *
 * @param counts - Where the objects made are counted
 */
function stylesWithKeys(
  before: readonly unknown[],
  keys: ReadonlyArray<[FeatureRowField, readonly unknown[]]>,
  length: number,
  counts: WorkCounts,
): unknown[] {
  const names = keys.map(([field]) => field.slice(STYLE_KEY_FIELD.length));
  /** The first step of the styles made from each style there was, by the style */
  const first = new Map<unknown, StyleStep>();
  const out = new Array<unknown>(length);
  countWork(counts, 'objectsCreated', 3);
  for (let i = 0; i < length; i++) {
    const style = (before[i] ?? NO_STYLE) as Readonly<Record<string, unknown>>;
    let step: StyleStep | undefined = first.get(style);
    if (!step) {
      step = { next: new Map(), style: undefined };
      countWork(counts, 'objectsCreated', 2);
      first.set(style, step);
    }
    for (const [, column] of keys) {
      const value = column[i];
      const at = value === undefined ? TAKEN_OFF : Object.is(value, -0) ? NEGATIVE_ZERO : value;
      let next: StyleStep | undefined = step.next.get(at);
      if (!next) {
        next = { next: new Map(), style: undefined };
        countWork(counts, 'objectsCreated', 2);
        step.next.set(at, next);
      }
      step = next;
    }
    if (!step.style) {
      const made: Record<string, unknown> = { ...style };
      for (let k = 0; k < keys.length; k++) {
        const value = keys[k][1][i];
        if (value === undefined) delete made[names[k]];
        else made[names[k]] = value;
      }
      step.style = Object.freeze(made);
      countWork(counts, 'objectsCreated');
    }
    out[i] = step.style;
  }
  return out;
}

/** The rows written deleted (`deleted` 1), in an array of their own */
function deletedRowsOf(rows: Int32Array, deleted: Uint8Array): Int32Array {
  let count = 0;
  for (let i = 0; i < rows.length; i++) if (deleted[i] !== 0) count++;
  const out = new Int32Array(count);
  let at = 0;
  for (let i = 0; i < rows.length; i++) if (deleted[i] !== 0) out[at++] = rows[i];
  return out;
}

/** Throws unless values of rows keep the rules of their fields */
/**
 * The marks of the rows each field of a write is written to (`RowValues.written`), checked:
 * undefined when every row is written every field
 */
function writtenMarksOf(
  what: string,
  written: unknown,
  rows: number,
): ReadonlyMap<string, Uint8Array> | undefined {
  if (written === undefined) return undefined;
  if (!(written instanceof Map)) invalid(`${what}: written is not a Map`);
  for (const [field, mark] of written as Map<unknown, unknown>) {
    if (typeof field !== 'string') invalid(`${what}: a key of written is not a field`);
    if (!(mark instanceof Uint8Array) || mark.length !== rows) {
      invalid(
        `${what}: the marks of ${JSON.stringify(field)} are not a Uint8Array of one entry per row`,
      );
    }
  }
  return written.size > 0 ? (written as ReadonlyMap<string, Uint8Array>) : undefined;
}

function checkValues(what: string, values: RowValues | NewRows, valuesPerPosition: number): void {
  const problem = validateRowValues(
    values,
    valuesPerPosition === 3 || valuesPerPosition === 4 ? valuesPerPosition : 2,
  );
  if (problem) {
    invalid(`${what}: the row ${problem.row}, ${problem.field}: ${problem.reason}`);
  }
}

/**
 * The ids of rows as the tables take them: their UTF-8 bytes one after the other, encoded as a
 * `TextEncoder` encodes them, into one array
 *
 * @throws `DrawError` with the code `invalidInput` for an id that holds a lone surrogate (it has
 *   no UTF-8)
 */
function idColumnOf(ids: readonly string[]): { offsets: Int32Array; bytes: Uint8Array } {
  let size = 0;
  for (const id of ids) size += id.length * 3;
  const bytes = new Uint8Array(size);
  const offsets = new Int32Array(ids.length + 1);
  let at = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    for (let k = 0; k < id.length; k++) {
      let code = id.charCodeAt(k);
      if (code >= 0xd800 && code <= 0xdbff && k + 1 < id.length) {
        const low = id.charCodeAt(k + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          k++;
        }
      }
      if (code >= 0xd800 && code <= 0xdfff) {
        invalid(`createRows: the id ${i} holds a lone surrogate`);
      }
      if (code < 0x80) {
        bytes[at++] = code;
      } else if (code < 0x800) {
        bytes[at++] = 0xc0 | (code >> 6);
        bytes[at++] = 0x80 | (code & 0x3f);
      } else if (code < 0x10000) {
        bytes[at++] = 0xe0 | (code >> 12);
        bytes[at++] = 0x80 | ((code >> 6) & 0x3f);
        bytes[at++] = 0x80 | (code & 0x3f);
      } else {
        bytes[at++] = 0xf0 | (code >> 18);
        bytes[at++] = 0x80 | ((code >> 12) & 0x3f);
        bytes[at++] = 0x80 | ((code >> 6) & 0x3f);
        bytes[at++] = 0x80 | (code & 0x3f);
      }
    }
    offsets[i + 1] = at;
  }
  return { offsets, bytes: bytes.subarray(0, at) };
}

/** A copy of a layer, frozen, with `null` of its optional fields read as `undefined` */
function frozenLayer(layer: Layer): Layer {
  const copy: Layer = { ...layer };
  if ((copy.metadata as unknown) === null) copy.metadata = undefined;
  if ((copy.styleRule as unknown) === null) copy.styleRule = undefined;
  return Object.freeze(copy);
}

/**
 * The writes of the built-in Store over a document
 *
 * @internal
 */
export function storeWritesOf(
  document: StoreDocument,
): Omit<
  Store,
  | 'tables'
  | 'getLayer'
  | 'listLayers'
  | 'getLayerOrder'
  | 'getGroup'
  | 'listGroups'
  | 'getFile'
  | 'listFiles'
  | 'getMetadata'
  | 'listPropertyKeys'
> {
  const { changes, counts, rowWrites } = document;
  const { kept } = changes;

  // The values before are read as the tables hold the rows, the deleted rows nothing keeps
  // included, with their deletion
  changes.readBefore = (rows, fields) =>
    tables(() =>
      readRowValues(document, rows, fields, { deleted: true, unkept: true, anyLayer: true }, [
        counts,
        changes.beforeCounts,
      ]),
    );

  /**
   * Whether an id is that of a row in use: a row that is not deleted, or a deleted row kept by a
   * change told (a row the transaction open deleted is not kept yet, whatever the listeners asked
   * for, so a group takes its id)
   */
  const isRowInUse = (id: string): boolean => {
    const found = tables(() => rowWrites.lookup(id));
    return (
      found !== undefined &&
      (!found.deleted || isKeptByChangeTold(kept, found.row, tablesTokenOf(changes)))
    );
  };

  /**
   * The layer a parent of a row names: the layer itself, or the layer of the group (undefined for
   * a value that names neither)
   */
  const layerNamed = (parent: unknown): string | undefined => {
    if (typeof parent !== 'string') return undefined;
    if (document.layers.has(parent)) return parent;
    return document.groups.get(parent)?.layerId;
  };

  /** Throws unless each parent given names a layer or a group */
  const checkParents = (what: string, parents: readonly unknown[] | undefined): void => {
    if (!parents) return;
    for (const parent of parents) {
      if (isId(parent) && layerNamed(parent) === undefined) {
        notFound(`${what}: the parent ${JSON.stringify(parent)} is neither a layer nor a group`);
      }
    }
  };

  /** The fields of values of rows under the names of the columns of the tables */
  const tableFieldsOf = (
    fields: ReadonlyMap<FeatureRowField, readonly unknown[]>,
  ): Map<string, readonly unknown[]> => {
    const out = new Map<string, readonly unknown[]>();
    for (const [field, column] of fields) {
      if (field === 'visible') {
        const hidden = new Array<unknown>(column.length);
        for (let i = 0; i < column.length; i++) {
          hidden[i] = column[i] === undefined ? undefined : column[i] !== true;
        }
        countWork(counts, 'objectsCreated');
        out.set('hidden', hidden);
      } else {
        out.set(TABLE_NAMES.get(field) ?? field, column);
      }
    }
    // The values of rows and the map of their fields
    countWork(counts, 'objectsCreated', 2);
    return out;
  };

  /** The fields a write of rows writes, for the values before: its fields, and the geometry */
  const fieldsWritten = (
    fields: ReadonlyMap<FeatureRowField, readonly unknown[]>,
    geometry: GeometryColumn | undefined,
  ): FeatureRowField[] => [...fields.keys(), ...(geometry ? (['geometry'] as const) : [])];

  /**
   * The fields of a write with the keys of the style written as the whole style of each row: its
   * style now (none for a new row) with the keys written; the fields as they are when no key of
   * the style is written
   */
  const withWholeStyles = (
    rows: Int32Array,
    fields: ReadonlyMap<FeatureRowField, readonly unknown[]>,
    keys: ReadonlyArray<[FeatureRowField, readonly unknown[]]>,
    created: boolean,
  ): ReadonlyMap<FeatureRowField, readonly unknown[]> => {
    if (keys.length === 0) return fields;
    let before: readonly unknown[] = [];
    if (!created) {
      before = tables(() => document.rows.readValues(rows, ['style'])).fields.get('style') ?? [];
      countWork(counts, 'objectsCreated', 3);
      countWork(counts, 'rowsTouched', rows.length);
    }
    const out = new Map<FeatureRowField, readonly unknown[]>();
    for (const [field, column] of fields) {
      if (!field.startsWith(STYLE_KEY_FIELD)) out.set(field, column);
    }
    out.set('style', stylesWithKeys(before, keys, rows.length, counts));
    countWork(counts, 'objectsCreated');
    return out;
  };

  /**
   * Writes values of rows to the tables, and adds what they wrote to the change: the rows brought
   * back are updated, and the rows deleted and brought back are marked as kept or not. The ids of
   * the rows deleted are forgotten once the change has been told, unless something keeps them
   *
   * @param created - Whether the rows are new ones (their style is none before the write)
   */
  const writeTables = (
    rows: Int32Array,
    fields: ReadonlyMap<FeatureRowField, readonly unknown[]>,
    geometry: GeometryColumn | undefined,
    layerId: string,
    deleted: Uint8Array | undefined,
    created: boolean,
    broughtBack?: ReadonlySet<number>,
  ): void => {
    const styleKeys = styleKeysOf(fields);
    const values: TablesRowValues = {
      rows,
      fields: tableFieldsOf(withWholeStyles(rows, fields, styleKeys, created)),
      ...(geometry && {
        shapes: new Map([
          [
            'geometry',
            shapeValuesOf(geometry, dimensionsOfPositions(positionsOf(document, layerId)), counts),
          ],
        ]),
      }),
      ...(deleted && { deleted }),
    };
    const tablesToken = tablesTokenOf(changes);
    const written = tables(() =>
      rowWrites.writeRows(
        values,
        tablesToken === undefined ? undefined : { restoreToken: tablesToken },
      ),
    );
    if (deleted) {
      markDeletionWritten(changes, rows, deleted);
      forgetWhenTold(changes, deletedRowsOf(rows, deleted));
    }
    addRows(
      changes,
      written.rows,
      broughtBack,
      styleKeys.length > 0 ? styleKeys.map(([field]) => field) : undefined,
    );
    countWork(counts, 'rowsWritten', rows.length);
    countWork(counts, 'rowsTouched', rows.length);
  };

  /** Writes groups to the tables, and adds the rows they took with them to the change */
  const writeGroups = (
    refs: Int32Array,
    fields: Map<string, unknown[]>,
    deleted?: Uint8Array,
  ): void => {
    const written = tables(() =>
      rowWrites.writeGroups({ groups: refs, fields, ...(deleted && { deleted }) }),
    );
    addRows(changes, written.rows);
  };

  /**
   * The fields of a write of new rows with the fields rows that come back held and the write does
   * not give, written with the values of a new row: visible, not locked, the style `{}`, and no
   * attribute of theirs (the keys of the style written alone build on no style)
   */
  const withValuesOfNewRows = (
    fields: ReadonlyMap<FeatureRowField, readonly unknown[]>,
    again: Int32Array,
    length: number,
  ): ReadonlyMap<FeatureRowField, readonly unknown[]> => {
    const out = new Map(fields);
    const fill = (field: FeatureRowField, value: unknown): void => {
      if (!out.has(field)) out.set(field, new Array<unknown>(length).fill(value));
    };
    fill('visible', true);
    fill('locked', false);
    if (styleKeysOf(fields).length === 0) fill('style', NO_STYLE);
    for (const key of tables(() => document.rows.listKeys('properties', again))) {
      fill(`properties:${key}` as FeatureRowField, undefined);
    }
    countWork(counts, 'objectsCreated', 2);
    return out;
  };

  const createRows: Store['createRows'] = (rows) =>
    write(changes, 'createRows', () => {
      const what = 'createRows';
      if (!isObject(rows) || !Array.isArray(rows.ids)) invalid(`${what}: the rows have no ids`);
      const { ids, fields, geometry } = rows;
      for (const id of ids) {
        if (typeof id !== 'string') invalid(`${what}: an id is not a string`);
        if (!isWellFormed(id))
          invalid(`${what}: the id ${JSON.stringify(id)} holds a lone surrogate`);
      }
      checkFields(what, fields);
      // The layer of the rows: the layer of their parents
      const parents = fields.get('parent');
      if (parents !== undefined && !Array.isArray(parents))
        invalid(`${what}: parent is not an array`);
      checkParents(what, parents);
      let layerId: string | undefined;
      for (const parent of parents ?? []) {
        const layer = layerNamed(parent);
        if (layer === undefined) continue;
        if (layerId === undefined) layerId = layer;
        else if (layer !== layerId) {
          invalid(
            `${what}: the rows are in more than one layer (${JSON.stringify(layerId)} and ${JSON.stringify(layer)})`,
          );
        }
      }
      const valuesPerPosition =
        layerId === undefined ? 2 : positionsOf(document, layerId).valuesPerPosition;
      checkValues(what, rows, valuesPerPosition);
      if (ids.length === 0 || layerId === undefined) return true;
      // The ids are those of no row in use and no group, and are not given twice
      const seen = new Set<string>();
      /** The ids the tables hold already (those of deleted rows nothing keeps), by their places */
      let found: Uint8Array | undefined;
      /** The references of those rows */
      const again: number[] = [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (seen.has(id) || document.groups.has(id)) return false;
        const row = tables(() => rowWrites.lookup(id));
        // A row kept by a change told is in use; one the transaction open deleted comes back
        if (row && (!row.deleted || isKeptByChangeTold(kept, row.row, tablesTokenOf(changes)))) {
          return false;
        }
        // The id of a deleted row nothing keeps whose id is not forgotten yet: a row the
        // transaction deleted, or one a clear of its operation took out (it keeps its reference)
        if (row) {
          found ??= new Uint8Array(ids.length);
          found[i] = 1;
          again.push(row.row);
        }
        seen.add(id);
      }
      countWork(counts, 'objectsCreated');
      const column = idColumnOf(ids);
      countWork(counts, 'objectsCreated', 3);
      // A row that comes back holds the values given alone: the fields it held that are not given
      // are written with the values of a new row, so that the change names them
      const written =
        again.length > 0 ? withValuesOfNewRows(fields, Int32Array.from(again), ids.length) : fields;
      const refs = tables(() => rowWrites.allocateRowRefs(column));
      // The rows that come back are written their deletion as well
      if (found)
        readValuesBefore(
          changes,
          refs,
          [...fieldsWritten(written, geometry as GeometryColumn), 'deleted'],
          { marks: new Map([['deleted', found]]) },
        );
      try {
        writeTables(refs, written, geometry as GeometryColumn, layerId, undefined, true);
      } catch (error) {
        // The ids given new references are taken out again: nothing was created
        let fresh = refs;
        if (found) {
          const isNew = found;
          fresh = refs.filter((_, i) => isNew[i] === 0);
        }
        tables(() => rowWrites.forgetIds(fresh));
        throw error;
      }
      if (found) {
        const again = found;
        markCreatedAgain(
          kept,
          refs.filter((_, i) => again[i] === 1),
        );
      }
      return true;
    });

  const writeRows: Store['writeRows'] = (values) =>
    write(changes, 'writeRows', () => {
      const what = 'writeRows';
      if (!isObject(values) || !(values.rows instanceof Int32Array)) {
        invalid(`${what}: the rows are not an Int32Array of references`);
      }
      const { rows, fields, geometry, deleted } = values;
      checkFields(what, fields);
      const marks = writtenMarksOf(what, values.written, rows.length);
      if (rows.length === 0) {
        checkValues(what, values, 2);
        return true;
      }
      // Where the rows are now: rows there, in one layer (a deleted row kept, to be brought back)
      const now = tables(() => document.rows.readValues(rows, ['parent', 'deleted']));
      countWork(counts, 'objectsCreated', 3);
      const parentsNow = now.fields.get('parent') ?? [];
      const parents = fields.get('parent');
      if (parents !== undefined && !Array.isArray(parents))
        invalid(`${what}: parent is not an array`);
      let layerId: string | undefined;
      let broughtBack: Set<number> | undefined;
      for (let i = 0; i < rows.length; i++) {
        if (now.deleted?.[i]) {
          if (!isKept(kept, rows[i])) {
            notFound(`${what}: no row has the reference ${rows[i]}, or nothing keeps it deleted`);
          }
          if (!(deleted instanceof Uint8Array) || deleted[i] !== 0) {
            notFound(
              `${what}: the row ${rows[i]} is deleted; it is written only to be brought back (deleted 0)`,
            );
          }
          broughtBack ??= new Set();
          broughtBack.add(rows[i]);
        }
        // A deleted row whose group is no longer there comes back under the parent given
        const layer =
          layerNamed(parentsNow[i]) ?? (now.deleted?.[i] ? layerNamed(parents?.[i]) : undefined);
        if (layer === undefined) {
          notFound(
            now.deleted?.[i]
              ? `${what}: the group of the deleted row ${rows[i]} is not there; give it a parent to come back to`
              : `${what}: no row has the reference ${rows[i]}`,
          );
        }
        if (layerId === undefined) layerId = layer;
        else if (layer !== layerId) {
          invalid(
            `${what}: the rows are in more than one layer (${JSON.stringify(layerId)} and ${JSON.stringify(layer)})`,
          );
        }
      }
      const layer = layerId as string;
      checkParents(what, parents);
      // The geometries have the number of values of the layer each row is in after the write
      let valuesPerPosition = positionsOf(document, layer).valuesPerPosition as number;
      if (isObject(geometry)) {
        valuesPerPosition = geometry.valuesPerPosition;
        const types = geometry.types;
        for (let i = 0; i < rows.length; i++) {
          if (!(types instanceof Uint8Array) || types[i] === NO_TYPE) continue;
          const target = layerNamed(parents?.[i]) ?? layer;
          const expected = positionsOf(document, target).valuesPerPosition;
          if (expected !== valuesPerPosition) {
            invalid(
              `${what}: the geometries have ${valuesPerPosition} values per position, the layer ${JSON.stringify(target)} ${expected}`,
            );
          }
        }
      }
      checkValues(what, values, valuesPerPosition);
      // A deleted row whose id a group or a layer took meanwhile does not come back: the id is in
      // use
      if (broughtBack) {
        for (const ref of broughtBack) {
          const id = tables(() => document.rows.getRowId(ref));
          if (id !== undefined && (document.groups.has(id) || document.layers.has(id))) {
            return false;
          }
        }
      }
      // The rows the marks leave out are given the values they have, and are not written: the
      // values before leave them out
      readValuesBefore(
        changes,
        rows,
        [...fieldsWritten(fields, geometry), ...(deleted ? (['deleted'] as const) : [])],
        { marks },
      );
      writeTables(
        rows,
        fields,
        geometry,
        layerNamed(parents?.[0]) ?? layer,
        deleted,
        false,
        broughtBack,
      );
      return true;
    });

  /**
   * Every field rows hold: their geometry, their type, their place, their flags, every key of
   * their attributes and every key of their style (the styles of the rows are read for their
   * keys, each style object once)
   */
  const everyFieldOf = (refs: Int32Array): FeatureRowField[] => {
    const fields: FeatureRowField[] = [
      'geometry',
      'type',
      'parent',
      'orderKey',
      'visible',
      'locked',
    ];
    for (const key of tables(() => document.rows.listKeys('properties', refs))) {
      fields.push(`properties:${key}` as FeatureRowField);
    }
    const styles = tables(() => document.rows.readValues(refs, ['style'])).fields.get('style');
    // Work of the values before alone
    for (const list of [counts, changes.beforeCounts]) {
      countWork(list, 'objectsCreated', 3);
      countWork(list, 'rowsTouched', refs.length);
    }
    const seen = new Set<unknown>();
    const keys = new Set<string>();
    for (const style of styles ?? []) {
      if (!isObject(style) || seen.has(style)) continue;
      seen.add(style);
      for (const key of Object.keys(style)) keys.add(key);
    }
    for (const key of keys) fields.push(`${STYLE_KEY_FIELD}${key}` as FeatureRowField);
    return fields;
  };

  const clear: Store['clear'] = () =>
    write(changes, 'clear', () => {
      // What there is now: the rows that are not deleted, by layer
      const rows = new Map<string, Int32Array>();
      for (const layerId of document.layers.keys()) {
        const batches: Int32Array[] = [];
        let length = 0;
        const cursor = tables(() => document.rows.scan({ tableIds: [layerId] }));
        for (const batch of cursor) {
          batches.push(batch);
          length += batch.length;
        }
        if (length === 0) continue;
        const refs = new Int32Array(length);
        let at = 0;
        for (const batch of batches) {
          refs.set(batch, at);
          at += batch.length;
        }
        rows.set(layerId, refs);
      }
      // The values before: every field of every row there is, with its deletion, as the rows
      // cannot be read once they are taken out (only for a listener that asked for them)
      if (readsValuesBefore(changes)) {
        for (const refs of rows.values()) {
          readValuesBefore(changes, refs, [...everyFieldOf(refs), 'deleted']);
        }
      }
      addCleared(changes, {
        rows,
        layers: [...document.layers.values()],
        groups: [...document.groups.values()],
        files: [...document.files.values()],
        metadata: document.metadata,
        order: document.layerOrder,
      });
      // The groups go from the tables with the rows
      const groupRefs: number[] = [];
      for (const id of document.groups.keys()) {
        const ref = tables(() => document.rows.getGroupRef(id));
        if (ref !== undefined) groupRefs.push(ref);
      }
      if (groupRefs.length > 0) {
        tables(() =>
          rowWrites.writeGroups({
            groups: Int32Array.from(groupRefs),
            fields: new Map(),
            deleted: new Uint8Array(groupRefs.length).fill(1),
          }),
        );
      }
      tables(() => rowWrites.clear());
      // The tables keep no deleted row any more: the tokens keep nothing. The ids of the rows taken
      // out are forgotten once the operation ends, but those that come back
      const keptWritten = forgetKept(kept);
      forgetWhenOperationEnds(changes, [...rows.values(), ...keptWritten]);
      document.layers.clear();
      document.groups.clear();
      document.files.clear();
      document.layerPositions.clear();
      document.layerOrder = Object.freeze([]);
      document.metadata = Object.freeze({});
    });

  const createLayer: Store['createLayer'] = (layer, options) =>
    write(changes, 'createLayer', () => {
      const what = 'createLayer';
      if (!isObject(layer) || !isId(layer.id)) invalid(`${what}: the layer has no id`);
      let valuesPerPosition: 2 | 3 | 4 = 2;
      let thirdValue: 'height' | 'measure' = 'height';
      if (options !== undefined) {
        if (!isObject(options)) invalid(`${what}: the options are not an object`);
        const given = options as { valuesPerPosition?: unknown; thirdValue?: unknown };
        if (given.valuesPerPosition !== undefined) {
          if (
            given.valuesPerPosition !== 2 &&
            given.valuesPerPosition !== 3 &&
            given.valuesPerPosition !== 4
          ) {
            invalid(
              `${what}: ${String(given.valuesPerPosition)} is not a number of values of a position (2, 3 or 4)`,
            );
          }
          valuesPerPosition = given.valuesPerPosition;
        }
        if (given.thirdValue !== undefined) {
          if (given.thirdValue !== 'height' && given.thirdValue !== 'measure') {
            invalid(`${what}: the third value is neither height nor measure`);
          }
          thirdValue = given.thirdValue;
        }
      }
      if (document.layers.has(layer.id) || document.groups.has(layer.id)) return false;
      const created = frozenLayer(layer);
      // How its positions are held, read by the tables before its first row
      document.layerPositions.set(created.id, Object.freeze({ valuesPerPosition, thirdValue }));
      document.layers.set(created.id, created);
      addLayerCreated(changes, created);
      const previous = document.layerOrder;
      if (!previous.includes(created.id)) {
        document.layerOrder = Object.freeze([...previous, created.id]);
      }
      addOrderChanged(changes, document.layerOrder, previous);
      return true;
    });

  const updateLayer: Store['updateLayer'] = (id, updates) =>
    write(changes, 'updateLayer', () => {
      const previous = document.layers.get(id);
      if (!previous) notFound(`updateLayer: no layer has the id ${JSON.stringify(id)}`);
      if (!isObject(updates)) invalid('updateLayer: the updates are not an object');
      const layer = frozenLayer({ ...previous, ...updates, id });
      document.layers.set(id, layer);
      // The rows drawn change when the layer is hidden or shown
      if ((layer.visible === false) !== (previous.visible === false)) {
        document.layerVisibilityRevision += 1;
      }
      addLayerUpdated(changes, layer, previous);
      return true;
    });

  const deleteLayer: Store['deleteLayer'] = (id) =>
    write(changes, 'deleteLayer', () => {
      const layer = document.layers.get(id);
      if (!layer) notFound(`deleteLayer: no layer has the id ${JSON.stringify(id)}`);
      // Its rows are deleted in one write, then its groups
      const batches: Int32Array[] = [];
      let length = 0;
      for (const batch of tables(() => document.rows.scan({ tableIds: [id] }))) {
        batches.push(batch);
        length += batch.length;
      }
      if (length > 0) {
        const refs = new Int32Array(length);
        let at = 0;
        for (const batch of batches) {
          refs.set(batch, at);
          at += batch.length;
        }
        readValuesBefore(changes, refs, ['deleted']);
        const deleted = new Uint8Array(length).fill(1);
        const tablesToken = tablesTokenOf(changes);
        const written = tables(() =>
          rowWrites.writeRows(
            { rows: refs, fields: new Map(), deleted },
            tablesToken === undefined ? undefined : { restoreToken: tablesToken },
          ),
        );
        markDeletionWritten(changes, refs, deleted);
        forgetWhenTold(changes, refs);
        addRows(changes, written.rows);
        countWork(counts, 'rowsWritten', length);
      }
      const groups = [...document.groups.values()].filter((group) => group.layerId === id);
      const groupRefs: number[] = [];
      for (const group of groups) {
        const ref = tables(() => document.rows.getGroupRef(group.id));
        if (ref !== undefined) groupRefs.push(ref);
        document.groups.delete(group.id);
        addGroupDeleted(changes, group);
      }
      if (groupRefs.length > 0) {
        writeGroups(
          Int32Array.from(groupRefs),
          new Map(),
          new Uint8Array(groupRefs.length).fill(1),
        );
      }
      document.layers.delete(id);
      document.layerPositions.delete(id);
      addLayerDeleted(changes, layer);
      const previous = document.layerOrder;
      if (previous.includes(id)) {
        document.layerOrder = Object.freeze(previous.filter((entry) => entry !== id));
      }
      addOrderChanged(changes, document.layerOrder, previous);
      return true;
    });

  const setLayerOrder: Store['setLayerOrder'] = (order) =>
    write(changes, 'setLayerOrder', () => {
      if (!Array.isArray(order)) invalid('setLayerOrder: the order is not an array');
      const previous = document.layerOrder;
      // What cannot be an entry is dropped: a value that is not a non-empty string, and an entry
      // given again after its first place
      document.layerOrder = Object.freeze([...new Set(order.filter(isId))]);
      addOrderChanged(changes, document.layerOrder, previous);
      return true;
    });

  const createGroup: Store['createGroup'] = (group) =>
    write(changes, 'createGroup', () => {
      const what = 'createGroup';
      if (!isObject(group) || !isId(group.id)) invalid(`${what}: the group has no id`);
      if (typeof group.layerId !== 'string')
        invalid(`${what}: the layer of the group is not an id`);
      if (!isId(group.orderKey)) invalid(`${what}: the key of the order is not a non-empty string`);
      const { id } = group;
      if (document.groups.has(id) || document.layers.has(id) || isRowInUse(id)) return false;
      if (!document.layers.has(group.layerId)) return false;
      const created: StoreGroup = Object.freeze({ ...group });
      // A group the tables still know by its id (its deleted rows name it) keeps its reference
      let ref = tables(() => document.rows.getGroupRef(id));
      if (ref === undefined) {
        ref = document.nextGroupRef;
        document.nextGroupRef += 1;
      }
      writeGroups(
        Int32Array.of(ref),
        new Map<string, unknown[]>([
          ['id', [id]],
          ['parent', [created.layerId]],
          ['key', [created.orderKey]],
          ['hidden', [created.visible === false]],
        ]),
      );
      document.groups.set(id, created);
      addGroupCreated(changes, created);
      return true;
    });

  const updateGroup: Store['updateGroup'] = (id, updates) =>
    write(changes, 'updateGroup', () => {
      const what = 'updateGroup';
      const previous = document.groups.get(id);
      if (!previous) notFound(`${what}: no group has the id ${JSON.stringify(id)}`);
      if (!isObject(updates)) invalid(`${what}: the updates are not an object`);
      const group: StoreGroup = Object.freeze({ ...previous, ...updates, id });
      if (typeof group.layerId !== 'string')
        invalid(`${what}: the layer of the group is not an id`);
      if (group.layerId !== previous.layerId && !document.layers.has(group.layerId)) {
        notFound(`${what}: no layer has the id ${JSON.stringify(group.layerId)}`);
      }
      if (!isId(group.orderKey)) invalid(`${what}: the key of the order is not a non-empty string`);
      // What the tables hold of the group: its layer (its members go with it), its key, whether
      // it is visible
      const fields = new Map<string, unknown[]>();
      if (group.layerId !== previous.layerId) fields.set('parent', [group.layerId]);
      if (group.orderKey !== previous.orderKey) fields.set('key', [group.orderKey]);
      if ((group.visible === false) !== (previous.visible === false)) {
        fields.set('hidden', [group.visible === false]);
      }
      if (fields.size > 0) {
        const ref = tables(() => document.rows.getGroupRef(id));
        // The members that go with it to the other layer are written their parent: the values
        // before have it
        if (ref !== undefined && fields.has('parent') && readsValuesBefore(changes)) {
          const view = tables(() => document.rows.get(previous.layerId));
          const count = tables(() => view?.countGroupMembers(ref) ?? 0);
          if (view && count > 0) {
            const members = tables(() => view.listGroupMembers(ref, 0, count));
            countWork(counts, 'rowsTouched', members.length);
            readValuesBefore(changes, members, ['parent']);
          }
        }
        if (ref !== undefined) writeGroups(Int32Array.of(ref), fields);
      }
      document.groups.set(id, group);
      addGroupUpdated(changes, group, previous);
      return true;
    });

  const deleteGroup: Store['deleteGroup'] = (id) =>
    write(changes, 'deleteGroup', () => {
      const group = document.groups.get(id);
      if (!group) notFound(`deleteGroup: no group has the id ${JSON.stringify(id)}`);
      const ref = tables(() => document.rows.getGroupRef(id));
      // A row that is not deleted still names it: its members are not moved
      if (ref !== undefined) {
        const members = tables(() => document.rows.get(group.layerId)?.countGroupMembers(ref) ?? 0);
        if (members > 0) return false;
        writeGroups(Int32Array.of(ref), new Map(), Uint8Array.of(1));
      }
      document.groups.delete(id);
      addGroupDeleted(changes, group);
      return true;
    });

  const createFile: Store['createFile'] = (file) =>
    write(changes, 'createFile', () => {
      if (
        !isObject(file) ||
        !isId(file.id) ||
        typeof file.mimeType !== 'string' ||
        typeof file.dataURL !== 'string'
      ) {
        invalid('createFile: the file is not an id, a MIME type and a data URL');
      }
      if (document.files.has(file.id)) return false;
      const created: FileData = Object.freeze({ ...file });
      document.files.set(created.id, created);
      addFileCreated(changes, created);
      return true;
    });

  const deleteFile: Store['deleteFile'] = (id) =>
    write(changes, 'deleteFile', () => {
      const file = document.files.get(id);
      if (!file) notFound(`deleteFile: no file has the id ${JSON.stringify(id)}`);
      document.files.delete(id);
      addFileDeleted(changes, file);
      return true;
    });

  const setMetadata: Store['setMetadata'] = (metadata) =>
    write(changes, 'setMetadata', () => {
      if (!isObject(metadata)) invalid('setMetadata: the metadata is not an object');
      const previous = document.metadata;
      const next: Record<string, unknown> = { ...previous };
      const keys = Object.keys(metadata);
      // Every key is kept as it is given, a key without a prefix included; undefined takes it off
      for (const key of keys) {
        const value = (metadata as Record<string, unknown>)[key];
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      document.metadata = Object.freeze(next) as Metadata;
      addMetadata(changes, document.metadata, previous, keys);
      return true;
    });

  /**
   * Lets go of a token of the tables, and forgets the ids of the rows the writes gave it that
   * nothing keeps any more (once the change is told, while a transaction is under way or told)
   */
  const releaseTablesToken: ReleaseTablesToken = (tablesToken, written) => {
    tables(() => rowWrites.release(tablesToken));
    for (const rows of written) forgetWhenTold(changes, rows);
  };

  return {
    createRows,
    createRowsFromPages: createRowsFromPagesOf(document),
    writeRows,
    clear,
    createLayer,
    updateLayer,
    deleteLayer,
    setLayerOrder,
    createGroup,
    updateGroup,
    deleteGroup,
    createFile,
    deleteFile,
    setMetadata,
    releaseDeletedRows: (token) => releaseToken(kept, token, releaseTablesToken),
    newOperationId: () => newOperationId(changes),
    subscribe: (listener, options) => subscribe(changes, listener, options),
    transact: (fn, source, options) => transact(changes, fn, source, options),
  };
}
