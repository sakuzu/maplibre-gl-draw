// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The GLSL of the projection run on a real WebGL2 (ANGLE on SwiftShader), held to float64
 *
 * A vertex shader made of maplibre's prelude and `OFFSET_MODE_GLSL` projects offsets from the
 * center with `project_position_to_clipspace_from_offset`, and transform feedback reads back the
 * clip space it gives. The uniforms are those `ProjectionUniformManager` writes for the frame
 * (recorded through a GL that keeps what it is given, and written again on the page). The
 * reference is the projection of the same position computed in float64 with the matrices maplibre
 * builds (`test-support/glsl-projection.ts`).
 *
 * The positions lie 1e-4 to 60 degrees from centers at latitudes 0, 35.68, 60 and 80, on Web
 * Mercator, on the globe and in the middle of the transition, each seen at the zoom that puts it
 * 500 px from the center: what a vertex on the screen is. They land within 0.01 px of the
 * reference. The bound of the specification at the limit is held by
 * `projection-precision.test.ts`; this test holds the GLSL the GPU runs.
 */

import type { ProjectionData } from 'maplibre-gl';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  frameProjection,
  mercatorOf,
  referenceClip,
  screenOf,
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
} from './helpers.js';
import { ProjectionUniformManager } from './projection.js';

const WIDTH = 1920;
const HEIGHT = 1080;
/** How far from the center a position is seen (px) */
const DISTANCE_PX = 500;
const LIMIT_PX = 0.01;

/** A uniform as the manager writes it: the name, the method of GL and its arguments */
interface UniformWrite {
  name: string;
  method: string;
  args: unknown[];
}

/** The uniforms `ProjectionUniformManager` writes for a frame, through a GL that records them */
function recordUniforms(projectionData: ProjectionData, center: [number, number]): UniformWrite[] {
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
  const manager = new ProjectionUniformManager(gl);
  manager.getLocations({} as WebGLProgram);
  manager.setUniforms(projectionData, calculateOffsetUniforms(center, projectionData));
  return writes;
}

/** The vertex shader that projects offsets and gives the clip space back */
function vertexSource(prelude: ShaderData): string {
  return withSamplerPrecision(`#version 300 es
${prelude.vertexShaderPrelude}
${prelude.define}
${getProjectionTransitionUniform(prelude.vertexShaderPrelude)}${OFFSET_MODE_GLSL}
in vec2 a_offset;
out vec4 v_clip;
void main() {
    v_clip = project_position_to_clipspace_from_offset(a_offset, u_projection_matrix);
    gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
    gl_PointSize = 1.0;
}`);
}

/** One position to project: the uniforms of its frame and its offset from the center */
interface Case {
  uniforms: UniformWrite[];
  offset: [number, number];
}

/** Projects the positions of each case on the page's WebGL2 and returns their clip space */
async function projectOnPage(page: Page, source: string, cases: Case[]): Promise<number[][]> {
  return page.evaluate(
    ({ source, cases }) => {
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
      gl.attachShader(program, shader(gl.VERTEX_SHADER, source));
      gl.attachShader(
        program,
        shader(
          gl.FRAGMENT_SHADER,
          '#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main() { o = vec4(1.0); }',
        ),
      );
      gl.transformFeedbackVaryings(program, ['v_clip'], gl.SEPARATE_ATTRIBS);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) ?? 'link');
      }
      gl.useProgram(program);
      const input = gl.createBuffer();
      const output = gl.createBuffer();
      const location = gl.getAttribLocation(program, 'a_offset');
      gl.enable(gl.RASTERIZER_DISCARD);
      const results: number[][] = [];
      for (const c of cases) {
        for (const write of c.uniforms) {
          const at = gl.getUniformLocation(program, write.name);
          if (!at) continue;
          const call = (gl as unknown as Record<string, (...a: unknown[]) => void>)[write.method];
          call?.call(gl, at, ...write.args);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, input);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(c.offset), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, output);
        gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, 16, gl.STREAM_READ);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, output);
        gl.beginTransformFeedback(gl.POINTS);
        gl.drawArrays(gl.POINTS, 0, 1);
        gl.endTransformFeedback();
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
        const clip = new Float32Array(4);
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, output);
        gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, clip);
        results.push([...clip]);
      }
      return results;
    },
    { source, cases },
  );
}

/** The projection data maplibre gives a custom layer for a camera and a transition */
function projectionDataOf(camera: TestCamera, transition: number): ProjectionData {
  const projection = frameProjection(camera, transition);
  return {
    mainMatrix: projection.mainMatrix,
    fallbackMatrix: projection.fallbackMatrix,
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [...projection.clippingPlane],
    projectionTransition: projection.projectionTransition,
  } as unknown as ProjectionData;
}

const LATITUDES = [0, 35.68, 60, 80];
const DELTAS = [1e-4, 1e-3, 1e-2, 0.1, 1, 10, 60];
/** The directions of the offsets: north, south, east, south west */
const DIRECTIONS: Array<[number, number]> = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-Math.SQRT1_2, -Math.SQRT1_2],
];

/** The cases of a transition: every position on the screen, and its reference in CSS px */
function casesOf(transition: number): Array<Case & { reference: [number, number]; where: string }> {
  const out: Array<Case & { reference: [number, number]; where: string }> = [];
  for (const lat of LATITUDES) {
    for (const delta of DELTAS) {
      for (const [ex, ey] of DIRECTIONS) {
        const center: [number, number] = [139.7, lat];
        const position: [number, number] = [center[0] + ex * delta, center[1] + ey * delta];
        if (Math.abs(position[1]) > 85) continue;
        const [cx, cy] = mercatorOf(center[0], center[1]);
        const [px, py] = mercatorOf(position[0], position[1]);
        const zoom = Math.log2(DISTANCE_PX / (Math.hypot(px - cx, py - cy) * 512));
        if (zoom < 0 || zoom > 24) continue;
        const camera: TestCamera = {
          center,
          zoom,
          pitch: 20,
          bearing: 10,
          width: WIDTH,
          height: HEIGHT,
        };
        const data = projectionDataOf(camera, transition);
        const centerF32: [number, number] = [Math.fround(center[0]), Math.fround(center[1])];
        // The offset as the CPU computes it, and the position it stands for
        const offset: [number, number] = [
          Math.fround(position[0] - centerF32[0]),
          Math.fround(position[1] - centerF32[1]),
        ];
        const clip = referenceClip(
          frameProjection(camera, transition),
          centerF32[0] + offset[0],
          centerF32[1] + offset[1],
        );
        const w = clip[3];
        if (!(w > 0) || Math.abs(clip[0] / w) > 1 || Math.abs(clip[1] / w) > 1) continue;
        out.push({
          uniforms: recordUniforms(data, center),
          offset,
          reference: screenOf(clip, WIDTH, HEIGHT),
          where: `transition ${transition} center ${center} offset ${[ex * delta, ey * delta]} zoom ${zoom.toFixed(2)}`,
        });
      }
    }
  }
  return out;
}

describe('the GLSL of the projection on a real WebGL2', () => {
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

  it.each([
    ['Web Mercator', 'mercator', 0],
    ['the globe', 'globe', 1],
    ['the transition from the globe to Web Mercator', 'globe', 0.5],
  ] as const)(
    'lands within 0.01 px of float64 on %s',
    async (_name, variant, transition) => {
      const prelude = preludes.find((p) => p.variantName === variant);
      if (!prelude) throw new Error(`no ${variant} prelude`);
      const cases = casesOf(transition);
      expect(cases.length).toBeGreaterThan(60);
      const clips = await projectOnPage(page, vertexSource(prelude), cases);
      let worst = { px: 0, where: '' };
      cases.forEach((c, i) => {
        const [x, y] = screenOf(clips[i] as number[], WIDTH, HEIGHT);
        const px = Math.hypot(x - c.reference[0], y - c.reference[1]);
        if (!(px <= worst.px)) worst = { px, where: c.where };
      });
      expect(worst.px, worst.where).toBeLessThan(LIMIT_PX);
    },
    browserTimeout(30_000),
  );
});
