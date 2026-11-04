// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for reading the ground back from the depth of the terrain MapLibre draws
 *
 * The depth is packed as MapLibre packs it (`packGroundDepth`, its `terrain_depth` shader), read
 * back as the shader of the rows reads it (`unpackGroundDepth`, and `groundAt` below, the
 * operations of `ground_at` in `GROUND_DEPTH_GLSL`, with the inverse of the projection held in
 * 32-bit floats), and compared with the ground where it is: the ray of the pixel met with it, in
 * float64. The camera is the one MapLibre makes (its near plane a fiftieth of the height).
 */

import { describe, expect, it } from 'vitest';
import {
  mercatorMatrix,
  mercatorOf,
  type TestCamera,
} from '../../../test-support/glsl-projection.js';
import { calculateOffsetUniforms } from '../../shaders/helpers.js';
import { metersToMercatorScale } from '../metrics.js';
import {
  GROUND_DEPTH_JUMP,
  groundDepthDigit,
  groundLiftOf,
  groundUnprojectOf,
  packGroundDepth,
  unpackGroundDepth,
} from './ground-depth.js';

const F32 = Math.fround;

/** A camera as MapLibre makes it, in CSS pixels */
function cameraOf(pitch: number, zoom = 15, width = 1280, height = 720): TestCamera {
  const d = (0.5 / Math.tan(0.6435011087932844 / 2)) * height;
  return {
    center: [138.72, 35.36],
    zoom,
    pitch,
    width,
    height,
    near: height / 50,
    far: d * 20,
  };
}

/** What the shader is given for a camera: the matrix, the center and the inverse */
function frameOf(camera: TestCamera) {
  const matrix = mercatorMatrix(camera);
  const uniforms = calculateOffsetUniforms(camera.center, { mainMatrix: matrix } as never);
  const unproject = new Float32Array(16);
  expect(groundUnprojectOf(matrix, uniforms.projectionCenter, unproject)).toBe(true);
  const exact = new Float64Array(16);
  groundUnprojectOf(matrix, uniforms.projectionCenter, exact);
  return { matrix, uniforms, unproject, exact, worldSize: 512 * 2 ** camera.zoom };
}

type Frame = ReturnType<typeof frameOf>;

/** The clip space of a Mercator offset from the center and an elevation (Mercator units) */
function clipOf(
  frame: Frame,
  dx: number,
  dy: number,
  dz: number,
): [number, number, number, number] {
  const m = frame.matrix;
  const c = frame.uniforms.projectionCenter;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    out[i] = (m[i] as number) * dx + (m[4 + i] as number) * dy + (m[8 + i] as number) * dz + c[i];
  }
  return out;
}

/** The ray of a point of the clip space over its w, as two Mercator offsets (float64) */
function rayOf(frame: Frame, x: number, y: number): [number[], number[]] {
  const at = (z: number): number[] => {
    const u = frame.exact;
    const h = [0, 1, 2, 3].map(
      (i) =>
        (u[i] as number) * x +
        (u[4 + i] as number) * y +
        (u[8 + i] as number) * z +
        (u[12 + i] as number),
    );
    return [0, 1, 2].map((i) => (h[i] as number) / (h[3] as number));
  };
  return [at(0.2), at(0.99)];
}

/** A plane of the ground: its elevation (Mercator units) at a Mercator offset from the center */
interface Plane {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

/** Where the ray of a point of the screen meets a plane of the ground (a Mercator offset) */
function meet(frame: Frame, plane: Plane, x: number, y: number): [number, number, number] {
  const [p0, p1] = rayOf(frame, x, y);
  const f = (p: number[]): number =>
    (p[2] as number) - (plane.a + plane.b * (p[0] as number) + plane.c * (p[1] as number));
  const t = f(p0) / (f(p0) - f(p1));
  return [0, 1, 2].map((i) => (p0[i] as number) + ((p1[i] as number) - (p0[i] as number)) * t) as [
    number,
    number,
    number,
  ];
}

/** The depth of a point of the clip space over its w, as a 32-bit float (MapLibre's v_depth) */
function depthOf(frame: Frame, p: readonly number[]): number {
  const clip = clipOf(frame, p[0] as number, p[1] as number, p[2] as number);
  return F32(clip[2] / clip[3]);
}

/**
 * A texture of the depth, a texel a CSS pixel, as MapLibre draws it (bottom row first): its texels
 * drawn as they are read
 */
interface DepthTexture {
  readonly width: number;
  readonly height: number;
  texel(i: number, j: number): readonly [number, number, number, number];
}

function drawDepth(
  frame: Frame,
  width: number,
  height: number,
  ground: (row: number) => Plane | null,
): DepthTexture {
  const drawn = new Map<number, [number, number, number, number]>();
  return {
    width,
    height,
    texel(i, j) {
      const key = j * width + i;
      let bytes = drawn.get(key);
      if (!bytes) {
        const plane = ground(j);
        const x = ((i + 0.5) / width) * 2 - 1;
        const y = ((j + 0.5) / height) * 2 - 1;
        bytes = plane
          ? packGroundDepth(depthOf(frame, meet(frame, plane, x, y)))
          : [255, 255, 255, 255];
        drawn.set(key, bytes);
      }
      return bytes;
    },
  };
}

/** The operations of `ground_at` (GROUND_DEPTH_GLSL), for a place of the screen in device px */
function groundAt(
  frame: Frame,
  texture: DepthTexture,
  viewport: readonly [number, number],
  fx: number,
  fy: number,
): { q: [number, number]; z: number } | null {
  const size = [texture.width, texture.height];
  const depthAt = (i: number, j: number): number => {
    const ci = Math.min(Math.max(i, 0), texture.width - 1);
    const cj = Math.min(Math.max(j, 0), texture.height - 1);
    const [r, g, b, a] = texture.texel(ci, cj);
    return unpackGroundDepth(r, g, b, a) ?? 2;
  };
  const u = frame.unproject;
  const inverseW = (x: number, y: number, z: number): number =>
    F32(
      F32(F32(u[3] as number) * x) +
        F32(F32(u[7] as number) * y) +
        F32(F32(u[11] as number) * z) +
        (u[15] as number),
    );
  const n01 = [fx / viewport[0], fy / viewport[1]];
  const t = [
    (n01[0] as number) * (size[0] as number) - 0.5,
    (n01[1] as number) * (size[1] as number) - 0.5,
  ];
  const base = [Math.floor(t[0] as number), Math.floor(t[1] as number)];
  const f = [(t[0] as number) - (base[0] as number), (t[1] as number) - (base[1] as number)];
  const [bx, by] = base as [number, number];
  const d = [depthAt(bx, by), depthAt(bx + 1, by), depthAt(bx, by + 1), depthAt(bx + 1, by + 1)];
  const nearest =
    (f[1] as number) < 0.5
      ? (f[0] as number) < 0.5
        ? d[0]
        : d[1]
      : (f[0] as number) < 0.5
        ? d[2]
        : d[3];
  if ((nearest as number) > 1.5) return null;
  const ndc = [(n01[0] as number) * 2 - 1, (n01[1] as number) * 2 - 1] as [number, number];
  const texel = [2 / (size[0] as number), 2 / (size[1] as number)] as [number, number];
  const c = [(bx + 0.5) * texel[0] - 1, (by + 0.5) * texel[1] - 1];
  const corners = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ];
  const iw = d.map((v, k) =>
    v > 1.5
      ? 0
      : inverseW(
          (c[0] as number) + (corners[k]![0] as number) * texel[0],
          (c[1] as number) + (corners[k]![1] as number) * texel[1],
          v,
        ),
  );
  const most = Math.max(...iw);
  const same = iw.map((v) => v * F32(1 + GROUND_DEPTH_JUMP) >= most);
  const [d00, d10, d01, d11] = d as [number, number, number, number];
  let z: number;
  if (same.every(Boolean)) {
    const fx0 = f[0] as number;
    const fy0 = f[1] as number;
    z = (d00 + (d10 - d00) * fx0) * (1 - fy0) + (d01 + (d11 - d01) * fx0) * fy0;
  } else {
    const k = iw.indexOf(most);
    const corner = corners[k] as [number, number];
    let gx = 0;
    let gy = 0;
    let nx = 0;
    let ny = 0;
    if (same[0] && same[1]) {
      gx += d10 - d00;
      nx++;
    }
    if (same[2] && same[3]) {
      gx += d11 - d01;
      nx++;
    }
    if (same[0] && same[2]) {
      gy += d01 - d00;
      ny++;
    }
    if (same[1] && same[3]) {
      gy += d11 - d10;
      ny++;
    }
    if (nx > 0) gx /= nx;
    if (ny > 0) gy /= ny;
    // The step from the texel on the other side (ground_outer_step)
    const own = [bx + corner[0], by + corner[1]] as const;
    const place = [
      (c[0] as number) + corner[0] * texel[0],
      (c[1] as number) + corner[1] * texel[1],
    ];
    const outer = (ax: number, ay: number): number => {
      const next = depthAt(own[0] + ax, own[1] + ay);
      if (next > 1.5) return 0;
      const other = inverseW(
        (place[0] as number) + ax * texel[0],
        (place[1] as number) + ay * texel[1],
        next,
      );
      if (Math.max(other, most) > Math.min(other, most) * F32(1 + GROUND_DEPTH_JUMP)) return 0;
      return next - (d[k] as number);
    };
    if (nx === 0) {
      const sx = corner[0] === 0 ? -1 : 1;
      gx = sx * outer(sx, 0);
    }
    if (ny === 0) {
      const sy = corner[1] === 0 ? -1 : 1;
      gy = sy * outer(0, sy);
    }
    z =
      (d[k] as number) + gx * ((f[0] as number) - corner[0]) + gy * ((f[1] as number) - corner[1]);
  }
  z = F32(z);
  const h = [0, 1, 2, 3].map((i) =>
    F32(
      F32(F32(u[i] as number) * ndc[0]) +
        F32(F32(u[4 + i] as number) * ndc[1]) +
        F32(F32(u[8 + i] as number) * z) +
        (u[12 + i] as number),
    ),
  );
  if ((h[3] as number) <= 0) return null;
  return {
    q: [F32((h[0] as number) / (h[3] as number)), F32((h[1] as number) / (h[3] as number))],
    z,
  };
}

describe('the depth MapLibre packs', () => {
  it('reads every byte back as the digit it was written for', () => {
    for (let digit = 0; digit < 256; digit++) {
      const byte = Math.round((digit / 256) * 255);
      const read = groundDepthDigit(byte);
      // 128 is written for 128 and 129 alike: read halfway
      expect(Math.abs(read - digit), `digit ${digit}`).toBeLessThanOrEqual(
        digit === 128 || digit === 129 ? 0.5 : 0,
      );
    }
  });

  it('reads a depth back to its 32-bit float, or within half a step of the second digit', () => {
    let exact = 0;
    const count = 20_000;
    for (let k = 0; k < count; k++) {
      // The depths of the ground: near 1 (the depth of a perspective grows to 1 far away)
      const depth = Math.min(F32(1 - 0.2 * ((k + 0.5) / count) ** 3), F32(1 - 2 ** -24));
      const [r, g, b, a] = packGroundDepth(depth);
      const read = unpackGroundDepth(r, g, b, a) as number;
      const error = Math.abs(read - depth);
      expect(error).toBeLessThanOrEqual(0.5 / 65_536 + 2 ** -24);
      if (error <= 2 ** -23) exact++;
    }
    // Only where the second digit is 128 or 129 (2 of 256) is it read halfway
    expect(exact / count).toBeGreaterThan(0.99);
  });

  it('takes white as no terrain, and writes no white for a depth below 1', () => {
    expect(unpackGroundDepth(255, 255, 255, 255)).toBeNull();
    for (const depth of [0, 0.5, 0.9999, F32(1 - 2 ** -24)]) {
      expect(packGroundDepth(depth)[3]).toBeLessThan(255);
    }
  });
});

