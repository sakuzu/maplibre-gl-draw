// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the style zoom (StyleZoom): which changes of the zoom number it absorbs
 */

import { describe, expect, it } from 'vitest';
import { type CameraPosition, StyleZoom } from './frame-state.js';

/** A camera over Tokyo at the given altitude (m) */
function cameraAt(altitude: number): CameraPosition {
  return [0.8882, 0.394, altitude];
}

describe('StyleZoom', () => {
  it('starts at the raw zoom and follows the increments while the camera is busy', () => {
    const zoom = new StyleZoom();
    expect(zoom.update(12, false, cameraAt(5000))).toBe(12);
    expect(zoom.update(11.5, true, cameraAt(7000))).toBe(11.5);
    expect(zoom.update(11, true, cameraAt(10000))).toBe(11);
  });

  it('absorbs a change of the zoom number while the camera stays where it is (a settlement)', () => {
    const zoom = new StyleZoom();
    zoom.update(12, false, cameraAt(5000));
    // The camera maplibre reports drifts sideways by a meter or two while it keeps its altitude
    const drifted: CameraPosition = [0.8882 + 4e-8, 0.394 + 2e-8, 5000];
    expect(zoom.update(12.2, false, drifted)).toBe(12);

    // An operation after it follows the increments, keeping the gap
    expect(zoom.update(12.7, true, cameraAt(3500))).toBeCloseTo(12.5);
  });

  it('takes the raw zoom when the camera jumped while nothing was moving (jumpTo)', () => {
    const zoom = new StyleZoom();
    zoom.update(9.7, false, cameraAt(40000));
    expect(zoom.update(11.96, false, cameraAt(8300))).toBe(11.96);

    // A settlement before the jump is not carried over either
    zoom.update(12.2, false, cameraAt(8300));
    expect(zoom.update(10, false, cameraAt(33000))).toBe(10);
  });

  it('does not absorb a change when the position of the camera cannot be read', () => {
    const zoom = new StyleZoom();
    zoom.update(9.7, false, null);
    expect(zoom.update(11.96, false, null)).toBe(11.96);
  });
});
