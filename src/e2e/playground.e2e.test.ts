// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end test of the playground: the page opens on the overview scene with the standard UI
 * and its added tools, `?plain` opens it empty, the switches in the card of actions work by a
 * press and by their keys, the buttons that move, turn and scale the selection lie clear of the
 * bar of the drawing tools and of the panels, and nothing throws an error
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

/**
 * Opens the playground at the given query (after the replaced basemap), in a page of the given
 * size, and waits for its map
 */
async function open(
  query = '',
  viewport = { width: 1024, height: 720 },
): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  const context = await browser.newContext({ viewport });
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
      const selected = draw.selection
        .get()
        .ids.toArray()
        .map((id) => draw.features.get(id));
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
      datasets: [['Density', 'belowLayers', 'graduated']],
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

  it('shows the buttons that move, turn and scale the selection whole, clear of the bar of the drawing tools and of the panels, on a page 900 and 1280 pixels wide', {
    timeout: 60_000,
  }, async () => {
    for (const width of [900, 1280]) {
      const { page, context, errors } = await open('&plain', { width, height: 757 });
      await page.getByRole('button', { name: 'Stamp', exact: true }).waitFor();
      /** The boxes of the buttons, of the bar and of the panels, and what a press in each button meets */
      const layout = () =>
        page.evaluate(() => {
          const box = (element: Element) => {
            const r = element.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
          };
          const buttons = Array.from(document.querySelectorAll('.pg-transforms button'));
          return {
            page: { width: window.innerWidth, height: window.innerHeight },
            buttons: buttons.map((button) => {
              const b = box(button);
              const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
              return { ...b, pressed: hit === button || button.contains(hit) };
            }),
            others: Array.from(
              document.querySelectorAll(
                '.mgd-ui [data-role="drawbar"], .mgd-ui [data-role="floating"]',
              ),
            )
              .map(box)
              .filter((b) => b.right > b.left && b.bottom > b.top),
          };
        });
      const check = async (when: string) => {
        const { page: size, buttons, others } = await layout();
        expect(buttons, `${width} ${when}`).toHaveLength(3);
        for (const b of buttons) {
          expect(b.pressed, `${width} ${when}`).toBe(true);
          expect(b.left >= 0 && b.top >= 0, `${width} ${when}`).toBe(true);
          expect(b.right <= size.width && b.bottom <= size.height, `${width} ${when}`).toBe(true);
          for (const o of others) {
            const meets =
              b.left < o.right && o.left < b.right && b.top < o.bottom && o.top < b.bottom;
            expect(meets, `${width} ${when}: ${JSON.stringify(b)} meets ${JSON.stringify(o)}`).toBe(
              false,
            );
          }
        }
        // The bar of the drawing tools is among the boxes compared
        expect(others.length, `${width} ${when}`).toBeGreaterThan(0);
      };
      await check('with nothing selected');
      // A feature selected opens the panel at the right
      await page.evaluate(() => {
        const { draw, map } = window as unknown as E2EWindow;
        const { lng, lat } = map.getCenter();
        const ring = [
          [lng, lat],
          [lng + 0.01, lat],
          [lng + 0.01, lat + 0.01],
          [lng, lat],
        ];
        const feature = draw.features.create({
          type: 'Polygon',
          geometry: { type: 'Polygon', coordinates: [ring] },
        });
        if (feature) draw.selection.set('feature', [feature.id]);
      });
      await settle(page);
      // The panel at the right is open: a floating panel in the right half, as tall as the page
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('.mgd-ui [data-role="floating"]')).some((panel) => {
            const r = panel.getBoundingClientRect();
            return r.left > window.innerWidth / 2 && r.height > window.innerHeight / 2;
          }),
        undefined,
        { timeout: browserTimeout(10_000) },
      );
      await check('with a feature selected');
      await context.close();
      expect(errors).toEqual([]);
    }
  });

  it('copies the selection and paints it with its buttons, which stand clear of the other buttons, of the bar of the drawing tools and of the panels', {
    timeout: 60_000,
  }, async () => {
    for (const width of [900, 1280]) {
      const { page, context, errors } = await open('&plain', { width, height: 757 });
      await page.getByRole('button', { name: 'Stamp', exact: true }).waitFor();
      const ids = await page.evaluate(() => {
        const { draw, map } = window as unknown as E2EWindow;
        const { lng, lat } = map.getCenter();
        const made: string[] = [];
        for (const dx of [0, 0.02]) {
          const ring = [
            [lng + dx, lat],
            [lng + dx + 0.01, lat],
            [lng + dx + 0.01, lat + 0.01],
            [lng + dx, lat],
          ];
          const feature = draw.features.create({
            type: 'Polygon',
            geometry: { type: 'Polygon', coordinates: [ring] },
          });
          if (feature) made.push(feature.id);
        }
        draw.selection.set('feature', made);
        return made;
      });
      await settle(page);
      const boxes = await page.evaluate(() => {
        const box = (element: Element) => {
          const r = element.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        };
        return {
          page: { width: window.innerWidth, height: window.innerHeight },
          buttons: Array.from(document.querySelectorAll('.pg-edits button')).map((button) => {
            const b = box(button);
            const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
            return { ...b, pressed: hit === button || button.contains(hit) };
          }),
          others: Array.from(
            document.querySelectorAll(
              '.pg-transforms button, .mgd-ui [data-role="drawbar"], .mgd-ui [data-role="floating"]',
            ),
          )
            .map(box)
            .filter((b) => b.right > b.left && b.bottom > b.top),
        };
      });
      expect(boxes.buttons, `${width}`).toHaveLength(2);
      for (const b of boxes.buttons) {
        expect(b.pressed, `${width}`).toBe(true);
        expect(b.left >= 0 && b.top >= 0, `${width}`).toBe(true);
        expect(b.right <= boxes.page.width && b.bottom <= boxes.page.height, `${width}`).toBe(true);
        for (const o of boxes.others) {
          const meets =
            b.left < o.right && o.left < b.right && b.top < o.bottom && o.top < b.bottom;
          expect(meets, `${width}: ${JSON.stringify(b)} meets ${JSON.stringify(o)}`).toBe(false);
        }
      }
      // The copies stand next to their originals, and the selection stays on the originals
      await page.locator('.pg-edits button[data-edit="duplicate"]').click();
      await page.waitForFunction(
        () => (window as unknown as E2EWindow).draw.features.count() === 4,
        undefined,
        { timeout: browserTimeout(10_000) },
      );
      const selected = await page.evaluate(() =>
        (window as unknown as E2EWindow).draw.selection.get().ids.toArray(),
      );
      expect(selected).toEqual(ids);
      // The same look on every feature selected
      await page.locator('.pg-edits button[data-edit="updateAll"]').click();
      await page.waitForFunction(
        (wanted) => {
          const { draw } = window as unknown as E2EWindow;
          return wanted.every((id) => draw.features.get(id)?.style.fillColor === '#f08c00');
        },
        ids,
        { timeout: browserTimeout(10_000) },
      );
      await context.close();
      expect(errors).toEqual([]);
    }
  });

  it('selects every feature of the layers with its button, and shows how many are selected', {
    timeout: 60_000,
  }, async () => {
    const { page, context, errors } = await open('&plain');
    await page.getByRole('button', { name: 'Stamp', exact: true }).waitFor();
    const made = await page.evaluate(() => {
      const { draw, map } = window as unknown as E2EWindow;
      const { lng, lat } = map.getCenter();
      const first = draw.layers.getActive()?.id;
      const second = draw.layers.create({ name: 'second' });
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const feature = draw.features.create({
          type: 'Point',
          geometry: { type: 'Point', coordinates: [lng + i * 0.001, lat] },
          layerId: i >= 4 && second ? second.id : first,
        });
        if (feature) ids.push(feature.id);
      }
      // Two of them in a group, whose features are selected with those of their layer
      draw.groups.create({ name: 'pair', featureIds: ids.slice(0, 2) });
      draw.selection.clear();
      return ids.length;
    });
    await settle(page);
    const count = page.locator('.pg-select output[data-select="count"]');
    expect(await count.textContent()).toBe('0 selected');
    await page.locator('.pg-select button[data-select="layers"]').click();
    await page.waitForFunction(
      (wanted) => (window as unknown as E2EWindow).draw.selection.get().ids.count() === wanted,
      made,
      { timeout: browserTimeout(10_000) },
    );
    expect(await count.textContent()).toBe(`${made} selected`);
    await context.close();
    expect(errors).toEqual([]);
  });

  it('has its switches in the card of actions, which a press and Shift with a letter run, and which show changes made by code', {
    timeout: 60_000,
  }, async () => {
    const { page, context, errors } = await open('&plain');
    const card = page.locator('.mgd-ui [data-role="actions"]');
    const checked = (label: string) =>
      card.getByRole('switch', { name: label, exact: true }).isChecked();
    const state = () =>
      page.evaluate(() => {
        const { draw } = window as unknown as E2EWindow;
        return { readOnly: draw.isReadOnly(), locked: draw.isInteractionLocked() };
      });
    expect(
      await card.locator('[data-action]').evaluateAll((rows) => rows.map((r) => r.dataset.action)),
    ).toEqual(['terrain', 'cells', 'read-only', 'interaction-lock', 'big', 'save', 'open']);

    // A press on the switch
    await card.getByText('Read-only', { exact: true }).click();
    await settle(page);
    expect(await state()).toEqual({ readOnly: true, locked: false });
    expect(await checked('Read-only')).toBe(true);

    // Shift with its letter
    await page.mouse.move(600, 300);
    await page.keyboard.press('Shift+K');
    await settle(page);
    expect(await state()).toEqual({ readOnly: true, locked: true });
    expect(await checked('Interaction lock')).toBe(true);

    // A change made by code shows too
    await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      draw.setReadOnly(false);
      draw.setInteractionLocked(false);
    });
    await settle(page);
    expect(await checked('Read-only')).toBe(false);
    expect(await checked('Interaction lock')).toBe(false);

    // The dataset of 10,000 cells comes and goes
    await card.getByText('10,000 cells', { exact: true }).click();
    await settle(page);
    expect(
      await page.evaluate(() => !!(window as unknown as E2EWindow).draw.datasets.get('cells')),
    ).toBe(true);
    expect(await checked('10,000 cells')).toBe(true);
    await context.close();
    expect(errors).toEqual([]);
  });
});
