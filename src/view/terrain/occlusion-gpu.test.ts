// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The GLSL of the test whether the terrain hides a position, run on a real WebGL2 (ANGLE on
 * SwiftShader), held to the test on the CPU
 *
 * A vertex shader made of maplibre's prelude, `OFFSET_MODE_GLSL` and `TERRAIN_OCCLUSION_GLSL`
 * gives `terrain_occlusion_opacity` of each anchor back through transform feedback. The uniforms
 * are those `ProjectionUniformManager` and `TerrainOcclusionUniforms` write for the frame (recorded through a GL that keeps
 * what it is given, and written again on the page), and the DEM atlas is a texture of the same
 * encoding as the one the engine bakes. The CPU decides the same anchors with
 * `anchorGhostOpacity`, over a terrain whose elevations are given apart.
 *
 * The scene: a camera 4,500 m high south of a ridge of 2,000 m, looking north over it at the
 * anchors, with a second ridge of 2,000 m behind them.
 *
 * - When the CPU reads the same elevations as the atlas holds (the bilinear interpolation of its
 *   texels), the two give the same answer for every anchor, on Web Mercator and on the globe:
 *   only the arithmetic differs (float32 against float64)
 * - Without the terrain, and with the exaggeration 0 (the atlas and the ground flat), nothing is
 *   hidden on either
 * - Where they read the elevations from two places, they may differ: the counts are printed and
 *   bounded. Where the CPU reads the terrain the atlas is baked from, the anchors whose line of
 *   sight grazes the ground (none of 1,681 with an atlas as fine as the terrain mesh, 12 with one
 *   four times coarser); where the atlas does not reach, the GPU holds the value of its edge (293
 *   of 1,681 with the ridge behind the anchors out of it)
 */

import type { ProjectionData } from 'maplibre-gl';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  frameProjection,
  mercatorOf,
  type TestCamera,
} from '../../test-support/glsl-projection.js';
import {
  capturePreludes,
  launchWebGlBrowser,
  openMaplibrePage,
} from '../../test-support/webgl-page.js';
import { browserTimeout } from '../../test-utils.js';
import {
  calculateOffsetUniforms,
  getProjectionTransitionUniform,
  OFFSET_MODE_GLSL,
  type ShaderData,
  withSamplerPrecision,
} from '../shaders/helpers.js';
import { ProjectionUniformManager } from '../shaders/projection.js';
import { anchorElevationMeters, setAnchorFrame } from './anchor.js';
import { TerrainContext, type TerrainRenderState } from './context.js';
import type { TerrainLike } from './detect.js';
import { metersToMercatorScale } from './metrics.js';
import {
  anchorGhostOpacity,
  TERRAIN_GHOST_OPACITY,
  TERRAIN_OCCLUSION_GLSL,
  TerrainOcclusionUniforms,
} from './occlusion.js';
import { TERRAIN_ATLAS_TEXTURE_UNIT } from './state.js';

const CENTER: [number, number] = [138.73, 35.36];
const CAMERA_LNG_LAT: [number, number] = [138.73, 35.22];
const CAMERA_ALTITUDE_M = 4500;
const ZOOM = 12;
const SCALE = metersToMercatorScale(CENTER[1]);
/** The spacing of the nodes of the terrain mesh at the zoom (128 cells a tile) */
const STEP_GRID = 1 / 2 ** ZOOM / 128;

/** The terrain: a ridge between the camera and the anchors, one behind them, and some hills */
function terrainMeters(lng: number, lat: number): number {
  const near = 2000 * Math.exp(-(((lat - 35.29) / 0.012) ** 2));
  const far = 2000 * Math.exp(-(((lat - 35.47) / 0.015) ** 2));
  const hills = 120 * (1 + Math.sin(lng * 90) * Math.cos(lat * 70)) + 40 * Math.sin(lng * 700);
  return near + far + hills;
}

/** The range of a DEM atlas, in degrees */
interface AtlasRange {
  west: number;
  south: number;
  east: number;
  north: number;
}

const WHOLE: AtlasRange = { west: 138.55, south: 35.15, east: 138.91, north: 35.56 };
const ATLAS_SIZE = 384;

/** A DEM atlas: its texels (RGBA8, the elevation as 24-bit fixed point) and its rectangle */
interface Atlas {
  width: number;
  height: number;
  /** The elevation of each texel, as the shader decodes it */
  meters: Float64Array;
  rgba: number[];
  /** [x0, y0, 1/width, 1/height] in Mercator */
  rect: [number, number, number, number];
}

/** Bakes an atlas over a range from an elevation function, as the engine encodes it */
function bakeAtlas(
  range: AtlasRange,
  elevation: (lng: number, lat: number) => number,
  size = ATLAS_SIZE,
): Atlas {
  const [x0, y1] = mercatorOf(range.west, range.south);
  const [x1, y0] = mercatorOf(range.east, range.north);
  const width = size;
  const height = size;
  const meters = new Float64Array(width * height);
  const rgba: number[] = new Array(width * height * 4);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const mx = x0 + ((i + 0.5) / width) * (x1 - x0);
      const my = y0 + ((j + 0.5) / height) * (y1 - y0);
      const lng = mx * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;
      const n = Math.round((elevation(lng, lat) + 32768) * 256);
      const k = j * width + i;
      meters[k] = n / 256 - 32768;
      rgba[k * 4] = (n >> 16) & 255;
      rgba[k * 4 + 1] = (n >> 8) & 255;
      rgba[k * 4 + 2] = n & 255;
      rgba[k * 4 + 3] = 255;
    }
  }
  return { width, height, meters, rgba, rect: [x0, y0, 1 / (x1 - x0), 1 / (y1 - y0)] };
}

/** The elevation the atlas gives at a position: the bilinear interpolation of `dem_elevation_meters` */
function atlasMeters(atlas: Atlas, lng: number, lat: number): number {
  const [mx, my] = mercatorOf(lng, lat);
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  const u = clamp((mx - atlas.rect[0]) * atlas.rect[2], 0, 1);
  const v = clamp((my - atlas.rect[1]) * atlas.rect[3], 0, 1);
  const cx = u * atlas.width - 0.5;
  const cy = v * atlas.height - 0.5;
  const fx = cx - Math.floor(cx);
  const fy = cy - Math.floor(cy);
  const ix = Math.floor(cx);
  const iy = Math.floor(cy);
  const at = (x: number, y: number): number =>
    atlas.meters[
      clamp(y, 0, atlas.height - 1) * atlas.width + clamp(x, 0, atlas.width - 1)
    ] as number;
  const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * fx;
  const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * fx;
  return top + (bottom - top) * fy;
}

/** The anchors: a grid north of the camera, over both ridges */
function anchors(): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let j = 0; j <= 40; j++) {
    for (let i = 0; i <= 40; i++) {
      out.push([138.62 + (0.22 * i) / 40, 35.25 + (0.27 * j) / 40]);
    }
  }
  return out;
}

/** The camera of the view (looking north over the ridge) */
function testCamera(): TestCamera {
  return { center: CENTER, zoom: ZOOM, pitch: 70, bearing: 0, width: 1024, height: 768 };
}

/** The projection data maplibre gives a custom layer for the camera and a transition */
function projectionDataOf(transition: number): ProjectionData {
  const projection = frameProjection(testCamera(), transition);
  return {
    mainMatrix: projection.mainMatrix,
    fallbackMatrix: projection.fallbackMatrix,
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [...projection.clippingPlane],
    projectionTransition: projection.projectionTransition,
  } as unknown as ProjectionData;
}

/** A scene: the atlas the GPU reads, and the elevations the CPU reads */
interface Scene {
  atlas: Atlas;
  /** The elevations of the CPU (exaggeration included) */
  elevation: (lng: number, lat: number) => number;
  /** Whether the terrain is on */
  terrain: boolean;
}

/** The terrain state of an instance for a scene, as the engine sets it for a frame */
function contextOf(scene: Scene, projection: ProjectionData): TerrainContext {
  const context = new TerrainContext();
  if (!scene.terrain) return context;
  const state: TerrainRenderState = {
    active: true,
    atlasTexture: null,
    atlasRect: scene.atlas.rect,
    atlasSize: [scene.atlas.width, scene.atlas.height],
    elevationScale: SCALE,
    liftMeters: 10,
    stepMeters: 70,
    stepGrid: STEP_GRID,
    tessellationRegion: null,
    tessellationTiling: null,
    generation: 1,
  };
  context.renderState = state;
  const terrain = {
    getTerrainData: () => null,
    getElevationForLngLatZoom: (lngLat: { lng: number; lat: number }) =>
      scene.elevation(lngLat.lng, lngLat.lat),
  } as unknown as TerrainLike;
  const [cx, cy] = mercatorOf(CAMERA_LNG_LAT[0], CAMERA_LNG_LAT[1]);
  setAnchorFrame(context, {
    terrain,
    zoom: ZOOM,
    elevationScale: SCALE,
    projection,
    offsetUniforms: calculateOffsetUniforms(CENTER, projection),
    width: 1024,
    height: 768,
    cameraMercator: [cx, cy, CAMERA_ALTITUDE_M * SCALE],
  });
  return context;
}

/** A uniform as the manager writes it: the name, the method of GL and its arguments */
interface UniformWrite {
  name: string;
  method: string;
  args: unknown[];
}

/** The uniforms of the projection and of the test for a frame, through a GL that records them */
function recordUniforms(projection: ProjectionData, context: TerrainContext): UniformWrite[] {
  const writes: UniformWrite[] = [];
  const gl = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'getUniformLocation') {
          return (_program: unknown, name: string) => ({ name });
        }
        if (typeof prop === 'string' && prop.startsWith('uniform')) {
          return (location: { name: string } | null, ...args: unknown[]) => {
            if (!location) return;
            writes.push({
              name: location.name,
              method: prop,
              args: args.map((a) =>
                ArrayBuffer.isView(a) || Array.isArray(a) ? [...(a as number[])] : a,
              ),
            });
          };
        }
        return () => undefined;
      },
    },
  ) as unknown as WebGL2RenderingContext;
  const manager = new ProjectionUniformManager(gl).useTerrainState(context);
  manager.getLocations({} as WebGLProgram);
  const center = calculateOffsetUniforms(CENTER, projection);
  manager.setUniforms(projection, center);
  new TerrainOcclusionUniforms(gl, {} as WebGLProgram).writeState(context, center);
  return writes;
}

/** The vertex shader that gives the opacity of each anchor back */
function vertexSource(prelude: ShaderData): string {
  return withSamplerPrecision(`#version 300 es
${prelude.vertexShaderPrelude}
${prelude.define}
${getProjectionTransitionUniform(prelude.vertexShaderPrelude)}${OFFSET_MODE_GLSL}${TERRAIN_OCCLUSION_GLSL}
in vec2 a_offset;
in float a_elevation;
out float v_opacity;
void main() {
    v_opacity = terrain_occlusion_opacity(a_offset, a_elevation);
    gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
    gl_PointSize = 1.0;
}`);
}

/** Runs the shader for every anchor on the page's WebGL2 and returns the opacities */
async function opacitiesOnPage(
  page: Page,
  input: {
    source: string;
    uniforms: UniformWrite[];
    atlas: { width: number; height: number; rgba: number[] };
    unit: number;
    offsets: number[];
    elevations: number[];
  },
): Promise<number[]> {
  return page.evaluate((input) => {
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
    gl.attachShader(program, shader(gl.VERTEX_SHADER, input.source));
    gl.attachShader(
      program,
      shader(
        gl.FRAGMENT_SHADER,
        '#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main() { o = vec4(1.0); }',
      ),
    );
    gl.transformFeedbackVaryings(program, ['v_opacity'], gl.SEPARATE_ATTRIBS);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? 'link');
    }
    gl.useProgram(program);
    for (const write of input.uniforms) {
      const at = gl.getUniformLocation(program, write.name);
      if (!at) continue;
      const call = (gl as unknown as Record<string, (...a: unknown[]) => void>)[write.method];
      call?.call(gl, at, ...write.args);
    }
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + input.unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      input.atlas.width,
      input.atlas.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(input.atlas.rgba),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const count = input.elevations.length;
    const bind = (name: string, data: number[], size: number): void => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    };
    bind('a_offset', input.offsets, 2);
    bind('a_elevation', input.elevations, 1);
    const output = gl.createBuffer();
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, output);
    gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, count * 4, gl.STREAM_READ);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, output);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.endTransformFeedback();
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    const result = new Float32Array(count);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, output);
    gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, result);
    return [...result];
  }, input);
}

/** What the two versions decide for the anchors of a scene */
interface Decisions {
  cpu: number[];
  gpu: number[];
  /** The anchors the two decide differently */
  differ: number;
  /** The anchors the CPU hides */
  hidden: number;
}

describe('the GLSL of the test whether the terrain hides a position', () => {
  let browser: Browser | null = null;
  let page: Page;
  let preludes: ShaderData[] = [];

  beforeAll(async () => {
    browser = await launchWebGlBrowser();
    page = await openMaplibrePage(browser);
    preludes = await capturePreludes(page);
  }, browserTimeout(60_000));

  afterAll(async () => {
    await browser?.close();
  });

  /** Decides the anchors of a scene on the CPU and on the GPU */
  async function decide(scene: Scene, variant: string, transition: number): Promise<Decisions> {
    const prelude = preludes.find((p) => p.variantName === variant);
    if (!prelude) throw new Error(`no ${variant} prelude`);
    const projection = projectionDataOf(transition);
    const context = contextOf(scene, projection);
    const list = anchors();
    const cpu = list.map(([lng, lat]) => anchorGhostOpacity(context, lng, lat));
    const center = [Math.fround(CENTER[0]), Math.fround(CENTER[1])] as const;
    const offsets = list.flatMap(([lng, lat]) => [
      Math.fround(lng - center[0]),
      Math.fround(lat - center[1]),
    ]);
    const elevations = list.map(([lng, lat]) => anchorElevationMeters(context, lng, lat));
    const gpu = await opacitiesOnPage(page, {
      source: vertexSource(prelude),
      uniforms: recordUniforms(projection, context),
      atlas: { width: scene.atlas.width, height: scene.atlas.height, rgba: scene.atlas.rgba },
      unit: TERRAIN_ATLAS_TEXTURE_UNIT,
      offsets,
      elevations,
    });
    let differ = 0;
    let hidden = 0;
    cpu.forEach((value, i) => {
      if (Math.abs(value - (gpu[i] as number)) > 1e-6) differ++;
      if (value < 1) hidden++;
    });
    return { cpu, gpu, differ, hidden };
  }

  const atlas = bakeAtlas(WHOLE, terrainMeters);
  const sameSource: Scene = {
    atlas,
    elevation: (lng, lat) => atlasMeters(atlas, lng, lat),
    terrain: true,
  };

  it.each([
    ['Web Mercator', 'mercator', 0],
    ['the globe', 'globe', 1],
  ] as const)(
    'gives the answer of the CPU for every anchor on %s, when both read the same elevations',
    async (_name, variant, transition) => {
      const { gpu, differ, hidden } = await decide(sameSource, variant, transition);
      const count = anchors().length;
      console.log(
        `[occlusion ${variant}] ${count} anchors, ${hidden} hidden on the CPU, ${differ} decided differently`,
      );
      // Both ridges hide a good share of the anchors, and leave a good share in view
      expect(hidden).toBeGreaterThan(count * 0.2);
      expect(hidden).toBeLessThan(count * 0.8);
      expect(new Set(gpu)).toEqual(new Set([1, Math.fround(TERRAIN_GHOST_OPACITY)]));
      expect(differ).toBe(0);
    },
    browserTimeout(30_000),
  );

  it('hides an anchor behind the ridge in front of it, and not one with a ridge behind it', async () => {
    const { cpu, gpu } = await decide(sameSource, 'mercator', 0);
    const list = anchors();
    const indexOf = (lng: number, lat: number): number =>
      list.findIndex(([x, y]) => Math.abs(x - lng) < 1e-9 && Math.abs(y - lat) < 1e-9);
    // Just past the ridge in front (35.29), low on its north side
    const behind = indexOf(138.73, 35.25 + (0.27 * 7) / 40);
    // Between the ridges, high enough to be seen over the first, with the second behind it
    const between = indexOf(138.73, 35.25 + (0.27 * 27) / 40);
    expect(behind).toBeGreaterThanOrEqual(0);
    expect(between).toBeGreaterThanOrEqual(0);
    expect(cpu[behind]).toBe(TERRAIN_GHOST_OPACITY);
    expect(gpu[behind]).toBe(Math.fround(TERRAIN_GHOST_OPACITY));
    expect(cpu[between]).toBe(1);
    expect(gpu[between]).toBe(1);
  });

  it('hides nothing without the terrain', async () => {
    const { cpu, gpu } = await decide({ ...sameSource, terrain: false }, 'mercator', 0);
    expect(new Set(cpu)).toEqual(new Set([1]));
    expect(new Set(gpu)).toEqual(new Set([1]));
  });

  it('hides nothing with the exaggeration 0 (the ground flat on both)', async () => {
    const flat = bakeAtlas(WHOLE, () => 0);
    const { cpu, gpu } = await decide(
      { atlas: flat, elevation: () => 0, terrain: true },
      'mercator',
      0,
    );
    expect(new Set(cpu)).toEqual(new Set([1]));
    expect(new Set(gpu)).toEqual(new Set([1]));
  });

  it.each([
    // About 100 m a texel, as fine as the nodes of the terrain mesh (about 76 m): no anchor of
    // the scene differs
    [ATLAS_SIZE, 0.005],
    // About 400 m a texel, coarser than the hills: 12 of the 1,681 anchors differ
    [96, 0.05],
  ])(
    'differs from the CPU only where the line of sight grazes the ground, when the CPU reads the terrain the atlas of %i texels a side samples',
    async (size, bound) => {
      const { differ, hidden } = await decide(
        { atlas: bakeAtlas(WHOLE, terrainMeters, size), elevation: terrainMeters, terrain: true },
        'mercator',
        0,
      );
      const count = anchors().length;
      console.log(
        `[occlusion, the terrain on the CPU, an atlas of ${size} texels] ${count} anchors, ${hidden} hidden on the CPU, ${differ} decided differently (${((differ / count) * 100).toFixed(2)}%)`,
      );
      expect(differ).toBeLessThan(count * bound);
    },
    browserTimeout(30_000),
  );

  it('holds the edge of the atlas where it does not reach', async () => {
    // An atlas that stops short of the ridge behind the anchors
    const short = bakeAtlas({ ...WHOLE, north: 35.42 }, terrainMeters);
    const { differ, hidden } = await decide(
      { atlas: short, elevation: (lng, lat) => atlasMeters(atlas, lng, lat), terrain: true },
      'mercator',
      0,
    );
    const count = anchors().length;
    console.log(
      `[occlusion, out of the atlas] ${count} anchors, ${hidden} hidden on the CPU, ${differ} decided differently (${((differ / count) * 100).toFixed(2)}%)`,
    );
    expect(differ).toBeGreaterThan(0);
    expect(differ).toBeLessThan(count * 0.25);
  });
});
