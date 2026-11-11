// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows a write wrote as core tells them, by layer (`RowsChange`), of what the tables tell,
 * by table: the tables of the rows are the layers
 */

import type { RowsChange as TablesRowsChange } from '@sakuzu/kasane';
import type { RowsChange } from '../shared/types/model.js';

/**
 * The rows the tables tell a write wrote, by layer
 *
 * @internal
 */
export function rowsChangeOf(change: TablesRowsChange): RowsChange {
  return { layers: change.tables };
}
