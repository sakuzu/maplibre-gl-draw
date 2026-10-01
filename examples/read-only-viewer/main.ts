// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// read-only-viewer: a page that shows a drawing to look at, not to edit.
// The drawing is loaded, then made read-only and its interaction locked. A click on a feature
// selects it, and the panel on the right shows its name, its measurements, its style and its
// attributes, every field disabled. The standard UI leaves out the toolbar and the parts of the
// layer panel that change the drawing.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { BASEMAPS, basemapStyle, initialBasemapId } from '../basemap.ts';
import '../example.css';
import { BLOCKS, STOPS } from './data.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.7712, 35.6818],
  zoom: 15.6,
});

// 1. No default layer: the drawing brings its own
const draw = createDraw(map, { initDefaultLayer: false });

// 2. The standard UI of a viewer: no toolbar, and a layer panel that lists the layers and their
// features but adds and reorders nothing. The inspector shows the attributes alone, without the
// style and the operations; while the drawing is read-only nothing in it can be changed.
// `?locale=ja` in the address shows it in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, {
  locale,
  basemaps: BASEMAPS,
  basemap: initialBasemapId(),
  toolbar: false,
  layers: { add: false, reorder: false },
  inspector: { tabs: ['attributes'], operations: false },
});

const loaded = (async () => {
  // 3. Load the drawing while it can still be written: each file into a layer of its own, the
  // blocks colored by their use (the legend tab shows the colors)
  await draw.document.load(BLOCKS, {
    layer: {
      name: 'Blocks',
      styleRule: {
        kind: 'categorical',
        property: 'use',
        map: { office: '#4e79a7', shop: '#f28e2b', hotel: '#59a14f' },
        other: '#bab0ac',
      },
    },
  });
  await draw.document.load(STOPS, { layer: { name: 'Stops' } });

  // 4. Read-only refuses every write, from the user and from code; the interaction lock keeps
  // the user from even starting an edit (no handles, no moving), while selecting still works
  draw.setReadOnly(true);
  draw.setInteractionLocked(true);
})();

// 5. The selection still changes: a click on a feature shows it in the inspector
draw.on('selection.changed', () => {
  const [feature] = draw.selection.features();
  if (feature) console.log(feature.properties);
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, loaded });
