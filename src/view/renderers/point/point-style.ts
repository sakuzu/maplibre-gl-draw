// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resolution of the style of a point marker
 *
 * The only place that merges the style of a point feature into the default of the instance.
 * Every built-in path reads a point through it (via `FeatureDrawer.getPointStyle`): the
 * immediate batches, the classification of the retained runs, the retained chunks and the
 * datasets. The shape in particular decides which run and which batch a point
 * goes on, so resolving it anywhere else would split the z-order of the paths.
 */

import { hexToColor } from '../../../shared/utils/color.js';
import type { FeatureStyle } from '../../../store/types.js';
import type { PointShape, PointStyle } from './point-shape.js';

/** The shapes a feature may name (`'icon'` belongs to the defaults of an extension) */
const FEATURE_POINT_SHAPES: ReadonlySet<string> = new Set(['circle', 'square', 'triangle', 'star']);

/**
 * The shape a feature names, or undefined when it names none or a value it may not name
 *
 * A style that did not come through an import (set through the API or applied by a replaced
 * store) is not validated, so a stray value falls back to the default here.
 */
function featurePointShape(style: FeatureStyle): PointShape | undefined {
  const shape = style.pointShape;
  return shape !== undefined && FEATURE_POINT_SHAPES.has(shape) ? shape : undefined;
}

/**
 * Merges the style of a point feature (already carrying the rule color) into the default
 *
 * The keys of the feature win key by key: `pointColor` becomes the fill, `pointRadius` the
 * size (a diameter), `pointShape` the shape. A key left unset (or a shape that is not one of
 * the four a feature may name) keeps the default.
 *
 * @param style The style of the feature (undefined when it has none)
 * @param defaults The point style of the `style` option of the instance
 *
 * @internal
 */
export function resolvePointStyle(
  style: FeatureStyle | undefined,
  defaults: PointStyle,
): PointStyle {
  if (!style) return defaults;

  return {
    ...defaults,
    shape: featurePointShape(style) ?? defaults.shape,
    fillColor: style.pointColor ? hexToColor(style.pointColor, 1) : defaults.fillColor,
    size: style.pointRadius ? style.pointRadius * 2 : defaults.size,
  };
}
