// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Selection UI rendering
 *
 * Responsible for drawing the selection UI (the bounding box and the handles) for the
 * selected features.
 */

import type { CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { THINNING_VIEWPORT_MARGIN_PX } from '../../shared/config/selection.js';
import type { CoordinateTransform } from '../../shared/math/index.js';
import { supportsVertexEditing } from '../../shared/utils/coordinates.js';
import { isGlobeProjection } from '../../shared/utils/map.js';
import { isLocallyHidden, type LocalHiddenStore } from '../../store/local-visibility.js';
import type {
  Coordinate,
  DragState,
  Feature,
  VertexRef,
  VertexSelection,
} from '../../store/types.js';
import type { PointInstanceRenderer } from '../renderers/point/point-instance.js';
import type { AuxiliaryHandleContext } from './auxiliary-handles.js';
import type { ThinningViewport, VisibleHandleSet } from './handle-thinning.js';
import { computeVisibleHandleSet, shouldThinHandles } from './handle-thinning.js';
import type { HandleInfo } from './handles.js';
import type { SelectionHandlesRenderer, SelectionUIRenderer } from './index.js';
import type { SelectionScope } from './selection-scope.js';
import {
  type BoundingBoxCoords,
  computeBoundingBox,
  hasZeroArea,
  rotateBoundingBox,
} from './selection-ui/index.js';

/**
 * The dependencies needed to draw the selection UI
 */
export interface SelectionUIDrawerDeps {
  selectionUIRenderer: SelectionUIRenderer | null;
  selectionHandlesRenderer: SelectionHandlesRenderer | null;
  pointInstanceRenderer: PointInstanceRenderer | null;
  map: MapLibreMap;
  /** The selection scope of the draw instance (extension points and thinned handle sets) */
  scope: SelectionScope;
}

/**
 * Draw the selection UI
 */
export function renderSelectionUI(
  selectedFeatures: Feature[],
  zoom: number,
  projectionData: CustomRenderMethodInput['defaultProjectionData'],
  deps: SelectionUIDrawerDeps,
  dragState: DragState | null,
  selectedVertices?: VertexSelection | null,
  /**
   * Whether the selection cannot be edited (effective lock / read-only / interaction lock).
   * When true, no manipulation handles are drawn. The selection box is still drawn (feedback
   * about "what is selected" is needed in read-only too, and a frame without handles does
   * not suggest editing).
   */
  isLocked = false,
): void {
  const { selectionUIRenderer, selectionHandlesRenderer, pointInstanceRenderer, map, scope } = deps;

  if (selectedFeatures.length === 0 || !selectionUIRenderer || !selectionHandlesRenderer) {
    return;
  }

  // Set the ProjectionData of PointInstanceRenderer
  if (pointInstanceRenderer) {
    pointInstanceRenderer.setProjectionData(projectionData);
  }

  // Set the coordinate transform
  const coordinateTransform: CoordinateTransform = {
    project: (lngLat: Coordinate) => map.project([lngLat[0], lngLat[1]]),
    unproject: (point: { x: number; y: number }) => {
      const ll = map.unproject([point.x, point.y]);
      return { lng: ll.lng, lat: ll.lat };
    },
  };

  selectionUIRenderer.setTransform(coordinateTransform);
  selectionUIRenderer.setProjectionData(projectionData);
  selectionHandlesRenderer.setTransform(coordinateTransform);
  selectionHandlesRenderer.setProjectionData(projectionData);

  selectionUIRenderer.draw(selectedFeatures, zoom, dragState);

  // When it is locked, only the selection box is shown and the manipulation handles
  // (resize/rotate/vertex) are not drawn. This shows visually that it can be selected but
  // not manipulated.
  if (isLocked) return;

  // Support for custom features: uses the combined bounding box computation of selectionUIRenderer
  let bbox = selectionUIRenderer.computeCombinedFeatureBoundingBox(selectedFeatures);
  if (!bbox) return;

  // Control the display of the handles based on the drag state
  const operation = dragState?.operation ?? null;

  // While rotating, the rotated bbox is used for drawing the handles
  const rotateInfo = dragState?.rotateInfo;
  if (operation === 'rotate' && rotateInfo) {
    bbox = rotateBoundingBox(rotateInfo.initialBbox, rotateInfo.currentAngle);
  }

  if (selectedFeatures.length === 1) {
    // Get the selected vertex reference (only for the target feature)
    const selectedVertexRefs =
      selectedVertices?.featureId === selectedFeatures[0].id
        ? selectedVertices.vertices
        : undefined;

    renderSingleSelectionHandles(
      selectedFeatures[0],
      zoom,
      selectionUIRenderer,
      selectionHandlesRenderer,
      operation,
      dragState,
      selectedVertexRefs,
      prepareVisibleHandleSet(selectedFeatures[0], map, scope),
      scope,
    );
    // The handles of the extensions, shown as the other handles are (hidden while another
    // operation runs)
    if (operation === null || operation === 'auxiliary') {
      const context = auxiliaryHandleContext(map, zoom);
      const positions = scope.auxiliaryHandles
        .list()
        .flatMap((provider) =>
          provider.getHandles(selectedFeatures[0], context).map((handle) => handle.position),
        );
      if (positions.length > 0) selectionHandlesRenderer.drawAuxiliaryHandles(positions, zoom);
    }
  } else {
    renderMultiSelectionHandles(
      selectedFeatures,
      bbox,
      zoom,
      selectionHandlesRenderer,
      operation,
      scope,
    );
  }
}

/**
 * Draw the auxiliary handles that belong to no feature (`getGlobalHandles`), whatever is
 * selected
 *
 * The caller draws them only while they can be grabbed (the select mode, and the document
 * neither read-only nor under the interaction lock).
 */
export function renderGlobalAuxiliaryHandles(
  zoom: number,
  projectionData: CustomRenderMethodInput['defaultProjectionData'],
  deps: SelectionUIDrawerDeps,
  dragState: DragState | null,
): void {
  const { selectionHandlesRenderer, pointInstanceRenderer, map, scope } = deps;
  if (!selectionHandlesRenderer) return;
  const operation = dragState?.operation ?? null;
  if (operation !== null && operation !== 'auxiliary') return;
  const providers = scope.auxiliaryHandles.list();
  if (!providers.some((provider) => provider.getGlobalHandles !== undefined)) return;

  const context = auxiliaryHandleContext(map, zoom);
  const positions = providers.flatMap(
    (provider) => provider.getGlobalHandles?.(context).map((handle) => handle.position) ?? [],
  );
  if (positions.length === 0) return;

  if (pointInstanceRenderer) pointInstanceRenderer.setProjectionData(projectionData);
  selectionHandlesRenderer.setTransform(coordinateTransformOf(map));
  selectionHandlesRenderer.setProjectionData(projectionData);
  selectionHandlesRenderer.drawAuxiliaryHandles(positions, zoom);
}

/** The coordinate transform of the map */
function coordinateTransformOf(map: MapLibreMap): CoordinateTransform {
  return {
    project: (lngLat: Coordinate) => map.project([lngLat[0], lngLat[1]]),
    unproject: (point: { x: number; y: number }) => {
      const ll = map.unproject([point.x, point.y]);
      return { lng: ll.lng, lat: ll.lat };
    },
  };
}

/**
 * The context the providers of auxiliary handles get when their handles are drawn: the
 * point is the center of the canvas, as there is no pointer to test
 */
function auxiliaryHandleContext(map: MapLibreMap, zoom: number): AuxiliaryHandleContext {
  const transform = coordinateTransformOf(map);
  const canvas = map.getCanvas();
  return {
    point: { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 },
    project: (lngLat) => transform.project(lngLat),
    unproject: (point) => transform.unproject(point),
    zoom,
  };
}

/**
 * Prepare the thinning set
 *
 * The set is built only for a feature whose total number of handles exceeds the threshold.
 * For a feature at or below the threshold, undefined is returned and exactly the same path
 * as before is taken, including the thinning computation.
 */
function prepareVisibleHandleSet(
  feature: Feature,
  map: MapLibreMap,
  scope: SelectionScope,
): VisibleHandleSet | undefined {
  if (!supportsVertexEditing(feature.type) || !shouldThinHandles(feature)) return undefined;

  const viewport = computeThinningViewport(map);
  return scope.thinning.ensureSet(
    feature,
    buildCameraSignature(map),
    performance.now(),
    () => computeVisibleHandleSet(feature, (coord) => map.project([coord[0], coord[1]]), viewport),
    // Make sure the recomputation runs even if no rendering frame arrives after the camera stops
    () => map.triggerRepaint(),
  );
}

/**
 * Build the camera signature
 *
 * Only exact equality is looked at, so nothing is rounded. Any movement at all changes the
 * signature, and the recomputation after the camera stops runs on a debounce.
 */
function buildCameraSignature(map: MapLibreMap): string {
  const center = map.getCenter();
  return `${center.lng},${center.lat},${map.getZoom()},${map.getBearing()},${map.getPitch()}`;
}

/**
 * Obtain the viewport rectangle used for the preliminary narrowing
 *
 * Adds a margin to the bounding rectangle of the screen (including bearing / pitch). The
 * pixel-to-degree conversion of the margin is obtained from the difference of two unproject
 * calls. When it crosses longitude ±180 the narrowing is given up (every vertex becomes
 * a candidate).
 */
function computeThinningViewport(map: MapLibreMap): ThinningViewport {
  // On the globe the bounds maplibre reports fall short of the edge of the sphere, and the
  // corners of the screen can lie off it, so nothing is narrowed there
  if (isGlobeProjection(map)) return { bounds: null };
  const bounds = map.getBounds();
  const origin = map.unproject([0, 0]);
  const lngMargin = Math.abs(map.unproject([THINNING_VIEWPORT_MARGIN_PX, 0]).lng - origin.lng);
  const latMargin = Math.abs(map.unproject([0, THINNING_VIEWPORT_MARGIN_PX]).lat - origin.lat);

  const minLng = bounds.getWest() - lngMargin;
  const maxLng = bounds.getEast() + lngMargin;
  if (minLng > maxLng || minLng < -180 || maxLng > 180) {
    return { bounds: null };
  }

  return {
    bounds: {
      minLng,
      maxLng,
      minLat: bounds.getSouth() - latMargin,
      maxLat: bounds.getNorth() + latMargin,
    },
  };
}

/**
 * The minimal interface of the Store that drawing the following vertices needs
 *
 * It is enough to be able to look up a feature by id and to decide local visibility.
 */
export interface FollowedVertexStore extends LocalHiddenStore {
  getFeature(id: string): Feature | undefined;
}

/**
 * Draw the vertices that follow along when a shared vertex is moved
 *
 * The following features are not selected, so they do not take the path of the selection UI.
 * The UI state raised only during a drag (store.getFollowedVertices) is read and they are
 * drawn in a different style from the selected vertices.
 * Calling it after the selection UI puts the following vertices in front of the selection
 * box and the handles.
 */
export function renderFollowedVertices(
  followedVertices: VertexSelection[] | null,
  store: FollowedVertexStore,
  zoom: number,
  projectionData: CustomRenderMethodInput['defaultProjectionData'],
  deps: SelectionUIDrawerDeps,
): void {
  if (!followedVertices || followedVertices.length === 0) return;

  const { selectionHandlesRenderer, pointInstanceRenderer, map } = deps;
  if (!selectionHandlesRenderer) return;

  if (pointInstanceRenderer) {
    pointInstanceRenderer.setProjectionData(projectionData);
  }

  const coordinateTransform: CoordinateTransform = {
    project: (lngLat: Coordinate) => map.project([lngLat[0], lngLat[1]]),
    unproject: (point: { x: number; y: number }) => {
      const ll = map.unproject([point.x, point.y]);
      return { lng: ll.lng, lat: ll.lat };
    },
  };
  selectionHandlesRenderer.setTransform(coordinateTransform);
  selectionHandlesRenderer.setProjectionData(projectionData);

  for (const followed of followedVertices) {
    const feature = store.getFeature(followed.featureId);
    // The handles of features that disappeared or were hidden during the drag are not drawn
    if (!feature?.visible || isLocallyHidden(feature, store)) continue;
    selectionHandlesRenderer.drawFollowedVertexHandles(feature, followed.vertices, zoom);
  }
}

/**
 * Draw the handles for a single selection
 */
function renderSingleSelectionHandles(
  feature: Feature,
  zoom: number,
  selectionUIRenderer: SelectionUIRenderer,
  selectionHandlesRenderer: SelectionHandlesRenderer,
  operation: DragState['operation'] | null,
  dragState: DragState | null,
  selectedVertexRefs: VertexRef[] | undefined,
  visibleSet: VisibleHandleSet | undefined,
  scope: SelectionScope,
): void {
  // Zero area (a single-coordinate feature) has no resize or rotate handles.
  // But a vertex-editable type (such as a MultiPoint with a single point) still gets its
  // vertex handles drawn. Hit testing (hitTestVertexHandles) can grab a vertex even at zero
  // area, so without drawing them the state would be "grabbable although invisible".
  const featureBbox = computeBoundingBox(feature, scope.extensions);
  if (featureBbox && hasZeroArea(featureBbox)) {
    if (supportsVertexEditing(feature.type) && operation !== 'move') {
      selectionHandlesRenderer.drawAllHandles(
        feature,
        featureBbox,
        {
          showResize: false,
          showRotate: false,
          showVertex: true,
          showMidpoint: false,
          activeVertex: operation === 'vertex' ? dragState?.activeVertex : undefined,
          selectedVertices: selectedVertexRefs,
          visibleSet,
        },
        zoom,
      );
    }
    return;
  }

  // Support for custom features: uses computeFeatureBoundingBox of selectionUIRenderer
  let singleBbox = selectionUIRenderer.computeFeatureBoundingBox(feature);
  if (!singleBbox) return;

  // While rotating, the rotated bbox is used
  const rotateInfo = dragState?.rotateInfo;
  if (operation === 'rotate' && rotateInfo) {
    singleBbox = rotateBoundingBox(rotateInfo.initialBbox, rotateInfo.currentAngle);
  }

  // The special handle rendering for Circle
  if (feature.type === 'Circle') {
    renderCircleHandles(feature, singleBbox, zoom, selectionHandlesRenderer, operation);
  } else {
    renderNonCircleHandles(
      feature,
      singleBbox,
      zoom,
      selectionHandlesRenderer,
      operation,
      dragState,
      selectedVertexRefs,
      visibleSet,
      scope,
    );
  }
}

/**
 * Draw the handles of a Circle
 */
function renderCircleHandles(
  feature: Feature,
  bbox: BoundingBoxCoords,
  zoom: number,
  selectionHandlesRenderer: SelectionHandlesRenderer,
  operation: DragState['operation'] | null,
): void {
  let showResize = true;
  let showRadiusHandle = true;
  let showCenterMarker = true;
  let showRadiusLine = true;

  if (operation === 'move') {
    // While moving: all handles are hidden
    showResize = false;
    showRadiusHandle = false;
    showCenterMarker = false;
    showRadiusLine = false;
  } else if (operation === 'resize') {
    // While resizing: only the resize handles are shown
    showRadiusHandle = false;
    showCenterMarker = false;
    showRadiusLine = false;
  } else if (operation === 'radius') {
    // While changing the radius: only the radius-related ones are shown
    showResize = false;
  }

  selectionHandlesRenderer.drawCircleHandles(
    feature,
    bbox,
    {
      showResize,
      showRadiusHandle,
      showCenterMarker,
      showRadiusLine,
    },
    zoom,
  );
}

/**
 * Draw the handles of features other than Circle
 */
function renderNonCircleHandles(
  feature: Feature,
  bbox: BoundingBoxCoords,
  zoom: number,
  selectionHandlesRenderer: SelectionHandlesRenderer,
  operation: DragState['operation'] | null,
  dragState: DragState | null,
  selectedVertexRefs: VertexRef[] | undefined,
  visibleSet: VisibleHandleSet | undefined,
  scope: SelectionScope,
): void {
  // The rules for showing handles in a single selection
  // (LineString, Polygon, the Multi kinds, Image, Freehand, custom features)
  // The Multi kinds are treated the same as LineString / Polygon (with vertex handles).
  // MultiPoint has no edges, so the midpoint handles come out empty.
  const isVertexEditable = supportsVertexEditing(feature.type);
  const isImage = feature.type === 'Image';
  const isFreehand = feature.type === 'Freehand';
  // Custom features: anything other than the types Core knows is treated like Image
  const isCustomFeature = !isVertexEditable && !isImage && !isFreehand && feature.type !== 'Circle';

  let showResize = true;
  let showRotate = true;
  // Freehand and custom features do not show vertex handles
  let showVertex = isVertexEditable;
  let showMidpoint = isVertexEditable;
  let activeVertex: VertexRef | undefined;

  if (operation === 'move') {
    // While moving: vertex-editable types/Text/Image/Freehand/custom features hide all handles
    if (isVertexEditable || isImage || isFreehand || isCustomFeature) {
      showResize = false;
      showRotate = false;
      showVertex = false;
      showMidpoint = false;
    }
  } else if (operation === 'resize') {
    // While resizing: only the resize handles are shown
    showRotate = false;
    showVertex = false;
    showMidpoint = false;
  } else if (operation === 'rotate') {
    // While rotating: only the rotate handles are shown
    showResize = false;
    showVertex = false;
    showMidpoint = false;
  } else if (operation === 'vertex' || operation === 'midpoint') {
    // While editing a vertex / adding a vertex: only the vertex being manipulated is shown
    showResize = false;
    showRotate = false;
    showMidpoint = false;
    activeVertex = dragState?.activeVertex;
  }

  // Create the callback that computes the additional handles of a custom feature
  // Get the calculator from the draw instance's registry
  let getAdditionalResizeHandles: ((marginedBbox: BoundingBoxCoords) => HandleInfo[]) | undefined;
  const calculator = scope.extensions.getAdditionalResizeHandlesCalculator(feature.type);
  if (calculator) {
    // Create the callback that receives the bbox after the margin is applied
    getAdditionalResizeHandles = (marginedBbox) =>
      calculator(feature, marginedBbox) as HandleInfo[];
  }

  selectionHandlesRenderer.drawAllHandles(
    feature,
    bbox,
    {
      showResize,
      showRotate,
      showVertex,
      showMidpoint,
      activeVertex,
      selectedVertices: selectedVertexRefs,
      getAdditionalResizeHandles,
      visibleSet,
    },
    zoom,
  );
}

/**
 * Draw the handles for a multi-selection
 */
function renderMultiSelectionHandles(
  selectedFeatures: Feature[],
  bbox: BoundingBoxCoords,
  zoom: number,
  selectionHandlesRenderer: SelectionHandlesRenderer,
  operation: DragState['operation'] | null,
  scope: SelectionScope,
): void {
  const hasNonPoint = selectedFeatures.some((f) => {
    const bbox = computeBoundingBox(f, scope.extensions);
    return bbox !== null && !hasZeroArea(bbox);
  });
  if (!hasNonPoint) {
    return;
  }

  let showResize = true;
  let showRotate = true;

  if (operation === 'move') {
    // While moving: the resize and rotate handles are hidden
    showResize = false;
    showRotate = false;
  } else if (operation === 'resize') {
    // While resizing: the rotate handles are hidden
    showRotate = false;
  } else if (operation === 'rotate') {
    // While rotating: the resize handles are hidden
    showResize = false;
  }

  if (showResize) {
    selectionHandlesRenderer.drawResizeHandles(bbox, zoom);
  }
  if (showRotate) {
    selectionHandlesRenderer.drawRotateHandle(bbox, zoom);
  }
}
