// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CustomLayer
 *
 * Implementation of the CustomLayerInterface of MapLibre
 *
 * It batches features while keeping the draw order, reducing the number of draw calls.
 * - Point: instanced rendering (circle, square, triangle, star)
 * - LineString: batched rendering with SDFLineRenderer (solid lines)
 * - Polygon: batched rendering with PolygonBatchRenderer (fill) + SDFPolygonRenderer
 *   (fill + stroke)
 *
 * This file implements the interface of maplibre and ties the parts together; the parts are
 * separate files:
 *
 * - renderers.ts: the initialization and disposal of the renderers
 * - slot-manager.ts: the slots (one CustomLayer per segment) and how many are on the map
 * - terrain-resolver.ts: the terrain state of a frame (the DEM atlas and the subdivision)
 * - drape-planner.ts: the plan of the analytic drape and the reason it is or is not used
 * - frame-state.ts: the state of a frame, built once by the first slot
 * - frame-render.ts: the drawing of a segment and of the foreground pass
 * - gl-state.ts: the GL state set and restored around every slot
 * - render.ts: the per-layer rendering loop
 *
 * Slots (several CustomLayers)
 *
 * When "external entries" of the host (MVT and raster layers that the host places as native
 * maplibre layers) are interleaved into the stacking order (layerOrder), the order is cut into
 * segments at the external entries and every segment gets its own CustomLayer (a slot). There is
 * a single rendering engine (renderers, retained batches, drape, terrain state) and each slot
 * draws only its own segment. The preparation of a frame is done once by the first slot, and the
 * foreground pass (selection UI, the tentative geometry being drawn, overlays) is drawn by the
 * last slot. The design is in docs/internals/rendering.md, "Slots and separators".
 */

