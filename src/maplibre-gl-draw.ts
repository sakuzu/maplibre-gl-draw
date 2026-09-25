// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The factory of a draw instance: it builds the context, the event bridge, the rendering,
 * the input handling, the modes and the plugin manager, and registers the release of each
 * one for destroy.
 *
 * The Store is the single source of truth: input goes through the dispatcher into the Store,
 * and the view and the events follow the Store's notifications.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';

import type { MapLibreGLDraw } from './api/api.js';
import { createDrawAPI } from './api/api.js';
import type { Options } from './api/context.js';
import { createContext } from './api/context.js';
import { createImportExportAPI } from './api/import-export/index.js';
import { toleranceDegrees } from './dispatcher/hit-test/local-frame.js';
import { createTopmostHitTester } from './dispatcher/hit-test/topmost.js';
import { createInputRouter } from './dispatcher/input-router.js';
import { createInputNormalizer } from './dispatcher/normalizer.js';
import { createDisplayInteractions } from './display/interaction.js';
import { createDatasetManager } from './display/manager.js';
import { effectiveZoomForCamera } from './display/thinning.js';
import { TriangulationScheduler } from './display/triangulation.js';
import {
  DrawCircleMode,
  DrawFreehandMode,
  DrawImageMode,
  DrawLineMode,
  DrawPointMode,
  DrawPolygonMode,
} from './modes/draw/index.js';
import type { ModeContext } from './modes/handler.js';
import { SelectMode } from './modes/select/mode.js';
import type { PluginContext } from './plugins/plugin.js';
import { createPluginContext } from './plugins/plugin-context.js';
import { createPluginManager } from './plugins/plugin-manager.js';
import { SnapIndicatorRenderer } from './snapping/indicator.js';
import { createDisplaySnapProviders } from './snapping/providers/display.js';
import { EventBridgeImpl } from './store/event-bridge.js';
import type { Mode } from './store/types.js';
import { createRenderCoordinator } from './view/coordinator.js';
import { createFeatureCompanionRegistry } from './view/feature-companion.js';
import { attachSlotLayers } from './view/layer/attach.js';
import { createCustomLayer } from './view/layer/index.js';
import { DEFAULT_VIEWPORT_EXPANSION_FACTOR, getExpandedViewportBounds } from './view/viewport.js';

// Re-export of the types
export type { EventPayloads, MapLibreGLDraw } from './api/api.js';
export type { Options } from './api/context.js';
export type { ImportExportAPI } from './api/import-export/index.js';
export type { Data, LoadResult, Metadata } from './store/types.js';

/**
 * The releases of one draw instance, run in the reverse order of the acquisitions
 *
 * Each resource is registered right where it is acquired, so nothing acquired can be missed
 * by destroy. Running is done once: a second run is ignored. A release that throws does not
 * stop the others; the first error is rethrown after all of them have run.
 */
function createTeardown() {
  const releases: Array<() => void> = [];
  let done = false;
  return {
    get done(): boolean {
      return done;
    },
    add(release: () => void): void {
      releases.push(release);
    },
    run(): void {
      if (done) return;
      done = true;
      let firstError: unknown = null;
      while (releases.length > 0) {
        const release = releases.pop() as () => void;
        try {
          release();
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError !== null) throw firstError;
    },
  };
}

/**
 * Creates a draw instance on a MapLibre map: the drawing and editing tools, their rendering and
 * their input handling.
 *
 * It can be called before, while or after the map loads. The render layers are added as soon
 * as the style accepts layers, and added again after `setStyle`. Unless
 * `initDefaultLayer: false` is given, the document starts with one empty layer. The instance
 * turns off the map's box zoom (Shift + drag selects features instead) and gives it back on
 * {@link MapLibreGLDraw.destroy}. Several instances can share a page, each on its own map.
 *
 * @param map the MapLibre map to draw on
 * @param options the options; every one can be omitted (see {@link Options})
 * @returns the draw instance
 *
 * @example
 * ```typescript
 * import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';
 * import * as maplibregl from 'maplibre-gl';
 *
 * const map = new maplibregl.Map({
 *   container: 'map',
 *   style: 'https://demotiles.maplibre.org/style.json',
 *   center: [139.767, 35.681],
 *   zoom: 12,
 * });
 * const draw = createMapLibreGLDraw(map, { defaultMode: 'select' });
 *
 * draw.setMode('draw_polygon');
 * draw.on('draw.feature.create', ({ feature }) => console.log('Created', feature.id));
 * ```
 */
export function createMapLibreGLDraw(map: MapLibreMap, options: Options = {}): MapLibreGLDraw {
  // 1. Create the context
  const context = createContext(map, options);
  const {
    store,
    modeManager,
    eventEmitter,
    spatialIndex,
    hitTestService,
    featureStyle,
    selectionStyle,
    renderingConfig,
    topology,
    trace,
    snapService,
    pixelRatioSource,
  } = context;

  // Everything acquired below is released by destroy, in the reverse order
  const teardown = createTeardown();
  // The registrations of the extension points belong to this instance and end with it
  teardown.add(() => {
    context.selectionScope.clear();
    context.snapTargets.clear();
  });

  // 2. Create the EventBridge
  const eventBridge = new EventBridgeImpl(store, eventEmitter);

  // 2.5 Create the manager of the datasets.
  // Culls with the same expanded viewport as the rendering loop, and calls the
  // provider on a change of the displayed range (moveend). It never touches the
  // Store.
  const datasets = createDatasetManager({
    getViewportBounds: () => getExpandedViewportBounds(map, DEFAULT_VIEWPORT_EXPANSION_FACTOR),
    getZoom: () => map.getZoom(),
    // The band of the collision thinning is decided by "the shallowest
    // effective zoom on screen" (pitch correction)
    getEffectiveZoom: () => effectiveZoomForCamera(map),
    onViewportChange: (handler) => {
      // A destroyed instance attaches nothing to the map again
      if (teardown.done) return () => {};
      // The end of a pitch operation also arrives as moveend, but pitchend is
      // subscribed as well so that it is not missed because of implementation
      // differences (recomputing the band is a no-op for the same band, so
      // doing it twice is cheap)
      map.on('moveend', handler);
      map.on('pitchend', handler);
      return () => {
        map.off('moveend', handler);
        map.off('pitchend', handler);
      };
    },
    requestRepaint: () => map.triggerRepaint(),
    pixelRatio: pixelRatioSource,
    // Read so that the collision thinning knows "the size of the point that is
    // actually drawn"
    featureStyle,
    // The time slicing of the triangulation belongs to this instance (its queue
    // and its finished triangles are never shared with another instance).
    // Rendering that "cannot wait" (printing, thumbnails) turns off time
    // slicing and triangulates on the spot: setting the threshold to infinity
    // puts every polygon on the synchronous path
    triangulationScheduler:
      renderingConfig.asyncTriangulation === false
        ? new TriangulationScheduler({ vertexThreshold: Number.POSITIVE_INFINITY })
        : new TriangulationScheduler(),
    // Announce the datasets that come and go and their reordering (draw.dataset.add,
    // draw.dataset.remove and draw.dataset.reorder)
    onDatasetAdd: (datasetId) => eventEmitter.emit('dataset.add', { datasetId }),
    onDatasetRemove: (datasetId) => eventEmitter.emit('dataset.remove', { datasetId }),
    onDatasetsReorder: (order) => eventEmitter.emit('dataset.reorder', { order }),
  });
  // Also disposes of the timers and the subscriptions of the datasets
  teardown.add(() => datasets.destroy());

  // 2.6 Hit testing with a unified z traversal.
  // Walks the features of the Store and the datasets in a
  // single stacking order (above-store -> the stacking order from the front ->
  // below-store) and returns the frontmost one.
  // The select mode and the interception of the datasets see
  // the same result.
  // The providers of companion rendering and companion hits are held one per
  // draw instance (the same scope as the renderers of custom feature types).
  // If they were shared, the provider of the hidden renderer used for printing,
  // thumbnails and previews would intercept with the geometry of its
  // own Store.
  const featureCompanions = createFeatureCompanionRegistry();

  const unproject = (p: { x: number; y: number }) => map.unproject([p.x, p.y]);
  const hitTestTopmost = createTopmostHitTester({
    store,
    hitTestService,
    unproject,
    // The same bearing-independent tolerance as the HitTestService
    toleranceLngLat: (point) => toleranceDegrees(unproject, point, context.options.clickTolerance),
    datasets,
    // Context of the companion hits (feature companion). A companion decides
    // its hit by its appearance in screen px, so the projection, the zoom and
    // the tolerance are passed.
    project: (lngLat) => {
      const projected = map.project(lngLat);
      return { x: projected.x, y: projected.y };
    },
    getZoom: () => map.getZoom(),
    clickTolerancePx: context.options.clickTolerance,
    companions: featureCompanions,
  });

  // 2.7 Snapping to data (datasets).
  // Adds the vertices, edges and intersections of the displayed datasets as
  // snapping candidates. The data itself is only read, and whether it is
  // enabled is held by options.datasets of the SnapService.
  const displaySnap = createDisplaySnapProviders({
    datasets,
    store,
    spatialIndex,
    snapTargets: context.snapTargets,
    isEnabled: () => snapService.isDatasetsEnabled(),
    // The resolved messages table of this instance (the description of an intersection)
    messages: context.messages,
  });
  for (const provider of displaySnap.providers) {
    teardown.add(snapService.register(provider));
  }

  // 3. Create the CustomLayer
  const customLayer = createCustomLayer({
    map,
    store,
    spatialIndex,
    featureStyle,
    selectionConfig: selectionStyle,
    renderingConfig,
    datasets,
    pixelRatio: pixelRatioSource,
    featureCompanions,
    // The selection UI extension points, the auxiliary handles and the thinned handle sets of
    // this instance (the modes hit test against the same scope)
    selectionScope: context.selectionScope,
    // The separators of the stacking order (external entries) and the frames.
    // Additions and removals of separators are announced by an event
    // (draw.renderslots.change)
    isExternalEntry: context.isExternalEntry,
    onSlotsChange: (slots) => eventEmitter.emit('renderslots.change', { slots }),
    // The failure to load the image of an Image feature (draw.load.error)
    onImageError: (featureId, error) =>
      eventEmitter.emit('load.error', { source: 'image', featureId, error }),
  });

  // 3.5 Add the snapping indicator as a built-in overlay
  // (it comes in front of the selection UI because order: 'overlay')
  customLayer.addOverlayRenderer(new SnapIndicatorRenderer({ snapService }));

  // Repaint when the snapping result changes (the Store does not change, so
  // the RenderCoordinator does not run)
  const repaintOnSnapChange = () => map.triggerRepaint();
  eventEmitter.on('snap.change', repaintOnSnapChange);
  teardown.add(() => eventEmitter.off('snap.change', repaintOnSnapChange));

  // 4. Create the RenderCoordinator (triggers a repaint automatically when the
  // Store changes)
  const renderCoordinator = createRenderCoordinator({ map, store });

  // 5. Set up the ModeManager
  modeManager.registerMode('select', () => new SelectMode());
  modeManager.registerMode('draw_point', () => new DrawPointMode());
  modeManager.registerMode('draw_line', () => new DrawLineMode());
  modeManager.registerMode('draw_polygon', () => new DrawPolygonMode());
  modeManager.registerMode('draw_image', () => new DrawImageMode());
  modeManager.registerMode('draw_circle', () => new DrawCircleMode());
  modeManager.registerMode('draw_freehand', () => new DrawFreehandMode());

  // 6. Create the PluginManager.
  // The PluginContext is initialized lazily after the PluginManager is created
  let pluginContext: PluginContext | null = null;
  const pluginManager = createPluginManager(() => {
    if (!pluginContext) {
      throw new Error('PluginContext not initialized');
    }
    return pluginContext;
  }, modeManager);

  // 7. Create the import/export API
  const importExportAPI = createImportExportAPI(context);

  const modeContext: ModeContext = {
    map,
    store,
    spatialIndex,
    hitTestService,
    hitTestTopmost,
    featureCompanions,
    selectionScope: context.selectionScope,
    eventEmitter,
    selectionStyle,
    topology,
    trace,
    autoNameGenerator: context.autoNameGenerator,
    boxSelectionRegistry: context.boxSelectionRegistry,
    pluginManager,
    generateFeatureId: context.generateFeatureId,
    getCurrentLayerId: context.getWritableLayerId,
    scaleWithZoom: context.options.scaleWithZoom,
    setMode: (mode: Mode) => modeManager.setMode(mode),
    // The key that temporarily disables shared vertices is shared with the
    // disableKey of the snapping
    snapOptions: context.snapOptions,
    // The only opening through which a mode learns about snapping (the
    // SnapService itself is not passed)
    getSnapResult: () => snapService?.getResult() ?? null,
    // The opening that resolves a snap target on data into a feature (read by
    // the tracing)
    getDatasetFeature: (datasetId, featureId) => displaySnap.getFeature(datasetId, featureId),
    // The features of the data put on the edge graph of the tracing (empty
    // when snapping to data is disabled)
    getDatasetTraceFeatures: (bbox) =>
      snapService.isDatasetsEnabled() ? displaySnap.queryFeatures(bbox) : [],
  };
  modeManager.setContext(modeContext);

  // 7. Initialize the PluginContext.
  // Helper function that looks up which layer an item belongs to
  const findLayerForItem = (itemId: string): string | undefined => {
    for (const layer of store.getAllLayers()) {
      if (layer.order.includes(itemId)) {
        return layer.id;
      }
    }
    return undefined;
  };

  // Helper function that looks up which group a feature belongs to
  const findGroupForFeature = (featureId: string): string | undefined => {
    for (const group of store.getAllGroups()) {
      if (group.featureIds.includes(featureId)) {
        return group.id;
      }
    }
    return undefined;
  };

  // Initialize the PluginContext.
  // The implementations of all PluginContext methods are gathered in
  // createPluginContext.
  // The draw instance is referenced lazily (through the closure, to cope
  // with the circular initialization).
  let drawApi: MapLibreGLDraw | null = null;
  pluginContext = createPluginContext({
    store,
    eventEmitter,
    spatialIndex,
    getActiveLayerId: context.getActiveLayerId,
    findLayerForItem,
    findGroupForFeature,
    getModeManager: () => modeManager,
    // The anchors and the selection extents of this instance (never another instance's)
    terrain: customLayer.getTerrainContext(),
    selectionExtensions: context.selectionScope.extensions,
    getDraw: () => {
      if (!drawApi) {
        throw new Error('MapLibreGLDraw not initialized');
      }
      return drawApi;
    },
  });

  // 7. Create the InputNormalizer and the InputRouter.
  // The hit testing of the datasets comes in as an
  // interception of the InputRouter.
  // The delivery target is decided by the result of the unified z traversal
  // (only the dataset in front receives it).
  const displayInteractions = createDisplayInteractions({
    manager: datasets,
    hitTestTopmost: (event) => hitTestTopmost(event.point),
    // Emit the resolved result of a click as a public event
    // (draw.dataset.click)
    notifyClick: (payload) => eventEmitter.emit('dataset.click', payload),
  });

  // The drag threshold of the options is the one of the mouse (a finger and a pen take a
  // larger one of their own)
  const inputNormalizer = createInputNormalizer(map, {
    dragThreshold: context.options.dragThreshold,
  });
  const inputRouter = createInputRouter({
    normalizer: inputNormalizer,
    modeManager,
    context: modeContext,
    map,
    pluginManager,
    displayInteractions,
    // Emit a click in select mode as a public event (draw.map.click)
    notifyMapClick: (payload) => eventEmitter.emit('map.click', payload),
    snapService,
  });

  // 7. Set up
  eventBridge.start();
  renderCoordinator.start();

  // Keep the render slots on the map. The slots are added as soon as the style
  // accepts layers, whenever the draw instance is created (before, during or
  // after the map loads), and they are restored after a style change. The
  // native layers of the separators are placed between the slots by the host,
  // which receives 'draw.renderslots.change'
  teardown.add(attachSlotLayers(map, () => customLayer.getSlotLayers()));

  inputNormalizer.attach();
  inputRouter.start();
  modeManager.start();

  // Disable the boxZoom of MapLibre (because Shift + drag is used for box
  // selection), and give it back in the state it was found in: the host or another draw
  // instance may have turned it off already.
  // It must be called after inputNormalizer.attach()
  const boxZoomWasEnabled = map.boxZoom.isEnabled();
  map.boxZoom.disable();
  teardown.add(() => {
    if (boxZoomWasEnabled) map.boxZoom.enable();
    else map.boxZoom.disable();
  });

  // Set the default mode
  modeManager.setMode(context.options.defaultMode);

  // 9. Create the public API
  drawApi = createDrawAPI(
    context,
    { inputNormalizer, inputRouter },
    eventBridge,
    customLayer,
    importExportAPI,
    { modeManager, renderCoordinator },
    { pluginManager, spatialIndex, datasets, featureCompanions },
  );

  // The public API releases what it created itself (the input, the modes, the rendering, the
  // plugins and the layers on the map) first, then the rest goes in the reverse order
  teardown.add(drawApi.destroy);
  drawApi.destroy = () => teardown.run();
  ignoreRegistrationsAfterDestroy(drawApi, () => teardown.done);

  return drawApi;
}

/**
 * Makes the registrations of a destroyed instance do nothing
 *
 * Every other call on a destroyed instance works on its inert Store and reaches neither the
 * map nor a timer, but a registration would install something (a plugin, a mode, a renderer,
 * a provider) that nothing is left to release. They are ignored instead and return a cancel
 * function that does nothing.
 */
function ignoreRegistrationsAfterDestroy(draw: MapLibreGLDraw, isDestroyed: () => boolean): void {
  const noop = (): void => {};
  const guard = <A extends unknown[], R>(
    fn: (...args: A) => R,
    whenDestroyed: R,
  ): ((...args: A) => R) => {
    return (...args: A) => (isDestroyed() ? whenDestroyed : fn(...args));
  };
  draw.addPlugin = guard(draw.addPlugin, noop);
  draw.registerMode = guard(draw.registerMode, noop);
  draw.registerFeatureHandler = guard(draw.registerFeatureHandler, noop);
  draw.addOverlayRenderer = guard(draw.addOverlayRenderer, noop);
  draw.registerAuxiliaryHandleProvider = guard(draw.registerAuxiliaryHandleProvider, noop);
  draw.registerFeatureCompanionProvider = guard(draw.registerFeatureCompanionProvider, noop);
  draw.snapping.register = guard(draw.snapping.register, noop);
}
