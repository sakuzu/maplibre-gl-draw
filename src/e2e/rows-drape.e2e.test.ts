// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the drape of the polygons and the lines of a Store of rows on the relief of
 * the test terrain (`dem-fixture.ts`), zoomed in past the analytic band and pitched:
 *
 * - The polygons and the lines of the rows paint the ground as those of a Store of objects do:
 *   the two pictures are the same, and at points of the slope facing the camera the pixel where
 *   maplibre projects the ground (`map.project`) is the color of the polygon
 * - The order of the rows holds on the drape: a point between two polygons is drawn over the
 *   first and under the second, a point after both over both, points and polygons one after the
 *   other (overlapping, some translucent) are drawn as one row at a time draws them, and the
 *   draws follow neither the number of the rows nor the points the polygons after them cover
 * - A row written in place is drawn where it is now, binning again a few tiles
 * - Rows of a moving set are drawn moved on the drape, and where they were once let go
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import { type FeatureInput, hex, load, type Rgb } from './drag-scene.js';
import { type Bundle, bundlePage, launchBrowser, openMapPage, settle } from './harness.js';

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

const RED: Rgb = [0xd0, 0x20, 0x20];
const GREEN: Rgb = [0x20, 0xa0, 0x20];
const BLUE: Rgb = [0x20, 0x40, 0xd0];
const ORANGE: Rgb = [0xc0, 0x80, 0x00];

/** South of the peak of the test terrain, on the slope that faces a camera to the south */
const SLOPE: [number, number] = [138.73, 35.352];

/** The camera: zoomed in past the analytic band, pitched */
const CAMERA = { center: SLOPE, zoom: 14.5, pitch: 62, bearing: 0 };

/** A square polygon of a color, of a half size in degrees around a place */
function squareRow(
  id: string,
  at: [number, number],
  half: number,
  color: Rgb,
  stroke: Record<string, unknown> = { strokeWidth: 0 },
): FeatureInput {
  const [x, y] = at;
  return {
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x - half, y - half],
          [x + half, y - half],
          [x + half, y + half],
          [x - half, y + half],
          [x - half, y - half],
        ],
      ],
    },
    style: { fillColor: hex(color), fillOpacity: 1, ...stroke },
  };
}

/** A point of a color */
function pointRow(id: string, at: [number, number], color: Rgb, radius = 10): FeatureInput {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: at },
    style: { pointColor: hex(color), pointRadius: radius, pointStrokeWidth: 0 },
  };
}

/** A line of a color through places */
function lineRow(id: string, places: Array<[number, number]>, color: Rgb, width = 6): FeatureInput {
  return {
    id,
    type: 'LineString',
    geometry: { type: 'LineString', coordinates: places },
    style: { strokeColor: hex(color), strokeWidth: width },
  };
}

/** The pixels of the canvas (RGBA, from the bottom), and the colors where maplibre projects places */
function readFrame(
  page: Page,
  places: Array<[number, number]> = [],
): Promise<{ pixels: number[]; at: number[][] }> {
  return page.evaluate(
    (list) =>
      new Promise((resolve) => {
        const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
        map.once('render', () => {
          const canvas = map.getCanvas();
          const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
          const width = gl.drawingBufferWidth;
          const height = gl.drawingBufferHeight;
          const pixels = new Uint8Array(width * height * 4);
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const ratio = canvas.width / canvas.clientWidth;
          const at = list.map(([lng, lat]) => {
            const p = map.project([lng, lat]);
            const x = Math.round(p.x * ratio);
            const y = height - 1 - Math.round(p.y * ratio);
            if (x < 0 || y < 0 || x >= width || y >= height) return [-1, -1, -1];
            const i = (y * width + x) * 4;
            return [pixels[i] as number, pixels[i + 1] as number, pixels[i + 2] as number];
          });
          resolve({ pixels: Array.from(pixels), at });
        });
        map.triggerRepaint();
      }),
    places,
  );
}

/**
 * The color a pixel is, of the pure colors of the rows, shaded by the terrain or not: the
 * channel well above the others (null for the ground, a mix, or a place off the canvas)
 */
function hueOf(c: readonly number[]): 'red' | 'green' | 'blue' | 'orange' | 'white' | null {
  const [r, g, b] = c as [number, number, number];
  if (r < 0) return null;
  if (r > 230 && g > 230 && b > 230) return 'white';
  if (r > 2 * g && r > 2 * b && r > 60) return 'red';
  if (g > 2 * r && g > 2 * b && g > 60) return 'green';
  if (b > 2 * r && b > 1.5 * g && b > 60) return 'blue';
  if (r > 1.2 * g && g > 2 * b && r > 100) return 'orange';
  return null;
}

/** What the drape of the rows did in the last frame */
interface DrapeDiagnostics {
  used: boolean;
  reason: string;
  draws: number;
  breaks: number;
  pointDraws: number;
  steps: number;
  deepest: number;
  tiles: number;
  binCount: number;
  elements: number;
}

const COLORS = ['#d02020', '#20a020', '#2040d0', '#c08000', '#8020c0'];

/**
 * Points and small squares one after the other on a grid, each square over the right half of
 * the point before it, one square in three translucent: the markers of the points overlap one
 * another where the grid is seen from afar
 */
function alternating(n: number, spacing: number, half: number): FeatureInput[] {
  const side = Math.ceil(Math.sqrt(n));
  const out: FeatureInput[] = [];
  for (let i = 0; i < n; i++) {
    const x = SLOPE[0] - (side / 2) * spacing + (i % side) * spacing;
    const y = SLOPE[1] - (side / 2) * spacing + Math.floor(i / side) * spacing;
    out.push({
      id: `p${i}`,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [x, y] },
      style: {
        pointColor: COLORS[(i + 2) % COLORS.length],
        pointRadius: 6,
        pointStrokeWidth: 1,
        pointStrokeColor: '#ffffff',
      },
    });
    const cx = x + half;
    out.push({
      id: `s${i}`,
      type: 'Polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [cx - half, y - half],
            [cx + half, y - half],
            [cx + half, y + half],
            [cx - half, y + half],
            [cx - half, y - half],
          ],
        ],
      },
      style: {
        fillColor: COLORS[i % COLORS.length],
        fillOpacity: i % 3 === 0 ? 0.55 : 1,
        strokeColor: '#303030',
        strokeWidth: 1,
      },
    });
  }
  return out;
}

/**
 * On each place of a grid, a point under a stack of translucent squares shifted a little one
 * from the other, a second point, and a last square
 */
function stacked(n: number, spacing: number, half: number, depth: number): FeatureInput[] {
  const side = Math.ceil(Math.sqrt(n));
  const out: FeatureInput[] = [];
  const square = (id: string, cx: number, cy: number, h: number, color: string, a: number) => ({
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [cx - h, cy - h],
          [cx + h, cy - h],
          [cx + h, cy + h],
          [cx - h, cy + h],
          [cx - h, cy - h],
        ],
      ],
    },
    style: { fillColor: color, fillOpacity: a, strokeColor: '#303030', strokeWidth: 1 },
  });
  const point = (id: string, x: number, y: number, color: string) => ({
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [x, y] },
    style: { pointColor: color, pointRadius: 6, pointStrokeWidth: 1, pointStrokeColor: '#ffffff' },
  });
  for (let i = 0; i < n; i++) {
    const x = SLOPE[0] - (side / 2) * spacing + (i % side) * spacing;
    const y = SLOPE[1] - (side / 2) * spacing + Math.floor(i / side) * spacing;
    out.push(point(`p${i}`, x, y, COLORS[i % COLORS.length] as string));
    for (let k = 0; k < depth; k++) {
      const color = COLORS[(i + k) % COLORS.length] as string;
      out.push(square(`s${i}-${k}`, x + (k * half) / depth, y, half, color, 0.4));
    }
    out.push(point(`q${i}`, x + half / 2, y, COLORS[(i + 1) % COLORS.length] as string));
    out.push(
      square(`t${i}`, x + half, y, half / 2, COLORS[(i + 3) % COLORS.length] as string, 0.7),
    );
  }
  return out;
}

/** A frame drawn with a way of keeping the order: its draws of GL, its drape and its pixels */
interface OrderedFrame {
  glDraws: number;
  drape: DrapeDiagnostics;
  pixels: number[];
}

/**
 * Draws a frame keeping the order of the rows one way (`TableDrapeOrder`; for the split, what
 * is past its last bound drawn by breaks or over)
 */
function frameWith(
  page: Page,
  order: 'split' | 'each',
  tail: 'breaks' | 'over' = 'over',
): Promise<OrderedFrame> {
  return page.evaluate(
    ({ order, tail }) => {
      const w = window as unknown as {
        map: import('maplibre-gl').Map & { redraw(): void };
        draw: unknown;
        e2e: {
          internals: {
            tableDiagnosticsOf(draw: unknown): {
              setDrapeOrder(order: string, split?: { tail?: string }): void;
              drape(): unknown;
            };
          };
        };
      };
      const hooks = w.e2e.internals.tableDiagnosticsOf(w.draw);
      hooks.setDrapeOrder(order, { tail });
      const map = w.map;
      const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext & {
        __draws?: { n: number };
      };
      if (!gl.__draws) {
        const count = { n: 0 };
        gl.__draws = count;
        for (const name of [
          'drawArrays',
          'drawElements',
          'drawArraysInstanced',
          'drawElementsInstanced',
        ] as const) {
          const original = gl[name].bind(gl) as (...args: unknown[]) => void;
          (gl as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
            count.n++;
            original(...args);
          };
        }
      }
      map.redraw();
      gl.__draws.n = 0;
      map.redraw();
      const glDraws = gl.__draws.n;
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(
        0,
        0,
        gl.drawingBufferWidth,
        gl.drawingBufferHeight,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      const drape = hooks.drape();
      hooks.setDrapeOrder('split');
      return { glDraws, drape, pixels: Array.from(pixels) } as never;
    },
    { order, tail },
  );
}

/** The pixels of a frame that are not the white of the ground */
function paintedOf(frame: OrderedFrame): number {
  let painted = 0;
  for (let i = 0; i < frame.pixels.length; i += 4) {
    if (!(frame.pixels[i] === 255 && frame.pixels[i + 1] === 255 && frame.pixels[i + 2] === 255)) {
      painted++;
    }
  }
  return painted;
}

/**
 * The pixels of the rows that differ from those of the objects by more than 8 in a channel, the
 * painted pixels, and the differing ones off the seams of the tiles: where the mesh of the tiles
 * has a crack, the drape of the objects shows the white under it and the rows may show the
 * ground seen through it (a white pixel in either picture)
 */
function differingOffSeams(
  a: readonly number[],
  b: readonly number[],
): { differing: number; offSeams: number; painted: number } {
  let differing = 0;
  let offSeams = 0;
  let painted = 0;
  const whiteish = (p: readonly number[], i: number): boolean =>
    (p[i] as number) >= 235 && (p[i + 1] as number) >= 235 && (p[i + 2] as number) >= 235;
  for (let i = 0; i < a.length; i += 4) {
    if (!(a[i] === 255 && a[i + 1] === 255 && a[i + 2] === 255)) painted++;
    for (let k = 0; k < 3; k++) {
      if (Math.abs((a[i + k] as number) - (b[i + k] as number)) > 8) {
        differing++;
        if (!whiteish(a, i) && !whiteish(b, i)) offSeams++;
        break;
      }
    }
  }
  return { differing, offSeams, painted };
}

/** The pixels of two pictures that differ by more than a step in a channel */
function differing(a: readonly number[], b: readonly number[], step = 3): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      if (Math.abs((a[i + k] as number) - (b[i + k] as number)) > step) {
        n++;
        break;
      }
    }
  }
  return n;
}

function drapeOf(page: Page): Promise<DrapeDiagnostics> {
  return page.evaluate(() => {
    const w = window as unknown as {
      draw: unknown;
      e2e: { internals: { tableDiagnosticsOf(draw: unknown): { drape(): unknown } } };
    };
    return w.e2e.internals.tableDiagnosticsOf(w.draw).drape() as DrapeDiagnostics;
  });
}

/** Waits for the frames until the drawing has no work left */
async function idle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        map: import('maplibre-gl').Map;
        draw: { hasPendingWork(): boolean };
      };
      w.map.triggerRepaint();
      return !w.draw.hasPendingWork();
    },
    undefined,
    { polling: 100, timeout: browserTimeout(30_000) },
  );
  await settle(page);
  await settle(page);
}

/** Opens the test terrain and loads features into a Store of a kind */
async function openScene(
  features: FeatureInput[],
  kind: 'rows' | 'objects' = 'rows',
  camera: typeof CAMERA = CAMERA,
  globe = false,
): Promise<Page> {
  const page = await openMapPage(browser, bundle, camera);
  // The test terrain as the map takes it by default (not exaggerated)
  await page.evaluate(async (globe) => {
    const w = window as unknown as {
      map: import('maplibre-gl').Map;
      e2e: { terrain: { addTestTerrain(map: unknown): Promise<void> } };
    };
    if (globe) w.map.setProjection({ type: 'globe' });
    await w.e2e.terrain.addTestTerrain(w.map);
  }, globe);
  await load(page, { kind, features }, camera.zoom, camera.center);
  await page.evaluate((c) => {
    const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
    map.jumpTo(c);
    // A white ground under the layers of the engine
    map.addLayer(
      { id: 'ground', type: 'background', paint: { 'background-color': '#ffffff' } },
      map.getLayersOrder()[0],
    );
  }, camera);
  await idle(page);
  return page;
}

/** The handles of rows by their ids */
function handlesOf(page: Page, ids: string[]): Promise<number[]> {
  return page.evaluate((list) => {
    const w = window as unknown as {
      store: { tables: { findRow(id: string): number | undefined } };
    };
    return list.map((id) => w.store.tables.findRow(id) as number);
  }, ids);
}

/** The colors where maplibre projects places, in each of the next frames */
function nextFrames(
  page: Page,
  places: Array<[number, number]>,
  frames: number,
): Promise<number[][][]> {
  return page.evaluate(
    ({ list, frames }) =>
      new Promise((resolve) => {
        const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
        const out: number[][][] = [];
        const read = () => {
          const canvas = map.getCanvas();
          const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
          const height = gl.drawingBufferHeight;
          const ratio = canvas.width / canvas.clientWidth;
          out.push(
            list.map(([lng, lat]) => {
              const p = map.project([lng, lat]);
              const pixel = new Uint8Array(4);
              gl.readPixels(
                Math.round(p.x * ratio),
                height - 1 - Math.round(p.y * ratio),
                1,
                1,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                pixel,
              );
              return [pixel[0] as number, pixel[1] as number, pixel[2] as number];
            }),
          );
          if (out.length >= frames) {
            map.off('render', read);
            resolve(out);
          } else {
            map.triggerRepaint();
          }
        };
        map.on('render', read);
        map.triggerRepaint();
      }),
    { list: places, frames },
  );
}

/** Puts rows into a moving set (0: out of any) and gives the set a translation */
function moveRows(page: Page, handles: number[], set: number, dLng: number, dLat: number) {
  return page.evaluate(
    ({ handles, set, dLng, dLat }) => {
      const w = window as unknown as {
        draw: unknown;
        e2e: {
          internals: {
            tableDiagnosticsOf(draw: unknown): {
              setRowsMoving(handles: number[], set: number): void;
              setMoveTranslation(set: number, dLng: number, dLat: number): void;
            };
          };
        };
      };
      const hooks = w.e2e.internals.tableDiagnosticsOf(w.draw);
      if (set > 0) {
        hooks.setRowsMoving(handles, set);
        hooks.setMoveTranslation(set, dLng, dLat);
      } else {
        hooks.setMoveTranslation(1, 0, 0);
        hooks.setRowsMoving(handles, 0);
      }
    },
    { handles, set, dLng, dLat },
  );
}

