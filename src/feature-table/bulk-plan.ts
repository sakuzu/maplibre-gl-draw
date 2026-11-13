// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The writes of the operations on a selection of many rows
 *
 * An operation on many rows selected is planned here as a write of this client (`RowWrite`): the
 * values of the rows, where they go, and the values they had before (read before anything is
 * written). Nothing is written here: the Store writes it (`Store.applyRows`), after recording it,
 * and makes the keys of the order of the rows put in a place.
 *
 * A change of the style is made once per kind of row (its type, its style and its created zoom),
 * not once per row: a map has few styles, so a hundred thousand rows ask for a few patches.
 */

import type { RowRef } from '@sakuzu/kasane';
import type { RowGroup, RowPlace } from '@sakuzu/kasane/render';
import { type PageDictionary, type PageValues, ROW_FLAG_DELETED } from '@sakuzu/kasane/render';
import type { RowWrite } from '../api/tables.js';
import { drawPropertyKey } from '../shared/properties.js';
import type {
  FeatureStyle,
  FeatureType,
  ItemPlacement,
  RowField,
  RowValues,
} from '../shared/types/model.js';
import {
  isGroupLocked,
  ROW_FLAG_LOCKED,
  STYLE_COLUMN,
  TYPE_COLUMN,
  typeColumnOf,
} from '../table/feature-row-columns.js';
import type { RowContainers } from './bulk-rows.js';
import { isRowLocked, livePlaceOf, rowsByLayerInOrder } from './bulk-rows.js';
import type { FeatureTablesInternals } from './feature-tables.js';
import { rowGeometry, rowNumber, rowType, rowValue } from './row-read.js';
import type { TableSelection } from './selection.js';

/** The key of the created zoom in the attributes of a row */
const CREATED_ZOOM_KEY = drawPropertyKey('createdZoom');

/**
 * What the change of the style of a kind of row is made from: its type, its own style and the
 * zoom it was created at
 *
 * @internal
 */
export interface RowStyleSample {
  readonly type: FeatureType;
  readonly style: Readonly<FeatureStyle>;
  readonly createdZoom: number | undefined;
}

/**
 * A change of a kind of row: the keys of its style and its attributes merged (a key given
 * `undefined` taken off), shown and locked
 *
 * @internal
 */
export interface RowUpdate {
  readonly style?: Readonly<Record<string, unknown>>;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly visible?: boolean;
  readonly locked?: boolean;
}

/**
 * Reads the values of a row a write of each row is made from
 *
 * @internal
 */
export interface BulkRowReader {
  readonly place: RowPlace;
  type(): FeatureType;
  geometry(): unknown;
  value(key: string): unknown;
}

/**
 * An operation on the rows of a selection of many rows
 *
 * - `delete`: the rows not locked are deleted
 * - `update`: a change made once per kind of row (`RowStyleSample`), written to every row of the
 *   kind; a locked row is left as it is, unless the change is of `locked` or `visible` only
 * - `rows`: values of fields made per row from its values (a move, a rotation, a resize); a locked
 *   row is left as it is
 * - `place`: the rows put in a place, in their order (another layer, a group)
 *
 * @internal
 */
export type BulkOperation =
  | { readonly kind: 'delete' }
  | { readonly kind: 'update'; readonly make: (sample: RowStyleSample) => RowUpdate | null }
  | {
      readonly kind: 'rows';
      readonly fields: readonly RowField[];
      /** The values of the fields of a row, in the order of `fields` (null: the row is not written) */
      readonly write: (handle: RowRef, read: BulkRowReader) => readonly unknown[] | null;
    }
  | { readonly kind: 'place'; readonly to: ItemPlacement };

/**
 * The write of an operation on the rows of a selection (null when it writes nothing, or is
 * refused)
 *
 * @internal
 */
export function planBulk(
  internals: FeatureTablesInternals,
  op: BulkOperation,
  rows: TableSelection,
  containers: RowContainers,
): RowWrite | null {
  switch (op.kind) {
    case 'delete':
      return planDelete(internals, rows, containers);
    case 'update':
      return planUpdate(internals, op.make, rows, containers);
    case 'rows':
      return planRows(internals, op, rows, containers);
    case 'place':
      return planPlace(internals, op.to, rows);
  }
}

function planDelete(
  internals: FeatureTablesInternals,
  rows: TableSelection,
  containers: RowContainers,
): RowWrite | null {
  const handles: number[] = [];
  for (const handle of rows.handles) {
    if (livePlaceOf(internals, handle) && !isRowLocked(internals, containers, handle)) {
      handles.push(handle);
    }
  }
  if (handles.length === 0) return null;
  const patch: RowValues = {
    handles: Int32Array.from(handles),
    fields: new Map(),
    deleted: new Uint8Array(handles.length).fill(1),
  };
  return { patch, before: internals.readRowValues(patch) };
}

