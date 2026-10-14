// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The summary of a selection of many rows the Store gives (`Selection.bulk`), and the rows each
 * summary was made of
 *
 * A summary is the number, the layers and the extent of the rows. It does not list them: the
 * rows stay with the summary here, so a summary kept (the selection before an operation, in the
 * history) puts the same rows back in the selection (`DrawStore.restoreSelection`).
 */

import { summarizeRows } from '../feature-table/bulk-rows.js';
import type { FeatureTablesInternals } from '../feature-table/feature-tables.js';
import type { TableSelection } from '../feature-table/selection.js';
import type { SelectionBulk } from './types.js';

const ROWS = new WeakMap<SelectionBulk, TableSelection>();
/** The summaries whose rows have one with an extent of an area */
const WITH_AREA = new WeakSet<SelectionBulk>();

/**
 * The summary of the rows of a selection (a new frozen object, which keeps the rows)
 *
 * @internal
 */
export function summaryOf(internals: FeatureTablesInternals, rows: TableSelection): SelectionBulk {
  const summary = summarizeRows(internals, rows);
  const bulk: SelectionBulk = Object.freeze({
    count: summary.count,
    layerIds: Object.freeze([...summary.layerIds]) as readonly string[],
    bounds: summary.bounds,
  });
  ROWS.set(bulk, rows);
  if (summary.hasArea) WITH_AREA.add(bulk);
  return bulk;
}

/**
 * Whether a row of a summary has an extent of an area: a selection of points alone has no
 * handle to rotate or resize it, as features selected one by one have none
 *
 * @internal
 */
export function summaryHasArea(bulk: SelectionBulk): boolean {
  return WITH_AREA.has(bulk);
}

/**
 * The rows a summary was made of (undefined for an object this module did not make)
 *
 * @internal
 */
export function rowsOfSummary(bulk: SelectionBulk | undefined): TableSelection | undefined {
  return bulk ? ROWS.get(bulk) : undefined;
}
