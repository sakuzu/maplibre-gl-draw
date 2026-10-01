// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// datasets: data to show, under and over the user's own drawing.
// The buildings and the places of central Tokyo from Overture Maps (examples/public/data/),
// fetched as GeoJSON. A dataset draws rows that are not features of the drawing: they are shown,
// not edited, and not saved with the drawing. The buildings are given at once, colored by their
// height and placed between two layers of the drawing, a survey area behind them and a planned
// route in front; the places are handed over for the part of the map in view as it moves,
// colored by their category, in front of everything. A line drawn by the user snaps to the
// edges of the buildings. A click on a row is reported by an event, logged in the browser
// console.

import {
  createDraw,
  type DatasetProvider,
  type DatasetRow,
  deriveLegend,
  type StyleRule,
} from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { BASEMAPS, basemapStyle, initialBasemapId } from '../basemap.ts';
import '../example.css';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
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
const ui = createDrawUI(draw, { locale, basemaps: BASEMAPS, basemap: initialBasemapId() });

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
const ROUTE_STYLE = { strokeColor: '#7c3aed', strokeWidth: 4, pointColor: '#7c3aed' };
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

/** The rows of a GeoJSON file of the sample data, each a feature with an ID */
async function fetchRows(name: string): Promise<DatasetRow[]> {
  const response = await fetch(new URL(`../data/${name}`, location.href));
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  return ((await response.json()) as { features: DatasetRow[] }).features;
}

// 3. The buildings by height in metres: one more color than breaks, and grey for a building
// whose height the data does not give
const BY_HEIGHT: StyleRule = {
  kind: 'graduated',
  property: 'height',
  breaks: [10, 20, 40, 80],
  colors: ['#eff3ff', '#bdd7e7', '#6baed6', '#3182bd', '#08519c'],
  other: '#d9d9d9',
};

/** The places by category: the 6 most common categories of the rows, the rest grey */
function byCategory(places: DatasetRow[]): StyleRule {
  const counts = new Map<string, number>();
  for (const place of places) {
    const category = place.properties?.category;
    if (typeof category === 'string') counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const colors = ['#e15759', '#f28e2b', '#59a14f', '#b07aa1', '#edc948', '#ff9da7'];
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

const loaded = Promise.all([
  fetchRows('tokyo-buildings.geojson'),
  fetchRows('tokyo-places.geojson'),
]).then(([buildings, places]) => {
  // 4. The buildings, given at once. `layer-order` places the dataset in the stacking order of
  // the layers, here between the survey area and the route
  draw.datasets.add({
    id: 'buildings',
    rows: buildings,
    styleRule: BY_HEIGHT,
    baseStyle: { fill: { fillOpacity: 0.85, strokeColor: '#ffffff', strokeWidth: 0.5 } },
    order: 'layer-order',
    interactive: true,
  });
  draw.layers.reorder([survey.id, 'buildings', route.id]);

  // 5. The places, fetched for the view, in front of every layer. Places that overlap on the
  // screen are thinned, and from zoom 18 every place is drawn
  const placeRule = byCategory(places);
  draw.datasets.add({
    id: 'places',
    provider: placesInView(places),
    styleRule: placeRule,
    baseStyle: { point: { pointRadius: 4, pointStrokeColor: '#ffffff', pointStrokeWidth: 1 } },
    collisionThinning: { enabled: true, fullDisplayZoom: 18, marginPx: 8 },
    order: 'above-store',
    interactive: true,
  });

  // 6. The Legend tab lists the rules of layers, not of datasets, so the page logs them
  console.log(
    `${buildings.length.toLocaleString('en')} buildings and ${places.length.toLocaleString('en')} places`,
  );
  for (const [name, rule] of [
    ['buildings by height (m)', BY_HEIGHT],
    ['places by category', placeRule],
  ] as const) {
    const rows = deriveLegend(rule).map(({ label, color }) => `${color} ${label}`);
    console.log(`Legend of the ${name}:\n  ${rows.join('\n  ')}`);
  }
  return { buildings: buildings.length, places: places.length };
});

// 7. A click on a row of an interactive dataset. It clears the selection of the drawing, so the
// panel on the right, which shows drawn features, closes; the page logs the row itself
draw.on('dataset.clicked', ({ datasetId, row }) => {
  const name = row.properties?.name ?? '(no name)';
  console.log(`${datasetId}: ${name}`, row.properties);
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, loaded });
