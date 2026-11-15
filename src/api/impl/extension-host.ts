// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The host of the extensions of one engine: the registries behind `draw.extensions`, the
 * contexts the extensions receive, and the route of the input to the plugins and the modes of
 * the contract
 *
 * The engine builds one host. The plugins live in the host itself: the select mode asks them
 * through {@link ExtensionHost.interactions} and the input reaches them through
 * {@link ExtensionHost.input}. Every other extension is installed into the registries the
 * engine already reads (the mode manager, the hit testing, the selection, the snapping and the
 * drawing), through the adapters of `adapters.ts`, `input.ts` and `render-context.ts`.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { HitTestTopmost } from '../../dispatcher/hit-test/topmost.js';
import type { ExtensionInputRoute } from '../../dispatcher/input-router.js';
import type { MouseNormalizedEvent } from '../../dispatcher/types.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import type { BBox } from '../../geometry/types.js';
import type { PluginInteractions } from '../../modes/handler.js';
import type { ModeManager } from '../../modes/manager.js';
import { createCoordinateTransform } from '../../shared/math/index.js';
import type { SketchController } from '../../sketches/sketch-controller.js';
import { DrawStore } from '../../store/draw-store.js';
import { createTransformFieldsRegistry } from '../../store/transform-roles.js';
import type { Feature as StoredFeature } from '../../store/types.js';
import type { FeatureCompanionRegistry } from '../../view/feature-companion.js';
import type { CustomLayerInterface } from '../../view/layer/index.js';
import type { Dataset } from '../datasets.js';
import type { Draw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { PluginContext } from '../extension/context.js';
import type { Plugin } from '../extension/plugin.js';
import type { Hit } from '../extension/provider.js';
import type { StoreView } from '../extension/store.js';
import type { LayerTableView as WebglLayerTableView } from '../extension/webgl.js';
import type { ExtensionsCollections } from '../extensions.js';
import type { Feature, FeatureGeometry, FeatureStyleResolved, LoadResult } from '../model.js';
import type { RuntimeOptions } from '../options.js';
import type { AdapterDeps } from './adapters.js';
import {
  adaptCompanionProvider,
  adaptHandleProvider,
  adaptSnapProvider,
  installFeatureType,
} from './adapters.js';
import { createAppliedStyles } from './applied-style.js';
import type { ContextServices, DrawingCommit, ModeServices } from './contexts.js';
import {
  createExtensionContext,
  createModeContext,
  createScreenContext,
  createSubscriptions,
  createTerrainSurface,
  toHit,
  toSelectionStyle,
} from './contexts.js';
import type { Context } from './engine-context.js';
import type { ExtensionRegistries, Installer } from './extensions.js';
import {
  BUILT_IN_TYPES,
  createExtensionsCollections,
  createRegistry,
  OVERRIDABLE_TYPES,
  styleRuleChannelOfType,
} from './extensions.js';
import { featureForExtension } from './feature-shape.js';
import { createGpuParts } from './gpu-parts.js';
import { bridgeMode, createInputRoute, deliverPointerLeave, toPointerEvent } from './input.js';
import { adaptGpuFeatureRenderer, createOverlayStack, terrainSurfaceOf } from './render-context.js';
import { validateExtension } from './validate-extension.js';

/**
 * What the host is built over
 *
 * @internal
 */
export interface ExtensionHostDeps {
  readonly map: MapLibreMap;
  readonly context: Context;
  readonly customLayer: CustomLayerInterface;
  readonly modeManager: ModeManager;
  readonly featureCompanions: FeatureCompanionRegistry;
  /** The sketches of the instance (the shape a mode draws is one of them) */
  readonly sketches: SketchController;
  /** The frontmost hit at a point, with the click tolerance */
  readonly hitTestTopmost: HitTestTopmost;
  /** A frontmost hit tester with another tolerance, in pixels */
  hitTestTopmostWith(tolerancePx: number): HitTestTopmost;
  /** The rows of the datasets to trace along (empty when snapping to them is off) */
  listTraceRows(bbox: BBox): Array<{ datasetId: string; rowIndex: number; feature: StoredFeature }>;
}

/**
 * The extensions of one engine
 *
 * @internal
 */
export interface ExtensionHost {
  /** Tells the host what a load wrote; an image the image mode placed is a commit of the mode */
  loaded(result: LoadResult, fromImageMode?: boolean): void;
  /** The collections of `draw.extensions` */
  readonly collections: ExtensionsCollections;
  /** The route of the input to the plugins and the modes of the contract */
  readonly input: ExtensionInputRoute;
  /** The interaction hooks of the plugins, which the select mode asks */
  readonly interactions: PluginInteractions;
  /** The frontmost hit at a point on the screen, in the shape of the contract */
  hitAt(point: { x: number; y: number }): Hit | null;
  /**
   * The commit `draw.mode.drawing.commit` asks of the modes of the contract while it runs (see
   * `ModeServices.drawingCommit`)
   */
  readonly drawingCommit: { current: DrawingCommit | null };
  /**
   * The look a feature is drawn with (`draw.features.getAppliedStyle`), which the renderers of
   * the custom types read from their render context: the look its type declares, the color of the
   * rule of its layer and its style
   */
  appliedStyle(feature: StoredFeature): FeatureStyleResolved;
  /**
   * Gives the host the draw instance the contexts hand out, the `style` option the looks of the
   * features start from, and the Store given in the options, whose notifications that reset the
   * document interrupt the current mode
   */
  attach(draw: Draw, styleOptions: () => RuntimeOptions['style'], documentStore?: StoreView): void;
  /** Starts listening to the map (the pointer leaving it) */
  start(): void;
  /** Removes every extension and stops listening */
  destroy(): void;
}

/**
 * Builds the host of the extensions of an engine
 *
 * @internal
 */
/** How long what the rest of the page takes is kept, in milliseconds */
const ROW_ROOM_READ_MS = 1_000;

export function createExtensionHost(deps: ExtensionHostDeps): ExtensionHost {
  const { map, context, customLayer, modeManager, featureCompanions } = deps;
  const { store } = context;
  const terrain = customLayer.getTerrainContext();
  let destroyed = false;

  let attached: Draw | null = null;
  const getDraw = (): Draw => {
    if (!attached) {
      throw new DrawError(
        'invalidState',
        'The draw instance is not attached to its extensions yet',
      );
    }
    return attached;
  };

  const screen = createScreenContext({
    map,
    pixelRatio: context.pixelRatioSource,
  });

  // The fields the custom types declare, which the drags and the Store of the library read
  const transformFields = createTransformFieldsRegistry();
  if (store instanceof DrawStore) store.setTransformFields(transformFields);

  // The looks of the features, with the looks the custom types declare. The `style` option is the
  // one of the draw instance, once it is attached
  let styleOptions: () => RuntimeOptions['style'] = () => undefined;
  const appliedStyles = createAppliedStyles({
    getLayer: (id) => store.getLayer(id),
    getStyleOptions: () => styleOptions(),
    styleRuleChannelOf: (type, geometry) =>
      styleRuleChannelOfType(registries.featureTypes, type, geometry),
  });
  const appliedStyle = (feature: StoredFeature): FeatureStyleResolved => appliedStyles.of(feature);

  const adapterDeps: AdapterDeps = {
    map,
    store,
    screen,
    clickTolerancePx: context.options.clickTolerance,
    hitTestService: context.hitTestService,
    boxSelectionRegistry: context.boxSelectionRegistry,
    selectionExtensions: context.selectionScope.extensions,
    auxiliaryHandles: context.selectionScope.auxiliaryHandles,
    featureCompanions,
    snapTargets: context.snapTargets,
    customLayer,
    spatialIndex: context.spatialIndex,
    surface: (state) => terrainSurfaceOf(state, createTerrainSurface),
    registerSnapProvider: (provider) => context.snapService.register(provider),
    shapes: context.shapes,
    selectionBoxOf: (featureId) => getDraw().rendered.getSelectionBox(featureId),
    selectionStyle: () =>
      toSelectionStyle(
        context.selectionStyle,
        context.renderingConfig.boxSelectionStyle,
        getDraw().options.get().selectionStyle,
      ),
    transformFields,
    appliedStyles,
    appliedStyle,
  };
  const overlays = createOverlayStack(customLayer, adapterDeps);
  const rowRoom = { limitBytes: 0, readAt: Number.NEGATIVE_INFINITY };
  const gpuParts = createGpuParts({
    ledger: customLayer.getGpuLedger(),
    // What the device has left once the rest of the page is counted, the heap of the documents
    // and the other instances among it: the sum stays under the limit of the device. Reading the
    // rest may walk a document, and it moves slowly, so an allocation does not read it each time
    rowLimitBytes: () => {
      const now = performance.now();
      if (now >= rowRoom.readAt + ROW_ROOM_READ_MS) {
        const { limitBytes, bytes } = getDraw().memory.get();
        rowRoom.limitBytes = limitBytes - (bytes - customLayer.getGpuLedger().rowBytesHeld);
        rowRoom.readAt = now;
      }
      return rowRoom.limitBytes;
    },
  });

  /** An installer that installs nothing once the instance is destroyed */
  const guarded = <T>(installer: Installer<T>): Installer<T> => ({
    ...installer,
    install: (name, value) => (destroyed ? () => {} : installer.install(name, value)),
  });

  const registries: ExtensionRegistries = {
    plugins: createRegistry<Plugin>(
      guarded({
        kind: 'plugin',
        validate: (_, plugin) => validateExtension('plugin', plugin),
        install: (_, plugin) => installPlugin(plugin),
      }),
    ),
    modes: createRegistry(
      guarded({
        kind: 'mode',
        validate: (_, factory) => validateExtension('mode', factory),
        isTakenElsewhere: (name) => modeManager.hasMode(name),
        install: (name, factory) =>
          modeManager.registerMode(name, () => {
            const handle = createModeContext(modeServices, screen);
            try {
              return bridgeMode(
                name,
                factory(handle.context),
                handle.dispose,
                handle.entering,
                // An interrupted mode leaves no snap behind (leaving it is cleared by the engine)
                () => context.snapService.clear(),
              );
            } catch (error) {
              handle.dispose();
              throw error;
            }
          }),
      }),
    ),
    featureTypes: createRegistry(
      guarded({
        kind: 'feature type',
        validate: (_, definition) => validateExtension('feature type', definition),
        isTakenElsewhere: (name) => BUILT_IN_TYPES.has(name),
        install: (name, definition) =>
          installFeatureType(definition, adapterDeps, OVERRIDABLE_TYPES.has(name)),
      }),
    ),
    overlays: createRegistry(
      guarded({
        kind: 'overlay',
        validate: (_, overlay) => validateExtension('overlay', overlay),
        install: (_, overlay) => overlays.add(overlay),
      }),
    ),
    snapProviders: createRegistry(
      guarded({
        kind: 'snap provider',
        validate: (_, provider) => validateExtension('snap provider', provider),
        install: (_, provider) => context.snapService.register(adaptSnapProvider(provider, screen)),
      }),
    ),
    handleProviders: createRegistry(
      guarded({
        kind: 'handle provider',
        validate: (_, provider) => validateExtension('handle provider', provider),
        isTakenElsewhere: (name) => context.selectionScope.auxiliaryHandles.get(name) !== undefined,
        install: (_, provider) =>
          context.selectionScope.auxiliaryHandles.register(
            adaptHandleProvider(provider, adapterDeps),
          ),
      }),
    ),
    companionProviders: createRegistry(
      guarded({
        kind: 'companion provider',
        validate: (_, provider) => validateExtension('companion provider', provider),
        isTakenElsewhere: (name) => featureCompanions.get(name) !== undefined,
        install: (_, provider) =>
          featureCompanions.register(adaptCompanionProvider(provider, adapterDeps)),
      }),
    ),
  };
  const collections = createExtensionsCollections(registries);

  const services: ContextServices = {
    map,
    store,
    terrain,
    pixelRatio: context.pixelRatioSource,
    autoNameGenerator: context.autoNameGenerator,
    messages: context.messages,
    selectionExtensions: context.selectionScope.extensions,
    spatialIndex: context.spatialIndex,
    modeManager,
    getDraw,
    collections,
  };

  const view = createCoordinateTransform(map);
  const unproject = (point: { x: number; y: number }) => view.unproject(point);
  const drawingCommit: { current: DrawingCommit | null } = { current: null };
  const modeServices: ModeServices = {
    ...services,
    hitTestTopmost(point, tolerancePx) {
      const tester =
        tolerancePx === undefined || tolerancePx === context.options.clickTolerance
          ? deps.hitTestTopmost
          : deps.hitTestTopmostWith(tolerancePx);
      return tester(point);
    },
    distanceToFeaturePx(feature, point) {
      const hit = context.hitTestService.hitTestAll(point, unproject, [feature])[0];
      if (!hit) return 0;
      const onePixel = Math.abs(
        unproject({ x: point.x + 1, y: point.y }).lng - unproject(point).lng,
      );
      return onePixel > 0 ? hit.distance / onePixel : 0;
    },
    snapPoint(point) {
      const lngLat = unproject(point);
      const handler = modeManager.getHandler();
      const prefer = handler?.getSnapPreference?.() ?? undefined;
      return context.snapService.resolve({ lng: lngLat.lng, lat: lngLat.lat }, point, {
        zoom: map.getZoom(),
        modifiers: { shift: false, ctrl: false, alt: false, meta: false },
        ...(prefer && { preferFeature: prefer }),
      });
    },
    listTraceRows(bbox: BBox) {
      return deps.listTraceRows(bbox);
    },
    getWritableLayerId: context.getWritableLayerId,
    sketches: deps.sketches,
    generateId: context.generateFeatureId,
    // Read when a feature is committed, so a change of the option applies at once
    get scaleWithZoom() {
      return context.options.scaleWithZoom;
    },
    selectionStyle: context.selectionStyle,
    boxSelectionStyle: context.renderingConfig.boxSelectionStyle,
    notifyDrawCommit: (feature) => announceDrawCommit(feature),
    drawingCommit,
  };

  /**
   * Installs a plugin: calls its onAdd with a context that records what the plugin adds, and
   * returns the removal, which calls its onRemove and removes what it added
   */
  function installPlugin(plugin: Plugin): () => void {
    const subscriptions = createSubscriptions();
    const added: Array<() => void> = [];
    const disposeAll = (): void => {
      subscriptions.endAll();
      for (let i = added.length - 1; i >= 0; i--) added[i]();
      added.length = 0;
    };
    const base = createExtensionContext(services, screen, subscriptions);
    const pluginContext: PluginContext = {
      get draw() {
        return getDraw();
      },
      store: base.store,
      on: base.on,
      off: base.off,
      once: base.once,
      terrain: base.terrain,
      names: base.names,
      messages: base.messages,
      screen: base.screen,
      invalidate: base.invalidate,
      extensions: createExtensionsCollections(registries, (remove) => added.push(remove)),
      webgl: {
        addOverlay(definition) {
          const part = gpuParts.add(definition, plugin.name);
          const remove = overlays.addPart(part);
          added.push(() => {
            remove();
            part.release();
          });
        },
        addFeatureRenderer(featureType, definition) {
          if (!registries.featureTypes.has(featureType)) {
            throw new DrawError('notFound', `There is no feature type ${featureType}`);
          }
          const part = gpuParts.add(definition, plugin.name);
          const remove = customLayer.registerFeatureRenderer(
            featureType,
            adaptGpuFeatureRenderer(featureType, part, adapterDeps),
          );
          added.push(() => {
            remove();
            part.release();
          });
        },
        rows: (id) =>
          featureTablesInternals(store.tables)?.view(id) ?? datasetRowsView(getDraw(), id),
        draggedRows: () => getDraw().rendered.getDraggedRows(),
      },
    };
    try {
      plugin.onAdd(pluginContext);
    } catch (error) {
      disposeAll();
      throw error;
    }
    return () => {
      try {
        plugin.onRemove?.();
      } catch (error) {
        console.error(`Error in plugin "${plugin.name}" onRemove:`, error);
      } finally {
        disposeAll();
      }
    };
  }

  /** Calls a hook of every plugin in turn; one that throws is reported and skipped */
  function eachPlugin(hook: string, call: (plugin: Plugin) => boolean | undefined): boolean {
    for (const plugin of registries.plugins.values()) {
      try {
        if (call(plugin) === true) return true;
      } catch (error) {
        console.error(`Error in plugin "${plugin.name}" ${hook}:`, error);
      }
    }
    return false;
  }
  /** Tells every plugin that a drawing mode created a feature */
  function announceDrawCommit(feature: Feature): void {
    eachPlugin('onFeatureCommit', (plugin) => {
      plugin.onFeatureCommit?.(feature);
      return false;
    });
  }
  const featureOf = (id: string): Feature | undefined => {
    const stored = store.getFeature(id);
    return stored === undefined ? undefined : featureForExtension(stored);
  };
  const click =
    (hook: 'onSelectedFeatureClick' | 'onFeatureDoubleClick') =>
    (featureId: string, event?: MouseNormalizedEvent): boolean => {
      const feature = featureOf(featureId);
      if (!feature || !event) return false;
      return eachPlugin(hook, (plugin) => {
        const handler = plugin.selectMode?.[hook];
        return handler?.call(plugin.selectMode, feature, toPointerEvent(event)) === true;
      });
    };
  const interactions: PluginInteractions = {
    handleFeatureClick: click('onSelectedFeatureClick'),
    handleFeatureDoubleClick: click('onFeatureDoubleClick'),
    isPluginInteracting: () =>
      eachPlugin('isActive', (plugin) => plugin.exclusive?.isActive() === true),
    finishPluginInteraction() {
      eachPlugin('finish', (plugin) => {
        plugin.exclusive?.finish?.();
        return false;
      });
    },
    cancelPluginInteraction() {
      eachPlugin('cancel', (plugin) => {
        plugin.exclusive?.cancel?.();
        return false;
      });
    },
    getPluginInteractionContainer() {
      let container: HTMLElement | null = null;
      eachPlugin('container', (plugin) => {
        if (plugin.exclusive?.isActive() !== true) return false;
        container = plugin.exclusive.container?.() ?? null;
        return container !== null;
      });
      return container;
    },
    notifyFeatureCreated(featureId) {
      const feature = featureOf(featureId);
      if (feature) announceDrawCommit(feature);
    },
  };

  const input = createInputRoute(() => registries.plugins.values());
  const onPointerLeave = (): void =>
    deliverPointerLeave(registries.plugins.values(), modeManager.getHandler());
  let listening = false;
  const watches: Array<() => void> = [];

  /**
   * What a load wrote: the image the image mode asked the application for (`requestImage`) and
   * placed is the commit of the image mode, which the plugins hear of as the commits of the other
   * drawing modes
   */
  function loaded(result: LoadResult, fromImageMode = false): void {
    if (!fromImageMode || result.format !== 'image') return;
    for (const id of result.featureIds) {
      const feature = featureOf(id);
      if (feature) announceDrawCommit(feature);
    }
  }

  return {
    collections,
    input,
    interactions,
    loaded,
    drawingCommit,
    hitAt: (point) =>
      toHit(modeServices.hitTestTopmost(point), (feature) =>
        modeServices.distanceToFeaturePx(feature, point),
      ),
    appliedStyle,
    attach(draw, options, documentStore) {
      attached = draw;
      styleOptions = options;
      // A Store that replaces its whole document says so with `reset`: the mode drops what it
      // was drawing, as it does for an Escape
      if (documentStore) {
        watches.push(
          documentStore.subscribe((changes) => {
            if (changes.reset === true && !destroyed) modeManager.notifyStateReset();
          }),
        );
      }
    },
    start() {
      if (listening || destroyed) return;
      listening = true;
      map.getCanvasContainer().addEventListener('mouseleave', onPointerLeave);
    },
    destroy() {
      if (destroyed) return;
      for (const stop of watches.splice(0)) stop();
      if (listening) {
        listening = false;
        map.getCanvasContainer().removeEventListener('mouseleave', onPointerLeave);
      }
      // The plugins go first, with what they added, then the rest in the reverse order
      registries.plugins.clear();
      registries.companionProviders.clear();
      registries.handleProviders.clear();
      registries.snapProviders.clear();
      registries.overlays.clear();
      registries.featureTypes.clear();
      registries.modes.clear();
      // The Store may serve another instance after this one
      if (store instanceof DrawStore && store.transformFields === transformFields) {
        store.setTransformFields(null);
      }
      destroyed = true;
    },
  };
}

/** The views of the rows of the datasets, one each (`Webgl.rows`) */
const datasetViews = new WeakMap<Dataset, WebglLayerTableView>();

/**
 * The rows of a dataset as `ctx.webgl.rows` reads them (undefined for an id of no dataset): the
 * rows drawn after the thinning, read by their indices
 */
function datasetRowsView(draw: Draw, id: string): WebglLayerTableView | undefined {
  const dataset = draw.datasets.get(id);
  if (!dataset) return undefined;
  let view = datasetViews.get(dataset);
  if (!view) {
    const geometryOf = (row: number): FeatureGeometry | null => {
      const geometry = dataset.getRow(row)?.geometry ?? null;
      return geometry === null || geometry.type === 'GeometryCollection' ? null : geometry;
    };
    view = {
      listDrawnRows: (bbox) => dataset.listDrawnRows([bbox[0], bbox[1], bbox[2], bbox[3]]),
      getDrawnRowsVersion: () => dataset.getDrawnRowsRevision(),
      findRow: (rowId) => dataset.findRow(rowId) ?? undefined,
      getRowType: (row) => dataset.getRowType(row),
      getRowPoint: (row) => dataset.getRowPoint(row),
      getRowGeometry: geometryOf,
      getRowValue: (row, key) =>
        (dataset.getRow(row)?.properties as Record<string, unknown> | null | undefined)?.[key],
      getRowStyle: (row) => dataset.getRow(row)?.style,
    };
    datasetViews.set(dataset, view);
  }
  return view;
}
