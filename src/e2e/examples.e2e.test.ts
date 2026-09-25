// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the examples: every page of examples/ opens and does its one thing
 *
 * The examples are built with their own vite configuration (in memory, from the library
 * sources) and served to headless Chromium from that build. Nothing goes to the network: every
 * request outside the test origin is aborted, and the basemap and the elevation tiles of the
 * examples are replaced through the address of the page (`?style=` and `?dem=`, see
 * examples/basemap.ts) by an empty style and flat tiles served here.
 *
 * Each test opens its page in a new browser context, so localStorage starts empty, and does
 * one drawing or one operation the way the user would, with the real pointer.
 */

import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { click, type E2EWindow, launchBrowser, type PagePoint, pageOf, settle } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(here, '../../examples');
const ORIGIN = 'http://examples.e2e.test';
const VIEWPORT = { width: 1024, height: 720 } as const;
/** The center of the page, where the center of the map is */
const CENTER: PagePoint = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
/** Opening a page compiles the shaders again on the software WebGL, which takes seconds */
const TIMEOUT = 60_000;

/** A page point relative to the center of the page */
function at(dx: number, dy: number): PagePoint {
  return { x: CENTER.x + dx, y: CENTER.y + dy };
}

/** The built files of the examples: path (without the leading slash) to content */
type Site = ReadonlyMap<string, string | Uint8Array>;

async function buildExamples(): Promise<Site> {
  const result = await build({
    root: EXAMPLES,
    configFile: join(EXAMPLES, 'vite.config.ts'),
    logLevel: 'silent',
    build: { write: false, minify: false },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const files = new Map<string, string | Uint8Array>();
  for (const output of outputs) {
    if (!('output' in output)) throw new Error('vite returned a watcher instead of a bundle');
    for (const file of output.output) {
      files.set(file.fileName, file.type === 'chunk' ? file.code : file.source);
    }
  }
  if (!files.has('basic/index.html')) {
    throw new Error(`The build has no basic page: ${[...files.keys()].join(', ')}`);
  }
  return files;
}

/** A PNG of one color (8-bit RGB), for the elevation tiles */
function solidPng(size: number, rgb: [number, number, number]): Uint8Array {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) row.set(rgb, 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Flat ground at 500 m in the Mapbox encoding: -10000 + (R * 65536 + G * 256 + B) / 10 */
const DEM_TILE = solidPng(256, [1, 154, 40]);
const EMPTY_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef0f2' } }],
};
const DEM_TILEJSON = {
  tilejson: '2.2.0',
  tiles: [`${ORIGIN}/e2e/dem/{z}/{x}/{y}.png`],
  minzoom: 0,
  maxzoom: 12,
};

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.png': 'image/png',
};

let browser: Browser;
let site: Site;

beforeAll(async () => {
  [browser, site] = await Promise.all([launchBrowser(), buildExamples()]);
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

/** Serves the build, the test fixtures and the public files, and aborts everything else */
async function serve(context: BrowserContext): Promise<void> {
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    let path = url.pathname.slice(1);
    if (path === '' || path.endsWith('/')) path += 'index.html';
    const contentType = CONTENT_TYPES[extname(path)] ?? 'application/octet-stream';
    if (path === 'e2e/style.json') return route.fulfill({ json: EMPTY_STYLE });
    if (path === 'e2e/dem.json') return route.fulfill({ json: DEM_TILEJSON });
    if (path.startsWith('e2e/dem/')) {
      return route.fulfill({ contentType, body: Buffer.from(DEM_TILE) });
    }
    const built = site.get(path);
    if (built !== undefined) {
      return route.fulfill({
        contentType,
        body: typeof built === 'string' ? built : Buffer.from(built),
      });
    }
    try {
      return route.fulfill({ contentType, body: readFileSync(join(EXAMPLES, 'public', path)) });
    } catch {
      return route.fulfill({ status: 404, body: 'not found' });
    }
  });
}

/** Waits until the page has exposed its map and draw instance and the style has loaded */
async function ready(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as Partial<E2EWindow>;
      return w.draw !== undefined && w.map?.isStyleLoaded() === true;
    },
    undefined,
    { timeout: 30_000 },
  );
  await settle(page);
}

/**
 * Opens an example in a new browser context, offline, and waits until it is ready
 *
 * The page errors are collected; `close` fails the test when there was one.
 */
async function openExample(name: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: VIEWPORT });
  await serve(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  const query = new URLSearchParams({
    style: `${ORIGIN}/e2e/style.json`,
    dem: `${ORIGIN}/e2e/dem.json`,
  });
  await page.goto(`${ORIGIN}/${name}/index.html?${query}`);
  await ready(page);
  return {
    page,
    close: async () => {
      await context.close();
      expect(errors).toEqual([]);
    },
  };
}

function featureCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as E2EWindow).draw.getAllFeatures().length);
}

function output(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById('output')?.textContent ?? '');
}

/** Clicks the vertices of a closed ring, the last click on the first vertex */
async function clickRing(page: Page, points: PagePoint[]): Promise<void> {
  for (const point of [...points, points[0]]) await click(page, point);
}

describe('the examples', () => {
  it('lists the ten examples on its index page', async () => {
    const index = String(site.get('index.html'));
    for (const name of [
      'basic',
      'save-load',
      'style-rules',
      'snapping-and-geometry',
      'terrain',
      'read-only',
      'plugin',
      'custom-feature-type',
      'large-data',
      'columnar-worker',
    ]) {
      expect(index).toContain(`./${name}/`);
      expect(site.has(`${name}/index.html`)).toBe(true);
    }
  });

  it('basic draws a polygon, saves it and restores it on the next visit', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('basic');
    await page.click('#draw-polygon');
    expect(await page.getAttribute('#draw-polygon', 'class')).toContain('active');
    await clickRing(page, [at(-80, -60), at(80, -60), at(80, 60), at(-80, 60)]);
    expect(await featureCount(page)).toBe(1);
    expect(await page.getAttribute('#draw-polygon', 'class')).not.toContain('active');

    await page.click('#save');
    await page.reload();
    await ready(page);
    expect(await featureCount(page)).toBe(1);
    await close();
  });

  it('save-load loads the sample, saves the native format and restores it', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('save-load');
    await page.click('#load-sample');
    await page.waitForFunction(() => document.getElementById('output')?.textContent !== '');
    const loaded = await featureCount(page);
    expect(loaded).toBeGreaterThan(10);
    expect(await output(page)).toContain('(geojson)');

    await page.click('#save');
    await page.click('#restore');
    await page.waitForFunction(() =>
      document.getElementById('output')?.textContent?.includes('native'),
    );
    expect(await output(page)).toContain('replaced');
    expect(await featureCount(page)).toBe(loaded);
    await close();
  });

  it('style-rules colors the layer by a rule and shows its legend', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('style-rules');
    const ruleKind = () =>
      page.evaluate(() => {
        const { draw } = window as unknown as E2EWindow;
        return draw.getAllLayers().find((layer) => layer.name === 'Blocks')?.styleRule?.kind;
      });
    expect(await ruleKind()).toBe('categorical');
    expect(await output(page)).toContain('commercial');

    await page.click('[data-rule="graduated"]');
    expect(await ruleKind()).toBe('graduated');
    expect(await output(page)).toContain('No data');
    await close();
  });

  it('snapping-and-geometry merges two polygons selected with the pointer', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('snapping-and-geometry');
    expect(await featureCount(page)).toBe(4);
    await click(page, await pageOf(page, [139.759, 35.6825]));
    await page.keyboard.down('Shift');
    await click(page, await pageOf(page, [139.764, 35.681]));
    await page.keyboard.up('Shift');
    expect(
      await page.evaluate(() => (window as unknown as E2EWindow).draw.getSelectedIds().length),
    ).toBe(2);

    await page.click('[data-op="union"]');
    expect(await featureCount(page)).toBe(3);
    expect(await output(page)).toContain('union: applied');
    await close();
  });

  it('terrain draws a line on the terrain', { timeout: TIMEOUT }, async () => {
    const { page, close } = await openExample('terrain');
    await page.waitForFunction(() => (window as unknown as E2EWindow).map.getTerrain() !== null);
    await page.click('#draw-line');
    await click(page, at(-60, 120));
    await click(page, at(60, 160));
    await click(page, at(60, 160));
    expect(await featureCount(page)).toBe(3);

    await page.click('#diagnostics');
    expect(await output(page)).toContain('Terrain active: true');
    await close();
  });

  it('read-only refuses to draw under the interaction lock, and writes while read-only', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('read-only');
    await page.click('#interaction-lock');
    await page.click('#draw-polygon');
    expect(await output(page)).toBe('Drawing is not possible now');
    expect(await page.evaluate(() => (window as unknown as E2EWindow).draw.getMode())).toBe(
      'select',
    );
    await page.click('#interaction-lock');

    await page.click('#read-only');
    await page.click('#lock-layer');
    const locked = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      return draw.getAllLayers().find((layer) => layer.name === 'Parcels')?.locked;
    });
    expect(locked).toBe(false);
    await close();
  });

  it('plugin stamps a point in the mode of the plugin, and uninstalling removes the mode', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('plugin');
    await page.click('#stamp');
    await click(page, at(0, 100));
    expect(await featureCount(page)).toBe(1);
    expect(await output(page)).toContain('seen 1');

    await page.click('#install');
    const entered = await page.evaluate(() =>
      (window as unknown as E2EWindow).draw.setMode('stamp'),
    );
    expect(entered).toBe(false);
    await close();
  });

  it('custom-feature-type adds a route and selects it with a click', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('custom-feature-type');
    await page.click('#add-route');
    const route = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      draw.deselect();
      const all = draw.getAllFeatures();
      return all[all.length - 1];
    });
    expect(route.type).toBe('Route');
    const [a, b] = route.coordinates as number[][];
    const pt = await pageOf(page, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    await click(page, pt);
    expect(
      await page.evaluate(() => (window as unknown as E2EWindow).draw.getSelectedIds()),
    ).toEqual([route.id]);
    await close();
  });

  it('large-data shows 50,000 cells and reports the one clicked', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('large-data');
    const cells = await page.evaluate(
      () => (window as unknown as E2EWindow).draw.getDataset('grid')?.getFeatures().length,
    );
    expect(cells).toBe(50_000);
    await click(page, at(10, 10));
    expect(await output(page)).toMatch(/^(grid|points): /);
    await close();
  });

  it('columnar-worker shows the 200,000 rows of the Worker and reports the one clicked', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('columnar-worker');
    await page.evaluate(() => (window as unknown as { loaded: Promise<void> }).loaded);
    const total = await page.evaluate(
      () => (window as unknown as E2EWindow).draw.getDataset('places')?.getThinningStats().total,
    );
    expect(total).toBe(200_000);
    // Row 0, where it was drawn
    const lngLat = await page.evaluate(() => {
      const dataset = (window as unknown as E2EWindow).draw.getDataset('places');
      const [feature] =
        dataset?.collectVisible({ minX: -180, minY: -85, maxX: 180, maxY: 85 }) ?? [];
      return feature.coordinates as [number, number];
    });
    await page.evaluate(
      (center) => (window as unknown as E2EWindow).map.jumpTo({ center, zoom: 18 }),
      lngLat,
    );
    await settle(page);
    await click(page, await pageOf(page, lngLat));
    expect(await output(page)).toMatch(/^row \d+: (shop|school|station|park), value \d+$/);
    await close();
  });
});
