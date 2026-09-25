// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The boolean editing operations (union / subtract / intersect) on the area types
 */

import type { AreaCoordinates, MultiPolygonCoordinates } from '../../geometry/index.js';
import type { GeometryOperationName } from '../../shared/utils/event-emitter.js';
import type { Store } from '../../store/store.js';
import type { Feature } from '../../store/types.js';
import { commitResult, emitApplied } from './apply.js';
import {
  currentSelectionIds,
  isAreaFeature,
  resolveTargetFeatures,
  toAreaCoordinates,
  toResultGeometry,
} from './targets.js';
import type { GeometryApiDeps } from './types.js';

/**
 * The common path that runs an operation on the area types and replaces the inputs with the
 * result.
 *
 * @param inputs The targets ordered in z order (the tail is the frontmost)
 * @param compute The geometric operation that receives the area coordinates in the same order
 *   as inputs and returns the result
 */
export function runAreaOperation(
  deps: GeometryApiDeps,
  operation: GeometryOperationName,
  inputs: Feature[],
  compute: (areas: AreaCoordinates[]) => MultiPolygonCoordinates,
): string | null {
  const inputIds = inputs.map((feature) => feature.id);
  const areas: AreaCoordinates[] = [];
  for (const feature of inputs) {
    const area = toAreaCoordinates(feature);
    if (area === null) return null;
    areas.push(area);
  }

  const geometry = toResultGeometry(compute(areas));
  if (geometry === null) {
    // An empty result (an intersection that does not overlap, a punch-out where everything was
    // subtracted). The inputs are not changed at all; only the notification is emitted.
    emitApplied(deps.eventEmitter, {
      operation,
      inputIds,
      resultId: null,
      resultIds: [],
      status: 'empty',
    });
    return null;
  }

  // The style, the properties and the placement are inherited from the frontmost input.
  const anchor = inputs[inputs.length - 1];
  const resultId = commitResult(deps, { anchor, removedIds: inputIds, geometry });
  emitApplied(deps.eventEmitter, {
    operation,
    inputIds,
    resultId,
    resultIds: [resultId],
    status: 'applied',
  });
  return resultId;
}

/**
 * Resolves the targets of subtract.
 *
 * When targetId is omitted, it is "subtract the group of frontmost features from the backmost
 * one". When it is given explicitly, that feature is added to the targets even if it is not
 * included in the list of targets (ids / the selection).
 */
export function resolveSubtractInputs(
  store: Store,
  targetId: string | undefined,
  ids: string[] | undefined,
): { inputs: Feature[]; targetIndex: number } | null {
  const baseIds = ids ?? currentSelectionIds(store);
  const wanted = targetId === undefined ? baseIds : [...new Set([targetId, ...baseIds])];
  const inputs = resolveTargetFeatures(store, wanted, isAreaFeature);
  if (inputs.length < 2) return null;

  // By default the backmost in z order is the side that is subtracted from.
  const targetIndex =
    targetId === undefined ? 0 : inputs.findIndex((feature) => feature.id === targetId);
  if (targetIndex < 0) return null;

  return { inputs, targetIndex };
}
