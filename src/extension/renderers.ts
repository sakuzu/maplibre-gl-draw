// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The renderer contracts of an extension
 *
 * The shapes an extension implements to draw with the WebGL context of a draw instance: the
 * renderer of a custom feature type and the overlay renderers. They are types only and sit low
 * in the layer order, so the view and snapping layers read them without reaching up into api.
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import type { SDFLineRenderer } from '../view/renderers/line/sdf-line.js';
import type { PointShapeRenderer } from '../view/renderers/point/point-shape.js';
import type { FillShaderManager } from '../view/renderers/polygon/fill.js';
import type { TerrainContext } from '../view/terrain/context.js';

/**
 * Rendering context for custom renderers
 *
 * Provides the shader data and offset information needed when using QuadShader and the like.
 * It also holds references to the shared renderers, which makes high-quality rendering possible.
 */
export interface CustomRendererDrawContext {
  /** Shader data (vertexShaderPrelude, define, variantName) */
  shaderData: {
    vertexShaderPrelude: string;
    define: string;
    variantName: string;
  };
  /** Viewport center coordinate [lng, lat] */
  centerLngLat: [number, number];
  /** The mainMatrix converted into an array */
  mainMatrixArray: number[];
  /**
   * The resolved rendering scale factor (the conversion factor from CSS pixels to device pixels)
   *
   * It is the value of `pixelRatio` in Options when one has been injected, and otherwise the
   * `window.devicePixelRatio` read in that frame. Renderers on the extension side use this
   * instead of reading `window.devicePixelRatio` directly.
   */
  pixelRatio: number;
  /**
   * The terrain state of the draw instance being drawn
   *
   * A renderer that owns a `ProjectionUniformManager` or a `QuadShader` passes it with
   * `setTerrain(context.terrain)` before drawing, and the anchor functions (`projectAnchor`,
   * `anchorElevationMeters`, `anchorGhostOpacity`, `drawQuadSurfaceOnTerrain` and so on) take
   * it as their first argument. It is valid for this draw call only; a renderer shared between
   * draw instances must not keep it.
   */
  terrain: TerrainContext;
  /**
   * The opacity of the layer being drawn, from 0 to 1 (`Layer.opacity`)
   *
   * Core multiplies it into everything it draws for the layer, and a renderer multiplies it
   * into its own alpha, so that what it draws fades with the layer. It is the opacity of the
   * layer of the feature for a {@link CustomFeatureRenderer} and a feature companion, and 1 for
   * an overlay (which does not belong to a layer). The shared renderers of this context do not
   * apply it by themselves. It changes nothing about hit testing: a feature in a layer at
   * opacity 0 can still be selected.
   */
  opacity: number;

  // --- Shared renderers ---

  /** SDF line rendering (high-quality line rendering, anti-aliasing, dashes and so on) */
  sdfLineRenderer: SDFLineRenderer;
  /** Polygon fill rendering */
  fillShaderManager: FillShaderManager;
  /** Point shape rendering */
  pointShapeRenderer: PointShapeRenderer;
}

/**
 * Draws the features of a custom feature type with the WebGL context of the map
 *
 * It is the `renderer` of a {@link CustomFeatureHandler}. `onAdd` runs when the draw layer is
 * added to the map (create the WebGL resources there), `draw` runs for each visible feature of
 * the type in stacking order on every frame, and `onRemove` runs when the layer is removed. The
 * shared renderers of the context draw lines, fills and point shapes the same way the built-in
 * types are drawn, terrain included.
 *
 * @example
 * ```ts
 * import type { CustomFeatureRenderer, PointStyle } from '@sakuzu/maplibre-gl-draw';
 *
 * const markerStyle: PointStyle = {
 *   shape: 'square',
 *   size: 14,
 *   fillColor: [0, 0.4, 1, 1],
 *   fillOpacity: 1,
 *   strokeColor: [1, 1, 1, 1],
 *   strokeWidth: 2,
 *   strokeOpacity: 1,
 * };
 *
 * const markerRenderer: CustomFeatureRenderer = {
 *   name: 'marker',
 *   onAdd() {}, // nothing to create: the shared point renderer does the drawing
 *   draw(feature, _projectionData, zoom, context) {
 *     const coordinate = feature.coordinates as [number, number];
 *     // Fade with the layer: the opacity of the layer is multiplied into the alpha
 *     const style = {
 *       ...markerStyle,
 *       fillOpacity: markerStyle.fillOpacity * context.opacity,
 *       strokeOpacity: markerStyle.strokeOpacity * context.opacity,
 *     };
 *     context.pointShapeRenderer.draw(coordinate, style, zoom, feature.id);
 *   },
 *   onRemove() {},
 * };
 * ```
 */
