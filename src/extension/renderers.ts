// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The renderer contracts of the engine
 *
 * The shapes the engine draws with in the WebGL context of a draw instance: the renderer of a
 * feature type that is not built in and the overlay renderers. The renderers of the extension
 * contract reach the engine through the adapters of `api/impl/render-context.ts`, which hand
 * them a `RenderContext` made from the {@link FrameDrawContext} of the frame. They are types
 * only and sit low in the layer order, so the view and snapping layers read them without
 * reaching up into api.
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import type { Feature } from '../shared/types/model.js';
import type { SDFLineRenderer } from '../view/renderers/line/sdf-line.js';
import type { PointShapeRenderer } from '../view/renderers/point/point-shape.js';
import type { FillShaderManager } from '../view/renderers/polygon/fill.js';
import type { TerrainContext } from '../view/terrain/context.js';

/**
 * The values of one frame the engine draws with: the shader data, the offset information and
 * the shared renderers
 *
 * @internal
 */
export interface FrameDrawContext {
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
   * It is the pixel ratio of the options when one has been given, and otherwise the
   * `window.devicePixelRatio` read in that frame.
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
   * layer of the feature for a {@link FeatureTypeRenderer} and a feature companion, and 1 for
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
 * Draws the features of a feature type that is not built in with the WebGL context of the map
 *
 * It is the `renderer` of a {@link FeatureTypeHandler}. `onAdd` runs when the draw layer is
 * added to the map (create the WebGL resources there), `draw` runs for each visible feature of
 * the type in stacking order on every frame, and `onRemove` runs when the layer is removed.
 *
 * @internal
 */
export interface FeatureTypeRenderer {
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
    feature: Feature,
    projectionData: ProjectionData,
    zoom: number,
    context: FrameDrawContext,
  ): void;

  /**
   * Releases the WebGL resources
   */
  onRemove(): void;
}

/**
 * An overlay renderer of the engine: drawing that belongs to no feature
 *
 * @internal
 */
export interface EngineOverlayRenderer {
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
  draw(projectionData: ProjectionData, zoom: number, context: FrameDrawContext): void;

  /**
   * Releases the WebGL resources
   */
  onRemove(): void;

  /**
   * Whether the renderer still has work that later frames finish on their own and that will
   * change what it draws (resources it prepares over several frames, say). Optional: a renderer
   * without it has none
   *
   * `draw.hasPendingWork()` asks every overlay renderer, so a host that waits for a
   * complete picture waits for this renderer too. A renderer that returns true requests the
   * repaints that finish the work itself. With `timeSlicing: false` in the rendering settings,
   * a renderer should finish in the frame what it would otherwise spread over frames.
   */
  hasPendingWork?(): boolean;
}

/**
 * An overlay renderer that also draws per layer
 *
 * An extension of EngineOverlayRenderer that supports rendering per layer.
 * Used for rendering that follows the layer order, such as the geometry being drawn.
 *
 * @internal
 */
export interface LayeredOverlayRenderer extends EngineOverlayRenderer {
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
    context: FrameDrawContext,
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
  drawVertices?(projectionData: ProjectionData, zoom: number, context: FrameDrawContext): void;
}
