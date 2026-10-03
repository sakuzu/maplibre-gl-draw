// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The harness of the end-to-end tests of the interface
 *
 * The page script (page-entry.ts) is built in memory with vite, with the Svelte plugin and the
 * style sheet of the interface as the package build makes them, and loaded into headless
 * Chromium next to maplibre's own build. Nothing comes from the network: the page, the script,
 * the style sheets and maplibre's files are served from memory and from node_modules through
 * `page.route`, and the map has an empty style.
 *
 * The browser is the one playwright-core installs for core's end-to-end tests
 * (`npx playwright-core install chromium-headless-shell`); a test that also needs WebKit is
 * skipped while it is not installed (`npx playwright-core install webkit`).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Draw } from '@sakuzu/maplibre-gl-draw';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { type Browser, chromium, type Page, webkit } from 'playwright-core';
import { build } from 'vite';
import { scopeKata } from '../build/scope-css.ts';
import type { DrawUI } from '../src/index.ts';
import { browserTimeout } from './timeout.js';

const here = dirname(fileURLToPath(import.meta.url));
const UI = join(here, '..');
const maplibreDist = join(
  dirname(createRequire(import.meta.url).resolve('maplibre-gl/package.json')),
  'dist',
);
const ORIGIN = 'http://ui.e2e.test';

/** The size of the page; wide enough for the side panels to float beside the toolbar */
export const VIEWPORT = { width: 1280, height: 800 } as const;

/** The globals of the test page, for `page.evaluate` */
export interface E2EWindow {
  map: MapLibreMap;
  draw: Draw;
  ui: DrawUI;
  /** The IDs of the features the page starts with */
  ids: { point: string; line: string; polygon: string };
  /** The layer they are in */
  layerId: string;
}

/** A point on the page (CSS pixels) */
export interface PagePoint {
  x: number;
  y: number;
}

/** The built page script and its style sheet: file name to content */
export type Site = ReadonlyMap<string, string | Uint8Array>;

/**
 * Builds page-entry.ts with the interface's sources, in memory
 *
 * maplibre-gl stays outside; the page resolves it to maplibre's build with an import map. Core
 * comes from its build (the root dist), which `npm run build` at the root makes.
 */
export async function buildPage(): Promise<Site> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    root: UI,
    plugins: [svelte()],
    css: { postcss: { plugins: [scopeKata()] } },
    build: {
      write: false,
      minify: false,
      sourcemap: false,
      target: 'es2022',
      lib: {
        // The interface is an entry of its own, as in the package build: the package marks only
        // its style sheets as having side effects, so main.ts reached only through a re-export
        // would lose the style sheets it imports
        entry: { page: join(here, 'page-entry.ts'), ui: join(UI, 'src/main.ts') },
        formats: ['es'],
        fileName: (_format, name) => `${name}.js`,
        cssFileName: 'style',
      },
      rolldownOptions: { external: [/^maplibre-gl(\/|$)/] },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const files = new Map<string, string | Uint8Array>();
  for (const output of outputs) {
    if (!('output' in output)) throw new Error('vite returned a watcher instead of a bundle');
    for (const file of output.output) {
      files.set(file.fileName, file.type === 'chunk' ? file.code : file.source);
    }
  }
  for (const name of ['page.js', 'style.css']) {
    if (!files.has(name)) {
      throw new Error(`The build has no ${name}: ${[...files.keys()].join(', ')}`);
    }
  }
  return files;
}

/**
 * Starts headless Chromium with a software WebGL2. Headless Chromium hides the scrollbars;
 * scrollbars: true draws them, as a browser on a desktop does, for a test that measures them
 */
export async function launchBrowser({ scrollbars = false } = {}): Promise<Browser> {
  try {
    return await chromium.launch({
      args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
      ...(scrollbars ? { ignoreDefaultArgs: ['--hide-scrollbars'] } : {}),
    });
  } catch (error) {
    throw new Error(
      'Headless Chromium could not be started. Install it with ' +
        `\`npx playwright-core install chromium-headless-shell\`.\n${String(error)}`,
    );
  }
}

/**
 * Starts headless WebKit, or gives null when it is not installed
 * (`npx playwright-core install webkit`), so that the tests that need it can be skipped
 */
export async function launchWebKit(): Promise<Browser | null> {
  try {
    return await webkit.launch();
  } catch {
    return null;
  }
}

const PAGE_HTML =
  '<!doctype html><html lang="en"><head>' +
  '<link rel="stylesheet" href="/maplibre-gl.css">' +
  '<link rel="stylesheet" href="/style.css">' +
  '<script type="importmap">{"imports":{"maplibre-gl":"/maplibre-gl.mjs"}}</script>' +
  '<style>html,body{margin:0;height:100%}#map{position:absolute;inset:0}</style>' +
  '</head><body><div id="map"></div>' +
  '<script type="module">' +
  "import * as maplibregl from 'maplibre-gl';" +
  "maplibregl.setWorkerUrl('/maplibre-gl-worker.mjs');" +
  "await import('/page.js');" +
  'window.e2eReady = true;' +
  '</script></body></html>';

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
};

/**
 * Opens the page: a map with an empty style, a draw instance with a point, a line and a polygon
 * (each with a name and two attributes) in the first layer, and `createDrawUI` in the dark theme
 * over it
 *
 * The page exposes `window.map`, `window.draw`, `window.ui`, `window.ids` and `window.layerId`.
 * Every request outside the test origin is aborted. The page is VIEWPORT large unless another
 * size is given.
 */
export async function openPage(
  browser: Browser,
  site: Site,
  viewport: { width: number; height: number } = VIEWPORT,
): Promise<Page> {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(browserTimeout(10_000));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const path = url.pathname.slice(1);
    if (path === '') return route.fulfill({ contentType: 'text/html', body: PAGE_HTML });
    const contentType = CONTENT_TYPES[extname(path)] ?? 'application/octet-stream';
    const built = site.get(path);
    if (built !== undefined) {
      return route.fulfill({
        contentType,
        body: typeof built === 'string' ? built : Buffer.from(built),
      });
    }
    try {
      return route.fulfill({ contentType, body: readFileSync(join(maplibreDist, path)) });
    } catch {
      return route.fulfill({ status: 404, body: '' });
    }
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => 'e2eReady' in window);
  if (errors.length > 0) throw new Error(`The page failed to start: ${errors.join('\n')}`);

  await page.evaluate(async (loadTimeout) => {
    const w = window as unknown as E2EWindow & {
      e2e: {
        maplibregl: typeof import('maplibre-gl');
        createDraw: typeof import('@sakuzu/maplibre-gl-draw').createDraw;
        createDrawUI: typeof import('../src/index.ts').createDrawUI;
      };
    };
    const { maplibregl, createDraw, createDrawUI } = w.e2e;
    const map = new maplibregl.Map({
      container: 'map',
      style: { version: 8, sources: {}, layers: [] },
      center: [139.77, 35.68],
      zoom: 13,
      fadeDuration: 0,
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the map did not load')), loadTimeout);
      map.once('load', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const draw = createDraw(map);
    const created = draw.features.createMany([
      {
        type: 'Point',
        geometry: { type: 'Point', coordinates: [139.765, 35.684] },
        properties: { name: 'Station', kind: 'station', platforms: 30 },
      },
      {
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [139.755, 35.676],
            [139.762, 35.684],
            [139.768, 35.69],
          ],
        },
        properties: { name: 'Walk', surface: 'paved', lanes: 2 },
      },
      {
        type: 'Polygon',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [139.772, 35.672],
              [139.782, 35.672],
              [139.782, 35.68],
              [139.772, 35.68],
              [139.772, 35.672],
            ],
          ],
        },
        properties: { name: 'Block', kind: 'block', owner: 'city' },
      },
    ]);
    if (!created) throw new Error('the features were not created');
    const [point, line, polygon] = created;
    w.map = map;
    w.draw = draw;
    w.ids = { point: point.id, line: line.id, polygon: polygon.id };
    w.layerId = polygon.layerId;
    w.ui = createDrawUI(draw, { theme: 'dark' });
  }, browserTimeout(15_000));
  await settle(page);
  if (errors.length > 0) throw new Error(`The page failed: ${errors.join('\n')}`);
  return page;
}

/** Waits until the page has drawn the latest change (two animation frames) */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/** The point on the page where a coordinate is drawn */
export async function pageOf(page: Page, lngLat: [number, number]): Promise<PagePoint> {
  return page.evaluate((coord) => {
    const map = (window as unknown as E2EWindow).map;
    const p = map.project(coord);
    const rect = map.getCanvas().getBoundingClientRect();
    return { x: rect.left + p.x, y: rect.top + p.y };
  }, lngLat);
}
