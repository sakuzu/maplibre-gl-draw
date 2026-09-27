// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Type definitions for snapping
 *
 * The single entry point for coordinates is InputRouter, so replacing the
 * coordinates of click / mousemove / dragmove there with SnapService makes every
 * mode (including custom modes from plugins) and the vertex dragging of the select
 * mode support snapping without any change.
 *
 * A candidate (SnapCandidate) has 2 shapes.
 *
 *   Point candidate (SnapPointCandidate)     Holds the coordinate as it is. Used for
 *                                            vertices, intersections, guides, and
 *                                            for an edge whose nearest point the
 *                                            provider computed itself
 *   Segment candidate (SnapSegmentCandidate) Holds the 2 end points of an edge. The
 *                                            point closest to the cursor is computed
 *                                            by SnapService
 *
 * The built-in edge provider returns segment candidates and leaves the computation
 * of the nearest point (a projection in pixel space) to SnapService.
 */

import type { ModifierKeys } from '../dispatcher/types.js';
import type { ScreenPoint } from '../shared/math/index.js';
import type { SnapLngLat, SnapResult, SnapTargetKind } from '../shared/types/events.js';
import type { BoundingBox, Coordinate, Feature, VertexRef } from '../store/types.js';

// The result types of snapping are defined in shared/ because draw.snap.change carries them
export type {
  SnapLngLat,
  SnapResult,
  SnapTarget,
  SnapTargetKind,
  SnapTargetSegment,
} from '../shared/types/events.js';

/**
 * The priority of each kind (smaller wins)
 *
 * @internal
 */
export const SNAP_KIND_PRIORITY: Record<SnapTargetKind, number> = {
  vertex: 0,
  intersection: 1,
  edge: 2,
  guide: 3,
};

/**
 * A single vertex to leave out of the snapping candidates.
 *
 * A vertex being dragged would snap to itself, so it is excluded. Only 1 vertex is
 * excluded, and the other vertices of the same feature are still included (so that a
 * ring can be closed).
 */
export interface SnapExcludeVertex {
  /** The ID of the target feature */
  featureId: string;
  /** The reference of the vertex to exclude */
  vertex: VertexRef;
}

/**
 * The state of one snapping resolution: the zoom, the exclusions and the modifier keys.
 *
 * The library builds it for every input.
 */
export interface SnapContext {
  /** The current zoom level (used to convert the pixel tolerance into degrees) */
  zoom: number;
  /**
   * The feature ID to exclude (that whole feature is removed from the candidates)
   */
  excludeFeatureId?: string;
  /**
   * The set of feature IDs to exclude (each of them is removed from the candidates
   * entirely)
   *
   * The features being moved in a move drag (operation === 'move') go in here.
   * A feature being moved travels with the cursor, so snapping to itself would repeat
   * "pull the cursor back to its own position -> shift again by the grab offset on
   * the next frame" and the view would oscillate. The reason for excluding them is
   * the same as for excludeVertex; the only difference is that the target is a whole
   * feature rather than a single vertex.
   */
  excludeFeatureIds?: ReadonlySet<string>;
  /** The vertex to exclude (the vertex being dragged itself) */
  excludeVertex?: SnapExcludeVertex;
  /**
   * The feature to prefer when both the priority and the distance are tied
   *
   * The source is the anchor of the tracing (the boundary that was first traced).
   * When features whose boundary coordinates overlap exactly line up, the distances
   * of the candidates tie and the winner ends up being decided by the order in which
   * the candidates were listed, so this feature is made to win only on a tie, to keep
   * the snapping target from jumping to another feature. It does not overturn a
   * candidate that is closer.
   */
  preferFeature?: {
    /** The feature ID to prefer */
    featureId: string;
    /** When it originates from a dataset, that dataset ID */
    datasetId?: string;
  };
  /** The state of the modifier keys (used to decide on a temporary disabling) */
  modifiers: ModifierKeys;
}

/**
 * The context passed to {@link SnapProvider.candidates}: a {@link SnapContext} plus the cursor
 * position and the tolerance in pixels and in degrees.
 *
 * A provider should honor the exclusions (`excludeFeatureId`, `excludeFeatureIds`,
 * `excludeVertex`): the features being moved travel with the cursor, and snapping to them
 * would pull the cursor back to itself.
 */
export interface SnapProviderContext extends SnapContext {
  /** The cursor position in degrees */
  lngLat: SnapLngLat;
  /** The cursor position in screen px, relative to the map container */
  point: ScreenPoint;
  /** The tolerance in screen px (`options.snap.tolerancePx`) */
  tolerancePx: number;
  /** The tolerance converted into degrees of longitude at the current zoom */
  toleranceLngDeg: number;
  /** The tolerance converted into degrees of latitude at the cursor latitude and zoom */
  toleranceLatDeg: number;
}

/**
 * A snapping candidate that snaps to a fixed coordinate.
 *
 * A provider that computed the nearest point on an edge itself can return this shape
 * with kind: 'edge'.
 */
export interface SnapPointCandidate {
  /** The kind of the candidate */
  kind: SnapTargetKind;
  /** The coordinate to snap to, `[lng, lat]` in degrees */
  coordinate: Coordinate;
  /** The feature ID it originates from */
  featureId?: string;
  /**
   * The dataset ID it originates from (only for candidates originating from a
   * dataset)
   */
  datasetId?: string;
  /** The vertex reference it originates from (used to decide on exclusion) */
  vertex?: VertexRef;
  /** A label for the host to show, passed on as `SnapTarget.description` */
  description?: string;
  /** The priority among candidates of the same kind at the same distance; higher wins */
  priority?: number;
}

/**
 * A snapping candidate that snaps to the point of a segment closest to the cursor.
 *
 * The point closest to the cursor is computed by SnapService. Besides real edges
 * (edge), construction guides (guide) are also returned in this shape.
 */
export interface SnapSegmentCandidate {
  /** The kind of the candidate (a segment candidate is either an edge or a guide) */
  kind: 'edge' | 'guide';
  /** The start of the segment, `[lng, lat]` in degrees */
  start: Coordinate;
  /** The end of the segment, `[lng, lat]` in degrees */
  end: Coordinate;
  /**
   * For a real edge, the vertex reference of the start. With both references, a click that
   * snapped to the edge can start or end edge tracing
   */
  startRef?: VertexRef;
  /** For a real edge, the vertex reference of the end */
  endRef?: VertexRef;
  /** The feature ID it originates from */
  featureId?: string;
  /**
   * The dataset ID it originates from (only for candidates originating from a
   * dataset)
   */
  datasetId?: string;
  /** A label for the host to show, passed on as `SnapTarget.description` */
  description?: string;
}

/**
 * A snapping candidate returned by a {@link SnapProvider}: a point or a segment.
 */
export type SnapCandidate = SnapPointCandidate | SnapSegmentCandidate;

/**
 * Decides whether it is a segment candidate
 *
 * @internal
 */
export function isSegmentCandidate(candidate: SnapCandidate): candidate is SnapSegmentCandidate {
  return 'start' in candidate;
}

/**
 * A source of snapping candidates, such as external data the host wants to snap to.
 *
 * Register one with `draw.snapping.register(provider)`; the call returns a function that
 * unregisters it. The library calls `candidates` for every pointer input while snapping is
 * enabled, then cuts the candidates off by the tolerance and picks the winner by kind
 * (vertex > intersection > edge > guide) and then by distance to the cursor. Candidates of a
 * kind disabled in `options.snap.kinds` are ignored. `candidates` runs on every mouse move,
 * so it should answer from an index rather than scan all the data.
 */
export interface SnapProvider {
  /** The provider name (for debugging and for detecting duplicate registrations) */
  readonly name: string;
  /**
   * Lists the candidates near the cursor
   *
   * @param bbox The extent around the cursor widened by the tolerance, in degrees. Candidates
   *   outside it may be returned; the library cuts them off
   * @param ctx The cursor position, the tolerance, the exclusions and the modifier keys
   * @returns The candidates. An empty array when there are none
   */
  candidates(bbox: BoundingBox, ctx: SnapProviderContext): SnapCandidate[];
}

/**
 * A function that returns the snapping candidates of a custom feature type
 *
 * This is the shape passed to FeatureTypeHandler.getSnapTargets. The built-in
 * vertex provider calls it when it is registered for the target type.
 *
 * @internal
 */
export type SnapTargetsProvider = (feature: Feature, ctx: SnapProviderContext) => SnapCandidate[];

/**
 * The modifier key that stops snapping while it is held, or `'none'` for no such key.
 */
export type SnapDisableKey = 'alt' | 'shift' | 'ctrl' | 'meta' | 'none';

/**
 * The snapping options of the engine (`createDraw` translates its `snapping` option).
 *
 * Every field can be omitted. Snapping applies to the pointer input of every drawing mode,
 * of custom modes and of vertex dragging. Everything except `tolerancePx` and `disableKey`
 * can be switched at runtime through `draw.snapping`.
 */
export interface SnapOptions {
  /** Whether snapping is enabled (default: true). Switch it with `draw.snapping.setEnabled` */
  enabled?: boolean;
  /**
   * The distance from the cursor within which a candidate snaps, in screen px (default: 10).
   * It is converted into degrees at the cursor latitude and the zoom, so it is the same on
   * screen in every direction
   */
  tolerancePx?: number;
  /**
   * The modifier key that stops snapping while it is held down (default: 'alt';
   * 'none' for no disabling)
   */
  disableKey?: SnapDisableKey;
  /**
   * The enabled flag of each kind (`vertex`, `edge`, `intersection`, `guide`). An omitted
   * kind is enabled. Switch one with `draw.snapping.setKindEnabled`
   */
  kinds?: Partial<Record<SnapTargetKind, boolean>>;
  /** Whether datasets are included as snapping targets (default: true) */
  datasets?: boolean;
  /**
   * The step angle of the built-in north-based guides in degrees (default: 45, which gives 8
   * guides; 15 gives 24). A value of 0 or less, or a non-finite value, gives the default.
   * Change it at runtime with `draw.snapping.setGuideStep`
   */
  guideStepDegrees?: number;
}

/**
 * The snapping options with every default filled in, as `draw.snapping.getOptions()` returns
 * them.
 *
 * `enabled`, `kinds`, `datasets` and `guideStepDegrees` reflect the changes made at runtime. `kinds` is a copy;
 * rewriting it has no effect.
 */
export type ResolvedSnapOptions = Required<Omit<SnapOptions, 'kinds'>> & {
  /** The enabled flag of each kind (every kind is filled in) */
  kinds: Record<SnapTargetKind, boolean>;
};

/**
 * The default of the enabled flag of each kind (all enabled)
 *
 * @internal
 */
export const DEFAULT_SNAP_KINDS: Record<SnapTargetKind, boolean> = {
  vertex: true,
  edge: true,
  intersection: true,
  guide: true,
};

/**
 * The defaults of the snapping options
 *
 * kinds is a nested object, so the caller must copy it before rewriting it.
 *
 * @internal
 */
export const DEFAULT_SNAP_OPTIONS: ResolvedSnapOptions = {
  enabled: true,
  tolerancePx: 10,
  disableKey: 'alt',
  kinds: DEFAULT_SNAP_KINDS,
  datasets: true,
  guideStepDegrees: 45,
};

/**
 * Normalizes the step angle of the north-based guides: a value of 0 or less, or a non-finite
 * value, gives the default (45 degrees)
 *
 * @internal
 */
export function resolveGuideStepDegrees(degrees: number | undefined): number {
  return degrees !== undefined && Number.isFinite(degrees) && degrees > 0
    ? degrees
    : DEFAULT_SNAP_OPTIONS.guideStepDegrees;
}

/**
 * Builds the enabled flag of each kind with the defaults filled in
 *
 * @internal
 */
export function resolveSnapKinds(
  kinds?: Partial<Record<SnapTargetKind, boolean>>,
): Record<SnapTargetKind, boolean> {
  return { ...DEFAULT_SNAP_KINDS, ...kinds };
}

/**
 * The SnapService interface
 *
 * @internal
 */
export interface SnapService {
  /**
   * Changes how close the pointer must come to a candidate, in screen px
   *
   * @param px The new tolerance
   */
  setTolerance(px: number): void;
  /**
   * Changes the modifier key that stops snapping while it is held
   *
   * @param key The new key
   */
  setDisableKey(key: SnapDisableKey): void;
  /**
   * Resolves a coordinate by snapping
   *
   * @param lngLat The input coordinate (the cursor position)
   * @param point The screen coordinate of the input coordinate (used by external
   *   providers)
   * @param ctx The context of snapping
   */
  resolve(lngLat: SnapLngLat, point: ScreenPoint, ctx: SnapContext): SnapResult;

  /**
   * Registers a provider
   *
   * @returns A function that unregisters it
   */
  register(provider: SnapProvider): () => void;

  /** Turns snapping on or off */
  setEnabled(enabled: boolean): void;

  /** Whether snapping is enabled */
  isEnabled(): boolean;

  /** Turns each kind on or off */
  setKindEnabled(kind: SnapTargetKind, enabled: boolean): void;

  /** Whether a kind is enabled */
  isKindEnabled(kind: SnapTargetKind): boolean;

  /** Turns snapping to datasets on or off */
  setDatasetsEnabled(enabled: boolean): void;

  /** Whether datasets are snapping targets */
  isDatasetsEnabled(): boolean;

  /**
   * Sets the step angle of the built-in north-based guides (degrees; an invalid value gives
   * the default). It takes effect from the next resolution
   */
  setGuideStep(degrees: number): void;

  /** The most recent resolution result (null when nothing has been resolved yet) */
  getResult(): SnapResult | null;

  /** The options with the defaults filled in */
  getOptions(): ResolvedSnapOptions;
}
