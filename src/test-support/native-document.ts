// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A document of the library for the tests, written with its features in the fields of the Store
 * (layerId, groupId, type, style, visible, locked) and given in the format the library reads
 * (4.0.0): each feature a GeoJSON Feature, the fields under the keys of the library in
 * `properties`
 */

type Json = Record<string, unknown>;

/** A feature written in the fields of the Store, as a GeoJSON Feature */
function featureOf(feature: Json): Json {
  const { id, type, geometry, layerId, groupId, properties, style, visible, locked } = feature;
  const moved: Json =
    typeof properties === 'object' && properties !== null ? { ...properties } : {};
  const key = (name: string) => `maplibre-gl-draw:${name}`;
  if (layerId !== undefined) moved[key('layerId')] = layerId;
  if (groupId !== undefined && groupId !== null) moved[key('groupId')] = groupId;
  const geometryType = (geometry as { type?: unknown } | undefined)?.type;
  if (typeof type === 'string' && type !== geometryType) moved[key('featureType')] = type;
  if (typeof style === 'object' && style !== null && Object.keys(style).length > 0) {
    moved[key('style')] = style;
  }
  if (visible === false) moved[key('visible')] = false;
  if (locked === true) moved[key('locked')] = true;
  return { type: 'Feature', id, geometry, properties: moved };
}

/** The document in the format of the library */
export function nativeDocument<T extends Json>(data: T): T {
  const { features, ...rest } = data as Json;
  const out: Json = { ...rest, version: '4.0.0' };
  out.features = Array.isArray(features) ? features.map((f) => featureOf(f as Json)) : features;
  return out as T;
}
