// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Built-in snapping provider (construction guides)
 *
 * It works only while drawing (draw_line / draw_polygon); it reads the confirmed
 * vertices from the Tentative of the Store and returns the guides as segment
 * candidates with kind: 'guide'. Because they are segment candidates, the
 * computation of the point closest to the cursor can be left to SnapService.
 *
 * It produces 3 kinds of guides.
 *
 *   Extension      Forward from the anchor along the bearing of the previous segment
 *                  (2 or more confirmed points)
 *   Perpendicular  At the bearing of the previous segment +-90 degrees, to both
 *                  sides of the anchor (2 or more confirmed points)
 *   North-based    Towards every bearing at each step angle, starting from true
 *                  north at 0 degrees (1 or more confirmed points)
 *
 * Only the north-based guide works from the very first segment. The built-in provider
 * reads the step angle from SnapOptions.guideStepDegrees at every query (through a
 * getter), so a change at runtime takes effect without rebuilding the provider. A
 * provider made with createGuideSnapProvider keeps the step it was built with.
 *
 * A guide is not an infinite line; it is cut off at the equivalent of 4096 pixels on
 * screen. The priority order stays SNAP_KIND_PRIORITY, so a real vertex,
 * intersection or edge wins when it is within the tolerance.
 */

import { getPointAtAngle } from '../../geometry/angle.js';
import { initialBearingDegrees } from '../../geometry/distance.js';
import { EARTH_RADIUS_METERS, toRadians } from '../../geometry/units.js';
import { type Messages, resolveMessages } from '../../messages.js';
import { DEFAULT_TILE_SIZE } from '../../shared/math/index.js';
import type { Store } from '../../store/store.js';
import type { BoundingBox, Coordinate, TentativeState } from '../../store/types.js';
import { degreesPerPixel } from '../geometry.js';
import {
  resolveGuideStepDegrees,
  type SnapCandidate,
  type SnapProvider,
  type SnapProviderContext,
  type SnapSegmentCandidate,
} from '../types.js';

/** The drawing modes that produce guides */
const GUIDE_MODES = new Set(['draw_line', 'draw_polygon']);

/** The length of a guide (pixels). The cut-off that keeps it from being an infinite line */
const GUIDE_LENGTH_PIXELS = 4096;

/**
 * The dependencies of {@link createGuideSnapProvider}.
 *
 * The guides are built from the vertices committed so far in the drawing in progress, so the
 * Store alone is enough.
 */
export interface GuideSnapProviderDeps {
  /** The Store of the draw instance, such as `ctx.getStore()` of a plugin */
  store: Store;
}

/**
 * The options of {@link createGuideSnapProvider}.
 */
export interface GuideSnapProviderOptions {
  /**
   * The step angle of the north-based guides in degrees (default: 45, which gives 8 guides).
   * 0, a negative value or a non-finite value gives the default
   */
  northStepDegrees?: number;
  /** The tile size in px the map uses, to convert px into degrees (default: 512) */
  tileSize?: number;
  /**
   * The messages table the descriptions of the candidates come from (`snapNorth`,
   * `snapExtension`, `snapPerpendicular`; default: `MESSAGES_EN`)
   */
  messages?: Partial<Messages>;
}

/**
 * Takes the confirmed vertices out of the Tentative
 *
 * For a line it is the first confirmedCount items of the coordinate sequence. For a
 * polygon it is the first confirmedCount items of the closed ring. The first point of
 * a polygon has type 'Point' because it is shown as a marker (in that case there is
 * no confirmedCount, and that single point is the confirmed one).
 *
 * @internal
 */
export function getConfirmedTentativeVertices(tentative: TentativeState): Coordinate[] {
  switch (tentative.type) {
    case 'Point':
      return [tentative.coordinates as Coordinate];

    case 'LineString': {
      const coords = tentative.coordinates as Coordinate[];
      const count = tentative.confirmedCount ?? coords.length;
      return coords.slice(0, Math.max(0, Math.min(count, coords.length)));
    }

    case 'Polygon': {
      const ring = (tentative.coordinates as Coordinate[][])[0];
      if (!ring || ring.length === 0) return [];
      // It is a closed ring, so the last item is a copy of the first one. When there is
      // no confirmedCount, the closing point is excluded
      const count = tentative.confirmedCount ?? ring.length - 1;
      return ring.slice(0, Math.max(0, Math.min(count, ring.length)));
    }

    default:
      return [];
  }
}

/**
 * Computes the length of a guide (meters)
 *
 * The equivalent of GUIDE_LENGTH_PIXELS on screen is converted into degrees in the
 * latitude direction, and that is converted into meters (because getPointAtAngle
 * takes the distance in meters).
 */
function guideLengthMeters(anchor: Coordinate, zoom: number, tileSize: number): number {
  const perPixel = degreesPerPixel(anchor[1], zoom, tileSize);
  const degrees = perPixel.lat * GUIDE_LENGTH_PIXELS;
  return toRadians(degrees) * EARTH_RADIUS_METERS;
}

/**
 * Builds a segment candidate extended from the anchor towards the bearing
 *
 * When backwardBearing is given, it becomes a single segment extended towards that
 * side as well (a guide on both sides passing through the anchor).
 */
function guideSegment(
  anchor: Coordinate,
  lengthMeters: number,
  bearing: number,
  description: string,
  backwardBearing?: number,
): SnapSegmentCandidate {
  return {
    kind: 'guide',
    start:
      backwardBearing === undefined
        ? [anchor[0], anchor[1]]
        : getPointAtAngle(anchor, lengthMeters, backwardBearing),
    end: getPointAtAngle(anchor, lengthMeters, bearing),
    description,
  };
}

/**
 * Creates the guide provider whose step angle is read through a getter at every query
 * (the built-in provider reads the current `guideStepDegrees` of the SnapService this way)
 *
 * @param deps The Store to read the drawing in progress from
 * @param getNorthStepDegrees Returns the step angle; an invalid value gives the default
 * @param options The tile size and the messages (`northStepDegrees` is ignored)
 * @internal
 */
export function createSteppedGuideSnapProvider(
  deps: GuideSnapProviderDeps,
  getNorthStepDegrees: () => number,
  options: Omit<GuideSnapProviderOptions, 'northStepDegrees'> = {},
): SnapProvider {
  const tileSize = options.tileSize ?? DEFAULT_TILE_SIZE;
  // The descriptions of the candidates (read by the status bar and the like)
  const messages = resolveMessages(options.messages);

  return {
    name: 'core:guide',

    candidates(_bbox: BoundingBox, ctx: SnapProviderContext): SnapCandidate[] {
      if (!GUIDE_MODES.has(deps.store.getMode())) return [];

      const tentative = deps.store.getTentative();
      if (!tentative) return [];

      const confirmed = getConfirmedTentativeVertices(tentative);
      if (confirmed.length === 0) return [];

      const anchor = confirmed[confirmed.length - 1];
      const lengthMeters = guideLengthMeters(anchor, ctx.zoom, tileSize);
      const candidates: SnapCandidate[] = [];
      const step = resolveGuideStepDegrees(getNorthStepDegrees());

      // North-based: every bearing at each step angle, starting from true north. The
      // only guide that works from the very first segment
      for (let bearing = 0; bearing < 360; bearing += step) {
        candidates.push(guideSegment(anchor, lengthMeters, bearing, messages.snapNorth));
      }

      if (confirmed.length >= 2) {
        const previous = confirmed[confirmed.length - 2];
        const bearing = initialBearingDegrees(previous, anchor);

        // Extension: forward along the bearing of the previous segment
        candidates.push(guideSegment(anchor, lengthMeters, bearing, messages.snapExtension));

        // Perpendicular: the bearing of the previous segment +-90 degrees. Merged into a
        // single line passing through the anchor
        candidates.push(
          guideSegment(
            anchor,
            lengthMeters,
            (bearing + 90) % 360,
            messages.snapPerpendicular,
            (bearing + 270) % 360,
          ),
        );
      }

      return candidates;
    },
  };
}
