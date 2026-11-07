// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The values a move of features written at once (the arrow keys) writes over each of them
 *
 * It takes the values of its features (their geometry and the fields of their roles,
 * `store/transform-roles.ts`) and computes them with the edit by the computation of the Store
 * (`Store.transforms`, or the one of the library), so what it writes is what the edit applied to
 * the features would write.
 */

import { DEFAULT_TRANSFORMS } from '../store/feature-edits.js';
import type { GeometryTransforms, TransformEdit, TransformValues } from '../store/store.js';
import {
  type TransformFieldsRegistry,
  type TransformRoles,
  transformRolesOf,
  transformValuesOf,
} from '../store/transform-roles.js';
import type { Feature } from '../store/types.js';

/**
 * The values of a feature an edit starts from
 *
 * @internal
 */
export interface TransformStart {
  readonly roles: TransformRoles;
  readonly values: TransformValues;
  /** The `properties` of the feature then */
  readonly properties: Readonly<Record<string, unknown>>;
}

/**
 * The values of a feature an edit starts from (a copy of its geometry is not made: the Store
 * never changes an object it gave)
 *
 * @param fields The fields the custom types of the instance declare
 * @internal
 */
export function transformStartOf(
  feature: Feature,
  fields?: TransformFieldsRegistry | null,
): TransformStart {
  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const read = (key: string): unknown => (key in properties ? properties[key] : undefined);
  const roles = transformRolesOf(feature.type, (key) => read(key) !== undefined, fields);
  return { roles, values: transformValuesOf(feature.geometry, roles, read), properties };
}

/**
 * The computation of a Store: its own, or the one of the library
 *
 * @internal
 */
export function transformsOf(store: {
  readonly transforms?: GeometryTransforms;
}): GeometryTransforms {
  return store.transforms ?? DEFAULT_TRANSFORMS;
}

/**
 * The fields an edit writes over a feature: its geometry, and the fields of its roles
 * merged into its `properties` as they are now (null when the computation does not take the edit)
 *
 * @param edit The edit (null: the values it started from)
 * @internal
 */
export function transformedUpdates(
  transforms: GeometryTransforms,
  edit: TransformEdit | null,
  start: TransformStart,
  feature: Feature,
): Partial<Feature> | null {
  if (edit && !transforms.accepts(edit)) return null;
  const after = edit ? transforms.apply(edit, start.values) : start.values;
  const updates: Partial<Feature> = { geometry: after.geometry as Feature['geometry'] };
  // A field the edit leaves as it was is put back as the feature had it when it started
  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  for (const [key, value] of [
    [start.roles.angleDegrees, after.angleDegrees],
    [start.roles.size, after.size],
  ] as const) {
    if (key === undefined) continue;
    const had = key in start.properties;
    const wanted = isFiniteNumber(value) ? value : start.properties[key];
    if (isFiniteNumber(value) || had) {
      if (!(key in properties) || properties[key] !== wanted) {
        next ??= { ...properties };
        next[key] = wanted;
      }
    } else if (key in properties) {
      next ??= { ...properties };
      delete next[key];
    }
  }
  if (next) updates.properties = next as Feature['properties'];
  return updates;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
