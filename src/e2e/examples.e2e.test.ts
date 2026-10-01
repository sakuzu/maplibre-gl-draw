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

import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { parquetMetadata } from 'hyparquet';
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
/** The examples of the gallery of the site, which lists every example */
const CATALOG = join(here, '../../docs/examples/catalog.json');
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
  if (!files.has('get-started/index.html')) {
    throw new Error(`The build has no get-started page: ${[...files.keys()].join(', ')}`);
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

/** Serves the build and the test fixtures, and aborts everything else */
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
    // The files of examples/public/ (the sample data), which vite copies to the root of the
    // build only when it writes the build to disk
    const file = join(EXAMPLES, 'public', path);
    if (existsSync(file)) return route.fulfill({ contentType, body: readFileSync(file) });
    return route.fulfill({ status: 404, body: 'not found' });
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

/** Waits for the promise a page exposes as `loaded` (the data it reads as it opens) */
async function loaded(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { loaded: Promise<unknown> }).loaded);
}

/** The card of the actions of the standard UI, at the bottom left of the map */
function actionCard(page: Page) {
  return page.locator('.mgd-ui [data-role="actions"]');
}

/** Presses the action of the card with this label, a switch or a button, as the user would */
async function pressAction(page: Page, label: string): Promise<void> {
  await actionCard(page).getByText(label, { exact: true }).click();
  await settle(page);
}

/** Whether the switch of the card with this label is on */
function actionChecked(page: Page, label: string): Promise<boolean> {
  return actionCard(page).getByRole('switch', { name: label, exact: true }).isChecked();
}

