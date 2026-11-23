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
 * 1. The datasets on the aboveLayers side (from the front side)
 * 2. The stacking order (`store.getLayerOrder()`) from the end = from the front. When an
 *    entry is a layer, the features of that layer are tested from the front, and when it
 *    is a dataset with order: 'layerOrder', that dataset is tested. An ID that is
 *    neither is skipped
 * 3. The datasets on the belowLayers side (from the front side)
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
import type { Coordinate, Feature } from '../../store/types.js';
import type {
  CompanionDocument,
  CompanionHitContext,
  FeatureCompanionHitResult,
  FeatureCompanionRegistry,
} from '../../view/feature-companion.js';
import { hitTestFeatureCompanions } from '../../view/feature-companion.js';
import { clickCopies } from './local-frame.js';
import type { HitTestDocument, HitTestService, UnprojectFunction } from './service.js';
import { DEFAULT_HIT_TEST_OPTIONS } from './strategies/base.js';

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
 * Returns the single frontmost hit at a screen position, across the Store, the
 * datasets and the feature companions, in the same order as they are drawn.
 *
 * The position is in CSS px relative to the map container. It returns `null` when nothing is
 * hit.
 */
export type HitTestTopmost = (point: ScreenPoint) => TopHit | null;

/**
 * The dependencies of the unified z traversal
 *
 * @internal
 */
export interface TopmostHitTestDeps {
  /** The layer over the Store: the features shown in stacking order, and their changes */
  store: HitTestDocument & CompanionDocument;
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
      tolerancePx: deps.clickTolerancePx ?? DEFAULT_HIT_TEST_OPTIONS.clickTolerancePx,
    };
  };

  /**
   * What the walk from the front looks at, in stacking order from the back with the layer of
   * each: the features hit themselves, and the features of the document that have companions
   * (when a companion can be hit), those shown alone; read without the features being made
   */
  const walkOf = (
    storeHits: ReadonlyMap<string, Feature>,
    holders: ReadonlyMap<string, Feature> | null,
  ): { ids: readonly string[]; layerIds: readonly string[] } => {
    if (!holders || holders.size === 0) {
      if (storeHits.size === 0) return { ids: [], layerIds: [] };
      return store.listShownInOrder(storeHits.keys());
    }
    const ids = new Set<string>(storeHits.keys());
    for (const id of holders.keys()) ids.add(id);
    return store.listShownInOrder(ids);
  };

  /**
   * The hit at one step of the walk: the feature itself, then its companions (a companion sits
   * one z below its feature)
   */
  const stepOf = (
    id: string,
    storeHits: ReadonlyMap<string, Feature>,
    holders: ReadonlyMap<string, Feature> | null,
    context: CompanionHitContext | null,
  ): TopHit | null => {
    const hit = storeHits.get(id);
    if (hit) return { kind: 'store', feature: hit };
    const holder = holders?.get(id);
    const companions = deps.companions;
    if (!holder || !context || !companions) return null;
    const companion = hitTestFeatureCompanions(companions, holder, context);
    return companion ? { kind: 'companion', companion } : null;
  };

  /** The features of the Store hit at a point, by their IDs (the spatial index is asked once) */
  const storeHitsAt = (point: ScreenPoint): Map<string, Feature> =>
    new Map(
      hitTestService
        .hitTestAll(point, unproject)
        .map((result) => [result.feature.id, result.feature]),
    );

  return (point) => {
    const companion = companionContext(point);
    // The features of the document that have companions (the providers are asked of a feature
    // when it changes, not here), only when a companion can be hit
    const holders = companion && deps.companions ? deps.companions.holdersIn(store) : null;

    // On a map with no dataset at all (none is visible), the cost is kept the same as
    // the conventional path. The spatial index is queried only once as well.
    if (!datasets?.hasAny()) {
      if (!companion) {
        const hit = hitTestService.hitTest(point, unproject);
        return hit ? { kind: 'store', feature: hit.feature } : null;
      }

      // A companion sits one z below the feature itself, so the features are examined one
      // at a time from the front in the order "the feature itself -> its companions". The
      // spatial index is queried only once.
      const storeHits = storeHitsAt(point);
      const walk = walkOf(storeHits, holders);
      for (let i = walk.ids.length - 1; i >= 0; i--) {
        const hit = stepOf(walk.ids[i], storeHits, holders, companion);
        if (hit) return hit;
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

    // 1. The aboveLayers side
    const above = onCopies((copy) => datasets.hitTestSide('aboveLayers', copy, tolerance, test));
    if (above) return toTopHit(above);

    // 2. The stacking order from the front. One hit test per frame is enough on the Store
    //    side, so it is performed only once, at the moment a layer entry is first met.
    let storeHits: Map<string, Feature> | undefined;
    let byLayer: Map<string, string[]> | undefined;
    const layerOrder = store.getLayerOrder();

    for (let i = layerOrder.length - 1; i >= 0; i--) {
      const entryId = layerOrder[i];

      if (store.getLayer(entryId) !== undefined) {
        if (!storeHits) {
          storeHits = storeHitsAt(point);
          byLayer = groupByLayer(walkOf(storeHits, holders));
        }
        // Even when not a single feature itself was hit, a companion can still be hit
        if (storeHits.size === 0 && !companion) continue;

        const ids = byLayer?.get(entryId);
        if (!ids) continue;
        for (let j = ids.length - 1; j >= 0; j--) {
          const hit = stepOf(ids[j], storeHits, holders, companion);
          if (hit) return hit;
        }
        continue;
      }

      const entry = onCopies((copy) => datasets.hitTestEntry(entryId, copy, tolerance, test));
      if (entry) return toTopHit(entry);
    }

    // 3. The belowLayers side
    const below = onCopies((copy) => datasets.hitTestSide('belowLayers', copy, tolerance, test));
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
 * Splits the features in stacking order per layer (the order is preserved)
 */
function groupByLayer(walk: {
  ids: readonly string[];
  layerIds: readonly string[];
}): Map<string, string[]> {
  const byLayer = new Map<string, string[]>();
  for (let i = 0; i < walk.ids.length; i++) {
    const ids = byLayer.get(walk.layerIds[i]);
    if (ids) ids.push(walk.ids[i]);
    else byLayer.set(walk.layerIds[i], [walk.ids[i]]);
  }
  return byLayer;
}
