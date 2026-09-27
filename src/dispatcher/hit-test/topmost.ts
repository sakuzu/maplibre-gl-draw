// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hit testing with the unified z traversal
 *
 * What receives a click is the single frontmost thing among those that are visible. It
 * does not matter whether that is a feature of the Store (an editing target) or a
 * dataset (data). The shape that occludes is exactly what is seen (a
 * polygon occludes with its fill, holes let clicks through, and a line occludes with its
 * line width plus the tolerance radius); nothing is transparent to clicks.
 *
 * The traversal goes from the front in the following order.
 *
 * 1. The datasets on the above-store side (from the front side)
 * 2. The stacking order (`store.getLayerOrder()`) from the end = from the front. When an
 *    entry is a layer, the features of that layer are tested from the front, and when it
 *    is a dataset with order: 'layer-order', that dataset is tested. An ID that is
 *    neither is skipped
 * 3. The datasets on the below-store side (from the front side)
 *
 * The test uses only test() (a boolean) of each strategy, and distance() is not used to
 * arbitrate between entries. Visibility is decided by visible / the local hidden state /
 * the visible flag of the layer and the group, and the result of the viewport thinning is
 * not used (thinning in the rendering is an optimization and takes no part in the
 * semantics of the test).
 *
 * A dataset with interactive: false also occludes hits. In that case feature is null
 * and neither click nor hover is fired.
 *
 * When the features of a layer are examined, the companions of a feature
 * (view/feature-companion) are asked right after the test of the feature itself fails and
 * before moving on to the next (one step further back) feature. A companion is drawn one z
 * below its feature, so the order in which things are seen matches the order in which they
 * can be grabbed. When no provider at all is registered, this detour never happens.
 */

import type { DisplayHitTestFn } from '../../dataset/dataset.js';
import type { DatasetManager } from '../../dataset/manager.js';
import type { Dataset } from '../../dataset/types.js';
import type { LngLat, ScreenPoint } from '../../shared/math/index.js';
import { getDisplayFeatures } from '../../store/local-visibility.js';
import type { Store } from '../../store/store.js';
import type { Coordinate, Feature } from '../../store/types.js';
import type {
  CompanionHitContext,
  FeatureCompanionHitResult,
  FeatureCompanionRegistry,
} from '../../view/feature-companion.js';
import { hitTestFeatureCompanions } from '../../view/feature-companion.js';
import { clickCopies } from './local-frame.js';
import type { HitTestService, UnprojectFunction } from './service.js';
import { DEFAULT_HIT_TEST_OPTIONS } from './strategies/base.js';
import { createVisibilityLookup, type VisibilityLookup } from './visibility-lookup.js';

/**
 * What the frontmost hit at a screen position is: a feature of the Store, a
 * dataset, or something that accompanies a feature.
 *
 * - store: a feature of the Store. It is a target of selection and editing as before
 * - dataset: a dataset. When feature is null it means "it occludes, but
 *   it does not fire an event" (interactive: false)
 * - companion: something that accompanies a feature (view/feature-companion). It was hit
 *   right after the test of the feature itself failed, and the click is received by the
 *   provider (the selection state does not change)
 */
export type TopHit =
  | { kind: 'store'; feature: Feature }
  | {
      kind: 'dataset';
      dataset: Dataset;
      feature: Feature | null;
      /** The row of the feature in the dataset (null together with feature) */
      row: number | null;
    }
  | { kind: 'companion'; companion: FeatureCompanionHitResult };

/**
 * The options of a {@link HitTestTopmost} call.
 */
export interface TopmostHitTestOptions {
  /**
   * The list of the features of the Store in display order
   *
   * When the caller already holds `getDisplayFeatures(store)`, passing it avoids fetching
   * it again. When omitted, this function fetches it itself.
   */
  orderedFeatures?: Feature[];
}

/**
 * Returns the single frontmost hit at a screen position, across the Store, the
 * datasets and the feature companions, in the same order as they are drawn.
 *
 * The position is in CSS px relative to the map container. It returns `null` when nothing is
 * hit.
 */
export type HitTestTopmost = (point: ScreenPoint, options?: TopmostHitTestOptions) => TopHit | null;

/**
 * The dependencies of the unified z traversal
 *
 * @internal
 */
export interface TopmostHitTestDeps {
  store: Store;
  /** The candidate narrowing and the precise test on the Store side */
  hitTestService: HitTestService;
  /** From screen coordinates to geographic coordinates */
  unproject: UnprojectFunction;
  /**
   * Converts the click tolerance (in pixels) into degrees of longitude at the click latitude,
   * independent of the bearing (toleranceDegrees in local-frame.ts)
   */
  toleranceLngLat(point: ScreenPoint): number;
  /** The datasets (when omitted, only the Store is traversed) */
  datasets?: DatasetManager;
  /**
   * Geographic coordinates -> screen px (passed to the context of the companion hits)
   *
   * When omitted, the companion hit (feature companion) test is not performed, because a
   * companion decides a hit by its appearance in screen px, so without a projection there
   * is no way to test it.
   */
  project?(lngLat: Coordinate): ScreenPoint;
  /** The current zoom level (passed to the context of the companion hits; when omitted the
   * companion hits are not performed) */
  getZoom?(): number;
  /** The click tolerance (in screen px; passed to the context of the companion hits) */
  clickTolerancePx?: number;
  /**
   * The providers of the companion rendering and the companion hits (those of this draw
   * instance)
   *
   * When omitted, the companion hit test is not performed.
   */
  companions?: FeatureCompanionRegistry;
}

/**
 * Creates the hit tester of the unified z traversal
 *
 * @internal
 */