describe('the ground read back from the depth', () => {
  for (const pitch of [0, 45, 70]) {
    it(`finds the ground where it is drawn, at a pitch of ${pitch}`, () => {
      const camera = cameraOf(pitch);
      const frame = frameOf(camera);
      const scale = metersToMercatorScale(camera.center[1]);
      // A slope of the ground, rising 300 m and 1 in 5 to the east
      const plane: Plane = { a: 300 * scale, b: 0, c: 0 };
      const sloped: Plane = { a: 300 * scale, b: 0.2, c: -0.1 };
      for (const ground of [plane, sloped]) {
        let worst = 0;
        let worstHalfway = 0;
        for (let j = 0; j <= 10; j++) {
          for (let i = 0; i <= 10; i++) {
            const x = (i / 10) * 1.9 - 0.95;
            const y = (j / 10) * 1.9 - 0.95;
            const at = meet(frame, ground, x, y);
            const depth = depthOf(frame, at);
            if (!(depth > -1 && depth < 1)) continue;
            const [r, g, b, a] = packGroundDepth(depth);
            const read = unpackGroundDepth(r, g, b, a) as number;
            const halfway = b === 128;
            const u = frame.unproject;
            const h = [0, 1, 2, 3].map((k) =>
              F32(
                F32(F32(u[k] as number) * F32(x)) +
                  F32(F32(u[4 + k] as number) * F32(y)) +
                  F32(F32(u[8 + k] as number) * F32(read)) +
                  (u[12 + k] as number),
              ),
            );
            const qx = (h[0] as number) / (h[3] as number);
            const qy = (h[1] as number) / (h[3] as number);
            // How far the ground read back is from the ground, in pixels of the screen at the
            // place: the step of the ground to the next CSS pixel there
            const next = meet(frame, ground, x + 2 / camera.width, y);
            const pixel = Math.hypot((next[0] as number) - at[0], (next[1] as number) - at[1]);
            const error = Math.hypot(qx - at[0], qy - at[1]) / pixel;
            if (halfway) worstHalfway = Math.max(worstHalfway, error);
            else worst = Math.max(worst, error);
          }
        }
        // Within a twentieth of a CSS pixel of the screen; where the second digit of the depth
        // is read halfway, the ground moves along the ray by up to a sixth of one
        expect(worst).toBeLessThan(0.05);
        expect(worstHalfway).toBeLessThan(1 / 6);
      }
    });
  }

  it('interpolates the depth on a plane to every device pixel of a CSS pixel', () => {
    const camera = cameraOf(60);
    const frame = frameOf(camera);
    const scale = metersToMercatorScale(camera.center[1]);
    const plane: Plane = { a: 300 * scale, b: 0.15, c: 0.05 };
    const texture = drawDepth(frame, camera.width, camera.height, () => plane);
    const viewport = [camera.width * 2, camera.height * 2] as const;
    let worst = 0;
    // Windows of the screen near the camera, at the center and far from the camera
    for (const [x0, y0] of [
      [600, 40],
      [1270, 700],
      [2000, 1380],
    ] as const) {
      for (let y = y0; y < y0 + 24; y++) {
        for (let x = x0; x < x0 + 24; x++) {
          const read = groundAt(frame, texture, viewport, x + 0.5, y + 0.5);
          expect(read).not.toBeNull();
          const ndcX = ((x + 0.5) / viewport[0]) * 2 - 1;
          const ndcY = ((y + 0.5) / viewport[1]) * 2 - 1;
          const at = meet(frame, plane, ndcX, ndcY);
          const next = meet(frame, plane, ndcX + 2 / viewport[0], ndcY);
          const pixel = Math.hypot((next[0] as number) - at[0], (next[1] as number) - at[1]);
          const q = (read as { q: [number, number] }).q;
          worst = Math.max(worst, Math.hypot(q[0] - at[0], q[1] - at[1]) / pixel);
        }
      }
    }
    // In device pixels, as the ground of each CSS pixel is read (most of it the depth read
    // halfway at its second digit)
    expect(worst).toBeLessThan(0.3);
  });

  it('takes the nearer surface across the edge of a ridge, and no ground where none is drawn', () => {
    const camera = cameraOf(60);
    const frame = frameOf(camera);
    const scale = metersToMercatorScale(camera.center[1]);
    // The ridge in front (high) up to row 400, the ground behind it (low) above, the sky over
    // row 420
    const ridge: Plane = { a: 600 * scale, b: 0, c: 0 };
    const behind: Plane = { a: 0, b: 0, c: 0 };
    const texture = drawDepth(frame, camera.width, camera.height, (row) =>
      row <= 400 ? ridge : row <= 420 ? behind : null,
    );
    const viewport = [camera.width * 2, camera.height * 2] as const;
    for (let y = 796; y < 846; y++) {
      for (let x = 1270; x < 1290; x++) {
        const read = groundAt(frame, texture, viewport, x + 0.5, y + 0.5);
        const t = ((y + 0.5) / viewport[1]) * camera.height - 0.5;
        if (Math.round(t) > 420) {
          // The nearest texel is of the sky
          expect(read, `${x}, ${y}`).toBeNull();
          continue;
        }
        expect(read, `${x}, ${y}`).not.toBeNull();
        const ndcX = ((x + 0.5) / viewport[0]) * 2 - 1;
        const ndcY = ((y + 0.5) / viewport[1]) * 2 - 1;
        // Between rows 400 and 401 the ridge is the nearer: its plane goes on
        const surface = t < 401 ? ridge : behind;
        const at = meet(frame, surface, ndcX, ndcY);
        const next = meet(frame, surface, ndcX + 2 / viewport[0], ndcY);
        const pixel = Math.hypot((next[0] as number) - at[0], (next[1] as number) - at[1]);
        const q = (read as { q: [number, number] }).q;
        expect(Math.hypot(q[0] - at[0], q[1] - at[1]) / pixel, `${x}, ${y}`).toBeLessThan(0.3);
      }
    }
  });
});

