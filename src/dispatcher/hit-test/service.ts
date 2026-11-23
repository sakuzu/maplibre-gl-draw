// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HitTestService
 *
 * The service that integrates the two-stage hit testing.
 * 1. Narrowing down the candidates with the spatial index of the Store (the boxes of its rows)
 * 2. The precise test with a HitTestStrategy
 */

import type { ScreenPoint } from '../../shared/math/index.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import type { DocumentAccess, DocumentBoxes } from '../../store/document-access.js';
import type { SpatialIndex } from '../../store/spatial/spatial-index.js';
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
const SCREEN_SPACE_TYPES: ReadonlySet<string> = new Set(['Point', 'MultiPoint']);

/**
 * The two-stage hit test of the features of the Store: candidates from the spatial index,
 * then the precise test of each type's {@link HitTestStrategy}.
 *
 * Extensions receive it through their context. The tolerance is the click tolerance of the
 * draw instance (6 px by default).
 */
export interface HitTestService {
  /**
   * Changes how far from a feature a click still hits it, in CSS pixels
   *
   * @param px The new tolerance
   */
  setClickTolerance(px: number): void;
  /**
   * Returns the frontmost feature that is hit, of those shown
   *
   * The candidates are the features the spatial index finds near the position; only they are
   * made, and the frontmost of those hit is decided by the stacking order.
   *
   * @param screenPoint The position in CSS px relative to the map container
   * @param unproject Converts screen positions into degrees
   * @returns The hit, or `null` when nothing is hit
   */
  hitTest(screenPoint: ScreenPoint, unproject: UnprojectFunction): HitTestResult | null;

  /**
   * Returns every feature shown that is hit, sorted by distance (the closest first; those as
   * close in stacking order, from the back)
   *
   * @param screenPoint The position in CSS px relative to the map container
   * @param unproject Converts screen positions into degrees
   * @returns The hits. An empty array when nothing is hit
   */
  hitTestAll(screenPoint: ScreenPoint, unproject: UnprojectFunction): HitTestResult[];

  /**
   * Returns the features given that are hit, sorted by distance (the closest first), as
   * `hitTestAll` tests them: only those the spatial index finds near the position and whose
   * visible flags (their own, their layer's and their group's) are on
   *
   * @param screenPoint The position in CSS px relative to the map container
   * @param unproject Converts screen positions into degrees
   * @param features The features to test, in display order
   * @returns The hits. An empty array when none is hit
   */
  hitTestFeatures(
    screenPoint: ScreenPoint,
    unproject: UnprojectFunction,
    features: readonly Feature[],
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
   * The strategy registered for a type, or `undefined`
   */
  getStrategy?(type: string): HitTestStrategy | undefined;

  /**
   * Registers, per feature type, the extra reach (in CSS pixels) for narrowing down the
   * candidates
   *
   * The first stage narrows down the candidates with a radius equivalent to clickTolerancePx,
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
  /**
   * How far the marker of a built-in point reaches from its position. When given, the built-in
   * `Point` and `MultiPoint` strategies hit a point within that reach plus the tolerance, so a
   * click anywhere on its marker hits it; when omitted a point is hit within the tolerance of its
   * position alone
   */
  pointMarker?: PointMarkerReach;
}

/**
 * How far the markers of the points reach from their positions, in CSS pixels
 *
 * @internal
 */
export interface PointMarkerReach {
  /** How far the marker of a point reaches */
  reachPx(feature: Feature): number;
  /**
   * A reach no marker of a point goes beyond (it may be larger than the largest): the candidates
   * are searched as far, without every point being read
   */
  maxReachPx(): number;
}

/**
 * The reads of the layer the hit test needs: the features, their visible flags, those shown in
 * stacking order and the points shown
 *
 * @internal
 */
export type HitTestDocument = DocumentAccess &
  Pick<DocumentBoxes, 'listShownInOrder' | 'listShownPoints'>;

/** What a hit test at one position works out before testing its candidates */
interface HitQuery {
  /** The position in degrees */
  readonly coordinate: Coordinate;
  /** The click tolerance in CSS pixels */
  readonly tolerancePx: number;
  /** The click tolerance in degrees of longitude at the position */
  readonly toleranceLngLat: number;
  /** The degrees per CSS pixel at the position, measured once and only when needed */
  degPerPx(): number;
  /** The position on each copy of the world it can reach */
  readonly copies: Coordinate[];
  /** The candidates the spatial index found on each copy */
  readonly candidatesByCopy: Set<string>[];
}

/**
 * The HitTestService implementation
 *
 * @internal
 */
export class HitTestServiceImpl implements HitTestService {
  private spatialIndex: SpatialIndex;
  private store: HitTestDocument;
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
  /** How far the markers of the points reach (null: a point is hit at its position alone) */
  private pointMarker: PointMarkerReach | null;

  setClickTolerance(px: number): void {
    this.options = { ...this.options, clickTolerancePx: px };
  }

  constructor(
    store: HitTestDocument,
    spatialIndex: SpatialIndex,
    options: HitTestServiceImplOptions = {},
  ) {
    this.store = store;
    this.spatialIndex = spatialIndex;
    this.anchorScreen = options.anchorScreen ?? null;
    this.drawnShape = options.drawnShape ?? ((feature) => feature);
    this.pointMarker = options.pointMarker ?? null;
    this.options = { ...DEFAULT_HIT_TEST_OPTIONS, ...options };
    const tileSize = options.tileSize ?? 512;

    // Register the default strategies
    this.registry = new HitTestStrategyRegistry();
    const marker = options.pointMarker;
    const markerReach = marker ? (feature: Feature) => marker.reachPx(feature) : undefined;
    this.registry.register(withReach(new PointHitTestStrategy(), markerReach));
    this.registry.register(new LineHitTestStrategy());
    this.registry.register(new PolygonHitTestStrategy());
    this.registry.register(new CircleHitTestStrategy());

    // The Multi geometries (a hit if any part is hit / the distance is the minimum over the
    // parts)
    this.registry.register(withReach(new MultiPointHitTestStrategy(), markerReach));
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
   * The strategy registered for a type
   */
  getStrategy(type: string): HitTestStrategy | undefined {
    return this.registry.get(type);
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
   * What a hit test at a position works out before it tests its candidates: the tolerance in
   * degrees, and the candidates of the spatial index on each copy of the world the position
   * reaches, searched as far as the tolerance widened by the extra reach
   *
   * The degrees per pixel are obtained by dividing the already computed toleranceLngLat by
   * clickTolerancePx (so no additional call to unproject is made). Only when clickTolerancePx is
   * 0 is one pixel measured directly.
   *
   * The radius is a square box in degrees. A latitude reach needs only radius * cos φ
   * (local-frame.ts), so the box never misses a candidate.
   *
   * @param featureReachPx The reach of the features beyond their geometry the search is widened
   *   by (the markers of the points)
   */
  private queryAt(
    screenPoint: ScreenPoint,
    unproject: UnprojectFunction,
    featureReachPx: number,
  ): HitQuery {
    const lngLat = unproject(screenPoint);
    const coordinate: Coordinate = [lngLat.lng, lngLat.lat];

    // The tolerance is a screen length. It is converted into degrees of longitude at the click
    // latitude by measuring the ground length of clickTolerancePx pixels, so it does not depend
    // on the bearing (see local-frame.ts)
    const tolerancePx = this.options.clickTolerancePx;
    const toleranceLngLat = toleranceDegrees(unproject, screenPoint, tolerancePx);

    // Stage 1: narrow down the candidates with the spatial index.
    // The search radius is widened by the registered extra reach
    // (registerCandidateReach). Unlike the approach of baking the appearance into the bbox
    // of the index, this does not depend on the state or the zoom. The tolerance passed to
    // the second stage is toleranceLngLat as before, widened only by the reach of a strategy
    // (the marker of a point); the registered reach widens only the candidate set.
    // The degrees per CSS pixel at the click, measured once and only when needed (from the
    // tolerance already converted, or from one pixel when the tolerance is 0)
    let degPerPxMemo: number | undefined;
    const degPerPx = (): number => {
      degPerPxMemo ??=
        tolerancePx > 0
          ? toleranceLngLat / tolerancePx
          : toleranceDegrees(unproject, screenPoint, 1);
      return degPerPxMemo;
    };
    const reachPx = this.maxCandidateReachPx() + featureReachPx;
    const searchRadius = reachPx > 0 ? toleranceLngLat + reachPx * degPerPx() : toleranceLngLat;
    // The click on each copy of the world it can reach (the stored copy alone away from the
    // antimeridian; local-frame.ts)
    const copies = clickCopies(coordinate, searchRadius);
    const candidatesByCopy = copies.map(
      (copy) => new Set(this.spatialIndex.findNear(copy, searchRadius)),
    );
    return { coordinate, tolerancePx, toleranceLngLat, degPerPx, copies, candidatesByCopy };
  }

  /**
   * A reach no marker of a point goes beyond, in CSS pixels (0 when the points have none)
   *
   * The reach of a strategy (`HitTestStrategy.reachPx`) is that of the marker of a built-in
   * point, or of the points an override leaves to the built-in type, so the candidates searched
   * as far take every feature a strategy reaches, without every feature being read.
   */
  private maxPointReachPx(): number {
    if (!this.pointMarker) return 0;
    const reach = this.pointMarker.maxReachPx();
    return Number.isFinite(reach) && reach > 0 ? reach : 0;
  }

  /**
   * The largest reach beyond its geometry among the features given whose strategy has one
   * (`HitTestStrategy.reachPx`, the markers of the points), in CSS pixels
   *
   * The reach depends on the style of each feature, so it is measured at query time like the
   * rest of the appearance (the bounding boxes of the index stay those of the geometry).
   */
  private maxFeatureReachPx(features: readonly Feature[]): number {
    let max = 0;
    let lastType: string | undefined;
    let reachOf: ((feature: Feature) => number) | undefined;
    for (const feature of features) {
      if (feature.type !== lastType) {
        lastType = feature.type;
        const strategy = this.registry.get(feature.type);
        reachOf = strategy?.reachPx?.bind(strategy);
      }
      if (!reachOf) continue;
      const reach = reachOf(feature);
      if (reach > max) max = reach;
    }
    return max;
  }

  /**
   * Returns the frontmost hit in the visual stacking order
   *
   * The arbitration takes, among the features hit, the one in front in the stacking order. The
   * distance is not used (the visual stacking order is the only order: a point on top of a
   * polygon wins, and a polygon in front occludes a point behind it).
   */
  hitTest(screenPoint: ScreenPoint, unproject: UnprojectFunction): HitTestResult | null {
    const results = this.hitTestAll(screenPoint, unproject);
    if (results.length === 0) return null;
    if (results.length === 1) return results[0];

    const byId = new Map(results.map((r) => [r.feature.id, r]));
    const inOrder = this.store.listShownInOrder(byId.keys()).ids;
    for (let i = inOrder.length - 1; i >= 0; i--) {
      const result = byId.get(inOrder[i]);
      if (result) return result;
    }

    // Every result is a feature shown, so this is never reached (a safety net)
    return results[0];
  }

  hitTestAll(screenPoint: ScreenPoint, unproject: UnprojectFunction): HitTestResult[] {
    const query = this.queryAt(screenPoint, unproject, this.maxPointReachPx());

    // The candidates the features shown, in stacking order: only they are made.
    // A lock forbids interaction, not selection, so nothing is excluded here for it
    // (a locked feature can still be selected, and moving / transforming / deleting it is
    // rejected on the interaction side).
    // Hidden features (visible=false on the feature / layer / group, or hidden by this client)
    // are not drawn, so they are excluded from the selection targets, as are the features of a
    // layer off the stacking order
    const candidates = new Set<string>();
    for (const set of query.candidatesByCopy) for (const id of set) candidates.add(id);
    const shown = candidates.size > 0 ? this.store.listShownInOrder(candidates).ids : [];

    // Symbols (points) are tested in screen space. This works only while the terrain is
    // enabled; when it is disabled null is returned and the conventional path is used as
    // before.
    const screen = this.screenHitsOfShownPoints(
      screenPoint,
      query.coordinate,
      query.tolerancePx,
      query.tolerancePx > 0 ? query.toleranceLngLat / query.tolerancePx : 0,
    );

    // Stage 2: the precise test
    const results: HitTestResult[] = screen ? [...screen.results] : [];
    for (const id of shown) {
      const feature = this.store.getFeature(id);
      if (feature) this.testCandidate(feature, query, screen?.handledTypes, results);
    }

    // Sort by distance
    results.sort((a, b) => a.distance - b.distance);

    return results;
  }

  hitTestFeatures(
    screenPoint: ScreenPoint,
    unproject: UnprojectFunction,
    features: readonly Feature[],
  ): HitTestResult[] {
    const query = this.queryAt(screenPoint, unproject, this.maxFeatureReachPx(features));
    const isCandidate = (id: string): boolean => query.candidatesByCopy.some((set) => set.has(id));

    // Filter down to the visible features only (a lock is not looked at, as in hitTestAll).
    // Layers and groups are looked up only once per container (not once per feature).
    const selectable = createVisibilityLookup(this.store);
    const visibleCandidates = features.filter((f) => isCandidate(f.id) && selectable(f));

    const screen = this.screenHitsOfFeatures(
      screenPoint,
      features,
      query.tolerancePx,
      query.tolerancePx > 0 ? query.toleranceLngLat / query.tolerancePx : 0,
      selectable,
    );

    const results: HitTestResult[] = screen ? [...screen.results] : [];
    for (const feature of visibleCandidates) {
      this.testCandidate(feature, query, screen?.handledTypes, results);
    }
    results.sort((a, b) => a.distance - b.distance);
    return results;
  }

  /**
   * Tests a candidate with the strategy of its type, against the click on each copy of the world
   * it is a candidate of, and adds it to the results when it is hit (the nearest hit counts)
   *
   * @param handledTypes The types already tested in screen space, which are not sent down the
   *   longitude/latitude path (they would be added twice)
   */
  private testCandidate(
    feature: Feature,
    query: HitQuery,
    handledTypes: ReadonlySet<string> | undefined,
    results: HitTestResult[],
  ): void {
    if (handledTypes?.has(feature.type)) return;
    const strategy = this.registry.get(feature.type);
    if (!strategy) return;

    // It is tested in the shape it is drawn with (the result keeps the stored feature)
    const shape = this.drawnShape(feature);
    // What is drawn beyond the geometry (the marker of a point) is hit as well
    const reachPx = strategy.reachPx?.(feature) ?? 0;
    const featureTolerance =
      reachPx > 0 ? query.toleranceLngLat + reachPx * query.degPerPx() : query.toleranceLngLat;
    let best: number | null = null;
    for (let i = 0; i < query.copies.length; i++) {
      if (!query.candidatesByCopy[i].has(feature.id)) continue;
      const copy = query.copies[i];
      let distance: number | null = null;
      // A strategy that has testDistance finishes the test and the distance computation in
      // a single scan
      if (strategy.testDistance) {
        distance = strategy.testDistance(shape, copy, featureTolerance);
      } else if (strategy.test(shape, copy, featureTolerance)) {
        distance = strategy.distance(shape, copy);
      }
      if (distance !== null && (best === null || distance < best)) best = distance;
    }
    if (best !== null) results.push({ feature, distance: best });
  }

  /**
   * Tests the anchors of the points shown in screen coordinates
   *
   * The candidates are the points that fall within the field of view. Occluded points are
   * candidates too (they are drawn without a depth test and are actually visible). The
   * spatial index is not used: as long as the longitude/latitude obtained by unprojecting
   * the click point lands on the terrain surface in front, nearness in longitude/latitude
   * does not agree with nearness on screen.
   *
   * The positions are read from the rows and projected without the features being made; only a
   * point whose anchor falls within the tolerance and the reach no marker goes beyond is made, and
   * tested as its own marker reaches. While the terrain is disabled the projection of the click
   * itself is null (nothing at all is projected then), and no point is read.
   *
   * The distance is converted back into a longitude difference so that it can be lined up
   * with the other results (it is multiplied by the longitude difference per screen pixel).
   * The meaning of the ordering does not change.
   *
   * @returns null when the anchor projection is unusable (it falls back to the conventional
   *   path)
   */
  private screenHitsOfShownPoints(
    screenPoint: ScreenPoint,
    coordinate: Coordinate,
    tolerancePx: number,
    degPerPx: number,
  ): { results: HitTestResult[]; handledTypes: ReadonlySet<string> } | null {
    const projector = this.anchorScreen;
    // While the terrain is disabled nothing projects, the click itself included
    if (!projector?.project(coordinate)) return null;

    const points = this.store.listShownPoints();
    const markerReachPx = this.maxPointReachPx();
    const results: HitTestResult[] = [];
    let usable = false;
    const position: Coordinate = [0, 0];

    for (let k = 0; k < points.types.length; k++) {
      let nearest = Number.POSITIVE_INFINITY;
      for (let p = points.starts[k]; p < points.starts[k + 1]; p++) {
        position[0] = points.coordinates[p * 2];
        position[1] = points.coordinates[p * 2 + 1];
        const point = projector.project(position);
        // null means the anchor projection is unusable (the terrain is disabled, or the
        // point is behind the camera). In the former case nothing at all is projected, so
        // this whole path is not used.
        if (!point) continue;
        usable = true;
        const distance = Math.hypot(point.x - screenPoint.x, point.y - screenPoint.y);
        if (distance < nearest) nearest = distance;
      }
      const type = points.types[k];
      if (!(nearest <= tolerancePx + this.candidateReachPx(type) + markerReachPx)) continue;

      const feature = this.store.getFeature(points.idOf(k));
      if (!feature) continue;
      const reachPx =
        tolerancePx +
        this.candidateReachPx(feature.type) +
        (this.registry.get(feature.type)?.reachPx?.(feature) ?? 0);
      if (nearest <= reachPx) results.push({ feature, distance: nearest * degPerPx });
    }

    if (!usable) return null;
    return { results, handledTypes: SCREEN_SPACE_TYPES };
  }

  /**
   * Tests the anchors of the symbols among the features given in screen coordinates, as
   * {@link screenHitsOfShownPoints} tests those shown
   *
   * @returns null when the anchor projection is unusable (it falls back to the conventional
   *   path)
   */
  private screenHitsOfFeatures(
    screenPoint: ScreenPoint,
    features: readonly Feature[],
    tolerancePx: number,
    degPerPx: number,
    selectable: VisibilityLookup,
  ): { results: HitTestResult[]; handledTypes: ReadonlySet<string> } | null {
    const projector = this.anchorScreen;
    if (!projector) return null;

    const results: HitTestResult[] = [];
    let usable = false;

    for (const feature of features) {
      if (!SCREEN_SPACE_TYPES.has(feature.type)) continue;
      if (!selectable(feature)) continue;

      const reachPx =
        tolerancePx +
        this.candidateReachPx(feature.type) +
        (this.registry.get(feature.type)?.reachPx?.(feature) ?? 0);
      const parts =
        feature.type === 'MultiPoint'
          ? (coordinatesOf(feature) as Coordinate[])
          : [coordinatesOf(feature) as Coordinate];

      let nearest = Number.POSITIVE_INFINITY;
      for (const coord of parts) {
        const point = projector.project(coord);
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

/**
 * A built-in strategy that reaches as far as the feature is drawn (`HitTestStrategy.reachPx`)
 *
 * Without a reach the strategy is returned as it is.
 */
function withReach(
  strategy: HitTestStrategy,
  reachPx: ((feature: Feature) => number) | undefined,
): HitTestStrategy {
  if (!reachPx) return strategy;
  return {
    geometryType: strategy.geometryType,
    test: (feature, coordinate, tolerance) => strategy.test(feature, coordinate, tolerance),
    distance: (feature, coordinate) => strategy.distance(feature, coordinate),
    ...(strategy.testDistance && {
      testDistance: (feature: Feature, coordinate: Coordinate, tolerance: number) =>
        strategy.testDistance?.(feature, coordinate, tolerance) ?? null,
    }),
    reachPx,
  };
}
