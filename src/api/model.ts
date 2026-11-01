// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The document model: features, layers, groups, metadata, their inputs, patches and filters
 *
 * Geometries and attributes are GeoJSON as they are. The values the library keeps on a
 * feature are keys of `properties` that start with {@link DRAW_PROPERTY_PREFIX}; every other
 * key is an attribute of the user.
 */

import type { BigInteger, Bytes, CalendarDate, DateTime, Reference, Value } from '@sakuzu/tabane';
import type {
  Feature as GeoJSONFeature,
  FeatureCollection as GeoJSONFeatureCollection,
  Geometry,
  Position,
} from 'geojson';
import type { BBox } from '../geometry/types.js';
import type { Messages } from '../messages.js';
import { parseColor } from '../shared/color.js';
import { isDrawProperty as isLibraryKey } from '../shared/properties.js';
import type { ItemMove, ItemPlacement } from '../shared/types/model.js';
import type { LineStyle } from '../shared/types/style.js';
import { longestRisingRun, diffItemOrder as movesBetween } from '../shared/utils/item-moves.js';
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
import type { VertexTarget } from './state.js';

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
 * Colors are CSS colors, read as {@link parseCssColor} reads them. Widths and radii are in CSS
 * pixels at the reference zoom of the feature.
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
  /**
   * The radius of a point marker, in pixels: half its diameter (`PointRenderer.draw` takes the
   * diameter, `size`)
   */
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
 *
 * Every key the library defines is there. A style key an extension or a host adds to
 * {@link FeatureStyle} by declaration merging stays optional: it is there only when the look the
 * type of the feature declares or the style of the feature has it.
 */
export type FeatureStyleResolved = FeatureStyle &
  Required<
    Pick<
      FeatureStyle,
      | 'fillColor'
      | 'fillOpacity'
      | 'strokeColor'
      | 'strokeWidth'
      | 'strokeOpacity'
      | 'lineStyle'
      | 'pointColor'
      | 'pointRadius'
      | 'pointShape'
      | 'pointOpacity'
      | 'pointStrokeColor'
      | 'pointStrokeWidth'
      | 'imageOpacity'
    >
  >;

export { DRAW_PROPERTY_PREFIX } from '../shared/properties.js';

/**
 * The `properties` of a feature: the GeoJSON properties themselves, with the keys of the
 * library typed.
 *
 * A key that starts with {@link DRAW_PROPERTY_PREFIX} holds a value of the library; any other
 * key is an attribute of the user. Export and load keep the keys as they are.
 *
 * Every value is a {@link Value}: null, a boolean, a number, a string, an array or an object of
 * values, or one of the classes of the kinds JSON has not (a date is a {@link CalendarDate}, a
 * date-time a {@link DateTime}, the id of another feature a {@link Reference}, ...). What is
 * given is held in one form: a bigint becomes a number or a {@link BigInteger}, a `Uint8Array`
 * {@link Bytes}, and a key whose value is `undefined` is left out. Anything else (a `Date`, a
 * `Map`, an instance of another class, a function, a string with a lone surrogate) is refused
 * with `invalid-input`.
 */
