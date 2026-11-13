// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ProjectionUniformManager
 *
 * A class that unifies the management of projection-related uniforms.
 * It centralizes the uniform location lookup and setup that was duplicated in
 * each renderer.
 */

import type { ProjectionData } from 'maplibre-gl';
import type { TerrainSurface } from '../../api/extension/context.js';
import type { RenderContext } from '../../api/extension/render.js';
import type { GpuContext } from '../../api/extension/webgl.js';
import { terrainStateOf } from '../terrain/binding.js';
import type { TerrainContext } from '../terrain/context.js';
import type { TerrainShadeLight } from '../terrain/shade.js';
import {
  INACTIVE_TERRAIN_STATE,
  TERRAIN_ATLAS_TEXTURE_UNIT,
  type TerrainRenderState,
} from '../terrain/state.js';
import { centerSineCosineOf } from './center-projection.js';
import { getRenderFrame } from './frame.js';
import { calculateOffsetUniforms, type OffsetUniforms } from './helpers.js';

/**
 * The locations of the projection and terrain uniforms of one program, as
 * {@link ProjectionUniformManager} looks them up. A location is null when the program does
 * not declare the uniform.
 */
export interface ProjectionUniformLocations {
  /** `u_projection_matrix`: the projection matrix of the view */
  matrix: WebGLUniformLocation | null;
  /** `u_center_lnglat`: the center the offsets are taken from, in degrees, rounded to Float32 */
  centerLngLat: WebGLUniformLocation | null;
  /** `u_center_sine_cosine`: sin and cos of the latitude and of the longitude of the center */
  centerSineCosine: WebGLUniformLocation | null;
  /** `u_projection_center`: the center in clip space */
  projectionCenter: WebGLUniformLocation | null;
  /**
   * `u_origin_shift`: the gap between the reference coordinates of a retained batch and the
   * center (immediate mode uses [0, 0])
   */
  originShift: WebGLUniformLocation | null;
  /** Globe: the Mercator coordinates of the tile (from maplibre's prelude) */
  mercatorCoords: WebGLUniformLocation | null;
  /** Globe: the clipping plane (from maplibre's prelude) */
  clippingPlane: WebGLUniformLocation | null;
  /** Globe: the transition between Mercator (0) and globe (1) */
  transition: WebGLUniformLocation | null;
  /** Globe: the fallback matrix (from maplibre's prelude) */
  fallbackMatrix: WebGLUniformLocation | null;
  /** Terrain: 1 while the terrain is drawn, 0 otherwise */
  terrainOn: WebGLUniformLocation | null;
  /** Terrain: the sampler of the DEM atlas */
  demAtlas: WebGLUniformLocation | null;
  /** Terrain: the Mercator rectangle the DEM atlas covers */
  demAtlasRect: WebGLUniformLocation | null;
  /** Terrain: the size of the DEM atlas */
  demAtlasSize: WebGLUniformLocation | null;
  /** Terrain: the parameters of the elevation lookup */
  elevationParams: WebGLUniformLocation | null;
  /** Terrain shading: the light direction (polygon fills only) */
  lightDir: WebGLUniformLocation | null;
  /** Terrain shading: the strength of the shading (polygon fills only) */
  shadeStrength: WebGLUniformLocation | null;
}

/**
 * A record of the values written last time (for memoization within a frame)
 *
 * Uniforms are per-program residual state, so there is no need to rewrite a
 * value that is unchanged. The sources (ProjectionData / OffsetUniforms) are
 * objects rebuilt every frame, so comparing by reference is enough. To avoid
 * missing an update should the design change and the same reference span
 * frames, the record is also invalidated by the frame number.
 */
interface ProjectionUniformMemo {
  /** The frame number of the last write (-1 when nothing has been written) */
  frame: number;
  /** The matrix written to u_projection_matrix (by reference) */
  mainMatrix: unknown;
  /** The source of the globe-related uniforms (by reference) */
  globeSource: ProjectionData | null;
  /** The value written to u_origin_shift */
  originShiftX: number;
  originShiftY: number;
  /** The source of the uniforms of the center (by reference) */
  centerSource: OffsetUniforms | null;
  /** The source of the terrain uniforms (by reference) */
  terrainSource: TerrainRenderState | null;
  /** The value written to u_terrain_on */
  terrainOn: number;
  /**
   * The center Mercator coordinates at the time the terrain uniforms were
   * written (it matters for the relative computation of the atlas origin)
   */
  terrainCenterSource: OffsetUniforms | null;
  /** The source of the shading light (by reference; null means no light was written) */
  shadeLight: TerrainShadeLight | null;
  /** The value written to u_shade_strength */
  shadeStrength: number;
}

/**
 * The gap of the reference coordinates when none is given (read only, never written: the
 * default is not made anew on every call)
 */
const NO_ORIGIN_SHIFT: [number, number] = [0, 0];

/**
 * Creates a record in the not-yet-written state
 */
function createMemo(): ProjectionUniformMemo {
  return {
    frame: -1,
    mainMatrix: null,
    globeSource: null,
    originShiftX: Number.NaN,
    originShiftY: Number.NaN,
    centerSource: null,
    terrainSource: null,
    terrainOn: Number.NaN,
    terrainCenterSource: null,
    shadeLight: null,
    shadeStrength: Number.NaN,
  };
}

/**
 * Looks up and sets the projection and terrain uniforms of a program, for a custom renderer
 * that uses {@link OFFSET_MODE_GLSL}.
 *
 * A class that manages the projection-related uniforms in one place
 */
export class ProjectionUniformManager {
  private gl: GpuContext;
  private locations: ProjectionUniformLocations | null = null;
  private memo: ProjectionUniformMemo = createMemo();
  /** The uniforms of the center [0, 0], for the draws given none */
  private origin: { projectionData: ProjectionData; uniforms: OffsetUniforms } | null = null;
  /**
   * Whether this is a renderer that draws things stuck to the ground surface
   * (polygons and lines)
   *
   * Only renderers with true stop applying the elevation on a frame that draws
   * polygons and lines flat (the zoomed-out band; surfacesFlattened in
   * `terrain/context.ts`). Symbols such as points, handles and billboard quads
   * are determined by a single vertex and do not interpolate in between, so
   * they do not create cliffs. Stopping the elevation would only put them out
   * of step with hit testing (the anchor projection).
   */
  private readonly surface: boolean;
  /**
   * The terrain state of the draw instance being drawn (null draws without terrain)
   *
   * The renderers of a CustomLayer bind their instance's state after construction. A renderer
   * of an extension, which may be shared between draw instances, calls `setTerrain(ctx)` with
   * the render context it receives in each draw call.
   */
  private terrain: TerrainContext | null = null;

  /**
   * @param gl - The WebGL context of the map
   * @param options - `surface`: whether the renderer draws things stuck to the ground (areas
   *   and lines), which lie flat on the views that draw them flat
   */
  constructor(gl: GpuContext, options: { surface?: boolean } = {}) {
    this.gl = gl;
    this.surface = options.surface === true;
  }

  /**
   * Sets the terrain the next uniforms are taken from.
   *
   * @param terrain - The render context of the draw call, or its `terrain`; `null` draws without
   *   terrain
   * @throws `DrawError` with the code `invalidInput` when it is an object the instance did not
   *   give a renderer, as `viewUniforms` does
   */
  setTerrain(terrain: RenderContext | TerrainSurface | null): void {
    this.terrain = terrainStateOf(terrain);
  }

  /**
   * Sets the terrain state of an instance directly
   *
   * @internal
   */
  useTerrainState(terrain: TerrainContext | null): this {
    this.terrain = terrain;
    return this;
  }

  /**
   * Obtains the uniform locations from a program
   *
   * Rebuilding the program also resets the uniform values, so the record is
   * discarded as well.
   */
  getLocations(program: WebGLProgram): ProjectionUniformLocations {
    const gl = this.gl;
    this.memo = createMemo();
    this.locations = {
      // The basic projection
      matrix: gl.getUniformLocation(program, 'u_projection_matrix'),
      // The center the offsets are taken from
      centerLngLat: gl.getUniformLocation(program, 'u_center_lnglat'),
      centerSineCosine: gl.getUniformLocation(program, 'u_center_sine_cosine'),
      projectionCenter: gl.getUniformLocation(program, 'u_projection_center'),
      originShift: gl.getUniformLocation(program, 'u_origin_shift'),
      // For globe mode
      mercatorCoords: gl.getUniformLocation(program, 'u_projection_tile_mercator_coords'),
      clippingPlane: gl.getUniformLocation(program, 'u_projection_clipping_plane'),
      transition: gl.getUniformLocation(program, 'u_projection_transition'),
      fallbackMatrix: gl.getUniformLocation(program, 'u_projection_fallback_matrix'),
      // For terrain
      terrainOn: gl.getUniformLocation(program, 'u_terrain_on'),
      demAtlas: gl.getUniformLocation(program, 'u_dem_atlas'),
      demAtlasRect: gl.getUniformLocation(program, 'u_dem_atlas_rect'),
      demAtlasSize: gl.getUniformLocation(program, 'u_dem_atlas_size'),
      elevationParams: gl.getUniformLocation(program, 'u_elevation_params'),
      // For terrain shading (null in shaders that do not declare them, and nothing is written)
      lightDir: gl.getUniformLocation(program, 'u_light_dir'),
      shadeStrength: gl.getUniformLocation(program, 'u_shade_strength'),
    };
    return this.locations;
  }

  /**
   * Obtains the current locations (getLocations() must be called first)
   */
  getCurrentLocations(): ProjectionUniformLocations | null {
    return this.locations;
  }

  /** The uniforms of the center [0, 0] for the projection data of a frame (computed once) */
  private originUniformsOf(projectionData: ProjectionData): OffsetUniforms {
    if (this.origin?.projectionData !== projectionData) {
      this.origin = { projectionData, uniforms: calculateOffsetUniforms([0, 0], projectionData) };
    }
    return this.origin.uniforms;
  }

  /**
   * Sets the projection uniforms
   *
   * A uniform whose value is the same as last time is not rewritten. Retained
   * mode passes through here for every chunk, but the only thing that changes
   * between chunks is u_origin_shift; the matrix and the camera-related values
   * are invariant within a draw (see frame.ts).
   *
   * @param projectionData MapLibre's ProjectionData
   * @param offsetUniforms The uniforms of the center the offsets are taken from (null takes
   *   them from [0, 0], as absolute coordinates)
   * @param originShift The gap between the reference coordinates of the vertex offsets and
   *   the center (the default is [0,0])
   */
  setUniforms(
    projectionData: ProjectionData,
    offsetUniforms: OffsetUniforms | null,
    originShift: [number, number] = NO_ORIGIN_SHIFT,
  ): void {
    if (!this.locations) return;

    const gl = this.gl;
    const locs = this.locations;
    const memo = this.memo;

    // Rewrite everything when the frame changes (insurance against a design where the
    // contents change while the reference stays the same)
    const frame = getRenderFrame();
    const staleFrame = memo.frame !== frame;

    // Projection matrix
    if (locs.matrix && (staleFrame || memo.mainMatrix !== projectionData.mainMatrix)) {
      gl.uniformMatrix4fv(locs.matrix, false, projectionData.mainMatrix);
      memo.mainMatrix = projectionData.mainMatrix;
    }

    // The gap of the reference coordinates is always set (defaults to [0,0])
    // This keeps a previous value from lingering when the same program is reused from a
    // retained batch to immediate mode
    // (only this one changes per chunk, so in practice it is written almost every time)
    if (
      locs.originShift &&
      (staleFrame || memo.originShiftX !== originShift[0] || memo.originShiftY !== originShift[1])
    ) {
      gl.uniform2f(locs.originShift, originShift[0], originShift[1]);
      memo.originShiftX = originShift[0];
      memo.originShiftY = originShift[1];
    }

    // The center the offsets are taken from: its degrees, sin and cos of them, and its position
    // in clip space. Without the uniforms of a center the offsets are absolute coordinates, the
    // offsets from [0, 0]
    const center = offsetUniforms ?? this.originUniformsOf(projectionData);
    if (staleFrame || memo.centerSource !== center) {
      if (locs.centerLngLat) gl.uniform2fv(locs.centerLngLat, center.centerLngLat);
      if (locs.centerSineCosine) {
        gl.uniform4fv(locs.centerSineCosine, centerSineCosineOf(center.centerLngLat));
      }
      if (locs.projectionCenter) gl.uniform4fv(locs.projectionCenter, center.projectionCenter);
      memo.centerSource = center;
    }

    // The uniforms for globe mode (taken from projectionData)
    if (staleFrame || memo.globeSource !== projectionData) {
      if (locs.mercatorCoords && projectionData.tileMercatorCoords) {
        gl.uniform4fv(locs.mercatorCoords, projectionData.tileMercatorCoords);
      }
      if (locs.clippingPlane && projectionData.clippingPlane) {
        gl.uniform4fv(locs.clippingPlane, projectionData.clippingPlane);
      }
      if (locs.transition) {
        gl.uniform1f(locs.transition, projectionData.projectionTransition ?? 0);
      }
      if (locs.fallbackMatrix && projectionData.fallbackMatrix) {
        gl.uniformMatrix4fv(locs.fallbackMatrix, false, projectionData.fallbackMatrix);
      }
      memo.globeSource = projectionData;
    }

    // The uniforms for terrain (taken from the frame state; when terrain is disabled,
    // u_terrain_on = 0 makes the vertex computation exactly identical to before)
    //
    // The atlas origin is handed over as a value relative to the center Mercator
    // coordinates. Sending absolute Mercator coordinates (values in 0-1 that use up the
    // significant digits) as Float32 cannot express differences smaller than one atlas
    // texel, which makes the elevation come out in steps.
    const context = this.terrain;
    const terrain = context?.renderState ?? INACTIVE_TERRAIN_STATE;
    const suppressed = context?.elevationSuppressed === true;
    const flattened = this.surface && context?.surfacesFlattened === true;
    const terrainOn = terrain.active && !suppressed && !flattened ? 1 : 0;
    if (
      staleFrame ||
      memo.terrainSource !== terrain ||
      memo.terrainOn !== terrainOn ||
      memo.terrainCenterSource !== center
    ) {
      const centerMercX = center.centerMercator[0];
      const centerMercY = center.centerMercator[1];

      if (locs.terrainOn) gl.uniform1f(locs.terrainOn, terrainOn);
      if (locs.demAtlas) gl.uniform1i(locs.demAtlas, TERRAIN_ATLAS_TEXTURE_UNIT);
      if (locs.demAtlasRect) {
        gl.uniform4f(
          locs.demAtlasRect,
          terrain.atlasRect[0] - centerMercX,
          terrain.atlasRect[1] - centerMercY,
          terrain.atlasRect[2],
          terrain.atlasRect[3],
        );
      }
      if (locs.demAtlasSize) {
        gl.uniform2f(locs.demAtlasSize, terrain.atlasSize[0], terrain.atlasSize[1]);
      }
      if (locs.elevationParams) {
        gl.uniform2f(locs.elevationParams, terrain.elevationScale, terrain.liftMeters);
      }
      memo.terrainSource = terrain;
      memo.terrainOn = terrainOn;
      memo.terrainCenterSource = center;
    }

    // The uniforms of the terrain shading (declared only by the shaders of the polygon fill)
    //
    // The strength is set to 0 when there is no terrain and when drawing as a shape on the
    // screen (things drawn with the elevation stopped, such as a rubber band). It is not set
    // to 0 on a frame that draws polygons and lines flat (the zoomed-out band). Stopping the
    // vertex displacement is a measure to avoid cliffs, and erasing the shading there as
    // well would make the appearance of the fill jump at the boundary where the paths swap
    // over (which is the very reason this shading was introduced).
    if (locs.lightDir !== null || locs.shadeStrength !== null) {
      const light = context?.shadeLight ?? null;
      const shadeStrength = light !== null && terrain.active && !suppressed ? light.strength : 0;
      if (staleFrame || memo.shadeLight !== light || memo.shadeStrength !== shadeStrength) {
        if (locs.lightDir) {
          const d = light?.direction ?? [0, 0, 1];
          gl.uniform3fv(locs.lightDir, [d[0], d[1], d[2]]);
        }
        if (locs.shadeStrength) gl.uniform1f(locs.shadeStrength, shadeStrength);
        memo.shadeLight = light;
        memo.shadeStrength = shadeStrength;
      }
    }

    memo.frame = frame;
  }
}
