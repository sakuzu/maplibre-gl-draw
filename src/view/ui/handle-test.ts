// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Handle hit testing
 *
 * Performs hit testing for the selection handles (resize, rotate, vertex, midpoint)
 *
 * Handles are drawn in screen coordinates, so hit testing is also done in screen
 * coordinates by checking whether the click position is inside the handle's rectangle
 * (bounding box). This yields accurate hit testing that matches the rendering.
 */

import type { HandleType } from '../../shared/config/constants.js';
import type { SelectionUIConfig } from '../../shared/config/selection.js';
import type { CoordinateTransform } from '../../shared/math/index.js';
import { applyMarginToBoundingBox } from '../../shared/math/index.js';
import { nearestLongitude } from '../../shared/math/longitude.js';
import { summaryHasArea } from '../../store/bulk-selection.js';
import type { Coordinate, Feature, SelectionBulk, VertexRef } from '../../store/types.js';
import {
  type AuxiliaryHandleCandidate,
  type AuxiliaryHandleContext,
  type AuxiliaryHandleHit,
  auxiliaryHandleSize,
} from './auxiliary-handles.js';
import { isPointInGeoBoundingBox, isPointInSelectionFrame } from './bounds.js';
import type { VisibleHandleSet } from './handle-thinning.js';
import { resolveMidpointCoordinate, resolveVertexCoordinate } from './handle-thinning.js';
import {
  computeCircleRadiusHandle,
  computeMidpointHandles,
  computeResizeHandles,
  computeRotateHandle,
  computeVertexHandles,
  supportsVertexEditing,
} from './handles.js';
import type { SelectionScope } from './selection-scope.js';
import type { BoundingBoxCoords } from './selection-ui/index.js';
import {
  computeBoundingBox,
  computeCombinedBoundingBox,
  hasZeroArea,
} from './selection-ui/index.js';

/**
 * Handle hit test result
 *
 * @internal
 */
export interface HandleHitResult {
  /** Kind of the handle that was hit */
  type: 'rotate' | 'resize' | 'vertex' | 'midpoint' | 'move' | 'radius' | 'auxiliary';
  /** Handle type (for resize) */
  handle?: HandleType;
  /** Vertex reference (for vertex/midpoint; part number + ring number + vertex index) */
  vertexRef?: VertexRef;
  /** Feature ID (for vertex/midpoint/auxiliary handles) */
  featureId?: string;
  /** Hit information of the auxiliary handle (for auxiliary handles) */
  auxiliary?: AuxiliaryHandleHit;
  /** Cursor specified by the auxiliary handle (for auxiliary handles; undefined if unset) */
  cursor?: string;
}

/**
 * Callback that enumerates the auxiliary handles
 *
 * Passed only for a single selection (assembled by modes/select/hit-helpers).
 * If it is not passed, auxiliary handles are not tested at all.
 *
 * @internal
 */
export type AuxiliaryHandlesCallback = (
  context: AuxiliaryHandleContext,
) => AuxiliaryHandleCandidate[];

/**
 * Hit test parameters in screen coordinates
 */
interface HitTestParams {
  screenPoint: { x: number; y: number };
  transform: CoordinateTransform;
  /** The selection scope of the draw instance (the displayed thinned handle sets) */
  scope: SelectionScope;
}

/**
 * A transform that projects every longitude on the copy of the world nearest to the pointer
 *
 * The handles are tested around the pointer. Across the antimeridian the feature on the other
 * side of the line is drawn as a second copy, moved by 360 degrees, while its coordinates stay
 * stored in [-180, 180] and the pointer unprojects to the unwrapped longitude of the view. The
 * copy nearest to the pointer is the copy drawn there, so a handle is projected on it. Away from
 * the antimeridian no longitude moves (nearestLongitude leaves anything within 180 degrees).
 */
function alignToPointer(
  transform: CoordinateTransform,
  screenPoint: { x: number; y: number },
): CoordinateTransform {
  const reference = transform.unproject(screenPoint).lng;
  return {
    project: (lngLat) => transform.project([nearestLongitude(lngLat[0], reference), lngLat[1]]),
    unproject: (point) => transform.unproject(point),
    metersPerPixel: (lngLat) => transform.metersPerPixel(lngLat),
  };
}

/**
 * Determines, in screen coordinates, whether the point is inside the handle's rectangle
 *
 * Builds a rectangle from the handle's center position and radius (size/2), and determines
 * whether the click position is inside that rectangle.
 */
function isPointInHandleRect(
  screenPoint: { x: number; y: number },
  handleScreenPos: { x: number; y: number },
  halfSize: number,
): boolean {
  return (
    screenPoint.x >= handleScreenPos.x - halfSize &&
    screenPoint.x <= handleScreenPos.x + halfSize &&
    screenPoint.y >= handleScreenPos.y - halfSize &&
    screenPoint.y <= handleScreenPos.y + halfSize
  );
}

/**
 * Hit test for the rotate handle
 */
function hitTestRotateHandle(
  marginedBbox: BoundingBoxCoords,
  config: SelectionUIConfig,
  params: HitTestParams,
): HandleHitResult | null {
  const handle = computeRotateHandle(marginedBbox, config.rotateHandle.distance, params.transform);
  const handleScreenPos = params.transform.project(handle.position);
  const halfSize = config.rotateHandle.point.size / 2;

  if (isPointInHandleRect(params.screenPoint, handleScreenPos, halfSize)) {
    return { type: 'rotate' };
  }

  return null;
}

/**
 * Hit test for the resize handles at the four corners
 *
 * @param marginedBbox Bounding box after the margin is applied
 * @param config Configuration of the selection UI
 * @param params Hit test parameters
 */
function hitTestResizeHandles(
  marginedBbox: BoundingBoxCoords,
  config: SelectionUIConfig,
  params: HitTestParams,
): HandleHitResult | null {
  const handles = computeResizeHandles(marginedBbox);
  const halfSize = config.resizeHandle.point.size / 2;

  for (const handle of handles) {
    const handleScreenPos = params.transform.project(handle.position);
    if (isPointInHandleRect(params.screenPoint, handleScreenPos, halfSize)) {
      return {
        type: 'resize',
        handle: handle.type,
      };
    }
  }

  return null;
}

/** Extra margin added to the pointer rectangle used for pre-filtering (pixels) */
const POINTER_BOUNDS_MARGIN_PX = 2;

/** Longitude/latitude rectangle used for pre-filtering */
interface PointerBounds {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/**
 * Computes the longitude/latitude rectangle around the pointer
 *
 * Unprojects the four corners of the screen rectangle centered on the press point and
 * builds their bounding box. Hit testing while thinning uses it to discard vertices outside
 * this rectangle without projecting them. When it crosses longitude +/-180, pre-filtering
 * is given up (null).
 */
function computePointerBounds(params: HitTestParams, halfSize: number): PointerBounds | null {
  const size = halfSize + POINTER_BOUNDS_MARGIN_PX;
  const { x, y } = params.screenPoint;
  const corners = [
    params.transform.unproject({ x: x - size, y: y - size }),
    params.transform.unproject({ x: x + size, y: y - size }),
    params.transform.unproject({ x: x - size, y: y + size }),
    params.transform.unproject({ x: x + size, y: y + size }),
  ];

  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const corner of corners) {
    minLng = Math.min(minLng, corner.lng);
    maxLng = Math.max(maxLng, corner.lng);
    minLat = Math.min(minLat, corner.lat);
    maxLat = Math.max(maxLat, corner.lat);
  }

  // A large longitude difference despite a tiny screen rectangle means the date line was
  // crossed
  if (maxLng - minLng > 180) return null;

  return { minLng, minLat, maxLng, maxLat };
}

/**
 * Whether the coordinate falls inside the pre-filter rectangle (always true if it is null)
 */
function isInPointerBounds(coord: Coordinate, bounds: PointerBounds | null): boolean {
  if (!bounds) return true;
  // The rectangle is in the unwrapped longitudes of the pointer (alignToPointer)
  const lng = nearestLongitude(coord[0], (bounds.minLng + bounds.maxLng) / 2);
  return (
    lng >= bounds.minLng &&
    lng <= bounds.maxLng &&
    coord[1] >= bounds.minLat &&
    coord[1] <= bounds.maxLat
  );
}

/**
 * Hit test against the set of handles currently displayed
 *
 * The path used while thinning. Candidates are narrowed by the pointer rectangle before
 * being projected, so it stays cheap however large the set is. The test itself is the same
 * as in the full-enumeration path (isPointInHandleRect).
 */
function hitTestVisibleRefs(
  feature: Feature,
  refs: readonly VertexRef[],
  resolve: (feature: Feature, ref: VertexRef) => Coordinate | null,
  halfSize: number,
  params: HitTestParams,
): VertexRef | null {
  const bounds = computePointerBounds(params, halfSize);

  for (const ref of refs) {
    const position = resolve(feature, ref);
    if (!position) continue;
    if (!isInPointerBounds(position, bounds)) continue;

    const handleScreenPos = params.transform.project(position);
    if (isPointInHandleRect(params.screenPoint, handleScreenPos, halfSize)) {
      // Do not hand out the reference stored in the cache as is (the caller keeps it)
      return { ...ref };
    }
  }

  return null;
}

/**
 * Hit test for the vertex handles
 *
 * For a Polygon all rings (outer ring + inner rings) are covered, and for the Multi types
 * the vertices of all parts. Because it uses the same computeVertexHandles as the
 * rendering, every vertex that shows a handle can always be grabbed.
 *
 * While thinning, only the displayed set is covered. Circles that are not visible cannot be
 * grabbed, but in exchange everything that can be grabbed is visible.
 */
function hitTestVertexHandles(
  feature: Feature,
  config: SelectionUIConfig,
  params: HitTestParams,
): HandleHitResult | null {
  const halfSize = config.vertexHandle.point.size / 2;
  const displayed: VisibleHandleSet | null = params.scope.thinning.getDisplayedSet(feature);

  if (displayed) {
    const vertexRef = hitTestVisibleRefs(
      feature,
      displayed.vertexRefs,
      resolveVertexCoordinate,
      halfSize,
      params,
    );
    return vertexRef ? { type: 'vertex', vertexRef, featureId: feature.id } : null;
  }

  const handles = computeVertexHandles(feature);

  for (const handle of handles) {
    const handleScreenPos = params.transform.project(handle.position);
    if (isPointInHandleRect(params.screenPoint, handleScreenPos, halfSize)) {
      return {
        type: 'vertex',
        vertexRef: handle.vertexRef,
        featureId: feature.id,
      };
    }
  }

  return null;
}

/**
 * Hit test for the midpoint handles
 *
 * For a Polygon all rings (outer ring + inner rings) are covered, and for the Multi types
 * the edges of all parts. While thinning, only the displayed midpoints are covered.
 */
function hitTestMidpointHandles(
  feature: Feature,
  config: SelectionUIConfig,
  params: HitTestParams,
): HandleHitResult | null {
  const halfSize = config.midpointHandle.point.size / 2;
  const displayed: VisibleHandleSet | null = params.scope.thinning.getDisplayedSet(feature);

  if (displayed) {
    const vertexRef = hitTestVisibleRefs(
      feature,
      displayed.midpointRefs,
      resolveMidpointCoordinate,
      halfSize,
      params,
    );
    return vertexRef ? { type: 'midpoint', vertexRef, featureId: feature.id } : null;
  }

  const handles = computeMidpointHandles(feature);

  for (const handle of handles) {
    const handleScreenPos = params.transform.project(handle.position);
    if (isPointInHandleRect(params.screenPoint, handleScreenPos, halfSize)) {
      return {
        type: 'midpoint',
        vertexRef: handle.vertexRef,
        featureId: feature.id,
      };
    }
  }

  return null;
}

/**
 * Hit test for the radius handle of a Circle
 */
function hitTestCircleRadiusHandle(
  feature: Feature,
  config: SelectionUIConfig,
  params: HitTestParams,
): HandleHitResult | null {
  const handle = computeCircleRadiusHandle(feature);
  if (!handle) return null;

  const handleScreenPos = params.transform.project(handle.position);
  const halfSize = config.radiusHandle.point.size / 2;

  if (isPointInHandleRect(params.screenPoint, handleScreenPos, halfSize)) {
    return { type: 'radius', featureId: feature.id };
  }

  return null;
}

/**
 * Hit test for the auxiliary handles (provided by an extension implementation)
 *
 * Enumerating the handles is left to the callback (the aggregation of the providers), while
 * the test is done with the same screen-px rectangle as the existing handles, of the size each
 * handle is shown at: the size of the resize handles for a `resize` handle (the size the
 * selection UI draws it at), the size the extension declares for a `custom` one (the size of the
 * mark it draws).
 */
function hitTestAuxiliaryHandles(
  feature: Feature,
  config: SelectionUIConfig,
  zoom: number,
  params: HitTestParams,
  getAuxiliaryHandles: AuxiliaryHandlesCallback,
): HandleHitResult | null {
  const context: AuxiliaryHandleContext = {
    point: params.screenPoint,
    project: (lngLat) => params.transform.project(lngLat),
    unproject: (point) => params.transform.unproject(point),
    zoom,
  };

  const resizeSize = config.resizeHandle.point.size;

  for (const { providerId, handle } of getAuxiliaryHandles(context)) {
    const handleScreenPos = params.transform.project(handle.position);
    const halfSize = auxiliaryHandleSize(handle, resizeSize) / 2;
    if (isPointInHandleRect(params.screenPoint, handleScreenPos, halfSize)) {
      return {
        type: 'auxiliary',
        featureId: feature.id,
        auxiliary: { providerId, handleId: handle.id, featureId: feature.id },
        cursor: handle.cursor,
      };
    }
  }

  return null;
}

/**
 * Hit test for the selection-independent auxiliary handles
 *
 * It can be called even when the selection is empty (hitTestHandles assumes a selection, so
 * this is a separate entry point). The test size, the handling of the cursor and the shape
 * of the returned HandleHitResult are identical to the auxiliary handles of the selection,
 * and drag delegation goes through the same auxiliary path. The only difference is that
 * "there is no feature it sits on", which is expressed by global / an empty featureId on
 * the hit.
 *
 * @param getGlobalHandles Callback that enumerates the handles (when omitted, no test is
 *   performed)
 *
 * @internal
 */
export function hitTestGlobalAuxiliaryHandles(
  screenPoint: { x: number; y: number },
  transform: CoordinateTransform,
  config: SelectionUIConfig,
  zoom: number,
  getGlobalHandles?: AuxiliaryHandlesCallback,
): HandleHitResult | null {
  if (!getGlobalHandles) return null;
  transform = alignToPointer(transform, screenPoint);

  const context: AuxiliaryHandleContext = {
    point: screenPoint,
    project: (lngLat) => transform.project(lngLat),
    unproject: (point) => transform.unproject(point),
    zoom,
  };

  const resizeSize = config.resizeHandle.point.size;

  for (const { providerId, handle } of getGlobalHandles(context)) {
    const handleScreenPos = transform.project(handle.position);
    const halfSize = auxiliaryHandleSize(handle, resizeSize) / 2;
    if (isPointInHandleRect(screenPoint, handleScreenPos, halfSize)) {
      return {
        type: 'auxiliary',
        auxiliary: { providerId, handleId: handle.id, featureId: '', global: true },
        cursor: handle.cursor,
      };
    }
  }

  return null;
}

/**
 * Hit test against all handles
 *
 * Priority order:
 * 1. Rotate handle
 * 2. Resize handles (the four corners)
 * 3. Auxiliary handles (provided by an extension implementation; single selection only)
 * 4. Vertex handles
 * 5. Midpoint handles
 * 6. Inside of the bounding box (move)
 *
 * @param screenPoint Screen coordinates
 * @param features The selected features
 * @param transform Coordinate transform
 * @param config Configuration of the selection UI
 * @param zoom Zoom level
 * @param scope The selection scope of the draw instance (extension points of the custom
 *   types and the thinned handle sets that are displayed)
 * @param getAuxiliaryHandles Callback that enumerates the auxiliary handles (when omitted,
 *   the auxiliary handles are not tested)
 *
 * @internal
 */
export function hitTestHandles(
  screenPoint: { x: number; y: number },
  features: Feature[],
  transform: CoordinateTransform,
  config: SelectionUIConfig,
  zoom: number,
  scope: SelectionScope,
  getAuxiliaryHandles?: AuxiliaryHandlesCallback,
): HandleHitResult | null {
  if (features.length === 0) {
    return null;
  }
  transform = alignToPointer(transform, screenPoint);

  // Compute the bbox without the margin (for computing the handle positions)
  const rawBbox = computeCombinedBoundingBox(features, scope.extensions);
  if (!rawBbox) {
    return null;
  }

  // The bbox after the margin is applied (for computing the handle positions), as the drawing
  // makes it
  const margin = config.box.margin;
  const marginedBbox: BoundingBoxCoords = {
    ...applyMarginToBoundingBox(rawBbox, margin, transform),
    center: rawBbox.center,
  };

  const params: HitTestParams = {
    screenPoint,
    transform,
    scope,
  };

  // When only single-coordinate features (Point and the like) are selected, skip the rotate
  // and resize handles
  const singleFeatureBbox =
    features.length === 1 ? computeBoundingBox(features[0], scope.extensions) : null;
  const isPointOnly = singleFeatureBbox !== null && hasZeroArea(singleFeatureBbox);
  // A Circle has no rotate handle; it has a radius handle instead
  const isCircle = features.length === 1 && features[0].type === 'Circle';

  if (!isPointOnly) {
    // For a Circle: the radius handle (in place of the rotate handle)
    if (isCircle) {
      const radiusHit = hitTestCircleRadiusHandle(features[0], config, params);
      if (radiusHit) return radiusHit;
    } else {
      // 1. Rotate handle (anything other than a Circle)
      const rotateHit = hitTestRotateHandle(marginedBbox, config, params);
      if (rotateHit) return rotateHit;
    }

    // 2. Resize handles
    const resizeHit = hitTestResizeHandles(marginedBbox, config, params);
    if (resizeHit) return resizeHit;
  }

  // 3. Auxiliary handles (single selection only). They are taken after resize and before
  //    vertex. When they
  //    overlap a vertex or a midpoint, the auxiliary handle wins (it is enough to move it
  //    aside and then grab the vertex).
  if (features.length === 1 && getAuxiliaryHandles) {
    const auxiliaryHit = hitTestAuxiliaryHandles(
      features[0],
      config,
      zoom,
      params,
      getAuxiliaryHandles,
    );
    if (auxiliaryHit) return auxiliaryHit;
  }

  // 4. Vertex handles (single selection only)
  if (features.length === 1) {
    const feature = features[0];
    // Point, Text, Image, Circle and Freehand have no vertex handles (move only)
    // Freehand does not support vertex editing (because it is a free curve)
    if (supportsVertexEditing(feature.type)) {
      const vertexHit = hitTestVertexHandles(feature, config, params);
      if (vertexHit) return vertexHit;

      // 5. Midpoint handles (a MultiPoint has no edges, so the result is empty)
      const midpointHit = hitTestMidpointHandles(feature, config, params);
      if (midpointHit) return midpointHit;
    }
  }

  // 6. Inside of the frames drawn (move)
  if (isPointInSelectionFrame(screenPoint, features, transform, config, scope.extensions)) {
    return { type: 'move' };
  }

  return null;
}

/**
 * Hit test of the handles of features selected in bulk (`Selection.bulk`), on the frame of their
 * extent: its rotate and resize handles (when a feature has an extent of an area, as for
 * features selected one by one), then its inside (move)
 *
 * @internal
 */
export function hitTestBulkHandles(
  screenPoint: { x: number; y: number },
  bulk: SelectionBulk,
  transform: CoordinateTransform,
  config: SelectionUIConfig,
  scope: SelectionScope,
): HandleHitResult | null {
  if (!bulk.bbox) return null;
  transform = alignToPointer(transform, screenPoint);
  const rawBbox = bulkFrame(bulk.bbox);
  const marginedBbox: BoundingBoxCoords = {
    ...applyMarginToBoundingBox(rawBbox, config.box.margin, transform),
    center: rawBbox.center,
  };
  const params: HitTestParams = { screenPoint, transform, scope };
  if (summaryHasArea(bulk)) {
    const rotateHit = hitTestRotateHandle(marginedBbox, config, params);
    if (rotateHit) return rotateHit;
    const resizeHit = hitTestResizeHandles(marginedBbox, config, params);
    if (resizeHit) return resizeHit;
  }
  const geoLngLat = transform.unproject(screenPoint);
  if (isPointInGeoBoundingBox([geoLngLat.lng, geoLngLat.lat], marginedBbox)) {
    return { type: 'move' };
  }
  return null;
}

/**
 * The frame of an extent `[west, south, east, north]` (the frame of features selected in bulk)
 *
 * @internal
 */
export function bulkFrame(bounds: readonly [number, number, number, number]): BoundingBoxCoords {
  const [west, south, east, north] = bounds;
  return {
    topLeft: [west, north],
    topRight: [east, north],
    bottomRight: [east, south],
    bottomLeft: [west, south],
    center: [(west + east) / 2, (south + north) / 2],
  };
}

/**
 * Gets the cursor that corresponds to the handle type
 *
 * @internal
 */
export function getCursorForHandle(hitResult: HandleHitResult | null): string {
  if (!hitResult) return 'default';

  switch (hitResult.type) {
    case 'rotate':
      return 'grab';
    case 'resize': {
      // The resize cursor that matches the handle position
      switch (hitResult.handle) {
        case 'resize-nw':
          return 'nw-resize';
        case 'resize-n':
          return 'n-resize';
        case 'resize-ne':
          return 'ne-resize';
        case 'resize-e':
          return 'e-resize';
        case 'resize-se':
          return 'se-resize';
        case 'resize-s':
          return 's-resize';
        case 'resize-sw':
          return 'sw-resize';
        case 'resize-w':
          return 'w-resize';
        default:
          return 'default';
      }
    }
    case 'vertex':
      return 'pointer';
    case 'midpoint':
      return 'crosshair';
    case 'move':
      return 'move';
    case 'radius':
      return 'pointer';
    case 'auxiliary':
      // The cursor specified by the auxiliary handle; if unset, 'pointer' as for vertices
      return hitResult.cursor ?? 'pointer';
    default:
      return 'default';
  }
}
