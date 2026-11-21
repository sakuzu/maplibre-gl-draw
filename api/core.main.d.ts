// @sakuzu/maplibre-gl-draw 3.0 の main の入口の宣言の案 (第 3 稿)。
// 第 2 稿に、批判 2 本への決め (spec-draft/v2/DECISIONS.md) と名前の試しの直しを当て、
// 第 3 稿への批判の決め (spec-draft/v3/REVIEW-DECISIONS.md) を当てて直した (FIXES.md)。
// main (2.2.0) からの差分は同じフォルダーの CHANGES.md、旧と新の名前は RENAMES.md にある。
// この入口は地物の言葉だけで閉じる。Store を作る人と、外で起きた変更を Store に書く人の
// 型は @sakuzu/maplibre-gl-draw/store の入口 (core.store.d.ts) にあり、ここは Store の型を
// 名指すだけである。「export されない宣言」の領域は、export された宣言が参照するので、この
// ファイルだけで読めるように写した物で、入口からは export されていない。

import type { Feature as GeoJSONFeature, FeatureCollection, FeatureCollection as GeoJSONFeatureCollection, Geometry, Position } from 'geojson';
import type { Map as MaplibreMap, ProjectionData } from 'maplibre-gl';
import type { Store } from '@sakuzu/maplibre-gl-draw/store';

// 入口の説明 (入口の index の先頭の TSDoc)
/**
 * Draw and edit points, lines and areas on a MapLibre map, and show large data beside them.
 *
 * Import from here for everything an application does with a drawing: create the instance,
 * read and change its features, layers and groups, listen to what changes, save and load the
 * document, and add plugins, modes and feature types. Four subpaths cover the rest: geometry
 * that needs no map (`/geometry`), large tables read in a Worker (`/table`), custom shaders
 * (`/webgl`), and the Store of the document, for an application that makes a Store of its own
 * or writes into it a change made outside the instance (`/store`).
 *
 * ```ts
 * import { createDraw } from '@sakuzu/maplibre-gl-draw';
 *
 * const draw = createDraw(map);
 * draw.setMode('drawPolygon');
 * draw.on('feature.created', ({ feature }) => {
 *   console.log(feature.id, feature.geometry);
 * });
 * ```
 *
 * Where to find things: every resource of {@link Draw} is a field with its own methods.
 *
 * - `draw.features` (create, update, updateMany, delete, move, getProperty, union, split, and
 *   the bulk edits translate, rotate, scale, deleteMany, updateAll, duplicate and restore):
 *   {@link FeaturesCollection}
 * - `draw.layers` (create, update, delete, reorder, setActive): {@link LayersCollection}
 * - `draw.groups` (create, update, move): {@link GroupsCollection}
 * - `draw.datasets` (add, remove, move): {@link DatasetsCollection}
 * - `draw.selection` (get, set, add, clear, delete, group): {@link SelectionResource}
 * - `draw.vertexSelection` (set, clear, delete): {@link VertexSelectionResource}
 * - `draw.sketches` (add, remove, list) and `draw.rendered` (get): {@link SketchesCollection},
 *   {@link RenderedResource}
 * - `draw.drag` (remove): {@link DragResource}
 * - `draw.metadata` and `draw.options` (get, update): {@link MetadataResource}, {@link OptionsResource}
 * - `draw.document` (load, subscribe, toJSON, toGeoJSON, stringify): {@link DocumentResource}
 * - `draw.drawing` (addVertex, finish, cancel): {@link DrawingResource}
 * - `draw.extensions` (plugins, modes, feature types, providers, the computation of moves):
 *   {@link ExtensionsCollections}
 * - events with `draw.on`: {@link DrawEvents}; errors: {@link DrawError}
 *
 * Read next: [getting started](https://sakuzu.github.io/maplibre-gl-draw/getting-started),
 * then the guides for [drawing](https://sakuzu.github.io/maplibre-gl-draw/guides/drawing) and
 * [saving and loading](https://sakuzu.github.io/maplibre-gl-draw/guides/save-load). The
 * symbols used most are {@link createDraw}, {@link Draw}, {@link Feature} and
 * {@link DrawEvents}.
 *
 * @module maplibre-gl-draw
 */

// =============================================================================
// 領域: 作る所 (createDraw と設定)
// =============================================================================

/**
 * Puts a draw instance on a map and returns it.
 *
 * It can be called before, while or after the map loads. The layers are added on top of the map
 * as soon as the style accepts them. After `setStyle`, with or without `diff`, they are on top
 * again: added again after a full replacement, and moved above the layers of the new style after
 * a diff. A layer added to the map later goes above them and stays there until the style changes.
 * Unless `initDefaultLayer: false` is given, the document starts with one empty layer. Several
 * instances can be shown at once, each on its own map.
 *
 * @param map - The map to draw on
 * @param options - The options; every one can be omitted
 * @returns The draw instance
 */
export declare function createDraw(map: MaplibreMap, options?: DrawOptions): Draw;

/**
 * The options given when the instance is created.
 */
export interface DrawOptions extends RuntimeOptions {
    /** The mode to start in */
    defaultMode?: Mode;
    /**
     * The Store that keeps the document, instead of the built-in one, for an application that
     * keeps the document somewhere of its own (the `/store` entry); only at creation. Most
     * applications leave it out.
     */
    store?: Store;
    /** Whether a layer is created when there is none; only at creation */
    initDefaultLayer?: boolean;
    /**
     * Makes the ID of everything the library creates, instead of the built-in generator; only
     * at creation. It is called for every new feature, group, layer and file: drawing, grouping
     * a selection, the results of a geometry operation, an image and every feature of a GeoJSON
     * load. It must return a non-empty string that is unique for the lifetime of the document
     * and never reused, also after the thing it named was deleted. An ID given by the caller,
     * such as `id` of `features.create`, is used as it is when `acceptsId` takes it. When it is
     * left out, the IDs are ULIDs.
     */
    generateId?: () => string;
    /**
     * Whether an ID given by the caller can name a new feature, group, layer or file; only at
     * creation. It is the counterpart of `generateId`, for an application whose IDs have a form
     * of its own (the keys of its database, say): it decides whether an ID that comes from
     * elsewhere, such as one in a file the user opens, can be kept. It is asked for every ID the
     * library did not make, such as `id` of `features.create` and the IDs a document of the
     * library brings to a load, before anything is written; a change written to the Store
     * directly is not asked. A creation whose ID it does not take
     * throws `DrawError` with the code `invalidInput` and writes nothing, and a load gives such
     * a feature, group, layer or file a new ID from `generateId`, the references to it naming
     * the new one. Every ID is taken when it is left out.
     *
     * @param id - The ID given
     * @returns True when the ID can be used
     */
    acceptsId?: (id: string) => boolean;
}

/**
 * The options that can change while the instance runs, with `draw.options.update`: every
 * option but `defaultMode`, `store`, `initDefaultLayer`, `generateId` and `acceptsId`.
 */
export interface RuntimeOptions {
    /** Replaces the words the library shows */
    messages?: Partial<Messages>;
    /** The names of new features; `false` turns them off */
    autoName?: AutoNameOptions | false;
    /**
     * The default look of each type, with the same keys and CSS colors as the style of a
     * feature
     */
    style?: {
        point?: FeatureStyle;
        line?: FeatureStyle;
        polygon?: FeatureStyle;
        circle?: FeatureStyle;
        image?: FeatureStyle;
    };
    /**
     * The look of the geometry being drawn, with the keys of the style of a feature: the stroke
     * keys give its lines, the point keys its vertices (`pointStrokeColor` and
     * `pointStrokeWidth` their outlines)
     */
    previewStyle?: Partial<FeatureStyle>;
    /** The look of the box and the handles of the selection */
    selectionStyle?: SelectionStyleOptions;
    /**
     * Whether a feature grows and shrinks with the zoom from its look at its reference zoom;
     * true when it is left out
     */
    scaleWithZoom?: boolean;
    /** Snapping */
    snapping?: SnappingOptions;
    /** Tracing of boundaries */
    tracing?: TracingOptions;
    /** Moving shared vertices together */
    topology?: TopologyOptions;
    /** How far the pointer may move and still click, in pixels */
    clickTolerancePx?: number;
    /** How far the pointer must move to start a drag, in pixels */
    dragThresholdPx?: number;
    /** The switches of the drawing */
    rendering?: RenderingOptions;
    /**
     * Whether an entry of the stacking order comes from outside the document, such as a layer
     * of the base map; the stacking order is divided at those entries
     */
    isExternalEntry?: (id: string) => boolean;
}

/** The switches of the drawing. */
export interface RenderingOptions {
    /**
     * The factor for the sizes this library draws in screen pixels (line widths, point sizes);
     * 0.5 while the map is shown at half size. 1 when it is left out
     */
    renderScale?: number;
    /** The pixel ratio to draw with; that of the map when it is left out */
    pixelRatio?: number;
    /**
     * Whether the geometry of the features that do not change is kept between drawings; true
     * when it is left out
     */
    cacheGeometry?: boolean;
    /** Whether work that does not fit in one drawing is spread over the next ones; true when it is left out */
    timeSlicing?: boolean;
}

/**
 * The look of the box around the selected features and of their handles. Each part given
 * replaces the default of that part. Colors are CSS colors, and sizes and widths are in CSS
 * pixels.
 */
export interface SelectionStyleOptions {
    /** The box around the selection */
    boundingBox?: {
        /** The line of the box */
        stroke: {
            /** The width in CSS pixels */
            width: number;
            /** The color (a CSS color) */
            color: string;
            /** The opacity, from 0 to 1 */
            opacity: number;
            /** The dash pattern */
            lineStyle: LineStyle;
            /** A dash pattern in CSS pixels, `[dash, gap]`, instead of that of `lineStyle` */
            dashArray?: number[];
        };
        /**
         * The gap between the features and the box, in CSS pixels: every edge of the box stands
         * this far outside the outline of the selection (`ScreenContext.outline`), and the resize
         * and rotate handles sit on the box
         */
        margin: number;
    };
    /** The resize handles at the corners of the box */
    resizeHandle?: {
        /** The handle */
        point: {
            /** The shape */
            shape: 'circle' | 'square' | 'triangle' | 'star' | 'icon';
            /** The size in CSS pixels */
            size: number;
            /** The fill color (a CSS color) */
            fillColor: string;
            /** The opacity of the fill, from 0 to 1 */
            fillOpacity: number;
            /** The color of the outline (a CSS color) */
            strokeColor: string;
            /** The width of the outline in CSS pixels (0 for none) */
            strokeWidth: number;
            /** The opacity of the outline, from 0 to 1 */
            strokeOpacity: number;
            /** The icon, for the `icon` shape */
            iconId?: string;
        };
    };
    /** The rotate handle above the box */
    rotateHandle?: {
        /** The handle */
        point: {
            /** The shape */
            shape: 'circle' | 'square' | 'triangle' | 'star' | 'icon';
            /** The size in CSS pixels */
            size: number;
            /** The fill color (a CSS color) */
            fillColor: string;
            /** The opacity of the fill, from 0 to 1 */
            fillOpacity: number;
            /** The color of the outline (a CSS color) */
            strokeColor: string;
            /** The width of the outline in CSS pixels (0 for none) */
            strokeWidth: number;
            /** The opacity of the outline, from 0 to 1 */
            strokeOpacity: number;
            /** The icon, for the `icon` shape */
            iconId?: string;
        };
        /** The distance between the handle and the box, in CSS pixels */
        distance: number;
        /** The line that joins the handle to the box */
        connector: {
            /** The width in CSS pixels */
            width: number;
            /** The color (a CSS color) */
            color: string;
            /** The opacity, from 0 to 1 */
            opacity: number;
            /** The dash pattern */
            lineStyle: LineStyle;
            /** A dash pattern in CSS pixels, `[dash, gap]`, instead of that of `lineStyle` */
            dashArray?: number[];
        };
    };
    /** The vertex handles */
    vertexHandle?: {
        /** A vertex handle */
        point: {
            /** The shape */
            shape: 'circle' | 'square' | 'triangle' | 'star' | 'icon';
            /** The size in CSS pixels */
            size: number;
            /** The fill color (a CSS color) */
            fillColor: string;
            /** The opacity of the fill, from 0 to 1 */
            fillOpacity: number;
            /** The color of the outline (a CSS color) */
            strokeColor: string;
            /** The width of the outline in CSS pixels (0 for none) */
            strokeWidth: number;
            /** The opacity of the outline, from 0 to 1 */
            strokeOpacity: number;
            /** The icon, for the `icon` shape */
            iconId?: string;
        };
        /** A selected vertex */
        selected: {
            /** The shape */
            shape: 'circle' | 'square' | 'triangle' | 'star' | 'icon';
            /** The size in CSS pixels */
            size: number;
            /** The fill color (a CSS color) */
            fillColor: string;
            /** The opacity of the fill, from 0 to 1 */
            fillOpacity: number;
            /** The color of the outline (a CSS color) */
            strokeColor: string;
            /** The width of the outline in CSS pixels (0 for none) */
            strokeWidth: number;
            /** The opacity of the outline, from 0 to 1 */
            strokeOpacity: number;
            /** The icon, for the `icon` shape */
            iconId?: string;
        };
        /** A vertex of another feature that moves along with a shared vertex */
        followed: {
            /** The shape */
            shape: 'circle' | 'square' | 'triangle' | 'star' | 'icon';
            /** The size in CSS pixels */
            size: number;
            /** The fill color (a CSS color) */
            fillColor: string;
            /** The opacity of the fill, from 0 to 1 */
            fillOpacity: number;
            /** The color of the outline (a CSS color) */
            strokeColor: string;
            /** The width of the outline in CSS pixels (0 for none) */
            strokeWidth: number;
            /** The opacity of the outline, from 0 to 1 */
            strokeOpacity: number;
            /** The icon, for the `icon` shape */
            iconId?: string;
        };
    };
    /** The midpoint handles, which add a vertex when dragged */
    midpointHandle?: {
        /** The handle */
        point: {
            /** The shape */
            shape: 'circle' | 'square' | 'triangle' | 'star' | 'icon';
            /** The size in CSS pixels */
            size: number;
            /** The fill color (a CSS color) */
            fillColor: string;
            /** The opacity of the fill, from 0 to 1 */
            fillOpacity: number;
            /** The color of the outline (a CSS color) */
            strokeColor: string;
            /** The width of the outline in CSS pixels (0 for none) */
            strokeWidth: number;
            /** The opacity of the outline, from 0 to 1 */
            strokeOpacity: number;
            /** The icon, for the `icon` shape */
            iconId?: string;
        };
    };
    /** The radius handle of a circle */
    radiusHandle?: {
        /** The handle */
        point: {
            /** The shape */
            shape: 'circle' | 'square' | 'triangle' | 'star' | 'icon';
            /** The size in CSS pixels */
            size: number;
            /** The fill color (a CSS color) */
            fillColor: string;
            /** The opacity of the fill, from 0 to 1 */
            fillOpacity: number;
            /** The color of the outline (a CSS color) */
            strokeColor: string;
            /** The width of the outline in CSS pixels (0 for none) */
            strokeWidth: number;
            /** The opacity of the outline, from 0 to 1 */
            strokeOpacity: number;
            /** The icon, for the `icon` shape */
            iconId?: string;
        };
    };
    /** The center marker of a circle */
    centerMarker?: {
        /** The marker */
        point: {
            /** The shape */
            shape: 'circle' | 'square' | 'triangle' | 'star' | 'icon';
            /** The size in CSS pixels */
            size: number;
            /** The fill color (a CSS color) */
            fillColor: string;
            /** The opacity of the fill, from 0 to 1 */
            fillOpacity: number;
            /** The color of the outline (a CSS color) */
            strokeColor: string;
            /** The width of the outline in CSS pixels (0 for none) */
            strokeWidth: number;
            /** The opacity of the outline, from 0 to 1 */
            strokeOpacity: number;
            /** The icon, for the `icon` shape */
            iconId?: string;
        };
    };
    /** The rectangle of a box selection (Shift and a drag) */
    boxSelection?: {
        /** The fill color (a CSS color) */
        fillColor: string;
        /** The opacity of the fill, from 0 to 1 */
        fillOpacity: number;
        /** The color of the outline (a CSS color) */
        strokeColor: string;
        /** The width of the outline in CSS pixels */
        strokeWidth: number;
    };
    /** The line from the center of a circle to its radius handle */
    radiusLine?: {
        /** The line */
        stroke: {
            /** The width in CSS pixels */
            width: number;
            /** The color (a CSS color) */
            color: string;
            /** The opacity, from 0 to 1 */
            opacity: number;
            /** The dash pattern */
            lineStyle: LineStyle;
            /** A dash pattern in CSS pixels, `[dash, gap]`, instead of that of `lineStyle` */
            dashArray?: number[];
        };
    };
}

/** The options of snapping to vertices, edges, intersections and guides. */
export interface SnappingOptions {
    /** Whether snapping is on; true when it is left out */
    enabled?: boolean;
    /** How close the pointer must come to a candidate, in screen pixels; 10 when it is left out */
    tolerancePx?: number;
    /** The key that turns snapping off while it is held; `alt` when it is left out */
    disableKey?: 'alt' | 'shift' | 'ctrl' | 'meta' | 'none';
    /** Whether each kind of candidate is on; a kind left out is on */
    kinds?: Partial<Record<'vertex' | 'edge' | 'intersection' | 'guide', boolean>>;
    /** Whether the rows of datasets are candidates; true when it is left out */
    datasets?: boolean;
    /** The angle between the guides from north, in degrees; 45 when it is left out */
    guideStepDegrees?: number;
    /**
     * The mark drawn at the snapped point, per kind of target; the keys given replace those of
     * the default. By default every mark is `#00C7BE`: `vertex` an outlined circle of 14 px,
     * `edge` an outlined square of 12 px, `intersection` a filled circle of 8 px and `guide` an
     * outlined circle of 10 px. A kind of a snap provider's own takes the mark of `vertex`
     */
    indicator?: {
        /** The mark of a vertex */
        vertex?: {
            /** The shape */
            shape?: 'circle' | 'square' | 'triangle' | 'star';
            /** The size in CSS pixels */
            size?: number;
            /** The fill color (a CSS color) */
            fillColor?: string;
            /** The opacity of the fill, from 0 to 1 */
            fillOpacity?: number;
            /** The color of the outline (a CSS color) */
            strokeColor?: string;
            /** The width of the outline in CSS pixels (0 for none) */
            strokeWidth?: number;
            /** The opacity of the outline, from 0 to 1 */
            strokeOpacity?: number;
        };
        /** The mark of a point on an edge */
        edge?: {
            /** The shape */
            shape?: 'circle' | 'square' | 'triangle' | 'star';
            /** The size in CSS pixels */
            size?: number;
            /** The fill color (a CSS color) */
            fillColor?: string;
            /** The opacity of the fill, from 0 to 1 */
            fillOpacity?: number;
            /** The color of the outline (a CSS color) */
            strokeColor?: string;
            /** The width of the outline in CSS pixels (0 for none) */
            strokeWidth?: number;
            /** The opacity of the outline, from 0 to 1 */
            strokeOpacity?: number;
        };
        /** The mark of an intersection of edges */
        intersection?: {
            /** The shape */
            shape?: 'circle' | 'square' | 'triangle' | 'star';
            /** The size in CSS pixels */
            size?: number;
            /** The fill color (a CSS color) */
            fillColor?: string;
            /** The opacity of the fill, from 0 to 1 */
            fillOpacity?: number;
            /** The color of the outline (a CSS color) */
            strokeColor?: string;
            /** The width of the outline in CSS pixels (0 for none) */
            strokeWidth?: number;
            /** The opacity of the outline, from 0 to 1 */
            strokeOpacity?: number;
        };
        /** The mark of a point on a guide */
        guide?: {
            /** The shape */
            shape?: 'circle' | 'square' | 'triangle' | 'star';
            /** The size in CSS pixels */
            size?: number;
            /** The fill color (a CSS color) */
            fillColor?: string;
            /** The opacity of the fill, from 0 to 1 */
            fillOpacity?: number;
            /** The color of the outline (a CSS color) */
            strokeColor?: string;
            /** The width of the outline in CSS pixels (0 for none) */
            strokeWidth?: number;
            /** The opacity of the outline, from 0 to 1 */
            strokeOpacity?: number;
        };
    };
    /**
     * The line drawn along a guide while the pointer snaps to it; the keys given replace those
     * of the default, a 1 px `#00C7BE` line dashed `[4, 4]`
     */
    guideLine?: {
        /** The width in CSS pixels */
        width?: number;
        /** The color (a CSS color) */
        color?: string;
        /** The opacity, from 0 to 1 */
        opacity?: number;
        /** The dash pattern */
        lineStyle?: LineStyle;
        /** A dash pattern in CSS pixels, `[dash, gap]`, instead of that of `lineStyle` */
        dashArray?: number[];
    };
}

/** The options of tracing the boundary of an existing feature while drawing. */
export interface TracingOptions {
    /** Whether tracing is on; true when it is left out */
    enabled?: boolean;
}

/** The options of moving the vertices that features share. */
export interface TopologyOptions {
    /** Whether dragging a vertex also moves the vertices of other features at the same position */
    sharedVertexDrag?: boolean;
}

/** How new features, layers and groups are named ("Point 1", "Layer 2"). */
export interface AutoNameOptions {
    /** The word used for each type in the name */
    typeNames?: Partial<Record<FeatureType | 'Layer' | 'Group', string>>;
    /** Builds the name from the word of the type and the number */
    formatter?: (typeName: string, number: number) => string;
}

/**
 * The table of the strings the library returns as values: legend labels and the descriptions
 * of the snapping guides
 *
 * The library builds no such string inline; it reads it from the table of the instance, so
 * the host can show them in its own language. Pass the entries to replace as the `messages`
 * option of `createDraw`; the entries left out keep the English defaults. A value is a string,
 * or a function that formats one from numbers already turned into strings. There is no locale
 * detection and no other built-in language. The words of generated names ("Layer 1") are
 * translated through the `autoName` option, not here.
 *
 * @example
 * ```ts
 * const draw = createDraw(map, {
 *   messages: {
 *     legendOther: 'Sonstige',
 *     legendRange: (lower, upper) => `${lower} bis unter ${upper}`,
 *   },
 * });
 * ```
 */
export interface Messages {
    /** The label of the single legend entry of a `single` style rule */
    legendAll: string;
    /** The label of the legend entry for values the rule could not resolve (`other`) */
    legendOther: string;
    /** The label of the first class of a `graduated` rule (values below `upper`) */
    legendBelow: (upper: string) => string;
    /** The label of the last class of a `graduated` rule (values of `lower` or more) */
    legendAtLeast: (lower: string) => string;
    /** The label of a middle class of a `graduated` rule (`lower` or more, below `upper`) */
    legendRange: (lower: string, upper: string) => string;
    /** The description of the north-based snapping guide */
    snapNorth: string;
    /** The description of the snapping guide that extends the previous segment */
    snapExtension: string;
    /** The description of the snapping guide perpendicular to the previous segment */
    snapPerpendicular: string;
    /** The description of a snapping candidate at the intersection of two edges */
    snapIntersection: string;
}

/**
 * The options that can change while the instance runs.
 */
export interface OptionsResource {
    /** The current values. */
    get(): Readonly<RuntimeOptions>;
    /**
     * Changes the options given: snapping, tracing, shared vertices, the scale of the drawing
     * and the rest of {@link RuntimeOptions}.
     *
     * @throws `DrawError` with the code `invalidInput` when a value has the wrong type
     */
    update(patch: Partial<RuntimeOptions>): void;
}

// =============================================================================
// 領域: instance (Draw)
// =============================================================================

/**
 * A draw instance on a map: the collections and resources of the document and of this
 * client, and the members that belong to no resource.
 */
