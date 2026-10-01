// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The development page of the interface: a map with a feature of each type and the interface
// laid over it. `?locale=ja` shows the Japanese words. `window.draw` and `window.ui` are there
// for the browser console.

import { createDraw, type FeatureInput } from '@sakuzu/maplibre-gl-draw';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './maplibre-setup.ts';
import { createDrawUI } from '../src/main.ts';
import { basemapStyle } from './basemap.ts';
import './dev.css';

const params = new URLSearchParams(location.search);

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.767, 35.681],
  zoom: 13,
});

const draw = createDraw(map);

/** A feature of each type, around Tokyo Station */
const FEATURES: FeatureInput[] = [
  { type: 'Point', geometry: { type: 'Point', coordinates: [139.7671, 35.6812] } },
  {
    type: 'LineString',
    geometry: {
      type: 'LineString',
      coordinates: [
        [139.755, 35.676],
        [139.762, 35.684],
        [139.773, 35.686],
      ],
    },
  },
  {
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [139.772, 35.672],
          [139.784, 35.672],
          [139.784, 35.68],
          [139.772, 35.68],
          [139.772, 35.672],
        ],
      ],
    },
  },
  {
    type: 'Circle',
    geometry: { type: 'Point', coordinates: [139.757, 35.688] },
    properties: { 'maplibre-gl-draw:radiusMeters': 400 },
  },
];
draw.features.createMany(FEATURES);

const ui = createDrawUI(draw, { locale: params.get('locale') === 'ja' ? 'ja' : 'en' });

Object.assign(window, { map, draw, ui });
