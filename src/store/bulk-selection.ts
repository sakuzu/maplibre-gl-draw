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

import type { SelectionValue as PublicSelectionValue } from '../api/state.js';
import { livePlaceOf, summarizeRows } from '../feature-table/bulk-rows.js';
import type { FeatureTablesInternals } from '../feature-table/feature-tables.js';
import type { TableSelection } from '../feature-table/selection.js';
import type { SelectionBulk, SelectionValue } from './types.js';

const ROWS = new WeakMap<object, TableSelection>();
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
    bbox: summary.bbox,
  });
  ROWS.set(bulk, rows);
  if (summary.hasArea) WITH_AREA.add(bulk);
  return bulk;
}

/**
 * The summary of rows whose geometries are as they were for a summary of them made before, some
 * of them put in other layers: the layers made again (the ones the rows put elsewhere went to,
 * and the ones the others are read in), the number and the extent kept
 *
 * @param layerOf - The layer a row was put in (undefined for a row not put elsewhere)
 * @internal
 */
export function summaryWithLayers(
  internals: FeatureTablesInternals,
  previous: SelectionBulk,
  rows: TableSelection,
  layerOf: (handle: number) => string | undefined,
): SelectionBulk {
  const layers = new Set<string>();
  for (const handle of rows.handles) {
    const layerId = layerOf(handle) ?? livePlaceOf(internals, handle)?.table.tableId;
    if (layerId !== undefined) layers.add(layerId);
  }
  const bulk: SelectionBulk = Object.freeze({
    count: previous.count,
    layerIds: Object.freeze([...layers]) as readonly string[],
    bbox: previous.bbox,
  });
  ROWS.set(bulk, rows);
  if (WITH_AREA.has(previous)) WITH_AREA.add(bulk);
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
 * Keeps the rows of features selected in bulk with the value the instance gives of their
 * selection (`listSelectedRows`)
 *
 * @internal
 */
export function keepSelectedRows(value: SelectionValue, rows: TableSelection): void {
  ROWS.set(value, rows);
}

/**
 * The handles of the rows of features selected in bulk, from the value of their selection
 * (`draw.selection.value` whose `ids` is `null`, the `bulk` of `drag.started`): what a plugin
 * reads them by, without their IDs. Empty for a value of features listed by their IDs, or one
 * the instance did not give
 *
 * @param selection - The value of the selection of the features selected in bulk
 * @returns The handles of their rows, ascending
 * @experimental
 */
export function listSelectedRows(selection: PublicSelectionValue): Int32Array {
  return ROWS.get(selection)?.handles.slice() ?? new Int32Array(0);
}

/**
 * The rows a summary was made of (undefined for an object this module did not make)
 *
 * @internal
 */
export function rowsOfSummary(bulk: SelectionBulk | undefined): TableSelection | undefined {
  return bulk ? ROWS.get(bulk) : undefined;
}
