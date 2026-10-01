// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// images: pictures placed on the map.
// The Image tool of the toolbar (the mode `draw_image`) asks the page for a file with the
// event image.requested; the page opens a file picker and loads the file where the map asked.
// Code places an image the same way, from a Blob. The page opens with that image selected, so
// the panel on the right shows its opacity; drag its corners to scale it.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { BASEMAPS, basemapStyle, initialBasemapId } from '../basemap.ts';
import '../example.css';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.7671, 35.6812],
  zoom: 15.5,
});
const draw = createDraw(map);

// 1. The library opens no file dialog. Entering `draw_image` (the Image tool, or the I key)
// emits image.requested with where to place the image, the zoom and the layer, and the mode
// returns to `select`. The page picks a file and passes it to document.load with them
draw.on('image.requested', ({ lngLat, zoom, layerId }) => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file) await draw.document.load(file, { coordinate: lngLat, zoom, layerId });
  });
  input.click();
});

// 2. The standard UI. `?locale=ja` in the address shows it in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale, basemaps: BASEMAPS, basemap: initialBasemapId() });

// 3. An image from code: any image Blob or File (PNG, JPEG, WebP, SVG...). It is centered on
// `coordinate` and drawn at its size in pixels at `zoom`, then follows the map. The library
// stores it once in the files of the document, as WebP, and selects the new feature
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">
  <rect x="4" y="4" width="232" height="152" rx="12"
    fill="#fff8e7" stroke="#30638e" stroke-width="8"/>
  <path d="M40 120 L100 50 L140 95 L165 70 L200 120 Z" fill="#2a9d8f"/>
  <circle cx="180" cy="45" r="16" fill="#edae49"/>
</svg>`;
const placed = await draw.document.load(new Blob([SVG], { type: 'image/svg+xml' }), {
  coordinate: [139.7671, 35.6812],
  zoom: 15.5,
});
if (placed === null) throw new Error('The drawing is read-only');
const [image] = placed.featureIds;

// 4. The look of an image is its opacity, from 0 to 1; the panel's slider writes the same key
draw.features.update(image, {
  properties: { name: 'Sketch map' },
  style: { imageOpacity: 0.85 },
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui });
