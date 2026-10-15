// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The copy of a document held as rows into a new Store of rows (`copyTableStore`)
 *
 * A document drawn apart from the one being edited (a print, a thumbnail) is read into a Store of
 * its own, held as rows as the document is: no feature is made. The layers, the groups, the
 * stacking order, the metadata and the embedded files are copied at once; the rows a block at a
 * time (`copyNext`), each block built from the rows as they are read then (what was written in
 * place included) and added to the new Store (`addBlocks`), so that a large document does not hold
 * a frame. The rows are listed once, at the start, in the order of their layers: a row written
 * meanwhile is copied with the values it has when its block is read.
 */

import { DrawError } from '../api/errors.js';
import type { StoreView } from '../api/extension/store.js';
import type { FeatureTablesWriter } from '../api/tables.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { rowInputOf } from '../feature-table/row-read.js';
import {
  createRowBlockBuilder,
  type GroupEntry,
  ROW_BLOCK_TARGET_ROWS,
} from '../table/row-group-builder.js';
import type { Store } from './store.js';
import { createTableStore, type TableStoreOptions } from './table-memory.js';
import type { Feature, Group, Layer } from './types.js';

/**
 * A copy of a document held as rows, made a block of rows at a time
 *
 * @internal
 */
export interface TableStoreCopyState {
  readonly store: Store;
  readonly writer: FeatureTablesWriter;
  copyNext(): boolean;
}

/** The rows of a layer left to copy */
interface LayerRows {
  readonly layerId: string;
  readonly handles: Int32Array;
  at: number;
}

/**
 * Copies a document held as rows into a new Store of rows
 *
 * @throws `DrawError` with the code `invalid-input` when the Store does not hold its features as
 *   rows
 * @internal
 */
export function copyTableStore(
  source: StoreView,
  options: TableStoreOptions & { readonly blockRows?: number } = {},
): TableStoreCopyState {
  const internals = featureTablesInternals(source.tables);
  if (!internals || !source.tables) {
    throw new DrawError('invalid-input', 'The Store to copy does not hold its features as rows');
  }
  const { blockRows = ROW_BLOCK_TARGET_ROWS, ...tableOptions } = options;
  /** The key of the order of a group of features here: the one written last */
  const groupOrderOf = (handle: number): string | undefined =>
    internals.writtenOrders.get(handle) ?? internals.groups.orderOf(handle);
  const target = createTableStore({
    ...tableOptions,
    // The layers keep the dimensions of their coordinates (no value is dropped)
    dimensionsOf: (layerId) => internals.readContext.dimensionsOf(layerId),
  });
  const { store, writer } = target;
  const tables = source.tables;
  const order = source.getLayerOrder();
  const layers: Layer[] = [];
  for (const id of order) {
    const layer = source.getLayer(id);
    if (layer) layers.push(layer);
  }
  for (const layer of source.listLayers()) if (!order.includes(layer.id)) layers.push(layer);
  const groups = source.listGroups();
  /** The features of the layers of objects (a Store of the host may hold some), in their order */
  const objectFeatures: Feature[] = [];
  store.transact(() => {
    for (const layer of layers) {
      const { kind: _kind, ...fields } = layer as Layer & { items?: unknown };
      delete (fields as { items?: unknown }).items;
      store.createLayer({ ...fields, kind: 'table' } as Layer);
    }
    store.setLayerOrder([...order]);
    // The groups, at the keys of their order (their members follow from their rows)
    for (const group of groups) {
      const { kind: _kind, ...fields } = group as Group & { featureIds?: unknown };
      delete (fields as { featureIds?: unknown }).featureIds;
      store.createGroup({ ...fields, kind: 'table' } as Group);
      const sourceHandle = tables.findGroup(group.id);
      const targetHandle = store.tables?.findGroup(group.id);
      const key = sourceHandle === undefined ? undefined : groupOrderOf(sourceHandle);
      if (key !== undefined && targetHandle !== undefined) {
        writer.applyGroups({
          handles: Int32Array.of(targetHandle),
          fields: new Map([['order', [key]]]),
        });
      }
    }
    store.setMetadata({ ...source.getMetadata() });
    for (const file of source.listFiles()) store.createFile(file);
    for (const layer of layers) {
      if (layer.kind === 'table') continue;
      for (const itemId of layer.items) {
        const group = source.getGroup(itemId);
        const ids = group && group.kind !== 'table' ? group.featureIds : [itemId];
        for (const id of ids) {
          const feature = source.getFeature(id);
          if (feature) objectFeatures.push(feature);
        }
      }
    }
    for (const feature of objectFeatures) store.createFeature(feature);
  }, 'remote');

  // The rows of every layer of rows, listed once in their order
  const pending: LayerRows[] = [];
  for (const layer of layers) {
    const view = tables.get(layer.id);
    if (!view || layer.kind !== 'table') continue;
    pending.push({
      layerId: layer.id,
      handles: view.listRowHandles(0, view.rowCountWithDeleted),
      at: 0,
    });
  }
  // The groups the builder names the rows by: the handles of the new Store, by the handles here
  const groupEntries = new Map<string, GroupEntry[]>();
  const targetGroupOf = new Map<number, number>();
  for (const group of groups) {
    const sourceHandle = tables.findGroup(group.id);
    const targetHandle = store.tables?.findGroup(group.id);
    const key = sourceHandle === undefined ? undefined : groupOrderOf(sourceHandle);
    if (sourceHandle === undefined || targetHandle === undefined || key === undefined) continue;
    targetGroupOf.set(sourceHandle, targetHandle);
    let entries = groupEntries.get(group.layerId);
    if (!entries) {
      entries = [];
      groupEntries.set(group.layerId, entries);
    }
    entries.push({ handle: targetHandle, id: group.id, order: key });
  }

  return {
    store,
    writer,
    copyNext(): boolean {
      while (pending.length > 0) {
        const layer = pending[0] as LayerRows;
        if (layer.at >= layer.handles.length) {
          pending.shift();
          continue;
        }
        const builder = createRowBlockBuilder({
          groups: groupEntries.get(layer.layerId) ?? [],
          dimensions: internals.readContext.dimensionsOf(layer.layerId),
        });
        const end = Math.min(layer.handles.length, layer.at + Math.max(1, blockRows));
        for (; layer.at < end; layer.at++) {
          const place = internals.placeOf(layer.handles[layer.at] as number);
          if (!place) continue;
          const row = rowInputOf(internals.readContext, place.group, place.row);
          if (row.deleted) continue;
          const group = row.group ?? -1;
          builder.addRow({
            ...row,
            group: group >= 0 ? (targetGroupOf.get(group) ?? -1) : -1,
            ...(group >= 0 && !targetGroupOf.has(group) && { member: undefined }),
          });
        }
        if (builder.length > 0) writer.addBlocks(layer.layerId, builder.finish());
        if (layer.at >= layer.handles.length) pending.shift();
        return pending.length > 0;
      }
      return false;
    },
  };
}
