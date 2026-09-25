// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Deciding whether a symbol is occluded by the terrain (whether to ghost it)
 *
 * Points, icons and billboard labels are drawn without a depth test. A billboard's front/back
 * order is decided by the depth of its single center point, so enabling depth makes the whole
 * thing disappear as soon as it sinks a few meters into the ground (confirmed by measurement).
 * On the other hand, a symbol behind a mountain stays clearly visible, which is misread as
 * "being in front". So what is occluded is drawn faintly (a CesiumJS-style ghost).
 *
 * The test runs on the CPU. The segment drawn from the camera to the anchor is sampled, and if
 * the ground elevation along the way rises above the segment it is occluded. Fetching a single
 * elevation takes about 0.4us, so 24 samples along the segment cost about 10us per anchor,
 * which is enough. Solving it on the GPU would mean ray marching in the fragment shader, whose
 * cost per symbol is far larger.
 *
 * Reading the depth buffer (MapLibre's `terrain.depthAtPoint`) is not an option: `readPixels`
 * runs for every single point, which inserts a synchronous wait and stalls rendering once per
 * symbol.
 */

import { drawnLongitude } from './anchor.js';
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
  const node = context.renderState.stepGrid > 0 ? context.renderState.stepGrid : horizontal / 16;
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
