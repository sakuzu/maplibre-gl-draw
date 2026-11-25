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
import type { EngineOverlayRenderer, FeatureTypeHandler } from '../../extension/index.js';
import type { FeatureStyleConfig } from '../../shared/config/feature-style.js';
import type { RenderingConfig } from '../../shared/config/rendering.js';
import type { SelectionUIConfig } from '../../shared/config/selection.js';
import type { AnchorProjector } from '../../shared/math/index.js';
import type { PixelRatioInput } from '../../shared/utils/pixel-ratio.js';
import { resolveContentPixelRatio, resolvePixelRatio } from '../../shared/utils/pixel-ratio.js';
import { drawnRowsOf } from '../../store/built-in/drawn-rows.js';
import type { DocumentAccess, DocumentTables } from '../../store/document-access.js';
import type { SpatialIndex } from '../../store/spatial/spatial-index.js';
import type { FeatureCompanionRegistry } from '../feature-companion.js';
import { updateGlobeSubdivision } from '../globe-subdivision.js';
import type { GpuLedger } from '../gpu-ledger.js';
import { beginRenderFrame } from '../shaders/frame.js';
import { createAnchorProjector } from '../terrain/anchor.js';
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
import type { ManySelection } from '../ui/bulk-selection.js';
import type { SelectionScope } from '../ui/selection-scope.js';
import { DisplayListCache } from './display-list.js';
import { DrapePlanner, isOpacityOnlyLayersChange } from './drape-planner.js';
import {
  type FrameRenderDeps,
  readManySelection,
  renderForeground,
  renderSegment,
} from './frame-render.js';
import { buildFrameState, type FrameState, manySelectedRows, StyleZoom } from './frame-state.js';
import { createRenderScope } from './render-scope.js';
import { disposeRenderers, initRenderers, type Renderers } from './renderers.js';
import { SlotManager } from './slot-manager.js';
import { type StackSlot, slotLayerId } from './slots.js';
import { drapeRowsOf } from './table-drape-rows.js';
import { TableLayerRenderer } from './table-retained.js';
import { TerrainResolver } from './terrain-resolver.js';

/**
 * Dependencies of CustomLayer
 *
 * @internal
 */
export interface CustomLayerDeps {
  map: MapLibreMap;
  /**
   * The layer over the Store; the layers are drawn from the rows of its tables (`getTables`) when
   * they are those of a built-in Store
   */
  store: DocumentAccess & Partial<DocumentTables>;
  spatialIndex: SpatialIndex;
  featureStyle: FeatureStyleConfig;
  selectionConfig: SelectionUIConfig;
  renderingConfig: RenderingConfig;
  /** Custom feature handlers (for the extension implementations) */
  customFeatureHandlers?: FeatureTypeHandler[];
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
  onSlotsChange?: (slots: StackSlot[]) => void;
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
   * @returns the function that removes it again (removeOverlay)
   */
  addOverlay(renderer: EngineOverlayRenderer): () => void;
  /** Removes an overlay renderer; it gets its onRemove when the GPU side exists */
  removeOverlay(renderer: EngineOverlayRenderer): void;
  /**
   * Registers the renderer of a custom feature type
   *
   * @returns the function that cancels the registration (it does not remove a later
   *   registration of the same type)
   */
  registerFeatureRenderer(type: string, renderer: FeatureTypeHandler['renderer']): () => void;
  /** The list of slots (the first = the backmost). Just itself when there is no separator */
  getStackSlots(): StackSlot[];
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
   * The anchor projection of this draw instance (the one of its terrain state), which its hit
   * testing and its selection UI project through while the terrain is on
   *
   * It returns null while the terrain is off or the layer is off the map, and the project of
   * MapLibre is used then.
   */
  readonly anchorProjector: AnchorProjector;
  /** The WebGL context of the map while the drawing is on it, or null */
  getGL(): WebGL2RenderingContext | null;
  /** What the drawing of this instance holds on the GPU, per part */
  getGpuLedger(): GpuLedger;
  /** The drawing of the layers from their rows (null while the GPU side is not built) */
  getTableRenderer(): TableLayerRenderer | null;
  /**
   * The reading of the selection its selection UI is drawn from, when many features are selected
   * and the layers are drawn from their rows (null otherwise: the features selected are read then)
   */
  getManySelection(): ManySelection | null;
  /**
   * The instance is gone: the GPU side is dropped if it is still there, and what is still in the
   * ledger was left behind. It is deleted and counted (`leakedBytes` of the ledger)
   */
  destroyGpu(): void;
  /**
   * Whether work remains that later frames finish without the host doing anything (see
   * `draw.hasPendingWork()`)
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
   * The drawing of the layers from their rows (null while not built, and while it is disabled by
   * the configuration: the immediate mode is used then)
   */
  tableRetained: TableLayerRenderer | null;
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
  const customRenderers = new Map<string, FeatureTypeHandler['renderer']>();
  if (customFeatureHandlers) {
    for (const handler of customFeatureHandlers) {
      customRenderers.set(handler.type, handler.renderer);
    }
  }

  const engine: EngineState = {
    gl: null,
    mapInstance: null,
    renderers: null,
    tableRetained: null,
    builtPixelRatio: null,
    unsubscribeStore: null,
    unwatchContextLoss: null,
    frame: null,
    preparedTerrainState: null,
  };
  /** The ordered list of the features to display (the immediate path; follows the Store) */
  const displayList = new DisplayListCache(store);
  // The drawing of the rows by kind is told once per instance (the renderer of the rows is made
  // again with the GL context)
  let toldByKind = false;
  const tellDrawnByKind = (): void => {
    if (toldByKind) return;
    toldByKind = true;
    console.warn(
      'The rows cannot be drawn in one draw on this GL: they are drawn by kind, a draw per run ' +
        'of one kind',
    );
  };
  const dynamicOverlayRenderers: EngineOverlayRenderer[] = [];

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
  // The anchor projection of this instance. It only takes effect in the frames where the terrain
  // is active (it returns null until setAnchorFrame is called, and again once the terrain state
  // is released), and on a map without terrain the project of MapLibre is used as before
  const anchorProjector = createAnchorProjector(terrainContext);
  const terrainResolver = new TerrainResolver(map, terrainContext, renderScope.gpu);
  const drape = new DrapePlanner({
    map,
    store,
    terrain: terrainContext,
    datasets,
    gpu: renderScope.gpu,
    // Read at each build, so a change of the rendering switches applies to the next one
    get timeSlicing() {
      return renderingConfig.timeSlicing;
    },
    // The layers drawn from their rows put their rows on the drape, without their features
    rows: (styles) => {
      if (renderingConfig.storeRetained === false) return null;
      const reader = drawnRowsOf(store.getTables?.());
      return reader ? drapeRowsOf(reader, store, styles) : null;
    },
    rowsRevision: () =>
      renderingConfig.storeRetained === false
        ? 0
        : (drawnRowsOf(store.getTables?.())?.revision ?? 0),
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

    // Subscribe to the Store changes to invalidate the earcut, style rule and retained batch
    // caches
    // Changes made while the layer was off the map were not seen
    displayList.invalidate();
    engine.unsubscribeStore = store.subscribe((changes) => {
      // A replacement of the whole document drops every cache of the features, whatever the
      // notification lists (the new document can reuse an ID with another shape)
      if (changes.reset === true) {
        renderScope.earcut.clear();
        renderScope.styleRules.clear();
        terrainContext.fillCache.clear();
      }
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

    // Release the terrain state of this instance (its anchor projection returns null again, and
    // hit testing goes back to the project of MapLibre)
    releaseTerrainContext(terrainContext);
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

    // A build that throws halfway gives back what it had made
    engine.renderers = renderScope.gpu.scope(gl, () =>
      initRenderers({
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
      }),
    );

    if (renderingConfig.storeRetained !== false) {
      // The layers are drawn from the rows of the built-in Store
      const reader = drawnRowsOf(store.getTables?.());
      if (reader) {
        engine.tableRetained = new TableLayerRenderer({
          gl,
          reader,
          store,
          ledger: renderScope.gpu,
          terrain: terrainContext,
          pixelRatio,
          requestRepaint: () => engine.mapInstance?.triggerRepaint(),
          timeSlicing: () => renderingConfig.timeSlicing !== false,
          drawnByKind: tellDrawnByKind,
        });
      }
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

    // Release the drawing of the rows too (before disposing the renderers)
    engine.tableRetained?.dispose();
    engine.tableRetained = null;
    engine.builtPixelRatio = null;

    // The DEM atlas, the drape renderers, and the plan and the index that point into the pack
    // uploaded to the drape renderer (the next frame collects and uploads again)
    terrainResolver.releaseGpu();
    drape.releaseGpu();
    setQuadDrapeFrame(terrainContext, null);

    disposeRenderers(r);
    engine.renderers = null;

    // Every part has given back what it held: what is still in the ledger was forgotten
    drainGpu();
  }

  /**
   * Deletes what is still in the ledger once the GPU side is gone, and tells it: 0 unless a part
   * forgot something. The sums of the ledger are checked as well
   */
  function drainGpu(): void {
    const { gpu } = renderScope;
    if (!gpu.audit()) console.warn('The sums of the GPU ledger do not agree with what it holds');
    if (!engine.gl) return;
    const left = gpu.drain(engine.gl);
    if (Object.keys(left).length > 0) {
      console.warn('GPU memory left behind by the drawing, now deleted:', left);
    }
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
    // The textures of the images not drawn for a while go, and an image drawn from a smaller
    // picture takes its whole picture again once there is room for it
    r.textureCache.sweep(Date.now());

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
    // draw.setScaleFactor()). The widths of the already baked retained batches no longer match
    // when the ratio changes, so they are discarded.
    const dpr = resolvePixelRatio(pixelRatio);
    if (engine.builtPixelRatio !== dpr) {
      if (engine.builtPixelRatio !== null) {
        engine.tableRetained?.reclassify();
      }
      engine.builtPixelRatio = dpr;
    }
    // The work of the tables and what this client hides and selects, before the frame is built
    engine.tableRetained?.beginFrame();

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
      contentDpr: resolveContentPixelRatio(pixelRatio),
      terrainState,
      rowsAvailable: engine.tableRetained !== null,
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
      tableRetained: engine.tableRetained,
      selectionScope: renderScope.selection,
      anchorProjector,
    };
    renderSegment(renderDeps, frame, index);
    frame.lastIndex = index;

    if (index === frame.segments.length - 1) {
      renderForeground(renderDeps, frame);
      engine.tableRetained?.endFrame();
      engine.frame = null;
    }
  }

  /** Creates the CustomLayer of the slot at `index` (the first one is customLayer itself) */
  function makeSlotLayer(index: number): BaseCustomLayerInterface {
    return {
      id: slotLayerId(index),
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
  function isRegisteredRenderer(renderer: FeatureTypeHandler['renderer']): boolean {
    for (const registered of customRenderers.values()) {
      if (registered === renderer) return true;
    }
    return false;
  }

  const customLayer: CustomLayerInterface = {
    id: slotLayerId(0),
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
      // What the drawing of the rows queued is written before the main pass
      engine.tableRetained?.prerender();
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

    addOverlay(renderer: EngineOverlayRenderer): () => void {
      dynamicOverlayRenderers.push(renderer);
      // An element involved in the rendering was added, so the prepared retained batches are
      // rebuilt
      engine.tableRetained?.reclassify();
      // Only while the GPU side exists (otherwise buildGpuResources calls onAdd)
      if (engine.renderers && engine.gl && engine.mapInstance) {
        renderer.onAdd(engine.gl, engine.mapInstance);
      }
      return () => customLayer.removeOverlay(renderer);
    },

    removeOverlay(renderer: EngineOverlayRenderer): void {
      const index = dynamicOverlayRenderers.indexOf(renderer);
      if (index === -1) return;
      dynamicOverlayRenderers.splice(index, 1);
      engine.tableRetained?.reclassify();
      // Its GPU resources exist only while the engine does
      if (engine.renderers && engine.gl) renderer.onRemove();
      engine.mapInstance?.triggerRepaint();
    },

    registerFeatureRenderer(type: string, renderer: FeatureTypeHandler['renderer']): () => void {
      const replaced = customRenderers.get(type);
      customRenderers.set(type, renderer);
      // Adding a custom type changes the classification of the features (whether they can be
      // retained)
      engine.tableRetained?.reclassify();
      // Only while the GPU side exists (otherwise buildGpuResources calls onAdd)
      if (engine.renderers && engine.gl && engine.mapInstance) {
        // A renderer can serve several types: it is released only when no type uses it
        if (replaced && !isRegisteredRenderer(replaced)) replaced.onRemove();
        renderer.onAdd(engine.gl, engine.mapInstance);
      }
      return () => {
        if (customRenderers.get(type) !== renderer) return;
        customRenderers.delete(type);
        engine.tableRetained?.reclassify();
        if (engine.renderers && engine.gl && !isRegisteredRenderer(renderer)) renderer.onRemove();
        engine.mapInstance?.triggerRepaint();
      };
    },

    getStackSlots(): StackSlot[] {
      return slots.getStackSlots();
    },

    getSlotLayers(): BaseCustomLayerInterface[] {
      return slots.getSlotLayers();
    },
    getTerrainContext(): TerrainContext {
      return terrainContext;
    },

    anchorProjector,

    getGL(): WebGL2RenderingContext | null {
      return engine.renderers ? engine.gl : null;
    },

    getGpuLedger(): GpuLedger {
      return renderScope.gpu;
    },

    getTableRenderer(): TableLayerRenderer | null {
      return engine.tableRetained;
    },

    getManySelection(): ManySelection | null {
      const { renderers, tableRetained } = engine;
      if (!renderers) return null;
      const reader = manySelectedRows(renderers, store, tableRetained !== null);
      if (!reader) return null;
      const deps = {
        renderers,
        store,
        tableRetained,
        customRenderers,
        featureCompanions,
        selectionScope: renderScope.selection,
      };
      return readManySelection(deps, reader)?.selection ?? null;
    },

    destroyGpu(): void {
      releaseGpuResources();
      drainGpu();
    },

    hasPendingWork(): boolean {
      if (drape.hasPendingWork) return true;
      if (engine.tableRetained?.hasPendingWork) return true;
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
