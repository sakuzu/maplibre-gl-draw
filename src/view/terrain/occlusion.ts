// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Deciding whether a symbol is occluded by the terrain (whether to ghost it)
 *
 * Points and other billboards are drawn without a depth test. A billboard's front/back
 * order is decided by the depth of its single center point, so enabling depth makes the whole
 * thing disappear as soon as it sinks a few meters into the ground (confirmed by measurement).
 * On the other hand, a symbol behind a mountain stays clearly visible, which is misread as
 * "being in front". So what is occluded is drawn faintly (a CesiumJS-style ghost).
 *
 * The segment drawn from the camera to the anchor is sampled, and if the ground elevation along
 * the way rises above the segment it is occluded. On the CPU, fetching a single elevation takes
 * about 0.4us, so 24 samples along the segment cost about 10us per anchor, which is enough for
 * the symbols drawn anew every frame. The symbols drawn from buffers kept over the frames (the
 * points of the layers held as rows) take the same formula and constants in their vertex shader
 * (`TERRAIN_OCCLUSION_GLSL`), every frame, once per vertex rather than per fragment.
 *
 * Reading the depth buffer (MapLibre's `terrain.depthAtPoint`) is not an option: `readPixels`
 * runs for every single point, which inserts a synchronous wait and stalls rendering once per
 * symbol.
 */

import type { RenderContext } from '../../api/extension/render.js';
import type { OffsetUniforms } from '../shaders/helpers.js';
import { drawnLongitude } from './anchor.js';
import { terrainStateOf } from './binding.js';
import type { TerrainContext } from './context.js';
import type { TerrainLike } from './detect.js';
import { groundElevationMeters } from './ground.js';
import { mercatorX, mercatorY } from './tessellation.js';

/**
 * Opacity of an occluded symbol
 *
 * @internal
 */
export const TERRAIN_GHOST_OPACITY = 0.35;

/** Upper bound on the number of samples along the segment */
const MAX_SAMPLES = 24;

/** Lower bound on the number of samples along the segment */
const MIN_SAMPLES = 6;

/**
 * The number of samples when the step of the terrain mesh is not known: the horizontal distance
 * divided into this many nodes
 */
const NODES_WITHOUT_STEP = 16;

/**
 * Margin discarded on the camera side
 *
 * The ground directly below the camera almost always rises above the segment (the camera is
 * above the ground, but the line of sight points downward, so it grazes the ground just past
 * the starting point). Looking there would make everything occluded, so the first few percent
 * on the start side are skipped.
 */
const NEAR_SKIP = 0.08;

/**
 * Margin discarded on the anchor side (counted in terrain mesh nodes)
 *
 * The anchor sits on top of the ground, so the ground just in front of it is necessarily at
 * the same height. To keep it from hiding itself, two nodes' worth is skipped.
 */
const SELF_SKIP_NODES = 2;

/**
 * Converts a Mercator y back into a latitude
 */
function inverseMercatorY(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/**
 * Whether an anchor is occluded by the terrain
 *
 * Always false (not occluded) when the terrain is disabled or the camera position cannot be
 * obtained. This matches the appearance before the terrain was introduced exactly.
 *
 * @internal
 */
export function isAnchorOccluded(context: TerrainContext, lng: number, lat: number): boolean {
  const frame = context.anchorFrame;
  const terrain = frame.terrain;
  const camera = frame.cameraMercator;
  if (!terrain || !camera) return false;

  const scale = frame.elevationScale;
  if (!(scale > 0)) return false;

  const cached = context.occlusionCache.get(`${lng},${lat}`);
  if (cached !== undefined) return cached;

  const result = computeOccluded(lng, lat, scale, camera, terrain, context);
  context.occlusionCache.set(`${lng},${lat}`, result);
  return result;
}

/**
 * Returns the opacity for a symbol at a point: 0.35 when the terrain hides it from the camera,
 * 1 otherwise.
 *
 * @param context The terrain state of the draw instance
 * @param lng The longitude in degrees
 * @param lat The latitude in degrees
 * @returns 0.35 or 1. Always 1 when the terrain is disabled
 */
export function anchorGhostOpacity(context: TerrainContext, lng: number, lat: number): number {
  return isAnchorOccluded(context, lng, lat) ? TERRAIN_GHOST_OPACITY : 1;
}

function computeOccluded(
  lng: number,
  lat: number,
  scale: number,
  camera: readonly [number, number, number],
  terrain: TerrainLike,
  context: TerrainContext,
): boolean {
  const frame = context.anchorFrame;
  // The elevation of the ground maplibre draws (ground.ts), on the copy of the world the
  // anchor is drawn on
  const elevationAt = (sampleLng: number, sampleLat: number): number =>
    groundElevationMeters(
      frame.elevationQuery,
      terrain,
      context.coverage,
      drawnLongitude(context, sampleLng),
      sampleLat,
      frame.tileZoom,
    );
  const ax = mercatorX(lng);
  const ay = mercatorY(lat);
  const az = elevationAt(lng, lat) * scale;

  const [cx, cy, cz] = camera;
  const dx = ax - cx;
  const dy = ay - cy;
  const dz = az - cz;

  const horizontal = Math.hypot(dx, dy);
  if (!(horizontal > 0)) return false;

  // The sample spacing matches the node spacing of the terrain mesh (sampling any finer only
  // goes beyond the resolution of the bilinear interpolation and adds no information)
  const node =
    context.renderState.stepGrid > 0
      ? context.renderState.stepGrid
      : horizontal / NODES_WITHOUT_STEP;
  const samples = Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, Math.ceil(horizontal / node)));

  // The ground just in front of the anchor is the anchor's own ground, so it is skipped
  const selfSkip = Math.min(0.5, (SELF_SKIP_NODES * node) / horizontal);
  const tEnd = 1 - selfSkip;
  if (!(tEnd > NEAR_SKIP)) return false;

  for (let i = 0; i < samples; i++) {
    const t = NEAR_SKIP + ((tEnd - NEAR_SKIP) * (i + 0.5)) / samples;
    const px = cx + dx * t;
    const py = cy + dy * t;
    const pz = cz + dz * t;
    const sampleLng = px * 360 - 180;
    const sampleLat = inverseMercatorY(py);
    const surface = elevationAt(sampleLng, sampleLat) * scale;
    if (surface > pz) return true;
  }
  return false;
}

