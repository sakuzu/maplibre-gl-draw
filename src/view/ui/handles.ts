// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Selection handle rendering
 *
 * Draws the handles used for resizing, rotating and vertex editing.
 */

import type { ProjectionData } from 'maplibre-gl';
import { destinationPoint } from '../../geometry/distance.js';
import type { HandleType } from '../../shared/config/constants.js';
import type { SelectionUIConfig } from '../../shared/config/selection.js';
import { mercatorMidpoint } from '../../shared/math/globe-subdivision.js';
import type { CoordinateTransform } from '../../shared/math/index.js';
import { applyMarginToBoundingBox, clampLatitude } from '../../shared/math/index.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import { getCircleRadius, getRadiusHandleAngle } from '../../shared/utils/property.js';
import { hasVertexRef, isSameVertexRef } from '../../shared/utils/vertex-ref.js';
import type { Coordinate, Feature, VertexRef } from '../../store/types.js';
import type {
  PointInstanceDataFull,
  PointInstanceRenderer,
} from '../renderers/point/point-instance.js';
import type { PointShapeRenderer, PointStyle } from '../renderers/point/point-shape.js';
import type { StrokeRenderer } from '../renderers/stroke.js';
import type { VisibleHandleSet } from './handle-thinning.js';
import {
  includeRequiredVertexRefs,
  resolveMidpointCoordinate,
  resolveVertexCoordinate,
} from './handle-thinning.js';
import type { BoundingBoxCoords } from './selection-ui/index.js';

/**
 * A handle of the selection UI: its kind and its position.
 */
export interface HandleInfo {
  /** The kind of handle (a resize corner, a vertex, a midpoint, a rotation handle...) */
  type: HandleType;
  /** The position of the handle, `[lng, lat]` in degrees */
  position: Coordinate;
  /** Vertex reference for vertex/midpoint handles (part number + ring number + vertex index) */
  vertexRef?: VertexRef;
}

// supportsVertexEditing is a predicate on the feature type, defined in shared/ (the handle
// thinning and the modes read it too); re-exported here for the existing imports
export { supportsVertexEditing } from '../../shared/utils/coordinates.js';

/**
 * Computes the positions of the resize handles
 * Specification: show resize handles only at the four corners of the bounding box
 *
 * @param bbox Bounding box
 * @param additionalHandles Additional handles (edge-center handles and the like)
 *
 * @internal
 */
export function computeResizeHandles(
  bbox: BoundingBoxCoords,
  additionalHandles?: HandleInfo[],
): HandleInfo[] {
  const { topLeft, topRight, bottomRight, bottomLeft } = bbox;

  const handles: HandleInfo[] = [
    { type: 'resize-nw', position: topLeft },
    { type: 'resize-ne', position: topRight },
    { type: 'resize-se', position: bottomRight },
    { type: 'resize-sw', position: bottomLeft },
  ];

  // Append the additional handles if there are any
  if (additionalHandles && additionalHandles.length > 0) {
    handles.push(...additionalHandles);
  }

  return handles;
}

/**
 * Computes the position of the rotate handle
 *
 * Supports an OBB (rotated bounding box).
 * Offsets in the direction perpendicular to the top edge.
 *
 * @internal
 */
export function computeRotateHandle(
  bbox: BoundingBoxCoords,
  distancePixels: number,
  zoom: number,
): HandleInfo {
  // Midpoint of the top edge, on the edge as drawn (a plain average on a parallel)
  const topCenter = mercatorMidpoint(bbox.topLeft, bbox.topRight);

  // Convert the pixel distance to degrees (approximation)
  const pixelsPerDegree = (256 * 2 ** zoom) / 360;
  const degreesOffset = distancePixels / pixelsPerDegree;

  // Edge vector of the top edge (topLeft -> topRight)
  const edgeDx = bbox.topRight[0] - bbox.topLeft[0];
  const edgeDy = bbox.topRight[1] - bbox.topLeft[1];

  // Latitude correction: in geographic coordinates longitude and latitude have different
  // scales, so a latitude correction is required to compute the correct perpendicular vector
  const latRad = (topCenter[1] * Math.PI) / 180;
  const latCos = Math.cos(latRad);

  // Edge vector in the normalized space (latCos applied along the longitude axis)
  const normEdgeDx = edgeDx * latCos;
  const normEdgeDy = edgeDy;

  // Length of the edge in the normalized space
  const normEdgeLength = Math.sqrt(normEdgeDx * normEdgeDx + normEdgeDy * normEdgeDy);

  // When the edge is 0 (a single point and the like), default to the upward direction
  if (normEdgeLength === 0) {
    return {
      type: 'rotate',
      // Clamped because at low zoom levels the latitude can fall outside the valid range
      position: [topCenter[0], clampLatitude(topCenter[1] + degreesOffset)],
    };
  }

  // Unit edge vector in the normalized space
  const normUnitDx = normEdgeDx / normEdgeLength;
  const normUnitDy = normEdgeDy / normEdgeLength;

  // Perpendicular vector in the normalized space (90 degrees counterclockwise = upward)
  // In 2D the perpendicular of (dx, dy) is (-dy, dx)
  const normPerpX = -normUnitDy;
  const normPerpY = normUnitDx;

  // Convert back to geographic coordinates (divide by latCos along the longitude axis)
  const perpX = normPerpX / latCos;
  const perpY = normPerpY;

  return {
    type: 'rotate',
    // Clamped because at low zoom levels the latitude can fall outside the valid range
    position: [
      topCenter[0] + perpX * degreesOffset,
      clampLatitude(topCenter[1] + perpY * degreesOffset),
    ],
  };
}

/**
 * Collects the vertex handles of a line (a single coordinate sequence)
 *
 * Passing part includes the part number in the VertexRef (for the Multi types).
 * For single geometries part is omitted and `{ ring, index }` is returned as before.
 */
function collectLineVertexHandles(
  coords: Coordinate[],
  handles: HandleInfo[],
  part?: number,
): void {
  for (let i = 0; i < coords.length; i++) {
    handles.push({
      type: 'vertex',
      position: coords[i],
      vertexRef: part === undefined ? { ring: 0, index: i } : { part, ring: 0, index: i },
    });
  }
}

/**
 * Collects the vertex handles of a polygon (an array of rings)
 *
 * The last entry of a closed ring is a duplicate of the first one (the closing point),
 * so no handle is emitted for it.
 */
function collectPolygonVertexHandles(
  rings: Coordinate[][],
  handles: HandleInfo[],
  part?: number,
): void {
  for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
    const ring = rings[ringIndex];
    if (ring.length === 0) continue;

    // The last point is the same as the first one, so it is excluded
    const length =
      ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
        ? ring.length - 1
        : ring.length;

    for (let i = 0; i < length; i++) {
      handles.push({
        type: 'vertex',
        position: ring[i],
        vertexRef:
          part === undefined ? { ring: ringIndex, index: i } : { part, ring: ringIndex, index: i },
      });
    }
  }
}

/**
 * Builds handle information from the set of handles to display (vertex references)
 *
 * The path used while thinning. Because the positions are looked up again from a set that
 * holds no coordinates, the same set can be reused even after the vertices move. References
 * that cannot be resolved (the coordinate is gone and the like) are discarded.
 */
function buildHandlesFromRefs(
  feature: Feature,
  refs: readonly VertexRef[],
  type: 'vertex' | 'midpoint',
  resolve: (feature: Feature, ref: VertexRef) => Coordinate | null,
): HandleInfo[] {
  const handles: HandleInfo[] = [];
  for (const ref of refs) {
    const position = resolve(feature, ref);
    if (!position) continue;
    handles.push({ type, position, vertexRef: ref });
  }
  return handles;
}

/**
 * Computes the positions of the vertex handles
 *
 * For a Polygon, not only the outer ring (ring 0) but also the vertices of the inner rings
 * (holes) are covered.
 *
 * The Multi types (MultiPoint / MultiLineString / MultiPolygon) are scanned across all
 * parts and returned with the part number included in the VertexRef. For a MultiPoint each
 * coordinate is one part, so the vertex reference becomes `{ part: i, ring: 0, index: 0 }`.
 *
 * @param visibleSet The display set thinned by screen density. When passed, not all vertices
 *   are enumerated; only the vertices contained in the set are returned (when omitted, all
 *   vertices are returned as before)
 *
 * @internal
 */
export function computeVertexHandles(
  feature: Feature,
  visibleSet?: VisibleHandleSet | null,
): HandleInfo[] {
  if (visibleSet) {
    return buildHandlesFromRefs(feature, visibleSet.vertexRefs, 'vertex', resolveVertexCoordinate);
  }

  const handles: HandleInfo[] = [];

  if (feature.type === 'Point') {
    // A Point is a single vertex
    const coord = coordinatesOf(feature) as Coordinate;
    handles.push({ type: 'vertex', position: coord, vertexRef: { ring: 0, index: 0 } });
  } else if (feature.type === 'LineString') {
    collectLineVertexHandles(coordinatesOf(feature) as Coordinate[], handles);
  } else if (feature.type === 'Polygon') {
    collectPolygonVertexHandles(coordinatesOf(feature) as Coordinate[][], handles);
  } else if (feature.type === 'MultiPoint') {
    // Each coordinate is one part. ring / index are always 0
    const points = coordinatesOf(feature) as Coordinate[];
    for (let part = 0; part < points.length; part++) {
      handles.push({
        type: 'vertex',
        position: points[part],
        vertexRef: { part, ring: 0, index: 0 },
      });
    }
  } else if (feature.type === 'MultiLineString') {
    const parts = coordinatesOf(feature) as Coordinate[][];
    for (let part = 0; part < parts.length; part++) {
      collectLineVertexHandles(parts[part], handles, part);
    }
  } else if (feature.type === 'MultiPolygon') {
    const parts = coordinatesOf(feature) as Coordinate[][][];
    for (let part = 0; part < parts.length; part++) {
      collectPolygonVertexHandles(parts[part], handles, part);
    }
  }

  return handles;
}

/**
 * Computes the position of the radius handle for a Circle
 *
 * The handle is laid out with the same geodesic direct problem as the circle's outline, so it
 * sits on the outline at any latitude and radius.
 */
export function computeCircleRadiusHandle(feature: Feature): HandleInfo | null {
  if (feature.type !== 'Circle') {
    return null;
  }

  const center = coordinatesOf(feature) as Coordinate;
  const radiusMeters = getCircleRadius(feature);
  const radiusHandleAngle = getRadiusHandleAngle(feature);

  if (!radiusMeters || radiusMeters <= 0) {
    return null;
  }

  const handlePosition = destinationPoint(center, radiusMeters, radiusHandleAngle);

  return {
    type: 'radius',
    position: handlePosition,
  };
}

/**
 * Computes the position of the center marker for a Circle
 */
export function computeCircleCenterHandle(feature: Feature): HandleInfo | null {
  if (feature.type !== 'Circle') {
    return null;
  }

  const center = coordinatesOf(feature) as Coordinate;

  return {
    type: 'center',
    position: center,
  };
}

/**
 * Collects the midpoint handles of a line (a single coordinate sequence)
 */
function collectLineMidpointHandles(
  coords: Coordinate[],
  handles: HandleInfo[],
  part?: number,
): void {
  for (let i = 0; i < coords.length - 1; i++) {
    const midpoint = mercatorMidpoint(coords[i], coords[i + 1]);
    handles.push({
      type: 'midpoint',
      position: midpoint,
      vertexRef: part === undefined ? { ring: 0, index: i } : { part, ring: 0, index: i },
    });
  }
}

/**
 * Collects the midpoint handles of a polygon (an array of rings)
 */
function collectPolygonMidpointHandles(
  rings: Coordinate[][],
  handles: HandleInfo[],
  part?: number,
): void {
  for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
    const ring = rings[ringIndex];
    for (let i = 0; i < ring.length - 1; i++) {
      const midpoint = mercatorMidpoint(ring[i], ring[i + 1]);
      handles.push({
        type: 'midpoint',
        position: midpoint,
        vertexRef:
          part === undefined ? { ring: ringIndex, index: i } : { part, ring: ringIndex, index: i },
      });
    }
  }
}

