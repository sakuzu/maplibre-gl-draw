// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests: a solid line is as thick on the terrain as without it
 *
 * With the terrain on, a solid line is painted on the ground by the analytic drape, which works
 * out the distance of each pixel to the line itself. Without the terrain, the same line is drawn
 * by the vertex path. The thickness must not change between the two: not with the device pixel
 * ratio, and not along the line (between its vertices and at them).
 *
 * The terrain is flat (0 m), so the line lies where it would lie without it, and the thickness
 * is read from the canvas across the line, on the normal of its direction on the screen.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import {
  type Bundle,
  bundlePage,
  type Camera,
  launchBrowser,
  openMapPage,
  settle,
} from './harness.js';

/**
 * A pitched camera: the ground is squeezed along the screen's vertical, so a line that runs
 * across the screen at a slant is not on an axis of the squeeze
 */
const CAMERA: Camera = { center: [139.0, 35.0], zoom: 17, pitch: 60, bearing: 0 };

/** The width of the line in CSS pixels */
const WIDTH = 12;

/** The ends of the line on the map canvas (CSS pixels): a slant across the screen */
const START_PX = { x: 140, y: 380 };
const END_PX = { x: 500, y: 120 };

/** The color of the line, pure and far from the white ground */
const BLUE = '#0000FF';

/** A position in `[lng, lat]` */
type LngLat = [number, number];

/** The line, its vertices and the middles of its edges */
interface TestLine {
  /** The three vertices: the ends and a vertex in the middle, on one straight line */
  vertices: LngLat[];
  /** The middles of the two edges */
  middles: LngLat[];
}

interface TestWindow {
  map: import('maplibre-gl').Map;
  draw: import('../index.js').Draw;
  e2e: {
    terrain: {
      addTestTerrain(
        map: import('maplibre-gl').Map,
        exaggeration: number,
        options?: { flat?: boolean },
      ): Promise<void>;
    };
  };
  pixels?: { data: Uint8Array; width: number; height: number; ratio: number };
}

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, browserTimeout(90_000));

afterAll(async () => {
  await browser?.close();
});

/** Opens a page with a white ground under the layers of the draw instance */
async function openPage(deviceScaleFactor: number): Promise<Page> {
  const page = await openMapPage(browser, bundle, CAMERA, { deviceScaleFactor });
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.map.addLayer(
      { id: 'ground', type: 'background', paint: { 'background-color': '#ffffff' } },
      w.map.getLayersOrder()[0],
    );
  });
  await settle(page);
  return page;
}

/** Puts the flat terrain on the page */
async function addFlatTerrain(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as TestWindow;
    await w.e2e.terrain.addTestTerrain(w.map, 1, { flat: true });
  });
  await settle(page);
}

/**
 * Replaces every feature with the test line
 *
 * Its ends are where `START_PX` and `END_PX` show the ground, and its width follows the zoom from
 * the zoom of the camera (a scale of 1 there).
 */
async function drawLine(page: Page): Promise<TestLine> {
  return page.evaluate(
    ({ start, end, width, color }) => {
      const { map, draw } = window as unknown as TestWindow;
      draw.features.deleteMany(draw.features.list().map((feature) => feature.id));
      const at = (px: { x: number; y: number }): LngLat => {
        const ll = map.unproject([px.x, px.y]);
        return [ll.lng, ll.lat];
      };
      const mid = (a: LngLat, b: LngLat): LngLat => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const a = at(start);
      const c = at(end);
      const b = mid(a, c);
      draw.features.create({
        type: 'LineString',
        geometry: { type: 'LineString', coordinates: [a, b, c] },
        properties: { 'maplibre-gl-draw:createdZoom': map.getZoom() },
        style: { strokeColor: color, strokeWidth: width, lineStyle: 'solid' },
      });
      return { vertices: [a, b, c], middles: [mid(a, b), mid(b, c)] };
    },
    { start: START_PX, end: END_PX, width: WIDTH, color: BLUE },
  );
}

/**
 * Draws until every tile is in, then keeps the pixels of the canvas (read in the render event,
 * before the frame is shown)
 *
 * @returns Whether the drape painted the frame
 */
async function capture(page: Page): Promise<{ used: boolean; reason: string }> {
  return page.evaluate(async () => {
    const w = window as unknown as TestWindow;
    const { map, draw } = w;
    const read = (): Promise<void> =>
      new Promise((resolve) => {
        map.once('render', () => {
          const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
          const width = gl.drawingBufferWidth;
          const height = gl.drawingBufferHeight;
          const data = new Uint8Array(width * height * 4);
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
          w.pixels = { data, width, height, ratio: width / map.getCanvas().clientWidth };
          resolve();
        });
        map.triggerRepaint();
      });
    // Enough frames for the drape to settle
    for (let i = 0; i < 12; i++) await read();
    for (let i = 0; i < 100 && !(map.loaded() && map.areTilesLoaded()); i++) await read();
    await read();
    const { used, reason } = draw.debug.terrain().drape;
    return { used, reason: String(reason) };
  });
}

/**
 * The thickness of the line at a point of it, in device pixels
 *
 * The canvas is walked from the point along the normal of the line on the screen, both ways, in
 * steps of a quarter of a device pixel, for as long as the pixels are the color of the line
 * (more than half covered: the blue is up and the red and green are below half). It is averaged
 * over a device pixel either way along the line (no further: at a vertex, a line that is
 * thinner between its vertices than at them would be read thinner than it is there).
 */
async function thicknessAt(page: Page, line: TestLine, point: LngLat): Promise<number> {
  return page.evaluate(
    ({ line, point }) => {
      const { map, pixels } = window as unknown as TestWindow;
      if (!pixels) throw new Error('nothing was captured');
      const { data, width, height, ratio } = pixels;
      const first = map.project(line.vertices[0]);
      const last = map.project(line.vertices[line.vertices.length - 1]);
      const length = Math.hypot(last.x - first.x, last.y - first.y);
      const along = { x: (last.x - first.x) / length, y: (last.y - first.y) / length };
      const normal = { x: -along.y, y: along.x };
      const center = map.project(point);
      const isLine = (x: number, y: number): boolean => {
        const col = Math.floor(x);
        const row = height - 1 - Math.floor(y);
        if (col < 0 || row < 0 || col >= width || row >= height) return false;
        const i = (row * width + col) * 4;
        return data[i] < 128 && data[i + 1] < 128 && data[i + 2] > 128;
      };
      const step = 0.25;
      const reach = 100 * ratio;
      const widths: number[] = [];
      for (const k of [-1, -0.5, 0, 0.5, 1]) {
        const cx = center.x * ratio + along.x * k;
        const cy = center.y * ratio + along.y * k;
        if (!isLine(cx, cy)) {
          widths.push(0);
          continue;
        }
        let total = step;
        for (const sign of [1, -1]) {
          let t = 0;
          while (
            t < reach &&
            isLine(cx + normal.x * sign * (t + step), cy + normal.y * sign * (t + step))
          ) {
            t += step;
          }
          total += t;
        }
        widths.push(total);
      }
      return widths.reduce((sum, w) => sum + w, 0) / widths.length;
    },
    { line, point },
  );
}

describe('a solid line on the terrain at a device pixel ratio of 1', () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(1);
    await addFlatTerrain(page);
  }, browserTimeout(90_000));

  it('is as thick between its vertices as at them', async () => {
    const line = await drawLine(page);
    const drape = await capture(page);
    expect(drape.used, `the drape is not in use (${drape.reason})`).toBe(true);
    const atVertex = await thicknessAt(page, line, line.vertices[1]);
    const between = await Promise.all(line.middles.map((m) => thicknessAt(page, line, m)));
    const report = `at the vertex ${atVertex}, between the vertices ${between.join(', ')}`;
    expect(Math.abs(atVertex - WIDTH), report).toBeLessThanOrEqual(1.5);
    for (const width of between) {
      expect(Math.abs(width - WIDTH), report).toBeLessThanOrEqual(1.5);
      expect(Math.abs(width - atVertex), report).toBeLessThanOrEqual(1);
    }
  });
});

describe('a solid line at a device pixel ratio of 2', () => {
  let page: Page;
  /** The thickness without the terrain, measured first */
  let withoutTerrain: number | undefined;

  beforeAll(async () => {
    page = await openPage(2);
  }, browserTimeout(90_000));

  it('is twice as thick in device pixels without the terrain', async () => {
    const line = await drawLine(page);
    await capture(page);
    withoutTerrain = await thicknessAt(page, line, line.vertices[1]);
    expect(Math.abs(withoutTerrain - WIDTH * 2), `${withoutTerrain}`).toBeLessThanOrEqual(2);
  });

  it('is as thick on the terrain as without it', async () => {
    await addFlatTerrain(page);
    const line = await drawLine(page);
    const drape = await capture(page);
    expect(drape.used, `the drape is not in use (${drape.reason})`).toBe(true);
    const width = await thicknessAt(page, line, line.vertices[1]);
    const report = `on the terrain ${width}, without it ${withoutTerrain}`;
    expect(Math.abs(width - WIDTH * 2), report).toBeLessThanOrEqual(2);
    if (withoutTerrain !== undefined) {
      expect(Math.abs(width - withoutTerrain), report).toBeLessThanOrEqual(1);
    }
  });
});
