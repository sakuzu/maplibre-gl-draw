// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SnapService
 *
 * It gathers the candidates from the registered providers, picks the single point
 * closest to the cursor and replaces the coordinate. The call is made just before
 * InputRouter hands the event to a mode, so every mode (including custom modes from
 * plugins) and the vertex dragging of the select mode supports snapping without any
 * change.
 *
 * The way one is picked is as follows.
 *
 *   1. Candidates of a disabled kind (options.kinds) are discarded
 *   2. Candidates outside the tolerance (pixels) are discarded
 *   3. The priority order of the kinds is vertex > intersection > edge > guide
 *   4. Within the same priority, the closer one wins
 *
 * 'snap.change' is emitted only when the result changed (the public name is
 * 'draw.snap.change'). When the snap comes off, it is emitted once without a target.
 */

import type { ModifierKeys } from '../dispatcher/types.js';
import type { ScreenPoint } from '../shared/math/index.js';
import { DEFAULT_TILE_SIZE } from '../shared/math/index.js';
import { nearestLongitude, wrapLongitude } from '../shared/math/longitude.js';
import type { EventEmitter } from '../shared/utils/event-emitter.js';
import { isSameVertexRef } from '../shared/utils/vertex-ref.js';
import type { SpatialIndex } from '../store/spatial/spatial-index.js';
import type { Store } from '../store/store.js';
import type { BoundingBox, Coordinate, VertexRef } from '../store/types.js';
import type { SnapTargetsRegistry } from './custom-targets.js';
import type { DegreesPerPixel } from './geometry.js';
import { degreesPerPixel, distanceInPixels, nearestPointOnSegment } from './geometry.js';
import type { GuideSnapProviderOptions } from './providers/guide.js';
import { createBuiltInSnapProviders } from './providers/store.js';
import type {
  ResolvedSnapOptions,
  SnapContext,
  SnapDisableKey,
  SnapLngLat,
  SnapOptions,
  SnapProvider,
  SnapProviderContext,
  SnapResult,
  SnapService,
  SnapTarget,
  SnapTargetKind,
  SnapTargetSegment,
} from './types.js';
import {
  DEFAULT_SNAP_OPTIONS,
  isSegmentCandidate,
  resolveGuideStepDegrees,
  resolveSnapKinds,
  SNAP_KIND_PRIORITY,
} from './types.js';

/**
 * The dependencies of SnapService
 *
 * The built-in providers (the vertices, edges and intersections of the Store, and the
 * guides) are registered only when both store and spatialIndex are present. A unit
 * test can omit both and register only the providers it needs.
 *
 * @internal
 */
export interface SnapServiceDeps {
  /** The Store (for the built-in providers) */
  store?: Store;
  /** The SpatialIndex (for the built-in providers) */
  spatialIndex?: SpatialIndex;
  /** The snapping candidates of the custom feature types of this draw instance */
  snapTargets?: SnapTargetsRegistry;
  /** Where 'snap.change' is emitted to */
  eventEmitter?: EventEmitter;
  /** The snapping options */
  options?: SnapOptions;
  /** The tile size (used to convert pixels into degrees) */
  tileSize?: number;
  /** The arguments for building the built-in guides (the messages; the step angle comes from
   * `options.guideStepDegrees`) */
  guide?: Omit<GuideSnapProviderOptions, 'northStepDegrees'>;
}

/**
 * Whether it is temporarily disabled by a modifier key
 */
function isDisabledByModifier(modifiers: ModifierKeys, key: SnapDisableKey): boolean {
  if (key === 'none') return false;
  return modifiers[key];
}

/**
 * Whether the vertex references are the same (two unspecified ones also count as the
 * same)
 */
function isSameVertex(a: VertexRef | undefined, b: VertexRef | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return isSameVertexRef(a, b);
}

/**
 * Whether the segments of the snapping targets are the same (two unspecified ones also
 * count as the same)
 *
 * Even when the snapped point does not move, a different segment means a different
 * snapping target, so it is treated as a change.
 */
function isSameSegment(
  a: SnapTargetSegment | undefined,
  b: SnapTargetSegment | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.start[0] === b.start[0] &&
    a.start[1] === b.start[1] &&
    a.end[0] === b.end[0] &&
    a.end[1] === b.end[1]
  );
}

/**
 * Whether the 2 results are the same (used to decide whether to emit an event)
 */
function isSameResult(a: SnapResult | null, b: SnapResult): boolean {
  // The first resolution counts as a change only when something was snapped to (not
  // being snapped is the default state)
  if (!a) return b.target === undefined;
  if (a.target === undefined && b.target === undefined) return true;
  if (a.target === undefined || b.target === undefined) return false;
  return (
    a.target.kind === b.target.kind &&
    a.target.featureId === b.target.featureId &&
    a.target.datasetId === b.target.datasetId &&
    a.target.description === b.target.description &&
    isSameVertex(a.target.vertex, b.target.vertex) &&
    isSameSegment(a.target.segment, b.target.segment) &&
    a.lngLat.lng === b.lngLat.lng &&
    a.lngLat.lat === b.lngLat.lat
  );
}

/**
 * The result of evaluating a candidate
 */
interface BestCandidate {
  coordinate: Coordinate;
  target: SnapTarget;
  priority: number;
  distancePx: number;
  /** Whether the candidate matches ctx.preferFeature (used as the tie-break on a tie) */
  preferred: boolean;
}

/**
 * Whether the new candidate replaces the current best candidate
 */
function isBetterCandidate(
  best: BestCandidate,
  priority: number,
  distancePx: number,
  preferred: boolean,
): boolean {
  if (best.priority !== priority) return priority < best.priority;
  if (best.distancePx !== distancePx) return distancePx < best.distancePx;
  // Only on a complete tie does a candidate of the preferred feature overturn the one
  // that arrived first
  return preferred && !best.preferred;
}

/**
 * Creates a SnapService
 *
 * @internal
 */
export function createSnapService(deps: SnapServiceDeps = {}): SnapService {
  // kinds is nested, so it is copied (so that the defaults object is not rewritten)
  const options: ResolvedSnapOptions = {
    ...DEFAULT_SNAP_OPTIONS,
    ...deps.options,
    kinds: resolveSnapKinds(deps.options?.kinds),
    datasets: deps.options?.datasets ?? DEFAULT_SNAP_OPTIONS.datasets,
    guideStepDegrees: resolveGuideStepDegrees(deps.options?.guideStepDegrees),
  };
  const tileSize = deps.tileSize ?? DEFAULT_TILE_SIZE;
  const providers: SnapProvider[] = [];

  let enabled = options.enabled;
  let lastResult: SnapResult | null = null;

  if (deps.store && deps.spatialIndex) {
    providers.push(
      ...createBuiltInSnapProviders(
        { store: deps.store, spatialIndex: deps.spatialIndex, snapTargets: deps.snapTargets },
        {
          tileSize,
          ...deps.guide,
          // Read at every query, so setGuideStep takes effect without rebuilding the provider
          getNorthStepDegrees: () => options.guideStepDegrees,
        },
      ),
    );
  }

  /**
   * Stores the result and emits an event when it changed
   */
  function publish(result: SnapResult): SnapResult {
    const changed = !isSameResult(lastResult, result);
    lastResult = result;
    if (changed) {
      deps.eventEmitter?.emit('snap.change', result);
    }
    return result;
  }

  /**
   * Evaluates a single candidate and updates best
   *
   * They are compared by the priority of the kind first and then by distance, and only
   * when the distances tie as well does the candidate matching preferFeature
   * (preferred) win. Otherwise the one that arrived first is kept.
   */
  function evaluate(
    best: BestCandidate | null,
    coordinate: Coordinate,
    target: SnapTarget,
    cursor: Coordinate,
    perPixel: DegreesPerPixel,
    preferred: boolean,
  ): BestCandidate | null {
    const distancePx = distanceInPixels(coordinate, cursor, perPixel);
    if (distancePx > options.tolerancePx) return best;

    const priority = SNAP_KIND_PRIORITY[target.kind];
    if (best && !isBetterCandidate(best, priority, distancePx, preferred)) {
      return best;
    }
    return { coordinate, target, priority, distancePx, preferred };
  }

  /** How far a longitude moves to reach its copy nearest to the cursor (0 in most cases) */
  function turnToCursor(lng: number, cursorLng: number): number {
    return nearestLongitude(lng, cursorLng) - lng;
  }

  /** A coordinate moved along the longitude (the same array when it does not move) */
  function moveBy(coordinate: Coordinate, turn: number): Coordinate {
    return turn === 0 ? coordinate : [coordinate[0] + turn, coordinate[1]];
  }

  function resolve(lngLat: SnapLngLat, point: ScreenPoint, ctx: SnapContext): SnapResult {
    if (!enabled || isDisabledByModifier(ctx.modifiers, options.disableKey)) {
      return publish({ lngLat });
    }

    const perPixel = degreesPerPixel(lngLat.lat, ctx.zoom, tileSize);
    const toleranceLngDeg = perPixel.lng * options.tolerancePx;
    const toleranceLatDeg = perPixel.lat * options.tolerancePx;
    const cursor: Coordinate = [lngLat.lng, lngLat.lat];

    // The cursor on each copy of the world its tolerance reaches. The features are stored in
    // [-180, 180], while the cursor comes in the unwrapped longitude of the view (above 180 on
    // the copy east of the antimeridian, where the rendering draws the stored features a second
    // time). The candidates are looked up around the cursor brought into [-180, 180], and also
    // on the neighbouring copy when the tolerance runs past ±180. Each candidate is then taken
    // on its copy nearest to the cursor (a segment moves by the turn of its start), so it is
    // evaluated and returned in the frame of the cursor; a candidate already in that frame (a
    // guide drawn from the tentative) does not move. Away from the antimeridian this is the
    // cursor alone, and nothing moves.
    const stored = wrapLongitude(lngLat.lng);
    const copies = [stored];
    if (stored + toleranceLngDeg > 180) copies.push(stored - 360);
    if (stored - toleranceLngDeg < -180) copies.push(stored + 360);

    let best: BestCandidate | null = null;

    for (const copyLng of copies) {
      const copyLngLat: SnapLngLat =
        copyLng === lngLat.lng ? lngLat : { lng: copyLng, lat: lngLat.lat };

      const bbox: BoundingBox = {
        minX: copyLng - toleranceLngDeg,
        minY: lngLat.lat - toleranceLatDeg,
        maxX: copyLng + toleranceLngDeg,
        maxY: lngLat.lat + toleranceLatDeg,
      };

      const providerCtx: SnapProviderContext = {
        ...ctx,
        lngLat: copyLngLat,
        point,
        tolerancePx: options.tolerancePx,
        toleranceLngDeg,
        toleranceLatDeg,
      };

      for (const provider of providers) {
        let candidates: ReturnType<SnapProvider['candidates']>;
        try {
          candidates = provider.candidates(bbox, providerCtx);
        } catch (error) {
          // An exception from one provider does not stop snapping as a whole
          console.error(`Error in snap provider "${provider.name}":`, error);
          continue;
        }

        for (const candidate of candidates) {
          // Candidates of a disabled kind are not evaluated
          if (!options.kinds[candidate.kind]) continue;

          let coordinate: Coordinate;
          if (isSegmentCandidate(candidate)) {
            const turn = turnToCursor(candidate.start[0], lngLat.lng);
            coordinate = nearestPointOnSegment(
              cursor,
              moveBy(candidate.start, turn),
              moveBy(candidate.end, turn),
              perPixel,
            );
          } else {
            coordinate = moveBy(
              candidate.coordinate,
              turnToCursor(candidate.coordinate[0], lngLat.lng),
            );
          }

          // The target keeps the stored coordinates (it names the geometry that was snapped to)
          const target: SnapTarget = { kind: candidate.kind };
          if (candidate.featureId !== undefined) target.featureId = candidate.featureId;
          if (candidate.datasetId !== undefined) target.datasetId = candidate.datasetId;
          if (candidate.description !== undefined) target.description = candidate.description;
          if (isSegmentCandidate(candidate)) {
            const segment: SnapTargetSegment = { start: candidate.start, end: candidate.end };
            if (candidate.startRef !== undefined) segment.startRef = candidate.startRef;
            if (candidate.endRef !== undefined) segment.endRef = candidate.endRef;
            target.segment = segment;
          } else if (candidate.vertex !== undefined) {
            target.vertex = candidate.vertex;
          }

          // Whether it matches the "preferred feature" used as the tie-break on a tie
          // (two unspecified datasetIds also count as a match)
          const preferred =
            ctx.preferFeature !== undefined &&
            candidate.featureId === ctx.preferFeature.featureId &&
            candidate.datasetId === ctx.preferFeature.datasetId;

          best = evaluate(best, coordinate, target, cursor, perPixel, preferred);
        }
      }
    }

    if (!best) {
      return publish({ lngLat });
    }

    return publish({
      lngLat: { lng: best.coordinate[0], lat: best.coordinate[1] },
      target: best.target,
    });
  }

  return {
    resolve,

    register(provider: SnapProvider): () => void {
      providers.push(provider);
      return () => {
        const index = providers.indexOf(provider);
        if (index >= 0) providers.splice(index, 1);
      };
    },

    setEnabled(value: boolean): void {
      enabled = value;
    },

    isEnabled(): boolean {
      return enabled;
    },

    setKindEnabled(kind: SnapTargetKind, value: boolean): void {
      options.kinds[kind] = value;
    },

    isKindEnabled(kind: SnapTargetKind): boolean {
      return options.kinds[kind];
    },

    setDatasetsEnabled(value: boolean): void {
      options.datasets = value;
    },

    isDatasetsEnabled(): boolean {
      return options.datasets;
    },

    setGuideStep(degrees: number): void {
      options.guideStepDegrees = resolveGuideStepDegrees(degrees);
    },

    getResult(): SnapResult | null {
      return lastResult;
    },

    getOptions(): ResolvedSnapOptions {
      return { ...options, enabled, kinds: { ...options.kinds } };
    },
  };
}
