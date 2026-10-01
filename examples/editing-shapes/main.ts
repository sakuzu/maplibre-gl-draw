// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// editing-shapes: changing the shape of a selected feature with its handles.
// A selected feature shows a frame with handles at its corners that resize it and a handle
// above it that rotates it, and a handle at each vertex and halfway along each edge. Two parcels
// share an edge: with the option `topology.sharedVertexDrag`, dragging a vertex of that edge
// moves the same vertex of the other parcel too. An area with a hole and an area of two parts
// get handles on every ring and every part. The T key switches the shared vertices off and on.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';
import { COURTYARD, EAST_PARCEL, ISLANDS, PATH, SHARED, WEST_PARCEL } from './data.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.7722, 35.6819],
  zoom: 15.5,
});

// 1. Dragging a vertex also moves the vertices of other features at exactly the same position
// (off when left out). The areas and the line get a calm look, so the handles stand out
const draw = createDraw(map, {
  topology: { sharedVertexDrag: true },
  style: {
    polygon: { fillColor: '#30638e', fillOpacity: 0.25, strokeColor: '#30638e' },
    line: { strokeColor: '#2e4057', strokeWidth: 3 },
  },
});

// 2. The features: the parcels list the same positions for the ends of their shared edge.
// A hole is a second ring of a Polygon, and the parts of a MultiPolygon are polygons of their
// own (createMany returns null only while read-only)
const created = draw.features.createMany([WEST_PARCEL, EAST_PARCEL, COURTYARD, ISLANDS, PATH]);
if (created === null) throw new Error('The drawing is read-only');
const [west] = created;

// 3. The standard UI. `?locale=ja` in the address shows it in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale });

// 4. Open with the west parcel selected, so its frame and its handles are drawn
draw.selection.set('feature', [west.id]);

// 5. The T key switches the shared vertices: off, a vertex of the shared edge moves in the
// grabbed parcel alone (holding Alt as the drag starts does the same for one drag). The keys
// typed into a field are left alone
window.addEventListener('keydown', (event) => {
  const { target } = event;
  if (
    event.key.toLowerCase() !== 't' ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    (target instanceof Element && target.closest('input, textarea, [contenteditable]'))
  ) {
    return;
  }
  const sharedVertexDrag = !draw.options.get().topology?.sharedVertexDrag;
  draw.options.update({ topology: { sharedVertexDrag } });
  console.info(`sharedVertexDrag: ${sharedVertexDrag}`);
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, SHARED });
