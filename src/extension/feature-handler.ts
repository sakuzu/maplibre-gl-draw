// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The feature handler contract of an extension
 *
 * The shape an extension implements to add a custom feature type: its renderer, its hit
 * testing, its box selection, its bounding boxes, its resize and its snapping candidates, all
 * registered at once with `registerFeatureHandler`. It is types only and sits low in the layer
 * order, so the view, snapping and operations layers read it without reaching up into api.
 */

import type { BoxSelectionStrategy } from '../dispatcher/hit-test/box-strategy.js';
import type { HitTestStrategy } from '../dispatcher/hit-test/strategies/index.js';
import type { ResizeState } from '../operations/resize.js';
import type { HandleType } from '../shared/config/constants.js';
import type { BoundingBox, Coordinate, Feature } from '../shared/types/model.js';
import type { BoundingBoxCoords } from '../shared/types/selection-box.js';
import type { SnapCandidate, SnapProviderContext } from '../snapping/types.js';
import type { HandleInfo } from '../view/ui/handles.js';
import type { PointFrameExtent } from '../view/ui/selection-ui/index.js';
import type { CustomFeatureRenderer } from './renderers.js';

/**
 * Custom resize result
 *
 * The result of the resize computation for a custom feature.
 * Used when processing different from the standard resize (changing scale) is needed.
 */
export interface CustomResizeResult {
  /** The new coordinates */
  coordinates: Coordinate;
  /** The new width (in pixels, optional) */
  width?: number;
  /** The new height (in pixels, optional) */
  height?: number;
}

/**
 * The type of a custom resize computation function
 */
export type CustomResizeCalculator = (
  handle: HandleType,
  state: ResizeState,
  currentLngLat: { lng: number; lat: number },
  feature: Feature,
) => CustomResizeResult | null;

/**
 * A custom feature type: how its features are drawn, hit, selected, resized and snapped to
 *
 * Register it with `draw.registerFeatureHandler(handler)`, usually from `onInstall` of a
 * {@link Plugin}. The registration belongs to that draw instance, and the returned function
 * removes it. Features of the type are ordinary features in the Store (`type` is the name of
 * the handler), so they are saved, exported, grouped and stacked like the built-in types;
 * GeoJSON export writes the type in `maplibre-gl-draw:featureType` so that it comes back.
 *
 * `type`, `renderer` and `hitTest` are required. The rest have fallbacks: box selection and
 * the bounding box use the coordinates, and without `getSelectionBoundingBox` no selection UI
 * is drawn.
 *
 * @example
 * ```ts
 * import type { CustomFeatureHandler, Feature } from '@sakuzu/maplibre-gl-draw';
 *
 * // A "marker" type: one coordinate, drawn as a square, hit within the tolerance
 * const distanceTo = (feature: Feature, [lng, lat]: [number, number]) => {
 *   const [x, y] = feature.coordinates as [number, number];
 *   return Math.hypot(x - lng, y - lat);
 * };
 *
 * const markerHandler: CustomFeatureHandler = {
 *   type: 'marker',
 *   renderer: markerRenderer, // see CustomFeatureRenderer
 *   hitTest: {
 *     geometryType: 'marker',
 *     test: (feature, coordinate, tolerance) => distanceTo(feature, coordinate) <= tolerance,
 *     distance: (feature, coordinate) => distanceTo(feature, coordinate),
 *   },
 * };
 *
 * const unregister = draw.registerFeatureHandler(markerHandler);
 * draw.addFeature({ type: 'marker', coordinates: [139.767, 35.681] });
 * ```
 */
export interface CustomFeatureHandler {
  /** The feature type name */
  readonly type: string;

  /** The custom renderer */
  readonly renderer: CustomFeatureRenderer;

  /** The custom hit testing strategy */
  readonly hitTest: HitTestStrategy;

  /** The custom box selection strategy (when omitted, a coordinate-based fallback is used) */
  readonly boxSelection?: BoxSelectionStrategy;

  /**
   * The resize strategy (applied when computeCustomResize returns null)
   * - 'scale': changes the scale property (as an Image does)
   * - 'coordinates': changes the coordinates directly (the same as Polygon and LineString)
   * - when omitted: a generic check (decided by the presence of the scale property)
   */
  readonly resizeStrategy?: 'scale' | 'coordinates';

  /**
   * Bounding box computation
   *
   * Used for viewport filtering in SpatialIndex.
   * When omitted, a simple bounding box is computed from the coordinates.
   *
   * @param feature The target feature
   * @param tileSize The tile size (512 by default)
   */
  getBoundingBox?(feature: Feature, tileSize: number): BoundingBox;

  /**
   * The additional reach for narrowing down candidates (in CSS pixels)
   *
   * The first stage of hit testing narrows down candidates with a radius equivalent to
   * clickTolerance, so when the hitTest strategy of this type treats a wider area as a hit
   * (icons and the like), the candidate is dropped before the precise test is reached.
   * Registering "how far from the center a hit can occur" here widens the candidate search
   * radius by that much.
   *
   * The test itself is still decided by the hitTest strategy as before (only the number of
   * candidates increases slightly). A value that changes with zoom or with settings is
   * registered as a function (it is evaluated on every query).
   */
  readonly candidateReachPx?: number | (() => number);

  /**
   * The half width and half height of the selection box of a zero-area point (in CSS pixels)
   *
   * A point keeps its zero area and is treated with the "point appearance" (box only, no resize
   * or rotation handles, move inside the box). This function only decides the dimensions of that
   * box (the special treatment of zero area itself does not change).
   *
   * When it is omitted, or returns null, the default 12px square is used.
   *
   * @param feature The target feature
   */
  getPointFrameExtent?(feature: Feature): PointFrameExtent | null;

  /**
   * Bounding box computation for the selection UI
   *
   * Used for the visual feedback of the selected state (bounding box, handles).
   * Returns an OBB (Oriented Bounding Box) that takes rotation into account.
   * When omitted, no selection UI is drawn.
   *
   * @param feature The target feature
   * @param tileSize The tile size (512 by default)
   */
  getSelectionBoundingBox?(feature: Feature, tileSize: number): BoundingBoxCoords;

  /**
   * Returns additional resize handles
   *
   * Returns the handles to display in addition to the standard four corner handles.
   * When omitted, only the four corner handles are shown.
   * Called only for a single selection.
   *
   * @param feature The target feature
   * @param bbox The bounding box for the selection UI
   */
  getAdditionalResizeHandles?(feature: Feature, bbox: BoundingBoxCoords): HandleInfo[];

  /**
   * Custom resize computation
   *
   * Provides custom resize logic such as edge-midpoint handles.
   * Returning null applies the standard resize (changing scale).
   *
   * @param handle The type of the handle being operated
   * @param state The state of the resize operation
   * @param currentLngLat The current mouse coordinate
   * @param feature The target feature
   */
  computeCustomResize?(
    handle: HandleType,
    state: ResizeState,
    currentLngLat: { lng: number; lat: number },
    feature: Feature,
  ): CustomResizeResult | null;

  /**
   * Returns the snapping candidates
   *
   * An extension point that lets a custom type provide its own vertices and edges as snapping
   * targets. The built-in vertex provider calls this when there is a registration for the type
   * of the target feature (when it is called, the standard enumeration of the vertices and edges
   * of that feature is not performed).
   *
   * The returned candidates may be either point candidates that have a coordinate
   * (kind: 'vertex' and the like) or segment candidates that have two endpoints (kind: 'edge').
   * The nearest point on a segment candidate is computed by SnapService.
   *
   * @param feature The target feature
   * @param ctx The snapping context (includes the cursor position, the tolerance and exclusions)
   */
  getSnapTargets?(feature: Feature, ctx: SnapProviderContext): SnapCandidate[];
}
