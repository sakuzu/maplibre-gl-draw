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
 *   first and under the second, a point after both over both, and the draws do not follow the
 *   number of the rows
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
  binCount: number;
  elements: number;
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
): Promise<Page> {
  const page = await openMapPage(browser, bundle, camera);
  await page.evaluate(async () => {
    const w = window as unknown as {
      map: import('maplibre-gl').Map;
      e2e: {
        terrain: { addTestTerrain(map: unknown, exaggeration: number): Promise<void> };
      };
    };
    await w.e2e.terrain.addTestTerrain(w.map, 1.5);
  });
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
    ];
    const objects = await openScene(features, 'objects');
    const expected = await readFrame(objects);
    await objects.close();
    const rows = await openScene(features);
    const drape = await drapeOf(rows);
    expect(drape.used, drape.reason).toBe(true);
    const drawn = await readFrame(rows);
    let differing = 0;
    let painted = 0;
    const a = drawn.pixels;
    const b = expected.pixels;
    for (let i = 0; i < a.length; i += 4) {
      if (!(a[i] === 255 && a[i + 1] === 255 && a[i + 2] === 255)) painted++;
      for (let k = 0; k < 3; k++) {
        if (Math.abs((a[i + k] as number) - (b[i + k] as number)) > 8) {
          differing++;
          break;
        }
      }
    }
    expect(painted).toBeGreaterThan(a.length / 4 / 10);
    expect(differing / painted).toBeLessThan(0.002);

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
    // Squares with a point on each, apart from one another by more than a marker reaches on the
    // screen: nothing after a point covers it
    const scene = (n: number): FeatureInput[] => {
      const out: FeatureInput[] = [];
      for (let i = 0; i < n; i++) {
        const x = SLOPE[0] - 0.008 + (i % 20) * 0.0008;
        const y = SLOPE[1] - 0.006 + Math.floor(i / 20) * 0.0008;
        out.push(squareRow(`s${i}`, [x, y], 0.0001, RED));
        out.push(pointRow(`p${i}`, [x, y], GREEN, 3));
      }
      return out;
    };
    const draws: number[] = [];
    for (const n of [100, 400]) {
      const page = await openScene(scene(n), 'rows', { ...CAMERA, pitch: 30 });
      const drape = await drapeOf(page);
      expect(drape.used, drape.reason).toBe(true);
      expect(drape.elements).toBe(n);
      draws.push(drape.draws);
      await page.close();
    }
    expect(draws[1]).toBe(draws[0]);
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
