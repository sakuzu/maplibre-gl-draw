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
  /**
   * The lowest and the highest ground of the DEM a terrain tile is drawn with (in meters, after
   * the exaggeration factor is applied); null values while no DEM has arrived for it
   */
  getMinMaxElevation?(tileID: unknown): {
    minElevation: number | null;
    maxElevation: number | null;
  };
}

/**
 * The DEM tile a terrain tile is drawn with: its own once it has arrived, a coarser one that has
 * until then (maplibre's `getSourceTile(tileID, true)`, what `getTerrainData` and
 * `queryTerrainElevation` read)
 */
export interface TerrainTileSource {
  /** The key of the DEM tile */
  readonly key: string;
  /**
   * The elevation data of the DEM tile (a new object when the tile is loaded again; maplibre
   * fills its border in place when a neighbour arrives)
   */
  readonly dem: object;
  /** The zoom of the DEM tile */
  readonly z: number;
  /** The number of pixels of the DEM tile on a side */
  readonly dim: number;
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
  getSourceTile?: (tileID: unknown, searchForDEM?: boolean) => SourceTileLike | undefined;
}

/** The necessary part of a DEM tile of maplibre */
interface SourceTileLike {
  tileID?: { key?: unknown; canonical?: { z?: unknown } };
  dem?: { dim?: unknown } | null;
}

/** The tile manager of the terrain (`tileManager` in v6, `sourceCache` in v5) */
function terrainTileManager(terrain: TerrainLike): TileManagerLike | undefined {
  const holder = terrain as unknown as {
    tileManager?: TileManagerLike;
    sourceCache?: TileManagerLike;
  };
  return holder.tileManager ?? holder.sourceCache;
}

/**
 * The DEM tile a terrain tile is drawn with (null while no DEM has arrived for it, or where the
 * terrain cannot tell)
 *
 * It is what tells the elevations of a tile changed while the tiles drawn stay the same: the DEM
 * arrives after the tile is first drawn, and a finer one replaces the coarser one drawn until
 * then.
 */
export function getTerrainTileSource(
  terrain: TerrainLike,
  tile: RenderableTerrainTile,
): TerrainTileSource | null {
  const manager = terrainTileManager(terrain);
  if (!manager || typeof manager.getSourceTile !== 'function') return null;
  let source: SourceTileLike | undefined;
  try {
    source = manager.getSourceTile(tile.tileID, true);
  } catch {
    return null;
  }
  const dem = source?.dem;
  const key = source?.tileID?.key;
  const z = source?.tileID?.canonical?.z;
  if (!dem || typeof dem !== 'object' || typeof z !== 'number' || !Number.isFinite(z)) return null;
  const dim = typeof dem.dim === 'number' && dem.dim > 0 ? dem.dim : 1;
  return { key: String(key), dem, z, dim };
}

/**
 * The lowest and the highest ground of the terrain tiles drawn, in meters as the anchors read
 * it (`getMinMaxElevation` of maplibre, the exaggeration included)
 *
 * A tile whose DEM has not arrived is drawn flat, at 0. null when the terrain cannot tell the
 * range of a tile.
 */
export function getTerrainElevationRange(
  terrain: TerrainLike,
  tiles: readonly RenderableTerrainTile[],
): { min: number; max: number } | null {
  if (typeof terrain.getMinMaxElevation !== 'function' || tiles.length === 0) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const tile of tiles) {
    let range: { minElevation: number | null; maxElevation: number | null };
    try {
      range = terrain.getMinMaxElevation(tile.tileID);
    } catch {
      return null;
    }
    const low = range?.minElevation;
    const high = range?.maxElevation;
    const known = typeof low === 'number' && typeof high === 'number';
    if (known && !(Number.isFinite(low) && Number.isFinite(high))) return null;
    min = Math.min(min, known ? low : 0);
    max = Math.max(max, known ? high : 0);
  }
  return { min, max };
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
  const manager = terrainTileManager(terrain);
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
 * The depth of the terrain MapLibre draws each frame (`getTerrainDepth`): the texture, and its
 * size in texels
 */
export interface TerrainDepth {
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
}

/**
 * The texture MapLibre draws the depth of its terrain into, once a frame the camera or the tiles
 * of the terrain changed in, before the layers are drawn (`maybeDrawDepth` of its painter): the
 * terrain mesh seen from the camera of the frame, one texel a CSS pixel of the map (the size of
 * the canvas over `devicePixelRatio`), each texel the depth of the clip space (its z over its w)
 * packed into the four bytes of an RGBA8 texel, white where no terrain is drawn
 * (`terrain_depth.fragment.glsl`). `getTerrainData` hands it to the shaders of MapLibre as
 * `depthTexture`.
 *
 * Null where it cannot be taken: no `depthTexture` in the data of the tile, one that is not a
 * texture, or one not of the size of the canvas now (MapLibre's 1 x 1 stand in before the first
 * depth is drawn, or a depth not drawn again yet after the canvas changed its size). The size is
 * read from the texture object that holds it (its `size`), the only place it is kept.
 *
 * @param tile Any tile of the terrain drawn (the depth is one for the frame)
 * @param drawingWidth The width of the drawing buffer (device pixels)
 * @param drawingHeight The height of the drawing buffer (device pixels)
 */
export function getTerrainDepth(
  terrain: TerrainLike,
  tile: RenderableTerrainTile,
  drawingWidth: number,
  drawingHeight: number,
): TerrainDepth | null {
  let data: unknown;
  try {
    data = terrain.getTerrainData(tile.tileID);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const texture = (data as { depthTexture?: unknown }).depthTexture;
  if (!isTexture(texture)) return null;
  const holder = (terrain as unknown as { _fboDepthTexture?: unknown })._fboDepthTexture;
  if (!holder || typeof holder !== 'object') return null;
  const own = holder as { texture?: unknown; size?: unknown };
  if (own.texture !== texture || !Array.isArray(own.size) || own.size.length < 2) return null;
  // MapLibre makes it the size of the canvas over the ratio of the device, which may not be a
  // whole number: the texture takes the whole part (as the viewport it is drawn with does)
  const width = Math.trunc(own.size[0] as number);
  const height = Math.trunc(own.size[1] as number);
  const ratio = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
  const dpr = typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  if (!(width > 0 && height > 0)) return null;
  if (width !== Math.trunc(drawingWidth / dpr) || height !== Math.trunc(drawingHeight / dpr)) {
    return null;
  }
  return { texture, width, height };
}

/** Whether a value is a WebGL texture (any object where the class is not there, as in tests) */
function isTexture(value: unknown): value is WebGLTexture {
  if (!value || typeof value !== 'object') return false;
  const kind = (globalThis as { WebGLTexture?: abstract new () => object }).WebGLTexture;
  return typeof kind === 'function' ? value instanceof kind : true;
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
