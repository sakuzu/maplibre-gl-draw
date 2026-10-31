// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The precision of the GLSL that projects positions relative to the center of the view, derived
 * from the bounds GLSL ES 3.00 (4.5.1) gives the error of its operations
 *
 * A GPU may compute the trigonometric built-ins with any error, and some (SwiftShader among them)
 * miss the Mercator y of a latitude by several pixels from zoom 10. The projection of positions
 * therefore uses only the operations the specification bounds. The tests hold:
 *
 * - the GLSL of the projection calls none of the built-ins without a bound
 * - a copy of the GLSL on the CPU, each operation moved by the bound of the specification in the
 *   direction that moves the result most (`test-support/glsl-projection.ts`), lands within half a
 *   pixel of the reference position at every zoom from 0 to 24 for every position on the screen:
 *   on Web Mercator flat and tilted, on the globe and in the transition between, and for the
 *   points of a line on the globe taken along the Mercator plane between ends far outside the
 *   screen
 * - the ends of an edge that crosses the screen from outside it: a point drawn on the edge is
 *   between its ends, so its error is at most theirs. The error of a position grows with its
 *   distance from the center (a few dozen roundoffs of a 32-bit float of that distance), which
 *   holds the ends within half a pixel up to `EDGE_REACH` pixels from the center
 *
 * The GPU of the browser is not at the limit of the specification, so these bounds are what the
 * tests on SwiftShader cannot show.
 */

import { describe, expect, it } from 'vitest';
import {
  type Arithmetic,
  frameProjection,
  mercatorOf,
  projectOffsetToClip,
  referenceClip,
  screenOf,
  stationClip,
  type TestCamera,
  UNIT_ROUNDOFF,
  uniformsOf,
  worstCase,
} from '../../test-support/glsl-projection.js';
import { buildLineVertexSource } from '../renderers/line/line-shader.js';
import { OFFSET_MODE_GLSL } from './helpers.js';

const F32 = Math.fround;
const WIDTH = 1920;
const HEIGHT = 1080;
/** The largest distance from the center of the view to a position on the screen (px) */
const ON_SCREEN = Math.hypot(WIDTH, HEIGHT) / 2;
/**
 * The farthest ends of an edge across the screen held to half a pixel (px from the center): the
 * error of an end is at most about 70 roundoffs of its distance near the limit of Web Mercator,
 * and about 25 elsewhere
 */
const EDGE_REACH = 2 ** 16;
const LIMIT_PX = 0.5;
/** The most roundoffs of a 32-bit float of its distance from the center a position is off by */
const ROUNDOFFS_OF_DISTANCE = 72;

/** The built-in functions GLSL ES 3.00 gives no bound of the error */
const UNBOUNDED = /\b(sin|cos|tan|asin|acos|atan|sinh|cosh|tanh|asinh|acosh|atanh)\s*\(/;

/** The latitude of a Mercator y (float64) */
const latitudeOf = (y: number): number =>
  (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/** The positions at a distance (Mercator px at the zoom) from the center, in a few directions */
function positionsAround(
  camera: TestCamera,
  distance: number,
  directions = 8,
): Array<[number, number]> {
  const worldSize = 512 * 2 ** camera.zoom;
  const [cx, cy] = mercatorOf(camera.center[0], camera.center[1]);
  const out: Array<[number, number]> = [];
  for (let k = 0; k < directions; k++) {
    const angle = (k * 2 * Math.PI) / directions + 0.3;
    const x = cx + (Math.cos(angle) * distance) / worldSize;
    const y = cy + (Math.sin(angle) * distance) / worldSize;
    const lat = latitudeOf(y);
    if (Math.abs(lat) > 85.05 || Math.abs(x - cx) > 1) continue;
    out.push([x * 360 - 180, lat]);
  }
  return out;
}

/** The view of a frame: its projection, the uniforms the shader reads, the center as they hold it */
function viewOf(camera: TestCamera, transition: number) {
  const projection = frameProjection(camera, transition);
  const uniforms = uniformsOf(projection, camera.center);
  const center: [number, number] = [F32(camera.center[0]), F32(camera.center[1])];
  const screen = (clip: readonly number[]) => screenOf(clip, camera.width, camera.height);
  return { projection, uniforms, center, screen, centerScreen: screen(uniforms.projectionCenter) };
}

/** Whether a position given in clip space is drawn on the screen (in front of the camera) */
function onScreen(clip: readonly number[]): boolean {
  const w = clip[3] as number;
  return w > 0 && Math.abs((clip[0] as number) / w) <= 1 && Math.abs((clip[1] as number) / w) <= 1;
}

interface Worst {
  px: number;
  where: string;
}

const worse = (a: Worst, b: Worst): Worst => (a.px >= b.px ? a : b);

/** The largest error in pixels of a computation at the limit of the specification */
function errorPx(compute: (ar: Arithmetic) => number[], reference: readonly number[]): number {
  const { exact, error } = worstCase(compute);
  return Math.hypot(
    Math.abs((exact[0] as number) - (reference[0] as number)) + (error[0] as number),
    Math.abs((exact[1] as number) - (reference[1] as number)) + (error[1] as number),
  );
}

/**
 * The largest error in pixels of the projection of positions, on the copy of the GLSL at the
 * limit of the specification (the positions off the screen left out when `visible`), and the
 * largest error over the distance from the projected center
 */
function worstOf(
  camera: TestCamera,
  transition: number,
  positions: ReadonlyArray<readonly [number, number]>,
  visible: boolean,
): Worst & { roundoffs: number } {
  const view = viewOf(camera, transition);
  let worst: Worst & { roundoffs: number } = { px: 0, where: '', roundoffs: 0 };
  for (const position of positions) {
    // The offsets as the CPU computes them (float64, then 32-bit floats)
    const dLng = F32(position[0] - view.center[0]);
    const dLat = F32(position[1] - view.center[1]);
    const clip = referenceClip(view.projection, view.center[0] + dLng, view.center[1] + dLat);
    if (visible && !onScreen(clip)) continue;
    const reference = view.screen(clip);
    const px = errorPx(
      (ar) => view.screen(projectOffsetToClip(ar, dLng, dLat, view.uniforms)),
      reference,
    );
    const distance = Math.hypot(
      reference[0] - view.centerScreen[0],
      reference[1] - view.centerScreen[1],
    );
    worst.roundoffs = Math.max(worst.roundoffs, px / Math.max(distance, 1) / UNIT_ROUNDOFF);
    if (px > worst.px) {
      worst = {
        px,
        where: `zoom ${camera.zoom} center ${camera.center} position ${position}`,
        roundoffs: worst.roundoffs,
      };
    }
  }
  return worst;
}

/**
 * The largest error in pixels of the points of lines on the globe on the screen, each between two
 * ends `reach` Mercator px from it
 */
function worstStationOf(camera: TestCamera, transition: number, reach: number): Worst {
  const view = viewOf(camera, transition);
  const worldSize = 512 * 2 ** camera.zoom;
  let worst: Worst = { px: 0, where: '' };
  for (const point of [0, 300, ON_SCREEN].flatMap((d) => positionsAround(camera, d, 6))) {
    const [px0, py0] = mercatorOf(point[0], point[1]);
    for (let k = 0; k < 4; k++) {
      const angle = (k * Math.PI) / 4 + 0.2;
      const ux = (Math.cos(angle) * reach) / worldSize;
      const uy = (Math.sin(angle) * reach) / worldSize;
      const ends = [
        [px0 - ux, py0 - uy],
        [px0 + ux * 0.6, py0 + uy * 0.6],
      ];
      if (ends.some(([, y]) => Math.abs(latitudeOf(y as number)) > 85.05)) continue;
      const [a, b] = ends.map(([x, y]) => [
        F32((x as number) * 360 - 180 - view.center[0]),
        F32(latitudeOf(y as number) - view.center[1]),
      ]) as [[number, number], [number, number]];
      const t = F32(1 / 1.6);
      // The reference: the point at t on the Mercator plane between the ends as the GPU holds them
      const [ax, ay] = mercatorOf(view.center[0] + a[0], view.center[1] + a[1]);
      const [bx, by] = mercatorOf(view.center[0] + b[0], view.center[1] + b[1]);
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const clip = referenceClip(view.projection, x * 360 - 180, latitudeOf(y));
      if (!onScreen(clip)) continue;
      const px = errorPx(
        (ar) => view.screen(stationClip(ar, a, b, t, view.uniforms)),
        view.screen(clip),
      );
      if (px > worst.px) {
        worst = { px, where: `zoom ${camera.zoom} center ${camera.center} point ${point}` };
      }
    }
  }
  return worst;
}

const ZOOMS = [...Array.from({ length: 25 }, (_, z) => z), 11.99];
const LATITUDES = [0, 15, 35.68, 60, 80];
const LONGITUDES = [0, 139.7, -179.9];

/** Every position on the screen of a camera: on rings around the center, up to beyond its corners */
function screenPositions(camera: TestCamera): Array<[number, number]> {
  const reach = (camera.pitch ?? 0) > 0 ? 8 * ON_SCREEN : ON_SCREEN;
  return [0.5, 10, 300, ON_SCREEN / 2, ON_SCREEN, reach / 2, reach].flatMap((d) =>
    positionsAround(camera, d, 12),
  );
}

describe('the GLSL of the projection', () => {
  it('calls none of the built-in functions without a bound of the error', () => {
    expect(OFFSET_MODE_GLSL).not.toMatch(UNBOUNDED);
    // The points of a line on the globe are taken along the Mercator plane
    const line = buildLineVertexSource('', '');
    const stations = [...line.matchAll(/\n\w+ station\w*\([^)]*\) \{[\s\S]*?\n\}/g)].map(
      (m) => m[0],
    );
    expect(stations.length).toBeGreaterThan(0);
    for (const station of stations) expect(station).not.toMatch(UNBOUNDED);
  });
});

describe('the projection at the limit of the specification', () => {
  it('stays within half a pixel on the screen of Web Mercator, flat and tilted, at every zoom', () => {
    let worst: Worst = { px: 0, where: '' };
    for (const zoom of ZOOMS) {
      for (const lat of LATITUDES) {
        for (const lng of LONGITUDES) {
          for (const pitch of [0, 60]) {
            const camera: TestCamera = {
              center: [lng, lat],
              zoom,
              pitch,
              bearing: 30,
              width: WIDTH,
              height: HEIGHT,
            };
            worst = worse(worst, worstOf(camera, 0, screenPositions(camera), true));
          }
        }
      }
    }
    expect(worst.px, worst.where).toBeLessThan(LIMIT_PX);
  });

  it('stays within half a pixel at the ends of an edge across the screen', () => {
    let worst: Worst = { px: 0, where: '' };
    for (const zoom of ZOOMS) {
      for (const lat of [...LATITUDES, 84.9, -60]) {
        const camera: TestCamera = { center: [139.7, lat], zoom, width: WIDTH, height: HEIGHT };
        const positions = [4 * ON_SCREEN, 2 ** 13, EDGE_REACH / 2, EDGE_REACH].flatMap((d) =>
          positionsAround(camera, d, 24),
        );
        worst = worse(worst, worstOf(camera, 0, positions, false));
      }
    }
    expect(worst.px, worst.where).toBeLessThan(LIMIT_PX);
  });

  it('keeps the error of a position within a few dozen roundoffs of its distance', () => {
    // What bounds an edge across the screen, whose ends are far
    let roundoffs = 0;
    for (const zoom of ZOOMS) {
      for (const lat of [...LATITUDES, 84.9, -60]) {
        const camera: TestCamera = { center: [139.7, lat], zoom, width: WIDTH, height: HEIGHT };
        const positions = [100, 10_000, 2 ** 15, 2 ** 16, 2 ** 17, 2 ** 18, 2 ** 19].flatMap((d) =>
          positionsAround(camera, d, 24),
        );
        roundoffs = Math.max(roundoffs, worstOf(camera, 0, positions, false).roundoffs);
      }
    }
    expect(roundoffs).toBeLessThan(ROUNDOFFS_OF_DISTANCE);
  });

  it('stays within half a pixel on the screen of the globe and of the transition', () => {
    let worst: Worst = { px: 0, where: '' };
    for (const transition of [1, 0.5, 0.05]) {
      for (const zoom of ZOOMS) {
        for (const lat of LATITUDES) {
          const camera: TestCamera = {
            center: [139.7, lat],
            zoom,
            pitch: 30,
            bearing: 20,
            width: WIDTH,
            height: HEIGHT,
          };
          worst = worse(worst, worstOf(camera, transition, screenPositions(camera), true));
        }
      }
    }
    expect(worst.px, worst.where).toBeLessThan(LIMIT_PX);
  });

  it('stays within half a pixel at the points of a line on the globe between far ends', () => {
    let worst: Worst = { px: 0, where: '' };
    for (const transition of [1, 0.5]) {
      for (const zoom of ZOOMS) {
        for (const lat of LATITUDES) {
          const camera: TestCamera = {
            center: [139.7, lat],
            zoom,
            pitch: 30,
            bearing: 20,
            width: WIDTH,
            height: HEIGHT,
          };
          for (const reach of [4 * ON_SCREEN, EDGE_REACH]) {
            worst = worse(worst, worstStationOf(camera, transition, reach));
          }
        }
      }
    }
    expect(worst.px, worst.where).toBeLessThan(LIMIT_PX);
  });
});
