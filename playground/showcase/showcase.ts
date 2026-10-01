// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The showcase: the scenes the README images are taken from
 *
 * Opening the playground with `?showcase` opens the overview, and `?showcase=<scene>` opens
 * one of the other scenes: `tilted` (pitch and bearing), `terrain` (3D terrain), `globe`
 * (the globe projection) and `large-data` (a city of editable features). `scripts/capture-readme-image.mjs` opens each scene and takes the
 * picture once `<html data-showcase="ready">` is set.
 */

import type { Draw } from '@sakuzu/maplibre-gl-draw';
import type * as maplibregl from 'maplibre-gl';
import { globeScene } from './globe';
import { largeDataScene } from './large-data';
import { overviewScene } from './overview';
import { nextFrame, type ShowcaseScene } from './scene';
import { terrainScene } from './terrain';
import { tiltedScene } from './tilted';

export type { ShowcaseScene } from './scene';

const SCENES: Record<string, ShowcaseScene> = {
  overview: overviewScene,
  tilted: tiltedScene,
  terrain: terrainScene,
  globe: globeScene,
  'large-data': largeDataScene,
};

/**
 * The scene the page opens, or `null` for the plain playground
 *
 * The dev server opens the plain playground and `?showcase` opens the showcase. The
 * GitHub Pages build (`npm run build:site`, which sets `VITE_SITE`) opens the showcase by
 * default and the plain playground with `?plain`. An unknown scene name opens the overview.
 */
export function getShowcaseScene(): ShowcaseScene | null {
  const params = new URLSearchParams(window.location.search);
  const name = params.get('showcase');
  if (name !== null) return SCENES[name] ?? overviewScene;
  return import.meta.env.VITE_SITE === '1' && !params.has('plain') ? overviewScene : null;
}

/**
 * Loads the drawing of the scene and finishes it, then marks the page ready once the map has
 * settled
 *
 * Called on the map's load.
 */
export async function runShowcase(
  scene: ShowcaseScene,
  draw: Draw,
  map: maplibregl.Map,
): Promise<void> {
  await scene.load({ draw, map });
  await scene.finish?.({ draw, map });

  await nextFrame();
  if (!map.loaded()) {
    await new Promise<void>((resolve) => map.once('idle', () => resolve()));
  }
  document.documentElement.dataset.showcase = 'ready';
}
