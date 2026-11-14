// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hold the features of a document as rows of columns, and read and write them as rows.
 *
 * Experimental: this entry may change in a minor release, and goes once what it holds has its
 * place in the other entries. Use it to write a Store that holds its features as rows, or to read
 * and write the rows of such a Store: when a layer holds more features than can be made objects
 * at once. A Worker builds the rows into pages of typed arrays (`createPageBuilder` of `/table`),
 * the Store adds them to its tables without a copy (`writer.addPages`), and the instance draws
 * and hit tests the layer from its rows, making a feature of a row only when one is read. An
 * application that only draws, edits and reads features needs none of it: the main entry reads
 * the features of every layer.
 *
 * ```ts
 * // worker.ts
 * import { createPageBuilder, transferList } from '@sakuzu/maplibre-gl-draw/table';
 *
 * const builder = createPageBuilder();
 * rows.forEach((row) => builder.addRow(row)); // id, type, geometry, key of the order
 * const pages = builder.finish();
 * self.postMessage(pages, { transfer: transferList(pages) });
 *
 * // main.ts
 * import { createTableStore } from '@sakuzu/maplibre-gl-draw/kasane';
 *
 * const { store, writer } = createTableStore();
 * const draw = createDraw(map, { store });
 * draw.layers.create({ id: 'buildings', name: 'Buildings' });
 * worker.onmessage = (e) => writer.addPages('buildings', e.data);
 * ```
 *
 * The functions used most are {@link createTableStore} and {@link FeatureTables}.
 *
 * Rows can also be kept and handed out as Tabane blocks (`@sakuzu/tabane`): files named by the
 * SHA-256 of their content, each a run of rows of one parent cut into pages, listed by a
 * manifest. Use them to save the rows of a document, or to send them elsewhere, without
 * making features of them. A feature is a row of the columns {@link TABANE_FEATURE_COLUMNS}
 * ({@link tabaneRowOf}); {@link writeTabaneFeatureBlocks} writes features as blocks, with the
 * triangles of their polygons as caches of the files, and a block read is pages the tables
 * take as they are (`toPage` of `/table`), the triangles copied from the caches.
 *
 * ```ts
 * import { packBlock, readBlockFile, digestOf } from '@sakuzu/tabane';
 * import { toPage } from '@sakuzu/maplibre-gl-draw/table';
 *
 * const [{ block, caches }] = writeTabaneFeatureBlocks({ parent: 'buildings', head: 'V', rows });
 * const name = await digestOf(block.content); // the name to keep the file under
 * const file = packBlock(block, compressor, caches); // its parts compressed with zstd
 *
 * // where it is read
 * const read = readBlockFile(file, compressor);
 * const pages = read.pages.map((b, k) =>
 *   toPage(b, { caches: read.caches.filter((c) => c.part === k + 1) }),
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
  RowApplyOptions,
  RowCursor,
  RowField,
  RowFieldValues,
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
  featureValuesOf,
  rowValuesOf,
} from '../api/tables.js';

// Features of GeoJSON read as rows
export type { GeoJSONRow, GeoJSONRows } from '../api/geojson-rows.js';
export { rowsOfGeoJSON } from '../api/geojson-rows.js';

// The order of the rows
export type { ItemRefs, RowsMove } from '../api/model.js';
export { ITEM_GROUP, ITEM_ROW } from '../api/tables.js';

// Features selected in bulk
export { listSelectedRows } from '../store/bulk-selection.js';

// What the extensions answer from the rows
export type { FeatureTypeRows } from '../api/extension/feature-type.js';
export type { CompanionProviderRows } from '../api/extension/provider.js';

// Build and merge pages in a Worker
// (the builder itself is `createPageBuilder` of `/table`)
export type { GroupEntry, PageBuilderOptions, PageMerge } from '../table/tables-values.js';
export type { FeatureRowInput as RowInput } from '../table/feature-row-blocks.js';
export { PAGE_TARGET_ROWS, PAGE_TARGET_VERTICES } from '@sakuzu/kasane';
export { mergePages } from '../table/pages.js';
export type { PointRowRings as RowRings } from '@sakuzu/kasane';

// Features as the rows of Tabane blocks (@sakuzu/tabane)
// (a block is read as pages by `toPage` of `/table`)
export type { TabaneFeatureRow } from '../table/tabane/columns.js';
export {
  featureRowOfTabane,
  TABANE_FEATURE_COLUMNS,
  tabaneRowOf,
} from '../table/tabane/columns.js';
export type { TabaneFeatureBlock, TabaneFeatureBlocksInput } from '../table/tabane/blocks.js';
export { writeTabaneFeatureBlocks } from '../table/tabane/blocks.js';
