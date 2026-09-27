// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The large-data scene: a city of editable features
 *
 * Every building, street and place of the scene is an editable feature of the Store, loaded
 * with `draw.load()`: each one can be selected, moved and reshaped. The tilted camera shows
 * them near at hand, where they can be told apart, and far into the distance, where they
 * become a texture. A park in the foreground is selected, with its frame and vertex handles.
 *
 * The city is made up. The streets form a bent grid of blocks, and each block is filled with
 * lots and the houses on them; a few blocks are parks, and a few houses have a shop or a
 * clinic. Only the water is real: it comes from the basemap, so that nothing is placed in a
 * river.
 */

import type { Data, StyleRule } from '@sakuzu/maplibre-gl-draw';
import type * as maplibregl from 'maplibre-gl';

import { QUIET_BASEMAP } from './overview';
import { buildDocument, type SceneFeature, type ShowcaseScene } from './scene';

/** The park that is selected, placed in the foreground */
const SELECTED_FEATURE = 'park-selected';

/** Where the selected park is placed, as a fraction of the width and the height of the map */
const SELECTED_AT = { x: 0.52, y: 0.8 };

/** The extent of the city around the center of the camera, in kilometers */
const HALF_WIDTH_KM = 4.2;
const HALF_HEIGHT_KM = 4.2;

/** The width of the land mask, in pixels */
const MASK_WIDTH = 2048;

/** The number of features, for the legend, and the time `draw.load` took, for the console */
const counts = { buildings: 0, streets: 0, places: 0, total: 0, loadMs: 0 };

export const largeDataScene: ShowcaseScene = {
  basemap: QUIET_BASEMAP,
  camera: { center: [139.664, 35.652], zoom: 16.2, pitch: 62, bearing: 28 },
  mapOnly: true,
  async load({ draw, map }) {
    quietBasemap(map);
    await settled(map);
    const document = createCity(map);
    const started = performance.now();
    await draw.load(document);
    counts.loadMs = performance.now() - started;
    console.info(
      `large-data: ${counts.total} features (${counts.buildings} buildings, ` +
        `${counts.streets} streets, ${counts.places} places), draw.load ${Math.round(counts.loadMs)} ms`,
    );
  },
  async finish({ draw, map }) {
    draw.select(SELECTED_FEATURE);
    addLegend(map);
  },
};

/** Hides the roads and the buildings of the basemap, which the made-up city replaces */
function quietBasemap(map: maplibregl.Map): void {
  for (const layer of map.getStyle().layers) {
    const sourceLayer = 'source-layer' in layer ? layer['source-layer'] : undefined;
    if (
      sourceLayer === 'transportation' ||
      sourceLayer === 'transportation_name' ||
      sourceLayer === 'building' ||
      sourceLayer === 'poi'
    ) {
      map.setLayoutProperty(layer.id, 'visibility', 'none');
    }
  }
}

function settled(map: maplibregl.Map): Promise<void> {
  if (map.loaded() && map.areTilesLoaded()) return Promise.resolve();
  return new Promise((resolve) => map.once('idle', () => resolve()));
}

type LngLat = [number, number];