describe('groundLiftOf', () => {
  it('lifts the depth of the ground by the lift there, larger the further it is', () => {
    const camera = cameraOf(60);
    const frame = frameOf(camera);
    const scale = metersToMercatorScale(camera.center[1]);
    const lift = new Float32Array(4);
    const meters = 0.5;
    const centerW = frame.uniforms.projectionCenter[3];
    groundLiftOf(frame.matrix, scale, meters, centerW, lift);
    const [cx, cy] = mercatorOf(camera.center[0], camera.center[1]);
    expect(cx).toBeGreaterThan(0);
    expect(cy).toBeGreaterThan(0);
    for (const offset of [0, 200, -200]) {
      const p = [0, offset / frame.worldSize, 100 * scale];
      const clip = clipOf(frame, p[0] as number, p[1] as number, p[2] as number);
      const z = clip[2] / clip[3];
      const lifted = (z + (lift[2] as number)) / (1 + (lift[3] as number));
      // The position lifted by the lift at the center times its distance over that of the center
      const raised = clipOf(
        frame,
        p[0] as number,
        p[1] as number,
        (p[2] as number) + meters * (clip[3] / centerW) * scale,
      );
      expect(lifted).toBeLessThan(z);
      expect(lifted).toBeCloseTo(raised[2] / raised[3], 9);
    }
  });
});
