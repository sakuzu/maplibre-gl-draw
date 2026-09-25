// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The GL resources of the SDF line renderer
 *
 * The vertex attribute layout shared by immediate mode and retained mode, the coordinate
 * textures, and the create / patch / delete of a retained batch. The functions take the GL
 * context and hold no state of their own, except the growable coordinate texture of
 * immediate mode.
 */

import { calculateLngLatOffset } from '../../shaders/helpers.js';
import { INSTANCE_BYTES, type LineBatchArrays, STATION_VERTICES } from './line-geometry.js';
import type { LineBatchShape, RetainedLineBatch } from './line-types.js';

/**
 * Sets up the quad vertex attributes (call it with the quad bound to ARRAY_BUFFER)
 *
 * @internal
 */
export function setupQuadAttribs(gl: WebGL2RenderingContext): void {
  // location 0: side (float)
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 8, 0);
  // location 1: t (float)
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 8, 4);
}

/**
 * Sets up the instance attributes (call it with the instances bound to ARRAY_BUFFER)
 *
 * Immediate mode and retained mode use the same layout (stride = 48 bytes = 12 floats).
 *
 * @internal
 */
export function setupInstanceAttribs(gl: WebGL2RenderingContext): void {
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, INSTANCE_BYTES, 0); // a_indices
  gl.vertexAttribDivisor(2, 1);

  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 4, gl.FLOAT, false, INSTANCE_BYTES, 16); // a_extra (vec4)
  gl.vertexAttribDivisor(3, 1);

  gl.enableVertexAttribArray(4);
  gl.vertexAttribPointer(4, 4, gl.FLOAT, false, INSTANCE_BYTES, 32); // a_color (vec4)
  gl.vertexAttribDivisor(4, 1);
}

/**
 * Resets the instance divisors and unbinds the vertex array (the end of an immediate draw)
 *
 * @internal
 */
export function releaseInstanceAttribs(gl: WebGL2RenderingContext): void {
  gl.vertexAttribDivisor(2, 0);
  gl.vertexAttribDivisor(3, 0);
  gl.vertexAttribDivisor(4, 0);
  gl.bindVertexArray(null);
}

/** Sets nearest filtering and edge clamping on the texture bound to TEXTURE_2D */
function setCoordTextureParams(gl: WebGL2RenderingContext): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

/**
 * Creates a coordinate texture (for retained mode; the size is allocated exactly)
 *
 * @param limit The largest side of a texture this GPU allows (MAX_TEXTURE_SIZE)
 * @returns null when the coordinates do not fit in a texture of this GPU (the batch is then
 *   not built)
 *
 * @internal
 */
export function createCoordTexture(
  gl: WebGL2RenderingContext,
  texData: Float32Array,
  texSize: number,
  limit: number,
): WebGLTexture | null {
  if (texSize > limit) return null;
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, texSize, texSize);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, texSize, texSize, gl.RGBA, gl.FLOAT, texData);
  setCoordTextureParams(gl);
  return texture;
}

/**
 * The coordinate texture reused by immediate mode
 *
 * It is an immutable texture allocated with texStorage2D, so it is recreated only when a
 * texSize larger than the allocated one arrives. `size` is the allocated side length, which is
 * distinct from u_tex_size (the texSize of the data) passed to the shader.
 *
 * @internal
 */
export class ImmediateCoordTexture {
  texture: WebGLTexture | null = null;
  size = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {}

  /**
   * Uploads the coordinates (returns with the texture bound to TEXTURE_2D)
   *
   * The allocated size is a power of two at least as large as texSize, which keeps
   * reallocation infrequent. The upload covers only the texSize of the data, and the shader's
   * u_tex_size is also given the texSize of the data. texelFetch only refers to the top-left
   * texSize x texSize sub-rectangle, so the read is correct even when the allocated size is
   * larger. The allocation never exceeds `limit` (MAX_TEXTURE_SIZE).
   *
   * @returns false when the coordinates do not fit in a texture of this GPU (nothing is drawn)
   */
  upload(texData: Float32Array, texSize: number, limit: number): boolean {
    const gl = this.gl;
    if (texSize > limit) return false;

    if (!this.texture || texSize > this.size) {
      if (this.texture) gl.deleteTexture(this.texture);

      let size = 2;
      while (size < texSize) size *= 2;
      size = Math.min(size, limit);

      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, size, size);
      setCoordTextureParams(gl);

      this.texture = texture;
      this.size = size;
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
    }

    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, texSize, texSize, gl.RGBA, gl.FLOAT, texData);
    return true;
  }

  /** Deletes the texture */
  dispose(): void {
    if (this.texture) {
      this.gl.deleteTexture(this.texture);
      this.texture = null;
      this.size = 0;
    }
  }
}

/**
 * Creates the GPU resources of a retained-mode line batch
 *
 * The batch owns its coordinate texture, quad vertex buffer, instance buffer, and VAO; none of
 * them is shared with immediate mode.
 *
 * @param limit The largest side of a texture this GPU allows (MAX_TEXTURE_SIZE)
 * @returns null when the coordinates do not fit in a texture of this GPU
 *
 * @internal
 */
export function createRetainedLineBatch(
  gl: WebGL2RenderingContext,
  arrays: LineBatchArrays,
  shape: LineBatchShape,
  origin: [number, number],
  widthZoom: number | null,
  limit: number,
): RetainedLineBatch | null {
  const texture = createCoordTexture(gl, arrays.texData, arrays.texSize, limit);
  if (!texture) return null;

  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);

  // The quad vertices (held separately from the shared immediate-mode buffer)
  const quadBuffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, STATION_VERTICES, gl.STATIC_DRAW);
  setupQuadAttribs(gl);

  // The instance attributes (the layout is identical to immediate mode)
  const instanceBuffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, arrays.instanceData, gl.STATIC_DRAW);
  setupInstanceAttribs(gl);

  gl.bindVertexArray(null);

  return {
    vao,
    quadBuffer,
    instanceBuffer,
    texture,
    texSize: arrays.texSize,
    instanceCount: arrays.instanceCount,
    shape,
    origin,
    widthZoom,
    maxSegmentMeters: arrays.maxSegmentMeters,
    maxSegmentMercator: arrays.maxSegmentMercator,
  };
}

/**
 * Rewrites single texels of the coordinate texture of a retained batch
 *
 * See SDFLineRenderer.patchRetainedBatchCoords for why only the texels are rewritten.
 *
 * @internal
 */
export function patchRetainedCoordTexels(
  gl: WebGL2RenderingContext,
  batch: RetainedLineBatch,
  updates: ReadonlyArray<{ coordIndex: number; lngLat: [number, number] }>,
): void {
  if (updates.length === 0) return;

  const texSize = batch.texSize;
  const capacity = texSize * texSize;

  // The upload buffer for one texel (z/w stay 0, the same as at build time)
  const texel = new Float32Array(4);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, batch.texture);

  for (const { coordIndex, lngLat } of updates) {
    // Ignore out-of-range indices (a safety net for when the batch and the caller diverge)
    if (!Number.isInteger(coordIndex) || coordIndex < 0 || coordIndex >= capacity) continue;

    // The same conversion as at build time (the offset from the origin at 64-bit precision)
    const offset = calculateLngLatOffset(lngLat, batch.origin);
    texel[0] = offset[0];
    texel[1] = offset[1];

    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      coordIndex % texSize,
      Math.floor(coordIndex / texSize),
      1,
      1,
      gl.RGBA,
      gl.FLOAT,
      texel,
    );
  }
}

/**
 * Deletes the GPU resources of a retained-mode line batch
 *
 * @internal
 */
export function deleteRetainedLineBatch(
  gl: WebGL2RenderingContext,
  batch: RetainedLineBatch,
): void {
  gl.deleteVertexArray(batch.vao);
  gl.deleteBuffer(batch.quadBuffer);
  gl.deleteBuffer(batch.instanceBuffer);
  gl.deleteTexture(batch.texture);
}
