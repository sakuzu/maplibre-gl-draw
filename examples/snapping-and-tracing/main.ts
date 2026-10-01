// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// snapping-and-tracing: drawing that fits what is already there.
// While drawing, the pointer snaps to vertices, edges and guide lines; a click on two points of
// the winding boundary of the parcel traces the boundary between them, so the neighbor is drawn
// without redrawing it. The switch at the end of the toolbar turns snapping off and on.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { BASEMAPS, basemapStyle, initialBasemapId } from '../basemap.ts';
import '../example.css';
import { FEATURES, STREAM } from './data.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.7757, 35.681],
  zoom: 15.3,
});
const draw = createDraw(map);

// 1. A parcel whose east side follows a stream (STREAM, the boundary to trace), and a road
// (data.ts)
draw.features.createMany(FEATURES);

// 2. Snapping and tracing are on by default; options.update changes only the keys given.
// Here: a wider reach, guide lines every 15 degrees from the last vertex, no snapping to
// crossings, and tracing along the boundaries snapped to (it needs snapping)
draw.options.update({
  snapping: { tolerancePx: 14, guideStepDegrees: 15, kinds: { intersection: false } },
  tracing: { enabled: true },
});

// 3. What the pointer snaps to, as it moves: a vertex, an edge or a guide (Alt suspends it)
draw.on('snap.changed', ({ result }) => {
  console.log(result ? `snapped to ${result.target?.kind ?? 'a point'}` : 'not snapped');
});

// 4. The standard UI. Its snapping switch writes `snapping.enabled` with options.update, and
// follows the option when code changes it. `?locale=ja` in the address shows it in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, {
  locale,
  basemaps: BASEMAPS,
  basemap: initialBasemapId(),
  toolbar: { snapping: true },
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, STREAM });
