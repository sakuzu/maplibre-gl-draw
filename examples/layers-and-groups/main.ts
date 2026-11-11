// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// layers-and-groups: the layers of a drawing and the groups in them.
// Two layers, parcels and paths, are stacked, faded and made active from code; three parcels
// are gathered into a group and locked; a draft is hidden. The panel on the left shows it all:
// the eye, the lock, renaming, dragging to reorder and the menu that adds a layer or a group.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { BASEMAPS, basemapStyle, initialBasemapId } from '../basemap.ts';
import '../example.css';
import { PARCELS, PATH } from './data.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.772, 35.6805],
  zoom: 15.2,
});
const draw = createDraw(map);

// 1. The document starts with one empty layer: name it. A second layer goes behind it
// (`index` 0 is the back). Every write of the document is a transaction of `draw.write`; a
// write refused (a read-only document) rejects with a DrawError
const parcels = draw.layers.getActive();
if (parcels === null) throw new Error('The document has no layer');
const paths = await draw.write(async (tx) => {
  await tx.layers.update(parcels.id, { name: 'Parcels' });
  return tx.layers.create({ name: 'Paths', index: 0 });
});

// 2. Features go into the layer named by `maplibre-gl-draw:layerId` in their properties, or
// else into the active layer (the parcels and the path are in data.ts)
const [a, b, c, draft] = await draw.write((tx) =>
  tx.features.create([
    ...PARCELS.map((coordinates, i) => ({
      type: 'Feature' as const,
      geometry: { type: 'Polygon' as const, coordinates },
      properties: { name: i === 3 ? 'Draft' : `Parcel ${i + 1}` },
    })),
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: PATH },
      properties: { name: 'Path', 'maplibre-gl-draw:layerId': paths.id },
    },
  ]),
);

// 3. A group of two parcels; `place` puts a third one into it, in front.
// The group is then locked: its features can be selected, not edited
await draw.write(async (tx) => {
  const group = await tx.groups.create({ featureIds: [a, b], name: 'Block A' });
  await tx.features.place(c, { groupId: group.id });
  await tx.groups.update(group.id, { locked: true });
});

// 4. Hide the draft for everyone who shares the document (`draw.hidden` hides on this page only)
await draw.write((tx) =>
  tx.features.update(draft, { properties: { 'maplibre-gl-draw:visible': false } }),
);

// 5. The stacking order, from the back: the paths go in front of the parcels, and fade
await draw.write(async (tx) => {
  await tx.layers.place(paths.id, { below: parcels.id });
  await tx.layers.update(paths.id, { opacity: 0.6 });
});

// 6. What the tools draw goes into the active layer
draw.layers.setActive(paths.id);

// 7. The standard UI: the layers on the left. `?locale=ja` in the address shows it in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, {
  locale,
  basemaps: BASEMAPS,
  basemap: initialBasemapId(),
  layers: { features: true, add: true, reorder: true },
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, layerIds: { parcels: parcels.id, paths: paths.id } });
