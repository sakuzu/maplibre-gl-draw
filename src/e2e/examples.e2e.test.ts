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
 *
 * The examples with the standard UI take it from its build, ui/dist/ (`npm run ui:build`), with
 * Svelte and kata inside it, so their pages load nothing else either.
 */

import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import {
  click,
  drag,
  type E2EWindow,
  launchBrowser,
  type PagePoint,
  pageOf,
  settle,
} from './harness.js';

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
}, browserTimeout(120_000));

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
    { timeout: browserTimeout(30_000) },
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
  return page.evaluate(() => (window as unknown as E2EWindow).draw.features.count());
}

function output(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById('output')?.textContent ?? '');
}

/**
 * The colors of the canvas within 2 CSS px of where a coordinate is drawn, read in the render
 * event of the next frame (the drawing buffer is cleared after it is shown)
 */
function colorsAround(page: Page, lngLat: number[]): Promise<Array<[number, number, number]>> {
  return page.evaluate(
    (coord) =>
      new Promise<Array<[number, number, number]>>((resolve) => {
        const { map } = window as unknown as E2EWindow;
        map.once('render', () => {
          const canvas = map.getCanvas();
          const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
          const ratio = gl.drawingBufferWidth / canvas.clientWidth;
          const p = map.project(coord as [number, number]);
          const r = Math.round(2 * ratio);
          const x = Math.round(p.x * ratio) - r;
          const y = gl.drawingBufferHeight - 1 - Math.round(p.y * ratio) - r;
          const size = 2 * r + 1;
          const pixels = new Uint8Array(size * size * 4);
          gl.readPixels(x, y, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const colors: Array<[number, number, number]> = [];
          for (let i = 0; i < pixels.length; i += 4) {
            colors.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
          }
          resolve(colors);
        });
        map.triggerRepaint();
      }),
    lngLat,
  );
}

/** Whether a color is the white of the fill of a handle */
function isWhite([r, g, b]: [number, number, number]): boolean {
  return r >= 250 && g >= 250 && b >= 250;
}

/** Clicks the vertices of a closed ring, the last click on the first vertex */
async function clickRing(page: Page, points: PagePoint[]): Promise<void> {
  for (const point of [...points, points[0]]) await click(page, point);
}

describe('the examples', () => {
  it('lists the twelve examples on its index page', async () => {
    const index = String(site.get('index.html'));
    for (const name of [
      'get-started',
      'style-features',
      'basic',
      'save-load',
      'style-rules',
      'snapping-and-geometry',
      'terrain',
      'read-only',
      'plugin',
      'custom-feature-type',
      'large-data',
      'table-worker',
    ]) {
      expect(index).toContain(`./${name}/`);
      expect(site.has(`${name}/index.html`)).toBe(true);
    }
  });

  it('get-started draws a polygon with the tool of the toolbar and shows it in the inspector', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('get-started');
    const inspector = page.locator('[data-role="inspector"]');
    expect(await inspector.count()).toBe(0);

    await page.getByRole('button', { name: 'Polygon', exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as E2EWindow).draw.getMode())).toBe(
      'draw_polygon',
    );
    await clickRing(page, [at(-80, -60), at(80, -60), at(80, 60), at(-80, 60)]);
    expect(await featureCount(page)).toBe(1);

    // Selected with a click, it opens the inspector on its style
    await page.keyboard.press('Escape');
    await click(page, at(0, 0));
    await inspector.getByRole('button', { name: 'Fill color' }).waitFor();
    await close();
  });

  it('style-features opens on the style of the block, and the inspector restyles it', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('style-features');
    const block = () =>
      page.evaluate(() => {
        const { draw } = window as unknown as E2EWindow;
        return draw.features.list().find((f) => f.properties.name === 'Block');
      });
    const fill = page
      .locator('[data-role="inspector"]')
      .getByRole('button', { name: 'Fill color' });
    await fill.waitFor();
    expect((await fill.innerText()).trim().toLowerCase()).toBe('#edae49');
    // The width the page set from code after the style it was created with
    expect((await block())?.style).toMatchObject({ fillColor: '#edae49', strokeWidth: 4 });

    // The color field opens kata's ColorPicker, whose code input commits a hex
    await fill.click();
    const code = page.getByRole('textbox', { name: 'Color code' });
    await code.fill('#1a2b3c');
    await code.press('Enter');
    await expect
      .poll(async () => (await block())?.style?.fillColor, { timeout: browserTimeout(5_000) })
      .toBe('#1A2B3C');
    await close();
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
        return draw.layers.list().find((layer) => layer.name === 'Blocks')?.styleRule?.kind;
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
      await page.evaluate(() => (window as unknown as E2EWindow).draw.selection.get().ids.length),
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
      return draw.layers.list().find((layer) => layer.name === 'Parcels')?.locked;
    });
    expect(locked).toBe(false);
    await close();
  });

  it('plugin stamps a point in the mode of the plugin, and removing it removes the mode', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('plugin');
    await page.click('#stamp');
    await click(page, at(0, 100));
    expect(await featureCount(page)).toBe(1);
    expect(await output(page)).toContain('seen 1');

    await page.click('#install');
    const registered = await page.evaluate(() =>
      (window as unknown as E2EWindow).draw.extensions.modes.has('stamp'),
    );
    expect(registered).toBe(false);
    await close();
  });

  it('custom-feature-type adds a route and selects it with a click', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('custom-feature-type');
    await page.click('#add-route');
    const route = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      draw.selection.clear();
      const all = draw.features.list();
      return all[all.length - 1];
    });
    expect(route.type).toBe('Route');
    const [a, b] = (route.geometry as GeoJSON.LineString).coordinates;
    const pt = await pageOf(page, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    await click(page, pt);
    expect(
      await page.evaluate(() => [...(window as unknown as E2EWindow).draw.selection.get().ids]),
    ).toEqual([route.id]);
    await close();
  });

  it('custom-feature-type shows the handles of its definition and drags one', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('custom-feature-type');
    await page.click('#add-route');
    const route = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      draw.selection.clear();
      const all = draw.features.list();
      return all[all.length - 1];
    });
    const [first] = (route.geometry as GeoJSON.LineString).coordinates;
    // Not selected: no handle, so nothing white where the first vertex is
    expect((await colorsAround(page, first)).some(isWhite)).toBe(false);

    await page.evaluate(
      (id) => (window as unknown as E2EWindow).draw.selection.set('feature', [id]),
      route.id,
    );
    await settle(page);
    // Selected: the handle is drawn there with the look of a vertex handle
    expect((await colorsAround(page, first)).some(isWhite)).toBe(true);

    // The handle takes the drag, and the definition moves the vertex
    const from = await pageOf(page, first);
    await drag(page, from, { x: from.x - 40, y: from.y + 30 });
    const moved = await page.evaluate(
      (id) => (window as unknown as E2EWindow).draw.features.get(id)?.geometry,
      route.id,
    );
    const [movedFirst, movedSecond] = (moved as GeoJSON.LineString).coordinates;
    expect(movedFirst[0]).toBeLessThan(first[0]);
    expect(movedFirst[1]).toBeLessThan(first[1]);
    expect(movedSecond).toEqual((route.geometry as GeoJSON.LineString).coordinates[1]);
    await close();
  });

  it('large-data shows 50,000 cells and reports the one clicked', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('large-data');
    const cells = await page.evaluate(
      () => (window as unknown as E2EWindow).draw.datasets.get('grid')?.listRows().length,
    );
    expect(cells).toBe(50_000);
    await click(page, at(10, 10));
    expect(await output(page)).toMatch(/^(grid|points): /);
    await close();
  });

  it('table-worker shows the 200,000 rows of the Worker and reports the one clicked', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('table-worker');
    await page.evaluate(() => (window as unknown as { loaded: Promise<void> }).loaded);
    const total = await page.evaluate(
      () => (window as unknown as E2EWindow).draw.datasets.get('places')?.getThinningStats().total,
    );
    expect(total).toBe(200_000);
    // Row 0, where it was drawn
    const lngLat = await page.evaluate(() => {
      const dataset = (window as unknown as E2EWindow).draw.datasets.get('places');
      const [row] = dataset?.listVisibleRows([-180, -85, 180, 85]) ?? [];
      // In the page: the helpers of the library are not loaded here
      return (row.geometry as GeoJSON.Point).coordinates as [number, number];
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

  it('builds a page for each example with the standard UI', () => {
    for (const name of [
      'feature-properties',
      'layers-and-groups',
      'style-rules-and-legend',
      'snapping-and-tracing',
      'geometry-operations',
      'images',
    ]) {
      expect(site.has(`${name}/index.html`)).toBe(true);
    }
  });

  it('feature-properties opens on the Attributes tab, and the tab adds one', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('feature-properties');
    const market = () =>
      page.evaluate(() => {
        const { draw } = window as unknown as E2EWindow;
        return draw.features.list().find((f) => f.properties.name === 'Market hall')?.properties;
      });
    // Loaded from GeoJSON, then changed from code: a value set, one added and one removed
    const loaded = await market();
    expect(loaded).toMatchObject({ use: 'commercial', floors: 4, renovated: 2024 });
    expect(loaded).not.toHaveProperty('stalls');

    // The inspector opens on the Attributes tab of the selected feature, with no click; a
    // value added there is kept as typed
    const inspector = page.locator('[data-role="inspector"]');
    const current = inspector.locator('[data-role="tabs"] [aria-current="page"]').first();
    await expect
      .poll(async () => (await current.textContent())?.trim(), {
        timeout: browserTimeout(5_000),
      })
      .toBe('Attributes');
    expect(await inspector.innerText()).toContain('commercial');
    await inspector.getByRole('button', { name: 'Add an attribute' }).click();
    await page.keyboard.type('height');
    await page.keyboard.press('Tab');
    await page.keyboard.type('12');
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => (await market())?.height, { timeout: browserTimeout(5_000) })
      .toBe('12');
    await close();
  });

  it('layers-and-groups lists the layers and the locked group, and the eye hides a layer', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('layers-and-groups');
    const state = () =>
      page.evaluate(() => {
        const w = window as unknown as E2EWindow & {
          layerIds: { parcels: string; paths: string };
        };
        const [group] = w.draw.groups.list();
        return {
          ids: w.layerIds,
          order: [...w.draw.layers.getOrder()],
          active: w.draw.layers.getActive()?.id,
          parcelsVisible: w.draw.layers.get(w.layerIds.parcels)?.visible,
          paths: w.draw.layers.get(w.layerIds.paths)?.opacity,
          group: { id: group?.id, size: group?.featureIds.length, locked: group?.locked },
        };
      });
    const before = await state();
    expect(before.order).toEqual([before.ids.parcels, before.ids.paths]);
    expect(before.active).toBe(before.ids.paths);
    expect(before.paths).toBe(0.6);
    expect(before.group).toMatchObject({ size: 3, locked: true });

    // The panel on the left shows the group, and the eye of the parcels hides the layer
    const panel = page.locator('[data-role="layer-panel"]');
    await panel.locator(`[role="treeitem"][data-node="${before.group.id}"]`).waitFor();
    await panel
      .locator(`[role="treeitem"][data-node="${before.ids.parcels}"]`)
      .getByRole('button', { name: 'Hide', exact: true })
      .click();
    await expect
      .poll(async () => (await state()).parcelsVisible, { timeout: browserTimeout(5_000) })
      .toBe(false);
    await close();
  });

  it('style-rules-and-legend shows the rule in the legend and R switches its kind', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('style-rules-and-legend');
    const ruleKind = () =>
      page.evaluate(() => (window as unknown as E2EWindow).draw.layers.list()[0]?.styleRule?.kind);
    expect(await ruleKind()).toBe('categorical');
    await page.getByRole('button', { name: 'Legend', exact: true }).click();
    const legend = page.locator('[data-role="legend"]');
    await expect
      .poll(() => legend.innerText(), { timeout: browserTimeout(5_000) })
      .toContain('commercial');

    await page.locator('body').press('r');
    expect(await ruleKind()).toBe('graduated');
    await expect
      .poll(() => legend.innerText(), { timeout: browserTimeout(5_000) })
      .toContain('or more');
    await close();
  });

  it('snapping-and-tracing snaps to a vertex and traces the boundary between two clicks', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('snapping-and-tracing');
    const stream = await page.evaluate(() => (window as unknown as { STREAM: number[][] }).STREAM);
    const first = stream[0];
    const last = stream[stream.length - 1];
    await page.getByRole('button', { name: 'Line', exact: true }).click();
    // A few pixels off each end of the boundary: both snap to the vertex
    const start = await pageOf(page, first);
    const end = await pageOf(page, last);
    await click(page, { x: start.x + 5, y: start.y + 4 });
    await click(page, { x: end.x + 5, y: end.y - 4 });
    await click(page, { x: end.x + 5, y: end.y - 4 });
    const line = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      const lines = draw.features.list({ type: 'LineString' });
      return (lines[lines.length - 1].geometry as GeoJSON.LineString).coordinates;
    });
    // Snapped at both ends, and the vertices between them traced along the boundary
    expect(line).toEqual(stream);

    // The switch of the toolbar turns snapping off
    await page.getByRole('button', { name: 'Snapping', exact: true }).click();
    expect(
      await page.evaluate(
        () => (window as unknown as E2EWindow).draw.options.get().snapping?.enabled,
      ),
    ).toBe(false);
    await close();
  });

  it('geometry-operations opens with two squares selected and unites them from the panel', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('geometry-operations');
    // Three squares, the line and the buffer the page made around it
    expect(await featureCount(page)).toBe(5);
    const logs: string[] = [];
    page.on('console', (message) => logs.push(message.text()));

    await page
      .locator('[data-role="inspector"]')
      .getByRole('button', { name: 'Union', exact: true })
      .click();
    await expect.poll(() => featureCount(page), { timeout: browserTimeout(5_000) }).toBe(4);
    const made = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      const [feature] = draw.selection.features();
      return feature?.type;
    });
    expect(made).toBe('Polygon');
    // The result is selected, and its area logged: two squares of about 400 m by 445 m
    await expect
      .poll(() => logs.find((log) => log.startsWith('1 selected')), {
        timeout: browserTimeout(5_000),
      })
      .toMatch(/^1 selected: [\d,]+ m², 0 m of line$/);
    await close();
  });

  it('images places an image from code and loads the file the Image tool asks for', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('images');
    const images = () =>
      page.evaluate(() =>
        (window as unknown as E2EWindow).draw.features
          .list({ type: 'Image' })
          .map((f) => ({ name: f.properties.name, opacity: f.style.imageOpacity })),
      );
    expect(await images()).toEqual([{ name: 'Sketch map', opacity: 0.85 }]);

    // The Image tool emits image.requested, and the page opens a file picker
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Image', exact: true }).click();
    await (await chooser).setFiles({
      name: 'red.png',
      mimeType: 'image/png',
      buffer: Buffer.from(solidPng(32, [200, 40, 40])),
    });
    await expect
      .poll(async () => (await images()).length, { timeout: browserTimeout(5_000) })
      .toBe(2);
    await close();
  });
});
