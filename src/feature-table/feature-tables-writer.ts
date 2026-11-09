// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The writer of the features held as rows (`FeatureTablesWriter`), over the writer of the tables
 *
 * The tables write the rows and return what they wrote (`TablesWriter`); they tell nobody. This
 * writer is core's: it hands an error of the tables out as a `DrawError`, and when it is given
 * where the changes of the document go (`notify`: the Store of rows, which adds them to the
 * notification of its transaction), it makes them. Before a write it reads what the changes of the
 * order are made of (the items the write disturbs, `item-order.ts`), and after it tells the rows
 * written (`rows`), the values before it was given (`previousValues`), the changes of the order
 * (`order`), the token of the write when the tables kept something the write deleted with it
 * (`restoreToken`), and the tables emptied (`reset`). Without `notify` it only writes.
 *
 * Each call is one call of the writer of the tables, with what the tables were given: nothing is
 * copied row by row.
 */

import { utf8String } from '@sakuzu/tabane';
import type { FeatureTablesWriter, RowApplyOptions } from '../api/tables.js';
import type {
  ItemOrderChange,
  RestoreToken,
  RowValues,
  StoreChange,
} from '../shared/types/model.js';
import { drawErrorOf } from '../table/draw-error-of.js';
import { KasaneError } from '../table/kasane-error.js';
import { ROW_FLAG_DELETED, type RowBlockData } from '../table/row-group-types.js';
import type { FeatureTablesInternals } from './feature-tables.js';
import {
  groupKeyMoves,
  type ItemOrderSource,
  ItemOrderWatch,
  ORDER_ITEM_LIMIT,
} from './item-order.js';
import { ItemWalk, type ItemWalkSource } from './item-walk.js';
import type { TableGroupPatch, TablesWriter } from './tables-writer.js';
import type { GroupHandle } from './types.js';

/**
 * The writer of the features held as rows, with what the Store of rows calls besides
 *
 * @internal
 */
export interface FeatureTablesStoreWriter extends FeatureTablesWriter {
  /**
   * Tells the changes of the order of a write made in several parts (a restore written in steps)
   * once, as one write of the whole of it would: the items it disturbs are read now, the writes of
   * rows tell no change of the order until the function returned is called, which tells the
   * changes the whole write made
   */
  watchOrderOf(patch: RowValues): () => void;
}

/**
 * What a write threw, as the writer throws it: an error of the tables (`KasaneError`) as a
 * `DrawError` of the same code (`drawErrorOf`), anything else (a `DrawError`, what a function
 * given to the tables or `notify` threw) as it is
 */
function writerError(error: unknown): unknown {
  return error instanceof KasaneError ? drawErrorOf(error) : error;
}

/**
 * Makes the writer of the features held as rows over the writer of their tables
 *
 * @param tables - The writer of the tables
 * @param internals - What the changes of the order read of the tables
 * @param notify - Where the changes of the document go (none: the writer only writes)
 * @internal
 */
export function createFeatureTablesWriter(
  tables: TablesWriter,
  internals: FeatureTablesInternals,
  notify?: (change: StoreChange) => void,
): FeatureTablesStoreWriter {
  /** The changes of the order of a write made in several parts, under way (`watchOrderOf`) */
  let partsWatch: { readonly watch: ItemOrderWatch | null } | null = null;
  const orderSource: ItemOrderSource = {
    walkItems: (layerId) => {
      const layer = internals.layerTable(layerId);
      return layer ? new ItemWalk(layer, internals) : null;
    },
    getGroupKey: (group) => internals.getGroupOrder(group),
    groups: internals.groups,
    idOf: (handle) => internals.ids.idOf(handle),
    placeOf: (handle) => internals.placeOf(handle),
  };

  /**
   * The items of the layers and the groups a write puts rows in, takes rows from, creates or
   * deletes rows in, kept before it to tell the changes of the order it makes (null when it makes
   * none, or when nothing is told)
   */
  const watchOrder = (patch: RowValues): ItemOrderWatch | null => {
    if (!notify) return null;
    const { handles, fields, deleted } = patch;
    const layerIds = fields.get('layerId');
    const groupIds = fields.get('groupId');
    const orders = fields.get('order');
    const members = fields.get('member');
    const placeFields = !!(layerIds || groupIds || orders || members);
    // Rows only deleted and created again, more than are told one at a time: they are told by
    // the change of the rows alone (`ItemOrderWatch`), so nothing is kept for them (the deletion
    // of a layer of 100,000 rows, and its undo)
    if (!placeFields && handles.length > ORDER_ITEM_LIMIT) {
      let flips = 0;
      for (let i = 0; i < handles.length; i++) {
        const place = internals.placeOf(handles[i]);
        const there = !!place && (place.group.data.flags[place.row] & ROW_FLAG_DELETED) === 0;
        if (there ? !!deleted?.[i] : !!place && !deleted?.[i]) flips++;
      }
      if (flips > ORDER_ITEM_LIMIT) return null;
    }
    const watch = new ItemOrderWatch(orderSource);
    const groups = internals.groups;
    const groupOf = (value: unknown): GroupHandle =>
      typeof value === 'string' && value !== '' ? groups.handleOfId(value) : -1;
    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i];
      const place = internals.placeOf(handle);
      const deleting = !!deleted?.[i];
      if (!place || (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0) {
        // A new row, or a deleted one created again
        const layerId = (layerIds?.[i] as string | undefined) ?? place?.layer.layerId;
        if (deleting || layerId === undefined) continue;
        watch.watchLayer(layerId);
        watch.watchGroup(groupOf(groupIds?.[i]));
        watch.row(handle, false);
        continue;
      }
      const data = place.group.data;
      const row = place.row;
      const group = data.groups[row];
      if (deleting) {
        watch.watchLayer(place.layer.layerId);
        watch.watchGroup(group);
        watch.row(handle, true);
        continue;
      }
      // A row there that no field of its place is written for keeps its place
      if (!placeFields) continue;
      const layerId = layerIds?.[i] as string | undefined;
      const nextGroup = groupIds ? groupOf(groupIds[i]) : group;
      const order = orders?.[i];
      const moved =
        (layerId !== undefined && layerId !== place.layer.layerId) ||
        nextGroup !== group ||
        (order !== undefined && order !== utf8String(data.itemKeys, row)) ||
        (members !== undefined &&
          nextGroup >= 0 &&
          (members[i] ?? '') !== utf8String(data.memberKeys, row));
      if (!moved) continue;
      watch.watchLayer(place.layer.layerId);
      if (layerId !== undefined) watch.watchLayer(layerId);
      watch.watchGroup(group);
      watch.watchGroup(nextGroup);
      watch.row(handle, false);
    }
    if (!watch.changes) return null;
    watch.keep();
    return watch;
  };

  /**
   * The moves of the groups given a new key by a write of groups, with the keys before (told when
   * they are written, whenever the order of their members goes in), read before the write: the
   * groups given a new key as the tables take it (a key other than the one of the table of the
   * groups), each in the layer the write leaves it in. Values the tables refuse are left to them
   * (nothing is told then)
   */
  const groupMovesOf = (patch: TableGroupPatch): ItemOrderChange[] => {
    const { handles, fields, deleted } = patch;
    const orderValues = fields.get('order');
    if (!orderValues) return [];
    const layerValues = fields.get('layerId');
    const groups = internals.groups;
    // The groups the write creates, and the layers of the groups it gives another, as it goes
    const created = new Set<GroupHandle>();
    const layersNow = new Map<GroupHandle, string>();
    const orders = new Map<string, Map<GroupHandle, string>>();
    for (let i = 0; i < handles.length; i++) {
      if (deleted?.[i]) continue;
      const group = handles[i];
      const layerValue = layerValues?.[i];
      const order = orderValues[i];
      if (layerValue !== undefined && typeof layerValue !== 'string') return [];
      if (order !== undefined && typeof order !== 'string') return [];
      if (created.has(group) || !groups.has(group)) {
        // A new group has no member yet: it moves nothing
        created.add(group);
        continue;
      }
      const layerId = layerValue ?? layersNow.get(group) ?? (groups.layerOf(group) as string);
      if (layerValue !== undefined) layersNow.set(group, layerValue);
      if (order === undefined || order === groups.orderOf(group)) continue;
      let list = orders.get(layerId);
      if (!list) {
        list = new Map();
        orders.set(layerId, list);
      }
      list.set(group, order);
    }
    if (orders.size === 0) return [];
    // The walks read the groups in the layers the write leaves them in
    const walkSource: ItemWalkSource =
      layersNow.size === 0
        ? internals
        : {
            groups,
            placeOf: (handle) => internals.placeOf(handle),
            writtenOrders: internals.writtenOrders,
            groupTableOf: (group) => layersNow.get(group) ?? groups.layerOf(group),
          };
    const source: ItemOrderSource =
      walkSource === internals
        ? orderSource
        : {
            ...orderSource,
            walkItems: (layerId) => {
              const layer = internals.layerTable(layerId);
              return layer ? new ItemWalk(layer, walkSource) : null;
            },
          };
    const moves: ItemOrderChange[] = [];
    for (const [layerId, list] of orders) moves.push(...groupKeyMoves(source, layerId, list));
    return moves;
  };

  return {
    lookup: (id) => {
      try {
        return tables.lookup(id);
      } catch (error) {
        throw writerError(error);
      }
    },
    createRestoreToken: () => {
      try {
        // The tables make a number; core names it a token
        return tables.createRestoreToken() as RestoreToken;
      } catch (error) {
        throw writerError(error);
      }
    },
    forget: (handles) => {
      try {
        tables.forget(handles);
      } catch (error) {
        throw writerError(error);
      }
    },
    allocateHandles: (ids, hashes) => {
      try {
        return tables.allocateHandles(ids, hashes);
      } catch (error) {
        throw writerError(error);
      }
    },
    // The blocks are made by the builder and the merge of the library
    addRowBlocks: (layerId, blocks) => {
      try {
        const { rows } = tables.addRowBlocks(layerId, blocks as readonly RowBlockData[]);
        notify?.({ rows });
        return rows;
      } catch (error) {
        throw writerError(error);
      }
    },
    apply: (values, options: RowApplyOptions = {}) => {
      try {
        // A part of a write made in several parts: its changes of the order are told at its end
        const watch = partsWatch ? null : watchOrder(values);
        const { rows, kept } = tables.apply(values, options);
        if (notify) {
          // The values before, the token that keeps the rows deleted and the changes of the order
          // go with the last of the additions to the notification
          const order = watch?.finish() ?? [];
          const extra: StoreChange = {
            ...(order.length > 0 && { order }),
            ...(kept &&
              options.restoreToken !== undefined && { restoreToken: options.restoreToken }),
          };
          const hasRows = rows.layers.size > 0 || options.before !== undefined;
          if (hasRows) {
            notify({
              rows,
              ...(options.before && { previousValues: options.before }),
              ...extra,
            });
          }
          if (!hasRows && Object.keys(extra).length > 0) notify(extra);
        }
        return rows;
      } catch (error) {
        throw writerError(error);
      }
    },
    applyGroups: (patch, options: RowApplyOptions = {}) => {
      try {
        const moves = notify ? groupMovesOf(patch) : [];
        const { kept } = tables.applyGroups(patch, options);
        if (moves.length > 0) notify?.({ order: moves });
        if (kept) notify?.({ restoreToken: options.restoreToken });
      } catch (error) {
        throw writerError(error);
      }
    },
    getGroupOrder: (groupHandle) => {
      try {
        return internals.getGroupOrder(groupHandle);
      } catch (error) {
        throw writerError(error);
      }
    },
    clear: () => {
      try {
        const { emptied } = tables.clear();
        if (emptied) notify?.({ reset: true });
      } catch (error) {
        throw writerError(error);
      }
    },
    watchOrderOf: (patch) => {
      const parts = { watch: watchOrder(patch) };
      partsWatch = parts;
      return () => {
        if (partsWatch !== parts) return;
        partsWatch = null;
        const order = parts.watch?.finish() ?? [];
        if (order.length > 0) notify?.({ order });
      };
    },
  };
}