export interface Draw {
    /** The features of the document */
    readonly features: FeaturesCollection;
    /** The layers of the document */
    readonly layers: LayersCollection;
    /** The groups of the document */
    readonly groups: GroupsCollection;
    /** The large data that is drawn but not edited, outside the document */
    readonly datasets: DatasetsCollection;
    /** What this client hides without changing the document */
    readonly hidden: HiddenCollection;
    /** What this client has selected */
    readonly selection: SelectionResource;
    /** The selected vertices of one feature in this client */
    readonly vertexSelection: VertexSelectionResource;
    /** The features this client marks as being edited in a field of an extension */
    readonly editingFeatures: EditingFeaturesResource;
    /** The features drawn moved, or with vertices moved, without the document changing */
    readonly sketches: SketchesCollection;
    /** The features as this client draws them, with the sketches applied over them */
    readonly rendered: RenderedResource;
    /** The drag of the select mode going on in this client, to take features out of it */
    readonly drag: DragResource;
    /** The shape the current drawing mode is drawing, to drive it from code */
    readonly drawing: DrawingResource;
    /** The title and the description of the document */
    readonly metadata: MetadataResource;
    /** The options that can change while the instance runs */
    readonly options: OptionsResource;
    /** The whole document, to load, to follow its changes and to write out */
    readonly document: DocumentResource;
    /** The plugins, modes, feature types, overlays and providers */
    readonly extensions: ExtensionsCollections;
    /** The map the instance draws on. */
    getMap(): MaplibreMap;
    /**
     * The Store that keeps the document: the one given in the `store` option, or the one the
     * instance made (the `/store` entry). It is for an application that keeps the document
     * somewhere of its own, and for writing into the document a change made outside this
     * instance, such as one the application read from elsewhere: such a change is drawn on a
     * client that only views the document as well.
     *
     * An edit of the user is not written there: a write to the Store does not go through the
     * checks of this instance (read-only and the locks). Only a change made outside the instance
     * goes to the Store directly, with the source `'remote'`: a large document built in a Worker
     * and opened so too. The source `'load'` is that of `draw.document.load` alone.
     * The edits, the writing back of the values a change had before (`features.restore`) and the
     * bulk edits go through the resources of this instance. The state of this client (the
     * selection, the mode, read-only, the interaction lock, the hidden items, the editing and the
     * vertex selection) is read and changed through this instance, not through the Store.
     */
    getStore(): Store;
    /** The current mode. */
    getMode(): Mode;
    /**
     * Changes the mode.
     *
     * @returns False when the mode cannot be entered now
     * @throws `DrawError` with the code `notFound` when there is no mode with this name
     */
    setMode(mode: Mode): boolean;
    /** Whether the document is read-only. */
    isReadOnly(): boolean;
    /**
     * Turns read-only on or off. Turned on while a bulk edit writes in parts, it stops the
     * edit: the parts written stay, and its last change arrives with `stopped: true` (see
     * {@link FeaturesCollection}). Turned on during a drag, it ends the drag as cancelled.
     */
    setReadOnly(value: boolean): void;
    /** Whether the interaction lock is on. */
    isInteractionLocked(): boolean;
    /** Turns the interaction lock on or off. */
    setInteractionLocked(value: boolean): void;
    /**
     * Runs `fn` as one transaction: its writes arrive as one `document.changed`, with one
     * `operationId`.
     *
     * Nested transactions keep the one rule of the Store (see `StoreView.transact` of the
     * `/store` entry): a nested call with a source other than that of the outer call throws
     * `DrawError` with the code `invalidState`, and one with the same source folds into the
     * outer call. A call that gives no source takes the source of the outer `draw.transact` this
     * instance has open, and has the source `'local'` when there is none. Inside a transaction
     * opened on the Store directly (`store.transact`, not one this instance opened) it takes
     * nothing: it has the source `'local'`, and throws by the rule above unless the outer
     * source is `'local'`, so that an edit of the user never mixes into a change made outside
     * the instance being written. With `ignoreLocks`, the writes of
     * `fn` through the resources of this instance ignore the locks of the features, groups and
     * layers, as writing back the values a change had before needs; read-only still refuses them, and
     * what the user does with the pointer and the keys still respects the locks. A nested call
     * inside such a call ignores them as well.
     *
     * A bulk edit started in `fn` (`features.translate`, `deleteMany`, `restore` and the others
     * that return a promise) takes the `operationId` of this transaction: the change of the
     * transaction is the first part of the edit, and its other parts follow, as transactions of
     * their own, after `fn` returns, with the same `operationId`. It takes its source and
     * `ignoreLocks` from the transaction unless its own options give them; a source it gives
     * other than that of the transaction throws `invalidState`. A write of a few features
     * (`features.update` and the others) made in `fn` is written with the source of the
     * transaction. When `fn` throws, the
     * edit does not start. One bulk edit at most can be started in `fn`: starting a second one
     * throws `DrawError` with the code `invalidState` at once (the call throws, rather than its
     * promise rejecting), so that `fn` stops instead of making two operations silently.
     *
     * The transactions of this instance are transactions of its Store, so the same rule holds
     * between this one and the transaction of the Store (`store.transact`), whichever is inside
     * the other: a write made to the Store directly, with another source, inside an edit of the
     * user throws `invalidState`, and so does an edit of the user inside a write made directly.
     *
     * @param options - `source` names where the writes come from; `ignoreLocks` lets them
     *   change locked features, groups and layers
     * @returns What `fn` returns
     * @throws `DrawError` with the code `invalidState` when it is called inside a transaction (of
     *   this instance or of the Store) of another source, or when `fn` starts a second bulk edit
     */
    transact<T>(fn: () => T, options?: TransactOptions): T;
    /**
     * Waits for the edits of this client that are being written to the document in parts (not a
     * saving elsewhere): the bulk edits under
     * way, the one a drag that was let go of writes, and the loads. It waits for those that were
     * started and had not ended when it was called (those waiting for an earlier edit to end
     * included), and resolves once the last change of each of them has arrived, whether it was
     * written whole or stopped; at once when none is under way. An edit that starts while it
     * waits is not waited for, so that it ends however many edits follow (a key held down).
     *
     * A button that keeps the document and must not keep half an edit, or an extension that
     * writes back the values a change had before and must not write over an edit still being
     * written, waits for it first.
     *
     * @returns A promise that resolves when no edit of this client is being written
     */
    waitForWrites(): Promise<void>;
    /**
     * Subscribes to an event.
     *
     * @returns The function that unsubscribes
     */
    on<K extends keyof DrawEvents>(event: K, listener: (payload: DrawEvents[K]) => void): () => void;
    /** Unsubscribes from an event. */
    off<K extends keyof DrawEvents>(event: K, listener: (payload: DrawEvents[K]) => void): void;
    /**
     * Subscribes to the next occurrence of an event only.
     *
     * @returns The function that unsubscribes before it occurs
     */
    once<K extends keyof DrawEvents>(event: K, listener: (payload: DrawEvents[K]) => void): () => void;
    /** Whether some drawing work has not finished yet. */
    hasPendingWork(): boolean;
    /** The divisions of the stacking order, one per run of layers. */
    getLayerStack(): readonly LayerStackEntry[];
    /** Diagnostics; their fields follow the drawing and carry a weaker promise. */
    readonly debug: {
        /** The state the terrain was drawn with. */
        terrain(): TerrainDiagnostics;
    };
    /**
     * Removes the instance from the map and releases everything it holds. A second call does
     * nothing; every other method of the instance and of its collections then throws `DrawError`
     * with the code `invalidState` (`document.load` rejects with it). A bulk edit under way stops:
     * its last part is written first, with `stopped: true` and nothing more in it, so that a
     * subscriber of the Store, which may live longer than the instance, sees the operation end;
     * then its promise rejects with `invalidState`, and no more of its changes arrive. An edit
     * waiting for an earlier one to end rejects as well, and writes nothing. An operation that a
     * caller of the Store left open (see `StoreTransactOptions`) is taken as ended.
     */
    destroy(): void;
}

/** The options of {@link Draw.transact} */
export interface TransactOptions {
    /**
     * Where the writes come from. When it is left out, the source of the outer `draw.transact`
     * this instance has open, or `'local'` when there is none (see {@link Draw.transact})
     */
    source?: UpdateSource;
    /**
     * Whether the writes ignore the locks of the features, groups and layers; read-only still
     * refuses them. False when left out.
     */
    ignoreLocks?: boolean;
}

/**
 * Where a write came from, as it arrives in {@link DocumentChange.source} and in the `source` of
 * the events.
 *
 * - `local`: an operation of the user or a call of the API (the default of `draw.transact`)
 * - `silent`: a change that a subscriber keeping the edits of the user leaves out, such as the
 *   layer an application creates when the document has none
 * - `load`: a load of any format (`document.load`, `document.loadMany`), with the replacement
 *   of `mode: 'replace'`; only the instance writes it (a document opened by writing to the
 *   Store directly is written with `remote`)
 * - `batch`: a bulk change of an application or an extension, to be taken as one edit; the
 *   library does not write it
 * - `remote`: a change made outside the instance and written to the Store directly
 * - `import`: data an application or an extension loads by its own means
 *
 * Any other string can be used by an application or an extension for the changes it writes, such
 * as the values it writes back.
 */
export type UpdateSource = 'local' | 'silent' | 'load' | 'batch' | 'remote' | 'import' | (string & Record<never, never>);

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

/**
 * The title and the description of the document.
 */
export interface MetadataResource {
    /** The title, the description and the keys of the extensions. */
    get(): Metadata;
    /**
     * Changes the keys given and returns the metadata after the change: the other keys keep
     * what they have, and a key given as `undefined` is taken off.
     *
     * @returns The changed metadata, or `null` when the document is read-only
     * @throws `DrawError` with the code `invalidInput` when a key has the wrong type, or a key of
     *   an extension a value that JSON does not hold
     */
    update(patch: Partial<Metadata>): Metadata | null;
}

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

/**
 * The shape the current drawing mode is drawing, driven from code: to draw from typed
 * coordinates, from another input device, or in an automated run.
 *
 * `addVertex`, `moveTo` and `finish` act as the input they stand for would: they are made into
 * the same pointer and key events the map gives, at the point of the screen the position
 * projects to, and go the same way as that input, through the `input` receivers of the plugins
 * first and then to the mode. The position is used as it is: nothing snaps it, and the event
 * carries it as its snapped position. A mode that ignores clicks, or a plugin that consumes
 * them, ignores or consumes these as well.
 *
 * Extensions reach the same object as `ctx.drawing`.
 */
export interface DrawingResource {
    /**
     * Whether a drawing mode is drawing: a shape is in progress, or the mode is ready to place its
     * first vertex (the current mode writes features).
     */
    isActive(): boolean;
    /**
     * Whether a shape is in progress: the mode shows a shape that is not created yet. False
     * while a drawing mode waits for its first vertex.
     */
    isDrawing(): boolean;
    /**
     * Places a vertex at a position, as a click there would: the pointer moves there, then
     * clicks. It does not snap. What the click does is up to the mode: the point mode creates the
     * point, and a click on the closing vertex of a line or an area finishes it. The position is
     * exact, so the click tolerance of the pointer (10 px) does not apply: a vertex a few pixels
     * from the last one is placed, and one near the closing vertex does not finish the shape.
     * Only a position exactly equal to the closing vertex (the last vertex of a line, the first
     * of an area) finishes it, and one exactly equal to the last vertex of an area is not placed
     * again.
     *
     * @param position - The position, as `[longitude, latitude]` in degrees
     * @returns True when the mode (or a plugin) took the click; false when no drawing mode is
     *   active or nothing took it
     * @throws `DrawError` with the code `invalidInput` when the position is not two finite
     *   numbers
     */
    addVertex(position: Position): boolean;
    /**
     * Moves the pointer to a position, as a pointer move there would: the preview of the shape
     * follows it. It does not snap, and, as with `addVertex`, the position is exact. It does
     * nothing when no drawing mode is active.
     *
     * @param position - The position, as `[longitude, latitude]` in degrees
     * @throws `DrawError` with the code `invalidInput` when the position is not two finite
     *   numbers
     */
    moveTo(position: Position): void;
    /**
     * Completes the shape in progress, as a double click on its last vertex or Enter would: the
     * mode creates the feature from the vertices placed so far, as soon as there are enough of
     * them (2 for a line, 3 for an area), wherever the last one is.
     *
     * @returns True when the shape was completed; false when no shape is in progress, or the mode
     *   did not complete it (too few vertices)
     */
    finish(): boolean;
    /**
     * Cancels the shape in progress, as an Escape does while drawing: the mode drops it
     * (`ModeHandler.onCancel`), the preview is cleared and the mode stays the current one. When
     * no shape is in progress it does nothing; unlike an Escape, it does not leave the mode.
     *
     * @returns True when a shape was in progress and was cancelled
     */
    cancel(): boolean;
    /**
     * Removes the last vertex of the shape in progress.
     *
     * @returns True when a vertex was removed; false when nothing is being drawn or the mode has
     *   no vertex to remove
     */
    undoVertex(): boolean;
    /**
     * Puts back the vertex the last `undoVertex` removed.
     *
     * @returns True when a vertex was put back
     */
    redoVertex(): boolean;
}

/**
 * The name of a mode: how the input is received. One of {@link MODES}, or the name of a mode
 * added with `draw.extensions.modes.add`.
 */
export type Mode = (typeof MODES)[number] | (string & {});

/** The names of the built-in modes. */
export declare const MODES: readonly ["select", "drawPoint", "drawLine", "drawPolygon", "drawImage", "drawCircle", "drawFreehand"];

/**
 * The state the terrain was drawn with, for diagnostics. Its fields follow the drawing and
 * carry a weaker promise than the rest of the API.
 */
export interface TerrainDiagnostics {
    /** The terrain state of the last drawing */
    readonly render: {
        /** Whether the terrain was on and its elevation data usable */
        readonly active: boolean;
        /** The Mercator rectangle the elevation data covers, `[x0, y0, 1 / width, 1 / height]` */
        readonly atlasRect: readonly [number, number, number, number];
        /** The size of the elevation data in texels, `[width, height]` */
        readonly atlasSize: readonly [number, number];
        /** The factor from meters to Mercator z at the latitude of the center of the screen */
        readonly elevationScale: number;
        /** The lift above the ground in meters */
        readonly liftMeters: number;
        /** The subdivision step in meters (0 means no subdivision) */
        readonly stepMeters: number;
        /** The grid spacing of the subdivision, in Mercator units */
        readonly stepGrid: number;
        /** The generation of the subdivision; it counts the changes of the step */
        readonly generation: number;
    };
    /** How the areas were laid on the terrain in the last drawing */
    readonly drape: {
        /** Whether the analytic drape was used */
        readonly used: boolean;
        /** Why it was not used */
        readonly reason: string;
        /** The number of features laid on the drape */
        readonly featureCount: number;
        /** The number of edges */
        readonly edgeCount: number;
        /** The number of tiles drawn */
        readonly tileCount: number;
        /** The largest number of runs in one cell */
        readonly maxRunsPerCell: number;
        /** The largest number of edges in one cell */
        readonly maxEdgesPerCell: number;
        /** The largest number of edges in one tile of the view */
        readonly maxTileEdges: number;
        /** The number of cells cut short for going over the budget */
        readonly truncatedCells: number;
        /** The number of tiles that could not be evaluated and were not drawn */
        readonly unfitTiles: number;
        /** The number of runs whose cell origin was inside the feature */
        readonly insideRuns: number;
        /** The number of features left off the drape */
        readonly excluded: number;
        /** The number of features drawn without the drape */
        readonly immediate: number;
    };
}

/**
 * One division of the stacking order: the map layer that draws one run of the layer order
 * between two entries that come from outside the document.
 */
export interface LayerStackEntry {
    /** The ID of the map layer that draws the run */
    readonly layerId: string;
    /** The index in the layer order where the run starts (inclusive) */
    readonly from: number;
    /** The index in the layer order where the run ends (exclusive) */
    readonly to: number;
}

// =============================================================================
// 領域: 地物と layer と group
// =============================================================================

/**
 * The features of the document, with the standard methods of a collection, the verbs that
 * combine and split them, and the bulk edits.
 *
 * A wrong argument (an ID that does not exist, an input of the wrong shape) throws a
 * `DrawError` and changes nothing. A refusal because of the state (read-only, a lock) returns
 * `null` or `false` and changes nothing.
 *
 * Two kinds of writes:
 *
 * - The writes of a few features (`create`, `createMany`, `update`, `updateMany`, `delete`,
 *   `move`, `moveMany` and the geometry operations) are done when the method returns: reading
 *   the instance then gives the new state. A method among them whose name ends in `Many` runs
 *   in one transaction: all of it happens or none of it does.
 * - The bulk edits (`translate`, `rotate`, `scale`, `deleteMany`, `updateAll`, `duplicate` and
 *   `restore`, `layers.delete` and `layers.deleteMany`, `selection.delete`, and
 *   `document.load` and `document.loadMany`) take any number of features. Each is one
 *   operation, with one `operationId`: it writes in parts, each short enough to keep the map
 *   responsive (within 100 ms, the work of the listeners of its change included) and drawn as
 *   soon as it is written, and each part arrives as a `document.changed` with that
 *   `operationId`. Every change of the operation but the last has `hasMoreParts: true`; the
 *   last one always arrives, also when the operation stops before it has written everything
 *   (`stopped: true`). The promise resolves with {@link EditCounts} once the last change has
 *   arrived.
 *
 * What a bulk edit does with the features of its target that are not there, or change while it
 * writes, is the same for every bulk edit, and written here only:
 *
 * - An ID of the target that names nothing when the edit starts is left out and counted
 *   (`EditCounts.missingCount`); the edit goes on with the others. Only a target of the wrong
 *   shape (an ID that is not a string) is refused, and then nothing is written.
 * - A feature deleted while the edit writes, before the edit reaches it, is left out of the
 *   parts written after; nothing writes it again.
 * - A feature that is locked, or is in a locked group or layer, stays as it is and is counted
 *   (`EditCounts.lockedCount`), and the others change; so does one locked while the edit writes.
 * - The edit stops before it has written everything only when the document turns read-only or
 *   the instance is destroyed (`stopped: true`). The parts written stay.
 *
 * The bulk edits of this client are written one at a time, in the order they were started: an
 * edit started while another is being written waits until the last change of that one has
 * arrived, and then writes its own parts (a move and a turn give another result in another
 * order, so the edits are never mixed feature by feature). A write of a few features of this
 * client (a click, a key, `update` and the other methods above) does not wait: when it touches
 * features that the edit being written has not reached yet, the edit is first applied to those
 * features only, as a part of it (inside a transaction that is already open, as a part of that
 * transaction), and then the write is made. The order of the edits is kept so,
 * and the work is that of the features touched. A change written to the Store directly from
 * outside the instance is applied at once, and may arrive between two parts; a later part reads
 * the values the features have then.
 */
