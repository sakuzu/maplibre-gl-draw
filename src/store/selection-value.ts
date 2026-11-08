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
 * (no feature is made) and from the features of a Store of objects, there when the layers or the
 * extent are first read (a selection changed in every frame of a box costs no reading of the
 * geometries of its features). The value of the features
 * listed by their IDs over a Store of rows is read again only once the IDs or the rows change: it
 * is kept with the versions of the rows and of the ids it was read at (`LISTED_VALUES`).
 *
 * A target keeps the selection as it was read (the IDs, or the rows of the features selected in
 * bulk), so that selecting it again (`DrawStore.restoreSelection`) puts the same items back,
 * without listing the rows of a selection of many.
 */

import { summarizeRows } from '../feature-table/bulk-rows.js';
import {
  type FeatureTablesInternals,
  featureTablesInternals,
} from '../feature-table/feature-tables.js';
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

/**
 * The value of the features listed by their IDs read last over the rows of tables, with the
 * versions of the rows and of the ids it was read at (`listedVersions`)
 */
interface ListedValue {
  /** The IDs as the Store gave them, frozen (the same array while the selection is the same) */
  readonly source: readonly string[];
  readonly versions: readonly [number, number, number];
  readonly value: SelectionValue;
}

/** The value of the features listed by their IDs read last, for each tables */
const LISTED_VALUES = new WeakMap<FeatureTablesInternals, ListedValue>();

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
  const internals = featureTablesInternals(store.tables);
  if (internals && type === 'feature') {
    const known = LISTED_VALUES.get(internals);
    const versions = listedVersions(internals);
    if (
      known?.versions.every((version, i) => version === versions[i]) &&
      (known.source === selection.ids || sameIds(known.source, selection.ids))
    ) {
      return known.value;
    }
  }
  const ids = Object.freeze([...selection.ids]) as readonly string[];
  if (internals && store.tables) {
    const rows =
      type === 'feature'
        ? TableSelection.of(ids.flatMap((id) => store.tables?.findRow(id) ?? []))
        : (store.rowsOfSelection(selection) ?? TableSelection.empty);
    const summary = summarizeRows(internals, rows);
    const value: SelectionValue = Object.freeze({
      type,
      count: type === 'feature' ? ids.length : summary.count,
      ids,
      layerIds: Object.freeze([...summary.layerIds]) as readonly string[],
      bbox: summary.bbox,
    });
    if (type === 'feature') {
      LISTED_VALUES.set(internals, {
        // An array the Store may change in place is kept as a copy
        source: Object.isFrozen(selection.ids) ? selection.ids : ids,
        versions: listedVersions(internals),
        value,
      });
    }
    return value;
  }
  // The layers and the extent of the features of a Store of objects are read when first asked
  // for, not each time the selection changes: a box drawn over many features changes it in
  // every frame, and nothing reads them then
  const features = type === 'feature' ? null : selectedObjects(store, type, ids);
  let extent: ObjectsExtent | null = null;
  const extentNow = (): ObjectsExtent =>
    (extent ??= extentOfObjects(features ?? selectedObjects(store, type, ids)));
  return Object.freeze({
    type,
    count: features?.length ?? ids.length,
    ids,
    get layerIds() {
      return extentNow().layerIds;
    },
    get bbox() {
      return extentNow().bbox;
    },
  });
}

/** The layers and the extent of features of a Store of objects */
interface ObjectsExtent {
  readonly layerIds: readonly string[];
  readonly bbox: BBox | null;
}

/** The layers the features are in and the extent of their geometries */
function extentOfObjects(features: readonly Feature[]): ObjectsExtent {
  const layerIds = new Set<string>();
  let bbox: BBox | null = null;
  for (const feature of features) {
    layerIds.add(feature.layerId);
    if (feature.geometry) bbox = unionOf(bbox, coordinatesBBox(positionsOf(feature.geometry)));
  }
  return { layerIds: Object.freeze([...layerIds]) as readonly string[], bbox };
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

/**
 * What the value of features listed by their IDs is read from: the rows drawn (`revision`), the
 * rows written (`WriteMarks.stamped`) and the handles of the ids (`IdIndex.version`)
 */
function listedVersions(internals: FeatureTablesInternals): [number, number, number] {
  return [internals.revision, internals.writeMarks.stamped, internals.ids.version];
}

/** Whether two lists of IDs are the same, in the same order */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
