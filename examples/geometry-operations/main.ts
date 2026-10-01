// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// geometry-operations: combining, cutting and measuring features.
// Select two areas or more (Shift + click), or an area and a line across it, and the panel on
// the right offers the operations that apply: union, intersection, difference, split and
// buffer. Each is one call of draw.features. The length and the area of the selection, from
// the geometry entry, are logged as it changes.

import { createDraw, type FeatureInput } from '@sakuzu/maplibre-gl-draw';
import { area, length } from '@sakuzu/maplibre-gl-draw/geometry';
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
  center: [139.7635, 35.681],
  zoom: 15.2,
});
const draw = createDraw(map);

/** A square area of `size` degrees with its south-west corner at [lng, lat] */
function square(name: string, lng: number, lat: number, size: number): FeatureInput {
  const ring = [
    [lng, lat],
    [lng + size, lat],
    [lng + size, lat + size],
    [lng, lat + size],
    [lng, lat],
  ];
  return {
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { name },
  };
}

// 1. Two squares that share an edge, a third that overlaps them, and a line across the first
// (createMany returns null only while read-only)
const created = draw.features.createMany([
  square('West', 139.758, 35.679, 0.004),
  square('East', 139.762, 35.679, 0.004),
  square('Overlap', 139.765, 35.682, 0.003),
  {
    type: 'LineString',
    geometry: {
      type: 'LineString',
      coordinates: [
        [139.757, 35.6805],
        [139.763, 35.6815],
      ],
    },
    properties: { name: 'Cut line' },
  },
]);
if (created === null) throw new Error('The drawing is read-only');
const [west, east, , line] = created;

// 2. The panel's operations are these calls, with the IDs of the selection; each replaces or
// adds features in one change and returns what it made (null or [] when nothing changed):
//   draw.features.union(ids)                     every area merged into one
//   draw.features.intersection(ids)              where they all overlap
//   draw.features.difference(first, others)      the first minus the others
//   draw.features.split(areaId, lineId)          the area cut along the line
//   draw.features.buffer(ids, { distanceMeters }) the area around each, one per input
// `?locale=ja` in the address shows the interface in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, {
  locale,
  basemaps: BASEMAPS,
  basemap: initialBasemapId(),
  inspector: { operations: true },
});

// 3. Measure the selection with the geometry entry: plain functions of GeoJSON geometries, in
// meters and square meters on the ground (a circle is a point with a radius, left out here)
draw.on('selection.changed', () => {
  const selected = draw.selection.features();
  let meters = 0;
  let squareMeters = 0;
  for (const { geometry } of selected) {
    if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
      meters += length(geometry);
    }
    if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
      squareMeters += area(geometry);
    }
  }
  const round = (value: number) => Math.round(value).toLocaleString('en');
  console.log(`${selected.length} selected: ${round(squareMeters)} m², ${round(meters)} m of line`);
});

// 4. One of the calls from code: the area within 40 m of the line, a new feature beside it
draw.features.buffer([line.id], { distanceMeters: 40 });

// 5. Open with the two squares selected: the panel lists the operations for two areas
draw.selection.set('feature', [west.id, east.id]);

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui });
