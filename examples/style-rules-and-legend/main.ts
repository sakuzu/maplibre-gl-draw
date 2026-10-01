// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// style-rules-and-legend: colors from the attributes of the features.
// A style rule belongs to a layer and colors its features from one attribute, in one of four
// kinds. The Legend tab of the panel on the left shows the rows of the rule, and the R key
// switches the layer to the next kind. Select the layer to see its rule in the panel on the right.

import { createDraw, type StyleRule } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';
import { BLOCKS } from './data.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.7675, 35.6815],
  zoom: 14.3,
});
// No empty first layer, as the page creates its own; and a stronger fill than the default, so
// that the colors of the rule read well (a rule sets the color, the style keeps the opacity)
const draw = createDraw(map, {
  initDefaultLayer: false,
  style: { polygon: { fillOpacity: 0.65, strokeWidth: 1 } },
});

// 1. The four kinds of rule. A feature whose attribute the rule cannot read gets `other`
const RULES: StyleRule[] = [
  // One color for every feature
  { kind: 'single', color: '#2b8cbe' },
  // A color for each value of a text attribute
  {
    kind: 'categorical',
    property: 'use',
    map: { commercial: '#e15759', residential: '#4e79a7', industrial: '#b07aa1', park: '#59a14f' },
    other: '#cccccc',
  },
  // Classes of a number: one more color than breaks
  {
    kind: 'graduated',
    property: 'population',
    breaks: [3000, 6000, 10000],
    colors: ['#fef0d9', '#fdcc8a', '#fc8d59', '#d7301f'],
    other: '#cccccc',
  },
  // A gradient between two colors, from min to max
  {
    kind: 'continuous',
    property: 'population',
    min: 0,
    max: 14000,
    ramp: ['#f7fbff', '#08306b'],
    other: '#cccccc',
  },
];

// 2. The rule is a key of the layer: create the layer with one, and its features with the
// attributes it reads (create returns null only while read-only)
const layer = draw.layers.create({ name: 'Blocks', styleRule: RULES[1] });
if (layer === null) throw new Error('The drawing is read-only');
draw.features.createMany(BLOCKS.map((block) => ({ ...block, layerId: layer.id })));

// 3. layers.update changes the rule; the map and the legend follow. The R key goes to the next
// kind (a page of your own would offer a menu; the keys typed into a field are left alone)
let current = 1;
window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  if (event.key.toLowerCase() !== 'r' || target.closest('input, textarea, [contenteditable]')) {
    return;
  }
  current = (current + 1) % RULES.length;
  draw.layers.update(layer.id, { styleRule: RULES[current] });
});

// 4. The standard UI: the Legend tab beside the layers. `?locale=ja` shows it in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale, legend: true });

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui });
