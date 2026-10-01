// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end test of the playground: the page opens on the overview scene with the standard UI
 * and its added tools, `?plain` opens it empty, and neither throws an error
 *
 * The playground is built with its own vite configuration (in memory, the library from its
 * sources and the standard UI from ui/dist/) and served to headless Chromium from that build.
 * Nothing goes to the network: the basemap is replaced through the address of the page
 * (`?style=`, examples/basemap.ts) by an empty style served here.
 */

import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import { type E2EWindow, launchBrowser, settle } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const PLAYGROUND = join(here, '../../playground');
const ORIGIN = 'http://playground.e2e.test';
const EMPTY_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef0f2' } }],
};
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

let browser: Browser;
const files = new Map<string, string | Uint8Array>();

beforeAll(async () => {
  const [launched, result] = await Promise.all([
    launchBrowser(),
    build({
      root: PLAYGROUND,
      configFile: join(PLAYGROUND, 'vite.config.ts'),
      logLevel: 'silent',
      build: { write: false, minify: false },
    }),
  ]);
  browser = launched;
  for (const output of Array.isArray(result) ? result : [result]) {
    if (!('output' in output)) throw new Error('vite returned a watcher instead of a bundle');
    for (const file of output.output) {
      files.set(file.fileName, file.type === 'chunk' ? file.code : file.source);
    }
  }
}, browserTimeout(120_000));

afterAll(async () => {
  await browser?.close();
});

/** Opens the playground at the given query (after the replaced basemap) and waits for its map */
async function open(
  query = '',
): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1024, height: 720 } });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (path === 'e2e/style.json') return route.fulfill({ json: EMPTY_STYLE });
    const built = files.get(path);
    if (built === undefined) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({
      contentType: CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
      body: typeof built === 'string' ? built : Buffer.from(built),
    });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${ORIGIN}/?style=${encodeURIComponent(`${ORIGIN}/e2e/style.json`)}${query}`);
  await page.waitForFunction(
    () => (window as unknown as Partial<E2EWindow>).map?.isStyleLoaded() === true,
    undefined,
    { timeout: browserTimeout(30_000) },
  );
  await settle(page);
  return { page, context, errors };
}

describe('the playground', () => {
  it('opens on the overview by default: five layers, the dataset under them, the area with a hole selected and both rules in the Legend tab', {
    timeout: 60_000,
  }, async () => {
    const { page, context, errors } = await open();
    await page.waitForFunction(
      () => document.documentElement.dataset.showcase === 'ready',
      undefined,
      {
        timeout: browserTimeout(30_000),
      },
    );
    const drawing = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      const selected = draw.selection.get().ids.map((id) => draw.features.get(id));
      return {
        layers: draw.layers
          .list()
          .map((layer) => [layer.name, layer.opacity, layer.styleRule?.kind]),
        groups: draw.groups.list().map((group) => group.name),
        types: [...new Set(draw.features.list().map((feature) => feature.type))].sort(),
        active: draw.layers.getActive()?.name,
        selected: selected.map((feature) => [
          feature?.properties.name,
          feature?.geometry.type === 'Polygon' ? feature.geometry.coordinates.length : 0,
        ]),
        datasets: draw.datasets
          .list()
          .map((dataset) => [dataset.id, dataset.order, dataset.getStyleRule()?.kind]),
      };
    });
    expect(drawing).toEqual({
      layers: [
        ['Land use', 1, 'categorical'],
        ['Draft (50%)', 0.5, undefined],
        ['Zones', 1, undefined],
        ['Routes', 1, undefined],
        ['Notes', 1, undefined],
      ],
      groups: ['Fill opacity', 'Outlines', 'Coverage', 'Trails', 'Markers'],
      types: ['Circle', 'Freehand', 'Image', 'LineString', 'MultiPolygon', 'Point', 'Polygon'],
      active: 'Notes',
      // The area with a hole: its outer ring and the hole
      selected: [['Courtyard block', 2]],
      datasets: [['Density', 'below-store', 'graduated']],
    });

    await page.getByRole('button', { name: 'Stamp', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Route', exact: true }).waitFor();
    // The stack lists the layers from the front, and the dataset under them
    const rows = page.locator(
      '[data-role="layer-panel"] [data-container="root"] > [data-sortable-item]',
    );
    expect(
      await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-id'))),
    ).toEqual([
      'layer-notes',
      'layer-routes',
      'layer-zones',
      'layer-draft',
      'layer-landuse',
      'Density',
    ]);
    // The Legend tab lists the categorical rule of Land use and the graduated rule of Density
    await page.getByRole('button', { name: 'Legend', exact: true }).click();
    const lists = page.locator('[data-role="legend"] [role="list"]');
    await expect
      .poll(
        () => lists.evaluateAll((items) => items.map((item) => item.getAttribute('aria-label'))),
        { timeout: browserTimeout(5_000) },
      )
      .toEqual(['Land use', 'Density']);
    const entries = (name: string) =>
      page
        .locator(`[data-role="legend"] [role="list"][aria-label="${name}"] [data-role="list-item"]`)
        .allInnerTexts();
    expect((await entries('Land use')).map((text) => text.trim())).toEqual([
      'Residential',
      'Commercial',
      'Park',
      'Civic',
      'Other',
    ]);
    expect((await entries('Density')).map((text) => text.trim())).toEqual([
      'Below 20',
      '20 to below 40',
      '40 to below 60',
      '60 to below 80',
      '80 or more',
      'Other',
    ]);
    await context.close();
    expect(errors).toEqual([]);
  });

  it('?plain is empty', { timeout: 60_000 }, async () => {
    const { page, context, errors } = await open('&plain');
    const drawing = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      return {
        features: draw.features.count(),
        layers: draw.layers.list().length,
        showcase: document.documentElement.dataset.showcase ?? null,
      };
    });
    expect(drawing).toEqual({ features: 0, layers: 1, showcase: null });
    await page.getByRole('button', { name: 'Stamp', exact: true }).waitFor();
    await context.close();
    expect(errors).toEqual([]);
  });
});
