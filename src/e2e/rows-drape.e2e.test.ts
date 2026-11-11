// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the polygons and the lines of a Store of rows read on the ground of the
 * relief of the test terrain (`dem-fixture.ts`), zoomed in past the analytic band and pitched:
 *
 * - They are drawn where maplibre projects the ground (`map.project`): the centers of lines within
 *   half a pixel of it, and at points of the slope facing the camera the pixel there is the color
 *   of the polygon. While maplibre draws the globe they are drawn as out of the band, in order
 * - The order of the rows holds: a point between two polygons is drawn over the first and under
 *   the second, a picture among them where it is, and points and polygons one after the other
 *   (overlapping, translucent, twenty deep on a pixel) as one row at a time on the drape draws
 *   them (nothing inside a difference), in draws that do not follow the number of the rows
 * - A 3D layer of the map in front of the ground hides them, the ground they are on does not
 * - A row written in place is drawn where it is now; rows of a moving set are drawn moved, and
 *   where they were once let go
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import { type FeatureInput, hex, load, type Rgb } from './drag-scene.js';
import {
  type Bundle,
  bundlePage,
  type E2EWrites,
  launchBrowser,
  openMapPage,
  settle,
} from './harness.js';

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

/** The Mercator coordinates of a longitude and a latitude */
function mercatorOf([lng, lat]: readonly [number, number]): [number, number] {
  return [(lng + 180) / 360, 0.5 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / (2 * Math.PI)];
}

/** The longitude and the latitude of Mercator coordinates */
function lngLatOf([x, y]: readonly [number, number]): [number, number] {
  return [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI];
}

/** The width of the lines held to where maplibre projects them (CSS px) */
const LINE_WIDTH = 3;

/**
 * How far the centers of blue lines of `LINE_WIDTH` on the white ground are from where maplibre
 * projects places on them (`map.project`, which takes the ground under them), in device px, by
 * thirds of the screen from the top (far from the camera) to the bottom
 *
 * The places of a line are given in their order along it. The line is read across it at each,
 * from its pixels, by the share of blue of each (from white to the blue): its center is where
 * that share weighs. Places by the ends of a run, by the edges of the canvas, hidden behind the
 * ground in front (where maplibre finds the ground elsewhere: `map.unproject`), by another line,
 * or where the line read across is not of its width (hidden in part) are left out.
 */
async function lineOffsets(
  page: Page,
  lines: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
): Promise<{ count: number; bands: Array<{ count: number; worst: number }> }> {
  // The places, and the runs of them along each line
  const places: Array<[number, number]> = [];
  const runs: Array<[number, number]> = [];
  for (const line of lines) {
    const start = places.length;
    for (const place of line) places.push([place[0], place[1]]);
    runs.push([start, places.length]);
  }
  const { pixels, projected, width, height } = await page.evaluate(
    (list) =>
      new Promise<{ pixels: number[]; projected: number[][]; width: number; height: number }>(
        (resolve) => {
          const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
          map.once('render', () => {
            const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
            const w = gl.drawingBufferWidth;
            const h = gl.drawingBufferHeight;
            const px = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
            const ratio = w / map.getCanvas().clientWidth;
            // Where maplibre projects each place, and the place it finds the ground at there (a
            // place hidden behind the ground in front is not found again)
            const projected = list.map(([lng, lat]) => {
              const p = map.project([lng, lat]);
              const back = map.unproject(p);
              return [p.x * ratio, p.y * ratio, back.lng - lng, back.lat - lat];
            });
            resolve({ pixels: Array.from(px), projected, width: w, height: h });
          });
          map.triggerRepaint();
        },
      ),
    places,
  );
  // The share of blue of a place of the canvas (device px, y down), between its four pixels
  const blueAt = (x: number, y: number): number => {
    const at = (i: number, j: number): number => {
      const ci = Math.min(Math.max(i, 0), width - 1);
      const cj = Math.min(Math.max(j, 0), height - 1);
      const r = pixels[((height - 1 - cj) * width + ci) * 4] as number;
      return Math.min(Math.max((255 - r) / (255 - (BLUE[0] as number)), 0), 1);
    };
    const i = Math.floor(x - 0.5);
    const j = Math.floor(y - 0.5);
    const fx = x - 0.5 - i;
    const fy = y - 0.5 - j;
    return (
      (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) +
      (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy
    );
  };
  const bands = [0, 1, 2].map(() => ({ count: 0, worst: 0 }));
  let count = 0;
  const step = 0.25;
  for (const [from, to] of runs) {
    for (let k = from + 2; k < to - 2; k++) {
      const p = projected[k] as [number, number, number, number];
      // Hidden behind the ground in front: maplibre finds the ground elsewhere there
      if (Math.hypot(p[2], p[3]) > 1e-6) continue;
      // By another line (where they cross, the line read across meets the other)
      let near = false;
      for (const [otherFrom, otherTo] of runs) {
        if (otherFrom === from) continue;
        for (let o = otherFrom; o < otherTo && !near; o++) {
          const q = projected[o] as [number, number];
          if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 8) near = true;
        }
      }
      if (near) continue;
      const before = projected[k - 1] as [number, number];
      const after = projected[k + 1] as [number, number];
      const tx = after[0] - before[0];
      const ty = after[1] - before[1];
      const length = Math.hypot(tx, ty);
      if (!(length > 0)) continue;
      const nx = -ty / length;
      const ny = tx / length;
      if (p[0] < 8 || p[1] < 8 || p[0] > width - 8 || p[1] > height - 8) continue;
      let sum = 0;
      let moment = 0;
      for (let s = -6; s <= 6; s += step) {
        const ink = blueAt(p[0] + nx * s, p[1] + ny * s);
        sum += ink * step;
        moment += ink * s * step;
      }
      // The whole width of the line across it, and nothing more
      if (Math.abs(sum - LINE_WIDTH) > 0.3) continue;
      const offset = Math.abs(moment / sum);
      const band = Math.min(2, Math.floor((p[1] / height) * 3));
      const entry = bands[band] as { count: number; worst: number };
      entry.count++;
      entry.worst = Math.max(entry.worst, offset);
      count++;
    }
  }
  return { count, bands };
}

/** What the drape of the rows did in the last frame */
interface DrapeDiagnostics {
  used: boolean;
  reason: string;
  draws: number;
  breaks: number;
  pointDraws: number;
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
 * Draws a frame keeping the order of the rows one way (`TableDrapeOrder`: the ground, or the
 * reference one row at a time on the drape of the rows, built over the frames it takes)
 */
function frameWith(page: Page, order: 'ground' | 'each'): Promise<OrderedFrame> {
  return page.evaluate(
    ({ order }) => {
      const w = window as unknown as {
        map: import('maplibre-gl').Map & { redraw(): void };
        draw: { hasPendingWork(): boolean };
        e2e: {
          internals: {
            tableDiagnosticsOf(draw: unknown): {
              setDrapeOrder(order: string): void;
              drape(): { used: boolean };
            };
          };
        };
      };
      const hooks = w.e2e.internals.tableDiagnosticsOf(w.draw);
      hooks.setDrapeOrder(order);
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
      // The reference builds its drape over the frames; the ground packs the rows again
      for (let i = 0; i < 400; i++) {
        map.redraw();
        if (!w.draw.hasPendingWork() && hooks.drape().used) break;
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
      hooks.setDrapeOrder('ground');
      return { glDraws, drape, pixels: Array.from(pixels) } as never;
    },
    { order },
  );
}

/**
 * The pixels of two frames that differ by more than a step in a channel, and of them those inside
 * a difference: the 5 x 5 pixels around them all differ (out of order, not a soft edge)
 */
function differingInside(
  a: readonly number[],
  b: readonly number[],
  width: number,
): { differing: number; inside: number } {
  const height = a.length / 4 / width;
  const off = new Uint8Array(width * height);
  let differing = 0;
  for (let p = 0; p < width * height; p++) {
    for (let k = 0; k < 3; k++) {
      if (Math.abs((a[p * 4 + k] as number) - (b[p * 4 + k] as number)) > 24) {
        off[p] = 1;
        differing++;
        break;
      }
    }
  }
  let inside = 0;
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      let all = true;
      for (let dy = -2; dy <= 2 && all; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!off[(y + dy) * width + x + dx]) {
            all = false;
            break;
          }
        }
      }
      if (all) inside++;
    }
  }
  return { differing, inside };
}

/** The width of the canvas of a page (device pixels) */
function canvasWidthOf(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { map: import('maplibre-gl').Map }).map.getCanvas().width,
  );
}

/** The pixels of a frame that are not the white of the ground */
function paintedOf(frame: Pick<OrderedFrame, 'pixels'>): number {
  let painted = 0;
  for (let i = 0; i < frame.pixels.length; i += 4) {
    if (!(frame.pixels[i] === 255 && frame.pixels[i + 1] === 255 && frame.pixels[i + 2] === 255)) {
      painted++;
    }
  }
  return painted;
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
  images: Record<string, string> = {},
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
  await load(page, { kind, features, images }, camera.zoom, camera.center);
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
      store: { tables: { getRowRef(id: string): number | undefined } };
    };
    return list.map((id) => w.store.tables.getRowRef(id) as number);
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
  it('paints the polygons and the lines of the rows, the slope facing the camera in its color', {
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
    const rows = await openScene(features);
    const drape = await drapeOf(rows);
    expect(drape.used, drape.reason).toBe(true);
    const drawn = await readFrame(rows);
    expect(paintedOf({ pixels: drawn.pixels })).toBeGreaterThan(drawn.pixels.length / 4 / 10);

    // The ground of the slope facing the camera is the color of the polygon
    const places: Array<[number, number]> = [];
    for (let i = -4; i <= 4; i++) {
      for (let j = -4; j <= 4; j++) places.push([SLOPE[0] + i * 0.0012, SLOPE[1] + j * 0.0012]);
    }
    const inside = (await readFrame(rows, places)).at.filter((c) => (c[0] as number) >= 0);
    expect(inside.length).toBeGreaterThan(40);
    const painted2 = inside.map(hueOf).filter((h) => h === 'red' || h === 'green' || h === 'blue');
    expect(painted2.length).toBeGreaterThan(inside.length * 0.95);
    await rows.close();
  });

  it('draws the lines of the rows where maplibre projects the ground under them', {
    timeout: browserTimeout(180_000),
  }, async () => {
    // Lines along the rows and the columns of the nodes of the terrain mesh (of the tiles of zoom
    // 8, so of the finer tiles too), near the camera, at the center and far from it, on the white
    // ground. At a node, the mesh maplibre draws and the DEM maplibre projects a place with
    // (`map.project`) are at the same elevation; between the nodes the flat triangles of the mesh
    // part from the DEM by meters on the ridges of the test terrain. The centers of the lines are
    // read at the nodes of the tiles drawn under them
    const node = 1 / (2 ** 8 * 128);
    const [cx, cy] = mercatorOf(SLOPE);
    const rows = [-1, 0, 1, 2, 3].map((k) => (Math.round(cy / node) + k) * node);
    const columns = [-3, -2, -1, 0, 1, 2, 3].map((k) => (Math.round(cx / node) + k) * node);
    const reach = 0.01 / 360;
    const lines: Array<Array<[number, number]>> = [
      ...rows.map(
        (y): Array<[number, number]> => [lngLatOf([cx - reach, y]), lngLatOf([cx + reach, y])],
      ),
      ...columns.map(
        (x): Array<[number, number]> => [lngLatOf([x, cy - reach]), lngLatOf([x, cy + reach])],
      ),
    ];
    const page = await openScene(
      lines.map((places, i) => lineRow(`line-${i}`, places, BLUE, LINE_WIDTH)),
    );
    const drape = await drapeOf(page);
    expect(drape.used, drape.reason).toBe(true);
    // The tiles of the terrain drawn: every one at zoom 8 or finer (their nodes hold those of the
    // rows and the columns of the lines)
    const tiles = await page.evaluate(() => {
      const w = window as unknown as {
        map: unknown;
        e2e: {
          internals: {
            getMapTerrain(map: unknown): unknown;
            getRenderableTerrainTiles(terrain: unknown): Array<{ x: number; y: number; z: number }>;
          };
        };
      };
      const terrain = w.e2e.internals.getMapTerrain(w.map);
      return w.e2e.internals.getRenderableTerrainTiles(terrain).map(({ x, y, z }) => ({ x, y, z }));
    });
    expect(Math.min(...tiles.map((t) => t.z))).toBeGreaterThanOrEqual(8);
    // The places read: the nodes on the lines of the tile drawn under each
    const runs: Array<Array<[number, number]>> = [];
    const along = (from: [number, number], to: [number, number]): void => {
      const run: Array<[number, number]> = [];
      const steps = 4000;
      let last = '';
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = from[0] + (to[0] - from[0]) * t;
        const y = from[1] + (to[1] - from[1]) * t;
        const tile = tiles.find((c) => {
          const size = 1 / 2 ** c.z;
          return x >= c.x * size && x < (c.x + 1) * size && y >= c.y * size && y < (c.y + 1) * size;
        });
        if (!tile) continue;
        const step = 1 / (2 ** tile.z * 128);
        const at: [number, number] =
          from[0] === to[0] ? [x, Math.round(y / step) * step] : [Math.round(x / step) * step, y];
        const key = `${at[0]},${at[1]}`;
        if (key === last) continue;
        last = key;
        run.push(lngLatOf(at));
      }
      runs.push(run);
    };
    for (const y of rows) along([cx - reach, y], [cx + reach, y]);
    for (const x of columns) along([x, cy - reach], [x, cy + reach]);
    const read = await lineOffsets(page, runs);
    // Measured (the same in every run), at 296 nodes: 0.07 px at most far from the camera (the top
    // third of the screen, 25 nodes), 0.25 at the center (187) and 0.18 near the camera (84)
    expect(read.count).toBeGreaterThan(200);
    for (const band of read.bands) {
      expect(band.count, JSON.stringify(read.bands)).toBeGreaterThan(20);
      // Within half a pixel of where maplibre projects the ground
      expect(band.worst, JSON.stringify(read.bands)).toBeLessThan(0.5);
    }
    await page.close();
  });

  for (const [what, camera] of [
    ['on the globe alone', { center: SLOPE, zoom: 9.5, pitch: 40, bearing: 20 }],
    ['in the transition of the globe', { center: SLOPE, zoom: 11.5, pitch: 45, bearing: 20 }],
  ] as const) {
    it(`draws the rows as out of the band ${what}, in their order`, {
      timeout: browserTimeout(180_000),
    }, async () => {
      // While maplibre draws the globe the ground is not read back (maplibre-coupling.md, item
      // 31): the rows are drawn as they are cut for the surface, in the order of the rows. A
      // point under a larger square drawn after it is hidden whole, one drawn last is seen
      const span = camera.zoom < 10 ? 0.04 : 0.006;
      const a: [number, number] = [SLOPE[0] - span / 2, SLOPE[1]];
      const b: [number, number] = [SLOPE[0] + span / 2, SLOPE[1]];
      const page = await openScene(
        [
          squareRow('under', SLOPE, span, RED),
          pointRow('between', a, GREEN, 5),
          squareRow('over', a, span * 0.45, BLUE),
          pointRow('top', b, ORANGE, 8),
        ],
        'rows',
        camera,
        true,
      );
      const projection = await page.evaluate(() => {
        const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
        return map.getProjection()?.type;
      });
      expect(projection).toBe('globe');
      const drape = await drapeOf(page);
      expect(drape.used).toBe(false);
      expect(drape.reason).toBe('ground-globe');
      const { pixels } = await readFrame(page);
      const hues = { red: 0, green: 0, blue: 0, orange: 0 };
      for (let i = 0; i < pixels.length; i += 4) {
        const hue = hueOf([pixels[i] as number, pixels[i + 1] as number, pixels[i + 2] as number]);
        if (hue && hue !== 'white') hues[hue]++;
      }
      expect(hues.red, JSON.stringify(hues)).toBeGreaterThan(100);
      expect(hues.blue, JSON.stringify(hues)).toBeGreaterThan(50);
      expect(hues.orange, JSON.stringify(hues)).toBeGreaterThan(50);
      // The point between is under the square over it
      expect(hues.green, JSON.stringify(hues)).toBe(0);
      await page.close();
    });
  }

  it('draws a picture of the rows on the terrain at its place among the polygons read on the ground', {
    timeout: browserTimeout(120_000),
  }, async () => {
    const at: [number, number] = [SLOPE[0], SLOPE[1] - 0.001];
    const covered: [number, number] = [at[0] + 0.0012, at[1]];
    const page = await openScene(
      [
        squareRow('under', SLOPE, 0.005, RED),
        {
          id: 'picture',
          type: 'Image',
          geometry: { type: 'Point', coordinates: at },
          properties: {
            'maplibre-gl-draw:createdZoom': CAMERA.zoom,
            'maplibre-gl-draw:imageFileId': 'green',
            'maplibre-gl-draw:imageWidth': 400,
            'maplibre-gl-draw:imageHeight': 400,
          },
          style: { imageOpacity: 1 },
        },
        // Over the east part of the picture
        squareRow('over', covered, 0.0008, BLUE),
      ],
      'rows',
      CAMERA,
      false,
      { green: hex(GREEN) },
    );
    const drape = await drapeOf(page);
    expect(drape.used, drape.reason).toBe(true);
    const [atPicture, atCovered] = (await readFrame(page, [at, covered])).at;
    expect(hueOf(atPicture as number[]), `the picture over the first polygon: ${atPicture}`).toBe(
      'green',
    );
    expect(hueOf(atCovered as number[]), `the second polygon over the picture: ${atCovered}`).toBe(
      'blue',
    );
    await page.close();
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
    // Read on the ground, the rows draw no drape and no break of the order
    expect(drape.draws).toBe(0);
    expect(drape.breaks).toBe(0);
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
      const ground = await frameWith(page, 'ground');
      expect(ground.drape.used, ground.drape.reason).toBe(true);
      expect(ground.drape.elements).toBe(n);
      draws.push(ground.glDraws);
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
    const ground = await frameWith(page, 'ground');
    expect(ground.drape.used, ground.drape.reason).toBe(true);
    // Every point is a break of the order: the drape painted up to it in every tile
    const each = await frameWith(page, 'each');
    expect(each.drape.breaks).toBeGreaterThan(200);
    expect(paintedOf(each)).toBeGreaterThan(each.pixels.length / 4 / 20);
    // In order everywhere: what differs is the soft edges, nothing inside a difference
    const off = differingInside(ground.pixels, each.pixels, await canvasWidthOf(page));
    expect(off.inside, `out of order: ${JSON.stringify(off)}`).toBe(0);
    expect(ground.glDraws).toBeLessThan(each.glDraws / 10);
    await page.close();
  });

  it('draws points under stacks of translucent squares as one row at a time draws them', {
    timeout: browserTimeout(900_000),
  }, async () => {
    // On each place, a point under six translucent squares, a second point and a last square
    const page = await openScene(stacked(64, 0.0016, 0.00032, 6), 'rows', {
      ...CAMERA,
      zoom: 15,
      pitch: 45,
    });
    const ground = await frameWith(page, 'ground');
    expect(ground.drape.used, ground.drape.reason).toBe(true);
    const each = await frameWith(page, 'each');
    const off = differingInside(ground.pixels, each.pixels, await canvasWidthOf(page));
    expect(off.inside, `out of order: ${JSON.stringify(off)}`).toBe(0);
    await page.close();
  });

  it('draws points and translucent squares twenty times one after the other on a pixel as one row at a time draws them', {
    timeout: browserTimeout(900_000),
  }, async () => {
    // On each place, twenty points one after the other, each under the next translucent square
    const out: FeatureInput[] = [];
    for (let i = 0; i < 9; i++) {
      const x = SLOPE[0] - 0.003 + (i % 3) * 0.003;
      const y = SLOPE[1] - 0.003 + Math.floor(i / 3) * 0.003;
      for (let k = 0; k < 20; k++) {
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
    const ground = await frameWith(page, 'ground');
    expect(ground.drape.used, ground.drape.reason).toBe(true);
    const each = await frameWith(page, 'each');
    const off = differingInside(ground.pixels, each.pixels, await canvasWidthOf(page));
    expect(off.inside, `out of order: ${JSON.stringify(off)}`).toBe(0);
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
    const ground = await frameWith(page, 'ground');
    expect(ground.drape.used, ground.drape.reason).toBe(true);
    expect(ground.drape.elements).toBe(10_000);
    // The draws of GL of the whole frame (the terrain and the other layers of maplibre with them)
    console.info(`2 x 10,000 alternating, zoom 15, pitch 45: ${ground.glDraws} draws of GL`);
    expect(ground.glDraws).toBeLessThan(100);
    await page.close();
  });

  it('draws a row written in place where it is now', {
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
      const w = window as unknown as E2EWrites & { draw: import('../index.js').Draw };
      const [x, y] = target;
      const h = 0.0008;
      w.e2e.writesOf(w.draw).features.update('moved', {
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
    const [atOld, atNew] = (await readFrame(page, [from, to])).at;
    expect(hueOf(atNew as number[]), `where it is now: ${atNew}`).toBe('red');
    expect(hueOf(atOld as number[]), `where it was: ${atOld}`).not.toBe('red');
    await page.close();
  });

  it('keeps drawing the rows as they are packed while they are packed again across the band', {
    timeout: browserTimeout(600_000),
  }, async () => {
    // Enough edges for the band to end at zoom 11 (more than the wide budget of the drape)
    const features: FeatureInput[] = [];
    for (let i = 0; i < 6400; i++) {
      const x = SLOPE[0] - 0.04 + (i % 80) * 0.001;
      const y = SLOPE[1] - 0.04 + Math.floor(i / 80) * 0.001;
      features.push(squareRow(`s${i}`, [x, y], 0.0004, RED));
    }
    const near = { ...CAMERA, zoom: 13, pitch: 40 };
    const far = { ...CAMERA, zoom: 10.5, pitch: 40 };
    const page = await openScene(features, 'rows', near);
    const inBand = await drapeOf(page);
    expect(inBand.used, inBand.reason).toBe(true);
    // Jumps and draws frames at once (each right after the other, as a page asking for frames
    // does), the pixels of each on a grid of every 8th pixel
    const jumpAndDraw = (camera: typeof CAMERA, frames: number): Promise<number[][]> =>
      page.evaluate(
        ({ c, frames }) => {
          const map = (window as unknown as { map: import('maplibre-gl').Map & { redraw(): void } })
            .map;
          map.jumpTo(c);
          const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
          const out: number[][] = [];
          for (let f = 0; f < frames; f++) {
            map.redraw();
            const width = gl.drawingBufferWidth;
            const height = gl.drawingBufferHeight;
            const pixels = new Uint8Array(width * height * 4);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            const grid: number[] = [];
            for (let y = 0; y < height; y += 8) {
              for (let x = 0; x < width; x += 8) {
                const at = (y * width + x) * 4;
                grid.push(pixels[at] as number, pixels[at + 1] as number, pixels[at + 2] as number);
              }
            }
            out.push(grid);
          }
          return out;
        },
        { c: camera, frames },
      );
    // The samples where the rows are in one frame and not in the other (the terrain under them
    // may change as its tiles come)
    const differ = (a: number[], b: number[]): number => {
      let n = 0;
      for (let i = 0; i < a.length; i += 3) {
        const inA = hueOf(a.slice(i, i + 3)) === 'red';
        const inB = hueOf(b.slice(i, i + 3)) === 'red';
        if (inA !== inB) n++;
      }
      return n;
    };
    const across = async (camera: typeof CAMERA, what: string, strict: boolean): Promise<void> => {
      const frames = await jumpAndDraw(camera, 8);
      // The last frame drawn: the rows cut for the surface of the frame or packed for the ground
      const last = frames[frames.length - 1] as number[];
      const rows = last.reduce(
        (n, _, i, all) => (i % 3 === 0 && hueOf(all.slice(i, i + 3)) === 'red' ? n + 1 : n),
        0,
      );
      expect(rows, what).toBeGreaterThan(50);
      const off = frames.map((frame) => differ(frame, last));
      const counts = frames.map((frame) =>
        frame.reduce(
          (n, _, i, all) => (i % 3 === 0 && hueOf(all.slice(i, i + 3)) === 'red' ? n + 1 : n),
          0,
        ),
      );
      const note = `${what}: ${off.join(', ')} differ, ${counts.join(', ')} of the rows`;
      for (let f = 0; f < frames.length; f++) {
        // No frame leaves the rows out
        expect(counts[f] as number, note).toBeGreaterThan(rows * 0.8);
        // Out of the band, every frame from the jump on draws them where the last one does
        // (within a few samples of their soft edges). Into it, the rows are drawn as they were
        // cut until their packing for the ground starts (the first frame)
        if (strict || f > 0) expect(off[f] as number, note).toBeLessThan(rows / 50);
      }
      await idle(page);
    };
    // The tiles of the terrain of both views loaded first (what is measured is the rows)
    await jumpAndDraw(far, 1);
    await idle(page);
    await jumpAndDraw(near, 1);
    await idle(page);
    // Out of the band: the rows packed for the ground are drawn reading it until they are cut
    // again for the terrain, then as they are cut
    await across(far, 'out of the band', true);
    expect((await drapeOf(page)).reason).toBe('wide-zoom');
    // Into the band: the rows cut for the terrain are drawn as they are cut until they are packed
    // for the ground
    await across(near, 'into the band', false);
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
          draw: import('../index.js').Draw;
          e2e: E2EWrites['e2e'] & {
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
        // The internal write, synchronous: the rows leave the set in the task they are written
        w.e2e.writesOf(w.draw).features.update('moved', {
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