export interface CustomFeatureRenderer {
  /** Renderer name (for debugging) */
  readonly name: string;

  /**
   * Initializes the WebGL resources
   */
  onAdd(gl: WebGL2RenderingContext, map: MapLibreMap): void;

  /**
   * Draws a feature
   *
   * @param feature The feature to draw
   * @param projectionData MapLibre's ProjectionData
   * @param zoom The current zoom level
   * @param context The rendering context (shader data, offset information, and the opacity of
   *   the layer of the feature, which the renderer multiplies into its own alpha)
   */
  draw(
    feature: {
      id: string;
      type: string;
      coordinates: unknown;
      properties: Record<string, unknown>;
      style?: unknown;
    },
    projectionData: ProjectionData,
    zoom: number,
    context: CustomRendererDrawContext,
  ): void;

  /**
   * Releases the WebGL resources
   */
  onRemove(): void;
}

/**
 * Custom renderer
 *
 * Responsible for overlay rendering (independent of features).
 */
export interface CustomOverlayRenderer {
  /** Renderer name (for debugging) */
  readonly name: string;

  /**
   * The priority in the draw order
   * - 'background': drawn behind the features
   * - 'foreground': drawn in front of the features (behind the selection UI)
   * - 'overlay': drawn in front of the selection UI
   */
  readonly order: 'background' | 'foreground' | 'overlay';

  /**
   * Initializes the WebGL resources
   */
  onAdd(gl: WebGL2RenderingContext, map: MapLibreMap): void;

  /**
   * Draws
   *
   * @param projectionData MapLibre's ProjectionData
   * @param zoom The current zoom level
   * @param context The rendering context (shared renderers, shader data and so on)
   */
  draw(projectionData: ProjectionData, zoom: number, context: CustomRendererDrawContext): void;

  /**
   * Releases the WebGL resources
   */
  onRemove(): void;

  /**
   * Whether the renderer still has work that later frames finish on their own and that will
   * change what it draws (resources it prepares over several frames, say). Optional: a renderer
   * without it has none
   *
   * `MapLibreGLDraw.hasPendingWork` asks every overlay renderer, so a host that waits for a
   * complete picture waits for this renderer too. A renderer that returns true requests the
   * repaints that finish the work itself. With `timeSlicing: false` in the rendering settings,
   * a renderer should finish in the frame what it would otherwise spread over frames.
   */
  hasPendingWork?(): boolean;
}

/**
 * Layer-aware overlay renderer
 *
 * An extension of CustomOverlayRenderer that supports rendering per layer.
 * Used for rendering that follows the layer order, such as Tentative.
 */
export interface LayerAwareOverlayRenderer extends CustomOverlayRenderer {
  /**
   * Performs the rendering that corresponds to the given layer (lines and fills only)
   *
   * Called in the per-layer rendering loop, after the features of each layer have been drawn.
   * When this method exists, it is used instead of draw().
   * Vertices are drawn in the foreground, so they are not drawn here.
   *
   * @param layerId The ID of the target layer
   * @param projectionData MapLibre's ProjectionData
   * @param zoom The current zoom level
   * @param context The rendering context
   */
  drawForLayer(
    layerId: string,
    projectionData: ProjectionData,
    zoom: number,
    context: CustomRendererDrawContext,
  ): void;

  /**
   * Draws the vertices in the foreground
   *
   * Called after the selection UI, it draws the vertices of all layers in the foreground at once.
   * This is needed so that the vertices stay visible even while drawing on a layer that is behind.
   *
   * @param projectionData MapLibre's ProjectionData
   * @param zoom The current zoom level
   * @param context The rendering context
   */
  drawVertices?(
    projectionData: ProjectionData,
    zoom: number,
    context: CustomRendererDrawContext,
  ): void;
}
