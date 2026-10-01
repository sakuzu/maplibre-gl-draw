// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// zoom-and-scale: widths that grow and shrink with the map, and widths fixed on the screen.
// A width is in pixels at the reference zoom of its feature (the property
// `maplibre-gl-draw:createdZoom`): from there it grows and shrinks with the map, like a line
// painted on the ground. A feature without a reference zoom keeps its widths on the screen at
// every zoom. The same three features are loaded twice, with and without one, in two layers;
// zoom in and out to see them part. A switch in the card of actions at the bottom left, with the
// key Z, switches the option `scaleWithZoom`, which decides whether the tools write a reference
// zoom into the features they draw.

import { createDraw, type FeatureInput } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';

/** The property that holds the reference zoom of a feature */
const CREATED_ZOOM = 'maplibre-gl-draw:createdZoom';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.7734, 35.6826],
  zoom: 15,
});
const draw = createDraw(map);

/**
 * A wide line, an area with a thick outline and a big point, in a row whose south edge is at
 * `south`
 */
function row(south: number): FeatureInput[] {
  const west = 139.77;
  return [
    {
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [west, south + 0.0002],
          [west + 0.0018, south + 0.0016],
        ],
      },
      properties: { name: 'Wide line' },
      style: { strokeColor: '#d1495b', strokeWidth: 8 },
    },
    {
      type: 'Polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [west + 0.0032, south],
            [west + 0.005, south],
            [west + 0.005, south + 0.0018],
            [west + 0.0032, south + 0.0018],
            [west + 0.0032, south],
          ],
        ],
      },
      properties: { name: 'Thick outline' },
      style: { fillColor: '#edae49', fillOpacity: 0.4, strokeColor: '#00798c', strokeWidth: 6 },
    },
    {
      type: 'Point',
      geometry: { type: 'Point', coordinates: [west + 0.0064, south + 0.0009] },
      properties: { name: 'Big point' },
      style: { pointColor: '#30638e', pointRadius: 14, pointStrokeWidth: 3 },
    },
  ];
}

// 1. Two layers. The document starts with one, which showState names below; the second goes
// behind it (`index` 0 is the back), as its row is under the first on the map
const scaledLayer = draw.layers.getActive();
const fixedLayer = draw.layers.create({ name: 'Fixed on screen', index: 0 });
if (scaledLayer === null || fixedLayer === null) throw new Error('The drawing is read-only');
const layerIds = { scaled: scaledLayer.id, fixed: fixedLayer.id };

// 2. The same features in both. Those of the first layer have a reference zoom of 15, where
// the page opens, so both rows look the same until the map zooms; those of the second have
// none, so they keep their widths on the screen (createMany returns null only while read-only)
const scaled = draw.features.createMany(
  row(35.683).map((feature) => ({
    ...feature,
    layerId: scaledLayer.id,
    properties: { ...feature.properties, [CREATED_ZOOM]: 15 },
  })),
);
draw.features.createMany(row(35.6806).map((feature) => ({ ...feature, layerId: fixedLayer.id })));
if (scaled === null) throw new Error('The drawing is read-only');

// 3. The reference zoom is per feature: a line of 2 px beside the wide line, whose reference
// zoom is set to 13 from code. Two zoom levels further in, at 15, it is 4 times as wide: 8 px,
// as wide as the wide line beside it
const thin = draw.features.create({
  type: 'LineString',
  layerId: scaledLayer.id,
  geometry: {
    type: 'LineString',
    coordinates: [
      [139.7707, 35.6832],
      [139.7725, 35.6846],
    ],
  },
  properties: { name: '2 px at zoom 13' },
  style: { strokeColor: '#2e4057', strokeWidth: 2 },
});
if (thin === null) throw new Error('The drawing is read-only');
draw.features.update(thin.id, { properties: { [CREATED_ZOOM]: 13 } });

// 4. The standard UI. `?locale=ja` in the address shows it in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale });

// 5. The option `scaleWithZoom` (true when left out) decides whether the tools write the zoom
// of the drawing into what they draw. A switch in the card of actions of the standard UI, with
// the key Z (listed with ?, and left alone while a field has the keyboard), switches it, and
// makes the layer of the same behavior the active one, so what the tools draw next goes where it
// belongs; an arrow before the name of that layer says so
const scaleWithZoom = () => draw.options.get().scaleWithZoom ?? true;
function showState(): void {
  const active = scaleWithZoom() ? layerIds.scaled : layerIds.fixed;
  draw.transact(() => {
    draw.layers.setActive(active);
    for (const [id, name] of [
      [layerIds.scaled, 'Scaled with zoom'],
      [layerIds.fixed, 'Fixed on screen'],
    ]) {
      draw.layers.update(id, { name: id === active ? `→ ${name}` : name });
    }
  });
  console.info(`scaleWithZoom: ${scaleWithZoom()}`);
}
showState();
ui.actions.add({
  id: 'scale-with-zoom',
  label: locale === 'ja' ? 'ズームで太さを変える' : 'Scale with zoom',
  kind: 'toggle',
  shortcut: 'Z',
  run: () => {
    draw.options.update({ scaleWithZoom: !scaleWithZoom() });
    showState();
  },
  checked: scaleWithZoom,
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, layerIds });
