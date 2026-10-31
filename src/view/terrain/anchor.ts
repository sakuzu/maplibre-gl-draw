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
 * The projection formula is the vertex shader's (OFFSET_MODE_GLSL in `shaders/helpers.ts`),
 * computed in float64 (`clipOfPosition` in `shaders/center-projection.ts`): on Web Mercator, on
 * the globe and in the transition between, at every zoom. The lift (liftMeters) is not added. That exists for
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
  setViewProjector,
} from '../../shared/math/index.js';
import { nearestLongitude } from '../../shared/math/longitude.js';
import { clipOfPosition } from '../shaders/center-projection.js';
import type { OffsetUniforms, ProjectionMatrices } from '../shaders/helpers.js';
import { INACTIVE_ANCHOR_FRAME, type TerrainContext, type ViewFrame } from './context.js';
import { getRenderableTerrainTiles, type TerrainLike } from './detect.js';
import { groundElevationMeters, type TerrainElevationQuery } from './ground.js';

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
    /** The projection data of the frame (its matrices and its transition) */
    projection: ProjectionMatrices;
    offsetUniforms: OffsetUniforms;
    width: number;
    height: number;
    /** Camera position (Mercator). null when it cannot be obtained */
    cameraMercator?: readonly [number, number, number] | null;
  },
): void {
  const { terrain, zoom, elevationScale, projection, offsetUniforms, width, height } = options;

  context.anchorFrame = {
    terrain,
    elevationQuery: options.elevationQuery ?? null,
    tileZoom: Math.floor(zoom),
    elevationScale,
    projection,
    offsetUniforms,
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
  return frame.terrain !== null && frame.projection !== null;
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
  const offsetUniforms = context.viewFrame.offsetUniforms ?? context.anchorFrame.offsetUniforms;
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
  if (!frame.projection || !frame.terrain) return null;
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
  const { projection, terrain, width, height } = frame;
  if (!projection || !terrain) return null;
  // The anchor is projected on the copy of the world it is drawn on, at its elevation in
  // Mercator units
  return screenOfClip(
    clipOfPosition(
      projection,
      drawnLongitude(context, lng),
      lat,
      elevationMeters * frame.elevationScale,
    ),
    width,
    height,
  );
}

/**
 * A point of the screen from a position in clip space, in CSS pixels of a viewport
 *
 * clipW <= 0 means behind the camera. Dividing by it as is produces coordinates folded over to
 * the opposite side of the screen, and hit testing hits "a point that is not visible". It is
 * returned as unusable (the caller either falls back to MapLibre's project or drops it from the
 * candidates).
 */
function screenOfClip(
  [clipX, clipY, , clipW]: readonly number[],
  width: number,
  height: number,
): ScreenPoint | null {
  if (width <= 0 || height <= 0 || !Number.isFinite(clipW) || clipW <= 0) return null;
  const ndcX = clipX / clipW;
  const ndcY = clipY / clipW;
  return {
    x: (ndcX * 0.5 + 0.5) * width,
    y: (1 - (ndcY * 0.5 + 0.5)) * height,
  };
}

/**
 * Records the view of the frame being drawn, with or without terrain (custom-layer calls it
 * every frame): the drawing reads it during the frame, and the hit testing and the extensions
 * until the next one
 */
export function setViewFrame(context: TerrainContext, frame: ViewFrame): void {
  context.viewFrame = frame;
}

/**
 * The point of the screen where a position is drawn in the frame drawn last: on the terrain
 * through the anchor projection while it is active, on the map with the projection of the
 * shaders otherwise, in float64
 *
 * @returns null behind the camera or before the first frame
 * @internal
 */
export function projectOnView(
  context: TerrainContext,
  lng: number,
  lat: number,
): ScreenPoint | null {
  if (isAnchorActive(context)) return projectAnchor(context, lng, lat);
  const { projection, width, height } = context.viewFrame;
  if (!projection) return null;
  return screenOfClip(
    clipOfPosition(projection, drawnLongitude(context, lng), lat, 0),
    width,
    height,
  );
}

/** The steps of Newton's method of {@link unprojectOnView} at most */
const UNPROJECT_STEPS = 8;

/** How close to the point, in CSS pixels, a position of {@link unprojectOnView} is taken */
const UNPROJECT_TOLERANCE_PX = 1e-6;

/** How far from the point a position of {@link unprojectOnView} may stay, in CSS pixels */
const UNPROJECT_MISS_PX = 0.01;

/**
 * The step in degrees the derivatives of {@link unprojectOnView} are taken over: a few pixels at
 * zoom 24 and a millionth of one at zoom 0, which the projection in float64 resolves
 */
const UNPROJECT_STEP_DEGREES = 1e-7;

/**
 * The position drawn at a point of the screen in the frame drawn last: the inverse of
 * {@link projectOnView}, found by Newton's method from a position near it
 *
 * The projection of the frame is not inverted in a closed form (the globe, the transition and
 * the terrain make it a surface of their own), so it is solved for the point from `near`, the
 * position maplibre unprojects the point to with its current camera, which is the frame drawn
 * last but for a camera moved since.
 *
 * @returns null when no position is drawn there (in space beside the globe, behind the camera),
 *   or before the first frame
 * @internal
 */
export function unprojectOnView(
  context: TerrainContext,
  x: number,
  y: number,
  near: { lng: number; lat: number },
): { lng: number; lat: number } | null {
  if (!context.viewFrame.projection) return null;
  let lng = near.lng;
  let lat = near.lat;
  for (let step = 0; step < UNPROJECT_STEPS; step++) {
    const at = projectOnView(context, lng, lat);
    if (!at) return null;
    const dx = x - at.x;
    const dy = y - at.y;
    if (Math.hypot(dx, dy) <= UNPROJECT_TOLERANCE_PX) return { lng, lat };
    const h = UNPROJECT_STEP_DEGREES;
    const east = projectOnView(context, lng + h, lat);
    const north = projectOnView(context, lng, lat + h);
    if (!east || !north) return null;
    const a = (east.x - at.x) / h;
    const b = (north.x - at.x) / h;
    const c = (east.y - at.y) / h;
    const d = (north.y - at.y) / h;
    const det = a * d - b * c;
    if (!Number.isFinite(det) || det === 0) return null;
    lng += (d * dx - b * dy) / det;
    lat += (a * dy - c * dx) / det;
    lat = Math.max(-90, Math.min(90, lat));
  }
  const at = projectOnView(context, lng, lat);
  return at && Math.hypot(x - at.x, y - at.y) <= UNPROJECT_MISS_PX ? { lng, lat } : null;
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
  // The view of the frame drawn last, which every conversion between the map and the screen
  // reads, with or without terrain
  setViewProjector(map, {
    project: (lng, lat) => projectOnView(context, lng, lat),
    unproject: (x, y, near) => unprojectOnView(context, x, y, near),
  });
}

/**
 * Removes the injection (when the layer is destroyed)
 */
export function uninstallAnchorProjector(map: MapLibreMap): void {
  setAnchorProjector(map, null);
  setViewProjector(map, null);
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
