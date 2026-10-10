// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Conversion from GeoJSON to the internal Feature format + load of a
 * GeoJSON FeatureCollection
 */

import type { DrawPropertyName } from '../../../shared/properties.js';
import {
  DRAW_PROPERTY_NAMES,
  DRAW_PROPERTY_PREFIX,
  drawPropertyKey,
  hasDrawProperty,
  setDrawProperty,
} from '../../../shared/properties.js';
import type { AutoNameGenerator } from '../../../shared/utils/name-generator.js';
import type { Store } from '../../../store/store.js';
import type {
  Coordinate,
  Feature,
  FeatureStyle,
  FileData,
  LoadResult,
  SkippedFeature,
} from '../../../store/types.js';
import { DrawError, type DrawErrorCode } from '../../errors.js';
import type { EmbeddedFileProblem } from './embedded-file.js';
import { isEmbeddedFileProblem, normalizeEmbeddedFile } from './embedded-file.js';
import { COORDINATE_DEPTH, describeCoordinateProblem } from './geometry-validation.js';
import { foldLegacyImageStyle } from './legacy-image-style.js';
import { setOwnProperty } from './own-property.js';
import { isCssColor, sanitizeFeatureStyle } from './style-validation.js';
import type { ConvertedFeatureResult, GeoJSONImportOptions, PreparedLoad } from './types.js';

/** The result of a GeoJSON import */
export interface GeoJSONLoadResult extends LoadResult {
  format: 'geojson';
  /** The features of the source that were not imported, in source order */
  skipped: SkippedFeature[];
}

/**
 * Metadata shared by the Features restored from GeoJSON.
 * It groups the Feature fields other than geometry/coordinates.
 */
interface GeoJSONFeatureMeta {
  id: string;
  layerId: string;
  groupId: string | undefined;
  style: Feature['style'];
  visible: boolean;
  locked: boolean;
}

/**
 * Converts a single geometry (Point/LineString/Polygon) into the Feature format
 */
function convertSingleGeometry(
  geometry: GeoJSON.Point | GeoJSON.LineString | GeoJSON.Polygon,
  meta: GeoJSONFeatureMeta,
  userProperties: Record<string, unknown>,
  featureType: unknown,
  fileData: FileData | undefined,
): ConvertedFeatureResult | null {
  // The fields shared besides geometry (id/layerId/groupId/style/visible/locked)
  const base = {
    id: meta.id,
    layerId: meta.layerId,
    groupId: meta.groupId,
    properties: userProperties,
    style: meta.style,
    locked: meta.locked,
    visible: meta.visible,
  };

  switch (geometry.type) {
    case 'Point': {
      const type = resolveFeatureType('Point', featureType);
      return {
        feature: { ...base, type, geometry },
        // The embedded image belongs only to a feature that really is an Image
        fileData: type === 'Image' ? fileData : undefined,
      };
    }

    case 'LineString': {
      // A custom type with a sequence of points (such as an arrow) is written out as a
      // LineString, so restore the original type when the featureType marker is present
      // (this pairs with the default branch on export).
      const type = resolveFeatureType('LineString', featureType);
      return {
        feature: { ...base, type, geometry },
      };
    }

    case 'Polygon':
      // A custom type whose geometry is an area comes back from its marker as the others do
      return {
        feature: {
          ...base,
          type: resolveFeatureType('Polygon', featureType),
          geometry,
        },
      };

    default:
      return null;
  }
}

/**
 * Converts a Multi* geometry into a single Multi feature (the default behavior)
 *
 * The parts are kept as they are instead of being split, so that properties are not
 * duplicated.
 */
function convertMultiGeometry(
  geometry: GeoJSON.MultiPoint | GeoJSON.MultiLineString | GeoJSON.MultiPolygon,
  meta: GeoJSONFeatureMeta,
  userProperties: Record<string, unknown>,
  featureType: unknown,
): ConvertedFeatureResult[] | null {
  if (geometry.coordinates.length === 0) return null;

  return [
    {
      feature: {
        id: meta.id,
        layerId: meta.layerId,
        groupId: meta.groupId,
        properties: userProperties,
        style: meta.style,
        locked: meta.locked,
        visible: meta.visible,
        type: resolveFeatureType(geometry.type, featureType),
        geometry,
      },
    },
  ];
}

/**
 * Flattens the coordinates of a Multi* geometry into individual features
 *
 * A compatibility behavior used only when `flattenMulti: true` is given.
 */
function flattenMultiGeometry<T>(
  coordsArray: T[],
  toGeometry: (coords: T) => GeoJSON.Point | GeoJSON.LineString | GeoJSON.Polygon,
  generateFeatureId: () => string,
  meta: Omit<GeoJSONFeatureMeta, 'id'>,
  userProperties: Record<string, unknown>,
  featureType: unknown,
  fileData: FileData | undefined,
): ConvertedFeatureResult[] | null {
  const results: ConvertedFeatureResult[] = [];
  for (const coords of coordsArray) {
    // Each part of the Multi becomes an individual Feature, so assign it a new ID
    const result = convertSingleGeometry(
      toGeometry(coords),
      { ...meta, id: generateFeatureId() },
      { ...userProperties },
      featureType,
      fileData,
    );
    if (result) results.push(result);
  }
  return results.length > 0 ? results : null;
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
  geometry: GeoJSON.GeometryCollection,
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
 * Converts a GeometryCollection into a set of Features folded by type
 */
function convertGeometryCollection(
  geometry: GeoJSON.GeometryCollection,
  meta: Omit<GeoJSONFeatureMeta, 'id'>,
  userProperties: Record<string, unknown>,
  generateFeatureId: () => string,
): ConvertedFeatureResult[] | null {
  const buckets = {
    points: [] as Coordinate[],
    lines: [] as Coordinate[][],
    polygons: [] as Coordinate[][][],
  };
  collectGeometryCollectionParts(geometry, buckets);

  const results: ConvertedFeatureResult[] = [];

  // The folded features multiply out of the original single feature, so a new id is
  // assigned and the properties are copied for each folded feature.
  const push = (
    type: 'MultiPoint' | 'MultiLineString' | 'MultiPolygon',
    coordinates: Coordinate[] | Coordinate[][] | Coordinate[][][],
  ): void => {
    results.push({
      feature: {
        id: generateFeatureId(),
        layerId: meta.layerId,
        groupId: meta.groupId,
        properties: { ...userProperties },
        style: meta.style,
        locked: meta.locked,
        visible: meta.visible,
        type,
        geometry: { type, coordinates } as GeoJSON.Geometry,
      },
    });
  };

  if (buckets.points.length > 0) push('MultiPoint', buckets.points);
  if (buckets.lines.length > 0) push('MultiLineString', buckets.lines);
  if (buckets.polygons.length > 0) push('MultiPolygon', buckets.polygons);

  return results.length > 0 ? results : null;
}

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
function resolveFeatureType(
  geometryType:
    | 'Point'
    | 'LineString'
    | 'Polygon'
    | 'MultiPoint'
    | 'MultiLineString'
    | 'MultiPolygon',
  marker: unknown,
): string {
  if (typeof marker !== 'string' || marker === '') return geometryType;
  if (GEOMETRY_TYPE_NAMES.has(marker.toLowerCase())) return geometryType;
  const expectedDepth = COORDINATE_DEPTH[marker];
  const actualDepth = COORDINATE_DEPTH[geometryType];
  return expectedDepth === undefined || expectedDepth === actualDepth ? marker : geometryType;
}

/** The keys of `properties` that hold the values of this library */
const LIBRARY_KEYS: ReadonlySet<string> = new Set(
  DRAW_PROPERTY_NAMES.map((name) => drawPropertyKey(name)),
);

/** The values of a Circle that an earlier export wrote without the prefix */
const LEGACY_CIRCLE_PROPERTIES: readonly DrawPropertyName[] = ['radiusMeters', 'radiusHandleAngle'];

/** The geometry types the import converts */
const SUPPORTED_GEOMETRY_TYPES: ReadonlySet<string> = new Set([
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
function normalizeGeometry(geometry: unknown): GeoJSON.Geometry | string {
  if (geometry === null || geometry === undefined) return 'the feature has no geometry';
  if (!isRecord(geometry)) return 'the geometry is not an object';
  const { type } = geometry;
  if (type === 'GeometryCollection') {
    if (!Array.isArray(geometry.geometries)) {
      return 'the GeometryCollection has no geometries array';
    }
    const geometries: GeoJSON.Geometry[] = [];
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
  return { type, coordinates } as GeoJSON.Geometry;
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
  properties: GeoJSON.GeoJsonProperties,
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

/** How a GeoJSON Feature is converted */
export interface GeoJSONConvertOptions {
  /** Whether Multi* geometries are expanded into features with a single geometry */
  flattenMulti?: boolean;
  /**
   * Whether a feature keeps the ID the input gives it (a load resolves the collisions when it
   * writes); when false, every feature gets a new ID
   */
  keepIds: boolean;
}

/**
 * Converts a GeoJSON Feature into the internal Feature format
 *
 * The geometry is validated and normalized first, and a feature that cannot be imported is
 * returned as a reason instead of throwing. A Multi* geometry is kept as a Multi feature by
 * default (it is expanded into individual features only when `flattenMulti: true`). A
 * GeometryCollection is folded by type into at most three features. visible/locked/groupId
 * are restored from the properties with the maplibre-gl-draw: prefix. Nothing is written.
 *
 * @param generateId - Makes the IDs of new features and of the files of embedded images
 */
export function convertGeoJSONToFeature(
  geoFeature: unknown,
  layerId: string,
  generateId: () => string,
  options: GeoJSONConvertOptions,
): { results: ConvertedFeatureResult[] } | { reason: string } {
  if (!isRecord(geoFeature)) return { reason: 'the entry is not a GeoJSON Feature object' };
  const rawProperties = geoFeature.properties;
  if (rawProperties !== null && rawProperties !== undefined && !isRecord(rawProperties)) {
    return { reason: 'the properties are not an object' };
  }
  const properties = (rawProperties ?? null) as GeoJSON.GeoJsonProperties;
  const geometry = normalizeGeometry(geoFeature.geometry);
  if (typeof geometry === 'string') return { reason: geometry };

  const flattenMulti = options.flattenMulti === true;

  // An id is a string; a number (allowed for a GeoJSON id) is normalized into its string
  // form, and anything else gets a new id. The prefixed property takes precedence, then the
  // standard id member of the Feature. Whether it collides with existing data is resolved by
  // the caller, which knows the store. The id is taken only for a feature that keeps one
  // (the parts of a flattened Multi and of a GeometryCollection get their own).
  const prefixedId = properties?.[`${DRAW_PROPERTY_PREFIX}id`];
  const rawId =
    prefixedId === undefined || prefixedId === null || prefixedId === ''
      ? geoFeature.id
      : prefixedId;
  const sourceId =
    typeof rawId === 'string' && rawId !== ''
      ? rawId
      : typeof rawId === 'number' && Number.isFinite(rawId)
        ? String(rawId)
        : undefined;
  const takeId = (): string =>
    options.keepIds && sourceId !== undefined ? sourceId : generateId();
  const rawLayerId = properties?.[`${DRAW_PROPERTY_PREFIX}layerId`];
  const featureLayerId = typeof rawLayerId === 'string' && rawLayerId !== '' ? rawLayerId : layerId;
  const rawGroupId = properties?.[`${DRAW_PROPERTY_PREFIX}groupId`];
  const groupId = typeof rawGroupId === 'string' && rawGroupId !== '' ? rawGroupId : undefined;
  // The round-trip style key takes precedence; only when it is absent is the style built
  // from simplestyle-spec (they are not merged). Either way the keys are validated.
  const roundTripStyle = properties?.[`${DRAW_PROPERTY_PREFIX}style`];
  const style: Feature['style'] =
    (roundTripStyle !== undefined && roundTripStyle !== null
      ? sanitizeFeatureStyle(roundTripStyle)
      : simplestyleToFeatureStyle(properties)) ?? {};
  const featureType: unknown = properties?.[`${DRAW_PROPERTY_PREFIX}featureType`];
  // visible is hidden only when it is explicitly false, and locked is treated as locked
  // only when it is explicitly true
  const visible = properties?.[`${DRAW_PROPERTY_PREFIX}visible`] !== false;
  const locked = properties?.[`${DRAW_PROPERTY_PREFIX}locked`] === true;

  // Extract the embedded image data. It is taken only for a single point that really is an
  // Image.
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
  // Keys are defined as own properties so that a `__proto__` key stays an ordinary key.
  const userProperties: Record<string, unknown> = {};
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      if (key.startsWith(DRAW_PROPERTY_PREFIX)) {
        // When there is image data, imageFileId is replaced with a new ID, so it is not
        // added here. Anything else that is not a value of this library (id, layerId, style,
        // featureType, visible, locked, imageData and so on) is excluded
        if (LIBRARY_KEYS.has(key) && (key !== drawPropertyKey('imageFileId') || !embedsImage)) {
          setOwnProperty(userProperties, key, value);
        }
      } else {
        setOwnProperty(userProperties, key, value);
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

  // When there is image data on a single Image point, create the FileData and set a new
  // imageFileId
  let fileData: FileData | undefined;
  if (embedsImage) {
    const newFileId = generateId();
    fileData = {
      id: newFileId,
      mimeType: imageMimeType as string,
      dataURL: imageData as string,
    };
    setDrawProperty(userProperties, 'imageFileId', newFileId);
  }

  const meta: Omit<GeoJSONFeatureMeta, 'id'> = {
    layerId: featureLayerId,
    groupId,
    style,
    visible,
    locked,
  };

  const convert = (): ConvertedFeatureResult[] | null => {
    switch (geometry.type) {
      case 'Point':
      case 'LineString':
      case 'Polygon': {
        const result = convertSingleGeometry(
          geometry,
          { ...meta, id: takeId() },
          userProperties,
          featureType,
          fileData,
        );
        return result ? [result] : null;
      }

      case 'MultiPoint':
        if (!flattenMulti) {
          return convertMultiGeometry(
            geometry,
            { ...meta, id: takeId() },
            userProperties,
            featureType,
          );
        }
        return flattenMultiGeometry(
          geometry.coordinates,
          (coords) => ({ type: 'Point', coordinates: coords }) as GeoJSON.Point,
          generateId,
          meta,
          userProperties,
          featureType,
          fileData,
        );

      case 'MultiLineString':
        if (!flattenMulti) {
          return convertMultiGeometry(
            geometry,
            { ...meta, id: takeId() },
            userProperties,
            featureType,
          );
        }
        return flattenMultiGeometry(
          geometry.coordinates,
          (coords) => ({ type: 'LineString', coordinates: coords }) as GeoJSON.LineString,
          generateId,
          meta,
          userProperties,
          undefined,
          undefined,
        );

      case 'MultiPolygon':
        if (!flattenMulti) {
          return convertMultiGeometry(
            geometry,
            { ...meta, id: takeId() },
            userProperties,
            featureType,
          );
        }
        return flattenMultiGeometry(
          geometry.coordinates,
          (coords) => ({ type: 'Polygon', coordinates: coords }) as GeoJSON.Polygon,
          generateId,
          meta,
          userProperties,
          undefined,
          undefined,
        );

      case 'GeometryCollection':
        return convertGeometryCollection(geometry, meta, userProperties, generateId);

      default:
        // Unreachable: normalizeGeometry rejects every other type
        return null;
    }
  };

  const results = convert();
  // Only a GeometryCollection without any member produces nothing
  return results ? { results } : { reason: 'the geometry has no parts' };
}

/** A feature of the input that a conversion left out, with the code and the reason */
export interface ConversionSkip {
  /** The index of the feature in the input */
  index: number;
  /** Why it was left out */
  reason: DrawErrorCode;
  /** Why it was left out, in English, for logs */
  detail: string;
}

/** A converted feature with the index of the feature of the input it came from */
export interface IndexedConversion extends ConvertedFeatureResult {
  index: number;
}

/**
 * Converts the features of a GeoJSON FeatureCollection: the step that a load and a parse share
 *
 * A feature that cannot be converted is skipped with `invalid-input` and its reason. The
 * embedded images are not decoded yet (see {@link decodeEmbeddedImages}).
 */
export function convertGeoJSONFeatures(
  features: readonly unknown[],
  layerId: string,
  generateId: () => string,
  options: GeoJSONConvertOptions,
): { results: IndexedConversion[]; skipped: ConversionSkip[] } {
  const results: IndexedConversion[] = [];
  const skipped: ConversionSkip[] = [];
  features.forEach((geoFeature: unknown, index) => {
    const converted = convertGeoJSONToFeature(geoFeature, layerId, generateId, options);
    if ('reason' in converted) {
      skipped.push({ index, reason: 'invalid-input', detail: converted.reason });
    } else {
      for (const result of converted.results) results.push({ ...result, index });
    }
  });
  return { results, skipped };
}

/**
 * Validates and normalizes the embedded images of converted features, in place: the step that
 * a load and a parse share
 *
 * Embedded images are accepted only as PNG / JPEG / WebP / GIF data URLs, and an oversized one
 * is scaled down. Nothing is thrown; the features whose image cannot be imported are returned
 * with the problem, in input order.
 */
export async function decodeEmbeddedImages(
  results: readonly IndexedConversion[],
): Promise<Array<{ result: IndexedConversion; problem: EmbeddedFileProblem }>> {
  const problems: Array<{ result: IndexedConversion; problem: EmbeddedFileProblem }> = [];
  for (const result of results) {
    if (!result.fileData) continue;
    const content = await normalizeEmbeddedFile(result.fileData.dataURL, result.fileData.mimeType);
    if (isEmbeddedFileProblem(content)) {
      problems.push({ result, problem: content });
    } else {
      result.fileData = { ...result.fileData, ...content };
    }
  }
  return problems;
}

/** How many times a colliding feature id is regenerated before the import gives up */
const MAX_ID_ATTEMPTS = 1000;

/**
 * Reads a GeoJSON FeatureCollection for a load that adds to the existing data (or replaces
 * the features and groups): the features are converted and checked and the embedded images
 * decoded here, and the writes are left to the transaction of the caller. The IDs and the
 * references to layers and groups are resolved when the features are written, against the
 * document as it is then (another load of the same transaction may have changed it).
 */
export async function prepareGeoJSON(
  data: GeoJSON.FeatureCollection<GeoJSON.Geometry>,
  deps: {
    store: Store;
    autoNameGenerator: AutoNameGenerator;
    generateFeatureId: () => string;
    getCurrentLayerId: () => string;
  },
  options?: GeoJSONImportOptions,
): Promise<PreparedLoad> {
  const { store, autoNameGenerator, generateFeatureId, getCurrentLayerId } = deps;
  const layerId = getCurrentLayerId();

  // 1. Validate and convert everything, and decode the embedded images, before writing.
  //    store.transact does not roll back, so nothing may throw once the writing has started. A
  //    feature that cannot be imported is skipped with its reason instead of rejecting the
  //    whole load. The features keep the IDs of the file; the collisions are resolved when
  //    they are written.
  const converted = convertGeoJSONFeatures(data.features, layerId, generateFeatureId, {
    flattenMulti: options?.flattenMulti,
    keepIds: true,
  });
  const { results } = converted;
  const skipped: SkippedFeature[] = converted.skipped.map(({ index, detail }) => ({
    index,
    reason: detail,
  }));

  // Unlike a malformed geometry, a bad image rejects the whole load: the image fields are
  // written only by this library's export, so a bad one means the file was altered, and the
  // load is refused rather than trusted in part. An image the browser cannot encode is refused
  // as unsupported-format, the same as when an image file is loaded.
  const [failure] = await decodeEmbeddedImages(results);
  if (failure) {
    const { result, problem } = failure;
    throw new DrawError(
      problem.code,
      `Invalid GeoJSON: the image data of feature "${result.feature.id}" ${problem.detail}`,
      problem.cause === undefined ? undefined : { cause: problem.cause },
    );
  }

  const replace = options?.replace === true;
  // 2. The writes, in the transaction of the caller, the deletion of a replace included: the
  //    whole import is one notification, one step for a subscriber that records changes
  const write = (): LoadResult => {
    const currentLayerId = getCurrentLayerId();
    if (replace) {
      for (const feature of store.listFeatures()) store.deleteFeature(feature.id);
      for (const group of store.listGroups()) store.deleteGroup(group.id);
    }
    // Feature and group IDs share the entries of layer.order, so an id taken by either (or by
    // an earlier feature of this import) is replaced with a new one. This is what makes a
    // GeoJSON exported from a store loadable into the same store again.
    // With replace, the features and groups of the document are gone by the time the new ones
    // are written, so only the IDs of this import can collide
    const takenIds = new Set<string>();
    const isTaken = (id: string): boolean =>
      takenIds.has(id) ||
      options?.reservedIds?.has(id) === true ||
      (!replace && (store.getFeature(id) !== undefined || store.getGroup(id) !== undefined));
    const resolveId = (id: string): string => {
      let resolved = id;
      for (let attempt = 0; isTaken(resolved); attempt++) {
        if (attempt >= MAX_ID_ATTEMPTS) {
          throw new DrawError(
            'invalid-input',
            'Failed to generate a unique feature id for the GeoJSON import',
          );
        }
        resolved = generateFeatureId();
      }
      takenIds.add(resolved);
      return resolved;
    };

    const forcedLayerId = options?.layerId;
    const oneGroup = options?.oneGroup === true;
    for (const { feature } of results) {
      feature.id = resolveId(feature.id);
      // References are resolved against this store: a layer given to the load wins over the one
      // the feature names, a layer the store does not have falls back to the current layer, and a
      // group it does not have (or a group of another layer, or any group when the groups are
      // replaced) is dropped: a feature pointing at a missing group would belong to no layer
      // order and never be drawn.
      if (forcedLayerId !== undefined && store.getLayer(forcedLayerId)) {
        feature.layerId = forcedLayerId;
      } else if (forcedLayerId !== undefined || oneGroup || !store.getLayer(feature.layerId)) {
        feature.layerId = currentLayerId;
      }
      // The features of a load that makes a group of them leave the group they name
      if (oneGroup) delete feature.groupId;
      if (feature.groupId !== undefined) {
        const group = replace ? undefined : store.getGroup(feature.groupId);
        if (!group || group.layerId !== feature.layerId) delete feature.groupId;
      }
    }

    const featureIds: string[] = [];
    for (const result of results) {
      // When there is image data, add the file first
      if (result.fileData) {
        store.createFile(result.fileData);
      }
      // When name is not set, generate an automatic name
      if (result.feature.properties.name === undefined) {
        const autoName = autoNameGenerator.generateName(result.feature.type);
        if (autoName !== undefined) {
          result.feature.properties.name = autoName;
        }
      }
      store.createFeature(result.feature);
      featureIds.push(result.feature.id);
    }

    const loaded: GeoJSONLoadResult = {
      format: 'geojson',
      featureIds,
      replaced: replace,
      skipped,
    };
    return loaded;
  };
  return { write };
}
