// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The terrain of the editing benchmark (`edit.html?terrain=1`), made in the page
 *
 * Hills that repeat over the whole grid of the features, from 0 m to 3,000 m, so that the ground
 * stays in the same range whatever the number of the features. The elevation tiles are drawn in
 * the page with the terrarium encoding and read by a `raster-dem` source through a protocol
 * registered with maplibre: nothing is fetched from the network.
 */

import type * as MapLibre from 'maplibre-gl';

/** The protocol the elevation tiles are read through */
const PROTOCOL = 'edit-dem';

/** The source of the terrain */
const SOURCE = 'edit-dem';

/** The deepest zoom of the elevation tiles */
const DEM_MAX_ZOOM = 12;

/** The side of an elevation tile in pixels */
const DEM_TILE_SIZE = 256;

/** The highest the hills rise (m) */
export const HILL_TOP_METERS = 3_000;

/** The distance from one hill to the next, in degrees */
const HILL_PERIOD_DEG = 0.06;

/**
 * The elevation of the terrain of the page in meters: hills from 0 m to {@link HILL_TOP_METERS},
 * one every {@link HILL_PERIOD_DEG} degrees each way
 */
export function hillElevation(lng: number, lat: number): number {
  const x = Math.sin((2 * Math.PI * lng) / HILL_PERIOD_DEG);
  const y = Math.sin((2 * Math.PI * lat) / HILL_PERIOD_DEG);
  return (HILL_TOP_METERS / 2) * (1 + x * y);
}

/** The longitude and latitude of a point of a tile (fractions of the tile) */
function tilePointToLngLat(z: number, x: number, y: number, fx: number, fy: number): number[] {
  const n = 2 ** z;
  const lng = ((x + fx) / n) * 360 - 180;
  const my = Math.PI * (1 - (2 * (y + fy)) / n);
  return [lng, (Math.atan(Math.sinh(my)) * 180) / Math.PI];
}

/** One elevation tile as a terrarium PNG */
async function renderTile(z: number, x: number, y: number): Promise<ArrayBuffer> {
  const size = DEM_TILE_SIZE;
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      // A DEM pixel describes the cell centred on it
      const [lng, lat] = tilePointToLngLat(z, x, y, (i + 0.5) / size, (j + 0.5) / size);
      const v = hillElevation(lng, lat) + 32768;
      const o = (j * size + i) * 4;
      pixels[o] = Math.floor(v / 256);
      pixels[o + 1] = Math.floor(v) % 256;
      pixels[o + 2] = Math.floor((v - Math.floor(v)) * 256);
      pixels[o + 3] = 255;
    }
  }
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context for the elevation tiles');
  context.putImageData(new ImageData(pixels, size, size), 0, 0);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

/** Registers the protocol of the elevation tiles (once per page) */
export function installHillTerrain(maplibregl: typeof MapLibre): void {
  maplibregl.addProtocol(PROTOCOL, async (params) => {
    const match = /^edit-dem:\/\/(\d+)\/(\d+)\/(\d+)$/.exec(params.url);
    if (!match) throw new Error(`unexpected elevation tile ${params.url}`);
    const [z, x, y] = match.slice(1).map(Number);
    return { data: await renderTile(z, x, y) };
  });
}

/** Puts the terrain of the page on a map (its elevations as they are) */
export function addHillTerrain(map: MapLibre.Map): void {
  map.addSource(SOURCE, {
    type: 'raster-dem',
    tiles: [`${PROTOCOL}://{z}/{x}/{y}`],
    tileSize: DEM_TILE_SIZE,
    maxzoom: DEM_MAX_ZOOM,
    encoding: 'terrarium',
  });
  map.setTerrain({ source: SOURCE });
}