export function createTopmostHitTester(deps: TopmostHitTestDeps): HitTestTopmost {
  const { store, hitTestService, unproject, toleranceLngLat, datasets } = deps;

  const test: DisplayHitTestFn = (feature, coordinate, tolerance) =>
    hitTestService.hitTestFeature(feature, coordinate, tolerance);

  /**
   * Builds the context of the companion hits (null unless the configuration can perform
   * the test)
   *
   * It is not built when no provider at all is registered, so the conventional traversal
   * changes neither in cost nor in path.
   */
  const companionContext = (point: ScreenPoint): CompanionHitContext | null => {
    if (!deps.companions?.any()) return null;

    const project = deps.project;
    const getZoom = deps.getZoom;
    if (!project || !getZoom) return null;

    return {
      point,
      project,
      unproject: (p: ScreenPoint): LngLat => {
        const { lng, lat } = unproject(p);
        return { lng, lat };
      },
      zoom: getZoom(),
      tolerancePx: deps.clickTolerancePx ?? DEFAULT_HIT_TEST_OPTIONS.clickTolerance,
    };
  };

  /**
   * Asks for a hit on the companions of one feature (a feature that is not visible is not
   * asked)
   */
  const companionOf = (
    feature: Feature,
    context: CompanionHitContext | null,
    visible: VisibilityLookup,
  ): TopHit | null => {
    if (!context) return null;
    if (!visible(feature)) return null;

    const companions = deps.companions;
    if (!companions) return null;
    const companion = hitTestFeatureCompanions(companions, feature, context);
    return companion ? { kind: 'companion', companion } : null;
  };

  return (point, options) => {
    const orderedFeatures = options?.orderedFeatures ?? getDisplayFeatures(store);
    const companion = companionContext(point);
    // Within one hit test, the visibility of a layer or a group is looked up only once per
    // container.
    const visible = createVisibilityLookup(store);

    // On a map with no dataset at all (none is visible), the cost is kept the same as
    // the conventional path. The spatial index is queried only once as well.
    if (!datasets?.hasAny()) {
      if (!companion) {
        const hit = hitTestService.hitTest(point, unproject, orderedFeatures);
        return hit ? { kind: 'store', feature: hit.feature } : null;
      }

      // A companion sits one z below the feature itself, so the features are examined one
      // at a time from the front in the order "the feature itself -> its companions". The
      // spatial index is queried only once.
      const storeHits = new Set(
        hitTestService.hitTestAll(point, unproject, orderedFeatures).map((r) => r.feature.id),
      );
      for (let i = orderedFeatures.length - 1; i >= 0; i--) {
        const feature = orderedFeatures[i];
        if (storeHits.has(feature.id)) return { kind: 'store', feature };

        const companionHit = companionOf(feature, companion, visible);
        if (companionHit) return companionHit;
      }
      return null;
    }

    const lngLat = unproject(point);
    const tolerance = toleranceLngLat(point);
    // The click on each copy of the world it can reach (the stored copy first; local-frame.ts)
    const copies = clickCopies([lngLat.lng, lngLat.lat], tolerance);
    const onCopies = <T>(hitOn: (coordinate: Coordinate) => T | null): T | null => {
      for (const copy of copies) {
        const hit = hitOn(copy);
        if (hit) return hit;
      }
      return null;
    };

    // 1. The above-store side
    const above = onCopies((copy) => datasets.hitTestSide('above-store', copy, tolerance, test));
    if (above) return toTopHit(above);

    // 2. The stacking order from the front. One hit test per frame is enough on the Store
    //    side, so it is performed only once, at the moment a layer entry is first met.
    let storeHits: Set<string> | undefined;
    let byLayer: Map<string, Feature[]> | undefined;
    const layerOrder = store.getLayerOrder();

    for (let i = layerOrder.length - 1; i >= 0; i--) {
      const entryId = layerOrder[i];

      if (store.getLayer(entryId) !== undefined) {
        if (!storeHits) {
          storeHits = new Set(
            hitTestService
              .hitTestAll(point, unproject, orderedFeatures)
              .map((result) => result.feature.id),
          );
          byLayer = groupByLayer(orderedFeatures);
        }
        // Even when not a single feature itself was hit, a companion can still be hit
        if (storeHits.size === 0 && !companion) continue;

        const features = byLayer?.get(entryId);
        if (!features) continue;
        for (let j = features.length - 1; j >= 0; j--) {
          const feature = features[j];
          if (storeHits.has(feature.id)) return { kind: 'store', feature };

          const companionHit = companionOf(feature, companion, visible);
          if (companionHit) return companionHit;
        }
        continue;
      }

      const entry = onCopies((copy) => datasets.hitTestEntry(entryId, copy, tolerance, test));
      if (entry) return toTopHit(entry);
    }

    // 3. The below-store side
    const below = onCopies((copy) => datasets.hitTestSide('below-store', copy, tolerance, test));
    return below ? toTopHit(below) : null;
  };
}

/**
 * Converts a dataset hit into a TopHit
 */
function toTopHit(hit: { dataset: Dataset; feature: Feature | null; row: number | null }): TopHit {
  return { kind: 'dataset', dataset: hit.dataset, feature: hit.feature, row: hit.row };
}

/**
 * Splits the features in display order per layer (the order is preserved)
 */
function groupByLayer(orderedFeatures: Feature[]): Map<string, Feature[]> {
  const byLayer = new Map<string, Feature[]>();
  for (const feature of orderedFeatures) {
    const features = byLayer.get(feature.layerId);
    if (features) features.push(feature);
    else byLayer.set(feature.layerId, [feature]);
  }
  return byLayer;
}
