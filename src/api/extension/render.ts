// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Drawing: the renderers of custom feature types and overlays, the values they draw with,
 * and the shared renderers they can draw through
 */

import type { Position } from 'geojson';
import type { Map as MaplibreMap, ProjectionData } from 'maplibre-gl';
import type { RowSpriteSource } from '../../view/renderers/rows/rows-format.js';
import type { Feature, LineStyle, PointShape } from '../model.js';
import type { LayerTableView } from '../tables.js';
import type { TerrainSurface } from './context.js';

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
 * precision of 32-bit floats near the camera at every zoom, on Web Mercator, on the globe and in
 * the transition between.
 */
export interface OffsetUniforms {
  /** The center, rounded to 32-bit floats for the shader (what the offsets are taken from) */
  centerLngLat: [number, number];
  /** The center at 64-bit precision, for the offsets computed on the CPU */
  centerLngLat64: [number, number];
  /** The Mercator coordinates of the center, at 64-bit precision */
  centerMercator: [number, number];
  /**
   * The center in clip space as the frame projects it, at 64-bit precision: on Web Mercator,
   * on the globe, or both mixed by the transition between them
   */
  projectionCenter: [number, number, number, number];
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
   *   the width is in pixels or meters; `referenceZoom` is the zoom at which a width in pixels is
   *   given, so that the line grows and shrinks with the zoom: it is drawn `2 ** (zoom -
   *   referenceZoom)` times as wide (the width stays the same at every zoom when it is left out)
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
    options?: { closed?: boolean; widthUnit?: 'pixels' | 'meters'; referenceZoom?: number },
  ): void;
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
  draw(rings: readonly (readonly Position[])[], style: { color: string; opacity: number }): void;
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
   *   ground; `referenceZoom` is the zoom at which the size and the outline width are given, so
   *   that the marker grows and shrinks with the zoom as a line does: it is drawn `2 ** (zoom -
   *   referenceZoom)` times as large (the same size at every zoom when it is left out)
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
    options?: { elevationMeters?: number; referenceZoom?: number },
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
  readonly projection: ProjectionData;
  /** The zoom of the frame */
  readonly zoom: number;
  /** The pixel ratio of the drawing */
  readonly pixelRatio: number;
  /** The opacity of the layer being drawn, from 0 to 1 */
  readonly opacity: number;
  /**
   * The heights of the terrain and where it hides a position. The building blocks of the
   * `/webgl` entry that draw on the terrain take it, or the whole render context.
   */
  readonly terrain: TerrainSurface;
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
  /**
   * How it draws the rows of a layer held as rows, without making features of them. Its type is
   * in `@sakuzu/maplibre-gl-draw/kasane`.
   *
   * @experimental
   */
  readonly rows?: FeatureRendererRows;
}

/**
 * How a renderer of a feature type draws the rows of a layer held as rows
 * (`FeatureRenderer.rows`), without making features of them
 *
 * @experimental
 */
export interface FeatureRendererRows {
  /**
   * The pictures it draws its points with: a point it takes whose style has a picture here is
   * drawn with the other rows of its layer, in their order and in their draw, from the texture
   * and the picture given, rather than by `draw` one at a time (a point whose style has none is
   * drawn by `draw`). Without it, every feature it takes is drawn by `draw`.
   */
  readonly sprites?: RowSpriteSource;
  /**
   * Draws features of rows, from the rows: the rows `FeatureRenderer.draw` would draw one after
   * the other, in that order (rows next to each other in the order of the layer, of the same
   * type, not hidden and in view). A row with a companion is drawn by `FeatureRenderer.draw`. A
   * row being dragged in bulk is given as it is written: read where it is drawn with
   * `draggedRowsOf`. Without it, the instance makes the features of the rows (keeping them up to a
   * limit) and draws them by `FeatureRenderer.draw`.
   */
  draw?(view: LayerTableView, handles: Int32Array, ctx: RenderContext): void;
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