describe('the drape of the rows on the relief of the terrain', () => {
  it('paints the polygons and the lines of the rows as those of a Store of objects', {
    timeout: browserTimeout(180_000),
  }, async () => {
    const features = [
      squareRow('slope', SLOPE, 0.006, RED, { strokeColor: hex(BLUE), strokeWidth: 3 }),
      squareRow('dashed', [SLOPE[0] + 0.003, SLOPE[1] - 0.002], 0.0015, GREEN, {
        strokeColor: hex(ORANGE),
        strokeWidth: 4,
        lineStyle: 'dashed',
      }),
      lineRow(
        'line',
        [
          [SLOPE[0] - 0.008, SLOPE[1] - 0.003],
          [SLOPE[0] + 0.008, SLOPE[1] + 0.002],
        ],
        BLUE,
        5,
      ),
      // A fill without an outline, translucent, with a hole
      {
        id: 'holed',
        type: 'Polygon',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [SLOPE[0] - 0.005, SLOPE[1] - 0.004],
              [SLOPE[0] - 0.001, SLOPE[1] - 0.0045],
              [SLOPE[0] - 0.0015, SLOPE[1] - 0.001],
              [SLOPE[0] - 0.0045, SLOPE[1] - 0.0005],
              [SLOPE[0] - 0.005, SLOPE[1] - 0.004],
            ],
            [
              [SLOPE[0] - 0.0035, SLOPE[1] - 0.003],
              [SLOPE[0] - 0.0035, SLOPE[1] - 0.002],
              [SLOPE[0] - 0.0025, SLOPE[1] - 0.002],
              [SLOPE[0] - 0.0025, SLOPE[1] - 0.003],
              [SLOPE[0] - 0.0035, SLOPE[1] - 0.003],
            ],
          ],
        },
        style: { fillColor: hex(ORANGE), fillOpacity: 0.6, strokeWidth: 0 },
      },
      // Dashed and dotted lines with corners
      {
        ...lineRow(
          'dashed-line',
          [
            [SLOPE[0] - 0.007, SLOPE[1] + 0.004],
            [SLOPE[0] - 0.002, SLOPE[1] + 0.0025],
            [SLOPE[0] + 0.001, SLOPE[1] + 0.0045],
          ],
          GREEN,
          4,
        ),
        style: { strokeColor: hex(GREEN), strokeWidth: 4, lineStyle: 'dashed' },
      },
      {
        ...lineRow(
          'dotted-line',
          [
            [SLOPE[0] + 0.002, SLOPE[1] + 0.001],
            [SLOPE[0] + 0.0045, SLOPE[1] + 0.003],
            [SLOPE[0] + 0.007, SLOPE[1] + 0.0005],
          ],
          ORANGE,
          5,
        ),
        style: { strokeColor: hex(ORANGE), strokeWidth: 5, lineStyle: 'dotted' },
      },
    ];
    const objects = await openScene(features, 'objects');
    const expected = await readFrame(objects);
    await objects.close();
    const rows = await openScene(features);
    const drape = await drapeOf(rows);
    expect(drape.used, drape.reason).toBe(true);
    const drawn = await readFrame(rows);
    const off = differingOffSeams(drawn.pixels, expected.pixels);
    expect(off.painted).toBeGreaterThan(drawn.pixels.length / 4 / 10);
    // Measured (the same in every run): 842 pixels off the seams and 1,054 in all of 169,371
    // painted, in single pixels of the soft edges of the lines, of the dots and of the outlines
    // on the slopes seen at a slant (the ground is read in 16-bit places and its steps from pixel
    // to pixel, the drape of the objects from the tiles drawn) and the cracks of the mesh. A
    // fifth over them for the drivers
    expect(off.offSeams / off.painted).toBeLessThan(0.006);
    expect(off.differing / off.painted).toBeLessThan(0.0075);

    // The ground of the slope facing the camera is the color of the polygon
    const places: Array<[number, number]> = [];
    for (let i = -4; i <= 4; i++) {
      for (let j = -4; j <= 4; j++) places.push([SLOPE[0] + i * 0.0012, SLOPE[1] + j * 0.0012]);
    }
    const inside = (await readFrame(rows, places)).at.filter((c) => (c[0] as number) >= 0);
    expect(inside.length).toBeGreaterThan(40);
    // The few white pixels are the seams of the tiles the drape of the objects shows as well
    const painted2 = inside.map(hueOf).filter((h) => h === 'red' || h === 'green' || h === 'blue');
    expect(painted2.length).toBeGreaterThan(inside.length * 0.95);
    await rows.close();
  });

  it('paints the polygons and the lines of the rows as those of a Store of objects on the globe', {
    timeout: browserTimeout(180_000),
  }, async () => {
    // Zoomed out where the globe is drawn as a sphere, few enough rows for the drape band
    const camera = { center: SLOPE, zoom: 9.5, pitch: 40, bearing: 20 };
    const features = [
      squareRow('slope', SLOPE, 0.12, RED, { strokeColor: hex(BLUE), strokeWidth: 3 }),
      squareRow('dashed', [SLOPE[0] + 0.15, SLOPE[1] - 0.05], 0.05, GREEN, {
        strokeColor: hex(ORANGE),
        strokeWidth: 4,
        lineStyle: 'dashed',
      }),
      lineRow(
        'line',
        [
          [SLOPE[0] - 0.2, SLOPE[1] - 0.1],
          [SLOPE[0] + 0.2, SLOPE[1] + 0.08],
        ],
        BLUE,
        5,
      ),
    ];
    const objects = await openScene(features, 'objects', camera, true);
    const expected = await readFrame(objects);
    await objects.close();
    const rows = await openScene(features, 'rows', camera, true);
    const drape = await drapeOf(rows);
    expect(drape.used, drape.reason).toBe(true);
    const projection = await rows.evaluate(
      () => (window as unknown as { map: import('maplibre-gl').Map }).map.getProjection()?.type,
    );
    expect(projection).toBe('globe');
    const drawn = await readFrame(rows);
    const off = differingOffSeams(drawn.pixels, expected.pixels);
    expect(off.painted).toBeGreaterThan(drawn.pixels.length / 4 / 20);
    // Measured (the same in every run): 70 pixels off the seams and 92 in all of 72,585 painted,
    // in single pixels of the soft edges; a fifth over them for the drivers
    expect(off.offSeams / off.painted).toBeLessThan(0.0012);
    expect(off.differing / off.painted).toBeLessThan(0.0016);
    await rows.close();
  });

  it('hides the polygons read on the ground behind a 3D layer of the map, and not behind the ground', {
    timeout: browserTimeout(180_000),
  }, async () => {
    // A tall box of the map in front of a polygon of the rows, on the slope facing the camera
    const base: [number, number] = [SLOPE[0], SLOPE[1] - 0.0035];
    const half = 0.0006;
    const page = await openScene([squareRow('slope', SLOPE, 0.006, RED)]);
    const drape = await drapeOf(page);
    expect(drape.used, drape.reason).toBe(true);
    const before = await readFrame(page, [base]);
    await page.evaluate(
      ({ base, half }) => {
        const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
        const [x, y] = base;
        map.addSource('box', {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [x - half, y - half],
                  [x + half, y - half],
                  [x + half, y + half],
                  [x - half, y + half],
                  [x - half, y - half],
                ],
              ],
            },
          },
        });
        // Under the layer of the engine, as a 3D layer of a base map is
        const engine = map.getLayersOrder().find((id) => map.getLayer(id)?.type === 'custom');
        map.addLayer(
          {
            id: 'box',
            type: 'fill-extrusion',
            source: 'box',
            paint: {
              'fill-extrusion-color': '#2040d0',
              'fill-extrusion-height': 600,
              'fill-extrusion-opacity': 1,
            },
          },
          engine,
        );
      },
      { base, half },
    );
    await idle(page);
    const after = await readFrame(page, [base]);
    // Up the screen from the foot of the box, its face is in front of the polygon
    const [width, at] = await page.evaluate((place) => {
      const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
      const p = map.project(place);
      const ratio = map.getCanvas().width / map.getCanvas().clientWidth;
      return [map.getCanvas().width, [Math.round(p.x * ratio), Math.round(p.y * ratio)]] as const;
    }, base);
    const height = after.pixels.length / 4 / width;
    const colorAt = (pixels: number[], x: number, y: number): number[] => {
      const i = ((height - 1 - y) * width + x) * 4;
      return [pixels[i] as number, pixels[i + 1] as number, pixels[i + 2] as number];
    };
    const face = colorAt(after.pixels, at[0] as number, (at[1] as number) - 25);
    expect(hueOf(colorAt(before.pixels, at[0] as number, (at[1] as number) - 25))).toBe('red');
    expect(hueOf(face), `the face of the box: ${face}`).not.toBe('red');
    // Away from the box, the polygon is not hidden by the ground it is on
    const away = colorAt(after.pixels, (at[0] as number) + 150, (at[1] as number) - 60);
    expect(hueOf(away), `away from the box: ${away}`).toBe('red');
    await page.close();
  });

  it('keeps the order: a point between two polygons over the first and under the second', {
    timeout: browserTimeout(120_000),
  }, async () => {
    const a: [number, number] = [SLOPE[0] - 0.002, SLOPE[1]];
    const b: [number, number] = [SLOPE[0] + 0.002, SLOPE[1]];
    const page = await openScene([
      squareRow('under', SLOPE, 0.004, RED),
      pointRow('between', a, GREEN, 14),
      // Covers the point between (the point is under it)
      squareRow('over', a, 0.0012, BLUE),
      pointRow('top', b, ORANGE, 14),
    ]);
    const drape = await drapeOf(page);
    expect(drape.used, drape.reason).toBe(true);
    const [atA, atB] = (await readFrame(page, [a, b])).at;
    expect(hueOf(atA as number[]), `under the second polygon: ${atA}`).toBe('blue');
    expect(hueOf(atB as number[]), `over both: ${atB}`).toBe('orange');
    // The point covered is a break of the order; the point over everything waits for the end
    expect(drape.breaks).toBe(1);
    await page.close();
  });

  it('draws as many times whatever the number of the rows, polygons and points alternating', {
    timeout: browserTimeout(180_000),
  }, async () => {
    // Squares with a point on each, the next square over the right half of its point
    const draws: number[] = [];
    for (const n of [100, 400]) {
      const page = await openScene(alternating(n, 0.0008, 0.0001), 'rows', {
        ...CAMERA,
        pitch: 30,
      });
      const drape = await drapeOf(page);
      expect(drape.used, drape.reason).toBe(true);
      expect(drape.elements).toBe(n);
      // One split of the drape at the points of the layer: per step, a bound and a segment in
      // every tile, and the last segment
      expect(drape.breaks).toBe(1);
      expect(drape.steps).toBeGreaterThan(0);
      expect(drape.draws).toBeLessThanOrEqual((2 * drape.steps + 1) * drape.tiles);
      // The keys of the points and the points of each segment, in one draw per chunk
      expect(drape.pointDraws).toBe(2 * drape.steps + 1);
      draws.push(drape.pointDraws / (2 * drape.steps + 1));
      await page.close();
    }
    expect(draws[1]).toBe(draws[0]);
  });

  it('draws points and squares one after the other, overlapping and translucent, as one row at a time draws them', {
    timeout: browserTimeout(900_000),
  }, async () => {
    // Seen from afar at the top of the view, the markers of the grid overlap one another and the
    // squares between them
    const page = await openScene(alternating(400, 0.0008, 0.00024), 'rows', {
      ...CAMERA,
      zoom: 15,
      pitch: 60,
    });
    const split = await frameWith(page, 'split');
    expect(split.drape.used, split.drape.reason).toBe(true);
    expect(split.drape.breaks).toBe(1);
    // Every point is a break of the order: the drape painted up to it in every tile
    const each = await frameWith(page, 'each');
    expect(each.drape.breaks).toBeGreaterThan(200);
    let painted = 0;
    for (let i = 0; i < each.pixels.length; i += 4) {
      if (!(each.pixels[i] === 255 && each.pixels[i + 1] === 255 && each.pixels[i + 2] === 255)) {
        painted++;
      }
    }
    expect(painted).toBeGreaterThan(each.pixels.length / 4 / 20);
    // A few pixels at the edges of the markers on the ridge may differ from frame to frame
    expect(differing(split.pixels, each.pixels)).toBeLessThanOrEqual(painted / 10_000);
    expect(split.glDraws).toBeLessThan(each.glDraws / 10);
    await page.close();
  });

  it('draws points under stacks of translucent squares as one row at a time draws them', {
    timeout: browserTimeout(900_000),
  }, async () => {
    // On each place, a point under six translucent squares, a second point and a last square:
    // more elements after the first point of a pixel than the steps take where the cells are
    // deep, what is past the last bound drawn by the breaks there
    const page = await openScene(stacked(64, 0.0016, 0.00032, 6), 'rows', {
      ...CAMERA,
      zoom: 15,
      pitch: 45,
    });
    const split = await frameWith(page, 'split');
    expect(split.drape.used, split.drape.reason).toBe(true);
    const each = await frameWith(page, 'each');
    expect(differing(split.pixels, each.pixels)).toBeLessThanOrEqual(paintedOf(each) / 10_000);
    await page.close();
  });

  it('draws in order by breaks, when asked, the pixels with more points between the polygons than the steps take', {
    timeout: browserTimeout(900_000),
  }, async () => {
    // On each place, twelve points one after the other, each under the next translucent square:
    // twelve elements after a point in a pixel, past the most steps a split takes
    const out: FeatureInput[] = [];
    for (let i = 0; i < 9; i++) {
      const x = SLOPE[0] - 0.003 + (i % 3) * 0.003;
      const y = SLOPE[1] - 0.003 + Math.floor(i / 3) * 0.003;
      for (let k = 0; k < 12; k++) {
        const at: [number, number] = [x + k * 0.00002, y];
        out.push({
          id: `p${i}-${k}`,
          type: 'Point',
          geometry: { type: 'Point', coordinates: at },
          style: { pointColor: COLORS[(i + k) % COLORS.length], pointRadius: 8 },
        });
        out.push({
          ...squareRow(`s${i}-${k}`, at, 0.00012, RED),
          style: {
            fillColor: COLORS[(i + k + 2) % COLORS.length],
            fillOpacity: 0.35,
            strokeWidth: 0,
          },
        });
      }
    }
    const page = await openScene(out, 'rows', { ...CAMERA, zoom: 15, pitch: 30 });
    const each = await frameWith(page, 'each');
    // Past the last bound drawn by the breaks of the cells deeper than the steps: in order
    const breaks = await frameWith(page, 'split', 'breaks');
    expect(breaks.drape.used, breaks.drape.reason).toBe(true);
    expect(breaks.drape.deepest).toBeGreaterThan(breaks.drape.steps);
    expect(breaks.drape.breaks).toBeGreaterThan(1);
    expect(differing(breaks.pixels, each.pixels)).toBeLessThanOrEqual(paintedOf(each) / 10_000);
    // Past the last bound drawn as one segment (as a split draws it): the points there are over
    // the squares after them, in the pixels with more than the steps
    const over = await frameWith(page, 'split');
    expect(over.drape.breaks).toBe(1);
    const off = differing(over.pixels, each.pixels);
    console.info(
      `more points between the polygons than the steps take: ${off} pixels out of order`,
    );
    expect(off).toBeGreaterThan(paintedOf(each) / 10_000);
    await page.close();
  });

  it('draws 2 x 10,000 points and squares one after the other at zoom 15 in a few draws', {
    timeout: browserTimeout(300_000),
  }, async () => {
    const page = await openScene(alternating(10_000, 0.0004, 0.00012), 'rows', {
      ...CAMERA,
      zoom: 15,
      pitch: 45,
    });
    const split = await frameWith(page, 'split');
    expect(split.drape.used, split.drape.reason).toBe(true);
    expect(split.drape.elements).toBe(10_000);
    // The draws of the frame, recorded with the test
    console.info(
      `2 x 10,000 alternating, zoom 15, pitch 45: ${split.glDraws} draws of GL, drape ${split.drape.draws} over ${split.drape.tiles} tiles, points ${split.drape.pointDraws}, ${split.drape.steps} steps (the deepest pixel reads ${split.drape.deepest} runs), ${split.drape.breaks} breaks`,
    );
    expect(split.drape.draws).toBeLessThanOrEqual(
      (2 * split.drape.steps + 1) * split.drape.tiles + split.drape.breaks * split.drape.tiles,
    );
    // The draws of GL of the whole frame (the terrain and the other layers of maplibre with them)
    expect(split.glDraws).toBeLessThan(1_000);
    await page.close();
  });

  it('draws a row written in place where it is now, binning again a few tiles', {
    timeout: browserTimeout(120_000),
  }, async () => {
    const features: FeatureInput[] = [];
    for (let i = 0; i < 200; i++) {
      const x = SLOPE[0] - 0.008 + (i % 20) * 0.0008;
      const y = SLOPE[1] - 0.006 + Math.floor(i / 20) * 0.0012;
      features.push(squareRow(`s${i}`, [x, y], 0.0002, BLUE));
    }
    const from: [number, number] = [SLOPE[0] - 0.0028, SLOPE[1] - 0.0015];
    features.push(squareRow('moved', from, 0.0008, RED));
    const page = await openScene(features);
    const before = await drapeOf(page);
    expect(before.used, before.reason).toBe(true);
    const to: [number, number] = [SLOPE[0] + 0.0028, SLOPE[1] + 0.0015];
    await page.evaluate((target) => {
      const w = window as unknown as {
        draw: { features: { update(id: string, patch: unknown): unknown } };
      };
      const [x, y] = target;
      const h = 0.0008;
      w.draw.features.update('moved', {
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [x - h, y - h],
              [x + h, y - h],
              [x + h, y + h],
              [x - h, y + h],
              [x - h, y - h],
            ],
          ],
        },
      });
    }, to);
    await idle(page);
    const after = await drapeOf(page);
    const [atOld, atNew] = (await readFrame(page, [from, to])).at;
    expect(hueOf(atNew as number[]), `where it is now: ${atNew}`).toBe('red');
    expect(hueOf(atOld as number[]), `where it was: ${atOld}`).not.toBe('red');
    // The partition of the row in the tiles its boxes touch, before and after
    expect(after.binCount - before.binCount).toBeGreaterThan(0);
    expect(after.binCount - before.binCount).toBeLessThanOrEqual(8);
    await page.close();
  });

  it('draws the rows of a moving set moved on the drape, and back where they were', {
    timeout: browserTimeout(120_000),
  }, async () => {
    const from: [number, number] = [SLOPE[0] - 0.003, SLOPE[1] - 0.001];
    const page = await openScene([
      squareRow('ground', SLOPE, 0.006, BLUE),
      squareRow('moved', from, 0.0008, RED),
    ]);
    const [handle] = await handlesOf(page, ['moved']);
    const to: [number, number] = [from[0] + 0.006, from[1] + 0.002];
    await moveRows(page, [handle as number], 1, 0.006, 0.002);
    await idle(page);
    const moved = await drapeOf(page);
    expect(moved.used, moved.reason).toBe(true);
    const [atFrom, atTo] = (await readFrame(page, [from, to])).at;
    expect(hueOf(atTo as number[]), `moved: ${atTo}`).toBe('red');
    expect(hueOf(atFrom as number[]), `where it was taken from: ${atFrom}`).toBe('blue');

    await moveRows(page, [handle as number], 0, 0, 0);
    await idle(page);
    const [backFrom, backTo] = (await readFrame(page, [from, to])).at;
    expect(hueOf(backFrom as number[]), `back: ${backFrom}`).toBe('red');
    expect(hueOf(backTo as number[]), `not moved any more: ${backTo}`).toBe('blue');
    await page.close();
  });

  it('moves rows selected in bulk from the first frame of their drag, and does not jump when let go', {
    timeout: browserTimeout(120_000),
  }, async () => {
    const from: [number, number] = [SLOPE[0] - 0.003, SLOPE[1] - 0.001];
    const page = await openScene([
      squareRow('ground', SLOPE, 0.006, BLUE),
      squareRow('moved', from, 0.0008, RED),
    ]);
    const [handle] = await handlesOf(page, ['moved']);
    // Selected in bulk: the index of the rows to drag is built before the drag
    await page.evaluate((h) => {
      const w = window as unknown as {
        draw: unknown;
        e2e: {
          internals: {
            tableDiagnosticsOf(draw: unknown): {
              setRowsMarked(handles: number[], marked: boolean): void;
            };
          };
        };
      };
      w.e2e.internals.tableDiagnosticsOf(w.draw).setRowsMarked([h], true);
    }, handle as number);
    await idle(page);
    const to: [number, number] = [from[0] + 0.006, from[1] + 0.002];
    // The set of the features selected in bulk
    await moveRows(page, [handle as number], 2, 0.006, 0.002);
    const [first] = await nextFrames(page, [from, to], 1);
    expect(hueOf((first as number[][])[1] as number[]), 'moved in the first frame').toBe('red');
    expect(hueOf((first as number[][])[0] as number[]), 'not left where it was').toBe('blue');

    // Let go: written where it was dragged to, and out of the set, in the same task
    await page.evaluate(
      ({ h, target }) => {
        const w = window as unknown as {
          draw: {
            features: { update(id: string, patch: unknown): unknown };
          };
          e2e: {
            internals: {
              tableDiagnosticsOf(draw: unknown): {
                setRowsMoving(handles: number[], set: number): void;
                setMoveTranslation(set: number, dLng: number, dLat: number): void;
              };
            };
          };
        };
        const [x, y] = target;
        const s = 0.0008;
        w.draw.features.update('moved', {
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [x - s, y - s],
                [x + s, y - s],
                [x + s, y + s],
                [x - s, y + s],
                [x - s, y - s],
              ],
            ],
          },
        });
        const hooks = w.e2e.internals.tableDiagnosticsOf(w.draw);
        hooks.setRowsMoving([h], 0);
        hooks.setMoveTranslation(2, 0, 0);
      },
      { h: handle as number, target: to },
    );
    const frames = await nextFrames(page, [from, to], 6);
    frames.forEach((colors, i) => {
      expect(hueOf(colors[1] as number[]), `where it was let go, frame ${i}`).toBe('red');
      expect(hueOf(colors[0] as number[]), `not back where it was, frame ${i}`).toBe('blue');
    });
    await page.close();
  });
});