function planUpdate(
  internals: FeatureTablesInternals,
  make: (sample: RowStyleSample) => RowUpdate | null,
  rows: TableSelection,
  containers: RowContainers,
): RowWrite | null {
  // The kind of each row: the number of its style, its type, its created zoom. The rows are read
  // once each, without a string or a list made per row
  const handlesIn = rows.handles;
  const kindAt = new Int32Array(handlesIn.length).fill(-1);
  const lockedAt = new Uint8Array(handlesIn.length);
  /** The kinds of row (a type, a style and a created zoom) of the selection */
  const kinds: RowStyleSample[] = [];
  /** The kinds by the type and the number of the style (their created zooms apart) */
  const kindsByType: number[][][] = [];
  /** The number of each type met, and the numbers of the types of the group of the row before */
  const typeIds = new Map<string, number>();
  let typesOf: RowGroup['data'] | null = null;
  let typeIdOf: number[] = [];
  const isLocked = lockReader(internals, containers);
  for (let j = 0; j < handlesIn.length; j++) {
    const place = internals.placeOf(handlesIn[j]);
    if (!place) continue;
    const { group, row } = place;
    const data = group.data;
    if ((data.flags[row] & ROW_FLAG_DELETED) !== 0) continue;
    if (isLocked(place)) lockedAt[j] = 1;
    if (data !== typesOf) {
      typesOf = data;
      typeIdOf = (typeColumnOf(data).values as readonly string[]).map((name) => {
        let id = typeIds.get(name);
        if (id === undefined) {
          id = typeIds.size;
          typeIds.set(name, id);
        }
        return id;
      });
    }
    const typeId = typeIdOf[(data.wholes[TYPE_COLUMN] as PageValues).indexes[row]];
    const createdZoom = rowNumber(group, row, CREATED_ZOOM_KEY);
    const styleNumber = (data.wholes[STYLE_COLUMN] as PageDictionary).indexes[row];
    let ofType = kindsByType[typeId];
    if (!ofType) {
      ofType = [];
      kindsByType[typeId] = ofType;
    }
    let ofKey = ofType[styleNumber];
    if (!ofKey) {
      ofKey = [];
      ofType[styleNumber] = ofKey;
    }
    let k = -1;
    for (let c = 0; c < ofKey.length; c++) {
      if (kinds[ofKey[c]].createdZoom === createdZoom) {
        k = ofKey[c];
        break;
      }
    }
    if (k < 0) {
      k = kinds.length;
      const type = rowType(data, row);
      kinds.push({ type, style: internals.styles.get(styleNumber), createdZoom });
      ofKey.push(k);
    }
    kindAt[j] = k;
  }
  const updates: Array<RowUpdate | null> = kinds.map((kind) => make(kind));
  // A locked row takes no change other than of its lock and its visibility (as features.update):
  // it is left as it is, and the others are written
  const leavesLocked = updates.map(
    (update) => update?.style !== undefined || update?.properties !== undefined,
  );
  const writes = (j: number): boolean => {
    const k = kindAt[j];
    return k >= 0 && updates[k] !== null && !(lockedAt[j] === 1 && leavesLocked[k]);
  };
  const counts = new Int32Array(kinds.length);
  for (let j = 0; j < handlesIn.length; j++) if (writes(j)) counts[kindAt[j]]++;
  // The fields written: the style, the attributes, shown, locked
  const fieldNames = new Set<RowField>();
  for (let k = 0; k < kinds.length; k++) {
    const update = updates[k];
    if (!update || counts[k] === 0) continue;
    if (update.style !== undefined) fieldNames.add('style');
    for (const key of Object.keys(update.properties ?? {})) fieldNames.add(`properties:${key}`);
    if (update.visible !== undefined) fieldNames.add('hidden');
    if (update.locked !== undefined) fieldNames.add('locked');
  }
  // The rows written, kind after kind (in the order the kinds were met), each kind in the order
  // of the selection
  const offsets = new Int32Array(kinds.length);
  let total = 0;
  for (let k = 0; k < kinds.length; k++) {
    offsets[k] = total;
    total += counts[k];
  }
  if (total === 0) return null;
  const handles = new Int32Array(total);
  const kindOf = new Int32Array(total);
  for (let j = 0; j < handlesIn.length; j++) {
    if (!writes(j)) continue;
    const k = kindAt[j];
    const at = offsets[k]++;
    handles[at] = handlesIn[j];
    kindOf[at] = k;
  }
  const fields = new Map<RowField, unknown[]>();
  // The values before (what an undo writes back)
  const current: RowValues = internals.readRowValues({
    handles,
    fields: new Map([...fieldNames].map((field) => [field, []])),
  });
  for (const field of fieldNames) {
    const values = new Array<unknown>(total);
    const before = current.fields.get(field) as readonly unknown[];
    // The rows of a kind have the same style: it is merged once, and the rows share the result
    // (the Store makes it canonical once)
    const styleOfKind = field === 'style' ? new Array<unknown>(kinds.length) : null;
    for (let i = 0; i < total; i++) {
      const k = kindOf[i];
      const update = updates[k] as RowUpdate;
      if (styleOfKind) {
        let style = styleOfKind[k];
        if (style === undefined) {
          style = updatedValue(field, update, before[i]);
          styleOfKind[k] = style;
        }
        values[i] = style;
      } else {
        values[i] = updatedValue(field, update, before[i]);
      }
    }
    fields.set(field, values);
  }
  const patch: RowValues = { handles, fields };
  return { patch, before: current };
}

