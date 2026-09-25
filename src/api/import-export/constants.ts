// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Constants related to Import/Export
 */

/**
 * Version of the native format
 *
 * Semantic versioning. A minor version only adds fields; a major version can change the
 * meaning of any field, and data of another major version is rejected. 2.0.0 made the
 * stacking order (`layerOrder`) a required part of the data.
 */
export const NATIVE_VERSION = '2.0.0';

/** Prefix of the GeoJSON properties that hold this library's own data */
export const GEOJSON_PREFIX = 'maplibre-gl-draw:';

/**
 * The properties this library itself keeps in `Feature.properties`
 *
 * They are stored without a prefix in the native format, and the
 * `maplibre-gl-draw:` prefix is added when exporting to GeoJSON. Every other property, those
 * of the host and of extensions included, is written as a plain key. `name` and `description`
 * are plain keys too: other GIS tools read them as the name and the description.
 */
export const LIBRARY_PROPERTIES: ReadonlySet<string> = new Set([
  // Common
  'createdZoom',
  'rotation',
  'scale',
  // Image
  'imageFileId',
  'imageWidth',
  'imageHeight',
]);

/**
 * The number of decimal places the GeoJSON export keeps in a coordinate
 *
 * 1e-7 degrees is about 1.1 cm at the equator, finer than any edit on the map, and it keeps
 * the file from carrying the noise digits of floating-point arithmetic (RFC 7946, 11.2).
 */
export const GEOJSON_COORDINATE_DECIMALS = 7;
