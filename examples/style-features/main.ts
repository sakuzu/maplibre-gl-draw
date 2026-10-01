// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// style-features: the look of each feature, side by side.
// Three areas whose fill and outline differ in color, their outlines solid, dashed and dotted;
// three lines of 1, 4 and 10 px; four points of each shape and size; and a circle of 80 m. The
// defaults of a type change for the features drawn from then on, and the page opens with the
// middle area selected, so the panel on the right shows its style. A change there restyles it
// at once.

import { createDraw, type FeatureInput, type FeatureStyle } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';
import { AREAS, LINES, POINTS, RANGE } from './data.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.772, 35.6825],
  zoom: 15.7,
});
const draw = createDraw(map);

// 1. A style of its own for each feature: the keys left out keep the defaults.
// Colors are CSS colors, opacities run from 0 to 1, widths and radii are in pixels
const AREA_STYLES: FeatureStyle[] = [
  { fillColor: '#edae49', fillOpacity: 0.5, strokeColor: '#00798c', strokeWidth: 1 },
  { fillColor: '#66a182', fillOpacity: 0.5, strokeColor: '#d1495b', strokeWidth: 3 },
  {
    fillColor: '#30638e',
    fillOpacity: 0.35,
    strokeColor: '#edae49',
    strokeWidth: 6,
    lineStyle: 'dotted',
  },
];
const LINE_STYLES: FeatureStyle[] = [
  { strokeColor: '#2e4057', strokeWidth: 1 },
  { strokeColor: '#d1495b', strokeWidth: 4, lineStyle: 'dashed' },
  { strokeColor: '#00798c', strokeWidth: 10, lineStyle: 'dotted' },
];
/** A point of one shape and radius, with a dark outline of 2 px */
const marker = (
  pointShape: FeatureStyle['pointShape'],
  pointRadius: number,
  pointColor: string,
) => ({ pointShape, pointRadius, pointColor, pointStrokeColor: '#2e4057', pointStrokeWidth: 2 });
const POINT_STYLES: FeatureStyle[] = [
  marker('circle', 6, '#d1495b'),
  marker('square', 9, '#edae49'),
  marker('triangle', 12, '#66a182'),
  marker('star', 15, '#30638e'),
];

/** The sample features with the style of the same place in `styles` */
const styled = (features: FeatureInput[], styles: FeatureStyle[]) =>
  features.map((feature, i) => ({ ...feature, style: styles[i] }));

// createMany returns null only while the drawing is read-only, which this page never turns on
const created = draw.features.createMany([
  ...styled(AREAS, AREA_STYLES),
  ...styled(LINES, LINE_STYLES),
  ...styled(POINTS, POINT_STYLES),
  {
    ...RANGE,
    style: {
      fillColor: '#30638e',
      fillOpacity: 0.15,
      strokeColor: '#30638e',
      strokeWidth: 2,
      lineStyle: 'dashed',
    },
  },
]);
if (created === null) throw new Error('The drawing is read-only');
const middle = created[1];

// 2. The defaults of a type: the areas drawn from now on, which have no style of their own,
// take these (a circle takes the defaults of `polygon` when `circle` has none)
draw.options.update({
  style: { polygon: { fillColor: '#2a9d8f', fillOpacity: 0.3, strokeColor: '#1d6f65' } },
});

// 3. The standard UI. `?locale=ja` in the address shows it in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale });

// 4. Select the middle area from code: the panel on the right opens on its style
draw.selection.set('feature', [middle.id]);

// 5. A field of the panel writes its value with features.update (updateMany for several
// features); this is the same change as choosing the dashed outline there
draw.features.update(middle.id, { style: { lineStyle: 'dashed' } });

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui });
