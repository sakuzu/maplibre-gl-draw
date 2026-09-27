// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The engine of a draw instance: it builds the context, the rendering, the input handling,
 * the modes, the extensions and the events, and registers the release of each one for
 * destroy.
 *
 * The Store is the single source of truth: input goes through the dispatcher into the Store,
 * and the view and the events follow the Store's notifications. The draw instance is built
 * on the pieces the engine returns.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { createDisplayInteractions } from '../../dataset/interaction.js';
import type { DatasetManager } from '../../dataset/manager.js';
import { createDatasetManager } from '../../dataset/manager.js';
import { effectiveZoomForCamera } from '../../dataset/thinning.js';
import { TriangulationScheduler } from '../../dataset/triangulation.js';
import { toleranceDegrees } from '../../dispatcher/hit-test/local-frame.js';
import { createTopmostHitTester } from '../../dispatcher/hit-test/topmost.js';
import type { InputRouter } from '../../dispatcher/input-router.js';
import { createInputRouter } from '../../dispatcher/input-router.js';
import { createInputNormalizer } from '../../dispatcher/normalizer.js';
import {
  DrawImageMode,
  drawCircleMode,
  drawFreehandMode,
  drawLineMode,
  drawPointMode,
  drawPolygonMode,
} from '../../modes/draw/index.js';
import type { EngineModeContext } from '../../modes/handler.js';
import type { ModeManager } from '../../modes/manager.js';
import { SelectMode } from '../../modes/select/mode.js';
import { SnapIndicatorRenderer } from '../../snapping/indicator.js';
import { createDisplaySnapProviders } from '../../snapping/providers/display.js';
import type { Mode } from '../../store/types.js';
import { createRenderCoordinator } from '../../view/coordinator.js';
import { createFeatureCompanionRegistry } from '../../view/feature-companion.js';
import { attachSlotLayers } from '../../view/layer/attach.js';
import type { CustomLayerInterface } from '../../view/layer/index.js';
import { createCustomLayer } from '../../view/layer/index.js';
import {
  DEFAULT_VIEWPORT_EXPANSION_FACTOR,
  getExpandedViewportBounds,
} from '../../view/viewport.js';
import type { Context, EngineOptions } from './engine-context.js';
import { createContext } from './engine-context.js';
import type { EventHub } from './events.js';
import { connectEngineEvents, connectStoreEvents, createEventHub } from './events.js';
import type { ExtensionHost } from './extension-host.js';
import { createExtensionHost } from './extension-host.js';

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
 * The pieces of one draw instance
 *
 * @internal
 */
export interface Engine {
  /** The map the instance draws on */
  readonly map: MapLibreMap;
  /** The context: the Store, the services and the resolved options */
  readonly context: Context;
  /** The custom layer that draws the document and the datasets */
  readonly customLayer: CustomLayerInterface;
  /** The modes */
  readonly modeManager: ModeManager;
  /** The datasets */
  readonly datasets: DatasetManager;
  /** The router of the input (the tests hand it synthetic events) */
  readonly inputRouter: InputRouter;
  /** The extensions of the extension contract: plugins, modes, feature types and the rest */
  readonly extensions: ExtensionHost;
  /**
   * The emitter of `DrawEvents`, the events of the instance that the application and the
   * extensions subscribe to
   */
  readonly events: EventHub;
  /** The switches of the input and the rendering that change while the instance runs */
  readonly runtime: {
    /** Changes how far the mouse moves before a press becomes a drag, in pixels */
    setDragThreshold(px: number): void;
    /** Turns the time slicing of the triangulation and of the drape on or off */
    setTimeSlicing(enabled: boolean): void;
  };
  /** Whether destroy has run */
  isDestroyed(): boolean;
  /**
   * Enters the default mode of the options. The engine does it by itself unless it was built
   * with `deferDefaultMode`, so that the draw instance the modes reach is attached first
   */
  enterDefaultMode(): void;
  /** Releases everything the engine acquired, in the reverse order (a second call is ignored) */
  destroy(): void;
}

/**
 * Builds the engine of a draw instance on a map
 *
 * @internal
 */
