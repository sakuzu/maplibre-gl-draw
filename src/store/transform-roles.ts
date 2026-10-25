// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The fields the edits that move, rotate and scale features change with the geometry, and the
 * values a Store gives its computation (`Store.transforms`) for a feature
 *
 * Which field of a feature is the rotation (`angleDegrees`) and which is its size (`size`), and whether a
 * scaling moves its positions uniformly (`uniformScale`), is told by its type:
 *
 * - An Image: `angleDegrees` is its rotation, `size` its scale, and it keeps its shape
 * - A Circle: `size` is its radius, and it keeps its shape
 * - Any type: a feature that has a rotation (the key, whatever its value) has `angleDegrees`, and
 *   one
 *   that has a scale has `size` and keeps its shape
 *
 * No type has `bearingDegrees` yet.
 *
 * @internal
 */

import type { Geometry, Position } from 'geojson';
import { DRAW_PROPERTY_KEYS } from '../shared/properties.js';
import type { TransformEdit, TransformValues } from './store.js';

/**
 * The fields of a feature the edits that move, rotate and scale features change: the keys of
 * `properties` of its roles
 *
 * @internal
 */
export interface TransformRoles {
  /** The key of the rotation, in degrees counterclockwise */
  readonly angleDegrees?: string;
  /** The key of the size */
  readonly size?: string;
  /** Whether a scaling moves its positions uniformly (by `sizeFactor`) */
  readonly uniformScale: boolean;
}

const IMAGE_ROLES: TransformRoles = {
  angleDegrees: DRAW_PROPERTY_KEYS.rotation,
  size: DRAW_PROPERTY_KEYS.scale,
  uniformScale: true,
};
const ROTATION_ROLES: TransformRoles = {
  angleDegrees: DRAW_PROPERTY_KEYS.rotation,
  uniformScale: false,
};
const SCALE_ROLES: TransformRoles = { size: DRAW_PROPERTY_KEYS.scale, uniformScale: true };
const NO_ROLES: TransformRoles = { uniformScale: false };

/**
 * The roles of a feature of a type, whose keys of `properties` `has` tells
 *
 * @internal
 */
export function transformRolesOf(type: string, has: (key: string) => boolean): TransformRoles {
  if (type === 'Image') return IMAGE_ROLES;
  const angle = has(DRAW_PROPERTY_KEYS.rotation);
  if (type === 'Circle') {
    return {
      ...(angle && { angleDegrees: DRAW_PROPERTY_KEYS.rotation }),
      size: DRAW_PROPERTY_KEYS.radiusMeters,
      uniformScale: true,
    };
  }
  const size = has(DRAW_PROPERTY_KEYS.scale);
  if (angle && size) return { ...IMAGE_ROLES };
  if (angle) return ROTATION_ROLES;
  if (size) return SCALE_ROLES;
  return NO_ROLES;
}

/**
 * Every key of `properties` a role may have, whatever the type
 *
 * @internal
 */
export function transformRoleFields(): readonly string[] {
  return ROLE_KEYS;
}

const ROLE_KEYS: readonly string[] = [
  DRAW_PROPERTY_KEYS.rotation,
  DRAW_PROPERTY_KEYS.scale,
  DRAW_PROPERTY_KEYS.radiusMeters,
];

/** A number, or null for a value that is not one (a field not there yet) */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/**
 * The values a computation is given for a feature: its geometry, and the fields of its roles,
 * which `read` reads from `properties` (undefined for a key that is not there)
 *
 * @internal
 */
export function transformValuesOf(
  geometry: Geometry,
  roles: TransformRoles,
  read: (key: string) => unknown,
): TransformValues {
  return {
    geometry,
    ...(roles.angleDegrees !== undefined && {
      angleDegrees: numberOrNull(read(roles.angleDegrees)),
    }),
    ...(roles.size !== undefined && { size: numberOrNull(read(roles.size)) }),
    ...(roles.uniformScale && { uniformScale: true }),
  };
}

/**
 * The fields of `properties` a computation gave new values of: the key of each role and its new
 * value (a value that is not a finite number is not written)
 *
 * @internal
 */
export function roleFieldsOf(
  roles: TransformRoles,
  before: TransformValues,
  after: TransformValues,
): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  if (
    roles.angleDegrees !== undefined &&
    after.angleDegrees !== before.angleDegrees &&
    isFiniteNumber(after.angleDegrees)
  ) {
    out.push([roles.angleDegrees, after.angleDegrees]);
  }
  if (roles.size !== undefined && after.size !== before.size && isFiniteNumber(after.size)) {
    out.push([roles.size, after.size]);
  }
  return out;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The first two numbers of a point */
function pointOf(position: Position): [number, number] {
  return [position[0] as number, position[1] as number];
}

/**
 * An edit that moves, rotates or scales features, as its computation is given it: without the
 * features, its points made `[longitude, latitude]`
 *
 * @internal
 */
export function transformEditOf(edit: TransformEdit): TransformEdit {
  switch (edit.kind) {
    case 'translate':
      return { kind: 'translate', from: pointOf(edit.from), to: pointOf(edit.to) };
    case 'rotate':
      return { kind: 'rotate', center: pointOf(edit.center), angleDegrees: edit.angleDegrees };
    case 'scale':
      return {
        kind: 'scale',
        center: pointOf(edit.center),
        eastFactor: edit.eastFactor,
        northFactor: edit.northFactor,
        sizeFactor: edit.sizeFactor,
      };
  }
}
