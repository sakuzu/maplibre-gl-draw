// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// globe: drawing on the globe.
// The projection is the map's own (`map.setProjection`), and the library follows it. Routes
// between the continents run along great circles, a box lies between two meridians and two
// parallels, a circle of 2,500 km surrounds Tokyo, a picture of a storm floats over the
// Pacific, and six cities are marked: all of them lie on the sphere and bend with it, and the
// route to New York goes behind it. An edge between two vertices follows the path it takes on
// the flat map, as the layers of the map do, so a great circle is drawn with many vertices
// along it; the dashed blue line joins London and Tokyo with two. An area across the
// antimeridian keeps its shape. The globe button at the bottom right switches between the
// globe and the flat map.

import { createDraw, type FeatureInput } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { BASEMAPS, basemapStyle, initialBasemapId } from '../basemap.ts';
import '../example.css';
import { AREAS, PLACES, ROUTES, STORM } from './data.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [124, 14],
  zoom: 1.7,
});

// 1. The globe, set once the style has loaded (a style can name a projection of its own), and
// no atmosphere and no fog (both paint a light fringe inside the globe's edge). The map leaves the
// space around the globe transparent, so the container's background is the space, dark blue
map.getContainer().style.background = '#0b1026';
map.on('style.load', () => {
  map.setProjection({ type: 'globe' });
  // No atmosphere and no fog at the horizon: both soften the edge of the globe
  map.setSky({ 'atmosphere-blend': 0, 'fog-ground-blend': 0, 'horizon-fog-blend': 0 });
});

// 2. Three layers, from the back: the areas, the routes and the cities (the features are in
// data.ts). The routes are great circles, computed there as points along them. New drawings go
// to the routes
const draw = createDraw(map, { initDefaultLayer: false });
const [areas, routes] = await draw.write(async (tx) => {
  const [areas, routes, places] = [
    await tx.layers.create({ name: 'Areas' }),
    await tx.layers.create({ name: 'Routes' }),
    await tx.layers.create({ name: 'Cities' }),
  ];
  const into = (layerId: string) => (feature: FeatureInput) => ({
    ...feature,
    properties: { ...feature.properties, 'maplibre-gl-draw:layerId': layerId },
  });
  await tx.features.create([
    ...AREAS.map(into(areas.id)),
    ...ROUTES.map(into(routes.id)),
    ...PLACES.map(into(places.id)),
  ]);
  return [areas, routes];
});
draw.layers.setActive(routes.id);

// 3. The standard UI; its map controls include maplibre-gl's globe button
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale, basemaps: BASEMAPS, basemap: initialBasemapId() });

// 4. The picture of a storm, made in a canvas and placed over the Pacific at its size in pixels
// at zoom 3. It is imported as a GeoJSON feature of the type Image that carries the picture
// under `maplibre-gl-draw:imageData`, as the GeoJSON written out carries it. It lies on the
// sphere like the rest, and is stored in the files of the document
const loaded = draw.write((tx) =>
  tx.import(
    {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: STORM.center },
          properties: {
            name: 'Storm',
            'maplibre-gl-draw:featureType': 'Image',
            'maplibre-gl-draw:imageData': stormPicture(STORM.size),
            'maplibre-gl-draw:imageMimeType': 'image/png',
            'maplibre-gl-draw:imageWidth': STORM.size,
            'maplibre-gl-draw:imageHeight': STORM.size,
            'maplibre-gl-draw:createdZoom': STORM.zoom,
            'maplibre-gl-draw:style': { imageOpacity: 0.95 },
          },
        },
      ],
    },
    { layer: areas.id },
  ),
);

/** A made-up picture of a storm seen from above: a white spiral around an eye, as a data URL */
function stormPicture(size: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D canvas');
  // Drawn on a square of 256
  context.scale(size / 256, size / 256);
  const glow = context.createRadialGradient(128, 128, 8, 128, 128, 128);
  glow.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  glow.addColorStop(0.55, 'rgba(235, 242, 255, 0.7)');
  glow.addColorStop(1, 'rgba(235, 242, 255, 0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, 256, 256);
  context.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  context.lineCap = 'round';
  context.lineWidth = 14;
  for (let arm = 0; arm < 3; arm++) {
    context.beginPath();
    for (let t = 0; t <= 1; t += 0.02) {
      const angle = arm * ((2 * Math.PI) / 3) + t * 3.4;
      const radius = 14 + t * 108;
      context.lineTo(128 + radius * Math.cos(angle), 128 + radius * Math.sin(angle));
    }
    context.stroke();
  }
  context.fillStyle = '#1d3557';
  context.beginPath();
  context.arc(128, 128, 9, 0, 2 * Math.PI);
  context.fill();
  return canvas.toDataURL('image/png');
}

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, loaded });
