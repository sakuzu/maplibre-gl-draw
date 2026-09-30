// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// read-only: stopping edits, for everyone or for one viewer.
// Read-only stops every write; the interaction lock only stops the user's editing gestures;
// a locked layer protects its features; local hiding hides a layer on this page only.

import { createDraw, type Feature } from '@sakuzu/maplibre-gl-draw';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.764, 35.681],
  zoom: 15,
});
const draw = createDraw(map);

// A layer of parcels next to the default layer, and one feature locked on its own
// (layers.create returns null only while read-only, which is still off here)
const created = draw.layers.create({ name: 'Parcels' });
if (created === null) throw new Error('The drawing is read-only');
const parcels = created.id;
for (const [lng, lat] of [
  [139.759, 35.679],
  [139.764, 35.679],
  [139.764, 35.682],
]) {
  draw.features.create({
    type: 'Polygon',
    layerId: parcels,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lng, lat],
          [lng + 0.004, lat],
          [lng + 0.004, lat + 0.0025],
          [lng, lat + 0.0025],
          [lng, lat],
        ],
      ],
    },
  });
}
draw.features.create({
  type: 'Point',
  geometry: { type: 'Point', coordinates: [139.7615, 35.6835] },
  locked: true,
});

const output = document.getElementById('output') as HTMLPreElement;

document.getElementById('draw-polygon')?.addEventListener('click', () => {
  // Refused (false) under the interaction lock, or when no layer can be written. While
  // read-only the mode starts, but what is drawn is not kept
  if (!draw.setMode('draw_polygon')) output.textContent = 'Drawing is not possible now';
});

/** A button that switches a state on and off and shows it */
function toggle(id: string, get: () => boolean, set: (on: boolean) => void): void {
  const button = document.getElementById(id) as HTMLButtonElement;
  button.addEventListener('click', () => {
    set(!get());
    button.classList.toggle('active', get());
  });
}

// Every write is refused, by the user or by code: the methods that change data return false
// or null
toggle(
  'read-only',
  () => draw.isReadOnly(),
  (on) => draw.setReadOnly(on),
);
// Selecting still works, editing and drawing do not start; code can still write
toggle(
  'interaction-lock',
  () => draw.isInteractionLocked(),
  (on) => draw.setInteractionLocked(on),
);
// A shared property of the layer: every feature in it is locked
toggle(
  'lock-layer',
  () => draw.layers.get(parcels)?.locked === true,
  (on) => draw.layers.update(parcels, { locked: on }),
);
// Hidden for this page only; the shared `visible` of the layer does not change
toggle(
  'hide-layer',
  () => draw.hidden.has(parcels),
  (on) => (on ? draw.hidden.add(parcels) : draw.hidden.remove(parcels)),
);

/** Whether a feature is locked: by itself, by its group or by its layer */
function isLocked(feature: Feature): boolean {
  if (feature.locked) return true;
  if (feature.groupId !== undefined && draw.groups.get(feature.groupId)?.locked) return true;
  return draw.layers.get(feature.layerId)?.locked === true;
}

// Whether the selected feature can be edited
draw.on('selection.changed', () => {
  const [feature] = draw.selection.features();
  if (!feature) return;
  const locked = isLocked(feature);
  output.textContent = `${feature.type} ${feature.id}: ${locked ? 'locked' : 'editable'}`;
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw });
