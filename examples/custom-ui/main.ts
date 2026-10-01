// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// custom-ui: a toolbar and a panel of your own, without the standard UI.
// Everything the standard UI does goes through the public API of the draw instance: a button
// calls setMode and follows `mode.changed`; the panel follows `selection.changed` and
// `document.changed`, and writes with features.update. This page does the same with a few
// buttons and fields in plain TypeScript, styled by its own style.css.

import { createDraw, type Feature, type Mode } from '@sakuzu/maplibre-gl-draw';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import './style.css';

const ja = new URLSearchParams(location.search).get('locale') === 'ja';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.767, 35.681],
  zoom: 14,
});
const draw = createDraw(map);

/** Creates an element with a class and text */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

// 1. The toolbar: one button for each mode. A button asks for its mode; setMode returns false
// when the mode cannot be entered now (no layer can be written, or the interaction is locked)
const TOOLS: [Mode, string, string][] = [
  ['select', 'Select', '選択'],
  ['draw_point', 'Point', '点'],
  ['draw_line', 'Line', '線'],
  ['draw_polygon', 'Polygon', '面'],
  ['draw_circle', 'Circle', '円'],
  ['draw_freehand', 'Freehand', 'フリーハンド'],
];
const toolbar = el('div', 'toolbar');
toolbar.setAttribute('role', 'toolbar');
for (const [mode, en, jaLabel] of TOOLS) {
  const button = el('button', '', ja ? jaLabel : en);
  button.type = 'button';
  button.dataset.mode = mode;
  button.addEventListener('click', () => draw.setMode(mode));
  toolbar.append(button);
}
const remove = el('button', 'danger', ja ? '削除' : 'Delete');
remove.type = 'button';
remove.addEventListener('click', () => draw.selection.delete());
toolbar.append(remove);
document.body.append(toolbar);

// 2. The toolbar follows the mode, whoever changed it: a button, a key or the end of a drawing
function showMode(mode: Mode): void {
  for (const button of toolbar.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
}
draw.on('mode.changed', ({ mode }) => showMode(mode));
showMode(draw.getMode());

// 3. The panel: the name and the color of the one feature selected
const panel = el('form', 'panel');
panel.hidden = true;
const nameInput = el('input');
const colorInput = el('input');
colorInput.type = 'color';
const label = (text: string, input: HTMLInputElement) => {
  const row = el('label', '', text);
  row.append(input);
  return row;
};
panel.append(label(ja ? '名前' : 'Name', nameInput), label(ja ? '色' : 'Color', colorInput));
panel.addEventListener('submit', (event) => event.preventDefault());
document.body.append(panel);

/** The style key of a type's main color */
function colorKey(feature: Feature): 'pointColor' | 'fillColor' | 'strokeColor' {
  if (feature.type === 'Point' || feature.type === 'MultiPoint') return 'pointColor';
  if (/Polygon|Circle/.test(feature.type)) return 'fillColor';
  return 'strokeColor';
}

/** The feature the panel shows: the one selected, if exactly one is */
function selected(): Feature | undefined {
  const features = draw.selection.features();
  return features.length === 1 ? features[0] : undefined;
}

// 4. The panel follows the selection and the changes of the document. The color shown is the
// one the feature is drawn with: its own, its layer's rule or the default
function showSelection(): void {
  const feature = selected();
  panel.hidden = feature === undefined;
  remove.disabled = draw.selection.get().ids.length === 0;
  if (!feature) return;
  const name = feature.properties.name;
  if (document.activeElement !== nameInput) nameInput.value = typeof name === 'string' ? name : '';
  const color = draw.features.getAppliedStyle(feature.id)?.[colorKey(feature)];
  if (typeof color === 'string') colorInput.value = color.slice(0, 7).toLowerCase();
  const editable = draw.features.isEditable(feature.id);
  nameInput.disabled = !editable;
  colorInput.disabled = !editable;
}
draw.on('selection.changed', showSelection);
draw.on('document.changed', showSelection);
showSelection();

// 5. A field writes its value into the feature with features.update, as the standard UI does
nameInput.addEventListener('change', () => {
  const feature = selected();
  if (feature) draw.features.update(feature.id, { properties: { name: nameInput.value } });
});
colorInput.addEventListener('input', () => {
  const feature = selected();
  if (feature)
    draw.features.update(feature.id, { style: { [colorKey(feature)]: colorInput.value } });
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw });
