// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Type definitions of the datasets
 *
 * It defines the types for showing large numbers of features that are not being edited, quickly
 * and with attribute-driven styles. It is a path independent of the Store (editing, undo,
 * events), and there is no editing API here.
 */

import type { ProjectionData } from 'maplibre-gl';
import type {
  BoundingBox,
  Coordinate,
  Feature,
  FeatureCoordinates,
  Layer,
  StyleRule,
} from '../shared/types/model.js';
import { geometryFromCoordinates } from '../shared/utils/coordinates.js';
import type { PixelRatioInput } from '../shared/utils/pixel-ratio.js';
import type { PointStyle } from '../view/renderers/point/point-shape.js';
import type { RetainedRendererSet } from '../view/renderers/retained.js';
import type { StyleRuleChannel } from '../view/style-rule.js';
import type { TerrainContext } from '../view/terrain/context.js';
import type { DatasetColumnarInput, DatasetColumnarPrepared } from './columnar/types.js';
import type {
  DatasetCollisionThinning,
  DatasetThinningStats,
  ResolvedCollisionThinning,
} from './thinning.js';
import type { TriangulationScheduler } from './triangulation.js';

/**
 * The default style of a dataset, per geometry channel.
 *
 * It holds a subset of FeatureStyle per channel (the same vocabulary as the rule colors). The
 * features of a dataset often have no individual style, so this is the mechanism
 * for giving a default such as "the lines of this dataset are 1px light blue" per dataset.
 *
 * The precedence is "the individual style of a feature > the rule color (color only) >
 * baseStyle > the core default".
 */
export type DatasetBaseStyle = Partial<Record<StyleRuleChannel, Feature['style']>>;

/**
 * A feature passed to a dataset.
 *
 * Its coordinates have the shapes of the coordinates of the geometry of a feature of the Store
 * (including Multi and holes). It is not put into the Store, so the layer it belongs to, the
 * lock and the visibility can be omitted (when omitted they are treated as an empty string,
 * false and true respectively). Positions with a third element (an elevation from GeoJSON) are truncated to `[lng, lat]`.
 */
export interface DatasetFeatureInput {
  /** The feature id, unique within the dataset */
  id: string;
  /** The geometry type, the same values as a feature of the Store */
  type: Feature['type'];
  /** The coordinates in `[lng, lat]` degrees, shaped as for `type` (holes and Multi included) */
  coordinates: FeatureCoordinates;
  /** The attributes the style rule reads (`{}` when omitted) */
  properties?: Record<string, unknown>;
  /** The individual style; it wins over the rule color and the base style */
  style?: Feature['style'];
  /** The layer id (`''` when omitted). Kept on the feature; the dataset does not use it */
  layerId?: string;
  /** The group id. Kept on the feature; the dataset does not use it */
  groupId?: string;
  /** The lock flag (`false` when omitted). Kept on the feature; nothing is edited here */
  locked?: boolean;
  /** `false` hides this feature (`true` when omitted) */
  visible?: boolean;
}

/**
 * Where a dataset is drawn relative to the layers of the Store.
 *
 * below-store / above-store refer to the position relative to all of the layers of the Store.
 * layer-order means "taking part in the same stacking order as the layers of the Store".
 *
 * - below-store: behind all of the layers of the Store (the default)
 * - above-store: in front of all of the layers of the Store (behind the selection UI)
 * - layer-order: drawn at the position where its own dataset id is placed within the
 *   stacking order of the Store (`store.getLayerOrder()`). While it is not on the order it is
 *   not drawn
 */
export type DatasetOrder = 'below-store' | 'above-store' | 'layer-order';

/**
 * The destination of {@link MapLibreGLDraw.moveDataset}: a side and a position
 * within it.
 *
 * order is the side (in front of or behind the Store) and index is the position within that
 * side. index 0 is the backmost and out-of-range values are clamped. Both can be omitted.
 *
 * When it is moved to order: 'layer-order', the stacking order is decided by the layer order of
 * the Store alone and index takes no part in it.
 */
export interface DatasetPlacement {
  /** The side to move to. When omitted, the current side is kept */
  order?: DatasetOrder;
  /**
   * The position within the side (0 = the backmost)
   *
   * When omitted, it goes to the front of the destination if the side changes, and keeps its
   * position if it does not.
   */
  index?: number;
}

/**
 * Fetches the features of a dataset for the displayed range.
 *
 * It is called, debounced by 200 ms, when the displayed range changes. `bbox` is the range in
 * degrees rounded out to the boundaries of the tiles at the integer zoom, and `zoom` is the
 * zoom at the time of the call. A result is cached per rounded range, so a small pan or zoom
 * causes no call; {@link Dataset.invalidateProviderCache} discards the cache. Only
 * the result of the last request is applied, and a rejected promise is logged with
 * `console.error` and leaves the features shown as they are.
 *
 * @example
 * ```ts
 * const provider: DatasetFeatureProvider = async (bbox, zoom) => {
 *   const url = `/api/parcels?bbox=${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}&z=${zoom}`;
 *   const response = await fetch(url);
 *   return response.json(); // DatasetFeatureInput[]
 * };
 * draw.addDataset({ id: 'parcels', provider });
 * ```
 */
export type DatasetFeatureProvider = (
  bbox: BoundingBox,
  zoom: number,
) => Promise<DatasetFeatureInput[]>;

/**
 * Returns the size and opacity factors of a dataset for a zoom.
 *
 * They are evaluated exactly once per frame, right before drawing. scale is the size factor (it
 * applies to the diameter of a point, the line width and the outline width of a polygon) and
 * opacity is the opacity factor (0..1).
 *
 * They are uniforms multiplied into the baked sizes at draw time, so changing a value never
 * rebuilds a retained batch. They are factors per dataset and do not affect the rendering of
 * the Store (the drawn features). A return value of NaN or a negative number does not break the
 * rendering (it is clamped into a safe range).
 *
 * @example
 * ```ts
 * // Shrink and fade the markers below zoom 12
 * const zoomScale: DatasetZoomScale = (zoom) =>
 *   zoom >= 12 ? { scale: 1, opacity: 1 } : { scale: 0.5, opacity: 0.6 };
 * ```
 */
export type DatasetZoomScale = (zoom: number) => { scale: number; opacity: number };

/**
 * The options of {@link MapLibreGLDraw.addDataset}.
 *
 * Only `id` is required. Give at most one of `features` (static), `columnar` (static, as
 * columns of typed arrays) and `provider` (fetched for the displayed range).
 */
export interface DatasetOptions {
  /**
   * The dataset id. It must be unique among the datasets of the draw
   * instance; a duplicate makes `addDataset` throw. With `order: 'layer-order'` it is
   * also the id placed in the layer order of the Store
   */
  id: string;
  /**
   * The static features, drawn in array order (the last in front). Cannot be given together
   * with `columnar` or `provider` (it throws). Replace them later with
   * {@link Dataset.setFeatures}
   */
  features?: DatasetFeatureInput[];
  /**
   * The static rows as columns of typed arrays, drawn in row order (the last in front); the
   * fast way in for a large table, read in a Worker if need be. Cannot be given together with
   * `features` or `provider` (it throws). Replace them later with
   * {@link Dataset.setColumnar}
   */
  columnar?: DatasetColumnarInput;
  /**
   * What `prepareDatasetColumnar` computed for `columnar` (in a Worker, say). The dataset then
   * computes none of it on the main thread. Only with `columnar` (it throws otherwise)
   */
  prepared?: DatasetColumnarPrepared;
  /**
   * Fetches the features for the displayed range. Cannot be given together with `features` or
   * `columnar` (it throws)
   */
  provider?: DatasetFeatureProvider;
  /**
   * The attribute-driven color, the same type as the `styleRule` of a layer. None when omitted
   */
  styleRule?: StyleRule;
  /** The default style per geometry channel. None when omitted */
  baseStyle?: DatasetBaseStyle;
  /**
   * Whether the hit test events are fired (false by default)
   *
   * Even with false it blocks hits while it is visible (the features below cannot be grabbed).
   * The only difference is whether click / hover are fired.
   */
  interactive?: boolean;
  /** Where it is drawn relative to the Store (`'below-store'` by default) */
  order?: DatasetOrder;
  /** The size and opacity factors per zoom (no factors when omitted) */
  zoomScale?: DatasetZoomScale;
  /**
   * Collision thinning of the point markers (disabled when omitted = everything drawn as before)
   *
   * When it is enabled, point markers that overlap on screen are not drawn (they are removed
   * from both the rendering and the hit testing). The test uses the size actually drawn, so
   * making the markers bigger makes the thinning coarser as well.
   */
  collisionThinning?: DatasetCollisionThinning;
  /**
   * Predicate that picks out the points drawn by an external renderer (core draws every point
   * when omitted)
   *
   * core does not draw a `Point` feature for which it returns true (the contract is that an
   * external renderer draws it). It is only not drawn; it stays a target of the collision
   * thinning, the hit testing and the selection. The test applies only to the Point channel;
   * `MultiPoint` is out of scope.
   *
   * What the predicate does inside (what it looks at to return true) is none of core's business;
   * core only reads whether the result is true.
   */
  externalPointRender?: (feature: Feature) => boolean;
}

// The payload of draw.dataset.click is defined in shared/ with the other event payloads
export type { DatasetClickEventPayload } from '../shared/types/events.js';

/**
 * The payload of the `click` event of a {@link Dataset}.
 */
export interface DatasetClickPayload {
  /** Dataset id */
  datasetId: string;
  /** The feature that was hit, as normalized by the dataset */
  feature: Feature;
  /**
   * The row of the feature: its index in the features given to the dataset (or in the result
   * of the provider), or its row in the columnar table. A host that keeps its own columns reads
   * the values of the row from them
   */
  row: number;
  /** The clicked position `[lng, lat]` in degrees */
  lngLat: Coordinate;
}

/**
 * The payload of the `hover` event of a {@link Dataset}.
 *
 * It fires only when the hovered target changes. When the pointer leaves the target, feature
 * becomes null (so that the host can detect that it left the dataset).
 */
export interface DatasetHoverPayload {
  /** Dataset id */
  datasetId: string;
  /** The feature being hovered. null when the pointer left the target */
  feature: Feature | null;
  /** The row of the feature (see {@link DatasetClickPayload.row}). null when it left the target */
  row: number | null;
  /** The pointer position `[lng, lat]` in degrees */
  lngLat: Coordinate;
}

/**
 * The payload of the `change` event of a {@link Dataset}.
 *
 * It reports to the outside that the contents, the style or the visibility of a dataset
 * changed. It exists so that a host that builds another representation from the contents of a
 * dataset, such as label rendering, gets a trigger to rebuild it.
 *
 * - features: the features were replaced (setFeatures, setColumnar, or a provider result
 *   applied). The rows are new, and so are the drawn rows
 * - style: the style rule or the base style changed (the drawn rows may have changed with it)
 * - visibility: it was actually switched between shown and hidden
 * - selection: the selected features actually changed
 * - thinning: the rows the collision thinning draws changed, and nothing else did. When a
 *   frame changed them (the zoom entered another band), it is sent right after that frame,
 *   which drew them; when the host did (`setCollisionThinning`, `setZoomScale`), it is sent at
 *   once and the next frame draws them
 *
 * Every change of the drawn rows also advances {@link Dataset.getDrawnRowsRevision}.
 */
export interface DatasetChangePayload {
  /** What changed (see the list above) */
  reason: 'features' | 'style' | 'visibility' | 'selection' | 'thinning';
}

/**
 * The events of a {@link Dataset} and their payloads.
 */
export interface DatasetEventMap {
  /** A feature was clicked. Fires only with `interactive: true` */
  click: DatasetClickPayload;
  /** The hovered feature changed. Fires only with `interactive: true` */
  hover: DatasetHoverPayload;
  /** The features, the style, the visibility, the selection or the thinning changed */
  change: DatasetChangePayload;
}