export interface FeaturesCollection {
    /**
     * Gets a feature by ID.
     *
     * @returns The feature, or `undefined` when there is none with this ID
     */
    get(id: string): Feature | undefined;
    /**
     * Gets features by ID, in the order of the IDs.
     *
     * @returns One entry per ID: the feature, or `undefined` when there is none with that ID
     */
    getMany(ids: readonly string[]): (Feature | undefined)[];
    /**
     * Reads one attribute of a feature (a key of its `properties`) without the feature being
     * made: what a hook that narrows many candidates reads (`Plugin.interaction.filterSelection`
     * over a box of 100,000 features), so that it makes no feature per candidate.
     *
     * @param id - The feature
     * @param key - The key of `properties`
     * @returns The value, or `undefined` when the feature does not hold the key
     * @throws `DrawError` with the code `notFound` when there is no feature with this ID
     */
    getProperty(id: string, key: string): unknown;
    /**
     * Lists the features in stacking order, from the back.
     *
     * @param filter - Keeps only the features that match every key given
     * @throws `DrawError` with the code `tooManyItems` when more than 10,000 features match; the
     *   list is never cut short. {@link FeaturesCollection.iterate} reads any number of them
     */
    list(filter?: FeatureFilter): Feature[];
    /**
     * Reads the features in stacking order, from the back, one at a time, for any number of
     * them: each feature is made as the iterator reaches it, as it is then, and is not kept by
     * the instance afterwards.
     *
     * It reads the features that match when it starts, in the order they had then. A write to
     * the document while it is under way does not stop it: a feature deleted before the
     * iterator reaches it is skipped, and a feature created after it started is not read.
     *
     * @param filter - Keeps only the features that match every key given
     * @returns An iterator of the features
     */
    iterate(filter?: FeatureFilter): IterableIterator<Feature>;
    /**
     * Counts the features.
     *
     * @param filter - Counts only the features that match every key given
     */
    count(filter?: FeatureFilter): number;
    /** Whether a feature with this ID exists. */
    has(id: string): boolean;
    /**
     * Whether the feature can be edited now: the document is not read-only, and neither the
     * feature nor its group nor its layer is locked. A refused edit returns `null` or `false`
     * for the same reasons.
     *
     * @throws `DrawError` with the code `notFound` when there is no feature with this ID
     */
    isEditable(id: string): boolean;
    /**
     * Creates a feature and returns it as it was stored.
     *
     * An Image created without its size on the map is given one as `document.load` gives the
     * image it places: `maplibre-gl-draw:createdZoom` left out is the zoom of the map now (the
     * zoom a load places an image at), so the image is shown at its size in pixels at that zoom,
     * and `maplibre-gl-draw:scale` left out is 1. An extension that places an image needs no
     * rule of its own for it. The size of the image in pixels (`maplibre-gl-draw:imageWidth` and
     * `imageHeight`) is given by the caller and cannot be left out, whether the document holds
     * the file or not.
     *
     * @returns The new feature, or `null` when the document is read-only
     * @throws `DrawError` with the code `invalidInput` when the input has the wrong shape or
     *   `acceptsId` does not take its ID or an Image has no size in pixels, `alreadyExists`
     *   when its ID is taken, `notFound` when
     *   its layer or group does not exist, or `invalidState` when the input names no layer and
     *   the document has no layer to put it in
     */
    create(input: FeatureInput): Feature | null;
    /**
     * Creates several features in one transaction: all of them or none.
     *
     * @returns The new features in the order of the inputs, or `null` when the document is
     *   read-only
     * @throws `DrawError` as {@link FeaturesCollection.create} does, for any of the inputs;
     *   nothing is created then
     */
    createMany(inputs: readonly FeatureInput[]): Feature[] | null;
    /**
     * Changes the keys given in the patch and returns the feature after the change.
     *
     * `properties` and `style` are merged key by key, and a key given as `undefined` is
     * removed.
     *
     * @returns The changed feature, or `null` when the change is refused (read-only, a lock)
     * @throws `DrawError` with the code `notFound` when there is no feature with this ID, or
     *   `invalidInput` when the patch has the wrong shape
     */
    update(id: string, patch: FeaturePatch): Feature | null;
    /**
     * Changes several features in one transaction, each with its own patch: all of them or none.
     *
     * @returns The changed features in the order of the patches, or `null` when the change is
     *   refused
     * @throws `DrawError` as {@link FeaturesCollection.update} does, for any of the patches;
     *   nothing changes then
     */
    updateMany(patches: readonly {
        id: string;
        patch: FeaturePatch;
    }[]): Feature[] | null;
    /**
     * Writes the same patch to all the features of the target, as `update` writes it to one: a
     * bulk edit, in parts (see {@link FeaturesCollection}). A feature for which the patch changes
     * nothing is not counted as changed. As with `update`, a patch of `locked` and `visible`
     * alone is written to the locked features too.
     *
     * @param target - The features
     * @param patch - The keys to change, the same for every feature
     * @param options - Where the writes come from, and whether they ignore the locks
     * @returns The counts of the edit, or `null` when it is refused (read-only, or every feature
     *   is locked)
     * @throws `DrawError` (the promise rejects) with the code `invalidInput` when the target or
     *   the patch has the wrong shape; nothing changes then
     */
    updateAll(target: FeatureTarget, patch: FeaturePatch, options?: EditOptions): Promise<EditCounts | null>;
    /**
     * Deletes a feature.
     *
     * @returns True when it was deleted, false when the deletion is refused (read-only, a lock)
     * @throws `DrawError` with the code `notFound` when there is no feature with this ID
     */
    delete(id: string): boolean;
    /**
     * Deletes every feature of the target: a bulk edit, in parts (see
     * {@link FeaturesCollection}). A group whose last feature goes is deleted with it. The
     * selection, the editing and the items this client hides let go of the features deleted.
     *
     * @param target - The features
     * @param options - Where the writes come from, and whether they ignore the locks
     * @returns The counts of the edit, or `null` when it is refused (read-only, or every feature
     *   is locked)
     * @throws `DrawError` (the promise rejects) with the code `invalidInput` when the target has
     *   the wrong shape; nothing is deleted then
     */
    deleteMany(target: FeatureTarget, options?: EditOptions): Promise<EditCounts | null>;
    /**
     * Moves a feature to another layer, into a group or out of its group; `index` of the
     * target sets its position there.
     *
     * @returns True when it moved, false when the move is refused (read-only, a lock)
     * @throws `DrawError` with the code `notFound` when the feature or the target does not
     *   exist
     */
    move(id: string, to: MoveTarget): boolean;
    /**
     * Moves several features in one transaction, keeping their order: all of them or none.
     *
     * @returns True when they moved, false when the move is refused
     * @throws `DrawError` with the code `notFound` when one of the features or the target does
     *   not exist; nothing moves then
     */
    moveMany(ids: readonly string[], to: MoveTarget): boolean;
    /**
     * Moves features as a move from one point to another moves them, the same for every
     * feature: a bulk edit, in parts (see {@link FeaturesCollection}).
     *
     * The built-in interactions write with this method: a drag of the selection calls it once,
     * when the pointer is let go of, on the features the drag moves then (`featureIds` of
     * `drag.ended`: those deleted or taken out of the drag meanwhile are not among them; the
     * drag itself writes nothing, see `drag.changed`), and a move with the arrow keys calls it
     * for every key, on `{ selection: true }`. The positions are computed by the provider set
     * with `draw.extensions.setTransformProvider`, or by the built-in computation (see
     * {@link Translation}).
     *
     * @param target - The features to move; none gives counts of 0
     * @param translation - The point the features move from and the point they move to
     * @param options - Where the writes come from, and whether they ignore the locks
     * @returns The counts of the edit, or `null` when the move is refused (read-only, or every
     *   feature is locked)
     * @throws `DrawError` (the promise rejects) with the code `invalidInput` when the target has
     *   the wrong shape, a position is not finite or has a latitude outside -90 to 90, or the
     *   provider does not compute the move; nothing moves then
     */
    translate(target: FeatureTarget, translation: Translation, options?: EditOptions): Promise<EditCounts | null>;
    /**
     * Turns features around a center by an angle, counterclockwise seen from above: a bulk
     * edit, in parts (see {@link FeaturesCollection}).
     *
     * The built-in interactions write with this method: a drag of the rotate handle of the
     * selection calls it once, when the pointer is let go of, on the features the drag changes
     * then (`featureIds` of `drag.ended`). The positions, and the fields of
     * rotation and direction of the features that have them (see
     * {@link FeatureTypeDefinition.transformFields}), are computed by the provider set with
     * `draw.extensions.setTransformProvider`, or by the built-in computation.
     *
     * An edit that turns a single feature of a `Point` geometry with a field of rotation turns it
     * about its position (see {@link TransformFields.rotationDegreesKey}): the instance puts that
     * position in `center` before the computation is called, so that a provider needs not know
     * how many features the edit has.
     *
     * @param target - The features to turn; none gives counts of 0
     * @param rotation - The center, as `[longitude, latitude]` in degrees, and the angle
     * @param options - Where the writes come from, and whether they ignore the locks
     * @returns The counts of the edit, or `null` when the rotation is refused (read-only, or
     *   every feature is locked)
     * @throws `DrawError` (the promise rejects) with the code `invalidInput` when the target has
     *   the wrong shape, the center or the angle is not finite, the center has a latitude outside
     *   -90 to 90, or the provider does not compute the rotation; nothing turns then
     */
    rotate(target: FeatureTarget, rotation: Rotation, options?: EditOptions): Promise<EditCounts | null>;
    /**
     * Scales features from a center, by a factor along the east and one along the north: a bulk
     * edit, in parts (see {@link FeaturesCollection}).
     *
     * The built-in interactions write with this method: a drag of a resize handle of the
     * selection calls it once, when the pointer is let go of, on the features the drag changes
     * then (`featureIds` of `drag.ended`). The positions, and the field of
     * size of the features that have one (see {@link FeatureTypeDefinition.transformFields}),
     * are computed by the provider set with `draw.extensions.setTransformProvider`, or by the
     * built-in computation.
     *
     * @param target - The features to scale; none gives counts of 0
     * @param scaling - The center, as `[longitude, latitude]` in degrees, and the factors
     * @param options - Where the writes come from, and whether they ignore the locks
     * @returns The counts of the edit, or `null` when the change is refused (read-only, or every
     *   feature is locked)
     * @throws `DrawError` (the promise rejects) with the code `invalidInput` when the target has
     *   the wrong shape, the center is not finite or has a latitude outside -90 to 90, a factor
     *   is not a finite number above 0, or the provider does not compute the scaling; nothing
     *   changes then
     */
    scale(target: FeatureTarget, scaling: Scaling, options?: EditOptions): Promise<EditCounts | null>;
    /**
     * Copies every feature of the target: a bulk edit, in parts (see
     * {@link FeaturesCollection}). Each copy gets a new ID (`generateId`) and the values of its
     * original as they are, its name included, and goes just in front of the original, in its
     * layer and its group. When the target holds every feature of a group, the copies of those
     * features make a new group instead, just in front of that group, with the values of the
     * group (its name, its lock); when the target holds only some features of a group, their
     * copies go into the group itself. With `offset`, the copies are moved as `translate` moves
     * features. The copies can be read by their IDs in `EditCounts.createdIds`, and are not
     * selected.
     *
     * A locked feature is copied too: the copy is a new feature, and has the lock of its
     * original.
     *
     * @param target - The features to copy
     * @param options - Where the writes come from, and the move of the copies
     * @returns The counts of the edit, or `null` when it is refused (read-only)
     * @throws `DrawError` (the promise rejects) with the code `invalidInput` when the target has
     *   the wrong shape; nothing is copied then
     */
    duplicate(target: FeatureTarget, options?: DuplicateOptions): Promise<EditCounts | null>;
    /**
     * Writes back the values features had before a change, as the changes of a subscriber that
     * asked for them carry them (`previousValues` of {@link DocumentChange}, see
     * `draw.document.subscribe`): a bulk edit, in parts (see {@link FeaturesCollection}). The
     * features take back what the change did, and only that, onto what they are now:
     *
     * - The geometry is taken back vertex by vertex, as the values keep it (see
     *   {@link FeatureValues}): a vertex the change moved goes back to where it was, a vertex it
     *   added is deleted, and a vertex it deleted comes back; the other vertices, such as those
     *   another edit moved since, stay as they are. The vertices are followed from the change to
     *   now as {@link VertexRef} says; one that cannot be followed is left as it is and counted
     *   (`EditCounts.skippedVertexCount`). A change that changed the whole geometry (a move, a
     *   rotation, a scaling, a geometry given whole, an edit that changed the number of
     *   rings) takes the whole geometry back.
     * - Any other value (an attribute, a key of the look, a flag, the place) is written back key
     *   by key: a key the change did not write keeps what it has now.
     * - A feature the change deleted comes back where it was, in its layer and its group, while
     *   the values keep it ({@link FeaturesCollection.releaseValues}). (Deleting features does
     *   not delete the embedded files they name, so there is no file to bring back with them.) A
     *   feature whose group is not there goes into the layer of the group. A feature the change
     *   created is deleted.
     * - The groups, which hold the features, are written back with them: a group the change
     *   deleted comes back where it was, a group it created is deleted, a group it moved goes
     *   back to where it was, and a group whose values it changed (its name, its visibility,
     *   its lock) takes them back.
     *
     * The values of several changes are written back from the last to the first, so the values
     * of the changes of one bulk edit, given in the order they arrived, take the whole edit back.
     * The features that come back are told as created (`ChangedIds.created`, and
     * `feature.created` on the main entry).
     *
     * The layers are not written back here: the change carries their values before as objects
     * (`layers` of {@link DocumentChange}), and the caller writes them back with `draw.layers`
     * (a layer created again, its values, the stacking order). A layer the change deleted is
     * created again by the caller first, with `layers.create` and the `index` it had in the
     * stacking order (`layers.orderChanged.previous` of the change). The metadata, which is
     * neither a feature, a group nor a layer, is not written back here either: the caller
     * writes it back with `draw.metadata` (`metadata.previous` of the change).
     *
     * It is an edit of the document like any other: read-only refuses it, and a lock of a
     * feature, its group or its layer leaves the feature as it is unless `ignoreLocks` is given,
     * as writing back what an edit of the user did needs. Its own changes carry, for a subscriber
     * that asks, the values the features had before it, which written back make the change
     * again.
     *
     * @param values - The values, in the order their changes arrived
     * @param options - Where the writes come from (`'local'` when left out; an extension that
     *   writes back the edits of the user names its own source), and whether they ignore the
     *   locks
     * @returns The counts of the edit, or `null` when it is refused (read-only, or every feature
     *   is locked)
     * Values are used up by what is written back of them. A `restore` that stopped
     * (`stopped: true`) leaves the rest of its values: given to `restore` again, the same values
     * write the rest that was not written (the `restore` goes on from where it stopped). Values
     * written back whole are used up: given to `restore` again, they make it reject with
     * `invalidInput`. A `restore` refused (`null`) writes nothing and uses nothing. The changes
     * of a `restore` carry, for a subscriber that asks, the values that take back what it wrote
     * (only that, for one that stopped): to make the change again, give those.
     *
     * @throws `DrawError` (the promise rejects) with the code `invalidInput` when a value is not
     *   one this instance gave to this subscriber, was let go of, or was written back whole, or
     *   `notFound` when it names a layer that is not there; nothing is written then
     */
    restore(values: readonly FeatureValues[], options?: EditOptions): Promise<EditCounts | null>;
    /**
     * Lets go of what values of features keep: the features and groups a change deleted,
     * kept so that `restore` can bring them back. Every subscriber that asks for the values
     * before gets values of its own for each change, and a deleted feature is kept until all the
     * values that keep it are let go of; it then goes for good, and its ID may be used again.
     *
     * A subscriber that asks for the values before calls it for every value it no longer needs,
     * also when it unsubscribes: unsubscribing lets go of nothing. Values let go of are no longer
     * written back: given to `restore`, they make it reject with `invalidInput`. Letting go of
     * values that a stopped `restore` left lets go of the rest it did not write too. Values let
     * go of while a `restore` writes them are let go of once that `restore` has ended. Values let go of
     * twice, or that keep nothing, are left as they are.
     */
    releaseValues(values: readonly FeatureValues[]): void;
    /**
     * The look a feature is drawn with: the default, the layer rule and the style of the
     * feature put on top of each other.
     *
     * The colors of the `style` option and of the style of the feature are the strings they
     * were given, alpha included; the color of a layer rule is `#rrggbb`, as
     * {@link evaluateStyleRule} gives it, and a default is `#rrggbb`.
     *
     * @returns The look, or `undefined` when there is no feature with this ID
     */
    getAppliedStyle(id: string): FeatureStyleResolved | undefined;
    /**
     * Joins areas into one feature and returns it; the result replaces the features given.
     *
     * @returns The new feature, or `null` when the operation is refused (read-only, a lock)
     * @throws `DrawError` with the code `notFound` when one of the IDs does not exist, or
     *   `invalidInput` when fewer than two areas are given or one of the features is not an
     *   area
     */
    union(ids: readonly string[]): Feature | null;
    /**
     * Subtracts other areas from an area and returns the result; the result replaces the area
     * subtracted from, and the areas subtracted stay.
     *
     * @param id - The area to subtract from
     * @param subtractIds - The areas to subtract
     * @returns The resulting feature, or `null` when the operation is refused (read-only, a lock)
     * @throws `DrawError` with the code `notFound` when one of the IDs does not exist, or
     *   `invalidInput` when one of the features is not an area
     */
    difference(id: string, subtractIds: readonly string[]): Feature | null;
    /**
     * Keeps the part where areas overlap and returns it; the result replaces the features given.
     *
     * @returns The resulting feature, or `null` when the operation is refused (read-only, a lock)
     * @throws `DrawError` with the code `notFound` when one of the IDs does not exist, or
     *   `invalidInput` when fewer than two areas are given or one of the features is not an
     *   area
     */
    intersection(ids: readonly string[]): Feature | null;
    /**
     * Splits an area along a line and returns the features it made.
     *
     * @param id - The area to split
     * @param lineId - The line to split along
     * @returns The new features, or `null` when the operation is refused (read-only, a lock)
     * @throws `DrawError` with the code `notFound` when one of the IDs does not exist, or
     *   `invalidInput` when the features are not an area and a line
     */
    split(id: string, lineId: string): Feature[] | null;
    /**
     * Creates the areas around features.
     *
     * @param ids - The features to surround
     * @param options - `distanceMeters` is the distance of the outline from the features, and
     *   `segments` the number of segments of a full circle, as in the buffer of the geometry
     *   entry
     * @returns The new features, or `null` when the operation is refused (read-only, a lock)
     * @throws `DrawError` with the code `notFound` when one of the IDs does not exist, or
     *   `invalidInput` when the distance is not a finite number
     */
    buffer(ids: readonly string[], options: {
        distanceMeters: number;
        segments?: number;
    }): Feature[] | null;
}

/**
 * The layers of the document, with the standard methods of a collection, the stacking order
 * and the active layer.
 *
 * A wrong argument (an ID that does not exist, an input of the wrong shape) throws a
 * `DrawError` and changes nothing. A refusal because of the state (read-only, a lock) returns
 * `null` or `false` and changes nothing. A method whose name ends in `Many` runs in one
 * transaction: all of it happens or none of it does, except `deleteMany`, which is a bulk edit
 * as `delete` is.
 *
 * The change of a creation and that of a deletion of a layer always carry the change of the
 * stacking order (`layers.orderChanged` of {@link DocumentChange}), so that the position of a
 * layer deleted can be read from the change and given back to `create` as `index`.
 */
export interface LayersCollection {
    /**
     * Gets a layer by ID.
     *
     * @returns The layer, or `undefined` when there is none with this ID
     */
    get(id: string): Layer | undefined;
    /**
     * Gets layers by ID, in the order of the IDs.
     *
     * @returns One entry per ID: the layer, or `undefined` when there is none with that ID
     */
    getMany(ids: readonly string[]): (Layer | undefined)[];
    /**
     * Lists the layers in stacking order, from the back.
     *
     * @param filter - Keeps only the layers that match every key given
     */
    list(filter?: LayerFilter): Layer[];
    /**
     * Counts the layers.
     *
     * @param filter - Counts only the layers that match every key given
     */
    count(filter?: LayerFilter): number;
    /** Whether a layer with this ID exists. */
    has(id: string): boolean;
    /**
     * Counts the items of a layer: the things that stand in its stacking order, that is its
     * groups (one item each, however many features they hold) and the features that are in no
     * group. The features in its groups are not counted: `features.count({ layerId })` counts
     * every feature of the layer.
     *
     * @throws `DrawError` with the code `notFound` when there is no layer with this ID
     */
    countItems(id: string): number;
    /**
     * The IDs of the items of a layer (its groups and the features that are in no group, as
     * `countItems` counts them) at a range of positions, from the back: an ID names a group or a
     * feature, and `groups.has` tells which. `features.move` and `groups.move` change the order.
     * A range that goes past the front ends there.
     *
     * The positions are those of the moment it is called: a write between two calls (an item
     * created, deleted or moved) shifts them, so reading a layer a range at a time with writes in
     * between can skip items or read them twice. `features.iterate` reads every feature of a
     * layer once, whatever is written meanwhile.
     *
     * @param range - The positions, 0 at the back: from `start`, up to `end` and without it
     * @returns The IDs, from the back
     * @throws `DrawError` with the code `notFound` when there is no layer with this ID,
     *   `invalidInput` when the range is not two integers from 0 with `start <= end`, or
     *   `tooManyItems` when it spans more than 10,000 positions
     */
    listItemIds(id: string, range: IndexRange): string[];
    /**
     * Creates a layer and returns it as it was stored.
     *
     * The ID of a layer this instance had and a change deleted is taken as it is, without
     * `acceptsId`: it is how a layer deleted is created again, before `features.restore` brings
     * its features back.
     *
     * @returns The new layer, or `null` when the document is read-only
     * @throws `DrawError` with the code `invalidInput` when the input has the wrong shape, or
     *   `alreadyExists` when its ID is taken
     */
    create(input: LayerInput): Layer | null;
    /**
     * Creates several layers in one transaction: all of them or none.
     *
     * @returns The new layers in the order of the inputs, or `null` when the document is
     *   read-only
     * @throws `DrawError` as {@link LayersCollection.create} does, for any of the inputs;
     *   nothing is created then
     */
    createMany(inputs: readonly LayerInput[]): Layer[] | null;
    /**
     * Changes the keys given in the patch and returns the layer after the change.
     *
     * @returns The changed layer, or `null` when the change is refused (read-only, a lock)
     * @throws `DrawError` with the code `notFound` when there is no layer with this ID, or
     *   `invalidInput` when the patch has the wrong shape
     */
    update(id: string, patch: LayerPatch): Layer | null;
    /**
     * Changes several layers in one transaction: all of them or none.
     *
     * @returns The changed layers in the order of the patches, or `null` when the change is
     *   refused
     * @throws `DrawError` as {@link LayersCollection.update} does, for any of the patches;
     *   nothing changes then
     */
    updateMany(patches: readonly {
        id: string;
        patch: LayerPatch;
    }[]): Layer[] | null;
    /**
     * Deletes a layer with its features and groups: a bulk edit, in parts (see
     * {@link FeaturesCollection}), however many features it holds. Its features and groups are
     * deleted in parts, and the layer itself in the last part. From its first part on, the
     * layer takes no other write of this client, as if it were locked, also from a write that
     * ignores the locks: such a write returns `null` or `false`. A feature that comes into the
     * layer meanwhile (from another client) is deleted in the last part too. The selection of
     * the layer (`selection.delete`) deletes it the same way.
     *
     * Its changes list the features in `features.deleted` and the layer in `layers.deleted`, and
     * the values before (for a subscriber that asks) keep the features, so that
     * `features.restore` brings them back once the layer is created again. When the edit stops
     * (read-only), the layer stays with the features not deleted yet.
     *
     * @param options - Where the writes come from, and whether they ignore the locks
     * @returns The counts of the edit (`changedCount` is the number of features deleted), or
     *   `null` when the deletion is refused: read-only, or the layer, one of its groups or one
     *   of its features is locked when the edit starts (nothing is deleted then; a feature
     *   locked while the edit writes stays, and the layer stays with it)
     */
    delete(id: string, options?: EditOptions): Promise<EditCounts | null>;
    /**
     * Deletes several layers as one bulk edit, each as `delete` deletes one.
     *
     * @param options - Where the writes come from, and whether they ignore the locks
     * @returns The counts of the edit, or `null` when the deletion is refused: none is deleted
     *   when one of them is refused
     * @throws `DrawError` (the promise rejects) with the code `invalidInput` when the IDs are
     *   not an array of strings; nothing is deleted then
     */
    deleteMany(ids: readonly string[], options?: EditOptions): Promise<EditCounts | null>;
    /**
     * Changes the stacking order.
     *
     * Besides the layers, the order may place the datasets whose order is `layerOrder` and the
     * entries the `isExternalEntry` option recognizes. An entry of the stacking order that is
     * not a layer and is left out of `order` keeps its position; the entries given fill the
     * other positions in the order given, and those new to the stacking order go to the front.
     *
     * @param order - The IDs of every layer, and of the other entries to place, from the back
     * @returns True when the order changed, false when the change is refused (read-only)
     * @throws `DrawError` with the code `invalidInput` when the IDs do not list every layer
     *   or list an ID twice, or `notFound` when one of them is not a layer, a `layerOrder`
     *   dataset or an entry the `isExternalEntry` option recognizes
     */
    reorder(order: readonly string[]): boolean;
    /**
     * The stacking order as {@link LayersCollection.reorder} takes it: the IDs of every layer and
     * of the other entries placed on it (the datasets whose order is `layerOrder` and the
     * entries the `isExternalEntry` option recognizes), from the back. An entry that is no longer
     * one of those is left out, so the array can be changed and given to `reorder` as it is.
     *
     * @returns A frozen array of IDs
     */
    getOrder(): readonly string[];
    /**
     * The layer that drawn features go into.
     *
     * @returns The active layer, or `null` when there is no layer
     */
    getActive(): Layer | null;
    /**
     * Changes the layer that drawn features go into.
     *
     * @returns True when it changed, false when the layer cannot take drawn features (a lock)
     * @throws `DrawError` with the code `notFound` when there is no layer with this ID
     */
    setActive(id: string): boolean;
}

/**
 * The groups of the document, with the standard methods of a collection and the verbs that
 * move them.
 *
 * A wrong argument (an ID that does not exist, an input of the wrong shape) throws a
 * `DrawError` and changes nothing. A refusal because of the state (read-only, a lock) returns
 * `null` or `false` and changes nothing. A method whose name ends in `Many` runs in one
 * transaction: all of it happens or none of it does.
 */
export interface GroupsCollection {
    /**
     * Gets a group by ID.
     *
     * @returns The group, or `undefined` when there is none with this ID
     */
    get(id: string): Group | undefined;
    /**
     * Gets groups by ID, in the order of the IDs.
     *
     * @returns One entry per ID: the group, or `undefined` when there is none with that ID
     */
    getMany(ids: readonly string[]): (Group | undefined)[];
    /**
     * Lists the groups in stacking order, from the back.
     *
     * @param filter - Keeps only the groups that match every key given
     * @throws `DrawError` with the code `tooManyItems` when more than 10,000 groups match; the
     *   list is never cut short. {@link GroupsCollection.iterate} reads any number of them
     */
    list(filter?: GroupFilter): Group[];
    /**
     * Reads the groups in stacking order, from the back, one at a time, for any number of them.
     *
     * It reads the groups that match when it starts, as {@link FeaturesCollection.iterate} reads
     * the features: a group deleted before the iterator reaches it is skipped, and a group
     * created after it started is not read.
     *
     * @param filter - Keeps only the groups that match every key given
     * @returns An iterator of the groups
     */
    iterate(filter?: GroupFilter): IterableIterator<Group>;
    /**
     * Counts the groups.
     *
     * @param filter - Counts only the groups that match every key given
     */
    count(filter?: GroupFilter): number;
    /** Whether a group with this ID exists. */
    has(id: string): boolean;
    /**
     * Counts the features of a group.
     *
     * @throws `DrawError` with the code `notFound` when there is no group with this ID
     */
    countFeatures(id: string): number;
    /**
     * The IDs of the features of a group at a range of positions, from the back. A range that
     * goes past the front ends there. As with `layers.listItemIds`, a write between two calls
     * shifts the positions.
     *
     * @param range - The positions, 0 at the back: from `start`, up to `end` and without it
     * @returns The IDs, from the back
     * @throws `DrawError` with the code `notFound` when there is no group with this ID,
     *   `invalidInput` when the range is not two integers from 0 with `start <= end`, or
     *   `tooManyItems` when it spans more than 10,000 positions
     */
    listFeatureIds(id: string, range: IndexRange): string[];
    /**
     * Creates a group of features and returns it as it was stored.
     *
     * @returns The new group, or `null` when the document is read-only
     * @throws `DrawError` with the code `notFound` when one of the features does not exist,
     *   `invalidInput` when the features are not in the same layer, or `alreadyExists` when
     *   its ID is taken
     */
    create(input: GroupInput): Group | null;
    /**
     * Creates several groups in one transaction: all of them or none.
     *
     * @returns The new groups in the order of the inputs, or `null` when the document is
     *   read-only
     * @throws `DrawError` as {@link GroupsCollection.create} does, for any of the inputs;
     *   nothing is created then
     */
    createMany(inputs: readonly GroupInput[]): Group[] | null;
    /**
     * Changes the keys given in the patch and returns the group after the change.
     *
     * @returns The changed group, or `null` when the change is refused (read-only, a lock)
     * @throws `DrawError` with the code `notFound` when there is no group with this ID, or
     *   `invalidInput` when the patch has the wrong shape
     */
    update(id: string, patch: GroupPatch): Group | null;
    /**
     * Changes several groups in one transaction: all of them or none.
     *
     * @returns The changed groups in the order of the patches, or `null` when the change is
     *   refused
     * @throws `DrawError` as {@link GroupsCollection.update} does, for any of the patches;
     *   nothing changes then
     */
    updateMany(patches: readonly {
        id: string;
        patch: GroupPatch;
    }[]): Group[] | null;
    /**
     * Deletes a group; its features stay in the layer.
     *
     * @returns True when it was deleted, false when the deletion is refused (read-only, a lock)
     * @throws `DrawError` with the code `notFound` when there is no group with this ID
     */
    delete(id: string): boolean;
    /**
     * Deletes several groups in one transaction: all of them or none. Their features stay in
     * their layers.
     *
     * @returns True when they were deleted, false when the deletion is refused
     * @throws `DrawError` with the code `notFound` when one of the IDs does not exist; nothing
     *   is deleted then
     */
    deleteMany(ids: readonly string[]): boolean;
    /**
     * Moves a group to another layer, or to another position in its layer.
     *
     * @returns True when it moved, false when the move is refused (read-only, a lock)
     * @throws `DrawError` with the code `notFound` when the group or the target does not
     *   exist, or `invalidInput` when the target is a group
     */
    move(id: string, to: MoveTarget): boolean;
    /**
     * Moves several groups in one transaction: all of them or none.
     *
     * @returns True when they moved, false when the move is refused
     * @throws `DrawError` as {@link GroupsCollection.move} does, for any of the groups; nothing
     *   moves then
     */
    moveMany(ids: readonly string[], to: MoveTarget): boolean;
}

/**
 * The IDs of the features, groups and layers this client hides. Hiding changes only what this
 * client draws; the document and its `visible` flags stay as they are.
 */
