// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// style-rules: colors from the attributes of the features.
// It changes the default look with `Options.style`, colors a layer with each of the four
// kinds of style rule, and builds a legend with `deriveLegend` and its own `messages`.

import {
  createMapLibreGLDraw,
  deriveLegend,
  type Messages,
  type StyleRule,
} from '@sakuzu/maplibre-gl-draw';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';

// The labels of the legend: the library returns English, and a page may replace any of them
const messages: Partial<Messages> = {
  legendAll: 'Every block',
  legendOther: 'No data',
};

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.7515, 35.6875],
  zoom: 13.2,
});

// The default look of the features without a rule: a dark blue outline and a light fill
// (colors are RGBA from 0 to 1)
const draw = createMapLibreGLDraw(map, {
  messages,
  style: {
    polygon: {
      stroke: { width: 1.5, color: [0.1, 0.2, 0.5, 1], opacity: 1, lineStyle: 'solid' },
      fill: { color: [0.1, 0.2, 0.5, 0.15] },
    },
  },
});

/** The four kinds of rule. A feature the rule cannot resolve gets `other` */
const RULES: Record<string, StyleRule> = {
  single: { kind: 'single', color: '#2b8cbe' },
  categorical: {
    kind: 'categorical',
    property: 'category',
    map: { commercial: '#e15759', residential: '#4e79a7', industrial: '#b07aa1', park: '#59a14f' },
    other: '#cccccc',
  },
  graduated: {
    kind: 'graduated',
    property: 'population',
    breaks: [2000, 5000, 10000],
    colors: ['#fef0d9', '#fdcc8a', '#fc8d59', '#d7301f'],
    other: '#cccccc',
  },
  continuous: {
    kind: 'continuous',
    property: 'population',
    min: 0,
    max: 15000,
    ramp: ['#f7fbff', '#08306b'],
    other: '#cccccc',
  },
};

// A layer of its own for the sample: the rule belongs to the layer
// (addLayer returns null only while read-only, which this page never turns on)
const created = draw.addLayer('Blocks');
if (created === null) throw new Error('The drawing is read-only');
const layerId: string = created;
draw.setActiveLayer(layerId);
const response = await fetch('../sample-gis.geojson');
await draw.load(await response.json());

const output = document.getElementById('output') as HTMLPreElement;

/** Sets the rule of the layer (or removes it) and shows its legend */
function applyRule(name: string): void {
  const rule = RULES[name];
  draw.updateLayer(layerId, { styleRule: rule });
  output.replaceChildren();
  for (const entry of rule ? deriveLegend(rule, messages) : []) {
    const swatch = document.createElement('span');
    swatch.textContent = '■ ';
    swatch.style.color = entry.color;
    output.append(swatch, `${entry.label}\n`);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-rule]')) {
    button.classList.toggle('active', button.dataset.rule === name);
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-rule]')) {
  button.addEventListener('click', () => applyRule(button.dataset.rule ?? 'none'));
}
applyRule('categorical');

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw });
