// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tentative rendering
 *
 * Draws the tentative state while drawing (Tentative)
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { destinationPoint } from '../../geometry/index.js';
import type { TentativeStyle } from '../../shared/config/feature-style.js';
import { generateCirclePolygon } from '../../shared/math/index.js';
import type { Coordinate, TentativeState } from '../../store/types.js';
import type { SDFLineRenderer, SDFStrokeStyle } from '../renderers/line/sdf-line.js';
import type { PointShapeRenderer, PointStyle } from '../renderers/point/point-shape.js';
import { FillShaderManager } from '../renderers/polygon/fill.js';
import type { OffsetUniforms, ShaderData } from '../shaders/helpers.js';
import type { TerrainContext } from '../terrain/context.js';

/**
 * The dependencies of TentativeRenderer
 *
 * @internal
 */
export interface TentativeRendererDeps {
  gl: WebGL2RenderingContext;
  map: MapLibreMap;
  sdfLineRenderer: SDFLineRenderer;
  pointShapeRenderer: PointShapeRenderer;
  tentativeStyle: TentativeStyle;
  /** The terrain state of the draw instance (an inactive one draws flat) */
  terrain?: TerrainContext;
}

/**
 * The dotted pattern: an 8px line and a 6px gap
 */
const TENTATIVE_DASH_ARRAY: [number, number] = [8, 6];

/**
 * The Tentative rendering class
 *
 * Draws the tentative state while drawing (points, lines, polygons)
 *
 * @internal
 */
export class TentativeRenderer {
  private sdfLineRenderer: SDFLineRenderer;
  private pointShapeRenderer: PointShapeRenderer;
  /** The style of confirmed lines (solid) */
  private strokeStyle: SDFStrokeStyle;
  /** The style of unconfirmed lines (dotted) */
  private tentativeStrokeStyle: SDFStrokeStyle;
  private vertexStyle: PointStyle;
  /** The style of a highlighted vertex */
  private highlightedVertexStyle: PointStyle;
  /** For Circle: the style of the center marker */
  private circleCenterMarkerStyle: PointStyle;
  /** For Circle: the style of the radius change handle */
  private circleRadiusHandleStyle: PointStyle;
  private fillColor: [number, number, number, number];
  private fillShaderManager: FillShaderManager;

  constructor(deps: TentativeRendererDeps) {
    this.sdfLineRenderer = deps.sdfLineRenderer;
    this.pointShapeRenderer = deps.pointShapeRenderer;
    this.strokeStyle = deps.tentativeStyle.stroke;
    // The style of unconfirmed lines (the dotted pattern is set to match the specification)
    this.tentativeStrokeStyle = {
      ...deps.tentativeStyle.tentativeStroke,
      dashArray: TENTATIVE_DASH_ARRAY,
    };
    this.vertexStyle = deps.tentativeStyle.vertex;
    this.highlightedVertexStyle = deps.tentativeStyle.highlightedVertex;
    this.circleCenterMarkerStyle = deps.tentativeStyle.circleCenterMarker;
    this.circleRadiusHandleStyle = deps.tentativeStyle.circleRadiusHandle;
    // The fill color for Tentative (translucent pink)
    this.fillColor = [1.0, 0.176, 0.333, 0.2];
    this.fillShaderManager = new FillShaderManager(deps.gl, deps.terrain);
  }

  /**
   * Make sure the shader exists
   */
  ensureShader(shaderData: ShaderData): void {
    this.fillShaderManager.ensureShader(shaderData);
  }

  /**
   * Set the uniforms for offset mode
   */
  setOffsetUniforms(uniforms: OffsetUniforms): void {
    this.fillShaderManager.setOffsetUniforms(uniforms);
  }

  /**
   * Draw only the lines and the fill of the Tentative (excluding the vertices)
   *
   * Used by the rendering that follows the layer order. The vertices are drawn separately
   * in the foreground by drawVertices().
   */
  drawGeometry(tentative: TentativeState, projectionData: ProjectionData, zoom: number): void {
    if (tentative.type === 'Point') {
      // A Point is only vertices, so nothing is drawn for the geometry
      return;
    } else if (tentative.type === 'LineString') {
      this.drawLineStringGeometry(tentative, projectionData, zoom);
    } else if (tentative.type === 'Polygon') {
      this.drawPolygonGeometry(tentative, projectionData, zoom);
    } else if (tentative.type === 'Circle') {
      this.drawCircleGeometry(tentative, projectionData, zoom);
    } else if (tentative.type === 'Freehand') {
      this.drawFreehandGeometry(tentative, projectionData, zoom);
    }
  }

  /**
   * Draw only the vertices of the Tentative
   *
   * Called after the selection UI so that they are shown in the foreground.
   */
  drawVertices(tentative: TentativeState, zoom: number): void {
    if (tentative.type === 'Point') {
      const coord = tentative.coordinates as Coordinate;
      this.drawPointShape(coord, this.vertexStyle, zoom);
    } else if (tentative.type === 'LineString') {
      this.drawLineStringVertices(tentative, zoom);
    } else if (tentative.type === 'Polygon') {
      this.drawPolygonVertices(tentative, zoom);
    } else if (tentative.type === 'Circle') {
      this.drawCircleVertices(tentative, zoom);
    } else if (tentative.type === 'Freehand') {
      // Freehand is lines only and does not draw vertices (the existing behavior is kept)
    }
  }

  /**
   * Draw a Point shape
   */
  private drawPointShape(coord: Coordinate, style: PointStyle, zoom: number): void {
    this.pointShapeRenderer.draw(coord, style, zoom);
  }

  /**
   * Tentative rendering of a LineString (lines only, no vertices)
   */
  private drawLineStringGeometry(
    tentative: TentativeState,
    projectionData: ProjectionData,
    zoom: number,
  ): void {
    const coords = tentative.coordinates as Coordinate[];
    const confirmedCount = tentative.confirmedCount ?? coords.length;

    // Draw solid lines between the confirmed vertices
    if (confirmedCount >= 2) {
      const confirmedCoords = coords.slice(0, confirmedCount) as [number, number][];
      this.sdfLineRenderer.draw(
        confirmedCoords,
        this.strokeStyle,
        { widthUnit: 'pixels', closed: false },
        zoom,
        projectionData,
      );
    }

    // Draw a dotted line from the last confirmed vertex to the cursor position (GPU implementation)
    if (confirmedCount >= 1 && coords.length > confirmedCount) {
      const tentativeCoords: [number, number][] = [
        coords[confirmedCount - 1] as [number, number],
        coords[coords.length - 1] as [number, number],
      ];
      this.sdfLineRenderer.draw(
        tentativeCoords,
        this.tentativeStrokeStyle,
        { widthUnit: 'pixels', closed: false },
        zoom,
        projectionData,
      );
    }
  }

  /**
   * Tentative rendering of the vertices of a LineString
   */
  private drawLineStringVertices(tentative: TentativeState, zoom: number): void {
    const coords = tentative.coordinates as Coordinate[];
    const highlightedIndex = tentative.highlightedVertexIndex;

    // Draw the vertices (the highlighted one has a different style)
    for (let i = 0; i < coords.length; i++) {
      const style = i === highlightedIndex ? this.highlightedVertexStyle : this.vertexStyle;
      this.drawPointShape(coords[i], style, zoom);
    }
  }

  /**
   * Tentative rendering of a Polygon (lines and fill only, no vertices)
   */
  private drawPolygonGeometry(
    tentative: TentativeState,
    projectionData: ProjectionData,
    zoom: number,
  ): void {
    const rings = tentative.coordinates as Coordinate[][];
    const outerRing = rings[0];

    if (!outerRing || outerRing.length < 2) {
      return;
    }

    // confirmedCount is the number of coordinates before closing (outerRing is a closed
    // ring, so the first point is appended at the end)
    const confirmedCount = tentative.confirmedCount ?? outerRing.length - 1;

    // Fill from 3 points or more (4 points or more when closed)
    if (outerRing.length >= 4) {
      this.fillShaderManager.drawPolygon(outerRing, this.fillColor, projectionData, zoom);
    }

    // Draw solid lines between the confirmed vertices (when there are 2 or more of them)
    if (confirmedCount >= 2) {
      const confirmedCoords = outerRing.slice(0, confirmedCount) as [number, number][];
      this.sdfLineRenderer.draw(
        confirmedCoords,
        this.strokeStyle,
        { widthUnit: 'pixels', closed: false },
        zoom,
        projectionData,
      );
    }

    // Draw the unconfirmed lines dotted (GPU implementation)
    // The last confirmed vertex (confirmedCount-1) -> the cursor position
    // (confirmedCount) -> the first vertex (0)
    if (confirmedCount >= 1 && outerRing.length > confirmedCount) {
      // From the last confirmed vertex to the cursor position
      const lastConfirmedToMouse: [number, number][] = [
        outerRing[confirmedCount - 1] as [number, number],
        outerRing[confirmedCount] as [number, number],
      ];
      this.sdfLineRenderer.draw(
        lastConfirmedToMouse,
        this.tentativeStrokeStyle,
        { widthUnit: 'pixels', closed: false },
        zoom,
        projectionData,
      );

      // The closing line from the cursor position to the first vertex
      const mouseToFirst: [number, number][] = [
        outerRing[confirmedCount] as [number, number],
        outerRing[0] as [number, number],
      ];
      this.sdfLineRenderer.draw(
        mouseToFirst,
        this.tentativeStrokeStyle,
        { widthUnit: 'pixels', closed: false },
        zoom,
        projectionData,
      );
    }
  }

  /**
   * Tentative rendering of the vertices of a Polygon
   */
  private drawPolygonVertices(tentative: TentativeState, zoom: number): void {
    const rings = tentative.coordinates as Coordinate[][];
    const outerRing = rings[0];

    if (!outerRing || outerRing.length < 1) {
      return;
    }

    // Draw the vertices (the closing point duplicates the first vertex, so it is excluded;
    // the highlighted one has a different style)
    const uniqueVertexCount = outerRing.length > 1 ? outerRing.length - 1 : outerRing.length;
    const highlightedIndex = tentative.highlightedVertexIndex;
    for (let i = 0; i < uniqueVertexCount; i++) {
      const style = i === highlightedIndex ? this.highlightedVertexStyle : this.vertexStyle;
      this.drawPointShape(outerRing[i], style, zoom);
    }
  }

  /**
   * Tentative rendering of a Circle (lines and fill only, no vertices)
   */
  private drawCircleGeometry(
    tentative: TentativeState,
    projectionData: ProjectionData,
    zoom: number,
  ): void {
    const center = tentative.coordinates as Coordinate;
    const radiusMeters = tentative.radiusMeters ?? 0;
    const radiusHandleAngle = tentative.radiusHandleAngle ?? 135;

    // The circle and the radius line are drawn only when the radius is greater than 0
    if (radiusMeters > 0) {
      // The preview of the circle (the fill)
      const circleCoords = generateCirclePolygon(center, radiusMeters);
      if (circleCoords.length >= 4) {
        this.fillShaderManager.drawPolygon(circleCoords, this.fillColor, projectionData, zoom);
      }

      // The stroke of the circle
      this.sdfLineRenderer.draw(
        circleCoords as [number, number][],
        this.strokeStyle,
        { widthUnit: 'pixels', closed: true },
        zoom,
        projectionData,
      );

      // Compute the position of the radius change handle (on the geodesic outline)
      const handlePosition = destinationPoint(center, radiusMeters, radiusHandleAngle);

      // Draw the radius line (dotted) (GPU implementation)
      const radiusLine: [number, number][] = [
        center as [number, number],
        handlePosition as [number, number],
      ];
      this.sdfLineRenderer.draw(
        radiusLine,
        this.tentativeStrokeStyle,
        { widthUnit: 'pixels', closed: false },
        zoom,
        projectionData,
      );
    }
  }

  /**
   * Tentative rendering of the vertices of a Circle
   */
  private drawCircleVertices(tentative: TentativeState, zoom: number): void {
    const center = tentative.coordinates as Coordinate;
    const radiusMeters = tentative.radiusMeters ?? 0;
    const radiusHandleAngle = tentative.radiusHandleAngle ?? 135;

    if (radiusMeters > 0) {
      // Compute the position of the radius change handle (on the geodesic outline)
      const handlePosition = destinationPoint(center, radiusMeters, radiusHandleAngle);

      // Draw the center marker (shown below the radius change handle)
      this.drawPointShape(center, this.circleCenterMarkerStyle, zoom);

      // Draw the radius change handle (shown above the center marker)
      this.drawPointShape(handlePosition, this.circleRadiusHandleStyle, zoom);
    } else {
      // When the radius is 0, only the radius change handle is shown at the center position
      this.drawPointShape(center, this.circleCenterMarkerStyle, zoom);
      this.drawPointShape(center, this.circleRadiusHandleStyle, zoom);
    }
  }

  /**
   * Tentative rendering of a Freehand (lines only)
   *
   * Freehand does not draw vertices, so geometry and tentative are the same
   */
  private drawFreehandGeometry(
    tentative: TentativeState,
    projectionData: ProjectionData,
    zoom: number,
  ): void {
    const coords = tentative.coordinates as Coordinate[];

    if (coords.length < 2) {
      return;
    }

    // Draw the line
    this.sdfLineRenderer.draw(
      coords as [number, number][],
      this.strokeStyle,
      { widthUnit: 'pixels', closed: false },
      zoom,
      projectionData,
    );
  }

  /**
   * Release the resources
   */
  dispose(): void {
    this.fillShaderManager.dispose();
  }
}
