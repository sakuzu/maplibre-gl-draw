// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HitTestService
 *
 * The service that integrates the two-stage hit testing.
 * 1. Narrowing down the candidates with the SpatialIndex (rbush)
 * 2. The precise test with a HitTestStrategy
 */

import type { ScreenPoint } from '../../shared/math/index.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import type { SpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Store } from '../../store/store.js';
import type { Coordinate, Feature } from '../../store/types.js';
import type { DrawnShapeResolver } from './globe-shape.js';
import { clickCopies, toleranceDegrees } from './local-frame.js';
import type { HitTestOptions, HitTestResult, HitTestStrategy } from './strategies/base.js';
import { DEFAULT_HIT_TEST_OPTIONS, HitTestStrategyRegistry } from './strategies/base.js';
import { CircleHitTestStrategy } from './strategies/circle.js';
import { ImageHitTestStrategy } from './strategies/image.js';
import { LineHitTestStrategy } from './strategies/line.js';
import {
  MultiLineStringHitTestStrategy,
  MultiPointHitTestStrategy,
  MultiPolygonHitTestStrategy,
} from './strategies/multi.js';
import { PointHitTestStrategy } from './strategies/point.js';
import { PolygonHitTestStrategy } from './strategies/polygon.js';
import { createVisibilityLookup, type VisibilityLookup } from './visibility-lookup.js';

/**
 * Converts a position in CSS px relative to the map container into degrees, as
 * `map.unproject` does.
 */
export type UnprojectFunction = (point: ScreenPoint) => { lng: number; lat: number };

/**
 * The injection point that maps the anchor of a symbol to screen coordinates (terrain
 * aware)
 *
 * Points are drawn without a depth test, so they are visible even when they are behind the
 * terrain. When one of those is clicked, the path "click -> terrain-aware unproject ->
 * longitude/latitude -> spatial index" can never hit it in principle, because the line of
 * sight lands on the terrain surface in front (even on a slope that is not occluded the
 * landing point is displaced, which shrinks the effective radius).
 *
 * Therefore symbols alone take the path "project the anchor of each candidate to screen
 * coordinates with the same projection as the rendering, and compare it directly with the
 * screen coordinates of the click". The implementation is the anchor projection of the
 * view layer (`view/terrain/anchor.ts`), which is identical to the one the rendering uses.
 *
 * While `project` returns null (the terrain is disabled, or no frame has been established
 * yet) the conventional path is used as before. Hit testing without terrain does not
 * change by a single byte.
 */
export interface AnchorScreenProjector {
  project(coord: Coordinate): ScreenPoint | null;
}

/**
 * The types tested in screen space (the symbols drawn without a depth test)
 *
 * Polygons, lines, circles and images are draped onto the ground surface and are occluded
 * correctly by depth, so the longitude/latitude path remains the correct one for them.
 */
const SCREEN_SPACE_TYPES = new Set(['Point', 'MultiPoint']);

/**
 * The two-stage hit test of the features of the Store: candidates from the spatial index,
 * then the precise test of each type's {@link HitTestStrategy}.
 *
 * Extensions receive it through their context. The tolerance is the click tolerance of the
 * draw instance (6 px by default).
 */
export interface HitTestService {
  /**
   * Returns the frontmost feature that is hit, walking `orderedFeatures` from the end
   *
   * @param screenPoint The position in CSS px relative to the map container
   * @param unproject Converts screen positions into degrees
   * @param orderedFeatures The candidates in display order (the last is in front)
   * @returns The hit, or `null` when nothing is hit
   */
  hitTest(
    screenPoint: ScreenPoint,
    unproject: UnprojectFunction,
    orderedFeatures: Feature[],
  ): HitTestResult | null;

  /**
   * Returns every feature that is hit, sorted by distance (the closest first)
   *
   * @param screenPoint The position in CSS px relative to the map container
   * @param unproject Converts screen positions into degrees
   * @param orderedFeatures The candidates in display order
   * @returns The hits. An empty array when nothing is hit
   */
  hitTestAll(
    screenPoint: ScreenPoint,
    unproject: UnprojectFunction,
    orderedFeatures: Feature[],
  ): HitTestResult[];

  /**
   * Tests one feature with the strategy of its type
   *
   * @param feature The feature to test
   * @param coordinate The position `[lng, lat]` in degrees
   * @param toleranceLngLat The tolerance in degrees of longitude at that latitude
   * @returns `true` when it is hit. `false` when no strategy is registered for its type
   */
  hitTestFeature(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): boolean;

  /**
   * Updates the tile size in px of the map (the Image hit test converts pixel sizes with it)
   */
  setTileSize?(tileSize: number): void;

