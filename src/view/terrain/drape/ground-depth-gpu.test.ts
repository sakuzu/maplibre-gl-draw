// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The GLSL that reads the ground back from the depth of the terrain, run on a real WebGL2 (ANGLE
 * on SwiftShader) and held to float64
 *
 * The depth of a ground is drawn as MapLibre draws it (its `terrain_depth` shader packs the depth
 * of `projectTileFor3D` into the bytes of an RGBA8 texel, a texel a CSS pixel), in the windows of
 * the screen read (white elsewhere), and the DEM atlas holds the same ground. A vertex shader
 * reads the ground of places of the screen with `ground_at` (`GROUND_DEPTH_GLSL`) and transform
 * feedback gives it back. The reference is where the ray of the place meets the ground, in float64
 * (`test-support/ground-depth-scene.ts`), and a place is held to it in device pixels (the step of
 * the ground to the next pixel there).
 *
 * The scenes, on the flat map (on the globe the ground is not read back): pitches 0, 45 and 70,
 * at device pixel ratios 1 and 2, with and without the DEM atlas (without it a depth whose second
 * digit is read halfway is not picked); the edge of a ridge in front of the ground behind it, and
 * the sky; the depth of the ground lifted.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frameProjection, type TestCamera } from '../../../test-support/glsl-projection.js';
import {
  type GroundScene,
  groundClipOf,
  groundMeet,
} from '../../../test-support/ground-depth-scene.js';
import { launchWebGlBrowser } from '../../../test-support/webgl-page.js';
import { browserTimeout } from '../../../test-utils.js';
import {
  calculateOffsetUniforms,
  DEM_SAMPLE_GLSL,
  withSamplerPrecision,
} from '../../shaders/helpers.js';
import { metersToMercatorScale } from '../metrics.js';
import { GROUND_DEPTH_GLSL, groundProjectionOf, packGroundDepth } from './ground-depth.js';

const WIDTH = 1280;
const HEIGHT = 720;

/** The vertex shader that reads the ground of places of the screen */
function sourceOf(): string {
  return withSamplerPrecision(`#version 300 es
precision highp float;
uniform vec2 u_viewport;
${DEM_SAMPLE_GLSL}
${GROUND_DEPTH_GLSL}
in vec2 a_frag;
out vec4 v_ground;
void main() {
    vec2 q;
    float depth;
    bool seen = ground_at(a_frag, q, depth);
    v_ground = vec4(q, depth, seen ? 1.0 : 0.0);
    gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
    gl_PointSize = 1.0;
}`);
}

/** A uniform: its name, the method of GL and its arguments */
interface Uniform {
  name: string;
  method: string;
  args: unknown[];
}

/** What a run on the page reads */
interface Run {
  source: string;
  depth: { width: number; height: number; bytes: number[] };
  atlas: { width: number; height: number; bytes: number[] } | null;
  uniforms: Uniform[];
  frags: number[];
}

/** Reads the ground of places of the screen on the page's WebGL2 */
async function readOnPage(page: Page, run: Run): Promise<number[]> {
  return page.evaluate((run) => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) throw new Error('WebGL2 is not available in the browser');
    const shader = (type: number, text: string): WebGLShader => {
      const s = gl.createShader(type) as WebGLShader;
      gl.shaderSource(s, text);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(s) ?? 'compile');
      }
      return s;
    };
    const program = gl.createProgram() as WebGLProgram;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, run.source));
    gl.attachShader(
      program,
      shader(
        gl.FRAGMENT_SHADER,
        '#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main() { o = vec4(1.0); }',
      ),
    );
    gl.transformFeedbackVaryings(program, ['v_ground'], gl.SEPARATE_ATTRIBS);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? 'link');
    }
    gl.useProgram(program);
    const texture = (unit: number, image: { width: number; height: number; bytes: number[] }) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        image.width,
        image.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array(image.bytes),
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    };
    texture(0, run.depth);
    texture(1, run.atlas ?? { width: 1, height: 1, bytes: [0, 0, 0, 255] });
    gl.uniform1i(gl.getUniformLocation(program, 'u_ground_depth'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_dem_atlas'), 1);
    for (const u of run.uniforms) {
      const at = gl.getUniformLocation(program, u.name);
      if (!at) continue;
      const call = (gl as unknown as Record<string, (...a: unknown[]) => void>)[u.method];
      call?.call(gl, at, ...u.args);
    }
    const count = run.frags.length / 2;
    const input = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, input);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(run.frags), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, 'a_frag');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    const output = gl.createBuffer();
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, output);
    gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, count * 16, gl.STREAM_READ);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, output);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.endTransformFeedback();
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    const out = new Float32Array(count * 4);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, output);
    gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, out);
    return [...out];
  }, run);
}

/** A frame of a camera on the flat map, and the lift of the ground at its center */
function sceneOf(camera: TestCamera, liftMeters = 0): GroundScene {
  const projection = frameProjection(
    { ...camera, near: camera.height / 50, far: camera.height * 30 },
    0,
  );
  const uniforms = calculateOffsetUniforms(camera.center, {
    ...projection,
    clippingPlane: [...projection.clippingPlane],
  } as never);
  const scale = metersToMercatorScale(uniforms.centerLngLat[1]);
  const read = groundProjectionOf(
    projection.mainMatrix,
    uniforms.centerMercator,
    scale,
    liftMeters,
  );
  if (!read) throw new Error('no inverse');
  return { projection, uniforms, scale, read };
}

/** The ground of a scene: its elevation (meters) at a Mercator offset, by the row of a texel */
type Ground = (dx: number, dy: number, row: number) => number | null;

/** A window of the screen read: its corner and its size (device pixels) */
type Window = readonly [number, number, number];

/** The uniforms of the reading of a scene */
function uniformsOf(scene: GroundScene, viewport: readonly [number, number], atlas: Atlas | null) {
  const r = scene.read;
  const f = (a: ArrayLike<number>) => Array.from(a, (v) => Math.fround(v));
  return [
    { name: 'u_viewport', method: 'uniform2f', args: [viewport[0], viewport[1]] },
    { name: 'u_ground_unproject', method: 'uniformMatrix4fv', args: [false, f(r.unproject)] },
    { name: 'u_ground_lift', method: 'uniform1f', args: [r.lift] },
    { name: 'u_elevation_params', method: 'uniform2f', args: [scene.scale, 0] },
    { name: 'u_terrain_on', method: 'uniform1f', args: [1] },
    { name: 'u_dem_atlas_rect', method: 'uniform4fv', args: [f(atlas?.rect ?? [0, 0, 1, 1])] },
    {
      name: 'u_dem_atlas_size',
      method: 'uniform2f',
      args: atlas ? [atlas.width, atlas.height] : [0, 0],
    },
  ];
}

/** A DEM atlas of a ground over a Mercator box (offsets from the center) */
interface Atlas {
  width: number;
  height: number;
  bytes: number[];
  rect: [number, number, number, number];
}

function atlasOf(ground: Ground, box: [number, number, number, number]): Atlas {
  const width = 256;
  const height = 256;
  const bytes: number[] = [];
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const dx = box[0] + ((i + 0.5) / width) * (box[2] - box[0]);
      const dy = box[1] + ((j + 0.5) / height) * (box[3] - box[1]);
      const e = ground(dx, dy, -1) ?? 0;
      const v = Math.min(Math.max((e + 32768) / 65536, 0), 0.99999994);
      const n = Math.floor(v * 16_777_216);
      bytes.push(n >> 16, (n >> 8) & 255, n & 255, 255);
    }
  }
  return {
    width,
    height,
    bytes,
    rect: [box[0], box[1], 1 / (box[2] - box[0]), 1 / (box[3] - box[1])],
  };
}

/** The result of reading the windows of a scene */
interface Reading {
  /** The largest distance from the reference, in device pixels */
  worst: number;
  /** The places read: where none was expected and none read, and their number */
  missing: number;
  extra: number;
  count: number;
  /** The texels whose second digit is 128 (read halfway or picked) */
  halfway: number;
  /**
   * With the lift: the largest distance of the depth taken from that of the ground lifted, as a
   * share of the step of the lift in the depth
   */
  depthWorst: number;
}

