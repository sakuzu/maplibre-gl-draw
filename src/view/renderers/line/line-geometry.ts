// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The vertex data of the SDF line renderer (pure functions, no GL)
 *
 * The strip vertices shared by all instances, the coordinate texels and per-segment instances
 * of a line, the instance color, and the number of subdivisions of a segment on terrain.
 * Immediate mode and retained mode build their data with the same functions.
 */

import { EARTH } from '../../../shared/math/constants.js';
import type { PixelRatioInput } from '../../../shared/utils/pixel-ratio.js';
import { resolveContentPixelRatio, resolvePixelRatio } from '../../../shared/utils/pixel-ratio.js';
import { globeGridOf } from '../../globe-subdivision.js';
import { calculateLngLatOffset } from '../../shaders/helpers.js';
import type { TerrainContext } from '../../terrain/context.js';
import type { Color, LineBatchItem } from './line-types.js';

// The stride of the instance data (floats per instance)
// indices(4) + extra(4) + color(4) = 12 floats
export const INSTANCE_STRIDE = 12;
export const INSTANCE_BYTES = INSTANCE_STRIDE * 4;

/**
 * The upper bound on subdivision points
 *
 * When terrain is enabled, a single segment is split into at most this many parts to draw it.
 * A long straight line with only two vertices (34km as measured) sinks into the terrain
 * between subdivision points when split coarsely, so the line looks broken up like a dashed
 * line. The upper bound was decided from that (34km / 512 = 66m, which lands at the same
 * granularity as the subdivision step).
 * The vertex buffer of the strip statically holds this upper bound, but (512+1)*2 vertices =
 * 4KB, so it is negligible as a resource. The number of vertices actually drawn is determined
 * from u_stations every time.
 */
export const MAX_LINE_STATIONS = 512;

/**
 * A guideline for how many post-split segments a single draw call may produce (a guard against
 * a vertex-count blow-up)
 *
 * The number of subdivisions is determined by the longest segment in the batch, so a single
 * long line mixed into a batch full of short lines makes the whole batch use the maximum
 * subdivision. This caps that.
 */
export const LINE_STATION_BUDGET = 500_000;

/**
 * The strip vertices shared by all instances (side, station)
 *
 * side: 1=left, -1=right / station: the index of the subdivision point along the segment
 *
 * On terrain, a segment sinks into valleys unless it is subdivided. Here the subdivision is
 * expressed as "the station index in the vertex buffer plus the vertex count at draw time".
 * Neither the coordinate texture of the segment nor the instance array is touched, so both
 * retained batches and the partial update for a vertex drag (patchRetainedBatchCoords) keep
 * working as they are.
 *
 * With u_stations = 1, drawing only 4 vertices gives stations 0,0,1,1, which is exactly the
 * same triangle strip as before terrain was introduced.
 */
// biome-ignore format: an array of vertex data
export const STATION_VERTICES = (() => {
  const data = new Float32Array((MAX_LINE_STATIONS + 1) * 2 * 2);
  for (let s = 0; s <= MAX_LINE_STATIONS; s++) {
    data[s * 4 + 0] = 1;  // left
    data[s * 4 + 1] = s;
    data[s * 4 + 2] = -1; // right
    data[s * 4 + 3] = s;
  }
  return data;
})();

/**
 * The instance array and coordinate texture data of a batch
 *
 * @internal
 */
export interface LineBatchArrays {
  texData: Float32Array;
  texSize: number;
  instanceData: Float32Array;
  instanceCount: number;
  /**
   * The length of the longest segment in the batch (meters, approximate)
   *
   * The basis for how many parts one segment is split into on terrain. It is a camera-
   * independent value, so it can also be baked into a retained batch.
   */
  maxSegmentMeters: number;
  /**
   * The length of the longest segment in the batch on the Mercator plane (world units, 1 =
   * the world)
   *
   * The basis for how many parts one segment is split into on the globe. It is camera-
   * independent as well.
   */
  maxSegmentMercator: number;
}

/**
 * Computes the color to pass as an instance attribute
 *
 * The fragment shader multiplies every color component by the coverage before output
 * (premultiplied alpha), so the opacity is folded into every component and not just alpha.
 * This gives the same composited result as the previous `u_color * (coverage * u_opacity)`.
 *
 * @internal
 */
export function toLineInstanceColor(color: Color, opacity: number): Color {
  const o = Number.isFinite(opacity) ? Math.min(Math.max(opacity, 0), 1) : 1;
  return [color[0] * o, color[1] * o, color[2] * o, color[3] * o];
}

/**
 * A Float32Array of at least `length` elements: the array itself when it is long enough,
 * otherwise a new one of the next power of two
 *
 * @internal
 */
export function growFloat32(
  array: Float32Array<ArrayBuffer>,
  length: number,
): Float32Array<ArrayBuffer> {
  if (array.length >= length) return array;
  let size = 64;
  while (size < length) size *= 2;
  return new Float32Array(size);
}

/**
 * Rounds the origin of the relative coordinates to Float32
 *
 * u_center_lnglat, which is passed to the shader, is Float32, so the CPU-side subtraction uses
 * the same rounded value to stay consistent (the same treatment as calculateOffsetUniforms).
 *
 * @internal
 */
export function normalizeOrigin(origin: [number, number]): [number, number] {
  return [Math.fround(origin[0]), Math.fround(origin[1])];
}

/**
 * The default origin coordinate of a line batch (the first coordinate of the first item)
 *
 * @internal
 */
export function defaultLineOrigin(items: LineBatchItem[]): [number, number] {
  const first = items[0]?.coords[0];
  return first ? [first[0], first[1]] : [0, 0];
}

/**
 * Builds the coordinate texture and instance array of a line batch (a pure transformation)
 *
 * Shared between immediate mode (drawAll) and retained mode (buildRetainedBatch). Coordinates
 * are stored as values relative to `origin`, so fixing `origin` makes the result independent
 * of the camera.
 *
 * @param zoom The zoom used to compute the cumulative distance (for dashes; the zoom at draw
 *   time for a dashed line, since the distance is in px at that zoom)
 * @param origin The origin of the relative coordinates
 * @param pixelRatio The injected rendering ratio (read from window each time when unspecified)
 *
 * @internal
 */
export function buildLineBatchArrays(
  items: LineBatchItem[],
  zoom: number,
  origin: [number, number],
  pixelRatio?: PixelRatioInput,
): LineBatchArrays | null {
  // Get the rendering ratio (to convert CSS pixels into physical pixels)
  //
  // The ratio is chosen by the sign of the width (the "two ratios" in
  // shared/utils/pixel-ratio.ts). A negative value = a width fixed in screen pixels uses the
  // ratio that includes renderScale; a positive value = a width that the shader scales by
  // 2^(u_zoom - createdZoom) uses the ratio without renderScale applied.
  const screenDpr = resolvePixelRatio(pixelRatio);
  const contentDpr = resolveContentPixelRatio(pixelRatio);

  // Compute the total number of coordinates
  let totalCoords = 0;
  for (const item of items) {
    totalCoords += item.coords.length;
  }

  if (totalCoords < 2) return null;

  // The texture size
  const texSize = Math.max(2, Math.ceil(Math.sqrt(totalCoords)));

  // The texture data (stores the relative coordinates)
  const texData = new Float32Array(texSize * texSize * 4);
  let coordOffset = 0;
  for (const item of items) {
    writeLineCoordTexels(texData, coordOffset, item.coords, origin);
    coordOffset += item.coords.length;
  }

  // Generate the instance data
  // 12 floats per instance: indices(4) + extra(4) + color(4)
  let totalInstances = 0;
  for (const item of items) {
    totalInstances += item.coords.length - 1;
  }

  const instanceData = new Float32Array(totalInstances * INSTANCE_STRIDE);
  let instanceIdx = 0;
  let maxSegmentMeters = 0;
  coordOffset = 0;

  for (const item of items) {
    const n = item.coords.length;
    const meters = writeLineInstances(instanceData, instanceIdx, coordOffset, item.coords, {
      closed: item.closed,
      zoom,
      dashPixelRatio: screenDpr,
      // a_extra.y: the original line width (physical pixels)
      strokeWidth: item.strokeWidth * (item.strokeWidth < 0 ? screenDpr : contentDpr),
      createdZoom: item.createdZoom,
      color: toLineInstanceColor(item.color, item.opacity),
    });
    if (meters > maxSegmentMeters) maxSegmentMeters = meters;

    instanceIdx += n - 1;
    coordOffset += n;
  }

  return {
    texData,
    texSize,
    instanceData,
    instanceCount: totalInstances,
    maxSegmentMeters,
    maxSegmentMercator: maxInstanceSegmentMercator(instanceData, totalInstances, zoom, screenDpr),
  };
}

/**
 * The length of the longest segment of written instances on the Mercator plane (world units)
 *
 * The instances carry the length of each segment on screen at `zoom` (a_extra.w, in drawing-
 * buffer px), which is the length on the Mercator plane times the size of the world in those
 * px, so nothing is measured again.
 *
 * @param instanceData The instances written by {@link writeLineInstances}
 * @param instanceCount The number of instances to look at
 * @param zoom The zoom the lengths were written at
 * @param dashPixelRatio The ratio the lengths were written with
 *
 * @internal
 */
