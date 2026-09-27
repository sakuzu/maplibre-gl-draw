// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Types internal to the Import/Export module
 */

import type { Feature, FileData } from '../../../store/types.js';

/**
 * GeoJSON import result (internal use).
 *
 * For a feature that contains image data, fileData is returned alongside it.
 */
export interface ConvertedFeatureResult {
  feature: Feature;
  fileData?: FileData;
}

/**
 * Options for GeoJSON import
 */
export interface GeoJSONImportOptions {
  /**
   * Whether to expand Multi* geometries into features with a single geometry
   *
   * The default is false, which keeps MultiPoint / MultiLineString / MultiPolygon
   * as Multi features as they are (so properties are not duplicated).
   * Setting it to true expands them as before, assigning a new ID to each part.
   */
  flattenMulti?: boolean;
}