async function readScene(
  page: Page,
  scene: GroundScene,
  ratio: number,
  ground: Ground,
  windows: readonly Window[],
  options: { atlas?: boolean; lifted?: boolean; step?: number } = {},
): Promise<Reading> {
  const css = [WIDTH, HEIGHT] as const;
  const viewport = [WIDTH * ratio, HEIGHT * ratio] as const;
  const bytes = new Array<number>(css[0] * css[1] * 4).fill(255);
  let halfway = 0;
  let box: [number, number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  // The texels of the windows and around them
  for (const [x0, y0, size] of windows) {
    const i0 = Math.floor(x0 / ratio) - 3;
    const j0 = Math.floor(y0 / ratio) - 3;
    const n = Math.ceil(size / ratio) + 6;
    for (let j = j0; j < j0 + n; j++) {
      for (let i = i0; i < i0 + n; i++) {
        if (i < 0 || j < 0 || i >= css[0] || j >= css[1]) continue;
        const x = ((i + 0.5) / css[0]) * 2 - 1;
        const y = ((j + 0.5) / css[1]) * 2 - 1;
        const meet = groundMeet(scene, x, y, (dx, dy) => ground(dx, dy, j) ?? -1e9);
        if (!meet || ground(meet.u[0] as number, meet.u[1] as number, j) === null) continue;
        const packed = packGroundDepth(Math.fround(meet.z));
        if (packed[2] === 128) halfway++;
        bytes.splice((j * css[0] + i) * 4, 4, ...packed);
        box = [
          Math.min(box[0], meet.u[0] as number),
          Math.min(box[1], meet.u[1] as number),
          Math.max(box[2], meet.u[0] as number),
          Math.max(box[3], meet.u[1] as number),
        ];
      }
    }
  }
  const pad = Math.max(box[2] - box[0], box[3] - box[1]) * 0.1 + 1e-9;
  const atlas =
    options.atlas === false
      ? null
      : atlasOf(ground, [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad]);
  const step = options.step ?? 1;
  const frags: number[] = [];
  for (const [x0, y0, size] of windows) {
    for (let y = y0; y < y0 + size; y += step) {
      for (let x = x0; x < x0 + size; x += step) frags.push(x + 0.5, y + 0.5);
    }
  }
  const out = await readOnPage(page, {
    source: sourceOf(),
    depth: { width: css[0], height: css[1], bytes },
    atlas,
    uniforms: uniformsOf(scene, viewport, atlas),
    frags,
  });
  const reading: Reading = { worst: 0, missing: 0, extra: 0, count: 0, halfway, depthWorst: 0 };
  for (let k = 0; k < frags.length / 2; k++) {
    const fx = frags[k * 2] as number;
    const fy = frags[k * 2 + 1] as number;
    const x = (fx / viewport[0]) * 2 - 1;
    const y = (fy / viewport[1]) * 2 - 1;
    // The ground of the scene by rows: whether there is one is that of the texel nearest to the
    // place, and between two rows of texels of two surfaces it is that of the lower row (the
    // ridge in front: the nearer to the camera)
    const t = (fy / viewport[1]) * css[1] - 0.5;
    const nearestRow = Math.round(t);
    const row = Math.floor(t);
    const elevation = (dx: number, dy: number): number =>
      ground(dx, dy, row) ?? ground(dx, dy, nearestRow) ?? -1e9;
    const meet = groundMeet(scene, x, y, elevation);
    const seen = (out[k * 4 + 3] as number) > 0.5;
    const expected =
      meet !== null && ground(meet.u[0] as number, meet.u[1] as number, nearestRow) !== null;
    if (!expected) {
      if (seen) reading.extra++;
      continue;
    }
    if (!seen) {
      reading.missing++;
      continue;
    }
    if (options.lifted) {
      // The depth of the ground lifted by the lift at the center times its distance over that of
      // the center
      const lifted = groundMeet(scene, x, y, (dx, dy) => {
        const e = elevation(dx, dy);
        return e + scene.read.lift * groundClipOf(scene, [dx, dy, e])[3];
      });
      if (lifted) {
        const share = Math.abs((out[k * 4 + 2] as number) - lifted.z) / Math.abs(meet.z - lifted.z);
        reading.depthWorst = Math.max(reading.depthWorst, share);
      }
    }
    const next = groundMeet(scene, x + 2 / viewport[0], y, elevation);
    if (!next) continue;
    const pixel = Math.hypot(
      (next.u[0] as number) - (meet.u[0] as number),
      (next.u[1] as number) - (meet.u[1] as number),
    );
    const error = Math.hypot(
      (out[k * 4] as number) - (meet.u[0] as number),
      (out[k * 4 + 1] as number) - (meet.u[1] as number),
    );
    reading.worst = Math.max(reading.worst, error / pixel);
    reading.count++;
  }
  return reading;
}

const CENTER: [number, number] = [138.72, 35.36];

/** Windows of the screen: near the camera, at the center and far from it (device pixels) */
function windowsOf(ratio: number): Window[] {
  return [
    [600 * ratio, 40 * ratio, 16 * ratio],
    [632 * ratio, 352 * ratio, 16 * ratio],
    [200 * ratio, 640 * ratio, 16 * ratio],
  ];
}

describe('the GLSL that reads the ground back from the depth, on a real WebGL2', () => {
  let browser: Browser | null = null;
  let page: Page;

  beforeAll(async () => {
    browser = await launchWebGlBrowser();
    page = await browser.newPage();
  }, browserTimeout(60_000));

  afterAll(async () => {
    await browser?.close();
  });

  for (const pitch of [0, 45, 70]) {
    it(`reads the ground of the flat map at a pitch of ${pitch}`, {
      timeout: browserTimeout(60_000),
    }, async () => {
      for (const ratio of [1, 2]) {
        const scene = sceneOf({ center: CENTER, zoom: 15, pitch, width: WIDTH, height: HEIGHT });
        const k = scene.scale;
        // A slope rising 1 in 5 to the east and 1 in 10 to the north, 300 m at the center
        const ground: Ground = (dx, dy) => 300 + (0.2 * dx) / k - (0.1 * dy) / k;
        const read = await readScene(page, scene, ratio, ground, windowsOf(ratio));
        expect(read.missing + read.extra, `ratio ${ratio}`).toBe(0);
        expect(read.count).toBeGreaterThan(0);
        // Within a twentieth of a device pixel, where the second digit is read halfway too (the
        // DEM atlas picks it)
        expect(read.worst, `ratio ${ratio}`).toBeLessThan(0.05);
      }
    });
  }

  it('picks the second digit read halfway by the DEM atlas, and reads it halfway without it', {
    timeout: browserTimeout(60_000),
  }, async () => {
    // Near the camera at a high pitch the depth steps little from a pixel to the next: a digit
    // read halfway moves the ground the most there
    const scene = sceneOf({ center: CENTER, zoom: 14.5, pitch: 62, width: WIDTH, height: HEIGHT });
    const k = scene.scale;
    const ground: Ground = (dx, dy) => 400 + (0.1 * dx) / k + (0.15 * dy) / k;
    const windows: Window[] = [];
    for (let y = 0; y < 300; y += 24) windows.push([300, y, 12]);
    const picked = await readScene(page, scene, 1, ground, windows);
    const halfway = await readScene(page, scene, 1, ground, windows, { atlas: false });
    expect(picked.halfway).toBeGreaterThan(0);
    expect(picked.worst).toBeLessThan(0.05);
    // Read halfway, the ground moves by more than that, and within the half of a pixel
    expect(halfway.worst).toBeGreaterThan(picked.worst);
    expect(halfway.worst).toBeLessThan(1);
  });

  it('takes the nearer surface across the edge of a ridge, and no ground under the sky', {
    timeout: browserTimeout(60_000),
  }, async () => {
    const scene = sceneOf({ center: CENTER, zoom: 15, pitch: 60, width: WIDTH, height: HEIGHT });
    // The ridge in front (high) up to row 400 of the texels, the ground behind it above, the sky
    // over row 420
    const ground: Ground = (_dx, _dy, row) =>
      row < 0 ? 0 : row <= 400 ? 600 : row <= 420 ? 0 : null;
    const read = await readScene(page, scene, 2, ground, [[1270, 796, 50]], { atlas: false });
    expect(read.count).toBeGreaterThan(0);
    expect(read.missing + read.extra).toBe(0);
    expect(read.worst).toBeLessThan(0.3);
  });

  it('takes the depth of the ground lifted, more the further it is, at the place of the ground', {
    timeout: browserTimeout(60_000),
  }, async () => {
    // The lift of the drape (1 / 2,500 of the tile drawn there)
    const scene = sceneOf({ center: CENTER, zoom: 15, pitch: 55, width: WIDTH, height: HEIGHT }, 1);
    const ground: Ground = () => 500;
    const read = await readScene(page, scene, 1, ground, windowsOf(1), { lifted: true });
    expect(read.missing + read.extra).toBe(0);
    // The place is the ground itself, where maplibre projects it
    expect(read.worst).toBeLessThan(0.05);
    // The depth is that of the ground lifted, within a tenth of the step of the lift
    expect(read.depthWorst).toBeGreaterThan(0);
    expect(read.depthWorst).toBeLessThan(0.1);
  });
});
