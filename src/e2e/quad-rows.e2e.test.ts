// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the prototype of the quads of the drawing of the rows
 *
 * - Points and pies (a custom type drawn as quads, `src/test-support/quad-pie.ts`) in turn, 20 of
 *   each, are drawn in one draw, in their order: a pie covers the point before it, and the point
 *   after it covers the pie. `QUAD_SHOT=<file.png>` writes the picture of the map there
 * - Rows without a quad are drawn the same with the program of the quads (`setQuadForAll`) as
 *   with the program of the rows
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import { type Bundle, bundlePage, type Camera, launchBrowser, openMapPage } from './harness.js';

const CENTER: [number, number] = [139.7, 35.68];
const CAMERA: Camera = { center: CENTER, zoom: 14 };

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

/** A row of the scene, as the builder of pages takes it */
interface SceneRow {
  id: string;
  type: string;
  at: [number, number];
  style?: Record<string, unknown>;
  properties?: Record<string, unknown>;
}

/** The points of the screen a scene is checked at (CSS px of the map) */
interface Probe {
  readonly x: number;
  readonly y: number;
  /** What is drawn on top there */
  readonly top: 'point' | 'pie';
}

/**
 * Draws rows of one layer held as rows, with the pies, waits until everything is drawn, and
 * keeps the pixels under `key`
 *
 * @returns The ranges drawn in one frame, by how they are drawn
 */
async function drawRows(
  page: Page,
  key: string,
  rows: SceneRow[],
  options: { quadForAll?: boolean } = {},
): Promise<Record<string, number>> {
  return page.evaluate(
    async ({ key, rows, quadForAll }) => {
      type Contract = import('../index.js').Store;
      const w = window as unknown as Record<string, unknown> & {
        map: import('maplibre-gl').Map;
        draw: import('../index.js').Draw;
        e2e: {
          createDraw: typeof import('../index.js').createDraw;
          tables: {
            createFeatureTables: typeof import('../kasane/index.js').createFeatureTables;
            createPageBuilder: typeof import('../table/feature-row-blocks.js').createFeaturePageBuilder;
          };
          quadPie: {
            piePlugin: typeof import('../test-support/quad-pie.js').piePlugin;
          };
          internals: {
            MemoryContractStore: new () => Contract;
            tableDiagnosticsOf: typeof import('../api/impl/table-diagnostics.js').tableDiagnosticsOf;
          };
        };
      };
      const { map } = w;
      const store = new w.e2e.internals.MemoryContractStore();
      store.transact(() => {
        store.createLayer({
          id: 'rows',
          name: 'rows',
          visible: true,
          locked: false,
          opacity: 1,
          items: [],
          styleRule: undefined,
          metadata: undefined,
        });
      }, 'remote');
      const { tables, writer } = w.e2e.tables.createFeatureTables();
      const builder = w.e2e.tables.createPageBuilder({});
      rows.forEach((r, i) => {
        builder.addRow({
          id: r.id,
          type: r.type,
          geometry: { type: 'Point', coordinates: r.at } as never,
          key: `k${String(i).padStart(6, '0')}`,
          style: r.style ?? {},
          properties: r.properties ?? {},
          hidden: false,
          locked: false,
        });
      });
      writer.addPages('rows', builder.finish());
      Object.defineProperty(store, 'tables', { value: tables });
      w.draw.destroy();
      w.draw = w.e2e.createDraw(map, { store, initDefaultLayer: false });
      w.draw.extensions.plugins.add(
        w.e2e.quadPie.piePlugin({ quads: true, meters: false, halfSize: 20 }),
      );
      const diagnostics = w.e2e.internals.tableDiagnosticsOf(w.draw);

      const read = (): Promise<Uint8Array> =>
        new Promise((resolve) => {
          map.once('render', () => {
            const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
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
            resolve(pixels);
          });
          map.triggerRepaint();
        });
      let pixels = await read();
      for (let i = 0; i < 400; i++) {
        const stats = diagnostics.quadStats();
        const done =
          stats !== null && stats.types > 0 && stats.ready + stats.failed === stats.types;
        if (done && !w.draw.hasPendingWork()) break;
        pixels = await read();
      }
      if (quadForAll) diagnostics.setQuadForAll(true);
      await read();
      const record = diagnostics.recordDraws();
      pixels = await read();
      diagnostics.stopRecording();
      pixels = await read();
      w.captured ??= {};
      (w.captured as Record<string, Uint8Array>)[key] = pixels;
      const out: Record<string, number> = { total: record.length };
      for (const range of record) out[range.kind] = (out[range.kind] ?? 0) + 1;
      const stats = diagnostics.quadStats();
      out.ready = stats?.ready ?? 0;
      out.quadChunks = stats?.quadChunks ?? 0;
      return out;
    },
    { key, rows, quadForAll: options.quadForAll ?? false },
  );
}

/** The color of the pixel at a point of the map (CSS px, the pixel ratio 1) */
async function colorAt(page: Page, key: string, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    ({ key, x, y }) => {
      const w = window as unknown as {
        captured: Record<string, Uint8Array>;
        map: import('maplibre-gl').Map;
      };
      const gl = w.map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const at = ((height - 1 - Math.round(y)) * width + Math.round(x)) * 4;
      return Array.from(w.captured[key].subarray(at, at + 4));
    },
    { key, x, y },
  );
}

/** The pixels of two pictures whose channels differ */
async function differing(
  page: Page,
  a: string,
  b: string,
): Promise<{ drawn: number; differ: number }> {
  return page.evaluate(
    ({ a, b }) => {
      const captured = (window as unknown as { captured: Record<string, Uint8Array> }).captured;
      const pa = captured[a];
      const pb = captured[b];
      let differ = 0;
      let drawn = 0;
      for (let i = 0; i < pa.length; i += 4) {
        if (pa[i + 3] > 0) drawn++;
        for (let k = 0; k < 4; k++) {
          if (pa[i + k] !== pb[i + k]) {
            differ++;
            break;
          }
        }
      }
      return { drawn, differ };
    },
    { a, b },
  );
}

/** The green of the points (`#2f9e44`) */
const POINT_GREEN = [47, 158, 68];

/** Whether a color is the green of the points (within a few levels) */
const isPointGreen = (c: number[]): boolean =>
  POINT_GREEN.every((v, k) => Math.abs((c[k] as number) - v) <= 6);

describe('the quads of the drawing of the rows (a prototype)', () => {
  let page: Page;

  beforeAll(async () => {
    page = await openMapPage(browser, bundle, CAMERA);
  }, browserTimeout(60_000));

  afterAll(async () => {
    await page?.close();
  });

  it('draws points and pies in turn in one draw, in their order', {
    timeout: browserTimeout(120_000),
  }, async () => {
    // 20 pairs in two lines of 10, 52 px apart: the point 10 px left of the middle of its cell,
    // the pie 8 px right of it, so each pie covers its point and the next point covers the pie
    const placed = await page.evaluate(() => {
      const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
      const out: { point: [number, number]; pie: [number, number]; x: number; y: number }[] = [];
      for (let i = 0; i < 20; i++) {
        const x = 70 + (i % 10) * 52;
        const y = 180 + Math.floor(i / 10) * 120;
        const point = map.unproject([x - 10, y]);
        const pie = map.unproject([x + 8, y]);
        out.push({ point: [point.lng, point.lat], pie: [pie.lng, pie.lat], x, y });
      }
      return out;
    });
    const rows: SceneRow[] = placed.flatMap((p, i) => [
      {
        id: `pt-${i}`,
        type: 'Point',
        at: p.point,
        style: { pointRadius: 18, pointColor: '#2f9e44', strokeColor: '#ffffff', strokeWidth: 1 },
      },
      {
        id: `pie-${i}`,
        type: 'pie',
        at: p.pie,
        properties: { share: ((i % 9) + 1) / 10, angle: (i * 17) % 360, size: 1 },
      },
    ]);
    const ranges = await drawRows(page, 'alt', rows);
    console.log(`[quads] alt n=20: ${JSON.stringify(ranges)}`);
    const shot = process.env.QUAD_SHOT;
    if (shot) {
      await page.screenshot({ path: shot, clip: { x: 40, y: 30, width: 640, height: 480 } });
    }
    // In one draw (one chunk), none drawn one by one
    expect(ranges.ready).toBe(1);
    expect(ranges.quadChunks).toBeGreaterThan(0);
    expect(ranges.rows).toBeGreaterThan(0);
    expect(ranges.immediate ?? 0).toBe(0);
    expect(ranges.total).toBeLessThanOrEqual(2);
    // In their order: the pie over its point, the next point over the pie
    const probes: Probe[] = [];
    for (const p of placed.slice(0, 19)) {
      if ((placed.indexOf(p) + 1) % 10 === 0) continue;
      probes.push({ x: p.x - 1, y: p.y, top: 'pie' });
      probes.push({ x: p.x + 25, y: p.y, top: 'point' });
    }
    for (const probe of probes) {
      const color = await colorAt(page, 'alt', probe.x, probe.y);
      expect(isPointGreen(color), `${probe.top} on top at ${probe.x}, ${probe.y}: ${color}`).toBe(
        probe.top === 'point',
      );
      expect(color[3]).toBe(255);
    }
  });

  it('draws rows without a quad with the program of the quads as with the one of the rows', {
    timeout: browserTimeout(120_000),
  }, async () => {
    const rows: SceneRow[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push({
        id: `p-${i}`,
        type: 'Point',
        at: [CENTER[0] - 0.01 + (i % 6) * 0.004, CENTER[1] - 0.004 + Math.floor(i / 6) * 0.002],
        style: {
          pointShape: (['circle', 'square', 'triangle', 'star'] as const)[i % 4],
          pointRadius: 4 + (i % 5) * 2,
          pointColor: i % 2 === 0 ? '#3366ff' : '#e15759',
          strokeColor: '#ffffff',
          strokeWidth: i % 3,
          strokeOpacity: 0.5,
        },
      });
    }
    await drawRows(page, 'rows', rows);
    const ranges = await drawRows(page, 'quad-program', rows, { quadForAll: true });
    expect(ranges.ready).toBe(1);
    const { drawn, differ } = await differing(page, 'rows', 'quad-program');
    console.log(
      `[quads] the program of the quads without a quad: ${drawn} drawn, ${differ} differ`,
    );
    expect(drawn).toBeGreaterThan(0);
    expect(differ).toBe(0);
  });
});
