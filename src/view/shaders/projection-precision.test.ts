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
 *   pixel of the reference position at every zoom from 0 to 24: on Web Mercator flat and tilted,
 *   on the globe and in the transition between, for a position on the screen, and for the ends of
 *   an edge that crosses the screen from far outside it (a point drawn on the edge is between
 *   its ends, so its error is at most theirs)
 *
 * The GPU of the browser is not at the limit of the specification, so these bounds are what the
 * tests on SwiftShader cannot show.
 */

import { describe, expect, it } from 'vitest';
import { buildLineVertexSource } from '../renderers/line/line-shader.js';
import {
  frameProjection,
  mercatorOf,
  projectMercatorOffsetToClip,
  projectOffsetToClip,
  referenceClip,
  screenOf,
  type TestCamera,
  UNIT_ROUNDOFF,
  uniformsOf,
  worstCase,
} from '../../test-support/glsl-projection.js';
import { OFFSET_MODE_GLSL } from './helpers.js';

const F32 = Math.fround;
const WIDTH = 1920;
const HEIGHT = 1080;
/** The largest distance from the center of the view to a position on the screen (px) */
const ON_SCREEN = Math.hypot(WIDTH, HEIGHT) / 2;
/**
 * The farthest ends of an edge across the screen held to half a pixel (px from the center). The
 * offsets the CPU gives the shader are 32-bit floats, rounded by 2^-24 of their size: beyond this
 * that rounding alone (0.03 px here) approaches what is left of the half pixel
 */
const EDGE_REACH = 2 ** 19;
const LIMIT_PX = 0.5;

/** The built-in functions GLSL ES 3.00 gives no bound of the error */
const UNBOUNDED = /\b(sin|cos|tan|asin|acos|atan|sinh|cosh|tanh|asinh|acosh|atanh)\s*\(/;

/** The latitude of a Mercator y (float64) */
const latitudeOf = (y: number): number =>
  (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/** The positions at a distance (px) from the center of the view, in a few directions */
function positionsAround(
  camera: TestCamera,
  distance: number,
): Array<[number, number]> {
  const worldSize = 512 * 2 ** camera.zoom;
  const [cx, cy] = mercatorOf(camera.center[0], camera.center[1]);
  const out: Array<[number, number]> = [];
  for (let k = 0; k < 8; k++) {
    const angle = (k * Math.PI) / 4 + 0.3;
    const x = cx + (Math.cos(angle) * distance) / worldSize;
    const y = cy + (Math.sin(angle) * distance) / worldSize;
    const lat = latitudeOf(y);
    if (Math.abs(lat) > 85.05 || Math.abs(x - cx) > 1) continue;
    out.push([x * 360 - 180, lat]);
  }
  return out;
}

/** The angle between two positions on the sphere, in degrees */
function angleBetween(a: readonly [number, number], b: readonly [number, number]): number {
  const r = Math.PI / 180;
  const c =
    Math.sin(a[1] * r) * Math.sin(b[1] * r) +
    Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r);
  return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
}

interface Worst {
  px: number;
  where: string;
}

/**
 * The largest error in pixels of the projection of the positions, on the copy of the GLSL at the
 * limit of the specification
 */
function worstOf(
  camera: TestCamera,
  transition: number,
  positions: ReadonlyArray<readonly [number, number]>,
  station = false,
): Worst {
  const projection = frameProjection(camera, transition);
  const uniforms = uniformsOf(projection, camera.center);
  const center: [number, number] = [F32(camera.center[0]), F32(camera.center[1])];
  let worst: Worst = { px: 0, where: '' };
  for (const position of positions) {
    // The offsets as the CPU computes them (float64, then 32-bit floats)
    const dLng = F32(position[0] - center[0]);
    const dLat = F32(position[1] - center[1]);
    let reference: [number, number];
    let compute: (ar: Parameters<typeof projectOffsetToClip>[0]) => number[];
    if (station) {
      // A point of a line on the globe, given by its Mercator offset from the center
      const [mx, my] = mercatorOf(center[0] + dLng, center[1] + dLat);
      const [cx, cy] = mercatorOf(center[0], center[1]);
      const mercator: [number, number] = [F32(mx - cx), F32(my - cy)];
      const lng = center[0] + mercator[0] * 360;
      const lat = latitudeOf(cy + mercator[1]);
      reference = screenOf(referenceClip(projection, lng, lat), camera.width, camera.height);
      compute = (ar) =>
        screenOf(projectMercatorOffsetToClip(ar, mercator, uniforms), camera.width, camera.height);
    } else {
      reference = screenOf(
        referenceClip(projection, center[0] + dLng, center[1] + dLat),
        camera.width,
        camera.height,
      );
      compute = (ar) =>
        screenOf(projectOffsetToClip(ar, dLng, dLat, uniforms), camera.width, camera.height);
    }
    const { exact, error } = worstCase(compute);
    const px = Math.hypot(
      Math.abs((exact[0] as number) - reference[0]) + (error[0] as number),
      Math.abs((exact[1] as number) - reference[1]) + (error[1] as number),
    );
    if (px > worst.px) {
      worst = { px, where: `zoom ${camera.zoom} center ${camera.center} position ${position}` };
    }
  }
  return worst;
}

const ZOOMS = [...Array.from({ length: 25 }, (_, z) => z), 11.99];
const LATITUDES = [0, 15, 35.68, 60, 80];
const LONGITUDES = [0, 139.7, -179.9];

describe('the GLSL of the projection', () => {
  it('calls none of the built-in functions without a bound of the error', () => {
    expect(OFFSET_MODE_GLSL).not.toMatch(UNBOUNDED);
    // The stations of a line on the globe are projected from their Mercator offsets
    const line = buildLineVertexSource('', '');
    const stations = [...line.matchAll(/\n\w+ station\w*\([^)]*\) \{[\s\S]*?\n\}/g)].map(
      (m) => m[0],
    );
    expect(stations.length).toBeGreaterThan(0);
    for (const station of stations) expect(station).not.toMatch(UNBOUNDED);
  });
});

