// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Instance API
 *
 * Provides the basic operations of a MapLibreGLDraw instance (getting the Map / Store,
 * switching the Mode, Metadata, destroy). It gathers the related methods that are small and
 * not large enough to deserve a file of their own.
 */

import type {
  CustomLayerInterface as MapLibreCustomLayerInterface,
  Map as MapLibreMap,
} from 'maplibre-gl';
import type { InputRouter } from '../dispatcher/input-router.js';
import type { InputNormalizer } from '../dispatcher/normalizer.js';
import type { ModeManager } from '../modes/manager.js';
import type { PluginManager } from '../plugins/plugin-manager.js';
import type { AutoNameGenerator } from '../shared/utils/name-generator.js';
import type { PixelRatioSource } from '../shared/utils/pixel-ratio.js';
import type { EventBridge } from '../store/event-bridge.js';
import type { Store, StoreView } from '../store/store.js';
import type { Metadata, Mode } from '../store/types.js';
import type { RenderCoordinator } from '../view/coordinator.js';
import type { CustomLayerInterface } from '../view/layer/index.js';
import type { RenderSlot } from '../view/layer/slots.js';
import type { TerrainRenderState } from '../view/terrain/context.js';
import { INITIAL_DRAPE_DEBUG } from '../view/terrain/context.js';
import {
  getTerrainDrapeDebug,
  getTerrainRenderState,
  INACTIVE_TERRAIN_STATE,
} from '../view/terrain/state.js';
import type { MapLibreGLDraw, TerrainDiagnostics, TerrainRenderDiagnostics } from './api.js';

export type InstanceApi = Pick<
  MapLibreGLDraw,
  | 'getMap'
  | 'getStore'
  | 'getMode'
  | 'setMode'
  | 'getMetadata'
  | 'setMetadata'
  | 'isReadOnly'
  | 'setReadOnly'
  | 'isInteractionLocked'
  | 'setInteractionLock'
  | 'getRenderSlots'
  | 'getRenderScale'
  | 'setRenderScale'
  | 'getPixelRatio'
  | 'getTerrainDiagnostics'
  | 'hasPendingWork'
  | 'isLocallyHidden'
  | 'getLocallyHidden'
  | 'setLocallyHidden'
  | 'destroy'
>;

export interface InstanceApiDeps {
  map: MapLibreMap;
  store: Store;
  modeManager: ModeManager;
  eventBridge: EventBridge;
  renderCoordinator: RenderCoordinator;
  inputRouter: InputRouter;
  inputNormalizer: InputNormalizer;
  customLayer: MapLibreCustomLayerInterface | CustomLayerInterface;
  autoNameGenerator: AutoNameGenerator;
  /** Needed in order to unregister the plugins on destroy (releasing the extension point
   * registries) */
  pluginManager: PluginManager;
  /** The source of the render scale (the actual object held by the Context; setRenderScale
   * rewrites it) */
  pixelRatioSource: PixelRatioSource;
}

export function createInstanceApi(deps: InstanceApiDeps): InstanceApi {
  const {
    map,
    store,
    modeManager,
    eventBridge,
    renderCoordinator,
    inputRouter,
    inputNormalizer,
    customLayer,
    autoNameGenerator,
    pixelRatioSource,
    pluginManager,
  } = deps;

  return {
    getMap(): MapLibreMap {
      return map;
    },

    getStore(): StoreView {
      return store;
    },

    getMode(): Mode {
      return modeManager.getMode();
    },

    setMode(mode: Mode): boolean {
      // Following the SSoT, call Store.setMode() through the ModeManager
      // The event is emitted from the Store through the EventBridge
      return modeManager.setMode(mode);
    },

    getMetadata(): Metadata {
      return store.getMetadata();
    },

    setMetadata(metadata: Partial<Metadata>): boolean {
      return store.setMetadata(metadata);
    },

    isReadOnly(): boolean {
      return store.isReadOnly();
    },

    setReadOnly(value: boolean): void {
      store.setReadOnly(value);
    },

    isInteractionLocked(): boolean {
      return store.isInteractionLocked();
    },

    setInteractionLock(value: boolean): void {
      store.setInteractionLock(value);
      // If drawing is in progress at the moment the interaction lock is applied, discard the
      // tentative geometry and go back to select. Switching to select through the modeManager
      // makes the onStop of the drawing handler clean up the tentative geometry. The setMode
      // gate lets a transition to select through, so this holds naturally.
      if (value && store.getMode() !== 'select') {
        modeManager.setMode('select');
      }
    },

    getRenderSlots(): RenderSlot[] {
      // For a CustomLayer without frames (an external implementation), return the single
      // conventional layer as one interval
      if ('getRenderSlots' in customLayer && typeof customLayer.getRenderSlots === 'function') {
        return customLayer.getRenderSlots();
      }
      return [{ layerId: customLayer.id, from: 0, to: store.getLayerOrder().length }];
    },

    getRenderScale(): number {
      return pixelRatioSource.getRenderScale();
    },

    setRenderScale(scale: number): void {
      // The retained batches that have already been baked are rebuilt by looking at the
      // scale, so prompt a redraw only when it has changed (on the next frame the CustomLayer
      // and the datasets each start rebuilding).
      if (!pixelRatioSource.setRenderScale(scale)) return;
      map.triggerRepaint();
    },

    getPixelRatio(): number {
      return pixelRatioSource.resolve();
    },

    getTerrainDiagnostics(): TerrainDiagnostics {
      // The terrain state is held by the CustomLayer of this instance (an external
      // implementation without one reports the inactive state)
      const terrain =
        'getTerrainContext' in customLayer && typeof customLayer.getTerrainContext === 'function'
          ? customLayer.getTerrainContext()
          : null;
      return Object.freeze({
        render: toRenderDiagnostics(
          terrain ? getTerrainRenderState(terrain) : INACTIVE_TERRAIN_STATE,
        ),
        drape: Object.freeze({
          ...(terrain ? getTerrainDrapeDebug(terrain) : INITIAL_DRAPE_DEBUG),
        }),
      });
    },

    hasPendingWork(): boolean {
      // The engine of this instance knows its deferred work (an external implementation of the
      // layer reports none)
      return (
        'hasPendingWork' in customLayer &&
        typeof customLayer.hasPendingWork === 'function' &&
        customLayer.hasPendingWork()
      );
    },

    isLocallyHidden(id: string): boolean {
      return store.isLocallyHidden(id);
    },

    getLocallyHidden(): ReadonlySet<string> {
      return store.getLocallyHidden();
    },

    setLocallyHidden(id: string, hidden: boolean): void {
      store.setLocallyHidden(id, hidden);
    },

    destroy(): void {
      inputRouter.stop();
      inputNormalizer.detach();
      eventBridge.stop();
      modeManager.stop();
      renderCoordinator.stop();
      autoNameGenerator.dispose();

      // Unregister the plugins so that each one runs its onUninstall (timers, subscriptions and
      // anything else it holds outside the draw instance). The extension point registries
      // themselves belong to this instance and are cleared with it, so no provider of the
      // destroyed instance can reach a live one.
      for (const name of pluginManager.getPluginNames()) {
        pluginManager.unregister(name);
      }

      // There can be several frames, so remove all of them
      const slotLayers =
        'getSlotLayers' in customLayer && typeof customLayer.getSlotLayers === 'function'
          ? customLayer.getSlotLayers()
          : [customLayer];
      for (const slotLayer of slotLayers) {
        if (map.getLayer(slotLayer.id)) {
          map.removeLayer(slotLayer.id);
        }
      }
    },
  };
}

/** The plain numbers of a terrain state, without the GL objects and the internal plans */
function toRenderDiagnostics(state: TerrainRenderState): TerrainRenderDiagnostics {
  return Object.freeze({
    active: state.active,
    atlasRect: [...state.atlasRect] as [number, number, number, number],
    atlasSize: [...state.atlasSize] as [number, number],
    elevationScale: state.elevationScale,
    liftMeters: state.liftMeters,
    stepMeters: state.stepMeters,
    stepGrid: state.stepGrid,
    generation: state.generation,
  });
}
