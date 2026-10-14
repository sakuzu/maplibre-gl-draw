// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.tables`: the writes of the rows of a Store that holds its features as rows
 */

import { DrawError } from '../errors.js';
import type { FeatureTables, RowValues, TablesResource } from '../tables.js';
import type { ResourceDeps } from './shared.js';
import { invalidInput, isRecord, notFound } from './shared.js';

/** The fields of a row other than its attributes (`property:<key>`) */
const ROW_FIELDS = new Set([
  'type',
  'layerId',
  'groupId',
  'order',
  'member',
  'geometry',
  'visible',
  'locked',
  'style',
]);

/**
 * Creates `draw.tables`
 *
 * @internal
 */
export function createTables(deps: Pick<ResourceDeps, 'store'>): TablesResource {
  const { store } = deps;
  return {
    applyRows(patch) {
      const tables = store.tables;
      if (!tables) {
        throw new DrawError('invalid-state', 'The Store does not hold its features as rows');
      }
      checkPatch(patch, tables);
      return store.restoreRows(patch);
    },
  };
}

/** Throws a DrawError unless the patch names rows there are, with one value per row */
function checkPatch(patch: RowValues, tables: FeatureTables): void {
  if (!isRecord(patch)) throw invalidInput('The patch must be an object');
  const { handles, fields, deleted } = patch as Partial<RowValues>;
  if (!(handles instanceof Int32Array)) throw invalidInput('The handles must be an Int32Array');
  if (!(fields instanceof Map)) throw invalidInput('The fields must be a Map');
  const n = handles.length;
  for (const [field, values] of fields) {
    if (typeof field !== 'string' || !(ROW_FIELDS.has(field) || field.startsWith('property:'))) {
      throw invalidInput(`${JSON.stringify(field)} is not a field of a row`);
    }
    if (!Array.isArray(values) || values.length !== n) {
      throw invalidInput(`The values of ${field} must be an array of one value per row`);
    }
  }
  if (deleted !== undefined && (!(deleted instanceof Uint8Array) || deleted.length !== n)) {
    throw invalidInput('The deletions must be a Uint8Array of one value per row');
  }
  for (const handle of handles) {
    if (tables.getRowId(handle) === undefined) throw notFound('row', handle);
  }
}
