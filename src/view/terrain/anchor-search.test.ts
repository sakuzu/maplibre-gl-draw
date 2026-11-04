// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the hit testing looks for the anchors drawn under a point of the screen
 * (`anchorSearchBoxes`)
 *
 * A point is drawn without a depth test, so it is seen behind a ridge, and the position the
 * click unprojects to is the ground in front, far from the point. The boxes follow the line of
 * sight under the click between the lowest and the highest ground of the terrain drawn: every
 * position whose anchor is drawn within the reach of the click is in one of them, whatever the
 * position the search starts from, and the boxes stay narrow around the line of sight.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  frameProjection,
  mercatorOf,
  type TestCamera,
} from '../../test-support/glsl-projection.js';
import { calculateOffsetUniforms, type ProjectionMatrices } from '../shaders/helpers.js';
import { anchorSearchBoxes, clearAnchorFrame, projectAnchorAt, setAnchorFrame } from './anchor.js';
import { TerrainContext } from './context.js';
import type { TerrainLike } from './detect.js';
import { UPSTREAM_EARTH_CIRCUMFERENCE_METERS } from './upstream-terrain.js';

const WIDTH = 1280;
const HEIGHT = 720;
const CENTER: [number, number] = [138.73, 35.36];
const context = new TerrainContext();

/** A terrain drawn as one tile whose ground lies between two elevations */
function terrainBetween(min: number | null, max: number | null): TerrainLike {
  return {
    getTerrainData: () => null,
    getElevationForLngLatZoom: () => 0,
    getMinMaxElevation: () => ({ minElevation: min, maxElevation: max }),
    tileManager: {
      getRenderableTiles: () => [{ tileID: { canonical: { x: 3631, y: 1615, z: 12 }, wrap: 0 } }],
    },
  } as unknown as TerrainLike;
}

/** The distance from the camera to the center of the view, in pixels (maplibre's) */
const cameraDistancePx = (height: number): number =>
  (0.5 / Math.tan(0.6435011087932844 / 2)) * height;

/** The position of the camera of a test camera (Mercator, z in Mercator units) */
function cameraMercatorOf(camera: TestCamera): [number, number, number] {
  const worldSize = 512 * 2 ** camera.zoom;
  const [cx, cy] = mercatorOf(camera.center[0], camera.center[1]);
  const distance = cameraDistancePx(camera.height) / worldSize;
  const pitch = ((camera.pitch ?? 0) * Math.PI) / 180;
  const bearing = ((camera.bearing ?? 0) * Math.PI) / 180;
  const ground = Math.sin(pitch) * distance;
  // Behind the center, away from the direction the camera looks in (where the matrix of the
  // frame divides by 0)
  return [
    cx + Math.sin(bearing) * ground,
    cy + Math.cos(bearing) * ground,
    Math.cos(pitch) * distance,
  ];
}

/** Draws a frame of a camera over a terrain */
function drawFrame(camera: TestCamera, terrain: TerrainLike, withCamera = false): void {
  const projection = frameProjection(camera, 0);
  const data = {
    mainMatrix: projection.mainMatrix,
    fallbackMatrix: projection.fallbackMatrix,
    projectionTransition: projection.projectionTransition,
    clippingPlane: [...projection.clippingPlane],
  } as unknown as ProjectionMatrices;
  setAnchorFrame(context, {
    terrain,
    zoom: camera.zoom,
    // Meters to Mercator units at the latitude of the center, as the frame gives it
    elevationScale:
      1 / (UPSTREAM_EARTH_CIRCUMFERENCE_METERS * Math.cos((camera.center[1] * Math.PI) / 180)),
    projection: data,
    offsetUniforms: calculateOffsetUniforms(camera.center, data),
    width: camera.width,
    height: camera.height,
    cameraMercator: withCamera ? cameraMercatorOf(camera) : null,
  });
}

/**
 * Looks for the anchors at positions around the center and elevations of the ground, each from
 * its click, and returns how many were looked for and the most boxes it took
 */
function searchAround(spread: number): { tested: number; boxes: number } {
  let tested = 0;
  let most = 0;
  const offsets: Array<[number, number]> = [];
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) offsets.push([i * 0.5, j * 0.5]);
  for (const [dx, dy] of offsets) {
    for (const elevation of [0, 1200, 3000]) {
      const lng = CENTER[0] + dx * spread;
      const lat = CENTER[1] + dy * spread;
      const click = projectAnchorAt(context, lng, lat, elevation);
      if (!click || click.x < 0 || click.x > WIDTH || click.y < 0 || click.y > HEIGHT) continue;
      // The search starts from the ground the click meets, here in front of the point (a ridge)
      const near = { lng: lng - spread * 0.4, lat: lat - spread * 0.4 };
      const boxes = anchorSearchBoxes(context, click.x, click.y, 10, near);
      expect(boxes, `${[lng, lat, elevation]}`).not.toBeNull();
      if (!boxes) continue;
      expect(inBoxes(boxes, lng, lat), `${[lng, lat, elevation]}`).toBe(true);
      tested++;
      most = Math.max(most, boxes.length / 4);
    }
  }
  return { tested, boxes: most };
}

/** Whether a position is in one of the boxes */
function inBoxes(boxes: readonly number[], lng: number, lat: number): boolean {
  for (let at = 0; at < boxes.length; at += 4) {
    if (lng >= boxes[at] && lng <= boxes[at + 2] && lat >= boxes[at + 1] && lat <= boxes[at + 3]) {
      return true;
    }
  }
  return false;
}

afterEach(() => {
  clearAnchorFrame(context);
});

describe('the boxes the anchors under a point of the screen are looked for in', () => {
  it.each([
    ['looking down', 0, 0],
    ['pitched', 50, 20],
    ['pitched steeply', 70, -35],
  ] as const)('hold every anchor drawn under the click, %s', (_name, pitch, bearing) => {
    const camera: TestCamera = {
      center: CENTER,
      zoom: 13,
      pitch,
      bearing,
      width: WIDTH,
      height: HEIGHT,
    };
    drawFrame(camera, terrainBetween(0, 3000), true);
    const { tested, boxes } = searchAround(0.01);
    expect(tested).toBeGreaterThan(20);
    expect(boxes).toBeLessThanOrEqual(128);
  });

  it('needs no camera while the camera is above the highest ground', () => {
    // At zoom 13 and a pitch of 50 the camera is some 5 km above the center
    const camera: TestCamera = {
      center: CENTER,
      zoom: 13,
      pitch: 50,
      bearing: 20,
      width: WIDTH,
      height: HEIGHT,
    };
    drawFrame(camera, terrainBetween(0, 3000), false);
    expect(searchAround(0.01).tested).toBeGreaterThan(20);
  });

  it('starts the line of sight at the camera when the camera is below the highest ground', () => {
    // At zoom 15 the camera is about a kilometer above the center, under ground of 3,000 m
    const camera: TestCamera = {
      center: CENTER,
      zoom: 15,
      pitch: 60,
      bearing: 30,
      width: WIDTH,
      height: HEIGHT,
    };
    expect(
      cameraMercatorOf(camera)[2] /
        (1 / (UPSTREAM_EARTH_CIRCUMFERENCE_METERS * Math.cos((CENTER[1] * Math.PI) / 180))),
    ).toBeLessThan(3000);
    drawFrame(camera, terrainBetween(0, 3000), true);
    const { tested } = searchAround(0.002);
    expect(tested).toBeGreaterThan(20);
  });

  it('stays narrow around the line of sight', () => {
    const camera: TestCamera = { center: CENTER, zoom: 13, pitch: 0, width: WIDTH, height: HEIGHT };
    drawFrame(camera, terrainBetween(0, 3000));
    const click = projectAnchorAt(context, CENTER[0], CENTER[1], 0);
    expect(click).not.toBeNull();
    if (!click) return;
    const boxes = anchorSearchBoxes(context, click.x, click.y, 10, {
      lng: CENTER[0],
      lat: CENTER[1],
    });
    expect(boxes).not.toBeNull();
    if (!boxes) return;
    // Looking straight down, the line of sight stands over one position: a position drawn
    // 50 px away is not looked for
    const degreesPerPixel = 360 / (512 * 2 ** 13);
    expect(inBoxes(boxes, CENTER[0] + 50 * degreesPerPixel, CENTER[1])).toBe(false);
    expect(inBoxes(boxes, CENTER[0] + 5 * degreesPerPixel, CENTER[1])).toBe(true);
  });

  it('is not given without terrain, nor where the terrain cannot tell the range of its ground', () => {
    expect(anchorSearchBoxes(context, 10, 10, 10, { lng: CENTER[0], lat: CENTER[1] })).toBeNull();
    const camera: TestCamera = {
      center: CENTER,
      zoom: 13,
      pitch: 50,
      width: WIDTH,
      height: HEIGHT,
    };
    drawFrame(camera, {
      getTerrainData: () => null,
      tileManager: { getRenderableTiles: () => [{ tileID: { canonical: { x: 0, y: 0, z: 0 } } }] },
    } as unknown as TerrainLike);
    expect(anchorSearchBoxes(context, 640, 360, 10, { lng: CENTER[0], lat: CENTER[1] })).toBeNull();
  });

  it('treats a tile whose DEM has not arrived as flat', () => {
    const camera: TestCamera = {
      center: CENTER,
      zoom: 13,
      pitch: 50,
      width: WIDTH,
      height: HEIGHT,
    };
    drawFrame(camera, terrainBetween(null, null));
    const click = projectAnchorAt(context, CENTER[0], CENTER[1], 0);
    expect(click).not.toBeNull();
    const boxes =
      click && anchorSearchBoxes(context, click.x, click.y, 10, { lng: CENTER[0], lat: CENTER[1] });
    expect(boxes).not.toBeNull();
    expect(boxes && inBoxes(boxes, CENTER[0], CENTER[1])).toBe(true);
  });
});
