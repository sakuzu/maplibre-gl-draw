// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Measures of the ways the drape of the rows keeps the order among the points drawn between its
 * polygons (a prototype: printed, not asserted)
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import { type FeatureInput, hex, load } from './drag-scene.js';
import { type Bundle, bundlePage, launchBrowser, openMapPage, settle } from './harness.js';

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

const SLOPE: [number, number] = [138.73, 35.352];

const COLORS = ['#d02020', '#20a020', '#2040d0', '#c08000', '#8020c0'];

/** The width of the outlines of the squares */
const STROKE = Number(process.env.DRAPE_ORDER_STROKE ?? 1);

/** Points and small squares, one after the other, the square over a part of its point */
function alternating(n: number, spacing: number, half: number): FeatureInput[] {
  const side = Math.ceil(Math.sqrt(n));
  const out: FeatureInput[] = [];
  for (let i = 0; i < n; i++) {
    const x = SLOPE[0] - (side / 2) * spacing + (i % side) * spacing;
    const y = SLOPE[1] - (side / 2) * spacing + Math.floor(i / side) * spacing;
    out.push(point(`p${i}`, [x, y], i + 2));
    out.push(square(`s${i}`, [x + half, y], half, i, i % 3 === 0 ? 0.55 : 1));
  }
  return out;
}

/**
 * On each place of a grid, a point under a stack of translucent squares shifted a little one
 * from the other, a second point, and a last square: many elements after the first point of a
 * pixel, two places where an element follows a point
 */
function stacked(n: number, spacing: number, half: number, depth: number): FeatureInput[] {
  const side = Math.ceil(Math.sqrt(n));
  const out: FeatureInput[] = [];
  for (let i = 0; i < n; i++) {
    const x = SLOPE[0] - (side / 2) * spacing + (i % side) * spacing;
    const y = SLOPE[1] - (side / 2) * spacing + Math.floor(i / side) * spacing;
    out.push(point(`p${i}`, [x, y], i));
    for (let k = 0; k < depth; k++) {
      out.push(square(`s${i}-${k}`, [x + (k * half) / depth, y], half, i + k, 0.4));
    }
    out.push(point(`q${i}`, [x + half / 2, y], i + 1));
    out.push(square(`t${i}`, [x + half, y], half / 2, i + 3, 0.7));
  }
  return out;
}

function point(id: string, at: [number, number], color: number): FeatureInput {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: at },
    style: {
      pointColor: COLORS[color % COLORS.length],
      pointRadius: 6,
      pointStrokeWidth: 1,
      pointStrokeColor: '#ffffff',
    },
  };
}

function square(
  id: string,
  [cx, cy]: [number, number],
  half: number,
  color: number,
  opacity: number,
): FeatureInput {
  return {
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [cx - half, cy - half],
          [cx + half, cy - half],
          [cx + half, cy + half],
          [cx - half, cy + half],
          [cx - half, cy - half],
        ],
      ],
    },
    style: {
      fillColor: COLORS[color % COLORS.length],
      fillOpacity: opacity,
      strokeColor: hex([0x30, 0x30, 0x30]),
      strokeWidth: STROKE,
    },
  };
}

async function openScene(features: FeatureInput[], camera: Record<string, unknown>) {
  const page = await openMapPage(browser, bundle, camera as never);
  await page.evaluate(async () => {
    const w = window as unknown as {
      map: import('maplibre-gl').Map;
      e2e: { terrain: { addTestTerrain(map: unknown, exaggeration: number): Promise<void> } };
    };
    await w.e2e.terrain.addTestTerrain(w.map, 1.5);
  });
  await load(page, { kind: 'rows', features }, camera.zoom as number, camera.center as never);
  await page.evaluate((c) => {
    const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
    map.jumpTo(c as never);
    map.addLayer(
      { id: 'ground', type: 'background', paint: { 'background-color': '#ffffff' } },
      map.getLayersOrder()[0],
    );
  }, camera);
  await idle(page);
  return page;
}

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
    { polling: 200, timeout: browserTimeout(120_000) },
  );
  await settle(page);
  await settle(page);
}

interface Measure {
  order: string;
  used: boolean;
  reason: string;
  glDraws: number;
  drapeDraws: number;
  pointDraws: number;
  breaks: number;
  steps: number;
  deepest: number;
  frameMs: number;
  pixels: number[];
}

/**
 * A way of keeping the order measured: the mode, and for the split its steps (0: as many as the
 * runs a pixel reads, up to its most) and what is past its last bound
 */
interface Way {
  order: 'split' | 'breaks' | 'each' | 'each-near';
  steps?: number;
  tail?: 'breaks' | 'over';
}

function nameOf(way: Way): string {
  if (way.order !== 'split') return way.order;
  const tail = way.tail === 'breaks' ? '+breaks' : '';
  return `split${way.steps ? way.steps : 'auto'}${tail}`;
}

/**
 * Draws frames keeping the order one way: the draws of GL in a frame, the median time of the
 * JavaScript of a frame, and its pixels
 */
async function measure(page: Page, way: Way, frames: number): Promise<Measure> {
  log(`measure ${nameOf(way)}`);
  return page.evaluate(
    async ({ way, frames, name }) => {
      const w = window as unknown as {
        map: import('maplibre-gl').Map & { redraw(): void };
        draw: unknown;
        e2e: {
          internals: {
            tableDiagnosticsOf(draw: unknown): {
              setDrapeOrder(order: string, split?: { steps?: number; tail?: string }): void;
              drape(): Record<string, unknown>;
            };
          };
        };
      };
      const hooks = w.e2e.internals.tableDiagnosticsOf(w.draw);
      hooks.setDrapeOrder(way.order, { steps: way.steps ?? 0, tail: way.tail ?? 'over' });
      const map = w.map;
      const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext & {
        __count?: { n: number };
      };
      if (!gl.__count) {
        const count = { n: 0 };
        gl.__count = count;
        for (const fn of [
          'drawArrays',
          'drawElements',
          'drawArraysInstanced',
          'drawElementsInstanced',
        ] as const) {
          const original = gl[fn].bind(gl) as (...args: unknown[]) => void;
          (gl as unknown as Record<string, unknown>)[fn] = (...args: unknown[]) => {
            count.n++;
            original(...args);
          };
        }
      }
      // Warm up (the programs of the split compile at their first frame)
      map.redraw();
      gl.finish();
      if (way.order === 'split') {
        map.redraw();
        gl.finish();
      }
      const times: number[] = [];
      let draws = 0;
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);
      for (let i = 0; i < frames; i++) {
        gl.__count.n = 0;
        const t0 = performance.now();
        map.redraw();
        times.push(performance.now() - t0);
        draws = gl.__count.n;
        // The pixels of the last frame, read before it is shown
        if (i === frames - 1) gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.finish();
      }
      times.sort((a, b) => a - b);
      const drape = hooks.drape();
      hooks.setDrapeOrder('split');
      return {
        order: name,
        used: drape.used as boolean,
        reason: drape.reason as string,
        glDraws: draws,
        drapeDraws: drape.draws as number,
        pointDraws: drape.pointDraws as number,
        breaks: drape.breaks as number,
        steps: drape.steps as number,
        deepest: drape.deepest as number,
        frameMs: times[Math.floor(times.length / 2)] as number,
        pixels: Array.from(pixels),
      };
    },
    { way, frames, name: nameOf(way) },
  );
}

/** Writes a line of progress to the file of the measures */
function log(text: string): void {
  const out = process.env.DRAPE_ORDER_OUT;
  if (out) appendFileSync(out, `# ${new Date().toISOString()} ${text}\n`);
}

/** The pixels of two pictures that differ by more than a step in a channel */
function differing(a: number[], b: number[], step = 3): number {
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

/** Writes a picture of the pixels of a frame (drawn bottom up) to a file */
async function writeImage(page: Page, pixels: number[], file: string): Promise<void> {
  const url = await page.evaluate((pixels) => {
    const canvas = document.createElement('canvas');
    const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
    const source = map.getCanvas();
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    const image = context.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y++) {
      const from = (canvas.height - 1 - y) * canvas.width * 4;
      image.data.set(pixels.slice(from, from + canvas.width * 4), y * canvas.width * 4);
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  }, pixels);
  writeFileSync(file, Buffer.from(url.split(',')[1] as string, 'base64'));
}

const WAYS: Way[] = [
  { order: 'breaks' },
  ...[1, 2, 3, 4, 8].map((steps): Way => ({ order: 'split', steps })),
  { order: 'split' },
  { order: 'split', tail: 'breaks' },
];

/**
 * Measures every way in a scene, against a reference when asked: every run a break, the drape
 * painted up to it in every tile (`each`) or in the tiles it meets (`each-near`)
 */
async function measureScene(
  name: string,
  features: FeatureInput[],
  camera: Record<string, unknown>,
  ways: Way[],
  reference: 'each' | 'each-near' | null,
): Promise<void> {
  log(`${name}: loading`);
  const page = await openScene(features, camera);
  log('loaded');
  const rows: string[] = [];
  const each = reference ? await measure(page, { order: reference }, 1) : null;
  const line = (m: Measure, diff: number | null) =>
    `${m.order.padEnd(7)} used=${m.used}(${m.reason}) gl=${m.glDraws} drape=${m.drapeDraws} points=${m.pointDraws} breaks=${m.breaks} steps=${m.steps} deepest=${m.deepest} ms=${m.frameMs.toFixed(1)}${diff === null ? '' : ` diff=${diff}`}`;
  if (each) {
    let painted = 0;
    for (let i = 0; i < each.pixels.length; i += 4) {
      if (!(each.pixels[i] === 255 && each.pixels[i + 1] === 255 && each.pixels[i + 2] === 255)) {
        painted++;
      }
    }
    rows.push(`${line(each, 0)} painted=${painted}`);
  }
  const images = process.env.DRAPE_ORDER_IMAGES;
  if (images && each) await writeImage(page, each.pixels, `${images}/${name}-each.png`);
  for (const way of ways) {
    const m = await measure(page, way, way.order === 'split' ? 5 : 1);
    rows.push(line(m, each ? differing(m.pixels, each.pixels) : null));
    if (images) await writeImage(page, m.pixels, `${images}/${name}-${m.order}.png`);
  }
  const out = process.env.DRAPE_ORDER_OUT;
  if (out) appendFileSync(out, `${name}\n${rows.join('\n')}\n`);
  await page.close();
}

// Measures only, run when asked (DRAPE_ORDER_OUT names the file of the measures)
describe.skipIf(!process.env.DRAPE_ORDER_OUT)(
  'the order of the points among the drape of the rows (measures)',
  () => {
    const scenes = (process.env.DRAPE_ORDER_SCENES ?? 'small,stacked,large').split(',');
    if (scenes.includes('small')) {
      it('alternating points and squares, 2 x 400, zoom 15, pitch 60, against the reference', {
        timeout: browserTimeout(3_600_000),
      }, async () => {
        await measureScene(
          'small-z15-p60',
          alternating(400, 0.0008, 0.00024),
          { center: SLOPE, zoom: 15, pitch: 60, bearing: 0 },
          WAYS,
          'each',
        );
      });
    }
    if (scenes.includes('stacked')) {
      it('points under stacks of translucent squares, zoom 15, pitch 45, against the reference', {
        timeout: browserTimeout(3_600_000),
      }, async () => {
        await measureScene(
          'stacked-z15-p45',
          stacked(100, 0.0016, 0.00032, 6),
          { center: SLOPE, zoom: 15, pitch: 45, bearing: 0 },
          WAYS,
          'each',
        );
      });
    }
    if (scenes.includes('large')) {
      for (const zoom of [15, 13.5, 12]) {
        it(`alternating points and squares, 2 x 10,000, zoom ${zoom}, pitch 45`, {
          timeout: browserTimeout(3_600_000),
        }, async () => {
          const ways: Way[] = [
            ...[2, 4].map((steps): Way => ({ order: 'split', steps })),
            { order: 'split' },
            ...(process.env.DRAPE_ORDER_BREAKS ? [{ order: 'breaks' } as Way] : []),
          ];
          await measureScene(
            `large-z${zoom}-p45`,
            alternating(10_000, 0.0004, 0.00012),
            { center: SLOPE, zoom, pitch: 45, bearing: 0 },
            ways,
            process.env.DRAPE_ORDER_REFERENCE ? 'each-near' : null,
          );
        });
      }
    }
  },
);
