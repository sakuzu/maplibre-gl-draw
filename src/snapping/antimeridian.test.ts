// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for snapping across the antimeridian
 *
 * The features are stored with longitudes in [-180, 180], while the cursor comes in the unwrapped
 * longitude of the view (above 180 on the copy east of the antimeridian, where the stored
 * features on the other side of the line are drawn a second time). Snapping looks the
 * candidates up around the cursor brought into [-180, 180] and returns the target on the copy
 * nearest to the cursor, so the cursor lands on what is drawn under it.
 */

import { describe, expect, it } from 'vitest';
import type { ModifierKeys } from '../dispatcher/types.js';
import type { BoundingBox, Coordinate } from '../store/types.js';
import { degreesPerPixel } from './geometry.js';
import { createSnapService } from './service.js';
import type { SnapCandidate, SnapLngLat, SnapProvider } from './types.js';

const NO_MODIFIERS: ModifierKeys = { shift: false, ctrl: false, alt: false, meta: false };
const ZOOM = 14;

/** A provider over stored vertices that returns only those inside the searched box */
function storedVertices(coordinates: Coordinate[]): SnapProvider {
  return {
    name: 'stored',
    candidates: (bbox: BoundingBox): SnapCandidate[] =>
      coordinates
        .filter(
          ([lng, lat]) =>
            lng >= bbox.minX && lng <= bbox.maxX && lat >= bbox.minY && lat <= bbox.maxY,
        )
        .map((coordinate) => ({ kind: 'vertex', coordinate, featureId: 'f' })),
  };
}

/** A provider whose candidates are already in the frame of the cursor (like a guide) */
function cursorFrame(coordinate: Coordinate): SnapProvider {
  return {
    name: 'cursor-frame',
    candidates: (): SnapCandidate[] => [{ kind: 'vertex', coordinate }],
  };
}

function resolve(provider: SnapProvider, lngLat: SnapLngLat) {
  const service = createSnapService();
  service.register(provider);
  return service.resolve(lngLat, { x: 0, y: 0 }, { zoom: ZOOM, modifiers: NO_MODIFIERS });
}

const perPixel = degreesPerPixel(0, ZOOM);

describe('snapping across the antimeridian', () => {
  it('snaps an unwrapped cursor to a vertex stored on the other side of the line', () => {
    const stored: Coordinate = [-179.9, 0];
    const cursor = { lng: 180.1 + 3 * perPixel.lng, lat: 0 };
    const result = resolve(storedVertices([stored]), cursor);

    expect(result.target?.kind).toBe('vertex');
    // Returned on the copy nearest to the cursor (the copy that is drawn there)
    expect(result.lngLat.lng).toBeCloseTo(180.1, 10);
    expect(result.lngLat.lat).toBe(0);
  });

  it('snaps to a vertex just across the line within the tolerance', () => {
    const stored: Coordinate = [-180 + 2 * perPixel.lng, 0];
    const cursor = { lng: 180 - 2 * perPixel.lng, lat: 0 };
    const result = resolve(storedVertices([stored]), cursor);

    expect(result.target?.kind).toBe('vertex');
    expect(result.lngLat.lng).toBeCloseTo(180 + 2 * perPixel.lng, 10);
  });

  it('leaves a candidate already in the frame of the cursor where it is', () => {
    const guide: Coordinate = [180.1 + 2 * perPixel.lng, 0];
    const result = resolve(cursorFrame(guide), { lng: 180.1, lat: 0 });

    expect(result.lngLat).toEqual({ lng: guide[0], lat: guide[1] });
  });

  it('changes nothing away from the antimeridian', () => {
    const stored: Coordinate = [139.7 + 3 * perPixel.lng, 35.68];
    const result = resolve(storedVertices([stored]), { lng: 139.7, lat: 35.68 });

    expect(result.lngLat).toEqual({ lng: stored[0], lat: stored[1] });
  });
});
