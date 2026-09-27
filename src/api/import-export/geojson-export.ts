// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Conversion from the internal Feature to the GeoJSON format + export of a
 * GeoJSON FeatureCollection
 *
 * The output follows RFC 7946: every position is rounded to GEOJSON_COORDINATE_DECIMALS
 * decimal places, the rings of a polygon follow the right-hand rule (the outer ring
 * counter-clockwise, the holes clockwise) whatever orientation they were drawn in, every
 * longitude is brought into [-180, 180], and the FeatureCollection carries a bbox. The stored
 * features are not changed.
 *
 * A feature drawn across the antimeridian is stored continuous, with longitudes a little
 * beyond ±180 (170 to 190, say). The export brings each position back by a whole turn and
 * does not cut the geometry at the line (RFC 7946 section 3.1.9 recommends cutting): an edge
 * across the line joins its two ends as they come back (170 to -170), which a reader that
 * does not handle the antimeridian draws the other way round the world. The orientation of a
 * ring is judged before the longitudes are brought back, on the continuous ring.
 */

import {
  normalizeMultiPolygonOrientation,
  normalizePolygonOrientation,
} from '../../geometry/simplify.js';
import type { Store } from '../../store/store.js';
import type { ExportOptions, Feature } from '../../store/types.js';
import { GEOJSON_COORDINATE_DECIMALS, GEOJSON_PREFIX, LIBRARY_PROPERTIES } from './constants.js';
import { setOwnProperty } from './own-property.js';

type Position = [number, number];

const COORDINATE_SCALE = 10 ** GEOJSON_COORDINATE_DECIMALS;

/** Rounds one coordinate value to the exported number of decimal places */
function roundValue(value: number): number {
  // `+ 0` turns a -0 produced by the rounding into 0
  return Math.round(value * COORDINATE_SCALE) / COORDINATE_SCALE + 0;
}

/**
 * Brings a longitude into [-180, 180] by whole turns
 *
 * A longitude already in the range, 180 and -180 included, is returned as it is.
 */
function wrapLongitude(lng: number): number {
  if (lng >= -180 && lng <= 180) {
    return lng;
  }
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  // Rounding the turn away can leave a value like 1e-13 off the grid; round it again
  return roundValue(wrapped);
}

function roundPosition(position: Position): Position {
  return [roundValue(position[0]), roundValue(position[1])];
}

function wrapPosition(position: Position): Position {
  return [wrapLongitude(position[0]), position[1]];
}

/** Rounds a position and brings its longitude into [-180, 180] */
function exportPosition(position: Position): Position {
  return wrapPosition(roundPosition(position));
}

function exportLine(line: Position[]): Position[] {
  return line.map(exportPosition);
}

function roundLine(line: Position[]): Position[] {
  return line.map(roundPosition);
}

function wrapRings(rings: Position[][]): Position[][] {
  return rings.map((ring) => ring.map(wrapPosition));
}

/**
 * Rounds the rings of a polygon, orients them by the right-hand rule and brings the
 * longitudes into [-180, 180] (in this order, so that the orientation is judged on the
 * continuous ring)
 */
function exportPolygon(rings: Position[][]): Position[][] {
  return wrapRings(normalizePolygonOrientation(rings.map(roundLine)));
}

/** Whether it is a single coordinate ([lng, lat]) */
function isCoordinatePair(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  );
}

/** Whether it is a sequence of points ([[lng, lat], …], two or more points) */
function isCoordinatePairArray(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 2 && value.every(isCoordinatePair);
}

/**
 * Converts an internal Feature into a GeoJSON Feature
 *
 * Conforms to docs/reference/data-format.md:
 *   - includes the metadata in properties with the maplibre-gl-draw: prefix, and writes
 *     name and description as plain keys
 *   - rounds the positions and orients the rings (see the top of this file)
 *   - a Point is written out as a Point geometry
 *   - the Multi types (MultiPoint / MultiLineString / MultiPolygon) are written out as they are
 *   - an Image is written out as a Point geometry and identified by featureType
 *   - for an Image feature, the image data is embedded as Base64
 */
export function convertFeatureToGeoJSON(
  feature: Feature,
  store: Store,
): GeoJSON.Feature<GeoJSON.Geometry> | null {
  const properties: Record<string, unknown> = {};

  // Add the properties (this library's own ones get the prefix). They are defined as
  // own properties so that a `__proto__` key is written out instead of replacing the
  // prototype of the output object.
  for (const [key, value] of Object.entries(feature.properties)) {
    if (LIBRARY_PROPERTIES.has(key)) {
      setOwnProperty(properties, `${GEOJSON_PREFIX}${key}`, value);
    } else {
      setOwnProperty(properties, key, value);
    }
  }

  // Add the metadata
  properties[`${GEOJSON_PREFIX}id`] = feature.id;
  properties[`${GEOJSON_PREFIX}layerId`] = feature.layerId;
  if (feature.groupId !== undefined) {
    properties[`${GEOJSON_PREFIX}groupId`] = feature.groupId;
  }
  if (!feature.visible) {
    properties[`${GEOJSON_PREFIX}visible`] = false;
  }
  if (feature.locked) {
    properties[`${GEOJSON_PREFIX}locked`] = true;
  }
  if (feature.style) {
    properties[`${GEOJSON_PREFIX}style`] = feature.style;
  }

  let geometry: GeoJSON.Geometry;

  switch (feature.type) {
    case 'Point':
      geometry = { type: 'Point', coordinates: exportPosition(feature.coordinates as Position) };
      break;

    case 'LineString':
      geometry = { type: 'LineString', coordinates: exportLine(feature.coordinates as Position[]) };
      break;

    case 'Polygon':
      geometry = {
        type: 'Polygon',
        coordinates: exportPolygon(feature.coordinates as Position[][]),
      };
      break;

    // The Multi types are written out to GeoJSON with their part structure preserved
    case 'MultiPoint':
      geometry = { type: 'MultiPoint', coordinates: exportLine(feature.coordinates as Position[]) };
      break;

    case 'MultiLineString':
      geometry = {
        type: 'MultiLineString',
        coordinates: (feature.coordinates as Position[][]).map(exportLine),
      };
      break;

    case 'MultiPolygon':
      geometry = {
        type: 'MultiPolygon',
        coordinates: normalizeMultiPolygonOrientation(
          (feature.coordinates as Position[][][]).map((rings) => rings.map(roundLine)),
        ).map(wrapRings),
      };
      break;

    case 'Image': {
      // An Image is written out as a Point geometry and identified by featureType
      geometry = { type: 'Point', coordinates: exportPosition(feature.coordinates as Position) };
      properties[`${GEOJSON_PREFIX}featureType`] = feature.type;

      // Embed the image data as Base64
      const imageFileId = feature.properties.imageFileId as string | undefined;
      if (imageFileId) {
        const fileData = store.getFile(imageFileId);
        if (fileData) {
          properties[`${GEOJSON_PREFIX}imageData`] = fileData.dataURL;
          properties[`${GEOJSON_PREFIX}imageMimeType`] = fileData.mimeType;
        }
      }
      break;
    }

    default:
      // Custom types (Circle, and the types registered from outside) are dispatched by the shape of their
      // geometry, and the type itself makes the round trip through the featureType marker,
      // which carries the type name as it is (a name such as MyShape keeps its inner capital).
      // A type with a single point is written out as a Point, and a type with a sequence of
      // points as a LineString. In both cases the import side restores
      // the original type from the same marker.
      if (isCoordinatePair(feature.coordinates)) {
        geometry = { type: 'Point', coordinates: exportPosition(feature.coordinates as Position) };
        properties[`${GEOJSON_PREFIX}featureType`] = feature.type;
      } else if (isCoordinatePairArray(feature.coordinates)) {
        geometry = {
          type: 'LineString',
          coordinates: exportLine(feature.coordinates as Position[]),
        };
        properties[`${GEOJSON_PREFIX}featureType`] = feature.type;
      } else {
        console.warn(`Unsupported feature type for GeoJSON export: ${feature.type}`);
        return null;
      }
  }

  return {
    type: 'Feature',
    id: feature.id,
    geometry,
    properties,
  };
}

/**
 * Exports the current data as a GeoJSON FeatureCollection
 */
export function exportGeoJSON(
  store: Store,
  options?: ExportOptions,
): GeoJSON.FeatureCollection<GeoJSON.Geometry> {
  // In addition to the draw order (visible), hidden features are also included at the end
  // of the export. getOrderedFeatures returns only the visible features, so on its own it
  // would lose visible:false across the GeoJSON round trip. Including the hidden ones
  // preserves it across the round trip.
  const visibleOrdered = store.getOrderedFeatures();
  const visibleIds = new Set(visibleOrdered.map((f) => f.id));
  const hiddenFeatures = store.getAllFeatures().filter((f) => !visibleIds.has(f.id));
  let features = [...visibleOrdered, ...hiddenFeatures];

  if (options?.featureIds && options.featureIds.length > 0) {
    const featureIdSet = new Set(options.featureIds);
    features = features.filter((f) => featureIdSet.has(f.id));
  }
  if (options?.layerIds && options.layerIds.length > 0) {
    const layerIdSet = new Set(options.layerIds);
    features = features.filter((f) => layerIdSet.has(f.layerId));
  }

  const geoJSONFeatures: GeoJSON.Feature<GeoJSON.Geometry>[] = [];
  for (const feature of features) {
    const geoFeature = convertFeatureToGeoJSON(feature, store);
    if (geoFeature) {
      geoJSONFeatures.push(geoFeature);
    }
  }

  const bbox = featureCollectionBBox(geoJSONFeatures);
  return {
    type: 'FeatureCollection',
    ...(bbox ? { bbox } : {}),
    features: geoJSONFeatures,
  };
}

/**
 * The bounding box of every exported position ([west, south, east, north])
 *
 * null when nothing was exported.
 */
function featureCollectionBBox(features: GeoJSON.Feature<GeoJSON.Geometry>[]): GeoJSON.BBox | null {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number') {
      const [lng, lat] = value as Position;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      return;
    }
    for (const item of value) visit(item);
  };
  for (const feature of features) {
    if (feature.geometry.type !== 'GeometryCollection') visit(feature.geometry.coordinates);
  }
  return west <= east ? [west, south, east, north] : null;
}
