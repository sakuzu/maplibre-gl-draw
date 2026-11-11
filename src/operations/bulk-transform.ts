// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Moving, rotating and scaling the features selected in bulk, written once on their rows
 *
 * The values are computed as the drags of features selected one by one compute them: the edit of
 * the drag (`translate`, `rotate`, `scale`) applied by the computation of the Store
 * (`Store.transforms`, or the one of the library) over the geometry of each row and the fields of
 * its roles (`store/transform-roles.ts`), so the rows end where the same features moved one by one
 * end. A row is not made a feature, and its positions keep their values after `x` and `y` (an
 * elevation, a measure).
 *
 * The rows are written by kind (the geometry alone, with a rotation, with a scale, with a radius),
 * each kind one write of the fields it changes, the writes made in one transaction (one change,
 * one step of the history). The kinds are made apart from their write (`transformKinds`), so that
 * a drag let go writes them in steps (`bulk-sliced.ts`).
 */

import type { Geometry } from 'geojson';
import type { BulkOperation, BulkRowReader } from '../feature-table/bulk-plan.js';
import { livePlaceOf } from '../feature-table/bulk-rows.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { TableSelection } from '../feature-table/selection.js';
import type { Store, TransformEdit } from '../store/store.js';
import {
  type TransformFieldsRegistry,
  transformFieldsOfStore,
  transformRolesOf,
  transformValuesOf,
} from '../store/transform-roles.js';
import type { RowField } from '../store/types.js';
import { transformsOf } from './transform-features.js';

/**
 * The writes of an operation on features selected in bulk, by kind of row: the rows of a kind
 * (ascending) and the operation that writes them
 *
 * @internal
 */
export type BulkKinds = ReadonlyArray<{
  readonly rows: readonly number[];
  readonly op: BulkOperation;
}>;

/**
 * Writes the kinds of rows of an operation, in one transaction: a locked row is left as it is
 *
 * @internal
 */
export function writeKinds(store: Store, rows: TableSelection, kinds: BulkKinds): boolean {
  if (rows.count === 0) return false;
  let written = false;
  store.transact(() => {
    for (const kind of kinds) {
      if (kind.rows.length === 0) continue;
      if (store.applyBulk(kind.op, TableSelection.of([...kind.rows]))) written = true;
    }
  });
  return written;
}

/**
 * Moves, rotates or scales the features selected in bulk by an edit, as a drag of them does
 *
 * @returns false when nothing is written (every feature locked, too), or the edit is refused
 * @internal
 */
export function transformBulkSelection(
  store: Store,
  edit: TransformEdit,
  rows: TableSelection | null = store.getSelectedRows(),
): boolean {
  if (!rows) return false;
  const kinds = transformKinds(store, edit, rows);
  return kinds !== null && writeKinds(store, rows, kinds);
}

/**
 * The writes of an edit of features selected in bulk (null without rows, or when the computation
 * of the Store does not take the edit)
 *
 * @internal
 */
export function transformKinds(
  store: Store,
  edit: TransformEdit,
  rows: TableSelection,
): BulkKinds | null {
  const internals = featureTablesInternals(store.tables);
  const tables = store.tables;
  if (!internals || !tables) return null;
  const transforms = transformsOf(store);
  if (!transforms.accepts(edit)) return null;
  const declared = transformFieldsOfStore(store);
  // The rows by the field of their roles the edit changes with their geometry (none: '')
  const byField = new Map<string, number[]>();
  for (const handle of rows.handles) {
    const place = livePlaceOf(internals, handle);
    if (!place) continue;
    const view = tables.get(place.layer.layerId);
    const type = view?.getRowType(handle) ?? null;
    let field = '';
    if (view && type !== null && edit.kind !== 'translate') {
      const roles = transformRolesOf(
        type,
        (key) => view.getRowValue(handle, key) !== undefined,
        declared,
      );
      field = (edit.kind === 'rotate' ? roles.angleDegrees : roles.size) ?? '';
    }
    let list = byField.get(field);
    if (!list) {
      list = [];
      byField.set(field, list);
    }
    list.push(handle);
  }
  const kinds: Array<{ rows: number[]; op: BulkOperation }> = [];
  for (const [field, list] of byField) {
    const fields: RowField[] = field === '' ? ['geometry'] : ['geometry', `properties:${field}`];
    kinds.push({
      rows: list,
      op: {
        kind: 'rows',
        fields,
        write: (handle, read) => {
          const type = tables.get(read.place.layer.layerId)?.getRowType(handle) ?? null;
          const moved = transformedRow(transforms, edit, read, type, declared);
          if (!moved) return null;
          if (field === '') return [moved.geometry];
          const value = field === moved.angleKey ? moved.angleDegrees : moved.size;
          return [moved.geometry, isFiniteNumber(value) ? value : read.value(field)];
        },
      },
    });
  }
  return kinds;
}

/** A row with an edit applied: its geometry and the values of its roles (null without a geometry) */
function transformedRow(
  transforms: ReturnType<typeof transformsOf>,
  edit: TransformEdit,
  read: BulkRowReader,
  type: string | null,
  fields: TransformFieldsRegistry | null,
): {
  geometry: unknown;
  angleKey: string | undefined;
  angleDegrees: unknown;
  size: unknown;
} | null {
  const geometry = read.geometry() as Geometry | undefined;
  if (!geometry) return null;
  const roles = transformRolesOf(type ?? '', (key) => read.value(key) !== undefined, fields);
  const after = transforms.apply(
    edit,
    transformValuesOf(geometry, roles, (key) => read.value(key)),
  );
  return {
    geometry: after.geometry,
    angleKey: roles.angleDegrees,
    angleDegrees: after.angleDegrees,
    size: after.size,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
