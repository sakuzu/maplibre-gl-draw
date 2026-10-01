// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// globe: drawing on the globe.
// The projection is the map's own (`map.setProjection`), and the library follows it. An edge
// between two vertices follows the path it takes on the flat map, as the layers of the map do,
// so the shortest way between two places, a great circle, is drawn with many vertices along it.
// An area across the antimeridian keeps its shape. The globe button at the bottom right
// switches between the globe and the flat map.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { BASEMAPS, basemapStyle, initialBasemapId } from '../basemap.ts';
import '../example.css';
import { ACROSS_THE_ANTIMERIDIAN, GREAT_CIRCLE, LONDON, TOKYO } from './data.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [135, 22],
  zoom: 1.5,
});

// 1. The globe, set once the style has loaded (a style can name a projection of its own), and
// the sky: space behind the globe and a thin atmosphere at its edge. The basemap styles carry
// no sky, so without it the page's background would show behind the globe
map.on('style.load', () => {
  map.setProjection({ type: 'globe' });
  map.setSky({
    'sky-color': '#0b1026',
    'horizon-color': '#1e3a66',
    'fog-color': '#0b1026',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.9,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 10, 1, 12, 0],
  });
});

const draw = createDraw(map);

// 2. The great circle from London to Tokyo, over the north of Siberia, with 64 edges (the places
// and the lines are in data.ts)
draw.features.create({
  type: 'LineString',
  geometry: { type: 'LineString', coordinates: GREAT_CIRCLE },
  properties: { name: 'Great circle' },
  style: { strokeColor: '#d1495b', strokeWidth: 3 },
});

// 3. The same two places with two vertices: the edge follows the straight line of the flat map
draw.features.create({
  type: 'LineString',
  geometry: { type: 'LineString', coordinates: [LONDON, TOKYO] },
  properties: { name: 'Two vertices' },
  style: { strokeColor: '#30638e', strokeWidth: 2, lineStyle: 'dashed' },
});

// 4. An area across the antimeridian. Its longitudes run on past 180 instead of jumping to
// -180, as a shape drawn across the line is kept; the GeoJSON written out wraps them
draw.features.create({
  type: 'Polygon',
  geometry: { type: 'Polygon', coordinates: ACROSS_THE_ANTIMERIDIAN },
  properties: { name: 'Across the antimeridian' },
  style: { fillColor: '#edae49', fillOpacity: 0.4, strokeColor: '#a86a00' },
});

// 5. The standard UI; its map controls include maplibre-gl's globe button
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale, basemaps: BASEMAPS, basemap: initialBasemapId() });

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui });
