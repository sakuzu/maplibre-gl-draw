// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// read-only-viewer: a page that shows a drawing to look at, and the four ways to stop edits.
// The drawing is loaded, then made read-only. A click on a feature selects it, and the panel on
// the right shows its name, its measurements and its attributes, every field disabled. Four
// switches in the card of actions at the bottom left, each with a key, switch the four states
// apart: R read-only, which refuses every write; K the interaction lock, which stops only the
// gestures of the user; B the lock of the Blocks layer, which protects its features; and H hides
// the blocks on this page only, writing nothing.

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

// 2. The standard UI of a viewer: a layer panel that lists the layers and their features but adds
// and reorders nothing, and an inspector with the attributes alone, without the style and the
// operations; while the drawing is read-only nothing in it can be changed. The toolbar stays,
// so its tools can be seen to refuse. `?locale=ja` in the address shows it in Japanese
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, {
  locale,
  basemaps: BASEMAPS,
  basemap: initialBasemapId(),
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

  // 4. Then a viewer: read-only refuses every write, from the user and from code
  draw.setReadOnly(true);
})();

/** The ID of the Blocks layer */
function blocksId(): string | undefined {
  return draw.layers.list().find((layer) => layer.name === 'Blocks')?.id;
}

// 5. The four switches. Read-only refuses every write, by the user or by code: the methods that
// change data return false or null, and the tools draw nothing. The interaction lock only stops
// the user: no tool starts, no handles and no moving, while selecting still works and code can
// still write. A locked layer is a property of the document: its features refuse to move or
// change, and since locking it is a write, read-only refuses it too. Hiding is local: the
// layer is hidden on this page only, the document and its `visible` do not change, and it
// works under read-only
function toggleReadOnly(): void {
  draw.setReadOnly(!draw.isReadOnly());
  console.info(`Read-only: ${draw.isReadOnly()}`);
}

function toggleInteractionLock(): void {
  draw.setInteractionLocked(!draw.isInteractionLocked());
  console.info(`Interaction lock: ${draw.isInteractionLocked()}`);
}

function toggleLayerLock(): void {
  const id = blocksId();
  if (id === undefined) return;
  const locked = draw.layers.get(id)?.locked !== true;
  const layer = draw.layers.update(id, { locked });
  if (layer === null) console.info('The lock of the Blocks layer was refused: read-only');
  else console.info(`Blocks layer locked: ${layer.locked === true}`);
}

function toggleHidden(): void {
  const id = blocksId();
  if (id === undefined) return;
  if (draw.hidden.has(id)) draw.hidden.remove(id);
  else draw.hidden.add(id);
  console.info(`Blocks hidden on this page: ${draw.hidden.has(id)}`);
}

// 6. The switches in the card of actions of the standard UI, each with its key (listed with ?,
// and left alone while a field of the panels has the keyboard). A switch shows what `checked`
// returns: the card reads it again after each press and on `refresh()`, which follows the events
// of core, so that the lock and the eye of the layer panel show here too
const ja = locale === 'ja';
const blocksLocked = () => draw.layers.get(blocksId() ?? '')?.locked === true;
const blocksHidden = () => {
  const id = blocksId();
  return id !== undefined && draw.hidden.has(id);
};
ui.actions.add({
  id: 'read-only',
  label: ja ? '読み取り専用' : 'Read-only',
  kind: 'toggle',
  shortcut: 'R',
  run: toggleReadOnly,
  checked: () => draw.isReadOnly(),
});
ui.actions.add({
  id: 'interaction-lock',
  label: ja ? '操作の錠' : 'Interaction lock',
  kind: 'toggle',
  shortcut: 'K',
  run: toggleInteractionLock,
  checked: () => draw.isInteractionLocked(),
});
ui.actions.add({
  id: 'lock-blocks',
  label: ja ? 'Blocks をロック' : 'Lock Blocks',
  kind: 'toggle',
  shortcut: 'B',
  run: toggleLayerLock,
  checked: blocksLocked,
});
ui.actions.add({
  id: 'hide-blocks',
  label: ja ? 'Blocks を隠す' : 'Hide Blocks',
  kind: 'toggle',
  shortcut: 'H',
  run: toggleHidden,
  checked: blocksHidden,
});
for (const event of [
  'readOnly.changed',
  'interactionLock.changed',
  'layer.created',
  'layer.updated',
  'hidden.changed',
] as const) {
  draw.on(event, () => ui.actions.refresh());
}

// 7. The selection still changes: a click on a feature shows it in the inspector
draw.on('selection.changed', () => {
  const [feature] = draw.selection.features();
  if (feature) console.log(feature.properties);
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, loaded });
