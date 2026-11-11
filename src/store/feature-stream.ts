// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every feature of a document read one at a time, and the document emptied, whether the Store
 * holds its features as objects or as rows
 *
 * A Store of rows does not list its features (`listFeatures` throws): what reads every feature
 * (the export, the numbering of the names) reads the rows of each layer in their order and makes
 * a feature of one row at a time, and what empties the document deletes the rows of a layer in
 * one write.
 */

import type { FeatureTables, RowHandle, RowValues } from '../api/tables.js';
import { featureTablesInternals, readWithoutKeeping } from '../feature-table/feature-tables.js';
import { ROW_FLAG_HIDDEN, ROW_FLAG_LOCKED } from '../table/feature-row-columns.js';
import { listEveryFeatureInOrder } from './ordering.js';
import type { Feature, FeatureType, Group, Layer, ObjectGroup, ObjectLayer } from './types.js';

/** What the features are read from */
export interface FeatureSource {
  readonly tables?: FeatureTables;
  getFeature(id: string): Feature | undefined;
  getLayer(id: string): Layer | undefined;
  getGroup(id: string): Group | undefined;
  getLayerOrder(): readonly string[];
  listLayers(): Layer[];
  listGroups(): Group[];
  listFeatures(): Feature[];
  listFeaturesInOrder(): Feature[];
}

/**
 * The ids of the layers in the order they are drawn, the ones not on the stacking order after
 *
 * @internal
 */
export function layerIdsInOrder(store: FeatureSource): string[] {
  const out = store.getLayerOrder().filter((id) => store.getLayer(id) !== undefined);
  const listed = new Set(out);
  for (const layer of store.listLayers()) if (!listed.has(layer.id)) out.push(layer.id);
  return out;
}

/**
 * Every feature in the order it is drawn, one at a time (a feature of a row is made when it is
 * reached, and not kept: `readWithoutKeeping`)
 *
 * @internal
 */
export function* featuresInOrder(store: FeatureSource): Generator<Feature> {
  const tables = store.tables;
  if (!tables) {
    yield* listEveryFeatureInOrder(store);
    return;
  }
  for (const layerId of layerIdsInOrder(store)) {
    const cursor = tables.scan({ layerIds: [layerId] });
    for (let batch = cursor.next(); batch; batch = cursor.next()) {
      for (const handle of batch) {
        const id = tables.getRowId(handle) as string;
        const feature = readWithoutKeeping(tables, () => store.getFeature(id));
        if (feature) yield feature;
      }
    }
  }
}

/**
 * The layers as a document lists them: a layer held as rows with its items read from its rows
 *
 * @internal
 */
export function listedLayers(store: FeatureSource): ObjectLayer[] {
  return store.listLayers().map((layer) => {
    if (layer.kind !== 'table') return layer;
    const { kind: _kind, ...fields } = layer;
    return { ...fields, items: tableItemIds(store.tables, layer.id) };
  });
}

/**
 * The groups as a document lists them: a group of a layer held as rows with its members read
 * from the rows
 *
 * @internal
 */
export function listedGroups(store: FeatureSource): ObjectGroup[] {
  return store.listGroups().map((group) => {
    if (group.kind !== 'table') return group;
    const { kind: _kind, ...fields } = group;
    return { ...fields, featureIds: tableMemberIds(store.tables, group) };
  });
}

/** The ids of the items of a layer held as rows, in their order */
function tableItemIds(tables: FeatureTables | undefined, layerId: string): string[] {
  const view = tables?.get(layerId);
  if (!tables || !view) return [];
  const refs = view.listItems(0, view.itemCount);
  const out: string[] = [];
  for (let i = 0; i < refs.kinds.length; i++) {
    const id =
      refs.kinds[i] === 0 ? tables.getRowId(refs.handles[i]) : tables.getGroupId(refs.handles[i]);
    if (id !== undefined) out.push(id);
  }
  return out;
}

/** The ids of the members of a group of a layer held as rows, in their order */
function tableMemberIds(tables: FeatureTables | undefined, group: Group): string[] {
  const view = tables?.get(group.layerId);
  const handle = tables?.findGroup(group.id);
  if (!tables || !view || handle === undefined) return [];
  const members = view.listGroupMembers(handle, 0, view.countGroupMembers(handle));
  return Array.from(members, (row) => tables.getRowId(row) as string);
}

/**
 * What a row is read for, as the filters of the features name it
 *
 * @internal
 */
export interface RowFilter {
  readonly layerId?: string;
  readonly groupId?: string;
  readonly type?: FeatureType;
  readonly visible?: boolean;
  readonly locked?: boolean;
  /** Its own visible flag, the one of its group and the one of its layer all on */
  readonly shown?: boolean;
  readonly bbox?: readonly [number, number, number, number];
}

/**
 * Whether a row matches a filter, read on its columns (the extent of the filter is not tested:
 * the rows are found by it)
 *
 * @returns The test, or null when no row can match (a group that is not there)
 * @internal
 */
export function rowMatcher(
  store: FeatureSource,
  filter: RowFilter,
): ((handle: RowHandle) => boolean) | null {
  const tables = store.tables;
  const internals = featureTablesInternals(tables);
  if (!tables || !internals) return null;
  const groupHandle = filter.groupId !== undefined ? (tables.findGroup(filter.groupId) ?? -2) : -1;
  if (groupHandle === -2) return null;
  const layerShown = new Map<string, boolean>();
  return (handle) => {
    const place = internals.placeOf(handle);
    if (!place) return false;
    const layerId = place.layer.layerId;
    if (filter.layerId !== undefined && layerId !== filter.layerId) return false;
    const data = place.group.data;
    const row = place.row;
    const group = data.groups[row];
    if (groupHandle >= 0 && group !== groupHandle) return false;
    const flags = data.flags[row];
    const visible = (flags & ROW_FLAG_HIDDEN) === 0;
    if (filter.visible !== undefined && visible !== filter.visible) return false;
    if (filter.locked !== undefined && ((flags & ROW_FLAG_LOCKED) !== 0) !== filter.locked) {
      return false;
    }
    if (filter.type !== undefined && tables.get(layerId)?.getRowType(handle) !== filter.type) {
      return false;
    }
    if (filter.shown !== undefined) {
      let shownLayer = layerShown.get(layerId);
      if (shownLayer === undefined) {
        shownLayer = store.getLayer(layerId)?.visible !== false;
        layerShown.set(layerId, shownLayer);
      }
      const shown = visible && shownLayer && (group < 0 || internals.groups.isVisible(group));
      if (shown !== filter.shown) return false;
    }
    return true;
  };
}

/**
 * Visits the rows that match a filter, in the order they are drawn, without making features
 *
 * @param visit Called with each row; returning false stops
 * @param after A row the visit starts after (the ones before it and it are not visited, whether
 *   they match or not); every row when omitted
 * @internal
 */
export function forEachMatchingRow(
  store: FeatureSource,
  filter: RowFilter,
  visit: (handle: RowHandle) => boolean,
  after?: RowHandle,
): void {
  const tables = store.tables;
  const internals = featureTablesInternals(tables);
  const matches = rowMatcher(store, filter);
  if (!tables || !internals || !matches) return;
  // The layer of the row the visit starts after: the layers before it are not read
  const afterLayer = after === undefined ? undefined : internals.placeOf(after)?.layer.layerId;
  let started = after === undefined;
  const layerIds =
    filter.layerId !== undefined
      ? store.getLayer(filter.layerId)
        ? [filter.layerId]
        : []
      : layerIdsInOrder(store);
  for (const layerId of layerIds) {
    if (!started && layerId !== afterLayer) continue;
    const cursor = tables.scan({
      layerIds: [layerId],
      ...(filter.bbox && { bbox: [...filter.bbox] as [number, number, number, number] }),
    });
    for (let batch = cursor.next(); batch; batch = cursor.next()) {
      for (const handle of batch) {
        if (!started) {
          started = handle === after;
          continue;
        }
        if (!matches(handle)) continue;
        if (!visit(handle)) return;
      }
    }
  }
}

/** What emptying the document writes */
export interface DocumentWriter extends FeatureSource {
  deleteFeature(id: string): unknown;
  deleteGroup(id: string): unknown;
  restoreRows(patch: RowValues): unknown;
}

/**
 * Deletes every feature and group of the document, keeping the layers (in the transaction of the
 * caller): the rows of a layer held as rows in one write per layer
 *
 * @internal
 */
export function deleteFeaturesAndGroups(store: DocumentWriter): void {
  const tables = store.tables;
  if (tables) {
    for (const layerId of layerIdsInOrder(store)) {
      const handles: number[] = [];
      const cursor = tables.scan({ layerIds: [layerId] });
      for (let batch = cursor.next(); batch; batch = cursor.next()) handles.push(...batch);
      if (handles.length === 0) continue;
      store.restoreRows({
        handles: Int32Array.from(handles),
        fields: new Map(),
        deleted: new Uint8Array(handles.length).fill(1),
      });
    }
  } else {
    for (const feature of store.listFeatures()) store.deleteFeature(feature.id);
  }
  for (const group of store.listGroups()) {
    if (store.getGroup(group.id)) store.deleteGroup(group.id);
  }
}
