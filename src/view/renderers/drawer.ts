// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Feature rendering
 *
 * Manages the rendering logic for the various feature kinds
 * Draws in screen coordinates using map.project
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import type { FeatureStyleConfig } from '../../shared/config/feature-style.js';
import { generateCirclePolygon } from '../../shared/math/index.js';
import { hexToColor } from '../../shared/utils/color.js';
import { getCircleRadius, getCreatedZoom } from '../../shared/utils/property.js';
import type { Coordinate, Feature, FeatureStyle, Layer } from '../../store/types.js';
import { StyleRuleCache } from '../cache/style-rule.js';
import type { OffsetUniforms, ShaderData } from '../shaders/helpers.js';
import { applyRuleColor, type StyleRuleChannel } from '../style-rule.js';
import type { TerrainContext } from '../terrain/context.js';
import { layerDrawFactors } from './draw-factors.js';
import type { ImageRenderer } from './image.js';
import type { Color, SDFLineRenderer, SDFStrokeStyle } from './line/sdf-line.js';
import type { PointShapeRenderer, PointStyle } from './point/point-shape.js';
import { resolvePointStyle } from './point/point-style.js';
import { FillShaderManager } from './polygon/fill.js';

/**
 * The dependencies of FeatureDrawer
 *
 * @internal
 */
export interface FeatureDrawerDeps {
  gl: WebGL2RenderingContext;
  map: MapLibreMap;
  sdfLineRenderer: SDFLineRenderer;
  pointShapeRenderer: PointShapeRenderer;
  imageRenderer: ImageRenderer;
  featureStyle: FeatureStyleConfig;
  /**
   * Evaluated style rules of the draw instance, keyed by feature id (a private cache when
   * omitted). The CustomLayer passes its own so that it can invalidate it on Store changes
   */
  styleRules?: StyleRuleCache;
  /** The terrain state of the draw instance (an inactive one draws flat) */
  terrain?: TerrainContext;
}

/**
 * The feature rendering class
 *
 * @internal
 */
export class FeatureDrawer {
  private map: MapLibreMap;
  /** Evaluated style rules of the draw instance, keyed by feature id */
  private readonly styleRules: StyleRuleCache;
  private sdfLineRenderer: SDFLineRenderer;
  private pointShapeRenderer: PointShapeRenderer;
  private imageRenderer: ImageRenderer;
  private featureStyle: FeatureStyleConfig;
  private fillShaderManager: FillShaderManager;

