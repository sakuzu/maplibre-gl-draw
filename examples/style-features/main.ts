// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// style-features: the look of each feature.
// A point, a line, an area, a circle and a freehand stroke each get a style of their own; the
// defaults of a type change for the features drawn from then on; and the page opens with the
// area selected, so the panel on the right shows its style. A change there restyles it at once.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';
import { BLOCK, RANGE, SKETCH, STATION, WALK } from './data.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.767, 35.681],
  zoom: 13.4,
});
const draw = createDraw(map);

// 1. A style of its own for each feature: the keys left out keep the defaults.
// Colors are CSS colors, opacities run from 0 to 1, widths and radii are in pixels
draw.features.create({
  ...STATION,
  style: { pointShape: 'square', pointColor: '#d1495b', pointRadius: 9, pointStrokeWidth: 3 },
});
draw.features.create({
  ...WALK,
  style: { strokeColor: '#00798c', strokeWidth: 4, lineStyle: 'dashed' },
});
const block = draw.features.create({
  ...BLOCK,
  style: { fillColor: '#edae49', fillOpacity: 0.45, strokeColor: '#a86a00', strokeWidth: 2 },
});
draw.features.create({
  ...RANGE,
  style: { fillColor: '#30638e', fillOpacity: 0.15, strokeColor: '#30638e', lineStyle: 'dotted' },
});
draw.features.create({
  ...SKETCH,
  style: { strokeColor: '#6a4c93', strokeWidth: 3, strokeOpacity: 0.7 },
});
// (create returns null only while the drawing is read-only, which this page never turns on)
if (block === null) throw new Error('The drawing is read-only');

// 2. The defaults of a type: the areas drawn from now on, which have no style of their own,
// take these (a circle takes the defaults of `polygon` when `circle` has none)
draw.options.update({
  style: { polygon: { fillColor: '#2a9d8f', fillOpacity: 0.3, strokeColor: '#1d6f65' } },
});

// 3. The standard UI. `?locale=ja` in the address shows it in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale });

// 4. Select the area from code: the panel on the right opens on its style
draw.selection.set('feature', [block.id]);

// 5. A field of the panel writes its value with features.update (updateMany for several
// features); this is the same change as setting the width of the outline to 4 there
draw.features.update(block.id, { style: { strokeWidth: 4 } });

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui });
