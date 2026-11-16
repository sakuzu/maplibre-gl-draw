// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A custom type of a prototype of the quads of the drawing of the rows: a pie of two colors on a
 * point, the share of the first color a value of the row (`share`), turned by `angle` (degrees
 * counterclockwise) and scaled by `size`
 *
 * The same GLSL function paints both ways it is drawn: in the draw of the chunk of its rows, as a
 * quad of the drawing of the rows (`rows.quads`, with `quads: true`), and one feature at a time by
 * a renderer of `webgl` (`QuadShader`), which draws the rows of the type while the program of the
 * quads compiles, when the function does not compile, and always with `quads: false`. The two
 * colors are read from a texture of two texels.
 *
 * For the measurement page of the bench (`bench/quad.html`) and the end-to-end tests: not part of
 * the library.
 */

import type { FeatureTypeDefinition, Plugin } from '../index.js';
import type { RowQuadOut, RowQuadSource } from '../view/renderers/rows/rows-format.js';
import {
  QUAD_DRAPE_TEXTURE_UNITS,
  type QuadDrapeContent,
  QuadShader,
  type QuadVertices,
  viewUniforms,
} from '../webgl/index.js';

/** The name of the type */
export const PIE_TYPE = 'pie';

/** The keys of `properties` the type reads */
export const PIE_KEYS = { share: 'share', angle: 'angle', size: 'size' } as const;

/** The two colors, as the texture holds them (RGBA, 8 bits per channel) */
export const PIE_COLORS = Uint8Array.of(232, 89, 12, 255, 28, 126, 214, 255);

/**
 * The function of the pie: a disc in the quad, its edge smoothed over a pixel, the first color
 * from the top clockwise over the share `values.x` of the turn, the second color over the rest
 */
export const PIE_GLSL = `
vec4 pie_color(vec2 uv, vec2 sizePx, vec4 values, sampler2D tex) {
    vec2 p = uv * 2.0 - 1.0;
    float r = length(p);
    float pixel = 2.0 / max(min(sizePx.x, sizePx.y), 1.0);
    float cover = clamp((1.0 - r) / pixel + 0.5, 0.0, 1.0);
    if (cover <= 0.0) return vec4(0.0);
    float turn = fract(atan(p.x, -p.y) / 6.28318530718 + 1.0);
    vec4 c = texelFetch(tex, ivec2(turn < values.x ? 0 : 1, 0), 0);
    return vec4(c.rgb * c.a * cover, c.a * cover);
}
`;

/** A function that does not compile (to see the rows of the type drawn one by one then) */
const BROKEN_GLSL = `
vec4 pie_color(vec2 uv, vec2 sizePx, vec4 values, sampler2D tex) {
    return pie_missing(uv);
}
`;

/** How the pies are drawn */
export interface PieOptions {
  /** Whether the rows are drawn as quads in the draw of their chunk (else one by one) */
  readonly quads: boolean;
  /** Whether the size is in meters on the ground (else CSS px on screen) */
  readonly meters: boolean;
  /** Half the side of a pie of `size` 1 */
  readonly halfSize: number;
  /** Gives a function that does not compile */
  readonly broken?: boolean;
}

/** A number of `properties`, or a fallback */
function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The source of quads of the pies */
export function pieQuadSource(options: PieOptions): RowQuadSource {
  return {
    glsl: options.broken ? BROKEN_GLSL : PIE_GLSL,
    entry: 'pie_color',
    texture: { width: 2, height: 1, data: PIE_COLORS },
    keys: [PIE_KEYS.share, PIE_KEYS.angle, PIE_KEYS.size],
    quad(view, handle, out: RowQuadOut): boolean {
      const size = numberOf(view.getRowValue(handle, PIE_KEYS.size), 1);
      out.halfWidth = options.halfSize * size;
      out.halfHeight = options.halfSize * size;
      out.meters = options.meters;
      out.angleDegrees = numberOf(view.getRowValue(handle, PIE_KEYS.angle), 0);
      out.values[0] = numberOf(view.getRowValue(handle, PIE_KEYS.share), 0.5);
      out.values[1] = 0;
      out.values[2] = 0;
      out.values[3] = 0;
      return true;
    },
  };
}

/** The content of a quad of `QuadShader`: the same function, its values in uniforms */
class PieContent implements QuadDrapeContent {
  readonly glsl: string;
  texture: WebGLTexture | null = null;
  readonly values = new Float32Array(4);
  readonly size = new Float32Array(2);

  constructor() {
    this.glsl = `
uniform vec4 u_pie_values;
uniform vec2 u_pie_size;
uniform sampler2D u_pie_tex;
${PIE_GLSL}
vec4 quadDrapeColor(vec2 uv, vec2 uvDx, vec2 uvDy, float shade) {
    return pie_color(uv, u_pie_size, u_pie_values, u_pie_tex);
}
`;
  }

  bind(
    gl: Parameters<QuadDrapeContent['bind']>[0],
    uniform: (name: string) => WebGLUniformLocation | null,
  ): void {
    const unit = QUAD_DRAPE_TEXTURE_UNITS[0] as number;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(uniform('u_pie_tex'), unit);
    gl.uniform4fv(uniform('u_pie_values'), this.values);
    gl.uniform2fv(uniform('u_pie_size'), this.size);
  }
}

/** Meters per degree of latitude (the corners of a pie on the ground, one by one) */
const METERS_PER_DEGREE = 111_319.49079327357;

/** The definition of the type */
export function pieType(options: PieOptions): FeatureTypeDefinition {
  return {
    type: PIE_TYPE,
    geometry: 'Point',
    transformFields: {
      angleDegreesKey: PIE_KEYS.angle,
      scaleKey: PIE_KEYS.size,
      uniformScale: true,
    },
    ...(options.quads && {
      rows: { appliesTo: () => true, quads: pieQuadSource(options) },
    }),
  };
}

/**
 * The plugin of the pies: the type, and the renderer of `webgl` that draws them one by one
 */
export function piePlugin(options: PieOptions): Plugin {
  return {
    name: 'quad-pie',
    onAdd(ctx) {
      ctx.extensions.featureTypes.add(pieType(options));
      ctx.webgl.addFeatureRenderer(PIE_TYPE, {
        gpuShare: 0.05,
        prepare(gpu) {
          // The function of the drawing one by one compiles even when the one of the quads does not
          const content = new PieContent();
          const shader = new QuadShader(gpu, content);
          const gl = gpu.gl;
          const texture = gpu.texture(2, 1, gl.RGBA8);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 2, 1, gl.RGBA, gl.UNSIGNED_BYTE, PIE_COLORS);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.bindTexture(gl.TEXTURE_2D, null);
          content.texture = texture;
          return {
            render(feature, rc) {
              if (feature.geometry.type !== 'Point') return;
              const [lng, lat] = feature.geometry.coordinates as [number, number];
              const properties = (feature.properties ?? {}) as Record<string, unknown>;
              const size = numberOf(properties[PIE_KEYS.size], 1);
              const angle = (numberOf(properties[PIE_KEYS.angle], 0) * Math.PI) / 180;
              content.values[0] = numberOf(properties[PIE_KEYS.share], 0.5);
              const half = options.halfSize * size;
              const cos = Math.cos(angle);
              const sin = Math.sin(angle);
              // The corners (x to the right, y up of the pie unturned), turned counterclockwise
              const turned = (x: number, y: number): [number, number] => [
                x * cos - y * sin,
                x * sin + y * cos,
              ];
              let corner: (x: number, y: number) => [number, number];
              if (options.meters) {
                const perLng = METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
                corner = (x, y) => {
                  const [e, n] = turned(x * half, y * half);
                  return [lng + e / perLng, lat + n / METERS_PER_DEGREE];
                };
              } else {
                const center = rc.screen.project([lng, lat]);
                // The east and the north on screen (its y goes down; the map may turn)
                const east = rc.screen.project([lng + 1e-4, lat]);
                const ex = east[0] - center[0];
                const ey = east[1] - center[1];
                const length = Math.hypot(ex, ey) || 1;
                const ux = ex / length;
                const uy = ey / length;
                corner = (x, y) => {
                  const [e, n] = turned(x * half, y * half);
                  const at = rc.screen.unproject([
                    center[0] + e * ux + n * uy,
                    center[1] + e * uy - n * ux,
                  ]);
                  return [at[0] as number, at[1] as number];
                };
              }
              const vertices: QuadVertices = {
                topLeft: corner(-1, 1),
                topRight: corner(1, 1),
                bottomLeft: corner(-1, -1),
                bottomRight: corner(1, -1),
              };
              const a = rc.screen.project(vertices.topLeft);
              const b = rc.screen.project(vertices.topRight);
              const side = Math.hypot(b[0] - a[0], b[1] - a[1]);
              content.size[0] = side;
              content.size[1] = side;
              const view = viewUniforms(rc);
              shader.ensureShader(view.shader);
              shader.setTerrain(rc);
              shader.setOffsetUniforms(view.offset);
              shader.draw(vertices, rc.opacity, view.projection);
            },
          };
        },
      });
    },
  };
}
