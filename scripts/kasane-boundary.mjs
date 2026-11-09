// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The files of src/ that are to be Kasane (`@sakuzu/kasane`): the rows held as tables of columns,
 * apart from what the library makes of them (features, layers, the drawing). While they are in
 * src/, `node scripts/check-layers.mjs --kasane` (`npm run check:kasane`) checks them:
 *
 * - Rule 12: a file of the list imports only the files of the list, and of the packages only
 *   those of `PACKAGES`
 * - Rule 13: a file of the list imports nothing of view/, modes/, store/, dispatcher/,
 *   operations/, snapping/, api/ or dataset/, not even a type
 * - No file of the list holds a word of `WORDS`, in its code or its comments: the tables know
 *   nothing of what the library draws, nor of the meaning of coordinates
 *
 * A file that is cut in two (the part of Kasane, the part of the library) joins the list when the
 * part of Kasane is a file of its own.
 */

/** The files, relative to src/ */
export const KASANE_FILES = [
  'feature-table/delta.ts',
  'feature-table/group-runs.ts',
  'feature-table/group-table.ts',
  'feature-table/id-index.ts',
  'feature-table/item-walk.ts',
  'feature-table/layer-table.ts',
  'feature-table/row-box-index.ts',
  'feature-table/row-skips.ts',
  'feature-table/row-state.ts',
  'feature-table/style-table.ts',
  'feature-table/tables-writer.ts',
  'feature-table/types.ts',
  'feature-table/value-overrides.ts',
  'feature-table/versions.ts',
  'feature-table/write-marks.ts',
  'geometry/bbox-type.ts',
  'table/kasane-error.ts',
  'table/packed-rtree.ts',
  'table/row-group-builder.ts',
  'table/row-group-merge.ts',
  'table/row-group-types.ts',
  'table/row-keys.ts',
  'table/row-rings.ts',
  'table/transfer-list.ts',
];

/** The areas of src/ a file of the list does not import, not even a type (rule 13) */
export const FORBIDDEN_AREAS = [
  'view',
  'modes',
  'store',
  'dispatcher',
  'operations',
  'snapping',
  'api',
  'dataset',
];

/** The packages a file of the list may import (rule 12) */
export const PACKAGES = ['@sakuzu/tabane', 'rbush'];

/**
 * The words no file of the list holds, as tokens (a text is cut at every character that is not
 * an ASCII letter or digit, between a lower-case and an upper-case letter, before the last
 * upper-case letter of a run followed by a lower-case one, and between a letter and a digit)
 */
export const WORDS = [
  // What the library draws
  'feature',
  'features',
  'layer',
  'layers',
  'geojson',
  'circle',
  'circles',
  'image',
  'images',
  // The meaning of coordinates, the earth and a device
  'longitude',
  'latitude',
  'lng',
  'lat',
  'lnglat',
  'wgs',
  'enu',
  'north',
  'east',
  'bearing',
  'mercator',
  'zoom',
  'geo',
  'geodesic',
  'ellipsoid',
  'browser',
  'tab',
  'tabs',
];
