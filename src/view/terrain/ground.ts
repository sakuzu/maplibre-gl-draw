// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ground elevation of a single point, taken from the surface maplibre draws
 *
 * Symbols (points, handles, the anchors of custom renderers) are placed by one elevation per
 * point, looked up on the CPU. It must be the elevation of the ground maplibre draws at that
 * point, or the symbol floats above the slope or sinks into it.
 *
 * maplibre 6.11.1 samples the drawn surface in `Map.queryTerrainElevation`
 * (`Terrain.getElevationForLngLat`, `src/render/terrain.ts:246`): where a terrain tile it draws
 * covers the point and its DEM has arrived, it reads that tile's DEM with the placement its
 * shader uses. That is what is used here, through the public method, and nothing of it is
 * copied. `map.project` reads the same function (`MercatorTransform.locationToScreenPoint`), so
 * the anchors agree with it as well.
 *
 * Where no drawn tile covers the point (off screen, or under the camera in a pitched view) the
 * public method walks the covering tiles of the whole view for every call, about 40 us a point
 * against 0.2 to 0.4 us inside the coverage (measured on maplibre 6.11.1, 10 000 points).
 * Nothing is drawn there, so such a point is answered from the tile of the current zoom level
 * (`Terrain.getElevationForLngLatZoom`, cheap) instead. {@link TerrainCoverage} tells the two
 * apart from the tiles maplibre draws in this frame; when the coverage changes, the anchor
 * generation advances and whatever baked an elevation is rebuilt.
 */

import {
  getTerrainElevationMeters,
  type RenderableTerrainTile,
  type TerrainLike,
  type TerrainTileSource,
} from './detect.js';
import type { MercatorRect } from './tessellation.js';

/** The part of the map the ground elevation is asked from (`Map.queryTerrainElevation`) */
export interface TerrainElevationQuery {
  queryTerrainElevation(lngLat: [number, number]): number | null;
}

/** The copies of the world a coverage tells apart (more are treated as not covered) */
const MAX_WRAP = 7;

/** A numeric key of a tile (exact up to zoom 24) */
function tileKey(wrap: number, z: number, x: number, y: number): number {
  const size = 2 ** z;
  return ((wrap + MAX_WRAP) * size + y) * size + x;
}

/** The DEM a tile drawn is drawn with, as the coverage tells them apart */
interface TileDem {
  /** The DEM tile and the data that arrived for it (empty while none has) */
  readonly id: string;
  /** One pixel of the DEM, in Mercator units (0 while none has arrived) */
  readonly pixel: number;
}

/**
 * The terrain tiles maplibre draws in the current frame, indexed for a point lookup, with the
 * DEM each is drawn with
 *
 * A point is covered here exactly when maplibre's coverage index (`wrap/z/x/y`, searched from
 * the finest zoom) finds a drawn tile for it, which is when `queryTerrainElevation` samples the
 * drawn surface.
 *
 * The elevations under a tile change when the tile comes or goes, and also while the tiles drawn
 * stay the same: its DEM arrives after it is first drawn (it is flat until then), and a finer
 * DEM replaces the coarser one it is drawn with meanwhile. Each update tells where
 * (`changedRegions`), so what baked an elevation reads again only what lies there.
 */
export class TerrainCoverage {
  /** Identifies the tile set (it changes whenever the set changes, not when a DEM arrives) */
  key = '';
  /**
   * Where the elevations may have changed in the last update that changed something (Mercator,
   * on the copy of the world of each tile): the tiles that came or went and the tiles drawn
   * with another DEM, each with a pixel of its DEM around it (maplibre fills the border of the
   * neighbouring DEM tiles in place when one arrives)
   */
  changedRegions: readonly MercatorRect[] = [];
  /** The zoom levels present, finest first (the order maplibre searches them in) */
  private zooms: number[] = [];
  private tiles = new Set<number>();
  /** The DEM of each tile drawn, by the name of the tile (`wrap/z/x/y`) */
  private dems = new Map<string, TileDem>();
  /** A number for each elevation data seen (by the identity of the object: a reload makes one) */
  private readonly demSerials = new WeakMap<object, number>();
  private nextDemSerial = 1;

