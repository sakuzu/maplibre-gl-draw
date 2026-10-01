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
import { BASEMAPS, basemapStyle, DEM_TILES, initialBasemapId } from '../basemap.ts';
import '../example.css';
import { terrainDocument } from './data.ts';

// 1. The Nordkette range above Innsbruck, seen from the south and tilted: the public elevation
// tiles are coarse, so the relief shows best where it is high
const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [11.392, 47.2875],
  zoom: 12.9,
  pitch: 72,
  bearing: -12,
  maxPitch: 85,
});

// 2. The elevation is a raster-dem source of the map; the terrain, a hillshade from the same
// tiles and a sky are set whenever a style has loaded (the basemap menu replaces the style). `map.setTerrain(null)` turns the terrain
// off, with no call to the library
map.on('style.load', () => {
  map.addSource('dem', { type: 'raster-dem', url: DEM_TILES, tileSize: 256 });
  // A source of its own for the hillshade, as maplibre recommends
  map.addSource('hillshade', { type: 'raster-dem', url: DEM_TILES, tileSize: 256 });
  const firstSymbol = map.getStyle().layers.find((layer) => layer.type === 'symbol')?.id;
  map.addLayer(
    {
      id: 'hillshade',
      type: 'hillshade',
      source: 'hillshade',
      paint: { 'hillshade-exaggeration': 0.5, 'hillshade-shadow-color': '#473b24' },
    },
    firstSymbol,
  );
  map.setTerrain({ source: 'dem', exaggeration: 1.5 });
  map.setSky({
    'sky-color': '#9cc8ee',
    'horizon-color': '#e4eef7',
    'sky-horizon-blend': 0.6,
    'fog-color': '#e4eef7',
    'fog-ground-blend': 0.8,
    'horizon-fog-blend': 0.6,
  });
});

const draw = createDraw(map, { initDefaultLayer: false });

// 3. The drawing (data.ts): an area and an image on the slope, a trail to the ridge with markers
// on its stations, a straight dashed line across the valley. Each follows the ground, and the
// parts behind the ridge are hidden by it
await draw.document.load(terrainDocument());

// 4. The standard UI over the tilted map. `?locale=ja` in the address shows it in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale, basemaps: BASEMAPS, basemap: initialBasemapId() });

// 5. How the last frame was drawn: whether the terrain was in use and whether the areas and the
// lines were painted on the ground. For debugging; the fields may change in a minor release
map.once('idle', () => {
  const { render, drape } = draw.debug.terrain();
  console.log(`Terrain active: ${render.active}, painted on the ground: ${drape.used}`);
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui });
