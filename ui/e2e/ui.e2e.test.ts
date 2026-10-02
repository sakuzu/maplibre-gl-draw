// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of `createDrawUI` on a real map
 *
 * Each test opens the page of the harness (a point, a line and a polygon, the interface in the
 * dark theme) and does one thing the way the user would, with the real pointer and keyboard of
 * the browser, then reads the result from the draw instance: the interface keeps nothing of the
 * drawing, so what it did is what core holds.
 */

import type { Browser, Locator, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  buildPage,
  type E2EWindow,
  launchBrowser,
  openPage,
  pageOf,
  type Site,
  settle,
} from './harness.js';
import { browserTimeout } from './timeout.js';

let browser: Browser;
let site: Site;
let page: Page;

beforeAll(async () => {
  [browser, site] = await Promise.all([launchBrowser(), buildPage()]);
}, browserTimeout(120_000));

afterAll(async () => {
  await browser?.close();
});

afterEach(async () => {
  await page?.close();
});

/** The IDs of the features the page starts with */
function ids(): Promise<E2EWindow['ids']> {
  return page.evaluate(() => (window as unknown as E2EWindow).ids);
}

/** The current mode of the draw instance */
function mode(): Promise<string> {
  return page.evaluate(() => (window as unknown as E2EWindow).draw.getMode());
}

/** Polls a value of the page until it equals the expected one */
async function until<T>(read: () => Promise<T>, expected: T): Promise<void> {
  await expect.poll(read, { timeout: browserTimeout(5_000) }).toEqual(expected);
}

/** The center of an element on the page */
async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('the element is not on the page');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

describe('the toolbar', () => {
  it('picks a tool by a press and by its key, and Escape on the map returns to select', async () => {
    page = await openPage(browser, site);
    const bar = page.locator('[data-role="drawbar"]');

    await bar.getByRole('button', { name: 'Polygon', exact: true }).click();
    expect(await mode()).toBe('draw_polygon');

    await page.keyboard.press('l');
    expect(await mode()).toBe('draw_line');

    // The first vertex of a line, on an empty part of the map, gives the canvas the focus
    const empty = await pageOf(page, [139.79, 35.665]);
    await page.mouse.click(empty.x, empty.y);
    await settle(page);
    // Escape drops the line being drawn, then leaves the tool
    await page.keyboard.press('Escape');
    await settle(page);
    expect(await mode()).toBe('draw_line');
    await page.keyboard.press('Escape');
    await settle(page);
    expect(await mode()).toBe('select');
    expect(await page.evaluate(() => (window as unknown as E2EWindow).draw.features.count())).toBe(
      3,
    );
  });
});

describe('the snapping settings', () => {
  it('open from the magnet above the toolbar, switch snapping, and close', async () => {
    page = await openPage(browser, site);
    const bar = page.locator('[data-role="drawbar"]');
    const magnet = bar.getByRole('button', { name: 'Snapping', exact: true });
    const settings = page.locator('[data-role="snapping"] [data-role="popover"]');
    const enabled = () =>
      page.evaluate(
        () => (window as unknown as E2EWindow).draw.options.get().snapping?.enabled !== false,
      );
    expect(await enabled()).toBe(true);
    expect(await magnet.getAttribute('aria-pressed')).toBe('true');

    await magnet.click();
    await settings.waitFor();
    const popoverBox = await settings.boundingBox();
    const barBox = await bar.boundingBox();
    if (!popoverBox || !barBox) throw new Error('the settings or the bar are not on the page');
    expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(barBox.y);

    // The overlay gives the pointer to the popover: the press reaches the switch
    await settings.getByRole('switch', { name: 'Snapping', exact: true }).click();
    await until(enabled, false);
    expect(await magnet.getAttribute('aria-pressed')).toBe('false');
    expect(await settings.getByRole('switch', { name: 'Vertices', exact: true }).isDisabled()).toBe(
      true,
    );

    // A second press on the magnet closes it, and Escape too
    const at = await centerOf(magnet);
    await page.mouse.click(at.x, at.y);
    await expect.poll(() => settings.count()).toBe(0);
    await page.mouse.click(at.x, at.y);
    await settings.waitFor();
    await page.keyboard.press('Escape');
    await expect.poll(() => settings.count()).toBe(0);
    expect(await enabled()).toBe(false);
  });
});

describe('the inspector', () => {
  it('follows the selection and writes the fill color, the name and an attribute', async () => {
    page = await openPage(browser, site);
    const { polygon } = await ids();
    const inspector = page.locator('[data-role="inspector"]');
    await expect.poll(() => inspector.count()).toBe(0);

    await page.evaluate((id) => {
      (window as unknown as E2EWindow).draw.selection.set('feature', [id]);
    }, polygon);
    await inspector.getByRole('button', { name: 'Name', exact: true }).waitFor();
    expect(await inspector.getByRole('button', { name: 'Name', exact: true }).innerText()).toBe(
      'Block',
    );

    // The color field opens kata's ColorPicker; its code input commits a hex on change
    await inspector.getByRole('button', { name: 'Fill color' }).click();
    const code = page.getByRole('textbox', { name: 'Color code' });
    await code.fill('#1a2b3c');
    await code.press('Enter');
    const fill = () =>
      page.evaluate(
        (id) => (window as unknown as E2EWindow).draw.features.get(id)?.style?.fillColor,
        polygon,
      );
    await until(fill, '#1A2B3C');
    await code.press('Escape');

    // The name, changed where it stands
    await inspector.getByRole('button', { name: 'Name', exact: true }).click();
    const name = inspector.getByRole('textbox', { name: 'Name' });
    await name.fill('Market');
    await name.press('Enter');
    await until(
      () =>
        page.evaluate(
          (id) => (window as unknown as E2EWindow).draw.features.get(id)?.properties.name,
          polygon,
        ),
      'Market',
    );

    // An attribute added in the Attributes tab
    await inspector.getByRole('button', { name: 'Attributes', exact: true }).click();
    await inspector.getByRole('button', { name: 'Add an attribute' }).click();
    await page.keyboard.type('height');
    await page.keyboard.press('Tab');
    await page.keyboard.type('12');
    await page.keyboard.press('Enter');
    await until(
      () =>
        page.evaluate(
          (id) => (window as unknown as E2EWindow).draw.features.get(id)?.properties.height,
          polygon,
        ),
      '12',
    );
  });
});

describe('the inspector of a point', () => {
  it('starts the fields of the Style tab pad-md under the line of the tabs, with no title', async () => {
    page = await openPage(browser, site);
    const { point } = await ids();
    await page.evaluate((id) => {
      (window as unknown as E2EWindow).draw.selection.set('feature', [id]);
    }, point);
    const inspector = page.locator('[data-role="inspector"]');
    await inspector.locator('[data-role="tabs"]').waitFor();
    await settle(page);
    const measured = await inspector.evaluate((el) => {
      const tabs = el.querySelector('[data-role="tabs"]');
      const color = el.querySelector('[aria-label="Color"]');
      if (!tabs?.parentElement || !color) throw new Error('no tabs or no color field');
      // The step of the token, in the font of the content the tabs are in
      const probe = document.createElement('div');
      probe.style.height = 'var(--kata-pad-md)';
      tabs.parentElement.append(probe);
      const step = probe.getBoundingClientRect().height;
      probe.remove();
      return {
        // From the line along the bottom of the tabs to the outline of the first field
        gap: color.getBoundingClientRect().top - tabs.getBoundingClientRect().bottom,
        step,
        headings: [...el.querySelectorAll('[data-role="section-head"]')].map((h) =>
          h.textContent?.trim(),
        ),
      };
    });
    expect(measured.step).toBeGreaterThan(0);
    expect(measured.gap).toBeCloseTo(measured.step, 1);
    expect(measured.headings).toEqual(['Operations']);
  });
});

describe('the layer panel', () => {
  it('lists the layer and its features, hides a feature and reorders by dragging', async () => {
    page = await openPage(browser, site);
    const { point, line, polygon } = await ids();
    const panel = page.locator('[data-role="layer-panel"]');
    const layer = await page.evaluate(() => {
      const w = window as unknown as E2EWindow;
      return w.draw.layers.get(w.layerId);
    });
    if (!layer) throw new Error('the layer is missing');

    // The layer, then its features from the front (the rows of the stack: not the basemap)
    const rows = panel.locator('[role="treeitem"][data-node]');
    await until(
      () => rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-node'))),
      [layer.id, polygon, line, point],
    );
    expect(await rows.locator('[data-role="list-item"]').allInnerTexts()).toEqual([
      layer.name,
      'Block',
      'Walk',
      'Station',
    ]);

    // The eye of the line, which shows while the row is hovered
    const lineRow = panel.locator(`[role="treeitem"][data-node="${line}"]`);
    await lineRow.hover();
    await lineRow.getByRole('button', { name: 'Hide', exact: true }).click();
    await until(
      () =>
        page.evaluate(
          (id) => (window as unknown as E2EWindow).draw.features.get(id)?.visible,
          line,
        ),
      false,
    );

    // The point (at the back) dragged by its grip above the polygon (at the front)
    const items = () =>
      page.evaluate(() => {
        const w = window as unknown as E2EWindow;
        return [...(w.draw.layers.get(w.layerId)?.items ?? [])];
      });
    expect(await items()).toEqual([point, line, polygon]);
    const pointRow = panel.locator(`[role="treeitem"][data-node="${point}"]`);
    const polygonRow = panel.locator(`[role="treeitem"][data-node="${polygon}"]`);
    await pointRow.hover();
    const grip = await centerOf(pointRow.locator('[data-grip]'));
    const target = await polygonRow.boundingBox();
    if (!target) throw new Error('the row of the polygon is not on the page');
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    // Past the tolerance of SortableJS (10 px), then over the top of the polygon's row
    await page.mouse.move(grip.x, grip.y - 15, { steps: 4 });
    await page.mouse.move(grip.x, target.y + 3, { steps: 12 });
    await page.waitForTimeout(200);
    await page.mouse.move(grip.x, target.y + 2, { steps: 2 });
    await page.mouse.up();
    await until(items, [line, polygon, point]);
  });

  it('drags a dataset added with the default order among the layers', async () => {
    page = await openPage(browser, site);
    const panel = page.locator('[data-role="layer-panel"]');
    // Two datasets behind every layer (below-store, the default of datasets.add); the later one
    // in front
    const layerId = await page.evaluate(() => {
      const w = window as unknown as E2EWindow;
      w.draw.datasets.add({ id: 'roads', rows: [] });
      w.draw.datasets.add({ id: 'parcels', rows: [] });
      return w.layerId;
    });
    const roots = panel.locator('[role="treeitem"][aria-level="1"][data-node]');
    await until(
      () => roots.evaluateAll((els) => els.map((el) => el.getAttribute('data-node'))),
      [layerId, 'parcels', 'roads'],
    );
    // The layer folded, so that its row is one line to drop above
    const layerRow = panel.locator(`[role="treeitem"][data-node="${layerId}"]`);
    await layerRow.getByRole('button', { name: 'Collapse', exact: true }).click();

    // The dataset at the back dragged by its grip above the layer
    const roadsRow = panel.locator('[role="treeitem"][data-node="roads"]');
    await roadsRow.hover();
    const grip = await centerOf(roadsRow.locator('[data-grip]'));
    const target = await layerRow.boundingBox();
    if (!target) throw new Error('the row of the layer is not on the page');
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    // Past the tolerance of SortableJS (10 px), then over the top of the layer's row
    await page.mouse.move(grip.x, grip.y - 15, { steps: 4 });
    await page.mouse.move(grip.x, target.y + 3, { steps: 12 });
    await page.waitForTimeout(200);
    await page.mouse.move(grip.x, target.y + 2, { steps: 2 });
    await page.mouse.up();

    // It joined the stacking order in front of the layer; the other stays behind every layer
    const placed = () =>
      page.evaluate(() => {
        const w = window as unknown as E2EWindow;
        return {
          order: w.draw.layers.getOrder(),
          roads: w.draw.datasets.get('roads')?.order,
          parcels: w.draw.datasets.get('parcels')?.order,
        };
      });
    await until(placed, {
      order: [layerId, 'roads'],
      roads: 'layer-order',
      parcels: 'below-store',
    });
    await until(
      () => roots.evaluateAll((els) => els.map((el) => el.getAttribute('data-node'))),
      ['roads', layerId, 'parcels'],
    );
  });
});

describe('operations', () => {
  it('unites two selected polygons from the selection panel', async () => {
    page = await openPage(browser, site);
    const { polygon } = await ids();
    const other = await page.evaluate(() => {
      const draw = (window as unknown as E2EWindow).draw;
      return draw.features.create({
        type: 'Polygon',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [139.778, 35.676],
              [139.788, 35.676],
              [139.788, 35.684],
              [139.778, 35.684],
              [139.778, 35.676],
            ],
          ],
        },
        properties: { name: 'Annex' },
      })?.id;
    });
    if (!other) throw new Error('the second polygon was not created');
    await page.evaluate(
      (pair) => (window as unknown as E2EWindow).draw.selection.set('feature', pair),
      [polygon, other],
    );
    const count = () => page.evaluate(() => (window as unknown as E2EWindow).draw.features.count());
    expect(await count()).toBe(4);

    await page
      .locator('[data-role="inspector"]')
      .getByRole('button', { name: 'Union', exact: true })
      .click();
    await until(count, 3);
    const made = await page.evaluate(() => {
      const draw = (window as unknown as E2EWindow).draw;
      const [id] = draw.selection.get().ids;
      return id ? draw.features.get(id)?.type : undefined;
    });
    expect(['Polygon', 'MultiPolygon']).toContain(made);
  });
});

describe('the overlay', () => {
  it('lets a click outside the panels reach the map', async () => {
    page = await openPage(browser, site);
    await page.evaluate(() => {
      const w = window as unknown as E2EWindow & { clicks: number };
      w.clicks = 0;
      w.draw.on('map.clicked', () => {
        w.clicks += 1;
      });
    });
    expect(await mode()).toBe('select');
    expect(
      await page.evaluate(() => (window as unknown as E2EWindow).draw.selection.get().ids.length),
    ).toBe(0);

    // The middle of the map, right of the layer panel and above the toolbar, away from features
    const spot = await pageOf(page, [139.79, 35.665]);
    await page.mouse.click(spot.x, spot.y);
    await until(() => page.evaluate(() => (window as unknown as { clicks: number }).clicks), 1);
  });
});

describe('the basemap row', () => {
  it('opens the basemaps on the right, and the drawing comes back on top of the one chosen', async () => {
    page = await openPage(browser, site);
    // The interface again, with two basemaps: style objects, so nothing goes to the network
    await page.evaluate(() => {
      const w = window as unknown as E2EWindow & {
        e2e: { createDrawUI: typeof import('../src/index.ts').createDrawUI };
      };
      const style = (id: string, color: string) => ({
        version: 8 as const,
        sources: {},
        layers: [{ id, type: 'background' as const, paint: { 'background-color': color } }],
      });
      w.ui.destroy();
      w.ui = w.e2e.createDrawUI(w.draw, {
        theme: 'dark',
        basemaps: [
          { id: 'paper', label: 'Paper', style: style('paper-background', '#f4f1e8') },
          { id: 'night', label: 'Night', style: style('night-background', '#101820') },
        ],
        basemap: 'paper',
      });
    });
    const layers = () => page.evaluate(() => (window as unknown as E2EWindow).map.getLayersOrder());
    const drawLayers = await page.evaluate(() =>
      (window as unknown as E2EWindow).map
        .getLayersOrder()
        .filter((id) => id.startsWith('maplibre-gl-draw')),
    );
    expect(drawLayers.length).toBeGreaterThan(0);

    // The one row of the last section of the layer panel, named by the current basemap
    const row = page.locator('[data-role="layer-panel"] [role="treeitem"][data-role="basemap"]');
    expect((await row.innerText()).replace(/\s+/g, ' ').trim()).toBe('Paper');
    expect(
      await row.evaluate((el) => el.closest('[role="tree"]')?.getAttribute('aria-label')),
    ).toBe('Basemap');
    await row.getByRole('button').click();
    // On the right, in the place of the inspector
    const chooser = page.locator('[data-region="right"] [data-role="basemap-panel"]');
    await chooser.getByRole('button', { name: 'Night' }).click();
    // The new background, under the layers of the draw instance
    await until(layers, ['night-background', ...drawLayers]);
    expect(await page.evaluate(() => (window as unknown as E2EWindow).ui.getBasemap()?.id)).toBe(
      'night',
    );
    expect((await row.innerText()).replace(/\s+/g, ' ').trim()).toBe('Night');
    // It stays open, the current one marked, until Escape closes it
    expect(await chooser.locator('[aria-current="true"]').getAttribute('data-id')).toBe('night');
    await page.keyboard.press('Escape');
    expect(await chooser.count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as E2EWindow).draw.features.count())).toBe(
      3,
    );
  });
});

describe('the actions', () => {
  /** The boxes of the card, the scale, the toolbar and the map, on the page */
  function boxes() {
    return page.evaluate(() => {
      const w = window as unknown as E2EWindow;
      const box = (el: Element | null | undefined) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      const root = w.ui.element;
      return {
        map: box(w.map.getContainer()),
        card: box(root.querySelector('[data-role="actions"] [data-role="floating"]')),
        scale: box(w.map.getContainer().querySelector('.maplibregl-ctrl-scale')),
        bar: box(root.querySelector('[data-region="bottom"] [data-role="drawbar"]')),
      };
    });
  }

  it('show at the bottom left above the scale, run by a press and by a key, and fold on a narrow map', async () => {
    page = await openPage(browser, site);
    await page.evaluate(() => {
      const w = window as unknown as E2EWindow & { on: boolean; saved: number };
      w.on = false;
      w.saved = 0;
      w.ui.actions.add({
        id: 'switch',
        label: 'Read-only',
        kind: 'toggle',
        shortcut: 'R',
        run: () => {
          w.on = !w.on;
        },
        checked: () => w.on,
      });
      w.ui.actions.add({
        id: 'save',
        label: 'Save',
        kind: 'action',
        shortcut: 'S',
        run: () => {
          w.saved += 1;
        },
      });
    });
    await settle(page);
    const card = page.locator('.mgd-ui [data-role="actions"]');
    const wide = await boxes();
    if (!wide.card || !wide.scale || !wide.bar || !wide.map) throw new Error('missing boxes');
    // Above the scale, apart from it, and clear of the toolbar
    expect(wide.card.bottom).toBeLessThan(wide.scale.top);
    expect(wide.card.right).toBeLessThan(wide.bar.left);
    expect(wide.card.left - wide.map.left).toBeGreaterThan(0);

    // A press on the switch's text, and the key
    await card.getByText('Read-only').click();
    await until(() => page.evaluate(() => (window as unknown as { on: boolean }).on), true);
    expect(await card.locator('input[role="switch"]').isChecked()).toBe(true);
    await card.getByRole('button', { name: /Save/ }).click();
    await page.mouse.move(640, 300);
    await page.keyboard.press('s');
    await until(() => page.evaluate(() => (window as unknown as { saved: number }).saved), 2);
    await page.keyboard.press('r');
    await until(() => page.evaluate(() => (window as unknown as { on: boolean }).on), false);
    expect(await card.locator('input[role="switch"]').isChecked()).toBe(false);

    // Narrow: folded into one button, which opens the card clear of the toolbar
    await page.setViewportSize({ width: 700, height: 800 });
    await settle(page);
    // The layer panel opens as a sheet over the bottom; Escape closes it
    await page.keyboard.press('Escape');
    await settle(page);
    await expect.poll(() => card.locator('input[role="switch"]').count()).toBe(0);
    await card.getByRole('button', { name: 'Actions' }).click();
    await settle(page);
    const narrow = await boxes();
    if (!narrow.card || !narrow.bar || !narrow.scale) throw new Error('missing boxes');
    const across = narrow.card.right > narrow.bar.left && narrow.card.left < narrow.bar.right;
    if (across) expect(narrow.card.bottom).toBeLessThanOrEqual(narrow.bar.top);
    expect(narrow.card.bottom).toBeLessThan(narrow.scale.top);
    await card.getByText('Read-only').click();
    await until(() => page.evaluate(() => (window as unknown as { on: boolean }).on), true);
  });
});