export interface HiddenCollection {
    /** Whether this client hides the item with this ID. */
    get(id: string): boolean;
    /** The IDs this client hides, as they are now. */
    list(): IdSet;
    /** Counts the IDs this client hides. */
    count(): number;
    /** Whether this client hides the item with this ID; the same as {@link HiddenCollection.get}. */
    has(id: string): boolean;
    /**
     * Hides a feature, a group or a layer in this client only; the document does not change.
     *
     * @throws `DrawError` with the code `notFound` when the ID is not a feature, a group or a
     *   layer of the document
     */
    add(id: string): void;
    /**
     * Hides several items in this client only, all of them or none.
     *
     * @throws `DrawError` with the code `notFound` when one of the IDs is not in the document;
     *   nothing is hidden then
     */
    addMany(ids: readonly string[]): void;
    /**
     * Shows an item this client hid.
     *
     * @returns False when this client did not hide it
     */
    remove(id: string): boolean;
    /**
     * Shows several items this client hid, all at once.
     *
     * @returns False when this client hid none of them
     */
    removeMany(ids: readonly string[]): boolean;
    /** Shows every item this client hid. */
    clear(): void;
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

/**
 * The type of a feature: a built-in type, or the name of a custom type.
 *
 * The built-in types are Point, LineString, Polygon, MultiPoint, MultiLineString,
 * MultiPolygon, Circle, Freehand and Image. Any other string names a custom type.
 */
export type FeatureType = 'Point' | 'LineString' | 'Polygon' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon' | 'Circle' | 'Freehand' | 'Image' | (string & {});

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
    /** The rotation of an image, in degrees counterclockwise seen from above */
    'maplibre-gl-draw:rotation'?: number;
    /** The factor of the size of an image, 1 for the size it was placed at */
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

/** The prefix of the keys of `properties` that hold the values of the library. */
export declare const DRAW_PROPERTY_PREFIX: "maplibre-gl-draw:";

/**
 * Whether a key of `properties` holds a value of the library, so that an attribute panel can
 * leave it out.
 *
 * @param key - A key of `properties`
 * @returns True when the key starts with {@link DRAW_PROPERTY_PREFIX}
 */
export declare function isDrawProperty(key: string): boolean;

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
export type MoveTarget = {
    layerId: string;
    index?: number;
} | {
    groupId: string | null;
    index?: number;
};

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

/**
 * How `translate` moves the features: as the move from one point to another moves them (for a
 * drag, the point the drag started at and the point the pointer is at).
 *
 * The built-in computation keeps the shapes and sizes on the ground: every position is moved on
 * the WGS 84 ellipsoid so that it keeps its offset in meters, east and north, from `from` as it
 * stands at `to` (the east, north and up axes of the earth at each of the two points). It is not
 * the difference of the longitudes and latitudes added to them.
 *
 * Longitudes are not brought back into -180 to 180. The features move the way the numbers of
 * `from` and `to` say: from 179.5 to 180.5 is one degree east, across the antimeridian, and
 * from 179.5 to -179.5 is 359 degrees west. Each longitude comes out as the value nearest to
 * that move, so that a feature stays in one piece. A position carried over a pole comes out on
 * the other side of it, half a turn of longitude away: a feature that lies across a pole after
 * an operation is drawn across the world by a map, and the computation does not prevent it
 * (the same holds for {@link Rotation} and {@link Scaling}).
 */
export interface Translation {
    /** The point the features move from, as `[longitude, latitude]` in degrees (WGS 84) */
    from: Position;
    /** The point they move to, as `[longitude, latitude]` in degrees (WGS 84) */
    to: Position;
}

/**
 * How `rotate` turns the features. The built-in computation turns them on the WGS 84 ellipsoid,
 * in the east and north axes of the center.
 */
export interface Rotation {
    /** The center, as `[longitude, latitude]` in degrees (WGS 84); it stays where it is */
    center: Position;
    /**
     * The angle to turn by, in degrees, counterclockwise seen from above (from the east toward
     * the north); a negative angle turns clockwise
     */
    counterclockwiseDegrees: number;
}

/**
 * How `scale` scales the features. A drag of a corner handle gives two factors of its own, and
 * a drag of a side handle a factor of 1 along the other side. In a drag of a corner handle and
 * of a side handle alike, `sizeFactor` is the distance from the pointer to the point that stays
 * (the opposite corner, or the middle of the opposite side) divided by that distance when the
 * drag started; a drag gives no factor below 0.1.
 *
 * The built-in computation scales the offsets in meters along the east and the north axes of
 * the center, in the plane that touches the WGS 84 ellipsoid there: a position 100 m east of the
 * center goes 200 m east of it with an `eastFactor` of 2. Far from the center the distances
 * along the ground differ a little from the factor (100 km east scaled by 2 comes out about 40 m
 * short of 200 km). A factor of 1 changes nothing along its axis.
 */
export interface Scaling {
    /** The center, as `[longitude, latitude]` in degrees (WGS 84); it stays where it is */
    center: Position;
    /** The factor along the east, above 0 (1 for no change); 2 doubles the width and 0.5 halves it */
    eastFactor: number;
    /** The factor along the north, above 0 (1 for no change) */
    northFactor: number;
    /**
     * The factor of the size of the features that have one (the scale of an image, the radius
     * of a circle, the field of size a type declares), above 0 (1 for no change). Such a feature
     * keeps its shape: its positions move from the center by this factor along both the east and
     * the north, in place of `eastFactor` and `northFactor`.
     */
    sizeFactor: number;
}

/**
 * A move, a rotation or a scaling of features (not a change of the system of coordinates): what
 * `translate`, `rotate` and `scale` take, with the kind of the operation. A drag carries it in
 * `drag.changed`, and the provider set with `draw.extensions.setTransformProvider` computes it.
 */
export type TransformOperation = ({
    kind: 'translate';
} & Translation) | ({
    kind: 'rotate';
} & Rotation) | ({
    kind: 'scale';
} & Scaling);

/**
 * The features a bulk edit acts on (`features.translate`, `deleteMany`, `updateAll` and the
 * others):
 *
 * - an array of IDs, or an {@link IdSet} (the selection, the features of a load, of a change)
 * - `{ selection: true }`: the features selected in this client when the edit starts, or the
 *   features of the groups and layers selected
 * - `{ layerIds }`: every feature of the layers, with those of their groups, without an array
 *   of their IDs (one layer is a list of one). The same form names the features of layers in
 *   `selection.set` and in a sketch
 *
 * The target is read once, when the edit starts: a feature created afterwards is not part of
 * it. What happens to an ID that names nothing, and to a feature deleted or locked meanwhile,
 * is written in {@link FeaturesCollection}.
 */
export type FeatureTarget = readonly string[] | IdSet | {
    /** Always true: the features selected in this client when the edit starts */
    readonly selection: true;
} | {
    readonly layerIds: readonly string[];
};

/** The options of a bulk edit. */
export interface EditOptions {
    /**
     * Where the writes come from (an {@link UpdateSource}, not a source of data of the map), as
     * the changes carry it; `'local'` when left out, or the source
     * of the `draw.transact` the edit is started in. Inside a `draw.transact`, a source other than
     * that of the transaction throws `DrawError` with the code `invalidState`
     */
    source?: UpdateSource;
    /**
     * Whether the writes ignore the locks of the features, groups and layers, as writing back the
     * values a change had before needs; read-only still refuses them. False when left out, or
     * that of the `draw.transact` the edit is started in.
     */
    ignoreLocks?: boolean;
}

/** The options of `features.duplicate`. */
export interface DuplicateOptions extends EditOptions {
    /**
     * How far the copies are moved from their originals, given as two points as `translate` takes
     * it (a {@link Translation}, in degrees); they stand on their originals when it is left out
     */
    offset?: Translation;
}

/**
 * What a bulk edit did (`features.translate`, `deleteMany`, `updateAll`, `duplicate`,
 * `restore`, `layers.delete`, `document.load` and the others): the counts of the features,
 * never the features themselves.
 */
export interface EditCounts {
    /** The number of the operation, as its changes carry it (`DocumentChange.operationId`) */
    operationId: number;
    /** The number of features the edit changed (created, for a copy or a load): never a locked one */
    changedCount: number;
    /**
     * The number of features that stayed as they were because they, their group or their layer
     * are locked, when the edit started or while it wrote
     */
    lockedCount: number;
    /**
     * The number of IDs of the target that named nothing when the edit started, and were left
     * out (see {@link FeaturesCollection})
     */
    missingCount: number;
    /**
     * True when the edit stopped before it had written everything: the document turned
     * read-only, or the instance was destroyed. The parts written stay.
     */
    stopped: boolean;
    /** The features the edit created (the copies of `duplicate`, the features of a load) */
    createdIds?: IdSet;
    /**
     * For `features.restore`: the number of vertices it left as they are, because the edits
     * made since changed their rings so that they could not be followed from the change to now
     * (see {@link VertexRef}), and left as they are
     */
    skippedVertexCount?: number;
}

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
export declare function createIdSet(ids: Iterable<string>): IdSet;

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
 * scaling, a geometry given whole, an edit that changed the number of rings). The
 * instance has the geometry before and after every change, and tells the vertices changed by
 * comparing them as {@link VertexRef} says. The values of a move of 100,000 features are kept
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

// =============================================================================
// 領域: 選択
// =============================================================================

/**
 * The selection of this client: features, groups or layers, one type at a time, and the
 * verbs that act on what is selected.
 */
export interface SelectionResource {
    /**
     * The type and the IDs of what is selected. The IDs are a set that reads any number of them
     * without an array of every ID ({@link IdSet}).
     */
    get(): Selection;
    /**
     * Selects these items instead of the current selection. `{ layerIds }` selects every feature
     * of the layers, those of their groups included, without an array of their IDs (as
     * {@link FeatureTarget} names them): for the type `feature` only (the type `layer` selects
     * the layers themselves, and what acts on the selection then acts on the layers).
     *
     * @param type - The type of the items
     * @param ids - The IDs, or for features the layers whose features are selected
     * @returns False when none of the items can be selected
     * @throws `DrawError` with the code `notFound` when one of the IDs is not an item of this
     *   type, or `invalidInput` when `{ layerIds }` is given with another type than `feature`
     */
    set(type: SelectionType, ids: readonly string[] | IdSet | {
        readonly layerIds: readonly string[];
    }): boolean;
    /**
     * Adds items of the selected type to the selection.
     *
     * @returns False when none of them can be added
     * @throws `DrawError` with the code `notFound` when one of the IDs is not an item of the
     *   selected type
     */
    add(ids: readonly string[] | IdSet): boolean;
    /**
     * Removes items from the selection.
     *
     * @returns False when none of them was selected
     */
    remove(ids: readonly string[] | IdSet): boolean;
    /** Clears the selection. */
    clear(): void;
    /**
     * The selected features; for a group or a layer, the features in it.
     *
     * @throws `DrawError` with the code `tooManyItems` when there are more than 10,000 of them;
     *   the list is never cut short. `features.iterate` with the `layerId` or `groupId` filter,
     *   or `get().ids.iterate()`, reads any number of them
     */
    features(): Feature[];
    /**
     * Deletes what is selected: the selected features, or the selected groups with their
     * features, or the selected layers with their features and groups. Features and groups are
     * deleted as `features.deleteMany({ selection: true })` deletes them, and layers as
     * `layers.deleteMany` deletes them (the layers in the last part): a bulk edit in parts, as
     * the Delete key does. What is locked stays, and the rest is deleted: a selected layer that
     * holds a lock is left out, and its features are counted (`EditCounts.lockedCount`). The
     * document keeps one layer: when every layer is selected, the last of the selection stays.
     * Once the edit has deleted something, nothing is selected. The selected vertices are not
     * deleted (see {@link VertexSelectionResource.delete}).
     *
     * @returns The counts of the edit, or `null` when nothing is selected or the deletion is
     *   refused (read-only, the interaction lock, or everything selected is locked)
     */
    delete(): Promise<EditCounts | null>;
    /**
     * Makes a group of the selected features.
     *
     * @returns The new group, or `null` when the features cannot be grouped
     */
    group(): Group | null;
    /**
     * Takes what is selected out of the groups, as the shortcut Shift+Cmd+G (Shift+Ctrl+G) does:
     * the selected groups are dissolved, their features taking their place in the layer, and
     * selected features that are in a group leave it (the group stays unless it becomes empty).
     *
     * @returns False when nothing selected is a group or in one, or the document is read-only
     */
    ungroup(): boolean;
    /**
     * Moves what is selected.
     *
     * @returns False when nothing is selected or the move is refused
     * @throws `DrawError` with the code `notFound` when the target does not exist
     */
    move(to: MoveTarget): boolean;
}

/**
 * The selected vertices of one feature in this client.
 *
 * The built-in edits of vertices each make one write, which changes only this:
 *
 * - A drag of a vertex, or of the selected vertices when the vertex dragged is one of them,
 *   writes once, when the pointer is let go of: the positions of the vertices dragged, put on
 *   the geometry the feature has then, and nothing else (see `drag.changed`). With the moving
 *   of shared vertices (`topology.sharedVertexDrag`), the same write puts the vertices of the
 *   other features that follow.
 * - A drag of a midpoint handle writes once, when the pointer is let go of: one vertex added in
 *   the segment of the handle, at the position the pointer was let go of. While it goes on, the
 *   vertex is drawn by an entry of the sketch of the drag that adds it (`added`, see
 *   {@link VertexPlacement}); when the pointer is let go of, it is added to the geometry the
 *   feature has then, before the vertex the entry names as it is followed then.
 * - {@link VertexSelectionResource.delete} writes once: the selected vertices deleted.
 *
 * The selection follows the vertices as the feature changes (see {@link VertexRef}): a vertex
 * it cannot follow leaves it.
 */
export interface VertexSelectionResource {
    /**
     * The selected vertices.
     *
     * @returns The vertices, or `null` when no vertex is selected
     */
    get(): VertexSelection | null;
    /**
     * Selects vertices of a feature.
     *
     * @returns False when the vertices cannot be selected (a lock)
     * @throws `DrawError` with the code `notFound` when the feature or one of the vertices
     *   does not exist
     */
    set(featureId: string, vertices: readonly VertexRef[]): boolean;
    /** Clears the vertex selection. */
    clear(): void;
    /**
     * Deletes the selected vertices.
     *
     * @returns False when no vertex is selected or the deletion is refused (read-only, a lock)
     */
    delete(): boolean;
}

/** What this client has selected: the type and the IDs. The selection holds one type at a time. */
export interface Selection {
    /** The type of the selected items, or `null` when nothing is selected */
    type: SelectionType | null;
    /**
     * The IDs of the selected items. A box selection lists the features it takes in stacking
     * order, from the back.
     */
    ids: IdSet;
}

/** What the selection holds: features, groups or layers. */
export type SelectionType = 'feature' | 'group' | 'layer';

/** The selected vertices of one feature. */
export interface VertexSelection {
    /** The ID of the feature */
    featureId: string;
    /** The selected vertices */
    vertices: readonly VertexRef[];
}

/**
 * A vertex of a feature, as the part, the ring and the index within the ring.
 *
 * How a vertex is followed while its feature changes: this rule is the one the instance uses
 * wherever it keeps a vertex across changes (the vertices of a drag, the vertex selection, the
 * vertices `features.restore` takes back). A vertex is kept by its index. Every time the geometry
 * of its feature changes, each ring is compared before and after (the rings matched by their
 * part and ring numbers): the vertices equal from the start of the ring, and those equal from
 * its end, are found, and what lies between them is the span that changed.
 *
 * - A vertex before the span keeps its index.
 * - A vertex after the span moves its index by the difference of the lengths of the ring.
 * - A vertex inside the span cannot be followed when the length of the ring changed. When the
 *   ring keeps its length, it goes to the index where its position is now, when the span holds
 *   that position at one other index only (vertices were taken out and put in at once, or the
 *   ring was turned around); otherwise it keeps its index (the vertex was moved).
 *
 * The rings are matched by their numbers only while there are as many of them as before: when
 * the geometry has another type or another number of parts, no vertex of the feature can be
 * followed, and when a part has another number of rings, no vertex of that part can be (a ring
 * taken out would give its number to the next one). A vertex that a
 * drag of vertices cannot follow leaves the drag, as do the vertices of a feature that is
 * deleted or locked, and the drag goes on with the others (the other features of a drag of
 * shared vertices, say); it ends as cancelled (`drag.ended` with `cancelled: true`) only when
 * nothing is left in it, or when the document turns read-only. The vertex selection lets go of
 * the vertices it cannot follow; `features.restore` leaves them and counts them.
 */
export interface VertexRef {
    /** The part of a Multi geometry; 0 when it is left out */
    part?: number;
    /** The ring of a polygon, 0 for the outer ring; 0 for lines and points */
    ring: number;
    /** The index of the vertex within the ring */
    index: number;
}

// =============================================================================
// 領域: sketches と、描かれている形
// =============================================================================

/**
 * The sketches: features of the document drawn moved, turned or scaled, or with some of their
 * vertices moved (the features themselves, not a copy nor a shape drawn beside them),
 * without the document changing. A sketch names features and says how to draw them; the features
 * themselves are drawn so, in their place in the stacking order (no copy of them is drawn beside
 * them), until the sketch is removed. Nothing is written, so a sketch is shown whatever the state
 * of this client, also while the document is read-only.
 *
 * What uses the shapes the sketches give, and what uses the document, is written here only:
 *
 * - What is drawn uses the features as the sketches draw them: the built-in drawing, the
 *   renderers of the feature types (`FeatureRenderer.draw`), the companions
 *   (`CompanionProvider.draw`), and the box and the handles of the selection
 *   (`ScreenContext.bounds` and `outline`, `FeatureTypeDefinition.bounds`, `outline` and
 *   `handles`).
 * - What hits uses them too: the hit test (`ModeContext.hitTest`, `FeatureTypeDefinition.hitTest`,
 *   `CompanionProvider.hitTest`), the box selection (`FeatureTypeDefinition.boxSelect`) and
 *   snapping (`ModeContext.snap`, `FeatureTypeDefinition.snapCandidates`), so that a click on a
 *   feature drawn moved hits it where it is drawn.
 * - What writes, and `draw.features`, use the document. `draw.rendered` reads the features as
 *   they are drawn.
 *
 * The select mode shows its own drags so, under an ID that starts with
 * {@link DRAW_PROPERTY_PREFIX} (`maplibre-gl-draw:`): a drag of the selection adds a sketch that
 * moves the features dragged, and a drag of vertices one that places those vertices
 * (`placeVertices`, with an entry for each vertex dragged, those of the other features that
 * follow a shared vertex included, or an entry `added` for the vertex a drag of a midpoint
 * handle adds), and a drag of a handle that gives a patch one that draws the feature with it
 * (`update`). It changes the sketch before every `drag.changed`, and follows the
 * vertices as their features change (see {@link VertexRef}). When the pointer is let go of, it
 * marks the sketch `isBeingWritten`, counting only the changes of the operation of the drag; it
 * removes the sketch once the last change of that operation has arrived, and at once when the
 * write is refused or writes nothing.
 *
 * An extension adds sketches of its own, for instance to show features as another program moves
 * them. They are not removed by themselves: the extension removes them, in its `onRemove` at the
 * latest. An ID that starts with `maplibre-gl-draw:` belongs to the select mode, and an extension
 * cannot give one.
 *
 * Several sketches can be shown at once. When two name the same feature, the one added last is
 * applied to it and the other is not (adding a sketch again with its own ID keeps its place in
 * that order), with one exception: vertex placements (`placeVertices`) of different vertices of
 * one feature are all applied, whatever sketches they come from (for one vertex, the one added
 * last).
 *
 * Once a sketch is marked `isBeingWritten` (the moves it shows are being written), a feature whose
 * geometry is written after that is drawn as the document holds it, without the sketch, so that
 * it neither moves twice nor goes back to where it was while the parts of the write arrive. The
 * sketches of the select mode count only the changes of the operation of their drag. A sketch so
 * marked that is left shown does no harm to the features already written.
 *
 * A sketch costs nothing per feature: its features are named by a set of IDs or by layers, and
 * the move by its values, so a sketch of 100,000 features makes no array nor object per feature.
 */
export interface SketchesCollection {
    /**
     * Gets a sketch by ID.
     *
     * @returns The sketch, or `undefined` when there is none with this ID
     */
    get(id: string): Sketch | undefined;
    /** Lists the sketches shown, in the order they were added, those of the select mode included. */
    list(): Sketch[];
    /**
     * Adds a sketch and returns it. A sketch with the ID of one shown takes its place: it is how
     * a sketch follows a move as it goes on (once per frame, say).
     *
     * A key of the look (`style`) that the library does not know is kept and handed to the
     * renderers, as the keys of an extension are.
     *
     * @returns The sketch
     * @throws `DrawError` with the code `invalidInput` when the input has the wrong shape (a
     *   position that is not finite, a factor that is not above 0, a value of the look of the
     *   wrong kind, such as a number that is not finite), or its ID starts with
     *   `maplibre-gl-draw:`
     */
    add(input: SketchInput): Sketch;
    /**
     * Removes a sketch: its features are drawn as the document holds them again.
     *
     * @returns False when there is no sketch with this ID
     */
    remove(id: string): boolean;
}

/**
 * How a sketch draws its features:
 *
 * - `transform` moves, turns or scales the features of `target` as `operation` says, as
 *   `features.translate`, `rotate` and `scale` would write them, drawn with the built-in
 *   computation
 * - `placeVertices` puts vertices of features at other positions, or adds vertices to them:
 *   each entry names a feature, one of its vertices and a position. The vertex named is drawn
 *   at the position, or, for an entry `added`, a new vertex is drawn at the position just
 *   before the vertex named
 * - `update` draws one feature with a patch put over it, as `features.update` would write it
 *   (its geometry, its attributes, its look): what a drag of a handle that gives a patch (the
 *   radius handle of a circle, a handle of a feature type or of a handle provider) looks like
 *   while it goes on. The patch is put over the feature as the document holds it at every
 *   draw, so a key the patch does not give is drawn as it is now
 *
 * A feature of the target that is deleted, hidden or not there is left out. The features of
 * `{ layerIds }` are those of the layers when a sketch of this ID was first added: a feature
 * created in them afterwards is not drawn moved, as it is not part of a bulk edit started then.
 *
 * The vertices are placed on the geometry the feature has in the document at every draw, and
 * only the vertices named are put elsewhere or added: a vertex that another edit moves
 * meanwhile is drawn where it goes. An entry whose feature or vertex is not there is left out.
 */
export type SketchEdit = {
    kind: 'transform';
    /**
     * The features: IDs, a set of IDs, or every feature of the layers (those of their groups
     * too) but those of `exceptIds`
     */
    target: readonly string[] | IdSet | {
        readonly layerIds: readonly string[];
        /**
         * Features of the layers that the sketch leaves out, such as those another drag took
         * over, so that a sketch of whole layers but a few makes no set of the IDs of the
         * layers; none when it is left out
         */
        readonly exceptIds?: readonly string[] | IdSet;
    };
    /** The move, the rotation or the scaling */
    operation: TransformOperation;
} | {
    kind: 'placeVertices';
    /** The vertices, and the positions they are drawn at */
    vertices: readonly VertexPlacement[];
} | {
    kind: 'update';
    /** The feature */
    featureId: string;
    /**
     * The keys it is drawn with, as `features.update` would write them: its geometry too, so that
     * the radius of a circle or the size of a box changes as the handle is dragged
     */
    patch: FeaturePatch;
};

/**
 * A vertex put at another position, or a vertex added: the feature, the vertex and the position.
 */
export interface VertexPlacement {
    /** The ID of the feature */
    readonly featureId: string;
    /**
     * The vertex put at the position, by its part, ring and index (not a position); for an entry
     * `added`, the vertex the new vertex goes just
     * before (the vertex after the segment it is added in)
     */
    readonly vertex: VertexRef;
    /** The position the vertex is drawn at, as `[longitude, latitude]` in degrees */
    readonly position: Position;
    /**
     * True for a vertex added (a drag of a midpoint handle): a new vertex is drawn at the position,
     * just before `vertex`, and the vertex named stays where it is. False when it is left out
     */
    readonly added?: boolean;
}

/**
 * A sketch shown: how features of the document are drawn moved, without the document changing
 * and without a copy of them (see {@link SketchesCollection}).
 */
export interface Sketch {
    /** The ID */
    readonly id: string;
    /** How it draws its features */
    readonly edit: SketchEdit;
    /**
     * The keys of the look put over the look of the features it draws, as `style` of a feature
     * is put over a layer rule (to show features moved by another program in another color, say);
     * none when it is left out
     */
    readonly style?: Readonly<Partial<FeatureStyle>>;
    /**
     * True once the moves it shows are being written: a feature whose geometry is written after
     * it was marked is drawn as the document holds it (see {@link SketchesCollection})
     */
    readonly isBeingWritten: boolean;
}

/** What `sketches.add` takes. */
export interface SketchInput {
    /** The ID; one is generated when it is left out. It cannot start with `maplibre-gl-draw:` */
    id?: string;
    /** How it draws its features */
    edit: SketchEdit;
    /**
     * The keys of the look put over the look of the features it draws
     * (`{ strokeColor: '#e11d48', lineStyle: 'dashed' }`, say)
     */
    style?: Partial<FeatureStyle>;
    /**
     * Whether the moves it shows are being written, as another program that let go of its drag
     * writes them (see {@link SketchesCollection}); false when it is left out
     */
    isBeingWritten?: boolean;
}

/**
 * The features as this client draws them, read as features of the document (not the layers the
 * map draws, as `queryRenderedFeatures` reads them): the document with the sketches applied over
 * it (see {@link SketchesCollection}). What is drawn with a feature (a label beside it, a box of
 * HTML over it) reads its shape here, so that it follows the feature as it is drawn while it is
 * dragged and not written yet; what writes reads the document (`draw.features`).
 */
export interface RenderedResource {
    /**
     * A feature as it is drawn: the feature of the document, moved, or with vertices moved, by
     * the sketches applied to it.
     *
     * @returns The feature, or `undefined` when there is none with this ID or it is not drawn
     *   (hidden)
     */
    get(id: string): Feature | undefined;
    /**
     * Features as they are drawn, in the order of the IDs.
     *
     * @returns One entry per ID: the feature, or `undefined` when there is none with that ID
     */
    getMany(ids: readonly string[]): (Feature | undefined)[];
}

/**
 * The drag of the select mode going on in this client (see `drag.started`), to take features out
 * of it: for an extension that hands a feature over to another drag, such as one another program
 * started on it later. Which drag gets a feature is for the extension to decide.
 */
export interface DragResource {
    /**
     * Takes features, or vertices of a feature, out of the drag going on; nothing is deleted, and
     * they stay in the document as they are. A feature taken out is
     * drawn as the document holds it again, or as another sketch draws it, and the write of the
     * drag leaves it as it is; the drag goes on with the others, and its `drag.changed` and
     * `drag.ended` no longer name it. Vertices taken out are left so, and the other vertices of
     * the drag go on. A drag left with nothing ends as cancelled (`drag.ended` with
     * `cancelled: true`).
     *
     * @param target - The features, as IDs or a set of IDs, or vertices of one feature
     * @returns False when no drag is going on, or none of them is in it
     */
    remove(target: readonly string[] | IdSet | {
        readonly featureId: string;
        readonly vertices: readonly VertexRef[];
    }): boolean;
}

// =============================================================================
// 領域: 読み込みと書き出し
// =============================================================================

/**
 * The whole document: features, layers, groups and metadata.
 */
export interface DocumentResource {
    /**
     * Reads a file, a JSON string, a document of the library or GeoJSON.
     *
     * `options.mode` decides whether the document is replaced or the features are added; it is
     * `replace` for a document of the library and `merge` for GeoJSON when it is left out.
     *
     * The source is read (and an image decoded) first, and checked whole: a load that fails
     * writes nothing; a `File` or a `Blob` is read whole first, as any other source. Then it is
     * written as one bulk edit with the source `load`, whatever the
     * format: one operation, in parts for many features, each part a `document.changed` with the
     * `operationId` of the load and the last one without `hasMoreParts` (see
     * {@link FeaturesCollection}). A replacement (`mode: 'replace'`) marks its first change
     * `reset`. The layer of `options.layer` and the group of `options.group` are created in its
     * first part. A load that the document turning read-only stops keeps the parts written
     * (`stopped`).
     *
     * @returns What was read and written, or `null` when the document is read-only
     * @throws `DrawError` (the promise rejects; every failure is a `DrawError`) with the code
     *   `unsupportedFormat` when the source cannot be read (text that is not JSON, data that is
     *   neither a document of the library nor GeoJSON, an image file that cannot be decoded), or
     *   `invalidInput` when the document is not valid (a document of the library that breaks
     *   its format, an embedded image that is broken, an image without `coordinate`, `layer`
     *   with `layerId`, `layer` or `group` with a document of the library), `notFound` for a
     *   `layerId` the document does not have, or `alreadyExists` for an ID of `layer` or
     *   `group` that is taken
     */
    load(source: LoadSource, options?: LoadOptions): Promise<LoadResult | null>;
    /**
     * Reads several sources and writes all of them as one bulk edit with the source `load`, as
     * `load` writes one: one operation, so that an import of several files is one edit. Every
     * source is read first, in order; the
     * writes then follow in the same order, each as `load` would write it, against the document
     * the earlier items left (a document of the library replaces what the earlier items wrote).
     * `document.loaded` arrives once per item, after the writes.
     *
     * An item may name with `layerId` a layer that an earlier item creates with `layer`, so the
     * items can fill one new layer and a group of it. A layer named by `layerId` that an earlier
     * item removed is replaced with the active layer. With `layer` and `group` in the options of
     * the items, an import of one layer per file and one group per folder is still one
     * operation.
     *
     * @param items - The sources, each with the options `load` takes
     * @returns What was read from each item, in the order of the items, or `null` when the
     *   document is read-only
     * @throws `DrawError` (the promise rejects) as `load` does, for the first item that cannot
     *   be read (`notFound` for a `layerId` that neither the document nor an earlier item has);
     *   nothing is written then. `invalidInput` when `items` is not an array of objects
     *   with a `source`
     */
    loadMany(items: readonly {
        source: LoadSource;
        options?: LoadOptions;
    }[]): Promise<LoadResult[] | null>;
    /**
     * Subscribes to the changes of the document, as `document.changed` delivers them, and asks
     * for more in them: the values the features had before each change
     * (`DocumentChange.previousValues`), for an extension that writes them back
     * (`features.restore`). The library reads and keeps those values only while a subscriber
     * asks for them, and only for the sources it names, so they cost nothing otherwise.
     *
     * A subscriber that asks for the values before lets go of the ones it no longer needs
     * (`features.releaseValues`): the values of a deletion keep the features deleted.
     *
     * @param listener - Called with each change, after the events of the resources, and after
     *   the Store has told every one of its listeners, so that it can write
     * @param options - What the changes of this subscriber carry besides the IDs
     * @returns The function that unsubscribes (an extension calls it in its `onRemove`)
     */
    subscribe(listener: (change: DocumentChange) => void, options?: DocumentSubscribeOptions): () => void;
    /**
     * The whole document in the format of the library, made at once: for a large document, it is
     * written out a part at a time with {@link DocumentResource.stringify} instead.
     */
    toJSON(): DrawDocument;
    /**
     * The whole document as GeoJSON, made at once. The values of the library are kept in
     * `properties` under the prefixed keys. For a large document, see
     * {@link DocumentResource.stringify}.
     */
    toGeoJSON(): FeatureCollection;
    /**
     * Writes the whole document out as text, given as an iterator of strings, a part at a time,
     * for a document of any size: the
     * parts joined are the text of `JSON.stringify(draw.document.toJSON())` (`native`) or of
     * `JSON.stringify(draw.document.toGeoJSON())` (`geojson`), and the map is drawn between two
     * parts, so that 100,000 features are never made at once.
     *
     * It writes the features there are when it starts, in their order then, each with the
     * values it has when it is reached, as {@link FeaturesCollection.iterate} reads them: a
     * feature deleted before it is reached is left out, and one created afterwards is not
     * written. A file that must hold one state of the document is written after
     * `draw.waitForWrites()`, with the document read-only while it is written.
     *
     * @param format - `native` for the format of the library, `geojson` for GeoJSON
     * @param options - `featuresPerPart` is the number of features written in one part (1,000
     *   when it is left out)
     * @returns An iterator of the parts of the text
     * @throws `DrawError` with the code `invalidInput` when the format or the options have the
     *   wrong value
     */
    stringify(format: 'native' | 'geojson', options?: {
        featuresPerPart?: number;
    }): AsyncIterableIterator<string>;
}

