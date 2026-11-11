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
 * geometries of its features). A value is the selection as it was when it was given: the
 * features of a Store of objects it has not read yet are read as they were before a change of the
 * document, for the values the instance tells (`settleSelectionValues`). The same selection gives
 * the same value until the document changes: the value of the features listed by their IDs over
 * a Store of rows is kept with the versions of the rows and of the ids it was read at
 * (`LISTED_VALUES`), the value of a Store of objects until a change of its document
 * (`OBJECT_VALUES`), and the value of features selected in bulk with their summary
 * (`BULK_VALUES`).
 *
 * A target keeps the selection as it was read (the IDs, or the rows of the features selected in
 * bulk) with the Store it was read from, so that selecting it again (`DrawStore.restoreSelection`)
 * puts the same items back, without listing the rows of a selection of many.
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
  StoreChange,
} from './types.js';

/** The value of nothing selected */
const NOTHING: SelectionValue = Object.freeze({
  type: 'feature',
  count: 0,
  ids: Object.freeze([]) as readonly string[],
  layerIds: Object.freeze([]) as readonly string[],
  bbox: null,
});

/**
 * The values of each summary of features selected in bulk: one for each type and IDs it is read
 * as (the same object for the same ones). The selection of a group or a layer selected in bulk
 * keeps its type and IDs, and a drag of its features (`bulkSelectionValue`) reads it as features
 */
const BULK_VALUES = new WeakMap<SelectionBulk, SelectionValue[]>();

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

/** The selection each target names, with the Store it was read from */
const TARGETS = new WeakMap<
  SelectionTarget,
  { readonly store: Store; readonly selection: Selection }
>();

/**
 * What the value of a selection of a Store of objects reads its layers and extent from: the
 * features of the selection (null until they are read, when the layers or the extent are first
 * read), the features the changes of the document since the value was made wrote (the changes,
 * in their order, and the number of the features they wrote; kept while the features of the
 * selection are not read, see `settleSelectionValues`), and their extent once read
 */
interface ObjectsRead {
  readonly store: Store;
  readonly type: NonNullable<Selection['type']>;
  readonly ids: readonly string[];
  features: readonly Feature[] | null;
  written: FeaturesChange[] | null;
  writtenCount: number;
  extent: ObjectsExtent | null;
}

/** The features a change of the document wrote */
type FeaturesChange = NonNullable<StoreChange['features']>;

/** What each value of a selection of a Store of objects reads */
const OBJECT_READS = new WeakMap<SelectionValue, ObjectsRead>();

/**
 * The value of the selection of a Store of objects made last, with the IDs it was made of (the
 * array the Store gave when it is frozen): given again for the same selection until the document
 * changes (`settleSelectionValues`)
 */
const OBJECT_VALUES = new WeakMap<
  Store,
  { readonly source: readonly string[]; readonly value: SelectionValue }
>();

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
        ? TableSelection.of(ids.flatMap((id) => store.tables?.getRowRef(id) ?? []))
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
  return objectsValueOf(store, selection, type, ids);
}

/**
 * The value of a selection of a Store of objects: the one made last for the same selection while
 * the document has not changed, made otherwise
 *
 * The layers and the extent of its features are read when first asked for, not each time the
 * selection changes: a box drawn over many features changes it in every frame, and nothing reads
 * them then. The features of a group or a layer are read when the value is made (its number).
 */
function objectsValueOf(
  store: Store,
  selection: Selection,
  type: NonNullable<Selection['type']>,
  ids: readonly string[],
): SelectionValue {
  const last = OBJECT_VALUES.get(store);
  if (
    last &&
    last.value.type === type &&
    (last.source === selection.ids || sameIds(last.source, selection.ids))
  ) {
    return last.value;
  }
  const read: ObjectsRead = {
    store,
    type,
    ids,
    features:
      type === 'feature' ? null : selectedObjects(store, type, ids, (id) => store.getFeature(id)),
    written: null,
    writtenCount: 0,
    extent: null,
  };
  const extentNow = (): ObjectsExtent => {
    if (read.features === null) readAsGiven(read, null);
    read.extent ??= extentOfObjects(read.features ?? []);
    return read.extent;
  };
  const value: SelectionValue = Object.freeze({
    type,
    count: read.features?.length ?? ids.length,
    ids,
    get layerIds() {
      return extentNow().layerIds;
    },
    get bbox() {
      return extentNow().bbox;
    },
  });
  OBJECT_READS.set(value, read);
  // An array the Store may change in place is kept as a copy
  OBJECT_VALUES.set(store, { source: Object.isFrozen(selection.ids) ? selection.ids : ids, value });
  return value;
}

/**
 * Keeps the values of the selection of a Store of objects as they were given through a change of
 * its document: a value whose features are not read yet keeps the features the change wrote as
 * they were before it (only the ones it wrote: a write costs no reading of the selection), and its
 * features are read from them and the Store once asked for. Past as many as the selection has (or
 * `WRITTEN_LIMIT`), its features are read at once instead. The next value of the same selection is
 * made again. Called with the notification of the change, before the selection it tells is read
 *
 * @param values The values the instance tells or told last, besides the one made last
 * @internal
 */
