// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.document`: the whole document, to load and to write out
 */

import type { FeatureCollection } from 'geojson';
import type { DrawDocument, LoadOptions, LoadResult, LoadSource } from './model.js';

/**
 * The whole document: features, layers, groups and metadata.
 */
export interface DocumentResource {
  /**
   * Reads a file, a JSON string, a document of the library or GeoJSON.
   *
   * `options.mode` decides whether the document is replaced or the features are added; it is
   * `replace` for a document of the library and `merge` for GeoJSON when it is left out.
   *
   * @returns What was read, or `null` when the document is read-only
   * @throws `DrawError` (the promise rejects; every failure is a `DrawError`) with the code
   *   `unsupported-format` when the source cannot be read (text that is not JSON, data that is
   *   neither a document of the library nor GeoJSON, an image file that cannot be decoded), or
   *   `invalid-input` when the document is not valid (a document of the library that breaks
   *   its format, an embedded image that is broken, an image without `coordinate`)
   */
  load(source: LoadSource, options?: LoadOptions): Promise<LoadResult | null>;
  /** The whole document in the format of the library. */
  toJSON(): DrawDocument;
  /**
   * The whole document as GeoJSON. The values of the library are kept in `properties` under
   * the prefixed keys.
   */
  toGeoJSON(): FeatureCollection;
}
