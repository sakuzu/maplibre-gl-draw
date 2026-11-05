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
import { parseColor, toColor } from '../../shared/color.js';
import type { Feature as StoredFeature } from '../../store/types.js';
import { applyDrawBlendState } from '../../view/layer/blend.js';
import { calculateOffsetUniforms, type OffsetUniforms } from '../../view/shaders/helpers.js';
import { bindViewUniforms } from '../../view/shaders/view-uniforms.js';
import { bindTerrainState } from '../../view/terrain/binding.js';
import type { TerrainContext } from '../../view/terrain/context.js';
import type { ScreenContext, TerrainSurface } from '../extension/context.js';
import type {
  FeatureRenderer,
  FillRenderer,
  LineRenderer,
  OverlayRenderer,
  PointRenderer,
  RenderContext,
} from '../extension/render.js';
import type { Feature, FeatureStyleResolved } from '../model.js';

// ============================================================================
// The surface of the terrain
// ============================================================================

/** The surface of each terrain state, so that a frame does not build it again */
const surfaceByTerrain = new WeakMap<TerrainContext, TerrainSurface>();

/**
 * The surface of the terrain of the contract over the terrain state of an instance
 *
 * @internal
 */
export function terrainSurfaceOf(
  terrain: TerrainContext,
  build: (terrain: TerrainContext) => TerrainSurface,
): TerrainSurface {
  let surface = surfaceByTerrain.get(terrain);
  if (!surface) {
    surface = build(terrain);
    surfaceByTerrain.set(terrain, surface);
  }
  return surface;
}

// ============================================================================
// The render context
// ============================================================================

/** The offsets of each projection matrix of a frame */
const offsetsByMatrix = new WeakMap<object, OffsetUniforms>();

/** The projection of a frame the CPU computes centers with: the matrix of the frame in float64 */
function frameOf(base: FrameDrawContext, projection: ProjectionData): ProjectionData {
  return { ...projection, mainMatrix: base.mainMatrixArray as ProjectionData['mainMatrix'] };
}

function offsetOf(base: FrameDrawContext, projection: ProjectionData): OffsetUniforms {
  let offset = offsetsByMatrix.get(base.mainMatrixArray);
  if (!offset) {
    offset = calculateOffsetUniforms(base.centerLngLat, frameOf(base, projection));
    offsetsByMatrix.set(base.mainMatrixArray, offset);
  }
  return offset;
}

/** A position as the `[lng, lat]` pair the shared renderers take */
function pair(position: Position): [number, number] {
  return [position[0], position[1]];
}

/**
 * Tells a color a shared renderer cannot read (it draws it transparent): a warning in the console
 * once for each part of each shared renderer of an instance
 */
type ColorWarning = (part: string, value: unknown) => void;

/** The parts of the shared renderers of each instance already warned of a color */
const warnedColors = new WeakMap<RenderAdapterDeps, Set<string>>();

/** The warning of the colors of the shared renderers of an instance */
function colorWarningOf(deps: RenderAdapterDeps): ColorWarning {
  return (part, value) => {
    let warned = warnedColors.get(deps);
    if (!warned) {
      warned = new Set();
      warnedColors.set(deps, warned);
    }
    if (warned.has(part)) return;
    warned.add(part);
    console.warn(
      `The shared renderer was given ${JSON.stringify(value)} as ${part}, which is not a CSS ` +
        'color the library reads (parseCssColor); it is drawn transparent',
    );
  };
}

/** A CSS color of a shared renderer, told once when it cannot be read */
function colorOf(
  value: string,
  part: string,
  warn: ColorWarning | undefined,
): ReturnType<typeof toColor> {
  if (warn && parseColor(value) === null) warn(part, value);
  return toColor(value);
}

/**
 * Builds the render context of the contract for one draw call
 *
 * @param gl - The WebGL context the renderer was added with
 * @param base - The context the engine gives its own renderers in this draw call
 * @param surface - The surface of the terrain of the terrain state of `base`
 * @param appliedStyle - The look a feature is drawn with (`draw.features.getAppliedStyle`)
 * @internal
 */
