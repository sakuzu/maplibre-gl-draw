// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Drawing: the renderers of custom feature types and overlays, the values they draw with,
 * and the shared renderers they can draw through
 */

import type { Position } from 'geojson';
import type { Map as MaplibreMap, ProjectionData } from 'maplibre-gl';
import type { Feature, LineStyle, PointShape } from '../model.js';
import type { TerrainAnchors } from './context.js';

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

/**
 * The shared renderer of lines. It only draws; the zoom, the projection and the terrain come
 * from the {@link RenderContext} it was taken from.
 */
// TODO(api-2): confirm the methods and their parameters (a subset of the previous line renderer, with CSS colors)
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
  draw(
    coordinates: readonly Position[],
    style: {
      width: number;
      color: string;
      opacity: number;
      lineStyle: LineStyle;
      dashArray?: number[];
    },
    options?: { closed?: boolean; widthUnit?: 'pixels' | 'meters'; createdZoom?: number },
  ): void;
}

/**
 * The shared renderer of areas. It only draws; the zoom, the projection and the terrain come
 * from the {@link RenderContext} it was taken from.
 */
// TODO(api-2): confirm the methods and their parameters (a subset of the previous fill renderer, with CSS colors)
export interface FillRenderer {
  /**
   * Fills an area.
   *
   * @param rings - The outer ring first, then the holes
   * @param color - The CSS color
   * @param opacity - The opacity from 0 to 1; 1 when it is left out
   */
  drawPolygon(rings: readonly (readonly Position[])[], color: string, opacity?: number): void;
}

/**
 * The shared renderer of point markers. It only draws; the zoom, the projection and the
 * terrain come from the {@link RenderContext} it was taken from.
 */
// TODO(api-2): confirm the methods and their parameters (a subset of the previous point renderer, with CSS colors)
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
  draw(
    position: Position,
    style: {
      shape: PointShape;
      size: number;
      fillColor: string;
      fillOpacity: number;
      strokeColor: string;
      strokeWidth: number;
      strokeOpacity: number;
    },
    options?: { elevationMeters?: number },
  ): void;
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
  // TODO(api-2): confirm the type of projection (the projection data of the map)
  readonly projection: ProjectionData;
  /** The zoom of the frame */
  readonly zoom: number;
  /** The pixel ratio of the drawing */
  readonly pixelRatio: number;
  /** The opacity of the layer being drawn, from 0 to 1 */
  readonly opacity: number;
  /** The positions and the heights on the terrain */
  readonly terrain: TerrainAnchors;
  /** The shared renderer of lines */
  readonly line: LineRenderer;
  /** The shared renderer of areas */
  readonly fill: FillRenderer;
  /** The shared renderer of point markers */
  readonly point: PointRenderer;
}

/**
 * How the features of a custom type are drawn. The methods take their arguments in the order
 * of a custom layer of the map.
 */
export interface FeatureRenderer {
  /** Called when the renderer is added to the map; create the programs and buffers here. */
  onAdd(map: MaplibreMap, gl: WebGL2RenderingContext): void;
  /** Draws one feature. */
  draw(feature: Feature, ctx: RenderContext): void;
  /** Called when the renderer is removed; release what `onAdd` created. */
  onRemove(map: MaplibreMap, gl: WebGL2RenderingContext): void;
}

/**
 * A renderer that draws above the features, or between the layers.
 */
export interface OverlayRenderer {
  /** The name it is registered under */
  readonly name: string;
  /** Called when the renderer is added to the map; create the programs and buffers here. */
  onAdd(map: MaplibreMap, gl: WebGL2RenderingContext): void;
  /** Draws above every layer. */
  draw(ctx: RenderContext): void;
  /** Draws just above one layer, for an overlay drawn between the layers. */
  drawForLayer?(layerId: string, ctx: RenderContext): void;
  /** Whether some of its drawing has not finished yet. */
  hasPendingWork?(): boolean;
  /** Called when the renderer is removed; release what `onAdd` created. */
  onRemove(map: MaplibreMap, gl: WebGL2RenderingContext): void;
}
