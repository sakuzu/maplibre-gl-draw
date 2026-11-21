// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the drawing of the layers of a flat map from their rows
 *
 * - On a pitched flat map, a dashed line shows as many dashes as the cut of the dashes on the CPU
 *   (`dash.ts`) gives once each dash has its round ends on the screen: the far dashes, closer on
 *   the screen than their ends reach, run into one
 * - When the program of the drawing in one draw cannot be made, the drawing by kind draws the
 *   scenes of the flat and the pitched maps within the bounds the pictures of the drawing are held
 *   to (`compare-pictures.ts`): a dashed or dotted scene with 1% of its pixels drawn differing by
 *   more than 8 levels at most (1.5% for the three scenes of `LOOSER`), another with 0.1% by more
 *   than 2
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrawDocument } from '../index.js';
import { browserTimeout } from '../test-utils.js';
import { getStrokeDashPattern, splitIntoDashes } from '../view/renderers/line/dash.js';
import { compareSets, describeComparison, type Picture } from './compare-pictures.js';
import {
  type Bundle,
  bundlePage,
  type Camera,
  type E2EWindow,
  launchBrowser,
  openMapPage,
  settle,
} from './harness.js';
import { type Call, CUSTOM_TYPE, MAP_SETUPS, type PictureScene, SCENES } from './picture-scenes.js';

/** A pitched camera close to the ground */
const PITCHED: Camera = { center: [139.0, 35.0], zoom: 17, pitch: 60, bearing: 0 };

/** The width of the dashed line (CSS px) */
const WIDTH = 8;

/** The frames the page draws at most before a picture, waiting for the drawing to finish */
const SETTLE_FRAMES = 300;

type LngLat = [number, number];

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, browserTimeout(90_000));

afterAll(async () => {
  await browser?.close();
});

/** The runs of the color of a line along a line of the canvas (device px from its first end) */
async function dashesOn(page: Page, from: LngLat, to: LngLat): Promise<Array<[number, number]>> {
  return page.evaluate(
    async ({ from, to, width }) => {
      const { map } = window as unknown as E2EWindow;
      const pixels = await new Promise<{ data: Uint8Array; w: number; h: number }>((resolve) => {
        map.once('render', () => {
          const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
          const w = gl.drawingBufferWidth;
          const h = gl.drawingBufferHeight;
          const data = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
          resolve({ data, w, h });
        });
        map.triggerRepaint();
      });
      const ratio = pixels.w / map.getCanvas().clientWidth;
      const a = map.project(from);
      const b = map.project(to);
      const ax = a.x * ratio;
      const ay = a.y * ratio;
      const length = Math.hypot(b.x * ratio - ax, b.y * ratio - ay);
      const dx = (b.x * ratio - ax) / length;
      const dy = (b.y * ratio - ay) / length;
      const isLine = (x: number, y: number): boolean => {
        const col = Math.floor(x);
        const row = pixels.h - 1 - Math.floor(y);
        if (col < 0 || row < 0 || col >= pixels.w || row >= pixels.h) return false;
        const i = (row * pixels.w + col) * 4;
        return pixels.data[i] < 128 && pixels.data[i + 1] < 128 && pixels.data[i + 2] > 128;
      };
      const runs: Array<[number, number]> = [];
      let open: number | null = null;
      for (let t = -width * ratio; t <= length + width * ratio; t += 0.5) {
        const on = isLine(ax + dx * t, ay + dy * t);
        if (on && open === null) open = t;
        if (!on && open !== null) {
          runs.push([open, t - 0.5]);
          open = null;
        }
      }
      if (open !== null) runs.push([open, length + width * ratio]);
      return runs;
    },
    { from, to, width: WIDTH },
  );
}

describe('a dashed line on a pitched flat map', () => {
  let page: Page;

  beforeAll(async () => {
    page = await openMapPage(browser, bundle, PITCHED);
    await page.evaluate(() => {
      const { map } = window as unknown as E2EWindow;
      map.addLayer(
        { id: 'ground', type: 'background', paint: { 'background-color': '#ffffff' } },
        map.getLayersOrder()[0],
      );
    });
  }, browserTimeout(90_000));

  afterAll(async () => {
    await page?.close();
  });

  it('shows as many dashes as the cut of the dashes on the CPU gives with round ends on the screen', async () => {
    const line = await page.evaluate(() => {
      const { map } = window as unknown as E2EWindow;
      return [map.unproject([140, 380]), map.unproject([500, 120])].map(
        (ll) => [ll.lng, ll.lat] as [number, number],
      );
    });
    const zoom = await page.evaluate(() => (window as unknown as E2EWindow).map.getZoom());
    await page.evaluate(
      ({ line, width }) => {
        const { map, draw } = window as unknown as E2EWindow;
        draw.features.create({
          type: 'LineString',
          geometry: { type: 'LineString', coordinates: line },
          properties: { 'maplibre-gl-draw:createdZoom': map.getZoom() },
          style: { strokeColor: '#0000FF', strokeWidth: width, lineStyle: 'dashed' },
        } as never);
      },
      { line, width: WIDTH },
    );
    await settle(page);
    const read = await dashesOn(page, line[0], line[1]);

    // The dashes the CPU cuts, on the screen, each reaching half the width past its ends; the
    // ones that reach each other show as one, and so do the ones less than half a pixel apart
    // (their smoothed edges meet)
    const pattern = getStrokeDashPattern('dashed', WIDTH) as [number, number];
    const cut = splitIntoDashes(line, pattern[0], pattern[1], zoom);
    const spans = await page.evaluate(
      ({ cut, from, to }) => {
        const { map } = window as unknown as E2EWindow;
        const ratio = map.getCanvas().width / map.getCanvas().clientWidth;
        const a = map.project(from);
        const b = map.project(to);
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        const along = (p: [number, number]): number => {
          const q = map.project(p);
          return (((q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y)) / length) * ratio;
        };
        return {
          ratio,
          spans: cut.map((dash) => [
            along(dash.coords[0] as [number, number]),
            along(dash.coords[dash.coords.length - 1] as [number, number]),
          ]),
        };
      },
      { cut: cut.map((d) => ({ coords: d.coords })), from: line[0], to: line[1] },
    );
    const reach = (WIDTH / 2) * spans.ratio;
    let shown = 0;
    let end = Number.NEGATIVE_INFINITY;
    for (const [start, stop] of spans.spans) {
      if (start - reach > end + spans.ratio / 2) shown++;
      end = Math.max(end, stop + reach);
    }
    expect(cut.length).toBeGreaterThan(shown);
    expect(read.length, JSON.stringify(read)).toBe(shown);
  });
});

/** Writes the document of a scene, makes its calls, and reads the pixels once it is drawn */
async function take(page: Page, scene: PictureScene): Promise<Picture> {
  const { width, height, base64 } = await page.evaluate(
    async ({ document, calls, frames }) => {
      const { draw, map } = window as unknown as E2EWindow;
      draw.setReadOnly(false);
      draw.setMode('select');
      draw.selection.clear();
      draw.hidden.clear();
      if (!(await draw.document.load(document as DrawDocument))) {
        throw new Error('the document of the scene was not loaded');
      }
      for (const [path, ...args] of calls as Call[]) {
        const [resource, method] = path.split('.');
        const target = (draw as unknown as Record<string, Record<string, unknown>>)[resource];
        (target[method] as (...a: unknown[]) => unknown).apply(target, args);
      }
      const frame = (): Promise<void> =>
        new Promise((resolve) => requestAnimationFrame(() => resolve()));
      for (let i = 0; ; i++) {
        if (i >= 2 && !draw.hasPendingWork() && map.loaded()) break;
        if (i >= frames) throw new Error('the drawing did not finish');
        map.triggerRepaint();
        await frame();
      }
      return new Promise<{ width: number; height: number; base64: string }>((resolve) => {
        map.once('render', () => {
          const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
          const w = gl.drawingBufferWidth;
          const h = gl.drawingBufferHeight;
          const pixels = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          let text = '';
          for (let i = 0; i < pixels.length; i += 0x8000) {
            text += String.fromCharCode(...pixels.subarray(i, i + 0x8000));
          }
          resolve({ width: w, height: h, base64: btoa(text) });
        });
        map.triggerRepaint();
      });
    },
    { document: scene.document, calls: scene.calls as Call[], frames: SETTLE_FRAMES },
  );
  return { width, height, pixels: Buffer.from(base64, 'base64') };
}

/**
 * Opens the page of a map for the pictures, with the custom type of the scenes; with `byKind`, the
 * program of the drawing in one draw cannot be compiled on it
 */
async function openPicturePage(map: 'flat' | 'pitched', byKind: boolean): Promise<Page> {
  const page = await openMapPage(browser, bundle, MAP_SETUPS[map].camera);
  await page.evaluate(
    ({ byKind, customType }) => {
      const w = window as unknown as E2EWindow & {
        e2e: { createDraw: typeof import('../index.js').createDraw };
      };
      if (byKind) {
        // What the drawing tells, kept for the test
        const told: string[] = [];
        (window as unknown as { told: string[] }).told = told;
        const warn = console.warn.bind(console);
        console.warn = (...args: unknown[]) => {
          told.push(String(args[0]));
          warn(...args);
        };
        // The sources of the program of the rows do not compile
        const proto = WebGL2RenderingContext.prototype;
        const shaderSource = proto.shaderSource;
        proto.shaderSource = function (shader, source) {
          const broken = source.includes('u_row_base') ? `${source}\n#error no rows` : source;
          shaderSource.call(this, shader, broken);
        };
        // A new instance compiles its programs anew
        w.draw.destroy();
        w.draw = w.e2e.createDraw(w.map);
      }
      w.draw.extensions.featureTypes.add({
        type: customType,
        geometry: 'Polygon',
        renderer: {
          onAdd() {},
          draw(feature, ctx) {
            const rings = (feature.geometry as { coordinates: number[][][] }).coordinates;
            const color = feature.style.fillColor ?? '#808080';
            ctx.fill.draw(rings, { color, opacity: 0.5 * ctx.opacity });
            ctx.line.draw(
              rings[0],
              { width: 3, color: '#202020', opacity: ctx.opacity, lineStyle: 'dashed' },
              { closed: true },
            );
            ctx.point.draw(rings[0][0], {
              shape: 'star',
              size: 10,
              fillColor: color,
              fillOpacity: ctx.opacity,
              strokeColor: '#ffffff',
              strokeWidth: 2,
              strokeOpacity: ctx.opacity,
            });
          },
          onRemove() {},
        },
      });
    },
    { byKind, customType: CUSTOM_TYPE },
  );
  await settle(page);
  return page;
}

/**
 * The scenes held to 1.5% of their pixels drawn differing by more than 8 levels: the edges of the
 * corners and of the round ends of their dashes differ by a pixel here and there
 */
const LOOSER: ReadonlySet<string> = new Set([
  'pitched/line-dashed/style-rule',
  'flat/line-dotted/style-rule',
  'pitched/line-dashed/hidden-here',
]);

/** Whether a scene draws a dashed or a dotted line (held to the looser bound) */
function dashedScene(scene: PictureScene): boolean {
  return (
    scene.kind === 'line-dashed' ||
    scene.kind === 'line-dotted' ||
    scene.kind === 'custom-type' ||
    JSON.stringify(scene.document).match(/"lineStyle":"(dashed|dotted)"/) !== null
  );
}

for (const map of ['flat', 'pitched'] as const) {
  describe(`the drawing by kind on the ${map} map`, () => {
    // The scenes whose image is decoded later are left out: they wait for the image
    const scenes = SCENES.filter((scene) => scene.map === map && scene.kind !== 'image');

    it('draws every scene but those of an image within the bounds of the drawing in one draw', {
      timeout: browserTimeout(600_000),
    }, async () => {
      const [oneDraw, byKind] = await Promise.all([
        openPicturePage(map, false),
        openPicturePage(map, true),
      ]);
      try {
        const before = new Map<string, Picture>();
        const after = new Map<string, Picture>();
        for (const scene of scenes) {
          before.set(scene.name, await take(oneDraw, scene));
          after.set(scene.name, await take(byKind, scene));
        }
        // The page drew by kind
        const told = await byKind.evaluate(() => (window as unknown as { told: string[] }).told);
        expect(told.some((text) => text.includes('drawn by kind'))).toBe(true);
        const bounds = new Map(
          scenes.map((scene) => [
            scene.name,
            LOOSER.has(scene.name)
              ? { levels: 8, share: 0.015 }
              : dashedScene(scene)
                ? { levels: 8, share: 0.01 }
                : { levels: 2, share: 0.001 },
          ]),
        );
        const failed = compareSets(before, after, new Set(), bounds)
          .filter((c) => c.failed)
          .map(describeComparison);
        expect(failed).toEqual([]);
      } finally {
        await Promise.all([oneDraw.close(), byKind.close()]);
      }
    });
  });
}