export function maxInstanceSegmentMercator(
  instanceData: Float32Array,
  instanceCount: number,
  zoom: number,
  dashPixelRatio: number,
): number {
  let max = 0;
  for (let i = 0; i < instanceCount; i++) {
    const length = instanceData[i * INSTANCE_STRIDE + 7];
    if (length > max) max = length;
  }
  const world = WORLD_TILE_SIZE * 2 ** zoom * dashPixelRatio;
  return world > 0 ? max / world : 0;
}

/**
 * Lines packed by the caller into typed arrays (the counterpart of an array of `LineBatchItem`
 * without an array per line). Every line is open (not closed)
 *
 * @internal
 */
export interface PackedLineItems {
  /** The number of lines */
  count: number;
  /** The coordinate buffer the lines are read from (interleaved) */
  coords: Float64Array;
  /** The number of values per coordinate in `coords` (2 or 3; the third is skipped) */
  stride: number;
  /** The first coordinate of each line */
  start: Int32Array;
  /** The end (exclusive) of each line */
  end: Int32Array;
  /** The width of each line in CSS px, with the sign convention of `LineBatchItemBase` */
  strokeWidth: Float64Array;
  /** The createdZoom of each line */
  createdZoom: Float64Array;
  /** The instance color of each line (`toLineInstanceColor`), 4 values per line */
  color: Float64Array;
}

/**
 * Builds the coordinate texture and instance array of packed lines
 *
 * It writes exactly what `buildLineBatchArrays` writes for the same lines (the same arithmetic in
 * the same order), so the two paths draw the same picture.
 *
 * @internal
 */
export function buildPackedLineBatchArrays(
  lines: PackedLineItems,
  zoom: number,
  origin: [number, number],
  pixelRatio?: PixelRatioInput,
): LineBatchArrays | null {
  const screenDpr = resolvePixelRatio(pixelRatio);
  const contentDpr = resolveContentPixelRatio(pixelRatio);
  const { count, coords, stride, start, end } = lines;

  let totalCoords = 0;
  let totalInstances = 0;
  for (let i = 0; i < count; i++) {
    totalCoords += end[i] - start[i];
    totalInstances += end[i] - start[i] - 1;
  }
  if (totalCoords < 2) return null;

  const texSize = Math.max(2, Math.ceil(Math.sqrt(totalCoords)));
  const texData = new Float32Array(texSize * texSize * 4);
  let coordOffset = 0;
  for (let i = 0; i < count; i++) {
    for (let v = start[i]; v < end[i]; v++) {
      texData[coordOffset * 4] = coords[v * stride] - origin[0];
      texData[coordOffset * 4 + 1] = coords[v * stride + 1] - origin[1];
      coordOffset++;
    }
  }

  const instanceData = new Float32Array(totalInstances * INSTANCE_STRIDE);
  let instanceIdx = 0;
  let maxSegmentMeters = 0;
  coordOffset = 0;
  for (let i = 0; i < count; i++) {
    const first = start[i];
    const n = end[i] - first;
    const width = lines.strokeWidth[i];
    const strokeWidth = width * (width < 0 ? screenDpr : contentDpr);
    const createdZoom = lines.createdZoom[i];
    const c = i * 4;
    let linesofar = 0;
    for (let k = 0; k < n - 1; k++) {
      const ax = coords[(first + k) * stride];
      const ay = coords[(first + k) * stride + 1];
      const bx = coords[(first + k + 1) * stride];
      const by = coords[(first + k + 1) * stride + 1];
      const segmentLength = screenPixelDistanceXY(ax, ay, bx, by, zoom) * screenDpr;
      const meters = segmentMetersXY(ax, ay, bx, by);
      if (meters > maxSegmentMeters) maxSegmentMeters = meters;

      const base = (instanceIdx + k) * INSTANCE_STRIDE;
      instanceData[base + 0] = coordOffset + k;
      instanceData[base + 1] = coordOffset + k + 1;
      instanceData[base + 2] = k > 0 ? coordOffset + k - 1 : -1;
      instanceData[base + 3] = k + 1 < n - 1 ? coordOffset + k + 2 : -1;
      instanceData[base + 4] = linesofar;
      instanceData[base + 5] = strokeWidth;
      instanceData[base + 6] = createdZoom;
      instanceData[base + 7] = segmentLength;
      instanceData[base + 8] = lines.color[c];
      instanceData[base + 9] = lines.color[c + 1];
      instanceData[base + 10] = lines.color[c + 2];
      instanceData[base + 11] = lines.color[c + 3];
      linesofar += segmentLength;
    }
    instanceIdx += n - 1;
    coordOffset += n;
  }

  return {
    texData,
    texSize,
    instanceData,
    instanceCount: totalInstances,
    maxSegmentMeters,
    maxSegmentMercator: maxInstanceSegmentMercator(instanceData, totalInstances, zoom, screenDpr),
  };
}

/**
 * Writes the coordinates of one line into coordinate texels, as offsets from `origin`
 *
 * Each coordinate takes one RGBA texel starting at `coordOffset`: x = dLng, y = dLat (the
 * offset from the origin computed at 64-bit precision). z and w are not written.
 *
 * @internal
 */
export function writeLineCoordTexels(
  target: Float32Array,
  coordOffset: number,
  coords: ReadonlyArray<[number, number]>,
  origin: [number, number],
): void {
  for (let i = 0; i < coords.length; i++) {
    // Compute the offset from the origin at 64-bit precision
    const offset = calculateLngLatOffset(coords[i], origin);
    target[(coordOffset + i) * 4] = offset[0]; // dLng (relative coordinate)
    target[(coordOffset + i) * 4 + 1] = offset[1]; // dLat (relative coordinate)
  }
}

/**
 * The per-line values written into every instance of one line
 *
 * @internal
 */
export interface LineInstanceParams {
  /** Whether the line is a closed path (the first and last segments join) */
  closed: boolean;
  /** The zoom used to compute the cumulative distance (for dashes) */
  zoom: number;
  /**
   * Drawing-buffer px per CSS px for the cumulative distance (for dashes)
   *
   * The ratio of dimensions fixed on screen (`resolvePixelRatio`), the same one the dash
   * pattern is scaled by, so a dash stays at its length in CSS px.
   */
  dashPixelRatio: number;
  /** a_extra.y: the original line width (physical pixels; see LineBatchItemBase) */
  strokeWidth: number;
  /** a_extra.z: createdZoom */
  createdZoom: number;
  /** a_color: the instance color (opacity already folded in) */
  color: Color;
}

/**
 * Writes the instances (one per segment) of one line
 *
 * 12 floats per instance: indices(4) + extra(4) + color(4). The indices point into the
 * coordinate texels of the line, which start at `coordOffset`; the previous and next indices
 * wrap around on a closed line and are -1 at the ends of an open one.
 *
 * @param instanceStart The index of the first instance of the line in `target`
 * @returns The length of the longest segment of the line (meters, approximate)
 *
 * @internal
 */
export function writeLineInstances(
  target: Float32Array,
  instanceStart: number,
  coordOffset: number,
  coords: ReadonlyArray<[number, number]>,
  params: LineInstanceParams,
): number {
  const n = coords.length;
  const { color } = params;
  let linesofar = 0;
  let maxSegmentMeters = 0;

  for (let i = 0; i < n - 1; i++) {
    const startIdx = coordOffset + i;
    const endIdx = coordOffset + i + 1;
    const prevIdx = i > 0 ? coordOffset + i - 1 : params.closed ? coordOffset + n - 2 : -1;
    const nextIdx = i + 1 < n - 1 ? coordOffset + i + 2 : params.closed ? coordOffset + 1 : -1;

    // The segment length on screen, in drawing-buffer px: the same unit as the screen length
    // the vertex shader adds inside a segment and as the dash pattern (resolveDashUniform)
    const segmentLength =
      screenPixelDistance(coords[i], coords[i + 1], params.zoom) * params.dashPixelRatio;

    const meters = segmentMeters(coords[i], coords[i + 1]);
    if (meters > maxSegmentMeters) maxSegmentMeters = meters;

    const base = (instanceStart + i) * INSTANCE_STRIDE;
    target[base + 0] = startIdx;
    target[base + 1] = endIdx;
    target[base + 2] = prevIdx;
    target[base + 3] = nextIdx;
    target[base + 4] = linesofar; // a_extra.x: the starting cumulative distance (buffer px)
    target[base + 5] = params.strokeWidth; // a_extra.y: the original line width (px)
    target[base + 6] = params.createdZoom; // a_extra.z: createdZoom
    target[base + 7] = segmentLength; // a_extra.w: the segment length (buffer px)
    target[base + 8] = color[0]; // a_color.r
    target[base + 9] = color[1]; // a_color.g
    target[base + 10] = color[2]; // a_color.b
    target[base + 11] = color[3]; // a_color.a

    linesofar += segmentLength;
  }

  return maxSegmentMeters;
}

