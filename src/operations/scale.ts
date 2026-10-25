// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The scaling of the features a resize drag scales from a handle of their frame, as an edit
 * (`scale`)
 *
 * The anchor (the side or the corner of the frame across from the handle) stays; the anchor, the
 * handle and the pointer are taken into the east, north and up frame of the anchor on the WGS 84
 * ellipsoid, and the factors are the ones that keep the handle on the pointer:
 *
 * - Along the east (`eastFactor`) and the north (`northFactor`), for a handle that moves along
 *   that axis: one plus the movement of the pointer along it over the distance of the handle from
 *   the anchor along it. A frame thinner than a pixel on the screen along an axis is not
 *   stretched along it (a pixel of movement would be a huge factor)
 * - For the features that keep their shape (`sizeFactor`): the distance of the pointer from the
 *   anchor over the one it started at
 *
 * No factor is below 0.1. The edit is computed as the Store computes it (`Store.transforms`, or
 * the computation of the library), so the drag writes what the edit written once would.
 */

import { enuOffsetOf } from '../geometry/enu-transforms.js';
import type { HandleType } from '../shared/config/constants.js';
import type { BoundingBoxCoords } from '../shared/types/selection-box.js';
import type { TransformEdit } from '../store/store.js';

/** A scale edit */
type ScaleEdit = Extract<TransformEdit, { kind: 'scale' }>;

/** The smallest factor of a drag */
const MIN_FACTOR = 0.1;
/** The semi-major axis of WGS 84, in metres */
const SEMI_MAJOR_AXIS = 6378137;

/**
 * The state of a resize drag, taken when it starts
 *
 * @internal
 */
export interface ScaleState {
  /** The handle dragged */
  readonly handle: HandleType;
  /** The point that stays, `[lng, lat]` */
  readonly anchor: [number, number];
  /** Whether the handle moves along the east and along the north, and which way (-1, 0 or 1) */
  readonly directionX: number;
  readonly directionY: number;
  /** The pointer at the start, `[east, north]` in metres in the frame of the anchor */
  readonly start: [number, number];
  /** The distance of the handle from the anchor along the east and the north, in metres */
  readonly width: number;
  readonly height: number;
  /** The extent below which the frame is not stretched along an axis, in metres (0: none) */
  readonly minExtent: number;
}

/** The anchor of a handle, the handle, and the axes it moves along */
function anchorOf(
  handle: HandleType,
  bbox: BoundingBoxCoords,
): {
  anchor: [number, number];
  handlePoint: [number, number] | null;
  directionX: number;
  directionY: number;
} {
  const mid = (a: readonly number[], b: readonly number[]): [number, number] => [
    ((a[0] as number) + (b[0] as number)) / 2,
    ((a[1] as number) + (b[1] as number)) / 2,
  ];
  const at = (p: readonly number[]): [number, number] => [p[0] as number, p[1] as number];
  switch (handle) {
    case 'resize-nw':
      return {
        anchor: at(bbox.bottomRight),
        handlePoint: at(bbox.topLeft),
        directionX: -1,
        directionY: 1,
      };
    case 'resize-n':
      return {
        anchor: [(bbox.bottomLeft[0] + bbox.bottomRight[0]) / 2, bbox.bottomLeft[1]],
        handlePoint: [(bbox.topLeft[0] + bbox.topRight[0]) / 2, bbox.topLeft[1]],
        directionX: 0,
        directionY: 1,
      };
    case 'resize-ne':
      return {
        anchor: at(bbox.bottomLeft),
        handlePoint: at(bbox.topRight),
        directionX: 1,
        directionY: 1,
      };
    case 'resize-e':
      return {
        anchor: mid(bbox.topLeft, bbox.bottomLeft),
        handlePoint: mid(bbox.topRight, bbox.bottomRight),
        directionX: 1,
        directionY: 0,
      };
    case 'resize-se':
      return {
        anchor: at(bbox.topLeft),
        handlePoint: at(bbox.bottomRight),
        directionX: 1,
        directionY: -1,
      };
    case 'resize-s':
      return {
        anchor: [(bbox.topLeft[0] + bbox.topRight[0]) / 2, bbox.topLeft[1]],
        handlePoint: [(bbox.bottomLeft[0] + bbox.bottomRight[0]) / 2, bbox.bottomLeft[1]],
        directionX: 0,
        directionY: -1,
      };
    case 'resize-sw':
      return {
        anchor: at(bbox.topRight),
        handlePoint: at(bbox.bottomLeft),
        directionX: -1,
        directionY: -1,
      };
    case 'resize-w':
      return {
        anchor: mid(bbox.topRight, bbox.bottomRight),
        handlePoint: mid(bbox.topLeft, bbox.bottomLeft),
        directionX: -1,
        directionY: 0,
      };
    default:
      return { anchor: at(bbox.center), handlePoint: null, directionX: 1, directionY: 1 };
  }
}

/**
 * The length of a pixel of the screen on the ground at a latitude, in metres
 *
 * @param zoom The zoom of the map (no limit when it is not a finite number)
 * @param tileSize The tile size of the map, in pixels
 * @internal
 */
export function pixelMetresAt(
  latitude: number,
  zoom: number | undefined,
  tileSize: number,
): number {
  if (!Number.isFinite(zoom)) return 0;
  return (
    (2 * Math.PI * SEMI_MAJOR_AXIS * Math.cos((latitude * Math.PI) / 180)) /
    (tileSize * 2 ** (zoom as number))
  );
}

/**
 * Starts a resize drag from a handle of the frame of the features
 *
 * @param startLngLat The pointer at the start
 * @param zoom The zoom of the map: a frame thinner than a pixel along an axis is not stretched
 *   along it (undefined: only a frame of no extent is left alone)
 * @param tileSize The tile size of the map, in pixels
 * @internal
 */
export function startScale(
  handle: HandleType,
  startLngLat: { lng: number; lat: number },
  bbox: BoundingBoxCoords,
  zoom?: number,
  tileSize = 512,
): ScaleState {
  const { anchor, handlePoint, directionX, directionY } = anchorOf(handle, bbox);
  const start = enuOffsetOf(anchor, [startLngLat.lng, startLngLat.lat]);
  const reach = handlePoint ? enuOffsetOf(anchor, handlePoint) : start;
  return {
    handle,
    anchor,
    directionX,
    directionY,
    start,
    width: Math.abs(reach[0]),
    height: Math.abs(reach[1]),
    minExtent: pixelMetresAt(anchor[1], zoom, tileSize),
  };
}

/**
 * The edit of a resize drag for where the pointer is now
 *
 * @internal
 */
export function scaleEditOf(state: ScaleState, current: { lng: number; lat: number }): ScaleEdit {
  const [ce, cn] = enuOffsetOf(state.anchor, [current.lng, current.lat]);
  const [se, sn] = state.start;
  // The features that keep their shape: the distance from the anchor
  const startDistance = Math.hypot(se, sn);
  let sizeFactor = 1;
  if (startDistance > 0) sizeFactor = Math.hypot(ce, cn) / startDistance;
  sizeFactor = Math.max(sizeFactor, MIN_FACTOR);
  // The others: along the axes the handle moves along
  let eastFactor = 1;
  let northFactor = 1;
  if (state.directionX !== 0 && state.width > state.minExtent) {
    eastFactor = 1 + (state.directionX * (ce - se)) / state.width;
  }
  if (state.directionY !== 0 && state.height > state.minExtent) {
    northFactor = 1 + (state.directionY * (cn - sn)) / state.height;
  }
  return {
    kind: 'scale',
    center: [state.anchor[0], state.anchor[1]],
    eastFactor: Math.max(eastFactor, MIN_FACTOR),
    northFactor: Math.max(northFactor, MIN_FACTOR),
    sizeFactor,
  };
}
