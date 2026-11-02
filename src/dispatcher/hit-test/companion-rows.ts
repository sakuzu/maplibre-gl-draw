// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows of a layer held as rows that have companions, for the hit testing
 *
 * A hit asks the companions of the rows in front of the frontmost row hit. Walking every row of
 * the layer to find the ones with companions would make each hit cost the rows of the layer, so
 * the rows with companions are found once and kept, in the order of the layer, by the providers
 * (`FeatureCompanionRegistry`) and the layer. A row has companions as the drawing tells it
 * (`rowHasCompanion`), from its values, so what is kept follows the rows that change only:
 *
 * - a row written in place (`onRowsWritten`), and a row that came into the delta of the layer or
 *   left it (`onDeltaChanged`), is asked again by its handle, alone. A row that comes into a
 *   delta or leaves one is asked again in the layer of its copy in a row group too, so a row
 *   moved to another layer, or read again where it was, is not missed
 * - when the rows of the layer cannot be told apart, every row is asked again: the providers came
 *   or went (their generation), row groups of the layer were added or replaced (new rows taken
 *   in, the next versions of groups), the groups of features changed (the keys of their order,
 *   their ids, which every member is read with), or the new rows read before their groups are
 *   taken in changed
 *
 * The rows asked again are told by handle, so they stay right whatever place they move to; their
 * places in the order are found again when they may have moved (a row asked again, or the delta
 * made again), from the rows with companions only. The state of a row (hidden, deleted) is not
 * read here: the hit reads it as it is.
 */

import type { LayerTableView } from '../../api/tables.js';
import type { FeatureTablesInternals } from '../../feature-table/feature-tables.js';
import type { LayerOrder, LayerTable, RowGroup } from '../../feature-table/layer-table.js';
import { rowFeatureToRead, rowHasGeometry } from '../../feature-table/row-read.js';
import type { RowHandle } from '../../feature-table/types.js';
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

/** The handles of the rows of one layer told to have changed, in the order they were told */
interface Told {
  /** The number of handles told before the first one held */
  start: number;
  readonly handles: RowHandle[];
}

/**
 * The most handles held per layer: past it, the ones held are let go of, and what was kept from
 * before them is found again from every row
 */
const TOLD_LIMIT = 1 << 15;

/** What the rows with companions of a layer were found with, and what they are */
interface Kept {
  readonly generation: number;
  readonly structure: number;
  readonly groupsRevision: number;
  readonly pending: number;
  /** The number of handles told to the layer that were asked again */
  seen: number;
  /** The revision of the delta the places of the rows were found at */
  delta: number;
  /** The handles of the rows with companions */
  readonly handles: Set<RowHandle>;
  rows: CompanionRows;
}

/** The rows with companions kept, by the providers and the layer */
const KEPT = new WeakMap<FeatureCompanionRegistry, WeakMap<LayerTable, Kept>>();

/**
 * The handles of the rows told to have changed, by tables and layer: one watch per tables, which
 * lives as long as the tables do
 */
const TOLD = new WeakMap<FeatureTablesInternals, Map<string, Told>>();

/** The rows of the layers of tables told to have changed (watched from the first call) */
function toldOf(tables: FeatureTablesInternals): Map<string, Told> {
  const known = TOLD.get(tables);
  if (known) return known;
  const told = new Map<string, Told>();
  const tell = (layerId: string, handle: RowHandle): void => {
    let list = told.get(layerId);
    if (!list) {
      list = { start: 0, handles: [] };
      told.set(layerId, list);
    }
    if (list.handles.length >= TOLD_LIMIT) {
      list.start += list.handles.length;
      list.handles.length = 0;
    }
    list.handles.push(handle);
  };
  tables.onRowsWritten((layerId, writes) => {
    for (const write of writes) tell(layerId, write.handle);
  });
  tables.onDeltaChanged((layerId, change) => {
    // The layer of the delta, and the layer of the copy of the row in a row group: where it was
    // read before it came into a delta (from another layer), or is read again once it left
    const moved = (handle: RowHandle): void => {
      tell(layerId, handle);
      const copy = tables.rowGroup(tables.ids.mainGroup(handle))?.layer.layerId;
      if (copy !== undefined && copy !== layerId) tell(copy, handle);
    };
    for (const handle of change.leaving) moved(handle);
    for (const { handle } of change.coming) moved(handle);
  });
  TOLD.set(tables, told);
  return told;
}

/**
 * The rows of a layer that have companions: the rows told to have changed are asked again, and
 * every row only when the rows cannot be told apart
 *
 * @internal
 */
export function companionRowsOf(
  tables: FeatureTablesInternals,
  table: LayerTable,
  companions: FeatureCompanionRegistry,
): CompanionRows {
  const told = toldOf(tables).get(table.layerId);
  const toldEnd = told ? told.start + told.handles.length : 0;
  const generation = companions.generation();
  const structure = table.structureRevision;
  const groupsRevision = tables.groups.revision;
  const pending = table.pendingRowsRevision;
  let byLayer = KEPT.get(companions);
  if (!byLayer) {
    byLayer = new WeakMap();
    KEPT.set(companions, byLayer);
  }
  const kept = byLayer.get(table);
  if (
    !kept ||
    kept.generation !== generation ||
    kept.structure !== structure ||
    kept.groupsRevision !== groupsRevision ||
    kept.pending !== pending ||
    kept.seen < (told?.start ?? 0) ||
    // Asking every row again costs less than asking the rows told
    toldEnd - kept.seen > table.groupRowCount + table.delta.length
  ) {
    const found = findCompanionRows(tables, table, table.rowOrder(), companions);
    byLayer.set(table, {
      generation,
      structure,
      groupsRevision,
      pending,
      seen: toldEnd,
      delta: table.delta.revision,
      handles: found.handles,
      rows: found.rows,
    });
    return found.rows;
  }
  let changed = false;
  if (told && kept.seen < toldEnd) {
    const view = tables.view(table.layerId);
    const asked = new Set<RowHandle>();
    for (let i = kept.seen - told.start; i < told.handles.length; i++) {
      const handle = told.handles[i];
      if (asked.has(handle)) continue;
      asked.add(handle);
      const has = hasCompanion(tables, table, view, companions, handle);
      if (has === kept.handles.has(handle)) continue;
      if (has) kept.handles.add(handle);
      else kept.handles.delete(handle);
      changed = true;
    }
    kept.seen = toldEnd;
  }
  // The rows of the delta are at other places once it is made again
  if (changed || kept.delta !== table.delta.revision) {
    kept.rows = placeRows(tables, table, kept.handles);
    kept.delta = table.delta.revision;
  }
  return kept.rows;
}

/** Where a row is read in a layer (null for a row read in another layer, or in none) */
function placeIn(
  tables: FeatureTablesInternals,
  table: LayerTable,
  handle: RowHandle,
): { readonly group: RowGroup; readonly row: number } | null {
  const place = tables.placeOf(handle);
  if (!place || place.layer !== table || !table.readsRow(place.group, place.row)) return null;
  return place;
}

/** Whether the row of a handle is read in a layer and has companions there */
function hasCompanion(
  tables: FeatureTablesInternals,
  table: LayerTable,
  view: LayerTableView | undefined,
  companions: FeatureCompanionRegistry,
  handle: RowHandle,
): boolean {
  const place = placeIn(tables, table, handle);
  if (!place) return false;
  const { group, row } = place;
  if (!rowHasGeometry(group, row)) return false;
  let feature: Feature | undefined;
  const featureOf = (): Feature => {
    feature ??= rowFeatureToRead(tables.readContext, table.layerId, group, row);
    return feature;
  };
  return rowHasCompanion(companions, view, group, row, featureOf);
}

/**
 * The rows of handles in the order of a layer, found from their places (a row read in another
 * layer is left out): the cost of the rows and the groups of the layer, not of its rows
 */
function placeRows(
  tables: FeatureTablesInternals,
  table: LayerTable,
  handles: ReadonlySet<RowHandle>,
): CompanionRows {
  const byGroup = new Map<RowGroup, number[]>();
  for (const handle of handles) {
    const place = placeIn(tables, table, handle);
    if (!place) continue;
    const ofGroup = byGroup.get(place.group);
    if (ofGroup) ofGroup.push(place.row);
    else byGroup.set(place.group, [place.row]);
  }
  const groups: RowGroup[] = [];
  const rows: number[] = [];
  table.visitInOrder(byGroup, (group, row) => {
    groups.push(group);
    rows.push(row);
  });
  return { groups, rows: Int32Array.from(rows), byGroup };
}

/** Walks the rows of a layer for the ones with companions (a row without a geometry has none) */
function findCompanionRows(
  tables: FeatureTablesInternals,
  table: LayerTable,
  order: LayerOrder,
  companions: FeatureCompanionRegistry,
): { readonly handles: Set<RowHandle>; readonly rows: CompanionRows } {
  const handles = new Set<RowHandle>();
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
    handles.add(order.handles[i]);
    groups.push(group);
    rows.push(row);
    const ofGroup = byGroup.get(group);
    if (ofGroup) ofGroup.push(row);
    else byGroup.set(group, [row]);
  }
  return { handles, rows: { groups, rows: Int32Array.from(rows), byGroup } };
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
