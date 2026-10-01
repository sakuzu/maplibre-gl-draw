// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// datasets: over a million rows shown beside an editable drawing.
// A dataset draws rows that are not features of the drawing: they are shown, not edited, and
// not saved with the drawing. Four of them lie under and over two layers of the user's drawing,
// a survey area and a planned route, on the light grey Positron basemap:
// - 1,000,000 points over the Kanto area, made in the page, handed over by a provider for the
//   part of the map in view as it moves and thinned where they overlap, colored by kind
// - 250,000 hexagonal cells over the wider city, given at once and colored by their value,
//   behind everything
// - the buildings of central Tokyo from Overture Maps (examples/public/data/), given at once,
//   colored by the area of their footprint, between the two layers of the drawing
// - the places of the same area, handed over for the view, colored by their category, in front
// The Legend tab of the panel on the left shows the rules of all four. A line drawn by the user
// snaps to the edges of the buildings. A click on a building, a place or a point is reported by
// an event, logged in the browser console. The T key turns the thinning of the points off and
// on, and the console says how many are drawn.

import {
  createDraw,
  type DatasetProvider,
  type DatasetRow,
  type StyleRule,
} from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { BASEMAPS, basemapStyle, basemapUrl, initialBasemapId } from '../basemap.ts';
import '../example.css';
import { CELLS, createCells, createPoints, KINDS, POINTS, PointServer } from './data.ts';

// Positron, a light grey basemap, so that the colors of the data read; the basemap row of the
// standard UI names it, and `?basemap=<id>` opens on another
const BASEMAP = 'positron';
const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(basemapUrl(BASEMAP)),
  center: [139.7725, 35.6745],
  zoom: 14.5,
  attributionControl: {
    customAttribution: '<a href="https://overturemaps.org">Overture Maps Foundation</a>',
  },
});
// 1. The drawing snaps to the rows of the interactive datasets too (the default, given here to
// show it), so a line drawn along a building follows its edges. The page makes its own layers
const draw = createDraw(map, { initDefaultLayer: false, snapping: { datasets: true } });
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale, basemaps: BASEMAPS, basemap: initialBasemapId(BASEMAP) });

// 2. Two layers of the user's drawing, there from the first frame: a survey area, to lie behind
// the buildings, and a planned route with its stops, in front of them. New drawings go to the
// route (the active layer)
const survey = draw.layers.create({ name: 'Survey area' });
const route = draw.layers.create({ name: 'Planned route' });
if (!survey || !route) throw new Error('The drawing is read-only');
draw.features.create({
  type: 'Polygon',
  layerId: survey.id,
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [139.7735, 35.6745],
        [139.7825, 35.6772],
        [139.7852, 35.6712],
        [139.7768, 35.6683],
        [139.7735, 35.6745],
      ],
    ],
  },
  properties: { name: 'Survey area' },
  style: { fillColor: '#fbbf24', fillOpacity: 0.35, strokeColor: '#b45309', strokeWidth: 2 },
});
const STOPS: Array<[string, [number, number]]> = [
  ['Nihonbashi', [139.774, 35.6823]],
  ['Kyobashi', [139.7701, 35.6769]],
  ['Tsukiji', [139.7726, 35.6668]],
];
const ROUTE_STYLE = { strokeColor: '#2563eb', strokeWidth: 4, pointColor: '#2563eb' };
draw.features.createMany([
  {
    type: 'LineString',
    layerId: route.id,
    geometry: {
      type: 'LineString',
      coordinates: [STOPS[0][1], STOPS[1][1], [139.7674, 35.6743], [139.7676, 35.67], STOPS[2][1]],
    },
    properties: { name: 'Planned route' },
    style: ROUTE_STYLE,
  },
  ...STOPS.map(([name, coordinates]) => ({
    type: 'Point' as const,
    layerId: route.id,
    geometry: { type: 'Point' as const, coordinates },
    properties: { name },
    style: { ...ROUTE_STYLE, pointRadius: 7, pointStrokeColor: '#ffffff', pointStrokeWidth: 2 },
  })),
]);
draw.layers.setActive(route.id);

/** A time in whole milliseconds, for the console */
const ms = (value: number): string => `${Math.round(value).toLocaleString('en')} ms`;

// 3. The cells, 250,000 hexagons over 12 km of the city (made in data.ts), given at once as
// rows once the map has loaded, without outlines, colored by their value from pale yellow to
// blue. With the order `layer-order` they stand in the stacking order of the layers, behind
// the survey area. They take no clicks, so the lines drawn snap to the buildings, not to them.
// The console says how long they took to make, to give and to reach the first frame drawn
const BY_VALUE: StyleRule = {
  kind: 'graduated',
  property: 'value',
  breaks: [20, 40, 60, 80],
  colors: ['#ffffcc', '#c7e9b4', '#7fcdbb', '#41b6c4', '#2c7fb8'],
  other: '#d9d9d9',
};
const cellsShown = new Promise<number>((resolve) => {
  map.once('load', () => {
    const started = performance.now();
    const rows = createCells(CELLS.count);
    const made = performance.now();
    draw.datasets.add({
      id: 'cells',
      rows,
      styleRule: BY_VALUE,
      baseStyle: { fill: { fillOpacity: 0.45, strokeWidth: 0 } },
      order: 'layer-order',
    });
    draw.layers.reorder(['cells', ...draw.layers.getOrder().filter((id) => id !== 'cells')]);
    const given = performance.now();
    map.once('render', () => {
      const frame = performance.now();
      console.info(
        `${rows.length.toLocaleString('en')} cells: ${ms(made - started)} to make the rows,`,
        `${ms(given - made)} to give them to the dataset, and the first frame`,
        `${ms(frame - given)} after`,
      );
      resolve(rows.length);
    });
    map.triggerRepaint();
  });
});

// 4. The points, 1,000,000 of them over about 100 km of the Kanto area, made in typed arrays
// (data.ts) and held by a stand-in for a server, which hands over the rows of a part of the
// map: all of them from zoom 14, a sample below. A provider is called with the part in view
// and the zoom once the map rests, and only its answer is held. Points that overlap on the
// screen are thinned until zoom 17. They are colored by `kind`, in front of the drawing
const generationStarted = performance.now();
const server = new PointServer(createPoints(POINTS.count));
console.info(
  `${POINTS.count.toLocaleString('en')} points made in`,
  `${ms(performance.now() - generationStarted)}, for the provider to hand over by view`,
);
const THINNING = { enabled: true, fullDisplayZoom: 17, marginPx: 1 };
const points = draw.datasets.add({
  id: 'points',
  provider: async (bbox, zoom) => server.query(bbox, zoom),
  styleRule: {
    kind: 'categorical',
    property: 'kind',
    map: Object.fromEntries(
      KINDS.map((kind, i) => [kind, ['#1b9e77', '#d95f02', '#7570b3', '#e6ab02'][i]]),
    ),
    other: '#8c8c8c',
  },
  baseStyle: {
    point: { pointRadius: 2.5, pointStrokeColor: '#ffffff', pointStrokeWidth: 0.5 },
  },
  collisionThinning: THINNING,
  order: 'above-store',
  interactive: true,
});

/** Logs, once the next frame is drawn, how many of the points handed over are drawn */
function logThinning(): Promise<{ visible: number; total: number }> {
  return new Promise((resolve) => {
    map.once('render', () => {
      const { enabled, visible, total } = points.getThinningStats();
      console.info(
        `points: thinning ${enabled ? 'on' : 'off'},`,
        `${visible.toLocaleString('en')} of ${total.toLocaleString('en')} drawn`,
      );
      resolve({ visible, total });
    });
    map.triggerRepaint();
  });
}
const unsubscribe = points.on('changed', ({ reason }) => {
  if (reason !== 'rows') return;
  unsubscribe();
  logThinning();
});

// 5. The T key turns the thinning off and on, and the console says how many points are drawn.
// The keys typed into a field are left alone
console.info('Keys: T turns the thinning of the points off and on');
window.addEventListener('keydown', (event) => {
  const { target } = event;
  if (
    event.key.toLowerCase() !== 't' ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    (target instanceof Element && target.closest('input, textarea, [contenteditable]'))
  ) {
    return;
  }
  points.setCollisionThinning(points.getCollisionThinning() ? null : THINNING);
  logThinning();
});

/** The rows of a GeoJSON file of the sample data, each a feature with an ID */
async function fetchRows(name: string): Promise<DatasetRow[]> {
  const response = await fetch(new URL(`../data/${name}`, location.href));
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  return ((await response.json()) as { features: DatasetRow[] }).features;
}

// 6. The buildings by the area of their footprint in square metres: one more color than breaks,
// from pink to deep purple. Half the buildings of the sample are under 70 m² and one in twenty
// over 670 m², so the breaks give each class a good share of them
const BY_AREA: StyleRule = {
  kind: 'graduated',
  property: 'area',
  breaks: [50, 100, 200, 500],
  colors: ['#fbb4b9', '#f768a1', '#dd3497', '#ae017e', '#7a0177'],
  other: '#d9d9d9',
};

/**
 * The places by category: the 6 most common categories of the rows, the rest grey, in colors
 * apart from those of the buildings
 */
function byCategory(places: DatasetRow[]): StyleRule {
  const counts = new Map<string, number>();
  for (const place of places) {
    const category = place.properties?.category;
    if (typeof category === 'string') counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const colors = ['#ff7f0e', '#2ca02c', '#17becf', '#d62728', '#bcbd22', '#8c564b'];
  return {
    kind: 'categorical',
    property: 'category',
    map: Object.fromEntries(top.map(([category], i) => [category, colors[i]])),
    other: '#8c8c8c',
  };
}

/**
 * The places for the part of the map in view, from zoom 14. A real provider fetches them from
 * a server for the extent; this one takes them from the array the page already fetched
 */
function placesInView(places: DatasetRow[]): DatasetProvider {
  return async ([west, south, east, north], zoom) => {
    if (zoom < 14) return [];
    return places.filter((place) => {
      const [x, y] = (place.geometry as GeoJSON.Point).coordinates;
      return x >= west && x <= east && y >= south && y <= north;
    });
  };
}

const buildingsAndPlaces = Promise.all([
  fetchRows('tokyo-buildings.geojson'),
  fetchRows('tokyo-places.geojson'),
]).then(([buildings, places]) => {
  // 7. The buildings, given at once. `layer-order` places the dataset in the stacking order of
  // the layers, here between the survey area and the route, in front of the cells
  draw.datasets.add({
    id: 'buildings',
    rows: buildings,
    styleRule: BY_AREA,
    baseStyle: { fill: { fillOpacity: 0.85, strokeColor: '#ffffff', strokeWidth: 0.5 } },
    order: 'layer-order',
    interactive: true,
  });
  const order = draw.layers.getOrder().filter((id) => id !== 'buildings');
  order.splice(order.indexOf(survey.id) + 1, 0, 'buildings');
  draw.layers.reorder(order);

  // 8. The places, fetched for the view, in front of every layer. Places that overlap on the
  // screen are thinned, and from zoom 18 every place is drawn
  draw.datasets.add({
    id: 'places',
    provider: placesInView(places),
    styleRule: byCategory(places),
    baseStyle: { point: { pointRadius: 4, pointStrokeColor: '#ffffff', pointStrokeWidth: 1 } },
    collisionThinning: { enabled: true, fullDisplayZoom: 18, marginPx: 8 },
    order: 'above-store',
    interactive: true,
  });

  // 9. The Legend tab of the panel on the left lists the rules of the four datasets, in the
  // order of the stack: the places, the points, the buildings and the cells
  console.log(
    `${buildings.length.toLocaleString('en')} buildings and ${places.length.toLocaleString('en')} places`,
  );
  return { buildings: buildings.length, places: places.length };
});
const loaded = Promise.all([buildingsAndPlaces, cellsShown]).then(([counts, cells]) => ({
  ...counts,
  cells,
}));

// 10. A click on a row of an interactive dataset. It clears the selection of the drawing, so the
// panel on the right, which shows drawn features, closes; the page logs the row itself
draw.on('dataset.clicked', ({ datasetId, row }) => {
  const name = row.properties?.name ?? row.properties?.kind ?? '(no name)';
  console.log(`${datasetId}: ${name}`, row.properties);
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, loaded });