describe('the projection at the limit of the specification', () => {
  it('stays within half a pixel on Web Mercator, flat and tilted, at every zoom', () => {
    const worst: Worst[] = [];
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
            const positions = [0.5, 10, 300, ON_SCREEN].flatMap((d) => positionsAround(camera, d));
            worst.push(worstOf(camera, 0, positions));
          }
        }
      }
    }
    const max = worst.reduce((a, b) => (a.px > b.px ? a : b));
    expect(max.px, max.where).toBeLessThan(LIMIT_PX);
  });

  it('stays within half a pixel at the ends of an edge across the screen', () => {
    const worst: Worst[] = [];
    for (const zoom of ZOOMS) {
      for (const lat of LATITUDES) {
        const camera: TestCamera = { center: [139.7, lat], zoom, width: WIDTH, height: HEIGHT };
        const positions = [4 * ON_SCREEN, 2 ** 14, 2 ** 17, EDGE_REACH].flatMap((d) =>
          positionsAround(camera, d),
        );
        worst.push(worstOf(camera, 0, positions));
      }
    }
    const max = worst.reduce((a, b) => (a.px > b.px ? a : b));
    expect(max.px, max.where).toBeLessThan(LIMIT_PX);
  });

  it('stays within half a pixel on the globe and in the transition', () => {
    const worst: Worst[] = [];
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
          // The positions on the side of the sphere toward the camera
          const positions = [0.5, 10, 300, ON_SCREEN, 2 ** 14, EDGE_REACH]
            .flatMap((d) => positionsAround(camera, d))
            .filter((p) => angleBetween(p, camera.center) < 75);
          worst.push(worstOf(camera, transition, positions));
          worst.push(worstOf(camera, transition, positions, true));
        }
      }
    }
    const max = worst.reduce((a, b) => (a.px > b.px ? a : b));
    expect(max.px, max.where).toBeLessThan(LIMIT_PX);
  });

  it('keeps the error of a position relative to its offset (a few roundoffs)', () => {
    // The error over the distance from the center, in roundoffs of a 32-bit float: what bounds
    // an edge across the screen, whose ends are far
    let ratio = 0;
    for (const zoom of [4, 12, 20, 24]) {
      for (const lat of LATITUDES) {
        const camera: TestCamera = { center: [139.7, lat], zoom, width: WIDTH, height: HEIGHT };
        for (const d of [100, 10_000, EDGE_REACH]) {
          const w = worstOf(camera, 0, positionsAround(camera, d));
          ratio = Math.max(ratio, w.px / d / UNIT_ROUNDOFF);
        }
      }
    }
    expect(ratio).toBeLessThan(16);
  });
});
