// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Position computation for UI anchors (the single source for rendering and hit testing)
 *
 * When the terrain is enabled, the position of "UI decided by a single point" such as points,
 * vertex handles, midpoint handles, scale handles and rotation handles necessarily disagrees
 * unless the following two things are upheld.
 *
 * 1. An anchor is "longitude/latitude + ground elevation" (longitude/latitude alone drops it
 *    to sea level 0)
 * 2. Rendering and hit testing share the result of putting the same elevation through the same
 *    projection
 *
 * Previously 2 was not upheld. The vertex shader looked the elevation up in the DEM atlas
 * while hit testing called MapLibre's `map.project`. With two sources, fixing only one of them
 * lets the problem come back. So this module was made the single source, in the following
 * shape.
 *
 * - The hit testing side arrives here through the injection point in `shared/math/transform.ts`
 * - The rendering side has the point renderer receive the elevation computed here as a vertex
 *   attribute
 *
 * Both the elevation value and the projection formula become single, so they agree
 * structurally.
 *
 * The source of the elevation is the surface MapLibre draws: `map.queryTerrainElevation`,
 * which samples the terrain tile drawn at the point (`ground.ts`). `map.project` reads the same
 * function, and the value includes the exaggeration. It is a different path from the DEM atlas
 * and the drape (the GPU-side elevation used by polygons and lines), but those read the same
 * DEM textures with the same placement (`upstream-terrain.ts`), so they agree; the end-to-end test
 * `src/e2e/terrain.e2e.test.ts` holds all of them to `map.queryTerrainElevation`. For anchors
 * alone the CPU-side value is authoritative and is handed to the GPU.
 *
 * The projection formula is a copy of the vertex shader's (OFFSET_MODE_GLSL in
 * `shaders/helpers.ts`). It goes through the same branch, including the condition for
 * switching to offset mode (zoom >= 12). The lift (liftMeters) is not added. That exists for
 * rendering reasons, to avoid Z-fighting with the terrain mesh; anchors are drawn without a
 * depth test so they do not need it, and adding it would make them disagree with
 * `map.project`.
 *
 * `map.project` itself is not used for hit testing, although with the same elevation it lands
 * within hundredths of a pixel of this projection. Hit testing must follow what the shader
 * draws, and `map.project` is fast only where a drawn tile covers the point: measured on
 * maplibre 6.11.1 with 10 000 points it takes 2.6 ms (pitch 0) to 4.2 ms (pitch 60) inside
 * the view, but 36 to 46 us a point outside it, where it walks the covering tiles for every
 * call. Hit testing and bounding boxes project vertices outside the view, so that would stall.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';

import {
  type AnchorProjector,
  type ScreenPoint,
  setAnchorProjector,
} from '../../shared/math/index.js';
import { nearestLongitude } from '../../shared/math/longitude.js';
import type { OffsetUniforms } from '../shaders/helpers.js';
import { INACTIVE_ANCHOR_FRAME, type TerrainContext } from './context.js';
import { getRenderableTerrainTiles, type TerrainLike } from './detect.js';
import { groundElevationMeters, type TerrainElevationQuery } from './ground.js';

/**
 * The zoom at which offset mode is switched on
 *
 * It must be the same value as the check on the vertex shader side (each renderer raises
 * u_use_offset_mode at `zoom >= 12`).
 */
const OFFSET_MODE_MIN_ZOOM = 12;

/**
 * Returns a number that changes whenever the elevations {@link anchorElevationMeters} returns
 * may have changed (the DEM coverage changed).
 *
 * Compare it between frames to know when positions baked with elevations must be rebuilt.
 *
 * @param context The terrain state of the draw instance
 * @returns The generation number
 */
export function getAnchorElevationGeneration(context: TerrainContext): number {
  return context.elevationGeneration;
}

/**
 * Advances the generation by looking at whether the DEM coverage changed
 *
 * The comparison uses a string listing the identifiers of the tile set. The number of tiles
 * per frame is a few dozen, so building it every frame is negligible.
 */
function syncCoverage(context: TerrainContext, terrain: TerrainLike | null): void {
  const changed = terrain
    ? context.coverage.update(getRenderableTerrainTiles(terrain))
    : context.coverage.clear();
  if (changed) context.elevationGeneration++;
}

/**
 * Establishes the anchor projection for this frame (custom-layer calls it every frame)
 *
 * When the terrain is disabled, call `clearAnchorFrame` instead.
 */
export function setAnchorFrame(
  context: TerrainContext,
  options: {
    terrain: TerrainLike | null;
    /**
     * The map the ground elevation is asked from (`map.queryTerrainElevation`). Without it the
     * elevation of the current zoom level is used
     */
    elevationQuery?: TerrainElevationQuery | null;
    zoom: number;
    elevationScale: number;
    mainMatrix: number[];
    offsetUniforms: OffsetUniforms;
    width: number;
    height: number;
    /** Camera position (Mercator). null when it cannot be obtained */
    cameraMercator?: readonly [number, number, number] | null;
  },
): void {
  const { terrain, zoom, elevationScale, mainMatrix, offsetUniforms, width, height } = options;

  context.anchorFrame = {
    terrain,
    elevationQuery: options.elevationQuery ?? null,
    tileZoom: Math.floor(zoom),
    elevationScale,
    mainMatrix,
    offsetUniforms,
    useOffsetMode: zoom >= OFFSET_MODE_MIN_ZOOM,
    width,
    height,
    cameraMercator: options.cameraMercator ?? null,
  };

  context.elevationCache.clear();
  context.occlusionCache.clear();
  syncCoverage(context, terrain);
}

/**
 * Returns the anchor projection to the inactive state (a frame with no terrain, or when the
 * layer is destroyed)
 *
 * From then on `projectAnchor` returns null and hit testing falls back to MapLibre's project
 * (exactly the same path as before the terrain was introduced).
 */
export function clearAnchorFrame(context: TerrainContext): void {
  context.anchorFrame = INACTIVE_ANCHOR_FRAME;
  if (context.elevationCache.size > 0) context.elevationCache = new Map();
  if (context.occlusionCache.size > 0) context.occlusionCache = new Map();
  syncCoverage(context, null);
}

/**
 * Whether the anchor is active (the terrain is enabled and the frame state is established)
 *
 * @internal
 */
export function isAnchorActive(context: TerrainContext): boolean {
  const frame = context.anchorFrame;
  return frame.terrain !== null && frame.mainMatrix !== null;
}

/**
 * Returns the ground elevation of a point in meters, as the terrain of the current frame
 * gives it (exaggeration included).
 *
 * Where the terrain is drawn this is the value of `map.queryTerrainElevation`, the elevation
 * of the surface maplibre draws. Outside the drawn tiles it is read from the DEM tile of the
 * current zoom level, which is cheaper and may differ slightly (nothing is drawn there).
 * Values are cached for the frame; when the drawn tiles change,
 * {@link getAnchorElevationGeneration} advances.
 *
 * Inside a plugin, prefer `PluginContext.anchorElevationMeters`, which is bound to the draw
 * instance.
 *
 * @param context The terrain state of the draw instance
 * @param lng The longitude in degrees
 * @param lat The latitude in degrees
 * @returns The elevation in meters. 0 when the terrain is disabled (0 means "add no
 *   elevation")
 */
export function anchorElevationMeters(context: TerrainContext, lng: number, lat: number): number {
  const frame = context.anchorFrame;
  const terrain = frame.terrain;
  if (!terrain) return 0;

  const key = `${lng},${lat}`;
  const cached = context.elevationCache.get(key);
  if (cached !== undefined) return cached;

  const elevation = groundElevationMeters(
    frame.elevationQuery,
    terrain,
    context.coverage,
    drawnLongitude(context, lng),
    lat,
    frame.tileZoom,
  );
  context.elevationCache.set(key, elevation);
  return elevation;
}

/**
 * The longitude of the copy of the world a point is drawn on: the copy nearest to the camera
 * (across the antimeridian the view draws the other side as a second copy)
 *
 * @internal
 */
export function drawnLongitude(context: TerrainContext, lng: number): number {
  const offsetUniforms = context.anchorFrame.offsetUniforms;
  return offsetUniforms ? nearestLongitude(lng, offsetUniforms.centerLngLat64[0]) : lng;
}

/**
 * Maps an anchor (longitude/latitude + ground elevation) to screen coordinates
 *
 * It goes through the same branch, the same matrix and the same elevation as the vertex
 * shader. It returns null when the terrain is disabled or the frame state has not been
 * established (the caller then falls back to MapLibre's project).
 *
 * The context is that of the draw instance whose map the point is projected onto, so several
 * rendering instances on a page (the screen + a thumbnail + a preview + printing) are
 * never mixed up.
 *
 * @internal
 */
export function projectAnchor(
  context: TerrainContext,
  lng: number,
  lat: number,
): ScreenPoint | null {
  const frame = context.anchorFrame;
  if (!frame.mainMatrix || !frame.terrain) return null;
  return projectAnchorAt(context, lng, lat, anchorElevationMeters(context, lng, lat));
}