export function settleSelectionValues(
  store: Store,
  changes: StoreChange,
  values: readonly (SelectionValue | null)[],
): void {
  if (!changesDocument(changes)) return;
  const last = OBJECT_VALUES.get(store);
  OBJECT_VALUES.delete(store);
  const reads = new Set<ObjectsRead>();
  for (const value of [last?.value, ...values]) {
    const read = value && OBJECT_READS.get(value);
    if (read && read.features === null && read.store === store) reads.add(read);
  }
  if (reads.size === 0) return;
  const features = changes.features;
  const count =
    (features?.created?.length ?? 0) +
    (features?.updated?.length ?? 0) +
    (features?.deleted?.length ?? 0);
  for (const read of reads) {
    // The whole document from elsewhere: what was there before is not told
    if (changes.reset === true) {
      readAsGiven(read, features);
      continue;
    }
    if (!features || count === 0) continue;
    if (read.writtenCount + count > Math.max(read.ids.length, WRITTEN_LIMIT)) {
      readAsGiven(read, features);
      continue;
    }
    read.written ??= [];
    read.written.push(features);
    read.writtenCount += count;
  }
}

/** The features written kept for a value of a selection of objects at most (or as many as it has) */
const WRITTEN_LIMIT = 1024;

/**
 * Reads the features of the value of a selection of objects as they were when it was given: the
 * ones the changes since wrote (those kept, then `more`) as they were before the first of them,
 * the others as the Store has them
 */
function readAsGiven(read: ObjectsRead, more: FeaturesChange | undefined | null): void {
  const before = new Map<string, Feature | null>();
  for (const change of [...(read.written ?? []), ...(more ? [more] : [])]) {
    for (const [id, was] of featuresBefore(change)) if (!before.has(id)) before.set(id, was);
  }
  read.features = selectedObjects(read.store, read.type, read.ids, (id) => {
    const was = before.get(id);
    return was === undefined ? read.store.getFeature(id) : (was ?? undefined);
  });
  read.written = null;
  read.writtenCount = 0;
}

/** Whether a notification changes the document (what the value of a selection reads) */
function changesDocument(changes: StoreChange): boolean {
  return (
    changes.features !== undefined ||
    changes.groups !== undefined ||
    changes.layers !== undefined ||
    changes.order !== undefined ||
    changes.reset === true ||
    changes.rows !== undefined
  );
}

/**
 * The features a change wrote, as they were before it: the ones deleted and the ones updated as
 * they were, and none for the ones created
 */
function featuresBefore(features: FeaturesChange): Map<string, Feature | null> {
  const out = new Map<string, Feature | null>();
  for (const feature of features.created ?? []) out.set(feature.id, null);
  for (const { feature, previous } of features.updated ?? []) out.set(feature.id, previous);
  for (const feature of features.deleted ?? []) out.set(feature.id, feature);
  return out;
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
  // The number of the features of a group or a layer selected by its ID follows what is in it, as
  // the one of features selected in bulk follows their rows
  const count = valueOfSelection(store, selection).count;
  const last = LAST_TARGET.get(store);
  const named = last && TARGETS.get(last);
  if (last && named && last.count === count && sameSelection(named.selection, selection)) {
    return last;
  }
  const kept: Selection = {
    type: selection.type,
    ids: Object.freeze([...selection.ids]) as readonly string[],
    ...(selection.bulk && { bulk: selection.bulk }),
  };
  const target: SelectionTarget = Object.freeze({ type: 'selection', count });
  TARGETS.set(target, { store, selection: kept });
  LAST_TARGET.set(store, target);
  return target;
}

/**
 * The selection a target names (undefined for an object the instance of this Store did not give)
 *
 * @internal
 */
export function selectionOfTarget(store: Store, target: SelectionTarget): Selection | undefined {
  const named = TARGETS.get(target);
  return named?.store === store ? named.selection : undefined;
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
  const found = known?.find(
    (value) =>
      value.type === type && (type === 'feature' || sameIds(value.ids as readonly string[], ids)),
  );
  if (found) return found;
  const value: SelectionValue = Object.freeze({
    type,
    count: bulk.count,
    // A group or a layer selected in bulk keeps its ID
    ids: type === 'feature' ? null : (Object.freeze([...ids]) as readonly string[]),
    layerIds: bulk.layerIds,
    bbox: bulk.bbox,
  });
  if (known) known.push(value);
  else BULK_VALUES.set(bulk, [value]);
  const rows = rowsOfSummary(bulk);
  if (rows) keepSelectedRows(value, rows);
  return value;
}

/**
 * The features of a selection of a Store of objects (the members of its groups and layers), each
 * read by `featureOf`
 */
function selectedObjects(
  store: Store,
  type: NonNullable<Selection['type']>,
  ids: readonly string[],
  featureOf: (id: string) => Feature | undefined,
): Feature[] {
  const out: Feature[] = [];
  const add = (id: string): void => {
    const feature = featureOf(id);
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
