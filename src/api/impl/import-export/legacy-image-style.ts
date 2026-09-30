// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The style keys an Image had in 1.0, folded into the model of 2.0
 *
 * In 1.0 the style of an Image could carry its size, a rotation and an opacity of its own. In
 * 2.0 the size and the rotation are values of the library in `properties` and the opacity is
 * `imageOpacity` of the style. Data written by 1.0 (native data of version 2 and GeoJSON) is
 * read through this fold so that the image keeps its look.
 */

import { drawPropertyKey } from '../../../shared/properties.js';

/** The style keys of an Image that 2.0 does not have */
const LEGACY_KEYS = ['width', 'height', 'rotation', 'opacity'] as const;

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Folds the style keys of an Image of 1.0 into its properties and its style
 *
 * - `width` and `height`, when they are positive, become the size the image is drawn at
 *   (`maplibre-gl-draw:imageWidth` and `maplibre-gl-draw:imageHeight`)
 * - `rotation` is added to `maplibre-gl-draw:rotation` (1.0 drew the sum of the two)
 * - `opacity` becomes `imageOpacity` when the style has no `imageOpacity` (1.0 read it only
 *   then)
 *
 * The four keys are removed from the style. The objects given are changed in place.
 *
 * @param properties - the properties of the feature, with the values of the library prefixed
 * @param style - the style of the feature
 * @returns whether anything was folded
 */
export function foldLegacyImageStyle(
  properties: Record<string, unknown>,
  style: Record<string, unknown>,
): boolean {
  if (!LEGACY_KEYS.some((key) => key in style)) return false;
  const { width, height, rotation, opacity } = style;
  if (isNumber(width) && width > 0) properties[drawPropertyKey('imageWidth')] = width;
  if (isNumber(height) && height > 0) properties[drawPropertyKey('imageHeight')] = height;
  if (isNumber(rotation) && rotation !== 0) {
    const current = properties[drawPropertyKey('rotation')];
    properties[drawPropertyKey('rotation')] = (isNumber(current) ? current : 0) + rotation;
  }
  if (style.imageOpacity === undefined && isNumber(opacity)) style.imageOpacity = opacity;
  for (const key of LEGACY_KEYS) delete style[key];
  return true;
}
