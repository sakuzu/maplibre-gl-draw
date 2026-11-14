// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tentative rendering
 *
 * Draws the tentative state while drawing (Tentative)
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { destinationPoint } from '../../geometry/distance.js';
import { applyPreviewStyle } from '../../shared/config/apply-style.js';
import type { TentativeStyle } from '../../shared/config/feature-style.js';
import { generateCirclePolygon } from '../../shared/math/index.js';
import type { FeatureStyle } from '../../shared/types/model.js';
import type { Color } from '../../shared/types/style.js';
import type { Coordinate, TentativeState } from '../../store/types.js';
import type { GpuLedger } from '../gpu-ledger.js';
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
  /** Where the GPU memory of the fills is recorded */
  ledger: GpuLedger;
}

/**
 * The dotted pattern: an 8px line and a 6px gap
 */
const TENTATIVE_DASH_ARRAY: [number, number] = [8, 6];

/**
 * A shape being drawn, with the look of its own put over the look of the shapes being drawn
 * (`Sketch.previewStyle`), when it has one
 *
 * @internal
 */
export type DrawnTentative = TentativeState & {
  readonly previewStyle?: Readonly<Partial<FeatureStyle>>;
};

/** The look a shape being drawn is drawn with */
interface Look {
  /** The style of confirmed lines (solid) */
  readonly stroke: SDFStrokeStyle;
  /** The style of unconfirmed lines (dotted) */
  readonly tentativeStroke: SDFStrokeStyle;
  readonly vertex: PointStyle;
  /** The style of a highlighted vertex */
  readonly highlightedVertex: PointStyle;
  /** For Circle: the style of the center marker */
  readonly circleCenterMarker: PointStyle;
  /** For Circle: the style of the radius change handle */
  readonly circleRadiusHandle: PointStyle;
  /** The fill of a polygon and of a circle */
  readonly fill: Color;
}

/** The look of a configuration of the shapes being drawn */
function lookOf(style: TentativeStyle): Look {
  return {
    stroke: style.stroke,
    // The style of unconfirmed lines (the dotted pattern is set to match the specification)
    tentativeStroke: { ...style.tentativeStroke, dashArray: TENTATIVE_DASH_ARRAY },
    vertex: style.vertex,
    highlightedVertex: style.highlightedVertex,
    circleCenterMarker: style.circleCenterMarker,
    circleRadiusHandle: style.circleRadiusHandle,
    fill: style.fill.color,
  };
}

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
  /** The look of the shapes being drawn, from the configuration */
  private tentativeStyle: TentativeStyle;
  /** The look of a shape being drawn without a look of its own */
  private look: Look;
  /**
   * The looks of the shapes being drawn with a look of their own, by that look (the renderers are
   * built again when the configuration changes, and this with them)
   */
  private looks = new WeakMap<Readonly<Partial<FeatureStyle>>, Look>();
  private fillShaderManager: FillShaderManager;

  constructor(deps: TentativeRendererDeps) {
    this.sdfLineRenderer = deps.sdfLineRenderer;
    this.pointShapeRenderer = deps.pointShapeRenderer;
    this.tentativeStyle = deps.tentativeStyle;
    this.look = lookOf(deps.tentativeStyle);
    this.fillShaderManager = new FillShaderManager(deps.gl, deps.ledger, deps.terrain);
  }

  /**
   * The look of a shape being drawn: the look of the configuration, with the look of its own put
   * over it
   */
  private lookOf(tentative: DrawnTentative): Look {
    const own = tentative.previewStyle;
    if (own === undefined) return this.look;
    let look = this.looks.get(own);
    if (!look) {
      const style = structuredClone(this.tentativeStyle);
      applyPreviewStyle(style, own);
      look = lookOf(style);
      this.looks.set(own, look);
    }
    return look;
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
  drawGeometry(tentative: DrawnTentative, projectionData: ProjectionData, zoom: number): void {
    if (tentative.type === 'Point') {
      // A Point is only vertices, so nothing is drawn for the geometry
      return;
    }
    const look = this.lookOf(tentative);
    if (tentative.type === 'LineString') {
      this.drawLineStringGeometry(tentative, look, projectionData, zoom);
    } else if (tentative.type === 'Polygon') {
      this.drawPolygonGeometry(tentative, look, projectionData, zoom);
    } else if (tentative.type === 'Circle') {
      this.drawCircleGeometry(tentative, look, projectionData, zoom);
    } else if (tentative.type === 'Freehand') {
      this.drawFreehandGeometry(tentative, look, projectionData, zoom);
    }
  }

  /**
   * Draw only the vertices of the Tentative
   *
   * Called after the selection UI so that they are shown in the foreground.
   */
  drawVertices(tentative: DrawnTentative): void {
    const look = this.lookOf(tentative);
    if (tentative.type === 'Point') {
      const coord = tentative.coordinates as Coordinate;
      this.drawPointShape(coord, look.vertex);
    } else if (tentative.type === 'LineString') {
      this.drawLineStringVertices(tentative, look);
    } else if (tentative.type === 'Polygon') {
      this.drawPolygonVertices(tentative, look);
    } else if (tentative.type === 'Circle') {
      this.drawCircleVertices(tentative, look);
    } else if (tentative.type === 'Freehand') {
      // Freehand is lines only and does not draw vertices (the existing behavior is kept)
    }
  }

  /**
   * Draw a Point shape
   */
  private drawPointShape(coord: Coordinate, style: PointStyle): void {
    this.pointShapeRenderer.draw(coord, style);
  }

  /**
   * Tentative rendering of a LineString (lines only, no vertices)
   */
  private drawLineStringGeometry(
    tentative: TentativeState,
    look: Look,
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
        look.stroke,
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
        look.tentativeStroke,
        { widthUnit: 'pixels', closed: false },
        zoom,
        projectionData,
      );
    }
  }

  /**
   * Tentative rendering of the vertices of a LineString
   */
  private drawLineStringVertices(tentative: TentativeState, look: Look): void {
    const coords = tentative.coordinates as Coordinate[];
    const highlightedIndex = tentative.highlightedVertexIndex;

    // Draw the vertices (the highlighted one has a different style)
    for (let i = 0; i < coords.length; i++) {
      const style = i === highlightedIndex ? look.highlightedVertex : look.vertex;
      this.drawPointShape(coords[i], style);
    }
  }

  /**
   * Tentative rendering of a Polygon (lines and fill only, no vertices)
   */
  private drawPolygonGeometry(
    tentative: TentativeState,
    look: Look,
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
      this.fillShaderManager.drawPolygon(outerRing, look.fill, projectionData);
    }

    // Draw solid lines between the confirmed vertices (when there are 2 or more of them)
    if (confirmedCount >= 2) {
      const confirmedCoords = outerRing.slice(0, confirmedCount) as [number, number][];
      this.sdfLineRenderer.draw(
        confirmedCoords,
        look.stroke,
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
        look.tentativeStroke,
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
        look.tentativeStroke,
        { widthUnit: 'pixels', closed: false },
        zoom,
        projectionData,
      );
    }
  }

  /**
   * Tentative rendering of the vertices of a Polygon
   */
  private drawPolygonVertices(tentative: TentativeState, look: Look): void {
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
      const style = i === highlightedIndex ? look.highlightedVertex : look.vertex;
      this.drawPointShape(outerRing[i], style);
    }
  }

  /**
   * Tentative rendering of a Circle (lines and fill only, no vertices)
   */
  private drawCircleGeometry(
    tentative: TentativeState,
    look: Look,
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
        this.fillShaderManager.drawPolygon(circleCoords, look.fill, projectionData);
      }

      // The stroke of the circle
      this.sdfLineRenderer.draw(
        circleCoords as [number, number][],
        look.stroke,
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
        look.tentativeStroke,
        { widthUnit: 'pixels', closed: false },
        zoom,
        projectionData,
      );
    }
  }

  /**
   * Tentative rendering of the vertices of a Circle
   */
  private drawCircleVertices(tentative: TentativeState, look: Look): void {
    const center = tentative.coordinates as Coordinate;
    const radiusMeters = tentative.radiusMeters ?? 0;
    const radiusHandleAngle = tentative.radiusHandleAngle ?? 135;

    if (radiusMeters > 0) {
      // Compute the position of the radius change handle (on the geodesic outline)
      const handlePosition = destinationPoint(center, radiusMeters, radiusHandleAngle);

      // Draw the center marker (shown below the radius change handle)
      this.drawPointShape(center, look.circleCenterMarker);

      // Draw the radius change handle (shown above the center marker)
      this.drawPointShape(handlePosition, look.circleRadiusHandle);
    } else {
      // When the radius is 0, only the radius change handle is shown at the center position
      this.drawPointShape(center, look.circleCenterMarker);
      this.drawPointShape(center, look.circleRadiusHandle);
    }
  }

  /**
   * Tentative rendering of a Freehand (lines only)
   *
   * Freehand does not draw vertices, so geometry and tentative are the same
   */
  private drawFreehandGeometry(
    tentative: TentativeState,
    look: Look,
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
      look.stroke,
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
