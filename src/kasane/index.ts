// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hold the features of a document as rows of columns, and read and write them as rows.
 *
 * Experimental: this entry may change in a minor release. Use it to write a Store that holds its
 * features as rows, or to read and write the rows of such a Store: when a layer holds more
 * features than can be made objects at once. A Worker builds the rows into blocks of typed arrays
 * (`createRowBlockBuilder`), the Store adds them to its tables without a copy
 * (`writer.addBlocks`), and the instance draws and hit tests the layer from its rows, making a
 * feature of a row only while it is selected or edited. An application that only draws, edits and
 * reads features needs none of it: the main entry reads the features of every layer.
 *
 * ```ts
 * // worker.ts
 * import { createRowBlockBuilder, transferList } from '@sakuzu/maplibre-gl-draw/kasane';
 *
 * const builder = createRowBlockBuilder();
 * rows.forEach((row) => builder.addRow(row)); // id, type, geometry, key of the order
 * const blocks = builder.finish();
 * self.postMessage(blocks, { transfer: transferList(blocks) });
 *
 * // main.ts
 * import { createTableStore } from '@sakuzu/maplibre-gl-draw/kasane';
 *
 * const { store, writer } = createTableStore();
 * const draw = createDraw(map, { store });
 * draw.layers.create({ id: 'buildings', name: 'Buildings' });
 * worker.onmessage = (e) => writer.addBlocks('buildings', e.data);
 * ```
 *
 * The functions used most are {@link createTableStore}, {@link createRowBlockBuilder} and
 * {@link FeatureTables}.
 *
 * @module kasane
 * @experimental
 */

// biome-ignore-all assist/source/organizeImports: the exports are grouped by task

// Stores that hold features as rows
export type {
  CreatedRows,
  FeatureTables,
  FeatureTablesOptions,
  FeatureTablesWorker,
  FeatureTablesWriter,
  LayerRowsChange,
  LayerTableView,
  OpenedApplyOptions,
  RowApplyOptions,
  RowCursor,
  RowField,
  RowFieldValues,
  RowHandle,
  RowPlacement,
  RowsChange,
  RowValues,
  RowWrite,
  TableGroupField,
  TableGroupPatch,
  TableScanOptions,
  TableStoreCopy,
} from '../api/tables.js';
export {
  copyTableStore,
  createFeatureTables,
  createRowValues,
  createTableStore,
  rowValuesOf,
} from '../api/tables.js';

// The order of the rows
export type { ItemHandles, RowsMove } from '../api/model.js';
export { ITEM_GROUP, ITEM_ROW } from '../api/tables.js';

// Features selected in bulk and dragged
export { listSelectedRows } from '../store/bulk-selection.js';
export type { DraggedRows } from '../feature-table/dragged-rows.js';
export { draggedRowsOf } from '../feature-table/dragged-rows.js';

// Pictures of points drawn with the rows
export type {
  RowSprite,
  RowSpriteDistanceScale,
  RowSpriteSource,
} from '../view/renderers/rows/rows-format.js';

// Build blocks of rows in a Worker
export type {
  GroupEntry,
  RowBlockBuilder,
  RowBlockBuilderOptions,
  RowInput,
} from '../table/row-group-builder.js';
export {
  createRowBlockBuilder,
  ROW_BLOCK_TARGET_ROWS,
  ROW_BLOCK_TARGET_VERTICES,
} from '../table/row-group-builder.js';
export type { RowBlockMerge } from '../table/row-group-merge.js';
export { mergeRowBlock } from '../table/row-group-merge.js';
export type { RowBlock } from '../table/row-group-types.js';
export { transferList } from '../table/transfer-list.js';
export type { CoordinateSystem } from '../table/coordinates.js';
export type { RowRings } from '../table/row-rings.js';
export type { Utf8Column } from '../table/utf8-column.js';
