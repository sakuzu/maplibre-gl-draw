// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `features.restore` and `features.releaseRestore`: the values of features held as rows written
 * back through the gate of the instance, and the rows a deletion kept let go of
 */

import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import type { FeatureValues, RestoreToken } from '../model.js';
import type { FeatureTables, RowValues } from '../tables.js';
import { checkRowValues } from '../tables.js';
import type { ResourceDeps } from './shared.js';
import { invalidInput, invalidState, locksIgnored, notFound } from './shared.js';

/**
 * The tables of the Store, or a DrawError for a Store that holds its features as objects
 */
function requireTables(store: ResourceDeps['store']): FeatureTables {
  const tables = store.tables;
  if (!tables) throw invalidState('The Store does not hold its features as rows');
  return tables;
}

/**
 * Whether a lock refuses a write of the rows: one of them, its group or its layer is locked
 */
function rowsLocked(store: ResourceDeps['store'], tables: FeatureTables, rows: RowValues): boolean {
  const now = tables.readValues({
    handles: rows.handles,
    fields: new Map([
      ['locked', []],
      ['groupId', []],
      ['layerId', []],
    ]),
  });
  const locked = now.fields.get('locked') ?? [];
  const groups = now.fields.get('groupId') ?? [];
  const layers = now.fields.get('layerId') ?? [];
  for (let i = 0; i < rows.handles.length; i++) {
    if (locked[i] === true) return true;
    const groupId = groups[i];
    if (typeof groupId === 'string' && store.getGroup(groupId)?.locked === true) return true;
    const layerId = layers[i];
    if (typeof layerId === 'string' && store.getLayer(layerId)?.locked === true) return true;
  }
  return false;
}

/**
 * Creates `features.restore` and `features.releaseRestore`
 *
 * @internal
 */
export function createRestore(deps: Pick<ResourceDeps, 'store'>): {
  restore(values: FeatureValues): FeatureValues | null;
  releaseRestore(token: RestoreToken): void;
} {
  const { store } = deps;
  return {
    restore(values) {
      const tables = requireTables(store);
      const rows = checkRowValues(values);
      // Whether each handle has a row, without reading its id (a restore of a layer of 100,000)
      const ids = featureTablesInternals(tables)?.ids;
      const known = ids
        ? (handle: number) => ids.has(handle)
        : (handle: number) => tables.getRowId(handle) !== undefined;
      for (const handle of rows.handles) {
        if (!known(handle)) throw notFound('feature of the row', handle);
      }
      if (store.isReadOnly()) return null;
      if (!locksIgnored(store) && rowsLocked(store, tables, rows)) return null;
      return store.restoreRows(rows);
    },
    releaseRestore(token) {
      const tables = requireTables(store);
      if (typeof token !== 'number' || !Number.isInteger(token)) {
        throw invalidInput('The token must be a RestoreToken');
      }
      tables.release(token);
    },
  };
}