/**
 * Maps a position at a given elevation to screen coordinates, with the projection of
 * {@link projectAnchor}
 *
 * Something drawn flat at one elevation, such as the frame of a selected point at the
 * elevation of the point, is projected with this so that it lands where the shader draws it.
 *
 * @param elevationMeters The elevation in meters (the exaggeration included, as
 *   {@link anchorElevationMeters} gives it)
 * @returns null when the terrain is disabled, the frame state has not been established or the
 *   position is behind the camera
 * @internal
 */
export function projectAnchorAt(
  context: TerrainContext,
  lng: number,
  lat: number,
  elevationMeters: number,
): ScreenPoint | null {
  const frame = context.anchorFrame;
  const { mainMatrix: m, offsetUniforms, terrain, width, height } = frame;
  if (!m || !terrain || width <= 0 || height <= 0) return null;

  const elevationMercator = elevationMeters * frame.elevationScale;
  // The anchor is projected on the copy of the world it is drawn on
  const drawnLng = drawnLongitude(context, lng);

  let clipX: number;
  let clipY: number;
  let clipW: number;

  if (frame.useOffsetMode && offsetUniforms) {
    // Offset mode: linearize relative to the center
    // (the same formula as project_offset_to_clipspace in the shader)
    const { centerLngLat, projectionCenter, unitsPerDegree, unitsPerDegree2 } = offsetUniforms;
    const lngOffset = drawnLng - centerLngLat[0];
    const latOffset = lat - centerLngLat[1];
    const mercX = lngOffset * (unitsPerDegree[0] + unitsPerDegree2[0] * latOffset);
    const mercY = latOffset * (unitsPerDegree[1] + unitsPerDegree2[1] * latOffset);

    // offset.w = 0, so the fourth column of the matrix has no effect. The translation comes
    // from projectionCenter
    clipX = m[0] * mercX + m[4] * mercY + m[8] * elevationMercator + projectionCenter[0];
    clipY = m[1] * mercX + m[5] * mercY + m[9] * elevationMercator + projectionCenter[1];
    clipW = m[3] * mercX + m[7] * mercY + m[11] * elevationMercator + projectionCenter[3];
  } else {
    // Low zoom: put the absolute Mercator coordinates through the matrix as they are
    // (the same formula as projectTileWithElevation in the shader)
    const mercX = (drawnLng + 180) / 360;
    const latRad = (lat * Math.PI) / 180;
    const mercY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;

    clipX = m[0] * mercX + m[4] * mercY + m[8] * elevationMercator + m[12];
    clipY = m[1] * mercX + m[5] * mercY + m[9] * elevationMercator + m[13];
    clipW = m[3] * mercX + m[7] * mercY + m[11] * elevationMercator + m[15];
  }

  // clipW <= 0 means behind the camera. Dividing by it as is produces coordinates folded over
  // to the opposite side of the screen, and hit testing hits "a point that is not visible". It
  // is returned as unusable (the caller either falls back to MapLibre's project or drops it
  // from the candidates).
  if (!Number.isFinite(clipW) || clipW <= 0) return null;

  const ndcX = clipX / clipW;
  const ndcY = clipY / clipW;
  return {
    x: (ndcX * 0.5 + 0.5) * width,
    y: (1 - (ndcY * 0.5 + 0.5)) * height,
  };
}

/**
 * Injects the anchor projection into the hit testing side (once when the layer is created)
 *
 * It is bound per map. When a page has several rendering instances (the screen + a thumbnail +
 * a preview + printing), keeping only one globally would make hit testing run against
 * the frame of the instance created last.
 *
 * @param map The map to inject into
 * @param context That map's terrain state
 */
export function installAnchorProjector(map: MapLibreMap, context: TerrainContext): void {
  const projector: AnchorProjector = {
    project: (lng, lat) => projectAnchor(context, lng, lat),
  };
  setAnchorProjector(map, projector);
}

/**
 * Removes the injection (when the layer is destroyed)
 */
export function uninstallAnchorProjector(map: MapLibreMap): void {
  setAnchorProjector(map, null);
}

/**
 * Helper that looks at the terrain the map holds and decides whether anchors are usable
 *
 * Keeping an entry point that takes `map` directly makes it easy to assemble the frame state
 * from outside custom-layer (from tests, for example).
 */
export function anchorViewportOf(map: MapLibreMap): { width: number; height: number } {
  const canvas = map.getCanvas();
  // Returned in CSS pixels (the same unit as map.project). Where clientWidth becomes 0 (when
  // hidden, or in tests) it falls back to the attribute value
  return {
    width: canvas.clientWidth || canvas.width,
    height: canvas.clientHeight || canvas.height,
  };
}