  /**
   * Registers a custom hit testing strategy (for dynamic registration)
   *
   * @returns a function that cancels the registration (see HitTestStrategyRegistry.register)
   */
  registerStrategy?(strategy: HitTestStrategy): () => void;

  /**
   * Registers, per feature type, the extra reach (in CSS pixels) for narrowing down the
   * candidates
   *
   * The first stage narrows down the candidates with a radius equivalent to clickTolerance,
   * so a type whose per-type strategy tests a wider area than that (icons and the like)
   * would drop out of the candidates before it ever reaches the precise test. Widening the
   * search radius by the registered distance lets such a type reach the second stage
   * regardless of the state or the zoom.
   *
   * Only the candidate set widens; the semantics of a hit are decided by the strategy as
   * before.
   *
   * @returns a function that cancels the registration (it does not remove a later
   *   registration of the same type)
   */
  registerCandidateReach?(type: string, reachPx: number | (() => number)): () => void;
}

/**
 * The options of HitTestServiceImpl
 */
export interface HitTestServiceImplOptions extends Partial<HitTestOptions> {
  /** The tile size (taken from transform.tileSize of MapLibre) */
  tileSize?: number;
  /** The injection point that maps the anchor of a symbol to screen coordinates (terrain
   * aware; when omitted only the conventional path is used) */
  anchorScreen?: AnchorScreenProjector;
  /**
   * Reshapes a feature into the shape it is drawn with before the precise test (on the globe,
   * its edges cut along the Mercator plane; `globe-shape.ts`). When omitted the stored shape
   * is tested
   */
  drawnShape?: DrawnShapeResolver;
}

/**
 * The HitTestService implementation
 *
 * @internal
 */
export class HitTestServiceImpl implements HitTestService {
  private spatialIndex: SpatialIndex;
  private store: Store;
  private registry: HitTestStrategyRegistry;
  private options: HitTestOptions;
  private imageStrategy: ImageHitTestStrategy;
  /** The extra reach (in CSS pixels) for narrowing down the candidates, per feature type */
  private candidateReach = new Map<string, number | (() => number)>();
  /** The anchor projection of the symbols (terrain aware; without it only the conventional
   * path is used) */
  private anchorScreen: AnchorScreenProjector | null;
  /** The shape a feature is drawn with (the stored shape when there is no resolver) */
  private drawnShape: DrawnShapeResolver;

  constructor(store: Store, spatialIndex: SpatialIndex, options: HitTestServiceImplOptions = {}) {
    this.store = store;
    this.spatialIndex = spatialIndex;
    this.anchorScreen = options.anchorScreen ?? null;
    this.drawnShape = options.drawnShape ?? ((feature) => feature);
    this.options = { ...DEFAULT_HIT_TEST_OPTIONS, ...options };
    const tileSize = options.tileSize ?? 512;

    // Register the default strategies
    this.registry = new HitTestStrategyRegistry();
    this.registry.register(new PointHitTestStrategy());
    this.registry.register(new LineHitTestStrategy());
    this.registry.register(new PolygonHitTestStrategy());
    this.registry.register(new CircleHitTestStrategy());

    // The Multi geometries (a hit if any part is hit / the distance is the minimum over the
    // parts)
    this.registry.register(new MultiPointHitTestStrategy());
    this.registry.register(new MultiLineStringHitTestStrategy());
    this.registry.register(new MultiPolygonHitTestStrategy());

    // Freehand uses the same strategy as LineString
    const freehandStrategy = new LineHitTestStrategy();
    // Create a wrapper with geometryType changed to Freehand
    this.registry.register({
      geometryType: 'Freehand',
      test: freehandStrategy.test.bind(freehandStrategy),
      distance: freehandStrategy.distance.bind(freehandStrategy),
      testDistance: freehandStrategy.testDistance.bind(freehandStrategy),
    });

    // The Image strategy (it depends on the zoom level and the tile size)
    this.imageStrategy = new ImageHitTestStrategy(tileSize);
    this.registry.register(this.imageStrategy);
  }

  /**
   * Updates the tile size
   */
  setTileSize(tileSize: number): void {
    this.imageStrategy.setTileSize(tileSize);
  }

  /**
   * Registers a custom strategy
   */
  registerStrategy(strategy: HitTestStrategy): () => void {
    return this.registry.register(strategy);
  }

  /**
   * Registers the extra reach for narrowing down the candidates
   *
   * A type whose value changes with the zoom or with settings is registered as a function
   * (it is evaluated on every query).
   */
  registerCandidateReach(type: string, reachPx: number | (() => number)): () => void {
    this.candidateReach.set(type, reachPx);
    return () => {
      if (this.candidateReach.get(type) === reachPx) this.candidateReach.delete(type);
    };
  }

  /**
   * The maximum of the registered extra reaches (in CSS pixels)
   *
   * Widening the candidate set is cheap (the precise test of the second stage drops the
   * extras), so the search is not split per type and is done once with the single maximum.
   */
  private maxCandidateReachPx(): number {
    let max = 0;
    for (const reach of this.candidateReach.values()) {
      const value = typeof reach === 'function' ? reach() : reach;
      if (Number.isFinite(value) && value > max) max = value;
    }
    return max;
  }

  /**
   * Widens the radius of the candidate search (degrees of longitude) by the extra reach
   *
   * The degrees per pixel are obtained by dividing the already computed toleranceLngLat by
   * clickTolerance (so no additional call to unproject is made). Only when clickTolerance is
   * 0 is one pixel measured directly.
   *
   * The radius is a square box in degrees. A latitude reach needs only radius * cos φ
   * (local-frame.ts), so the box never misses a candidate.
   */
  private expandSearchRadius(
    toleranceLngLat: number,
    tolerancePx: number,
    screenPoint: ScreenPoint,
    unproject: UnprojectFunction,
  ): number {
    const reachPx = this.maxCandidateReachPx();
    if (reachPx <= 0) return toleranceLngLat;

    const degPerPx =
      tolerancePx > 0 ? toleranceLngLat / tolerancePx : toleranceDegrees(unproject, screenPoint, 1);

    return toleranceLngLat + reachPx * degPerPx;
  }

  /**
   * Returns the frontmost hit in the visual stacking order
   *
   * The arbitration walks the indices of orderedFeatures in descending order (from the
   * front) and takes the first feature that satisfies test(). The distance is not used (the
   * visual stacking order is the only order: a point on top of a polygon wins, and a
   * polygon in front occludes a point behind it).
   */
  hitTest(
    screenPoint: ScreenPoint,
    unproject: UnprojectFunction,
    orderedFeatures: Feature[],
  ): HitTestResult | null {
    const results = this.hitTestAll(screenPoint, unproject, orderedFeatures);
    if (results.length === 0) return null;
    if (results.length === 1) return results[0];

    const byId = new Map(results.map((r) => [r.feature.id, r]));
    for (let i = orderedFeatures.length - 1; i >= 0; i--) {
      const result = byId.get(orderedFeatures[i].id);
      if (result) return result;
    }

    // The candidates are narrowed down from orderedFeatures, so this is never reached
    // (a safety net)
    return results[0];
  }

  hitTestAll(
    screenPoint: ScreenPoint,
    unproject: UnprojectFunction,
    orderedFeatures: Feature[],
  ): HitTestResult[] {
    const lngLat = unproject(screenPoint);
    const coordinate: Coordinate = [lngLat.lng, lngLat.lat];

    // The tolerance is a screen length. It is converted into degrees of longitude at the
    // click latitude by measuring the ground length of clickTolerance pixels, so it does not
    // depend on the bearing (see local-frame.ts)
    const tolerance = this.options.clickTolerance;
    const toleranceLngLat = toleranceDegrees(unproject, screenPoint, tolerance);

    // Stage 1: narrow down the candidates with the spatial index.
    // The search radius is widened by the registered extra reach
    // (registerCandidateReach). Unlike the approach of baking the appearance into the bbox
    // of the index, this does not depend on the state or the zoom. The tolerance passed to
    // the second stage is toleranceLngLat as before (only the candidate set widens; the
    // semantics of a hit are decided by the strategy).
    const searchRadius = this.expandSearchRadius(
      toleranceLngLat,
      tolerance,
      screenPoint,
      unproject,
    );
    // The click on each copy of the world it can reach (the stored copy alone away from the
    // antimeridian; local-frame.ts)
    const copies = clickCopies(coordinate, searchRadius);
    const candidatesByCopy = copies.map(
      (copy) => new Set(this.spatialIndex.findNear(copy, searchRadius)),
    );
    const isCandidate = (id: string): boolean => candidatesByCopy.some((set) => set.has(id));

    // Filter down to the visible features only.
    // A lock forbids interaction, not selection, so nothing is excluded here for it
    // (a locked feature can still be selected, and moving / transforming / deleting it is
    // rejected on the interaction side).
    // Hidden features (visible=false on the feature / layer / group) are not drawn, so they
    // are excluded from the selection targets.
    // Layers and groups are looked up only once per container (not once per feature).
    const selectable = createVisibilityLookup(this.store);
    const visibleCandidates = orderedFeatures.filter((f) => {
      if (!isCandidate(f.id)) return false;
      return selectable(f);
    });

    // Symbols (points) are tested in screen space. This works only while the terrain is
    // enabled; when it is disabled null is returned and the conventional path is used as
    // before.
    const degPerPx = tolerance > 0 ? toleranceLngLat / tolerance : 0;
    const screen = this.hitTestAnchorsInScreenSpace(
      screenPoint,
      orderedFeatures,
      tolerance,
      degPerPx,
      selectable,
    );

    // Stage 2: the precise test
    const results: HitTestResult[] = screen ? [...screen.results] : [];

    for (const feature of visibleCandidates) {
      // Types already tested in screen space are not sent down the longitude/latitude path
      // (they would be added twice)
      if (screen?.handledTypes.has(feature.type)) continue;
      const strategy = this.registry.get(feature.type);
      if (!strategy) continue;

      // The feature is tested against the click on each copy it is a candidate of, and the
      // nearest hit counts. It is tested in the shape it is drawn with (the result keeps the
      // stored feature)
      const shape = this.drawnShape(feature);
      let best: number | null = null;
      for (let i = 0; i < copies.length; i++) {
        if (!candidatesByCopy[i].has(feature.id)) continue;
        const copy = copies[i];
        let distance: number | null = null;
        // A strategy that has testDistance finishes the test and the distance computation in
        // a single scan
        if (strategy.testDistance) {
          distance = strategy.testDistance(shape, copy, toleranceLngLat);
        } else if (strategy.test(shape, copy, toleranceLngLat)) {
          distance = strategy.distance(shape, copy);
        }
        if (distance !== null && (best === null || distance < best)) best = distance;
      }
      if (best !== null) results.push({ feature, distance: best });
    }

    // Sort by distance
    results.sort((a, b) => a.distance - b.distance);

    return results;
  }

  /**
   * Tests the anchors of the symbols in screen coordinates
   *
   * The candidates are the points that fall within the field of view. Occluded points are
   * candidates too (they are drawn without a depth test and are actually visible). The
   * spatial index is not used: as long as the longitude/latitude obtained by unprojecting
   * the click point lands on the terrain surface in front, nearness in longitude/latitude
   * does not agree with nearness on screen.
   *
   * The distance is converted back into a longitude difference so that it can be lined up
   * with the other results (it is multiplied by the longitude difference per screen pixel).
   * The meaning of the ordering does not change.
   *
   * @returns null when the anchor projection is unusable (it falls back to the conventional
   *   path)
   */
  private hitTestAnchorsInScreenSpace(
    screenPoint: ScreenPoint,
    orderedFeatures: Feature[],
    tolerancePx: number,
    degPerPx: number,
    selectable: VisibilityLookup,
  ): { results: HitTestResult[]; handledTypes: Set<string> } | null {
    const projector = this.anchorScreen;
    if (!projector) return null;

    const results: HitTestResult[] = [];
    let usable = false;

    for (const feature of orderedFeatures) {
      if (!SCREEN_SPACE_TYPES.has(feature.type)) continue;
      if (!selectable(feature)) continue;

      const reachPx = tolerancePx + this.candidateReachPx(feature.type);
      const parts =
        feature.type === 'MultiPoint'
          ? (coordinatesOf(feature) as Coordinate[])
          : [coordinatesOf(feature) as Coordinate];

      let nearest = Number.POSITIVE_INFINITY;
      for (const coord of parts) {
        const point = projector.project(coord);
        // null means the anchor projection is unusable (the terrain is disabled, or the
        // point is behind the camera). In the former case nothing at all is projected, so
        // this whole path is not used.
        if (!point) continue;
        usable = true;
        const distance = Math.hypot(point.x - screenPoint.x, point.y - screenPoint.y);
        if (distance < nearest) nearest = distance;
      }

      if (nearest <= reachPx) {
        results.push({ feature, distance: nearest * degPerPx });
      }
    }

    if (!usable) return null;
    return { results, handledTypes: SCREEN_SPACE_TYPES };
  }

  /**
   * The extra reach registered for a type (in CSS pixels)
   */
  private candidateReachPx(type: string): number {
    const reach = this.candidateReach.get(type);
    if (reach === undefined) return 0;
    const value = typeof reach === 'function' ? reach() : reach;
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  hitTestFeature(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): boolean {
    const strategy = this.registry.get(feature.type);
    if (!strategy) return false;
    return strategy.test(this.drawnShape(feature), coordinate, toleranceLngLat);
  }
}
