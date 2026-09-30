// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests: the engine on a real maplibre Map, driven by the real pointer
 *
 * The unit tests feed normalized events to the modes on a linear stub of the map (one degree
 * per ten pixels). These tests go through everything that stub skips: the browser's mouse and
 * keyboard events, maplibre's event system and projection, the InputNormalizer (the drag
 * threshold, a click told from a drag), the focus of the canvas and the hit testing against
 * what is drawn. See `harness.ts` for how the page is built.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Feature } from '../index.js';
import { coordinatesOf } from '../shared/utils/coordinates.js';
import { browserTimeout } from '../test-utils.js';
import {
  type Bundle,
  bundlePage,
  type Camera,
  click,
  drag,
  type E2EWindow,
  features,
  launchBrowser,
  lngLatOf,
  MAP_SIZE,
  mode,
  openMapPage,
  type PagePoint,
  pageOf,
  press,
  selectedIds,
  settle,
} from './harness.js';

/** The camera of the page: a flat map (the pitched tests tilt and rotate it) */
const FLAT: Camera = { center: [139.7, 35.68], zoom: 14 };

/** The page point of the center of the map */
const CENTER: PagePoint = { x: 40 + MAP_SIZE.width / 2, y: 30 + MAP_SIZE.height / 2 };

/** A page point relative to the center of the map */
function at(dx: number, dy: number): PagePoint {
  return { x: CENTER.x + dx, y: CENTER.y + dy };
}

/** Degrees of error allowed between a coordinate and the point it was drawn at (about 1 px) */
const TOLERANCE_DEG = 2e-5;

function expectNear(actual: number[], expected: number[], tolerance = TOLERANCE_DEG): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => {
    expect(Math.abs(value - expected[i])).toBeLessThan(tolerance);
  });
}

async function setMode(page: Page, name: string): Promise<boolean> {
  const ok = await page.evaluate((m) => (window as unknown as E2EWindow).draw.setMode(m), name);
  await settle(page);
  return ok;
}

/** Whether a drawing is in progress, read through the context of a probe plugin */
async function isDrawing(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const { draw } = window as unknown as E2EWindow;
    const probe = window as unknown as { e2eDrawing?: { isDrawing(): boolean } };
    if (!probe.e2eDrawing) {
      draw.extensions.plugins.add({
        name: 'e2e-probe',
        onAdd(ctx) {
          probe.e2eDrawing = ctx.drawing;
        },
      });
    }
    return probe.e2eDrawing?.isDrawing() === true;
  });
}

async function clearAll(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { draw } = window as unknown as E2EWindow;
    draw.setReadOnly(false);
    draw.setMode('select');
    draw.features.deleteMany(draw.features.list().map((feature) => feature.id));
  });
  await settle(page);
}

/** The outer ring of a Polygon feature */
function outerRing(feature: Feature): number[][] {
  return (coordinatesOf(feature) as number[][][])[0];
}

let browser: Browser;
/**
 * One page serves every test: a new page means a new GL context, and compiling the shaders
 * again on the software WebGL of the headless browser costs seconds
 */
let page: Page;

beforeAll(async () => {
  let bundle: Bundle;
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
  page = await openMapPage(browser, bundle, FLAT);
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

describe('drawing with the real pointer on a flat map', () => {
  it('draws a point with a click, and Escape leaves the mode without one', async () => {
    await clearAll(page);
    await setMode(page, 'draw_point');
    await click(page, at(-50, 20));
    const [point] = await features(page);
    expect(point.type).toBe('Point');
    expectNear(coordinatesOf(point) as number[], await lngLatOf(page, at(-50, 20)));
    expect(await mode(page)).toBe('select');

    await setMode(page, 'draw_point');
    await page.mouse.move(at(80, 80).x, at(80, 80).y);
    await press(page, 'Escape');
    expect(await mode(page)).toBe('select');
    expect(await features(page)).toHaveLength(1);
  });

  it('draws a line with clicks and a click on the last vertex, and Escape discards one', async () => {
    await clearAll(page);
    await setMode(page, 'draw_line');
    await click(page, at(-100, 0));
    await click(page, at(0, -60));
    await click(page, at(100, 0));
    await click(page, at(100, 0));
    const [line] = await features(page);
    expect(line.type).toBe('LineString');
    expect(coordinatesOf(line)).toHaveLength(3);
    expectNear((coordinatesOf(line) as number[][])[1], await lngLatOf(page, at(0, -60)));
    expect(await mode(page)).toBe('select');

    await setMode(page, 'draw_line');
    await click(page, at(-100, 100));
    await click(page, at(0, 120));
    await press(page, 'Escape');
    expect(await features(page)).toHaveLength(1);
    expect(await isDrawing(page)).toBe(false);
    // The first Escape discards the line being drawn, the second leaves the mode
    expect(await mode(page)).toBe('draw_line');
    await press(page, 'Escape');
    expect(await mode(page)).toBe('select');
  });

  it('draws a polygon closed on its first vertex, and Escape discards one', async () => {
    await clearAll(page);
    await setMode(page, 'draw_polygon');
    await click(page, at(-80, -60));
    await click(page, at(80, -60));
    await click(page, at(80, 60));
    await click(page, at(-80, 60));
    await click(page, at(-80, -60));
    const [polygon] = await features(page);
    expect(polygon.type).toBe('Polygon');
    const ring = outerRing(polygon);
    expect(ring).toHaveLength(5);
    expectNear(ring[2], await lngLatOf(page, at(80, 60)));

    await setMode(page, 'draw_polygon');
    await click(page, at(120, 100));
    await click(page, at(200, 100));
    await press(page, 'Escape');
    expect(await features(page)).toHaveLength(1);
    expect(await isDrawing(page)).toBe(false);
    expect(await mode(page)).toBe('draw_polygon');
    await press(page, 'Escape');
    expect(await mode(page)).toBe('select');
  });

  it('finishes a polygon with a double click, on its last vertex or on a new position', async () => {
    await clearAll(page);
    const zoom = await page.evaluate(() => (window as unknown as E2EWindow).map.getZoom());
    await setMode(page, 'draw_polygon');
    await click(page, at(-80, -60));
    await click(page, at(80, -60));
    await click(page, at(80, 60));
    await page.mouse.dblclick(at(80, 60).x, at(80, 60).y);
    await settle(page);
    expect(await mode(page)).toBe('select');
    expect(await isDrawing(page)).toBe(false);
    const [triangle] = await features(page);
    expect(triangle.type).toBe('Polygon');
    expect(outerRing(triangle)).toHaveLength(4);
    expectNear(outerRing(triangle)[2], await lngLatOf(page, at(80, 60)));

    await clearAll(page);
    await setMode(page, 'draw_polygon');
    await click(page, at(-80, -60));
    await click(page, at(80, -60));
    await click(page, at(80, 60));
    await page.mouse.dblclick(at(-80, 60).x, at(-80, 60).y);
    await settle(page);
    expect(await mode(page)).toBe('select');
    const [square] = await features(page);
    expect(outerRing(square)).toHaveLength(5);
    expectNear(outerRing(square)[3], await lngLatOf(page, at(-80, 60)));
    // The double clicks did not zoom the map
    expect(await page.evaluate(() => (window as unknown as E2EWindow).map.getZoom())).toBe(zoom);
  });

  it('draws a circle from its center and radius, and Escape discards one', async () => {
    await clearAll(page);
    await setMode(page, 'draw_circle');
    await click(page, at(0, 0));
    await page.mouse.move(at(60, 0).x, at(60, 0).y, { steps: 4 });
    await click(page, at(60, 0));
    const [circle] = await features(page);
    expect(circle.type).toBe('Circle');
    expect(await mode(page)).toBe('select');

    await setMode(page, 'draw_circle');
    await click(page, at(-150, -100));
    await page.mouse.move(at(-100, -100).x, at(-100, -100).y, { steps: 4 });
    await press(page, 'Escape');
    expect(await features(page)).toHaveLength(1);
    expect(await isDrawing(page)).toBe(false);
  });

  it('draws an area from code with draw.drawing, through the input of the plugins', async () => {
    await clearAll(page);
    await setMode(page, 'draw_polygon');
    const seen = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      const clicks: string[] = [];
      const remove = draw.extensions.plugins.add({
        name: 'e2e-drawing-probe',
        onAdd() {},
        input: {
          onClick(event) {
            clicks.push(event.original.type);
          },
        },
      });
      const placed = [
        [139.699, 35.679],
        [139.701, 35.679],
        [139.701, 35.681],
      ].map((position) => draw.drawing.addVertex(position));
      const finished = draw.drawing.finish();
      remove();
      return { placed, finished, clicks };
    });
    await settle(page);
    expect(seen).toEqual({
      placed: [true, true, true],
      finished: true,
      clicks: ['click', 'click', 'click'],
    });
    const [area] = await features(page);
    expect(area.type).toBe('Polygon');
    expectNear(outerRing(area)[1], [139.701, 35.679], 1e-9);
    expect(await mode(page)).toBe('select');
  });

  it('draws a freehand stroke with a drag, and Escape during a stroke discards it', async () => {
    await clearAll(page);
    await setMode(page, 'draw_freehand');
    await drag(page, at(-120, 80), at(120, 40), 16);
    const [stroke] = await features(page);
    expect(stroke.type).toBe('Freehand');
    expect((coordinatesOf(stroke) as number[][]).length).toBeGreaterThan(2);
    expect(await mode(page)).toBe('draw_freehand');

    // Escape while the button is down cancels the drag (dragcancel), and the release that
    // follows draws nothing
    await page.mouse.move(at(-120, -80).x, at(-120, -80).y);
    await page.mouse.down();
    await page.mouse.move(at(100, -60).x, at(100, -60).y, { steps: 12 });
    await press(page, 'Escape');
    await page.mouse.up();
    await settle(page);
    expect(await features(page)).toHaveLength(1);
    expect(await isDrawing(page)).toBe(false);

    await press(page, 'Escape');
    expect(await mode(page)).toBe('select');
  });

  it('selects a polygon with a click and moves it with a drag', async () => {
    await clearAll(page);
    await setMode(page, 'draw_polygon');
    for (const p of [at(-40, -40), at(40, -40), at(40, 40), at(-40, 40), at(-40, -40)]) {
      await click(page, p);
    }
    const [before] = await features(page);

    await click(page, at(0, 0));
    expect(await selectedIds(page)).toEqual([before.id]);

    await drag(page, at(0, 0), at(100, 50));
    const [after] = await features(page);
    expectNear(outerRing(after)[0], await lngLatOf(page, at(60, 10)));
  });

  it('moves a vertex of the selected polygon with a drag on its handle', async () => {
    await clearAll(page);
    await setMode(page, 'draw_polygon');
    for (const p of [at(-40, -40), at(40, -40), at(40, 40), at(-40, 40), at(-40, -40)]) {
      await click(page, p);
    }
    await click(page, at(0, 0));

    await drag(page, at(40, 40), at(90, 70));
    const [after] = await features(page);
    const ring = outerRing(after);
    expectNear(ring[2], await lngLatOf(page, at(90, 70)));
    expectNear(ring[1], await lngLatOf(page, at(40, -40)));
  });

  it('does not move a feature when the press stays within the drag threshold', async () => {
    await clearAll(page);
    await setMode(page, 'draw_point');
    await click(page, at(0, 0));
    const [before] = await features(page);

    await click(page, at(0, 0));
    await drag(page, at(0, 0), at(2, 0), 2);
    const [after] = await features(page);
    expect(coordinatesOf(after)).toEqual(coordinatesOf(before));
    expect(await selectedIds(page)).toEqual([before.id]);
  });

  it('deletes the selection with the Delete key', async () => {
    await clearAll(page);
    await setMode(page, 'draw_point');
    await click(page, at(30, 30));
    await setMode(page, 'draw_point');
    await click(page, at(-30, -30));
    const [first, second] = await features(page);

    await click(page, at(30, 30));
    expect(await selectedIds(page)).toEqual([first.id]);
    await press(page, 'Delete');
    expect((await features(page)).map((f) => f.id)).toEqual([second.id]);
  });

  it('stops editing while read-only and resumes when it is turned off', async () => {
    await clearAll(page);
    await setMode(page, 'draw_polygon');
    for (const p of [at(-40, -40), at(40, -40), at(40, 40), at(-40, 40), at(-40, -40)]) {
      await click(page, p);
    }
    const [before] = await features(page);
    await page.evaluate(() => (window as unknown as E2EWindow).draw.setReadOnly(true));

    await click(page, at(0, 0));
    await drag(page, at(0, 0), at(100, 50));
    await drag(page, at(40, 40), at(90, 70));
    await press(page, 'Delete');
    expect(await features(page)).toEqual([before]);
    // Entering a drawing mode is local state and passes; the drawing is not written
    await setMode(page, 'draw_point');
    await click(page, at(150, 150));
    expect(await features(page)).toEqual([before]);
    await setMode(page, 'select');

    await page.evaluate(() => (window as unknown as E2EWindow).draw.setReadOnly(false));
    await click(page, at(0, 0));
    await drag(page, at(0, 0), at(100, 50));
    const [after] = await features(page);
    expectNear(outerRing(after)[0], await lngLatOf(page, at(60, 10)));
  });
});

describe('the stacking order on a real map', () => {
  it('places external entries and layer-order datasets with reorder, and the runs follow', async () => {
    const result = await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      draw.options.update({ isExternalEntry: (id) => id.startsWith('base:') });
      const [first] = draw.layers.list();
      const itemsBefore = [...first.items];
      draw.layers.create({ id: 'e2e-second' });
      draw.datasets.add({ id: 'e2e-parcels', rows: [], order: 'layer-order' });
      draw.layers.reorder([first.id, 'base:roads', 'e2e-parcels', 'e2e-second']);
      const placed = {
        order: [...draw.getStore().getLayerOrder()],
        runs: draw.getLayerStack().map(({ from, to }) => [from, to]),
        items: draw.layers.list().map((layer) => [...layer.items]),
      };
      draw.layers.delete('e2e-second');
      draw.datasets.remove('e2e-parcels');
      draw.options.update({ isExternalEntry: () => false });
      return { ...placed, firstId: first.id, itemsBefore };
    });
    expect(result.order).toEqual([result.firstId, 'base:roads', 'e2e-parcels', 'e2e-second']);
    expect(result.runs).toEqual([
      [0, 1],
      [2, 4],
    ]);
    expect(result.items).toEqual([result.itemsBefore, []]);
  });
});

describe('drawing on a pitched and rotated map', () => {
  beforeAll(async () => {
    await page.evaluate(() =>
      (window as unknown as E2EWindow).map.jumpTo({ zoom: 15, pitch: 55, bearing: 35 }),
    );
    await settle(page);
  });

  afterAll(async () => {
    await page.evaluate((camera) => {
      const { map, draw } = window as unknown as E2EWindow;
      map.jumpTo({ ...camera, pitch: 0, bearing: 0 });
      draw.options.update({ snapping: { enabled: true } });
    }, FLAT);
  });

  it('puts the vertices under the pointer and moves the polygon to where it is dropped', async () => {
    await clearAll(page);
    // Snapping is turned off: its constraints (a right angle, the extension of an edge) are
    // taken on the ground and would rightly pull a vertex off the pointer
    await page.evaluate(() =>
      (window as unknown as E2EWindow).draw.options.update({ snapping: { enabled: false } }),
    );
    const corners = [at(-60, -30), at(60, -40), at(70, 60), at(-70, 50)];
    await setMode(page, 'draw_polygon');
    for (const p of [...corners, corners[0]]) await click(page, p);
    const [polygon] = await features(page);
    const ring = outerRing(polygon);
    for (let i = 0; i < corners.length; i++) {
      // The projection is not linear: the vertex is where maplibre unprojects the pointer
      expectNear(ring[i], await lngLatOf(page, corners[i]));
    }

    await click(page, at(0, 10));
    expect(await selectedIds(page)).toEqual([polygon.id]);
    await drag(page, at(0, 10), at(40, -30));
    const [moved] = await features(page);
    const from = await lngLatOf(page, at(0, 10));
    const to = await lngLatOf(page, at(40, -30));
    // The polygon is carried by the ground offset between the press and the release, which on
    // a pitched and rotated map is nothing like the screen offset
    for (let i = 0; i < corners.length; i++) {
      expectNear(outerRing(moved)[i], [ring[i][0] + to[0] - from[0], ring[i][1] + to[1] - from[1]]);
    }

    // A vertex handle is hit where it is drawn and follows the pointer
    await drag(page, await pageOf(page, outerRing(moved)[1]), at(120, -90));
    const [edited] = await features(page);
    expectNear(outerRing(edited)[1], await lngLatOf(page, at(120, -90)));
  });
});
