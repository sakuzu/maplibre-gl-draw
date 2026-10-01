// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The generated data of datasets: 250,000 hexagonal cells over the wider city around the sample
// buildings, and 1,000,000 points over the Kanto area, with a stand-in for the server that
// hands over the points of a part of the map. Both are made in code, the same on every run,
// and leave out the Imperial Palace and its gardens; the points leave out the water of the
// bays too. The functions without parameters give every cell and every point, so that a test
// can check where they lie.

import type { DatasetRow } from '@sakuzu/maplibre-gl-draw';

/** [west, south, east, north] in degrees */
type Box = [number, number, number, number];

/** The Imperial Palace, its East Gardens and Kitanomaru Park, where nothing is placed */
const PALACE: Box = [139.743, 35.676, 139.765, 35.695];

/** Kilometers per degree of latitude */
const KM_PER_LAT = 111.2;

/**
 * The cells: hexagons of 12 m a side in rows from the south, 570 to a row (12 km), around the
 * box of the sample buildings, until there are 250,000 of them (8.4 km from south to north)
 */
export const CELLS = {
  center: [139.778, 35.678] as [number, number],
  columns: 570,
  widthKm: 12,
  southKm: -4.2,
  count: 250_000,
};

/** The points: 1,000,000 of them, over about 100 km of the Kanto area around Tokyo */
export const POINTS = {
  extent: [139.15, 35.23, 140.25, 36.13] as Box,
  count: 1_000_000,
};

/** The values of the `kind` attribute of the points: how a trip that starts there is made */
export const KINDS = ['walk', 'bicycle', 'car', 'train'];

/**
 * A generator of numbers from 0 to 1, the same from the same seed (mulberry32), so that the
 * data is the same on every run
 */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function overlaps(a: Box, b: Box): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * The value of a cell, from 0 to 100, that varies smoothly over the city: two waves and a
 * rise towards the east of the station
 */
function cellValue(xKm: number, yKm: number): number {
  const rise = 35 * Math.exp(-((xKm - 0.5) ** 2 + (yKm - 0.3) ** 2) / 6);
  const value =
    35 +
    20 * Math.sin(xKm / 1.3 + 0.4) * Math.cos(yKm / 1.1) +
    12 * Math.sin((xKm + 2 * yKm) / 2.3) +
    rise;
  return Math.round(Math.min(100, Math.max(0, value)));
}

/**
 * The cells as rows: a hexagon with a `value` from 0 to 100 each, `count` of them in rows from
 * the south, the cells that would reach into the palace left out
 */
export function createCells(count: number): DatasetRow[] {
  const [lng0, lat0] = CELLS.center;
  const kmPerLng = KM_PER_LAT * Math.cos((lat0 * Math.PI) / 180);
  // The radius of a hexagon (pointy at the top), from the width of a row
  const r = CELLS.widthKm / (CELLS.columns * Math.sqrt(3));
  const [dx, dy] = [Math.sqrt(3) * r, 1.5 * r];
  /** The corners of a hexagon around its center, in km */
  const corners = Array.from({ length: 6 }, (_, k) => {
    const angle = ((90 + 60 * k) * Math.PI) / 180;
    return [r * Math.cos(angle), r * Math.sin(angle)];
  });
  const round = (value: number) => Math.round(value * 1e7) / 1e7;
  const rows: DatasetRow[] = [];
  for (let j = 0; rows.length < count; j++) {
    const y = CELLS.southKm + j * dy;
    for (let i = 0; i < CELLS.columns && rows.length < count; i++) {
      const x = -CELLS.widthKm / 2 + (i + (j % 2) / 2) * dx;
      const [lng, lat] = [lng0 + x / kmPerLng, lat0 + y / KM_PER_LAT];
      const [halfLng, halfLat] = [r / kmPerLng, r / KM_PER_LAT];
      if (overlaps([lng - halfLng, lat - halfLat, lng + halfLng, lat + halfLat], PALACE)) continue;
      const ring = corners.map(([cx, cy]) => [
        round(lng0 + (x + cx) / kmPerLng),
        round(lat0 + (y + cy) / KM_PER_LAT),
      ]);
      ring.push(ring[0]);
      rows.push({
        type: 'Feature',
        id: `cell-${j}-${i}`,
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { value: cellValue(x, y) },
      });
    }
  }
  return rows;
}

/** Every cell, as one MultiPolygon */
export const everyCell = () => ({
  type: 'MultiPolygon',
  coordinates: createCells(CELLS.count).map((row) => (row.geometry as GeoJSON.Polygon).coordinates),
});

/**
 * The centers the points gather around, with their weight and their spread in km: the wards
 * of Tokyo first, then the cities around them
 */
const CENTERS: Array<[lng: number, lat: number, weight: number, spreadKm: number]> = [
  [139.775, 35.682, 3, 3.0], // East of Tokyo Station
  [139.7, 35.69, 3, 3.0], // Shinjuku
  [139.702, 35.658, 2, 2.5], // Shibuya
  [139.711, 35.729, 2, 2.5], // Ikebukuro
  [139.74, 35.62, 2, 3.0], // Shinagawa
  [139.8, 35.715, 2, 3.0], // Ueno and Asakusa
  [139.83, 35.69, 3, 4.0], // Koto and Sumida
  [139.63, 35.69, 6, 7.0], // The western wards
  [139.75, 35.76, 5, 5.5], // The northern wards
  [139.6, 35.47, 6, 5.0], // Yokohama
  [139.68, 35.55, 4, 4.0], // Kawasaki
  [139.63, 35.87, 5, 5.0], // Saitama
  [140.11, 35.62, 3, 4.0], // Chiba
  [139.985, 35.71, 4, 4.0], // Funabashi and Ichikawa
  [139.32, 35.66, 2, 4.0], // Hachioji
  [139.41, 35.7, 3, 4.0], // Tachikawa
  [139.43, 35.56, 3, 4.5], // Machida and Sagamihara
  [139.96, 35.86, 3, 4.0], // Kashiwa and Matsudo
  [139.47, 35.8, 3, 4.0], // Tokorozawa
  [139.48, 35.35, 2, 4.0], // Fujisawa
  [139.49, 35.92, 2, 3.5], // Kawagoe
];

/** A rough outline of Tokyo Bay, where no point is placed */
const TOKYO_BAY: Array<[number, number]> = [
  [139.765, 35.63],
  [139.83, 35.643],
  [139.92, 35.66],
  [139.99, 35.665],
  [140.06, 35.62],
  [140.1, 35.58],
  [140.05, 35.52],
  [139.95, 35.45],
  [139.9, 35.38],
  [139.83, 35.31],
  [139.78, 35.2],
  [139.68, 35.2],
  [139.67, 35.28],
  [139.65, 35.36],
  [139.66, 35.43],
  [139.7, 35.48],
  [139.76, 35.52],
  [139.8, 35.56],
  [139.78, 35.6],
];

/** Whether a position is in the water: Tokyo Bay, or Sagami Bay south of the coast */
function inWater(lng: number, lat: number): boolean {
  if (lat < 35.305 && lng < 139.63) return true;
  if (lng < 139.64 || lng > 140.11 || lat < 35.19 || lat > 35.67) return false;
  let inside = false;
  for (let i = 0, j = TOKYO_BAY.length - 1; i < TOKYO_BAY.length; j = i++) {
    const [xi, yi] = TOKYO_BAY[i];
    const [xj, yj] = TOKYO_BAY[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** The points: their positions (longitude and latitude of each in turn) and their kinds */
export interface Points {
  coords: Float64Array;
  kinds: Uint8Array;
  /** The time each trip takes, in minutes */
  minutes: Uint8Array;
}

/**
 * Makes `count` points in typed arrays, without an object per point: most of them gather
 * around the centers, the rest are spread over the land. Near the middle of Tokyo more trips
 * are made on foot and by train, further out more by car
 */
export function createPoints(count: number): Points {
  const next = random(20_261_001);
  const coords = new Float64Array(count * 2);
  const kinds = new Uint8Array(count);
  const minutes = new Uint8Array(count);
  const [west, south, east, north] = POINTS.extent;
  const kmPerLng = KM_PER_LAT * Math.cos((35.7 * Math.PI) / 180);
  const total = CENTERS.reduce((sum, [, , weight]) => sum + weight, 0);
  for (let n = 0; n < count; ) {
    let lng: number;
    let lat: number;
    if (next() < 0.2) {
      // Spread over the whole area
      lng = west + (east - west) * next();
      lat = south + (north - south) * next();
    } else {
      // Around a center, by its weight, in a normal distribution (Box-Muller)
      let pick = next() * total;
      let c = 0;
      while (pick > CENTERS[c][2]) pick -= CENTERS[c++][2];
      const [cLng, cLat, , spread] = CENTERS[c];
      const radius = spread * Math.sqrt(-2 * Math.log(1 - next()));
      const angle = 2 * Math.PI * next();
      lng = cLng + (radius * Math.cos(angle)) / kmPerLng;
      lat = cLat + (radius * Math.sin(angle)) / KM_PER_LAT;
    }
    if (lng < west || lng > east || lat < south || lat > north) continue;
    if (lng >= PALACE[0] && lng <= PALACE[2] && lat >= PALACE[1] && lat <= PALACE[3]) continue;
    if (inWater(lng, lat)) continue;
    coords[n * 2] = lng;
    coords[n * 2 + 1] = lat;
    // The distance from the station, in km, makes the kinds
    const km = Math.hypot((lng - 139.767) * kmPerLng, (lat - 35.681) * KM_PER_LAT);
    const urban = Math.exp(-km / 15);
    const walk = 0.15 + 0.2 * urban;
    const bicycle = walk + 0.15 + 0.05 * urban;
    const car = bicycle + 0.5 - 0.4 * urban;
    const u = next();
    kinds[n] = u < walk ? 0 : u < bicycle ? 1 : u < car ? 2 : 3;
    minutes[n] = 5 + Math.floor(next() * 85);
    n++;
  }
  return { coords, kinds, minutes };
}

/** Every point, as its positions */
export const everyPoint = () => createPoints(POINTS.count).coords;

/**
 * A stand-in for a server that holds the points and hands over those of a part of the map, as
 * rows: every one of them from zoom 14, and a sample of them below (a quarter at zoom 13, a
 * sixteenth at 12, and so on), as a server sends fewer rows for a wider view. The points are
 * sorted into a grid of cells of 0.02 degrees, so a part of the map reads only its cells
 */
export class PointServer {
  private readonly points: Points;
  private readonly order: Int32Array;
  private readonly starts: Int32Array;
  private readonly columns: number;
  private readonly rowsOfGrid: number;
  private static readonly CELL = 0.02;

  constructor(points: Points) {
    this.points = points;
    const [west, south, east, north] = POINTS.extent;
    const cell = PointServer.CELL;
    this.columns = Math.ceil((east - west) / cell);
    this.rowsOfGrid = Math.ceil((north - south) / cell);
    const count = points.coords.length / 2;
    const cellOf = new Int32Array(count);
    this.starts = new Int32Array(this.columns * this.rowsOfGrid + 1);
    for (let i = 0; i < count; i++) {
      const c = this.cellAt(points.coords[i * 2], points.coords[i * 2 + 1]);
      cellOf[i] = c;
      this.starts[c + 1]++;
    }
    for (let c = 0; c < this.columns * this.rowsOfGrid; c++) this.starts[c + 1] += this.starts[c];
    const fill = this.starts.slice(0, -1);
    this.order = new Int32Array(count);
    for (let i = 0; i < count; i++) this.order[fill[cellOf[i]]++] = i;
  }

  private cellAt(lng: number, lat: number): number {
    const [west, south] = POINTS.extent;
    const x = Math.min(this.columns - 1, Math.max(0, Math.floor((lng - west) / PointServer.CELL)));
    const y = Math.min(
      this.rowsOfGrid - 1,
      Math.max(0, Math.floor((lat - south) / PointServer.CELL)),
    );
    return y * this.columns + x;
  }

  /** The rows of the points in the box, a sample of them below zoom 14 */
  query([west, south, east, north]: Box, zoom: number): DatasetRow[] {
    const stride = 4 ** Math.max(0, 14 - Math.floor(zoom));
    const { coords, kinds, minutes } = this.points;
    const [x0, y0] = this.cellXY(west, south);
    const [x1, y1] = this.cellXY(east, north);
    const rows: DatasetRow[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const c = y * this.columns + x;
        for (let k = this.starts[c]; k < this.starts[c + 1]; k++) {
          const i = this.order[k];
          if (i % stride !== 0) continue;
          const [lng, lat] = [coords[i * 2], coords[i * 2 + 1]];
          if (lng < west || lng > east || lat < south || lat > north) continue;
          rows.push({
            type: 'Feature',
            id: `trip-${i}`,
            geometry: { type: 'Point', coordinates: [lng, lat] },
            properties: { kind: KINDS[kinds[i]], minutes: minutes[i] },
          });
        }
      }
    }
    return rows;
  }

  private cellXY(lng: number, lat: number): [number, number] {
    const c = this.cellAt(lng, lat);
    return [c % this.columns, Math.floor(c / this.columns)];
  }
}