/**
 * Computes the positions of the midpoint handles
 *
 * For a Polygon, not only the outer ring (ring 0) but also the edges of the inner rings
 * (holes) are covered.
 *
 * The Multi types are scanned across all parts. A MultiPoint has no edges, so no midpoint
 * handles are emitted for it (vertex handles only).
 *
 * @param visibleSet The display set thinned by screen density. When passed, not all edges
 *   are enumerated; only the edges contained in the set are returned (when omitted, all
 *   edges are returned as before)
 *
 * @internal
 */
export function computeMidpointHandles(
  feature: Feature,
  visibleSet?: VisibleHandleSet | null,
): HandleInfo[] {
  if (visibleSet) {
    return buildHandlesFromRefs(
      feature,
      visibleSet.midpointRefs,
      'midpoint',
      resolveMidpointCoordinate,
    );
  }

  const handles: HandleInfo[] = [];

  if (feature.type === 'LineString') {
    collectLineMidpointHandles(coordinatesOf(feature) as Coordinate[], handles);
  } else if (feature.type === 'Polygon') {
    collectPolygonMidpointHandles(coordinatesOf(feature) as Coordinate[][], handles);
  } else if (feature.type === 'MultiLineString') {
    const parts = coordinatesOf(feature) as Coordinate[][];
    for (let part = 0; part < parts.length; part++) {
      collectLineMidpointHandles(parts[part], handles, part);
    }
  } else if (feature.type === 'MultiPolygon') {
    const parts = coordinatesOf(feature) as Coordinate[][][];
    for (let part = 0; part < parts.length; part++) {
      collectPolygonMidpointHandles(parts[part], handles, part);
    }
  }

  return handles;
}

/**
 * SelectionHandlesRenderer
 *
 * The renderer that draws the selection handles
 *
 * @internal
 */
export class SelectionHandlesRenderer {
  private strokeRenderer: StrokeRenderer;
  private pointRenderer: PointShapeRenderer;
  private config: SelectionUIConfig;
  private transform: CoordinateTransform | null = null;
  private projectionData: ProjectionData | null = null;
  private pointInstanceRenderer: PointInstanceRenderer | null = null;

  constructor(
    strokeRenderer: StrokeRenderer,
    pointRenderer: PointShapeRenderer,
    config: SelectionUIConfig,
  ) {
    this.strokeRenderer = strokeRenderer;
    this.pointRenderer = pointRenderer;
    this.config = config;
  }

  /**
   * Sets the coordinate transform
   */
  setTransform(transform: CoordinateTransform): void {
    this.transform = transform;
  }

  /**
   * Sets the ProjectionData
   */
  setProjectionData(projectionData: ProjectionData): void {
    this.projectionData = projectionData;
  }

  /**
   * Sets the PointInstanceRenderer
   */
  setPointInstanceRenderer(renderer: PointInstanceRenderer): void {
    this.pointInstanceRenderer = renderer;
  }

  /**
   * Draws the resize handles
   * Draws them at the four corners of the bbox after the margin is applied (additional
   * handles can also be drawn)
   *
   * @param bbox Bounding box
   * @param zoom Zoom level
   * @param getAdditionalHandles Callback that computes the additional handles (it receives
   *   the bbox after the margin is applied)
   */
  drawResizeHandles(
    bbox: BoundingBoxCoords,
    zoom: number,
    getAdditionalHandles?: (marginedBbox: BoundingBoxCoords) => HandleInfo[],
  ): void {
    // Compute the bbox with the margin applied
    let marginedBbox = bbox;
    if (this.transform) {
      const margin = this.config.boundingBox.margin;
      marginedBbox = {
        ...applyMarginToBoundingBox(bbox, margin, this.transform, zoom),
        center: bbox.center,
      };
    }

    // If a callback is given, call it with the bbox after the margin is applied
    const additionalHandles = getAdditionalHandles?.(marginedBbox);
    const handles = computeResizeHandles(marginedBbox, additionalHandles);

    // Each handle sits on the ground elevation of its own point. Hit testing (anchor
    // projection) uses the same elevation, so the drawn position and the grabbable position
    // match structurally. Putting them all at a single height to match the selection box
    // would shift only the rendering and make them ungrabbable
    for (const handle of handles) {
      this.pointRenderer.draw(handle.position, this.config.resizeHandle.point, zoom);
    }
  }