/**
 * A set of features drawn fast with attribute-driven styles, outside the Store.
 *
 * It is meant for overlaying tens of thousands of read-only records, such as parcels or a
 * table of places. The features never enter the Store, so none of the following applies to
 * them: editing, undo / redo, the `draw.feature.*` events, the selection UI, and
 * `getAllFeatures()` / `export()`. A caller who wants to edit one copies it into the Store with
 * `addFeature`; the library does not relate the two. Create one with
 * {@link MapLibreGLDraw.addDataset}.
 *
 * @example
 * ```ts
 * const parcels = draw.addDataset({
 *   id: 'parcels',
 *   features: [
 *     {
 *       id: 'p1',
 *       type: 'Polygon',
 *       coordinates: [[[139.76, 35.68], [139.77, 35.68], [139.77, 35.69], [139.76, 35.68]]],
 *       properties: { population: 4200 },
 *     },
 *   ],
 *   styleRule: {
 *     kind: 'graduated',
 *     property: 'population',
 *     breaks: [1000, 5000],
 *     colors: ['#eff3ff', '#6baed6', '#2171b5'],
 *     other: '#cccccc',
 *   },
 *   interactive: true,
 * });
 *
 * const unsubscribe = parcels.on('click', ({ feature }) => {
 *   console.log(feature.id, feature.properties);
 * });
 *
 * parcels.setVisible(false); // hide without discarding the features
 * parcels.remove(); // the same as draw.removeDataset('parcels')
 * ```
 */
export interface Dataset {
  /** The dataset id given at creation */
  readonly id: string;
  /**
   * Where it is drawn relative to the Store (the current side)
   *
   * When the side is changed with `moveDataset`, this value becomes the new side.
   */
  readonly order: DatasetOrder;
  /** Whether click / hover are fired (hits are blocked even with false) */
  readonly interactive: boolean;
  /** Whether it is shown (true by default) */
  readonly visible: boolean;

  /**
   * Switches between shown and hidden
   *
   * While it is hidden, neither the rendering nor the hit testing happens, but the features held
   * and the GPU resources stay as they are (showing it again takes effect immediately).
   */
  setVisible(visible: boolean): void;
  /**
   * Replaces all the features that are shown (there is no partial update). The selection
   * drops the ids that disappear
   */
  setFeatures(features: DatasetFeatureInput[]): void;
  /**
   * Replaces all the rows that are shown with a columnar table (there is no partial update).
   * The selection drops the ids that disappear
   *
   * The arrays are kept and read as they are, not copied. The rows are packed straight into the
   * GPU arrays, and a row becomes a feature only when it is asked for (a hit, the selection,
   * `getFeatures`, `collectVisible`). The bboxes, the spatial chunks and the spatial index of the
   * hit testing are computed here unless `prepared` brings them.
   *
   * @param input The table
   * @param prepared What `prepareDatasetColumnar` (from `@sakuzu/maplibre-gl-draw/columnar`)
   *   computed for this table, typically in the Worker that read it
   * @throws when the shape of the table does not add up, or when `prepared` was made for a table
   *   of another length
   */
  setColumnar(input: DatasetColumnarInput, prepared?: DatasetColumnarPrepared): void;
  /** Replaces the style rule (undefined clears it) */
  setStyleRule(rule: StyleRule | undefined): void;
  /**
   * Replaces the zoom-dependent drawing factors (null clears them)
   *
   * The factors are only multiplied in at draw time, so the retained batches are not rebuilt
   * (they take effect from the next frame). With the collision thinning on, the footprints of
   * the points change with the scale: the winners are picked again at once and, when they
   * changed, the next frame rebuilds the points alone.
   */
  setZoomScale(zoomScale: DatasetZoomScale | null): void;
  /** The zoom-dependent drawing factors in effect (null when not set) */
  getZoomScale(): DatasetZoomScale | null;
  /** Replaces the base style (undefined clears it) */
  setBaseStyle(style: DatasetBaseStyle | undefined): void;
  /**
   * Replaces the predicate that picks out the points drawn by an external renderer (undefined
   * clears it)
   *
   * It has the same meaning as the `externalPointRender` option at creation. The test is baked
   * into the retained batches, so replacing it rebuilds them (without a rebuild, a circle that
   * should have stopped being drawn would remain, and one that should be drawn again would not
   * appear).
   */
  setExternalPointRender(predicate: ((feature: Feature) => boolean) | undefined): void;
  /**
   * The base style in effect (undefined when not set)
   *
   * `getFeatures` returns the features before the base style is merged in, so a caller who needs
   * the effective appearance (the radius of a point, for example) reads this as well.
   */
  getBaseStyle(): DatasetBaseStyle | undefined;
  /**
   * The features currently held, in draw order, as normalized by the dataset. The rule
   * colors and the base style are not merged in (use `collectVisible` for that)
   *
   * For a columnar table every row with a geometry is built into a feature on the first call
   * (and kept), which costs as much as giving the rows as features in the first place.
   */
  getFeatures(): Feature[];

  /**
   * Returns the features that intersect the displayed range, in draw order (with the rule colors
   * and the base style applied)
   *
   * The narrowing uses the spatial index (rbush), so however many tens of thousands are held,
   * the cost is proportional to the number that intersect. It is the entry point for a caller
   * who wants to "walk only what is visible" (collecting label candidates, for example).
   *
   * @param bounds The range in degrees (`minX` / `maxX` are longitudes, `minY` / `maxY`
   *   latitudes)
   * @returns New array of features. Empty when nothing intersects
   */
  collectVisible(bounds: BoundingBox): Feature[];

  /**
   * Returns the rows that intersect the range and are drawn now, in draw order
   *
   * It is the counterpart of `collectVisible` narrowed to the drawn rows, by row number: a row
   * is kept when its bbox intersects the range, it has a geometry, it is not hidden
   * (`visible: false`) and it survived the collision thinning (every row survives while the
   * thinning is off). A point handed to `externalPointRender` counts as drawn. The visibility
   * of the dataset itself is not looked at (as in `collectVisible`).
   *
   * "Drawn now" means the rows of the zoom band of the most recent frame: a frame decides the
   * band before anything of it is drawn, and draws exactly these rows (see
   * {@link Dataset.getDrawnRowsRevision} for when they change). A layer that draws in the same
   * frame reads the rows of that frame.
   *
   * The narrowing uses the spatial index and builds no feature, so the cost is proportional to
   * the number of rows in the range. It is the entry point for code that walks only what is
   * drawn, such as placing text next to points: choose rows with the `getRow*` reads and build
   * the features of the chosen ones alone with `getRowFeature`.
   *
   * A row is the one reported as `row` by `click` and `hover`: the index in the features given
   * (or in the result of the provider), or the row of the columnar table. The numbers hold until
   * the contents are replaced (a `change` with the reason `features`).
   *
   * @param bounds The range in degrees (`minX` / `maxX` are longitudes, `minY` / `maxY`
   *   latitudes)
   * @returns New array of rows, in ascending order. Empty when nothing is drawn in the range
   */
  collectDrawnRows(bounds: BoundingBox): Int32Array;
  /**
   * The feature of a row, with the rule colors and the base style applied (the same feature
   * `collectVisible` returns for that row)
   *
   * A row of a columnar table is built into a feature on each call.
   *
   * @returns null when the row is out of range
   */
  getRowFeature(row: number): Feature | null;
  /**
   * The id of a row, without building its feature
   *
   * @returns null when the row is out of range
   */
  getRowId(row: number): string | null;
  /**
   * The geometry type of a row, without building its feature
   *
   * @returns null for a row without a geometry, or out of range
   */
  getRowType(row: number): Feature['type'] | null;
  /**
   * The bounding box of a row in degrees, without building its feature (the box the spatial
   * index holds for it)
   *
   * @returns null for a row without a geometry, or out of range
   */
  getRowBounds(row: number): BoundingBox | null;
  /**
   * The `[lng, lat]` of a row whose geometry is a `Point`, without building its feature
   *
   * @returns null for any other row (another type, no geometry, out of range)
   */
  getRowPoint(row: number): Coordinate | null;
  /**
   * The row of a feature id: the reverse of `getRowId`
   *
   * The first call builds an index of the ids (one pass over the rows), and the calls after it
   * are a lookup, until the contents are replaced. The ids of a dataset are expected to be
   * unique; when several rows share one, the last (frontmost) row is returned. A row without a
   * geometry is found too (it is never drawn).
   *
   * @returns null when no row has the id
   */
  findRow(id: string): number | null;

  /**
   * Replaces the selected features
   *
   * The selection is a state of the dataset and is independent of the selection of the Store. A
   * selected feature is drawn with a highlight (the same key color as the selection UI) on top
   * of the retained rendering. The retained batches are not touched, so switching the selection
   * never rebuilds a GPU resource.
   *
   * An id that is not held is ignored. An id that disappears through setFeatures or through a
   * provider result is dropped from the selection automatically.
   */
  setSelectedIds(ids: string[]): void;
  /** The ids of the selected features (in draw order) */
  getSelectedIds(): string[];

  /**
   * Sets the collision thinning of the point markers (null disables it)
   *
   * While it is enabled, point markers that overlap on screen are not drawn. The test uses the
   * size actually drawn (the radius + the outline + the margin) and the winners are decided from
   * all of the features of the dataset for each integer zoom band (this does not depend on
   * the view, so panning does not swap them). At zooms at or above `fullDisplayZoom` the thinning
   * stops and every feature is drawn. When there is a pitch, the band and `fullDisplayZoom` are
   * decided with "the shallowest effective zoom on screen" (so that only the distance does not
   * get squashed).
   *
   * The band follows the zoom being drawn by itself: every frame decides it from the zoom it
   * draws with, during a zoom or pitch gesture as well, so there is nothing to call when the
   * camera moves or before drawing once at a given camera (a snapshot, a print). Changing the
   * settings picks the winners at once, for the band of the most recent frame, and the next
   * frame draws them (only the points are rebuilt).
   */
  setCollisionThinning(options: DatasetCollisionThinning | null): void;
  /** The collision thinning in effect (null when not set) */
  getCollisionThinning(): ResolvedCollisionThinning | null;

  /**
   * The set of feature ids that are drawn (null when no thinning is in effect)
   *
   * null means "every feature is drawn" (the set of all of them is not built). The rows are
   * those of {@link Dataset.collectDrawnRows}. The set is built on the first request after each
   * change of the drawn rows, one pass over every row, so code that walks the drawn points of
   * a range reads `collectDrawnRows` instead, and code that caches something per set of drawn
   * rows keys it on {@link Dataset.getDrawnRowsRevision}.
   */
  getVisibleFeatureIds(): ReadonlySet<string> | null;
  /**
   * The state of the thinning: how many of the features are drawn, in which band (the rows of
   * {@link Dataset.collectDrawnRows})
   */
  getThinningStats(): DatasetThinningStats;
  /**
   * A number that advances whenever the drawn rows change: the contents replaced, or the rows
   * the collision thinning draws (a band entered by a frame, the settings, the style, the zoom
   * factors)
   *
   * Reading it costs nothing, so it is the key for a cache of what is derived from the drawn
   * rows (the text placed next to the drawn points, say): the same number means the same rows
   * for `collectDrawnRows`, `getVisibleFeatureIds`, `getThinningStats` and the hit testing. A
   * layer that draws in the same frame as the dataset can compare it when it draws, and see a
   * new band in the very frame that draws it, before the `change` event of that frame arrives.
   */
  getDrawnRowsRevision(): number;

  /**
   * Discards the cache of the fetch results of the provider
   *
   * It is called when what the provider returns has itself changed (a filter being applied
   * again, for example). It empties the cache, fetches again even for the same displayed range,
   * and throws away any response in flight together with its result. After discarding it, it
   * fetches again for the current displayed range.
   *
   * It does nothing for a dataset without a provider.
   */
  invalidateProviderCache(): void;

  /**
   * Subscribes to an event
   *
   * click / hover fire only with interactive: true. change fires regardless of interactive.
   *
   * @returns A function that cancels the subscription
   */
  on<K extends keyof DatasetEventMap>(
    event: K,
    handler: (payload: DatasetEventMap[K]) => void,
  ): () => void;
  /** Cancels a subscription made with `on`. A handler that is not subscribed is ignored */
  off<K extends keyof DatasetEventMap>(
    event: K,
    handler: (payload: DatasetEventMap[K]) => void,
  ): void;

  /**
   * Removes the dataset and releases its GPU resources; the same as
   * {@link MapLibreGLDraw.removeDataset}, including the `draw.dataset.remove` event.
   * Calling it again does nothing
   */
  remove(): void;
}

/** Recursively checks whether it contains a position with 3 or more elements */
function hasExtraPositionElements(value: readonly unknown[]): boolean {
  if (typeof value[0] === 'number') {
    return value.length !== 2;
  }
  return (value as readonly (readonly unknown[])[]).some(hasExtraPositionElements);
}

/** Returns a copy with every position truncated to the 2 elements [longitude, latitude] */
function truncatePositions(value: readonly unknown[]): unknown[] {
  if (typeof value[0] === 'number') {
    return [value[0], value[1]];
  }
  return (value as readonly (readonly unknown[])[]).map(truncatePositions);
}