/** The value a field of a row takes from a change (the value it had for a field it leaves) */
function updatedValue(field: RowField, update: RowUpdate, before: unknown): unknown {
  if (field === 'style') {
    return update.style === undefined ? before : merged(before as object, update.style);
  }
  if (field === 'hidden') return update.visible === undefined ? before : update.visible === false;
  if (field === 'locked') return update.locked ?? before;
  const key = field.slice('properties:'.length);
  const properties = update.properties;
  return properties && Object.keys(properties).includes(key) ? properties[key] : before;
}

/** The keys of `base` with the keys of `patch` set, and taken off where they are undefined */
function merged(base: object, patch: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base ?? {})) {
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete result[key];
    else {
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return result;
}

/**
 * Whether a row is locked (as `isRowLocked`), with the lock of its group and of its layer read
 * once per group and per layer
 */
function lockReader(
  internals: FeatureTablesInternals,
  containers: RowContainers,
): (place: RowPlace) => boolean {
  const groups = new Map<number, boolean>();
  const layers = new Map<string, boolean>();
  return (place) => {
    const data = place.group.data;
    if ((data.flags[place.row] & ROW_FLAG_LOCKED) !== 0) return true;
    const group = data.groups[place.row];
    if (group >= 0) {
      let groupLocked = groups.get(group);
      if (groupLocked === undefined) {
        groupLocked = isGroupLocked(internals.groups, group);
        groups.set(group, groupLocked);
      }
      if (groupLocked) return true;
    }
    const layerId = place.table.tableId;
    let layerLocked = layers.get(layerId);
    if (layerLocked === undefined) {
      layerLocked = containers.layerLocked(layerId);
      layers.set(layerId, layerLocked);
    }
    return layerLocked;
  };
}

function planRows(
  internals: FeatureTablesInternals,
  op: Extract<BulkOperation, { kind: 'rows' }>,
  rows: TableSelection,
  containers: RowContainers,
): RowWrite | null {
  const handles: number[] = [];
  const columns = op.fields.map(() => [] as unknown[]);
  for (const handle of rows.handles) {
    const place = livePlaceOf(internals, handle);
    if (!place || isRowLocked(internals, containers, handle)) continue;
    const values = op.write(handle, readerOf(internals, place));
    if (!values) continue;
    handles.push(handle);
    for (let f = 0; f < columns.length; f++) columns[f].push(values[f]);
  }
  if (handles.length === 0) return null;
  const patch: RowValues = {
    handles: Int32Array.from(handles),
    fields: new Map(op.fields.map((field, f) => [field, columns[f]])),
  };
  return { patch, before: internals.readRowValues(patch) };
}

/** The reader of the values of a row */
function readerOf(internals: FeatureTablesInternals, place: RowPlace): BulkRowReader {
  const { group, row } = place;
  return {
    place,
    type: () => rowType(group.data, row),
    geometry: () => rowGeometry(group, row) ?? undefined,
    value: (key) => rowValue(group, row, key, internals.strings),
  };
}

function planPlace(
  internals: FeatureTablesInternals,
  to: ItemPlacement,
  rows: TableSelection,
): RowWrite | null {
  // The rows go there in the order of their layers, the layers in the order of the set
  const ordered: number[] = [];
  for (const handles of rowsByLayerInOrder(internals, rows).values()) ordered.push(...handles);
  if (ordered.length === 0) return null;
  const patch: RowValues = { handles: new Int32Array(0), fields: new Map() };
  return {
    patch,
    place: { rows: Int32Array.from(ordered), to },
    before: patch,
  };
}