export function createEngine(
  map: MapLibreMap,
  options: EngineOptions = {},
  build: {
    /** Leaves the entering of the default mode to `enterDefaultMode` */
    deferDefaultMode?: boolean;
  } = {},
): Engine {
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

  const triangulationScheduler = new TriangulationScheduler();
  triangulationScheduler.setSlicing(renderingConfig.timeSlicing !== false);

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
    // The providers are called when the displayed range changed
    onViewportChange: (handler) => {
      // A destroyed instance attaches nothing to the map again
      if (teardown.done) return () => {};
      map.on('moveend', handler);
      return () => {
        map.off('moveend', handler);
      };
    },
    requestRepaint: () => map.triggerRepaint(),
    pixelRatio: pixelRatioSource,
    // Read so that the collision thinning knows "the size of the point that is
    // actually drawn"
    featureStyle,
    // The time slicing of the triangulation belongs to this instance (its queue
    // and its finished triangles are never shared with another instance).
    // Rendering that draws complete frames (printing, thumbnails) turns off time
    // slicing and triangulates on the spot: setting the threshold to infinity
    // puts every polygon on the synchronous path
    triangulationScheduler,
    // Read when a dataset is added, so a change at runtime applies to the datasets added after
    get timeSlicing() {
      return renderingConfig.timeSlicing;
    },
    // Announce the datasets that come and go and their reordering
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
  const topmostDeps: Parameters<typeof createTopmostHitTester>[0] = {
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
    // Read at each hit, so a change of the option applies at once
    get clickTolerancePx() {
      return context.options.clickTolerance;
    },
    companions: featureCompanions,
  };
  const hitTestTopmost = createTopmostHitTester(topmostDeps);

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
    // Additions and removals of separators are announced (layerStack.changed)
    isExternalEntry: context.isExternalEntry,
    onSlotsChange: (slots) => eventEmitter.emit('layerStack.change', { slots }),
    // The failure to load the image of an Image feature (an error event)
    onImageError: (featureId, error) =>
      eventEmitter.emit('load.error', { source: 'image', featureId, error }),
  });

  // 3.5 Add the snapping indicator as a built-in overlay
  // (it comes in front of the selection UI because order: 'overlay')
  customLayer.addOverlay(new SnapIndicatorRenderer({ snapService }));

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
  modeManager.registerMode('draw_image', () => new DrawImageMode());

  // 6.5 Create the host of the extensions of the extension contract, and add the built-in
  // modes written to that contract through it
  const extensions = createExtensionHost({
    map,
    context,
    customLayer,
    modeManager,
    featureCompanions,
    hitTestTopmost,
    hitTestTopmostWith: (tolerancePx) =>
      createTopmostHitTester({
        ...topmostDeps,
        toleranceLngLat: (point) => toleranceDegrees(unproject, point, tolerancePx),
        clickTolerancePx: tolerancePx,
      }),
    listTraceRows: (bbox) =>
      snapService.isDatasetsEnabled()
        ? displaySnap.queryRows(bbox).map(({ datasetId, feature }) => ({
            datasetId,
            rowIndex: datasets.get(datasetId)?.findRow(feature.id) ?? -1,
            feature,
          }))
        : [],
  });
  extensions.collections.modes.addMany([
    { name: 'draw_point', factory: drawPointMode },
    { name: 'draw_line', factory: drawLineMode },
    { name: 'draw_polygon', factory: drawPolygonMode },
    { name: 'draw_circle', factory: drawCircleMode },
    { name: 'draw_freehand', factory: drawFreehandMode },
  ]);

  // The position of the click being handled, for what a click causes
  let clickPosition: [number, number] | null = null;

  // 7. The context of the modes of the engine (select and image)
  const modeContext: EngineModeContext = {
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
    plugins: extensions.interactions,
    generateFeatureId: context.generateFeatureId,
    getCurrentLayerId: context.getWritableLayerId,
    // Read when a feature is committed, so a change of the option applies at once
    get scaleWithZoom() {
      return context.options.scaleWithZoom;
    },
    setMode: (mode: Mode) => modeManager.setMode(mode),
    getClickPosition: () => clickPosition,
    // The key that temporarily disables shared vertices is shared with the
    // disableKey of the snapping
    snapOptions: context.snapOptions,
  };
  modeManager.setContext(modeContext);

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
    displayInteractions,
    // Emit a click in select mode as a public event (draw.map.click)
    notifyMapClick: (payload) => eventEmitter.emit('map.click', payload),
    trackClick: (lngLat) => {
      clickPosition = lngLat;
    },
    snapService,
    extensionInput: extensions.input,
  });

  // 8. Set up
  // The events of the instance follow the Store and the signals of the engine
  const events = createEventHub();
  const stopStoreEvents = connectStoreEvents(events, store);
  const stopEngineEvents = connectEngineEvents(events, eventEmitter, {
    hitAt: (point) => extensions.hitAt(point),
  });
  teardown.add(() => {
    stopStoreEvents();
    stopEngineEvents();
    events.clear();
  });
  renderCoordinator.start();

  // Keep the frames of the stacking order on the map. They are added as soon as the style
  // accepts layers, whenever the draw instance is created (before, during or after the map
  // loads), and they are restored after a style change. The native layers of the separators
  // are placed between the frames by the host, which receives layerStack.changed
  teardown.add(attachSlotLayers(map, () => customLayer.getSlotLayers()));

  inputNormalizer.attach();
  inputRouter.start();
  extensions.start();
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

  // Set the default mode (unless the caller attaches the public object of the modes first)
  const enterDefaultMode = (): void => {
    if (!teardown.done) modeManager.setMode(context.options.defaultMode);
  };
  if (!build.deferDefaultMode) enterDefaultMode();

  // 9. The release of what was set up above: the input, the modes, the rendering and the
  // layers on the map, then the rest in the reverse order
  teardown.add(() => {
    inputRouter.stop();
    inputNormalizer.detach();
    modeManager.stop();
    renderCoordinator.stop();
    context.autoNameGenerator.dispose();
    // There can be several frames, so remove all of them
    for (const layer of customLayer.getSlotLayers()) {
      if (map.getLayer(layer.id)) map.removeLayer(layer.id);
    }
    // After the plugins are removed (their onRemove can still read the index)
    spatialIndex.destroy();
  });
  // The extensions go first, while everything they use is there
  teardown.add(() => extensions.destroy());

  return {
    map,
    context,
    customLayer,
    modeManager,
    datasets,
    inputRouter,
    extensions,
    events,
    runtime: {
      setDragThreshold: (px) => inputNormalizer.setDragThreshold(px),
      setTimeSlicing(enabled) {
        renderingConfig.timeSlicing = enabled;
        triangulationScheduler.setSlicing(enabled);
      },
    },
    isDestroyed: () => teardown.done,
    enterDefaultMode,
    destroy: () => teardown.run(),
  };
}