/**
 * The side of the Web Mercator world at zoom 0, in CSS px
 *
 * maplibre lays the world out on 512 px tiles, so the world is `512 * 2^zoom` CSS px wide.
 *
 * @internal
 */
export const WORLD_TILE_SIZE = 512;

/**
 * The distance between two points on a flat Web Mercator map, in CSS px at `zoom`
 *
 * The projection stretches the latitude by 1 / cos(latitude) exactly as it stretches the
 * longitude, so a length measured here is the same number of px on screen at any latitude.
 * It is exact for an untilted Mercator view; a tilted or globe view shrinks the far side, and
 * the vertex shader measures that part itself.
 *
 * @internal
 */
export function screenPixelDistance(
  a: readonly [number, number],
  b: readonly [number, number],
  zoom: number,
): number {
  return screenPixelDistanceXY(a[0], a[1], b[0], b[1], zoom);
}

/**
 * {@link screenPixelDistance} with the coordinates as separate numbers
 *
 * @internal
 */
export function screenPixelDistanceXY(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  zoom: number,
): number {
  const world = WORLD_TILE_SIZE * 2 ** zoom;
  const dx = ((bx - ax) / 360) * world;
  const dy = (mercatorY(by) - mercatorY(ay)) * world;
  return Math.sqrt(dx * dx + dy * dy);
}

/** The Web Mercator y of a latitude, in world units (the world is 1 wide) */
function mercatorY(lat: number): number {
  const latRad = (lat * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / (2 * Math.PI);
}

/**
 * The distance between two points (meters, planar approximation)
 *
 * An approximation used only to decide the number of terrain subdivisions.
 *
 * @internal
 */
export function segmentMeters(a: [number, number], b: [number, number]): number {
  return segmentMetersXY(a[0], a[1], b[0], b[1]);
}

/**
 * {@link segmentMeters} with the coordinates as separate numbers
 *
 * @internal
 */
export function segmentMetersXY(ax: number, ay: number, bx: number, by: number): number {
  const midLatRad = (((ay + by) / 2) * Math.PI) / 180;
  const dx = (bx - ax) * EARTH.METERS_PER_DEGREE * Math.cos(midLatRad);
  const dy = (by - ay) * EARTH.METERS_PER_DEGREE;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Whether the stations of the segments are placed along the Mercator plane (the globe) rather
 * than along the degrees (the terrain)
 *
 * On the terrain the stations follow the mesh of the ground, in degrees as before. On the
 * globe they follow the straight line of the Mercator plane, the path maplibre draws an edge
 * along (`view/globe-subdivision.ts`).
 *
 * @internal
 */
export function lineStationsOnMercatorPlane(context: TerrainContext): boolean {
  return !isTerrainStationActive(context) && globeGridOf(context, 'line') > 0;
}

/** Whether the terrain decides the stations (the terrain is drawn with a step) */
function isTerrainStationActive(context: TerrainContext): boolean {
  const terrain = context.renderState;
  return terrain.active && terrain.stepMeters > 0;
}

/**
 * Decides how many parts one segment is split into when drawn on terrain or on the globe
 *
 * On a flat map without terrain it always returns 1 (= the same 4-vertex strip as before).
 * The terrain splits by its step in meters; the globe, when there is no terrain, by the line
 * cell of maplibre's granularity on the Mercator plane.
 *
 * @param maxSegmentMercator The longest segment on the Mercator plane (world units; only the
 *   globe reads it)
 *
 * @internal
 */
export function resolveLineStations(
  context: TerrainContext,
  maxSegmentMeters: number,
  instanceCount: number,
  maxSegmentMercator = 0,
): number {
  let wanted: number;
  if (isTerrainStationActive(context)) {
    if (!(maxSegmentMeters > 0)) return 1;
    wanted = Math.ceil(maxSegmentMeters / context.renderState.stepMeters);
  } else {
    const grid = globeGridOf(context, 'line');
    if (!(grid > 0) || !(maxSegmentMercator > 0)) return 1;
    wanted = Math.ceil(maxSegmentMercator / grid);
  }

  let stations = Math.min(MAX_LINE_STATIONS, wanted);
  if (stations <= 1) return 1;

  // Stop the vertex count from blowing up (a single long segment mixed in would otherwise
  // make the whole batch use the maximum subdivision)
  if (instanceCount > 0) {
    const budget = Math.max(1, Math.floor(LINE_STATION_BUDGET / instanceCount));
    stations = Math.min(stations, budget);
  }
  return Math.max(1, stations);
}
