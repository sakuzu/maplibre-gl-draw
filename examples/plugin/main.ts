// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// plugin: extending a draw instance with a plugin.
// The plugin counts the features created (an event), offers the count to the page (its api)
// and adds a drawing mode of its own; removing it removes all of that again.

import { createDraw, type ModeFactory, type Plugin } from '@sakuzu/maplibre-gl-draw';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';

/** What the plugin offers the page (`draw.extensions.plugins.getApi`) */
interface StampApi {
  getCreatedCount(): number;
}

/** A plugin with a mode that puts a point where the user clicks */
function createStampPlugin(onCount: (count: number) => void): Plugin<StampApi> {
  let created = 0;

  // A mode receives the input through its handlers; this one only needs clicks and keys.
  // `writes` keeps it from starting while no layer can be written
  const stampMode: ModeFactory = (ctx) => ({
    writes: true,
    onClick(event) {
      ctx.commitFeature({ type: 'Point', geometry: { type: 'Point', coordinates: event.lngLat } });
    },
    onKeyDown(event) {
      if (event.key === 'Escape') ctx.setMode('select');
    },
  });

  return {
    name: 'stamp',
    api: { getCreatedCount: () => created },
    onAdd(ctx) {
      // What the plugin adds through its context is removed with it
      ctx.extensions.modes.add('stamp', stampMode);
      // After every creation, whatever made it: a mode, a load or the API
      ctx.on('feature.created', () => {
        created += 1;
        onCount(created);
      });
    },
  };
}

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.767, 35.681],
  zoom: 14,
});
const draw = createDraw(map);

const output = document.getElementById('output') as HTMLPreElement;
const pluginButton = document.getElementById('install') as HTMLButtonElement;
const stampButton = document.getElementById('stamp') as HTMLButtonElement;
let removePlugin: (() => void) | null = null;

/** Adds or removes the plugin */
function setAdded(on: boolean): void {
  if (on) {
    removePlugin = draw.extensions.plugins.add(
      createStampPlugin((count) => {
        output.textContent = `The plugin has seen ${count} features created`;
      }),
    );
  } else {
    removePlugin?.();
    removePlugin = null;
  }
  pluginButton.classList.toggle('active', on);
  pluginButton.textContent = on ? 'Remove the plugin' : 'Add the plugin';
  stampButton.disabled = !on;
}

pluginButton.addEventListener('click', () => setAdded(removePlugin === null));
stampButton.addEventListener('click', () => {
  draw.setMode('stamp');
  const count = draw.extensions.plugins.getApi<StampApi>('stamp')?.getCreatedCount() ?? 0;
  output.textContent = `Click the map to stamp points (${count} features so far)`;
});
document.getElementById('draw-polygon')?.addEventListener('click', () => {
  draw.setMode('draw_polygon');
});
draw.on('mode.changed', ({ mode }) => stampButton.classList.toggle('active', mode === 'stamp'));

setAdded(true);

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw });
