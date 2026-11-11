// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tables joined to the words of the model: the implementation of the tables (`TablesStore`,
 * with its writer, `TablesWriter`) given the columns of the model, its operations written to them
 * as values of rows and of groups, and what is read of them in the words of the model
 *
 * Only what the tables declare is used: their writer, what lets go of a token, and what the side
 * that draws the rows reads (the items of a table walked in order, where a row is read, the
 * groups). A row is read back as their builder takes it.
 */

import { type TabaneShape, utf8ColumnFromStrings } from '@sakuzu/tabane';
import { rowInputColumnsOf, rowInputOfGroup } from '../../feature-table/row-group-read.js';
import type { TableColumns } from '../../feature-table/row-values.js';
import type { StyleTable } from '../../feature-table/style-table.js';
import { TablesStore } from '../../feature-table/tables-store.js';
import type { TableGroupField, TableGroupPatch } from '../../feature-table/tables-writer.js';
import { rowColumnLayoutOf } from '../../table/row-columns.js';
import { createRowBlockDataBuilder, type GroupEntry } from '../../table/row-group-builder.js';
import { GROUP_HANDLE_BASE, GROUP_IDS, ROW_IDS, TABLE_IDS } from './model.js';
import type {
  ModelItem,
  ModelNewRow,
  ModelOperation,
  ModelRowRead,
  ModelRowValues,
  ModelShape,
  ModelSnapshot,
  ModelSubject,
  ModelUse,
} from './types.js';

/** The columns of the rows of every use */
export const MODEL_COLUMNS: TableColumns = Object.freeze({
  shape: 'shape',
  type: Object.freeze({ kind: 'whole', dictionary: 'rowBlock' }),
  look: Object.freeze({ kind: 'whole', dictionary: 'tables' }),
  attrs: 'keyed',
  hidden: 'flag',
  pinned: 'flag',
});

/** The columns of the groups of every use */
export const MODEL_GROUP_COLUMNS: TableColumns = Object.freeze({ hidden: 'flag', pinned: 'flag' });

/** The fields of the values of rows a write of the model writes */
function fieldsOf(
  rows: ReadonlyArray<{
    readonly parent?: string;
    readonly key?: string;
    readonly values: ModelRowValues;
  }>,
): Map<string, unknown[]> {
  const fields = new Map<string, unknown[]>();
  const set = (field: string, i: number, value: unknown): void => {
    let list = fields.get(field);
    if (!list) {
      list = new Array(rows.length).fill(undefined);
      fields.set(field, list);
    }
    list[i] = value;
  };
  rows.forEach(({ parent, key, values }, i) => {
    if (parent !== undefined) set('parent', i, parent);
    if (key !== undefined) set('key', i, key);
    if (values.type !== undefined) set('type', i, values.type);
    if (values.shape !== undefined) set('shape', i, values.shape as TabaneShape);
    if (values.look !== undefined) set('look', i, values.look);
    if (values.hidden !== undefined) set('hidden', i, values.hidden);
    if (values.pinned !== undefined) set('pinned', i, values.pinned);
    for (const [k, value] of Object.entries(values.attrs ?? {})) set(`attrs:${k}`, i, value);
  });
  return fields;
}

/**
 * The tables of a use, joined to the model
 */
export function tablesSubject(use: ModelUse): ModelSubject {
  const released: string[] = [];
  const idOfHandle = new Map<number, string>();
  const store = new TablesStore({
    columns: MODEL_COLUMNS,
    groupColumns: MODEL_GROUP_COLUMNS,
    relocatingFields: use.relocating,
    dimensionsOf: () => use.dims,
    onRelease: (handles) => {
      for (const handle of handles) released.push(idOfHandle.get(handle) ?? `#${handle}`);
    },
  });
  const columns = rowInputColumnsOf(rowColumnLayoutOf(MODEL_COLUMNS));
  const tokens: number[] = [];
  let kept: boolean | null = null;

  const handlesOf = (ids: readonly string[]): Int32Array => {
    const handles = store.allocateHandles(utf8ColumnFromStrings([...ids]));
    handles.forEach((handle, i) => {
      idOfHandle.set(handle, ids[i]);
    });
    return handles;
  };
  const tokenOf = (token: number | null): number | undefined => {
    if (token === null) return undefined;
    tokens[token] ??= store.createRestoreToken();
    return tokens[token];
  };
  const writeGroups = (patch: TableGroupPatch, token?: number): void => {
    kept = store.applyGroups(patch, token === undefined ? {} : { restoreToken: token }).kept;
  };
  const groupFields = (entries: ReadonlyArray<readonly [string, unknown]>) =>
    new Map(entries.map(([field, value]) => [field as TableGroupField, [value]]));

  const addBlock = (table: string, rows: readonly ModelNewRow[]): void => {
    const groups: GroupEntry[] = [];
    for (const id of GROUP_IDS) {
      const handle = store.groups.handleOfId(id);
      if (handle >= 0 && store.groups.tableOf(handle) === table) {
        groups.push({ handle, id, key: store.groups.orderOf(handle) ?? '' });
      }
    }
    const builder = createRowBlockDataBuilder({
      columns: MODEL_COLUMNS,
      groups,
      dimensions: use.dims,
      targetRows: 2,
    });
    for (const row of rows) {
      const group = store.groups.handleOfId(row.parent);
      builder.addRow({
        id: row.id,
        key: row.key,
        ...(group >= 0 ? { group } : {}),
        values: {
          type: row.values.type,
          shape: row.values.shape,
          look: row.values.look,
          attrs: row.values.attrs,
          hidden: row.values.hidden,
          pinned: row.values.pinned,
        },
      });
    }
    kept = store.addRowBlocks(table, builder.finish()).kept;
    for (const row of rows) {
      const found = store.lookup(row.id);
      if (found) idOfHandle.set(found.handle, row.id);
    }
  };

  return {
    apply(operation: ModelOperation): void {
      switch (operation.kind) {
        case 'createRows': {
          const handles = handlesOf(operation.rows.map(({ id }) => id));
          kept = store.apply({
            handles,
            fields: fieldsOf(operation.rows),
            deleted: new Uint8Array(handles.length),
          }).kept;
          return;
        }
        case 'addBlock':
          addBlock(operation.table, operation.rows);
          return;
        case 'writeRow': {
          const handles = handlesOf([operation.id]);
          kept = store.apply({ handles, fields: fieldsOf([operation]) }).kept;
          return;
        }
        case 'deleteRows': {
          const handles = handlesOf(operation.ids);
          const token = tokenOf(operation.token);
          kept = store.apply(
            { handles, fields: new Map(), deleted: new Uint8Array(handles.length).fill(1) },
            token === undefined ? {} : { restoreToken: token },
          ).kept;
          return;
        }
        case 'restoreRows': {
          const handles = handlesOf(operation.ids);
          kept = store.apply({
            handles,
            fields: new Map(),
            deleted: new Uint8Array(handles.length),
          }).kept;
          return;
        }
        case 'release':
          store.release(tokens[operation.token]);
          return;
        case 'forget': {
          const handles = operation.ids.map((id) => store.lookup(id)?.handle ?? -1);
          store.forget(Int32Array.from(handles.filter((handle) => handle >= 0)));
          return;
        }
        case 'createGroup':
          writeGroups({
            handles: Int32Array.of(operation.handle),
            fields: groupFields([
              ['id', operation.id],
              ['key', operation.key],
              ['parent', operation.table],
              ['hidden', operation.flags.hidden],
              ['pinned', operation.flags.pinned],
            ]),
          });
          return;
        case 'writeGroup': {
          const entries: Array<readonly [string, unknown]> = [];
          if (operation.key !== undefined) entries.push(['key', operation.key]);
          if (operation.table !== undefined) entries.push(['parent', operation.table]);
          for (const [flag, value] of Object.entries(operation.flags ?? {})) {
            entries.push([flag, value]);
          }
          writeGroups({ handles: Int32Array.of(operation.handle), fields: groupFields(entries) });
          return;
        }
        case 'deleteGroup':
          writeGroups(
            {
              handles: Int32Array.of(operation.handle),
              fields: new Map(),
              deleted: Uint8Array.of(1),
            },
            tokenOf(operation.token),
          );
          return;
        case 'restoreGroup':
          writeGroups({
            handles: Int32Array.of(operation.handle),
            fields: new Map(),
            deleted: Uint8Array.of(0),
          });
          return;
      }
    },
    settle(): void {
      store.addQueuedRowBlocks();
      store.flushVersions();
    },
    read(): ModelSnapshot {
      const groups = store.groups;
      const tables: Record<string, ModelItem[]> = {};
      for (const table of TABLE_IDS) {
        const items: ModelItem[] = [];
        const walk = store.walkItems(table);
        for (
          let code = walk?.bottom(-1) ?? null;
          walk && code !== null;
          code = walk.above(code, -1)
        ) {
          if ((code & 1) === 0) {
            items.push({ row: store.ids.idOf(code >> 1) ?? `#${code >> 1}` });
          } else {
            const group = code >> 1;
            items.push({
              group: groups.idOf(group) ?? `#${group}`,
              members: walk.members(group).map((handle) => store.ids.idOf(handle) ?? `#${handle}`),
            });
          }
        }
        tables[table] = items;
      }
      const rows: Record<string, ModelRowRead | 'deleted' | 'none'> = {};
      for (const id of ROW_IDS) {
        const found = store.lookup(id);
        if (!found) rows[id] = 'none';
        else if (found.deleted) rows[id] = 'deleted';
        else {
          const place = store.placeOf(found.handle);
          if (!place) {
            rows[id] = 'none';
            continue;
          }
          const input = rowInputOfGroup(
            columns,
            store.styles as StyleTable,
            place.group,
            place.row,
          );
          const group = input.group ?? -1;
          rows[id] = {
            table: place.table.tableId,
            group: group >= 0 ? (groups.idOf(group) ?? `#${group}`) : null,
            key: input.key,
            type: input.values.type as string,
            shape: (input.values.shape as ModelShape | null) ?? null,
            look: input.values.look,
            attrs: input.values.attrs as Record<string, unknown>,
            hidden: input.values.hidden === true,
            pinned: input.values.pinned === true,
          };
        }
      }
      const held: Record<string, { table: string; key: string; hidden: boolean; pinned: boolean }> =
        {};
      const hiddenBit = groups.flagBitOf('hidden');
      const pinnedBit = groups.flagBitOf('pinned');
      for (const id of GROUP_IDS) {
        const handle = GROUP_HANDLE_BASE + GROUP_IDS.indexOf(id);
        if (!groups.has(handle)) continue;
        const flags = groups.flagsOf(handle);
        held[id] = {
          table: groups.tableOf(handle) ?? '',
          key: groups.orderOf(handle) ?? '',
          hidden: (flags & hiddenBit) !== 0,
          pinned: (flags & pinnedBit) !== 0,
        };
      }
      return { tables, rows, groups: held, released: [...released], kept };
    },
  };
}