/** Records the next `dataset.clicked` of the page in `window.clickedDataset` */
async function recordDatasetClick(page: Page): Promise<() => Promise<string | null>> {
  await page.evaluate(() => {
    const w = window as unknown as E2EWindow & { clickedDataset: string | null };
    w.clickedDataset = null;
    w.draw.on('dataset.clicked', ({ datasetId }) => {
      w.clickedDataset = datasetId;
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { clickedDataset: string | null }).clickedDataset);
}

describe('the examples', () => {
  it('builds a page for every example of the gallery, and no page at its root', () => {
    // The gallery of the site lists the examples (docs/examples/catalog.json) and owns
    // /examples/index.html, so the build of the examples has no page there
    const catalog = JSON.parse(readFileSync(CATALOG, 'utf8')) as Record<string, unknown>;
    const names = Object.keys(catalog).filter((name) => name !== 'playground');
    const built = [...site.keys()]
      .filter((file) => file.endsWith('/index.html'))
      .map((file) => file.slice(0, -'/index.html'.length));
    expect(built.sort()).toEqual(names.sort());
    expect(site.has('index.html')).toBe(false);
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

  it('style-features opens on the style of the middle area, and the inspector restyles it', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('style-features');
    const middle = () =>
      page.evaluate(() => {
        const { draw } = window as unknown as E2EWindow;
        return draw.features.list().find((f) => f.properties.name === 'Dashed 3 px');
      });
    const fill = page
      .locator('[data-role="inspector"]')
      .getByRole('button', { name: 'Fill color' });
    await fill.waitFor();
    expect((await fill.innerText()).trim().toLowerCase()).toBe('#66a182');
    // The dash the page set from code after the style it was created with
    expect((await middle())?.style).toMatchObject({
      fillColor: '#66a182',
      strokeColor: '#d1495b',
      strokeWidth: 3,
      lineStyle: 'dashed',
    });

    // The color field opens kata's ColorPicker, whose code input commits a hex
    await fill.click();
    const code = page.getByRole('textbox', { name: 'Color code' });
    await code.fill('#1a2b3c');
    await code.press('Enter');
    await expect
      .poll(async () => (await middle())?.style?.fillColor, { timeout: browserTimeout(5_000) })
      .toBe('#1A2B3C');
    await close();
  });

  it('terrain draws a line with the tool of the toolbar on the terrain', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('terrain');
    await page.waitForFunction(() => (window as unknown as E2EWindow).map.getTerrain() !== null);
    // The drawing of data.ts: an image, an area, two lines and three points
    await expect.poll(() => featureCount(page), { timeout: browserTimeout(10_000) }).toBe(7);
    await page.getByRole('button', { name: 'Line', exact: true }).click();
    await click(page, at(-60, 120));
    await click(page, at(60, 160));
    await click(page, at(60, 160));
    expect(await featureCount(page)).toBe(8);
    await expect
      .poll(
        () =>
          page.evaluate(() => (window as unknown as E2EWindow).draw.debug.terrain().render.active),
        { timeout: browserTimeout(10_000) },
      )
      .toBe(true);
    await close();
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

  it('style-rules-and-legend opens on the graduated rule, R switches it, and a height typed in the Attributes tab recolors the building', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('style-rules-and-legend');
    await loaded(page);
    expect(await featureCount(page)).toBe(400);
    // It opens on Positron, which the style of the address stands in for
    expect(
      (
        await page
          .locator('[data-role="layer-panel"] [role="treeitem"][data-role="basemap"]')
          .innerText()
      ).replace(/\s+/g, ' '),
    ).toContain('OpenFreeMap Positron');
    const ruleKind = () =>
      page.evaluate(() => (window as unknown as E2EWindow).draw.layers.list()[0]?.styleRule?.kind);
    expect(await ruleKind()).toBe('graduated');
    await page.getByRole('button', { name: 'Legend', exact: true }).click();
    const legend = page.locator('[data-role="legend"]');
    await expect
      .poll(() => legend.innerText(), { timeout: browserTimeout(5_000) })
      .toContain('80 or more');

    // A building lower than 10 m, selected: the inspector opens on its Attributes tab, where
    // its height becomes 120, which the rule puts in its last class
    const building = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      const feature = draw.features
        .list()
        .find((f) => typeof f.properties.height === 'number' && f.properties.height < 10);
      if (!feature) throw new Error('No building lower than 10 m');
      draw.selection.set('feature', [feature.id]);
      return { id: feature.id, fill: draw.features.getAppliedStyle(feature.id)?.fillColor };
    });
    expect(building.fill).toBe('#ffffb2');
    const inspector = page.locator('[data-role="inspector"]');
    await inspector.getByRole('button', { name: 'height', exact: true }).click();
    await inspector.getByRole('textbox', { name: 'height', exact: true }).fill('120');
    await page.keyboard.press('Enter');
    const applied = () =>
      page.evaluate((id) => {
        const { draw } = window as unknown as E2EWindow;
        return {
          height: draw.features.get(id)?.properties.height,
          fill: draw.features.getAppliedStyle(id)?.fillColor,
        };
      }, building.id);
    // The page turns the text typed into a number, and the rule reads it
    await expect
      .poll(applied, { timeout: browserTimeout(5_000) })
      .toEqual({ height: 120, fill: '#bd0026' });

    await page.locator('body').press('r');
    await expect.poll(ruleKind, { timeout: browserTimeout(5_000) }).toBe('categorical');
    await expect
      .poll(() => legend.innerText(), { timeout: browserTimeout(5_000) })
      .toContain('commercial');
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

    // The magnet of the toolbar opens the snapping settings, whose first switch turns it off
    await page.getByRole('button', { name: 'Snapping', exact: true }).click();
    await page
      .locator('[data-role="snapping"] [data-role="popover"]')
      .getByRole('switch', { name: 'Snapping', exact: true })
      .click();
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

  it('save-and-load leaves out the unusable feature, saves with S and loads it back from the card of actions', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('save-and-load');
    await loaded(page);
    // The file has five features, one of them a line of a single position
    expect(await featureCount(page)).toBe(4);
    await page.getByRole('button', { name: 'Polygon', exact: true }).click();
    await clickRing(page, [at(-60, -40), at(60, -40), at(60, 40), at(-60, 40)]);
    expect(await featureCount(page)).toBe(5);
    // A click on empty ground gives the map the keyboard, with nothing selected
    await click(page, at(-300, -250));
    await page.keyboard.press('s');

    // The next visit opens with the saved document
    await page.reload();
    await ready(page);
    await loaded(page);
    expect(await featureCount(page)).toBe(5);

    // O loads it back in place of the drawing
    await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      draw.features.deleteMany(draw.features.list().map((f) => f.id));
    });
    expect(await featureCount(page)).toBe(0);
    await pressAction(page, 'Load');
    await expect.poll(() => featureCount(page), { timeout: browserTimeout(5_000) }).toBe(5);
    await close();
  });

  it('save-and-load downloads both formats and opens a file from the card of actions', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('save-and-load');
    await loaded(page);
    await click(page, at(-300, -250));

    // Download offers the document in the format of the library, Download GeoJSON its features
    for (const [label, name] of [
      ['Download', 'drawing.maplibre-gl-draw.json'],
      ['Download GeoJSON', 'drawing.geojson'],
    ] as const) {
      const download = page.waitForEvent('download');
      await pressAction(page, label);
      const file = await download;
      expect(file.suggestedFilename()).toBe(name);
      const json = JSON.parse(readFileSync((await file.path()) as string, 'utf8')) as {
        type?: string;
        version?: string;
        features: unknown[];
      };
      expect(json.features).toHaveLength(4);
      if (label === 'Download') expect(json.version).toBe('3.0.0');
      else expect(json.type).toBe('FeatureCollection');
    }

    // Open a file opens the chooser of the browser, and the file chosen is loaded into the drawing
    const chooser = page.waitForEvent('filechooser');
    await pressAction(page, 'Open a file');
    const point = { type: 'Point', coordinates: [139.774, 35.675] };
    await (await chooser).setFiles({
      name: 'one.geojson',
      mimeType: 'application/geo+json',
      buffer: Buffer.from(
        JSON.stringify({
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: point, properties: { name: 'Chosen' } }],
        }),
      ),
    });
    await expect.poll(() => featureCount(page), { timeout: browserTimeout(5_000) }).toBe(5);
    await close();
  });

  it('globe opens on the globe with its routes, areas, image and cities, and the globe button of the map controls turns it flat', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('globe');
    const projection = () =>
      page.evaluate(() => (window as unknown as E2EWindow).map.getProjection()?.type);
    await expect.poll(projection, { timeout: browserTimeout(5_000) }).toBe('globe');
    await loaded(page);
    // The features by layer and by type: the box, the circle, the area across the antimeridian
    // and the storm; the four routes and the line of two vertices; the six cities
    const byLayer = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      return draw.layers.getOrder().map((id) => ({
        name: draw.layers.get(id)?.name,
        types: draw.features
          .list({ layerId: id })
          .map((feature) => feature.type)
          .sort(),
      }));
    });
    expect(byLayer).toEqual([
      { name: 'Areas', types: ['Circle', 'Image', 'Polygon', 'Polygon'] },
      { name: 'Routes', types: Array(5).fill('LineString') },
      { name: 'Cities', types: Array(6).fill('Point') },
    ]);
    // A great circle has many vertices, the comparison line two
    const vertices = await page.evaluate(() =>
      Object.fromEntries(
        (window as unknown as E2EWindow).draw.features
          .list()
          .filter((feature) => feature.type === 'LineString')
          .map((feature) => [
            feature.properties.name,
            (feature.geometry as GeoJSON.LineString).coordinates.length,
          ]),
      ),
    );
    expect(vertices['Two vertices']).toBe(2);
    expect(vertices['Tokyo to London']).toBeGreaterThan(30);
    expect(
      await page.evaluate(() => [...(window as unknown as E2EWindow).draw.selection.get().ids]),
    ).toEqual([]);

    await page.locator('.maplibregl-ctrl-globe, .maplibregl-ctrl-globe-enabled').click();
    await expect.poll(projection, { timeout: browserTimeout(5_000) }).toBe('mercator');
    await close();
  });

  it('200000-features loads its city of 208,073 features in one step, selects the park at open and a building with a click', {
    timeout: browserTimeout(TIMEOUT),
  }, async () => {
    const { page, close } = await openExample('200000-features');
    // The numbers the page logs, as it hands them to the tests
    const city = await page.evaluate(
      () =>
        (
          window as unknown as {
            loaded: Promise<{ polygons: number; lines: number; points: number; total: number }>;
          }
        ).loaded,
    );
    expect(city.total).toBeGreaterThan(200_000);
    expect(city.polygons + city.lines + city.points).toBe(city.total);
    expect(await featureCount(page)).toBe(city.total);
    const byType = await page.evaluate(() => {
      const types: Record<string, number> = {};
      for (const feature of (window as unknown as E2EWindow).draw.features.list()) {
        types[feature.type] = (types[feature.type] ?? 0) + 1;
      }
      return types;
    });
    expect(byType).toEqual({ Polygon: city.polygons, LineString: city.lines, Point: city.points });

    // The layer panel lists none of them: one row under each layer counts its features
    const counts = page.locator('[data-role="layer-panel"] [data-kind="count"]');
    const rows = [city.polygons, city.lines, city.points]
      .map((n) => `${n.toLocaleString('en')} features. Select them on the map.`)
      .sort();
    await expect
      .poll(async () => (await counts.allInnerTexts()).sort(), {
        timeout: browserTimeout(5_000),
      })
      .toEqual(rows);
    expect(await page.locator('[data-role="layer-panel"] [data-kind="feature"]').count()).toBe(0);

    // The park in front is selected at open, with a white handle on its first vertex
    const selected = () =>
      page.evaluate(() => [...(window as unknown as E2EWindow).draw.selection.get().ids]);
    expect(await selected()).toEqual(['park-selected']);
    const parkVertex = await page.evaluate(() => {
      const park = (window as unknown as E2EWindow).draw.features.get('park-selected');
      if (park === undefined) throw new Error('No park');
      return (park.geometry as GeoJSON.Polygon).coordinates[0][0];
    });
    await expect
      .poll(async () => (await colorsAround(page, parkVertex)).some(isWhite), {
        timeout: browserTimeout(10_000),
      })
      .toBe(true);

    // A house near the middle of the tilted view, with no place drawn over it, is selected by
    // a click on its middle
    const target = await page.evaluate(() => {
      const { draw, map } = window as unknown as E2EWindow;
      const middle = { x: map.getCanvas().clientWidth / 2, y: map.getCanvas().clientHeight / 2 };
      const places = draw.features
        .list()
        .filter((feature) => feature.type === 'Point')
        .map((feature) =>
          map.project((feature.geometry as GeoJSON.Point).coordinates as [number, number]),
        );
      let best: { id: string; center: [number, number]; distance: number } | null = null;
      for (const feature of draw.features.list()) {
        if (feature.properties?.use !== 'House') continue;
        const [ring] = (feature.geometry as GeoJSON.Polygon).coordinates;
        const center: [number, number] = [
          (ring[0][0] + ring[2][0]) / 2,
          (ring[0][1] + ring[2][1]) / 2,
        ];
        const p = map.project(center);
        const distance = Math.hypot(p.x - middle.x, p.y - middle.y);
        if (best !== null && distance >= best.distance) continue;
        if (places.some((place) => Math.hypot(place.x - p.x, place.y - p.y) < 20)) continue;
        best = { id: feature.id, center, distance };
      }
      return best;
    });
    expect(target).not.toBeNull();
    if (target === null) return;
    await click(page, await pageOf(page, target.center));
    expect(await selected()).toEqual([target.id]);
    await close();
  });

  it('datasets shows the generated cells and points and the sample data between and over two layers of the drawing, colors the buildings by area, thins the points until T, lists the rules in the Legend tab and reports a click', {
    timeout: browserTimeout(TIMEOUT),
  }, async () => {
    const count = (name: string): number =>
      (
        JSON.parse(
          readFileSync(join(EXAMPLES, 'public/data', name), 'utf8'),
        ) as GeoJSON.FeatureCollection
      ).features.length;
    const [buildings, places] = [count('tokyo-buildings.geojson'), count('tokyo-places.geojson')];
    const { page, close } = await openExample('datasets');
    // Opened again with the console followed, which the page writes as it loads
    const logs: string[] = [];
    page.on('console', (message) => logs.push(message.text()));
    await page.reload();
    await ready(page);
    expect(
      await page.evaluate(() => (window as unknown as { loaded: Promise<unknown> }).loaded),
    ).toEqual({
      buildings,
      places,
      cells: 250_000,
    });
    // The two layers of the drawing, the cells behind them, the buildings placed between them,
    // and the snapping to the datasets on
    const drawing = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      const layers = Object.fromEntries(
        draw.layers.list().map((layer) => [
          layer.name,
          draw.features
            .list({ layerId: layer.id })
            .map((feature) => feature.type)
            .sort(),
        ]),
      );
      return {
        layers,
        order: draw.layers.getOrder().map((id) => draw.layers.get(id)?.name ?? id),
        snapToDatasets: draw.options.get().snapping?.datasets,
      };
    });
    expect(drawing).toEqual({
      layers: {
        'Survey area': ['Polygon'],
        'Planned route': ['LineString', 'Point', 'Point', 'Point'],
      },
      order: ['cells', 'Survey area', 'buildings', 'Planned route'],
      snapToDatasets: true,
    });
    // The layer panel lists the stack from the front: the places and the points over every
    // layer, the buildings between the two layers and the cells behind them
    const rows = page.locator(
      '[data-role="layer-panel"] [data-container="root"] > [data-sortable-item]',
    );
    expect(
      await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-id'))),
    ).toEqual(
      await page.evaluate(() => {
        const { draw } = window as unknown as E2EWindow;
        return ['places', 'points', ...[...draw.layers.getOrder()].reverse()];
      }),
    );
    expect(
      (await page.locator('[role="treeitem"][data-node="buildings"]').first().innerText())
        .replace(/\s+/g, ' ')
        .trim(),
    ).toBe('buildings');
    expect(logs).toContain(
      `${buildings.toLocaleString('en')} buildings and ${places.toLocaleString('en')} places`,
    );
    expect(logs).toContain('Keys: T turns the thinning of the points off and on');
    expect(logs.some((line) => /^1,000,000 points made in \d+ ms/.test(line))).toBe(true);
    expect(
      logs.some((line) =>
        /^250,000 cells: [\d,]+ ms to make the rows, [\d,]+ ms to give them to the dataset, and the first frame [\d,]+ ms after$/.test(
          line,
        ),
      ),
    ).toBe(true);
    // The cells, all given at once, and the points the provider handed over for the view: the
    // thinning draws a part of them, and T draws them all
    const stats = (id: string) =>
      page.evaluate(
        (datasetId) =>
          (window as unknown as E2EWindow).draw.datasets.get(datasetId)?.getThinningStats(),
        id,
      );
    expect((await stats('cells'))?.total).toBe(250_000);
    await expect
      .poll(async () => (await stats('points'))?.total ?? 0, { timeout: browserTimeout(10_000) })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await stats('points'))?.visible ?? 0, { timeout: browserTimeout(5_000) })
      .toBeGreaterThan(0);
    const thinned = await stats('points');
    expect(thinned?.enabled).toBe(true);
    expect(thinned?.visible).toBeLessThan(thinned?.total ?? 0);
    await expect
      .poll(() => logs.some((line) => /^points: thinning on, [\d,]+ of [\d,]+ drawn$/.test(line)), {
        timeout: browserTimeout(5_000),
      })
      .toBe(true);
    await page.keyboard.press('t');
    await expect
      .poll(async () => (await stats('points'))?.visible, { timeout: browserTimeout(5_000) })
      .toBe(thinned?.total);
    await expect
      .poll(() => logs.some((line) => /^points: thinning off, /.test(line)), {
        timeout: browserTimeout(5_000),
      })
      .toBe(true);
    await page.keyboard.press('t');
    await expect
      .poll(async () => (await stats('points'))?.visible, { timeout: browserTimeout(5_000) })
      .toBe(thinned?.visible);
    // It opens on Positron, which the style of the address stands in for
    expect(
      (
        await page
          .locator('[data-role="layer-panel"] [role="treeitem"][data-role="basemap"]')
          .innerText()
      ).replace(/\s+/g, ' '),
    ).toContain('OpenFreeMap Positron');
    // The buildings by the area of their footprint: each in the color of its class
    const palette = ['#fbb4b9', '#f768a1', '#dd3497', '#ae017e', '#7a0177'];
    // (the class of an area is the number of the breaks 50, 100, 200 and 500 m² it reaches)
    const fills = await page.evaluate(() =>
      (window as unknown as E2EWindow).draw.datasets
        .get('buildings')
        ?.listVisibleRows([-180, -85, 180, 85])
        .map((row) => [row.properties?.area as number, row.style?.fillColor] as const),
    );
    const classOf = (area: number) => [50, 100, 200, 500].filter((at) => area >= at).length;
    expect(fills?.length).toBe(buildings);
    expect(fills?.filter(([area, fill]) => fill !== palette[classOf(area)])).toEqual([]);
    expect(new Set(fills?.map(([, fill]) => fill)).size).toBe(palette.length);
    // The Legend tab: the places in front, then the buildings, each with the rows of its rule
    await page.getByRole('button', { name: 'Legend', exact: true }).click();
    const legendList = (name: string) =>
      page.locator(`[data-role="legend"] [role="list"][aria-label="${name}"]`);
    await expect
      .poll(
        () =>
          page
            .locator('[data-role="legend"] [role="list"]')
            .evaluateAll((lists) => lists.map((list) => list.getAttribute('aria-label'))),
        { timeout: browserTimeout(5_000) },
      )
      .toEqual(['places', 'points', 'buildings', 'cells']);
    expect(
      (await legendList('buildings').locator('[data-role="list-item"]').allInnerTexts()).map(
        (text) => text.trim(),
      ),
    ).toEqual([
      'Below 50',
      '50 to below 100',
      '100 to below 200',
      '200 to below 500',
      '500 or more',
      'Other',
    ]);
    expect(
      await legendList('buildings')
        .locator('[data-role="mark"]')
        .evaluateAll((marks) =>
          marks.map((mark) => (mark as HTMLElement).style.getPropertyValue('--kata-swatch-color')),
        ),
    ).toEqual([...palette, '#d9d9d9']);
    expect(await legendList('places').locator('[data-role="list-item"]').count()).toBe(7);
    expect(
      (await legendList('points').locator('[data-role="list-item"]').allInnerTexts()).map((text) =>
        text.trim(),
      ),
    ).toEqual(['walk', 'bicycle', 'car', 'train', 'Other']);
    expect(await legendList('cells').locator('[data-role="list-item"]').count()).toBe(6);
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    expect(
      await page.evaluate(
        () => (window as unknown as E2EWindow).draw.datasets.get('buildings')?.listRows().length,
      ),
    ).toBe(buildings);
    // The provider of the places hands over those in view, a part of them
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as E2EWindow).draw.datasets.get('places')?.listRows().length ?? 0,
          ),
        { timeout: browserTimeout(10_000) },
      )
      .toBeGreaterThan(0);

    // The middle of a building of four corners, at zoom 18
    const target = await page.evaluate(() => {
      const { draw, map } = window as unknown as E2EWindow;
      const dataset = draw.datasets.get('buildings');
      for (let i = 0; dataset?.getRowId(i) != null; i++) {
        const geometry = dataset.getRow(i)?.geometry;
        if (geometry?.type !== 'Polygon' || geometry.coordinates[0].length !== 5) continue;
        const ring = geometry.coordinates[0].slice(0, 4);
        const center = [0, 1].map((k) => ring.reduce((sum, p) => sum + p[k], 0) / 4);
        map.jumpTo({ center: center as [number, number], zoom: 18 });
        return center;
      }
      throw new Error('No building of four corners');
    });
    await settle(page);
    const clicked = await recordDatasetClick(page);
    await click(page, await pageOf(page, target));
    await expect
      .poll(clicked, { timeout: browserTimeout(5_000) })
      .toMatch(/^(buildings|places|points)$/);
    expect(logs.some((line) => /^(buildings|places|points): /.test(line))).toBe(true);
    await close();
  });

  it('columnar-data-in-a-worker reads every row of the GeoParquet file in its Worker and reports a click, and M adds and removes a million points', {
    timeout: browserTimeout(TIMEOUT),
  }, async () => {
    const file = readFileSync(join(EXAMPLES, 'public/data/tokyo-buildings.parquet'));
    const rows = Number(
      parquetMetadata(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength))
        .num_rows,
    );
    const { page, close } = await openExample('columnar-data-in-a-worker');
    // Opened again with the console followed, which the page writes once the rows are drawn
    const infos: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'info') infos.push(message.text());
    });
    await page.reload();
    await ready(page);
    const result = await page.evaluate(
      () =>
        (
          window as unknown as {
            loaded: Promise<{ rows: number; times: Record<string, number>; firstFrameMs: number }>;
          }
        ).loaded,
    );
    expect(result.rows).toBe(rows);
    expect(Number.isFinite(result.firstFrameMs)).toBe(true);
    expect(Object.keys(result.times).sort()).toEqual(['fetch', 'prepare', 'read', 'table']);
    expect(Object.values(result.times).every(Number.isFinite)).toBe(true);
    // The console states the keys, then the number of rows and the time of each step
    expect(infos).toHaveLength(2);
    expect(infos[0]).toBe('Keys: M loads 1,000,000 points from the Worker, and removes them');
    expect(infos[1]).toMatch(
      new RegExp(
        `^${rows.toLocaleString('en')} building footprints read from a GeoParquet file in a Worker and drawn from its columns: \\d+ ms to fetch the file, \\d+ ms to read the columns, \\d+ ms to build the table, \\d+ ms to prepare it, and \\d+ ms from the request to the first frame that draws them$`,
      ),
    );
    // It opens on Dark, which the style of the address stands in for
    expect(
      (
        await page
          .locator('[data-role="layer-panel"] [role="treeitem"][data-role="basemap"]')
          .innerText()
      ).replace(/\s+/g, ' '),
    ).toContain('OpenFreeMap Dark');
    // The footprints by their area: each in the color of its class
    const palette = ['#cc4778', '#e66c5c', '#f89540', '#fdc328', '#f0f921'];
    // (the class of an area is the number of the breaks 50, 100, 200 and 500 m² it reaches)
    const fills = await page.evaluate(() =>
      (window as unknown as E2EWindow).draw.datasets
        .get('buildings')
        ?.listVisibleRows([-180, -85, 180, 85])
        .map((row) => [row.properties?.area as number, row.style?.fillColor] as const),
    );
    const classOf = (area: number) => [50, 100, 200, 500].filter((at) => area >= at).length;
    expect(fills?.length).toBe(rows);
    expect(fills?.filter(([area, fill]) => fill !== palette[classOf(area)])).toEqual([]);
    expect(new Set(fills?.map(([, fill]) => fill)).size).toBe(palette.length);
    const total = await page.evaluate(() => {
      const dataset = (window as unknown as E2EWindow).draw.datasets.get('buildings');
      let count = 0;
      while (dataset?.getRowId(count) != null) count++;
      return count;
    });
    expect(total).toBe(rows);

    // The middle of a building of four corners, at zoom 18
    const target = await page.evaluate(() => {
      const { draw, map } = window as unknown as E2EWindow;
      const dataset = draw.datasets.get('buildings');
      for (let i = 0; dataset?.getRowId(i) != null; i++) {
        const geometry = dataset.getRow(i)?.geometry;
        if (geometry?.type !== 'MultiPolygon' || geometry.coordinates[0][0].length !== 5) continue;
        const ring = geometry.coordinates[0][0].slice(0, 4);
        const center = [0, 1].map((k) => ring.reduce((sum, p) => sum + p[k], 0) / 4);
        map.jumpTo({ center: center as [number, number], zoom: 18 });
        return center;
      }
      throw new Error('No building of four corners');
    });
    await settle(page);
    const clicked = await recordDatasetClick(page);
    await click(page, await pageOf(page, target));
    await expect.poll(clicked, { timeout: browserTimeout(5_000) }).toBe('buildings');

    // M asks the Worker for the million points, which a second dataset draws from the table
    await page.keyboard.press('m');
    const million = () =>
      page.evaluate(
        () =>
          (window as unknown as E2EWindow).draw.datasets.get('million')?.getThinningStats().total ??
          null,
      );
    await expect.poll(million, { timeout: browserTimeout(30_000) }).toBe(1_000_000);
    await expect.poll(() => infos.length, { timeout: browserTimeout(10_000) }).toBe(3);
    expect(infos[2]).toMatch(
      /^1,000,000 points made in a Worker as typed arrays: [\d,]+ ms to build the table, [\d,]+ ms to prepare it, [\d,]+ ms to transfer it without a copy, and [\d,]+ ms from handing it to the dataset to the first frame that draws them; the arrays hold \d+ MB( \(JavaScript heap \d+ MB before, \d+ MB after\))?$/,
    );
    // A click on one of them, alone at zoom 18, reports its row
    const point = await page.evaluate(() => {
      const { draw, map } = window as unknown as E2EWindow;
      const position = draw.datasets.get('million')?.getRowPoint(123_456);
      if (!position) throw new Error('No point at row 123456');
      map.jumpTo({ center: position as [number, number], zoom: 18 });
      return position;
    });
    await settle(page);
    const clickedPoint = await recordDatasetClick(page);
    await click(page, await pageOf(page, point));
    await expect.poll(clickedPoint, { timeout: browserTimeout(5_000) }).toBe('million');
    // M again removes them
    await page.keyboard.press('m');
    await expect.poll(million, { timeout: browserTimeout(5_000) }).toBeNull();
    await close();
  });

  it('read-only-viewer loads its drawing and refuses an update', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('read-only-viewer');
    await page.evaluate(() => (window as unknown as { loaded: Promise<void> }).loaded);
    const after = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      const [first] = draw.features.list();
      const updated = draw.features.update(first.id, { properties: { name: 'Changed' } });
      return {
        count: draw.features.count(),
        updated,
        name: draw.features.get(first.id)?.properties.name,
      };
    });
    expect(after).toEqual({ count: 8, updated: null, name: 'North tower' });
    await close();
  });

  it('read-only-viewer switches read-only, the interaction lock, the lock of the Blocks layer and local hiding from the card of actions, and the interaction lock with K', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('read-only-viewer');
    await loaded(page);
    const press = async (key: string) => {
      await page.keyboard.press(key);
      await settle(page);
    };
    const state = () =>
      page.evaluate(() => {
        const { draw } = window as unknown as E2EWindow;
        const blocks = draw.layers.list().find((layer) => layer.name === 'Blocks');
        if (blocks === undefined) throw new Error('No Blocks layer');
        return {
          readOnly: draw.isReadOnly(),
          interactionLocked: draw.isInteractionLocked(),
          layerLocked: blocks.locked === true,
          hidden: draw.hidden.has(blocks.id),
          visible: blocks.visible !== false,
        };
      });
    const tower = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      return draw.features.list().find((f) => f.properties.name === 'North tower');
    });
    if (tower === undefined) throw new Error('No North tower');
    const geometryOf = (id: string) =>
      page.evaluate(
        (featureId) => (window as unknown as E2EWindow).draw.features.get(featureId)?.geometry,
        id,
      );
    const rename = () =>
      page.evaluate(
        (id) =>
          (window as unknown as E2EWindow).draw.features.update(id, {
            properties: { note: 'changed' },
          }) !== null,
        tower.id,
      );
    // The viewer opens read-only, with the three other states off
    expect(await state()).toEqual({
      readOnly: true,
      interactionLocked: false,
      layerLocked: false,
      hidden: false,
      visible: true,
    });
    expect(await rename()).toBe(false);
    // The tools start, and what they draw is not kept
    await page.getByRole('button', { name: 'Polygon', exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as E2EWindow).draw.getMode())).toBe(
      'draw_polygon',
    );
    await clickRing(page, [at(-60, 120), at(60, 120), at(60, 200), at(-60, 200)]);
    expect(await featureCount(page)).toBe(8);
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    // The switches of the card show the states
    expect(await actionChecked(page, 'Read-only')).toBe(true);
    expect(await actionChecked(page, 'Interaction lock')).toBe(false);
    // Locking a layer is a write, so read-only refuses it, and its switch stays off
    await pressAction(page, 'Lock Blocks');
    expect((await state()).layerLocked).toBe(false);
    expect(await actionChecked(page, 'Lock Blocks')).toBe(false);

    // Read-only off: writable again, by code too
    await pressAction(page, 'Read-only');
    expect((await state()).readOnly).toBe(false);
    expect(await actionChecked(page, 'Read-only')).toBe(false);
    expect(await rename()).toBe(true);

    // K, the key of the interaction lock: it stops the tools of the user; code still writes
    await page.mouse.move(CENTER.x, CENTER.y);
    await press('k');
    expect((await state()).interactionLocked).toBe(true);
    expect(await actionChecked(page, 'Interaction lock')).toBe(true);
    await page.getByRole('button', { name: 'Polygon', exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as E2EWindow).draw.getMode())).not.toBe(
      'draw_polygon',
    );
    await clickRing(page, [at(-60, 120), at(60, 120), at(60, 200), at(-60, 200)]);
    expect(await featureCount(page)).toBe(8);
    expect(await rename()).toBe(true);
    await pressAction(page, 'Interaction lock');
    expect((await state()).interactionLocked).toBe(false);

    // B: the locked layer keeps its features where they are; unlocked, a drag moves them
    const [[corner]] = (tower.geometry as GeoJSON.Polygon).coordinates;
    const inside = [corner[0] + 0.0008, corner[1] + 0.00055];
    await page.evaluate(
      (center) =>
        (window as unknown as E2EWindow).map.jumpTo({ center: center as [number, number] }),
      inside,
    );
    await settle(page);
    await pressAction(page, 'Lock Blocks');
    expect((await state()).layerLocked).toBe(true);
    expect(await actionChecked(page, 'Lock Blocks')).toBe(true);
    await click(page, at(0, 0));
    await drag(page, at(0, 0), at(-50, 40));
    expect(await geometryOf(tower.id)).toEqual(tower.geometry);
    await pressAction(page, 'Lock Blocks');
    expect((await state()).layerLocked).toBe(false);
    await click(page, at(0, 0));
    await drag(page, at(0, 0), at(-50, 40));
    expect(await geometryOf(tower.id)).not.toEqual(tower.geometry);

    // Hide Blocks: hidden on this page only; the layer stays visible in the document, under
    // read-only too
    await pressAction(page, 'Read-only');
    await pressAction(page, 'Hide Blocks');
    expect(await state()).toMatchObject({ readOnly: true, hidden: true, visible: true });
    expect(await actionChecked(page, 'Hide Blocks')).toBe(true);
    await pressAction(page, 'Hide Blocks');
    expect((await state()).hidden).toBe(false);
    await close();
  });

  it('plugins adds the tool of the mode of the plugin, which stamps a point', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('plugins');
    expect(await featureCount(page)).toBe(1);
    await page.getByRole('button', { name: 'Stamp', exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as E2EWindow).draw.getMode())).toBe(
      'stamp',
    );
    await click(page, at(-100, 60));
    const stamped = await page.evaluate(() => {
      const all = (window as unknown as E2EWindow).draw.features.list();
      return all.map((f) => f.properties.stamp);
    });
    expect(stamped).toEqual(['done', 'planned']);
    await close();
  });

  it('plugins removes the plugin with its mode, its tool and its section from the card of actions, and adds them back with U', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('plugins');
    const press = async (key: string) => {
      await page.keyboard.press(key);
      await settle(page);
    };
    const stampTool = page.getByRole('button', { name: 'Stamp', exact: true });
    const section = page.locator('[data-role="inspector"]').getByText('Planned', { exact: true });
    const extension = () =>
      page.evaluate(() => {
        const { draw } = window as unknown as E2EWindow;
        let error: string | undefined;
        try {
          draw.setMode('stamp');
        } catch (e) {
          error = (e as { code?: string }).code;
        }
        draw.setMode('select');
        return {
          plugin: draw.extensions.plugins.has('stamp'),
          mode: draw.extensions.modes.has('stamp'),
          error,
        };
      });
    // The page opens with the meeting point selected, on the section of the plugin
    await section.waitFor();
    expect(await stampTool.count()).toBe(1);
    expect(await extension()).toEqual({ plugin: true, mode: true, error: undefined });

    expect(await actionChecked(page, 'Stamp plugin')).toBe(true);
    await pressAction(page, 'Stamp plugin');
    expect(await extension()).toEqual({ plugin: false, mode: false, error: 'not-found' });
    expect(await actionChecked(page, 'Stamp plugin')).toBe(false);
    expect(await stampTool.count()).toBe(0);
    expect(await section.count()).toBe(0);
    // The stars stay in the drawing
    expect(await featureCount(page)).toBe(1);

    await page.mouse.move(CENTER.x, CENTER.y);
    await press('u');
    expect(await extension()).toEqual({ plugin: true, mode: true, error: undefined });
    expect(await actionChecked(page, 'Stamp plugin')).toBe(true);
    expect(await stampTool.count()).toBe(1);
    await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      draw.selection.set('feature', [draw.features.list()[0].id]);
    });
    await section.waitFor();
    // The plugin added again stamps and counts from zero
    await stampTool.click();
    await click(page, at(-100, 60));
    expect(
      await page.evaluate(() =>
        (window as unknown as E2EWindow).draw.extensions.plugins
          .getApi<{ count(): number }>('stamp')
          ?.count(),
      ),
    ).toBe(1);
    await close();
  });

  it('custom-feature-types draws a route with its own style keys and hits it', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('custom-feature-types');
    const [hill, river] = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      draw.selection.clear();
      return draw.features.list();
    });
    expect(river.type).toBe('Route');
    // The river route is drawn solid in its own blue (#1f6feb)
    const [r0, r1] = (river.geometry as GeoJSON.LineString).coordinates;
    const middle = [(r0[0] + r1[0]) / 2, (r0[1] + r1[1]) / 2];
    expect((await colorsAround(page, middle)).some(([r, , b]) => b > 180 && r < 120)).toBe(true);

    // A click on the hill route selects it, through the hit test of the type
    const [h0, h1] = (hill.geometry as GeoJSON.LineString).coordinates;
    await click(page, await pageOf(page, [(h0[0] + h1[0]) / 2, (h0[1] + h1[1]) / 2]));
    expect(
      await page.evaluate(() => [...(window as unknown as E2EWindow).draw.selection.get().ids]),
    ).toEqual([hill.id]);
    await close();
  });

  it('custom-feature-types unregisters the type from the card of actions, and registers it again with U', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('custom-feature-types');
    const press = async (key: string) => {
      await page.keyboard.press(key);
      await settle(page);
    };
    const [hill, river] = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      draw.selection.clear();
      return draw.features.list();
    });
    const [r0, r1] = (river.geometry as GeoJSON.LineString).coordinates;
    const riverMiddle = [(r0[0] + r1[0]) / 2, (r0[1] + r1[1]) / 2];
    const [h0, h1] = (hill.geometry as GeoJSON.LineString).coordinates;
    const hillMiddle = [(h0[0] + h1[0]) / 2, (h0[1] + h1[1]) / 2];
    const blue = async () =>
      (await colorsAround(page, riverMiddle)).some(([r, , b]) => b > 180 && r < 120);
    const state = () =>
      page.evaluate(() => {
        const { draw } = window as unknown as E2EWindow;
        return {
          registered: draw.extensions.featureTypes.has('Route'),
          count: draw.features.count(),
          selected: [...draw.selection.get().ids],
        };
      });
    expect(await blue()).toBe(true);
    const clickHill = async () => {
      await page.evaluate(() => (window as unknown as E2EWindow).draw.selection.clear());
      await click(page, await pageOf(page, hillMiddle));
      return (await state()).selected;
    };

    // Without the type the routes stay in the data, but they are not drawn and a click passes
    // through them
    expect(await actionChecked(page, 'Route type')).toBe(true);
    await pressAction(page, 'Route type');
    expect(await state()).toMatchObject({ registered: false, count: 2 });
    expect(await actionChecked(page, 'Route type')).toBe(false);
    expect(await blue()).toBe(false);
    expect(await clickHill()).toEqual([]);
    // A selection box still takes one, by the fallback test of the library on its positions
    await page.evaluate(() => (window as unknown as E2EWindow).draw.selection.clear());
    const vertex = await pageOf(page, h0);
    await page.keyboard.down('Shift');
    await drag(
      page,
      { x: vertex.x - 20, y: vertex.y - 20 },
      { x: vertex.x + 20, y: vertex.y + 20 },
    );
    await page.keyboard.up('Shift');
    expect((await state()).selected).toEqual([hill.id]);

    // Registered again with the key, they come back as they were
    await press('u');
    expect(await actionChecked(page, 'Route type')).toBe(true);
    expect(await state()).toMatchObject({ registered: true, count: 2 });
    expect(await blue()).toBe(true);
    expect(await clickHill()).toEqual([hill.id]);
    await close();
  });

  it('custom-feature-types shows the handles of its definition and drags one', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('custom-feature-types');
    const hill = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      draw.selection.clear();
      return draw.features.list()[0];
    });
    const [first, second] = (hill.geometry as GeoJSON.LineString).coordinates;
    // The first vertex in the middle of the map, clear of the panels
    await page.evaluate(
      (center) =>
        (window as unknown as E2EWindow).map.jumpTo({ center: center as [number, number] }),
      first,
    );
    await settle(page);
    // Not selected: no handle, so nothing white where the first vertex is
    expect((await colorsAround(page, first)).some(isWhite)).toBe(false);

    await page.evaluate(
      (id) => (window as unknown as E2EWindow).draw.selection.set('feature', [id]),
      hill.id,
    );
    await settle(page);
    // Selected: the handle is drawn there with the look of a vertex handle
    expect((await colorsAround(page, first)).some(isWhite)).toBe(true);

    // The handle takes the drag, and the definition moves the vertex
    const from = await pageOf(page, first);
    await drag(page, from, { x: from.x - 40, y: from.y + 30 });
    const moved = await page.evaluate(
      (id) => (window as unknown as E2EWindow).draw.features.get(id)?.geometry,
      hill.id,
    );
    const [movedFirst, movedSecond] = (moved as GeoJSON.LineString).coordinates;
    expect(movedFirst[0]).toBeLessThan(first[0]);
    expect(movedFirst[1]).toBeLessThan(first[1]);
    expect(movedSecond).toEqual(second);
    await close();
  });

  it('custom-ui switches the mode with a button of its own toolbar', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('custom-ui');
    const button = page.locator('[data-mode="draw_polygon"]');
    await button.click();
    expect(await page.evaluate(() => (window as unknown as E2EWindow).draw.getMode())).toBe(
      'draw_polygon',
    );
    expect(await button.getAttribute('aria-pressed')).toBe('true');
    await close();
  });

  it('get-started has the basemap row of the standard UI with the five basemaps', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('get-started');
    // The one row of the last section of the layer panel; it opens the basemaps on the right
    await page
      .locator('[data-role="layer-panel"] [role="treeitem"][data-role="basemap"]')
      .getByRole('button')
      .click();
    // Opened only: an item of OpenFreeMap chosen would load its style from the network
    const chooser = page.locator('[data-region="right"] [data-role="basemap-panel"]');
    const items = chooser.locator('[data-role="list-item"]');
    expect((await items.allInnerTexts()).map((text) => text.trim())).toEqual([
      'OpenFreeMap Liberty',
      'OpenFreeMap Bright',
      'OpenFreeMap Positron',
      'OpenFreeMap Dark',
      'Blank',
    ]);
    // Each with its preview
    expect(
      await items.evaluateAll((list) =>
        list.map(
          (item) =>
            (item.querySelector('.preview') as HTMLElement).style.getPropertyValue('--preview') !==
            '',
        ),
      ),
    ).toEqual([true, true, true, true, true]);
    // The style of the address replaced the basemap, so none of them is current
    expect(await chooser.locator('[aria-current="true"]').count()).toBe(0);
    await page.keyboard.press('Escape');
    expect(await chooser.count()).toBe(0);
    await close();
  });

  it('zoom-and-scale keeps the reference zoom of each feature, and Z switches scaleWithZoom', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('zoom-and-scale');
    const state = () =>
      page.evaluate(() => {
        const w = window as unknown as E2EWindow & { layerIds: { scaled: string; fixed: string } };
        const zoomOf = (layerId: string) =>
          Object.fromEntries(
            w.draw.features
              .list({ layerId })
              .map((f) => [f.properties.name, f.properties['maplibre-gl-draw:createdZoom']]),
          );
        return {
          option: w.draw.options.get().scaleWithZoom,
          active: w.draw.layers.getActive()?.id === w.layerIds.fixed ? 'fixed' : 'scaled',
          names: w.draw.layers.list().map((layer) => layer.name),
          scaled: zoomOf(w.layerIds.scaled),
          fixed: zoomOf(w.layerIds.fixed),
        };
      });
    const before = await state();
    // The same three features in both layers, with a reference zoom in the first only, and the
    // one the page set from code
    expect(before.scaled).toEqual({
      'Wide line': 15,
      'Thick outline': 15,
      'Big point': 15,
      '2 px at zoom 13': 13,
    });
    expect(before.fixed).toEqual({
      'Wide line': undefined,
      'Thick outline': undefined,
      'Big point': undefined,
    });
    expect(before).toMatchObject({ option: true, active: 'scaled' });
    expect(before.names).toContain('→ Scaled with zoom');

    // Z turns the option off and makes the second layer the active one
    await page.keyboard.press('z');
    const after = await state();
    expect(after).toMatchObject({ option: false, active: 'fixed' });
    expect(after.names).toContain('→ Fixed on screen');

    // The tools then write no reference zoom: a line drawn goes into the second layer without one
    await page.getByRole('button', { name: 'Line', exact: true }).click();
    await click(page, at(-60, 160));
    await click(page, at(60, 180));
    await click(page, at(60, 180));
    const drawn = await state();
    expect(Object.keys(drawn.fixed)).toHaveLength(4);
    expect(Object.values(drawn.fixed)).toEqual([undefined, undefined, undefined, undefined]);

    // And Z turns it back on
    await page.keyboard.press('Escape');
    await page.keyboard.press('z');
    expect(await state()).toMatchObject({ option: true, active: 'scaled' });
    await close();
  });
  it('editing-shapes moves a shared vertex in both parcels, then in one after T', {
    timeout: TIMEOUT,
  }, async () => {
    const { page, close } = await openExample('editing-shapes');
    type Shared = { lower: number[]; upper: number[] };
    const shared = await page.evaluate(() => (window as unknown as { SHARED: Shared }).SHARED);
    const parcels = () =>
      page.evaluate(() => {
        const { draw } = window as unknown as E2EWindow;
        const ring = (name: string) => {
          const feature = draw.features.list().find((f) => f.properties.name === name);
          return (feature?.geometry as GeoJSON.Polygon | undefined)?.coordinates[0] ?? [];
        };
        return { west: ring('West parcel'), east: ring('East parcel') };
      });
    const has = (ring: number[][], position: number[]) =>
      ring.some(([lng, lat]) => lng === position[0] && lat === position[1]);
    const before = await parcels();
    expect(has(before.west, shared.upper) && has(before.east, shared.upper)).toBe(true);
    expect(
      await page.evaluate(() =>
        (window as unknown as E2EWindow).draw.selection.features().map((f) => f.properties.name),
      ),
    ).toEqual(['West parcel']);

    // The selected west parcel shows a handle at the upper end of the shared edge: dragged, the
    // vertex moves in both parcels, which keep one position there
    const upper = await pageOf(page, shared.upper);
    await drag(page, upper, { x: upper.x - 30, y: upper.y + 20 });
    const moved = await parcels();
    expect(has(moved.west, shared.upper) || has(moved.east, shared.upper)).toBe(false);
    const westOnly = moved.west.filter((p) => !has(before.west, p));
    expect(westOnly).toHaveLength(1);
    expect(has(moved.east, westOnly[0])).toBe(true);

    // T switches the shared vertices off: the lower end moves in the west parcel alone
    await page.keyboard.press('t');
    expect(
      await page.evaluate(
        () => (window as unknown as E2EWindow).draw.options.get().topology?.sharedVertexDrag,
      ),
    ).toBe(false);
    const lower = await pageOf(page, shared.lower);
    await drag(page, lower, { x: lower.x - 30, y: lower.y - 20 });
    const after = await parcels();
    expect(has(after.west, shared.lower)).toBe(false);
    expect(after.east).toEqual(moved.east);

    // A click on the area with a hole selects it; its geometry has the outer ring and the hole,
    // and the hole gets vertex handles of its own (their white fill)
    const courtyard = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      const feature = draw.features.list().find((f) => f.properties.name === 'Courtyard');
      const rings = (feature?.geometry as GeoJSON.Polygon | undefined)?.coordinates ?? [];
      return { id: feature?.id, rings };
    });
    const [outer, hole] = courtyard.rings;
    // Halfway between the west edges of the outer ring and of the hole
    await click(page, await pageOf(page, [(outer[0][0] + hole[0][0]) / 2, hole[0][1]]));
    expect(
      await page.evaluate(() => [...(window as unknown as E2EWindow).draw.selection.get().ids]),
    ).toEqual([courtyard.id]);
    expect(courtyard.rings).toHaveLength(2);
    expect((await colorsAround(page, hole[1])).some(isWhite)).toBe(true);
    await close();
  });
});
