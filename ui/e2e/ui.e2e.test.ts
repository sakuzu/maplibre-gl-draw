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
  launchWebKit,
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
  it('keeps the tabs in the head, and starts the description pad-md under their line, then the fields with no title', async () => {
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
      const body = el.querySelector('[data-role="panel"] > .scroll');
      const content = body?.firstElementChild;
      const description = content?.firstElementChild;
      const color = el.querySelector('[aria-label="Color"]');
      if (!tabs?.parentElement || !body || !description || !color) {
        throw new Error('no tabs, no content or no color field');
      }
      const row = description.querySelector('[data-role="pair"]') ?? description.firstElementChild;
      if (!row) throw new Error('no description');
      // The step of the token, in the font of the content
      const probe = document.createElement('div');
      probe.style.height = 'var(--kata-pad-md)';
      body.append(probe);
      const step = probe.getBoundingClientRect().height;
      probe.remove();
      return {
        tabsInBody: body.contains(tabs),
        // From the line along the bottom of the head (the tabs) to the row of the description
        gap: row.getBoundingClientRect().top - body.getBoundingClientRect().top,
        description: description.textContent ?? '',
        colorAfter: !description.contains(color) && content?.children[1]?.contains(color),
        step,
        headings: [...el.querySelectorAll('[data-role="section-head"]')].map((h) =>
          h.textContent?.trim(),
        ),
      };
    });
    expect(measured.tabsInBody).toBe(false);
    expect(measured.description).toContain('Description');
    expect(measured.colorAfter).toBe(true);
    expect(measured.step).toBeGreaterThan(0);
    expect(measured.gap).toBeCloseTo(measured.step, 1);
    expect(measured.headings).toEqual(['Operations']);
  });

  it('takes the width of the sheet on a narrow map', async () => {
    page = await openPage(browser, site);
    await page.setViewportSize({ width: 390, height: 667 });
    const { point } = await ids();
    await page.evaluate((id) => {
      (window as unknown as E2EWindow).draw.selection.set('feature', [id]);
    }, point);
    const inspector = page.locator('[data-role="inspector"]');
    await inspector.locator('[data-role="tabs"]').waitFor();
    await settle(page);
    const widths = await inspector.evaluate((el) => ({
      sheet: el.closest('[data-region="right"]')?.getBoundingClientRect().width ?? 0,
      panel: el.querySelector('[data-role="panel"]')?.getBoundingClientRect().width ?? 0,
      sheeted: el.hasAttribute('data-sheet'),
    }));
    expect(widths.sheeted).toBe(true);
    expect(widths.sheet).toBeGreaterThan(380);
    expect(widths.panel).toBeCloseTo(widths.sheet, 0);
  });

  it('fits the half sheet on a narrow map: its content scrolls and its foot is in view', async () => {
    page = await openPage(browser, site);
    await page.setViewportSize({ width: 390, height: 667 });
    const { point } = await ids();
    await page.evaluate((id) => {
      (window as unknown as E2EWindow).draw.selection.set('feature', [id]);
    }, point);
    const inspector = page.locator('[data-role="inspector"]');
    await inspector.locator('[data-role="tabs"]').waitFor();
    await settle(page);
    const measured = await inspector.evaluate((el) => {
      const scroll = el.querySelector('[data-role="panel"] > .scroll');
      const remove = [...el.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Delete',
      );
      if (!scroll || !remove) throw new Error('no scrolling content or no Delete');
      const box = remove.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        stage: el.closest('[data-stage]')?.getAttribute('data-stage'),
        scrollHeight: scroll.scrollHeight,
        clientHeight: scroll.clientHeight,
        top: box.top,
        bottom: box.bottom,
        reached: !!hit && remove.contains(hit),
      };
    });
    expect(measured.stage).toBe('half');
    expect(measured.scrollHeight).toBeGreaterThan(measured.clientHeight);
    expect(measured.top).toBeGreaterThanOrEqual(0);
    expect(measured.bottom).toBeLessThanOrEqual(667);
    expect(measured.reached).toBe(true);
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

    // Delete is in the lead of the foot, as for one feature; the operations are in the content
    const inspector = page.locator('[data-role="inspector"]');
    const foot = inspector.locator('[data-role="panel"] > [data-role="footer"]');
    await expect
      .poll(() => foot.getByRole('button', { name: 'Delete', exact: true }).count())
      .toBe(1);
    expect(await foot.getByRole('button', { name: 'Union', exact: true }).count()).toBe(0);
    const lead = await foot.evaluate((el) => {
      const remove = [...el.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Delete',
      );
      const box = el.getBoundingClientRect();
      return remove ? remove.getBoundingClientRect().left - box.left : -1;
    });
    // At the start of the foot, inside its padding
    expect(lead).toBeGreaterThan(0);
    expect(lead).toBeLessThan(40);

    await inspector.getByRole('button', { name: 'Union', exact: true }).click();
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
  /** The boxes of the card, the scale, the attribution, the toolbar and the map, on the page */
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
        attrib: box(w.map.getContainer().querySelector('.maplibregl-ctrl-attrib')),
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

  it('stand above the scale and a two-line attribution on a narrow map, and fit the map open', async () => {
    page = await openPage(browser, site);
    await page.setViewportSize({ width: 390, height: 667 });
    // A credit long enough to wrap: a source drawn by a layer, and many actions
    await page.evaluate(() => {
      const w = window as unknown as E2EWindow;
      w.map.addSource('credit', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        attribution: 'The survey of the city, the data of the transport authority and the walks',
      });
      w.map.addLayer({ id: 'credit', type: 'circle', source: 'credit' });
      for (let i = 0; i < 16; i++) {
        w.ui.actions.add({ id: `run-${i}`, label: `Action ${i}`, kind: 'action', run: () => {} });
      }
    });
    await expect
      .poll(() => page.locator('.maplibregl-ctrl-attrib').innerText())
      .toContain('transport authority');
    // The layer panel opens as a sheet over the bottom; Escape closes it
    await page.keyboard.press('Escape');
    await settle(page);
    const card = page.locator('.mgd-ui [data-role="actions"]');
    await card.getByRole('button', { name: 'Actions' }).click();
    await settle(page);

    await expect
      .poll(async () => {
        const b = await boxes();
        const attrib = b.attrib;
        if (!b.card || !b.scale || !attrib || !b.map) return 'missing boxes';
        const attribAcross = (r: { left: number; right: number }) =>
          r.left < attrib.right && attrib.left < r.right;
        // The attribution two lines high, across the scale and the card
        if (attrib.bottom - attrib.top < 30) return 'one line';
        if (!attribAcross(b.scale) || !attribAcross(b.card)) return 'not across';
        // The scale above the attribution, the card above both, and the card inside the map
        if (b.scale.bottom > attrib.top + 1) return 'scale under the attribution';
        if (b.card.bottom > attrib.top || b.card.bottom > b.scale.top) return 'card too low';
        if (b.card.top < b.map.top) return 'card past the top';
        return 'ok';
      })
      .toBe('ok');
    // The rows that do not fit scroll inside the card
    const scrolls = await card
      .locator('.card')
      .evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY);
    expect(scrolls).toBe('auto');
  });
});

describe("maplibre-gl's controls and the padding of the map", () => {
  it('keep the controls of the bottom right clear of the inspector, and pad the map at the left', async () => {
    page = await openPage(browser, site);
    const { polygon } = await ids();
    /** The boxes of the controls of the bottom right, the attribution and the right pane */
    const read = () =>
      page.evaluate(() => {
        const w = window as unknown as E2EWindow;
        const box = (el: Element | null | undefined) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        };
        const corner = w.map
          .getContainer()
          .querySelector('.maplibregl-ctrl-bottom-right') as HTMLElement;
        return {
          zoom: box(corner.querySelector('.maplibregl-ctrl-zoom-in')?.parentElement),
          attrib: box(corner.querySelector('.maplibregl-ctrl-attrib')),
          pane: box(w.ui.element.querySelector('[data-role="shell"] [data-region="right"]')),
          padding: w.map.getPadding(),
        };
      });
    const before = await read();
    if (!before.zoom || !before.attrib) throw new Error('missing boxes');
    // The left panel floats over the map: its room is the padding at the left, none at the right
    expect(before.padding.left).toBeGreaterThan(0);
    expect(before.padding.right).toBe(0);

    await page.evaluate(
      (id) => (window as unknown as E2EWindow).draw.selection.set('feature', [id]),
      polygon,
    );
    await expect
      .poll(async () => {
        const now = await read();
        if (!now.zoom || !now.pane || !now.attrib) return 'missing boxes';
        return now.zoom.right < now.pane.left ? 'clear' : 'under the pane';
      })
      .toBe('clear');
    const open = await read();
    // The attribution stays at the corner, and the padding does not change with the selection
    expect(open.attrib?.right).toBeCloseTo(before.attrib.right, 0);
    expect(open.padding).toEqual(before.padding);

    await page.evaluate(() => (window as unknown as E2EWindow).draw.selection.clear());
    await expect.poll(async () => (await read()).zoom?.right).toBeCloseTo(before.zoom.right, 0);
  });
});

describe("the look of maplibre-gl's controls", () => {
  it('follows the theme of the interface', async () => {
    page = await openPage(browser, site);
    /** The background of a group of buttons, and the panel color of the interface */
    const colors = () =>
      page.evaluate(() => {
        const w = window as unknown as E2EWindow;
        const group = w.map.getContainer().querySelector('.maplibregl-ctrl-group');
        const icon = w.map.getContainer().querySelector('.maplibregl-ctrl-icon');
        const probe = document.createElement('div');
        probe.style.background = 'var(--kata-color-panel)';
        w.ui.element.append(probe);
        const panel = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
          group: group ? getComputedStyle(group).backgroundColor : '',
          icon: icon ? getComputedStyle(icon).filter : '',
          panel,
        };
      });
    // Dark, the theme of the page
    const dark = await colors();
    expect(dark.group).toBe(dark.panel);
    expect(dark.group).not.toBe('rgb(255, 255, 255)');
    expect(dark.icon).toBe('invert(1)');
    await page.evaluate(() => (window as unknown as E2EWindow).ui.setTheme('light'));
    const light = await colors();
    expect(light.group).toBe(light.panel);
    expect(light.group).not.toBe(dark.group);
    expect(light.icon).toBe('none');
  });
});

describe('WebKit on a narrow map', () => {
  let webkit: Browser | null = null;

  beforeAll(async () => {
    webkit = await launchWebKit();
  }, browserTimeout(120_000));

  afterAll(async () => {
    await webkit?.close();
  });

  it('measures the interface without a ResizeObserver loop', async (ctx) => {
    if (!webkit) {
      ctx.skip();
      return;
    }
    page = await openPage(webkit, site, { width: 390, height: 667 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.text().includes('ResizeObserver')) errors.push(message.text());
    });
    // As the playground: a credit long enough to wrap, actions in the card at the bottom left,
    // then a feature selected, which opens the inspector as a sheet
    await page.evaluate(() => {
      const w = window as unknown as E2EWindow;
      w.map.addSource('credit', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        attribution: 'The survey of the city, the data of the transport authority and the walks',
      });
      w.map.addLayer({ id: 'credit', type: 'circle', source: 'credit' });
      for (let i = 0; i < 4; i++) {
        w.ui.actions.add({ id: `run-${i}`, label: `Action ${i}`, kind: 'action', run: () => {} });
      }
    });
    await settle(page);
    const { polygon } = await ids();
    await page.evaluate((id) => {
      (window as unknown as E2EWindow).draw.selection.set('feature', [id]);
    }, polygon);
    await page.locator('[data-role="inspector"] [data-role="tabs"]').waitFor();
    await settle(page);
    await page.waitForTimeout(500);
    await settle(page);
    expect(errors).toEqual([]);
  });
});
