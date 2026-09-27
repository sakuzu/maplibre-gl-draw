// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Validation of an imported feature style
 *
 * A style arrives from a file (the maplibre-gl-draw:style property of GeoJSON, the style of a
 * native feature, the simplestyle-spec keys) and reaches the renderer, which parses the
 * colors as CSS colors and uses the numbers as they are. A value of the wrong type or form (a
 * number or null for a color, a string that is not a CSS color, an opacity of 5) would be
 * drawn wrong, so each known key is checked here and a key that fails is dropped. Keys this
 * library does not define are kept unchanged, whatever their value: they belong to the host or
 * to an extension, which gives features keys of its own and checks their values where it reads
 * them (values reach the Store through updateFeature and a replaced store as well, without
 * passing here).
 */

import { isColor } from '../../../shared/color.js';
import type { FeatureStyle } from '../../../store/types.js';
import { setOwnProperty } from './own-property.js';

type Check = (value: unknown) => boolean;

/** A CSS color */
export const isCssColor: Check = isColor;

const isFiniteNumber: Check = (value) => typeof value === 'number' && Number.isFinite(value);
const isOpacity: Check = (value) =>
  isFiniteNumber(value) && (value as number) >= 0 && (value as number) <= 1;
const isNonNegative: Check = (value) => isFiniteNumber(value) && (value as number) >= 0;
const oneOf =
  (...values: string[]): Check =>
  (value) =>
    typeof value === 'string' && values.includes(value);

/** The check of every key of FeatureStyle */
const STYLE_CHECK_TABLE: Readonly<Record<keyof FeatureStyle, Check>> = {
  fillColor: isCssColor,
  fillOpacity: isOpacity,
  strokeColor: isCssColor,
  strokeWidth: isNonNegative,
  strokeOpacity: isOpacity,
  lineStyle: oneOf('solid', 'dashed', 'dotted'),
  pointRadius: isNonNegative,
  pointColor: isCssColor,
  pointShape: oneOf('circle', 'square', 'triangle', 'star'),
  pointOpacity: isOpacity,
  imageOpacity: isOpacity,
};

const STYLE_CHECKS: ReadonlyMap<string, Check> = new Map(Object.entries(STYLE_CHECK_TABLE));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns the usable part of an imported style
 *
 * A key of FeatureStyle whose value fails its check is dropped; every other key is kept.
 *
 * @param value The style as read from the file
 * @returns The style, or undefined when the value is not an object or nothing is left
 */
export function sanitizeFeatureStyle(value: unknown): FeatureStyle | undefined {
  if (!isRecord(value)) return undefined;
  const style: Record<string, unknown> = {};
  let kept = 0;
  for (const [key, entry] of Object.entries(value)) {
    const check = STYLE_CHECKS.get(key);
    if (check && !check(entry)) continue;
    setOwnProperty(style, key, entry);
    kept++;
  }
  return kept > 0 ? (style as FeatureStyle) : undefined;
}

/**
 * Describes the first key of a style whose value fails its check
 *
 * A key given as `undefined` is not checked (it removes the key in a patch), and a key this
 * library does not define is not checked either.
 *
 * @param value The style
 * @returns A short description of the problem, or null when there is none
 */
export function describeStyleProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'a style that is not an object';
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    const check = STYLE_CHECKS.get(key);
    if (check && !check(entry)) return `a style whose ${key} is not valid`;
  }
  return null;
}
