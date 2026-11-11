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
import { CENTER, FEATURES, PLACES } from './data.ts';
import './dev.css';

const params = new URLSearchParams(location.search);

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: CENTER,
  zoom: 13,
});

const draw = createDraw(map);

// A feature of each type, around Tokyo Station (data.ts), and a second layer of places colored by
// their kind, two of them in a group
await draw.write(async (tx) => {
  await tx.features.create(FEATURES);
  const places = await tx.layers.create({
    name: 'Places',
    styleRule: {
      kind: 'categorical',
      property: 'kind',
      map: { park: '#3fa34d', station: '#e4572e' },
      other: '#888888',
    },
  });
  const point = (name: string, kind: string, coordinates: [number, number]): FeatureInput => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates },
    properties: { name, kind, 'maplibre-gl-draw:layerId': places.id },
  });
  const created = await tx.features.create(PLACES.map((place) => point(...place)));
  await tx.groups.create({ name: 'Parks', members: [created[0], created[1]] });
});

const ui = createDrawUI(draw, { locale: params.get('locale') === 'ja' ? 'ja' : 'en' });

Object.assign(window, { map, draw, ui });
