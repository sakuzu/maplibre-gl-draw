// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// layers-and-groups: the layers of a drawing and the groups in them.
// Two layers, parcels and paths, are stacked, faded and made active from code; three parcels
// are gathered into a group and locked; a draft is hidden. The panel on the left shows it all:
// the eye, the lock, renaming, dragging to reorder and the menu that adds a layer or a group.

import { createDraw, type Position } from '@sakuzu/maplibre-gl-draw';
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
  center: [139.7645, 35.6805],
  zoom: 15.2,
});
const draw = createDraw(map);

/** A rectangle with its south-west corner at [lng, lat] */
function parcel(lng: number, lat: number): Position[][] {
  const [w, h] = [0.0026, 0.0018];
  return [
    [
      [lng, lat],
      [lng + w, lat],
      [lng + w, lat + h],
      [lng, lat + h],
      [lng, lat],
    ],
  ];
}

// 1. The document starts with one empty layer: name it. A second layer goes behind it
// (`index` 0 is the back). Methods that write return null only while read-only
const parcels = draw.layers.getActive();
const paths = draw.layers.create({ name: 'Paths', index: 0 });
if (parcels === null || paths === null) throw new Error('The drawing is read-only');
draw.layers.update(parcels.id, { name: 'Parcels' });

// 2. Features go into the layer named by `layerId`, or else into the active layer
const created = draw.features.createMany([
  ...[0, 1, 2, 3].map((i) => ({
    type: 'Polygon' as const,
    geometry: { type: 'Polygon' as const, coordinates: parcel(139.7605 + i * 0.0028, 35.679) },
    properties: { name: i === 3 ? 'Draft' : `Parcel ${i + 1}` },
  })),
  {
    type: 'LineString',
    layerId: paths.id,
    geometry: {
      type: 'LineString',
      coordinates: [
        [139.76, 35.6785],
        [139.772, 35.682],
      ],
    },
    properties: { name: 'Path' },
  },
]);
if (created === null) throw new Error('The drawing is read-only');
const [a, b, c, draft] = created;

// 3. A group of two parcels; features.move puts a third one into it.
// The group is then locked: its features can be selected, not edited
const group = draw.groups.create({ featureIds: [a.id, b.id], name: 'Block A' });
if (group === null) throw new Error('The drawing is read-only');
draw.features.move(c.id, { groupId: group.id });
draw.groups.update(group.id, { locked: true });

// 4. Hide the draft for everyone who shares the document (`draw.hidden` hides on this page only)
draw.features.update(draft.id, { visible: false });

// 5. The stacking order, from the back: the paths go in front of the parcels, and fade
draw.layers.reorder([parcels.id, paths.id]);
draw.layers.update(paths.id, { opacity: 0.6 });

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
