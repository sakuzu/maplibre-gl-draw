// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The writes of the operations on a selection of many rows (11.1 of the design)
 *
 * An operation on many rows selected is planned here as a write of this client (`RowWrite`): the
 * values of the rows, where they go, and the values they had before (read before anything is
 * written). Nothing is written here: the Store writes it (`Store.applyRows`), after recording it,
 * and makes the keys of the order of the rows put in a place.
 *
 * A change of the style is made once per kind of row (its type, its style and its created zoom),
 * not once per row: a map has few styles, so a hundred thousand rows ask for a few patches.
 */

import type { RowWrite } from '../api/tables.js';
import { drawPropertyKey } from '../shared/properties.js';
import type {
  FeatureStyle,
  FeatureType,
  ItemPlacement,
  RowField,
  RowValues,
} from '../shared/types/model.js';
import type { RowContainers } from './bulk-rows.js';
import { isRowLocked, livePlaceOf, rowsByLayerInOrder } from './bulk-rows.js';
import type { FeatureTablesInternals, RowPlace } from './feature-tables.js';
import { rowGeometry, rowNumber, rowType, rowValue } from './row-read.js';
import type { TableSelection } from './selection.js';
import type { RowHandle } from './types.js';

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
 *   kind; refused (null) when a row is locked and the change is not of `locked` or `visible` only
 * - `rows`: values of fields made per row from its values (a move, a rotation, a resize);
 *   refused when a row is locked (or the row left as it is, with `skipLocked`)
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
      /**
       * Whether a locked row is left as it is rather than refusing the whole (a write made in
       * steps, where a row can be locked from elsewhere between two of them)
       */
      readonly skipLocked?: boolean;
      /** The values of the fields of a row, in the order of `fields` (null: the row is not written) */
      readonly write: (handle: RowHandle, read: BulkRowReader) => readonly unknown[] | null;
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
  return { patch, before: internals.readValues(patch) };
}

/** The values of a kind of row (its type, its style and its created zoom) */
interface Kind {
  readonly sample: RowStyleSample;
  readonly rows: number[];
}

function planUpdate(
  internals: FeatureTablesInternals,
  make: (sample: RowStyleSample) => RowUpdate | null,
  rows: TableSelection,
  containers: RowContainers,
): RowWrite | null {
  // The rows by kind: the number of the style, the type, the created zoom
  const kinds = new Map<string, Kind>();
  let locked = false;
  for (const handle of rows.handles) {
    const place = livePlaceOf(internals, handle);
    if (!place) continue;
    if (isRowLocked(internals, containers, handle)) locked = true;
    const { group, row } = place;
    const data = group.data;
    const type = rowType(data, row);
    const createdZoom = rowNumber(group, row, CREATED_ZOOM_KEY);
    const styleNumber = data.styles[row];
    const key = `${styleNumber}\u0000${type}\u0000${createdZoom ?? ''}`;
    let kind = kinds.get(key);
    if (!kind) {
      kind = {
        sample: { type, style: internals.styles.get(styleNumber), createdZoom },
        rows: [],
      };
      kinds.set(key, kind);
    }
    kind.rows.push(handle);
  }
  const updates = new Map<Kind, RowUpdate>();
  for (const kind of kinds.values()) {
    const update = make(kind.sample);
    if (update) updates.set(kind, update);
  }
  if (updates.size === 0) return null;
  // A locked row refuses a change other than of its lock and its visibility (as features.update)
  if (locked) {
    for (const update of updates.values()) {
      if (update.style !== undefined || update.properties !== undefined) return null;
    }
  }
  // The fields written: the style, the attributes, shown, locked
  const fieldNames = new Set<RowField>();
  for (const update of updates.values()) {
    if (update.style !== undefined) fieldNames.add('style');
    for (const key of Object.keys(update.properties ?? {})) fieldNames.add(`property:${key}`);
    if (update.visible !== undefined) fieldNames.add('visible');
    if (update.locked !== undefined) fieldNames.add('locked');
  }
  const handles: number[] = [];
  const kindOf: Kind[] = [];
  for (const kind of updates.keys()) {
    for (const handle of kind.rows) {
      handles.push(handle);
      kindOf.push(kind);
    }
  }
  const fields = new Map<RowField, unknown[]>();
  const current: RowValues = internals.readValues({
    handles: Int32Array.from(handles),
    fields: new Map([...fieldNames].map((field) => [field, []])),
  });
  for (const field of fieldNames) {
    const values = new Array<unknown>(handles.length);
    const before = current.fields.get(field) as readonly unknown[];
    // The rows of a kind have the same style: it is merged once, and the rows share the result
    // (the Store makes it canonical once)
    const styleOfKind = field === 'style' ? new Map<Kind, unknown>() : null;
    for (let i = 0; i < handles.length; i++) {
      const kind = kindOf[i];
      const update = updates.get(kind) as RowUpdate;
      if (styleOfKind) {
        let style = styleOfKind.get(kind);
        if (style === undefined) {
          style = updatedValue(field, update, before[i]);
          styleOfKind.set(kind, style);
        }
        values[i] = style;
      } else {
        values[i] = updatedValue(field, update, before[i]);
      }
    }
    fields.set(field, values);
  }
  const patch: RowValues = { handles: Int32Array.from(handles), fields };
  return { patch, before: current };
}

/** The value a field of a row takes from a change (the value it had for a field it leaves) */
function updatedValue(field: RowField, update: RowUpdate, before: unknown): unknown {
  if (field === 'style') {
    return update.style === undefined ? before : merged(before as object, update.style);
  }
  if (field === 'visible') return update.visible ?? before;
  if (field === 'locked') return update.locked ?? before;
  const key = field.slice('property:'.length);
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
    if (!place) continue;
    if (isRowLocked(internals, containers, handle)) {
      if (op.skipLocked) continue;
      return null;
    }
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
  return { patch, before: internals.readValues(patch) };
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
