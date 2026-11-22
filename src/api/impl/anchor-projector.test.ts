// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests that the anchor projection belongs to the draw instance
 *
 * Two draw instances on one map each project through the projection of their own terrain state:
 * the projection of one never serves the hit testing of the other, and taking one off the map
 * leaves the projection of the other as it was.
 *
 * The drawing layers of two instances have the same id, so the map stub keeps only the layer of
 * the first; the layer of the second is put on the map and taken off it by hand (its `onAdd`
 * and `onRemove`), as the map calls them.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, describe, expect, it } from 'vitest';
import { createCoordinateTransform } from '../../shared/math/index.js';
import { createCountingGL, createDrawingMapStub } from '../../test-utils.js';
import { projectAnchor, setAnchorFrame } from '../../view/terrain/anchor.js';
import type { TerrainContext } from '../../view/terrain/context.js';
import type { TerrainLike } from '../../view/terrain/detect.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';

const engines: Engine[] = [];
/** The layers put on the map by hand, taken off before the instances are destroyed */
const removing: (() => void)[] = [];

afterEach(() => {
  for (const remove of removing.splice(0)) remove();
  for (const engine of engines.splice(0)) engine.destroy();
});

/** A terrain stand-in of one elevation everywhere */
function terrainAt(elevation: number): TerrainLike {
  return {
    getTerrainData: () => null,
    getElevationForLngLatZoom: () => elevation,
    tileManager: { getRenderableTiles: () => [{ tileID: { canonical: { x: 0, y: 0, z: 0 } } }] },
  } as unknown as TerrainLike;
}

/** The identity matrix with a term by which the elevation moves the screen upward */
function matrix(): number[] {
  const m = new Array(16).fill(0);
  m[0] = 1;
  m[5] = 1;
  m[9] = 4;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/** Gives a terrain state the frame of a terrain of one elevation */
function applyFrame(context: TerrainContext, elevation: number): void {
  setAnchorFrame(context, {
    terrain: terrainAt(elevation),
    zoom: 14,
    elevationScale: 1e-3,
    mainMatrix: matrix(),
    offsetUniforms: {
      centerLngLat: [0, 0],
      centerLngLat64: [0, 0],
      centerMercator: [0.5, 0.5],
      projectionCenter: [0, 0, 0, 1],
      unitsPerDegree: [1, 1, 1],
      unitsPerDegree2: [0, 0, 0],
    },
    width: 800,
    height: 600,
  });
}

/** Two draw instances on one map that draws on a GL, both of their layers on the map */
function twoOnOneMap() {
  const gl = createCountingGL();
  const stub = createDrawingMapStub(gl.gl);
  const map = stub.map as unknown as MapLibreMap;
  const make = () => {
    const engine = createEngine(map, {});
    engines.push(engine);
    return engine;
  };
  const first = make();
  const second = make();
  second.customLayer.onAdd?.(map, gl.gl);
  // Takes the layer of the second off the map, as the map does when it removes the layer
  const removeSecond = () => second.customLayer.onRemove?.(map, gl.gl);
  removing.push(removeSecond);
  return { map, first, second, removeSecond };
}

describe('the anchor projection of a draw instance', () => {
  it('is the projection of its own terrain state, with two instances on one map', () => {
    const { map, first, second } = twoOnOneMap();
    const firstTerrain = first.customLayer.getTerrainContext();
    const secondTerrain = second.customLayer.getTerrainContext();
    applyFrame(firstTerrain, 1000);
    applyFrame(secondTerrain, 0);

    const firstExpected = projectAnchor(firstTerrain, 0, 0);
    const secondExpected = projectAnchor(secondTerrain, 0, 0);
    expect(firstExpected).not.toBeNull();
    expect(secondExpected).not.toBeNull();
    expect(firstExpected).not.toEqual(secondExpected);

    // The hit testing of each instance (and the modes and the selection UI, which take the same
    // projector) projects through its own frame, whichever instance was added last
    expect(first.context.anchorProjector.project(0, 0)).toEqual(firstExpected);
    expect(second.context.anchorProjector.project(0, 0)).toEqual(secondExpected);
    expect(createCoordinateTransform(map, first.context.anchorProjector).project([0, 0])).toEqual(
      firstExpected,
    );
    expect(createCoordinateTransform(map, second.context.anchorProjector).project([0, 0])).toEqual(
      secondExpected,
    );
  });

  it('stays the projection of the instance left on the map when the other is removed', () => {
    const { map, first, second, removeSecond } = twoOnOneMap();
    const firstTerrain = first.customLayer.getTerrainContext();
    applyFrame(firstTerrain, 1000);
    applyFrame(second.customLayer.getTerrainContext(), 0);
    const expected = projectAnchor(firstTerrain, 0, 0);
    expect(expected).not.toBeNull();

    removeSecond();
    removing.splice(removing.indexOf(removeSecond), 1);

    expect(first.context.anchorProjector.project(0, 0)).toEqual(expected);
    expect(createCoordinateTransform(map, first.context.anchorProjector).project([0, 0])).toEqual(
      expected,
    );
    // The instance taken off the map projects through nothing any more
    expect(second.context.anchorProjector.project(0, 0)).toBeNull();
  });

  it('is null without a terrain, and the project of the map is used then', () => {
    const { map, first } = twoOnOneMap();

    expect(first.context.anchorProjector.project(0, 0)).toBeNull();
    const point = map.project([10, 20]);
    expect(createCoordinateTransform(map, first.context.anchorProjector).project([10, 20])).toEqual(
      { x: point.x, y: point.y },
    );
  });
});
