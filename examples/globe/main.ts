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
import { basemapStyle } from '../basemap.ts';
import '../example.css';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [135, 22],
  zoom: 1.5,
});

// 1. The globe, set once the style has loaded (a style can name a projection of its own)
map.on('style.load', () => map.setProjection({ type: 'globe' }));

const draw = createDraw(map);

/** Points along the great circle from `a` to `b`, in degrees, by spherical interpolation */
function greatCircle(a: [number, number], b: [number, number], steps: number): number[][] {
  const rad = Math.PI / 180;
  const toVector = ([lng, lat]: [number, number]) => [
    Math.cos(lat * rad) * Math.cos(lng * rad),
    Math.cos(lat * rad) * Math.sin(lng * rad),
    Math.sin(lat * rad),
  ];
  const [p, q] = [toVector(a), toVector(b)];
  const angle = Math.acos(p[0] * q[0] + p[1] * q[1] + p[2] * q[2]);
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const [s, u] = [Math.sin((1 - t) * angle), Math.sin(t * angle)];
    const [x, y, z] = p.map((v, k) => (s * v + u * q[k]) / Math.sin(angle));
    return [Math.atan2(y, x) / rad, Math.asin(z) / rad];
  });
}

const LONDON: [number, number] = [-0.1276, 51.5072];
const TOKYO: [number, number] = [139.7671, 35.6812];

// 2. The great circle from London to Tokyo, over the north of Siberia, with 64 edges
draw.features.create({
  type: 'LineString',
  geometry: { type: 'LineString', coordinates: greatCircle(LONDON, TOKYO, 64) },
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
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [174, -21],
        [186, -21],
        [186, -12],
        [174, -12],
        [174, -21],
      ],
    ],
  },
  properties: { name: 'Across the antimeridian' },
  style: { fillColor: '#edae49', fillOpacity: 0.4, strokeColor: '#a86a00' },
});

// 5. The standard UI; its map controls include maplibre-gl's globe button
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale });

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui });
