// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the shape hit testing tests on the globe
 *
 * On the globe an edge is drawn along the straight line of the Mercator plane, so the lines
 * and the rings are cut along it before the precise test, and a click on the drawn path of a
 * long slanted edge hits it.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { mercatorLerp } from '../../shared/math/globe-subdivision.js';
import type { FeatureCoordinates } from '../../shared/types/model.js';
import { coordinatesOf, geometryFromCoordinates } from '../../shared/utils/coordinates.js';
import { MemoryStore } from '../../store/memory.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Coordinate, Feature } from '../../store/types.js';
import { createGlobeShapeResolver, globeHitTestGrid, shapeOnGlobe } from './globe-shape.js';
import { HitTestServiceImpl } from './service.js';

function feature(type: string, coordinates: FeatureCoordinates): Feature {
  return {
    id: type,
    type,
    geometry: geometryFromCoordinates(type, coordinates),
    layerId: 'l1',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

/** A map stub set to a projection at a zoom */
function mapOf(type: string | undefined, zoom = 1): MapLibreMap {
  return {
    getProjection: () => (type ? { type } : undefined),
    getZoom: () => zoom,
  } as unknown as MapLibreMap;
}

const SLANTED: Coordinate[] = [
  [-60, 0],
  [60, 50],
];

describe('shapeOnGlobe', () => {
  it('cuts lines, rings and the parts of the Multi types', () => {
    const grid = 1 / 512;
    const line = shapeOnGlobe(feature('LineString', SLANTED), grid);
    expect((coordinatesOf(line) as Coordinate[]).length).toBeGreaterThan(100);

    const ring: Coordinate[] = [
      [-40, 20],
      [40, 20],
      [40, 50],
      [-40, 50],
      [-40, 20],
    ];
    const polygon = shapeOnGlobe(feature('Polygon', [ring]), grid);
    expect((coordinatesOf(polygon) as Coordinate[][])[0].length).toBeGreaterThan(100);

    const multi = shapeOnGlobe(feature('MultiPolygon', [[ring], [ring]]), grid);
    for (const part of coordinatesOf(multi) as Coordinate[][][]) {
      expect(part[0].length).toBeGreaterThan(100);
    }
    expect(coordinatesOf(shapeOnGlobe(feature('Freehand', SLANTED), grid))).toEqual(
      coordinatesOf(line),
    );
  });

  it('keeps the other types and a flat map as they are', () => {
    const point = feature('Point', [0, 0]);
    expect(shapeOnGlobe(point, 1 / 512)).toBe(point);
    const line = feature('LineString', SLANTED);
    expect(shapeOnGlobe(line, 0)).toBe(line);
  });
});

describe('the resolver of a map', () => {
  it('cuts on a globe map only', () => {
    expect(globeHitTestGrid(mapOf('globe', 1))).toBe(1 / 512);
    expect(globeHitTestGrid(mapOf('mercator'))).toBe(0);
    expect(globeHitTestGrid(mapOf(undefined))).toBe(0);
    const line = feature('LineString', SLANTED);
    expect(createGlobeShapeResolver(mapOf('mercator'))(line)).toBe(line);
  });

  it('cuts a feature once per cell', () => {
    let zoom = 1;
    const map = {
      getProjection: () => ({ type: 'globe' }),
      getZoom: () => zoom,
    } as unknown as MapLibreMap;
    const resolve = createGlobeShapeResolver(map);
    const line = feature('LineString', SLANTED);
    const first = resolve(line);
    expect(first).not.toBe(line);
    expect(resolve(line)).toBe(first);
    zoom = 12;
    expect(resolve(line)).not.toBe(first);
  });
});

describe('a click on the drawn path of a long slanted edge', () => {
  const store = new MemoryStore();
  const index = new RBushSpatialIndex();
  const line = feature('LineString', SLANTED);
  // Halfway along the edge as drawn: 2.8 degrees north of the halfway point in degrees
  const onPath = mercatorLerp(SLANTED[0], SLANTED[1], 0.5);

  it('misses when the stored shape is tested', () => {
    const service = new HitTestServiceImpl(store, index);
    expect(service.hitTestFeature(line, onPath, 0.5)).toBe(false);
  });

  it('hits when the shape it is drawn with is tested', () => {
    const service = new HitTestServiceImpl(store, index, {
      drawnShape: createGlobeShapeResolver(mapOf('globe', 1)),
    });
    expect(service.hitTestFeature(line, onPath, 0.5)).toBe(true);
  });
});
