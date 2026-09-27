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
   * @returns What was read
   * @throws `DrawError` (the promise rejects) with the code `unsupported-format` when the
   *   source cannot be read, or `invalid-input` when a document of the library is not valid
   */
  // TODO(api-2): confirm what a read-only document does on load
  load(source: LoadSource, options?: LoadOptions): Promise<LoadResult>;
  /** The whole document in the format of the library. */
  toJSON(): DrawDocument;
  /**
   * The whole document as GeoJSON. The values of the library are kept in `properties` under
   * the prefixed keys.
   */
  toGeoJSON(): FeatureCollection;
}
