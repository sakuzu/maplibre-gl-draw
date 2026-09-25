// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// plugin: extending a draw instance with a plugin.
// The plugin counts the features created (a hook), offers the count to the page (its api)
// and adds a drawing mode of its own; uninstalling it removes all of that again.

import {
  createMapLibreGLDraw,
  type ModeHandler,
  type Plugin,
  type PluginContext,
} from '@sakuzu/maplibre-gl-draw';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';

/** What the plugin offers the page (`draw.getPluginApi`) */
interface StampApi {
  getCreatedCount(): number;
}

/** A plugin with a mode that puts a point where the user clicks */
function createStampPlugin(onCount: (count: number) => void): Plugin {
  let ctx: PluginContext | null = null;
  let unregisterMode: (() => void) | null = null;
  let created = 0;

  // A mode is a set of handlers for the normalized input; this one only needs clicks and keys
  const stampMode = (): ModeHandler => ({
    modeName: 'stamp',
    writesFeatures: true,
    onClick(event) {
      const { lng, lat } = event.lngLat;
      ctx?.addFeatures([
        { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} },
      ]);
    },
    onKeyDown(event) {
      if (event.key === 'Escape') ctx?.setMode('select');
    },
  });

  const api = { getCreatedCount: () => created } satisfies StampApi;

  return {
    name: 'stamp',
    api,
    onInstall(context) {
      ctx = context;
      // The plugin could list the mode in `modes` instead; registering it here shows the
      // function that registerMode returns
      unregisterMode = context.draw.registerMode('stamp', stampMode);
    },
    onUninstall() {
      unregisterMode?.();
      ctx = null;
    },
    hooks: {
      // After every creation, whatever made it: a mode, a load or the API
      'feature:afterCreate': (features) => {
        created += features.length;
        onCount(created);
      },
    },
  };
}

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.767, 35.681],
  zoom: 14,
});
const draw = createMapLibreGLDraw(map);

const output = document.getElementById('output') as HTMLPreElement;
const installButton = document.getElementById('install') as HTMLButtonElement;
const stampButton = document.getElementById('stamp') as HTMLButtonElement;
let uninstall: (() => void) | null = null;

/** Installs or uninstalls the plugin */
function setInstalled(on: boolean): void {
  if (on) {
    uninstall = draw.addPlugin(
      createStampPlugin((count) => {
        output.textContent = `The plugin has seen ${count} features created`;
      }),
    );
  } else {
    uninstall?.();
    uninstall = null;
  }
  installButton.classList.toggle('active', on);
  installButton.textContent = on ? 'Uninstall the plugin' : 'Install the plugin';
  stampButton.disabled = !on;
}

installButton.addEventListener('click', () => setInstalled(uninstall === null));
stampButton.addEventListener('click', () => {
  draw.setMode('stamp');
  const count = draw.getPluginApi<StampApi>('stamp')?.getCreatedCount() ?? 0;
  output.textContent = `Click the map to stamp points (${count} features so far)`;
});
document.getElementById('draw-polygon')?.addEventListener('click', () => {
  draw.setMode('draw_polygon');
});
draw.on('draw.mode.change', ({ mode }) => stampButton.classList.toggle('active', mode === 'stamp'));

setInstalled(true);

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw });
