// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Extension API
 *
 * Provides the extension point API of MapLibreGLDraw.
 *   - addPlugin / getPluginApi: plugin registration / lookup
 *   - registerMode: registers a custom mode
 *   - registerFeatureHandler: registers a custom feature handler (registers the renderer /
 *     hitTest / boxSelection / boundingBox / resize calculator / snapping candidates at once)
 *   - registerAuxiliaryHandleProvider: registers a provider of auxiliary handles (handles of
 *     a plugin's own that are neither vertices nor resize handles)
 *   - registerFeatureCompanionProvider: registers a provider of companion rendering and
 *     companion hits (things drawn at the z just below the feature and grabbable in the same
 *     z order)
 *   - addOverlayRenderer: adds a custom overlay renderer
 *
 * Every registration returns the function that cancels it.
 */

import type { BoxSelectionStrategyRegistry } from '../dispatcher/hit-test/box-strategy.js';
import type { HitTestService } from '../dispatcher/hit-test/service.js';
import type { CustomFeatureHandler, CustomOverlayRenderer } from '../extension/index.js';
import type { ModeHandler } from '../modes/handler.js';
import type { ModeManager } from '../modes/manager.js';
import type { Plugin } from '../plugins/plugin.js';
import type { PluginManager } from '../plugins/plugin-manager.js';
import type { SnapTargetsRegistry } from '../snapping/custom-targets.js';
import type { SpatialIndex } from '../store/spatial/spatial-index.js';
import type { Mode } from '../store/types.js';
import type {
  FeatureCompanionProvider,
  FeatureCompanionRegistry,
} from '../view/feature-companion.js';
import type { CustomLayerInterface } from '../view/layer/index.js';
import type { AuxiliaryHandleProvider } from '../view/ui/auxiliary-handles.js';
import type { SelectionScope } from '../view/ui/selection-scope.js';
import type { MapLibreGLDraw } from './api.js';

export type ExtensionApi = Pick<
  MapLibreGLDraw,
  | 'addPlugin'
  | 'getPluginApi'
  | 'registerMode'
  | 'registerFeatureHandler'
  | 'registerAuxiliaryHandleProvider'
  | 'registerFeatureCompanionProvider'
  | 'addOverlayRenderer'
>;

export interface ExtensionApiDeps {
  pluginManager: PluginManager;
  modeManager: ModeManager;
  spatialIndex: SpatialIndex;
  hitTestService: HitTestService;
  boxSelectionRegistry: BoxSelectionStrategyRegistry;
  customLayer: CustomLayerInterface;
  /** The providers of companion rendering and companion hits (those of this draw instance) */
  featureCompanions: FeatureCompanionRegistry;
  /**
   * The selection scope of this draw instance (selection UI extension points and auxiliary
   * handles). Registrations go here, never into a module-level registry
   */
  selectionScope: SelectionScope;
  /** The snapping candidates of the custom feature types of this draw instance */
  snapTargets: SnapTargetsRegistry;
}

export function createExtensionApi(deps: ExtensionApiDeps): ExtensionApi {
  const {
    pluginManager,
    modeManager,
    spatialIndex,
    hitTestService,
    boxSelectionRegistry,
    customLayer,
    featureCompanions,
    selectionScope,
    snapTargets,
  } = deps;
  const selectionExtensions = selectionScope.extensions;

  return {
    addPlugin(plugin: Plugin): () => void {
      return pluginManager.register(plugin);
    },

    getPluginApi<T>(name: string): T | undefined {
      return pluginManager.getPluginApi<T>(name);
    },

    registerMode(mode: Mode, factory: () => ModeHandler): () => void {
      return modeManager.registerMode(mode, factory);
    },

    registerFeatureHandler(handler: CustomFeatureHandler): () => void {
      const { type } = handler;
      const cancels: Array<() => void> = [];
      const add = (cancel: (() => void) | undefined): void => {
        if (cancel) cancels.push(cancel);
      };

      // 1. The bounding box computation of the spatial index (it re-measures the features of
      //    the type the Store already holds)
      if (handler.getBoundingBox) {
        add(spatialIndex.setCustomBoundingBoxCalculator?.(type, handler.getBoundingBox));
      }
      // 2. The hit testing strategy
      if (handler.hitTest) add(hitTestService.registerStrategy?.(handler.hitTest));
      // 3. The box selection strategy
      if (handler.boxSelection) add(boxSelectionRegistry.register(handler.boxSelection));
      // 4. The renderer
      if (handler.renderer) add(customLayer.registerFeatureRenderer(type, handler.renderer));
      // 5. The bounding box of the selection UI
      if (handler.getSelectionBoundingBox) {
        add(selectionExtensions.registerBoundingBox(type, handler.getSelectionBoundingBox));
      }
      // 6. The additional resize handles
      if (handler.getAdditionalResizeHandles) {
        add(
          selectionExtensions.registerAdditionalResizeHandles(
            type,
            handler.getAdditionalResizeHandles,
          ),
        );
      }
      // 7. The custom resize computation
      if (handler.computeCustomResize) {
        add(selectionExtensions.registerCustomResize(type, handler.computeCustomResize));
      }
      // 8. The resize strategy. A type with the scale strategy also rotates through its
      //    rotation property (the rotate operation reads the same strategy)
      if (handler.resizeStrategy) {
        add(selectionExtensions.registerResizeStrategy(type, handler.resizeStrategy));
      }
      // 9. The snapping candidates
      if (handler.getSnapTargets) add(snapTargets.register(type, handler.getSnapTargets));
      // 10. The additional reach for candidate narrowing of the hit test
      if (handler.candidateReachPx !== undefined) {
        add(hitTestService.registerCandidateReach?.(type, handler.candidateReachPx));
      }
      // 11. The extent of a point's selection box
      if (handler.getPointFrameExtent) {
        add(selectionExtensions.registerPointFrameExtent(type, handler.getPointFrameExtent));
      }

      // The cancellation undoes every registration above, in the reverse order
      let cancelled = false;
      return () => {
        if (cancelled) return;
        cancelled = true;
        for (let i = cancels.length - 1; i >= 0; i--) cancels[i]();
      };
    },

    registerAuxiliaryHandleProvider(provider: AuxiliaryHandleProvider): () => void {
      return selectionScope.auxiliaryHandles.register(provider);
    },

    registerFeatureCompanionProvider(provider: FeatureCompanionProvider): () => void {
      return featureCompanions.register(provider);
    },

    addOverlayRenderer(renderer: CustomOverlayRenderer): () => void {
      return customLayer.addOverlayRenderer(renderer);
    },
  };
}
