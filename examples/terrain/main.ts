// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// terrain: drawing and editing on 3D terrain.
// The terrain is the map's own (`map.setTerrain`); the library has no setting for it and
// follows it. Areas and lines are painted on the relief, points and handles stand on it, and
// drawing, selecting and dragging hit the ground that is seen. The standard UI works as it does
// on a flat map, and the compass at the bottom right turns the map flat again.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle, DEM_TILES } from '../basemap.ts';
import '../example.css';
import { ACROSS_THE_VALLEY, ON_THE_SLOPE } from './data.ts';

// 1. A tilted view over high mountains (the Alps near Innsbruck): the public elevation tiles are
// coarse, so the relief shows best where it is high
const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [11.39085, 47.27574],
  zoom: 12,
  pitch: 65,
  maxPitch: 85,
});

// 2. The elevation is a raster-dem source of the map, and the terrain is set once the style has
// loaded. `map.setTerrain(null)` turns it off, with no call to the library
map.on('load', () => {
  map.addSource('dem', { type: 'raster-dem', url: DEM_TILES, tileSize: 256 });
  map.setTerrain({ source: 'dem', exaggeration: 1.5 });
});

const draw = createDraw(map);

// 3. A line across the valley and an area on the slope (data.ts), to see them follow the ground
draw.features.create({
  type: 'LineString',
  geometry: { type: 'LineString', coordinates: ACROSS_THE_VALLEY },
  properties: { name: 'Across the valley' },
});
draw.features.create({
  type: 'Polygon',
  geometry: { type: 'Polygon', coordinates: ON_THE_SLOPE },
  properties: { name: 'On the slope' },
  style: { fillColor: '#d1495b', fillOpacity: 0.35, strokeColor: '#a3283a' },
});

// 4. The standard UI over the tilted map. `?locale=ja` in the address shows it in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale });

// 5. How the last frame was drawn: whether the terrain was in use and whether the areas and the
// lines were painted on the ground. For debugging; the fields may change in a minor release
map.once('idle', () => {
  const { render, drape } = draw.debug.terrain();
  console.log(`Terrain active: ${render.active}, painted on the ground: ${drape.used}`);
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui });
