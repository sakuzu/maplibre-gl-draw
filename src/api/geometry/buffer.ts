// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The buffer: the area within a distance of each input, created as new features
 *
 * It differs from the boolean operations only in that it "keeps the inputs and adds the
 * results", so it takes the same path with the removedIds of applyResult left empty. Since it
 * creates one result per input, several applyResult calls are gathered into one
 * store.transact, and all the results are selected at the end.
 */

import { buffer as computeBuffer } from '../../geometry/buffer.js';
// buffer is imported under an alias so that the name reads as the geometry module's function.
import { drawProperties } from '../../shared/properties.js';
import { getCircleRadius } from '../../shared/utils/property.js';
import type { Feature, FeatureCoordinates, FeatureType } from '../../store/types.js';
import { applyResult, emitApplied } from './apply.js';
import { toBufferGeometry, toResultGeometry } from './targets.js';
import type { GeometryApiDeps, GeometryBufferOptions } from './types.js';

/** The content of one result created by the buffer (an input and its result geometry). */
interface BufferPlan {
  input: Feature;
  geometry: { type: FeatureType; coordinates: FeatureCoordinates };
  /** Only in the Circle special case, it holds the properties with the radius replaced */
  properties?: Record<string, unknown>;
}

/**
 * Plans the buffer of a Circle input.
 *
 * To keep it parametric, it returns a Circle whose radiusMeters has been grown or shrunk,
 * without reducing it to a polygon. A shrink that makes the radius 0 or less has an empty
 * result, so null is returned.
 */
function planCircleBuffer(input: Feature, distanceMeters: number): BufferPlan | null {
  const radiusMeters = getCircleRadius(input);
  if (radiusMeters === undefined || radiusMeters <= 0) return null;

  const nextRadius = radiusMeters + distanceMeters;
  if (nextRadius <= 0) return null;

  return {
    input,
    geometry: { type: 'Circle', coordinates: input.coordinates },
    // It stays a Circle, so the properties including radiusHandleAngle are inherited and only
    // the radius is replaced.
    properties: { ...input.properties, ...drawProperties({ radiusMeters: nextRadius }) },
  };
}

/**
 * Plans the buffer of one input. null when the result is empty or the operation is not
 * defined.
 */
function planBuffer(input: Feature, options: GeometryBufferOptions): BufferPlan | null {
  const { distanceMeters, segments } = options;
  if (input.type === 'Circle') return planCircleBuffer(input, distanceMeters);

  const geometryInput = toBufferGeometry(input);
  if (geometryInput === null) return null;

  // null means "the operation is not defined for that input" (a negative value on a point or
  // a line), [] means the result is empty.
  const parts = computeBuffer(geometryInput, distanceMeters, { segments });
  if (parts === null) return null;

  const geometry = toResultGeometry(parts);
  if (geometry === null) return null;

  return { input, geometry };
}

/**
 * Runs the buffer and creates the result features.
 *
 * The inputs remain, and one result is created per input. The creation of all the results is
 * gathered into one store.transact, so a single undo removes all of them.
 *
 * @param inputs The targets ordered in z order (the tail is the frontmost)
 */
export function runBuffer(
  deps: GeometryApiDeps,
  inputs: Feature[],
  options: GeometryBufferOptions,
): string[] {
  const { store } = deps;
  const plans: BufferPlan[] = [];
  for (const input of inputs) {
    const plan = planBuffer(input, options);
    if (plan !== null) plans.push(plan);
  }

  if (plans.length === 0) {
    // Every input was skipped or had an empty result. The Store is not changed at all; only
    // the notification is emitted.
    emitApplied(deps.eventEmitter, {
      operation: 'buffer',
      inputIds: inputs.map((input) => input.id),
      resultId: null,
      resultIds: [],
      status: 'empty',
    });
    return [];
  }

  const resultIds = store.transact(() => {
    const ids = plans.map((plan) =>
      applyResult(deps, {
        anchor: plan.input,
        removedIds: [],
        geometry: plan.geometry,
        properties: plan.properties,
      }),
    );
    store.setSelection('feature', ids);
    return ids;
  });

  emitApplied(deps.eventEmitter, {
    operation: 'buffer',
    inputIds: plans.map((plan) => plan.input.id),
    resultId: resultIds[0],
    resultIds,
    status: 'applied',
  });
  return resultIds;
}