/** What the changes of a subscriber of `draw.document.subscribe` carry besides the IDs. */
export interface DocumentSubscribeOptions {
    /**
     * Whether the changes carry the values the features had before
     * ({@link DocumentChange.previousValues}): true for the changes of every source, the sources
     * whose changes carry them (an extension that writes back the edits of this client leaves out
     * `'remote'` and `'load'`, which it never writes back), `{ except }` with the sources whose
     * changes do not carry them (every other source, those an extension names included), or a
     * function that answers for each change, from its source and the number of its operation
     * (an extension that writes changes of its own, under operation numbers it took, and does not
     * want their values, answers false for those). The function is asked before the change is
     * written, once per change (once per part of a bulk edit), so that the values nobody asks for
     * are never read; it answers at once and writes nothing. False when it is left out.
     */
    previousValues?: boolean | readonly UpdateSource[] | {
        readonly except: readonly UpdateSource[];
    } | ((change: {
        readonly source: UpdateSource;
        readonly operationId: number;
    }) => boolean);
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

/** What `document.load` reads: a file, a JSON string, a document of the library, or GeoJSON. */
export type LoadSource = File | Blob | string | DrawDocument | GeoJSONFeatureCollection | GeoJSONFeature | Geometry;

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
     * A layer to create for the features, written in the first part of the load (see
     * `document.load`); every
     * feature goes into it, as with `layerId`, and `LoadResult.layerId` gives its ID. It cannot
     * be given together with `layerId` (`invalidInput`), nor with a document of the library,
     * which brings its own layers.
     */
    layer?: LayerInput;
    /**
     * A group to create for the features, written in the first part of the load: every
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

/**
 * What `document.load` read and wrote: the counts of its edit, and what it read. A load writes
 * new features and checks no target, so `lockedCount` and `missingCount` are always 0.
 */
export interface LoadResult extends EditCounts {
    /** The format that was detected */
    format: 'native' | 'geojson' | 'image';
    /** The IDs of the features that were written, in the order of the input */
    featureIds: IdSet;
    /** Whether the document was replaced */
    replaced: boolean;
    /** The GeoJSON features that were left out */
    skipped?: SkippedFeature[];
    /** The ID of the layer created from `LoadOptions.layer` */
    layerId?: string;
    /** The ID of the group created from `LoadOptions.group`, when something was read */
    groupId?: string;
}

/** A GeoJSON feature that `document.load` left out, and why. */
export interface SkippedFeature {
    /** The index of the feature in the input */
    index: number;
    /** Why it was left out, in English, for logs */
    reason: string;
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
    skipped: Array<{
        index: number;
        reason: DrawErrorCode;
        detail?: string;
    }>;
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
export declare function parseNative(input: DrawDocument, options?: ParseOptions): Promise<ParsedDocument>;

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
export declare function parseGeoJSON(input: GeoJSONFeatureCollection | GeoJSONFeature | Geometry, options?: ParseOptions): Promise<ParsedDocument>;

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
 * Writes one feature as a GeoJSON Feature, as {@link featuresToGeoJSON} writes each of its
 * features.
 *
 * @param feature - The feature
 * @param options - Where the file of an image is read from
 * @returns The Feature, or `null` when its geometry is a GeometryCollection
 */
export declare function featureToGeoJSON(feature: Feature, options?: ToGeoJSONOptions): GeoJSONFeature | null;

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
export declare function featuresToGeoJSON(features: readonly Feature[], options?: ToGeoJSONOptions): GeoJSONFeatureCollection;

// =============================================================================
// 領域: event
// =============================================================================

/**
 * The events, by name, with their payloads.
 */
export interface DrawEvents {
    /**
     * A feature was created, or came back (`features.restore`); `hasMoreParts` is true when the
     * change is a part of a bulk edit that is not its last part, as `hasMoreParts` of the
     * `document.changed` it comes with (the same in the four events of the features)
     *
     * It arrives once per feature, also when one change touches many features. The feature
     * objects are made only while the event has a listener; for changes of many features, listen
     * to `document.changed` instead.
     */
    'feature.created': {
        feature: Feature;
        source: UpdateSource;
        hasMoreParts: boolean;
    };
    /**
     * A feature changed; `hasMoreParts` is true when the change is a part of a bulk edit that is
     * not its last part, as `hasMoreParts` of the `document.changed` it comes with. A feature
     * deleted and created again with its ID in one transaction is told here, once, and not as
     * deleted and created (a change that replaces the whole document tells it as both, see
     * `feature.deleted`)
     *
     * It arrives once per feature, also when one change touches many features. The feature
     * objects are made only while the event has a listener; for changes of many features, listen
     * to `document.changed` instead.
     */
    'feature.updated': {
        feature: Feature;
        previous: Feature;
        source: UpdateSource;
        hasMoreParts: boolean;
    };
    /**
     * A feature was deleted
     *
     * It arrives once per feature, also when one change touches many features. The feature
     * objects are made only while the event has a listener; for changes of many features, listen
     * to `document.changed` instead. A change that replaces the whole document
     * (`DocumentChange.reset`) tells every feature taken out here, before the features it
     * writes are told as created.
     */
    'feature.deleted': {
        feature: Feature;
        source: UpdateSource;
        hasMoreParts: boolean;
    };
    /**
     * A feature moved to another layer or group, or to another position in its layer or group
     *
     * It arrives once per feature, also when one change touches many features. The feature
     * objects are made only while the event has a listener; for changes of many features, listen
     * to `document.changed` instead.
     */
    'feature.moved': {
        feature: Feature;
        from: MoveTarget;
        to: MoveTarget;
        source: UpdateSource;
        hasMoreParts: boolean;
    };
    /** A layer was created */
    'layer.created': {
        layer: Layer;
        source: UpdateSource;
    };
    /**
     * A layer changed: one of its own values (its name, its visibility, its lock, its opacity,
     * its rule or its metadata). A change of the order of what it holds does not fire it:
     * `feature.moved` and `group.moved` tell of those
     */
    'layer.updated': {
        layer: Layer;
        previous: Layer;
        source: UpdateSource;
    };
    /** A layer was deleted */
    'layer.deleted': {
        layer: Layer;
        source: UpdateSource;
    };
    /** The stacking order of the layers changed */
    'layer.reordered': {
        order: readonly string[];
        previous: readonly string[];
        source: UpdateSource;
    };
    /** A group was created */
    'group.created': {
        group: Group;
        source: UpdateSource;
    };
    /**
     * A group changed: one of its own values (its name, its visibility or its lock). A change of
     * the order of its features does not fire it: `feature.moved` tells of those
     */
    'group.updated': {
        group: Group;
        previous: Group;
        source: UpdateSource;
    };
    /** A group moved to another layer, or to another position in its layer */
    'group.moved': {
        group: Group;
        from: MoveTarget;
        to: MoveTarget;
        source: UpdateSource;
    };
    /** A group was ungrouped */
    'group.deleted': {
        group: Group;
        source: UpdateSource;
    };
    /** The title or the description changed */
    'metadata.updated': {
        metadata: Metadata;
        previous: Metadata;
        source: UpdateSource;
    };
    /**
     * Every change of one transaction that changed the document (features, layers, groups,
     * metadata or files), in the words of the features: the IDs of what changed, where the
     * change came from and the operation it is a part of. It arrives once per such transaction,
     * after the events of the resources, and once more at the end of a bulk edit that stopped
     * (see {@link DocumentChange}). A change of the selection, the mode or another state of this
     * client alone does not fire it. The values the features had before are carried to a
     * subscriber of `draw.document.subscribe` that asks for them. The events of the document
     * are told once the Store has told every one of its listeners, so a listener can write. The
     * changes are told in the order they were written: what a listener writes is told once the
     * change being told has reached every listener and every subscriber.
     */
    'document.changed': DocumentChange;
    /** A document was loaded */
    'document.loaded': {
        result: LoadResult;
        source: UpdateSource;
    };
    /**
     * The selection changed. `operationId` is the operation of the change of the document it
     * came with (the features deleted leaving the selection, a copy selected), as
     * `document.changed` carries it, or `null` when the selection changed alone; the selection
     * changes before that `document.changed` arrives
     */
    'selection.changed': {
        selection: Selection;
        previous: Selection;
        /**
         * The operation of the change of the document that came with it (not of the change of the
         * selection), or `null` when the selection changed alone
         */
        operationId: number | null;
    };
    /** The features this client marks as being edited changed; `ids` is the whole set after it */
    'editingFeatures.changed': {
        ids: IdSet;
    };
    /** The vertex selection changed */
    'vertexSelection.changed': {
        selection: VertexSelection | null;
        previous: VertexSelection | null;
    };
    /**
     * A drag of the select mode started: of the selected features (`feature`), of a vertex
     * (`vertex`), or of a handle (`handle`). Nothing is written while it goes on: the features
     * are drawn where the drag puts them, by the built-in computation (a sketch of the select
     * mode, see {@link SketchesCollection}), and the document changes once, when it ends.
     * `featureIds` are the features it changes when it starts; `selection` is what was selected
     * when it started (a layer selected names the layer, not its features), the cheap way to name
     * what is dragged. `operationId` is the operation the end of the drag writes, as its changes
     * carry it.
     *
     * While it goes on, a feature of a drag of features that is deleted leaves it at once (it is
     * no longer drawn) and the others go on; so does a feature an extension takes out
     * (`draw.drag.remove`). A drag of vertices follows its vertices as their features change (see
     * {@link VertexRef}): a vertex it cannot follow, and the vertices of a feature deleted or
     * locked, leave it and the others go on. The drag ends as cancelled only when nothing is left
     * in it, or when the document turns read-only
     */
    'drag.started': {
        kind: 'feature' | 'vertex' | 'handle';
        operationId: number;
        /** What was selected when the drag started (not the target of a bulk edit) */
        selection: Selection;
        featureIds: IdSet;
    };
    /**
     * A drag went on: what the user is doing now, for any number of features. `featureIds` are
     * the features it changes now (those that left it are not among them). `operation` is the
     * move, the rotation or the scaling from the start of the drag to now, the one the features
     * are drawn with; `null` for a drag of a vertex or of a handle of an extension. `vertices` is,
     * for a drag of vertices, each vertex dragged and the position it is drawn at now (those of
     * the other features that follow a shared vertex included, and the vertex a drag of a
     * midpoint handle adds, as an entry `added`), the value to give to a sketch
     * (`placeVertices`) elsewhere; `null` for the other drags. `patch` is, for a drag of a handle
     * that gives a patch (the radius handle of a circle, a handle of a feature type or of a
     * handle provider), the patch the handle gives now, the one the feature is drawn with and
     * the value to give to a sketch (`update`) elsewhere; `null` for the other drags, and when
     * the handle gives none. The sketch of the drag is changed
     * before it fires, so `draw.rendered` and `draw.sketches` give the new shapes in its
     * listeners. It fires once per move of the pointer that changes the drag, with no
     * throttling, as `preview.changed` fires for the shape being drawn
     */
    'drag.changed': {
        kind: 'feature' | 'vertex' | 'handle';
        operationId: number;
        /** What was selected when the drag started (not the target of a bulk edit) */
        selection: Selection;
        featureIds: IdSet;
        operation: TransformOperation | null;
        vertices: readonly VertexPlacement[] | null;
        /** The patch a handle gives now, for a drag of a handle that gives one; `null` otherwise */
        patch: FeaturePatch | null;
    };
    /**
     * A drag ended, as the pointer was let go of; `cancelled` is true when it was cancelled (see
     * `drag.started`), and nothing is written then. `featureIds` are the features the write
     * changes. `operation` is the one written, as the last `drag.changed` carried it (`null` when
     * it was cancelled, and for a drag of a vertex or of a handle of an extension).
     *
     * It arrives before the write: the write of the drag starts after it (once the bulk edits of
     * this client started before it have ended, see {@link FeaturesCollection}), as the operation
     * `operationId`, and its changes arrive after it (in parts for many features). The write of a
     * drag of vertices puts the vertices dragged on the geometry each feature has then, and
     * nothing else (see {@link VertexSelectionResource}); the write of a drag of a handle that
     * gives a patch writes the patch the handle gives when the drag ends. Until the part that
     * writes a feature
     * arrives, the feature is drawn where the drag left it (the sketch of the drag is marked
     * `isBeingWritten`), so nothing jumps back. A drag that writes nothing (cancelled, or a patch
     * of `null`) makes no change of that operation
     */
    'drag.ended': {
        kind: 'feature' | 'vertex' | 'handle';
        operationId: number;
        /** What was selected when the drag started (not the target of a bulk edit) */
        selection: Selection;
        featureIds: IdSet;
        operation: TransformOperation | null;
        cancelled: boolean;
    };
    /** The mode changed */
    'mode.changed': {
        mode: Mode;
        previous: Mode;
    };
    /** The items this client hides changed; `ids` is the whole set after the change */
    'hidden.changed': {
        ids: IdSet;
    };
    /** Read-only was turned on or off */
    'readOnly.changed': {
        readOnly: boolean;
    };
    /** The interaction lock was turned on or off */
    'interactionLock.changed': {
        locked: boolean;
    };
    /**
     * `draw.options.update` changed the options; `options` and `previous` are what
     * `draw.options.get()` returns after and before the change. An update that leaves every
     * value as it was does not fire it
     */
    'options.changed': {
        options: Readonly<RuntimeOptions>;
        previous: Readonly<RuntimeOptions>;
    };
    /** The snapping target changed */
    'snap.changed': {
        result: SnapResult | null;
    };
    /**
     * The shape being drawn changed, or was cleared (`feature` is `null`). It fires once per
     * change, with no throttling: at each vertex, at each move of the pointer that moves the
     * shape, and when the shape is created, cancelled or left. `feature` has the type, the
     * geometry and the layer of the shape, the ID it will be created with, and the radius of a
     * circle; it is a copy that the drawing does not change afterwards. `confirmedVertices` and
     * `highlightVertex` are the options the shape was shown with (`ModeContext.preview.set`):
     * each is left out when it was not given, and both when the shape is cleared.
     */
    'preview.changed': {
        feature: FeatureInput | null;
        confirmedVertices?: number;
        highlightVertex?: number;
    };
    /**
     * A click on the map in the select mode, whether it hit something or not. `lngLat` is the
     * position of the pointer before snapping, and `hit` the frontmost thing under it (a feature,
     * a row of a dataset, a companion), or `null` when the click hit nothing
     */
    'map.clicked': {
        lngLat: Position;
        point: ScreenPoint;
        hit: Hit | null;
    };
    /** A row of a dataset was clicked */
    'dataset.clicked': {
        datasetId: string;
        rowIndex: number;
        row: DatasetRow;
        lngLat: Position;
        point: ScreenPoint;
    };
    /** A dataset was added */
    'dataset.added': {
        dataset: Dataset;
    };
    /** A dataset was removed */
    'dataset.removed': {
        datasetId: string;
    };
    /** The stacking order of the datasets changed */
    'dataset.reordered': {
        order: readonly string[];
        previous: readonly string[];
    };
    /**
     * The image mode asks for an image to place at a position: the application picks a file
     * and loads it with `document.load(file, { coordinate: lngLat, zoom, layerId })`. `lngLat` is
     * the clicked position when a click led to the mode (a listener of `map.clicked` entered it),
     * and the center of the map when the mode was entered otherwise
     */
    'image.requested': {
        lngLat: Position;
        zoom: number;
        layerId: string;
    };
    /** The divisions of the stacking order changed */
    'layerStack.changed': {
        entries: readonly LayerStackEntry[];
    };
    /** Loading or reading an image failed */
    'image.failed': {
        error: DrawError;
        source: string;
        featureId?: string;
    };
}

/** A function that receives the payload of an event. */
export type DrawEventListener<K extends keyof DrawEvents = keyof DrawEvents> = (payload: DrawEvents[K]) => void;

/**
 * One change of the document, in the words of the features: what `document.changed` delivers,
 * once per transaction that changed the document. It lists the IDs of what changed; what the
 * features are now is read from `draw.features`.
 *
 * A bulk edit (`features.translate`, `deleteMany`, `restore`, `document.load` and the others)
 * is one operation written in parts: its changes share one `operationId`, every one but the
 * last has `hasMoreParts: true`, and the last one always arrives, also when the edit stopped
 * before it had written everything (`stopped: true`; that change may list nothing). A
 * subscriber that takes an edit as one change (to keep the document, or to write it back)
 * gathers the changes of its `operationId` up to the one without `hasMoreParts`. Any other
 * change is one operation of one change.
 */
export interface DocumentChange {
    /** Where the writes came from */
    source: UpdateSource;
    /**
     * The number of the operation the change is a part of: the same for every part of a bulk
     * edit (`EditCounts.operationId`), for the write of a drag (`drag.started`), and for the
     * calls of the computation of moves that wrote it (`TransformInput.operationId`); a new one
     * for any other change. Numbers are not used twice in an instance.
     */
    operationId: number;
    /** True when more changes of the same operation follow */
    hasMoreParts: boolean;
    /**
     * True on the last change of an operation that stopped before it had written everything
     * (the document turned read-only, or the instance was destroyed; see
     * {@link FeaturesCollection}). The parts written stay
     */
    stopped: boolean;
    /**
     * True when the change replaces the whole document (a load with `mode: 'replace'`, or a
     * replacement written to the Store): `features.deleted` lists what was there, and
     * `features.created` what is written in the change. When the replacement is written in
     * parts, its first change is marked, and the changes of the same operation after it go on
     * writing it. The current mode drops what it was drawing (`ModeHandler.onCancel`); the
     * selection, the editing and the items this client hides let go of what is gone once the
     * operation ends, so that an item written again in a later part keeps them.
     */
    reset: boolean;
    /** The features created, updated, deleted and moved */
    features: ChangedIds;
    /**
     * The layers created, updated and deleted, and the change of the stacking order; a change
     * that creates or deletes a layer always carries `orderChanged`
     */
    layers?: {
        created?: Layer[];
        updated?: Array<{
            id: string;
            layer: Layer;
            previous: Layer;
        }>;
        deleted?: Layer[];
        orderChanged?: {
            order: string[];
            previous: string[];
        };
    };
    /**
     * The groups created, updated, deleted and moved. `features.restore` writes all of them
     * back, with the features (see {@link FeatureValues}): a caller that writes back a change
     * reads them only to show what changed
     */
    groups?: {
        created?: Group[];
        updated?: Array<{
            id: string;
            group: Group;
            previous: Group;
        }>;
        deleted?: Group[];
        /**
         * Groups moved themselves (not what they hold): `from` and `to` are each a layer and a
         * position in it (`MoveTarget`, `{ layerId, index }`), where the group was before and
         * where it is now: in another layer, or at another position in its layer
         */
        moved?: Array<{
            id: string;
            group: Group;
            from: MoveTarget;
            to: MoveTarget;
        }>;
    };
    /** The new metadata and the one before it */
    metadata?: {
        metadata: Metadata;
        previous: Metadata;
        /**
         * The keys the change wrote, each once (a key taken off included), so that a subscriber
         * of many keys reads only those
         */
        keys: readonly string[];
    };
    /** The embedded files created and deleted */
    files?: {
        created?: FileData[];
        deleted?: FileData[];
    };
    /**
     * What the change did to the features, the deleted features kept (see
     * {@link FeatureValues}): what `features.restore` takes back. Only for a
     * subscriber of `draw.document.subscribe` that asked for them, for this source; never on the
     * payload of `draw.on('document.changed')`. A change that wrote no feature has none.
     */
    previousValues?: FeatureValues;
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

/** A point on the screen, as `[x, y]` in CSS pixels. */
export type ScreenPoint = [number, number];

export type { Position } from 'geojson';

// =============================================================================
// 領域: dataset
// =============================================================================

/**
 * The datasets on the map, in stacking order.
 */
export interface DatasetsCollection {
    /**
     * Gets a dataset by ID.
     *
     * @returns The dataset, or `undefined` when there is none with this ID
     */
    get(id: string): Dataset | undefined;
    /** Lists the datasets in stacking order. */
    list(): Dataset[];
    /** Counts the datasets. */
    count(): number;
    /** Whether a dataset with this ID exists. */
    has(id: string): boolean;
    /**
     * Adds a dataset and returns it.
     *
     * @throws `DrawError` with the code `alreadyExists` when the ID is taken, or
     *   `invalidInput` when the options are wrong
     */
    add(options: DatasetOptions): Dataset;
    /**
     * Adds several datasets in one transaction, all of them or none, and returns them.
     *
     * @throws `DrawError` as {@link DatasetsCollection.add} does, for any of the options;
     *   nothing is added then
     */
    addMany(options: readonly DatasetOptions[]): Dataset[];
    /**
     * Removes a dataset.
     *
     * @returns True when it was removed
     * @throws `DrawError` with the code `notFound` when there is no dataset with this ID
     */
    remove(id: string): boolean;
    /**
     * Removes several datasets in one transaction: all of them or none.
     *
     * @returns True when they were removed
     * @throws `DrawError` with the code `notFound` when one of the IDs does not exist; nothing
     *   is removed then
     */
    removeMany(ids: readonly string[]): boolean;
    /**
     * Moves a dataset in the stacking order.
     *
     * @returns True when it moved
     * @throws `DrawError` with the code `notFound` when there is no dataset with this ID
     */
    move(id: string, placement: DatasetPlacement): boolean;
}

/**
 * Large data drawn on the map and not edited; it is not part of the document.
 */
export interface Dataset {
    /** The ID */
    readonly id: string;
    /** Where it is stacked */
    readonly order: DatasetOrder;
    /** Whether the rows can be clicked and snapped to */
    readonly interactive: boolean;
    /** Whether it is visible */
    readonly visible: boolean;
    /** Shows or hides the dataset. */
    setVisible(visible: boolean): void;
    /** Replaces every row. */
    setRows(rows: readonly DatasetRow[]): void;
    /** Replaces every row with a table. */
    setTable(table: Table | PreparedTable): void;
    /** Replaces the style rule; `undefined` removes it. */
    setStyleRule(rule: StyleRule | undefined): void;
    /**
     * The style rule, or `undefined` when none is set: the rule last given to `setStyleRule`, or
     * the one given to `datasets.add` when it was not replaced.
     */
    getStyleRule(): StyleRule | undefined;
    /** Replaces the scale factor and the opacity by zoom; `null` removes them. */
    setZoomScale(zoomScale: DatasetZoomScale | null): void;
    /** The scale factor and the opacity by zoom, or `null` when none is set. */
    getZoomScale(): DatasetZoomScale | null;
    /** Replaces the default look; `undefined` removes it. */
    setBaseStyle(style: DatasetBaseStyle | undefined): void;
    /** Replaces the function that picks the point rows another renderer draws. */
    setExternalPointRender(predicate: ((row: DatasetRow) => boolean) | undefined): void;
    /** The default look, or `undefined` when none is set. */
    getBaseStyle(): DatasetBaseStyle | undefined;
    /** Every row, in drawing order, without the rule colors and the default look. */
    listRows(): DatasetRow[];
    /** The rows whose extent meets the range, with the rule colors and the default look. */
    listVisibleRows(bbox: BBox): DatasetRow[];
    /** The indexes of the rows drawn now whose extent meets the range, in ascending order. */
    listDrawnRows(bbox: BBox): Int32Array;
    /** Reads a row as a GeoJSON feature; `undefined` when there is no such row. */
    getRow(index: number): DatasetRow | undefined;
    /** The ID of a row, or `null` when there is no such row or it has no ID. */
    getRowId(index: number): string | null;
    /** The type of the geometry of a row, or `null` when there is no such row. */
    getRowType(index: number): FeatureType | null;
    /** The extent of a row, or `null` when there is no such row or it has no geometry. */
    getRowBounds(index: number): BBox | null;
    /** The position of a point row, or `null` when the row is not a point. */
    getRowPoint(index: number): Position | null;
    /** The index of the row with this ID, or `null` when there is none. */
    findRow(id: string): number | null;
    /** Replaces the IDs of the selected rows. */
    setSelectedRowIds(ids: readonly string[]): void;
    /** The IDs of the selected rows. */
    getSelectedRowIds(): string[];
    /** Replaces the thinning of overlapping points; `null` turns it off. */
    setCollisionThinning(options: DatasetCollisionThinning | null): void;
    /** The thinning in effect with every default filled in, or `null` when it is off. */
    getCollisionThinning(): Required<DatasetCollisionThinning> | null;
    /** The IDs of the rows the thinning draws, or `null` when it thins nothing. */
    listVisibleRowIds(): ReadonlySet<string> | null;
    /** What the thinning is doing now. */
    getThinningStats(): DatasetThinningStats;
    /** A number that changes whenever the rows drawn change. */
    getDrawnRowsRevision(): number;
    /** Fetches the rows of the provider again on the next move of the map. */
    refresh(): void;
    /** Subscribes to an event of this dataset and returns the function that unsubscribes. */
    on<K extends keyof DatasetEvents>(event: K, listener: (payload: DatasetEvents[K]) => void): () => void;
    /** Unsubscribes from an event of this dataset. */
    off<K extends keyof DatasetEvents>(event: K, listener: (payload: DatasetEvents[K]) => void): void;
}

/**
 * What `datasets.add` takes. The rows are given in one of three ways, told apart by the name
 * of the field: `rows`, `table` or `provider`. With none of them the dataset starts empty: it
 * can be placed at once (`layers.reorder` takes its ID when its order is `layerOrder`), and
 * its rows are given later with `setRows` or `setTable`.
 */
export type DatasetOptions = {
    /** The ID */
    id: string;
    /** The rule that colors the rows from their attributes */
    styleRule?: StyleRule;
    /** The default look */
    baseStyle?: DatasetBaseStyle;
    /** Whether the rows can be clicked and snapped to */
    interactive?: boolean;
    /** Where it is stacked */
    order?: DatasetOrder;
    /** The scale factor and the opacity by zoom */
    zoomScale?: DatasetZoomScale;
    /** The thinning of overlapping points */
    collisionThinning?: DatasetCollisionThinning;
    /** Picks the point rows that another renderer draws; they are not drawn by the dataset */
    externalPointRender?: (row: DatasetRow) => boolean;
} & ({
    /** The rows as GeoJSON features */
    rows: readonly DatasetRow[];
} | {
    /** The rows as a table, prepared or not */
    table: Table | PreparedTable;
} | {
    /** The function that returns the rows of the range in view */
    provider: DatasetProvider;
} | {
    /** No rows yet: they are given later with `setRows` or `setTable` */
    rows?: undefined;
    /** No table yet */
    table?: undefined;
    /** No provider */
    provider?: undefined;
});

/**
 * A function that returns the rows of the range in view, for a dataset whose rows are fetched
 * as the map moves.
 *
 * @param bbox - The range in view, in degrees
 * @param zoom - The zoom of the map
 * @returns The rows of the range
 */
export type DatasetProvider = (bbox: BBox, zoom: number) => Promise<DatasetRow[]>;

/**
 * A row of a dataset, given and read as a GeoJSON feature. Its geometry may be `null`, as
 * GeoJSON allows; such a row is kept in the table and is not drawn.
 *
 * Besides the members of GeoJSON, a row may carry `style`, its own look, which wins over the
 * color of the style rule and the base style of the dataset. A row read back carries the look
 * it was given merged over the base style, when that has a key.
 */
export type DatasetRow = GeoJSONFeature<Geometry | null> & {
    /** The look of the row; it wins over the style rule and the base style of the dataset */
    style?: FeatureStyle;
};

/** The events of one dataset, by name, with their payloads. */
export interface DatasetEvents {
    /** A row was clicked */
    clicked: {
        datasetId: string;
        rowIndex: number;
        row: DatasetRow;
        lngLat: Position;
        point: ScreenPoint;
    };
    /** The pointer moved over a row, or off every row (`rowIndex` and `row` are then `null`) */
    hovered: {
        datasetId: string;
        rowIndex: number | null;
        row: DatasetRow | null;
        lngLat: Position;
        point: ScreenPoint;
    };
    /** The rows, the look, the visibility, the selection or the thinning changed */
    changed: {
        reason: 'rows' | 'style' | 'visibility' | 'selection' | 'thinning';
    };
}

/**
 * The default look of the rows of a dataset for each part a style rule colors (`point`,
 * `stroke` and `fill`). A row without a look of its own takes it.
 */
export type DatasetBaseStyle = Partial<Record<'point' | 'stroke' | 'fill', FeatureStyle>>;

/** Where a dataset goes in the stacking order. */
export interface DatasetPlacement {
    /** The division of the stacking order */
    order?: DatasetOrder;
    /** The position within the division, 0 at the back */
    index?: number;
}

/**
 * Where a dataset is stacked: below the layers of the document, above them, or inside the
 * layer order.
 */
export type DatasetOrder = 'belowLayers' | 'aboveLayers' | 'layerOrder';

/** The scale factor and the opacity the rows of a dataset are drawn with at a zoom. */
export type DatasetZoomScale = (zoom: number) => {
    scale: number;
    opacity: number;
};

/** How the point rows of a dataset that overlap on the screen are thinned out. */
export interface DatasetCollisionThinning {
    /** Whether the thinning is on; false when it is left out */
    enabled?: boolean;
    /** The zoom from which every row is drawn; 17 when it is left out */
    fullDisplayZoom?: number;
    /** The margin around each marker, in screen pixels; 2 when it is left out */
    marginPx?: number;
}

/** What the thinning of a dataset is doing now, for a message such as "showing n of N". */
export interface DatasetThinningStats {
    /** Whether the thinning is on */
    enabled: boolean;
    /** Whether it is thinning out rows at the current zoom */
    active: boolean;
    /** The number of rows */
    total: number;
    /** The number of rows drawn */
    visible: number;
    /** The zoom band the drawn rows were chosen for, or `null` */
    band: number | null;
}

// =============================================================================
// 領域: Store
// =============================================================================

// Store と、その読み書きの型は @sakuzu/maplibre-gl-draw/store の入口にある。この入口は、
// ファイルの先頭で Store の型だけを import して、DrawOptions.store、Draw.getStore、
// ExtensionContext.store に使う。変更の通知 (DocumentChange)、出どころ (UpdateSource)、
// 座標の計算 (TransformProvider) は、この入口の型である。

// =============================================================================
// 領域: 拡張 (plugin、mode、型、overlay、provider)
// =============================================================================

// --- plugin ---

/**
 * Every collection of extensions of a draw instance.
 */
export interface ExtensionsCollections {
    /** The plugins: bundles of other extensions and state */
    readonly plugins: PluginsCollection;
    /** The modes: ways of receiving input */
    readonly modes: ModesCollection;
    /** The custom feature types */
    readonly featureTypes: FeatureTypesCollection;
    /** The renderers that draw above the features or between the layers */
    readonly overlays: OverlaysCollection;
    /** The providers of snapping candidates */
    readonly snapProviders: ProvidersCollection<SnapProvider>;
    /** The providers of handles on the selected features */
    readonly handleProviders: ProvidersCollection<HandleProvider>;
    /** The providers of companions drawn one step below a feature */
    readonly companionProviders: ProvidersCollection<CompanionProvider>;
    /**
     * The providers of the contents of files the document names but does not hold, such as the
     * image of an Image feature kept elsewhere; asked in the order they were added
     */
    readonly fileProviders: ProvidersCollection<FileProvider>;
    /**
     * The computation of moves, rotations and scalings set now ({@link TransformProvider}).
     *
     * @returns The provider, or `undefined` when the built-in computation is used
     */
    getTransformProvider(): TransformProvider | undefined;
    /**
     * Sets the computation of the moves, rotations and scalings that the bulk edits write
     * (`features.translate`, `rotate`, `scale`, `duplicate` with an offset, and the drags and
     * keys that write with them), in place of the built-in one. One is used at a time: the
     * computations set are kept in the order they were set, and the one used is the last one set
     * that is still there. The function it returns takes out that computation only, wherever it
     * stands, so that taking out one set earlier leaves the one used as it is; the built-in
     * computation is used again when none is left. One set through the context of a plugin is
     * taken out when the plugin is removed.
     *
     * @returns The function that takes this computation out
     * @throws `DrawError` with the code `invalidInput` when the value does not have the shape of
     *   the contract
     */
    setTransformProvider(provider: TransformProvider): () => void;
}

/** The plugins, in the order they were added. */
export interface PluginsCollection {
    /**
     * Gets a plugin by name.
     *
     * @returns The plugin, or `undefined` when there is none with this name
     */
    get(name: string): Plugin | undefined;
    /** Lists the plugins in the order they were added. */
    list(): Plugin[];
    /** Counts the plugins. */
    count(): number;
    /** Whether a plugin with this name was added. */
    has(name: string): boolean;
    /**
     * Adds a plugin.
     *
     * @returns The function that removes it again
     * @throws `DrawError` with the code `alreadyExists` when a plugin with the same name was
     *   added
     *   or with `invalidInput` when the value does not have the shape of the contract
     */
    add(plugin: Plugin): () => void;
    /**
     * Adds several plugins in one transaction: all of them or none.
     *
     * @returns The function that removes them again
     * @throws `DrawError` with the code `alreadyExists` when one of the names is taken, or
     *   `invalidInput` when a value does not have the shape of the contract; nothing is added
     *   then
     */
    addMany(plugins: readonly Plugin[]): () => void;
    /**
     * Removes a plugin, with everything it added.
     *
     * @returns True when it was removed
     * @throws `DrawError` with the code `notFound` when there is no plugin with this name
     */
    remove(name: string): boolean;
    /**
     * Removes several plugins, with everything they added: all of them or none.
     *
     * @returns True when they were removed
     * @throws `DrawError` with the code `notFound` when one of the names does not exist;
     *   nothing is removed then
     */
    removeMany(names: readonly string[]): boolean;
    /**
     * The API a plugin offers to others.
     *
     * @returns The API, or `undefined` when there is no plugin with this name or it offers none
     */
    getApi<T>(name: string): T | undefined;
}

/**
 * A plugin: a bundle of modes, feature types, overlays, providers and state, added with
 * `draw.extensions.plugins.add`. What it adds through its context is removed by itself when
 * the plugin is removed. Plugins talk to each other through their `api`.
 *
 * @typeParam Api - The API the plugin offers to others
 */
export interface Plugin<Api = unknown> {
    /** The name it is registered under */
    readonly name: string;
    /** Called when the plugin is added; add its extensions and subscribe to events here. */
    onAdd(ctx: PluginContext): void;
    /** Called when the plugin is removed. */
    onRemove?(): void;
    /** The API others get with `draw.extensions.plugins.getApi(name)` */
    readonly api?: Api;
    /**
     * Receivers of the input, called before those of the mode. Returning true consumes the
     * event, so that the mode does not get it.
     */
    readonly input?: Partial<InputHandlers>;
    /** The hooks of the select mode, and an exclusive interaction of the plugin */
    readonly interaction?: {
        /**
         * Narrows the candidates of a selection (a click, a box, `selection.set`) to the IDs it
         * returns, a set of them ({@link createIdSet}, or the candidates as they are); a box over
         * many features gives many candidates, read without an array of them
         */
        filterSelection?(candidateIds: IdSet): IdSet;
        /** A selected feature was clicked again; returning true means the plugin handled it */
        onFeatureClick?(feature: Feature, event: DrawPointerEvent): boolean;
        /** A feature was double-clicked; returning true means the plugin handled it */
        onFeatureDoubleClick?(feature: Feature, event: DrawPointerEvent): boolean;
        /**
         * A drawing mode created a feature: a commit of `ModeContext.commitFeature`, which the
         * built-in drawing modes use too, or the image placed by the load that follows a request
         * of the image mode
         */
        onDrawCommit?(feature: Feature): void;
        /** Whether the plugin is in an exclusive interaction, during which the mode stays still */
        isBusy?(): boolean;
        /** Completes the exclusive interaction */
        finish?(): void;
        /** Cancels the exclusive interaction */
        cancel?(): void;
        /** The element of the exclusive interaction; clicks inside it are left to the plugin */
        container?(): HTMLElement | null;
    };
}

/**
 * The context of a plugin.
 */
export interface PluginContext extends ExtensionContext {
    /**
     * The same collections as `draw.extensions`. What a plugin adds through them is removed by
     * itself when the plugin is removed.
     */
    readonly extensions: ExtensionsCollections;
}

/**
 * What every context of an extension has: the public API, the Store, the events, the
 * terrain, the automatic names, the screen and a way to redraw, and the shape being drawn.
 */
export interface ExtensionContext {
    /** The whole public API; an extension reads and writes the document through it */
    readonly draw: Draw;
    /**
     * The Store of the document, the one `draw.getStore()` returns: for an extension that writes
     * into the document a change made outside this instance (one it read from elsewhere, or a
     * large document built in a Worker), with the source `'remote'`. A
     * write to it does not go through the checks of read-only and the locks, so an edit of the
     * user, and the writing back of the values a change had before, go through `draw` instead;
     * the state of this client is read through `draw` too
     */
    readonly store: Store;
    /**
     * Subscribes to an event, with the same names as `draw.on`. The subscription ends by itself
     * when the extension is removed.
     *
     * @returns The function that unsubscribes
     */
    on<K extends keyof DrawEvents>(event: K, listener: (payload: DrawEvents[K]) => void): () => void;
    /** Unsubscribes from an event. */
    off<K extends keyof DrawEvents>(event: K, listener: (payload: DrawEvents[K]) => void): void;
    /**
     * Subscribes to the next occurrence of an event only.
     *
     * @returns The function that unsubscribes before it occurs
     */
    once<K extends keyof DrawEvents>(event: K, listener: (payload: DrawEvents[K]) => void): () => void;
    /** The positions and the heights on the terrain */
    readonly terrain: TerrainAnchors;
    /** The automatic names of new features, layers and groups */
    readonly names: NameGenerator;
    /** The conversion between the map and the screen */
    readonly screen: ScreenContext;
    /**
     * Asks for the features to be drawn again.
     *
     * @param filter - Only the features of this type, or with these IDs; every feature when it
     *   is left out
     */
    invalidate(filter?: {
        type?: string;
        ids?: string[];
    }): void;
    /**
     * The shape the current drawing mode is drawing: the same object as `draw.drawing`, to place,
     * finish and cancel it, and take back and put back its vertices
     */
    readonly drawing: DrawingResource;
}

/**
 * The automatic names of new features, layers and groups.
 *
 * The number of a name is never used twice while the document is open: the numbers this
 * instance gave are kept, so that a name deleted ("Point 7") is not given again. When a document
 * is opened (loaded, or read into the Store), the numbers start after the largest number of the
 * automatic names it holds.
 */
export interface NameGenerator {
    /**
     * The next name for a type.
     *
     * @returns The name, or `undefined` for a feature when automatic names are off
     */
    next(type: FeatureType | 'Layer' | 'Group'): string | undefined;
}

/** The conversion between positions on the map and points on the screen. */
export interface ScreenContext {
    /** The point on the screen of a position. */
    project(lngLat: Position): ScreenPoint;
    /** The position on the map of a point on the screen. */
    unproject(point: ScreenPoint): Position;
    /**
     * The extent of a feature on the screen, in pixels, as it is drawn (see
     * {@link SketchesCollection}); a feature off the screen still has one.
     *
     * @returns The corners of the extent, or `null` when the feature has nothing to draw
     */
    bounds(feature: Feature): {
        min: ScreenPoint;
        max: ScreenPoint;
    } | null;
    /**
     * The outline of the selection frame of a feature on the screen, in pixels, as it is drawn
     * (see {@link SketchesCollection}), without the
     * margin the frame is drawn with (`selectionStyle.boundingBox.margin`): its four corners in
     * the order top left, top right, bottom right, bottom left of the shape as it stands
     * unturned. It answers for every type: an image and any other turned shape give the turned
     * corners, a line or an area the corners of its extent, a point the square its marker
     * spans (its radius and its outline), and a custom type the corners of its `outline`, or of
     * its `bounds` when it has none. A feature
     * off the screen still has one. The engine draws the frame with every edge moved the margin
     * outward from these corners.
     *
     * A custom type must not call it for its own features from its `outline` or `bounds`, which
     * it calls.
     *
     * @returns The four corners, or an empty array when the feature has nothing to draw
     */
    outline(feature: Feature): ScreenPoint[];
    /** The zoom of the map */
    readonly zoom: number;
    /** The pixel ratio the drawing uses */
    readonly pixelRatio: number;
}

/** The positions and the heights on the terrain, for placing things on it. */
export interface TerrainAnchors {
    /**
     * The point on the screen of a position lifted to the ground.
     *
     * @returns The point, or `null` when the terrain is off or not ready
     */
    project(lngLat: Position): ScreenPoint | null;
    /**
     * The height of the ground at a position.
     *
     * @returns The height in meters; 0 when the terrain is off
     */
    elevation(lngLat: Position): number;
    /**
     * The opacity for a mark at a position: lower when the terrain hides it from the camera.
     *
     * @returns A value from 0 to 1; 1 when the terrain is off
     */
    ghostOpacity(lngLat: Position): number;
    /** A number that changes whenever the heights `elevation` returns may have changed. */
    generation(): number;
}

// --- mode ---

/** The modes that were added, by name. */
export interface ModesCollection {
    /**
     * Gets the factory of a mode by name; for a built-in mode that is overridden, the factory
     * that overrides it.
     *
     * @returns The factory, or `undefined` when there is no mode with this name
     */
    get(name: string): ModeFactory | undefined;
    /** Lists the names of the modes, those of the overridden built-in modes included. */
    list(): string[];
    /** Counts the modes, as `list` lists them. */
    count(): number;
    /** Whether a mode with this name was added, or is a built-in mode that is overridden. */
    has(name: string): boolean;
    /**
     * Adds a mode under a name.
     *
     * @returns The function that removes it again
     * @throws `DrawError` with the code `alreadyExists` when the name is taken
     *   or with `invalidInput` when the value does not have the shape of the contract
     */
    add(name: string, factory: ModeFactory): () => void;
    /**
     * Adds several modes in one transaction: all of them or none.
     *
     * @returns The function that removes them again
     * @throws `DrawError` with the code `alreadyExists` when one of the names is taken, or
     *   `invalidInput` when a value does not have the shape of the contract; nothing is added
     *   then
     */
    addMany(entries: readonly {
        name: string;
        factory: ModeFactory;
    }[]): () => void;
    /**
     * Overrides a built-in mode (one of {@link MODES}, `select` included) with a factory of the
     * same name: `draw.setMode(name)`, and every built-in way into the mode, enter the factory
     * given from then on.
     *
     * The built-in mode comes back with the function it returns, with `remove(name)`, and, for a
     * plugin that overrode it through its context, when the plugin is removed. `add` keeps
     * refusing the names of the built-in modes. When the mode overridden, or put back, is the
     * current mode, the instance enters `select` again, as it does when the current mode is
     * removed.
     *
     * @returns The function that puts the built-in mode back
     * @throws `DrawError` with the code `invalidInput` when the name is not one of the built-in
     *   modes or the value does not have the shape of the contract, and `alreadyExists` when the
     *   mode is already overridden
     */
    override(name: string, factory: ModeFactory): () => void;
    /**
     * Removes a mode, or the factory that overrides a built-in mode (the built-in mode comes
     * back).
     *
     * @returns True when it was removed
     * @throws `DrawError` with the code `notFound` when there is no mode with this name
     */
    remove(name: string): boolean;
    /**
     * Removes several modes: all of them or none.
     *
     * @returns True when they were removed
     * @throws `DrawError` with the code `notFound` when one of the names does not exist;
     *   nothing is removed then
     */
    removeMany(names: readonly string[]): boolean;
}

/**
 * The function that creates the handler of a mode. It is registered once, under its name,
 * with `draw.extensions.modes.add(name, factory)`.
 */
export type ModeFactory = (ctx: ModeContext) => ModeHandler;

/**
 * The contract of a mode: how it enters, exits and receives the input. Every member is
 * optional; returning true from an input receiver consumes the event.
 */
export interface ModeHandler extends Partial<InputHandlers> {
    /**
     * Whether the mode writes new features. Such a mode is entered only while a layer can be
     * written, and a double click never zooms the map while it is the current mode, whether or
     * not it takes the double click; false when it is left out.
     */
    readonly writes?: boolean;
    /** How the mode wants the positions of its input snapped; every input snaps when left out */
    readonly snapPreference?: SnapPreference;
    /** Called when the mode is entered */
    onEnter?(): void;
    /** Called when the mode is left */
    onExit?(): void;
    /**
     * Called when the mode is interrupted: by an Escape that neither a plugin nor the mode
     * consumed, or when the Store replaces its whole document (a notification with
     * `reset: true`). The mode drops what it was drawing and stays the current mode.
     */
    onCancel?(): void;
    /**
     * Removes the last vertex of the shape being drawn, as `ctx.drawing.undoVertex` asks.
     *
     * @returns True when a vertex was removed
     */
    onUndoVertex?(): boolean;
    /**
     * Puts back the vertex the last `onUndoVertex` removed, as `ctx.drawing.redoVertex` asks.
     *
     * @returns True when a vertex was put back
     */
    onRedoVertex?(): boolean;
}

/**
 * The context of a mode.
 */
export interface ModeContext extends ExtensionContext {
    /**
     * Changes the mode.
     *
     * @returns False when the mode cannot be entered now
     */
    setMode(mode: Mode): boolean;
    /**
     * The topmost feature or dataset row at a point on the screen, the features as they are
     * drawn (with the sketches, see {@link SketchesCollection}).
     *
     * @param options - `tolerancePx` is how far from the point a hit may be, in pixels
     * @returns What was hit, or `null`
     */
    hitTest(point: ScreenPoint, options?: {
        tolerancePx?: number;
    }): Hit | null;
    /**
     * Where a point on the screen snaps to, the features as they are drawn (see
     * {@link SketchesCollection}); its own position when nothing is snapped to.
     */
    snap(point: ScreenPoint): SnapResult;
    /**
     * Creates a feature the way the built-in modes do: the writable layer, the ID, the
     * automatic name and the reference zoom follow the same rules.
     *
     * @returns The new feature, or `null` when it is refused (read-only, a lock)
     */
    commitFeature(input: FeatureInput): Feature | null;
    /** Shows the shape being drawn before it is created. */
    readonly preview: {
        /**
         * Shows this shape as the one being drawn.
         *
         * @param options - `confirmedVertices` is how many vertices from the start are placed:
         *   the line up to them is drawn solid and the rest, up to the pointer, dashed (every
         *   vertex when it is left out); `highlightVertex` is the index of a vertex drawn
         *   highlighted, such as the first vertex of an area the next click would close
         */
        set(feature: FeatureInput, options?: {
            confirmedVertices?: number;
            highlightVertex?: number;
        }): void;
        /** Stops showing it */
        clear(): void;
    };
    /** The cursor of the map. */
    readonly cursor: {
        /** Sets the cursor, as a CSS cursor value */
        set(cursor: string): void;
        /**
         * Goes back to the cursor of the mode: the one it set in `onEnter`, or the cursor of the
         * map when it set none there. The cursor the mode set is taken back when it is left.
         */
        reset(): void;
    };
    /** The look of the selected features. */
    readonly selectionStyle: Required<SelectionStyleOptions>;
    /**
     * The layer a new feature goes into: the active layer when it can be written (it exists,
     * is visible, is not locked and not hidden on this client), otherwise the first layer that
     * can.
     *
     * @returns The layer, or `null` when no layer can be written
     */
    writableLayer(): Layer | null;
    /**
     * The rows of the datasets that a shape can trace along, within an extent. Empty when
     * snapping to the datasets is off.
     *
     * @param bbox - The extent, as `[west, south, east, north]` in degrees
     * @returns The rows, each with the ID of its dataset and its index there; the dataset finds
     *   a row by the ID of a snapping target with `draw.datasets.get(datasetId).findRow(id)`
     */
    listTraceRows(bbox: BBox): {
        datasetId: string;
        rowIndex: number;
        row: DatasetRow;
    }[];
}

/**
 * The receivers of the input; `Plugin.input` and `ModeHandler` take any of them. Returning
 * true consumes the event, so that nothing after the receiver gets it.
 */
export interface InputHandlers {
    /** A pointer was pressed */
    onPointerDown(event: DrawPointerEvent): boolean | void;
    /** The pointer moved without a drag */
    onPointerMove(event: DrawPointerEvent): boolean | void;
    /** A pointer was released */
    onPointerUp(event: DrawPointerEvent): boolean | void;
    /** The pointer left the map */
    onPointerLeave(): boolean | void;
    /** A click */
    onClick(event: DrawPointerEvent): boolean | void;
    /** A double click */
    onDoubleClick(event: DrawPointerEvent): boolean | void;
    /** A drag started */
    onDragStart(event: DrawPointerEvent): boolean | void;
    /** The pointer moved during a drag */
    onDrag(event: DrawPointerEvent): boolean | void;
    /** A drag ended */
    onDragEnd(event: DrawPointerEvent): boolean | void;
    /** A drag was cancelled */
    onDragCancel(event: DrawPointerEvent): boolean | void;
    /** A key was pressed */
    onKeyDown(event: DrawKeyEvent): boolean | void;
    /** A key was released */
    onKeyUp(event: DrawKeyEvent): boolean | void;
}

/** A pointer input on the map, as a mode and a plugin receive it. */
export interface DrawPointerEvent {
    /** The point on the screen */
    point: ScreenPoint;
    /** The position on the map */
    lngLat: Position;
    /** Where the input snaps to; the position of the pointer when nothing is snapped to */
    snapped: SnapResult;
    /** The modifier keys held */
    modifiers: Modifiers;
    /** The kind of pointer */
    pointerType: 'mouse' | 'touch' | 'pen';
    /** The event of the browser */
    original: PointerEvent;
    /**
     * True when the input was made from code by `draw.drawing` (`addVertex`, `moveTo`), not by
     * the pointer. Its position is exact: a mode applies no click tolerance to it, so a vertex
     * placed a few pixels from another is kept, and only one at exactly the same position is
     * the same vertex. Left out for the input of the pointer.
     */
    programmatic?: boolean;
}

/** A key input, as a mode and a plugin receive it. */
export interface DrawKeyEvent {
    /** The key, as `KeyboardEvent.key` gives it */
    key: string;
    /** The modifier keys held */
    modifiers: Modifiers;
    /** The event of the browser */
    original: KeyboardEvent;
}

/** The modifier keys held during an input. */
export interface Modifiers {
    /** Whether Shift was held */
    shift: boolean;
    /** Whether Control was held */
    ctrl: boolean;
    /** Whether Alt (Option on macOS) was held */
    alt: boolean;
    /** Whether Meta (Command on macOS) was held */
    meta: boolean;
}

// --- 型 (feature type と描画) ---

/**
 * The custom feature types, by type name, and the definitions that override a built-in type.
 */
export interface FeatureTypesCollection {
    /**
     * Gets the definition of a feature type by name: a type that was added, or the definition
     * that overrides a built-in type.
     *
     * @returns The definition, or `undefined` when there is none with this name
     */
    get(name: string): FeatureTypeDefinition | undefined;
    /** Lists the names of the feature types that were added or overridden. */
    list(): string[];
    /** Counts the feature types that were added or overridden. */
    count(): number;
    /** Whether a feature type with this name was added or overridden. */
    has(name: string): boolean;
    /**
     * Adds a custom feature type. The type takes every feature of its type: its `appliesTo`, if
     * it has one, is ignored.
     *
     * @returns The function that removes it again
     * @throws `DrawError` with the code `alreadyExists` when the type name is taken
     *   or with `invalidInput` when the value does not have the shape of the contract
     */
    add(definition: FeatureTypeDefinition): () => void;
    /**
     * Adds several custom feature types in one transaction: all of them or none.
     *
     * @returns The function that removes them again
     * @throws `DrawError` with the code `alreadyExists` when one of the names is taken, or
     *   `invalidInput` when a value does not have the shape of the contract; nothing is added
     *   then
     */
    addMany(definitions: readonly FeatureTypeDefinition[]): () => void;
    /**
     * Overrides a built-in feature type (`Point`, `LineString`, `Polygon`, `Circle`,
     * `Freehand` or `Image`) with a definition of the same `type` and the same kind of
     * `geometry` as the built-in one (`Point` for a circle and an image, `LineString` for a
     * freehand line). The features of the type are drawn by its renderer from then on. Its
     * `hitTest`, `boxSelect`, `bounds`, `outline`, `bbox` and `snapCandidates` replace those of
     * the built-in type when it has them, and the built-in ones stay for the members it leaves
     * out. Its `handles` are shown with those of the built-in type. With `appliesTo`, it takes
     * only the features for which that returns true, and the others keep the built-in type
     * entirely. Its `transformFields`, when it has them, apply to the features it takes in
     * place of all those of the built-in type; when it has none, those of the built-in type
     * stay (the rotation and the scale of an image, the radius of a circle).
     *
     * The built-in type comes back with the function it returns, with `remove(type)`, and, for
     * a plugin that overrode it through its context, when the plugin is removed. `add` keeps
     * refusing the names of the built-in types.
     *
     * @returns The function that puts the built-in type back
     * @throws `DrawError` with the code `invalidInput` when the type is not one of the
     *   built-in types above, its `geometry` is not the one of the built-in type, or the value
     *   does not have the shape of the contract, and `alreadyExists` when the type is already
     *   overridden
     */
    override(definition: FeatureTypeDefinition): () => void;
    /**
     * Removes a custom feature type, or the definition that overrides a built-in type (the
     * built-in type comes back).
     *
     * @returns True when it was removed
     * @throws `DrawError` with the code `notFound` when there is no type with this name
     */
    remove(name: string): boolean;
    /**
     * Removes several custom feature types: all of them or none.
     *
     * @returns True when they were removed
     * @throws `DrawError` with the code `notFound` when one of the names does not exist;
     *   nothing is removed then
     */
    removeMany(names: readonly string[]): boolean;
}

/**
 * The definition of a custom feature type. Its handles and snapping candidates are written
 * here; a provider is only for the types an extension does not define.
 */
export interface FeatureTypeDefinition {
    /** The name of the type; it is registered under this name */
    readonly type: string;
    /** The kind of GeoJSON geometry the features of this type have; one kind per type */
    readonly geometry: Geometry['type'];
    /**
     * How far beyond its geometry a feature of this type can be hit, in pixels, such as the
     * half size of an icon drawn on a point. The candidates of a hit test are gathered this much
     * farther out; 0 when it is left out.
     */
    readonly hitPaddingPx?: number;
    /** How the features of this type are drawn */
    readonly renderer: FeatureRenderer;
    /**
     * Which features of the type the definition takes, for a definition that overrides a
     * built-in type (`extensions.featureTypes.override`). A feature for which it returns false
     * keeps the built-in type: its built-in drawing (drawn in batches with the other features),
     * hit test, box selection, selection frame, handles, snapping candidates, extent and fields
     * of rotation and size. The others are drawn, hit and framed by this definition. Every
     * feature of the type is taken when it is left out.
     *
     * It is given a sample of the feature, not the feature: its type, its style and its
     * attributes read one key at a time, so that a type of 100,000 features is asked without a
     * feature being made for each. It is asked again whenever the style or an attribute of a
     * feature changes, so its answer must follow from them and nothing else. It is ignored in a
     * definition given to `add`: a custom type takes every feature of its type.
     */
    appliesTo?(feature: FeatureCandidate): boolean;
    /**
     * The fields of its features that the moves, rotations and scalings change with their
     * geometry: the keys of `properties` that hold their rotation, their direction and their
     * size, and whether a scaling keeps their shape. The bulk edits `rotate` and `scale` write
     * them (and so do the drags of the rotate and resize handles, which write with them), and the
     * computation of moves is given their values (`TransformInput.rotationDegrees`,
     * `bearingDegrees`, `size` and `isScaledUniformly`).
     *
     * A definition that overrides a built-in type can declare them for the features it takes
     * (`appliesTo`): a point that shows a symbol turned to a direction declares the key of that
     * direction. Without it, the moves, rotations and scalings change the geometry of the features
     * only, whatever keys they have; the built-in types have their own (the rotation and the
     * factor of an image, the radius of a circle).
     */
    readonly transformFields?: TransformFields;
    /**
     * The extent of a feature on the map, `[west, south, east, north]` in degrees, for a type
     * that draws beyond its geometry by a distance on the ground. The spatial index takes it:
     * it gathers the candidates of a hit test and of a box selection, answers
     * `features.list({ bbox })`, and decides which features are near enough to the view to be
     * drawn. The extent of the geometry is used when it is left out, and when it returns an
     * extent that is not four finite numbers from the west and south to the east and north.
     *
     * It is measured when a feature changes; call `invalidate({ type })` when it depends on
     * something outside the document. A reach in pixels belongs in `hitPaddingPx`.
     */
    bbox?(feature: Feature): BBox;
    /**
     * Hit tests a feature of this type, given as it is drawn (see {@link SketchesCollection});
     * the geometry is hit tested when it is left out.
     *
     * @returns What was hit, or `null`
     */
    hitTest?(feature: Feature, ctx: HitTestContext): Hit | null;
    /**
     * Whether a box selection takes a feature of this type, given as it is drawn (see
     * {@link SketchesCollection}).
     *
     * @param box - The corners of the box on the screen, in pixels
     */
    boxSelect?(feature: Feature, box: {
        min: ScreenPoint;
        max: ScreenPoint;
    }, ctx: HitTestContext): boolean;
    /**
     * The extent of the selection box of a feature on the screen, in pixels, given as it is
     * drawn (see {@link SketchesCollection}).
     *
     * @returns The corners of the extent, or `null` when the feature has nothing to draw
     */
    bounds?(feature: Feature, ctx: ScreenContext): {
        min: ScreenPoint;
        max: ScreenPoint;
    } | null;
    /**
     * The outline of the selection frame of a feature on the screen, in pixels, given as it is
     * drawn (see {@link SketchesCollection}), for a type whose shape turns: its four corners in
     * the order top left, top right, bottom right, bottom left
     * of the shape as it stands unturned, without the margin of the frame
     * (`selectionStyle.boundingBox.margin`). The engine draws the selection frame along it when
     * it is given, and from `bounds` otherwise, with every edge moved the margin outward. For a
     * type of any geometry but `Point`, the resize and rotate handles sit on the corners of that
     * frame too; a `Point` type keeps a frame with no such handles.
     *
     * @returns The four corners; anything else (or an empty array) gives the frame of `bounds`
     */
    outline?(feature: Feature, ctx: ScreenContext): ScreenPoint[];
    /**
     * The handles that resize or reshape a selected feature, given as it is drawn (see
     * {@link SketchesCollection}). The engine draws them with the
     * look of the vertex handles, hit tests them at the same size, and gives their drags to
     * `onHandleDrag`.
     */
    handles?(feature: Feature, ctx: ScreenContext): Handle[];
    /**
     * The change a drag of one of its handles makes. It is called for every move of the drag,
     * and the feature is drawn with its patch by a sketch of the select mode (`update`), which
     * writes nothing; `drag.changed` carries the patch (`patch`). It is called once more when
     * the drag ends, and that patch is written. The drag keeps the rules of the other drags: the
     * sketch is marked `isBeingWritten` when the pointer is let go of, and an extension can take
     * the feature out of the drag (`draw.drag.remove`), which then ends as cancelled.
     *
     * @returns The patch to apply to the feature, or `null` for no change
     */
    onHandleDrag?(feature: Feature, handle: Handle, event: DrawPointerEvent): FeaturePatch | null;
    /**
     * A drag of one of its handles is about to start, before the first `onHandleDrag`.
     *
     * @returns False to refuse the drag; no `onHandleDrag` nor `onHandleDragEnd` follows then
     */
    onHandleDragStart?(feature: Feature, handle: Handle, event: DrawPointerEvent): boolean;
    /**
     * A drag of one of its handles ended, after the last `onHandleDrag` and its patch. It is
     * called once for every drag that started, also when the drag is cut short.
     *
     * @param feature - The feature as it is now, or `null` when it is gone
     */
    onHandleDragEnd?(feature: Feature | null, handle: Handle, event: DrawPointerEvent): void;
    /**
     * The snapping candidates a feature of this type offers, given as it is drawn (see
     * {@link SketchesCollection}).
     */
    snapCandidates?(feature: Feature, ctx: SnapContext): SnapCandidate[];
}

/**
 * What a definition that overrides a built-in type reads of a feature to say whether it takes it
 * (`FeatureTypeDefinition.appliesTo`), without the feature being made.
 */
export interface FeatureCandidate {
    /** The type of the feature */
    readonly type: FeatureType;
    /** The style of the feature, as it holds it (shared with the features of the same style) */
    readonly style: Readonly<FeatureStyle>;
    /**
     * The value of an attribute of the feature (`properties`), read by its key.
     *
     * @returns The value, or `undefined` when the feature does not hold the key
     */
    getProperty(key: string): unknown;
}

/**
 * The fields of the features of a type that the moves, rotations and scalings change with their
 * geometry, as the type declares them (`FeatureTypeDefinition.transformFields`): the keys of
 * `properties` that hold them. A feature without a key of them starts from 0 for a rotation and
 * a direction, and from 1 for a size.
 *
 * For example, a type of signboards whose features keep their rotation under `boardAngle` and the
 * factor of their size under `boardScale`, and keep their shape when they are scaled, declares
 * `{ rotationDegreesKey: 'boardAngle', sizeKey: 'boardScale', isScaledUniformly: true }`.
 */
export interface TransformFields {
    /**
     * The key that holds the rotation of a feature, in degrees counterclockwise seen from above.
     * A rotation adds its angle to it, within [0, 360). A rotation of a single feature of a
     * `Point` geometry with this key turns it about its position.
     */
    readonly rotationDegreesKey?: string;
    /**
     * The key that holds a direction of a feature, in degrees clockwise from the north, unlike
     * `rotationDegreesKey` (a turn counterclockwise of the shape itself) (a
     * bearing): the direction a symbol on a point faces, say. A rotation takes its angle away from
     * it, within [0, 360), so the feature still faces the same way on the ground after it.
     */
    readonly bearingDegreesKey?: string;
    /**
     * The key that holds the factor of the size of a feature, 1 for the size it was made at. A
     * scaling multiplies it by `sizeFactor`.
     */
    readonly sizeKey?: string;
    /**
     * Whether a scaling moves the positions of a feature by `sizeFactor` along both the east and
     * the north, so that it keeps its shape, in place of `eastFactor` and `northFactor`; false
     * when it is left out.
     */
    readonly isScaledUniformly?: boolean;
}

/** One handle on a selected feature. */
export interface Handle {
    /** The ID of the handle, unique within the feature */
    id: string;
    /** The position of the handle */
    position: Position;
    /** The kind of handle, as its provider names it */
    kind: string;
    /** The CSS cursor over the handle */
    cursor?: string;
}

/**
 * How the features of a custom type are drawn. The methods take their arguments in the order
 * of a custom layer of the map.
 */
export interface FeatureRenderer {
    /** Called when the renderer is added to the map; create the programs and buffers here. */
    onAdd(map: MaplibreMap, gl: WebGL2RenderingContext): void;
    /** Draws one feature, given as it is drawn: with the sketches (see {@link SketchesCollection}). */
    draw(feature: Feature, ctx: RenderContext): void;
    /** Called when the renderer is removed; release what `onAdd` created. */
    onRemove(map: MaplibreMap, gl: WebGL2RenderingContext): void;
}

/**
 * The shared renderer of point markers. It only draws; the zoom, the projection and the
 * terrain come from the {@link RenderContext} it was taken from.
 */
export interface PointRenderer {
    /**
     * Draws a point marker.
     *
     * @param position - The position
     * @param style - The shape, the size in pixels, the fill and the outline (CSS colors,
     *   opacities from 0 to 1, the outline width in pixels)
     * @param options - `elevationMeters` places the marker at this height instead of on the
     *   ground
     */
    draw(position: Position, style: {
        shape: PointShape;
        size: number;
        fillColor: string;
        fillOpacity: number;
        strokeColor: string;
        strokeWidth: number;
        strokeOpacity: number;
    }, options?: {
        elevationMeters?: number;
    }): void;
}

/**
 * The shared renderer of lines. It only draws; the zoom, the projection and the terrain come
 * from the {@link RenderContext} it was taken from.
 */
export interface LineRenderer {
    /**
     * Draws a line.
     *
     * @param coordinates - The positions of the line
     * @param style - The width in pixels, the CSS color, the opacity from 0 to 1, the dash
     *   pattern, and a custom `[dash, gap]` in pixels
     * @param options - `closed` joins the last position to the first; `widthUnit` says whether
     *   the width is in pixels or meters; `createdZoom` is the zoom at which the width applies,
     *   so that the line grows and shrinks with the zoom
     */
    draw(coordinates: readonly Position[], style: {
        width: number;
        color: string;
        opacity: number;
        lineStyle: LineStyle;
        dashArray?: number[];
    }, options?: {
        closed?: boolean;
        widthUnit?: 'pixels' | 'meters';
        createdZoom?: number;
    }): void;
}

/**
 * The shared renderer of areas. It only draws; the zoom, the projection and the terrain come
 * from the {@link RenderContext} it was taken from.
 */
export interface FillRenderer {
    /**
     * Fills an area.
     *
     * @param rings - The outer ring first, then the holes
     * @param style - The CSS color and the opacity from 0 to 1
     */
    draw(rings: readonly (readonly Position[])[], style: {
        color: string;
        opacity: number;
    }): void;
}

/**
 * Everything a renderer needs to draw a frame. The offsets are already computed.
 */
export interface RenderContext {
    /** The WebGL context of the map */
    readonly gl: WebGL2RenderingContext;
    /** The shader prelude of the current projection */
    readonly shader: ShaderData;
    /** The values for drawing relative to the center of the view */
    readonly offset: OffsetUniforms;
    /** The projection of the frame, as the map passes it to a custom layer */
    readonly projection: ProjectionData;
    /** The zoom of the frame */
    readonly zoom: number;
    /** The pixel ratio of the drawing */
    readonly pixelRatio: number;
    /** The opacity of the layer being drawn, from 0 to 1 */
    readonly opacity: number;
    /**
     * The positions and the heights on the terrain. The functions of the `/webgl` entry that
     * draw on the terrain take it, or the whole render context.
     */
    readonly terrain: TerrainAnchors;
    /** The shared renderer of lines */
    readonly line: LineRenderer;
    /** The shared renderer of areas */
    readonly fill: FillRenderer;
    /** The shared renderer of point markers */
    readonly point: PointRenderer;
}

/**
 * The shader prelude the map passes to a custom layer, for compiling programs for the current
 * projection.
 */
export interface ShaderData {
    /** The GLSL the map prepends to a vertex shader (its projection functions) */
    vertexShaderPrelude: string;
    /** The `#define` lines of the current projection */
    define: string;
    /** The name of the projection variant; a program is compiled again when it changes */
    variantName: string;
}

/**
 * The values for drawing positions relative to the center of the view, which keeps the
 * precision of 32-bit floats near the camera.
 */
export interface OffsetUniforms {
    /** The center, rounded to 32-bit floats for the shader */
    centerLngLat: [number, number];
    /** The center at 64-bit precision, for the offsets computed on the CPU */
    centerLngLat64: [number, number];
    /** The Mercator coordinates of the center, at 64-bit precision */
    centerMercator: [number, number];
    /** The center of the view in clip space, at 64-bit precision */
    projectionCenter: [number, number, number, number];
    /** The Mercator units per degree of longitude and latitude at the center */
    unitsPerDegree: [number, number, number];
    /** The second-order correction of `unitsPerDegree` for the change with latitude */
    unitsPerDegree2: [number, number, number];
}

// --- overlay ---

/** The renderers that draw above the features or between the layers, by name. */
export interface OverlaysCollection {
    /**
     * Gets an overlay renderer by name.
     *
     * @returns The renderer, or `undefined` when there is none with this name
     */
    get(name: string): OverlayRenderer | undefined;
    /** Lists the names of the overlay renderers. */
    list(): string[];
    /** Counts the overlay renderers. */
    count(): number;
    /** Whether an overlay renderer with this name was added. */
    has(name: string): boolean;
    /**
     * Adds an overlay renderer.
     *
     * @returns The function that removes it again
     * @throws `DrawError` with the code `alreadyExists` when the name is taken
     *   or with `invalidInput` when the value does not have the shape of the contract
     */
    add(renderer: OverlayRenderer): () => void;
    /**
     * Adds several overlay renderers in one transaction: all of them or none.
     *
     * @returns The function that removes them again
     * @throws `DrawError` with the code `alreadyExists` when one of the names is taken, or
     *   `invalidInput` when a value does not have the shape of the contract; nothing is added
     *   then
     */
    addMany(renderers: readonly OverlayRenderer[]): () => void;
    /**
     * Removes an overlay renderer.
     *
     * @returns True when it was removed
     * @throws `DrawError` with the code `notFound` when there is none with this name
     */
    remove(name: string): boolean;
    /**
     * Removes several overlay renderers: all of them or none.
     *
     * @returns True when they were removed
     * @throws `DrawError` with the code `notFound` when one of the names does not exist;
     *   nothing is removed then
     */
    removeMany(names: readonly string[]): boolean;
}

/**
 * A renderer that draws above the features, or between the layers.
 */
export interface OverlayRenderer {
    /** The name it is registered under */
    readonly name: string;
    /**
     * The order among the overlays: a lower one is drawn first, below a higher one. Overlays of
     * the same order are drawn in the order they were added; 0 when it is left out.
     */
    readonly order?: number;
    /** Called when the renderer is added to the map; create the programs and buffers here. */
    onAdd(map: MaplibreMap, gl: WebGL2RenderingContext): void;
    /** Draws above every layer. */
    draw(ctx: RenderContext): void;
    /** Draws just above one layer, for an overlay drawn between the layers. */
    drawForLayer?(layerId: string, ctx: RenderContext): void;
    /**
     * Draws the vertices of what the overlay shows, above the features of every layer and the
     * selection, so that they stay visible over a layer further back.
     */
    drawVertices?(ctx: RenderContext): void;
    /** Whether some of its drawing has not finished yet. */
    hasPendingWork?(): boolean;
    /** Called when the renderer is removed; release what `onAdd` created. */
    onRemove(map: MaplibreMap, gl: WebGL2RenderingContext): void;
}

// --- provider ---

/**
 * The providers of one kind, by name: snapping candidates, handles, companions, or the
 * contents of files.
 *
 * @typeParam T - The kind of provider
 */
export interface ProvidersCollection<T> {
    /**
     * Gets a provider by name.
     *
     * @returns The provider, or `undefined` when there is none with this name
     */
    get(name: string): T | undefined;
    /** Lists the names of the providers. */
    list(): string[];
    /** Counts the providers. */
    count(): number;
    /** Whether a provider with this name was added. */
    has(name: string): boolean;
    /**
     * Adds a provider.
     *
     * @returns The function that removes it again
     * @throws `DrawError` with the code `alreadyExists` when the name is taken
     *   or with `invalidInput` when the value does not have the shape of the contract
     */
    add(provider: T): () => void;
    /**
     * Adds several providers in one transaction: all of them or none.
     *
     * @returns The function that removes them again
     * @throws `DrawError` with the code `alreadyExists` when one of the names is taken, or
     *   `invalidInput` when a value does not have the shape of the contract; nothing is added
     *   then
     */
    addMany(providers: readonly T[]): () => void;
    /**
     * Removes a provider.
     *
     * @returns True when it was removed
     * @throws `DrawError` with the code `notFound` when there is no provider with this name
     */
    remove(name: string): boolean;
    /**
     * Removes several providers: all of them or none.
     *
     * @returns True when they were removed
     * @throws `DrawError` with the code `notFound` when one of the names does not exist;
     *   nothing is removed then
     */
    removeMany(names: readonly string[]): boolean;
}

/** An extension that adds snapping candidates. */
export interface SnapProvider {
    /** The name it is registered under */
    readonly name: string;
    /** The candidates near the point of the context. */
    candidates(ctx: SnapContext): SnapCandidate[];
}

/** One snapping candidate. */
export interface SnapCandidate {
    /** The position to snap to */
    position: Position;
    /** The kind of candidate; a provider may use a kind of its own */
    kind: 'vertex' | 'edge' | 'intersection' | 'guide' | (string & {});
    /** The priority among candidates at the same distance; higher wins */
    priority?: number;
    /** Where the candidate came from, for display */
    source?: string;
}

/** What a provider of snapping candidates receives. */
export interface SnapContext {
    /** The point on the screen */
    point: ScreenPoint;
    /** The position on the map */
    lngLat: Position;
    /** How far from the point a candidate may be, in pixels */
    tolerancePx: number;
    /** The conversion between the map and the screen */
    screen: ScreenContext;
    /** The IDs of the features that must not be snapped to, such as the one being drawn */
    excludeIds: ReadonlySet<string>;
}

/**
 * How a mode wants the positions of its input snapped, as `ModeHandler.snapPreference` declares
 * it. It is read before every input is snapped, so a mode whose preference changes
 * while it draws declares it as a getter.
 */
export interface SnapPreference {
    /**
     * The feature to prefer when snapping candidates are at the same distance, such as the
     * boundary a trace started along; none when it is left out or `null`
     */
    prefer?: {
        featureId: string;
        datasetId?: string;
    } | null;
    /**
     * The inputs whose position is not snapped, by the name of their receiver; every input is
     * snapped when it is left out. A stroke drawn by dragging leaves out `onDrag`, so that its
     * inner points follow the pointer while its ends still snap.
     */
    unsnapped?: readonly ('onClick' | 'onPointerMove' | 'onDragStart' | 'onDrag' | 'onDragEnd')[];
}

/**
 * Where the pointer snapped to. When nothing was snapped to, `lngLat` is the position of the
 * pointer and `target` is absent.
 */
export interface SnapResult {
    /** The position after snapping */
    lngLat: Position;
    /** What was snapped to */
    target?: {
        /**
         * The kind of the target; a kind of its own that a snap provider gave its candidate is
         * kept as it is
         */
        kind: 'vertex' | 'edge' | 'intersection' | 'guide' | (string & {});
        /** The ID of the feature, for a target of the document */
        featureId?: string;
        /** The ID of the dataset, for a target of a dataset */
        datasetId?: string;
        /** A description to show */
        description?: string;
        /** The vertex, for a vertex target */
        vertex?: VertexRef;
        /** The segment, for an edge or a guide */
        segment?: {
            start: Position;
            end: Position;
        };
    };
}

/** An extension that shows handles of its own on the selected features and receives their drags. */
export interface HandleProvider {
    /** The name it is registered under */
    readonly name: string;
    /**
     * The handles of a selected feature. The engine draws them with the look of the vertex
     * handles, hit tests them at the same size, and gives their drags to `onDrag`.
     */
    handles(feature: Feature, ctx: ScreenContext): Handle[];
    /**
     * The handles that belong to no feature, shown whatever is selected; they are hit and
     * dragged like the others, and their drag arrives with `feature` as `null`.
     */
    globalHandles?(ctx: ScreenContext): Handle[];
    /**
     * The change a drag of one of its handles makes. It is called for every move of the drag,
     * and the feature is drawn with its patch, which is not written, as
     * {@link FeatureTypeDefinition.onHandleDrag} says (a sketch `update`, the patch in
     * `drag.changed`); it is called once more when the drag ends, and that patch is the one
     * written.
     *
     * @param feature - The feature the handle is on; `null` for a handle of `globalHandles`
     * @returns The patch to apply to the feature, or `null` for no change
     */
    onDrag(feature: Feature | null, handle: Handle, event: DrawPointerEvent): FeaturePatch | null;
    /**
     * A drag of one of its handles is about to start, before the first `onDrag`.
     *
     * @param feature - The feature the handle is on; `null` for a handle of `globalHandles`
     * @returns False to refuse the drag: the pointer then does what it would do without the
     *   handle, and no `onDrag` nor `onDragEnd` follows
     */
    onDragStart?(feature: Feature | null, handle: Handle, event: DrawPointerEvent): boolean;
    /**
     * A drag of one of its handles ended, after the last `onDrag` and its patch. It is called
     * once for every drag that started, also when the drag is cut short.
     *
     * @param feature - The feature the handle is on as it is now; `null` for a handle of
     *   `globalHandles`, or when the feature is gone
     */
    onDragEnd?(feature: Feature | null, handle: Handle, event: DrawPointerEvent): void;
}

/**
 * An extension that draws a companion one step below a feature, such as a leader line, and
 * hit tests it at the same step.
 */
export interface CompanionProvider {
    /** The name it is registered under */
    readonly name: string;
    /**
     * Whether a feature has a companion. It is asked for every feature on every frame and
     * every hit test, so it must answer at once.
     */
    has(feature: Feature): boolean;
    /** Draws the companion of a feature, given as it is drawn (see {@link SketchesCollection}). */
    draw(feature: Feature, ctx: RenderContext): void;
    /**
     * Hit tests the companion of a feature, given as it is drawn (see {@link SketchesCollection}).
     *
     * It is asked at the step of the feature in the stacking order: when the point missed the
     * feature itself, and before the feature behind it. At one point, the handles of the
     * selection come first; then, from the front, each feature and then its companions, so a
     * feature (its marker, its line or its area, with the click tolerance) wins over its own
     * companion and a companion wins over the features behind its feature; a dataset row
     * comes only after the features and the companions in front of it.
     *
     * @returns What was hit, or `null`
     */
    hitTest(feature: Feature, ctx: HitTestContext): Hit | null;
    /**
     * A companion was clicked.
     *
     * @param hit - What `hitTest` returned
     * @returns True to consume the click, which then changes nothing else; false, or nothing,
     *   to leave it to the select mode as a click on the feature
     */
    onClick?(feature: Feature, hit: Hit, event: DrawPointerEvent): boolean;
}

/**
 * An extension that gives the contents of files the document names but does not hold, such as
 * the image of an Image feature the application keeps outside the document: the document then
 * keeps the ID of the file only. It is the one extension point of the library for such files:
 * the library itself embeds the files of the images it places (`document.load`), and keeping
 * them elsewhere (uploading them, telling of a failure, fetching those in view) is for an
 * extension to do.
 *
 * An Image whose file the document does not hold is a feature as any other: an extension makes
 * one with `features.create`, giving the ID of its file in `maplibre-gl-draw:imageFileId` and the
 * size of the image in pixels (`maplibre-gl-draw:imageWidth` and `imageHeight`), and the document
 * holds the ID only. Its size on the map is decided by `features.create` as for a load (see
 * there).
 *
 * The instance asks for a file when it is to draw a feature whose file the Store does not hold,
 * once per ID, and asks the providers in the order they were added until one gives the file.
 * Until then the image is drawn as its frame: its outline at its place, its size and its
 * rotation, with nothing inside. When a provider gives the file, the instance keeps it beside
 * the document (it is not written to the document, no `document.changed` arrives, and
 * `document.toJSON` does not write it), and draws the features of that file again. The files
 * kept so are held within limits of their number and of their bytes, 256 files and
 * 128,000,000 bytes by default (constants of the library): past them, the ones used
 * least lately are let go of, and asked for again when they are to be drawn. When none gives a
 * file, the frame stays and `image.failed` arrives with the ID of the feature; the file is asked
 * for again at the next `invalidate` of its features.
 */
export interface FileProvider {
    /** The name it is registered under */
    readonly name: string;
    /**
     * The content of a file by its ID.
     *
     * @param id - The ID of the file, as the document names it
     * @returns The file, or `undefined` when this provider does not have it
     */
    getFile(id: string): Promise<FileData | undefined>;
}

/**
 * An extension that computes the moves, rotations and scalings of features, in place of the
 * built-in computation: the same operations, computed with another precision or by other rules,
 * such as on a plane rather than on the ellipsoid, or with another geodesic formula. It is set
 * with `draw.extensions.setTransformProvider`; there is one at a time.
 *
 * The built-in computation works on the WGS 84 ellipsoid, in the east, north and up axes of the
 * point the operation names (see {@link Translation}, {@link Rotation} and {@link Scaling}).
 *
 * A provider is called only for what is written: the bulk edits `translate`, `rotate` and
 * `scale` (and `duplicate` with an offset), with the drags and keys that write with them, a part
 * of the features at a time. While a drag goes on, the features are drawn moved by the built-in
 * computation, and the provider computes the values written once the pointer is let go of. A
 * provider whose results differ visibly from the built-in computation therefore makes the
 * features move when a drag ends, from where they were drawn to where it puts them.
 *
 * It receives and returns arrays of numbers, so that an operation on 100,000 features makes no
 * object per feature. The result of a feature depends on the operation and on the values of that
 * feature alone, so the features can be given in any parts and in any order. What depends on the
 * whole edit is settled before it is called: a rotation of a single feature of a `Point`
 * geometry with a field of rotation comes with the position of that feature as its center (see
 * `features.rotate`).
 */
export interface TransformProvider {
    /** The name it is set under, for messages */
    readonly name: string;
    /**
     * Whether it computes this operation (its points, its angle, its factors). The instance does
     * not apply an operation it does not compute: the bulk edit rejects with the code
     * `invalidInput`, and a drag or a key leaves the features as they are. A computation on a
     * plane, for instance, does not compute an operation near a pole, or across the ±180
     * degree meridian.
     */
    accepts(operation: TransformOperation): boolean;
    /**
     * Computes an operation for some features: writes into `output` the values each of them has
     * after it. It is called only with an operation `accepts` took.
     *
     * @param operation - What is done, in geographic values: positions as `[longitude,
     *   latitude]` in degrees, angles in degrees
     * @param input - The features and their values now
     * @param output - Where to write their values after: arrays of the same lengths as those of
     *   `input`, every entry to be written
     */
    apply(operation: TransformOperation, input: TransformInput, output: TransformOutput): void;
}

/**
 * The features an operation is computed for, in one call, and their values now, as arrays:
 * entry `i` of each array of one value per feature is feature `i`.
 */
export interface TransformInput {
    /**
     * The number of the operation, the same in every call for it: its changes carry it
     * (`DocumentChange.operationId`), and so does the drag that writes it (`drag.started`)
     */
    readonly operationId: number;
    /** The number of features in this call */
    readonly featureCount: number;
    /**
     * The positions of every feature, one after the other, `valuesPerPosition` numbers each: the
     * longitude and the latitude in degrees, then the height in meters and the measure when the
     * features have them (copied as they are)
     */
    readonly coordinates: Float64Array;
    /** The number of values of a position: 2, 3 or 4 */
    readonly valuesPerPosition: number;
    /**
     * Where the positions of each feature start in `coordinates`, counted in positions (not in
     * numbers): those of feature `i` are positions `positionStarts[i]` to `positionStarts[i + 1]`,
     * without the last (one more entry than there are features)
     */
    readonly positionStarts: Int32Array;
    /**
     * The rotation of each feature, in degrees counterclockwise seen from above (the rotation of
     * an image, or the field a type declares, `TransformFields.rotationDegreesKey`), NaN for a
     * feature without one; `null` when none has one. A rotation adds its angle to it, within
     * [0, 360), a NaN counting as 0
     */
    readonly rotationDegrees: Float64Array | null;
    /**
     * A direction of each feature, in degrees clockwise from the north
     * (`TransformFields.bearingDegreesKey`), NaN for a feature without one; `null` when none has
     * one. A rotation takes its angle away from it, within [0, 360), and leaves a NaN as it is
     */
    readonly bearingDegrees: Float64Array | null;
    /**
     * The size of each feature: the factor of an image (1 for the size it was placed at), the
     * radius of a circle in meters, or the factor a type declares (`TransformFields.sizeKey`);
     * NaN for a feature without one, `null` when none has one. A scaling multiplies it by
     * `sizeFactor`, a NaN counting as 1
     */
    readonly size: Float64Array | null;
    /**
     * 1 for a feature that keeps its shape when it is scaled (an image, a circle, a type that
     * declares `TransformFields.isScaledUniformly`): its positions move by `sizeFactor` along both
     * the east and the north, in place of `eastFactor` and `northFactor`; 0 for the others; `null`
     * when none keeps its shape
     */
    readonly isScaledUniformly: Uint8Array | null;
}

/**
 * Where a {@link TransformProvider} writes the values of the features after an operation: arrays
 * of the same lengths as those of the {@link TransformInput}, not the same arrays.
 */
export interface TransformOutput {
    /** The positions after, as `TransformInput.coordinates` (the height and the measure copied) */
    readonly coordinates: Float64Array;
    /** The rotations after, when the input has them */
    readonly rotationDegrees: Float64Array | null;
    /** The directions after, when the input has them */
    readonly bearingDegrees: Float64Array | null;
    /** The sizes after, when the input has them */
    readonly size: Float64Array | null;
}

/** What a hit test of a custom feature type or a companion receives. */
export interface HitTestContext {
    /** The point on the screen */
    point: ScreenPoint;
    /** The position on the map */
    lngLat: Position;
    /** How far from the point a hit may be, in pixels */
    tolerancePx: number;
    /** The conversion between the map and the screen */
    screen: ScreenContext;
}

/** What a hit test found. */
export interface Hit {
    /** What was hit */
    kind: 'feature' | 'dataset' | 'companion' | 'handle';
    /** The ID of what was hit */
    id: string;
    /** The ID of the feature it belongs to */
    featureId?: string;
    /** The ID of the dataset, for a row of a dataset */
    datasetId?: string;
    /** The distance from the point, in pixels */
    distancePx: number;
}

// =============================================================================
// 領域: style
// =============================================================================

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

/** The dash pattern of a line: solid, dashed or dotted. */
export type LineStyle = 'solid' | 'dashed' | 'dotted';

/** The shape of a point marker. */
export type PointShape = 'circle' | 'square' | 'triangle' | 'star';

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
export type StyleRule = {
    kind: 'single';
    color: string;
} | {
    kind: 'categorical';
    property: string;
    map: Record<string, string>;
    other: string;
} | {
    kind: 'graduated';
    property: string;
    breaks: number[];
    colors: string[];
    other: string;
} | {
    kind: 'continuous';
    property: string;
    min: number;
    max: number;
    ramp: [string, string];
    other: string;
};

/** One entry of the legend of a style rule. */
export interface LegendEntry {
    /** The label to show */
    label: string;
    /** The color, as `#rrggbb` */
    color: string;
}

/**
 * The color a style rule gives to a feature with these properties.
 *
 * @param rule - The rule
 * @param properties - The properties of the feature
 * @returns The color, as `#rrggbb`
 */
export declare function evaluateStyleRule(rule: StyleRule, properties: Record<string, unknown> | undefined): string;

/**
 * The part of the look a style rule colors for a type: the point, the stroke or the fill.
 *
 * @param type - The type of the feature
 * @returns `point` for points, `stroke` for lines and `fill` for areas
 */
export declare function getStyleRuleChannel(type: FeatureType): 'point' | 'stroke' | 'fill';

/**
 * The legend entries of a style rule, in the order to show them.
 *
 * @param rule - The rule
 * @param messages - The words of the labels, to show them in another language
 * @returns The legend entries, their colors as `#rrggbb`
 */
export declare function deriveLegend(rule: StyleRule, messages?: Partial<Messages>): LegendEntry[];

// =============================================================================
// 領域: error
// =============================================================================

/**
 * The error a method throws when an argument is wrong, or when a read would return more than
 * it returns at once; the method has changed nothing.
 */
export declare class DrawError extends Error {
    /** Why it was thrown */
    readonly code: DrawErrorCode;
    /** More about the cause, such as the ID that was not found */
    readonly details?: unknown;
    /**
     * Creates the error
     *
     * @param code - Why it is thrown
     * @param message - A description in English, for logs
     * @param details - More about the cause
     */
    constructor(code: DrawErrorCode, message: string, details?: unknown);
}

/**
 * Why a {@link DrawError} was thrown.
 *
 * - `notFound`: an ID that does not exist
 * - `alreadyExists`: an ID that is already taken
 * - `invalidInput`: an input of the wrong shape or value
 * - `unsupportedFormat`: a source that cannot be read
 * - `invalidState`: a call that is not possible in the current situation, such as deleting
 *   a feature while it is being drawn, or any call on an instance that was destroyed
 * - `tooManyItems`: a read that would return more than 10,000 features, groups or IDs in one
 *   array; they are read with an `iterate` method, `IdSet.iterate` or a range instead
 */
export type DrawErrorCode = 'notFound' | 'alreadyExists' | 'invalidInput' | 'unsupportedFormat' | 'invalidState' | 'tooManyItems';

// =============================================================================
// 領域: export されない宣言 (export された宣言が参照する)
// =============================================================================

/**
 * A bounding box as `[minLng, minLat, maxLng, maxLat]` in degrees.
 *
 * A box never crosses the ±180 degree meridian: `minLng <= maxLng` always holds.
 */
type BBox = [number, number, number, number];

/**
 * A table of rows held as columns, the fast way to put many rows on the map.
 *
 * Build one with {@link tableFromFeatures} or {@link createTableBuilder}, or take the output of
 * a GeoArrow reader as it is: the layout is the same. Pass it as `table` to
 * {@link maplibre-gl-draw!DatasetsCollection.add | draw.datasets.add} or to
 * {@link maplibre-gl-draw!Dataset.setTable | Dataset.setTable}.
 *
 * Nothing is copied: the dataset keeps and reads the arrays, so do not change them while the
 * dataset holds them (replace the table with `setTable` instead). Every array can be transferred
 * from a Worker without a copy; {@link transferList} lists their buffers.
 *
 * Row `i` behaves as the feature `{ id, type: geometry.type, coordinates, properties }` where
 * `coordinates` are read from the geometry column, `properties` holds the value of every column at
 * row `i`, and `id` is `String(ids[i])` (or `String(i)` without `ids`). With a
 * {@link TableMixedGeometry}, `type` and `coordinates` are those of the row's child
 * column. The rows have no individual style; the style rule and the base style of the dataset
 * color them.
 *
 * @example
 * ```ts
 * const places: Table = {
 *   length: 3,
 *   geometry: {
 *     type: 'Point',
 *     coords: new Float64Array([139.70, 35.68, 139.71, 35.69, 139.72, 35.66]),
 *   },
 *   columns: {
 *     name: ['Shinjuku', 'Yoyogi', 'Shibuya'],
 *     visitors: new Float64Array([3.5, 0.7, 3.0]),
 *   },
 * };
 * draw.datasets.add({ id: 'places', table: places });
 * ```
 */
interface Table {
    /** The number of rows */
    length: number;
    /**
     * The geometry column: of one type, or {@link TableMixedGeometry} for rows of
     * different types
     */
    geometry: TableGeometry | TableMixedGeometry;
    /**
     * Which rows have a geometry, as the validity bitmap of Arrow: bit `i % 8` of byte `i >> 3` (the
     * lowest bit first) is 1 for a row with a geometry. Every row has one when omitted
     */
    validity?: Uint8Array;
    /**
     * The id of each row, turned into a string with `String()` (the row number as a string when
     * omitted). The ids must be unique within the table
     */
    ids?: Column;
    /**
     * The attribute columns by name. They become the `properties` of the rows, which the style
     * rule reads. Passing only the columns that the rule and the host read is enough
     */
    columns?: Record<string, Column>;
}

/**
 * A table together with what {@link prepareTable} computed for it, ready for the main thread.
 *
 * Besides the table it carries the bbox of each row, the spatial chunks and the spatial index
 * of the hit testing, all in typed arrays, so it can be transferred from a Worker without a copy
 * ({@link transferList}). It also tells the number of rows and the extent of the table. Treat
 * everything else as opaque: pass the whole object as `table` to {@link maplibre-gl-draw!DatasetsCollection.add | draw.datasets.add} or to
 * {@link maplibre-gl-draw!Dataset.setTable | Dataset.setTable}.
 */
interface PreparedTable {
    /** The table the rest was computed for */
    readonly table: Table;
    /** The number of rows, the `length` of the table it was computed for */
    readonly length: number;
    /**
     * The extent of the rows with a geometry, as `[west, south, east, north]` in degrees, or
     * `null` when no row has a geometry
     */
    readonly bounds: BBox | null;
}

/**
 * The geometry column of a table whose rows share one geometry type.
 *
 * It follows the layout of GeoArrow: interleaved coordinates and the offset arrays, outermost
 * first.
 *
 * Every row owns a contiguous run of the coordinates, so the offsets only say where each row,
 * part and ring starts:
 *
 * | Type | `offsets` |
 * | --- | --- |
 * | Point | none: row `i` is coordinate `i` |
 * | LineString, MultiPoint | `[row → coordinate]` |
 * | Polygon | `[row → ring, ring → coordinate]` |
 * | MultiLineString | `[row → part, part → coordinate]` |
 * | MultiPolygon | `[row → polygon, polygon → ring, ring → coordinate]` |
 *
 * An offset array has one more entry than the level it splits (the first entry is the start of
 * the first element, the last is the end of the last), and its values never decrease.
 *
 * A row without a geometry has an empty run (two equal offsets), or NaN coordinates for a Point,
 * or a 0 bit in {@link Table.validity}. It is neither drawn nor hit.
 *
 * @example A table of two lines
 * ```ts
 * const geometry: TableGeometry = {
 *   type: 'LineString',
 *   coords: new Float64Array([139.70, 35.68, 139.71, 35.69, 139.72, 35.66, 139.73, 35.67]),
 *   offsets: [new Int32Array([0, 2, 4])],
 * };
 * ```
 */
interface TableGeometry {
    /** The geometry type of every row */
    type: GeometryType;
    /**
     * The coordinates in degrees, interleaved: `[lng0, lat0, lng1, lat1, ...]`, or
     * `[lng0, lat0, z0, ...]` with `dimensions: 3`
     */
    coords: Float64Array;
    /**
     * The number of values per coordinate: 2 (`xy`, the default) or 3 (`xyz`; the third value is
     * skipped)
     */
    dimensions?: 2 | 3;
    /** The offset arrays, outermost first (see the table above). Omitted or empty for Point */
    offsets?: Int32Array[];
}

/**
 * The geometry column of a table whose rows have different geometry types.
 *
 * It follows the layout of the mixed geometry of GeoArrow (a dense union of Arrow): a geometry
 * column of a single type per child, and for every row of the table the child and the row within
 * it.
 *
 * The geometry of row `i` is row `offsets[i]` of `children[types[i]]`, and row `i` behaves exactly
 * as the feature of that child's type with those coordinates. The rows of a child can be in any
 * order; the draw order is the order of the table rows. A row with a negative `types[i]` has no
 * geometry (as a 0 bit in {@link Table.validity}, which still applies on top). The
 * number of rows of a child is read from its arrays: the coordinates for a Point column,
 * `offsets[0].length - 1` for the others.
 *
 * @example A point, a line and a polygon, the polygon first in the table
 * ```ts
 * const geometry: TableMixedGeometry = {
 *   type: 'Mixed',
 *   types: new Int8Array([2, 0, 1]),
 *   offsets: new Int32Array([0, 0, 0]),
 *   children: [
 *     { type: 'Point', coords: new Float64Array([139.70, 35.68]) },
 *     {
 *       type: 'LineString',
 *       coords: new Float64Array([139.71, 35.69, 139.72, 35.70]),
 *       offsets: [new Int32Array([0, 2])],
 *     },
 *     {
 *       type: 'Polygon',
 *       coords: new Float64Array([139.73, 35.66, 139.75, 35.66, 139.75, 35.68, 139.73, 35.66]),
 *       offsets: [new Int32Array([0, 1]), new Int32Array([0, 4])],
 *     },
 *   ],
 * };
 * ```
 */
interface TableMixedGeometry {
    /** Marks the mixed form */
    type: 'Mixed';
    /**
     * For every row, the child column that holds its geometry (an index into `children`; negative
     * for a row without a geometry)
     */
    types: Int8Array;
    /** For every row, the row within its child column */
    offsets: Int32Array;
    /** The geometry columns of a single type */
    children: TableGeometry[];
}

/**
 * An attribute column of a table: a typed array of numbers, a dictionary, or a plain array.
 *
 * Row `i` of the table is element `i` of the column. In a `Float64Array` or a `Float32Array`,
 * NaN means no value (`null`).
 */
type Column = Float64Array | Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array | DictionaryColumn | readonly unknown[];

/**
 * The geometry type of a geometry column of a single type.
 *
 * A table whose rows have different types gives a {@link TableMixedGeometry}, made of columns of
 * these types.
 */
type GeometryType = 'Point' | 'LineString' | 'Polygon' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon';

/**
 * An attribute column encoded as a dictionary (the dictionary type of Arrow).
 *
 * The value of row `i` is `dictionary[codes[i]]`. A negative code, or one past the end of the
 * dictionary, means no value (`null`).
 *
 * @example
 * ```ts
 * const category: DictionaryColumn = {
 *   codes: new Int32Array([0, 1, 0, -1]),
 *   dictionary: ['cafe', 'school'],
 * }; // 'cafe', 'school', 'cafe', null
 * ```
 */
interface DictionaryColumn {
    /** The code of each row */
    codes: Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array;
    /** The distinct values */
    dictionary: readonly (string | number | boolean | null)[];
}