export function createRenderContext(
  gl: WebGL2RenderingContext,
  base: FrameDrawContext,
  projection: ProjectionData,
  zoom: number,
  surface: TerrainSurface,
  screen: ScreenContext,
  appliedStyle: (feature: StoredFeature) => FeatureStyleResolved,
  warnColor?: ColorWarning,
): RenderContext {
  const line: LineRenderer = {
    draw(coordinates, style, options = {}) {
      const coords = coordinates.map(pair);
      const stroke = {
        width: style.width,
        color: colorOf(style.color, 'the color of ctx.line', warnColor),
        opacity: style.opacity,
        lineStyle: style.lineStyle,
        ...(style.dashArray !== undefined && { dashArray: style.dashArray }),
      };
      const common = {
        widthUnit: options.widthUnit ?? 'pixels',
        ...(options.referenceZoom !== undefined && { createdZoom: options.referenceZoom }),
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
      const [r, g, b, a] = colorOf(style.color, 'the color of ctx.fill', warnColor);
      base.fillShaderManager.drawPolygonRings(
        rings.map((ring) => ring.map(pair)),
        [r, g, b, a * style.opacity],
        projection,
      );
    },
  };
  const point: PointRenderer = {
    draw(position, style, options = {}) {
      // A size given at a reference zoom follows the zoom from it, as the width of a line does
      const scale = options.referenceZoom === undefined ? 1 : 2 ** (zoom - options.referenceZoom);
      base.pointShapeRenderer.draw(
        pair(position),
        {
          shape: style.shape,
          size: style.size * scale,
          fillColor: colorOf(style.fillColor, 'the fillColor of ctx.point', warnColor),
          fillOpacity: style.fillOpacity,
          strokeColor: colorOf(style.strokeColor, 'the strokeColor of ctx.point', warnColor),
          strokeWidth: style.strokeWidth * scale,
          strokeOpacity: style.strokeOpacity,
        },
        undefined,
        options.elevationMeters,
      );
    },
  };
  const context: RenderContext = {
    gl,
    screen,
    opacity: base.opacity,
    terrain: surface,
    line,
    fill,
    point,
    // The features a renderer is given are those of the Store, as the contract shows them
    appliedStyle: (feature) => appliedStyle(feature as unknown as StoredFeature),
  };
  // The building blocks of the second entry find the terrain state and the values of the GPU of
  // the frame behind the context
  bindTerrainState(context, base.terrain);
  bindViewUniforms(context, {
    shader: base.shaderData,
    projection,
    offset: offsetOf(base, projection),
    frame: frameOf(base, projection),
  });
  return context;
}

/** What the adapters of the renderers read from the instance */
export interface RenderAdapterDeps {
  /** The surface of the terrain of a terrain state */
  surface(terrain: TerrainContext): TerrainSurface;
  /** The conversion between the map and the screen of the instance */
  readonly screen: ScreenContext;
  /** The look a feature is drawn with, which `draw.features.getAppliedStyle` answers too */
  appliedStyle(feature: StoredFeature): FeatureStyleResolved;
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
  const warnColor = colorWarningOf(deps);
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
    const context = createRenderContext(
      gl,
      base,
      projection,
      zoom,
      deps.surface(base.terrain),
      deps.screen,
      deps.appliedStyle,
      warnColor,
    );
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
    // The pictures of the points drawn with the rows, as the renderer gives them
    ...(renderer.rows?.sprites && { rowSprites: renderer.rows.sprites }),
    // The rows it holds on the GPU, when the renderer holds them so
    ...(renderer.rows?.gpu && {
      gpuRows: renderer.rows.gpu,
      gpuRowsContext(projectionData, zoom, context) {
        if (!attachment) return null;
        return contextFor(attachment.gl, context, projectionData, zoom);
      },
    }),
  };
}

/**
 * The render contexts of the frames an extension draws in outside a feature and a layer (the
 * handles it draws itself), one per frame: null while the map gives no WebGL context
 *
 * @internal
 */
export function createFrameContexts(
  deps: RenderAdapterDeps,
  getGl: () => WebGL2RenderingContext | null,
): (frame: FrameDrawContext, projection: ProjectionData, zoom: number) => RenderContext | null {
  const contextFor = createContextCache(deps);
  return (frame, projection, zoom) => {
    const gl = getGl();
    return gl ? contextFor(gl, frame, projection, zoom) : null;
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
