// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A known terrain for the end-to-end tests, served without the network
 *
 * The elevation tiles are made in the page: a `raster-dem` source reads them through a
 * protocol registered with maplibre, and each tile is drawn with the terrarium encoding into an
 * OffscreenCanvas and handed over as a PNG. The surface is a steep peak on a tilted plane, so
 * reading the DEM half a pixel off moves the elevation by meters, not by rounding. A flat
 * surface at 0 m is there too, for what must look the same with the terrain as without it.
 *
 * It runs in the page (it is bundled into `page-entry.ts`).
 */

import type * as MapLibre from 'maplibre-gl';

/** The protocol the elevation tiles are read through */
const PROTOCOL = 'e2e-dem';

/** The source id of the terrain */
export const TEST_DEM_SOURCE = 'e2e-dem';

/** The deepest zoom of the elevation tiles */
const DEM_MAX_ZOOM = 12;

/** The side of an elevation tile in pixels */
const DEM_TILE_SIZE = 256;

/** The top of the peak */
export const TEST_PEAK: readonly [number, number] = [138.73, 35.36];

/**
 * The elevation of the test terrain in meters (before the exaggeration)
 *
 * A Gaussian peak of 3000 m with a spread of about 1.5 km on a plane that rises 200 m per
 * kilometer to the east, crossed by ridges 40 m high and a few hundred meters apart. Its
 * steepest slope is above 1, so half a DEM pixel (about 15 m at the zoom the tests use) moves
 * the elevation by more than ten meters, and the ridges make a coarser DEM tile of the same
 * place differ from a finer one by meters.
 */
export function testElevation(lng: number, lat: number): number {
  const kmPerDegLat = 111.32;
  const kmPerDegLng = kmPerDegLat * Math.cos((TEST_PEAK[1] * Math.PI) / 180);
  const dx = (lng - TEST_PEAK[0]) * kmPerDegLng;
  const dy = (lat - TEST_PEAK[1]) * kmPerDegLat;
  const peak = 3000 * Math.exp(-(dx * dx + dy * dy) / (2 * 1.5 * 1.5));
  const ridges = 40 * Math.sin((dx * 2 * Math.PI) / 0.35) * Math.sin((dy * 2 * Math.PI) / 0.45);
  return 1000 + peak + 200 * dx + ridges;
}

/** The longitude and latitude of a point of a tile (fractions of the tile) */
function tilePointToLngLat(z: number, x: number, y: number, fx: number, fy: number): number[] {
  const n = 2 ** z;
  const lng = ((x + fx) / n) * 360 - 180;
  const my = Math.PI * (1 - (2 * (y + fy)) / n);
  const lat = (Math.atan(Math.sinh(my)) * 180) / Math.PI;
  return [lng, lat];
}

/**
 * One elevation tile as a terrarium PNG
 *
 * @param flat Whether the tile is of the flat terrain (0 m everywhere) instead of the peak
 */
async function renderTile(z: number, x: number, y: number, flat: boolean): Promise<ArrayBuffer> {
  const size = DEM_TILE_SIZE;
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      // A DEM pixel describes the cell centred on it
      const [lng, lat] = tilePointToLngLat(z, x, y, (i + 0.5) / size, (j + 0.5) / size);
      const v = (flat ? 0 : testElevation(lng, lat)) + 32768;
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
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blob.arrayBuffer();
}

/** Registers the protocol of the elevation tiles (once per page) */
export function installTestDem(maplibregl: typeof MapLibre): void {
  maplibregl.addProtocol(PROTOCOL, async (params) => {
    const match = /^e2e-dem:\/\/(flat\/)?(\d+)\/(\d+)\/(\d+)$/.exec(params.url);
    if (!match) throw new Error(`unexpected elevation tile ${params.url}`);
    const [z, x, y] = match.slice(2).map(Number);
    return { data: await renderTile(z, x, y, match[1] !== undefined) };
  });
}

/** The options of the test terrain */
export interface TestTerrainOptions {
  /**
   * A flat terrain at 0 m instead of the peak, for what must look the same as without the
   * terrain (the widths of the lines)
   */
  flat?: boolean;
}

/**
 * Puts the test terrain on a map and waits until every tile of it has arrived
 *
 * @param exaggeration The vertical exaggeration of the terrain
 */
export async function addTestTerrain(
  map: MapLibre.Map,
  exaggeration: number,
  options: TestTerrainOptions = {},
): Promise<void> {
  map.addSource(TEST_DEM_SOURCE, {
    type: 'raster-dem',
    tiles: [`${PROTOCOL}://${options.flat ? 'flat/' : ''}{z}/{x}/{y}`],
    tileSize: DEM_TILE_SIZE,
    maxzoom: DEM_MAX_ZOOM,
    encoding: 'terrarium',
  });
  map.setTerrain({ source: TEST_DEM_SOURCE, exaggeration });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the terrain did not load')), 20_000);
    map.once('idle', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
