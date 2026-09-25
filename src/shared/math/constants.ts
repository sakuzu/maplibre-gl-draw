// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Geographic and rendering constants
 *
 * Earth-related constants, rendering parameters, and default style values.
 */

/**
 * Earth-related constants
 */
export const EARTH = {
  /** Circumference of the Earth (meters) */
  CIRCUMFERENCE_METERS: 40075016.686,
  /** Number of meters per degree */
  METERS_PER_DEGREE: 40075016.686 / 360,
  /** Factor that converts radians to degrees */
  DEGREES_PER_RADIAN: 180 / Math.PI,
  /** Factor that converts degrees to radians */
  RADIANS_PER_DEGREE: Math.PI / 180,
} as const;

/**
 * Default tile size
 */
export const DEFAULT_TILE_SIZE = 512;

/**
 * Default rendering parameters
 */
export const RENDERING_DEFAULTS = {
  /** Number of segments of a circle */
  CIRCLE_SEGMENTS: 32,
  /** Miter limit (handling of line corners) */
  MITER_LIMIT: 4.0,
  /** Viewport expansion factor */
  VIEWPORT_EXPANSION_FACTOR: 0.2,
} as const;

/**
 * Presets of dash patterns
 */
export const DASH_PATTERNS = {
  /** Dashed pattern: 10px dash, 5px gap */
  DASHED: [10, 5] as readonly [number, number],
  /** Dotted pattern: 2px dot, 4px gap */
  DOTTED: [2, 4] as readonly [number, number],
  /** Solid line (empty array) */
  SOLID: [] as readonly number[],
} as const;

/**
 * Gets the dash pattern from a LineStyle
 */
export function getDashPattern(lineStyle: 'solid' | 'dashed' | 'dotted'): readonly number[] {
  switch (lineStyle) {
    case 'dashed':
      return [10, 5];
    case 'dotted':
      return [2, 4];
    default:
      return [];
  }
}
