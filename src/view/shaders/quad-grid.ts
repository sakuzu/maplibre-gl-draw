// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Subdivision of a textured quad (the degraded path)
 *
 * On frames where the analytic drape (`terrain/drape/quad.ts`) cannot be used,
 * the quad is split to a fineness close to the grid of the terrain mesh. The
 * resulting vertices are lifted by the shared GLSL
 * (`terrain_elevation_from_offset` in `OFFSET_MODE_GLSL`), which looks up the
 * elevation from the DEM atlas, so unlike a billboard with only four corners
 * the terrain never pokes through from the inside.
 *
 * The step is aimed at half the node spacing of the terrain mesh. In theory,
 * splitting to match the nodes themselves would be best, but a quad is a
 * rotated rectangle, so cutting it along the grid produces trapezoids. With a
 * half step, the amount by which a chord dips below the terrain inside a cell
 * drops to about 1/4 of the node-aligned case and falls within the depth bias
 * (`TERRAIN_DEPTH_BIAS`) applied to the whole frame.
 *
 * There is an upper limit on the total number of cells. This is so that the
 * cost does not diverge even for a huge quad that covers a whole country;
 * when the limit is hit, the caller reports the coarsening factor via
 * `reportTerrainCoarsening` and the depth bias grows by the same amount (it
 * rides directly on the same mechanism as the subdivision of polygons and
 * lines).
 */

/** The maximum number of divisions per side */
export const QUAD_GRID_MAX_DIVISIONS = 128;

/** The upper limit on the total number of cells */
export const QUAD_GRID_MAX_CELLS = 16384;

/** The target step relative to the terrain mesh node spacing (half the fineness) */
const QUAD_GRID_STEP_RATIO = 0.5;

/** The number of divisions of the subdivision */
export interface QuadGridSize {
  /** The number of divisions in the u direction (top-left -> top-right) */
  readonly nx: number;
  /** The number of divisions in the v direction (top-left -> bottom-left) */
  readonly ny: number;
  /**
   * The coarseness of the actual step relative to the terrain mesh node spacing
   * (1 = same as the nodes)
   */
  readonly coarsening: number;
}

/**
 * Decides the number of divisions
 *
 * @param quad The four corners in Mercator coordinates (x, y in the order top-left, top-right,
 *   bottom-right, bottom-left)
 * @param stepGrid The node spacing of the terrain mesh (Mercator). No subdivision if 0 or less
 * @param stepRatio The target step relative to `stepGrid` (half of it on terrain; the globe
 *   passes 1 to cut at its cell, `view/globe-subdivision.ts`)
 */
export function computeQuadGridSize(
  quad: ArrayLike<number>,
  stepGrid: number,
  stepRatio = QUAD_GRID_STEP_RATIO,
): QuadGridSize {
  if (!(stepGrid > 0)) return { nx: 1, ny: 1, coarsening: 1 };

  const lengthU = Math.max(edgeLength(quad, 0, 1), edgeLength(quad, 3, 2));
  const lengthV = Math.max(edgeLength(quad, 0, 3), edgeLength(quad, 1, 2));
  const target = stepGrid * stepRatio;

  let nx = clampDivisions(Math.ceil(lengthU / target));
  let ny = clampDivisions(Math.ceil(lengthV / target));

  if (nx * ny > QUAD_GRID_MAX_CELLS) {
    const scale = Math.sqrt(QUAD_GRID_MAX_CELLS / (nx * ny));
    nx = Math.max(1, Math.floor(nx * scale));
    ny = Math.max(1, Math.floor(ny * scale));
  }

  const coarsening = Math.max(1, lengthU / nx / stepGrid, lengthV / ny / stepGrid);
  return { nx, ny, coarsening };
}

/**
 * The subdivided grid (absolute coordinates; subtracting the per-frame center
 * is done by the caller)
 */
export interface QuadGridGeometry {
  /** The WGS84 coordinates of the vertices (a sequence of [lng, lat]; kept at 64-bit) */
  readonly lngLat: Float64Array;
  /** The texture coordinates of the vertices */
  readonly texCoords: Float32Array;
  /** The triangle indices */
  readonly indices: Uint16Array;
  /** The number of vertices */
  readonly vertexCount: number;
}

/**
 * Builds a grid by subdividing the four corners
 *
 * The interpolation is done on the Mercator plane. The interpolation of the
 * texture coordinates when the GPU draws the four-corner billboard is also
 * linear on the Mercator plane, so the appearance does not change when
 * subdivided (interpolating on the lng/lat plane would introduce a slight
 * stretch in the latitude direction).
 *
 * @param quad The four corners in Mercator coordinates (x, y in the order top-left, top-right,
 *   bottom-right, bottom-left)
 */
export function buildQuadGrid(quad: ArrayLike<number>, nx: number, ny: number): QuadGridGeometry {
  const cols = nx + 1;
  const rows = ny + 1;
  const vertexCount = cols * rows;

  const lngLat = new Float64Array(vertexCount * 2);
  const texCoords = new Float32Array(vertexCount * 2);

  for (let j = 0; j < rows; j++) {
    const v = j / ny;
    for (let i = 0; i < cols; i++) {
      const u = i / nx;
      // Bilinear interpolation (a = top-left, b = top-right, c = bottom-right, d = bottom-left)
      const wa = (1 - u) * (1 - v);
      const wb = u * (1 - v);
      const wc = u * v;
      const wd = (1 - u) * v;
      const x = wa * quad[0] + wb * quad[2] + wc * quad[4] + wd * quad[6];
      const y = wa * quad[1] + wb * quad[3] + wc * quad[5] + wd * quad[7];

      const at = (j * cols + i) * 2;
      lngLat[at] = x * 360 - 180;
      lngLat[at + 1] = latFromMercatorY(y);
      texCoords[at] = u;
      texCoords[at + 1] = v;
    }
  }

  const indices = new Uint16Array(nx * ny * 6);
  let k = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const topLeft = j * cols + i;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + cols;
      const bottomRight = bottomLeft + 1;
      indices[k++] = topLeft;
      indices[k++] = bottomLeft;
      indices[k++] = bottomRight;
      indices[k++] = topLeft;
      indices[k++] = bottomRight;
      indices[k++] = topRight;
    }
  }

  return { lngLat, texCoords, indices, vertexCount };
}

/** Mercator y -> latitude */
function latFromMercatorY(y: number): number {
  const n = Math.PI - 2 * Math.PI * y;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** The distance between two of the four corners (Mercator) */
function edgeLength(quad: ArrayLike<number>, from: number, to: number): number {
  const dx = quad[to * 2] - quad[from * 2];
  const dy = quad[to * 2 + 1] - quad[from * 2 + 1];
  return Math.hypot(dx, dy);
}

/** Clamps the number of divisions into 1..the upper limit */
function clampDivisions(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(QUAD_GRID_MAX_DIVISIONS, Math.round(value));
}