/**
 * Normalizes the input into a feature of the same shape as in the Store
 *
 * It fills in the optional fields and, since it is not put into the Store, layerId defaults to an
 * empty string. The coordinates may contain 3-element positions coming from GeoJSON (with an
 * elevation), so a copy truncated to 2 elements is made only when they do (ordinary input with
 * only 2 elements is not copied).
 *
 * @internal
 */
export function normalizeDisplayFeature(input: DatasetFeatureInput): Feature {
  const coords = input.coordinates as readonly unknown[];
  const coordinates = hasExtraPositionElements(coords)
    ? (truncatePositions(coords) as FeatureCoordinates)
    : input.coordinates;
  return {
    id: input.id,
    type: input.type,
    geometry: geometryFromCoordinates(input.type, coordinates),
    layerId: input.layerId ?? '',
    groupId: input.groupId,
    properties: input.properties ?? {},
    style: input.style ?? {},
    locked: input.locked ?? false,
    visible: input.visible !== false,
  };
}

/**
 * The receiver of the batched rendering
 *
 * It is the minimal shape that BatchManager satisfies structurally. A dataset
 * does not depend on the implementation of the batches.
 *
 * @internal
 */
export interface DisplayBatchTarget {
  beginFrame(projectionData: ProjectionData, zoom: number, layer?: Layer): void;
  processFeature(feature: Feature, isSelected: boolean): boolean;
  endFrame(): void;
  /**
   * Returns the full set of retained-mode renderers (optional)
   *
   * For an implementation that does not provide it or returns undefined, immediate mode is used.
   */
  getRetainedRenderers?(): RetainedRendererSet | undefined;
  /**
   * The terrain state of the draw instance being drawn into (optional)
   *
   * An implementation that does not provide it draws without terrain.
   */
  getTerrain?(): TerrainContext;
}

/**
 * The function of the precise hit test (the same shape as HitTestService.hitTestFeature)
 *
 * @internal
 */
export type DisplayHitTestFn = (
  feature: Feature,
  coordinate: Coordinate,
  toleranceLngLat: number,
) => boolean;

/**
 * Internal dependencies of a dataset
 *
 * @internal
 */
export interface DatasetDeps {
  /** Requests a repaint */
  requestRepaint(): void;
  /** Debounce time of the provider (ms) */
  providerDebounceMs: number;
  /** Callback used by remove() to take it off the manager */
  onRemove(id: string): void;
  /**
   * Returns the current displayed range and zoom
   *
   * It is used to fetch the same range again after the provider cache has been discarded. Only
   * the manager knows the displayed range.
   */
  getViewportState(): { bounds: BoundingBox; zoom: number };
  /**
   * How far "the shallowest effective zoom on screen" lies below the zoom of the camera (the
   * pitch correction; 0 at pitch 0)
   *
   * Only the band of the collision thinning reads it: the band is decided from the zoom of the
   * frame lowered by this drop.
   */
  getPitchZoomDrop(): number;
  /**
   * A light entry point that returns only the current zoom
   *
   * The hit testing looks at the zoom to compute the hit radius of a point (the size that is
   * drawn), and that runs for every dataset on every hover. So that it does not drag in the
   * computation of the displayed range or the effective zoom (a query to the map), the zoom alone
   * is looked up.
   */
  getZoom(): number;
  /**
   * Rendering pixel ratio (read from window every time when not injected)
   *
   * When a number is injected the value never changes, so no retained batch is rebuilt. When a
   * function (`pixelRatioSource.resolve`) is passed, a change of the rendering pixel ratio at
   * runtime becomes the signal to rebuild.
   */
  pixelRatio?: PixelRatioInput;
  /**
   * The scheduler of the triangulation of huge polygons (the global one when omitted)
   *
   * It can be injected so that a test can replace the clock and the launching of the slices.
   */
  triangulationScheduler?: TriangulationScheduler;
  /**
   * Default style of a point (the default of core when omitted)
   *
   * It is used to compute the footprint of the collision thinning (the radius + the outline) from
   * the same defaults as the rendering side. It follows the host when it has replaced
   * featureStyle.
   */
  pointStyle?: PointStyle;
  /**
   * Whether the work that does not fit in a frame is spread over later frames (true when
   * omitted; the `timeSlicing` of the rendering settings). With false every chunk in view is
   * built in the frame that needs it
   */
  timeSlicing?: boolean;
}
