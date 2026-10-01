// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// plugins: extending the drawing with a plugin, and the standard UI with its tool.
// The plugin (stamp.ts) adds a mode that puts stars, listens to the creations and offers a
// count. The page adds a tool for the mode to the toolbar, and a section to the panel on the
// right for the stars: their state, planned or done, which also sets their color.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';
import {
  createStampPlugin,
  isStamp,
  STAR_ICON,
  type StampApi,
  type StampState,
  stampStyle,
} from './stamp.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.767, 35.681],
  zoom: 14,
});
const draw = createDraw(map);

// 1. Add the plugin: its mode `stamp` is registered from now on. The function it returns
// removes the plugin with its mode and its listeners
const removePlugin = draw.extensions.plugins.add(createStampPlugin());

// 2. The standard UI. `?locale=ja` in the address shows it in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale });

// 3. A tool for the mode, after the built-in tools: the button calls draw.setMode('stamp'), and
// the key S does the same. The icon is SVG markup of the page, drawn with currentColor
ui.tools.add({
  id: 'stamp',
  mode: 'stamp',
  label: locale === 'ja' ? 'スタンプ' : 'Stamp',
  icon: STAR_ICON,
  shortcut: 'S',
});

// 4. A section of the panel on the right, shown when every selected feature is a stamp. Its
// field is drawn by the UI; a change comes to onchange, which writes it with features.updateMany
ui.inspector?.sections.add({
  id: 'stamp',
  title: locale === 'ja' ? 'スタンプ' : 'Stamp',
  appliesTo: (features) => features.every(isStamp),
  fields: (features) => {
    const states = new Set(features.map((f) => f.properties.stamp));
    return [
      {
        key: 'stamp',
        kind: 'segmented',
        label: locale === 'ja' ? '状態' : 'State',
        value: [...states][0],
        mixed: states.size > 1,
        options: [
          { value: 'planned', label: locale === 'ja' ? '予定' : 'Planned' },
          { value: 'done', label: locale === 'ja' ? '済み' : 'Done' },
        ],
      },
    ];
  },
  onchange: (_key, value, features) => {
    const state = value as StampState;
    draw.features.updateMany(
      features.map((f) => ({
        id: f.id,
        patch: { properties: { stamp: state }, style: stampStyle(state) },
      })),
    );
  },
});

// 5. One stamp placed from code, selected so the panel opens on its section
const first = draw.features.create({
  type: 'Point',
  geometry: { type: 'Point', coordinates: [139.767, 35.6835] },
  properties: { name: 'Meeting point', stamp: 'done' },
  style: stampStyle('done'),
});
if (first !== null) draw.selection.set('feature', [first.id]);

// 6. The api of the plugin, asked by its name: how many stamps were made, after each tool
draw.on('mode.changed', ({ mode }) => {
  const count = draw.extensions.plugins.getApi<StampApi>('stamp')?.count() ?? 0;
  console.log(`Mode ${mode}; ${count} stamps so far`);
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, removePlugin });
