// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The preparation of a columnar table, callable in a Worker
 *
 * It computes what a dataset needs before it can draw and hit test a table: the
 * bbox of every row, the spatial chunks and the spatial index. Done in a Worker together with the
 * reading of a file, the main thread receives the table and this result without a copy and
 * computes none of it again.
 *
 * A pure module: it depends on neither maplibre nor WebGL nor the DOM.
 */

import { buildPackedRTree } from '../packed-rtree.js';
import { partitionRows } from '../partition.js';
import { ColumnarTable, isDictionaryColumn } from './table.js';
import type { DatasetColumn, DatasetColumnarInput, DatasetColumnarPrepared } from './types.js';

/**
 * Computes the bboxes, the spatial chunks and the spatial index of a columnar table.
 *
 * It is the work that `Dataset.setColumnar` would otherwise do on the main thread. Call it where the table is read (in a Worker), send the result along with the table,
 * and pass both to `setColumnar` (or to `addDataset` as `columnar` and `prepared`). It
 * uses neither maplibre nor WebGL, so it runs in any Worker.
 *
 * @param input The table
 * @returns The prepared arrays, which belong to this table only
 * @throws when the shape of the table does not add up (the same checks as `setColumnar`)
 *
 * @example In a Worker
 * ```ts
 * import { columnarTransferables, prepareDatasetColumnar } from '@sakuzu/maplibre-gl-draw/columnar';
 *
 * self.onmessage = async (event) => {
 *   const input = await readTable(event.data); // your reader: a DatasetColumnarInput
 *   const prepared = prepareDatasetColumnar(input);
 *   self.postMessage({ input, prepared }, columnarTransferables(input, prepared));
 * };
 * ```
 */
export function prepareDatasetColumnar(input: DatasetColumnarInput): DatasetColumnarPrepared {
  const table = new ColumnarTable(input);
  const bounds = table.computeBounds();
  const chunks = partitionRows(bounds, table.computeVertexCounts());
  const index = buildPackedRTree(bounds);
  return {
    length: table.length,
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
 * Lists the buffers of a columnar table (and of its prepared arrays) for the transfer list of
 * `postMessage`, so that they move to the other thread without a copy.
 *
 * Each buffer appears once, even when several arrays share it. A `SharedArrayBuffer` is left out
 * (it is shared, not moved). After the transfer the arrays are empty on the sending side.
 *
 * @param input The table
 * @param prepared The result of {@link prepareDatasetColumnar} for the table (optional)
 * @returns The buffers to pass as the transfer list
 *
 * @example
 * ```ts
 * worker.postMessage({ input, prepared }, columnarTransferables(input, prepared));
 * ```
 */
export function columnarTransferables(
  input: DatasetColumnarInput,
  prepared?: DatasetColumnarPrepared,
): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (view: ArrayBufferView | undefined): void => {
    if (view && view.buffer instanceof ArrayBuffer) buffers.add(view.buffer);
  };
  const addColumn = (column: DatasetColumn | undefined): void => {
    if (!column) return;
    if (isDictionaryColumn(column)) add(column.codes);
    else if (ArrayBuffer.isView(column)) add(column);
  };

  add(input.geometry.coords);
  for (const offsets of input.geometry.offsets ?? []) add(offsets);
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
