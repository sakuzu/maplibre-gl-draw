// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Detection of the data format on import
 */

import type { Data } from '../../store/types.js';

/**
 * Determines whether the data is in the native format
 */
export function isNativeFormat(data: unknown): data is Data {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.version === 'string' &&
    Array.isArray(obj.features) &&
    obj.features.every(
      (f: unknown) =>
        typeof f === 'object' &&
        f !== null &&
        'id' in f &&
        'type' in f &&
        'geometry' in f &&
        'layerId' in f,
    )
  );
}

/**
 * Determines whether the data is a GeoJSON FeatureCollection
 */
export function isGeoJSONFeatureCollection(
  data: unknown,
): data is GeoJSON.FeatureCollection<GeoJSON.Geometry> {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  return obj.type === 'FeatureCollection' && Array.isArray(obj.features);
}