/** Positions in kilometers east and north of the center, and back to degrees */
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
    return [round(this.center[0] + bx * this.lngPerKm), round(this.center[1] + by * this.latPerKm)];
  }

  random(): number {
    // mulberry32: the same numbers on every run, so the picture does not change
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
  const corners: [number, number][] = [
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

/**
 * Builds the city over the extent around the center of the camera: streets on a bent grid,
 * blocks of houses on their lots, parks, and places on some of the houses
 */
function createCity(map: maplibregl.Map): Data {
  const center = map.getCenter();
  const frame = new Frame([center.lng, center.lat]);
  const isLand = landMask(map, frame);

  const buildings: SceneFeature[] = [];
  const streets: SceneFeature[] = [];
  const places: SceneFeature[] = [];

  // Columns about 100 m apart and rows about 55 m apart: long blocks, as in a residential area
  const xs = gridLines(frame, HALF_WIDTH_KM, 0.08, 0.13);
  const ys = gridLines(frame, HALF_HEIGHT_KM, 0.045, 0.065);

  // The block of the selected park: the one under the given point of the screen
  const canvas = map.getCanvas();
  const target = map.unproject([
    canvas.clientWidth * SELECTED_AT.x,
    canvas.clientHeight * SELECTED_AT.y,
  ]);
  const targetX = (target.lng - frame.center[0]) / frame.lngPerKm;
  const targetY = (target.lat - frame.center[1]) / frame.latPerKm;
  // The park takes the block there and its neighbors to the east and to the north
  const parkI = Math.max(0, xs.findIndex((x) => x > targetX) - 1);
  const parkJ = Math.max(0, ys.findIndex((y) => y > targetY) - 1);

  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < ys.length - 1; j++) {
      const west = xs[i];
      const east = xs[i + 1];
      const south = ys[j];
      const north = ys[j + 1];
      const land = [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
      ].every(([x, y]) => isLand(x, y));
      if (!land) continue;

      // The streets on the west and the north side of the block; every eighth line is wider
      // No street runs through the park
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

  counts.buildings = buildings.length;
  counts.streets = streets.length;
  counts.places = places.length;
  counts.total = buildings.length + streets.length + places.length;

  const document = buildDocument('City', [
    { id: 'layer-streets', name: 'Streets', features: streets },
    { id: 'layer-buildings', name: 'Buildings', features: buildings },
    { id: 'layer-places', name: 'Places', features: places },
  ]);
  for (const layer of document.layers ?? []) {
    const rule = RULES[layer.id];
    if (rule) layer.styleRule = rule;
  }
  return document;
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

/** A street between two positions, in three segments so that it follows the bent grid */
function street(
  frame: Frame,
  index: number,
  from: [number, number],
  to: [number, number],
  avenue: boolean,
): SceneFeature {
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
    geometry: { type: 'LineString', coordinates: coordinates },
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
  buildings: SceneFeature[],
  places: SceneFeature[],
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

const PLACE_KINDS = [
  { name: 'Cafe', shape: 'circle' },
  { name: 'Clinic', shape: 'square' },
  { name: 'Bakery', shape: 'star' },
] as const;

/** The park in the foreground that is selected: an outline with a bend on each side */
function selectedPark(
  frame: Frame,
  west: number,
  south: number,
  east: number,
  north: number,
): SceneFeature {
  const inset = 0.006;
  const w = west + inset;
  const e = east - inset;
  const s = south + inset;
  const n = north - inset;
  const dx = (e - w) / 3;
  const dy = (n - s) / 3;
  const outline: [number, number][] = [
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
    id: SELECTED_FEATURE,
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { use: 'Park', name: 'Park' },
    style: BUILDING_STYLE,
  };
}

/**
 * The land around the center: the water polygons of the loaded basemap tiles painted into a
 * raster, read back as a test in kilometers
 */
function landMask(map: maplibregl.Map, frame: Frame): (x: number, y: number) => boolean {
  const west = frame.center[0] - HALF_WIDTH_KM * 1.2 * frame.lngPerKm;
  const east = frame.center[0] + HALF_WIDTH_KM * 1.2 * frame.lngPerKm;
  const south = frame.center[1] - HALF_HEIGHT_KM * 1.2 * frame.latPerKm;
  const north = frame.center[1] + HALF_HEIGHT_KM * 1.2 * frame.latPerKm;
  const width = MASK_WIDTH;
  const height = Math.round((width * HALF_HEIGHT_KM) / HALF_WIDTH_KM);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('No 2D canvas');
  const px = (lng: number) => ((lng - west) / (east - west)) * width;
  const py = (lat: number) => ((north - lat) / (north - south)) * height;
  const trace = (ring: number[][]) => {
    ring.forEach(([lng, lat], i) => {
      if (i === 0) context.moveTo(px(lng), py(lat));
      else context.lineTo(px(lng), py(lat));
    });
  };

  context.fillStyle = '#000';
  for (const feature of map.querySourceFeatures('openmaptiles', { sourceLayer: 'water' })) {
    const geometry = feature.geometry;
    const polygons =
      geometry.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry.type === 'MultiPolygon'
          ? geometry.coordinates
          : [];
    for (const polygon of polygons) {
      context.beginPath();
      for (const ring of polygon) {
        trace(ring);
        context.closePath();
      }
      context.fill('evenodd');
    }
  }
  const alpha = context.getImageData(0, 0, width, height).data;
  return (x, y) => {
    const [lng, lat] = frame.toLngLat(x, y);
    const col = Math.floor(px(lng));
    const row = Math.floor(py(lat));
    if (col < 0 || col >= width || row < 0 || row >= height) return false;
    return alpha[(row * width + col) * 4 + 3] < 128;
  };
}

/** The legend: the number of editable features in each layer */
function addLegend(map: maplibregl.Map): void {
  const format = (n: number) => n.toLocaleString('en-US');
  const card = document.createElement('div');
  card.className = 'showcase-legend';
  card.innerHTML =
    `<section><h2>${format(counts.total)} editable features</h2><ul>` +
    `<li>${format(counts.buildings)} polygons (buildings and parks)</li>` +
    `<li>${format(counts.streets)} lines (streets)</li>` +
    `<li>${format(counts.places)} points (places)</li>` +
    '</ul></section>';
  map.getContainer().appendChild(card);
}
