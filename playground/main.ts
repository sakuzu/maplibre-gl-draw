// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The playground: every feature of the library on one page, under the standard UI with all its
// parts. What the standard UI does not cover is added through its openings (a tool for a mode,
// a section of the inspector, an action in the card at the bottom left, switches.ts): the stamps
// of the plugin of the plugins example, the routes of the custom-feature-types example, terrain,
// a dataset, read-only, the interaction lock, saving and opening in this browser, and 200,000
// features.
// The globe is the globe button of the map's controls.
//
// The page opens on the overview scene (showcase/overview.ts): a drawing of every kind of
// feature and look. `?plain` opens it empty, and `?showcase=<scene>` opens another scene of
// those the README images are taken from (showcase/).

import { createDraw, type ModeFactory } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI, type DrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './maplibre-setup.ts';
import { BASEMAPS, basemapStyle, initialBasemapId } from '../examples/basemap.ts';
import { routeLook, routeType } from '../examples/custom-feature-types/route.ts';
import {
  createStampPlugin,
  isStamp,
  STAR_ICON,
  type StampState,
  stampStyle,
} from '../examples/plugins/stamp.ts';
import { getShowcaseScene, runShowcase } from './showcase/showcase.ts';
import './showcase/showcase.css';
import { addSwitches } from './switches.ts';
import './style.css';

const scene = getShowcaseScene();
const ja = new URLSearchParams(location.search).get('locale') === 'ja';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(scene?.basemap),
  center: scene?.camera.center ?? [139.767, 35.681],
  zoom: scene?.camera.zoom ?? 14,
  pitch: scene?.camera.pitch ?? 0,
  bearing: scene?.camera.bearing ?? 0,
  ...(scene?.maxPitch !== undefined && { maxPitch: scene.maxPitch }),
});

// 1. The draw instance, with snapping on; a scene brings its own layers, and the empty page
// (`?plain`) starts with one
const draw = createDraw(map, {
  initDefaultLayer: scene === null,
  snapping: { enabled: true, disableKey: 'alt' },
});

// 2. A plugin with a mode of its own, and a custom feature type with a mode that places it
draw.extensions.plugins.add(createStampPlugin());
draw.extensions.featureTypes.add(routeType);
const routeMode: ModeFactory = (ctx) => ({
  writes: true,
  onClick({ point: [x, y] }) {
    const at = (dx: number, dy: number) => ctx.screen.unproject([x + dx, y + dy]);
    ctx.commitFeature({
      type: 'Route',
      geometry: { type: 'LineString', coordinates: [at(-80, 30), at(0, -30), at(80, 30)] },
    });
  },
  onKeyDown(event) {
    if (event.key === 'Escape') ctx.setMode('select');
  },
});
draw.extensions.modes.add('route', routeMode);

// 3. The standard UI, every part on (the defaults), with the tools, the sections and the
// switches below. The layer panel lists up to 1,000 features in a layer, and only their number
// beyond that, so the 200,000 points (Shift+B) need nothing of the page
function mountUI(): DrawUI {
  const ui = createDrawUI(draw, {
    locale: ja ? 'ja' : 'en',
    basemaps: BASEMAPS,
    basemap: initialBasemapId(),
  });

  // 4. Tools for the two modes, and sections of the inspector for their features
  ui.tools.add({
    id: 'stamp',
    mode: 'stamp',
    label: ja ? 'スタンプ' : 'Stamp',
    icon: STAR_ICON,
    shortcut: 'S',
    group: 'extensions',
  });
  ui.tools.add({
    id: 'route',
    mode: 'route',
    label: ja ? 'ルート' : 'Route',
    icon:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="2" stroke-dasharray="3 3"><path d="M3 18 L12 6 L21 18"/></svg>',
    shortcut: 'R',
    group: 'extensions',
  });
  ui.inspector?.sections.add({
    id: 'stamp',
    title: ja ? 'スタンプ' : 'Stamp',
    appliesTo: (features) => features.every(isStamp),
    fields: ([first]) => [
      {
        key: 'stamp',
        kind: 'segmented',
        label: ja ? '状態' : 'State',
        value: first.properties.stamp,
        options: [
          { value: 'planned', label: ja ? '予定' : 'Planned' },
          { value: 'done', label: ja ? '済み' : 'Done' },
        ],
      },
    ],
    onchange: (_key, value, features) => {
      const state = value as StampState;
      const patch = { properties: { stamp: state }, style: stampStyle(state) };
      draw.features.updateMany(features.map((f) => ({ id: f.id, patch })));
    },
  });
  ui.inspector?.sections.add({
    id: 'route',
    title: ja ? 'ルート' : 'Route',
    appliesTo: (features) => features.every((f) => f.type === 'Route'),
    fields: ([first]) => {
      const look = routeLook(first);
      return [
        { key: 'routeColor', kind: 'color', label: ja ? '色' : 'Color', value: look.routeColor },
        {
          key: 'routeWidth',
          kind: 'slider',
          label: ja ? '太さ' : 'Width',
          value: look.routeWidth,
          min: 1,
          max: 12,
          unit: 'px',
        },
        {
          key: 'routeDashed',
          kind: 'toggle',
          label: ja ? '破線' : 'Dashed',
          value: look.routeDashed,
        },
      ];
    },
    onchange: (key, value, features) => {
      const patch = { style: { [key]: value } };
      draw.features.updateMany(features.map((f) => ({ id: f.id, patch })));
    },
  });
  return ui;
}
// None over a scene that shows the map alone
const ui = scene?.mapOnly ? null : mountUI();

// 5. The image tool asks the page for a file; the page places it where the user clicked
draw.on('image.requested', ({ lngLat, zoom, layerId }) => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void draw.document.load(file, { coordinate: lngLat, zoom, layerId });
  });
  input.click();
});

// 6. A file dropped on the map is loaded there: an image centered where it fell, a GeoJSON or
// a document of the library at its own positions
const container = map.getContainer();
container.addEventListener('dragover', (e) => e.preventDefault());
container.addEventListener('drop', async (e) => {
  e.preventDefault();
  const rect = container.getBoundingClientRect();
  const { lng, lat } = map.unproject([e.clientX - rect.left, e.clientY - rect.top]);
  for (const file of e.dataTransfer?.files ?? []) {
    const result = await draw.document.load(file, {
      coordinate: [lng, lat],
      zoom: map.getZoom(),
      layerId: draw.layers.getActive()?.id,
    });
    console.info(result ? `${file.name}: ${result.featureIds.length} features` : 'Read-only');
  }
});

// 7. The switches in the card of actions, each with Shift and a letter: terrain, a dataset,
// read-only, the lock, 200,000 points, save and open. A scene that shows the map alone has no
// interface, so no switches
if (ui) addSwitches(ui, draw, map, ja);

// A scene of the showcase loads its drawing once the style is in
if (scene) map.on('load', () => void runShowcase(scene, draw, map));

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui });
