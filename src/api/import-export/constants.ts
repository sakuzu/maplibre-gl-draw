// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Constants related to Import/Export
 */

/**
 * Version of the native format
 *
 * Semantic versioning. A minor version only adds fields; a major version can change the
 * meaning of any field. Data of an earlier major version is upgraded on load when there is a
 * step for it (native-upgrade.ts), and data of any other major version is rejected. 2.0.0 made
 * the stacking order (`layerOrder`) a required part of the data. 3.0.0 holds the geometry of
 * a feature as GeoJSON, the values of the library in `properties` under the
 * `maplibre-gl-draw:` prefix, the items of a layer in `items` and the layer of a group in
 * `layerId`.
 */
export const NATIVE_VERSION = '3.0.0';

/**
 * The number of decimal places the GeoJSON export keeps in a coordinate
 *
 * 1e-7 degrees is about 1.1 cm at the equator, finer than any edit on the map, and it keeps
 * the file from carrying the noise digits of floating-point arithmetic (RFC 7946, 11.2).
 */
export const GEOJSON_COORDINATE_DECIMALS = 7;
