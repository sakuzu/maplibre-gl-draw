// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hold the features of a document as rows of columns, and read and write them as rows.
 *
 * Experimental: this entry may change in a minor release. Use it to write a Store that holds its
 * features as rows, or to read and write the rows of such a Store: when a layer holds more
 * features than can be made objects at once. A Worker builds the rows into row blocks of typed arrays
 * (`createRowBlockBuilder`), the Store adds them to its tables without a copy
 * (`writer.addRowBlocks`), and the instance draws and hit tests the layer from its rows, making a
 * feature of a row only while it is selected or edited. An application that only draws, edits and
 * reads features needs none of it: the main entry reads the features of every layer.
 *
 * ```ts
 * // worker.ts
 * import { createRowBlockBuilder, transferList } from '@sakuzu/maplibre-gl-draw/kasane';
 *
 * const builder = createRowBlockBuilder();
 * rows.forEach((row) => builder.addRow(row)); // id, type, geometry, key of the order
 * const rowBlocks = builder.finish();
 * self.postMessage(rowBlocks, { transfer: transferList(rowBlocks) });
 *
 * // main.ts
 * import { createTableStore } from '@sakuzu/maplibre-gl-draw/kasane';
 *
 * const { store, writer } = createTableStore();
 * const draw = createDraw(map, { store });
 * draw.layers.create({ id: 'buildings', name: 'Buildings' });
 * worker.onmessage = (e) => writer.addRowBlocks('buildings', e.data);
 * ```
 *
 * The functions used most are {@link createTableStore}, {@link createRowBlockBuilder} and
 * {@link FeatureTables}.
 *
 * Rows can also be kept and handed out as Tabane blocks (`@sakuzu/tabane`): files named by the
 * SHA-256 of their content, each a run of rows of one parent cut into row blocks, listed by a
 * manifest. Use them to save the rows of a document, or to send them elsewhere, without
 * making features of them. A feature is a row of the columns {@link TABANE_FEATURE_COLUMNS}
 * ({@link tabaneRowOf}); {@link writeTabaneFeatureBlocks} writes features as blocks, with the
 * triangles of their polygons as caches of the files, and a block read is row blocks the tables
 * take as they are ({@link rowBlockOfTabane}), the triangles copied from the caches.
 *
 * ```ts
 * import { packTabaneBlock, readTabaneBlockFile, tabaneNameOf } from '@sakuzu/tabane';
 *
 * const [{ block, caches }] = writeTabaneFeatureBlocks({ parent: 'buildings', head: 'V', rows });
 * const name = await tabaneNameOf(block.content); // the name to keep the file under
 * const file = packTabaneBlock(block, compressor, caches); // its parts compressed with zstd
 *
 * // where it is read
 * const read = readTabaneBlockFile(file, compressor);
 * const rowBlocks = read.rowBlocks.map((b, k) =>
 *   rowBlockOfTabane(b, { caches: read.caches.filter((c) => c.part === k + 1) }),
 * );
 * ```
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

// Features of GeoJSON read as rows
export type { GeoJSONRow, GeoJSONRows } from '../api/geojson-rows.js';
export { rowsOfGeoJSON } from '../api/geojson-rows.js';

// The order of the rows
export type { ItemHandles, RowsMove } from '../api/model.js';
export { ITEM_GROUP, ITEM_ROW } from '../api/tables.js';

// Features selected in bulk and dragged
export { listSelectedRows } from '../store/bulk-selection.js';
export type { DraggedRows } from '../feature-table/dragged-rows.js';

// What the extensions answer and draw from the rows
export type { FeatureTypeRows } from '../api/extension/feature-type.js';
export type { CompanionProviderRows } from '../api/extension/provider.js';
export type { FeatureRendererRows } from '../api/extension/render.js';

// Pictures of points drawn with the rows
export type {
  RowSprite,
  RowSpriteScaleStop,
  RowSpriteSource,
} from '../view/renderers/rows/rows-format.js';

// Build row blocks in a Worker
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
export type { RowRings } from '../table/row-rings.js';

// Features as the rows of Tabane blocks (@sakuzu/tabane), and the blocks read as row blocks
export type { TabaneFeatureRow } from '../table/tabane/columns.js';
export {
  featureRowOfTabane,
  TABANE_FEATURE_COLUMNS,
  tabaneRowOf,
} from '../table/tabane/columns.js';
export type { TabaneFeatureBlock, TabaneFeatureBlocksInput } from '../table/tabane/blocks.js';
export { writeTabaneFeatureBlocks } from '../table/tabane/blocks.js';
export type { RowBlockOfTabaneOptions } from '../table/tabane/rows.js';
export { rowBlockOfTabane } from '../table/tabane/rows.js';