  /**
   * Draws the rotate handle
   * Draws it at a position offset upward from the midpoint of the top edge of the bbox
   * after the margin is applied
   */
  drawRotateHandle(bbox: BoundingBoxCoords, zoom: number): void {
    // Compute the bbox with the margin applied
    let marginedBbox = bbox;
    if (this.transform) {
      const margin = this.config.boundingBox.margin;
      marginedBbox = {
        ...applyMarginToBoundingBox(bbox, margin, this.transform, zoom),
        center: bbox.center,
      };
    }

    const handle = computeRotateHandle(marginedBbox, this.config.rotateHandle.distance, zoom);

    // Draw the connector line (from the midpoint of the top edge after the margin is applied)
    const topCenter = mercatorMidpoint(marginedBbox.topLeft, marginedBbox.topRight);
    this.strokeRenderer.draw(
      [topCenter, handle.position],
      this.config.rotateHandle.connector,
      // The connector line follows the ground as well (same elevation source as the box
      // and the handles)
      { widthUnit: 'pixels', closed: false, followTerrain: true },
      zoom,
      this.projectionData ?? undefined,
    );

    // Draw the handle (put on the ground elevation of each point so that it matches the
    // grabbable position)
    this.pointRenderer.draw(handle.position, this.config.rotateHandle.point, zoom);
  }

  /**
   * Draws the vertex handles
   * @param feature Target feature
   * @param zoom Zoom level
   * @param options Options
   *   - activeVertex: when specified, only that vertex and the selected vertices are drawn
   *   - selectedVertices: references of the selected vertices (for highlighting)
   *   - visibleSet: the display set thinned by screen density (when omitted, all vertices)
   */
  drawVertexHandles(
    feature: Feature,
    zoom: number,
    options?: {
      activeVertex?: VertexRef;
      selectedVertices?: VertexRef[];
      visibleSet?: VisibleHandleSet | null;
    },
  ): void {
    const activeVertex = options?.activeVertex;
    const selectedVertices = options?.selectedVertices ?? [];

    // Even while thinning, the selected and the in-operation vertices are always drawn
    // (if a recomputation hid such a vertex it would look like "it disappeared even though
    // I selected it")
    const visibleSet = options?.visibleSet
      ? includeRequiredVertexRefs(
          options.visibleSet,
          activeVertex ? [...selectedVertices, activeVertex] : selectedVertices,
        )
      : options?.visibleSet;

    const handles = computeVertexHandles(feature, visibleSet);

    // Draw individually when activeVertex is specified or when instancing is unavailable
    if (activeVertex !== undefined || !this.pointInstanceRenderer || handles.length < 2) {
      for (const handle of handles) {
        const isSelected = hasVertexRef(selectedVertices, handle.vertexRef!);
        // When activeVertex is specified, draw only that vertex and the selected vertices
        if (activeVertex !== undefined) {
          const isActive = isSameVertexRef(handle.vertexRef!, activeVertex);
          if (!isActive && !isSelected) {
            continue;
          }
        }
        const style = isSelected
          ? this.config.vertexHandle.selected
          : this.config.vertexHandle.point;
        this.pointRenderer.draw(handle.position, style, zoom);
      }
      return;
    }

    // Separate the unselected vertices from the selected ones
    const normalHandles = handles.filter((h) => !hasVertexRef(selectedVertices, h.vertexRef!));
    const selectedHandles = handles.filter((h) => hasVertexRef(selectedVertices, h.vertexRef!));

    // Draw the normal vertices
    if (normalHandles.length > 0) {
      const style = this.config.vertexHandle.point;
      const points: PointInstanceDataFull[] = normalHandles.map((h) => ({
        coord: h.position,
        fillColor: [
          style.fillColor[0],
          style.fillColor[1],
          style.fillColor[2],
          style.fillColor[3] * style.fillOpacity,
        ],
        fillSize: style.size / 2, // diameter -> radius
        strokeColor: [
          style.strokeColor[0],
          style.strokeColor[1],
          style.strokeColor[2],
          style.strokeColor[3] * style.strokeOpacity,
        ],
        strokeWidth: style.strokeWidth,
      }));

      this.pointInstanceRenderer.drawAll(points, 'circle', zoom);
    }

    // Draw the selected vertices (highlight style)
    if (selectedHandles.length > 0) {
      const style = this.config.vertexHandle.selected;
      const points: PointInstanceDataFull[] = selectedHandles.map((h) => ({
        coord: h.position,
        fillColor: [
          style.fillColor[0],
          style.fillColor[1],
          style.fillColor[2],
          style.fillColor[3] * style.fillOpacity,
        ],
        fillSize: style.size / 2, // diameter -> radius
        strokeColor: [
          style.strokeColor[0],
          style.strokeColor[1],
          style.strokeColor[2],
          style.strokeColor[3] * style.strokeOpacity,
        ],
        strokeWidth: style.strokeWidth,
      }));

      this.pointInstanceRenderer.drawAll(points, 'circle', zoom);
    }
  }

