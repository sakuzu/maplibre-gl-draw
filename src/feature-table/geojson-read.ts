// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a feature of GeoJSON is read: its geometry checked and normalized, its type, its style,
 * whether it is shown and locked, and its properties with the values of the library. A load
 * (`document.load`), a parse (`parseGeoJSON`) and the rows read for a layer held as rows
 * (`rowsOfGeoJSON`) all read a feature here, so the same feature is read the same way.
 */

import type { Geometry, GeometryCollection } from 'geojson';
import { COORDINATE_DEPTH, describeCoordinateProblem } from '../shared/geometry-validation.js';
import { foldLegacyImageStyle } from '../shared/legacy-image-style.js';
import type { DrawPropertyName } from '../shared/properties.js';
import {
  DRAW_PROPERTY_NAMES,
  DRAW_PROPERTY_PREFIX,
  drawPropertyKey,
  hasDrawProperty,
} from '../shared/properties.js';
import { isCssColor, sanitizeFeatureStyle } from '../shared/style-validation.js';
import type { Coordinate, FeatureStyle } from '../shared/types/model.js';
import { setOwnProperty } from '../shared/utils/own-property.js';
import { type Value, valueOfInput } from '../table/value.js';

/** The names of the GeoJSON geometry types, lower-cased */
const GEOMETRY_TYPE_NAMES: ReadonlySet<string> = new Set([
  'point',
  'linestring',
  'polygon',
  'multipoint',
  'multilinestring',
  'multipolygon',
  'geometrycollection',
]);

/** The geometry types that are read (a GeometryCollection is folded into them) */
const SUPPORTED_GEOMETRY_TYPES: ReadonlySet<string> = new Set([
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
]);

/** The keys of `properties` that hold the values of this library */
const LIBRARY_KEYS: ReadonlySet<string> = new Set(
  DRAW_PROPERTY_NAMES.map((name) => drawPropertyKey(name)),
);

/** The values of a Circle that an earlier export wrote without the prefix */
const LEGACY_CIRCLE_PROPERTIES: readonly DrawPropertyName[] = ['radiusMeters', 'radiusHandleAngle'];

type SimpleGeometryType =
  | 'Point'
  | 'LineString'
  | 'Polygon'
  | 'MultiPoint'
  | 'MultiLineString'
  | 'MultiPolygon';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolves the feature type of a geometry from the featureType marker
 *
 * The marker restores a type that GeoJSON has no geometry for (Image, Circle, Freehand and
 * custom types, whatever their geometry). The export writes the type name as it is, and the
 * marker is read as that exact name: it wins over the kind of the geometry. It is used only
 * when it is a non-empty string, does not name a GeoJSON geometry type (in any letter case),
 * and does not name a built-in type whose coordinates have another shape. Anything else is
 * ignored and the geometry type is kept, so the marker can never pair a built-in type with
 * coordinates of another shape.
 */
function resolveFeatureType(geometryType: SimpleGeometryType, marker: unknown): string {
  if (typeof marker !== 'string' || marker === '') return geometryType;
  if (GEOMETRY_TYPE_NAMES.has(marker.toLowerCase())) return geometryType;
  const expectedDepth = COORDINATE_DEPTH[marker];
  const actualDepth = COORDINATE_DEPTH[geometryType];
  return expectedDepth === undefined || expectedDepth === actualDepth ? marker : geometryType;
}

/**
 * Truncates every GeoJSON position to the two elements [longitude, latitude]
 *
 * GeoJSON allows a third element and beyond (elevation and so on), but the Coordinate
 * of core has two elements. Letting a three-element position through misaligns the
 * coordinate packing of the rendering so that nothing can be drawn, so it is normalized
 * at the import boundary. A value that is not an array is returned as it is (the
 * validation that follows rejects it).
 */
function truncatePositions(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (typeof value[0] === 'number') return value.length > 2 ? value.slice(0, 2) : value;
  return value.map(truncatePositions);
}

/**
 * Returns a copy of the geometry with every position truncated to two elements, or the
 * reason it cannot be imported
 *
 * Every geometry of a GeometryCollection must be valid for the GeometryCollection to be imported.
 */
function normalizeGeometry(geometry: unknown): Geometry | string {
  if (geometry === null || geometry === undefined) return 'the feature has no geometry';
  if (!isRecord(geometry)) return 'the geometry is not an object';
  const { type } = geometry;
  if (type === 'GeometryCollection') {
    if (!Array.isArray(geometry.geometries)) {
      return 'the GeometryCollection has no geometries array';
    }
    const geometries: Geometry[] = [];
    for (const sub of geometry.geometries) {
      const normalized = normalizeGeometry(sub);
      if (typeof normalized === 'string') {
        return `a geometry of the GeometryCollection: ${normalized}`;
      }
      geometries.push(normalized);
    }
    return { type, geometries };
  }
  if (typeof type !== 'string' || !SUPPORTED_GEOMETRY_TYPES.has(type)) {
    return `unsupported geometry type "${String(type)}"`;
  }
  const coordinates = truncatePositions(geometry.coordinates);
  const problem = describeCoordinateProblem(type, coordinates);
  if (problem) return `the ${type} has ${problem}`;
  return { type, coordinates } as Geometry;
}

/**
 * Copies the properties of simplestyle-spec into a FeatureStyle (an import fallback)
 *
 * Plain GeoJSON (the output of a GPS logger or of another tool) does not carry a style
 * with the maplibre-gl-draw: prefix, but it may express colors and line widths through the
 * keys of simplestyle-spec. Only when the round-trip key is absent are these read as the
 * internal style. Keys whose type or form does not match (a color that is not #rgb or
 * #rrggbb, an opacity outside 0-1, a negative width) are silently ignored, and undefined is
 * returned if not a single one could be copied. The original properties are not rewritten,
 * so the simplestyle keys remain as user-defined properties.
 */
function simplestyleToFeatureStyle(
  properties: Record<string, unknown> | null,
): FeatureStyle | undefined {
  if (!properties) return undefined;

  const style: FeatureStyle = {};
  let found = false;

  const copyString = (key: string, target: 'strokeColor' | 'fillColor' | 'pointColor'): void => {
    const value = properties[key];
    if (isCssColor(value)) {
      style[target] = value as string;
      found = true;
    }
  };
  const copyNumber = (
    key: string,
    target: 'strokeWidth' | 'strokeOpacity' | 'fillOpacity',
  ): void => {
    const value = properties[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      style[target] = value;
      found = true;
    }
  };

  copyString('stroke', 'strokeColor');
  copyNumber('stroke-width', 'strokeWidth');
  copyNumber('stroke-opacity', 'strokeOpacity');
  copyString('fill', 'fillColor');
  copyNumber('fill-opacity', 'fillOpacity');
  copyString('marker-color', 'pointColor');

  // The numbers are checked against the ranges of FeatureStyle by the same rules as the
  // round-trip style
  return found ? sanitizeFeatureStyle(style) : undefined;
}

/**
 * Folds the sub-geometries of a GeometryCollection by type
 *
 * A GeometryCollection is not made a first-class feature type; it is gathered into one
 * geometry per type. Sub-geometries of the same kind become a single Multi
 * (a GC of three Polygons becomes one MultiPolygon feature), and even when they are
 * mixed, they grow to at most three features, one per type
 * (MultiPoint / MultiLineString / MultiPolygon). Duplication of the properties is thus
 * held down to those three.
 *
 * A nested GeometryCollection is expanded recursively into the same buckets.
 */
function collectGeometryCollectionParts(
  geometry: GeometryCollection,
  buckets: {
    points: Coordinate[];
    lines: Coordinate[][];
    polygons: Coordinate[][][];
  },
): void {
  for (const sub of geometry.geometries) {
    switch (sub.type) {
      case 'Point':
        buckets.points.push(sub.coordinates as Coordinate);
        break;
      case 'MultiPoint':
        buckets.points.push(...(sub.coordinates as Coordinate[]));
        break;
      case 'LineString':
        buckets.lines.push(sub.coordinates as Coordinate[]);
        break;
      case 'MultiLineString':
        buckets.lines.push(...(sub.coordinates as Coordinate[][]));
        break;
      case 'Polygon':
        buckets.polygons.push(sub.coordinates as Coordinate[][]);
        break;
      case 'MultiPolygon':
        buckets.polygons.push(...(sub.coordinates as Coordinate[][][]));
        break;
      case 'GeometryCollection':
        collectGeometryCollectionParts(sub, buckets);
        break;
      default:
        // Unreachable: normalizeGeometry rejects every other type before conversion
        break;
    }
  }
}

/**
 * The type and the geometry of one feature read from a feature of GeoJSON
 *
 * @internal
 */
export interface GeoJSONPart {
  type: string;
  geometry: Geometry;
}

/**
 * The geometries of a feature of GeoJSON, each with its type: one, or one per part of a Multi
 * geometry with `flattenMulti`, or one per kind of the geometries of a GeometryCollection (at
 * most three)
 */
function partsOf(geometry: Geometry, featureType: unknown, flattenMulti: boolean): GeoJSONPart[] {
  switch (geometry.type) {
    case 'Point':
    case 'LineString':
    case 'Polygon':
      // A custom type with a sequence of points (such as an arrow) is written out as a
      // LineString, and one whose geometry is an area as a Polygon, so the original type is
      // restored when the featureType marker is present (this pairs with the export)
      return [{ type: resolveFeatureType(geometry.type, featureType), geometry }];
    case 'MultiPoint':
    case 'MultiLineString':
    case 'MultiPolygon': {
      if (geometry.coordinates.length === 0) return [];
      if (!flattenMulti) {
        // The parts are kept as they are instead of being split, so that properties are not
        // duplicated
        return [{ type: resolveFeatureType(geometry.type, featureType), geometry }];
      }
      // A compatibility behavior used only when `flattenMulti: true` is given: each part is a
      // feature of its own. The marker is read for the points only
      if (geometry.type === 'MultiPoint') {
        return geometry.coordinates.map((coordinates) => ({
          type: resolveFeatureType('Point', featureType),
          geometry: { type: 'Point', coordinates },
        }));
      }
      if (geometry.type === 'MultiLineString') {
        return geometry.coordinates.map((coordinates) => ({
          type: 'LineString',
          geometry: { type: 'LineString', coordinates },
        }));
      }
      return geometry.coordinates.map((coordinates) => ({
        type: 'Polygon',
        geometry: { type: 'Polygon', coordinates },
      }));
    }
    case 'GeometryCollection': {
      const buckets = {
        points: [] as Coordinate[],
        lines: [] as Coordinate[][],
        polygons: [] as Coordinate[][][],
      };
      collectGeometryCollectionParts(geometry, buckets);
      const parts: GeoJSONPart[] = [];
      if (buckets.points.length > 0) {
        parts.push({
          type: 'MultiPoint',
          geometry: { type: 'MultiPoint', coordinates: buckets.points },
        });
      }
      if (buckets.lines.length > 0) {
        parts.push({
          type: 'MultiLineString',
          geometry: { type: 'MultiLineString', coordinates: buckets.lines },
        });
      }
      if (buckets.polygons.length > 0) {
        parts.push({
          type: 'MultiPolygon',
          geometry: { type: 'MultiPolygon', coordinates: buckets.polygons },
        });
      }
      return parts;
    }
    default:
      return [];
  }
}

/**
 * A feature of GeoJSON as it is read, before it is written anywhere
 *
 * @internal
 */
export interface GeoJSONFeatureRead {
  /** The features it is read as, in order: their types and geometries */
  readonly parts: readonly GeoJSONPart[];
  /**
   * Whether it is read as one feature that can keep the ID of the input: not the parts of a
   * flattened Multi geometry, nor those of a GeometryCollection
   */
  readonly whole: boolean;
  /** The ID the input gives it, as text */
  readonly inputId: string | undefined;
  /** The layer it names (`maplibre-gl-draw:layerId`) */
  readonly layerId: string | undefined;
  /** The group it names (`maplibre-gl-draw:groupId`) */
  readonly groupId: string | undefined;
  readonly style: FeatureStyle;
  readonly visible: boolean;
  readonly locked: boolean;
  /**
   * The user-defined properties and the values of the library; without the file of the image
   * when the feature embeds one (it takes the ID of the new file)
   */
  readonly properties: Record<string, Value>;
  /** The image a single Image point embeds, with the ID the input gives its file */
  readonly image?: {
    readonly mimeType: string;
    readonly dataURL: string;
    readonly fileId?: string;
  };
}

/**
 * Reads a feature of GeoJSON
 *
 * The geometry is validated and normalized first, and a feature that cannot be read is
 * returned as a reason instead of throwing. A Multi* geometry is kept as a Multi feature unless
 * `flattenMulti`. A GeometryCollection is folded by type into at most three features. The
 * type, the style, visible, locked, the IDs it names and the values of the library are read
 * from the properties with the maplibre-gl-draw: prefix; the style falls back to the keys of
 * simplestyle-spec.
 *
 * @returns What is read, or why it cannot be read
 * @throws DrawError (`invalid-input`) when a value of the properties is not a value
 * @internal
 */
export function readGeoJSONFeature(
  geoFeature: unknown,
  flattenMulti: boolean,
): GeoJSONFeatureRead | string {
  if (!isRecord(geoFeature)) return 'the entry is not a GeoJSON Feature object';
  const rawProperties = geoFeature.properties;
  if (rawProperties !== null && rawProperties !== undefined && !isRecord(rawProperties)) {
    return 'the properties are not an object';
  }
  const properties = (rawProperties ?? null) as Record<string, unknown> | null;
  const geometry = normalizeGeometry(geoFeature.geometry);
  if (typeof geometry === 'string') return geometry;

  // An id is a string; a number (allowed for a GeoJSON id) is normalized into its string
  // form, and anything else is no id. The prefixed property takes precedence, then the
  // standard id member of the Feature.
  const prefixedId = properties?.[`${DRAW_PROPERTY_PREFIX}id`];
  const rawId =
    prefixedId === undefined || prefixedId === null || prefixedId === ''
      ? geoFeature.id
      : prefixedId;
  const inputId =
    typeof rawId === 'string' && rawId !== ''
      ? rawId
      : typeof rawId === 'number' && Number.isFinite(rawId)
        ? String(rawId)
        : undefined;
  const rawLayerId = properties?.[`${DRAW_PROPERTY_PREFIX}layerId`];
  const layerId = typeof rawLayerId === 'string' && rawLayerId !== '' ? rawLayerId : undefined;
  const rawGroupId = properties?.[`${DRAW_PROPERTY_PREFIX}groupId`];
  const groupId = typeof rawGroupId === 'string' && rawGroupId !== '' ? rawGroupId : undefined;
  // The round-trip style key takes precedence; only when it is absent is the style built
  // from simplestyle-spec (they are not merged). Either way the keys are validated.
  const roundTripStyle = properties?.[`${DRAW_PROPERTY_PREFIX}style`];
  const style: FeatureStyle =
    (roundTripStyle !== undefined && roundTripStyle !== null
      ? sanitizeFeatureStyle(roundTripStyle)
      : simplestyleToFeatureStyle(properties)) ?? {};
  const featureType: unknown = properties?.[`${DRAW_PROPERTY_PREFIX}featureType`];
  // visible is hidden only when it is explicitly false, and locked is treated as locked
  // only when it is explicitly true
  const visible = properties?.[`${DRAW_PROPERTY_PREFIX}visible`] !== false;
  const locked = properties?.[`${DRAW_PROPERTY_PREFIX}locked`] === true;

  // The embedded image data is taken only for a single point that really is an Image
  const imageData = properties?.[`${DRAW_PROPERTY_PREFIX}imageData`] as string | undefined;
  const imageMimeType = properties?.[`${DRAW_PROPERTY_PREFIX}imageMimeType`] as string | undefined;
  const embedsImage =
    Boolean(imageData && imageMimeType) &&
    geometry.type === 'Point' &&
    resolveFeatureType('Point', featureType) === 'Image';

  // Extract the properties
  // - without a prefix: added as is as a user-defined property
  // - with a prefix and one of this library's own values: added as is
  // - any other prefixed key (id, layerId, style, visible, locked and so on): excluded
  //   (they are handled separately)
  // Keys are defined as own properties so that a `__proto__` key stays an ordinary key. Each
  // value is held in the one form of a value, and a value that is not one refuses the feature.
  const userProperties: Record<string, Value> = {};
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      if (key.startsWith(DRAW_PROPERTY_PREFIX)) {
        // When there is image data, imageFileId is replaced with the ID of the new file, so it
        // is not added here. Anything else that is not a value of this library (id, layerId,
        // style, featureType, visible, locked, imageData and so on) is excluded
        if (LIBRARY_KEYS.has(key) && (key !== drawPropertyKey('imageFileId') || !embedsImage)) {
          setOwnProperty(userProperties, key, valueOfInput(value, `The property ${key}`));
        }
      } else if (value !== undefined) {
        setOwnProperty(userProperties, key, valueOfInput(value, `The property ${key}`));
      }
    }
  }

  // An earlier export wrote the radius of a Circle and the direction of its handle without
  // the prefix; they are read as the values of this library when the prefixed ones are absent
  if (geometry.type === 'Point' && resolveFeatureType('Point', featureType) === 'Circle') {
    for (const name of LEGACY_CIRCLE_PROPERTIES) {
      if (userProperties[name] !== undefined && !hasDrawProperty(userProperties, name)) {
        setOwnProperty(userProperties, drawPropertyKey(name), userProperties[name]);
        delete userProperties[name];
      }
    }
  }

  // The style of an Image written by an earlier export can carry its size, a rotation and an
  // opacity of its own; they are read as the values of this library and imageOpacity
  if (geometry.type === 'Point' && resolveFeatureType('Point', featureType) === 'Image') {
    foldLegacyImageStyle(userProperties, style as Record<string, unknown>);
  }

  let image: GeoJSONFeatureRead['image'];
  if (embedsImage) {
    const namedFileId = properties?.[drawPropertyKey('imageFileId')];
    image = {
      mimeType: imageMimeType as string,
      dataURL: imageData as string,
      ...(typeof namedFileId === 'string' && namedFileId !== '' && { fileId: namedFileId }),
    };
  }

  const parts = partsOf(geometry, featureType, flattenMulti);
  // Only a GeometryCollection without any member, or an empty Multi geometry, produces nothing
  if (parts.length === 0) return 'the geometry has no parts';
  const whole =
    geometry.type !== 'GeometryCollection' && !(flattenMulti && geometry.type.startsWith('Multi'));
  return {
    parts,
    whole,
    inputId,
    layerId,
    groupId,
    style,
    visible,
    locked,
    properties: userProperties,
    ...(image && { image }),
  };
}
