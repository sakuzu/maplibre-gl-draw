// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Immediate-mode drawing of the chunks that cannot be retained
 *
 * Dashed lines, images, point shapes without instancing support, custom types and features with
 * a companion are drawn one at a time through the immediate-mode draw target, in the same order
 * as the layer loop of render.ts.
 */

import type { ProjectionData } from 'maplibre-gl';
import type { FeatureTypeHandler, FrameDrawContext } from '../../extension/index.js';
import { isLocallyHidden } from '../../store/local-visibility.js';
import type { Store } from '../../store/store.js';
import type { Feature, Layer } from '../../store/types.js';
import {
  drawFeatureCompanionsInFrame,
  type FeatureCompanionRegistry,
} from '../feature-companion.js';
import type { RetainedRendererSet } from '../renderers/retained.js';
import { customRendererOf } from './store-retained-classify.js';

/**
 * Draw target used when falling back to immediate mode (the same shape as BatchManager)
 */
export interface StoreImmediateTarget {
  beginFrame(projectionData: ProjectionData, zoom: number, layer?: Layer): void;
  processFeature(feature: Feature, isSelected: boolean): boolean;
  endFrame(): void;
}

/**
 * Dependencies of drawLayer
 */
export interface StoreRetainedDrawDeps {
  /** The full set of renderers of retained mode */
  renderers: RetainedRendererSet;
  /** Immediate-mode draw target that draws the features which cannot be retained */
  batchManager: StoreImmediateTarget;
  /** Renderers of the custom feature types (type name → renderer) */
  customRenderers: Map<string, FeatureTypeHandler['renderer']>;
  /** Draw context passed to a custom renderer */
  customRendererContext: FrameDrawContext;
  /** Providers of companion drawing and companion hits (those of this draw instance) */
  companions: FeatureCompanionRegistry;
  /**
   * Returns the set of feature ids inside the expanded viewport (a spatial index query)
   *
   * Used to thin immediate chunks per feature. It is not called in a frame that draws no
   * immediate chunk at all (the caller must memoize it within the frame). When omitted, an
   * immediate chunk is thinned by the chunk bbox alone.
   */
  getVisibleIds?: () => ReadonlySet<string>;
  /**
   * Re-establishes the blend state of our own rendering (a wrapper around `applyDrawBlendState`)
   *
   * The renderer of a custom feature type is an external implementation and may come back having
   * rewritten the blend function for its own purposes. Left alone, everything drawn later in the
   * same frame would be composited wrongly, so it is called right after control comes back.
   * When omitted nothing is re-established (the path of tests that have no GL).
   */
  restoreBlendState?: () => void;
}

/**
 * Draws a list of features in immediate mode
 *
 * It draws with the same steps as the current immediate mode (the layer loop of render.ts).
 * A custom type is drawn after the batch has been flushed, to keep the draw order.
 *
 * @param store Where the features are looked up again (hidden ones are skipped)
 * @param visibleIds Feature ids inside the expanded viewport (no thinning when omitted)
 */
export function drawFeaturesImmediate(
  store: Store,
  featureIds: string[],
  layer: Layer | undefined,
  projectionData: ProjectionData,
  zoom: number,
  deps: StoreRetainedDrawDeps,
  visibleIds?: ReadonlySet<string>,
): void {
  const { batchManager, customRenderers, customRendererContext } = deps;

  batchManager.beginFrame(projectionData, zoom, layer);

  for (const id of featureIds) {
    if (visibleIds && !visibleIds.has(id)) continue;

    const feature = store.getFeature(id);
    if (!feature?.visible || isLocallyHidden(feature, store)) continue;

    // Companion drawing (feature companion): drawn right before the feature itself, that is,
    // one z below it. classifyFeature splits a feature that has a companion out into an
    // immediate chunk, so going through here makes the z order in retained mode identical to
    // immediate mode.
    drawFeatureCompanionsInFrame(
      deps.companions,
      feature,
      batchManager,
      projectionData,
      zoom,
      layer,
      customRendererContext,
      deps.restoreBlendState,
    );

    const customRenderer = customRendererOf(customRenderers, feature);
    if (customRenderer) {
      // To keep the draw order (painter's algorithm), the core batch that has accumulated is
      // flushed first and only then the custom feature is drawn immediately.
      batchManager.endFrame();
      customRenderer.draw(feature, projectionData, zoom, customRendererContext);
      // Re-establish the blend state that the external renderer may have rewritten
      deps.restoreBlendState?.();
      batchManager.beginFrame(projectionData, zoom, layer);
    } else {
      batchManager.processFeature(feature, false);
    }
  }

  batchManager.endFrame();
}
