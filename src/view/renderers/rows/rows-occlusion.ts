// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The test of whether the terrain hides a point from the camera, in a vertex shader
 *
 * The symbols drawn anew every frame take the test on the CPU (`terrain/occlusion.ts`): the
 * segment from the camera to the anchor is sampled, and the anchor is occluded when the ground
 * rises above the segment somewhere along it, and is then drawn faint. The points drawn from the
 * kept chunks of the rows take the same test in their vertex shader, every frame, once per vertex
 * (every vertex of a point gets the same answer), so a kept chunk never draws the ghost of an
 * older camera. The constants (the samples, the margins and the faintness) are those of the CPU.
 *
 * The ground along the segment is read from the DEM atlas (`dem_elevation_meters`, so the source
 * goes after `OFFSET_MODE_GLSL`), where the CPU reads the ground maplibre draws (`ground.ts`). The
 * atlas holds the ground the map draws; a sample that falls outside it is passed over, as ground
 * that hides nothing: what is not drawn is not seen, so it is no reason for the point to be faint.
 * The CPU reads the real ground there, so the two can only differ where ground that is not drawn
 * (under the camera, off the screen) rises above the line of sight.
 *
 * `terrain_occlusion_opacity` takes the anchor as the offset it is projected from and the
 * elevation of its ground in meters, and returns the opacity of the symbol: the faintness when
 * the terrain hides it, 1 otherwise and while `u_ghost_on` is 0.
 *
 * The uniforms, which {@link TerrainOcclusionUniforms} writes:
 * - `u_ghost_on`: 1 while the test is made (the terrain is drawn and the camera is known)
 * - `u_ghost_camera`: the camera, its Mercator offset from the center the draw is projected from
 *   and its height in Mercator units
 * - `u_ghost_node`: the node spacing of the terrain mesh in Mercator units (0 when not known)
 */

import type { OffsetUniforms } from '../../shaders/helpers.js';
import type { TerrainContext } from '../../terrain/context.js';
import {
  MAX_SAMPLES,
  MIN_SAMPLES,
  NEAR_SKIP,
  NODES_WITHOUT_STEP,
  SELF_SKIP_NODES,
  TERRAIN_GHOST_OPACITY,
} from '../../terrain/occlusion.js';

/** A float literal of GLSL */
function glslFloat(value: number): string {
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

/**
 * The GLSL of the test (after `OFFSET_MODE_GLSL`)
 *
 * @internal
 */
export const TERRAIN_OCCLUSION_GLSL = `
uniform float u_ghost_on;
uniform vec3 u_ghost_camera;
uniform float u_ghost_node;

// Whether a Mercator offset from the center is on the DEM atlas (the ground the map draws)
bool terrainGhostOnAtlas(vec2 offset) {
    vec2 uv = (offset - u_dem_atlas_rect.xy) * u_dem_atlas_rect.zw;
    return uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0;
}

// The opacity of an anchor given as its Mercator offset from the center and its height in
// Mercator units
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
        // Ground the map does not draw hides nothing
        if (!terrainGhostOnAtlas(p.xy)) continue;
        float surface = dem_elevation_meters(p.xy) * u_elevation_params.x;
        if (surface > p.z) return ${glslFloat(TERRAIN_GHOST_OPACITY)};
    }
    return 1.0;
}

// The opacity of an anchor given as the offset it is projected from and the elevation of its
// ground in meters
float terrain_occlusion_opacity(vec2 offset, float elevationMeters) {
    if (u_ghost_on < 0.5) return 1.0;
    return terrainGhostOpacity(shade_mercator_offset(offset), elevationMeters * u_elevation_params.x);
}
`;

/**
 * The uniforms of {@link TERRAIN_OCCLUSION_GLSL} of a program
 *
 * The camera is written from the center the offsets of the draw are taken from, on the copy of the
 * world nearest to it, as the origin of the DEM atlas is.
 *
 * @internal
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
   * Writes the uniforms of a draw; the program is in use
   *
   * @param wanted Whether the draw makes the test (the frames the drape paints only)
   * @param terrain The terrain state of the instance
   * @param center The center the offsets of the draw are taken from
   */
  write(wanted: boolean, terrain: TerrainContext, center: OffsetUniforms | null): void {
    const gl = this.#gl;
    const camera = terrain.anchorFrame.cameraMercator;
    const on = wanted && center !== null && camera !== null && ghostsDrawn(terrain);
    if (this.#on) gl.uniform1f(this.#on, on ? 1 : 0);
    if (!on) return;
    const dx = camera[0] - center.centerMercator[0];
    if (this.#camera) {
      gl.uniform3f(
        this.#camera,
        dx - Math.round(dx),
        camera[1] - center.centerMercator[1],
        camera[2],
      );
    }
    if (this.#node) gl.uniform1f(this.#node, terrain.renderState.stepGrid);
  }
}

/**
 * Whether the test can be made in a frame: the terrain is drawn, and the CPU test would look from
 * a camera (the conditions of `isAnchorOccluded`)
 */
function ghostsDrawn(terrain: TerrainContext): boolean {
  const frame = terrain.anchorFrame;
  return (
    terrain.renderState.active &&
    frame.terrain !== null &&
    frame.cameraMercator !== null &&
    frame.elevationScale > 0
  );
}
