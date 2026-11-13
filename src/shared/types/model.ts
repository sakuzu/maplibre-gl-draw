// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The data model: coordinates, features, layers, groups and the state the Store holds
 *
 * Types only. They sit in shared/ so that every layer can use them (store/types.ts
 * re-exports them).
 */

import type { RowField, RowFieldValues, TableRowsChange } from '@sakuzu/kasane';
import type { Value } from '@sakuzu/tabane';
import type { Geometry, Position } from 'geojson';

/**
 * The rows of one layer a change created, updated or deleted, by handle (`LayerRowsChange`): the
 * tables declare it, a layer being a table
 */
export type { RowField, TableRowsChange as LayerRowsChange };

/**
 * Values of rows: the rows by their handles, and the values of fields, one per row. Read from
 * the rows, they are the values the rows have; written to them, they put the values there.
 */
export interface RowValues {
  /** The rows */
  readonly handles: Int32Array;
  /** The values of each field, one per row */
  readonly fields: ReadonlyMap<RowField, RowFieldValues>;
  /**
   * Non-zero for a row deleted, zero for a row not deleted (a row deleted and kept,
   * `RestoreToken`, written not deleted comes back at its place, as it was); absent when the
   * deletion is not read or written
   */
  readonly deleted?: Uint8Array;
}

/**
 * A field of a group a {@link TableGroupPatch} writes: a fixed field of every group (its `id`,
 * its `parent`, the layer it is in, and the `key` of its order among the items there), its
 * `name`, or a group column of the features (`hidden`, `locked`). The `name` of a group is kept by
 * the Store, not by the tables: the writer of the features takes it out of the values it writes to
 * the tables.
 */
export type TableGroupField = 'id' | 'name' | 'parent' | 'key' | 'hidden' | 'locked';

/**
 * Values written to groups of features held as rows: the groups by their handles (the handles
 * rows name in their pages, `GroupEntry.handle`).
 */
export interface TableGroupPatch {
  /** The groups written */
  readonly handles: Int32Array;
  /** The values of each field written, one per group */
  readonly fields: ReadonlyMap<TableGroupField, readonly unknown[]>;
  /** Non-zero for a group deleted */
  readonly deleted?: Uint8Array;
}

/**
 * The rows a change wrote, by layer: what the writer of the rows
 * (`FeatureTablesWriter.writeRows`) returns, for the implementation of the Store to put in its
 * notification (`StoreChange.rows`). It is what the tables tell, by table, a layer being a table
 */
export interface RowsChange {
  /** The rows of each layer */
  readonly layers: ReadonlyMap<string, TableRowsChange>;
}

/**
 * A position as `[longitude, latitude]` in degrees (WGS 84), in the same order as GeoJSON
 */
export type Coordinate = [number, number];

/**
 * The coordinates of a GeoJSON geometry, nested as deep as its kind needs
 *
 * - `Position`: Point (the geometry of a Point, the anchor of an Image and the center of a
 *   Circle)
 * - `Position[]`: LineString (also of a Freehand) and MultiPoint
 * - `Position[][]`: Polygon (an array of rings: ring 0 is the outer ring, the rest are holes)
 *   and MultiLineString (an array of lines)
 * - `Position[][][]`: MultiPolygon (an array of polygons, each an array of rings)
 *
 * A ring of a Polygon is closed: its last coordinate repeats its first.
 */
export type FeatureCoordinates = Position | Position[] | Position[][] | Position[][][];

/**
 * The type of a feature: one of the nine built-in types, or the name of a custom type
 *
 * The built-in types are Point, LineString, Polygon, MultiPoint, MultiLineString,
 * MultiPolygon, Image, Circle and Freehand. The type decides the kind of `Feature.geometry`:
 * a Circle and an Image hold the Point of their center and their anchor, and a Freehand holds
 * a LineString. Any other string names a custom type, which an extension adds through
 * `draw.extensions.featureTypes` (the engine reads it as a {@link FeatureTypeHandler}).
 *
 * The Multi types come from imports and from the results of geometry operations; no drawing
 * mode creates them.
 */
export type FeatureType =
  | 'Point'
  | 'LineString'
  | 'Polygon'
  | 'MultiPoint'
  | 'MultiLineString'
  | 'MultiPolygon'
  | 'Image'
  | 'Circle'
  | 'Freehand'
  | (string & {});

/**
 * The name of an interaction mode: one of the seven built-in modes, or a custom mode
 *
 * `select` selects and edits features, and each `draw_*` mode creates one feature type
 * (`draw_line` creates a LineString). Any other string names a custom mode, registered with
 * `registerMode` or {@link Plugin.modes}.
 */
export type Mode =
  | 'select'
  | 'draw_point'
  | 'draw_line'
  | 'draw_polygon'
  | 'draw_image'
  | 'draw_circle'
  | 'draw_freehand'
  | (string & {});

/**
 * What the selection holds: features, groups or layers
 *
 * The selection is exclusive: it holds items of one type at a time.
 */
export type SelectionType = 'feature' | 'group' | 'layer';

/**
 * The current selection: its type and the IDs of the selected items
 */
export interface Selection {
  /** Selection type (null means nothing is selected) */
  type: SelectionType | null;
  /** IDs of the selected items (empty for features selected in bulk) */
  ids: readonly string[];
  /**
   * Many features selected at once, held as the set of their rows (see the public
   * `SelectionValue`)
   */
  bulk?: SelectionBulk;
}

/**
 * The selection as the instance gives it: its type, the number of its features, their IDs (null
 * for features selected in bulk), layers and extent (see the public `SelectionValue`)
 */
export interface SelectionValue {
  readonly type: SelectionType;
  readonly count: number;
  readonly ids: readonly string[] | null;
  readonly layerIds: readonly string[];
  readonly bbox: [number, number, number, number] | null;
}

/** What names a selection as it was read, without listing it (see the public `SelectionTarget`) */
export interface SelectionTarget {
  readonly type: 'selection';
  readonly count: number;
}

/**
 * Many features selected at once: their number, layers and extent, which keep their rows
 * (`bulk-selection.ts`)
 */
export interface SelectionBulk {
  readonly count: number;
  readonly layerIds: readonly string[];
  readonly bbox: [number, number, number, number] | null;
}

/**
 * Vertex reference
 *
 * Points at a single vertex with the triple of part number, ring number and the
 * vertex index within the ring.
 * A Polygon can have inner rings (holes), so a vertex is always specified in this form.
 * For LineString / Point, which have no rings, ring is always 0.
 *
 * part points at the part of the Multi kinds (MultiPoint / MultiLineString /
 * MultiPolygon). When omitted it is interpreted as 0, so for single geometries that
 * have no parts it is still enough to write just `{ ring, index }` as before.
 * Use the functions in shared/utils/vertex-ref for comparison and lookup (they treat
 * undefined and 0 as the same).
 */
export interface VertexRef {
  /**
   * Part number (MultiPoint: the number of the coordinate, MultiLineString: the number
   * of the line, MultiPolygon: the number of the polygon. 0 for single geometries).
   * Omitted means 0.
   */
  part?: number;
  /** Ring number (Polygon: 0 = outer ring, 1 and later = inner rings. 0 for LineString / Point) */
  ring: number;
  /** Vertex index within the ring */
  index: number;
}

/**
 * The selected vertices of one feature
 *
 * Several vertices of a single feature can be selected at once, to move or delete them
 * together. It is local state of this client, like the selection.
 */
export interface VertexSelection {
  /** The ID of the feature whose vertices are selected */
  featureId: string;
  /** The selected vertices */
  vertices: readonly VertexRef[];
}

/**
 * The style a feature carries in `Feature.style`, overriding the defaults key by key
 *
 * Every key is optional. A color key left unset takes the color of the layer's style rule
 * ({@link StyleRule}) when the layer has one, and any other key left unset takes the default
 * of the `style` option ({@link FeatureStyleConfig}). The precedence is "the feature's own key
 * > the layer's style rule > the default". Colors are CSS colors.
 *
 * Each feature type reads its own keys:
 *
 * | Feature types | Keys |
 * | --- | --- |
 * | Point, MultiPoint | pointColor, pointRadius, pointShape, pointOpacity, pointStrokeColor, pointStrokeWidth |
 * | LineString, MultiLineString, Freehand | strokeColor, strokeOpacity, strokeWidth, lineStyle |
 * | Polygon, MultiPolygon, Circle | the stroke keys, fillColor, fillOpacity |
 * | Image | imageOpacity |
 *
 * On import each key is validated and a key that fails is dropped.
 *
 * A key this type does not define is kept as it is, whatever its value: it is stored,
 * synchronized, exported and loaded back like the keys above, and core does not read it. An
 * extension or a host gives features style keys of its own this way. It declares them with
 * declaration merging and checks their values where it reads them, since a value can also
 * arrive through `updateFeature` or a replaced store without an import.
 *
 * @example A style key of an extension
 * ```ts
 * declare module '@sakuzu/maplibre-gl-draw' {
 *   interface FeatureStyle {
 *     markerLabel?: string;
 *   }
 * }
 *
 * // In the extension's renderer: check the value before using it
 * const label = feature.style?.markerLabel;
 * if (typeof label === 'string') drawLabel(label);
 * ```
 */
export interface FeatureStyle {
  // Fill
  /**
   * The fill color of a polygon
   *
   * @defaultValue `'#FF0077'` (`polygon.fill` of {@link FeatureStyleConfig})
   */
  fillColor?: string;
  /**
   * The opacity of the fill of a polygon, from 0 to 1
   *
   * @defaultValue `0.25` (the alpha of `polygon.fill` of {@link FeatureStyleConfig})
   */
  fillOpacity?: number;

  // Stroke (line)
  /**
   * The color of a line, or of the outline of a polygon
   *
   * @defaultValue `'#FF0077'` (`lineString.stroke` and `polygon.stroke` of
   *   {@link FeatureStyleConfig})
   */
  strokeColor?: string;
  /**
   * The width of a line, or of the outline of a polygon, in CSS pixels
   *
   * A feature drawn in a drawing mode records the zoom it was created at
   * ({@link getCreatedZoom}), and its width follows the map from there: it doubles with each
   * zoom level in and halves with each level out. A feature without a created zoom keeps the
   * same width on the screen at every zoom.
   *
   * @defaultValue `2`
   */
  strokeWidth?: number;
  /**
   * The opacity of a line, or of the outline of a polygon, from 0 to 1
   *
   * @defaultValue `1`
   */
  strokeOpacity?: number;
  /**
   * The dash pattern of a line, or of the outline of a polygon
   *
   * @defaultValue `'solid'`
   */
  lineStyle?: 'solid' | 'dashed' | 'dotted';

  // Point
  /**
   * The radius of the marker of a point, in CSS pixels
   *
   * @defaultValue `6` (a 12 px marker; `point.point.size` of {@link FeatureStyleConfig} is
   *   the diameter)
   */
  pointRadius?: number;
  /**
   * The fill color of the marker of a point (its outline is `pointStrokeColor`)
   *
   * @defaultValue `'#FF6633'`
   */
  pointColor?: string;
  /**
   * The shape of the marker of a point
   *
   * It wins over the shape of the `style` option (`point.point.shape` of
   * {@link FeatureStyleConfig}), so points of one instance can mix shapes. Hit testing does not
   * look at the shape: a square, a triangle or a star is hit like the circle that encloses it.
   *
   * @defaultValue the shape of the `style` option (`'circle'` unless it is changed)
   */
  pointShape?: 'circle' | 'square' | 'triangle' | 'star';
  /**
   * The opacity of the marker of a point, from 0 to 1, multiplied into the opacity of its
   * fill and of its outline
   *
   * @defaultValue `1`
   */
  pointOpacity?: number;
  /**
   * The color of the outline of the marker of a point
   *
   * @defaultValue `'#ffffff'`
   */
  pointStrokeColor?: string;
  /**
   * The width of the outline of the marker of a point, in CSS pixels (0 for none)
   *
   * @defaultValue `2`
   */
  pointStrokeWidth?: number;

  // Image
  /**
   * The opacity of an image, from 0 to 1
   *
   * @defaultValue `1`
   */
  imageOpacity?: number;
}

/**
 * The values core keeps in `Feature.properties` of an Image feature, read into one object
 *
 * The image mode and `load()` of an image file write them, under the keys that start with
 * `maplibre-gl-draw:`. The image data itself is a {@link FileData} of the Store, which
 * `imageFileId` names, so that several features can share one image.
 */
export interface ImageProperties {
  /** The ID of the {@link FileData} that holds the image */
  imageFileId: string;
  /** The width in pixels the image is drawn at, at the created zoom */
  imageWidth: number;
  /** The height in pixels the image is drawn at, at the created zoom */
  imageHeight: number;
  /** The zoom the image was placed at; at this zoom it is drawn at its size in pixels */
  createdZoom: number;
  /** The rotation in degrees (0 when unset) */
  rotation?: number;
  /** The scale that resizing applies to the size of the image (1 when unset) */
  scale?: number;
}

/**
 * An embedded file of the document, such as the data of an image
 *
 * Features refer to it by ID (`maplibre-gl-draw:imageFileId` in `properties` of an Image),
 * and the native format exports the files the exported features use.
 */
export interface FileData {
  /** The ID of the file, unique within the document */
  id: string;
  /** The MIME type, such as `image/webp` */
  mimeType: string;
  /** The content as a data URL (`data:<mimeType>;base64,...`) */
  dataURL: string;
}

/**
 * A feature of the document: its GeoJSON geometry, the layer and group it belongs to, its
 * attributes and its style
 *
 * The draw instance returns features from `draw.features` and the events, and creates them
 * from an input. What the instance returns is read-only: a change stores a new object.
 *
 * The stacking order of the features is not a property of the feature: it is the position of
 * its ID in `Layer.items`, or in `Group.featureIds` when it belongs to a group.
 */
export interface Feature {
  /** The ID of the feature, unique within the document (a ULID when core generates it) */
  id: string;
  /** The type of the feature, which decides the kind of `geometry` */
  type: FeatureType;
  /**
   * The GeoJSON geometry (a Circle and an Image hold the Point of their center and their
   * anchor, and a Freehand holds a LineString)
   */
  geometry: Geometry;
  /**
   * The ID of the layer the feature belongs to (for a feature in a group, the layer of the
   * group)
   */
  layerId: string;
  /**
   * The ID of the group the feature belongs to, when it belongs to one
   *
   * A feature in a group is listed in `Group.featureIds` instead of `Layer.items`.
   */
  groupId: string | undefined;
  /**
   * The GeoJSON properties: the attributes of the user and the values of the library
   *
   * A key that starts with `maplibre-gl-draw:` holds a value of the library: the created zoom,
   * the rotation and the scale (see {@link getCreatedZoom}, {@link getRotation} and
   * {@link getScale}), the radius of a Circle and the values of {@link ImageProperties} of an
   * Image. Every other key is an attribute of the user, free-form; `name` and `description`
   * are read as the name and the description. Exports write them as they are.
   */
  properties: { [key: string]: Value };
  /**
   * The style of this feature, `{}` when it has none of its own (the defaults and the layer's
   * style rule apply to the keys it leaves out)
   */
  style: FeatureStyle;
  /**
   * Whether the feature is locked
   *
   * A locked feature can be selected but not moved, resized, rotated, reshaped or deleted by
   * the user. A feature is also locked when its group or its layer is ({@link isFeatureLocked}).
   */
  locked: boolean;
  /**
   * Whether the feature is shown
   *
   * It is part of the document, so it is saved and exported. A hidden
   * feature is neither drawn nor hit. To hide a feature in this instance only, use local
   * visibility (`setLocallyHidden`) instead.
   */
  visible: boolean;
}

/**
 * The input for adding a feature to the Store: a {@link Feature} whose other fields
 * may be omitted
 *
 * Only `type` and `geometry` are required; the other fields take the defaults written on
 * them.
 */
export interface FeatureInput {
  /** Feature ID (generated automatically when omitted) */
  id?: string;
  /** Feature type */
  type: FeatureType;
  /** The GeoJSON geometry, of the kind the type holds */
  geometry: Geometry;
  /** Layer ID (the active layer when omitted) */
  layerId?: string;
  /** Properties (an empty object when omitted) */
  properties?: Record<string, unknown>;
  /** Style */
  style?: FeatureStyle;
  /** Locked state (false when omitted) */
  locked?: boolean;
  /** Visible state (true when omitted) */
  visible?: boolean;
}

/**
 * A rule that colors the features of a layer from their attributes (`Layer.styleRule`)
 *
 * The rule is evaluated when the features are drawn, so a feature follows the rule as soon
 * as an attribute changes, with nothing to rewrite in its style. The precedence is "the
 * feature's own color > the layer's rule > the default color". The color goes to
 * `pointColor` of a point, `strokeColor` of a line and `fillColor` of a polygon
 * ({@link getStyleRuleChannel}). Colors are `#rrggbb`.
 *
 * There are four kinds:
 *
 * - `single`: gives every feature the same `color`, without looking at attributes
 * - `categorical`: looks up the value of `property` (a string, a number or a boolean, as a
 *   string) in `map`
 * - `graduated`: classes the number in `property` by the ascending `breaks` (n of them) and
 *   takes the color from `colors` (n + 1 of them): a value below `breaks[i]` takes
 *   `colors[i]`, and a value below no break takes `colors[n]`
 * - `continuous`: interpolates the two colors of `ramp` in OKLab from `min` to `max` (so no
 *   muddy middle color appears); a value outside the range is clamped
 *
 * A feature that lacks the attribute, or whose value has the wrong type (a numeric string
 * for `graduated`, say), takes `other` rather than the default color, so a rule that does not
 * apply can be told apart from a missing value. {@link evaluateStyleRule} evaluates a rule and
 * {@link deriveLegend} lists its legend entries; the library does not draw the legend.
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

/**
 * What every layer of the document has: its visibility, lock, opacity and style rule
 */
export interface LayerFields {
  /** The ID of the layer, unique within the document */
  id: string;
  /** The display name */
  name: string;
  /**
   * Whether the layer is shown
   *
   * It is part of the document, like {@link Feature.visible}. A hidden layer hides every
   * feature in it, and no feature can be drawn into it.
   */
  visible: boolean;
  /**
   * Whether the layer is locked
   *
   * Every feature in a locked layer is locked ({@link isFeatureLocked}), and no feature can
   * be drawn into it.
   */
  locked: boolean;
  /**
   * The opacity of the layer, from 0 to 1
   *
   * It is multiplied into the alpha of everything drawn for the layer (fills, lines, points,
   * images, and what the renderers of custom types and feature companions draw, which receive
   * it as `FrameDrawContext.opacity`). It is applied at draw time, so changing it is
   * cheap: nothing is rebuilt. It is only a look: hit testing ignores it, and a feature in a
   * layer at opacity 0 can still be selected.
   */
  opacity: number;
  /** Free-form data of the host, saved and exported with the layer */
  metadata: Record<string, unknown> | undefined;
  /**
   * Style rule (no rule when omitted)
   *
   * Because it is an ordinary field it is subject to saving, subscription and undo, and
   * it is updated with `updateLayer(id, { styleRule })`.
   */
  styleRule: StyleRule | undefined;
}

/**
 * A layer of the document whose features are objects: an ordered list of features and groups
 *
 * Every feature belongs to one layer. The layers are stacked in the order of
 * `getLayerOrder()`, and within a layer the items are stacked in the order of `items`. New
 * features are drawn into the active layer.
 */
export interface ObjectLayer extends LayerFields {
  /** Not set: a layer of objects */
  kind?: undefined;
  /**
   * The IDs of the standalone features and of the groups in the layer, back to front (the
   * last is the frontmost)
   *
   * A feature in a group is listed in `Group.featureIds` instead.
   */
  items: readonly string[];
}

/**
 * A layer of the document a Store holds as rows of columns (`StoreView.tables`): its items are
 * read from its rows (`LayerTableView.listItems`), not listed in it
 */
export interface TableLayer extends LayerFields {
  /** A layer held as rows */
  kind: 'table';
}

/**
 * A layer of the document, with its own visibility, lock and style rule: a layer of objects,
 * which lists its items, or a layer held as rows, whose items are read from its rows (a Store
 * holds every layer one way or the other)
 */
export type Layer = ObjectLayer | TableLayer;

/**
 * What every group of features has
 */
export interface GroupFields {
  /** The ID of the group, unique within the document */
  id: string;
  /**
   * The ID of the layer the group is in: the layer whose `items` list it
   *
   * The Store keeps it: a group takes the layer that lists it when it is created, and a write
   * that lists it in the items of another layer moves it to that layer.
   */
  layerId: string;
  /** The display name */
  name: string;
  /**
   * Whether the group is locked (every member is then locked, see {@link isFeatureLocked})
   */
  locked: boolean;
  /** Whether the group is shown (a hidden group hides every member) */
  visible: boolean;
}

/**
 * A group of features within one layer of objects, selected, moved and stacked as a unit
 *
 * A group is listed in `Layer.items` of its layer like a feature, and its members are listed
 * in `featureIds` (each member has `groupId` set).
 */
export interface ObjectGroup extends GroupFields {
  /** Not set: a group of a layer of objects */
  kind?: undefined;
  /** The IDs of the members, back to front (the last is the frontmost) */
  featureIds: readonly string[];
}

/**
 * A group of features of a layer held as rows: its members are read from the rows
 * (`LayerTableView.listGroupMembers`), not listed in it
 */
export interface TableGroup extends GroupFields {
  /** A group of a layer held as rows */
  kind: 'table';
}

/**
 * A group of features within one layer, selected, moved and stacked as a unit: a group of a
 * layer of objects, which lists its members, or a group of a layer held as rows
 */
export type Group = ObjectGroup | TableGroup;

/**
 * The geometry being drawn, before it is committed as a feature, as the renderer of a shape being
 * drawn reads it
 *
 * A drawing mode shows it by a sketch of this client of an edit `create` (`draw.sketches`), and it
 * goes with the sketch when the feature is committed or the drawing is cancelled.
 */
export interface TentativeState {
  /** The type of the feature being drawn */
  type: FeatureType;
  /** The coordinates drawn so far, in the format of the feature type */
  coordinates: Coordinate | Coordinate[] | Coordinate[][];
  /**
   * ID of the layer being drawn into
   *
   * Indicates the layer the Tentative belongs to.
   * Used in order to render according to the layer order.
   */
  layerId: string;
  /**
   * The number of committed coordinates. Used for LineString/Polygon.
   * Of the coordinates, the first confirmedCount of them are committed.
   * The ones after that (such as the cursor position) are not committed.
   * When omitted, all of them are treated as committed.
   */
  confirmedCount?: number;
  /**
   * The index of the vertex to highlight.
   * Set when the mouse comes close to a vertex.
   */
  highlightedVertexIndex?: number;
  /**
   * For Circle: the radius (in meters)
   */
  radiusMeters?: number;
  /**
   * For Circle: the angle of the radius handle (in degrees)
   */
  radiusHandleAngle?: number;
  /**
   * The ID of the Feature that is going to be created
   *
   * The ID of the Feature that will be created when drawing finishes is decided in
   * advance and included in the Tentative.
   * Lets a subscriber that receives the committed Feature drop the corresponding Tentative
   * at once.
   */
  pendingFeatureId?: string;
}

/**
 * Where a change came from, carried by every change notification of the Store
 *
 * A subscriber reads it to decide what to do with a change. The source is only a label: it
 * does not change which events are emitted
 * or how they are grouped. Every change is emitted, one notification per transaction, and
 * features.change carries the source of its flush.
 *
 * - local: an operation of the user or a call of the API (the default)
 * - silent: a change that a subscriber recording changes leaves out, such as clearing the
 *   selection when a mode starts
 * - load: a load of any format (or of several sources at once), with the replacement it
 *   makes, recorded as one step (it is one transaction, which is what makes it one
 *   notification)
 * - batch: a bulk change of a host or an extension recorded as one step; core does not write
 *   it
 * - remote: a change that came from outside the instance. A replaced Store (see StoreContract)
 *   writes it for the changes it applies from elsewhere, so that subscribers can tell them from
 *   local edits and core keeps the local editing state (a vertex selection) consistent with them
 * - import: for a host or an extension that loads data by its own means; core does not write
 *   it
 *
 * Any other string can be used by a plugin or a store for the changes it applies itself.
 */
export type UpdateSource =
  | 'local'
  | 'silent'
  | 'load'
  | 'batch'
  | 'remote'
  | 'import'
  | (string & Record<never, never>);

/**
 * One change notification of the Store: everything one transaction changed
 *
 * `subscribe` of the Store delivers one per outermost transaction (or per write outside
 * one). Each category is present only when the transaction changed it. The document
 * categories (features, layers, groups, order, metadata, files, rows) are what a
 * DocumentStore notifies; the others are local state of this client.
 */
export interface StoreChange {
  /**
   * The source of the operation
   *
   * Used by subscribers to identify the source of the operation. Core writes 'local',
   * 'silent' and 'load', and a replaced store writes 'remote' for the changes it applies
   * from outside (see {@link UpdateSource}); plugins and external store implementations can
   * use their own values.
   */
  source?: UpdateSource;

  /** The features created, updated and deleted (each update with the feature before it) */
  features?: {
    created?: Feature[];
    updated?: Array<{
      id: string;
      feature: Feature;
      previous: Feature;
    }>;
    deleted?: Feature[];
  };
  /**
   * The layers created, updated and deleted, and the change of the stacking order of the
   * layers (`orderChanged`)
   */
  layers?: {
    created?: Layer[];
    updated?: Array<{ id: string; layer: Layer; previous: Layer }>;
    deleted?: Layer[];
    orderChanged?: { order: string[]; previous: string[] };
  };
  /** The groups created, updated and deleted */
  groups?: {
    created?: Group[];
    updated?: Array<{ id: string; group: Group; previous: Group }>;
    deleted?: Group[];
  };
  /**
   * The items (features and groups) put in another place of the stacking order, created and
   * deleted, in the order they were put there: each with where it was and where it is, by the
   * items just below and above it at that moment (see {@link ItemOrderChange})
   */
  order?: ItemOrderChange[];
  /**
   * What keeps the rows and the groups deleted by this client in this transaction (a Store that
   * holds its features as rows): what undoes the deletion holds it, and lets it go with
   * `FeatureTables.release` once it no longer needs them
   */
  restoreToken?: RestoreToken;
  /** The new selection and the one before it */
  selection?: {
    type: SelectionType | null;
    ids: string[];
    previousType: SelectionType | null;
    previousIds: string[];
    /** Many features selected at once, and before */
    bulk?: SelectionBulk;
    previousBulk?: SelectionBulk;
    /**
     * The selection as the instance gives it (`draw.selection.value`), and the one it gave before
     * (the Store of core sets them)
     */
    value?: SelectionValue;
    previousValue?: SelectionValue;
  };
  /** The IDs of the features whose editing started and ended */
  editing?: {
    started?: string[];
    ended?: string[];
  };
  /** The new mode and the one before it */
  mode?: {
    mode: Mode;
    previous: Mode;
  };
  /**
   * A flag indicating that the UI state (dragState, boxSelection) has changed
   * These are not included in the details of StoreChange, but they are notified in order
   * to trigger a redraw
   */
  uiStateChanged?: boolean;
  /** The new metadata of the document and the one before it */
  metadata?: {
    metadata: Metadata;
    previous: Metadata;
  };
  /** The embedded files created and deleted */
  files?: {
    created?: FileData[];
    deleted?: FileData[];
  };
  /**
   * True when the notification replaces the whole document at once (a Store that takes a
   * document from elsewhere sets it); it survives the folding of a transaction
   */
  reset?: boolean;
  /**
   * The rows held as columns written (a Store that holds its features as rows puts here what its
   * writer returned); a feature is in `features` or here, never in both
   */
  rows?: RowsChange;
  /**
   * The values the rows had before a write of this client, for the fields written (see
   * `DocumentChange.previousValues`): a {@link RowValues}
   */
  previousValues?: FeatureValues;
}

declare const featureValuesBrand: unique symbol;

/**
 * Values of features as they were, which written back with `features.restore` put them back: what
 * a Store that holds its features as rows notifies of a write of this client
 * (`DocumentChange.previousValues`) and what `features.restore` returns. Its content is values of
 * rows, read with `rowValuesOf` and made of values of rows with `featureValuesOf`
 * (`@sakuzu/maplibre-gl-draw/kasane`).
 */
export interface FeatureValues {
  /** Tells it from other objects: its content is a `RowValues` */
  readonly [featureValuesBrand]?: true;
}

/**
 * Items of a layer, in their order: rows and groups of features.
 */
export interface ItemHandles {
  /** The kind of each item: 0 for a row, 1 for a group of features */
  readonly kinds: Uint8Array;
  /** The handle of each item: of its row, or of its group (-1 for none) */
  readonly handles: Int32Array;
}

/**
 * Where an item (a feature, or a group of features) is put: in a layer, or in a group of
 * features, just above an item and below another.
 *
 * `below` is the item just below it (drawn before it), `above` the one just above it (drawn
 * after it); `null` names the end of the layer or the group (the back for `below`, the front for
 * `above`). When the two do not stand next to each other (another write came in between),
 * `below` decides and `above` is not read. When `below` is left out, `above` decides; when both
 * are, the item goes to the front.
 */
export interface ItemPlacement {
  /** The layer */
  readonly layerId: string;
  /** The group of features of the layer it goes into (a feature only; none: an item of the layer) */
  readonly groupId?: string;
  /** The item just below it, or null for the back */
  readonly below?: string | null;
  /** The item just above it, or null for the front */
  readonly above?: string | null;
}

/**
 * Where an item stands: its layer, its group of features, and the items just below and above it
 * (null at an end).
 */
export interface ItemPosition {
  /** The layer */
  readonly layerId: string;
  /** The group of features it is in (undefined for an item of the layer) */
  readonly groupId: string | undefined;
  /** The item just below it (null: it is at the back) */
  readonly below: string | null;
  /** The item just above it (null: it is at the front) */
  readonly above: string | null;
}

/**
 * An item put in another place: where it was and where it is, at the moment it was moved (an
 * item created was nowhere, an item deleted is nowhere). Moving the items of a list back to
 * where they were, from the last one, puts the order back.
 */
export interface ItemMove {
  readonly kind: 'item';
  /** The item: a feature, or a group of features */
  readonly itemId: string;
  /** Where it was (null for an item created) */
  readonly from: ItemPosition | null;
  /** Where it is (null for an item deleted) */
  readonly to: ItemPosition | null;
  /**
   * For a row of a Store of rows that was somewhere (moved or deleted): its layer, its group and
   * the keys of its order before, as {@link RowsMove.before} holds them (written back, they put
   * the row back). Absent for an item created, a group of features, and in a Store that keeps no
   * keys
   */
  readonly before?: RowValues;
}

/**
 * Many rows of a layer held as rows put in another place at once (their features stay as they
 * are): the rows in the order they were put, and either the place they were put together at
 * (`to`) or, for each row, the item just below it (`belows`; -1 for a row at the back, read in
 * its group of features). `before` holds the keys of their order, their layer and their group as
 * they were (written back, it puts them back).
 */
export interface RowsMove {
  readonly kind: 'rows';
  /** The layer the rows are in */
  readonly layerId: string;
  /** The rows, in the order they were put */
  readonly handles: Int32Array;
  /** The place they were put at, one after the other (absent when `belows` is given) */
  readonly to?: ItemPosition;
  /** The item just below each row (absent when `to` is given) */
  readonly belows?: ItemHandles;
  /** Their layer, group and keys of their order before */
  readonly before: RowValues;
}

/**
 * A change of the stacking order of the items of the layers: one item, or many rows at once.
 */
export type ItemOrderChange = ItemMove | RowsMove;

declare const restoreTokenBrand: unique symbol;

/**
 * What keeps the rows and the groups a deletion of this client deleted
 * (`DocumentChange.restoreToken`): they stay as they were, so that a deletion undone puts them
 * back where they were, until it is let go of (`features.releaseRestore`).
 */
export type RestoreToken = number & { readonly [restoreTokenBrand]: true };

/**
 * The metadata of the document
 *
 * Core stores, saves and exports it, and does not read it. `setMetadata` merges into it.
 *
 * It declares a title and a description. An application keeps settings of its own here (the
 * basemap it shows, a default view) by adding keys to this interface with declaration
 * merging; the keys are stored and exported like the declared ones.
 */
export interface Metadata {
  /** The title of the document */
  title?: string;
  /** The description of the document */
  description?: string;
}

/**
 * The whole document in the native format, as `export('native')` writes it and
 * `load()` reads it
 *
 * `load()` validates it as a whole before replacing the document, and rejects it on the
 * first problem. The format is described in the data format reference.
 */
export interface Data {
  /** The version of the native format (`'4.0.0'` for this release) */
  version: string;
  /** When the data was written (an ISO 8601 timestamp) */
  created?: string;
  /** When the data was last modified (an ISO 8601 timestamp) */
  modified?: string;
  /** The metadata of the document */
  metadata?: Metadata;
  /**
   * The layers, with their order of items (the order of this array has no meaning): a layer
   * held as rows is written with the items its rows list
   */
  layers?: ObjectLayer[];
  /**
   * The stacking order, from the back: every layer of `layers` once, and the entries of the
   * application that are not layers (see the stacking order of StoreContract) at their
   * positions
   */
  layerOrder: string[];
  /** The groups, with the features they list */
  groups?: ObjectGroup[];
  /** The features */
  features: Feature[];
  /** The embedded files the features use, by ID */
  files?: Record<string, FileData>;
}

/**
 * Options for load()
 *
 * For an image file, the coordinate, the zoom and the layer ID are required.
 * For GeoJSON and the like they are not required, because the coordinate information is
 * contained in the file.
 */
export interface LoadOptions {
  /** The coordinate at which to place the image feature */
  coordinate?: Coordinate;
  /** The zoom level at which the image feature is created */
  zoom?: number;
  /** The ID of the layer to add the image feature to */
  layerId?: string;
  /**
   * Whether to expand the Multi* geometries of GeoJSON into individual features
   * (default: false)
   *
   * By default MultiPoint / MultiLineString / MultiPolygon are kept as they are, as Multi
   * features. Setting it to true gives the former expanding behavior.
   */
  flattenMulti?: boolean;
}

/**
 * What `load()` imported: the detected format, the IDs of the new features and what it
 * skipped
 */
export interface LoadResult {
  /** The detected data format */
  format: 'native' | 'geojson' | 'image';
  /** The IDs of the imported features */
  featureIds: string[];
  /** Whether the existing data was replaced */
  replaced: boolean;
  /**
   * Features that the import left out, with the reason. Only GeoJSON input
   * skips features; the native format is validated as a whole and rejected
   * on the first problem.
   */
  skipped?: SkippedFeature[];
}

/**
 * A feature of a GeoJSON input that `load()` left out, and why
 */
export interface SkippedFeature {
  /** Index of the feature in the input */
  index: number;
  /** Why it was skipped (English, for logs and diagnostics) */
  reason: string;
}

/**
 * Options of `export()`: the file name, and which features or layers to export
 */
export interface ExportOptions {
  /** A custom file name */
  fileName?: string;
  /** Export only certain features */
  featureIds?: string[];
  /** Export only certain layers */
  layerIds?: string[];
}

/**
 * The box selection in progress (a Shift-drag in the select mode), local state of this client
 */
export interface BoxSelection {
  /** The point where the drag started (geographic coordinates) */
  startPoint: Coordinate;
  /** The current drag position (geographic coordinates) */
  endPoint: Coordinate;
  /** The selection state when the drag started (in order to restore it on cancel) */
  previousSelection: string[];
  /**
   * The selection when the drag started when it held features in bulk (restored on cancel in
   * place of `previousSelection`)
   */
  previous?: Selection;
}

/**
 * The kind of drag in progress in the select mode (null when there is none)
 */
export type DragOperationType =
  | 'move'
  | 'resize'
  | 'rotate'
  | 'vertex'
  | 'midpoint'
  | 'radius'
  /**
   * The drag of an auxiliary handle provided by an extension implementation (core does not own
   * the meaning of the coordinates)
   */
  | 'auxiliary'
  | null;

/**
 * The four corners and the center of an axis-aligned box, as geographic coordinates
 */
export interface BoundingBoxCoordsSimple {
  /** The north-west corner */
  topLeft: Coordinate;
  /** The north-east corner */
  topRight: Coordinate;
  /** The south-east corner */
  bottomRight: Coordinate;
  /** The south-west corner */
  bottomLeft: Coordinate;
  /** The center */
  center: Coordinate;
}

/**
 * The state of a rotation in progress, for drawing the rotating bounding box
 */
export interface RotateInfo {
  /** The combined AABB when the rotation started (before the margin is applied) */
  initialBbox: BoundingBoxCoordsSimple;
  /** The bbox of each feature when the rotation started (only for a multiple selection) */
  initialFeatureBboxes?: Map<string, BoundingBoxCoordsSimple>;
  /** The current rotation angle (in radians, counterclockwise) */
  currentAngle: number;
  /** The center the features turn around (the center of `initialBbox` when omitted) */
  center?: Coordinate;
}

/**
 * The drag in progress on the selected features, local state of this client
 *
 * The selection UI reads it to decide which handles to show during the drag.
 */
export interface DragState {
  /** The kind of the current drag operation */
  operation: DragOperationType;
  /**
   * The vertex being operated on while editing a vertex/midpoint (part number + ring
   * number + vertex index)
   * Set only when operation is 'vertex' or 'midpoint'
   */
  activeVertex?: VertexRef;
  /**
   * The edges of the feature being operated on that the drag of a vertex or a midpoint changes,
   * each by the vertex it starts from (as the edges of a feature are listed): the edges the vertex
   * starts and ends. Before a midpoint adds its vertex, the edge it is on alone
   */
  activeEdges?: VertexRef[];
  /**
   * The ID of the feature being operated on while editing a vertex/midpoint
   * Set only when operation is 'vertex' or 'midpoint'
   */
  activeFeatureId?: string;
  /**
   * For drawing the bbox during a rotation operation
   * Set only when operation is 'rotate'
   */
  rotateInfo?: RotateInfo;
  /**
   * The IDs of the features the drag changes as a whole (a group/layer selection is already
   * resolved into its members): the features moved, rotated or resized, the circle whose radius
   * is dragged, and the feature a handle of an extension is on. Not set for a vertex or a
   * midpoint, whose drag changes one vertex and its edges (`activeVertex`, `activeEdges`)
   *
   * Snapping leaves them out of the candidates: what the drag changes as a whole goes with the
   * pointer, and would pull it back to itself.
   */
  movingFeatureIds?: string[];
  /**
   * The rows of the features selected in bulk the drag changes as a whole (snapping leaves them
   * out as it leaves out `movingFeatureIds`)
   */
  movingRows?: { has(handle: number): boolean };
}

/**
 * What a drag changes, as its drag state records it: the features and the rows it changes as a
 * whole, or the vertex it drags and the edges it changes. Snapping leaves them out of the
 * candidates, from the start of the drag (before the drag state is set) to its end
 */
export type DragTargets = Pick<
  DragState,
  'movingFeatureIds' | 'movingRows' | 'activeFeatureId' | 'activeVertex' | 'activeEdges'
>;
