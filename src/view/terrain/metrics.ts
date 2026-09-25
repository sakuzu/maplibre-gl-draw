// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The dimensions around terrain rendering
 *
 * The conventions for units, the lift amount and the subdivision step are collected here.
 */

import { UPSTREAM_EARTH_CIRCUMFERENCE_METERS } from './upstream-terrain.js';

/**
 * The length of one circuit of the Earth at a latitude (in meters)
 *
 * 1.0 in Mercator coordinates corresponds to this length. It is measured on maplibre's sphere
 * (`upstream-terrain.ts`), so an elevation turned into Mercator units lands on maplibre's
 * terrain mesh.
 *
 * @internal
 */
export function circumferenceAtLatitude(lat: number): number {
  return UPSTREAM_EARTH_CIRCUMFERENCE_METERS * Math.cos((lat * Math.PI) / 180);
}

/**
 * The center latitude of a tile
 *
 * Used to convert the gradient of the shading into meters (to derive the ground size of that
 * tile).
 */
export function tileCenterLatitude(tileY: number, tileZ: number): number {
  const n = Math.PI - (2 * Math.PI * (tileY + 0.5)) / 2 ** tileZ;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * Returns the factor that converts an elevation in meters to Mercator z units at a latitude.
 *
 * It is the factor for producing the same value as
 * `MercatorCoordinate.fromLngLat(lngLat, meters).z`. The elevation handed to a vertex must
 * always be in Mercator units (handing over meters as they are is wrong). The factor depends
 * on the latitude, but MapLibre's matrices are assembled with the factor of the view center
 * latitude, so within the viewport it is represented by the latitude of the screen center.
 *
 * @param centerLat The latitude in degrees (the view center)
 * @returns Mercator units per meter
 */
export function metersToMercatorScale(centerLat: number): number {
  const circumference = circumferenceAtLatitude(centerLat);
  return circumference > 0 ? 1 / circumference : 0;
}

/**
 * The grid spacing of MapLibre's terrain mesh (in meters)
 *
 * MapLibre draws the terrain with a regular mesh that splits one tile into 128. This value is
 * "the granularity to match" when putting our own geometry onto the ground.
 */
export const TERRAIN_MESH_DIVISIONS = 128;

/**
 * The grid spacing of the terrain mesh (in meters)
 *
 * @internal
 */
export function terrainMeshSpacingMeters(zoom: number, lat: number): number {
  const tileWidth = circumferenceAtLatitude(lat) / 2 ** zoom;
  return tileWidth / TERRAIN_MESH_DIVISIONS;
}

/**
 * The factor of the lift amount (the ratio to the terrain mesh grid spacing)
 *
 * This is not an exaggeration of the terrain. The relief is drawn with the same exaggeration
 * as the map's own terrain and nothing is added to it. What is added here is purely a
 * rendering implementation value to avoid Z-fighting: our own geometry (the bilinear
 * interpolation of the DEM turned into a polyline / faceted surface on the grid) and
 * MapLibre's terrain mesh (linear
 * interpolation with 128 subdivisions per tile) are different surfaces and therefore
 * necessarily intersect. It is not made a public option.
 *
 * The amount required is decided by "the maximum amount by which the mesh comes above the
 * bilinear surface", which with the four corners of a grid cell as e00, e10, e01, e11 is
 * |e00 + e11 - e10 - e01| / 4. Values measured in the Northern Alps (Kamikochi to Hotaka, an
 * elevation difference of 750 m per 10 km):
 *
 * | display zoom | terrain tile z | grid spacing | required (max) | grid ratio |
 * | --- | --- | --- | --- | --- |
 * | 10 | 10 | 246.5m | 61.0m | 0.25 |
 * | 12 | 12 | 61.6m | 37.3m | 0.60 |
 * | 14 | 14 | 15.4m | 10.3m | 0.67 |
 *
 * This table gives the values "when the subdivision points are placed at an arbitrary
 * spacing". The current implementation aligns the subdivision points with the nodes of
 * MapLibre's terrain mesh themselves and matches the direction of the cell diagonals too, so
 * the two surfaces agree both at the nodes and inside the cells. All that remains is
 * floating-point rounding, so the world lift is shrunk down to an invisible amount (a factor
 * of 0.15) and the main depth bias is left to the slope-proportional gl.polygonOffset (the
 * depth settings in view/layer/gl-state.ts). A large world lift is avoided because it "looks like it is
 * floating" at close zooms.
 */
export const TERRAIN_LIFT_RATIO = 0.15;

/** The lower bound of the lift (in meters). A floor for the depth buffer's resolution */
export const TERRAIN_LIFT_MIN_METERS = 0.05;

/**
 * The lift amount (in meters)
 *
 * @internal
 */
export function terrainLiftMeters(zoom: number, lat: number): number {
  const spacing = terrainMeshSpacingMeters(zoom, lat);
  return Math.max(TERRAIN_LIFT_MIN_METERS, spacing * TERRAIN_LIFT_RATIO);
}

/**
 * The subdivision step (in meters)
 *
 * It is bounded above by "the ground size of a DEM pixel at the zoom being displayed" and
 * below by "the grid spacing of the terrain mesh". The implementation aims at the grid spacing
 * of the terrain mesh, and since going finer than a DEM pixel adds no information, a floor is
 * set at the DEM pixel.
 *
 * @param zoom The representative zoom of the terrain tiles
 * @param lat The latitude of the screen center
 * @param demPixelMeters The ground size of a DEM pixel (0 when unknown)
 */
export function terrainTessellationStepMeters(
  zoom: number,
  lat: number,
  demPixelMeters: number,
): number {
  const spacing = terrainMeshSpacingMeters(zoom, lat);
  return Math.max(spacing, demPixelMeters, 1);
}

/**
 * Quantizes the step to a power of 2
 *
 * Redoing the subdivision every time the zoom moves continuously would break retained batches
 * every frame. The step is rounded to a power of 2 and rebuilt only when one is crossed (which
 * is the same thing as crossing an integer zoom).
 */
export function quantizeStepMeters(stepMeters: number): number {
  if (!(stepMeters > 0)) return 0;
  return 2 ** Math.round(Math.log2(stepMeters));
}

/**
 * The upper bound on the number of subdivision points per feature (stopping a blow-up of the
 * vertex count)
 *
 * This is not "the number at which it is cut off" but "the number at which the step starts to
 * be coarsened" (polygonTessellationStep in terrain/polygon.ts). The larger the feature, the
 * coarser the step, so the vertex count is capped around this value. Subdividing a 10 km
 * square polygon with the zoom 12 step (64 m) gives about 26,000 points, so the value is set
 * such that polygons of ordinary size get by without being coarsened.
 */
export const TERRAIN_MAX_SUBDIVISION_POINTS = 120000;

/**
 * The upper bound on the number of subdivision points per feature when subdividing to match
 * the tile's actual mesh
 *
 * When the step matches the tile's actual mesh (with a tiling), the amount subdivided is
 * capped by "the number of tiles in the view x the square of the mesh subdivisions". That is
 * the same order of magnitude as the vertex count MapLibre itself uses for the terrain mesh,
 * and it is decided by the extent of the view alone (it depends on neither the number of
 * features nor the zoom).
 *
 * Cutting at the upper bound would mean "coarsening and subdividing again" from there on, and
 * the coarse chord would dive under ridges and the fill would drop out. Only an exact match is
 * safe, so the value is set high enough that even a single polygon covering the whole view can
 * be subdivided fully.
 */
export const TERRAIN_MAX_TILED_SUBDIVISION_POINTS = 800000;

/**
 * The upper bound on the number of cells that may be subdivided across one whole batch build
 *
 * The per-feature upper bound (TERRAIN_MAX_SUBDIVISION_POINTS) alone is no brake when there
 * are thousands of features. Measuring a dataset (8,172 administrative
 * boundaries, 1.1 million vertices in total), each individual feature stayed far below the
 * bound (a few hundred cells) yet the total reached about 1.7 million cells and a single
 * retained batch build blocked the main thread for 34 seconds. The cost of the subdivision is
 * proportional to the pairs of "cell x triangle", so the only way to hold it back is by the
 * total across all features.
 *
 * When the total is expected to exceed this value, the step of the whole batch is coarsened by
 * a power of 2 (batchTessellationFactor in terrain/polygon.ts). Even coarsened it still lies
 * on a subset of the terrain mesh nodes, so the agreement between the fill and the outline is
 * preserved.
 *
 * The value was taken from "keeping one build with terrain to about 1 second".
 */
export const TERRAIN_MAX_BATCH_SUBDIVISION_CELLS = 1000000;

/**
 * The depth bias when there is terrain (the factor / units of gl.polygonOffset)
 *
 * It is the amount per one level of step coarseness. The value actually used is this
 * multiplied by "the coarsest factor subdivided with in that generation"
 * (view/layer/terrain-resolver.ts).
 *
 * 16 was decided by measurement. With 1 (the previous value), spotty holes remained on hill
 * tops even when the step was the terrain mesh nodes themselves (no coarsening). With 8 a few
 * remained at a coarsening of 2, and they disappeared at 16 to 32 (hands-on in the north of
 * Kawasaki, zoom 15.7, pitch 60).
 */
export const TERRAIN_DEPTH_BIAS = 16;

/**
 * The margin added to the subdivision range (the ratio to the atlas side length)
 *
 * The subdivision is done only inside the rectangle the DEM atlas covers. Making the range
 * exactly the atlas would change the range on every small movement and trigger a re-bake of
 * the retained batches, so a margin is added around it and the range is recomputed only when
 * the atlas moves outside the margin.
 *
 * 0.2 = 20 percent of the view on each side (about twice the area). Since the step came to
 * match the tile's actual mesh, the amount can no longer be reduced by coarsening (coarsening
 * makes it drop out on ridges), so a thicker margin makes construction correspondingly
 * heavier. 20 percent of the view is the compromise for "no re-bake on a light gesture, a
 * re-bake on a heavy one".
 */
export const TERRAIN_REGION_MARGIN = 0.2;

/**
 * The upper bound on the number of levels the step may be coarsened by (powers of 2)
 *
 * The upper bound of the subdivision criterion is "the ground size of a DEM pixel". Coarsening
 * for budget reasons goes in the direction of coarser than that bound, so it is not allowed to
 * act without limit. It is capped at 6 levels (a factor of 64), and anything that still does
 * not fit is emitted without being subdivided fully.
 */
export const TERRAIN_MAX_COARSEN_STEPS = 6;

/**
 * The upper bound on the coarsening allowed when subdividing to match the tile's actual mesh
 * (powers of 2)
 *
 * The actual mesh as is would be ideal, but with a wide view and a strong pitch the amount
 * subdivided jumps and frames of several hundred milliseconds appear every time new ground
 * enters the view (measured). As long as the coarsening is by a power of 2 the subdivision
 * points still lie on a subset of the actual mesh nodes, so the problem of sinking in valley
 * floors (whose cause is leaving the nodes) does not occur. The slight dive of the chord on
 * ridges is covered by the step-proportional depth bias.
 *
 * 2 is where "the amount can be quartered and the dive on ridges can still be covered by the
 * bias".
 */
export const TERRAIN_MAX_TILED_COARSEN = 2;
