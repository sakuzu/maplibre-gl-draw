// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The subpath `@sakuzu/maplibre-gl-draw/table`
 *
 * The parts for reading a large table in a Worker and putting it on the map. Use it when the
 * data has hundreds of thousands of rows or more and comes from a file: read and prepare it in a
 * Worker, and the main thread only receives it and passes it to the dataset. For a few thousand
 * rows, passing an array of features as `rows` is simpler.
 *
 * It depends on neither maplibre nor WebGL nor the DOM, so a Worker can import it without
 * pulling in the engine.
 *
 * @example
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
 * @module table
 */

// biome-ignore-all assist/source/organizeImports: the exports are grouped by task

// Build a table
export type { TableBuilder } from './builder.js';
export { createTableBuilder, tableFromFeatures } from './builder.js';
export type { Table } from './types.js';

// Prepare in a Worker
export { prepareTable, transferList } from './prepare.js';
export type { PreparedTable } from './types.js';

// Column types
export type {
  Column,
  DictionaryColumn,
  GeometryType,
  TableGeometry,
  TableMixedGeometry,
} from './types.js';