import type {
  CustomLayerInterface as BaseCustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from 'maplibre-gl';
import type { DatasetManager } from '../../dataset/manager.js';
import type { CustomFeatureHandler, CustomOverlayRenderer } from '../../extension/index.js';
import type { FeatureStyleConfig } from '../../shared/config/feature-style.js';
import type { RenderingConfig } from '../../shared/config/rendering.js';
import type { SelectionUIConfig } from '../../shared/config/selection.js';
import type { PixelRatioInput } from '../../shared/utils/pixel-ratio.js';
import { resolvePixelRatio } from '../../shared/utils/pixel-ratio.js';
import type { SpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Store } from '../../store/store.js';
import type { FeatureCompanionRegistry } from '../feature-companion.js';
import { updateGlobeSubdivision } from '../globe-subdivision.js';
import { beginRenderFrame } from '../shaders/frame.js';
import { installAnchorProjector, uninstallAnchorProjector } from '../terrain/anchor.js';
import {
  releaseTerrainContext,
  type TerrainContext,
  type TerrainRenderState,
} from '../terrain/context.js';
import { getCameraMercator } from '../terrain/detect.js';
import {
  setQuadDrapeFrame,
  setTerrainCameraMoving,
  setTerrainRenderState,
} from '../terrain/state.js';
import type { SelectionScope } from '../ui/selection-scope.js';
import { DisplayListCache } from './display-list.js';
import { DrapePlanner } from './drape-planner.js';
import { type FrameRenderDeps, renderForeground, renderSegment } from './frame-render.js';
import { buildFrameState, type FrameState, StyleZoom } from './frame-state.js';
import { createRenderScope } from './render-scope.js';
import { disposeRenderers, initRenderers, type Renderers } from './renderers.js';
import { SlotManager } from './slot-manager.js';
import { type RenderSlot, renderSlotLayerId } from './slots.js';
import { StoreRetainedCache } from './store-retained.js';
import { isOpacityOnlyLayersChange } from './store-retained-invalidation.js';
import { TerrainResolver } from './terrain-resolver.js';

/**
 * Dependencies of CustomLayer
 *
 * @internal
 */
export interface CustomLayerDeps {
  map: MapLibreMap;
  store: Store;
  spatialIndex: SpatialIndex;
  featureStyle: FeatureStyleConfig;
  selectionConfig: SelectionUIConfig;
  renderingConfig: RenderingConfig;
  /** Custom feature handlers (for the extension implementations) */
  customFeatureHandlers?: CustomFeatureHandler[];
  /**
   * Datasets (read-only layers that show large amounts of data)
   *
   * No dataset is drawn when it is omitted.
   */
  datasets?: DatasetManager;
  /**
   * Rendering pixel ratio (when omitted, `window.devicePixelRatio` is read every time)
   *
   * The `pixelRatioSource.resolve` of Context (an injected value, or window × the render scale)
   * is passed in. A number can also be passed directly.
   */
  pixelRatio?: PixelRatioInput;
  /**
   * Providers of companion drawing and companion hits (those of this draw instance)
   *
   * It is required. If it could be omitted, a missing wiring would show up only as "the
   * companions are silently not drawn" and would go unnoticed until found in the field (the
   * defect where companion lines were missing from a print export had exactly this shape).
   */
  featureCompanions: FeatureCompanionRegistry;
  /**
   * The selection scope of this draw instance (the extension points of the custom feature
   * types, the auxiliary handles and the thinned handle sets)
   *
   * It is required and it is the same object the modes hit test against, so the selection UI
   * that is drawn and the handles that can be grabbed come from one source.
   */
  selectionScope: SelectionScope;
  /**
   * Predicate that identifies the "external entries" of the stacking order (always false when
   * omitted = a single slot)
   *
   * An entry for which it returns true is a separator and is not drawn by us. Every segment
   * between separators gets its own slot (CustomLayer).
   */
  isExternalEntry?: (entryId: string) => boolean;
  /**
   * Where the changes of the slots and of the segments are notified
   *
   * On receiving it, the host places the native layers that correspond to the separators back
   * between the slots.
   */
  onSlotsChange?: (slots: RenderSlot[]) => void;
  /**
   * Where the failure to load the image of an Image feature is reported (once per image that
   * fails; the draw instance turns it into the load.error event)
   */
  onImageError?: (featureId: string, error: Error) => void;
}

/**
 * An extended CustomLayerInterface
 * Overlay renderers can be added to it dynamically
 *
 * @internal
 */
export interface CustomLayerInterface extends BaseCustomLayerInterface {
  /**
   * Adds an overlay renderer
   *
   * @returns the function that removes it again (removeOverlayRenderer)
   */
  addOverlayRenderer(renderer: CustomOverlayRenderer): () => void;
  /** Removes an overlay renderer; it gets its onRemove when the GPU side exists */
  removeOverlayRenderer(renderer: CustomOverlayRenderer): void;
  /**
   * Registers the renderer of a custom feature type
   *
   * @returns the function that cancels the registration (it does not remove a later
   *   registration of the same type)
   */
  registerFeatureRenderer(type: string, renderer: CustomFeatureHandler['renderer']): () => void;
  /** The list of slots (the first = the backmost). Just itself when there is no separator */
  getRenderSlots(): RenderSlot[];
  /**
   * The list of CustomLayers that should be added to maplibre (first = backmost; the first is
   * this one)
   *
   * The host calls map.addLayer in order from the first. When a slot is added Draw adds it
   * itself, and when one is removed Draw removes it itself.
   */
  getSlotLayers(): BaseCustomLayerInterface[];
  /**
   * The terrain state of this draw instance (the anchor projection of the plugins reads it)
   */
  getTerrainContext(): TerrainContext;
  /**
   * Whether work remains that later frames finish without the host doing anything (see
   * `MapLibreGLDraw.hasPendingWork`)
   */
  hasPendingWork(): boolean;
  /**
   * Draws again from the configuration: the GPU side is built again from the styles and the
   * switches of the rendering, the caches are dropped and the slots follow the separators.
   * Called after the options of the instance changed at runtime
   */
  refresh(): void;
}

/**
 * The engine behind the slots
 *
 * The GL side (the context, the renderers, the retained batches) exists only while at least one
 * slot is on the map, and every field that changes with it is held here rather than in loose
 * variables.
 */
interface EngineState {
  /** The WebGL context received in onAdd (kept after the removal; `renderers` says built) */
  gl: WebGL2RenderingContext | null;
  /** The map the engine is on (null while not added) */
  mapInstance: MapLibreMap | null;
  /** The renderers (null while the GPU side is not built) */
  renderers: Renderers | null;
  /**
   * Retained batch cache of the Store rendering
   *
   * While it is disabled by the configuration it stays null and the previous immediate mode is
   * used.
   */
  storeRetainedCache: StoreRetainedCache | null;
  /**
   * The rendering pixel ratio baked into the retained batches (null when not built yet)
   *
   * Line widths and point sizes are converted to physical pixels and baked into the retained
   * batches, so they have to be rebuilt when the ratio changes (the same story as
   * `syncDevicePixelRatio` on the dataset side; this one is the retained batches
   * of the Store rendering).
   */
  builtPixelRatio: number | null;
  unsubscribeStore: (() => void) | null;
  /** Stops following the context loss of the canvas (null while not added) */
  unwatchContextLoss: (() => void) | null;
  /** The frame being drawn (the first slot builds it, the last slot closes it) */
  frame: FrameState | null;
  /**
   * The terrain state resolved by prerender for the frame about to be drawn (null when the frame
   * resolves it itself: prerender did not run, or it was already used)
   */
  preparedTerrainState: TerrainRenderState | null;
}

/**
 * Factory function of the CustomLayerInterface
 *
 * @internal
 */
export function createCustomLayer(deps: CustomLayerDeps): CustomLayerInterface {
  const {
    map,
    store,
    spatialIndex,
    featureStyle,
    selectionConfig,
    renderingConfig,
    customFeatureHandlers,
    datasets,
    pixelRatio,
  } = deps;

  // The providers of companion drawing are dedicated to this instance
  const featureCompanions = deps.featureCompanions;

  // Map of the custom feature handlers
  const customRenderers = new Map<string, CustomFeatureHandler['renderer']>();
  if (customFeatureHandlers) {
    for (const handler of customFeatureHandlers) {
      customRenderers.set(handler.type, handler.renderer);
    }
  }

  const engine: EngineState = {
    gl: null,
    mapInstance: null,
    renderers: null,
    storeRetainedCache: null,
    builtPixelRatio: null,
    unsubscribeStore: null,
    unwatchContextLoss: null,
    frame: null,
    preparedTerrainState: null,
  };
  /** The ordered list of the features to display (the immediate path; follows the Store) */
  const displayList = new DisplayListCache(store);
  const dynamicOverlayRenderers: CustomOverlayRenderer[] = [];

  /**
   * Terrain state of this draw instance
   *
   * The frame state, the generation counters, the frame of the anchor projection and the
   * subdivision cache are all held here. It used to be module-global, and the screen, the
   * thumbnails, the previews and the print overwrote each other's state every frame.
   * It is part of the render scope, together with the caches of triangulation and style
   * evaluation that are keyed by feature id (another instance holding the same ids never reads
   * them). The renderers receive the parts they need at construction.
   */
  const renderScope = createRenderScope(deps.selectionScope);
  const terrainContext = renderScope.terrain;
  const terrainResolver = new TerrainResolver(map, terrainContext);
  const drape = new DrapePlanner({
    map,
    store,
    terrain: terrainContext,
    datasets,
    // Read at each build, so a change of the rendering switches applies to the next one
    get timeSlicing() {
      return renderingConfig.timeSlicing;
    },
  });
  const styleZoom = new StyleZoom();
  const slots = new SlotManager({
    map,
    getLayerOrder: () => store.getLayerOrder(),
    isExternalEntry: deps.isExternalEntry,
    onSlotsChange: deps.onSlotsChange,
    createSlotLayer: makeSlotLayer,
  });

  // ---------------------------------------------------------------------------
  // Creation and disposal of the engine (built when the first slot goes onto the map, torn down
  // when the last slot is removed)
  // ---------------------------------------------------------------------------

  function engineAdd(mapInstance: MapLibreMap, glContext: WebGL2RenderingContext): void {
    if (!slots.attach()) return;

    engine.gl = glContext;
    engine.mapInstance = mapInstance;

    // Insert the anchor projection into the hit testing side. It only takes effect in the frames
    // where the terrain is active (it returns null until setAnchorFrame is called), and on a map
    // without terrain the project of MapLibre is used as before.
    installAnchorProjector(mapInstance, terrainContext);

    // Subscribe to the Store changes to invalidate the earcut, style rule and retained batch
    // caches
    // Changes made while the layer was off the map were not seen
    displayList.invalidate();
    engine.unsubscribeStore = store.subscribe((changes) => {
      engine.storeRetainedCache?.applyChanges(changes);
      displayList.applyChanges(changes);
      // The binning of the analytic drape is rebuilt only on a change of the geometry, the style,
      // the membership or the order. Rebuilding it indiscriminately on changes such as
      // selection / editing / tentative / mode would run the dataset (about 10 ms) and the
      // binning on every interaction and make the map stutter (measured; the exclusion test of
      // the dataset depends only on the type and the style, so the collected result does not
      // change even without looking at them). The opacity of a layer is a factor of its drape
      // source, written every frame, so a change of the opacity alone keeps the binning.
      const affectsDrape =
        changes.features !== undefined ||
        (changes.layers !== undefined && !isOpacityOnlyLayersChange(changes.layers)) ||
        changes.groups !== undefined ||
        changes.layerReorder !== undefined ||
        changes.groupReorder !== undefined;
      if (affectsDrape) drape.invalidate();

      if (changes.features?.updated) {
        for (const { id } of changes.features.updated) {
          renderScope.earcut.delete(id);
          renderScope.styleRules.delete(id);
          terrainContext.fillCache.delete(id);
        }
      }
      if (changes.features?.deleted) {
        for (const feature of changes.features.deleted) {
          renderScope.earcut.delete(feature.id);
          renderScope.styleRules.delete(feature.id);
          terrainContext.fillCache.delete(feature.id);
        }
      }
      // When the style rule of a layer changes, the evaluation results of every feature that
      // belongs to that layer go stale. There is no reverse lookup of the membership, so the
      // whole cache is discarded (changing a rule is a rare operation).
      if (changes.layers?.updated) {
        for (const { layer, previous } of changes.layers.updated) {
          if (layer.styleRule !== previous.styleRule) {
            renderScope.styleRules.clear();
            break;
          }
        }
      }
      // When the stacking order changes, the slots follow it (a layer added, removed or
      // reordered; a dataset joining the order also goes through setLayerOrder
      // and arrives here)
      if (changes.layers !== undefined) slots.sync();
    });

    watchContextLoss(mapInstance);

    // Build the GPU side (skipped while the context is lost; the restore builds it then)
    buildGpuResources();

    // If the stacking order changed before it was added, the number of slots is matched here
    slots.sync();
  }

  function engineRemove(): void {
    if (!slots.detach()) return;

    if (engine.unsubscribeStore) {
      engine.unsubscribeStore();
      engine.unsubscribeStore = null;
    }
    engine.unwatchContextLoss?.();
    engine.unwatchContextLoss = null;

    releaseGpuResources();

    // The overlay renderers stay registered. maplibre removes the custom layers when it swaps
    // the style or loses the WebGL context, and the host adds them back afterwards; the overlays
    // then receive onAdd again from buildGpuResources (they were registered once, by a plugin or
    // at creation, and nobody registers them a second time).
    engine.mapInstance = null;
    renderScope.earcut.clear();
    renderScope.styleRules.clear();

    // Release the terrain state of this instance
    releaseTerrainContext(terrainContext);
    // Remove the inserted anchor projection (hit testing goes back to the project of MapLibre)
    if (map) uninstallAnchorProjector(map);
  }

  // ---------------------------------------------------------------------------
  // GPU resources (every buffer, texture, program, vertex array and framebuffer)
  //
  // Everything that lives in the WebGL context is created by buildGpuResources and dropped by
  // releaseGpuResources, and nothing else holds a GL object across frames. A lost context
  // invalidates every GL object at once, so this pair is also what the context loss and the
  // restore run (docs/internals/rendering.md, "GPU resources and WebGL context loss"). The CPU-side
  // state (the Store subscription, the caches of triangulation and style evaluation, the
  // drape index of the elements) is kept.
  // ---------------------------------------------------------------------------

  /**
   * Creates the GPU resources of the engine
   *
   * It does nothing when they already exist or when the context is lost (the restore calls it
   * again).
   */
  function buildGpuResources(): void {
    const { gl, mapInstance } = engine;
    if (engine.renderers || !gl || !mapInstance || gl.isContextLost()) return;

    engine.renderers = initRenderers({
      gl,
      map: mapInstance,
      store,
      spatialIndex,
      featureStyle,
      selectionConfig,
      renderingConfig,
      customFeatureHandlers,
      pixelRatio,
      scope: renderScope,
      onImageError: deps.onImageError,
    });

    if (renderingConfig.storeRetained !== false) {
      engine.storeRetainedCache = new StoreRetainedCache(store, {
        terrain: terrainContext,
        extensions: renderScope.selection.extensions,
      });
    }

    // Initialize the custom renderers and the overlay renderers (an overlay added before the
    // engine existed receives its onAdd here)
    for (const renderer of customRenderers.values()) {
      renderer.onAdd(gl, mapInstance);
    }
    for (const renderer of dynamicOverlayRenderers) {
      renderer.onAdd(gl, mapInstance);
    }
  }

  /**
   * Drops the GPU resources of the engine
   *
   * The delete calls are harmless on a lost context (WebGL ignores them), so the same path serves
   * the removal from the map and the context loss.
   */
  function releaseGpuResources(): void {
    engine.frame = null;
    engine.preparedTerrainState = null;
    const r = engine.renderers;
    if (!r) return;

    for (const renderer of customRenderers.values()) {
      renderer.onRemove();
    }
    for (const renderer of dynamicOverlayRenderers) {
      renderer.onRemove();
    }

    // Release the retained-mode GPU resources held by the datasets (the
    // datasets themselves are kept and built again once the layer is recreated)
    datasets?.disposeRetained();

    // Release the retained batches of the Store rendering too (before disposing the renderers)
    engine.storeRetainedCache?.dispose(r.batchManager.getRetainedRenderers());
    engine.storeRetainedCache = null;
    engine.builtPixelRatio = null;

    // The DEM atlas, the drape renderers, and the plan and the index that point into the pack
    // uploaded to the drape renderer (the next frame collects and uploads again)
    terrainResolver.releaseGpu();
    drape.releaseGpu();
    setQuadDrapeFrame(terrainContext, null);

    disposeRenderers(r);
    engine.renderers = null;
  }

  /**
   * Follows the loss and the restore of the WebGL context of the map
   *
   * These are events of the GL context, not input, so they are subscribed here and not in the
   * InputNormalizer. maplibre 6.6 itself removes every custom layer when the context is lost
   * (onRemove runs, and this listener goes with it) and does not add them back; the host adds
   * them again after the restore (attachSlotLayers follows `styledata`), and onAdd builds
   * everything again. The listener covers the other shape, where the layer stays on the map
   * through the loss: the GPU side is dropped on the loss and built again on the restore
   * (docs/internals/maplibre-coupling.md, item 23).
   */
  function watchContextLoss(mapInstance: MapLibreMap): void {
    const canvas = mapInstance.getCanvas?.();
    if (!canvas) return;
    const onLost = (): void => {
      releaseGpuResources();
    };
    const onRestored = (): void => {
      if (slots.addedCount === 0) return;
      buildGpuResources();
      mapInstance.triggerRepaint?.();
    };
    canvas.addEventListener('webglcontextlost', onLost, false);
    canvas.addEventListener('webglcontextrestored', onRestored, false);
    engine.unwatchContextLoss = () => {
      canvas.removeEventListener('webglcontextlost', onLost, false);
      canvas.removeEventListener('webglcontextrestored', onRestored, false);
    };
  }

  // ---------------------------------------------------------------------------
  // Preparation of the frame (done once by the first slot)
  // ---------------------------------------------------------------------------

  function beginFrame(renderOptions: CustomRenderMethodInput): FrameState | null {
    const { gl, renderers: r } = engine;
    if (!gl || !r) return null;

    // Declare the switch to a new frame (this invalidates the memoized uniforms held by each
    // renderer; see shaders/frame.ts)
    beginRenderFrame();

    // While the camera is moving, the re-baking of the retained batches is deferred (read by
    // dataset/chunk-set.ts)
    setTerrainCameraMoving(
      terrainContext,
      map?.isMoving?.() === true || map?.isZooming?.() === true,
    );

    // The zoom that the rendering reads is the style zoom (a value that absorbs the steps of the
    // elevation settlement; frame-state.ts). The position of the camera (the altitude in meters)
    // tells a settlement from a jump of the camera
    const rawZoom = map?.getZoom() ?? 14;
    const cameraBusy = map?.isMoving?.() === true || map?.isZooming?.() === true;
    const zoom = styleZoom.update(rawZoom, cameraBusy, getCameraMercator(map, 1));
    // The datasets decide the rows they draw from the zoom of this frame, before anything of it
    // is drawn (the drape plan below and every layer of the frame read the same rows)
    datasets?.beginFrame(zoom);

    // Detection of the terrain and establishing the frame state
    //
    // INACTIVE is put in place when there is no terrain. The u_terrain_on of the shaders becomes
    // 0 and the vertex computation is exactly the same as before the terrain was introduced (zero
    // regression). This is looked at every frame (setTerrain / removeTerrain emit no event).
    //
    // It is normally resolved in prerender, before maplibre starts the main pass, because baking
    // the DEM atlas renders into a framebuffer of its own; switching framebuffers in the middle
    // of the main pass makes a tiled GPU store and reload the whole frame
    const terrainState = engine.preparedTerrainState ?? terrainResolver.resolve(gl);
    engine.preparedTerrainState = null;
    setTerrainRenderState(terrainContext, terrainState);
    // The cells the globe cuts the geometry into (none on a flat map; globe-subdivision.ts)
    updateGlobeSubdivision(
      terrainContext,
      renderOptions.defaultProjectionData.projectionTransition ?? 0,
      rawZoom,
    );

    // Follow the changes of the rendering pixel ratio (moving to another display, or
    // draw.setRenderScale()). The widths of the already baked retained batches no longer match
    // when the ratio changes, so they are discarded.
    const dpr = resolvePixelRatio(pixelRatio);
    if (engine.builtPixelRatio !== dpr) {
      if (engine.builtPixelRatio !== null) engine.storeRetainedCache?.invalidateAll();
      engine.builtPixelRatio = dpr;
    }

    return buildFrameState({
      gl,
      renderers: r,
      map,
      store,
      terrainContext,
      displayList,
      drape,
      renderOptions,
      zoom,
      rawZoom,
      dpr,
      terrainState,
      retainedAvailable: engine.storeRetainedCache !== null,
      overlayRenderers: dynamicOverlayRenderers,
      segments: slots.segments,
    });
  }

  // ---------------------------------------------------------------------------
  // render of a slot (maplibre calls it per slot)
  // ---------------------------------------------------------------------------

  function renderSlot(index: number, renderOptions: CustomRenderMethodInput): void {
    const { gl, renderers: r } = engine;
    // Nothing is drawn while the GPU side is missing (a lost context, before the restore)
    if (!gl || !r || gl.isContextLost()) return;
    // The slots are called in the order of the list (ascending index). An index that goes back
    // means a new frame. A frame where the last slot never arrived (right after slots were added
    // or removed, for example) is closed here as well
    if (engine.frame === null || index <= engine.frame.lastIndex) {
      engine.frame = beginFrame(renderOptions);
    }
    const frame = engine.frame;
    if (!frame) return;
    // Right after slots are removed, the render of a removed slot never arrives (it has been
    // removed from the map), but to be safe nothing outside the segments is drawn
    if (index >= frame.segments.length) return;

    const renderDeps: FrameRenderDeps = {
      gl,
      renderers: r,
      map,
      store,
      terrainContext,
      drape,
      customRenderers,
      featureCompanions,
      datasets,
      storeRetainedCache: engine.storeRetainedCache,
      selectionScope: renderScope.selection,
    };
    renderSegment(renderDeps, frame, index);
    frame.lastIndex = index;

    if (index === frame.segments.length - 1) {
      renderForeground(renderDeps, frame);
      engine.frame = null;
    }
  }

  /** Creates the CustomLayer of the slot at `index` (the first one is customLayer itself) */
  function makeSlotLayer(index: number): BaseCustomLayerInterface {
    return {
      id: renderSlotLayerId(index),
      type: 'custom',
      renderingMode: '3d',
      onAdd(mapInstance: MapLibreMap, glContext: WebGL2RenderingContext): void {
        engineAdd(mapInstance, glContext);
      },
      render(_gl: WebGL2RenderingContext | WebGLRenderingContext, renderOptions): void {
        renderSlot(index, renderOptions);
      },
      onRemove(): void {
        engineRemove();
      },
    };
  }

  /** Whether a feature renderer is still registered for some type */
  function isRegisteredRenderer(renderer: CustomFeatureHandler['renderer']): boolean {
    for (const registered of customRenderers.values()) {
      if (registered === renderer) return true;
    }
    return false;
  }

  const customLayer: CustomLayerInterface = {
    id: renderSlotLayerId(0),
    type: 'custom',
    renderingMode: '3d',

    onAdd(mapInstance: MapLibreMap, glContext: WebGL2RenderingContext): void {
      engineAdd(mapInstance, glContext);
    },

    // The offscreen pass of maplibre, before the main pass of the frame. Only the first slot
    // prepares here: the terrain state of the frame, which bakes the DEM atlas into its own
    // framebuffer when the terrain changed (maplibre resets its GL state after it; see
    // maplibre-coupling.md, "prerender")
    prerender(): void {
      const { gl } = engine;
      if (!gl || !engine.renderers || gl.isContextLost()) return;
      engine.preparedTerrainState = terrainResolver.resolve(gl);
    },

    // The first argument also accepts WebGL1, to match the declaration of CustomRenderMethod
    // (what is used is the WebGL2 context received in onAdd, so the body does not change).
    render(
      _gl: WebGL2RenderingContext | WebGLRenderingContext,
      renderOptions: CustomRenderMethodInput,
    ): void {
      renderSlot(0, renderOptions);
    },

    onRemove(): void {
      engineRemove();
    },

    addOverlayRenderer(renderer: CustomOverlayRenderer): () => void {
      dynamicOverlayRenderers.push(renderer);
      // An element involved in the rendering was added, so the prepared retained batches are
      // rebuilt
      engine.storeRetainedCache?.invalidateAll();
      // Only while the GPU side exists (otherwise buildGpuResources calls onAdd)
      if (engine.renderers && engine.gl && engine.mapInstance) {
        renderer.onAdd(engine.gl, engine.mapInstance);
      }
      return () => customLayer.removeOverlayRenderer(renderer);
    },

    removeOverlayRenderer(renderer: CustomOverlayRenderer): void {
      const index = dynamicOverlayRenderers.indexOf(renderer);
      if (index === -1) return;
      dynamicOverlayRenderers.splice(index, 1);
      engine.storeRetainedCache?.invalidateAll();
      // Its GPU resources exist only while the engine does
      if (engine.renderers && engine.gl) renderer.onRemove();
      engine.mapInstance?.triggerRepaint();
    },

    registerFeatureRenderer(type: string, renderer: CustomFeatureHandler['renderer']): () => void {
      const replaced = customRenderers.get(type);
      customRenderers.set(type, renderer);
      // Adding a custom type changes the classification of the features (whether they can be
      // retained)
      engine.storeRetainedCache?.invalidateAll();
      // Only while the GPU side exists (otherwise buildGpuResources calls onAdd)
      if (engine.renderers && engine.gl && engine.mapInstance) {
        // A renderer can serve several types: it is released only when no type uses it
        if (replaced && !isRegisteredRenderer(replaced)) replaced.onRemove();
        renderer.onAdd(engine.gl, engine.mapInstance);
      }
      return () => {
        if (customRenderers.get(type) !== renderer) return;
        customRenderers.delete(type);
        engine.storeRetainedCache?.invalidateAll();
        if (engine.renderers && engine.gl && !isRegisteredRenderer(renderer)) renderer.onRemove();
        engine.mapInstance?.triggerRepaint();
      };
    },

    getRenderSlots(): RenderSlot[] {
      return slots.getRenderSlots();
    },

    getSlotLayers(): BaseCustomLayerInterface[] {
      return slots.getSlotLayers();
    },
    getTerrainContext(): TerrainContext {
      return terrainContext;
    },

    hasPendingWork(): boolean {
      if (drape.hasPendingWork) return true;
      if (datasets?.hasPendingWork()) return true;
      for (const renderer of dynamicOverlayRenderers) {
        if (renderer.hasPendingWork?.()) return true;
      }
      return false;
    },

    refresh(): void {
      renderScope.earcut.clear();
      renderScope.styleRules.clear();
      displayList.invalidate();
      drape.invalidate();
      if (!engine.mapInstance) return;
      // The renderers and the retained batches read the configuration when they are built
      if (engine.renderers) {
        releaseGpuResources();
        buildGpuResources();
      }
      slots.sync();
      engine.mapInstance.triggerRepaint();
    },
  };

  // The first slot is customLayer itself. When there are separators, the following slots are
  // prepared here (the host adds them to the map in order from the first)
  slots.init(customLayer);

  return customLayer;
}