export type DrawProperties = { [key: string]: Value } & {
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
 * A unit of the stacking order that holds features and groups as objects.
 */
export interface ObjectLayer {
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
  /** Not set: a layer of objects */
  kind?: undefined;
  /**
   * The IDs of the features and groups in the layer, from the back. `features.move` and
   * `groups.move` change it
   */
  items: readonly string[];
}

/**
 * A layer a Store holds as rows of columns (the tables of the Store): its items are read from
 * its rows (`LayerTableView.listItems`), not listed in it.
 */
export interface TableLayer {
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
  /** A layer held as rows */
  kind: 'table';
}

/**
 * A unit of the stacking order that holds features and groups: a layer of objects, which lists
 * its items, or a layer held as rows (a Store holds every layer one way or the other).
 */
export type Layer = ObjectLayer | TableLayer;

/**
 * A set of features in one layer of objects.
 */
export interface ObjectGroup {
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
  /** Not set: a group of a layer of objects */
  kind?: undefined;
  /** The IDs of its features, from the back */
  featureIds: readonly string[];
}

/**
 * A set of features in one layer held as rows: its features are read from the rows
 * (`LayerTableView.listGroupMembers`), not listed in it.
 */
export interface TableGroup {
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
  /** A group of a layer held as rows */
  kind: 'table';
}

/**
 * A set of features in one layer.
 */
export type Group = ObjectGroup | TableGroup;

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
  /** The layers, each with the items it lists (a layer held as rows is not written here) */
  layers?: ObjectLayer[];
  /** The IDs of the layers in stacking order, from the back */
  layerOrder: string[];
  /** The groups, each with the features it lists */
  groups?: ObjectGroup[];
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

/**
 * An edit of a feature, as a Store applies it (`Store.applyEdits`).
 *
 * - `set` changes the fields of `patch` as `features.update` does: the keys of `properties`
 *   and `style` one by one (a key given as `undefined` is removed), the geometry whole.
 * - `vertex-move` puts each vertex of `vertices` at the position of the same index in
 *   `positions` (the two have the same length).
 * - `vertex-insert` adds a vertex at `position`, just after the vertex `after` or just before
 *   the vertex `before` (exactly one of the two is given), in its line or ring. A point and the
 *   points of a MultiPoint take no vertex.
 * - `vertex-delete` deletes the vertices, and keeps the lines and the rings of the geometry with
 *   enough positions; a point of a MultiPoint goes with its vertex.
 *
 * - `translate` moves the features of `target` from the point `from` to the point `to`, in the
 *   east, north and up axes of the earth at each of the two points.
 * - `rotate` turns the features of `target` about `center` by `angleDegrees`, counterclockwise
 *   seen from above, and adds the angle to the rotation of the features that have one.
 * - `scale` stretches the features of `target` about `center` by `eastFactor` along the east and
 *   by `northFactor` along the north, and multiplies the size of the features that have one (a
 *   scale, the radius of a circle) by `sizeFactor`; such a feature moves by `sizeFactor` along
 *   both, so that it keeps its shape.
 *
 * The last position of a closed ring is its first vertex: moving or deleting either moves or
 * deletes both, and a vertex inserted after the last or before the first goes between the last
 * vertex and the first.
 *
 * The points of `translate`, `rotate` and `scale` are `[longitude, latitude]` in degrees (a
 * number after the first two is not read). The values they take (the latitudes, the angle and
 * the factors) are the ones the Store takes (`Store.transforms`, or the ranges of the computation
 * of the library for a Store without it: a latitude within [-90, 90], an angle within
 * (-180, 180], factors within [1/1,000,000, 1,000,000]). They change the
 * longitudes and the latitudes of the positions, and keep the numbers after them as they are.
 */
export type FeatureEdit =
  | {
      kind: 'set';
      /** The feature */
      featureId: string;
      /** The fields to change */
      patch: FeaturePatch;
    }
  | {
      kind: 'vertex-move';
      /** The feature */
      featureId: string;
      /** The vertices to move */
      vertices: readonly VertexTarget[];
      /** Where each of them goes, in the same order, `[longitude, latitude]` in degrees */
      positions: readonly Position[];
    }
  | {
      kind: 'vertex-insert';
      /** The feature */
      featureId: string;
      /** The vertex the new one follows */
      after?: VertexTarget;
      /** The vertex the new one goes before */
      before?: VertexTarget;
      /** The position of the new vertex, `[longitude, latitude]` in degrees */
      position: Position;
    }
  | {
      kind: 'vertex-delete';
      /** The feature */
      featureId: string;
      /** The vertices to delete */
      vertices: readonly VertexTarget[];
    }
  | {
      kind: 'translate';
      /** The features */
      target: EditTarget;
      /** The point the features move from, `[longitude, latitude]` in degrees */
      from: Position;
      /** The point they move to, `[longitude, latitude]` in degrees */
      to: Position;
    }
  | {
      kind: 'rotate';
      /** The features */
      target: EditTarget;
      /** The point they turn about, `[longitude, latitude]` in degrees */
      center: Position;
      /** The angle, counterclockwise seen from above */
      angleDegrees: number;
    }
  | {
      kind: 'scale';
      /** The features */
      target: EditTarget;
      /** The point they stretch from, `[longitude, latitude]` in degrees */
      center: Position;
      /** The factor along the east */
      eastFactor: number;
      /** The factor along the north */
      northFactor: number;
      /** The factor of the size of the features that have one, and of how far they move */
      sizeFactor: number;
    };

/**
 * The features an edit of {@link FeatureEdit} moves, rotates or scales: these features, or the
 * features selected in this client when it is applied (the features of the groups and the layers
 * selected).
 *
 * The instance gives a Store the IDs: `{ selection: true }` is what an application asks of the
 * instance, and a Store that is given it throws.
 */
export type EditTarget =
  | {
      /** The IDs of the features, each once */
      featureIds: readonly string[];
    }
  | {
      /** The features selected */
      selection: true;
    };

/** What a Store did with edits of features (`Store.applyEdits`). */
export interface EditResult {
  /**
   * The number of edits left out because the feature they name was not there (deleted, or never
   * created)
   */
  readonly dropped: number;
}

/**
 * What `selection.update` makes a patch from: the type of the features, their own style and the
 * zoom they were created at. Features that share these get the same patch, so a selection of many
 * features asks for one patch per kind of feature rather than one per feature.
 */
export interface FeatureStyleSample {
  /** The type of the features */
  readonly type: FeatureType;
  /** Their own style (`Feature.style`) */
  readonly style: Readonly<FeatureStyle>;
  /** The zoom they were created at (`properties` of the library), when they have one */
  readonly createdZoom: number | undefined;
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

/**
 * How many features `features.list` makes at most. A Store that holds its features as rows
 * needs it: it holds more features than can be made at once, so it makes only the ones within
 * the limit.
 */
export interface FeatureListOptions {
  /** The number of features made at most (a non-negative integer) */
  limit: number;
  /**
   * The ID of the feature read last: the features are read from the one after it in stacking
   * order (from the first when omitted), so that pages are read one after the other
   */
  after?: string;
}

/**
 * Which items `layers.listItems` and `groups.listMembers` read: a range of them by position, from
 * the back.
 *
 * A panel shows the part of a long list it is scrolled to, so it reads the items by position. A
 * reading of every feature a page at a time reads on after the feature read last instead
 * (`FeatureListOptions.after`), which stays right while features are added or deleted before it.
 */
export interface ItemListOptions {
  /** The position of the first item read, 0 at the back (a non-negative integer); 0 when omitted */
  offset?: number;
  /** The number of items read at most (a non-negative integer); every one after `offset` when omitted */
  limit?: number;
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
  /** The IDs of the features to put in the group: at least one */
  featureIds: readonly string[];
  /** The layer of the group: it must be the layer of its features (theirs when it is left out) */
  layerId?: string;
  /**
   * The ID; one is generated when it is left out. A group deleted whose features are kept
   * (`DocumentChange.restoreToken`) is brought back with `groups.restore`
   */
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
 * when it is left out. A place can be given by the items it goes between instead
 * ({@link ItemPlacement}: `{ layerId, groupId?, below?, above? }`), which is how a layer held as
 * rows is moved into: a position by `index` there is refused (`invalid-state`).
 */
export type MoveTarget =
  | { layerId: string; index?: number }
  | { groupId: string | null; index?: number }
  | ItemPlacement;

export type {
  FeatureValues,
  ItemHandles,
  ItemMove,
  ItemOrderChange,
  ItemPlacement,
  ItemPosition,
  RestoreToken,
  RowsMove,
  RowValues,
} from '../shared/types/model.js';

/**
 * The items of a layer (its features outside a group, and its groups) or the members of a group,
 * from the back, before and after a change: what {@link diffItemOrder} reads.
 */
export interface ItemListChange {
  /** The layer (the layer of the group, for a group) */
  readonly layerId: string;
  /** The group (undefined for a layer) */
  readonly groupId: string | undefined;
  /** The items before, from the back (none when the list did not exist) */
  readonly before: readonly string[];
  /** The items after, from the back (none when the list does not exist any more) */
  readonly after: readonly string[];
}

/**
 * The moves of the items that take lists of items from their state before to their state after,
 * one item at a time: what a Store that keeps its lists of items notifies as `order`
 * (`StoreChange.order`) when it changes them otherwise than by putting items in a place.
 *
 * Each move has where the item stood and where it stands at that moment, by the items just below
 * and above it ({@link ItemMove}). Made back from the last one, each item put back where it was,
 * the moves take the lists back to their state before.
 *
 * The moves come in this order: the items placed in the layers (moved, or created), then the
 * features placed in the groups, then the features deleted, then the groups deleted, so that a
 * group is in its place before its members go into it, and its members leave it before it is
 * deleted. The items of a list that keep their order among the others (the longest run of them)
 * do not move. An item in a list after and in none before is created (`from` is null); an item
 * in a list before and in none after is deleted (`to` is null). An item listed twice keeps its
 * first place: in the lists before in their order, in the lists after the layers first.
 *
 * @param lists - The lists that changed (the lists of a layer and of its groups that did not
 *   change can be left out, as long as an item does not leave them or come into them)
 * @param isGroup - Whether an item is a group (a group is deleted after the features)
 * @returns The moves, in the order they are made
 *
 * @example The moves of a layer whose items were reordered
 * ```ts
 * const moves = diffItemOrder(
 *   [{ layerId: 'l1', groupId: undefined, before: ['a', 'b', 'c'], after: ['c', 'a', 'b'] }],
 *   (id) => draw.groups.has(id),
 * );
 * // [{ kind: 'item', itemId: 'c', from: { layerId: 'l1', groupId: undefined, below: 'b',
 * //   above: null }, to: { layerId: 'l1', groupId: undefined, below: null, above: 'a' } }]
 * ```
 */
export function diffItemOrder(
  lists: readonly ItemListChange[],
  isGroup: (id: string) => boolean,
): ItemMove[] {
  // An item listed twice keeps its first place: in the lists before in their order, in the lists
  // after the layers first
  const seenBefore = new Set<string>();
  const before = lists.map((list) =>
    list.before.filter((id) => {
      if (seenBefore.has(id)) return false;
      seenBefore.add(id);
      return true;
    }),
  );
  const layersFirst = [
    ...lists.flatMap((list, k) => (list.groupId === undefined ? [k] : [])),
    ...lists.flatMap((list, k) => (list.groupId !== undefined ? [k] : [])),
  ];
  // The items that stay in each list: the longest run of the ones listed after whose first
  // places in the list before go up; every other item placed moves
  const placed = new Set<string>();
  const moved = new Set<string>();
  const after: string[][] = lists.map(() => []);
  for (const k of layersFirst) {
    const list = lists[k];
    const placeBefore = new Map<string, number>();
    list.before.forEach((id, i) => {
      if (!placeBefore.has(id)) placeBefore.set(id, i);
    });
    const places: number[] = [];
    const indices: number[] = [];
    list.after.forEach((id, i) => {
      const at = placeBefore.get(id);
      if (at === undefined) return;
      places.push(at);
      indices.push(i);
    });
    const stays = new Set(longestRisingRun(places).map((at) => indices[at]));
    list.after.forEach((id, i) => {
      if (placed.has(id)) return;
      placed.add(id);
      after[k].push(id);
      if (!stays.has(i)) moved.add(id);
    });
  }
  const deleted = before.flatMap((ids) => ids.filter((id) => !placed.has(id)));
  const containers = lists.map((list, k) => {
    const index = new Map(before[k].map((id, i) => [id, i]));
    return {
      layerId: list.layerId,
      groupId: list.groupId,
      before: before[k],
      after: after[k],
      beforeIndex: (id: string) => index.get(id) ?? -1,
    };
  });
  return movesBetween(containers, { moved, deleted, isGroup, idOf: (id) => id });
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
 * The part of the look a style rule colors for a built-in type: the point, the stroke or the fill.
 *
 * It answers by the name of the type. A custom type has the channel it declares
 * (`FeatureTypeDefinition.styleRuleChannel`), or else the one of the geometry of the feature, as a
 * built-in type of that geometry has it; this function answers `fill` for a name it does not know.
 *
 * @param type - The type of the feature
 * @returns `point` for points, `stroke` for lines and `fill` for areas and images
 */
export function getStyleRuleChannel(type: FeatureType): 'point' | 'stroke' | 'fill' {
  return getRuleChannel(type);
}

// ============================================================================
// Color functions
// ============================================================================

/**
 * Reads a CSS color as the library reads every color it takes: the colors of
 * {@link FeatureStyle}, of the options and of the look a type declares are checked and drawn
 * with it.
 *
 * It reads `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`, `hsl()` and `hsla()`
 * (with commas, or with spaces and a `/` before the alpha), the named colors of CSS and
 * `transparent`. An extension reads the colors it draws with its own shader here, and checks a
 * color in a style key of its own here, so that it takes and draws the colors the library takes
 * and draws, no more and no fewer.
 *
 * @param value - The color
 * @returns The color as `[red, green, blue, alpha]`, each from 0 to 1 and not premultiplied, in a
 *   new array; `null` when the value is not a color the library reads
 *
 * @example
 * ```ts
 * parseCssColor('#ff000080'); // [1, 0, 0, 0.5019607843137255]
 * parseCssColor('rebeccapurple'); // [0.4, 0.2, 0.6, 1]
 * parseCssColor('not a color'); // null
 * ```
 */
export function parseCssColor(
  value: unknown,
): [red: number, green: number, blue: number, alpha: number] | null {
  return typeof value === 'string' ? parseColor(value) : null;
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
 * A {@link Reference} in `properties` to a feature, a group or a layer of the input names its
 * new ID. An ID kept as a string, which the library cannot tell from other text, is left as it
 * is: rewrite it with `idMap`.
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
 * with `maplibre-gl-draw:groupId` form a new group. A {@link Reference} in `properties` names the
 * new ID; `idMap` gives the new ID of each ID of the input, for an ID kept as a string in
 * `properties`, which is left as it is. A feature that cannot be read is left out
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
 * metadata of the document is not read. A {@link Reference} in `properties` names the new ID;
 * `idMap` gives the new ID of each ID of the input, for an ID kept as a string, which is left as
 * it is. The values of `properties` are read from their JSON form (`valueFromJSON`). A feature
 * whose image file cannot be imported is left
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
