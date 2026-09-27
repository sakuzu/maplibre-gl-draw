// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// terrain: drawing on 3D terrain.
// The terrain is MapLibre's own (`map.setTerrain`); the library has no terrain setting and
// follows it. Features lie on the ground, and drawing and selecting hit the ground too.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle, DEM_TILES } from '../basemap.ts';
import '../example.css';

// The demo elevation tiles are coarse, so the view is over high mountains (the Alps near
// Innsbruck), tilted
const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [11.39085, 47.27574],
  zoom: 12,
  pitch: 65,
  maxPitch: 85,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

const draw = createDraw(map);

// A line across the valley and an area on the slope, to see them follow the ground
draw.features.create({
  type: 'LineString',
  geometry: {
    type: 'LineString',
    coordinates: [
      [11.36, 47.255],
      [11.39, 47.275],
      [11.42, 47.3],
    ],
  },
});
draw.features.create({
  type: 'Polygon',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [11.4, 47.25],
        [11.43, 47.25],
        [11.43, 47.265],
        [11.4, 47.265],
        [11.4, 47.25],
      ],
    ],
  },
});

const TERRAIN = { source: 'dem', exaggeration: 1.5 };
const terrainButton = document.getElementById('terrain') as HTMLButtonElement;

/** Turns the terrain of the map on or off */
function setTerrain(on: boolean): void {
  map.setTerrain(on ? TERRAIN : null);
  terrainButton.classList.toggle('active', on);
}

// The elevation is a raster-dem source of the map, added once the style has loaded
map.on('load', () => {
  map.addSource('dem', { type: 'raster-dem', url: DEM_TILES, tileSize: 256 });
  setTerrain(true);
});
terrainButton.addEventListener('click', () => setTerrain(map.getTerrain() === null));

document.getElementById('draw-polygon')?.addEventListener('click', () => {
  draw.setMode('draw_polygon');
});
document.getElementById('draw-line')?.addEventListener('click', () => draw.setMode('draw_line'));

// The state the last frame was drawn with, for debugging
const output = document.getElementById('output') as HTMLPreElement;
document.getElementById('diagnostics')?.addEventListener('click', () => {
  const { render, drape } = draw.debug.terrain();
  output.textContent = [
    `Terrain active: ${render.active}`,
    `Subdivision step: ${render.stepMeters} m`,
    `Analytic drape: ${drape.used ? 'used' : `not used (${drape.reason})`}`,
  ].join('\n');
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw });
