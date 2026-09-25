// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-layer rendering
 *
 * The per-layer rendering loop called from CustomLayer's render()
 */

import type { ProjectionData } from 'maplibre-gl';
import type { DatasetManager } from '../../display/manager.js';
import type {
  CustomFeatureHandler,
  CustomRendererDrawContext,
  LayerAwareOverlayRenderer,
} from '../../extension/index.js';
import type { Store } from '../../store/store.js';
import type { BoundingBox, Feature, Layer } from '../../store/types.js';
import type { FeatureCompanionRegistry } from '../feature-companion.js';
import { drawFeatureCompanionsInFrame } from '../feature-companion.js';
import { layerDrawFactors } from '../renderers/draw-factors.js';
import type { Renderers } from './renderers.js';
import type { StoreRetainedCache } from './store-retained.js';

/**
 * Draw features and overlays layer by layer
 *
 * The loop walks the stacking order of the Store (`store.getLayerOrder()`). Its entries are a
 * mix of layer ids and dataset ids, and for each entry it does the following.
 *
 * - A layer exists: draw it in retained / immediate mode as before
 * - A dataset whose order is 'layer-order' exists: draw that dataset
 * - Neither of them (an unknown id): skip it (not an error)
 *
 * In addition, datasets (display) have two insertion points outside the layer
 * loop. below-store is drawn before every layer (behind them) and above-store after every layer
 * (in front of them). Batching uses the same BatchManager as the Store. The per-layer frames
 * (beginFrame / endFrame) are closed inside the loop, so their state never mixes with a frame
 * opened outside it. The batch of a dataset is also closed at a layer boundary, so inserting
 * one in the middle of the order never nests GL state.
 *
 * There are two paths for the features of the Store.
 *
 * - Retained mode (storeRetained is present and the renderers support it): draws the retained
 *   batches prepared per layer. The features argument is not used. Thinning of a retained batch
 *   is done per chunk, so the bbox of the expanded viewport is computed once per frame and passed
 *   in. Immediate chunks, which draw one feature at a time, are thinned per feature as well, so
 *   the set of visible ids is passed too (only once it becomes necessary).
 * - Immediate mode (the path used before): walks features every frame and draws them.
 *
 * The rendering result (including the z-order) is the same either way.
 *
 * An external renderer (a custom feature type or a layer-aware overlay) may rewrite the GL blend
 * state for its own purposes. If it comes back having left it rewritten, everything drawn later
 * in that frame (the layers that follow and the datasets) is drawn with the
 * wrong blending, so `restoreBlendState` is called at the point control comes back, to
 * re-establish the contract of the frame.
 *
 * @param companions Providers of companion drawing (those of this draw instance)
 * @param features Features to draw in immediate mode (not used in retained mode)
 * @param datasets Datasets (not drawn when omitted)
 * @param storeRetained Retained batch cache for drawing the Store (immediate mode when omitted)
 * @param restoreBlendState Re-establishes our own blend state (not re-established when omitted)
 * @param range The segment (slot) to draw (every entry when omitted)
 * @param view The part of the view to draw, on one copy of the world (the expanded viewport
 *   of the ViewportFilter when omitted). A view across the antimeridian is drawn once per
 *   copy, each with its own range
 */
export function renderLayers(
  r: Renderers,
  store: Store,
  features: Feature[],
  selectedIdSet: Set<string>,
  defaultProjectionData: ProjectionData,
  zoom: number,
  customRenderers: Map<string, CustomFeatureHandler['renderer']>,
  customRendererContext: CustomRendererDrawContext,
  companions: FeatureCompanionRegistry,
  layerAwareRenderers: LayerAwareOverlayRenderer[],
  datasets?: DatasetManager,
  storeRetained?: StoreRetainedCache,
  restoreBlendState?: () => void,
  range?: RenderLayersRange,
  view?: RenderLayersView,
): void {
  const fullOrder = store.getLayerOrder();
  // When a segment (slot) is given, only the entries of that segment are drawn. The datasets
  // below the order (below-store) are drawn only by the first segment and those above it
  // (above-store) only by the last segment (the same thing is not drawn once per slot)
  const layerOrder = range ? fullOrder.slice(range.from, range.to) : fullOrder;
  const drawBelow = range ? range.first : true;
  const drawAbove = range ? range.last : true;
  const tentative = store.getTentative();

  // Implementations without the renderers of retained mode (a test stub, for example) fall back
  // to the immediate mode used before
  const retainedRenderers =
    storeRetained !== undefined && typeof r.batchManager.getRetainedRenderers === 'function'
      ? r.batchManager.getRetainedRenderers()
      : undefined;
  const useRetained = storeRetained !== undefined && retainedRenderers !== undefined;

  if (useRetained) storeRetained.beginFrame(companions);

  // The range used to thin the retained chunks and the chunks of the datasets.
  // It does not depend on the number of features, so once per frame is enough (it is computed
  // regardless of the rendering path and passed to draw / drawOne as an argument; the manager is
  // not left to look it up lazily). An implementation without a ViewportFilter (a test stub, for
  // example) does not compute it and leaves it to the default of the dataset.
  const viewportBounds =
    view?.bounds ??
    (typeof r.viewportFilter?.getBounds === 'function' ? r.viewportFilter.getBounds() : undefined);

  // Immediate chunks (dashed lines, images, custom types) cannot be thinned by the chunk bbox
  // alone: once a chunk touches the view, even features outside the screen are drawn one by one.
  // The set of visible ids is passed so that the same per-feature thinning as immediate mode is
  // applied. Querying the spatial index once per frame is enough, and it is not needed at all in
  // a frame without a single immediate chunk, so it is looked up once, when first needed.
  let visibleIdsMemo: ReadonlySet<string> | undefined;
  const canFilterVisible =
    view !== undefined ||
    (viewportBounds !== undefined && typeof r.viewportFilter?.getVisibleIds === 'function');
  const getVisibleIds = canFilterVisible
    ? (): ReadonlySet<string> => {
        if (!visibleIdsMemo) {
          visibleIdsMemo = view ? view.getVisibleIds() : r.viewportFilter.getVisibleIds();
        }
        return visibleIdsMemo;
      }
    : undefined;

  // Insertion point 1: behind every layer of the Store
  if (drawBelow) {
    datasets?.draw('below-store', r.batchManager, defaultProjectionData, zoom, viewportBounds);
  }

  // Group the features by layer id (immediate mode only)
  const featuresByLayer = new Map<string, Feature[]>();
  if (!useRetained) {
    for (const feature of features) {
      const layerFeatures = featuresByLayer.get(feature.layerId) ?? [];
      layerFeatures.push(feature);
      featuresByLayer.set(feature.layerId, layerFeatures);
    }
  }

  for (const layerId of layerOrder) {
    // The layer is needed to evaluate the style rule (layer.styleRule), so it is passed to the
    // frame of the batch.
    const layer = store.getLayer(layerId);

    // An entry that is not a layer is drawn as a dataset taking part in the
    // stacking order. If it is not a dataset either, it is skipped (the order is the single
    // source of truth, and an id that is not on it is not drawn).
    if (!layer) {
      datasets?.drawOne(layerId, r.batchManager, defaultProjectionData, zoom, viewportBounds);
      continue;
    }

    // The custom renderers and the companions of the layer get its opacity in their context
    const layerContext = layerRendererContext(customRendererContext, layer);

    if (useRetained && retainedRenderers) {
      storeRetained.drawLayer(
        layerId,
        layer,
        defaultProjectionData,
        zoom,
        {
          renderers: retainedRenderers,
          batchManager: r.batchManager,
          customRenderers,
          customRendererContext: layerContext,
          companions,
          getVisibleIds,
          restoreBlendState,
        },
        viewportBounds,
      );
    } else {
      const layerFeatures = featuresByLayer.get(layerId) ?? [];

      r.batchManager.beginFrame(defaultProjectionData, zoom, layer);

      for (const feature of layerFeatures) {
        const isSelected = selectedIdSet.has(feature.id);

        // Companion drawing (feature companion): drawn right before the feature itself, that is,
        // one z below it. If no provider at all is registered, not even has is called.
        drawFeatureCompanionsInFrame(
          companions,
          feature,
          r.batchManager,
          defaultProjectionData,
          zoom,
          layer,
          layerContext,
          restoreBlendState,
        );

        const customRenderer = customRenderers.get(feature.type);
        if (customRenderer) {
          // To keep the draw order (painter's algorithm), the core batch that has accumulated is
          // flushed first and only then the custom feature is drawn immediately.
          // A batch is not painted until endFrame, so without flushing here a custom feature
          // would ignore layer.order and be drawn before the core features of the same layer.
          r.batchManager.endFrame();
          customRenderer.draw(
            {
              id: feature.id,
              type: feature.type,
              coordinates: feature.coordinates,
              properties: feature.properties,
              style: feature.style,
            },
            defaultProjectionData,
            zoom,
            layerContext,
          );
          // Re-establish the blend state that the external renderer may have rewritten.
          restoreBlendState?.();
          // Restart the batch for the core features that follow.
          r.batchManager.beginFrame(defaultProjectionData, zoom, layer);
        } else {
          r.batchManager.processFeature(feature, isSelected);
        }
      }

      r.batchManager.endFrame();
    }

    // Tentative rendering
    if (tentative && tentative.layerId === layerId) {
      r.tentativeRenderer.drawGeometry(tentative, defaultProjectionData, zoom);
    }

    // Layer-aware overlay rendering (an overlay is not content of the layer, so it keeps the
    // context of the frame, at opacity 1)
    for (const renderer of layerAwareRenderers) {
      renderer.drawForLayer(layerId, defaultProjectionData, zoom, customRendererContext);
      // Re-establish the blend state that the external renderer may have rewritten
      restoreBlendState?.();
    }
  }

  // Insertion point 2: in front of every layer of the Store (behind the selection UI and
  // tentative)
  if (drawAbove) {
    datasets?.draw('above-store', r.batchManager, defaultProjectionData, zoom, viewportBounds);
  }
}

/**
 * The context of the custom renderers for one layer (the context of the frame with the opacity
 * of the layer)
 *
 * The same object is returned when the opacity is already the one of the context, so a map whose
 * layers are all opaque allocates nothing per layer.
 */
export function layerRendererContext(
  base: CustomRendererDrawContext,
  layer: Layer,
): CustomRendererDrawContext {
  const opacity = layerDrawFactors(layer).opacity;
  return base.opacity === opacity ? base : { ...base, opacity };
}

/**
 * The part of the view one rendering covers (one copy of the world)
 */
export interface RenderLayersView {
  /** The range to draw, in stored longitudes (thins the chunks) */
  readonly bounds: BoundingBox;
  /** The ids of the features inside `bounds` (thins the immediate chunks one by one) */
  readonly getVisibleIds: () => ReadonlySet<string>;
}

/**
 * Specification of the segment (slot) to draw
 *
 * from / to is [from, to) in layerOrder. first is the first slot (it draws the datasets below
 * the order), last is the last slot (it draws the datasets above the order).
 */
export interface RenderLayersRange {
  readonly from: number;
  readonly to: number;
  readonly first: boolean;
  readonly last: boolean;
}
