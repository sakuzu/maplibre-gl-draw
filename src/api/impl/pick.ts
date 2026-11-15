// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `features.pick`: the features at a point of the screen, from the top, as the frame drawn last
 * shows them (`createFeaturePicker` of the hit tests)
 */

import type { FeaturesCollection } from '../features.js';
import type { Engine } from './engine.js';
import { toFeature } from './feature-shape.js';
import { invalidInput, isRecord, onlyKeys } from './shared.js';

/** A point of the screen given as `[x, y]` or as `{ x, y }`, checked */
function pointOf(point: unknown): { x: number; y: number } {
  const [x, y] = Array.isArray(point)
    ? point
    : isRecord(point)
      ? [point.x, point.y]
      : [Number.NaN, Number.NaN];
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x + y)) {
    throw invalidInput('The point must be [x, y] or { x, y } of finite numbers');
  }
  return { x, y };
}

/**
 * Creates `features.pick` over the engine
 *
 * @internal
 */
export function createPick(engine: Pick<Engine, 'pickFeatures'>): FeaturesCollection['pick'] {
  return (point, options) => {
    const at = pointOf(point);
    let tolerancePx: number | undefined;
    if (options !== undefined) {
      if (!isRecord(options)) throw invalidInput('The options must be an object');
      onlyKeys(options, ['tolerancePixels'], 'The options');
      const given = options.tolerancePixels;
      if (
        given !== undefined &&
        (typeof given !== 'number' || !(given >= 0) || given === Infinity)
      ) {
        throw invalidInput('tolerancePixels must be a finite number, 0 or more');
      }
      tolerancePx = given;
    }
    return engine.pickFeatures(at, tolerancePx).map((feature) => ({ feature: toFeature(feature) }));
  };
}
