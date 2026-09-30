// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `RenderContext` of the extension contract, built from the context the engine draws its
 * own renderers with, and the renderers of the contract put into the engine
 *
 * A renderer of the contract receives one context with the offsets already computed and the
 * shared renderers reduced to their drawing methods. The engine keeps drawing through its own
 * renderer interfaces; the adapters here translate between the two.
 */

import type { Position } from 'geojson';
import type { Map as MaplibreMap, ProjectionData } from 'maplibre-gl';
import type {
  EngineOverlayRenderer,
  FeatureTypeRenderer,
  FrameDrawContext,
  LayeredOverlayRenderer,
} from '../../extension/renderers.js';
import { toColor } from '../../shared/color.js';
import type { Feature as StoredFeature } from '../../store/types.js';
import { applyDrawBlendState } from '../../view/layer/blend.js';
import { calculateOffsetUniforms } from '../../view/shaders/helpers.js';
import { bindTerrainState } from '../../view/terrain/binding.js';
import type { TerrainContext } from '../../view/terrain/context.js';
import type { TerrainAnchors } from '../extension/context.js';
import type {
  FeatureRenderer,
  FillRenderer,
  LineRenderer,
  OffsetUniforms,
  OverlayRenderer,
  PointRenderer,
  RenderContext,
} from '../extension/render.js';
import type { Feature } from '../model.js';

// ============================================================================
// Terrain anchors
// ============================================================================

/** The anchors of each terrain state, so that a frame does not build them again */
const anchorsByTerrain = new WeakMap<TerrainContext, TerrainAnchors>();

/**
 * The terrain anchors of the contract over the terrain state of an instance
 *
 * @internal
 */
export function terrainAnchorsOf(
  terrain: TerrainContext,
  build: (terrain: TerrainContext) => TerrainAnchors,
): TerrainAnchors {
  let anchors = anchorsByTerrain.get(terrain);
  if (!anchors) {
    anchors = build(terrain);
    anchorsByTerrain.set(terrain, anchors);
  }
  return anchors;
}

// ============================================================================
// The render context
// ============================================================================

/** The offsets of each projection matrix of a frame */
const offsetsByMatrix = new WeakMap<object, OffsetUniforms>();

function offsetOf(base: FrameDrawContext): OffsetUniforms {
  let offset = offsetsByMatrix.get(base.mainMatrixArray);
  if (!offset) {
    offset = calculateOffsetUniforms(base.centerLngLat, base.mainMatrixArray);
    offsetsByMatrix.set(base.mainMatrixArray, offset);
  }
  return offset;
}

/** A position as the `[lng, lat]` pair the shared renderers take */
function pair(position: Position): [number, number] {
  return [position[0], position[1]];
}

/**
 * Builds the render context of the contract for one draw call
 *
 * @param gl - The WebGL context the renderer was added with
 * @param base - The context the engine gives its own renderers in this draw call
 * @param anchors - The terrain anchors of the terrain state of `base`
 * @internal
 */
export function createRenderContext(
  gl: WebGL2RenderingContext,
  base: FrameDrawContext,
  projection: ProjectionData,
  zoom: number,
  anchors: TerrainAnchors,
): RenderContext {
  const line: LineRenderer = {
    draw(coordinates, style, options = {}) {
      const coords = coordinates.map(pair);
      const stroke = {
        width: style.width,
        color: toColor(style.color),
        opacity: style.opacity,
        lineStyle: style.lineStyle,
        ...(style.dashArray !== undefined && { dashArray: style.dashArray }),
      };
      const common = {
        widthUnit: options.widthUnit ?? 'pixels',
        ...(options.createdZoom !== undefined && { createdZoom: options.createdZoom }),
      };
      if (options.closed) {
        base.sdfLineRenderer.drawClosed(coords, stroke, common, zoom, projection);
      } else {
        base.sdfLineRenderer.draw(coords, stroke, { ...common, closed: false }, zoom, projection);
      }
    },
  };
  const fill: FillRenderer = {
    draw(rings, style) {
      const [r, g, b, a] = toColor(style.color);
      base.fillShaderManager.drawPolygonRings(
        rings.map((ring) => ring.map(pair)),
        [r, g, b, a * style.opacity],
        projection,
        zoom,
      );
    },
  };
  const point: PointRenderer = {
    draw(position, style, options = {}) {
      base.pointShapeRenderer.draw(
        pair(position),
        {
          shape: style.shape,
          size: style.size,
          fillColor: toColor(style.fillColor),
          fillOpacity: style.fillOpacity,
          strokeColor: toColor(style.strokeColor),
          strokeWidth: style.strokeWidth,
          strokeOpacity: style.strokeOpacity,
        },
        zoom,
        undefined,
        options.elevationMeters,
      );
    },
  };
  const context: RenderContext = {
    gl,
    shader: base.shaderData,
    offset: offsetOf(base),
    projection,
    zoom,
    pixelRatio: base.pixelRatio,
    opacity: base.opacity,
    terrain: anchors,
    line,
    fill,
    point,
  };
  // The building blocks of the second entry find the terrain state behind the context
  bindTerrainState(context, base.terrain);
  return context;
}

/** What the adapters of the renderers read from the instance */
export interface RenderAdapterDeps {
  /** The terrain anchors of a terrain state */
  anchors(terrain: TerrainContext): TerrainAnchors;
}

/** The map and the WebGL context a renderer was added with */
interface Attachment {
  map: MaplibreMap;
  gl: WebGL2RenderingContext;
}

/**
 * Remembers the last render context, so that the features drawn one after another in a frame
 * share one
 */
function createContextCache(deps: RenderAdapterDeps) {
  let last: {
    base: FrameDrawContext;
    projection: ProjectionData;
    zoom: number;
    context: RenderContext;
  } | null = null;
  return (
    gl: WebGL2RenderingContext,
    base: FrameDrawContext,
    projection: ProjectionData,
    zoom: number,
  ): RenderContext => {
    if (
      last &&
      last.base === base &&
      last.projection === projection &&
      last.zoom === zoom &&
      last.context.gl === gl
    ) {
      return last.context;
    }
    const context = createRenderContext(gl, base, projection, zoom, deps.anchors(base.terrain));
    last = { base, projection, zoom, context };
    return context;
  };
}

/**
 * The renderer of the engine that draws the features of a custom type through a renderer of
 * the contract
 *
 * @internal
 */
export function adaptFeatureRenderer(
  type: string,
  renderer: FeatureRenderer,
  deps: RenderAdapterDeps,
): FeatureTypeRenderer {
  let attachment: Attachment | null = null;
  const contextFor = createContextCache(deps);
  return {
    name: type,
    onAdd(gl, map) {
      attachment = { map, gl };
      renderer.onAdd(map, gl);
    },
    draw(feature, projectionData, zoom, context) {
      if (!attachment) return;
      renderer.draw(
        feature as unknown as Feature,
        contextFor(attachment.gl, context, projectionData, zoom),
      );
    },
    onRemove() {
      if (!attachment) return;
      const { map, gl } = attachment;
      attachment = null;
      renderer.onRemove(map, gl);
    },
  };
}

/**
 * The drawing of a companion through the contract, for one provider
 *
 * @internal
 */
export function createCompanionDrawer(
  deps: RenderAdapterDeps,
  getGl: () => WebGL2RenderingContext | null,
) {
  const contextFor = createContextCache(deps);
  return (
    draw: (feature: Feature, ctx: RenderContext) => void,
    feature: StoredFeature,
    projectionData: ProjectionData,
    zoom: number,
    context: FrameDrawContext,
  ): void => {
    const gl = getGl();
    if (!gl) return;
    draw(feature as Feature, contextFor(gl, context, projectionData, zoom));
  };
}

// ============================================================================
// Overlays
// ============================================================================

/** Where the overlays of the contract are put into the engine */
export interface OverlayHost {
  /** Adds a renderer of the engine; returns the function that removes it */
  addOverlay(renderer: EngineOverlayRenderer): () => void;
}

/**
 * The overlays of the contract of one instance
 *
 * @internal
 */
export interface OverlayStack {
  /** Adds an overlay; returns the function that removes it */
  add(overlay: OverlayRenderer): () => void;
  /** The WebGL context of the map, while the overlays are on it */
  gl(): WebGL2RenderingContext | null;
}

/**
 * Creates the overlays of the contract of one instance
 *
 * They are drawn by two renderers of the engine, added while at least one overlay exists: one
 * draws `draw` of every overlay above the features and the selection, the other draws
 * `drawForLayer` after each layer and `drawVertices` above everything. Within each, the overlays
 * go by `order`, then by the order they were added.
 *
 * @internal
 */
export function createOverlayStack(host: OverlayHost, deps: RenderAdapterDeps): OverlayStack {
  const overlays: Array<{ overlay: OverlayRenderer; seq: number }> = [];
  let seq = 0;
  let attachment: Attachment | null = null;
  let removeRenderers: (() => void) | null = null;
  const contextFor = createContextCache(deps);

  const sorted = (): OverlayRenderer[] =>
    [...overlays]
      .sort((a, b) => (a.overlay.order ?? 0) - (b.overlay.order ?? 0) || a.seq - b.seq)
      .map((entry) => entry.overlay);

  const each = (
    projectionData: ProjectionData,
    zoom: number,
    context: FrameDrawContext,
    call: (overlay: OverlayRenderer, ctx: RenderContext) => void,
  ): void => {
    if (!attachment) return;
    const ctx = contextFor(attachment.gl, context, projectionData, zoom);
    for (const overlay of sorted()) {
      call(overlay, ctx);
      applyDrawBlendState(attachment.gl);
    }
  };

  const onAdd = (gl: WebGL2RenderingContext, map: MaplibreMap): void => {
    if (attachment) return;
    attachment = { gl, map };
    for (const overlay of sorted()) overlay.onAdd(map, gl);
  };
  const onRemove = (): void => {
    if (!attachment) return;
    const { map, gl } = attachment;
    attachment = null;
    for (const overlay of sorted()) overlay.onRemove(map, gl);
  };

  const above: EngineOverlayRenderer = {
    name: 'extension-overlays',
    order: 'overlay',
    onAdd,
    draw(projectionData, zoom, context) {
      each(projectionData, zoom, context, (overlay, ctx) => overlay.draw(ctx));
    },
    onRemove,
    hasPendingWork: () => overlays.some((entry) => entry.overlay.hasPendingWork?.() === true),
  };
  const perLayer: LayeredOverlayRenderer = {
    name: 'extension-overlays-per-layer',
    order: 'overlay',
    // The resources are created and released by the other renderer
    onAdd() {},
    draw() {},
    onRemove() {},
    drawForLayer(layerId, projectionData, zoom, context) {
      each(projectionData, zoom, context, (overlay, ctx) => overlay.drawForLayer?.(layerId, ctx));
    },
    drawVertices(projectionData, zoom, context) {
      each(projectionData, zoom, context, (overlay, ctx) => overlay.drawVertices?.(ctx));
    },
  };

  return {
    add(overlay) {
      const entry = { overlay, seq: seq++ };
      overlays.push(entry);
      if (!removeRenderers) {
        const removeAbove = host.addOverlay(above);
        const removePerLayer = host.addOverlay(perLayer);
        removeRenderers = () => {
          removePerLayer();
          removeAbove();
        };
      } else if (attachment) {
        overlay.onAdd(attachment.map, attachment.gl);
      }
      return () => {
        const index = overlays.indexOf(entry);
        if (index === -1) return;
        if (overlays.length === 1 && removeRenderers) {
          // The last one goes with the renderers of the engine, which release it
          const remove = removeRenderers;
          removeRenderers = null;
          remove();
          overlays.splice(overlays.indexOf(entry), 1);
          return;
        }
        overlays.splice(index, 1);
        if (attachment) overlay.onRemove(attachment.map, attachment.gl);
      };
    },
    gl: () => attachment?.gl ?? null,
  };
}
