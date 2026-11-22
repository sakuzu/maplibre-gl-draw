// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests that the anchor projection belongs to the draw instance
 *
 * Two draw instances on the page, each on its own map (a map takes one instance at a time),
 * each project through the projection of their own terrain state: the projection of one never
 * serves the hit testing of the other, and taking one off its map leaves the projection of the
 * other as it was.
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

afterEach(() => {
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

/** A draw instance on a map of its own that draws on a GL (its layer on the map) */
function onItsOwnMap() {
  const gl = createCountingGL();
  const map = createDrawingMapStub(gl.gl).map as unknown as MapLibreMap;
  const engine = createEngine(map, {});
  engines.push(engine);
  return { map, engine };
}

/** Two draw instances, each on its own map */
function twoOnTwoMaps() {
  const one = onItsOwnMap();
  const two = onItsOwnMap();
  return { firstMap: one.map, first: one.engine, secondMap: two.map, second: two.engine };
}

describe('the anchor projection of a draw instance', () => {
  it('is the projection of its own terrain state, with two instances on the page', () => {
    const { firstMap, first, secondMap, second } = twoOnTwoMaps();
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
    expect(
      createCoordinateTransform(firstMap, first.context.anchorProjector).project([0, 0]),
    ).toEqual(firstExpected);
    expect(
      createCoordinateTransform(secondMap, second.context.anchorProjector).project([0, 0]),
    ).toEqual(secondExpected);
  });

  it('stays the projection of the instance left on its map when the other is destroyed', () => {
    const { firstMap: map, first, second } = twoOnTwoMaps();
    const firstTerrain = first.customLayer.getTerrainContext();
    applyFrame(firstTerrain, 1000);
    applyFrame(second.customLayer.getTerrainContext(), 0);
    const expected = projectAnchor(firstTerrain, 0, 0);
    expect(expected).not.toBeNull();

    // Destroying the second takes its layer off its map and releases its terrain state
    second.destroy();
    engines.splice(engines.indexOf(second), 1);

    expect(first.context.anchorProjector.project(0, 0)).toEqual(expected);
    expect(createCoordinateTransform(map, first.context.anchorProjector).project([0, 0])).toEqual(
      expected,
    );
    // The destroyed instance projects through nothing any more
    expect(second.context.anchorProjector.project(0, 0)).toBeNull();
  });

  it('is null without a terrain, and the project of the map is used then', () => {
    const { map, engine: first } = onItsOwnMap();

    expect(first.context.anchorProjector.project(0, 0)).toBeNull();
    const point = map.project([10, 20]);
    expect(createCoordinateTransform(map, first.context.anchorProjector).project([10, 20])).toEqual(
      { x: point.x, y: point.y },
    );
  });
});
