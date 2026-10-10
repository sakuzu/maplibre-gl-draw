// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Conversion from the internal Feature to the GeoJSON format + export of a
 * GeoJSON FeatureCollection
 *
 * The conversion is pure: it reads only the features it is given and, for the image of an
 * Image, the function that reads an embedded file. The export of the document puts the
 * features of the Store in their order and converts them with the same functions.
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
} from '../../../geometry/simplify.js';
import { DRAW_PROPERTY_PREFIX, getDrawProperty } from '../../../shared/properties.js';
import { listShownFeatures } from '../../../store/local-visibility.js';
import type { Store } from '../../../store/store.js';
import type { ExportOptions, Feature, FileData } from '../../../store/types.js';
import { GEOJSON_COORDINATE_DECIMALS } from './constants.js';
import { setOwnProperty } from './own-property.js';

type Position = [number, number];

/** Reads an embedded file by its ID (undefined when there is no such file) */
export type ReadFile = (id: string) => FileData | undefined;

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

/**
 * The geometry as it is exported: the positions rounded, the rings oriented by the right-hand
 * rule and the longitudes brought into [-180, 180] (null for a GeometryCollection, which no
 * feature holds)
 */
function exportGeometry(geometry: GeoJSON.Geometry): GeoJSON.Geometry | null {
  switch (geometry.type) {
    case 'Point':
      return { type: 'Point', coordinates: exportPosition(geometry.coordinates as Position) };
    case 'LineString':
      return { type: 'LineString', coordinates: exportLine(geometry.coordinates as Position[]) };
    case 'Polygon':
      return { type: 'Polygon', coordinates: exportPolygon(geometry.coordinates as Position[][]) };
    case 'MultiPoint':
      return { type: 'MultiPoint', coordinates: exportLine(geometry.coordinates as Position[]) };
    case 'MultiLineString':
      return {
        type: 'MultiLineString',
        coordinates: (geometry.coordinates as Position[][]).map(exportLine),
      };
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: normalizeMultiPolygonOrientation(
          (geometry.coordinates as Position[][][]).map((rings) => rings.map(roundLine)),
        ).map(wrapRings),
      };
    default:
      return null;
  }
}

/**
 * Converts an internal Feature into a GeoJSON Feature
 *
 * Conforms to docs/reference/data-format.md. The geometry and the properties are written as
 * they are: the values of this library already carry the maplibre-gl-draw: prefix, and name
 * and description are plain keys. Besides:
 *   - the fields of the feature (id, layer, group, visibility, lock, style) are added to the
 *     properties with the maplibre-gl-draw: prefix
 *   - the positions are rounded and the rings oriented (see the top of this file)
 *   - a type that is not the type of its geometry is identified by featureType
 *   - for an Image feature, the image data is embedded as Base64, when `readFile` is given
 *     and finds its file
 *
 * @param readFile - Reads the file of an Image by its ID
 */
export function convertFeatureToGeoJSON(
  feature: Feature,
  readFile?: ReadFile,
): GeoJSON.Feature<GeoJSON.Geometry> | null {
  const properties: Record<string, unknown> = {};

  // Add the properties as they are (the values of this library already carry the prefix).
  // They are defined as own properties so that a `__proto__` key is written out instead of
  // replacing the prototype of the output object.
  for (const [key, value] of Object.entries(feature.properties)) {
    setOwnProperty(properties, key, value);
  }

  // Add the metadata
  properties[`${DRAW_PROPERTY_PREFIX}id`] = feature.id;
  properties[`${DRAW_PROPERTY_PREFIX}layerId`] = feature.layerId;
  // A feature given from outside a drawing may carry `null` for no group, which is read as
  // undefined at the boundary
  if (feature.groupId != null) {
    properties[`${DRAW_PROPERTY_PREFIX}groupId`] = feature.groupId;
  }
  if (!feature.visible) {
    properties[`${DRAW_PROPERTY_PREFIX}visible`] = false;
  }
  if (feature.locked) {
    properties[`${DRAW_PROPERTY_PREFIX}locked`] = true;
  }
  if (Object.keys(feature.style).length > 0) {
    // A copy, so that changing the output does not change the feature given
    properties[`${DRAW_PROPERTY_PREFIX}style`] = structuredClone(feature.style);
  }

  const geometry = exportGeometry(feature.geometry);
  if (!geometry) {
    console.warn(`Unsupported geometry for GeoJSON export: ${feature.geometry.type}`);
    return null;
  }

  // A type that GeoJSON has no geometry for (Image, Circle, Freehand and custom types) makes
  // the round trip through the featureType marker, which carries the type name as it is (a
  // name such as MyShape keeps its inner capital). The import restores the type from it.
  if (feature.type !== feature.geometry.type) {
    properties[`${DRAW_PROPERTY_PREFIX}featureType`] = feature.type;
  }

  // Embed the image data of an Image as Base64
  if (feature.type === 'Image') {
    const imageFileId = getDrawProperty(feature, 'imageFileId');
    const fileData = imageFileId && readFile ? readFile(imageFileId) : undefined;
    if (fileData) {
      properties[`${DRAW_PROPERTY_PREFIX}imageData`] = fileData.dataURL;
      properties[`${DRAW_PROPERTY_PREFIX}imageMimeType`] = fileData.mimeType;
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
  // of the export. listShownFeatures returns only the visible features, so on its own it
  // would lose visible:false across the GeoJSON round trip. Including the hidden ones
  // preserves it across the round trip.
  const visibleOrdered = listShownFeatures(store);
  const visibleIds = new Set(visibleOrdered.map((f) => f.id));
  const hiddenFeatures = store.listFeatures().filter((f) => !visibleIds.has(f.id));
  let features = [...visibleOrdered, ...hiddenFeatures];

  if (options?.featureIds && options.featureIds.length > 0) {
    const featureIdSet = new Set(options.featureIds);
    features = features.filter((f) => featureIdSet.has(f.id));
  }
  if (options?.layerIds && options.layerIds.length > 0) {
    const layerIdSet = new Set(options.layerIds);
    features = features.filter((f) => layerIdSet.has(f.layerId));
  }

  return convertFeaturesToGeoJSON(features, (id) => store.getFile(id));
}

/**
 * Converts internal Features into a GeoJSON FeatureCollection, in the order given
 *
 * A feature whose geometry cannot be exported is left out. The collection carries the bbox of
 * every exported position, unless nothing was exported.
 *
 * @param readFile - Reads the file of an Image by its ID
 */
export function convertFeaturesToGeoJSON(
  features: readonly Feature[],
  readFile?: ReadFile,
): GeoJSON.FeatureCollection<GeoJSON.Geometry> {
  const geoJSONFeatures: GeoJSON.Feature<GeoJSON.Geometry>[] = [];
  for (const feature of features) {
    const geoFeature = convertFeatureToGeoJSON(feature, readFile);
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
