// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only AND BSD-3-Clause

/**
 * The DEM atlas
 *
 * MapLibre's terrain holds the DEM in a separate texture per tile and references it with a
 * different `u_terrain_matrix` per tile. core's rendering is built to draw once per layer /
 * chunk in one go, so bringing "a split per terrain tile" into it would multiply the draw
 * calls by the number of tiles and break the premise of retained batches as well.
 *
 * So the DEM tiles being drawn are re-baked into a single texture (the atlas) at the head of
 * the frame. From then on every vertex shader can look an elevation up with nothing but the
 * simple linear transform "Mercator coordinate -> atlas uv". Since the vertex buffers are
 * never touched, there is no need to rebuild retained batches when the DEM arrives (the point
 * of the shader-based approach).
 *
 * The contents of the atlas are not terrarium but elevation meters repacked into a 24-bit
 * fixed point value (a resolution of 0.0039 m). Decoding then takes a single dot product.
 *
 * The bake is skipped when nothing it reads has changed: the same layout, the same tiles with
 * the same DEM textures, matrices and unpack vectors, and the same exaggeration. maplibre
 * rewrites a DEM texture in place when a tile is reloaded or its border is filled from a
 * neighbour that just arrived, which none of those show, so the atlas is also baked on every
 * frame while tiles are loading and on the first frame after they have all arrived
 * (maplibre-coupling.md, "DEM textures").
 *
 * The elevation is baked after the terrain's vertical exaggeration has been applied, the
 * same way MapLibre displaces its own mesh (`getTerrainExaggeration` in `detect.ts`). Every
 * reader of the atlas (vertex displacement and the shading of the fill) then sees the
 * surface the map actually draws, and agrees with the anchors, whose CPU-side elevation
 * already includes the factor. The range of the fixed point value (+-32768 m) applies to
 * the exaggerated elevation.
 */

import { createProgram } from '../shaders/helpers.js';
import {
  getRenderableTerrainTiles,
  getTerrainExaggeration,
  getTerrainTileData,
  type RenderableTerrainTile,
  type TerrainLike,
} from './detect.js';
import { UPSTREAM_DEM_GLSL } from './upstream-terrain.js';

/** Target number of texels assigned to one tile (the terrain mesh splits a tile into 128) */
const ATLAS_CELL_TEXELS = 256;

/** Upper bound on the side of the atlas (2048x2048 of RGBA8 = 16MB) */
const ATLAS_MAX_TEXELS = 2048;

/** The EXTENT of MapLibre's tile coordinate system */
const TILE_EXTENT = 8192;

/**
 * The span of zooms admitted into the range the atlas covers
 *
 * Once the pitch is raised, the terrain tiles being drawn include very coarse tiles on the
 * horizon side (measured: two zoom 7 tiles in a zoom 12 view). Trying to cover the coarse
 * tiles too would make the atlas range as much as 64 times the width of the finest tile, and
 * the resolution in the foreground would end up coarser than the terrain mesh (128
 * subdivisions per tile).
 *
 * So the range is decided by "only the tiles within this span from the finest zoom". The
 * coarse tiles are baked in a way that sticks out beyond the range, so no elevation is missing
 * inside that range. Outside the range (on the horizon side) it is clamped to the edge value.
 */
const ATLAS_ZOOM_SPAN = 2;

/** The result of building the atlas */
export interface DemAtlasResult {
  texture: WebGLTexture;
  /** [x0, y0, 1/width, 1/height] (Mercator) */
  rect: [number, number, number, number];
  /** [width, height] (texels) */
  size: [number, number];
  /** The maximum zoom of the tiles being drawn (used for the lift and the subdivision step) */
  maxTileZoom: number;
  /** The number of pixels within a tile, used to derive the ground size of one DEM pixel */
  demDim: number;
}

const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);

const VERTEX_SOURCE = `#version 300 es
layout(location = 0) in vec2 a_corner;
uniform vec4 u_dest;      // [x0, y0, width, height] in the atlas 0..1 space
uniform float u_extent;   // The EXTENT of the tile coordinate system
out vec2 v_tile_pos;
void main() {
    vec2 p = u_dest.xy + a_corner * u_dest.zw;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    v_tile_pos = a_corner * u_extent;
}`;

// The DEM is read with the layout of maplibre's DEM textures (upstream-terrain.ts), the same way
// the drape and maplibre's own terrain read it.
const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 v_tile_pos;
uniform highp sampler2D u_terrain;
uniform mat4 u_terrain_matrix;
uniform float u_terrain_dim;
uniform vec4 u_terrain_unpack;
uniform float u_terrain_exaggeration;
out vec4 fragColor;
${UPSTREAM_DEM_GLSL}
void main() {
    vec2 uv = (u_terrain_matrix * vec4(v_tile_pos, 0.0, 1.0)).xy;
    float elevation = upstream_dem_bilinear(
        u_terrain, u_terrain_unpack, upstream_dem_coord(uv, u_terrain_dim)) *
        u_terrain_exaggeration;

    // Meters into a 24-bit fixed point value (-32768 m to +32768 m, resolution 0.0039 m)
    float v = clamp((elevation + 32768.0) / 65536.0, 0.0, 0.99999994);
    float r = floor(v * 256.0);
    float g = floor((v * 256.0 - r) * 256.0);
    float b = floor(((v * 256.0 - r) * 256.0 - g) * 256.0);
    fragColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
}`;

/**
 * The DEM atlas
 */
export class DemAtlas {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private framebuffer: WebGLFramebuffer | null = null;
  private texture: WebGLTexture | null = null;
  private textureWidth = 0;
  private textureHeight = 0;

  // Uniform locations
  private destLoc: WebGLUniformLocation | null = null;
  private extentLoc: WebGLUniformLocation | null = null;
  private terrainLoc: WebGLUniformLocation | null = null;
  private matrixLoc: WebGLUniformLocation | null = null;
  private dimLoc: WebGLUniformLocation | null = null;
  private unpackLoc: WebGLUniformLocation | null = null;
  private exaggerationLoc: WebGLUniformLocation | null = null;

  /** What the atlas holds now, for skipping a bake that would give the same texels */
  private bakedKey: string | null = null;
  private bakedResult: DemAtlasResult | null = null;
  /** A number per DEM texture object (the key compares textures by identity) */
  private textureIds = new WeakMap<object, number>();
  private nextTextureId = 1;
  /** The number of bakes done (diagnostics and tests) */
  bakeCount = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /**
   * Bakes the DEM tiles being drawn into the atlas
   *
   * @param centerMercatorX The Mercator x of the camera center. Each tile is placed on the copy
   *   of the world nearest to it, so the tiles on both sides of the antimeridian sit next to
   *   each other (see `computeAtlasLayout`)
   * @param tilesLoaded Whether every tile of the map has arrived (`map.areTilesLoaded()`).
   *   While they have not, the DEM textures can be rewritten in place, so the atlas is baked
   *   again on every frame; once they have, an unchanged frame reuses the last bake
   * @returns null when it cannot be baked (the terrain is disabled, there is not a single
   *   tile, or a GL resource could not be allocated)
   */
  build(terrain: TerrainLike, centerMercatorX = 0.5, tilesLoaded = false): DemAtlasResult | null {
    const tiles = getRenderableTerrainTiles(terrain);
    if (tiles.length === 0) return null;

    const layout = computeAtlasLayout(tiles, centerMercatorX);
    if (!layout) return null;

    // Coarse tiles are baked first and finer tiles overwrite them
    const ordered = [...tiles].sort((a, b) => a.z - b.z);
    const sources = ordered.map((tile) => getTerrainTileData(terrain, tile));
    const exaggeration = getTerrainExaggeration(terrain);
    const key = this.bakeKey(layout, ordered, sources, exaggeration);
    if (key === this.bakedKey && this.bakedResult && this.texture) return this.bakedResult;

    const gl = this.gl;
    if (!this.ensureProgram()) return null;
    if (!this.ensureTarget(layout.width, layout.height)) return null;
    this.bakeCount++;

    // Saves the draw state. This runs in the middle of MapLibre's rendering, and restoring it
    // is the caller's responsibility.
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const prevDepth = gl.getParameter(gl.DEPTH_TEST) as boolean;
    const prevBlend = gl.getParameter(gl.BLEND) as boolean;
    const prevScissor = gl.getParameter(gl.SCISSOR_TEST) as boolean;
    const prevCull = gl.getParameter(gl.CULL_FACE) as boolean;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, layout.width, layout.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);

    // Fills with elevation 0 (outside the coverage is treated as sea level 0)
    gl.clearColor(128 / 255, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    if (this.terrainLoc) gl.uniform1i(this.terrainLoc, 0);
    if (this.extentLoc) gl.uniform1f(this.extentLoc, TILE_EXTENT);
    if (this.exaggerationLoc) gl.uniform1f(this.exaggerationLoc, exaggeration);

    let demDim = 0;
    let drawn = 0;
    for (let i = 0; i < ordered.length; i++) {
      const tile = ordered[i];
      const data = sources[i];
      if (!data) continue;

      const tileSize = 1 / 2 ** tile.z;
      const x0 = (tileMercatorX(tile, centerMercatorX) - layout.minX) / layout.spanX;
      const y0 = (tile.y * tileSize - layout.minY) / layout.spanY;
      const w = tileSize / layout.spanX;
      const h = tileSize / layout.spanY;

      gl.bindTexture(gl.TEXTURE_2D, data.texture);
      if (this.destLoc) gl.uniform4f(this.destLoc, x0, y0, w, h);
      if (this.matrixLoc) {
        gl.uniformMatrix4fv(this.matrixLoc, false, toFloat32(data.matrix));
      }
      if (this.dimLoc) gl.uniform1f(this.dimLoc, data.dim);
      if (this.unpackLoc) {
        gl.uniform4f(
          this.unpackLoc,
          data.unpack[0],
          data.unpack[1],
          data.unpack[2],
          data.unpack[3],
        );
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      demDim = Math.max(demDim, data.dim);
      drawn++;
    }

    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Restores the saved state
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
    if (prevDepth) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);
    if (prevBlend) gl.enable(gl.BLEND);
    else gl.disable(gl.BLEND);
    if (prevScissor) gl.enable(gl.SCISSOR_TEST);
    else gl.disable(gl.SCISSOR_TEST);
    if (prevCull) gl.enable(gl.CULL_FACE);
    else gl.disable(gl.CULL_FACE);

    if (drawn === 0 || !this.texture) {
      this.bakedKey = null;
      this.bakedResult = null;
      return null;
    }

    const result: DemAtlasResult = {
      texture: this.texture,
      rect: [layout.minX, layout.minY, 1 / layout.spanX, 1 / layout.spanY],
      size: [layout.width, layout.height],
      maxTileZoom: layout.maxZoom,
      demDim: demDim || 256,
    };
    // Only a bake made after every tile arrived can be reused (see the module comment)
    this.bakedKey = tilesLoaded ? key : null;
    this.bakedResult = result;
    return result;
  }

  /**
   * The key of everything a bake reads (two bakes with the same key give the same texels, as
   * long as no DEM texture was rewritten in place)
   */
  private bakeKey(
    layout: AtlasLayout,
    tiles: readonly RenderableTerrainTile[],
    sources: ReadonlyArray<ReturnType<typeof getTerrainTileData>>,
    exaggeration: number,
  ): string {
    let key = `${layout.width}x${layout.height}@${layout.minX},${layout.minY},${layout.spanX},${layout.spanY}|${exaggeration}`;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const data = sources[i];
      key += `|${tile.z}/${tile.x}/${tile.y}`;
      if (!data) continue;
      let id = this.textureIds.get(data.texture as object);
      if (id === undefined) {
        id = this.nextTextureId++;
        this.textureIds.set(data.texture as object, id);
      }
      key += `:${id}:${data.dim}:${Array.prototype.join.call(data.unpack)}:${Array.prototype.join.call(data.matrix)}`;
    }
    return key;
  }

  /**
   * Releases the GL resources
   */
  dispose(): void {
    const gl = this.gl;
    this.bakedKey = null;
    this.bakedResult = null;
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
    if (this.vao) {
      gl.deleteVertexArray(this.vao);
      this.vao = null;
    }
    if (this.quadBuffer) {
      gl.deleteBuffer(this.quadBuffer);
      this.quadBuffer = null;
    }
    if (this.framebuffer) {
      gl.deleteFramebuffer(this.framebuffer);
      this.framebuffer = null;
    }
    if (this.texture) {
      gl.deleteTexture(this.texture);
      this.texture = null;
    }
    this.textureWidth = 0;
    this.textureHeight = 0;
  }

  /**
   * Compiles the baking program once (false when it cannot be created)
   */
  ensureProgram(): boolean {
    if (this.program) return true;
    const gl = this.gl;

    try {
      this.program = createProgram(gl, VERTEX_SOURCE, FRAGMENT_SOURCE);
    } catch {
      return false;
    }

    this.destLoc = gl.getUniformLocation(this.program, 'u_dest');
    this.extentLoc = gl.getUniformLocation(this.program, 'u_extent');
    this.terrainLoc = gl.getUniformLocation(this.program, 'u_terrain');
    this.matrixLoc = gl.getUniformLocation(this.program, 'u_terrain_matrix');
    this.dimLoc = gl.getUniformLocation(this.program, 'u_terrain_dim');
    this.unpackLoc = gl.getUniformLocation(this.program, 'u_terrain_unpack');
    this.exaggerationLoc = gl.getUniformLocation(this.program, 'u_terrain_exaggeration');

    this.quadBuffer = gl.createBuffer();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);

    return true;
  }

  private ensureTarget(width: number, height: number): boolean {
    const gl = this.gl;
    if (this.texture && this.textureWidth === width && this.textureHeight === height) return true;

    if (this.texture) gl.deleteTexture(this.texture);
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);

    if (!complete) {
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(framebuffer);
      this.texture = null;
      this.framebuffer = null;
      this.textureWidth = 0;
      this.textureHeight = 0;
      return false;
    }

    this.texture = texture;
    this.framebuffer = framebuffer;
    this.textureWidth = width;
    this.textureHeight = height;
    return true;
  }
}

/** The layout of the atlas */
export interface AtlasLayout {
  minX: number;
  minY: number;
  spanX: number;
  spanY: number;
  width: number;
  height: number;
  maxZoom: number;
}

/**
 * The Mercator x of the west edge of a tile, on the copy of the world nearest to the camera
 *
 * The tiles carry canonical x (0 to 2^z - 1). Across the antimeridian the view holds tiles from
 * both ends of that range, and with canonical x their union would be the whole width of the
 * world, crushing the resolution of the atlas. The tile is moved by whole turns (1 in Mercator
 * units) so that its center is within half a turn of the camera center. This is the same
 * placement maplibre gives the wrapped copies it draws.
 */
export function tileMercatorX(tile: RenderableTerrainTile, centerMercatorX: number): number {
  const size = 1 / 2 ** tile.z;
  const x0 = tile.x * size;
  const turns = Math.round(centerMercatorX - (x0 + size / 2));
  return x0 + turns;
}

/**
 * Decides the layout of the atlas from the tiles being drawn
 *
 * The range covered is the union of the Mercator rectangles of the tiles (each placed on the
 * copy nearest to the camera, `tileMercatorX`), and the resolution aims at "assigning
 * ATLAS_CELL_TEXELS to the finest tile", lowered only when it would exceed the upper bound.
 */
export function computeAtlasLayout(
  tiles: RenderableTerrainTile[],
  centerMercatorX: number,
): AtlasLayout | null {
  let maxZoom = 0;
  for (const tile of tiles) {
    if (tile.z > maxZoom) maxZoom = tile.z;
  }
  const minZoom = maxZoom - ATLAS_ZOOM_SPAN;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const tile of tiles) {
    if (tile.z < minZoom) continue;
    const size = 1 / 2 ** tile.z;
    const x0 = tileMercatorX(tile, centerMercatorX);
    const y0 = tile.y * size;
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x0 + size > maxX) maxX = x0 + size;
    if (y0 + size > maxY) maxY = y0 + size;
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  if (!(spanX > 0) || !(spanY > 0)) return null;

  const finest = 1 / 2 ** maxZoom;
  let cell = ATLAS_CELL_TEXELS;
  while (
    cell > 16 &&
    ((spanX / finest) * cell > ATLAS_MAX_TEXELS || (spanY / finest) * cell > ATLAS_MAX_TEXELS)
  ) {
    cell /= 2;
  }

  const width = Math.min(ATLAS_MAX_TEXELS, Math.max(2, Math.ceil((spanX / finest) * cell)));
  const height = Math.min(ATLAS_MAX_TEXELS, Math.max(2, Math.ceil((spanY / finest) * cell)));

  return { minX, minY, spanX, spanY, width, height, maxZoom };
}

/** ArrayLike into a Float32Array (a mat4 can arrive as a Float64Array) */
function toFloat32(source: ArrayLike<number>): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 16; i++) out[i] = source[i];
  return out;
}
