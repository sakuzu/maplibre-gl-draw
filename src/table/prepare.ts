// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The preparation of a table, callable in a Worker
 *
 * It computes what a dataset needs before it can draw and hit test a table: the bbox of every
 * row, the spatial chunks and the spatial index. Done in a Worker together with the reading of a
 * file, the main thread receives the table and this result without a copy and computes none of
 * it again.
 *
 * A pure module: it depends on neither maplibre nor WebGL nor the DOM.
 */

import { buildPackedRTree } from './packed-rtree.js';
import { partitionRows } from './partition.js';
import { isDictionaryColumn, TableReader } from './table.js';
import type { Column, PreparedTable, Table, TableGeometry } from './types.js';

/**
 * Computes the bboxes, the spatial chunks and the spatial index of a table, and returns them
 * with the table.
 *
 * It is the work that the dataset would otherwise do on the main thread when it is given the
 * table. Call it where the table is read (in a Worker), send the result to the main thread and
 * pass it as `table` to `addDataset` or to `Dataset.setTable`. It uses neither maplibre nor
 * WebGL, so it runs in any Worker.
 *
 * @param table The table
 * @returns The table with its prepared arrays, which belong to this table only
 * @throws when the shape of the table does not add up (the same checks as `Dataset.setTable`)
 *
 * @example In a Worker
 * ```ts
 * import { prepareTable, transferList } from '@sakuzu/maplibre-gl-draw/table';
 *
 * self.onmessage = async (event) => {
 *   const table = await readTable(event.data); // your reader, which returns a Table
 *   const prepared = prepareTable(table);
 *   self.postMessage(prepared, { transfer: transferList(prepared) });
 * };
 * ```
 */
export function prepareTable(table: Table): PreparedTable {
  const reader = new TableReader(table);
  const bounds = reader.computeBounds();
  const chunks = partitionRows(bounds, reader.computeVertexCounts());
  const index = buildPackedRTree(bounds);
  return {
    table,
    length: reader.length,
    bounds,
    chunkRows: chunks.rows,
    chunkOffsets: chunks.offsets,
    chunkBounds: chunks.bounds,
    indexNodeSize: index.nodeSize,
    indexItemCount: index.numItems,
    indexBoxes: index.boxes,
    indexEntries: index.indices,
    indexLevels: index.levelBounds,
  };
}

/**
 * Whether a value is a prepared table rather than a bare table
 *
 * @internal
 */
export function isPreparedTable(value: Table | PreparedTable): value is PreparedTable {
  return 'table' in value && typeof value.table === 'object' && value.table !== null;
}

/**
 * Lists the buffers of a table, or of a prepared table, for the transfer list of `postMessage`.
 *
 * The buffers move to the other thread without a copy. The geometry arrays of every child of a
 * mixed geometry column are listed too, and for a prepared table the prepared arrays as well.
 * Each buffer appears once, even when several arrays share it. A `SharedArrayBuffer` is left
 * out (it is shared, not moved). After the transfer the arrays are empty on the sending side.
 *
 * @param table The table, or the result of {@link prepareTable}
 * @returns The buffers to pass as the transfer list
 *
 * @example
 * ```ts
 * const prepared = prepareTable(tableFromFeatures(features));
 * self.postMessage(prepared, { transfer: transferList(prepared) });
 * ```
 */
export function transferList(table: Table | PreparedTable): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (view: ArrayBufferView | undefined): void => {
    if (view && view.buffer instanceof ArrayBuffer) buffers.add(view.buffer);
  };
  const addColumn = (column: Column | undefined): void => {
    if (!column) return;
    if (isDictionaryColumn(column)) add(column.codes);
    else if (ArrayBuffer.isView(column)) add(column);
  };
  const addGeometry = (geometry: TableGeometry): void => {
    add(geometry.coords);
    for (const offsets of geometry.offsets ?? []) add(offsets);
  };

  const prepared = isPreparedTable(table) ? table : null;
  const input = prepared ? prepared.table : (table as Table);
  const geometry = input.geometry;
  if (geometry.type === 'Mixed') {
    add(geometry.types);
    add(geometry.offsets);
    for (const child of geometry.children) addGeometry(child);
  } else {
    addGeometry(geometry);
  }
  add(input.validity);
  addColumn(input.ids);
  for (const column of Object.values(input.columns ?? {})) addColumn(column);

  if (prepared) {
    add(prepared.bounds);
    add(prepared.chunkRows);
    add(prepared.chunkOffsets);
    add(prepared.chunkBounds);
    add(prepared.indexBoxes);
    add(prepared.indexEntries);
    add(prepared.indexLevels);
  }
  return [...buffers];
}
