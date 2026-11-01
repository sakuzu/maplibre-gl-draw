// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The fields the edits that move, rotate and scale features change with the geometry, and the
 * values a Store gives its computation (`Store.transforms`) for a feature
 *
 * Which field of a feature is the rotation (`angleDegrees`) and which is its size (`size`), and whether a
 * scaling moves its positions uniformly (`uniformScale`), is told by its type:
 *
 * - A custom type of the instance (`featureTypes.add`): the fields it declares
 *   (`FeatureTypeDefinition.transformFields`), and none when it declares none, whatever keys its
 *   features have
 * - An Image: `angleDegrees` is its rotation, `size` its scale, and it keeps its shape
 * - A Circle: `size` is its radius, and it keeps its shape
 * - Any other type (a built-in type, or a type no extension of the instance defines): a feature
 *   that has a rotation (the key, whatever its value) has `angleDegrees`, and one that has a scale
 *   has `size` and keeps its shape
 *
 * No type has `bearingDegrees` yet.
 *
 * @internal
 */

import type { Geometry, Position } from 'geojson';
import { DRAW_PROPERTY_KEYS } from '../shared/properties.js';
import type { TransformEdit, TransformFields, TransformValues } from './store.js';

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
 * The fields the custom types of an instance declare (`FeatureTypeDefinition.transformFields`),
 * by type
 *
 * @internal
 */
export interface TransformFieldsRegistry {
  /**
   * The fields a custom type declares (an empty declaration for one that declares none), or
   * `undefined` for a type that is not a custom type of the instance
   */
  of(type: string): TransformFields | undefined;
  /** Every key of `properties` a custom type declares */
  keys(): readonly string[];
  /**
   * Registers the fields of a custom type
   *
   * @returns The function that cancels the registration (it leaves a later registration of the
   *   same type as it is)
   */
  register(type: string, fields: TransformFields): () => void;
  /** Cancels every registration */
  clear(): void;
}

/**
 * Creates an empty registry of the fields the custom types declare
 *
 * @internal
 */
export function createTransformFieldsRegistry(): TransformFieldsRegistry {
  const byType = new Map<string, TransformFields>();
  let keys: readonly string[] | null = null;
  return {
    of: (type) => byType.get(type),
    keys() {
      if (!keys) {
        const all = new Set<string>();
        for (const fields of byType.values()) {
          if (fields.angleDegreesKey !== undefined) all.add(fields.angleDegreesKey);
          if (fields.scaleKey !== undefined) all.add(fields.scaleKey);
        }
        keys = [...all];
      }
      return keys;
    },
    register(type, fields) {
      const own = { ...fields };
      byType.set(type, own);
      keys = null;
      return () => {
        if (byType.get(type) !== own) return;
        byType.delete(type);
        keys = null;
      };
    },
    clear() {
      byType.clear();
      keys = null;
    },
  };
}

/** The fields the Stores of the instances are given, by Store */
const ofStores = new WeakMap<object, TransformFieldsRegistry>();
/** The contracts of the library that read the fields, and how each takes them */
const takers = new WeakMap<object, (fields: TransformFieldsRegistry | null) => void>();

/**
 * Has a contract of the library take the fields the custom types of the instance declare, as the
 * Store over it is given them (`setTransformFieldsOfStore`); the contract of an application,
 * which is reached through the members of the public Store only, decides the fields of its edits
 * itself
 *
 * @internal
 */
export function takeTransformFields(
  contract: object,
  take: (fields: TransformFieldsRegistry | null) => void,
): void {
  takers.set(contract, take);
}

/**
 * Gives the Store of an instance the fields its custom types declare (null once the instance is
 * gone), and the contract under it when it is one of the library (`takeTransformFields`)
 *
 * @param store The Store of the instance
 * @param contract The contract the Store is over
 * @internal
 */
export function setTransformFieldsOfStore(
  store: object,
  contract: object,
  fields: TransformFieldsRegistry | null,
): void {
  if (fields) ofStores.set(store, fields);
  else ofStores.delete(store);
  takers.get(contract)?.(fields);
}

/**
 * The fields the custom types of the instance a Store belongs to declare (null for a Store of no
 * instance)
 *
 * @internal
 */
export function transformFieldsOfStore(store: object): TransformFieldsRegistry | null {
  return ofStores.get(store) ?? null;
}

/**
 * The roles of a feature of a type, whose keys of `properties` `has` tells
 *
 * @param fields The fields the custom types of the instance declare (none: every type is read as
 *   a type no extension defines)
 * @internal
 */
export function transformRolesOf(
  type: string,
  has: (key: string) => boolean,
  fields?: TransformFieldsRegistry | null,
): TransformRoles {
  const declared = fields?.of(type);
  if (declared) return rolesOfDeclaration(declared);
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

/** The roles of the fields a custom type declares */
function rolesOfDeclaration(declared: TransformFields): TransformRoles {
  return {
    ...(declared.angleDegreesKey !== undefined && { angleDegrees: declared.angleDegreesKey }),
    ...(declared.scaleKey !== undefined && { size: declared.scaleKey }),
    uniformScale: declared.uniformScale === true,
  };
}

/**
 * Every key of `properties` a role may have, whatever the type
 *
 * @param fields The fields the custom types of the instance declare, whose keys are added
 * @internal
 */
export function transformRoleFields(fields?: TransformFieldsRegistry | null): readonly string[] {
  const declared = fields?.keys() ?? [];
  if (declared.length === 0) return ROLE_KEYS;
  return [...new Set([...ROLE_KEYS, ...declared])];
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
