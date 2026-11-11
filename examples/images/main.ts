// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// images: pictures placed on the map.
// The Image tool of the toolbar (the mode `draw_image`) asks the page for a file with the option
// requestImage; the page opens a file picker and gives the file, which the library places where
// the map was clicked. Code places an image by importing a GeoJSON feature of the type Image that
// carries the picture. The page opens with that image selected, so the panel on the right shows
// its opacity; drag its corners to scale it.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { BASEMAPS, basemapStyle, initialBasemapId } from '../basemap.ts';
import '../example.css';
import { IMAGE_CENTER } from './data.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: IMAGE_CENTER,
  zoom: 15.5,
});
// 1. The library opens no file dialog. Entering `draw_image` (the Image tool, or the I key)
// and clicking the map calls requestImage with where the image goes; the page lets the user
// pick a file and gives it, and the library places it there, in the active layer at the zoom of
// the map, as one commit. A picker left without a file gives nothing: the request is stopped by
// its signal when the next one is made
const draw = createDraw(map, {
  requestImage: (_at, { signal }) =>
    new Promise<Blob>((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file) resolve(file);
      });
      signal.addEventListener('abort', () => reject(signal.reason));
      input.click();
    }),
});

// 2. The standard UI. `?locale=ja` in the address shows it in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale, basemaps: BASEMAPS, basemap: initialBasemapId() });

// 3. An image from code: a GeoJSON feature of the type Image, centered on its point (from
// data.ts) and drawn at its size in pixels at its reference zoom, then following the map. The
// picture is a PNG, JPEG, WebP or GIF data URL under `maplibre-gl-draw:imageData`, as the
// GeoJSON written out carries it; the library stores it once in the files of the document.
// This SVG is drawn into a PNG first
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">
  <rect x="4" y="4" width="232" height="152" rx="12"
    fill="#fff8e7" stroke="#30638e" stroke-width="8"/>
  <path d="M40 120 L100 50 L140 95 L165 70 L200 120 Z" fill="#2a9d8f"/>
  <circle cx="180" cy="45" r="16" fill="#edae49"/>
</svg>`;

/** An SVG drawn into a PNG of its size, as a data URL */
async function pngOf(svg: string, width: number, height: number): Promise<string> {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/png');
}

// 4. The look of an image is its opacity, from 0 to 1; the panel's slider writes the same key
const IMAGE_ID = 'sketch-map';
const picture = await pngOf(SVG, 240, 160);
await draw.write((tx) =>
  tx.import({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: IMAGE_ID,
        geometry: { type: 'Point', coordinates: IMAGE_CENTER },
        properties: {
          name: 'Sketch map',
          'maplibre-gl-draw:featureType': 'Image',
          'maplibre-gl-draw:imageData': picture,
          'maplibre-gl-draw:imageMimeType': 'image/png',
          'maplibre-gl-draw:imageWidth': 240,
          'maplibre-gl-draw:imageHeight': 160,
          'maplibre-gl-draw:createdZoom': 15.5,
          'maplibre-gl-draw:style': { imageOpacity: 0.85 },
        },
      },
    ],
  }),
);
draw.selection.set('feature', [IMAGE_ID]);

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui });
