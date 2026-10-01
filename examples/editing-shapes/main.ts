// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// editing-shapes: changing the shape of a selected feature with its handles.
// A selected feature shows a frame with handles at its corners that resize it and a handle
// above it that rotates it, and a handle at each vertex and halfway along each edge. Two parcels
// share an edge: with the option `topology.sharedVertexDrag`, dragging a vertex of that edge
// moves the same vertex of the other parcel too. An area with a hole and an area of two parts
// get handles on every ring and every part. A switch in the card of actions at the bottom left,
// with the key T, switches the shared vertices off and on.

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

// 5. A switch in the card of actions of the standard UI, with the key T (listed with ?, and left
// alone while a field has the keyboard), switches the shared vertices: off, a vertex of the
// shared edge moves in the grabbed parcel alone (holding Alt as the drag starts does the same for
// one drag). The snapping settings of the toolbar switch the same option, so the card reads it
// again when the options change
const sharedVertexDrag = () => draw.options.get().topology?.sharedVertexDrag === true;
ui.actions.add({
  id: 'shared-vertices',
  label: locale === 'ja' ? '共有頂点の同時移動' : 'Move shared vertices',
  kind: 'toggle',
  shortcut: 'T',
  run: () => {
    draw.options.update({ topology: { sharedVertexDrag: !sharedVertexDrag() } });
    console.info(`sharedVertexDrag: ${sharedVertexDrag()}`);
  },
  checked: sharedVertexDrag,
});
draw.on('options.changed', () => ui.actions.refresh());

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, SHARED });
