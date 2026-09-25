// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  DASH_PATTERNS,
  DEFAULT_TILE_SIZE,
  EARTH,
  getDashPattern,
  RENDERING_DEFAULTS,
} from './constants.js';

describe('EARTH', () => {
  it('CIRCUMFERENCE_METERS is roughly 40,075,017 meters', () => {
    expect(EARTH.CIRCUMFERENCE_METERS).toBeCloseTo(40075016.686, 0);
  });

  it('METERS_PER_DEGREE is the circumference / 360', () => {
    expect(EARTH.METERS_PER_DEGREE).toBeCloseTo(EARTH.CIRCUMFERENCE_METERS / 360, 6);
  });

  it('DEGREES_PER_RADIAN is 180 / PI', () => {
    expect(EARTH.DEGREES_PER_RADIAN).toBeCloseTo(180 / Math.PI, 10);
  });

  it('RADIANS_PER_DEGREE is PI / 180', () => {
    expect(EARTH.RADIANS_PER_DEGREE).toBeCloseTo(Math.PI / 180, 10);
  });

  it('DEGREES_PER_RADIAN and RADIANS_PER_DEGREE are reciprocals of each other', () => {
    expect(EARTH.DEGREES_PER_RADIAN * EARTH.RADIANS_PER_DEGREE).toBeCloseTo(1, 10);
  });
});

describe('DEFAULT_TILE_SIZE', () => {
  it('is 512', () => {
    expect(DEFAULT_TILE_SIZE).toBe(512);
  });
});

describe('RENDERING_DEFAULTS', () => {
  it('CIRCLE_SEGMENTS is 32', () => {
    expect(RENDERING_DEFAULTS.CIRCLE_SEGMENTS).toBe(32);
  });

  it('MITER_LIMIT is 4.0', () => {
    expect(RENDERING_DEFAULTS.MITER_LIMIT).toBe(4.0);
  });

  it('VIEWPORT_EXPANSION_FACTOR is 0.2', () => {
    expect(RENDERING_DEFAULTS.VIEWPORT_EXPANSION_FACTOR).toBe(0.2);
  });
});

describe('DASH_PATTERNS', () => {
  it('DASHED is [10, 5]', () => {
    expect(DASH_PATTERNS.DASHED).toEqual([10, 5]);
  });

  it('DOTTED is [2, 4]', () => {
    expect(DASH_PATTERNS.DOTTED).toEqual([2, 4]);
  });

  it('SOLID is an empty array', () => {
    expect(DASH_PATTERNS.SOLID).toEqual([]);
  });
});

describe('getDashPattern', () => {
  it('solid returns an empty array', () => {
    expect(getDashPattern('solid')).toEqual([]);
  });

  it('dashed returns [10, 5]', () => {
    expect(getDashPattern('dashed')).toEqual([10, 5]);
  });

  it('dotted returns [2, 4]', () => {
    expect(getDashPattern('dotted')).toEqual([2, 4]);
  });
});
