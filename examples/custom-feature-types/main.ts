// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// custom-feature-types: a feature type the library does not have.
// A "Route" (route.ts) is a line with style keys of its own: a color, a width and whether it is
// dashed. Its definition draws it, hits it and takes it into a selection box. The panel on the
// right has no style fields for a type it does not know, so the page adds a section for the
// route's keys. The U key unregisters the type and registers it again.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { BASEMAPS, basemapStyle, initialBasemapId } from '../basemap.ts';
import '../example.css';
import { HILL_ROUTE, RIVER_ROUTE } from './data.ts';
import { routeLook, routeType } from './route.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.72, 35.685],
  zoom: 13,
});
const draw = createDraw(map);

// 1. Register the type. `featureTypes.remove('Route')`, or the function `add` returns,
// unregisters it (6)
draw.extensions.featureTypes.add(routeType);

// 2. Two routes (their lines are in data.ts), one with style keys of its own
draw.features.create({
  type: 'Route',
  geometry: { type: 'LineString', coordinates: HILL_ROUTE },
  properties: { name: 'Hill route' },
});
const river = draw.features.create({
  type: 'Route',
  geometry: { type: 'LineString', coordinates: RIVER_ROUTE },
  properties: { name: 'River route' },
  style: { routeColor: '#1f6feb', routeWidth: 5, routeDashed: false },
});

// 3. The standard UI. `?locale=ja` in the address shows it in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale, basemaps: BASEMAPS, basemap: initialBasemapId() });
const ja = locale === 'ja';

// 4. A section for the route's style keys, shown when every selected feature is a route. The UI
// draws the fields; a change writes its key into the style of the routes
ui.inspector?.sections.add({
  id: 'route-style',
  title: ja ? 'ルート' : 'Route',
  appliesTo: (features) => features.every((f) => f.type === 'Route'),
  fields: ([first]) => {
    const look = routeLook(first);
    return [
      { key: 'routeColor', kind: 'color', label: ja ? '色' : 'Color', value: look.routeColor },
      {
        key: 'routeWidth',
        kind: 'slider',
        label: ja ? '太さ' : 'Width',
        value: look.routeWidth,
        min: 1,
        max: 12,
        step: 1,
        unit: 'px',
      },
      {
        key: 'routeDashed',
        kind: 'toggle',
        label: ja ? '破線' : 'Dashed',
        value: look.routeDashed,
      },
    ];
  },
  onchange: (key, value, features) => {
    const patch = { style: { [key]: value } };
    draw.features.updateMany(features.map((f) => ({ id: f.id, patch })));
  },
});

// 5. Select the second route, so the panel opens on its section
if (river !== null) draw.selection.set('feature', [river.id]);

// 6. The key of the page, listed in the console as it opens: U unregisters the type and
// registers it again. Without the type, the routes stay in the data, neither drawn nor hit by a
// click (a selection box still takes them, by their positions), and come back as they were when
// the type is registered again. A key typed into a field of the panels is left alone, and so is
// one held with a modifier
console.info('The keys of this page:\n  U  Unregister the type Route, or register it again');
window.addEventListener('keydown', (event) => {
  const typing =
    event.target instanceof Element &&
    event.target.closest('input, textarea, select, [contenteditable]') !== null;
  if (typing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.toLowerCase() !== 'u') return;
  if (draw.extensions.featureTypes.has('Route')) draw.extensions.featureTypes.remove('Route');
  else draw.extensions.featureTypes.add(routeType);
  console.info(`Route type registered: ${draw.extensions.featureTypes.has('Route')}`);
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui });
