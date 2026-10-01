// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample data of 200000-features: a made-up city west of central Tokyo, made in code.
// The streets form a bent grid of blocks, and each block is filled with lots and the houses on
// them; a few blocks are parks, and a few houses have a shop or a clinic. The random numbers
// start from the same seed, so the city is the same on every visit.

import type { DrawDocument, Feature, PointShape, StyleRule } from '@sakuzu/maplibre-gl-draw';

type LngLat = [number, number];

type CityFeature = Pick<Feature, 'id' | 'type' | 'geometry' | 'style' | 'properties'>;

/** The center of the city and of the map */
export const CENTER: LngLat = [139.664, 35.652];

/** How far the city reaches from its center to the east, west, north and south, in kilometers */
export const HALF_SIZE_KM = 4.2;

/** The ID of the park that the page selects */
export const PARK_ID = 'park-selected';

/**
 * Where the selected park starts, in kilometers east and north of the center: in front of the
 * tilted camera of the page, which looks north-north-east
 */
export const PARK_AT_KM: [number, number] = [-0.12, -0.29];

/** The number of features of each geometry type */
export interface CityCounts {
  /** Buildings and parks */
  polygons: number;
  /** Streets */
  lines: number;
  /** Places */
  points: number;
  total: number;
}

export interface City {
  document: DrawDocument;
  counts: CityCounts;
}

/**
 * Makes the city: streets on a bent grid, blocks of houses on their lots, parks, and places on
 * some of the houses, in three layers (streets, buildings and places, from the back)
 *
 * @param center The center of the city
 * @param halfSizeKm How far the city reaches from its center on each side, in kilometers
 * @param parkAtKm Where the selected park starts, in kilometers east and north of the center
 */
export function createCity(center: LngLat, halfSizeKm: number, parkAtKm: [number, number]): City {
  const frame = new Frame(center);
  const buildings: CityFeature[] = [];
  const streets: CityFeature[] = [];
  const places: CityFeature[] = [];

  // Columns about 100 m apart and rows about 55 m apart: long blocks, as in a residential area
  const xs = gridLines(frame, halfSizeKm, 0.08, 0.13);
  const ys = gridLines(frame, halfSizeKm, 0.045, 0.065);

  // The park takes the block at `parkAtKm` and its neighbors to the east and to the north
  const parkI = Math.max(0, xs.findIndex((x) => x > parkAtKm[0]) - 1);
  const parkJ = Math.max(0, ys.findIndex((y) => y > parkAtKm[1]) - 1);

  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < ys.length - 1; j++) {
      const west = xs[i];
      const east = xs[i + 1];
      const south = ys[j];
      const north = ys[j + 1];

      // The streets on the west and the north side of the block; every eighth line is an
      // avenue. No street runs through the park
      if (!(j === parkJ && (i === parkI || i === parkI + 1))) {
        streets.push(street(frame, streets.length, [west, north], [east, north], j % 8 === 7));
      }
      if (!(i === parkI + 1 && (j === parkJ || j === parkJ + 1))) {
        streets.push(street(frame, streets.length, [west, south], [west, north], i % 8 === 0));
      }

      const inPark = (i === parkI || i === parkI + 1) && (j === parkJ || j === parkJ + 1);
      if (inPark) {
        if (i === parkI && j === parkJ) {
          buildings.push(selectedPark(frame, west, south, xs[i + 2], ys[j + 2]));
        }
      } else if (frame.random() < 0.025) {
        buildings.push({
          id: `park-${buildings.length}`,
          type: 'Polygon',
          geometry: {
            type: 'Polygon',
            coordinates: [
              rectangle(frame, west + 0.006, south + 0.006, east - 0.006, north - 0.006, 3),
            ],
          },
          properties: { use: 'Park' },
          style: BUILDING_STYLE,
        });
      } else {
        fillBlock(frame, buildings, places, west, south, east, north);
      }
    }
  }

  const layers = [
    { id: 'layer-streets', name: 'Streets', features: streets },
    { id: 'layer-buildings', name: 'Buildings', features: buildings },
    { id: 'layer-places', name: 'Places', features: places },
  ];
  const document: DrawDocument = {
    version: '3.0.0',
    metadata: { title: 'City' },
    layerOrder: layers.map((layer) => layer.id),
    layers: layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      visible: true,
      locked: false,
      opacity: 1,
      items: layer.features.map((feature) => feature.id),
      styleRule: RULES[layer.id],
      metadata: undefined,
    })),
    features: layers.flatMap((layer) =>
      layer.features.map((feature) => ({
        ...feature,
        layerId: layer.id,
        groupId: undefined,
        visible: true,
        locked: false,
      })),
    ),
    files: {},
  };
  return {
    document,
    counts: {
      polygons: buildings.length,
      lines: streets.length,
      points: places.length,
      total: buildings.length + streets.length + places.length,
    },
  };
}

/**
 * The outline of the city around `CENTER`, as a closed ring: a cheap stand-in for its 200,000
 * features, for the checks that walk the sample data
 */
export function cityExtent(): LngLat[] {
  const frame = new Frame(CENTER);
  // The grid ends within one block beyond the extent, and the bend moves it by 55 m at most
  const reach = HALF_SIZE_KM + 0.2;
  return [
    [-reach, -reach],
    [reach, -reach],
    [reach, reach],
    [-reach, reach],
    [-reach, -reach],
  ].map(([x, y]) => frame.toDegrees(x, y));
}

/** The colors of the layers, as style rules on a property of the features */
const RULES: Record<string, StyleRule> = {
  'layer-buildings': {
    kind: 'categorical',
    property: 'use',
    map: {
      House: '#9ab8e0',
      Apartment: '#5b7fc7',
      Shop: '#f08a4b',
      Park: '#6cbf84',
    },
    other: '#cccccc',
  },
  'layer-streets': {
    kind: 'categorical',
    property: 'class',
    map: { Avenue: '#e4574f', Street: '#9aa3b2' },
    other: '#cccccc',
  },
  'layer-places': {
    kind: 'categorical',
    property: 'kind',
    map: { Cafe: '#d62f7a', Clinic: '#1f9e89', Bakery: '#f2b134' },
    other: '#cccccc',
  },
};

const BUILDING_STYLE = { fillOpacity: 0.92, strokeColor: '#33415c', strokeWidth: 0.8 };

const PLACE_KINDS: ReadonlyArray<{ name: string; shape: PointShape }> = [
  { name: 'Cafe', shape: 'circle' },
  { name: 'Clinic', shape: 'square' },
  { name: 'Bakery', shape: 'star' },
];

/** Positions in kilometers east and north of the center, and the random numbers of the city */
class Frame {
  readonly lngPerKm: number;
  readonly latPerKm = 1 / 111.2;
  private seed = 7_302_117;

  constructor(readonly center: LngLat) {
    this.lngPerKm = 1 / (111.2 * Math.cos((center[1] * Math.PI) / 180));
  }

  /** The degrees of a position in kilometers, bent a little so that the grid is not ruled */
  toLngLat(x: number, y: number): LngLat {
    const bx = x + 0.035 * Math.sin(y / 0.55 + 0.4) + 0.02 * Math.sin((x + y) / 0.31);
    const by = y + 0.035 * Math.sin(x / 0.7 + 1.3) + 0.02 * Math.sin((x - y) / 0.27);
    return this.toDegrees(bx, by);
  }

  /** The degrees of a position in kilometers, without the bend */
  toDegrees(x: number, y: number): LngLat {
    return [round(this.center[0] + x * this.lngPerKm), round(this.center[1] + y * this.latPerKm)];
  }

  random(): number {
    // mulberry32: the same numbers on every run, so the city does not change
    this.seed = (this.seed + 0x6d2b79f5) | 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  between(min: number, max: number): number {
    return min + (max - min) * this.random();
  }
}

function round(value: number): number {
  return Math.round(value * 1e7) / 1e7;
}

/** Grid lines from `-half` to `half`, at spacings between `min` and `max` */
function gridLines(frame: Frame, half: number, min: number, max: number): number[] {
  const lines = [-half];
  while (lines[lines.length - 1] < half) {
    lines.push(lines[lines.length - 1] + frame.between(min, max));
  }
  return lines;
}

/** A rectangle in kilometers as a closed ring in degrees, each side in `steps` segments */
function rectangle(
  frame: Frame,
  west: number,
  south: number,
  east: number,
  north: number,
  steps = 1,
): LngLat[] {
  const corners: LngLat[] = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
  ];
  const ring: LngLat[] = [];
  for (let side = 0; side < 4; side++) {
    const [x0, y0] = corners[side];
    const [x1, y1] = corners[(side + 1) % 4];
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      ring.push(frame.toLngLat(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t));
    }
  }
  ring.push(ring[0]);
  return ring;
}

/** A street between two positions, in three segments so that it follows the bent grid */
function street(
  frame: Frame,
  index: number,
  from: LngLat,
  to: LngLat,
  avenue: boolean,
): CityFeature {
  const coordinates: LngLat[] = [];
  for (let k = 0; k <= 3; k++) {
    const t = k / 3;
    coordinates.push(
      frame.toLngLat(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t),
    );
  }
  return {
    id: `street-${index}`,
    type: 'LineString',
    geometry: { type: 'LineString', coordinates },
    properties: { class: avenue ? 'Avenue' : 'Street' },
    style: { strokeWidth: avenue ? 5 : 2.5, strokeOpacity: 1 },
  };
}

/**
 * Fills a block with two rows of lots, back to back. Each lot has a house set back from the
 * street; a few lots are joined into an apartment, and a few houses have a place on them
 */
function fillBlock(
  frame: Frame,
  buildings: CityFeature[],
  places: CityFeature[],
  west: number,
  south: number,
  east: number,
  north: number,
): void {
  const setback = 0.005;
  const middle = (south + north) / 2;
  for (const [rowSouth, rowNorth, front] of [
    [south + setback, middle - 0.001, 'south'],
    [middle + 0.001, north - setback, 'north'],
  ] as const) {
    let x = west + setback;
    while (x < east - setback - 0.006) {
      const apartment = frame.random() < 0.12;
      const width = Math.min(
        east - setback - x,
        apartment ? frame.between(0.022, 0.034) : frame.between(0.009, 0.014),
      );
      const depth = (rowNorth - rowSouth) * (apartment ? 0.9 : frame.between(0.55, 0.8));
      const houseSouth = front === 'south' ? rowSouth : rowNorth - depth;
      const use = apartment ? 'Apartment' : frame.random() < 0.05 ? 'Shop' : 'House';
      buildings.push({
        id: `building-${buildings.length}`,
        type: 'Polygon',
        geometry: {
          type: 'Polygon',
          coordinates: [
            rectangle(frame, x + 0.0012, houseSouth, x + width - 0.0012, houseSouth + depth),
          ],
        },
        properties: { use },
        style: BUILDING_STYLE,
      });
      if (use === 'Shop' || frame.random() < 0.01) {
        const kind = PLACE_KINDS[Math.floor(frame.random() * PLACE_KINDS.length)];
        places.push({
          id: `place-${places.length}`,
          type: 'Point',
          geometry: {
            type: 'Point',
            coordinates: frame.toLngLat(x + width / 2, houseSouth + depth / 2),
          },
          properties: { kind: kind.name },
          style: { pointShape: kind.shape, pointRadius: 4.5 },
        });
      }
      x += width;
    }
  }
}

/** The park that the page selects: an outline with a bend on each side, over four blocks */
function selectedPark(
  frame: Frame,
  west: number,
  south: number,
  east: number,
  north: number,
): CityFeature {
  const inset = 0.006;
  const w = west + inset;
  const e = east - inset;
  const s = south + inset;
  const n = north - inset;
  const dx = (e - w) / 3;
  const dy = (n - s) / 3;
  const outline: LngLat[] = [
    [w, s],
    [w + dx, s + dy * 0.25],
    [e - dx, s],
    [e, s + dy],
    [e - dx * 0.2, n - dy],
    [e, n],
    [e - dx * 1.3, n - dy * 0.3],
    [w + dx, n],
    [w, n - dy * 1.2],
    [w + dx * 0.25, s + dy],
  ];
  const ring = outline.map(([x, y]) => frame.toLngLat(x, y));
  ring.push(ring[0]);
  return {
    id: PARK_ID,
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { use: 'Park', name: 'Park' },
    style: BUILDING_STYLE,
  };
}