  /**
   * Replaces the tile set and the DEM each tile is drawn with
   *
   * @param sourceOf The DEM a tile is drawn with (null while none has arrived). Without it only
   *   the tile set is compared
   * @returns Whether the elevations may have changed (the set changed, or a tile is drawn with
   *   another DEM)
   */
  update(
    tiles: readonly RenderableTerrainTile[],
    sourceOf?: (tile: RenderableTerrainTile) => TerrainTileSource | null,
  ): boolean {
    let key = '';
    const dems = new Map<string, TileDem>();
    for (const tile of tiles) {
      const name = `${tile.wrap ?? 0}/${tile.z}/${tile.x}/${tile.y}`;
      key += `${name},`;
      const source = sourceOf?.(tile) ?? null;
      dems.set(
        name,
        source
          ? { id: `${source.key}#${this.demSerial(source.dem)}`, pixel: demPixel(source) }
          : NO_DEM,
      );
    }
    const changed = changedTiles(this.dems, dems);
    if (key === this.key && changed.length === 0) return false;

    this.changedRegions = changed;
    this.dems = dems;
    if (key !== this.key) {
      this.key = key;
      this.tiles = new Set();
      const zooms = new Set<number>();
      for (const tile of tiles) {
        const wrap = tile.wrap ?? 0;
        if (Math.abs(wrap) > MAX_WRAP) continue;
        this.tiles.add(tileKey(wrap, tile.z, tile.x, tile.y));
        zooms.add(tile.z);
      }
      this.zooms = [...zooms].sort((a, b) => b - a);
    }
    return true;
  }

  /**
   * Forgets the tile set
   *
   * @returns Whether there was one
   */
  clear(): boolean {
    if (this.key === '') return false;
    this.changedRegions = changedTiles(this.dems, new Map());
    this.key = '';
    this.zooms = [];
    this.tiles = new Set();
    this.dems = new Map();
    return true;
  }

  /** The number of an elevation data */
  private demSerial(dem: object): number {
    let serial = this.demSerials.get(dem);
    if (serial === undefined) {
      serial = this.nextDemSerial++;
      this.demSerials.set(dem, serial);
    }
    return serial;
  }

  /**
   * Whether a drawn tile covers a point
   *
   * @param lng The longitude in degrees, on the copy of the world it is drawn on (not wrapped)
   * @param lat The latitude in degrees
   */
  covers(lng: number, lat: number): boolean {
    if (this.zooms.length === 0) return false;
    const mercatorX = (lng + 180) / 360;
    const latRad = (lat * Math.PI) / 180;
    const mercatorY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
    if (!(mercatorY >= 0 && mercatorY < 1) || !Number.isFinite(mercatorX)) return false;

    const wrap = Math.floor(mercatorX);
    if (Math.abs(wrap) > MAX_WRAP) return false;
    const wrappedX = mercatorX - wrap;
    for (const z of this.zooms) {
      const scale = 2 ** z;
      const key = tileKey(wrap, z, Math.floor(wrappedX * scale), Math.floor(mercatorY * scale));
      if (this.tiles.has(key)) return true;
    }
    return false;
  }
}

/** The DEM of a tile drawn while none has arrived for it (it is drawn flat) */
const NO_DEM: TileDem = { id: '', pixel: 0 };

/** One pixel of a DEM tile, in Mercator units */
function demPixel(source: TerrainTileSource): number {
  return 1 / (2 ** source.z * source.dim);
}

/**
 * The regions of the tiles whose elevations may have changed between two updates: those that
 * came, went or are drawn with another DEM, each with a pixel of its DEMs around it
 */
function changedTiles(
  before: ReadonlyMap<string, TileDem>,
  after: ReadonlyMap<string, TileDem>,
): MercatorRect[] {
  const regions: MercatorRect[] = [];
  for (const [name, dem] of after) {
    const old = before.get(name);
    if (old?.id !== dem.id) regions.push(tileRegion(name, Math.max(dem.pixel, old?.pixel ?? 0)));
  }
  for (const [name, dem] of before) {
    if (!after.has(name)) regions.push(tileRegion(name, dem.pixel));
  }
  return regions;
}

/** The Mercator rectangle of a tile named `wrap/z/x/y`, grown by a margin on every side */
function tileRegion(name: string, margin: number): MercatorRect {
  const [wrap, z, x, y] = name.split('/').map(Number);
  const size = 1 / 2 ** z;
  return {
    x0: wrap + x * size - margin,
    y0: y * size - margin,
    x1: wrap + (x + 1) * size + margin,
    y1: (y + 1) * size + margin,
  };
}

/**
 * The ground elevation of a point in meters, exaggeration included
 *
 * @param query The map, or null where there is none (then only the fallback is used)
 * @param terrain The terrain of the map
 * @param coverage The tiles drawn in this frame
 * @param lng The longitude in degrees, on the copy of the world the point is drawn on
 * @param lat The latitude in degrees
 * @param tileZoom The zoom level of the fallback (maplibre's `tileZoom`, `floor(zoom)`)
 * @returns The elevation; 0 when it cannot be obtained ("add no elevation")
 */
export function groundElevationMeters(
  query: TerrainElevationQuery | null,
  terrain: TerrainLike,
  coverage: TerrainCoverage,
  lng: number,
  lat: number,
  tileZoom: number,
): number {
  if (query && coverage.covers(lng, lat)) {
    let elevation: number | null = null;
    try {
      elevation = query.queryTerrainElevation([lng, lat]);
    } catch {
      elevation = null;
    }
    if (typeof elevation === 'number' && Number.isFinite(elevation)) return elevation;
  }
  return getTerrainElevationMeters(terrain, lng, lat, tileZoom);
}
