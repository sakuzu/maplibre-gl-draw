// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rotation of the features a rotate drag turns, as an edit (`rotate`)
 *
 * The angle is the one the pointer turned around the center since the drag started, measured in
 * the east, north and up frame of the center on the WGS 84 ellipsoid: counterclockwise seen from
 * above, within (-180, 180]. The edit is computed as the Store computes it (`Store.transforms`, or
 * the computation of the library), so the drag writes what the edit written once would.
 */

import { enuOffsetOf } from '../geometry/enu-transforms.js';
import type { BoundingBoxCoords } from '../shared/types/selection-box.js';
import type { TransformEdit } from '../store/store.js';
import { type TransformFieldsRegistry, transformRolesOf } from '../store/transform-roles.js';
import type { Feature } from '../store/types.js';

/** A rotate edit */
type RotateEdit = Extract<TransformEdit, { kind: 'rotate' }>;

/**
 * The center a rotate drag turns its features around: the center of their frame, or the place of
 * the feature when it is the only one, a `Point`, and turns by its rotation (an Image, a feature of
 * a custom type that declares `angleDegreesKey`, or a feature of another type that has a
 * rotation): its position stays and its rotation changes
 *
 * @param fields The fields the custom types of the instance declare
 * @internal
 */
export function rotationCenterOf(
  bbox: BoundingBoxCoords,
  features: readonly Feature[],
  fields?: TransformFieldsRegistry | null,
): [number, number] {
  if (features.length === 1) {
    const feature = features[0] as Feature;
    const properties = (feature.properties ?? {}) as Record<string, unknown>;
    const roles = transformRolesOf(feature.type, (key) => key in properties, fields);
    const geometry = feature.geometry as { type: string; coordinates?: unknown };
    if (roles.angleDegrees !== undefined && geometry.type === 'Point') {
      const position = geometry.coordinates as number[];
      return [position[0] as number, position[1] as number];
    }
  }
  return [bbox.center[0], bbox.center[1]];
}

/** An angle in degrees within (-180, 180] */
function withinHalfTurn(degrees: number): number {
  let r = degrees - 360 * Math.floor(degrees / 360);
  if (r > 180) r -= 360;
  return r === -180 ? 180 : r;
}

/**
 * The angle the pointer turned around a center from where it started, in degrees counterclockwise
 * within (-180, 180] (0 when either is on the center)
 *
 * @internal
 */
export function rotationAngleOf(
  center: readonly [number, number],
  start: { lng: number; lat: number },
  current: { lng: number; lat: number },
): number {
  const [se, sn] = enuOffsetOf(center, [start.lng, start.lat]);
  const [ce, cn] = enuOffsetOf(center, [current.lng, current.lat]);
  if ((se === 0 && sn === 0) || (ce === 0 && cn === 0)) return 0;
  const radians = Math.atan2(cn, ce) - Math.atan2(sn, se);
  return withinHalfTurn((radians * 180) / Math.PI);
}

/**
 * The edit of a rotate drag: around the center, by the angle the pointer turned
 *
 * @internal
 */
export function rotateEditOf(
  center: readonly [number, number],
  start: { lng: number; lat: number },
  current: { lng: number; lat: number },
): RotateEdit {
  return {
    kind: 'rotate',
    center: [center[0], center[1]],
    angleDegrees: rotationAngleOf(center, start, current),
  };
}
