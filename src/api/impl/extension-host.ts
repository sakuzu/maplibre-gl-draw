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

import type { BBox } from 'geojson';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { HitTestTopmost } from '../../dispatcher/hit-test/topmost.js';
import type { ExtensionInputRoute } from '../../dispatcher/input-router.js';
import type { MouseNormalizedEvent } from '../../dispatcher/types.js';
import type { PluginInteractions } from '../../modes/handler.js';
import type { ModeManager } from '../../modes/manager.js';
import type { BoundingBox, Feature as StoredFeature } from '../../store/types.js';
import type { FeatureCompanionRegistry } from '../../view/feature-companion.js';
import type { CustomLayerInterface } from '../../view/layer/index.js';
import type { Draw } from '../draw.js';
import type { PluginContext } from '../extension/context.js';
import type { Plugin } from '../extension/plugin.js';
import type { StoreView } from '../extension/store.js';
import type { ExtensionsCollections } from '../extensions.js';
import type { Feature } from '../model.js';
import type { AdapterDeps } from './adapters.js';
import {
  adaptCompanionProvider,
  adaptHandleProvider,
  adaptSnapProvider,
  installFeatureType,
} from './adapters.js';
import type { ContextServices, ModeServices } from './contexts.js';
import {
  createExtensionContext,
  createModeContext,
  createScreenContext,
  createSubscriptions,
  createTerrainAnchors,
} from './contexts.js';
import type { Context } from './engine-context.js';
import type { ExtensionRegistries, Installer } from './extensions.js';
import { createExtensionsCollections, createRegistry } from './extensions.js';
import { preparePatch } from './features.js';
import { bridgeMode, createInputRoute, deliverPointerLeave, toPointerEvent } from './input.js';
import { createOverlayStack, terrainAnchorsOf } from './render-context.js';

/** The feature types of the engine, which a custom type cannot take the name of */
const BUILT_IN_TYPES: ReadonlySet<string> = new Set([
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
  'Image',
  'Circle',
  'Freehand',
]);

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
  /** The frontmost hit at a point, with the click tolerance */
  readonly hitTestTopmost: HitTestTopmost;
  /** A frontmost hit tester with another tolerance, in pixels */
  hitTestTopmostWith(tolerancePx: number): HitTestTopmost;
  /** The rows of the datasets to trace along (empty when snapping to them is off) */
  listTraceRows(
    bbox: BoundingBox,
  ): Array<{ datasetId: string; rowIndex: number; feature: StoredFeature }>;
}

/**
 * The extensions of one engine
 *
 * @internal
 */
export interface ExtensionHost {
  /** The collections of `draw.extensions` */
  readonly collections: ExtensionsCollections;
  /** The route of the input to the plugins and the modes of the contract */
  readonly input: ExtensionInputRoute;
  /** The interaction hooks of the plugins, which the select mode asks */
  readonly interactions: PluginInteractions;
  /**
   * Gives the host the draw instance the contexts hand out, and the Store given in the
   * options, whose notifications that reset the document interrupt the current mode
   */
  attach(draw: Draw, documentStore?: StoreView): void;
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
export function createExtensionHost(deps: ExtensionHostDeps): ExtensionHost {
  const { map, context, customLayer, modeManager, featureCompanions } = deps;
  const { store } = context;
  const terrain = customLayer.getTerrainContext();
  let destroyed = false;

  let attached: Draw | null = null;
  const getDraw = (): Draw => {
    if (!attached) throw new Error('The draw instance is not attached to its extensions yet');
    return attached;
  };

  const screen = createScreenContext({
    map,
    pixelRatio: context.pixelRatioSource,
    selectionExtensions: context.selectionScope.extensions,
  });

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
    anchors: (state) => terrainAnchorsOf(state, createTerrainAnchors),
    registerSnapProvider: (provider) => context.snapService.register(provider),
    applyPatch(featureId, patch, final) {
      const feature = store.getFeature(featureId);
      if (!feature || store.isReadOnly()) return;
      store.updateFeature(featureId, preparePatch(feature, patch), { isIntermediate: !final });
    },
  };
  const overlays = createOverlayStack(customLayer, adapterDeps);

  /** An installer that installs nothing once the instance is destroyed */
  const guarded = <T>(installer: Installer<T>): Installer<T> => ({
    ...installer,
    install: (name, value) => (destroyed ? () => {} : installer.install(name, value)),
  });

  const registries: ExtensionRegistries = {
    plugins: createRegistry<Plugin>(
      guarded({
        kind: 'plugin',
        validate(_, plugin) {
          if (typeof plugin.onAdd !== 'function') {
            throw new TypeError('A plugin must have onAdd');
          }
        },
        install: (_, plugin) => installPlugin(plugin),
      }),
    ),
    modes: createRegistry(
      guarded({
        kind: 'mode',
        validate(_, factory) {
          if (typeof factory !== 'function') throw new TypeError('A mode must be a function');
        },
        isTakenElsewhere: (name) => modeManager.hasMode(name),
        install: (name, factory) =>
          modeManager.registerMode(name, () => {
            const handle = createModeContext(modeServices, screen);
            try {
              return bridgeMode(name, factory(handle.context), handle.dispose);
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
        validate(_, definition) {
          if (typeof definition.renderer?.draw !== 'function') {
            throw new TypeError('A feature type must have a renderer');
          }
        },
        isTakenElsewhere: (name) => BUILT_IN_TYPES.has(name),
        install: (_, definition) => installFeatureType(definition, adapterDeps),
      }),
    ),
    overlays: createRegistry(
      guarded({
        kind: 'overlay',
        validate(_, overlay) {
          if (typeof overlay.draw !== 'function') throw new TypeError('An overlay must draw');
        },
        install: (_, overlay) => overlays.add(overlay),
      }),
    ),
    snapProviders: createRegistry(
      guarded({
        kind: 'snap provider',
        validate(_, provider) {
          if (typeof provider.candidates !== 'function') {
            throw new TypeError('A snap provider must have candidates');
          }
        },
        install: (_, provider) => context.snapService.register(adaptSnapProvider(provider, screen)),
      }),
    ),
    handleProviders: createRegistry(
      guarded({
        kind: 'handle provider',
        validate(_, provider) {
          if (typeof provider.handles !== 'function' || typeof provider.onDrag !== 'function') {
            throw new TypeError('A handle provider must have handles and onDrag');
          }
        },
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
        validate(_, provider) {
          if (typeof provider.has !== 'function' || typeof provider.hitTest !== 'function') {
            throw new TypeError('A companion provider must have has and hitTest');
          }
        },
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
    selectionExtensions: context.selectionScope.extensions,
    spatialIndex: context.spatialIndex,
    modeManager,
    getDraw,
    collections,
  };

  const unproject = (point: { x: number; y: number }) => map.unproject([point.x, point.y]);
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
      return deps.listTraceRows({ minX: bbox[0], minY: bbox[1], maxX: bbox[2], maxY: bbox[3] });
    },
    getWritableLayerId: context.getWritableLayerId,
    generateId: context.generateFeatureId,
    scaleWithZoom: context.options.scaleWithZoom,
    selectionStyle: context.selectionStyle,
    boxSelectionStyle: context.renderingConfig.boxSelectionStyle,
    notifyDrawCommit: (feature) => announceDrawCommit(feature),
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
      screen: base.screen,
      invalidate: base.invalidate,
      drawing: base.drawing,
      extensions: createExtensionsCollections(registries, (remove) => added.push(remove)),
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
    eachPlugin('onDrawCommit', (plugin) => {
      plugin.interaction?.onDrawCommit?.(feature);
      return false;
    });
  }
  const featureOf = (id: string): Feature | undefined =>
    store.getFeature(id) as Feature | undefined;
  const click =
    (hook: 'onFeatureClick' | 'onFeatureDoubleClick') =>
    (featureId: string, event?: MouseNormalizedEvent): boolean => {
      const feature = featureOf(featureId);
      if (!feature || !event) return false;
      return eachPlugin(hook, (plugin) => {
        const handler = plugin.interaction?.[hook];
        return handler?.call(plugin.interaction, feature, toPointerEvent(event)) === true;
      });
    };
  const interactions: PluginInteractions = {
    filterSelectionCandidates(candidateIds) {
      let filtered = candidateIds;
      eachPlugin('filterSelection', (plugin) => {
        const filter = plugin.interaction?.filterSelection;
        if (filter) filtered = filter.call(plugin.interaction, filtered);
        return false;
      });
      return filtered;
    },
    handleFeatureClick: click('onFeatureClick'),
    handleFeatureDoubleClick: click('onFeatureDoubleClick'),
    isPluginInteracting: () =>
      eachPlugin('isBusy', (plugin) => plugin.interaction?.isBusy?.() === true),
    finishPluginInteraction() {
      eachPlugin('finish', (plugin) => {
        plugin.interaction?.finish?.();
        return false;
      });
    },
    cancelPluginInteraction() {
      eachPlugin('cancel', (plugin) => {
        plugin.interaction?.cancel?.();
        return false;
      });
    },
    getPluginInteractionContainer() {
      let container: HTMLElement | null = null;
      eachPlugin('container', (plugin) => {
        if (plugin.interaction?.isBusy?.() !== true) return false;
        container = plugin.interaction.container?.() ?? null;
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
   * The image mode asks the application for a file (`image.requested`), and the application
   * places the image by loading the file. The image that load places is the commit of the
   * image mode, which the plugins hear of as the commits of the other drawing modes
   */
  function watchImageCommits(draw: Draw): void {
    let requested = false;
    watches.push(
      draw.on('image.requested', () => {
        requested = true;
      }),
      draw.on('document.loaded', ({ result }) => {
        if (!requested || result.format !== 'image') return;
        requested = false;
        for (const id of result.featureIds) {
          const feature = featureOf(id);
          if (feature) announceDrawCommit(feature);
        }
      }),
    );
  }

  return {
    collections,
    input,
    interactions,
    attach(draw, documentStore) {
      attached = draw;
      watchImageCommits(draw);
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
      destroyed = true;
    },
  };
}