  constructor(deps: FeatureDrawerDeps) {
    this.map = deps.map;
    this.sdfLineRenderer = deps.sdfLineRenderer;
    this.pointShapeRenderer = deps.pointShapeRenderer;
    this.imageRenderer = deps.imageRenderer;
    this.featureStyle = deps.featureStyle;
    this.styleRules = deps.styleRules ?? new StyleRuleCache();
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
   * Draw a feature
   *
   * @param layer The layer it belongs to (used to evaluate style rules, and its opacity is
   *   multiplied into the drawing; no rules and no factor when omitted)
   */
  drawFeature(feature: Feature, projectionData: ProjectionData, zoom: number, layer?: Layer): void {
    const opacity = layerDrawFactors(layer).opacity;
    if (feature.type === 'Point') {
      const coord = feature.coordinates as Coordinate;
      const pointStyle = pointWithOpacity(this.getPointStyle(feature, layer), opacity);
      this.drawPointShape(coord, pointStyle, zoom, feature.id);
    } else if (feature.type === 'LineString') {
      const coords = feature.coordinates as Coordinate[];
      const createdZoom = getCreatedZoom(feature) ?? zoom;
      const strokeStyle = strokeWithOpacity(this.getLineStringStrokeStyle(feature, layer), opacity);
      this.drawLineStringStroke(coords, strokeStyle, projectionData, zoom, createdZoom, feature.id);
    } else if (feature.type === 'Polygon') {
      const rings = feature.coordinates as Coordinate[][];
      const createdZoom = getCreatedZoom(feature) ?? zoom;
      const { fillColor, strokeStyle } = polygonWithOpacity(
        this.getPolygonStyles(feature, layer),
        opacity,
      );
      this.drawPolygonWithStroke(
        rings,
        fillColor,
        strokeStyle,
        projectionData,
        zoom,
        createdZoom,
        feature.id,
      );
    } else if (feature.type === 'MultiPoint') {
      // Draw a point for each part (the style is shared across the feature)
      const parts = feature.coordinates as Coordinate[];
      const pointStyle = pointWithOpacity(this.getPointStyle(feature, layer), opacity);
      for (const coord of parts) {
        this.drawPointShape(coord, pointStyle, zoom, feature.id);
      }
    } else if (feature.type === 'MultiLineString') {
      // Draw a line for each part
      const parts = feature.coordinates as Coordinate[][];
      const createdZoom = getCreatedZoom(feature) ?? zoom;
      const strokeStyle = strokeWithOpacity(this.getLineStringStrokeStyle(feature, layer), opacity);
      for (let i = 0; i < parts.length; i++) {
        this.drawLineStringStroke(
          parts[i],
          strokeStyle,
          projectionData,
          zoom,
          createdZoom,
          `${feature.id}:part:${i}`,
        );
      }
    } else if (feature.type === 'MultiPolygon') {
      // Draw a hole-aware polygon for each part
      const parts = feature.coordinates as Coordinate[][][];
      const createdZoom = getCreatedZoom(feature) ?? zoom;
      const { fillColor, strokeStyle } = polygonWithOpacity(
        this.getPolygonStyles(feature, layer),
        opacity,
      );
      for (let i = 0; i < parts.length; i++) {
        this.drawPolygonWithStroke(
          parts[i],
          fillColor,
          strokeStyle,
          projectionData,
          zoom,
          createdZoom,
          `${feature.id}:part:${i}`,
        );
      }
    } else if (feature.type === 'Image') {
      this.imageRenderer.draw(
        feature,
        projectionData,
        zoom,
        () => this.map.triggerRepaint(),
        opacity,
      );
    } else if (feature.type === 'Circle') {
      this.drawCircle(feature, projectionData, zoom, layer, opacity);
    } else if (feature.type === 'Freehand') {
      // Freehand uses the same rendering logic as LineString
      const coords = feature.coordinates as Coordinate[];
      const createdZoom = getCreatedZoom(feature) ?? zoom;
      const strokeStyle = strokeWithOpacity(this.getLineStringStrokeStyle(feature, layer), opacity);
      this.drawLineStringStroke(coords, strokeStyle, projectionData, zoom, createdZoom, feature.id);
    }
  }

  /**
   * Resolve the effective style
   *
   * The precedence is "per-feature color > the layer's style rule > the default color".
   * The result of evaluating the rules is cached by feature ID and invalidated when the
   * feature is updated and when the layer rules change (done by CustomLayer, which
   * subscribes to the Store).
   */
  private resolveStyle(
    feature: Feature | undefined,
    layer: Layer | undefined,
    channel: StyleRuleChannel,
  ): FeatureStyle | undefined {
    if (!feature) return undefined;

    const style = feature.style as FeatureStyle | undefined;
    const ruleColor = this.styleRules.resolve(feature, layer?.styleRule);
    return applyRuleColor(style, ruleColor, channel);
  }

  /**
   * Get the style of a Point (merges feature.style, the layer rules and the defaults)
   *
   * Every built-in path reads the style of a point here (instanced and immediate drawing, the
   * classification of the retained runs, the datasets), so the shape a feature
   * names (`pointShape`) wins over the default of the instance on all of them.
   *
   * @param feature The target feature
   * @param layer The layer it belongs to (used to evaluate style rules; no rules when omitted)
   */
  getPointStyle(feature: Feature | undefined, layer?: Layer): PointStyle {
    return resolvePointStyle(
      this.resolveStyle(feature, layer, 'point'),
      this.featureStyle.point.point,
    );
  }

  /**
   * Get the stroke style of a LineString
   *
   * @param feature The target feature
   * @param layer The layer it belongs to (used to evaluate style rules; no rules when omitted)
   */
  getLineStringStrokeStyle(feature: Feature | undefined, layer?: Layer): SDFStrokeStyle {
    const defaultStyle = this.featureStyle.lineString.stroke;
    const style = this.resolveStyle(feature, layer, 'stroke');

    if (!style) return defaultStyle;

    // Apply strokeOpacity when it is specified, even if strokeColor is not set
    // strokeOpacity is set directly rather than multiplied into the default alpha value
    const color: Color = style.strokeColor
      ? hexToColor(style.strokeColor, style.strokeOpacity ?? 1)
      : style.strokeOpacity !== undefined
        ? [defaultStyle.color[0], defaultStyle.color[1], defaultStyle.color[2], style.strokeOpacity]
        : defaultStyle.color;

    return {
      ...defaultStyle,
      color,
      width: style.strokeWidth ?? defaultStyle.width,
      // The opacity is already folded into color, so opacity is set to 1
      opacity: 1,
      lineStyle: style.lineStyle ?? defaultStyle.lineStyle,
    };
  }

  /**
   * Get the style of a Polygon (fill + stroke)
   *
   * The color from a style rule is applied to the fill (fillColor). The outline is
   * determined by the per-feature style and the default color.
   *
   * @param feature The target feature
   * @param layer The layer it belongs to (used to evaluate style rules; no rules when omitted)
   */
  getPolygonStyles(
    feature: Feature | undefined,
    layer?: Layer,
  ): {
    fillColor: Color;
    strokeStyle: SDFStrokeStyle;
  } {
    const defaultFillColor = this.featureStyle.polygon.fill.color;
    const defaultStrokeStyle = this.featureStyle.polygon.stroke;
    const style = this.resolveStyle(feature, layer, 'fill');

    if (!style) {
      return { fillColor: defaultFillColor, strokeStyle: defaultStrokeStyle };
    }

    // Apply fillOpacity when it is specified, even if fillColor is not set
    // fillOpacity is set directly rather than multiplied into the default alpha value
    // When fillOpacity is not set, the default polygon fill alpha (from the config) is used.
    // So that a feature with only fillColor specified does not become opaque (alpha 1),
    // it follows the alpha component of the default color rather than a hardcoded 1.
    const fillColor: Color = style.fillColor
      ? hexToColor(style.fillColor, style.fillOpacity ?? defaultFillColor[3])
      : style.fillOpacity !== undefined
        ? [defaultFillColor[0], defaultFillColor[1], defaultFillColor[2], style.fillOpacity]
        : defaultFillColor;

    // Apply strokeOpacity when it is specified, even if strokeColor is not set
    // strokeOpacity is set directly rather than multiplied into the default alpha value
    const strokeColor: Color = style.strokeColor
      ? hexToColor(style.strokeColor, style.strokeOpacity ?? 1)
      : style.strokeOpacity !== undefined
        ? [
            defaultStrokeStyle.color[0],
            defaultStrokeStyle.color[1],
            defaultStrokeStyle.color[2],
            style.strokeOpacity,
          ]
        : defaultStrokeStyle.color;

    const strokeStyle: SDFStrokeStyle = {
      ...defaultStrokeStyle,
      color: strokeColor,
      width: style.strokeWidth ?? defaultStrokeStyle.width,
      // The opacity is already folded into color, so opacity is set to 1
      opacity: 1,
      lineStyle: style.lineStyle ?? defaultStrokeStyle.lineStyle,
    };

    return { fillColor, strokeStyle };
  }

  /**
   * Draw a Point shape
   */
  drawPointShape(coord: Coordinate, style: PointStyle, zoom: number, featureId?: string): void {
    this.pointShapeRenderer.draw(coord, style, zoom, featureId);
  }

  /**
   * Draw the stroke of a LineString (computed on the GPU)
   */
  private drawLineStringStroke(
    coords: Coordinate[],
    style: SDFStrokeStyle,
    projectionData: ProjectionData,
    zoom: number,
    createdZoom: number,
    featureId?: string,
  ): void {
    if (coords.length < 2) return;

    // Compute widthPixels = style.width * 2^(zoom - createdZoom) on the GPU
    this.sdfLineRenderer.draw(
      coords as [number, number][],
      style,
      { widthUnit: 'pixels', closed: false, featureId, createdZoom },
      zoom,
      projectionData,
    );
  }

  /**
   * Draw a Polygon with a fill and a stroke
   */
  private drawPolygonWithStroke(
    rings: Coordinate[][],
    fillColor: [number, number, number, number],
    strokeStyle: SDFStrokeStyle,
    projectionData: ProjectionData,
    zoom: number,
    createdZoom: number,
    featureId?: string,
  ): void {
    if (rings.length === 0) return;

    const outerRing = rings[0];
    if (outerRing.length < 3) return;

    // Fill (inner rings are punched out as holes)
    if (fillColor[3] > 0) {
      this.fillShaderManager.drawPolygonRings(rings, fillColor, projectionData, zoom);
    }

    // Stroke (computed on the GPU): the outer ring and each inner ring are drawn as closed paths
    if (strokeStyle.opacity > 0) {
      for (let i = 0; i < rings.length; i++) {
        const ring = rings[i];
        if (ring.length < 3) continue;

        this.sdfLineRenderer.drawClosed(
          ring as [number, number][],
          strokeStyle,
          {
            widthUnit: 'pixels',
            featureId: featureId ? `${featureId}:stroke:${i}` : undefined,
            createdZoom,
          },
          zoom,
          projectionData,
        );
      }
    }
  }

  /**
   * Draw a Circle
   */
  private drawCircle(
    feature: Feature,
    projectionData: ProjectionData,
    zoom: number,
    layer?: Layer,
    opacity = 1,
  ): void {
    const center = feature.coordinates as Coordinate;
    const radiusMeters = getCircleRadius(feature);

    if (!radiusMeters || radiusMeters <= 0) return;

    const createdZoom = getCreatedZoom(feature) ?? zoom;
    const { fillColor, strokeStyle } = polygonWithOpacity(
      this.getPolygonStyles(feature, layer),
      opacity,
    );

    // Convert the circle into a polygon
    const circleCoords = generateCirclePolygon(center, radiusMeters);

    // Fill
    if (fillColor[3] > 0) {
      this.fillShaderManager.drawPolygon(circleCoords, fillColor, projectionData, zoom);
    }

    // Stroke
    if (strokeStyle.opacity > 0) {
      this.sdfLineRenderer.drawClosed(
        circleCoords as [number, number][],
        strokeStyle,
        {
          widthUnit: 'pixels',
          featureId: feature.id ? `${feature.id}:stroke` : undefined,
          createdZoom,
        },
        zoom,
        projectionData,
      );
    }
  }

  /**
   * Release the resources
   */
  dispose(): void {
    this.fillShaderManager.dispose();
  }
}

/** A point style with an opacity factor multiplied in (the same object at 1) */
function pointWithOpacity(style: PointStyle, opacity: number): PointStyle {
  if (opacity === 1) return style;
  return {
    ...style,
    fillOpacity: style.fillOpacity * opacity,
    strokeOpacity: style.strokeOpacity * opacity,
  };
}

/** A stroke style with an opacity factor multiplied in (the same object at 1) */
function strokeWithOpacity(style: SDFStrokeStyle, opacity: number): SDFStrokeStyle {
  return opacity === 1 ? style : { ...style, opacity: style.opacity * opacity };
}

/** Polygon styles with an opacity factor multiplied into the fill and the outline */
function polygonWithOpacity(
  styles: { fillColor: Color; strokeStyle: SDFStrokeStyle },
  opacity: number,
): { fillColor: Color; strokeStyle: SDFStrokeStyle } {
  if (opacity === 1) return styles;
  const { fillColor, strokeStyle } = styles;
  return {
    fillColor: [fillColor[0], fillColor[1], fillColor[2], fillColor[3] * opacity],
    strokeStyle: strokeWithOpacity(strokeStyle, opacity),
  };
}
