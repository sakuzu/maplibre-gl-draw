// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// style-rules-and-legend: colors from the attributes of the features.
// A style rule belongs to a layer and colors its features from one attribute, in one of four
// kinds. The features are 400 buildings of central Tokyo from Overture Maps
// (examples/public/data/), loaded into the drawing, so they can be edited. The Legend tab of the
// panel on the left shows the rows of the rule, and the R key switches the layer to the next
// kind. The rule reads the attribute: change the height of a building in the Attributes tab and
// its color follows at once.

import { createDraw, type StyleRule } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';

/** The center of the sample data, around which the page takes its buildings */
const CENTER: [number, number] = [139.778, 35.678];
const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: CENTER,
  zoom: 16,
  attributionControl: {
    customAttribution: '<a href="https://overturemaps.org">Overture Maps Foundation</a>',
  },
});
// No empty first layer, as the page creates its own; and a stronger fill than the default with
// a white outline, so that the colors of the rule read well (a rule sets the color of the fill,
// the style keeps the opacity and the outline)
const draw = createDraw(map, {
  initDefaultLayer: false,
  style: { polygon: { fillOpacity: 0.8, strokeColor: '#ffffff', strokeWidth: 1 } },
});

// 1. The four kinds of rule. A feature whose attribute the rule cannot read gets `other`
const RULES: StyleRule[] = [
  // Classes of a number: one more color than breaks
  {
    kind: 'graduated',
    property: 'height',
    breaks: [10, 20, 40, 80],
    colors: ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'],
    other: '#cccccc',
  },
  // A color for each value of a text attribute
  {
    kind: 'categorical',
    property: 'class',
    map: { commercial: '#e15759', retail: '#f28e2b', office: '#4e79a7', apartments: '#59a14f' },
    other: '#cccccc',
  },
  // A gradient between two colors, from min to max
  {
    kind: 'continuous',
    property: 'height',
    min: 0,
    max: 100,
    ramp: ['#f7fbff', '#08306b'],
    other: '#cccccc',
  },
  // One color for every feature
  { kind: 'single', color: '#2b8cbe' },
];

// 2. The 400 buildings nearest the center among those with a height, with the attributes the
// rules read. Overture leaves out what it does not know, and so do the features
interface Building {
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  properties: Record<string, string | number | null>;
}
async function nearestBuildings(count: number): Promise<GeoJSON.Feature[]> {
  const response = await fetch(new URL('../data/tokyo-buildings.geojson', location.href));
  if (!response.ok) throw new Error(`tokyo-buildings.geojson: ${response.status}`);
  const { features } = (await response.json()) as { features: Building[] };
  const scale = Math.cos((CENTER[1] * Math.PI) / 180);
  const distance = ({ geometry }: Building): number => {
    const ring = geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates[0][0];
    const [x, y] = ring.slice(1).reduce(([sx, sy], [px, py]) => [sx + px, sy + py], [0, 0]);
    const [dx, dy] = [
      (x / (ring.length - 1) - CENTER[0]) * scale,
      y / (ring.length - 1) - CENTER[1],
    ];
    return dx * dx + dy * dy;
  };
  return features
    .filter((building) => typeof building.properties.height === 'number')
    .map((building) => ({ building, d: distance(building) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, count)
    .map(({ building: { geometry, properties } }) => ({
      type: 'Feature',
      geometry,
      properties: Object.fromEntries(
        ['name', 'height', 'floors', 'class']
          .filter((key) => properties[key] !== null)
          .map((key) => [key, properties[key]]),
      ),
    }));
}

// 3. The rule is a key of the layer: the load creates the layer with the first rule, the
// graduated one, and puts the buildings in it, in one step
const loaded = nearestBuildings(400).then(async (features) => {
  const result = await draw.document.load(
    { type: 'FeatureCollection', features },
    { layer: { name: 'Buildings', styleRule: RULES[0] } },
  );
  if (!result?.layerId) throw new Error('The drawing is read-only');
  return result.layerId;
});

// 4. layers.update changes the rule; the map and the legend follow. The R key goes to the next
// kind (a page of your own would offer a menu; the keys typed into a field are left alone)
let current = 0;
window.addEventListener('keydown', async (event) => {
  const target = event.target as HTMLElement;
  if (event.key.toLowerCase() !== 'r' || target.closest('input, textarea, [contenteditable]')) {
    return;
  }
  current = (current + 1) % RULES.length;
  draw.layers.update(await loaded, { styleRule: RULES[current] });
});

// 5. The Attributes tab keeps what is typed as text ("45"), and graduated and continuous rules
// read numbers only, so the page turns a number typed into `height` or `floors` into a number
draw.on('feature.updated', ({ feature, intermediate }) => {
  if (intermediate) return;
  const numbers: Record<string, number> = {};
  for (const key of ['height', 'floors']) {
    const value = feature.properties[key];
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      numbers[key] = Number(value);
    }
  }
  if (Object.keys(numbers).length > 0) {
    draw.features.update(feature.id, { properties: numbers });
  }
});

// 6. The standard UI: the Legend tab beside the layers, and the inspector opening on the
// Attributes tab of the selected building. `?locale=ja` shows it in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, {
  locale,
  legend: true,
  inspector: { tabs: ['attributes', 'style'] },
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, loaded });
