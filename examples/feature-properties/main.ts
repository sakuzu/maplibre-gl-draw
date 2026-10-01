// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// feature-properties: the attributes of features.
// The features come from GeoJSON, whose properties become their attributes. The page opens
// with the market hall selected; the Attributes tab of the panel on the right lists its
// attributes, where a value is changed, added and removed. Code changes them with
// features.update, and feature.updated tells the page of every change, wherever it was made.

import { createDraw, isDrawProperty } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';
import { PLACES } from './data.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.767, 35.679],
  zoom: 14.2,
});
const draw = createDraw(map);

// 1. Follow the changes of attributes, from the panel or from code. A value typed in the panel
// is kept as the string typed ("12", not 12): convert it here when the data needs numbers.
// The keys of the library (`maplibre-gl-draw:*`) live in the same properties and are left out
draw.on('feature.updated', ({ feature, previous }) => {
  const keys = new Set([...Object.keys(previous.properties), ...Object.keys(feature.properties)]);
  for (const key of keys) {
    const before = previous.properties[key];
    const after = feature.properties[key];
    if (isDrawProperty(key) || JSON.stringify(before) === JSON.stringify(after)) continue;
    console.log(`${feature.properties.name ?? feature.id}: ${key}`, before, '->', after);
  }
});

// 2. Load the GeoJSON: each feature keeps its properties, of any JSON type
const loaded = await draw.document.load(PLACES);
if (loaded === null) throw new Error('The drawing is read-only');
const [market] = loaded.featureIds;

// 3. Change attributes from code: `properties` is merged key by key, and a key given as
// `undefined` is removed. This is what the Attributes tab does when a value is changed
draw.features.update(market, {
  properties: { floors: 4, renovated: 2024, stalls: undefined },
});

// 4. The standard UI. `?locale=ja` in the address shows it in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale });

// 5. Select the market hall: the panel on the right shows its name and its description, and
// its Attributes tab lists the other properties
draw.selection.set('feature', [market]);

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui });
