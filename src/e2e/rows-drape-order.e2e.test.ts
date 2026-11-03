// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Measures of the ways the drape of the rows keeps the order among the points drawn between its
 * polygons (a prototype: printed, not asserted)
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
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

/**
 * On each place of a grid, `depth` points and `depth` translucent squares one after the other,
 * all over the pixel of the place: a point, then a square over it, `depth` times
 */
function deep(n: number, spacing: number, half: number, depth: number): FeatureInput[] {
  const side = Math.ceil(Math.sqrt(n));
  const out: FeatureInput[] = [];
  for (let i = 0; i < n; i++) {
    const x = SLOPE[0] - (side / 2) * spacing + (i % side) * spacing;
    const y = SLOPE[1] - (side / 2) * spacing + Math.floor(i / side) * spacing;
    for (let k = 0; k < depth; k++) {
      const shift = (k - depth / 2) * half * 0.02;
      out.push(point(`d${i}-${k}`, [x + shift, y - shift], k));
      out.push(square(`e${i}-${k}`, [x - shift, y + shift], half, k + 2, 0.45));
    }
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
  // The test terrain as the map takes it by default (not exaggerated)
  await page.evaluate(async () => {
    const w = window as unknown as {
      map: import('maplibre-gl').Map;
      e2e: { terrain: { addTestTerrain(map: unknown): Promise<void> } };
    };
    await w.e2e.terrain.addTestTerrain(w.map);
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
  totalMs: number;
  used: boolean;
  reason: string;
  glDraws: number;
  drapeDraws: number;
  pointDraws: number;
  breaks: number;
  steps: number;
  deepest: number;
  frameMs: number;
  /** The shortest time of a frame with the work of the GPU (the least disturbed by the machine) */
  minMs: number;
  /** The times of every frame with the work of the GPU */
  totals: number[];
  pixels: number[];
}

/**
 * A way of keeping the order measured: the mode, and for the split its steps (0: as many as the
 * runs a pixel reads, up to its most) and what is past its last bound
 */
interface Way {
  order: 'split' | 'breaks' | 'each' | 'each-near' | 'ground';
  steps?: number;
  tail?: 'breaks' | 'over';
}

/** A way named as `nameOf` names it */
function wayOf(name: string): Way {
  if (name === 'breaks' || name === 'each' || name === 'each-near' || name === 'ground') {
    return { order: name };
  }
  const match = /^split(auto|\d+)(\+breaks)?$/.exec(name);
  if (!match) throw new Error(`no way ${name}`);
  return {
    order: 'split',
    ...(match[1] === 'auto' ? {} : { steps: Number(match[1]) }),
    ...(match[2] ? { tail: 'breaks' as const } : {}),
  };
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
      // Warm up (the programs of the split compile at their first frame, and the rows are packed
      // again for the surface of the way)
      for (let i = 0; i < 400; i++) {
        map.redraw();
        if (!(w.draw as { hasPendingWork(): boolean }).hasPendingWork()) break;
      }
      map.redraw();
      gl.finish();
      if (way.order === 'split') {
        map.redraw();
        gl.finish();
      }
      if (way.order === 'ground') {
        map.redraw();
        gl.finish();
      }
      const times: number[] = [];
      const totals: number[] = [];
      let draws = 0;
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);
      const one = new Uint8Array(4);
      for (let i = 0; i < frames; i++) {
        gl.__count.n = 0;
        const t0 = performance.now();
        map.redraw();
        times.push(performance.now() - t0);
        draws = gl.__count.n;
        // The pixels of the last frame, read before it is shown; a pixel of every frame read, so
        // that the time of the frame holds the work of the GPU
        if (i === frames - 1) gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        else gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
        totals.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      totals.sort((a, b) => a - b);
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
        totalMs: totals[Math.floor(totals.length / 2)] as number,
        minMs: totals[0] as number,
        totals,
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

/**
 * The points of a scene the terrain hides from the camera, and of them those in view: the segment
 * from the camera to the point, at its elevation on the test terrain (exaggerated as the scene
 * is), meets the ground
 */
async function ghostPoints(page: Page, features: FeatureInput[]): Promise<string> {
  const anchors = features
    .filter((f) => f.type === 'Point')
    .map((f) => (f.geometry as { coordinates: [number, number] }).coordinates);
  return page.evaluate(
    ({ anchors }) => {
      const w = window as unknown as {
        map: import('maplibre-gl').Map;
        e2e: {
          maplibregl: typeof import('maplibre-gl');
          terrain: { testElevation(lng: number, lat: number): number };
        };
      };
      const map = w.map;
      type CameraTransform = {
        getCameraLngLat(): { lng: number; lat: number };
        getCameraAltitude(): number;
      };
      const holder = map as unknown as {
        transform?: CameraTransform;
        painter?: { transform?: CameraTransform };
      };
      const transform = (holder.transform ?? holder.painter?.transform) as CameraTransform;
      const cameraLngLat = transform.getCameraLngLat();
      const camera = w.e2e.maplibregl.MercatorCoordinate.fromLngLat(
        cameraLngLat,
        transform.getCameraAltitude(),
      );
      const Mercator = w.e2e.maplibregl;
      const ground = (x: number, y: number): number => {
        const ll = new Mercator.MercatorCoordinate(x, y, 0).toLngLat();
        return w.e2e.terrain.testElevation(ll.lng, ll.lat);
      };
      const canvas = map.getCanvas();
      let hidden = 0;
      let hiddenInView = 0;
      let inView = 0;
      for (const [lng, lat] of anchors) {
        const at = Mercator.MercatorCoordinate.fromLngLat(
          { lng, lat },
          w.e2e.terrain.testElevation(lng, lat),
        );
        const meter = at.meterInMercatorCoordinateUnits();
        const screen = map.project([lng, lat]);
        const shown =
          screen.x >= 0 &&
          screen.y >= 0 &&
          screen.x <= canvas.clientWidth &&
          screen.y <= canvas.clientHeight;
        if (shown) inView++;
        let occluded = false;
        for (let i = 1; i < 64; i++) {
          const t = i / 64;
          const x = camera.x + (at.x - camera.x) * t;
          const y = camera.y + (at.y - camera.y) * t;
          const z = (camera.z ?? 0) + (at.z - (camera.z ?? 0)) * t;
          if (ground(x, y) * meter > z + 2 * meter) {
            occluded = true;
            break;
          }
        }
        if (occluded) {
          hidden++;
          if (shown) hiddenInView++;
        }
      }
      return `${hidden} of ${anchors.length}, in view ${hiddenInView} of ${inView}`;
    },
    { anchors },
  );
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
  const each =
    reference && !process.env.DRAPE_ORDER_NOREF
      ? await measure(page, { order: reference }, 1)
      : null;
  const line = (m: Measure, diff: number | null) =>
    `${m.order.padEnd(7)} used=${m.used}(${m.reason}) gl=${m.glDraws} drape=${m.drapeDraws} points=${m.pointDraws} breaks=${m.breaks} steps=${m.steps} deepest=${m.deepest} ms=${m.frameMs.toFixed(1)} total=${m.totalMs.toFixed(1)} min=${m.minMs.toFixed(1)}${diff === null ? '' : ` diff=${diff}`}`;
  rows.push(`ghost points: ${await ghostPoints(page, features)}`);
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
  // The ways measured in turn, as many rounds as asked: the time of a frame drawn by the GPU of
  // the machine (SwiftShader) moves with what else the machine does, so each way is summed up by
  // the median of its medians and the shortest of its frames over the rounds
  const rounds = Number(process.env.DRAPE_ORDER_ROUNDS ?? 1);
  const summary = new Map<string, { totals: number[]; mins: number[]; frames: number[] }>();
  for (let round = 0; round < rounds; round++) {
    for (const way of ways) {
      const m = await measure(page, way, Number(process.env.DRAPE_ORDER_FRAMES ?? 3));
      rows.push(line(m, each ? differing(m.pixels, each.pixels) : null));
      const kept = summary.get(m.order) ?? { totals: [], mins: [], frames: [] };
      kept.totals.push(m.totalMs);
      kept.frames.push(...m.totals);
      kept.mins.push(m.minMs);
      summary.set(m.order, kept);
      if (images && round === 0) {
        await writeImage(page, m.pixels, `${images}/${name}-${m.order}.png`);
      }
    }
  }
  rows.push(
    `load of the machine at the end: ${loadavg()
      .map((l) => l.toFixed(1))
      .join(' ')}`,
  );
  if (rounds > 1) {
    for (const [order, kept] of summary) {
      const totals = [...kept.totals].sort((a, b) => a - b);
      const frames = [...kept.frames].sort((a, b) => a - b);
      const at = (q: number) => (frames[Math.floor(q * (frames.length - 1))] as number).toFixed(1);
      rows.push(
        `summary ${order} median=${(totals[Math.floor(totals.length / 2)] as number).toFixed(1)} min=${Math.min(...kept.mins).toFixed(1)} rounds=${totals.length} frames: p25=${at(0.25)} p50=${at(0.5)}`,
      );
      // Against the split measured in the same round (the load of the machine moves both)
      const split = summary.get('splitauto');
      if (split && order !== 'splitauto') {
        const ratios = kept.totals
          .map((t, i) => t / (split.totals[i] as number))
          .sort((a, b) => a - b);
        rows.push(
          `summary ${order}/splitauto ratio median=${(ratios[Math.floor(ratios.length / 2)] as number).toFixed(3)} all=${ratios.map((r) => r.toFixed(2)).join(',')}`,
        );
      }
    }
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
    const asked = process.env.DRAPE_ORDER_WAYS;
    const pick = (ways: Way[]): Way[] =>
      asked ? asked.split(',').map((name) => wayOf(name)) : [...ways, { order: 'ground' }];
    if (scenes.includes('small')) {
      it('alternating points and squares, 2 x 400, zoom 15, pitch 60, against the reference', {
        timeout: browserTimeout(3_600_000),
      }, async () => {
        await measureScene(
          'small-z15-p60',
          alternating(400, 0.0008, 0.00024),
          { center: SLOPE, zoom: 15, pitch: 60, bearing: 0 },
          pick(WAYS),
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
          pick(WAYS),
          'each',
        );
      });
    }
    if (scenes.includes('deep')) {
      it('points and translucent squares 20 times one after the other on a pixel, zoom 15, pitch 45, against the reference', {
        timeout: browserTimeout(3_600_000),
      }, async () => {
        await measureScene(
          'deep-z15-p45',
          deep(36, 0.0016, 0.0003, 20),
          { center: SLOPE, zoom: 15, pitch: 45, bearing: 0 },
          pick([{ order: 'split' }]),
          'each',
        );
      });
    }
    if (scenes.includes('large')) {
      const zooms = (process.env.DRAPE_ORDER_ZOOMS ?? '15,13.5,12').split(',').map(Number);
      const pitches = (process.env.DRAPE_ORDER_PITCHES ?? '45').split(',').map(Number);
      // Fewer of them for the pictures of one row at a time (DRAPE_ORDER_LARGE)
      const count = Number(process.env.DRAPE_ORDER_LARGE ?? 10_000);
      for (const pitch of pitches)
        for (const zoom of zooms) {
          it(`alternating points and squares, 2 x ${count}, zoom ${zoom}, pitch ${pitch}`, {
            timeout: browserTimeout(3_600_000),
          }, async () => {
            const ways: Way[] = pick([
              ...[2, 4].map((steps): Way => ({ order: 'split', steps })),
              { order: 'split' },
              ...(process.env.DRAPE_ORDER_BREAKS ? [{ order: 'breaks' } as Way] : []),
            ]);
            await measureScene(
              `large${count === 10_000 ? '' : count}-z${zoom}-p${pitch}`,
              alternating(count, 0.0004, 0.00012),
              { center: SLOPE, zoom, pitch, bearing: 0 },
              ways,
              (process.env.DRAPE_ORDER_REFERENCE as 'each' | 'each-near' | undefined) ?? null,
            );
          });
        }
    }
  },
);
