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

import type { GroupRef, TableGroupPatch as TablesGroupPatch, TablesWriter } from '@sakuzu/kasane';
import { KasaneError } from '@sakuzu/kasane';
import {
  ItemWalk,
  type ItemWalkSource,
  type PageData,
  ROW_FLAG_DELETED,
} from '@sakuzu/kasane/render';

import { utf8String } from '@sakuzu/tabane';
import type { FeatureTablesWriter, RowApplyOptions } from '../api/tables.js';
import { DrawError } from '../shared/draw-error.js';
import { asFeatureValues } from '../shared/feature-values.js';
import type {
  ItemOrderChange,
  RestoreToken,
  RowValues,
  StoreChange,
  TableGroupPatch,
} from '../shared/types/model.js';
import { drawErrorOf } from '../table/draw-error-of.js';
import { shapeOfGeometry } from '../table/feature-row-blocks.js';
import { tablesGroupPatchOf, tablesValuesOf } from '../table/tables-values.js';
import type { FeatureTablesInternals } from './feature-tables.js';
import {
  groupKeyMoves,
  type ItemOrderSource,
  ItemOrderWatch,
  ORDER_ITEM_LIMIT,
  PlacementOrder,
  type RowsPlacement,
} from './item-order.js';
import { rowsChangeOf } from './rows-change.js';

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
  /**
   * As `watchOrderOf`, for values that put rows in a place together (`placeRows` of the Store):
   * the changes of the order are made as the parts are written, from where the rows go
   * (`placement`) and from where each part read its rows before it was written, not from the
   * places of the rows once written (see `PlacementOrder`). Values of few rows are watched as
   * `watchOrderOf` watches them
   */
  watchPlacementOf(patch: RowValues, placement: RowsPlacement): () => void;
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
 * Values of rows as the tables take them: the GeoJSON geometries as shapes of Tabane
 * (`shapeOfGeometry`), every other field as it is
 *
 * @internal
 */
export function shapesOfGeometries(values: RowValues): RowValues {
  const geometries = values.fields.get('geometry');
  if (!geometries) return values;
  const fields = new Map(values.fields);
  fields.set('geometry', geometries.map(shapeOfGeometry));
  return { ...values, fields };
}

/**
 * Makes the writer of the features held as rows over the writer of their tables
 *
 * @param tables - The writer of the tables
 * @param internals - What the changes of the order read of the tables
 * @param notify - Where the changes of the document go (none: the writer only writes)
 * @param isLayer - Whether an id is a layer of the Store (none: any id that is not a group is a
 *   layer, the tables of a layer made when a row is put there)
 * @internal
 */
export function createFeatureTablesWriter(
  tables: TablesWriter,
  internals: FeatureTablesInternals,
  notify?: (change: StoreChange) => void,
  isLayer?: (id: string) => boolean,
): FeatureTablesStoreWriter {
  /**
   * The changes of the order of a write made in several parts, under way (`watchOrderOf`, or
   * `watchPlacementOf` with the order made as its parts are written)
   */
  let partsWatch: {
    readonly watch: ItemOrderWatch | null;
    readonly placed?: PlacementOrder;
  } | null = null;
  const orderSource: ItemOrderSource = {
    walkItems: (layerId) => internals.walkItems(layerId),
    getGroupKey: (group) => internals.getGroupKey(group),
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
    const { rows: handles, fields, deleted } = patch;
    const parents = fields.get('parent');
    const keys = fields.get('key');
    const placeFields = !!(parents || keys);
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
    const groupOf = (value: unknown): GroupRef =>
      typeof value === 'string' && value !== '' ? groups.handleOfId(value) : -1;
    // The layer of a parent: the layer of a group, or the parent itself (a layer)
    const layerOf = (value: unknown): string | undefined => {
      if (typeof value !== 'string' || value === '') return undefined;
      const group = groups.handleOfId(value);
      return group >= 0 ? groups.tableOf(group) : value;
    };
    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i];
      const place = internals.placeOf(handle);
      const deleting = !!deleted?.[i];
      if (!place || (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0) {
        // A new row, or a deleted one created again
        const layerId = layerOf(parents?.[i]) ?? place?.table.tableId;
        if (deleting || layerId === undefined) continue;
        watch.watchLayer(layerId);
        watch.watchGroup(groupOf(parents?.[i]));
        watch.row(handle, false);
        continue;
      }
      const data = place.group.data;
      const row = place.row;
      const group = data.groups[row];
      if (deleting) {
        watch.watchLayer(place.table.tableId);
        watch.watchGroup(group, place.table.tableId);
        watch.row(handle, true);
        continue;
      }
      // A row there that no field of its place is written for keeps its place
      if (!placeFields) continue;
      const parent = parents?.[i];
      const layerId = layerOf(parent);
      const nextGroup = parent !== undefined ? groupOf(parent) : group;
      const key = keys?.[i];
      const moved =
        (layerId !== undefined && layerId !== place.table.tableId) ||
        nextGroup !== group ||
        (key !== undefined && key !== utf8String(data.keys, row));
      if (!moved) continue;
      watch.watchLayer(place.table.tableId);
      if (layerId !== undefined) watch.watchLayer(layerId);
      // The members of a group given another layer are read where they are until written there
      watch.watchGroup(group, place.table.tableId);
      watch.watchGroup(nextGroup);
      watch.row(handle, false);
    }
    if (!watch.changes) return null;
    watch.keep();
    return watch;
  };

  /**
   * The items of the layers a write of groups takes groups with members to another layer from and
   * to, kept before it: the groups move there with their members (null when it moves none)
   */
  const watchFollowers = (patch: TableGroupPatch): ItemOrderWatch | null => {
    const parents = patch.fields.get('parent');
    if (!parents) return null;
    const groups = internals.groups;
    const watch = new ItemOrderWatch(orderSource);
    for (let i = 0; i < patch.groups.length; i++) {
      const parent = parents[i];
      const group = patch.groups[i];
      const before = groups.tableOf(group);
      if (patch.deleted?.[i] || typeof parent !== 'string' || before === undefined) continue;
      if (parent === before) continue;
      const members = internals.membersIn(before, group);
      if (members.length === 0) continue;
      watch.watchLayer(before);
      watch.watchLayer(parent);
      watch.watchGroup(group, before);
      for (const member of members) watch.row(member, false);
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
    const { groups: handles, fields, deleted } = patch;
    const orderValues = fields.get('key');
    if (!orderValues) return [];
    const layerValues = fields.get('parent');
    const groups = internals.groups;
    // The groups the write creates, and the layers of the groups it gives another, as it goes
    const created = new Set<GroupRef>();
    const layersNow = new Map<GroupRef, string>();
    const orders = new Map<string, Map<GroupRef, string>>();
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
      const layerId = layerValue ?? layersNow.get(group) ?? (groups.tableOf(group) as string);
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
            groupTableOf: (group) => layersNow.get(group) ?? groups.tableOf(group),
          };
    const source: ItemOrderSource =
      walkSource === internals
        ? orderSource
        : {
            ...orderSource,
            walkItems: (layerId) => {
              const layer = internals.rowTable(layerId);
              return layer ? new ItemWalk(layer, walkSource) : null;
            },
          };
    const moves: ItemOrderChange[] = [];
    for (const [layerId, list] of orders) moves.push(...groupKeyMoves(source, layerId, list));
    return moves;
  };

  /**
   * Refuses a write whose parent of a row is neither a layer of the Store nor a group, before
   * anything is written: the tables would hold the row in a table of that id
   *
   * @throws `DrawError` with the code `notFound`
   */
  const checkParents = (values: RowValues): void => {
    const parents = values.fields.get('parent');
    if (!isLayer || !parents) return;
    parents.forEach((parent, i) => {
      if (typeof parent !== 'string' || parent === '' || values.deleted?.[i]) return;
      if (isLayer(parent) || internals.groups.handleOfId(parent) >= 0) return;
      throw new DrawError(
        'notFound',
        `FeatureTables: the parent "${parent}" is unknown (neither a layer nor a group)`,
      );
    });
  };

  const watchOrderOf = (patch: RowValues): (() => void) => {
    const parts = { watch: watchOrder(patch) };
    partsWatch = parts;
    return () => {
      if (partsWatch !== parts) return;
      partsWatch = null;
      const order = parts.watch?.finish() ?? [];
      if (order.length > 0) notify?.({ order });
    };
  };

  return {
    lookup: (id) => {
      try {
        const found = tables.lookup(id);
        return found && { row: found.row, deleted: found.deleted };
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
        tables.forgetIds(handles);
      } catch (error) {
        throw writerError(error);
      }
    },
    allocateRowRefs: (ids, hashes) => {
      try {
        return tables.allocateRowRefs(ids, hashes);
      } catch (error) {
        throw writerError(error);
      }
    },
    // The blocks are made by the builder and the merge of the library
    addPages: (layerId, blocks) => {
      try {
        const rows = rowsChangeOf(tables.addPages(layerId, blocks as readonly PageData[]).rows);
        notify?.({ rows });
        return rows;
      } catch (error) {
        throw writerError(error);
      }
    },
    writeRows: (values, options: RowApplyOptions = {}) => {
      try {
        checkParents(values);
        // A part of a write made in several parts: its changes of the order are told at its end
        const watch = partsWatch ? null : watchOrder(values);
        partsWatch?.placed?.part(values);
        const written = tables.writeRows(tablesValuesOf(shapesOfGeometries(values)), options);
        const rows = rowsChangeOf(written.rows);
        const kept = written.kept;
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
              ...(options.before && { previousValues: asFeatureValues(options.before) }),
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
    writeGroups: (patch, options: RowApplyOptions = {}) => {
      try {
        const followers = notify ? watchFollowers(patch) : null;
        const moves = notify ? groupMovesOf(patch) : [];
        const written = tables.writeGroups(withoutNames(patch), options);
        const rows = rowsChangeOf(written.rows);
        const kept = written.kept;
        // A group created again whose id is hidden on this client is hidden again
        internals.states.groupsWritten(patch.groups);
        const order = [...(followers?.finish() ?? []), ...moves];
        if (rows.layers.size > 0) notify?.({ rows, ...(order.length > 0 && { order }) });
        else if (order.length > 0) notify?.({ order });
        if (kept) notify?.({ restoreToken: options.restoreToken });
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
    watchOrderOf,
    watchPlacementOf: (patch, placement) => {
      if (!notify || patch.rows.length <= ORDER_ITEM_LIMIT) return watchOrderOf(patch);
      const parts = { watch: null, placed: new PlacementOrder(orderSource, patch, placement) };
      partsWatch = parts;
      return () => {
        if (partsWatch !== parts) return;
        partsWatch = null;
        const order = parts.placed.finish();
        if (order.length > 0) notify({ order });
      };
    },
  };
}

/**
 * The values of groups as the tables take them: the names of the groups are kept by the Store
 * (`TableGroupField`), so they are checked and taken out
 *
 * @throws `DrawError` with the code `invalidInput` when a name is not a string
 */
function withoutNames(patch: TableGroupPatch): TablesGroupPatch {
  const names = patch.fields.get('name');
  if (!names) return tablesGroupPatchOf(patch);
  names.forEach((name, i) => {
    if (name !== undefined && typeof name !== 'string' && !patch.deleted?.[i]) {
      throw new DrawError(
        'invalidInput',
        `FeatureTables: the name of the group ${patch.groups[i]} is not a string`,
      );
    }
  });
  const fields = new Map(patch.fields);
  fields.delete('name');
  return tablesGroupPatchOf({ ...patch, fields });
}
