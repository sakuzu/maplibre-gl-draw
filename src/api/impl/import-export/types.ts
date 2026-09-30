// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Types internal to the Import/Export module
 */

import type { Feature, FileData, LoadResult } from '../../../store/types.js';

/**
 * A load whose source is read, checked and decoded: what is left is to write it, inside the
 * transaction of the caller. Nothing that can fail is left to `write`, because a transaction
 * does not roll back.
 */
export interface PreparedLoad {
  /** Writes what was read and returns what was loaded */
  write(): LoadResult;
}

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
  /**
   * The layer every feature goes into, over the layer a feature names itself with
   * `maplibre-gl-draw:layerId`. A group of another layer is then dropped from the feature
   */
  layerId?: string;
  /**
   * Whether the features and the groups of the document are replaced: they are deleted in the
   * same transaction that writes the features of the file, and the layers stay
   */
  replace?: boolean;
  /**
   * Whether every feature goes into one layer (the one of `layerId`, else the current one) and
   * leaves the group it names, because the load puts them all into a new group
   */
  oneGroup?: boolean;
  /** IDs the features must not take, such as those of a layer and a group the load creates */
  reservedIds?: ReadonlySet<string>;
}
