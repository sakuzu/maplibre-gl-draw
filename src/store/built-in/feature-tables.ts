// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tables of the built-in Store as the Store hands them out (`FeatureTables`, and a
 * `LayerTableView` per layer): the reads of the rows of the tables of the document, in the words
 * of the features.
 *
 * Each read reads only what it is asked for, from the rows it is given or finds: no feature, and
 * no object per row, is made. A row is named by its reference, which the tables give it and keep
 * whatever group, layer or place it moves to. The numbers of the work count the rows each read
 * touches and the objects it hands out.
 *
 * A deleted row is read while something keeps it (see `kept-rows.ts`); one that nothing keeps is
 * not there for any read, by its reference or by its id, though the tables hold it until its page
 * is built again, and the references of the rows of a layer leave out every deleted row. The rows
 * of a hidden layer are not drawn.
 *
 * A key of the style (`style:<key>`) is read from the style of the row, the one object the rows of
 * the same style share in the tables: its value there, or undefined when it does not hold the key.
 *
 * An error of the tables is thrown as a `DrawError` of the same code.
 *
 * @internal
 */

import { KasaneError, type RowField, type TableView } from '@sakuzu/kasane';
import type { FeatureStyle, FeatureType } from '../../api/model.js';
import { DrawError } from '../../shared/errors.js';
import { countWork, type WorkCounts } from '../../shared/work-counts.js';
import { layerOfParent, positionsOf, type StoreDocument } from './document.js';
import { geometryColumnOf } from './geometry-column.js';
import { isKept } from './kept-rows.js';
import type {
  FeatureRowField,
  FeatureTables,
  ItemRefs,
  LayerTableView,
  RowCursor,
  RowRef,
  RowValues,
  TableScanOptions,
} from './types.js';

/** The fields of a row read as they are named in the tables, by their names here */
const PLAIN_FIELDS: ReadonlyMap<string, string> = new Map([
  ['type', 'type'],
  ['locked', 'locked'],
  ['style', 'style'],
  ['parent', 'parent'],
  ['orderKey', 'key'],
]);

/** The start of the fields of the attributes */
const PROPERTY_FIELD = 'properties:';

/** The start of the fields of the keys of the style */
const STYLE_KEY_FIELD = 'style:';

/** The number of references of a layer read at a time to leave the deleted rows out */
const ROW_BATCH = 1024;

/**
 * Runs a read of the tables, throwing an error of the tables as a `DrawError` of the same code
 */
function read<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof KasaneError) throw new DrawError(error.code, error.message, error);
    throw error;
  }
}

/**
 * The values of one key of the styles of rows: the value each style holds for it, undefined for
 * a row without the key (or without a style). The rows of one style share its object, so the key
 * is looked up once per style
 */
function styleKeyOf(styles: readonly unknown[], key: string): unknown[] {
  const out = new Array<unknown>(styles.length);
  const keyValues = new Map<unknown, unknown>();
  for (let i = 0; i < styles.length; i++) {
    const style = styles[i];
    if (typeof style !== 'object' || style === null) continue;
    if (!keyValues.has(style)) {
      keyValues.set(style, Object.getOwnPropertyDescriptor(style, key)?.value);
    }
    out[i] = keyValues.get(style);
  }
  return out;
}

/**
 * What a read of values of rows reads besides their fields
 *
 * @internal
 */
export interface ReadRowsOptions {
  /** Whether the deletion is read (`RowValues.deleted`) */
  readonly deleted?: boolean;
  /**
   * Whether a deleted row nothing keeps is read as the tables hold it, for the values before of a
   * transaction (it is not there otherwise)
   */
  readonly unkept?: boolean;
}

/**
 * The values the fields given have now, for rows of one layer (see `FeatureTables.readValues`)
 *
 * @param counts - Where the rows touched and the objects made are counted
 * @internal
 */
