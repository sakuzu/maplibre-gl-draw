// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The selection of this client as the instance gives it: its value (`draw.selection.value`) and
 * the target that names it (`draw.selection.target`)
 *
 * The value is read the same however the selection is held: the features listed by their IDs
 * (up to `Store.selectionIdsLimit` of a Store of rows, every one of a Store of objects), or
 * selected in bulk by the states of their rows (`Selection.bulk`), with no IDs listed then. The
 * number, the layers and the extent of the features are read from the rows of a Store of rows
 * (no feature is made) and from the features of a Store of objects.
 *
 * A target keeps the selection as it was read (the IDs, or the rows of the features selected in
 * bulk), so that selecting it again (`DrawStore.restoreSelection`) puts the same items back,
 * without listing the rows of a selection of many.
 */

import { summarizeRows } from '../feature-table/bulk-rows.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { TableSelection } from '../feature-table/selection.js';
import { coordinatesBBox } from '../geometry/bbox.js';
import { positionsOf } from '../geometry/geojson.js';
import type { BBox } from '../geometry/types.js';
import { keepSelectedRows, rowsOfSummary } from './bulk-selection.js';
import type { Store } from './store.js';
import type {
  Feature,
  Group,
  Selection,
  SelectionBulk,
  SelectionTarget,
  SelectionValue,
} from './types.js';

/** The value of nothing selected */
const NOTHING: SelectionValue = Object.freeze({
  type: 'feature',
  count: 0,
  ids: Object.freeze([]) as readonly string[],
  layerIds: Object.freeze([]) as readonly string[],
  bbox: null,
});

/** The value of each summary of features selected in bulk (the same object for the same one) */
const BULK_VALUES = new WeakMap<SelectionBulk, SelectionValue>();

/** The selection each target names */
const TARGETS = new WeakMap<SelectionTarget, Selection>();

/** The target made last for each Store, with the selection it names */
const LAST_TARGET = new WeakMap<Store, SelectionTarget>();

/**
 * The value of the selection of this client now
 *
 * @internal
 */
export function selectionValueOf(store: Store): SelectionValue {
  return valueOfSelection(store, store.getSelection());
}

/**
 * The value of a selection read from a Store (the one it holds now, or one told before): its
 * number, layers and extent read from what the Store holds now
 *
 * @internal
 */
export function valueOfSelection(store: Store, selection: Selection): SelectionValue {
  const { type, bulk } = selection;
  if (type === null) return NOTHING;
  if (bulk) return bulkValueOf(type, selection.ids, bulk);
  const ids = Object.freeze([...selection.ids]) as readonly string[];
  const internals = featureTablesInternals(store.tables);
  if (internals && store.tables) {
    const rows =
      type === 'feature'
        ? TableSelection.of(ids.flatMap((id) => store.tables?.findRow(id) ?? []))
        : (store.rowsOfSelection(selection) ?? TableSelection.empty);
    const summary = summarizeRows(internals, rows);
    return Object.freeze({
      type,
      count: type === 'feature' ? ids.length : summary.count,
      ids,
      layerIds: Object.freeze([...summary.layerIds]) as readonly string[],
      bbox: summary.bbox,
    });
  }
  const features = selectedObjects(store, type, ids);
  const layerIds = new Set<string>();
  let bbox: BBox | null = null;
  for (const feature of features) {
    layerIds.add(feature.layerId);
    if (feature.geometry) bbox = unionOf(bbox, coordinatesBBox(positionsOf(feature.geometry)));
  }
  return Object.freeze({
    type,
    count: type === 'feature' ? ids.length : features.length,
    ids,
    layerIds: Object.freeze([...layerIds]) as readonly string[],
    bbox,
  });
}

/**
 * The target that names the selection of this client now: the same object while the selection
 * is the same
 *
 * @internal
 */
export function selectionTargetOf(store: Store): SelectionTarget {
  const selection = store.getSelection();
  const last = LAST_TARGET.get(store);
  const named = last && TARGETS.get(last);
  if (last && named && sameSelection(named, selection)) return last;
  const kept: Selection = {
    type: selection.type,
    ids: Object.freeze([...selection.ids]) as readonly string[],
    ...(selection.bulk && { bulk: selection.bulk }),
  };
  const target: SelectionTarget = Object.freeze({
    type: 'selection',
    count: valueOfSelection(store, selection).count,
  });
  TARGETS.set(target, kept);
  LAST_TARGET.set(store, target);
  return target;
}

/**
 * The selection a target names (undefined for an object the instance did not give)
 *
 * @internal
 */
export function selectionOfTarget(target: SelectionTarget): Selection | undefined {
  return TARGETS.get(target);
}

/**
 * The value of a selection of features selected in bulk, from its summary (the `bulk` of a
 * drag): the same object for the same summary
 *
 * @internal
 */
export function bulkSelectionValue(bulk: SelectionBulk): SelectionValue {
  return bulkValueOf('feature', [], bulk);
}

/** The value of features selected in bulk, made once for each summary */
function bulkValueOf(
  type: NonNullable<Selection['type']>,
  ids: readonly string[],
  bulk: SelectionBulk,
): SelectionValue {
  const known = BULK_VALUES.get(bulk);
  if (known) return known;
  const value: SelectionValue = Object.freeze({
    type,
    count: bulk.count,
    // A group or a layer selected in bulk keeps its ID
    ids: type === 'feature' ? null : (Object.freeze([...ids]) as readonly string[]),
    layerIds: bulk.layerIds,
    bbox: bulk.bbox,
  });
  BULK_VALUES.set(bulk, value);
  const rows = rowsOfSummary(bulk);
  if (rows) keepSelectedRows(value, rows);
  return value;
}

/** The features of a selection of a Store of objects (the members of its groups and layers) */
function selectedObjects(
  store: Store,
  type: NonNullable<Selection['type']>,
  ids: readonly string[],
): Feature[] {
  const out: Feature[] = [];
  const add = (id: string): void => {
    const feature = store.getFeature(id);
    if (feature) out.push(feature);
  };
  const addGroup = (group: Group): void => {
    if (group.kind !== 'table') for (const id of group.featureIds) add(id);
  };
  for (const id of ids) {
    if (type === 'feature') add(id);
    else if (type === 'group') {
      const group = store.getGroup(id);
      if (group) addGroup(group);
    } else {
      const layer = store.getLayer(id);
      if (!layer || layer.kind === 'table') continue;
      for (const item of layer.items) {
        const group = store.getGroup(item);
        if (group) addGroup(group);
        else add(item);
      }
    }
  }
  return out;
}

/** The union of two extents */
function unionOf(a: BBox | null, b: BBox | null): BBox | null {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** Whether two selections hold the same items (the same rows, for features selected in bulk) */
function sameSelection(a: Selection, b: Selection): boolean {
  if (a.type !== b.type || a.ids.length !== b.ids.length) return false;
  if ((a.bulk === undefined) !== (b.bulk === undefined)) return false;
  if (a.bulk && b.bulk && a.bulk !== b.bulk) {
    const rows = rowsOfSummary(a.bulk);
    const other = rowsOfSummary(b.bulk);
    if (!rows || !other || !rows.equals(other)) return false;
  }
  return a.ids.every((id, i) => id === b.ids[i]);
}
