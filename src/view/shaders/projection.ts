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
import type { TerrainContext } from '../terrain/context.js';
import type { TerrainShadeLight } from '../terrain/shade.js';
import {
  INACTIVE_TERRAIN_STATE,
  TERRAIN_ATLAS_TEXTURE_UNIT,
  type TerrainRenderState,
} from '../terrain/state.js';
import { getRenderFrame } from './frame.js';
import type { OffsetUniforms } from './helpers.js';

/**
 * The locations of the projection and terrain uniforms of one program, as
 * {@link ProjectionUniformManager} looks them up. A location is null when the program does
 * not declare the uniform.
 */
export interface ProjectionUniformLocations {
  /** `u_projection_matrix`: the projection matrix of the frame */
  matrix: WebGLUniformLocation | null;
  /** `u_center_lnglat`: the view center in degrees, rounded to Float32 (offset mode) */
  centerLngLat: WebGLUniformLocation | null;
  /** `u_projection_center`: the view center in clip space (offset mode) */
  projectionCenter: WebGLUniformLocation | null;
  /** `u_units_per_degree`: Mercator units per degree at the center (offset mode) */
  unitsPerDegree: WebGLUniformLocation | null;
  /** `u_units_per_degree2`: the latitude correction of the above (offset mode) */
  unitsPerDegree2: WebGLUniformLocation | null;
  /** `u_use_offset_mode`: 1 to project relative to the center, 0 otherwise */
  useOffsetMode: WebGLUniformLocation | null;
  /**
   * The gap between the reference coordinates of a retained batch and the linearization
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
  /** Terrain: the Mercator coordinates of the view center */
  centerMercator: WebGLUniformLocation | null;
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
  /** The value written to u_use_offset_mode */
  useOffsetMode: number;
  /** The value written to u_origin_shift */
  originShiftX: number;
  originShiftY: number;
  /** The source of u_center_lnglat (by reference; null means [0,0] was written) */
  centerSource: OffsetUniforms | null;
  /**
   * The source of the offset-mode-specific uniforms (by reference; null means
   * the default values were written)
   */
  offsetSource: OffsetUniforms | null;
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
 * Creates a record in the not-yet-written state
 */
function createMemo(): ProjectionUniformMemo {
  return {
    frame: -1,
    mainMatrix: null,
    globeSource: null,
    useOffsetMode: Number.NaN,
    originShiftX: Number.NaN,
    originShiftY: Number.NaN,
    centerSource: null,
    offsetSource: null,
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
  private gl: WebGL2RenderingContext;
  private locations: ProjectionUniformLocations | null = null;
  private memo: ProjectionUniformMemo = createMemo();
  /**
   * Whether this is a renderer that draws things stuck to the ground surface
   * (polygons and lines)
   *
   * Only renderers with true stop applying the elevation on a frame that draws
   * polygons and lines flat (the zoomed-out band; surfacesFlattened in
   * `terrain/context.ts`). Symbols such as points, handles and text quads
   * are determined by a single vertex and do not interpolate in between, so
   * they do not create cliffs. Stopping the elevation would only put them out
   * of step with hit testing (the anchor projection).
   */
  private readonly surface: boolean;
  /**
   * The terrain state of the draw instance being drawn (null draws without terrain)
   *
   * The renderers of a CustomLayer pass their instance's context at construction. A renderer
   * of an extension implementation, which may be shared between draw instances, calls
   * `setTerrain(context.terrain)` with the context it receives in each draw call.
   */
  private terrain: TerrainContext | null;

  constructor(
    gl: WebGL2RenderingContext,
    options: { surface?: boolean; terrain?: TerrainContext | null } = {},
  ) {
    this.gl = gl;
    this.surface = options.surface === true;
    this.terrain = options.terrain ?? null;
  }

  /**
   * Sets the terrain state the next uniforms are taken from (null draws without terrain)
   */
  setTerrain(terrain: TerrainContext | null): void {
    this.terrain = terrain;
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
      // For offset mode
      centerLngLat: gl.getUniformLocation(program, 'u_center_lnglat'),
      projectionCenter: gl.getUniformLocation(program, 'u_projection_center'),
      unitsPerDegree: gl.getUniformLocation(program, 'u_units_per_degree'),
      unitsPerDegree2: gl.getUniformLocation(program, 'u_units_per_degree2'),
      useOffsetMode: gl.getUniformLocation(program, 'u_use_offset_mode'),
      originShift: gl.getUniformLocation(program, 'u_origin_shift'),
      // For globe mode
      mercatorCoords: gl.getUniformLocation(program, 'u_projection_tile_mercator_coords'),
      clippingPlane: gl.getUniformLocation(program, 'u_projection_clipping_plane'),
      transition: gl.getUniformLocation(program, 'u_projection_transition'),
      fallbackMatrix: gl.getUniformLocation(program, 'u_projection_fallback_matrix'),
      // For terrain
      centerMercator: gl.getUniformLocation(program, 'u_center_mercator'),
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

  /**
   * Sets the projection uniforms
   *
   * A uniform whose value is the same as last time is not rewritten. Retained
   * mode passes through here for every chunk, but the only thing that changes
   * between chunks is u_origin_shift; the matrix and the camera-related values
   * are invariant within a frame (see frame.ts).
   *
   * @param projectionData MapLibre's ProjectionData
   * @param zoom The current zoom level
   * @param offsetUniforms The uniforms for offset mode (null is allowed)
   * @param originShift The gap between the reference coordinates of the vertex offsets and
   *   the linearization center (the default is [0,0])
   */
  setUniforms(
    projectionData: ProjectionData,
    zoom: number,
    offsetUniforms: OffsetUniforms | null,
    originShift: [number, number] = [0, 0],
  ): void {
    if (!this.locations) return;

    const gl = this.gl;
    const locs = this.locations;
    const memo = this.memo;

    // Rewrite everything when the frame changes (insurance against a design where the
    // contents change while the reference stays the same)
    const frame = getRenderFrame();
    const staleFrame = memo.frame !== frame;

    // Use offset mode at high zoom levels (zoom >= 12)
    const useOffsetMode = zoom >= 12 ? 1.0 : 0.0;

    // Projection matrix
    if (locs.matrix && (staleFrame || memo.mainMatrix !== projectionData.mainMatrix)) {
      gl.uniformMatrix4fv(locs.matrix, false, projectionData.mainMatrix);
      memo.mainMatrix = projectionData.mainMatrix;
    }

    // The offset mode flag
    if (locs.useOffsetMode && (staleFrame || memo.useOffsetMode !== useOffsetMode)) {
      gl.uniform1f(locs.useOffsetMode, useOffsetMode);
      memo.useOffsetMode = useOffsetMode;
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

    // centerLngLat is always set (because the relative coordinates are computed on the CPU
    // side, it is required even at zoom < 12 so that the shader's fallback path can restore
    // the absolute coordinates)
    if (locs.centerLngLat && (staleFrame || memo.centerSource !== offsetUniforms)) {
      if (offsetUniforms) {
        gl.uniform2fv(locs.centerLngLat, offsetUniforms.centerLngLat);
      } else {
        gl.uniform2fv(locs.centerLngLat, [0, 0]);
      }
      memo.centerSource = offsetUniforms;
    }

    // The uniforms specific to offset mode (used only when zoom >= 12)
    // If the source is the same, the written values are the same too (null means the default
    // values were written)
    const offsetSource = offsetUniforms && useOffsetMode > 0 ? offsetUniforms : null;
    if (staleFrame || memo.offsetSource !== offsetSource) {
      if (offsetSource) {
        if (locs.projectionCenter) {
          gl.uniform4fv(locs.projectionCenter, offsetSource.projectionCenter);
        }
        if (locs.unitsPerDegree) {
          gl.uniform3fv(locs.unitsPerDegree, offsetSource.unitsPerDegree);
        }
        if (locs.unitsPerDegree2) {
          gl.uniform3fv(locs.unitsPerDegree2, offsetSource.unitsPerDegree2);
        }
      } else {
        // Default values when not in offset mode
        if (locs.projectionCenter) {
          gl.uniform4fv(locs.projectionCenter, [0, 0, 0, 0]);
        }
        if (locs.unitsPerDegree) {
          gl.uniform3fv(locs.unitsPerDegree, [1, 1, 1]);
        }
        if (locs.unitsPerDegree2) {
          gl.uniform3fv(locs.unitsPerDegree2, [0, 0, 0]);
        }
      }
      memo.offsetSource = offsetSource;
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
      memo.terrainCenterSource !== offsetUniforms
    ) {
      const centerMercX = offsetUniforms?.centerMercator[0] ?? 0;
      const centerMercY = offsetUniforms?.centerMercator[1] ?? 0;

      if (locs.terrainOn) gl.uniform1f(locs.terrainOn, terrainOn);
      if (locs.demAtlas) gl.uniform1i(locs.demAtlas, TERRAIN_ATLAS_TEXTURE_UNIT);
      if (locs.centerMercator) gl.uniform2f(locs.centerMercator, centerMercX, centerMercY);
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
      memo.terrainCenterSource = offsetUniforms;
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
