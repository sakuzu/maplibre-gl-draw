// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows of a layer held as rows that have companions, for the hit testing
 *
 * A hit asks the companions of the rows in front of the frontmost row hit. Walking every row of
 * the layer to find the ones with companions would make each hit cost the rows of the layer, so
 * the rows with companions are found once and kept, in the order of the layer, by the providers
 * (`FeatureCompanionRegistry`) and the layer. A row has companions as the drawing tells it
 * (`rowHasCompanion`), and what is kept is found again when what that answer reads changed, as
 * the drawing classifies its rows again: the providers came or went (their generation), the
 * order of the rows changed (`LayerTable.rowOrder` is made again), or rows of the layer were
 * written in place or came into its delta or left it (`onRowsWritten`, `onDeltaChanged`). The
 * state of a row (hidden, deleted) is not read here: the hit reads it as it is.
 */

import type { FeatureTablesInternals } from '../../feature-table/feature-tables.js';
import type { LayerOrder, LayerTable, RowGroup } from '../../feature-table/layer-table.js';
import { rowFeatureToRead, rowHasGeometry } from '../../feature-table/row-read.js';
import type { Feature } from '../../store/types.js';
import type { FeatureCompanionRegistry } from '../../view/feature-companion.js';
import { rowHasCompanion } from '../../view/layer/table-partition.js';

/**
 * The rows of a layer that have companions, in the order of the layer (back to front)
 *
 * @internal
 */
export interface CompanionRows {
  /** The group each row is read from */
  readonly groups: readonly RowGroup[];
  /** The row of each in its group */
  readonly rows: Int32Array;
  /** The rows by the group they are read from (what `LayerTable.visitInOrder` takes) */
  readonly byGroup: ReadonlyMap<RowGroup, number[]>;
}

/** What the rows with companions of a layer were found with */
interface Kept {
  readonly order: LayerOrder;
  readonly generation: number;
  readonly changes: number;
  readonly rows: CompanionRows;
}

/** The rows with companions kept, by the providers and the layer */
const KEPT = new WeakMap<FeatureCompanionRegistry, WeakMap<LayerTable, Kept>>();

/**
 * The changes of the rows told so far, by tables and layer: one watch per tables, which lives as
 * long as the tables do
 */
const CHANGES = new WeakMap<FeatureTablesInternals, Map<string, number>>();

/** The changes of the rows of the layers of tables told so far (watched from the first call) */
function changesOf(tables: FeatureTablesInternals): Map<string, number> {
  let changes = CHANGES.get(tables);
  if (changes) return changes;
  const counts = new Map<string, number>();
  const count = (layerId: string): void => {
    counts.set(layerId, (counts.get(layerId) ?? 0) + 1);
  };
  tables.onRowsWritten(count);
  tables.onDeltaChanged(count);
  CHANGES.set(tables, counts);
  changes = counts;
  return changes;
}

/**
 * The rows of a layer that have companions, found again only when what tells it changed
 *
 * @internal
 */
export function companionRowsOf(
  tables: FeatureTablesInternals,
  table: LayerTable,
  companions: FeatureCompanionRegistry,
): CompanionRows {
  const changes = changesOf(tables);
  const order = table.rowOrder();
  const generation = companions.generation();
  const changeCount = changes.get(table.layerId) ?? 0;
  let byLayer = KEPT.get(companions);
  if (!byLayer) {
    byLayer = new WeakMap();
    KEPT.set(companions, byLayer);
  }
  const kept = byLayer.get(table);
  if (
    kept &&
    kept.order === order &&
    kept.generation === generation &&
    kept.changes === changeCount
  ) {
    return kept.rows;
  }
  const rows = findCompanionRows(tables, table, order, companions);
  byLayer.set(table, { order, generation, changes: changeCount, rows });
  return rows;
}

/** Walks the rows of a layer for the ones with companions (a row without a geometry has none) */
function findCompanionRows(
  tables: FeatureTablesInternals,
  table: LayerTable,
  order: LayerOrder,
  companions: FeatureCompanionRegistry,
): CompanionRows {
  const groups: RowGroup[] = [];
  const rows: number[] = [];
  const byGroup = new Map<RowGroup, number[]>();
  const view = tables.view(table.layerId);
  for (let i = 0; i < order.handles.length; i++) {
    const group = order.groups[i];
    const row = order.rows[i];
    if (!rowHasGeometry(group, row)) continue;
    let feature: Feature | undefined;
    const featureOf = (): Feature => {
      feature ??= rowFeatureToRead(tables.readContext, table.layerId, group, row);
      return feature;
    };
    if (!rowHasCompanion(companions, view, group, row, featureOf)) continue;
    groups.push(group);
    rows.push(row);
    const ofGroup = byGroup.get(group);
    if (ofGroup) ofGroup.push(row);
    else byGroup.set(group, [row]);
  }
  return { groups, rows: Int32Array.from(rows), byGroup };
}

/**
 * The rows with companions in front of a row of the layer, in the order of the layer (back to
 * front): found with the row among them in the order of the layer, so a hit costs the rows with
 * companions and the groups of the layer, not its rows
 *
 * @internal
 */
export function companionRowsInFront(
  table: LayerTable,
  withCompanions: CompanionRows,
  group: RowGroup,
  row: number,
): { readonly groups: readonly RowGroup[]; readonly rows: readonly number[] } {
  const found = new Map(withCompanions.byGroup);
  const ofGroup = found.get(group);
  if (!ofGroup) found.set(group, [row]);
  else if (!ofGroup.includes(row)) found.set(group, [...ofGroup, row]);
  const groups: RowGroup[] = [];
  const rows: number[] = [];
  let passed = false;
  table.visitInOrder(found, (g, r) => {
    if (g === group && r === row) {
      passed = true;
      return;
    }
    if (!passed) return;
    groups.push(g);
    rows.push(r);
  });
  return { groups, rows };
}