export function readRowValues(
  document: StoreDocument,
  refs: Int32Array,
  fields: readonly FeatureRowField[],
  options: ReadRowsOptions,
  counts: readonly WorkCounts[],
): RowValues {
  // The fields of the tables, in the order asked, and how each is read back; the keys of the
  // style are read from the style
  const asked: string[] = [];
  let geometry = false;
  let styleKeys = false;
  for (const field of fields) {
    const plain = PLAIN_FIELDS.get(field);
    if (plain !== undefined) asked.push(plain);
    else if (field === 'visible') asked.push('hidden');
    else if (field === 'geometry') geometry = true;
    else if (field.startsWith(PROPERTY_FIELD) && field.length > PROPERTY_FIELD.length) {
      asked.push(field);
    } else if (field.startsWith(STYLE_KEY_FIELD) && field.length > STYLE_KEY_FIELD.length) {
      styleKeys = true;
    } else {
      throw new DrawError('invalidInput', `${JSON.stringify(field)} is not a field of a row`);
    }
  }
  if (styleKeys && !asked.includes('style')) asked.push('style');
  // The deletion is read to leave out the deleted rows nothing keeps
  const found = document.rows.readValues(
    refs,
    ['parent', ...asked, ...(geometry ? ['geometry'] : []), 'deleted'],
    geometry ? { shapes: 'columns' } : undefined,
  );
  for (const list of counts) countWork(list, 'rowsTouched', refs.length);
  const deletion = found.deleted ?? new Uint8Array(refs.length);
  const shapes = found.shapes?.get('geometry');
  if (!options.unkept) {
    // A deleted row that nothing keeps is not there
    for (let i = 0; i < refs.length; i++) {
      if (deletion[i] === 0 || isKept(document.changes.kept, refs[i])) continue;
      for (const list of found.fields.values()) (list as unknown[])[i] = undefined;
      if (shapes) shapes.formIndex[i] = -1;
    }
  }

  // The rows are those of one layer
  let layerId: string | undefined;
  const parents = found.fields.get('parent') ?? [];
  for (let i = 0; i < parents.length; i++) {
    const layer = layerOfParent(document, parents[i]);
    if (layer === undefined) continue;
    if (layerId === undefined) layerId = layer;
    else if (layer !== layerId) {
      throw new DrawError(
        'invalidInput',
        `readValues: the rows are in more than one layer (${JSON.stringify(layerId)} and ${JSON.stringify(layer)})`,
      );
    }
  }

  const out = new Map<FeatureRowField, readonly unknown[]>();
  for (const field of fields) {
    if (field === 'geometry' || out.has(field)) continue;
    if (field === 'visible') {
      const hidden = found.fields.get('hidden') ?? [];
      const visible = new Array<unknown>(hidden.length);
      for (let i = 0; i < hidden.length; i++) {
        visible[i] = hidden[i] === undefined ? undefined : hidden[i] !== true;
      }
      out.set(field, visible);
    } else if (field.startsWith(STYLE_KEY_FIELD) && field.length > STYLE_KEY_FIELD.length) {
      out.set(
        field,
        styleKeyOf(found.fields.get('style') ?? [], field.slice(STYLE_KEY_FIELD.length)),
      );
    } else {
      out.set(field, found.fields.get(PLAIN_FIELDS.get(field) ?? field) ?? []);
    }
  }
  const valuesPerPosition =
    layerId === undefined ? 2 : positionsOf(document, layerId).valuesPerPosition;
  const values: RowValues = {
    rows: found.rows,
    fields: out,
    ...(geometry && {
      geometry: geometryColumnOf(shapes, refs.length, valuesPerPosition),
    }),
    ...(options.deleted && { deleted: deletion }),
  };
  // The values, the map of the fields and an array per field; the geometry and its arrays
  for (const list of counts) {
    countWork(list, 'objectsCreated', 2 + out.size + (geometry ? 6 : 0));
  }
  return values;
}

/**
 * The rows given that are there: those that are not deleted, and the deleted rows kept (the rows
 * given themselves when every one is)
 */
function rowsThere(document: StoreDocument, rows: Int32Array): Int32Array {
  const deleted = document.rows.readValues(rows, ['deleted']).deleted;
  countWork(document.counts, 'rowsTouched', rows.length);
  countWork(document.counts, 'objectsCreated', 3);
  if (!deleted) return rows;
  const { kept } = document.changes;
  let gone = 0;
  for (let i = 0; i < rows.length; i++) {
    if (deleted[i] !== 0 && !isKept(kept, rows[i])) gone++;
  }
  if (gone === 0) return rows;
  const out = new Int32Array(rows.length - gone);
  countWork(document.counts, 'objectsCreated');
  let at = 0;
  for (let i = 0; i < rows.length; i++) {
    if (deleted[i] === 0 || isKept(kept, rows[i])) out[at++] = rows[i];
  }
  return out;
}

