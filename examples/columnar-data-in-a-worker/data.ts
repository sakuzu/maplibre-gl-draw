// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The generated data of columnar-data-in-a-worker: 1,000,000 points over the wider Tokyo area,
// made by the Worker straight into the typed arrays of a table in the layout of GeoArrow. They
// are the same on every run, and leave out the Imperial Palace and its gardens and the water
// of Tokyo Bay. `everyPoint`, without parameters, gives the positions of all of them, so that a
// test can check where they lie.

import type { Table, TableGeometry } from '@sakuzu/maplibre-gl-draw/table';

/** [west, south, east, north] in degrees */
type Box = [number, number, number, number];

/** The points: how many, and the box they lie in */
export const MILLION = {
  count: 1_000_000,
  extent: [139.45, 35.48, 140.1, 35.9] as Box,
};

/** The values of the `kind` column: how a trip that starts there is made */
export const KINDS = ['walk', 'bicycle', 'car', 'train'];

/** The Imperial Palace, its East Gardens and Kitanomaru Park, where no point is placed */
const PALACE: Box = [139.743, 35.676, 139.765, 35.695];

/** Kilometers per degree of latitude */
const KM_PER_LAT = 111.2;

/** The centers the points gather around: longitude, latitude, weight and spread in km */
const CENTERS: Array<[number, number, number, number]> = [
  [139.775, 35.682, 3, 3.0], // East of Tokyo Station
  [139.7, 35.69, 3, 3.0], // Shinjuku
  [139.702, 35.658, 2, 2.5], // Shibuya
  [139.711, 35.729, 2, 2.5], // Ikebukuro
  [139.8, 35.715, 2, 3.0], // Ueno and Asakusa
  [139.83, 35.69, 3, 4.0], // Koto and Sumida
  [139.63, 35.69, 6, 7.0], // The western wards
  [139.75, 35.76, 5, 5.5], // The northern wards
  [139.6, 35.52, 4, 4.5], // Yokohama, its north
  [139.68, 35.55, 4, 4.0], // Kawasaki
  [139.63, 35.86, 4, 4.5], // Saitama
  [139.985, 35.71, 4, 4.0], // Funabashi and Ichikawa
  [139.96, 35.86, 3, 4.0], // Kashiwa and Matsudo
  [139.5, 35.7, 3, 4.5], // Mitaka to Kokubunji
];

/** A rough outline of the north of Tokyo Bay, where no point is placed */
const TOKYO_BAY: Array<[number, number]> = [
  [139.765, 35.63],
  [139.83, 35.643],
  [139.92, 35.66],
  [139.99, 35.665],
  [140.06, 35.62],
  [140.1, 35.58],
  [140.1, 35.47],
  [139.76, 35.47],
  [139.76, 35.52],
  [139.8, 35.56],
  [139.78, 35.6],
];

function inBay(lng: number, lat: number): boolean {
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

/**
 * A table of `count` points: the coordinates in one `Float64Array`, longitude and latitude of
 * each row in turn, the kind of each row as a dictionary of `Uint8Array` codes, and the minutes
 * of each trip in a `Uint8Array`. There is no object per row. Most points gather around the
 * centers, the rest are spread over the box; near the middle of Tokyo more trips are made on
 * foot and by train, further out more by car
 */
export function createMillion(count: number): Table {
  // mulberry32: the same numbers on every run
  let seed = 20_261_002;
  const next = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const coords = new Float64Array(count * 2);
  const kinds = new Uint8Array(count);
  const minutes = new Uint8Array(count);
  const [west, south, east, north] = MILLION.extent;
  const kmPerLng = KM_PER_LAT * Math.cos((35.7 * Math.PI) / 180);
  const total = CENTERS.reduce((sum, [, , weight]) => sum + weight, 0);
  for (let n = 0; n < count; ) {
    let lng: number;
    let lat: number;
    if (next() < 0.2) {
      lng = west + (east - west) * next();
      lat = south + (north - south) * next();
    } else {
      // Around a center chosen by its weight, in a normal distribution (Box-Muller)
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
    if (lat < 35.67 && lng > 139.76 && inBay(lng, lat)) continue;
    coords[n * 2] = lng;
    coords[n * 2 + 1] = lat;
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
  return {
    length: count,
    geometry: { type: 'Point', coords },
    columns: { kind: { codes: kinds, dictionary: KINDS }, minutes },
  };
}

/** The positions of every point */
export const everyPoint = () => (createMillion(MILLION.count).geometry as TableGeometry).coords;
