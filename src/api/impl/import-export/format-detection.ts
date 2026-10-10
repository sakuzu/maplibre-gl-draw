// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Detection of the data format on import
 */

import type { Data } from '../../../store/types.js';

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
        // `coordinates` in data of version 2, which is upgraded on load
        ('geometry' in f || 'coordinates' in f) &&
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

const GEOMETRY_TYPES: ReadonlySet<string> = new Set([
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
  'GeometryCollection',
]);

/** A FeatureCollection from GeoJSON data (a collection, a feature or a geometry), or null */
export function toFeatureCollection(data: unknown): GeoJSON.FeatureCollection | null {
  if (isGeoJSONFeatureCollection(data)) return data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  if (obj.type === 'Feature') {
    return { type: 'FeatureCollection', features: [data as GeoJSON.Feature] };
  }
  if (typeof obj.type === 'string' && GEOMETRY_TYPES.has(obj.type)) {
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: data as GeoJSON.Geometry }],
    };
  }
  return null;
}
