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
 * Nothing is made per row.
 *
 * @internal
 */

import { KasaneError, type RowValues as TablesRowValues } from '@sakuzu/kasane';
import type { FileData, Layer, Metadata } from '../../api/model.js';
import { DrawError } from '../../shared/errors.js';
import { countWork } from '../../shared/work-counts.js';
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
  newOperationId,
  subscribe,
  transact,
  write,
} from './changes.js';
import { dimensionsOfPositions, positionsOf, type StoreDocument } from './document.js';
import { shapeValuesOf } from './shape-values.js';
import type {
  FeatureRowField,
  GeometryColumn,
  NewRows,
  RowValues,
  Store,
  StoreGroup,
} from './types.js';
import { fieldKind, validateRowValues } from './validate.js';

/** The type of a row without a geometry, in `GeometryColumn.types` */
const NO_TYPE = 255;

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
 * Throws unless the fields of a write of rows are fields it writes: the fields of a row, the keys
 * of the style excepted (`style:<key>` is not written on its own yet), and not the geometry,
 * which is given as a column
 */
function checkFields(
  what: string,
  fields: unknown,
): asserts fields is ReadonlyMap<FeatureRowField, readonly unknown[]> {
  if (!(fields instanceof Map)) invalid(`${what}: the fields are not a Map`);
  for (const field of fields.keys()) {
    if (field === 'geometry') {
      invalid(`${what}: the geometries are given as a GeometryColumn (geometry), not as a field`);
    }
    const kind = typeof field === 'string' ? fieldKind(field) : null;
    if (kind === null) invalid(`${what}: ${JSON.stringify(field)} is not a field of a row`);
    if (kind === 'style') {
      invalid(
        `${what}: ${JSON.stringify(field)}: a key of the style is not written on its own; write the field style`,
      );
    }
  }
}

/** Throws unless values of rows keep the rules of their fields */
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
      // A lone surrogate is written as the character that replaces it
      if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
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
> {
  const { changes, counts, rowWrites } = document;

  /** Whether an id is that of a row that is not deleted */
  const isLiveRow = (id: string): boolean => {
    const found = tables(() => rowWrites.lookup(id));
    return found !== undefined && !found.deleted;
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

  /** Writes values of rows to the tables, and adds what they wrote to the change */
  const writeTables = (
    rows: Int32Array,
    fields: ReadonlyMap<FeatureRowField, readonly unknown[]>,
    geometry: GeometryColumn | undefined,
    layerId: string,
    deleted: Uint8Array | undefined,
  ): void => {
    const values: TablesRowValues = {
      rows,
      fields: tableFieldsOf(fields),
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
    const written = tables(() => rowWrites.writeRows(values));
    addRows(changes, written.rows);
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

  const createRows: Store['createRows'] = (rows) =>
    write(changes, 'createRows', () => {
      const what = 'createRows';
      if (!isObject(rows) || !Array.isArray(rows.ids)) invalid(`${what}: the rows have no ids`);
      const { ids, fields, geometry } = rows;
      for (const id of ids) if (typeof id !== 'string') invalid(`${what}: an id is not a string`);
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
      // The ids are those of no row and no group, and are not given twice
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id) || document.groups.has(id) || isLiveRow(id)) return false;
        seen.add(id);
      }
      countWork(counts, 'objectsCreated');
      const column = idColumnOf(ids);
      countWork(counts, 'objectsCreated', 3);
      const refs = tables(() => rowWrites.allocateRowRefs(column));
      writeTables(refs, fields, geometry as GeometryColumn, layerId, undefined);
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
      if (rows.length === 0) {
        checkValues(what, values, 2);
        return true;
      }
      // Where the rows are now: rows there, in one layer
      const now = tables(() => document.rows.readValues(rows, ['parent', 'deleted']));
      countWork(counts, 'objectsCreated', 3);
      const parentsNow = now.fields.get('parent') ?? [];
      let layerId: string | undefined;
      for (let i = 0; i < rows.length; i++) {
        if (now.deleted?.[i]) notFound(`${what}: no row has the reference ${rows[i]}`);
        const layer = layerNamed(parentsNow[i]);
        if (layer === undefined) notFound(`${what}: no row has the reference ${rows[i]}`);
        if (layerId === undefined) layerId = layer;
        else if (layer !== layerId) {
          invalid(
            `${what}: the rows are in more than one layer (${JSON.stringify(layerId)} and ${JSON.stringify(layer)})`,
          );
        }
      }
      const layer = layerId as string;
      const parents = fields.get('parent');
      if (parents !== undefined && !Array.isArray(parents))
        invalid(`${what}: parent is not an array`);
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
      writeTables(rows, fields, geometry, layerNamed(parents?.[0]) ?? layer, deleted);
      return true;
    });

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
      if (options !== undefined) {
        if (!isObject(options)) invalid(`${what}: the options are not an object`);
        const { valuesPerPosition, thirdValue } = options;
        // The positions of the rows have two values until the tables hold more
        if (valuesPerPosition !== undefined && valuesPerPosition !== 2) {
          invalid(
            `${what}: a layer of ${String(valuesPerPosition)} values per position is not held yet; a layer holds 2`,
          );
        }
        if (thirdValue !== undefined && thirdValue !== 'height' && thirdValue !== 'measure') {
          invalid(`${what}: the third value is neither height nor measure`);
        }
      }
      if (document.layers.has(layer.id) || document.groups.has(layer.id)) return false;
      const created = frozenLayer(layer);
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
        const written = tables(() =>
          rowWrites.writeRows({
            rows: refs,
            fields: new Map(),
            deleted: new Uint8Array(length).fill(1),
          }),
        );
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
      if (document.groups.has(id) || document.layers.has(id) || isLiveRow(id)) return false;
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

  return {
    createRows,
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
    newOperationId: () => newOperationId(changes),
    subscribe: (listener) => subscribe(changes, listener),
    transact: (fn, source, options) => transact(changes, fn, source, options),
  };
}
