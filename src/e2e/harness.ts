// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The harness of the end-to-end tests
 *
 * The engine is bundled from the sources with vite (in memory), and loaded into headless
 * Chromium next to maplibre's own build. The page runs a real maplibre Map with an empty style
 * (nothing is fetched from the network) and a draw instance on it, and the tests drive it with
 * the real pointer and keyboard of the browser (`page.mouse`, `page.keyboard`). What the unit
 * tests replace with stubs runs for real here: maplibre's event system and projection (pitch and
 * bearing included), the InputNormalizer, the canvas focus and the rendering.
 *
 * The browser is the one playwright-core installs (`npx playwright-core install
 * chromium-headless-shell`), started the same way as the shader compile test.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright-core';
import { build } from 'vite';
import type { Feature, MapLibreGLDraw, Mode } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const maplibreDist = join(
  dirname(createRequire(import.meta.url).resolve('maplibre-gl/package.json')),
  'dist',
);
const ORIGIN = 'http://draw.e2e.test';

/** The globals of the test page, for `page.evaluate` */
export interface E2EWindow {
  map: import('maplibre-gl').Map;
  draw: MapLibreGLDraw;
}

/** The size of the map on the page (CSS pixels) */
export const MAP_SIZE = { width: 640, height: 480 } as const;

/** A point on the page (CSS pixels, relative to the viewport) */
export interface PagePoint {
  x: number;
  y: number;
}

/** The camera the map of a page starts with */
export interface Camera {
  center: [number, number];
  zoom: number;
  pitch?: number;
  bearing?: number;
}

/** The bundle of the page script: file name to code */
export type Bundle = ReadonlyMap<string, string>;

/**
 * Bundles `page-entry.ts` and the engine sources it imports, in memory
 *
 * maplibre-gl is left external; the page resolves it to maplibre's build with an import map.
 */
export async function bundlePage(): Promise<Bundle> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    root: here,
    build: {
      write: false,
      minify: false,
      sourcemap: false,
      lib: { entry: join(here, 'page-entry.ts'), formats: ['es'], fileName: 'draw' },
      rolldownOptions: { external: ['maplibre-gl'] },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const files = new Map<string, string>();
  for (const output of outputs) {
    if (!('output' in output)) throw new Error('vite returned a watcher instead of a bundle');
    for (const chunk of output.output) {
      if (chunk.type === 'chunk') files.set(chunk.fileName, chunk.code);
    }
  }
  if (!files.has('draw.js')) {
    throw new Error(`The bundle has no draw.js: ${[...files.keys()].join(', ')}`);
  }
  return files;
}

/** Starts headless Chromium with a software WebGL2 */
export async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({
      args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
    });
  } catch (error) {
    throw new Error(
      `Headless Chromium could not be started. Install it with ` +
        `\`npx playwright-core install chromium-headless-shell\`.\n${String(error)}`,
    );
  }
}

function pageHtml(): string {
  return (
    '<!doctype html><html><head>' +
    '<link rel="stylesheet" href="/maplibre-gl.css">' +
    '<script type="importmap">{"imports":{"maplibre-gl":"/maplibre-gl.mjs"}}</script>' +
    '<style>html,body{margin:0}</style>' +
    '</head><body>' +
    `<div id="map" style="position:absolute;left:40px;top:30px;` +
    `width:${MAP_SIZE.width}px;height:${MAP_SIZE.height}px"></div>` +
    '<script type="module">' +
    "import * as maplibregl from 'maplibre-gl';" +
    "maplibregl.setWorkerUrl('/maplibre-gl-worker.mjs');" +
    "await import('/draw.js');" +
    'window.e2eReady = true;' +
    '</script>' +
    '</body></html>'
  );
}

/**
 * Opens a page with a map at the given camera and a draw instance on it
 *
 * The page exposes `window.map` and `window.draw`. The map is shifted from the top left of the
 * viewport, so a point that forgets the offset of the canvas lands in the wrong place.
 */
export async function openMapPage(browser: Browser, bundle: Bundle, camera: Camera): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 720, height: 560 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: pageHtml() });
    const script = bundle.get(path.slice(1));
    if (script !== undefined) {
      return route.fulfill({ contentType: 'text/javascript', body: script });
    }
    const contentType = path.endsWith('.css') ? 'text/css' : 'text/javascript';
    return route.fulfill({ contentType, body: readFileSync(join(maplibreDist, path.slice(1))) });
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => 'e2eReady' in window);
  if (errors.length > 0) throw new Error(`The page failed to start: ${errors.join('\n')}`);

  await page.evaluate(async (cam) => {
    const w = window as unknown as {
      e2e: {
        maplibregl: typeof import('maplibre-gl');
        createMapLibreGLDraw: typeof import('../index.js').createMapLibreGLDraw;
      };
      map: unknown;
      draw: unknown;
    };
    const { maplibregl, createMapLibreGLDraw } = w.e2e;
    const map = new maplibregl.Map({
      container: 'map',
      style: { version: 8, sources: {}, layers: [] },
      center: cam.center,
      zoom: cam.zoom,
      pitch: cam.pitch ?? 0,
      bearing: cam.bearing ?? 0,
      maxPitch: 85,
      fadeDuration: 0,
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the map did not load')), 15_000);
      map.once('load', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    w.map = map;
    w.draw = createMapLibreGLDraw(map);
  }, camera);
  await settle(page);
  return page;
}

/** Waits until the map has rendered the latest change (two animation frames) */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/** The point on the page where a coordinate is drawn */
export async function pageOf(page: Page, lngLat: number[]): Promise<PagePoint> {
  return page.evaluate((coord) => {
    const map = (window as unknown as E2EWindow).map;
    const p = map.project(coord as [number, number]);
    const rect = map.getCanvas().getBoundingClientRect();
    return { x: rect.left + p.x, y: rect.top + p.y };
  }, lngLat);
}

/** The coordinate under a point of the page */
export async function lngLatOf(page: Page, point: PagePoint): Promise<[number, number]> {
  return page.evaluate((pt) => {
    const map = (window as unknown as E2EWindow).map;
    const rect = map.getCanvas().getBoundingClientRect();
    const ll = map.unproject([pt.x - rect.left, pt.y - rect.top]);
    return [ll.lng, ll.lat] as [number, number];
  }, point);
}

/** Every feature of the draw instance */
export async function features(page: Page): Promise<Feature[]> {
  return page.evaluate(() => (window as unknown as E2EWindow).draw.getAllFeatures());
}

/** The current mode of the draw instance */
export async function mode(page: Page): Promise<Mode> {
  return page.evaluate(() => (window as unknown as E2EWindow).draw.getMode());
}

/** The ids of the selected features */
export async function selectedIds(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as E2EWindow).draw.getSelectedIds());
}

/** A press, a move in steps and a release of the left mouse button */
export async function drag(page: Page, from: PagePoint, to: PagePoint, steps = 8): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
  await settle(page);
}

/** A click of the left mouse button, and a wait for the map to render */
export async function click(page: Page, point: PagePoint): Promise<void> {
  await page.mouse.click(point.x, point.y);
  await settle(page);
}

/** A key press on the focused element (the map canvas once it has been pressed) */
export async function press(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
  await settle(page);
}
