// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The document model: features, layers, groups, metadata, their inputs, patches and filters
 *
 * Geometries and attributes are GeoJSON as they are. The values the library keeps on a
 * feature are keys of `properties` that start with {@link DRAW_PROPERTY_PREFIX}; every other
 * key is an attribute of the user.
 */

import type {
  Feature as GeoJSONFeature,
  FeatureCollection as GeoJSONFeatureCollection,
  Geometry,
  Position,
} from 'geojson';
import type { BBox } from '../geometry/types.js';
import type { Messages } from '../messages.js';
import { isDrawProperty as isLibraryKey } from '../shared/properties.js';
import type { LineStyle } from '../shared/types/style.js';
import {
  deriveLegend as deriveRuleLegend,
  evaluateStyleRule as evaluateRule,
  getStyleRuleChannel as getRuleChannel,
} from '../view/style-rule.js';
import type { DrawErrorCode } from './errors.js';
import {
  convertFeaturesToGeoJSON,
  convertFeatureToGeoJSON,
} from './impl/import-export/geojson-export.js';
import { parseGeoJSONInput, parseNativeInput } from './impl/import-export/parse.js';

// ============================================================================
// Features
// ============================================================================

/**
 * The type of a feature: a built-in type, or the name of a custom type.
 *
 * The built-in types are Point, LineString, Polygon, MultiPoint, MultiLineString,
 * MultiPolygon, Circle, Freehand and Image. Any other string names a custom type.
 */
export type FeatureType =
  | 'Point'
  | 'LineString'
  | 'Polygon'
  | 'MultiPoint'
  | 'MultiLineString'
  | 'MultiPolygon'
  | 'Circle'
  | 'Freehand'
  | 'Image'
  | (string & {});

// The dash pattern of a line is the one the shared line renderer draws
export type { LineStyle };

/** The shape of a point marker. */
export type PointShape = 'circle' | 'square' | 'triangle' | 'star';

/**
 * How a feature looks; every key is optional, and a key left out takes the value of the
 * layer rule or the default.
 *
 * Colors are CSS colors. Widths and radii are in CSS pixels at the reference zoom of the
 * feature.
 */
export interface FeatureStyle {
  /** The fill color */
  fillColor?: string;
  /** The opacity of the fill, from 0 to 1 */
  fillOpacity?: number;
  /** The color of a line or of the outline of an area (`pointStrokeColor` for a point) */
  strokeColor?: string;
  /**
   * The width of a line or of the outline of an area, in pixels at the reference zoom
   * (`pointStrokeWidth` for a point)
   */
  strokeWidth?: number;
  /** The opacity of a line or of the outline of an area, from 0 to 1 */
  strokeOpacity?: number;
  /** The dash pattern of a line or an outline */
  lineStyle?: LineStyle;
  /** The color of a point marker */
  pointColor?: string;
  /** The radius of a point marker, in pixels */
  pointRadius?: number;
  /** The shape of a point marker */
  pointShape?: PointShape;
  /** The opacity of a point marker, its fill and its outline, from 0 to 1 */
  pointOpacity?: number;
  /** The color of the outline of a point marker; `#ffffff` by default */
  pointStrokeColor?: string;
  /** The width of the outline of a point marker, in pixels (0 for none); 2 by default */
  pointStrokeWidth?: number;
  /** The opacity of an image, from 0 to 1 */
  imageOpacity?: number;
}

/**
 * The look a feature is drawn with: the default, the layer rule and the style of the feature
 * put on top of each other.
 */
export type FeatureStyleResolved = Required<FeatureStyle>;

export { DRAW_PROPERTY_PREFIX } from '../shared/properties.js';

/**
 * The `properties` of a feature: the GeoJSON properties themselves, with the keys of the
 * library typed.
 *
 * A key that starts with {@link DRAW_PROPERTY_PREFIX} holds a value of the library; any other
 * key is an attribute of the user. Export and load keep the keys as they are.
 */
export type DrawProperties = Record<string, unknown> & {
  /** The reference zoom: the zoom the feature was drawn or created at */
  'maplibre-gl-draw:createdZoom'?: number;
  /** The rotation, in degrees */
  'maplibre-gl-draw:rotation'?: number;
  /** The scale factor */
  'maplibre-gl-draw:scale'?: number;
  /** The radius of a circle, in meters */
  'maplibre-gl-draw:radiusMeters'?: number;
  /** The direction of the radius handle of a circle, in degrees */
  'maplibre-gl-draw:radiusHandleAngle'?: number;
  /** The ID of the file of an image feature */
  'maplibre-gl-draw:imageFileId'?: string;
  /** The width of the image of an image feature, in pixels */
  'maplibre-gl-draw:imageWidth'?: number;
  /** The height of the image of an image feature, in pixels */
  'maplibre-gl-draw:imageHeight'?: number;
};

/**
 * Whether a key of `properties` holds a value of the library, so that an attribute panel can
 * leave it out.
 *
 * @param key - A key of `properties`
 * @returns True when the key starts with {@link DRAW_PROPERTY_PREFIX}
 */
export function isDrawProperty(key: string): boolean {
  return isLibraryKey(key);
}

/**
 * A shape that can be drawn and edited, with its layer, group, attributes and look.
 */
export interface Feature {
  /** The ID */
  id: string;
  /** The type */
  type: FeatureType;
  /** The GeoJSON geometry */
  geometry: Geometry;
  /** The ID of the layer it is in */
  layerId: string;
  /** The ID of the group it is in */
  groupId: string | undefined;
  /** The GeoJSON properties: the attributes of the user and the values of the library */
  properties: DrawProperties;
  /** The look of the feature */
  style: FeatureStyle;
  /** Whether it is visible */
  visible: boolean;
  /** Whether it is locked */
  locked: boolean;
}

// ============================================================================
// Layers and groups
// ============================================================================

/**
 * A rule that colors the features of a layer from the value of an attribute.
 *
 * - `single`: one color for every feature
 * - `categorical`: the color of the value of `property` in `map`
 * - `graduated`: the class of the number in `property` by the ascending `breaks`, with
 *   `colors` holding one more color than `breaks`
 * - `continuous`: the color between the two colors of `ramp`, from `min` to `max`
 *
 * A feature without the attribute, or with a value of the wrong type, takes `other`.
 */
export type StyleRule =
  | { kind: 'single'; color: string }
  | { kind: 'categorical'; property: string; map: Record<string, string>; other: string }
  | { kind: 'graduated'; property: string; breaks: number[]; colors: string[]; other: string }
  | {
      kind: 'continuous';
      property: string;
      min: number;
      max: number;
      ramp: [string, string];
      other: string;
    };

/** One row of the legend of a style rule. */
export interface LegendEntry {
  /** The label to show */
  label: string;
  /** The color, as `#rrggbb` */
  color: string;
}

/**
 * A unit of the stacking order that holds features and groups.
 */
export interface Layer {
  /** The ID */
  id: string;
  /** The name */
  name: string;
  /** Whether it is visible */
  visible: boolean;
  /** Whether it is locked */
  locked: boolean;
  /** The opacity of the whole layer, from 0 to 1 */
  opacity: number;
  /**
   * The IDs of the features and groups in the layer, from the back. `features.move` and
   * `groups.move` change it
   */
  items: readonly string[];
  /** The rule that colors its features from their attributes */
  styleRule: StyleRule | undefined;
  /** Values of the user */
  metadata: Record<string, unknown> | undefined;
}

/**
 * A set of features in one layer.
 */
export interface Group {
  /** The ID */
  id: string;
  /** The ID of the layer it is in */
  layerId: string;
  /** The name */
  name: string;
  /** The IDs of its features, from the back */
  featureIds: readonly string[];
  /** Whether it is visible */
  visible: boolean;
  /** Whether it is locked */
  locked: boolean;
}

// ============================================================================
// The document
// ============================================================================

/**
 * The title and the description of the document.
 *
 * An application can add fields of its own by declaration merging.
 */
export interface Metadata {
  /** The title */
  title?: string;
  /** The description */
  description?: string;
}

/** A file embedded in the document, such as the data of an image. */
export interface FileData {
  /** The ID, unique within the document */
  id: string;
  /** The MIME type, such as `image/webp` */
  mimeType: string;
  /** The content as a data URL */
  dataURL: string;
}

/**
 * The whole document in the format of the library, as `document.toJSON` writes it and
 * `document.load` reads it.
 */
export interface DrawDocument {
  /** The version of the format */
  version: string;
  /** When it was written, as an ISO 8601 timestamp */
  created?: string;
  /** When it was last changed, as an ISO 8601 timestamp */
  modified?: string;
  /** The title and the description */
  metadata?: Metadata;
  /** The layers */
  layers?: Layer[];
  /** The IDs of the layers in stacking order, from the back */
  layerOrder: string[];
  /** The groups */
  groups?: Group[];
  /** The features */
  features: Feature[];
  /** The embedded files, by ID */
  files?: Record<string, FileData>;
}

// ============================================================================
// Inputs, patches and filters
// ============================================================================

/**
 * What `features.create` takes. The radius of a circle and the other values of the library
 * go into `properties` under their prefixed keys.
 */
export interface FeatureInput {
  /** The type */
  type: FeatureType;
  /** The GeoJSON geometry */
  geometry: Geometry;
  /** The ID; one is generated when it is left out */
  id?: string;
  /** The layer to put it in; the active layer when it is left out */
  layerId?: string;
  /** The group to put it in */
  groupId?: string;
  /** The GeoJSON properties */
  properties?: DrawProperties;
  /** The look */
  style?: FeatureStyle;
  /** Whether it is visible */
  visible?: boolean;
  /** Whether it is locked */
  locked?: boolean;
}

/**
 * What `features.update` takes: only the keys given change.
 *
 * `properties` and `style` are merged key by key, and a key given as `undefined` is removed.
 * The ID and the layer cannot change here; `features.move` moves a feature.
 *
 * A patch has no `type`: the type of a feature cannot change. To turn a feature into another
 * type, or to undo such a change, delete it and create it again.
 */
export interface FeaturePatch {
  /** The new GeoJSON geometry */
  geometry?: Geometry;
  /** The keys of `properties` to set, or to remove with `undefined` */
  properties?: Partial<DrawProperties>;
  /** The keys of `style` to set, or to remove with `undefined` */
  style?: FeatureStyle;
  /** Whether it is visible */
  visible?: boolean;
  /** Whether it is locked */
  locked?: boolean;
}

/** What `features.list` and `features.count` keep: every key given must match. */
export interface FeatureFilter {
  /** Only the features in this layer */
  layerId?: string;
  /** Only the features in this group */
  groupId?: string;
  /** Only the features of this type */
  type?: FeatureType;
  /**
   * Only the features whose own `visible` is true (true) or false (false). A feature can be
   * visible itself and still not be drawn, when its group or its layer is hidden: `shown`
   * answers for that.
   */
  visible?: boolean;
  /**
   * Only the features that are shown (true): their own `visible`, the one of their group and
   * the one of their layer are all true; or only the ones that are not (false). What this
   * client hides with `draw.hidden` is not consulted.
   */
  shown?: boolean;
  /** Only the locked (true) or unlocked (false) features */
  locked?: boolean;
  /**
   * Only the features whose extent meets this extent, as `[west, south, east, north]` in
   * degrees
   */
  bbox?: BBox;
}

/** What `layers.create` takes. */
export interface LayerInput {
  /** The ID; one is generated when it is left out */
  id?: string;
  /** The name; one is generated when it is left out */
  name?: string;
  /** Whether it is visible */
  visible?: boolean;
  /** Whether it is locked */
  locked?: boolean;
  /** The opacity of the whole layer, from 0 to 1 */
  opacity?: number;
  /** The rule that colors its features */
  styleRule?: StyleRule;
  /** Values of the user */
  metadata?: Record<string, unknown>;
  /** The position in the stacking order, 0 at the back; the front when it is left out */
  index?: number;
}

/** What `layers.update` takes: only the keys given change. */
export interface LayerPatch {
  /** The name */
  name?: string;
  /** Whether it is visible */
  visible?: boolean;
  /** Whether it is locked */
  locked?: boolean;
  /** The opacity of the whole layer, from 0 to 1 */
  opacity?: number;
  /** The rule that colors its features; `undefined` removes it */
  styleRule?: StyleRule;
  /** Values of the user */
  metadata?: Record<string, unknown>;
}

/** What `layers.list` and `layers.count` keep: every key given must match. */
export interface LayerFilter {
  /** Only the visible (true) or hidden (false) layers */
  visible?: boolean;
  /** Only the locked (true) or unlocked (false) layers */
  locked?: boolean;
}

/** What `groups.create` takes. The features must be in the same layer. */
export interface GroupInput {
  /** The IDs of the features to put in the group */
  featureIds: readonly string[];
  /** The ID; one is generated when it is left out */
  id?: string;
  /** The name; one is generated when it is left out */
  name?: string;
  /** Whether it is visible */
  visible?: boolean;
  /** Whether it is locked */
  locked?: boolean;
}

/** What `groups.update` takes: only the keys given change. */
export interface GroupPatch {
  /** The name */
  name?: string;
  /** Whether it is visible */
  visible?: boolean;
  /** Whether it is locked */
  locked?: boolean;
}

/** What `groups.list` and `groups.count` keep: every key given must match. */
export interface GroupFilter {
  /** Only the groups in this layer */
  layerId?: string;
  /** Only the visible (true) or hidden (false) groups */
  visible?: boolean;
  /** Only the locked (true) or unlocked (false) groups */
  locked?: boolean;
}

/**
 * Where a move goes: a layer, or into a group.
 *
 * `{ groupId: null }` takes a feature out of its group: it stays in its layer, just in front
 * of the group. `index` is the position within the destination, 0 at the back; the front
 * when it is left out.
 */
export type MoveTarget =
  | { layerId: string; index?: number }
  | { groupId: string | null; index?: number };

// ============================================================================
// Loading
// ============================================================================

/** What `document.load` reads: a file, a JSON string, a document of the library, or GeoJSON. */
export type LoadSource =
  | File
  | Blob
  | string
  | DrawDocument
  | GeoJSONFeatureCollection
  | GeoJSONFeature
  | Geometry;

/** The options of `document.load`. */
export interface LoadOptions {
  /**
   * Whether the document is replaced or the features are added; `replace` for a document of
   * the library and `merge` for GeoJSON when it is left out
   */
  mode?: 'replace' | 'merge';
  /**
   * The layer to add the features to. It wins over the layer a GeoJSON feature names with
   * `maplibre-gl-draw:layerId`; when it is left out, that layer is used, or else the active one.
   * In `document.loadMany` it may also be a layer an earlier item creates with `layer`.
   */
  layerId?: string;
  /**
   * A layer to create for the features, written in the same transaction as them; every
   * feature goes into it, as with `layerId`, and `LoadResult.layerId` gives its ID. It cannot
   * be given together with `layerId` (`invalid-input`), nor with a document of the library,
   * which brings its own layers.
   */
  layer?: LayerInput;
  /**
   * A group to create for the features, written in the same transaction as them: every
   * feature read goes into it, and it stands where they land in their layer. The features all
   * go into one layer (the one of `layer` or `layerId`, else the active one), and a group a
   * GeoJSON feature names is not kept. `LoadResult.groupId` gives its ID; no group is created
   * when nothing is read. It cannot be given with a document of the library.
   */
  group?: Omit<GroupInput, 'featureIds'>;
  /** Where to place an image */
  coordinate?: Position;
  /** The zoom an image is placed at */
  zoom?: number;
  /** Whether the Multi geometries of GeoJSON are split into one feature per part */
  flattenMulti?: boolean;
}

/** A GeoJSON feature that `document.load` left out, and why. */
export interface SkippedFeature {
  /** The index of the feature in the input */
  index: number;
  /** Why it was left out, in English, for logs */
  reason: string;
}

/** What `document.load` read. */
export interface LoadResult {
  /** The format that was detected */
  format: 'native' | 'geojson' | 'image';
  /** The IDs of the features that were read */
  featureIds: string[];
  /** Whether the document was replaced */
  replaced: boolean;
  /** The GeoJSON features that were left out */
  skipped?: SkippedFeature[];
  /** The ID of the layer created from `LoadOptions.layer` */
  layerId?: string;
  /** The ID of the group created from `LoadOptions.group`, when something was read */
  groupId?: string;
}

// ============================================================================
// Style rule functions
// ============================================================================

/**
 * The color a style rule gives to a feature with these properties.
 *
 * @param rule - The rule
 * @param properties - The properties of the feature
 * @returns The color, as `#rrggbb`
 */
export function evaluateStyleRule(
  rule: StyleRule,
  properties: Record<string, unknown> | undefined,
): string {
  return evaluateRule(rule, properties);
}

/**
 * The legend rows of a style rule, in the order to show them.
 *
 * @param rule - The rule
 * @param messages - The words of the labels, to show them in another language
 * @returns The legend rows, their colors as `#rrggbb`
 */
export function deriveLegend(rule: StyleRule, messages?: Partial<Messages>): LegendEntry[] {
  return deriveRuleLegend(rule, messages);
}

/**
 * The part of the look a style rule colors for a type: the point, the stroke or the fill.
 *
 * @param type - The type of the feature
 * @returns `point` for points, `stroke` for lines and `fill` for areas
 */
export function getStyleRuleChannel(type: FeatureType): 'point' | 'stroke' | 'fill' {
  return getRuleChannel(type);
}

// ============================================================================
// GeoJSON functions
// ============================================================================

/** Options of {@link featuresToGeoJSON} and {@link featureToGeoJSON}. */
export interface ToGeoJSONOptions {
  /**
   * Reads an embedded file by its ID, for the pixels of an Image: `(id) => store.getFile(id)`,
   * for example. An Image whose file it does not find, or every Image when it is left out, is
   * written without `maplibre-gl-draw:imageData` and `maplibre-gl-draw:imageMimeType`.
   */
  getFile?: (id: string) => FileData | undefined;
}

/**
 * Writes features as a GeoJSON FeatureCollection, as `document.toGeoJSON` writes the
 * document, without a drawing: the features need not be in one.
 *
 * The features come out in the order given (`document.toGeoJSON` gives the draw order, with
 * the hidden features at the end). The rules of the output are those of `document.toGeoJSON`:
 * positions rounded to 7 decimal places, rings by the right-hand rule, longitudes brought into
 * -180 to 180, the values of the feature added to `properties` under the prefixed keys, and a
 * `bbox` unless nothing was written. A feature whose geometry is a GeometryCollection is left
 * out. The features given are not changed.
 *
 * @param features - The features, in the order to write them
 * @param options - Where the files of the images are read from
 * @returns The FeatureCollection
 */
export function featuresToGeoJSON(
  features: readonly Feature[],
  options?: ToGeoJSONOptions,
): GeoJSONFeatureCollection {
  return convertFeaturesToGeoJSON(features, options?.getFile);
}

/**
 * Writes one feature as a GeoJSON Feature, as {@link featuresToGeoJSON} writes each of its
 * features.
 *
 * @param feature - The feature
 * @param options - Where the file of an image is read from
 * @returns The Feature, or `null` when its geometry is a GeometryCollection
 */
export function featureToGeoJSON(
  feature: Feature,
  options?: ToGeoJSONOptions,
): GeoJSONFeature | null {
  return convertFeatureToGeoJSON(feature, options?.getFile);
}

// ============================================================================
// Parsing
// ============================================================================

/** Options of {@link parseGeoJSON} and {@link parseNative}. */
export interface ParseOptions {
  /**
   * Makes the ID of every feature, group, layer and file of the result; the IDs are ULIDs when
   * it is left out. Give the generator given to `createDraw` as `generateId`, so that every ID
   * of the document comes from one place.
   */
  generateId?: () => string;
  /**
   * The layer every feature goes into. Leave it out when the caller creates the layer and sets
   * it: the features of GeoJSON then have an empty `layerId`, and those of a document of the
   * library the ID of their layer in `layers`.
   */
  layerId?: string;
  /** Whether the Multi geometries of GeoJSON are split into one feature per part */
  flattenMulti?: boolean;
}

/**
 * What {@link parseGeoJSON} and {@link parseNative} read, ready to be written into a document.
 *
 * Every feature, group, layer and file has a new ID, and the references between them (the
 * group of a feature, the members of a group, the file of an image) name the new IDs. Nothing
 * is named automatically: a feature without a name has none.
 */
export interface ParsedDocument {
  /** The features, complete, with new IDs, in the order of the input */
  features: Feature[];
  /** The groups, their members given by the new IDs of the features */
  groups: GroupInput[];
  /** The files of the embedded images, normalized, with new IDs */
  files: FileData[];
  /**
   * The layers of a document of the library with new IDs, from the back of the stacking order;
   * empty for GeoJSON, and when `layerId` is given
   */
  layers: LayerInput[];
  /**
   * The features of the input that were left out: `index` is the position of the feature in
   * the input, `reason` the code a load would throw for it, and `detail` the reason in English,
   * for logs
   */
  skipped: Array<{ index: number; reason: DrawErrorCode; detail?: string }>;
}

/**
 * Reads GeoJSON into features, groups and files without a drawing, the counterpart of
 * {@link featuresToGeoJSON}: nothing is written, and no document is needed.
 *
 * The features are read as `document.load` reads them: the values of the library come back from
 * the prefixed keys, a Multi geometry stays one feature unless `flattenMulti` is given, and a
 * GeometryCollection is folded by type. Unlike a load, the IDs of the input are never kept:
 * every feature and file gets one from `generateId`, and the features that name the same group
 * with `maplibre-gl-draw:groupId` form a new group. A feature that cannot be read is left out
 * and reported in `skipped`, with `invalid-input`; so is a feature whose embedded image is not
 * a PNG / JPEG / WebP / GIF data URL of its declared type or cannot be decoded, and one whose
 * image the browser cannot encode when it scales it down, with `unsupported-format`.
 *
 * @param input - A FeatureCollection, a Feature or a geometry
 * @param options - The generator of the IDs, the layer and the reading of Multi geometries
 * @returns What was read
 * @throws `DrawError` with the code `unsupported-format` when the input is not GeoJSON, or
 *   `invalid-input` when an option has the wrong type
 */
export function parseGeoJSON(
  input: GeoJSONFeatureCollection | GeoJSONFeature | Geometry,
  options?: ParseOptions,
): Promise<ParsedDocument> {
  return parseGeoJSONInput(input, options);
}

/**
 * Reads a document of the library into features, groups, files and layers without a drawing,
 * with new IDs: nothing is written, and no document is needed.
 *
 * The document is checked as `document.load` checks it. Every layer, group, feature and file
 * gets a new ID from `generateId`, and the references between them are rewritten; the
 * metadata of the document is not read. A feature whose image file cannot be imported is left
 * out and reported in `skipped`, with `invalid-input` or `unsupported-format` as for
 * {@link parseGeoJSON}, and a group whose features are all left out is left out too.
 *
 * @param input - A document of the library, as `document.toJSON` writes it
 * @param options - The generator of the IDs and the layer
 * @returns What was read
 * @throws `DrawError` with the code `unsupported-format` when the input is not a document of
 *   the library, or `invalid-input` when it is malformed, has another major version, or an
 *   option has the wrong type
 */
export function parseNative(input: DrawDocument, options?: ParseOptions): Promise<ParsedDocument> {
  return parseNativeInput(input, options);
}
