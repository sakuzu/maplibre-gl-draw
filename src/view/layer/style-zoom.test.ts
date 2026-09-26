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

  it('an animated move follows the increments and keeps the gap of a settlement after it ends', () => {
    const zoom = new StyleZoom();
    zoom.update(12, false, cameraAt(5000));
    // A settlement leaves a gap of -0.2
    expect(zoom.update(12.2, false, cameraAt(5000))).toBe(12);
    // easeTo from 12.2 to 13.2 over a few frames
    expect(zoom.update(12.6, true, cameraAt(3800))).toBeCloseTo(12.4);
    expect(zoom.update(13.2, true, cameraAt(2500))).toBeCloseTo(13);
    // The end of the ease: the camera stays where the last frame of the move left it
    expect(zoom.update(13.2, false, cameraAt(2500))).toBeCloseTo(13);
    // A settlement after the ease is absorbed as well
    expect(zoom.update(13.25, false, cameraAt(2500))).toBeCloseTo(13);
    // A jump that changes the zoom drops the gap (a jump sideways at the same zoom keeps it)
    expect(zoom.update(13.25, false, [0.9, 0.39, 2500])).toBeCloseTo(13);
    expect(zoom.update(13.5, false, cameraAt(2100))).toBe(13.5);
  });

  it('takes any change of the zoom that moves the camera, however small', () => {
    const zoom = new StyleZoom();
    const altitude = 5000;
    zoom.update(12, false, cameraAt(altitude));
    // A jump by 0.001 changes the altitude by the factor 2^-0.001
    expect(zoom.update(12.001, false, cameraAt(altitude * 2 ** -0.001))).toBe(12.001);
    // The same at the altitude of a whole-globe view
    const high = 2e7;
    zoom.update(2, false, cameraAt(high));
    expect(zoom.update(2.001, false, cameraAt(high * 2 ** -0.001))).toBe(2.001);
  });

  it('does not absorb a change when the position of the camera cannot be read', () => {
    const zoom = new StyleZoom();
    zoom.update(9.7, false, null);
    expect(zoom.update(11.96, false, null)).toBe(11.96);
  });
});
