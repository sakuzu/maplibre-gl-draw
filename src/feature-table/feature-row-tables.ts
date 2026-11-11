// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tables of the features of a document, with what the library declares of its features
 * (`createFeatureRowTables`, `createFeatureTablesStore`)
 *
 * The tables (`createTables`) hold rows and know nothing of features. The library gives them what
 * they ask the user of the tables for: the rings of the Circles (`circleRowRings`), the triangles
 * of the fills as a cache of the rows (`FEATURE_CACHES`), the boxes of the rows of an Image and of
 * the types of the extensions (`FeatureRowBoxes`), the fields whose new value places a row again,
 * the ones the drawing cuts the rows by (the type, and the zoom a feature was created at), and
 * when the tables run their work (while the page is idle).
 */

import type { FeatureTables, FeatureTablesWriter, RowField } from '../api/tables.js';
import { drawPropertyKey } from '../shared/properties.js';
import { whenIdle } from '../shared/utils/idle.js';
import { circleRowRings } from '../table/circle-rings.js';
import { FEATURE_CACHES } from '../table/fill-triangles.js';
import { FEATURE_TABLE_COLUMNS } from '../table/tabane/columns.js';
import { FeatureRowBoxes, keepFeatureRowBoxes } from './feature-row-boxes.js';
import {
  createTables,
  type FeatureTablesInternalOptions,
  type FeatureTablesInternals,
  featureTablesInternals,
  type TablesInternalOptions,
} from './feature-tables.js';
import { createFeatureTablesWriter } from './feature-tables-writer.js';
import type { TablesWriter } from './tables-writer.js';

/**
 * The fields of a feature whose new value places its row again: the drawing cuts the rows by
 * their type and by the zoom they were created at
 *
 * @internal
 */
export const FEATURE_RELOCATING_FIELDS: readonly RowField[] = [
  'type',
  `properties:${drawPropertyKey('createdZoom')}`,
];

/**
 * Creates the tables of the features of a document with what the library declares of its
 * features (`createTables`): the rings of the Circles, the triangles of the fills, the boxes of
 * the rows of an Image and of the types of the extensions (`featureRowBoxesOf`), the fields that
 * place a row again, and the idle periods of the page for their work (unless the options give
 * others). What a read through
 * the reading side calls first (`beforeRead`) is the one of the options
 *
 * @internal
 */
export function createFeatureRowTables(
  options: Omit<
    TablesInternalOptions,
    'columns' | 'rowBoxes' | 'relocatingFields' | 'rings' | 'caches'
  > = {},
): {
  tables: FeatureTables;
  writer: TablesWriter;
} {
  const boxes = new FeatureRowBoxes();
  const made = createTables({
    ...options,
    columns: FEATURE_TABLE_COLUMNS,
    rings: circleRowRings,
    caches: FEATURE_CACHES,
    rowBoxes: boxes.boxesOf,
    relocatingFields: FEATURE_RELOCATING_FIELDS,
    whenIdle: options.whenIdle ?? whenIdle,
  });
  const internals = featureTablesInternals(made.tables) as FeatureTablesInternals;
  boxes.attach(() => internals.refreshBoxes());
  keepFeatureRowBoxes(made.tables, boxes);
  return made;
}

/**
 * Creates the tables of the features of a document, as its reading side and the writer of the
 * features over the writer of the tables (the implementation of `createFeatureTables`): the writer
 * only writes, and tells nothing
 *
 * @internal
 */
export function createFeatureTablesStore(options: FeatureTablesInternalOptions = {}): {
  tables: FeatureTables;
  writer: FeatureTablesWriter;
} {
  const { tables, writer } = createFeatureRowTables(options);
  return {
    tables,
    writer: createFeatureTablesWriter(
      writer,
      featureTablesInternals(tables) as FeatureTablesInternals,
    ),
  };
}