/**
 * The keys of the attributes rows hold, each once (see `StoreView.listPropertyKeys`): of the rows
 * given, the deleted rows kept included, or of every row of the document that is not deleted. A
 * deleted row nothing keeps holds none. The tables list them without an object per row
 *
 * @internal
 */
export function listPropertyKeysOf(document: StoreDocument, rows?: Int32Array): string[] {
  if (rows !== undefined && !(rows instanceof Int32Array)) {
    throw new DrawError(
      'invalidInput',
      'listPropertyKeys: the rows are not an Int32Array of references',
    );
  }
  return read(() => {
    const keys = document.rows.listKeys(
      'properties',
      rows && rows.length > 0 ? rowsThere(document, rows) : rows,
    );
    if (rows) countWork(document.counts, 'rowsTouched', rows.length);
    countWork(document.counts, 'objectsCreated');
    return keys;
  });
}

/**
 * The tables of the rows of a document, as the Store hands them out
 *
 * @internal
 */
export function featureTablesOf(document: StoreDocument): FeatureTables {
  const { rows, rowWrites, counts } = document;
  const { kept } = document.changes;
  const views = new WeakMap<TableView, LayerTableView>();

  /** Whether a row read with its deletion is there: not deleted, or deleted and kept */
  const isThere = (ref: RowRef, deleted: Uint8Array | undefined): boolean =>
    !deleted?.[0] || isKept(kept, ref);

  /**
   * The values of fields of one row, read alone, with the layer it is in (undefined for a row
   * that is not there, a deleted row nothing keeps included)
   */
  const readRow = (ref: RowRef, fields: readonly RowField[], geometry = false) => {
    const values = rows.readValues(
      Int32Array.of(ref),
      ['parent', ...fields, 'deleted'],
      geometry ? { shapes: 'columns' } : undefined,
    );
    countWork(counts, 'rowsTouched');
    const there = isThere(ref, values.deleted);
    return {
      layerId: there ? layerOfParent(document, values.fields.get('parent')?.[0]) : undefined,
      values,
    };
  };

  const viewOf = (view: TableView): LayerTableView => {
    const layerId = view.tableId;
    const touched = (refs: Int32Array): Int32Array => {
      countWork(counts, 'rowsTouched', refs.length);
      return refs;
    };
    /**
     * `count` rows from the `start`-th one, the deleted rows left out: the references the tables
     * hold, read a batch at a time from the first one to leave out the deleted rows among them,
     * when there are deleted rows the tables still hold
     */
    const listRowRefs = (view: TableView, start: number, count: number): Int32Array => {
      const held = view.rowCountWithDeleted;
      const rowCount = view.rowCount;
      if (held === rowCount) return touched(view.listRowRefs(start, count));
      const from = Math.max(0, Math.floor(start));
      const out = new Int32Array(Math.max(0, Math.min(Math.floor(count), rowCount - from)));
      let seen = 0;
      let at = 0;
      for (let next = 0; next < held && at < out.length; next += ROW_BATCH) {
        const batch = view.listRowRefs(next, ROW_BATCH);
        const deleted = rows.readValues(batch, ['deleted']).deleted ?? new Uint8Array(0);
        countWork(counts, 'rowsTouched', batch.length);
        for (let i = 0; i < batch.length && at < out.length; i++) {
          if (deleted[i]) continue;
          if (seen >= from) out[at++] = batch[i];
          seen += 1;
        }
      }
      return at === out.length ? out : out.slice(0, at);
    };
    return {
      layerId,
      get rowCount() {
        return read(() => view.rowCount);
      },
      get itemCount() {
        return read(() => view.itemCount);
      },
      // The rows of a hidden layer are not drawn
      listDrawnRows: (bbox) =>
        read(() =>
          document.layers.get(layerId)?.visible === false
            ? new Int32Array(0)
            : touched(view.listVisibleRows(bbox)),
        ),
      getDrawnRowsRevision: () =>
        read(() => view.getVisibleRowsVersion() + document.layerVisibilityRevision),
      getRowBBox: (ref) =>
        read(() => {
          if (readRow(ref, []).layerId === undefined) return null;
          return view.getRowBBox(ref);
        }),
      getRowType: (ref) =>
        read(() => {
          const row = readRow(ref, ['type']);
          if (row.layerId !== layerId) return null;
          return (row.values.fields.get('type')?.[0] as FeatureType | undefined) ?? null;
        }),
      getPointPosition: (ref) =>
        read(() => {
          const row = readRow(ref, ['geometry'], true);
          const shapes = row.values.shapes?.get('geometry');
          if (row.layerId !== layerId || !shapes || shapes.formIndex[0] < 0) return null;
          const form = shapes.forms[shapes.formIndex[0]];
          if (form.name !== 'Point' || form.depth !== 0) return null;
          const at = shapes.formRow[0] * shapes.dimensions.length;
          return [form.points[at], form.points[at + 1]];
        }),
      getRowProperty: (ref, key) =>
        read(() => {
          const field = `${PROPERTY_FIELD}${key}`;
          const row = readRow(ref, [field]);
          return row.layerId === layerId ? row.values.fields.get(field)?.[0] : undefined;
        }),
      getRowStyle: (ref) =>
        read(() => {
          const row = readRow(ref, ['style']);
          if (row.layerId !== layerId) return undefined;
          return row.values.fields.get('style')?.[0] as Readonly<FeatureStyle> | undefined;
        }),
      listRowRefs: (start, count) => read(() => listRowRefs(view, start, count)),
      listItemRefs: (start, count): ItemRefs =>
        read(() => {
          const items = view.listItems(start, count);
          countWork(counts, 'rowsTouched', items.refs.length);
          countWork(counts, 'objectsCreated');
          return { kinds: items.types, refs: items.refs };
        }),
      countGroupMembers: (groupRef) => read(() => view.countGroupMembers(groupRef)),
      listGroupMembers: (groupRef, start, count) =>
        read(() => touched(view.listGroupMembers(groupRef, start, count))),
    };
  };

  const readValues: FeatureTables['readValues'] = (refs, fields, options) =>
    read(() => readRowValues(document, refs, fields, options ?? {}, [counts]));

  return {
    get: (layerId) =>
      read(() => {
        const view = rows.get(layerId);
        if (!view) return undefined;
        let out = views.get(view);
        if (!out) {
          out = viewOf(view);
          views.set(view, out);
        }
        return out;
      }),
    getRowRef: (id) => read(() => rows.getRowRef(id)),
    // A deleted row is found while something keeps it
    findRow: (id) =>
      read(() => {
        const row = rowWrites.lookup(id);
        countWork(counts, 'rowsTouched');
        if (!row || (row.deleted && !isKept(kept, row.row))) return undefined;
        return { ref: row.row, deleted: row.deleted };
      }),
    getRowId: (ref) => read(() => rows.getRowId(ref)),
    findGroup: (id) => read(() => rows.getGroupRef(id)),
    getGroupId: (groupRef) => read(() => rows.getGroupId(groupRef)),
    getValuesPerPosition: (layerId) =>
      document.layers.has(layerId) ? positionsOf(document, layerId).valuesPerPosition : undefined,
    getThirdValue: (layerId) => {
      if (!document.layers.has(layerId)) return undefined;
      const positions = positionsOf(document, layerId);
      if (positions.valuesPerPosition === 2) return undefined;
      return positions.valuesPerPosition === 4 ? 'height' : positions.thirdValue;
    },
    scan: (options?: TableScanOptions): RowCursor =>
      read(() => {
        const batches = rows.scan({
          ...(options?.layerIds && { tableIds: options.layerIds }),
          ...(options?.bbox && { bbox: options.bbox }),
          ...(options?.batchSize !== undefined && { batchSize: options.batchSize }),
        });
        return {
          next: () =>
            read(() => {
              const batch = batches.next();
              if (batch.done) return null;
              countWork(counts, 'rowsTouched', batch.value.length);
              return batch.value;
            }),
        };
      }),
    readValues,
  };
}
