// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reaching MapLibre's terrain
 *
 * Parts of the terrain's internal API have no published types (maplibre-coupling.md, item 7).
 * They are confined to this single place, and in environments where they are absent null is
 * returned and rendering falls back to the path without terrain.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';

/** Rendering data for one DEM tile (the necessary part of MapLibre's TerrainData) */
export interface TerrainTileData {
  texture: WebGLTexture;
  /** 4x4 that maps tile EXTENT coordinates to the 0..1 space of the DEM texture */
  matrix: ArrayLike<number>;
  /** Decoding coefficients such as terrarium's [r, g, b, offset] */
  unpack: ArrayLike<number>;
  /** One side of the DEM (excluding the border) */
  dim: number;
  /** The vertical exaggeration of the terrain (see `getTerrainExaggeration`) */
  exaggeration: number;
}

/** A terrain tile to be rendered */
export interface RenderableTerrainTile {
  x: number;
  y: number;
  z: number;
  /** The copy of the world the tile is drawn on (0 for the main copy; absent in tests) */
  wrap?: number;
  /** The OverscaledTileID passed to getTerrainData (its type is internal to maplibre) */
  tileID: unknown;
}

/** The necessary part of the terrain object */
export interface TerrainLike {
  getTerrainData(tileID: unknown): unknown;
  /** The vertical exaggeration MapLibre applies to the terrain (see `getTerrainExaggeration`) */
  exaggeration?: number;
  /** The TerrainSpecification passed to `setTerrain` (used only as a fallback) */
  options?: { exaggeration?: number };
  /** Number of subdivisions of one tile (MapLibre's default is 128) */
  meshSize?: number;
  /**
   * Looks up the elevation of a single point (in meters, after the exaggeration factor is
   * applied) on the CPU, in the DEM tile of the given zoom level
   *
   * Used only where no drawn tile covers the point (`ground.ts`); where one does, the
   * elevation comes from `map.queryTerrainElevation`, which samples the drawn tile.
   */
  getElevationForLngLatZoom?(lngLat: TerrainLngLat, zoom: number): number;
}

/**
 * The shape of longitude and latitude that MapLibre's elevation lookup requires
 *
 * Only `wrap()` is called, rather than the `LngLat` class itself, so the value container
 * is provided here (no value is imported from maplibre-gl = the peer's version differences
 * are not touched).
 */
interface TerrainLngLat {
  lng: number;
  lat: number;
  wrap(): TerrainLngLat;
}

/**
 * A reusable container for elevation lookups
 *
 * Hit testing looks up the elevation for each vertex, so per-point allocation is avoided.
 * The MapLibre side only reads the values and does not keep the reference.
 */
const elevationQuery: TerrainLngLat = {
  lng: 0,
  lat: 0,
  wrap(): TerrainLngLat {
    return this;
  },
};

/**
 * Gets the elevation of a single point from the DEM tile of one zoom level (in meters)
 *
 * This is the fallback of `groundElevationMeters` (`ground.ts`) for points no drawn tile
 * covers. When it cannot be obtained (no terrain / the DEM has not arrived / the function is
 * missing due to a version difference) 0 is returned. Here 0 does not mean "sea level" but
 * "do not add an elevation", and the result is exactly the same as the rendering and hit
 * testing before the terrain was introduced.
 *
 * @param tileZoom The same value as MapLibre's `transform.tileZoom` (= floor(zoom))
 */
export function getTerrainElevationMeters(
  terrain: TerrainLike | null,
  lng: number,
  lat: number,
  tileZoom: number,
): number {
  const query = terrain?.getElevationForLngLatZoom;
  if (typeof query !== 'function') return 0;

  elevationQuery.lng = lng;
  elevationQuery.lat = lat;
  let elevation: number;
  try {
    elevation = query.call(terrain, elevationQuery, tileZoom);
  } catch {
    return 0;
  }
  return Number.isFinite(elevation) ? elevation : 0;
}

/**
 * Extracts the camera position (in Mercator)
 *
 * The occlusion test for symbols (`occlusion.ts`) uses it to draw a segment from the
 * camera to the anchor.
 *
 * `transform.cameraPosition` is not used. That one is "the same space as the 3D features
 * of that projection", and in measurements its units are mixed, with x and y in world
 * pixels and z on yet another scale, so the factor for converting it into this Mercator
 * space depends on the version. Instead it is assembled from `getCameraLngLat()` and
 * `getCameraAltitude()`, because their meaning is unambiguous and they can be written in
 * the same "longitude and latitude + meters" language as the elevation of the anchor.
 *
 * The location of transform differs between versions (v6 has `map.painter.transform`, v5
 * has `map.transform`). In environments where it is absent null is returned, and the
 * occlusion test falls back to "not occluded".
 */
export function getCameraMercator(
  map: MapLibreMap | null | undefined,
  elevationScale: number,
): readonly [number, number, number] | null {
  if (!map || !(elevationScale > 0)) return null;

  const holder = map as unknown as {
    transform?: CameraTransformLike;
    painter?: { transform?: CameraTransformLike };
  };
  const transform = holder.transform ?? holder.painter?.transform;
  if (!transform) return null;
  if (typeof transform.getCameraLngLat !== 'function') return null;
  if (typeof transform.getCameraAltitude !== 'function') return null;

  let lngLat: { lng: number; lat: number };
  let altitude: number;
  try {
    lngLat = transform.getCameraLngLat();
    altitude = transform.getCameraAltitude();
  } catch {
    return null;
  }
  if (!lngLat || !Number.isFinite(lngLat.lng) || !Number.isFinite(lngLat.lat)) return null;
  if (!Number.isFinite(altitude)) return null;

  const x = (lngLat.lng + 180) / 360;
  const latRad = (lngLat.lat * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  return [x, y, altitude * elevationScale];
}

/** The necessary part of the transform that is queried for the camera */
interface CameraTransformLike {
  getCameraLngLat?(): { lng: number; lat: number };
  getCameraAltitude?(): number;
}

/**
 * The vertical exaggeration MapLibre applies to the terrain
 *
 * MapLibre multiplies every elevation by this factor: the terrain mesh it draws
 * (`u_terrain_exaggeration` of `getTerrainData`) and `queryTerrainElevation`, which the
 * anchors use (`ground.ts`). So that polygons, lines and symbols sit on the same surface as the map, every
 * GPU path here (the DEM atlas and the drape) multiplies by the same factor.
 *
 * The factor is read from the terrain object itself (`terrain.exaggeration`, present in v5
 * and v6), which is the very field MapLibre multiplies by, rather than from
 * `map.getTerrain()`, which returns the specification as passed and can leave the factor
 * undefined. When the field is missing, the specification (`terrain.options`) is consulted,
 * and failing that 1 (MapLibre's default) is returned. A negative or non-finite value is
 * treated as missing.
 */
export function getTerrainExaggeration(terrain: TerrainLike | null): number {
  if (!terrain) return 1;
  const own = terrain.exaggeration;
  if (typeof own === 'number' && Number.isFinite(own) && own >= 0) return own;
  const spec = terrain.options?.exaggeration;
  if (typeof spec === 'number' && Number.isFinite(spec) && spec >= 0) return spec;
  return 1;
}

/** The number of subdivisions of MapLibre's terrain mesh (128 by default) */
export function getTerrainMeshSize(terrain: TerrainLike): number {
  const size = terrain.meshSize;
  return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 128;
}

interface TileManagerLike {
  getRenderableTiles?: () => Array<{ tileID?: unknown }>;
}

/**
 * Extracts the terrain object from the map (null when it is disabled)
 */
export function getMapTerrain(map: MapLibreMap | null | undefined): TerrainLike | null {
  if (!map) return null;
  const terrain = (map as unknown as { terrain?: unknown }).terrain;
  if (!terrain || typeof terrain !== 'object') return null;
  const candidate = terrain as Partial<TerrainLike>;
  if (typeof candidate.getTerrainData !== 'function') return null;
  return candidate as TerrainLike;
}

/**
 * Enumerates the terrain tiles to be rendered
 *
 * In v6 they live in `tileManager`, in v5 in `sourceCache`. When neither exists, an empty
 * result is returned.
 */
export function getRenderableTerrainTiles(terrain: TerrainLike): RenderableTerrainTile[] {
  const holder = terrain as unknown as {
    tileManager?: TileManagerLike;
    sourceCache?: TileManagerLike;
  };
  const manager = holder.tileManager ?? holder.sourceCache;
  if (!manager || typeof manager.getRenderableTiles !== 'function') return [];

  let tiles: Array<{ tileID?: unknown }>;
  try {
    tiles = manager.getRenderableTiles();
  } catch {
    return [];
  }

  const result: RenderableTerrainTile[] = [];
  for (const tile of tiles) {
    const tileID = tile?.tileID as { canonical?: { x: number; y: number; z: number } } | undefined;
    const canonical = tileID?.canonical;
    if (!canonical) continue;
    if (
      !Number.isFinite(canonical.x) ||
      !Number.isFinite(canonical.y) ||
      !Number.isFinite(canonical.z)
    ) {
      continue;
    }
    const wrap = (tileID as { wrap?: unknown }).wrap;
    result.push({
      x: canonical.x,
      y: canonical.y,
      z: canonical.z,
      wrap: typeof wrap === 'number' && Number.isFinite(wrap) ? wrap : 0,
      tileID,
    });
  }
  return result;
}

/**
 * Extracts the DEM rendering data for one tile (null when something is missing)
 */
export function getTerrainTileData(
  terrain: TerrainLike,
  tile: RenderableTerrainTile,
): TerrainTileData | null {
  let data: unknown;
  try {
    data = terrain.getTerrainData(tile.tileID);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;

  const record = data as {
    texture?: unknown;
    u_terrain_matrix?: ArrayLike<number>;
    u_terrain_unpack?: ArrayLike<number>;
    u_terrain_dim?: number;
  };
  const texture = record.texture as WebGLTexture | undefined;
  const matrix = record.u_terrain_matrix;
  const unpack = record.u_terrain_unpack;
  const dim = record.u_terrain_dim;
  if (!texture || !matrix || !unpack || typeof dim !== 'number' || dim <= 0) return null;
  if (matrix.length < 16 || unpack.length < 4) return null;

  return { texture, matrix, unpack, dim, exaggeration: getTerrainExaggeration(terrain) };
}
