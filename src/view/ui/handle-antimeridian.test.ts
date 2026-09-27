// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the handles of a feature drawn on the other side of the antimeridian
 *
 * The feature is stored in [-180, 180], but a view across the antimeridian draws it as a second
 * copy, 360 degrees away, and the pointer unprojects to the unwrapped longitude of the view.
 * The handles are projected on the copy nearest to the pointer, the copy that is drawn there.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import type { CoordinateTransform } from '../../shared/math/index.js';
import type { Coordinate, Feature } from '../../store/types.js';
import { hitTestHandles } from './handle-test.js';
import { createSelectionScope } from './selection-scope.js';

/** A plain unwrapped projection around 180 (1 degree = 1000 px, x = 0 at 180) */
const transform: CoordinateTransform = {
  project: (lngLat: Coordinate) => ({ x: (lngLat[0] - 180) * 1000, y: -lngLat[1] * 1000 }),
  unproject: (point: { x: number; y: number }) => ({
    lng: 180 + point.x / 1000,
    lat: -point.y / 1000,
  }),
};

function line(id: string, coordinates: Coordinate[]): Feature {
  return {
    id,
    type: 'LineString',
    geometry: { type: 'LineString', coordinates: coordinates },
    layerId: 'l1',
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

describe('handles across the antimeridian', () => {
  it('grabs the vertex of a line stored on the other side at its drawn position', () => {
    // Stored at -179.9 and -179.8: drawn at 180.1 and 180.2, that is x = 100 and x = 200
    const feature = line('west', [
      [-179.9, 0],
      [-179.8, 0.05],
    ]);
    const hit = hitTestHandles(
      { x: 100, y: 0 },
      [feature],
      transform,
      DEFAULT_SELECTION_CONFIG,
      14,
      createSelectionScope(),
    );

    expect(hit?.type).toBe('vertex');
    expect(hit?.vertexRef).toMatchObject({ index: 0 });
  });
});