/** A float literal of GLSL */
function glslFloat(value: number): string {
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

/**
 * The same test on the GPU, for symbols drawn from buffers kept over the frames (the points of
 * the layers held as rows): the formula and the constants of the test on the CPU, evaluated
 * in the vertex shader every frame, so a kept buffer never draws a ghost of an older camera.
 *
 * It reads the elevations of the ground along the segment from the DEM atlas
 * (`dem_elevation_meters`, so it goes after `OFFSET_MODE_GLSL`), where the CPU version reads the
 * ground maplibre draws (`ground.ts`). `terrain_occlusion_opacity` takes the anchor as the offset
 * it is projected from and the elevation of its ground in meters, and returns the opacity of the
 * symbol: 0.35 when the terrain hides it, 1 otherwise and while `u_ghost_on` is 0.
 * `terrainGhostOpacity` is the same test of an anchor given as its Mercator offset from the center
 * and its height in Mercator units.
 *
 * The uniforms, which {@link TerrainOcclusionUniforms} writes:
 * - `u_ghost_on`: 1 while the terrain is drawn and the camera is known
 * - `u_ghost_camera`: the camera, its Mercator offset from the center and its height in Mercator
 *   units
 * - `u_ghost_node`: the node spacing of the terrain mesh in Mercator units (0 when not known)
 */
export const TERRAIN_OCCLUSION_GLSL = `
uniform float u_ghost_on;
uniform vec3 u_ghost_camera;
uniform float u_ghost_node;

float terrainGhostOpacity(vec2 anchor, float anchorZ) {
    if (u_ghost_on < 0.5) return 1.0;
    vec3 camera = u_ghost_camera;
    vec3 d = vec3(anchor - camera.xy, anchorZ - camera.z);
    float horizontal = length(d.xy);
    if (!(horizontal > 0.0)) return 1.0;
    float node = u_ghost_node > 0.0 ? u_ghost_node : horizontal / ${glslFloat(NODES_WITHOUT_STEP)};
    int samples = int(min(${glslFloat(MAX_SAMPLES)}, max(${glslFloat(MIN_SAMPLES)}, ceil(horizontal / node))));
    float selfSkip = min(0.5, ${glslFloat(SELF_SKIP_NODES)} * node / horizontal);
    float tEnd = 1.0 - selfSkip;
    if (!(tEnd > ${glslFloat(NEAR_SKIP)})) return 1.0;
    for (int i = 0; i < ${MAX_SAMPLES}; i++) {
        if (i >= samples) break;
        float t = ${glslFloat(NEAR_SKIP)} + (tEnd - ${glslFloat(NEAR_SKIP)}) * (float(i) + 0.5) / float(samples);
        vec3 p = camera + d * t;
        float surface = dem_elevation_meters(p.xy) * u_elevation_params.x;
        if (surface > p.z) return ${glslFloat(TERRAIN_GHOST_OPACITY)};
    }
    return 1.0;
}

float terrain_occlusion_opacity(vec2 offset, float elevationMeters) {
    if (u_ghost_on < 0.5) return 1.0;
    return terrainGhostOpacity(shade_mercator_offset(offset), elevationMeters * u_elevation_params.x);
}
`;

/**
 * The uniforms of {@link TERRAIN_OCCLUSION_GLSL} of a program
 *
 * It writes them with the projection of the draw: the camera is written from the center the
 * offsets of the draw are taken from, on the copy of the world nearest to it, as the origin of the
 * DEM atlas is.
 */
export class TerrainOcclusionUniforms {
  readonly #gl: WebGL2RenderingContext;
  readonly #on: WebGLUniformLocation | null;
  readonly #camera: WebGLUniformLocation | null;
  readonly #node: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext, program: WebGLProgram) {
    this.#gl = gl;
    this.#on = gl.getUniformLocation(program, 'u_ghost_on');
    this.#camera = gl.getUniformLocation(program, 'u_ghost_camera');
    this.#node = gl.getUniformLocation(program, 'u_ghost_node');
  }

  /**
   * Whether a draw reads the terrain at all: nothing is hidden while this is false
   *
   * @param ctx - The render context of the draw
   */
  static activeIn(ctx: RenderContext): boolean {
    return ghostsDrawn(terrainStateOf(ctx));
  }

  /**
   * Writes the uniforms of a draw; the program is in use
   *
   * @param ctx - The render context of the draw
   * @param center - The center the offsets of the draw are taken from
   */
  write(ctx: RenderContext, center: OffsetUniforms): void {
    this.writeState(terrainStateOf(ctx), center);
  }

  /**
   * {@link write} of the terrain state of an instance
   *
   * @internal
   */
  writeState(terrain: TerrainContext | null, center: OffsetUniforms): void {
    const gl = this.#gl;
    const on = ghostsDrawn(terrain);
    if (this.#on) gl.uniform1f(this.#on, on ? 1 : 0);
    if (!on) return;
    const state = terrain as TerrainContext;
    const camera = state.anchorFrame.cameraMercator as readonly [number, number, number];
    const dx = camera[0] - center.centerMercator[0];
    if (this.#camera) {
      gl.uniform3f(
        this.#camera,
        dx - Math.round(dx),
        camera[1] - center.centerMercator[1],
        camera[2],
      );
    }
    if (this.#node) gl.uniform1f(this.#node, state.renderState.stepGrid);
  }
}

/** Whether the terrain is drawn with a camera the test can look from */
function ghostsDrawn(terrain: TerrainContext | null): boolean {
  if (!terrain) return false;
  const { renderState, elevationSuppressed, anchorFrame } = terrain;
  return renderState.active && !elevationSuppressed && anchorFrame.cameraMercator !== null;
}
