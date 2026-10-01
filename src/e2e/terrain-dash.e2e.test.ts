// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests: a dashed line lies on the terrain like a solid one
 *
 * With the terrain on and the camera pitched, a dashed line must keep its whole thickness: both
 * of its sides, on the side of the camera as well as on the far side, with the same pattern of
 * dashes as without the terrain. The same holds for the dashed outline of a polygon, whose fill
 * must still be painted. A dashed line must be painted once, not once by each path.
 *
 * The terrain is flat (0 m), so every line lies where it would lie without it. The dashes are
 * read from the canvas: the line is walked along its middle in steps of half a device pixel,
 * and at each step inside a dash the line is followed along its normal on the screen, to the
 * upper side and to the lower side apart.
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

/** A pitched camera close to the ground */
const CAMERA: Camera = { center: [139.0, 35.0], zoom: 17, pitch: 60, bearing: 0 };

/** The width of the lines in CSS pixels */
const WIDTH = 8;

/**
 * How far the two sides of a dash may differ (device pixels)
 *
 * A line painted on the ground reaches as far to either side of its middle, give or take the
 * antialiasing of its edges. A dash drawn as a ribbon at the depth of its middle lost about a
 * pixel on its lower side, the side towards the camera, where the ground is nearer.
 */
const SIDE_TOLERANCE = 0.75;

/** The ends of the line on the map canvas (CSS pixels): a slant across the screen */
const START_PX = { x: 140, y: 380 };
const END_PX = { x: 500, y: 120 };

/** The third corner of the test polygon (CSS pixels), below the line */
const CORNER_PX = { x: 520, y: 420 };

/** The ends of a short solid line away from the test lines (CSS pixels) */
const ANCHOR_PX = [
  { x: 30, y: 300 },
  { x: 60, y: 330 },
];

/** How far the parallel solid line is put below the dashed one (CSS pixels) */
const SOLID_OFFSET_PX = 60;

/** The color of the lines, pure and far from the white ground */
const BLUE = '#0000FF';

/** The fill of the polygon, far from both the line and the ground */
const RED = '#FF0000';

/** The opacity of the lines of the test that a line is painted once */
const HALF_OPACITY = 0.6;

/** A position in `[lng, lat]` */
type LngLat = [number, number];

/** A point on the map canvas (CSS pixels) */
interface CanvasPoint {
  x: number;
  y: number;
}

/** One dash read from the canvas */
interface Dash {
  /** Where it starts and ends along the line (device pixels from the first end) */
  start: number;
  end: number;
  /** The mean reach of the line from its middle, to the upper and the lower side (device px) */
  upper: number;
  lower: number;
  /** The color in the middle of the dash */
  center: [number, number, number];
}

/** What a walk along a line reads */
interface Walk {
  dashes: Dash[];
  /** The gaps between the dashes: their length (device pixels) and the color in their middle */
  gaps: Array<{ length: number; color: [number, number, number] }>;
  /** The device pixel ratio of the canvas */
  ratio: number;
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
async function openPage(deviceScaleFactor = 1): Promise<Page> {
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

/** The ground at points of the map canvas */
async function groundAt(page: Page, points: CanvasPoint[]): Promise<LngLat[]> {
  return page.evaluate((points) => {
    const { map } = window as unknown as TestWindow;
    return points.map((px) => {
      const ll = map.unproject([px.x, px.y]);
      return [ll.lng, ll.lat] as LngLat;
    });
  }, points);
}

/**
 * Replaces every feature with the given ones
 *
 * Their widths follow the zoom from the zoom of the camera (a scale of 1 there).
 */
async function replaceFeatures(page: Page, features: TestFeature[]): Promise<void> {
  await page.evaluate((features) => {
    const { map, draw } = window as unknown as TestWindow;
    draw.features.deleteMany(draw.features.list().map((feature) => feature.id));
    for (const feature of features) {
      draw.features.create({
        type: feature.type,
        geometry:
          feature.type === 'Polygon'
            ? { type: 'Polygon', coordinates: [[...feature.coordinates, feature.coordinates[0]]] }
            : { type: 'LineString', coordinates: feature.coordinates },
        properties: { 'maplibre-gl-draw:createdZoom': map.getZoom() },
        style: feature.style,
      });
    }
  }, features);
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
 * Walks along a line from `from` to `to` and reads its dashes from the captured canvas
 *
 * The walk goes a little past both ends, so that the caps there are read whole. A step is
 * inside the line when its pixel is more than half the color of the line (the blue is up and
 * the red and green are below half). Inside a dash, the reach to either side is averaged over
 * the middle of the dash only: the round caps at its ends are narrower by their nature.
 */
async function walkLine(page: Page, from: LngLat, to: LngLat, width: number): Promise<Walk> {
  return page.evaluate(
    ({ from, to, width }) => {
      const { map, pixels } = window as unknown as TestWindow;
      if (!pixels) throw new Error('nothing was captured');
      const { data, width: canvasWidth, height, ratio } = pixels;
      const a = map.project(from);
      const b = map.project(to);
      const ax = a.x * ratio;
      const ay = a.y * ratio;
      const length = Math.hypot(b.x * ratio - ax, b.y * ratio - ay);
      const along = { x: (b.x * ratio - ax) / length, y: (b.y * ratio - ay) / length };
      // The normal that points down the screen
      let down = { x: -along.y, y: along.x };
      if (down.y < 0) down = { x: -down.x, y: -down.y };

      const colorAt = (x: number, y: number): [number, number, number] => {
        const col = Math.floor(x);
        const row = height - 1 - Math.floor(y);
        if (col < 0 || row < 0 || col >= canvasWidth || row >= height) return [0, 0, 0];
        const i = (row * canvasWidth + col) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      };
      const isLine = (x: number, y: number): boolean => {
        const [r, g, bl] = colorAt(x, y);
        return r < 128 && g < 128 && bl > 128;
      };
      const reach = (x: number, y: number, dx: number, dy: number): number => {
        const step = 0.25;
        let t = 0;
        while (t < 50 * ratio && isLine(x + dx * (t + step), y + dy * (t + step))) t += step;
        return t + step / 2;
      };

      const step = 0.5;
      const margin = width * ratio;
      const on: boolean[] = [];
      const positions: number[] = [];
      for (let t = -margin; t <= length + margin; t += step) {
        positions.push(t);
        on.push(isLine(ax + along.x * t, ay + along.y * t));
      }

      const runs: Array<[number, number]> = [];
      let open = -1;
      for (let i = 0; i <= on.length; i++) {
        const value = i < on.length && on[i];
        if (value && open < 0) open = i;
        if (!value && open >= 0) {
          runs.push([open, i - 1]);
          open = -1;
        }
      }

      const point = (t: number): [number, number] => [ax + along.x * t, ay + along.y * t];
      const dashes = runs.map(([i0, i1]) => {
        const start = positions[i0];
        const end = positions[i1];
        // The middle of the dash, a cap's length away from either end
        const cap = (width * ratio) / 2 + 1;
        const upper: number[] = [];
        const lower: number[] = [];
        for (let t = start + cap; t <= end - cap; t += step) {
          const [x, y] = point(t);
          upper.push(reach(x, y, -down.x, -down.y));
          lower.push(reach(x, y, down.x, down.y));
        }
        const mean = (list: number[]): number =>
          list.length === 0 ? Number.NaN : list.reduce((s, v) => s + v, 0) / list.length;
        const [cx, cy] = point((start + end) / 2);
        return { start, end, upper: mean(upper), lower: mean(lower), center: colorAt(cx, cy) };
      });
      const gaps = runs.slice(1).map(([i0], k) => {
        const before = positions[runs[k][1]];
        const [x, y] = point((before + positions[i0]) / 2);
        return { length: positions[i0] - before, color: colorAt(x, y) };
      });
      return { dashes, gaps, ratio };
    },
    { from, to, width },
  );
}

/** The dashes a walk read wholly inside the line (the ends of the walk cut no dash short) */
function innerDashes(walk: Walk, from: number, to: number): Dash[] {
  return walk.dashes.filter((dash) => dash.start >= from && dash.end <= to);
}

/** A readable list of what the dashes measured */
function describeDashes(dashes: Dash[]): string {
  return dashes
    .map(
      (d) =>
        `[${d.start.toFixed(1)}..${d.end.toFixed(1)} up ${d.upper.toFixed(2)} down ${d.lower.toFixed(2)}]`,
    )
    .join(' ');
}

/** Checks that every dash is whole: as thick as the line, as much above its middle as below */
function expectWholeDashes(dashes: Dash[], ratio: number): void {
  const report = describeDashes(dashes);
  expect(dashes.length, report).toBeGreaterThanOrEqual(4);
  for (const dash of dashes) {
    // A dash too short to have a middle between its caps says nothing about its sides
    if (Number.isNaN(dash.upper)) continue;
    expect(Math.abs(dash.upper - dash.lower), report).toBeLessThanOrEqual(SIDE_TOLERANCE);
    expect(Math.abs(dash.upper + dash.lower - WIDTH * ratio), report).toBeLessThanOrEqual(1.5);
  }
}

/** A feature to put on the page */
interface TestFeature {
  type: 'LineString' | 'Polygon';
  coordinates: LngLat[];
  style: Record<string, string | number>;
}

/** The dashed test line */
function dashedLine(line: LngLat[]): TestFeature {
  return {
    type: 'LineString',
    coordinates: line,
    style: { strokeColor: BLUE, strokeWidth: WIDTH, lineStyle: 'dashed' },
  };
}

/**
 * A short solid line away from the others
 *
 * It keeps the drape in use whatever else is on the page, so that a dashed line is compared
 * on a frame the drape paints.
 */
async function anchorLine(page: Page): Promise<TestFeature> {
  return {
    type: 'LineString',
    coordinates: await groundAt(page, ANCHOR_PX),
    style: { strokeColor: '#00AA00', strokeWidth: 4, lineStyle: 'solid' },
  };
}

describe.each([1, 2])(
  'a dashed line with and without the flat terrain at a device pixel ratio of %d',
  (ratio) => {
    let page: Page;
    let line: LngLat[];

    beforeAll(async () => {
      page = await openPage(ratio);
      line = await groundAt(page, [START_PX, END_PX]);
    }, browserTimeout(90_000));

    it('has its dashes where they are without the terrain', async () => {
      await replaceFeatures(page, [await anchorLine(page), dashedLine(line)]);
      await capture(page);
      const withoutTerrain = await walkLine(page, line[0], line[1], WIDTH);
      expect(withoutTerrain.dashes.length).toBeGreaterThanOrEqual(4);

      await addFlatTerrain(page);
      await replaceFeatures(page, [await anchorLine(page), dashedLine(line)]);
      const drape = await capture(page);
      const onTerrain = await walkLine(page, line[0], line[1], WIDTH);

      const report = `on the terrain ${describeDashes(onTerrain.dashes)}, without it ${describeDashes(withoutTerrain.dashes)}`;
      expect(onTerrain.dashes.length, report).toBe(withoutTerrain.dashes.length);
      onTerrain.dashes.forEach((dash, i) => {
        const flat = withoutTerrain.dashes[i];
        if (!flat) return;
        // A device pixel either way at a ratio of 1 (the pattern is measured in CSS pixels, so the
        // tolerance grows with the ratio)
        expect(Math.abs(dash.start - flat.start), report).toBeLessThanOrEqual(ratio);
        expect(Math.abs(dash.end - flat.end), report).toBeLessThanOrEqual(ratio);
      });
      expect(drape.used, `the drape is not in use (${drape.reason})`).toBe(true);
    });
  },
);

describe('a dashed line on the flat terrain', () => {
  let page: Page;
  let line: LngLat[];

  beforeAll(async () => {
    page = await openPage();
    line = await groundAt(page, [START_PX, END_PX]);
    await addFlatTerrain(page);
  }, browserTimeout(90_000));

  it('keeps both sides of every dash', async () => {
    await replaceFeatures(page, [await anchorLine(page), dashedLine(line)]);
    const drape = await capture(page);
    const walk = await walkLine(page, line[0], line[1], WIDTH);
    const length = walk.dashes.length > 0 ? walk.dashes[walk.dashes.length - 1].end : 0;
    expectWholeDashes(innerDashes(walk, 0, length), walk.ratio);
    expect(drape.used, `the drape is not in use (${drape.reason})`).toBe(true);
  });

  it('keeps both sides of every dash of the outline of a polygon, and fills it', async () => {
    const corner = (await groundAt(page, [CORNER_PX]))[0];
    await replaceFeatures(page, [
      await anchorLine(page),
      {
        type: 'Polygon',
        coordinates: [line[0], line[1], corner],
        style: {
          fillColor: RED,
          fillOpacity: 1,
          strokeColor: BLUE,
          strokeWidth: WIDTH,
          lineStyle: 'dashed',
        },
      },
    ]);
    const drape = await capture(page);

    const fill = await page.evaluate(
      ({ points }) => {
        const { pixels } = window as unknown as TestWindow;
        if (!pixels) throw new Error('nothing was captured');
        const x = ((points[0].x + points[1].x + points[2].x) / 3) * pixels.ratio;
        const y = ((points[0].y + points[1].y + points[2].y) / 3) * pixels.ratio;
        const i = ((pixels.height - 1 - Math.floor(y)) * pixels.width + Math.floor(x)) * 4;
        return [pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]];
      },
      { points: [START_PX, END_PX, CORNER_PX] },
    );
    expect(fill[0], `the fill reads ${fill}`).toBeGreaterThan(200);
    expect(fill[1], `the fill reads ${fill}`).toBeLessThan(60);
    expect(fill[2], `the fill reads ${fill}`).toBeLessThan(60);

    // The corners of the polygon are left out (two edges meet there)
    const walk = await walkLine(page, line[0], line[1], WIDTH);
    const length = walk.dashes.length > 0 ? walk.dashes[walk.dashes.length - 1].end : 0;
    const keep = WIDTH * walk.ratio * 2;
    expectWholeDashes(innerDashes(walk, keep, length - keep), walk.ratio);
    expect(drape.used, `the drape is not in use (${drape.reason})`).toBe(true);
  });

  it('is painted once next to a solid line', async () => {
    const below = await groundAt(page, [
      { x: START_PX.x, y: START_PX.y + SOLID_OFFSET_PX },
      { x: END_PX.x, y: END_PX.y + SOLID_OFFSET_PX },
    ]);
    const style = { strokeColor: BLUE, strokeWidth: WIDTH, strokeOpacity: HALF_OPACITY };
    await replaceFeatures(page, [
      { type: 'LineString', coordinates: below, style: { ...style, lineStyle: 'solid' } },
      { type: 'LineString', coordinates: line, style: { ...style, lineStyle: 'dashed' } },
    ]);
    const drape = await capture(page);
    expect(drape.used, `the drape is not in use (${drape.reason})`).toBe(true);

    const dashed = await walkLine(page, line[0], line[1], WIDTH);
    const solid = await walkLine(page, below[0], below[1], WIDTH);
    expect(solid.dashes.length, describeDashes(solid.dashes)).toBe(1);
    expect(dashed.dashes.length, describeDashes(dashed.dashes)).toBeGreaterThanOrEqual(4);
    // Once over the white ground, the red of the line is what the opacity leaves of the ground.
    // Painted twice, the line would be darker than the solid one
    const once = solid.dashes[0].center[0];
    const report = `the solid line ${solid.dashes[0].center}, the dashes ${dashed.dashes.map((d) => d.center.join(',')).join(' ')}, the gaps ${dashed.gaps.map((g) => `${g.length}:${g.color.join(',')}`).join(' ')}`;
    expect(Math.abs(once - 255 * (1 - HALF_OPACITY)), report).toBeLessThanOrEqual(12);
    for (const dash of dashed.dashes) {
      if (dash.end - dash.start < WIDTH * dashed.ratio) continue;
      expect(Math.abs(dash.center[0] - once), report).toBeLessThanOrEqual(12);
    }
    // Nothing is in a gap that is open on the screen (where the gap is shorter than the line is
    // wide, the round caps of the dashes on either side reach into its middle)
    for (const gap of dashed.gaps) {
      if (gap.length < WIDTH * dashed.ratio) continue;
      expect(Math.min(...gap.color), report).toBeGreaterThan(230);
    }
  });
});
