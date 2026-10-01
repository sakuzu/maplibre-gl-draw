// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// get-started: the smallest page, a map with the standard UI over it.
// Draw with the tools at the bottom, click a feature to select it, and change its name, its
// style and its attributes in the panel on the right. The page follows every change.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// 1. Set the worker URL of maplibre-gl once, before the first map is created
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';

// 2. Create the map
const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.767, 35.681],
  zoom: 13,
});

// 3. Create the draw instance: it keeps the features and draws them on the map
const draw = createDraw(map);

// 4. Lay the standard UI over the map: the tools at the bottom, the layers on the left and the
// selected feature on the right. `?locale=ja` in the address shows it in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale });

// 5. Follow the changes: one event per transaction, whether a tool, the panel or code made it
draw.on('document.changed', ({ features, source }) => {
  if (!features) return;
  console.log(
    `${features.created?.length ?? 0} created, ${features.updated?.length ?? 0} updated,`,
    `${features.deleted?.length ?? 0} deleted (${source})`,
  );
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui });
