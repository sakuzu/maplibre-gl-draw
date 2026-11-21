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
import { makeIdSet } from './impl/id-set.js';
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
 *
 * A key this type does not define is kept as it is, whatever value JSON holds: it is stored,
 * exported and loaded back like the keys above, and the library does not read it. An extension
 * or an application gives features style keys of its own this way: it declares them with
 * declaration merging, and checks their values where it reads them.
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
 * A unit of the stacking order that holds features and groups. The IDs of what it holds are read
 * with `layers.countItems` and `layers.listItemIds`.
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
  /** The rule that colors its features from their attributes */
  styleRule: StyleRule | undefined;
  /** Values of the user */
  metadata: Record<string, unknown> | undefined;
}

/**
 * A set of features in one layer. The IDs of its features are read with `groups.countFeatures`
 * and `groups.listFeatureIds`.
 */
export interface Group {
  /** The ID */
  id: string;
  /** The ID of the layer it is in */
  layerId: string;
  /** The name */
  name: string;
  /** Whether it is visible */
  visible: boolean;
  /** Whether it is locked */
  locked: boolean;
}

// ============================================================================
// The document
// ============================================================================

/**
 * The metadata of the document: its title, its description, and the keys of applications and
 * extensions.
 *
 * A key without a prefix belongs to the library, as `title` and `description` do. A key without
 * a prefix that the library does not know (one read from a file) is not refused: it is kept as it
 * is. An application or an extension puts values of its own under keys that start with a prefix
 * of its own,
 * `<prefix>:<name>` (as the keys of `properties` do, see {@link DRAW_PROPERTY_PREFIX}), so that
 * they never meet the keys of the library or of another extension; it can declare them by
 * declaration merging. Such a key holds a value that JSON holds (a string, a finite number, a
 * boolean, `null`, or arrays and plain objects of them), and the document keeps it as it is:
 * `document.toJSON` writes it, `document.load` reads it back, and the Store holds it. Each key
 * is written on its own (`metadata.update`), and a change tells the keys it wrote
 * (`DocumentChange.metadata.keys`).
 */
export interface Metadata {
  /** The title */
  title?: string;
  /** The description */
  description?: string;
  /** The keys of applications and extensions, each under its prefix */
  [key: `${string}:${string}`]: unknown;
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
  /** The layers, each with the IDs of its items */
  layers?: DocumentLayer[];
  /** The IDs of the layers in stacking order, from the back */
  layerOrder: string[];
  /** The groups, each with the IDs of its features */
  groups?: DocumentGroup[];
  /** The features */
  features: Feature[];
  /** The embedded files, by ID */
  files?: Record<string, FileData>;
}

/**
 * A layer as the format of the library writes it: the layer and the IDs of what it holds.
 */
export interface DocumentLayer extends Layer {
  /** The IDs of the features and groups in the layer, from the back */
  items: readonly string[];
}

/**
 * A group as the format of the library writes it: the group and the IDs of its features.
 */
export interface DocumentGroup extends Group {
  /** The IDs of its features, from the back */
  featureIds: readonly string[];
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
 * type, or to change it back, delete it and create it again.
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
 * of the group. `index` is the position within the target, 0 at the back; the front
 * when it is left out.
 */
export type MoveTarget =
  | { layerId: string; index?: number }
  | { groupId: string | null; index?: number };

/**
 * A range of positions, 0 at the back, as `Array.prototype.slice` takes one: from `start`, up to
 * `end` and without it. `{ start: 0, end: 100 }` is the first 100 positions.
 */
export interface IndexRange {
  /** The first position of the range */
  start: number;
  /** The position after the last one of the range: not in the range, as with `slice` */
  end: number;
}

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
   * be given together with `layerId` (`invalidInput`), nor with a document of the library,
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
 *
 * A reference the library does not know, such as the ID of another feature that an application
 * or an extension keeps in `properties`, is left as it is: rewrite it with `idMap`.
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
  /**
   * The new ID of each thing that had an ID in the input, by the ID of the input, one map per
   * kind (an ID of the input may name a feature and a file at once). A feature, group, file or
   * layer the input gave no ID, or that was left out, is not listed. When several features
   * come from one feature of the input (the parts of a GeometryCollection, or of a Multi
   * geometry with `flattenMulti`), its ID gives the first of them; when the input gives one ID
   * to several features, it gives the first.
   *
   * ```ts
   * const target = parsed.idMap.features[oldId]; // undefined when it was not read
   * ```
   */
  idMap: {
    /** The new IDs of the features */
    features: Record<string, string>;
    /** The new IDs of the groups (the `maplibre-gl-draw:groupId` of GeoJSON) */
    groups: Record<string, string>;
    /** The new IDs of the files of the images */
    files: Record<string, string>;
    /** The new IDs of the layers of a document of the library listed in `layers` */
    layers: Record<string, string>;
  };
}

/**
 * Reads GeoJSON into features, groups and files without a drawing, the counterpart of
 * {@link featuresToGeoJSON}: nothing is written, and no document is needed.
 *
 * The features are read as `document.load` reads them: the values of the library come back from
 * the prefixed keys, a Multi geometry stays one feature unless `flattenMulti` is given, and a
 * GeometryCollection is folded by type. Unlike a load, the IDs of the input are never kept:
 * every feature and file gets one from `generateId`, and the features that name the same group
 * with `maplibre-gl-draw:groupId` form a new group. `idMap` gives the new ID of each ID of the
 * input, for the references the library does not know, such as an ID of another feature in
 * `properties`, which are left as they are. A feature that cannot be read is left out
 * and reported in `skipped`, with `invalidInput`; so is a feature whose embedded image is not
 * a PNG / JPEG / WebP / GIF data URL of its declared type or cannot be decoded, and one whose
 * image the browser cannot encode when it scales it down, with `unsupportedFormat`.
 *
 * @param input - A FeatureCollection, a Feature or a geometry
 * @param options - The generator of the IDs, the layer and the reading of Multi geometries
 * @returns What was read
 * @throws `DrawError` with the code `unsupportedFormat` when the input is not GeoJSON, or
 *   `invalidInput` when an option has the wrong type
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
 * metadata of the document is not read. `idMap` gives the new ID of each ID of the input, for
 * the references the library does not know, which are left as they are. A feature whose image file cannot be imported is left
 * out and reported in `skipped`, with `invalidInput` or `unsupportedFormat` as for
 * {@link parseGeoJSON}, and a group whose features are all left out is left out too.
 *
 * @param input - A document of the library, as `document.toJSON` writes it
 * @param options - The generator of the IDs and the layer
 * @returns What was read
 * @throws `DrawError` with the code `unsupportedFormat` when the input is not a document of
 *   the library, or `invalidInput` when it is malformed, has another major version, or an
 *   option has the wrong type
 */
export function parseNative(input: DrawDocument, options?: ParseOptions): Promise<ParsedDocument> {
  return parseNativeInput(input, options);
}

// ============================================================================
// Sets of IDs and the features being edited
// ============================================================================

/**
 * A set of IDs, read without an array of every ID: the selection, the items this client hides,
 * the features of a drag, of a change and of a load. It is the set as it was when it was given,
 * and it never changes afterwards; a change makes a new set. Unlike a `Set` of JavaScript, it is
 * read only through these methods. A set that stands for the features of layers (a selection
 * made with `{ layerIds }`) counts, answers `has` and is read without the IDs being made.
 *
 * A set of features a change deleted (`ChangedIds.deleted`) is read after the change was told
 * too, as long as the document is open and not replaced as a whole: the IDs of deleted features
 * stay readable from the set.
 */
export interface IdSet {
  /** The number of IDs. */
  count(): number;
  /** Whether the set holds this ID. */
  has(id: string): boolean;
  /**
   * Reads the IDs one at a time, for a set of any size, in the order of the set.
   *
   * @returns An iterator of the IDs
   */
  iterate(): IterableIterator<string>;
  /**
   * The IDs as an array, in the order of the set.
   *
   * @throws `DrawError` with the code `tooManyItems` when the set holds more than 10,000 IDs;
   *   the array is never cut short. {@link IdSet.iterate} reads any number of them
   */
  toArray(): string[];
}

/**
 * Makes an {@link IdSet} of IDs, in the order given, each once: what an extension gives back
 * where an `IdSet` is asked for (`Plugin.interaction.filterSelection`), or gives to
 * `selection.set`.
 *
 * @param ids - The IDs
 * @returns The set
 */
export function createIdSet(ids: Iterable<string>): IdSet {
  return makeIdSet(ids);
}

declare const featureValuesBrand: unique symbol;

/**
 * What a change did to features, as the changes of a subscriber that asked for them carry it
 * (`previousValues` of {@link DocumentChange}): what `features.restore` takes back. Its content
 * is not read: it is given to `features.restore` as it is, and it costs no object per feature
 * however many it holds.
 *
 * For the geometry of a feature, it keeps what the change did to it: the vertices it moved and
 * where they were, the vertices it added, the vertices it deleted and where they were, or the
 * whole geometry before, for a change that changed the whole geometry (a move, a rotation, a
 * scaling, an edit that changed the type of the geometry, the number of its parts or the number
 * of the rings of a part). The
 * instance has the geometry before and after every change, and tells the vertices changed by
 * comparing them as {@link VertexRef} says, a geometry given whole (`features.update`) with the
 * same type, parts and rings included. The values of a move of 100,000 features are kept
 * as arrays of the geometries before, with no record per feature. For any other value (an
 * attribute, a key of the look, a flag, the place), it keeps the value before of every key the
 * change wrote.
 *
 * It keeps every change of the groups too (those it created, deleted and moved, and the values
 * it changed), and where they were, so that `features.restore` takes them back with the features
 * they hold.
 *
 * Every subscriber that asks gets values of its own. The values of a change that deleted
 * features keep them (and the groups it deleted), so that `features.restore` can bring
 * them back where they were, until every subscriber has let go of its values
 * (`features.releaseValues`). A subscriber that keeps values for long keeps that memory:
 * `byteLength` tells how much.
 */
export interface FeatureValues {
  /** The memory the values and what they keep take, in bytes (an estimate) */
  readonly byteLength: number;
  /** The number of features they hold values of */
  readonly featureCount: number;
  /** Tells them from other objects */
  readonly [featureValuesBrand]: true;
}

/**
 * The IDs of the features one change created, updated, deleted and moved, as sets that read any
 * number of them without an array of every ID. A feature is in one of `created`, `updated` and
 * `deleted` at most, and in none when the change created and deleted it; it is in `moved` too
 * when it was also put in another place. A change that replaces the whole document
 * (`DocumentChange.reset`) is the exception: a feature it takes out and writes again with its ID
 * is in `deleted` and in `created`, as the events of the features tell it.
 */
export interface ChangedIds {
  /** Created, or brought back (a feature `features.restore` brings back is created again) */
  created: IdSet;
  /** Changed in its values (its geometry, its attributes, its look, its flags) */
  updated: IdSet;
  /** Deleted */
  deleted: IdSet;
  /**
   * Put in another layer or group, or in another position in its layer or group: its place in
   * the document, not its position on the map (a feature moved on the map is in `updated`)
   */
  moved: IdSet;
}

/**
 * The features this client marks as being edited: a mark of this client that the document does
 * not hold, as the selection. An extension that edits a feature in a field of its own marks it
 * here while the field is open, so that other extensions can tell (one that draws the feature
 * leaves out what the field shows, say). A feature deleted leaves it.
 *
 * When the select mode is entered, every feature marked is told to the plugins as a feature a
 * drawing mode created (`Plugin.interaction.onDrawCommit`), and the marks are taken off: a
 * drawing mode that leaves a new feature marked hands it over so.
 *
 * A value written to a marked feature from elsewhere (a change written to the Store directly, an
 * edit of another extension) is written and told as any other change: what the open field does
 * with it is up to the extension that owns the field.
 */
export interface EditingFeaturesResource {
  /** The features marked, as they are now */
  get(): IdSet;
  /**
   * Marks features as being edited.
   *
   * @throws `DrawError` with the code `notFound` when one of the IDs is not a feature
   */
  add(ids: readonly string[]): void;
  /** Takes the mark off features; an ID that is not marked is left as it is. */
  remove(ids: readonly string[]): void;
}
