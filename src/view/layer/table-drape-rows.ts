// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows of the layers of the Store as the analytic drape collects them (`DrapeStoreRows` of
 * `terrain/drape/pass.ts`), read from the rows without making their features
 *
 * A layer is read in the order its rows are drawn: its row groups in their order, with the rows
 * of the parts of its delta at their places among them (`DrawnRows.deltaInserts`). The rows left
 * out are those its features would not be shown for (`getDisplayFeatures`): a row not drawn
 * (hidden by its own flag or by its group, deleted, read elsewhere), a row this client hides, or
 * whose group it hides; a layer hidden, or hidden on this client, gives no row. The styles are
 * resolved once per number of style, type and color of the style rule (`RowStyleSlots`), as the
 * drawing of the rows resolves them.
 */

import type { DeltaInsert, DrawnRows, RowGroup } from '../../store/built-in/drawn-rows.js';
import type { DocumentAccess } from '../../store/document-access.js';
import type { RetainedStyleResolver } from '../renderers/retained.js';
import type { DrapeStoreRow, DrapeStoreRows } from '../terrain/drape/pass.js';
import { RowStyleSlots, rowCreatedZoom, rowGeometryOf } from './table-collect.js';

/**
 * The rows of the layers of a Store as the drape collects them
 *
 * @param reader What the drawing reads of the rows of the built-in Store
 * @param store The layer over the Store (the layers, what this client hides)
 * @param resolver The resolution of the styles the elements are collected with
 * @internal
 */
export function drapeRowsOf(
  reader: DrawnRows,
  store: DocumentAccess,
  resolver: RetainedStyleResolver,
): DrapeStoreRows {
  // What this client hides, read once for the collection
  const hidden = new Set(store.listHidden());
  return {
    forEachRow(layerId, visit) {
      const layer = store.getLayer(layerId);
      if (!layer || layer.visible === false || hidden.has(layerId)) return;
      const table = reader.table(layerId);
      if (!table) return;
      const slots = new RowStyleSlots(resolver, reader, layer.styleRule);
      const inserts = new Map<number, DeltaInsert[]>();
      for (const insert of reader.deltaInserts(table)) {
        let list = inserts.get(insert.group);
        if (!list) {
          list = [];
          inserts.set(insert.group, list);
        }
        list.push(insert);
      }
      const visitRow = (group: RowGroup, row: number): void => {
        if (reader.notDrawn(group, row)) return;
        const id = reader.idOf(reader.refOf(group, row));
        if (id === undefined || hidden.has(id)) return;
        const groupId = reader.groupIdOf(group, row);
        if (groupId !== undefined && hidden.has(groupId)) return;
        const geometry = rowGeometryOf(group, row);
        if (!geometry) return;
        const type = reader.typeOf(group, row);
        const style = reader.styleNumberOf(group, row);
        const ruleColor = (): string | null => slots.ruleColorOf(group, row);
        const coordinates = geometry.reader.coordinatesOf(geometry.at);
        const drapeRow: DrapeStoreRow = {
          id,
          type,
          // The coordinates are read anew for each collection: they are the key of what is kept
          key: coordinates as object,
          coordinates,
          createdZoom: rowCreatedZoom(group, row),
          polygonStyles: () => slots.polygon(style, type, ruleColor()).resolved,
          lineStyle: () => slots.line(style, type, ruleColor()).stroke,
        };
        visit(drapeRow);
      };
      const visitInsert = (insert: DeltaInsert): void => {
        for (let row = insert.from; row < insert.to; row++) visitRow(insert.rows, row);
      };
      for (let g = 0; g < table.groupCount; g++) {
        const group = table.groupAt(g);
        const list = inserts.get(g) ?? [];
        let next = 0;
        for (let row = 0; row < group.data.length; row++) {
          while (next < list.length && list[next].at <= row) visitInsert(list[next++]);
          visitRow(group, row);
        }
        while (next < list.length) visitInsert(list[next++]);
      }
      for (const insert of inserts.get(-1) ?? []) visitInsert(insert);
    },
  };
}
