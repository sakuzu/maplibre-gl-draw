// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// datasets: data to show, too large or too foreign to edit.
// A dataset draws rows that are not features of the drawing: they are not edited, saved or
// listed in the panels. One dataset is given its 50,000 cells at once and colored by a value;
// the other fetches points for the part of the map in view as it moves. A click on a row is
// reported by an event, logged in the browser console.

import { createDraw, type DatasetProvider, type DatasetRow } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';
import { CENTER, createCells } from './data.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: CENTER,
  zoom: 13,
});
const draw = createDraw(map);
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale });

// 1. 250 x 200 square cells around the center, each with a value from 0 to 100 (data.ts)
const cells = createCells();

// 2. The rows given at once, colored by their value, behind the features drawn by hand
draw.datasets.add({
  id: 'cells',
  rows: cells,
  baseStyle: { fill: { fillOpacity: 0.55, strokeWidth: 0 } },
  styleRule: {
    kind: 'graduated',
    property: 'value',
    breaks: [20, 40, 60, 80],
    colors: ['#eff3ff', '#bdd7e7', '#6baed6', '#3182bd', '#08519c'],
    other: '#cccccc',
  },
  order: 'below-store',
  interactive: true,
});

// 3. A provider is called with the extent in view (rounded to tiles) and the zoom once the map
// rests, and returns the rows for it. A real one fetches them from a server; this one makes
// about 16 points per tile width at stable places
const pointsInView: DatasetProvider = async ([west, south, east, north], zoom) => {
  if (zoom < 12) return [];
  const step = 360 / 2 ** (Math.floor(zoom) + 4);
  const points: DatasetRow[] = [];
  for (let i = Math.floor(west / step); i * step < east; i++) {
    for (let j = Math.floor(south / step); j * step < north; j++) {
      const hash = Math.abs(Math.sin(i * 12.9898 + j * 78.233) * 43758.5453) % 1;
      points.push({
        type: 'Feature',
        id: `point-${i}-${j}`,
        geometry: {
          type: 'Point',
          coordinates: [(i + hash) * step, (j + ((hash * 7) % 1)) * step],
        },
        properties: { kind: ['shop', 'school', 'station'][Math.floor(hash * 3)] },
      });
    }
  }
  return points;
};

// 4. The rows fetched for the view, in front of the drawing. Points that overlap on the screen
// are thinned, and from zoom 17 every point is drawn
draw.datasets.add({
  id: 'points',
  provider: pointsInView,
  styleRule: {
    kind: 'categorical',
    property: 'kind',
    map: { shop: '#e15759', school: '#59a14f', station: '#4e79a7' },
    other: '#cccccc',
  },
  baseStyle: { point: { pointRadius: 5 } },
  collisionThinning: { enabled: true, fullDisplayZoom: 17 },
  order: 'above-store',
  interactive: true,
});

// 5. A click on a row of an interactive dataset. It clears the selection of the drawing, so the
// panel on the right, which shows drawn features, closes; the page shows the row itself
draw.on('dataset.clicked', ({ datasetId, row }) => {
  console.log(`${datasetId}: ${row.id}`, row.properties);
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui });
