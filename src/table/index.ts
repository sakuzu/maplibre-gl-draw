// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Read a large table in a Worker and put it on the map.
 *
 * Use it when the data has hundreds of thousands of rows or more and comes from a file: read
 * and prepare it in a Worker, and the main thread only receives it and passes it to
 * `draw.datasets.add`. For a few thousand rows, passing an array of features as `rows` is
 * simpler. It depends on neither maplibre nor WebGL nor the DOM, so a Worker can import it
 * without pulling in the engine.
 *
 * ```ts
 * // worker.ts
 * import {
 *   tableFromFeatures, prepareTable, transferList,
 * } from '@sakuzu/maplibre-gl-draw/table';
 *
 * const features = await readGeoJSON(url);          // read it any way you like
 * const prepared = prepareTable(tableFromFeatures(features));
 * self.postMessage(prepared, { transfer: transferList(prepared) });
 *
 * // main.ts
 * worker.onmessage = (e) =>
 *   draw.datasets.add({ id: 'places', table: e.data });
 * ```
 *
 * A Store that holds its features as rows (`createTableStore` of `/kasane`) takes pages: about a
 * thousand rows of a layer each, in arrays of columns. A Worker builds them from features
 * (`createPageBuilder`) or reads them from the blocks of Tabane (`toPage`), and the main thread
 * adds them without a copy (`writer.addPages`).
 *
 * ```ts
 * // worker.ts
 * import { createPageBuilder, transferList } from '@sakuzu/maplibre-gl-draw/table';
 *
 * const builder = createPageBuilder();
 * rows.forEach((row) => builder.addRow(row)); // id, type, geometry, key of the order
 * const pages = builder.finish();
 * self.postMessage(pages, { transfer: transferList(pages) });
 * ```
 *
 * Read next: the guide
 * [showing large data](https://sakuzu.github.io/maplibre-gl-draw/guides/large-data). The
 * functions used most are {@link tableFromFeatures}, {@link createTableBuilder},
 * {@link prepareTable}, {@link transferList} and {@link createPageBuilder}.
 *
 * @module table
 */

// biome-ignore-all assist/source/organizeImports: the exports are grouped by task

// Build a table
export type { TableBuilder } from './builder.js';
export { createTableBuilder, tableFromFeatures } from './builder.js';
export type { Table } from './types.js';

// Prepare in a Worker
export { prepareTable } from './prepare.js';
export type { PreparedTable } from './types.js';

// Pages of rows built or read in a Worker, for a Store that holds its features as rows
export type { Page } from '@sakuzu/kasane';
export type { FeaturePageBuilder as PageBuilder } from './feature-row-blocks.js';
export { createPageBuilder, transferList } from './pages.js';
export type { ToPageOptions } from './tabane/rows.js';
export { toPage } from './tabane/rows.js';

// Column types
export type {
  Column,
  DictionaryColumn,
  GeometryType,
  TableGeometry,
  TableMixedGeometry,
} from './types.js';
