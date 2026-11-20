// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reconstruction of the terrain mesh
 *
 * The vertices and triangles are built with "the same rules" as the regular mesh MapLibre uses
 * to draw the terrain. The point is to make both the coordinates and the direction of the
 * diagonals the same, which makes our own polygons agree exactly with MapLibre's terrain
 * surface (sampling the same DEM with two different triangulations necessarily disagrees on a
 * slope).
 *
 * The rules match `Terrain.getTerrainMesh` of MapLibre 6.6.
 *
 * - The vertices lay out (x * delta, y * delta) for x, y = 0..meshSize in row-major order
 *   (delta = EXTENT / meshSize)
 * - The triangles are two per cell, (x, y) -> (x, y+1) -> (x+1, y+1) and
 *   (x, y) -> (x+1, y+1) -> (x+1, y). The diagonal is the main diagonal joining (x, y) and
 *   (x+1, y+1)
 *
 * No skirt (a hem at the tile boundary) is built. A prototype was verified hands-on, but the
 * wall of the hem stands on the same surface as MapLibre's own skirt, so it is not hidden by
 * depth and showed up as a thick band along the tile boundary. The gap at a tile boundary is
 * closed not by covering it with a hem but by having adjoining tiles share the same polyline
 * at the boundary (drape/stitch.ts and drape_constrain in the vertex shader).
 */

import type { GpuLedgerPart } from '../../gpu-ledger.js';

/**
 * The part the drape records its textures and its meshes under in the GPU ledger
 *
 * @internal
 */
export const DRAPE_PART = 'drape';

/** The EXTENT of MapLibre's tile coordinate system */
export const TILE_EXTENT = 8192;

/** The GPU resources of one terrain mesh */
export interface TerrainMeshBuffers {
  readonly vao: WebGLVertexArrayObject;
  readonly vertexBuffer: WebGLBuffer;
  readonly indexBuffer: WebGLBuffer;
  readonly indexCount: number;
  readonly meshSize: number;
}

/**
 * Builds the vertices and indices of the mesh (a pure function)
 */
export function buildTerrainMeshArrays(meshSize: number): {
  vertices: Int16Array;
  indices: Uint32Array;
} {
  const delta = TILE_EXTENT / meshSize;
  const side = meshSize + 1;

  const vertices = new Int16Array(side * side * 2);
  let v = 0;
  for (let y = 0; y <= meshSize; y++) {
    for (let x = 0; x <= meshSize; x++) {
      vertices[v++] = x * delta;
      vertices[v++] = y * delta;
    }
  }

  const indices: number[] = [];
  const meshSize2 = meshSize * meshSize;
  for (let rowBase = 0; rowBase < meshSize2; rowBase += meshSize + 1) {
    for (let x = 0; x < meshSize; x++) {
      indices.push(x + rowBase);
      indices.push(meshSize + x + rowBase + 1);
      indices.push(meshSize + x + rowBase + 2);
      indices.push(x + rowBase);
      indices.push(meshSize + x + rowBase + 2);
      indices.push(x + rowBase + 1);
    }
  }

  return { vertices, indices: new Uint32Array(indices) };
}

/**
 * Uploads the mesh to the GPU
 *
 * One mesh is enough regardless of the tile (the tile coordinate system is common).
 *
 * @param ledger Where the buffers are recorded, and under which part
 */
export function createTerrainMeshBuffers(
  gl: WebGL2RenderingContext,
  meshSize: number,
  ledger: GpuLedgerPart,
): TerrainMeshBuffers | null {
  const { vertices, indices } = buildTerrainMeshArrays(meshSize);
  const { ledger: gpu, part } = ledger;

  const vao = gl.createVertexArray();
  gpu.record(vao, part, 'vertex-array');
  const vertexBuffer = gl.createBuffer();
  gpu.record(vertexBuffer, part, 'buffer');
  const indexBuffer = gl.createBuffer();
  gpu.record(indexBuffer, part, 'buffer');
  if (!vao || !vertexBuffer || !indexBuffer) {
    // What was made is given back (a lost context makes none of them)
    gpu.release(vao);
    gpu.release(vertexBuffer);
    gpu.release(indexBuffer);
    if (vao) gl.deleteVertexArray(vao);
    if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
    if (indexBuffer) gl.deleteBuffer(indexBuffer);
    return null;
  }

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  gpu.record(vertexBuffer, part, 'buffer', vertices.byteLength);
  gl.enableVertexAttribArray(0);
  // The integer attribute is read as a float (the shader side is a vec2)
  gl.vertexAttribPointer(0, 2, gl.SHORT, false, 4, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  gpu.record(indexBuffer, part, 'buffer', indices.byteLength);
  gl.bindVertexArray(null);

  return { vao, vertexBuffer, indexBuffer, indexCount: indices.length, meshSize };
}

/**
 * Releases the GPU resources of the mesh
 */
export function disposeTerrainMeshBuffers(
  gl: WebGL2RenderingContext,
  mesh: TerrainMeshBuffers,
  ledger: GpuLedgerPart,
): void {
  ledger.ledger.release(mesh.vao);
  ledger.ledger.release(mesh.vertexBuffer);
  ledger.ledger.release(mesh.indexBuffer);
  gl.deleteVertexArray(mesh.vao);
  gl.deleteBuffer(mesh.vertexBuffer);
  gl.deleteBuffer(mesh.indexBuffer);
}
