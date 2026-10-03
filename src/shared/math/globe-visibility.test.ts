// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the side of the globe a position is on, as maplibre's globe shaders clip it
 */

import { describe, expect, it } from 'vitest';
import { isOnVisibleSideOfGlobe } from './globe-visibility.js';

/** A camera above longitude 0 on the equator: the horizon plane through the center of the sphere */
const FACING_ZERO = { clippingPlane: [0, 0, 1, 0], projectionTransition: 1 };

describe('isOnVisibleSideOfGlobe', () => {
  it('sees the near side and not the far side', () => {
    expect(isOnVisibleSideOfGlobe(0, 0, 0, FACING_ZERO)).toBe(true);
    expect(isOnVisibleSideOfGlobe(80, 30, 0, FACING_ZERO)).toBe(true);
    expect(isOnVisibleSideOfGlobe(100, 0, 0, FACING_ZERO)).toBe(false);
    expect(isOnVisibleSideOfGlobe(180, 0, 0, FACING_ZERO)).toBe(false);
  });

  it('places the longitude as maplibre does (sin for x, cos for z)', () => {
    // A plane facing longitude 90: the meridian 90 is seen, the meridian -90 is not
    const facingEast = { clippingPlane: [1, 0, 0, 0], projectionTransition: 1 };
    expect(isOnVisibleSideOfGlobe(90, 0, 0, facingEast)).toBe(true);
    expect(isOnVisibleSideOfGlobe(-90, 0, 0, facingEast)).toBe(false);
  });

  it('sees a raised position over the horizon a little further', () => {
    // The horizon at longitude 60 (a camera at a finite distance)
    const plane = { clippingPlane: [0, 0, 1, -0.5], projectionTransition: 1 };
    expect(isOnVisibleSideOfGlobe(61, 0, 0, plane)).toBe(false);
    // Raised by 4 percent of the radius of the sphere
    expect(isOnVisibleSideOfGlobe(61, 0, 0.04 * 6371008.8, plane)).toBe(true);
  });

  it('sees everything on the Mercator plane and early in the transition', () => {
    expect(isOnVisibleSideOfGlobe(180, 0, 0, { ...FACING_ZERO, projectionTransition: 0 })).toBe(
      true,
    );
    // Below maplibre's threshold of 0.2 the depth is not mixed in
    expect(isOnVisibleSideOfGlobe(180, 0, 0, { ...FACING_ZERO, projectionTransition: 0.2 })).toBe(
      true,
    );
    expect(isOnVisibleSideOfGlobe(180, 0, 0, { ...FACING_ZERO, projectionTransition: 0.9 })).toBe(
      false,
    );
  });
});