  /**
   * Draws the vertices that follow along when shared vertices are moved together
   *
   * The target is another feature that is not necessarily selected, so this has an entry
   * point independent of the selection UI (drawAllHandles). Only the passed vertex
   * references are drawn in the following style; no other vertices are drawn.
   *
   * computeVertexHandles emits no handle for the closing point (the last entry) of a closed
   * ring, so even when it is included in the references only one handle is drawn, as the
   * first vertex.
   */
  drawFollowedVertexHandles(feature: Feature, followedVertices: VertexRef[], zoom: number): void {
    if (followedVertices.length === 0) return;

    const handles = computeVertexHandles(feature).filter((h) =>
      hasVertexRef(followedVertices, h.vertexRef!),
    );
    this.drawHandlesWithStyle(handles, this.config.vertexHandle.followed, zoom);
  }

  /**
   * Draws the auxiliary handles of the extensions with the look of the vertex handles, the
   * size their hit test uses
   */
  drawAuxiliaryHandles(positions: readonly Coordinate[], zoom: number): void {
    this.drawHandlesWithStyle(
      positions.map((position) => ({ position })),
      this.config.vertexHandle.point,
      zoom,
    );
  }

  /**
   * Draws a group of handles with a single style
   *
   * When there are two or more of them and instancing is available, they are drawn together.
   */
  private drawHandlesWithStyle(
    handles: ReadonlyArray<Pick<HandleInfo, 'position'>>,
    style: PointStyle,
    zoom: number,
  ): void {
    if (handles.length === 0) return;

    if (!this.pointInstanceRenderer || handles.length < 2) {
      for (const handle of handles) {
        this.pointRenderer.draw(handle.position, style, zoom);
      }
      return;
    }

    const points: PointInstanceDataFull[] = handles.map((h) => ({
      coord: h.position,
      fillColor: [
        style.fillColor[0],
        style.fillColor[1],
        style.fillColor[2],
        style.fillColor[3] * style.fillOpacity,
      ],
      fillSize: style.size / 2, // diameter -> radius
      strokeColor: [
        style.strokeColor[0],
        style.strokeColor[1],
        style.strokeColor[2],
        style.strokeColor[3] * style.strokeOpacity,
      ],
      strokeWidth: style.strokeWidth,
    }));

    this.pointInstanceRenderer.drawAll(points, 'circle', zoom);
  }

  /**
   * Draws the midpoint handles
   *
   * @param visibleSet The display set thinned by screen density (when omitted, all edges)
   */
  drawMidpointHandles(feature: Feature, zoom: number, visibleSet?: VisibleHandleSet | null): void {
    const handles = computeMidpointHandles(feature, visibleSet);

    // Draw individually when instancing is unavailable
    if (!this.pointInstanceRenderer || handles.length < 2) {
      for (const handle of handles) {
        this.pointRenderer.draw(handle.position, this.config.midpointHandle.point, zoom);
      }
      return;
    }

    // Use instanced rendering
    const style = this.config.midpointHandle.point;
    const points: PointInstanceDataFull[] = handles.map((h) => ({
      coord: h.position,
      fillColor: [
        style.fillColor[0],
        style.fillColor[1],
        style.fillColor[2],
        style.fillColor[3] * style.fillOpacity,
      ],
      fillSize: style.size / 2, // diameter -> radius
      strokeColor: [
        style.strokeColor[0],
        style.strokeColor[1],
        style.strokeColor[2],
        style.strokeColor[3] * style.strokeOpacity,
      ],
      strokeWidth: style.strokeWidth,
    }));

    this.pointInstanceRenderer.drawAll(points, 'circle', zoom);
  }

  /**
   * Draws all handles
   */
  drawAllHandles(
    feature: Feature,
    bbox: BoundingBoxCoords,
    options: {
      showResize: boolean;
      showRotate: boolean;
      showVertex: boolean;
      showMidpoint: boolean;
      /** When specified, only that vertex is drawn (used while editing a vertex/midpoint) */
      activeVertex?: VertexRef;
      /** References of the selected vertices (for highlighting) */
      selectedVertices?: VertexRef[];
      /**
       * Callback that computes the additional resize handles (it receives the bbox after
       * the margin is applied)
       */
      getAdditionalResizeHandles?: (marginedBbox: BoundingBoxCoords) => HandleInfo[];
      /** The display set thinned by screen density (when omitted, all handles) */
      visibleSet?: VisibleHandleSet | null;
    },
    zoom: number,
  ): void {
    if (options.showResize) {
      this.drawResizeHandles(bbox, zoom, options.getAdditionalResizeHandles);
    }
    if (options.showRotate) {
      this.drawRotateHandle(bbox, zoom);
    }
    if (options.showVertex) {
      this.drawVertexHandles(feature, zoom, {
        activeVertex: options.activeVertex,
        selectedVertices: options.selectedVertices,
        visibleSet: options.visibleSet,
      });
    }
    if (options.showMidpoint) {
      this.drawMidpointHandles(feature, zoom, options.visibleSet);
    }
  }

  /**
   * Draws the radius handle for a Circle
   */
  drawCircleRadiusHandle(feature: Feature, zoom: number): void {
    const handle = computeCircleRadiusHandle(feature);
    if (!handle) return;

    this.pointRenderer.draw(handle.position, this.config.radiusHandle.point, zoom);
  }

  /**
   * Draws the center marker for a Circle
   */
  drawCircleCenterMarker(feature: Feature, zoom: number): void {
    const handle = computeCircleCenterHandle(feature);
    if (!handle) return;

    this.pointRenderer.draw(handle.position, this.config.centerMarker.point, zoom);
  }

  /**
   * Draws the radius line for a Circle (the dotted line from the center to the radius handle)
   */
  drawCircleRadiusLine(feature: Feature, zoom: number): void {
    const centerHandle = computeCircleCenterHandle(feature);
    const radiusHandle = computeCircleRadiusHandle(feature);
    if (!centerHandle || !radiusHandle) return;

    this.strokeRenderer.draw(
      [centerHandle.position, radiusHandle.position],
      this.config.radiusLine.stroke,
      { widthUnit: 'pixels', closed: false },
      zoom,
      this.projectionData ?? undefined,
    );
  }

  /**
   * Draws all selection handles for a Circle
   * (the radius handle, the center marker and the radius line)
   */
  drawCircleHandles(
    feature: Feature,
    bbox: BoundingBoxCoords,
    options: {
      showResize: boolean;
      showRadiusHandle: boolean;
      showCenterMarker: boolean;
      showRadiusLine: boolean;
    },
    zoom: number,
  ): void {
    if (options.showResize) {
      this.drawResizeHandles(bbox, zoom);
    }
    // Draw the radius line first (so that it goes under the handles)
    if (options.showRadiusLine) {
      this.drawCircleRadiusLine(feature, zoom);
    }
    if (options.showCenterMarker) {
      this.drawCircleCenterMarker(feature, zoom);
    }
    if (options.showRadiusHandle) {
      this.drawCircleRadiusHandle(feature, zoom);
    }
  }

  /**
   * Updates the configuration
   */
  updateConfig(config: SelectionUIConfig): void {
    this.config = config;
  }
}
