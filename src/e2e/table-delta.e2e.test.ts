// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the rows of the delta drawn at their places, and of the next versions of
 * the row groups swapped in
 *
 * Rows are drawn in one draw per chunk, then written through the writer of their tables so that
 * they go to the delta of their layer: rows put in another place of the order (half transparent,
 * over and under others), and new rows written in the middle of the order (a building drawn and
 * finished). On the real maplibre and WebGL of the browser:
 *
 * - the picture of the frame the writes are drawn in (the rows of the delta drawn from their chunk
 *   at their places, the chunks of the groups cut around them, the copies in the groups hidden)
 * - and the picture once the next versions of the groups took the rows of the delta
 *
 * are compared with the picture of the rows as written, drawn from the start. The rows of the
 * delta are drawn by the program that draws the groups, so the pictures are the same within the
 * tolerance of the other comparisons of the drawing in one draw (a chunk may take another
 * origin).
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import { type Bundle, bundlePage, type Camera, launchBrowser, openMapPage } from './harness.js';

const CENTER: [number, number] = [139.7, 35.68];
const CAMERA: Camera = { center: CENTER, zoom: 14 };

/**
 * The differences allowed between two pictures: the share of the pixels drawn whose channels
 * differ by more than `level` (as in the comparisons of the drawing in one draw)
 */
const TOLERANCE = { level: 2, share: 0.001 };

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

/** A feature of a scene, with the key of its order */
interface SceneFeature {
  id: string;
  type: string;
  order: string;
  geometry: { type: string; coordinates: unknown };
  style?: Record<string, unknown>;
}

/** A position at an offset from the center, in degrees */
const at = (dx: number, dy: number): [number, number] => [CENTER[0] + dx, CENTER[1] + dy];

/** A closed ring of `n` corners around an offset from the center */
function ring(dx: number, dy: number, r: number, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.3;
    out.push(at(dx + r * Math.cos(a), dy + r * Math.sin(a)));
  }
  out.push(out[0]);
  return out;
}

const key = (i: number): string => `k${String(i).padStart(6, '0')}`;

/**
 * Overlapping half transparent buildings, lines and points in many groups of rows (the order
 * shows in the colors where they overlap)
 */
function scene(): SceneFeature[] {
  const colors = ['#4e79a7', '#e15759', '#59a14f', '#f28e2b', '#b07aa1'];
  const out: SceneFeature[] = [];
  for (let i = 0; i < 40; i++) {
    const x = -0.008 + (i % 10) * 0.0016;
    const y = -0.004 + Math.floor(i / 10) * 0.002;
    const color = colors[i % colors.length];
    if (i % 3 === 0) {
      out.push({
        id: `point${i}`,
        type: 'Point',
        order: key(i * 10),
        geometry: { type: 'Point', coordinates: at(x, y) },
        style: { pointColor: color, pointRadius: 9, pointOpacity: 0.7 },
      });
    } else if (i % 3 === 1) {
      out.push({
        id: `line${i}`,
        type: 'LineString',
        order: key(i * 10),
        geometry: {
          type: 'LineString',
          coordinates: [at(x - 0.0015, y - 0.0006), at(x, y + 0.0006), at(x + 0.0015, y - 0.0006)],
        },
        style: { strokeColor: color, strokeWidth: 6, strokeOpacity: 0.6 },
      });
    } else {
      out.push({
        id: `building${i}`,
        type: 'Polygon',
        order: key(i * 10),
        geometry: { type: 'Polygon', coordinates: [ring(x, y, 0.0011, 5)] },
        style: { fillColor: color, fillOpacity: 0.55, strokeWidth: 2, strokeOpacity: 0.8 },
      });
    }
  }
  return out;
}

/** What is written: rows put in another place of the order, and new rows in the middle of it */
interface SceneWrites {
  readonly moves: ReadonlyArray<{ id: string; order: string }>;
  readonly created: readonly SceneFeature[];
}

function writes(): SceneWrites {
  return {
    moves: [
      // Over the rows it overlapped from under them, and the other way round
      { id: 'building2', order: `${key(390)}a` },
      { id: 'point33', order: `${key(5)}a` },
      { id: 'line22', order: `${key(125)}a` },
      { id: 'building17', order: `${key(301)}a` },
    ],
    created: [
      {
        id: 'drawn',
        type: 'Polygon',
        order: `${key(200)}a`,
        geometry: { type: 'Polygon', coordinates: [ring(-0.001, -0.001, 0.0025, 6)] },
        style: { fillColor: '#76b7b2', fillOpacity: 0.5, strokeWidth: 3 },
      },
    ],
  };
}

/** The features of a scene as written: the keys moved, the rows created */
function written(features: SceneFeature[], change: SceneWrites): SceneFeature[] {
  const out = features.map((f) => {
    const move = change.moves.find((m) => m.id === f.id);
    return move ? { ...f, order: move.order } : f;
  });
  return [...out, ...change.created];
}

/**
 * Draws a scene as rows in a new instance (groups of 8 rows), writes it once everything is drawn,
 * and keeps the pixels of the frame the writes are drawn in under `${key}-delta` and the pixels
 * once everything is built and swapped under `${key}-swapped`
 *
 * @returns The pixels drawn, and the rows of the delta in the frame of the writes and at the end
 */
async function drawWritten(
  page: Page,
  key: string,
  features: SceneFeature[],
  change: SceneWrites | null,
): Promise<{ drawn: number; deltaRows: number; deltaAfter: number; swapped: number }> {
  return page.evaluate(
    async ({ key, features, change }) => {
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
      const builder = w.e2e.tables.createPageBuilder({ targetRows: 8 });
      for (const f of features) {
        builder.addRow({
          id: f.id,
          type: f.type,
          geometry: f.geometry,
          order: f.order,
          style: f.style ?? {},
        } as never);
      }
      writer.addPages('rows', builder.finish());
      Object.defineProperty(store, 'tables', { value: tables });
      w.draw.destroy();
      w.draw = w.e2e.createDraw(map, { store, initDefaultLayer: false });

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
      const settle = async (): Promise<Uint8Array> => {
        let pixels = await read();
        for (let i = 0; i < 300; i++) {
          if (!w.draw.hasPendingWork()) break;
          pixels = await read();
        }
        // Two more frames with everything built (a chunk is drawn the frame after it is written)
        await read();
        pixels = await read();
        return pixels;
      };
      w.captured ??= {};
      const captured = w.captured as Record<string, Uint8Array>;
      captured[`${key}-swapped`] = await settle();
      let deltaRows = 0;
      if (change) {
        const ids = change.moves.map((m) => m.id);
        writer.writeRows({
          handles: Int32Array.from(ids.map((id) => tables.getRowRef(id) as number)),
          fields: new Map([['key', change.moves.map((m) => m.order)]]),
        });
        const encoder = new TextEncoder();
        const parts = change.created.map((f) => encoder.encode(f.id));
        const offsets = new Int32Array(parts.length + 1);
        for (let i = 0; i < parts.length; i++) offsets[i + 1] = offsets[i] + parts[i].length;
        const bytes = new Uint8Array(offsets[parts.length]);
        parts.forEach((part, i) => {
          bytes.set(part, offsets[i]);
        });
        const handles = writer.allocateHandles({ offsets, bytes });
        writer.writeRows({
          handles,
          fields: new Map<never, unknown[]>([
            ['type' as never, change.created.map((f) => f.type)],
            ['parent' as never, change.created.map(() => 'rows')],
            ['geometry' as never, change.created.map((f) => f.geometry)],
            ['key' as never, change.created.map((f) => f.order)],
            ['style' as never, change.created.map((f) => f.style ?? {})],
          ]),
        });
        // The frame the writes are drawn in: the rows of the delta at their places
        captured[`${key}-delta`] = await read();
        deltaRows = w.e2e.internals.tableDiagnosticsOf(w.draw).editStats().deltaRows;
        captured[`${key}-swapped`] = await settle();
      }
      const stats = w.e2e.internals.tableDiagnosticsOf(w.draw).editStats();
      const pixels = captured[`${key}-swapped`];
      let drawn = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) drawn++;
      return {
        drawn,
        deltaRows,
        deltaAfter: stats.deltaRows,
        swapped: stats.versionsSwapped,
      };
    },
    { key, features, change },
  );
}

/** The pixels of two pictures whose channels differ by more than `level` */
async function differing(page: Page, a: string, b: string, level: number): Promise<number> {
  return page.evaluate(
    ({ a, b, level }) => {
      const captured = (window as unknown as { captured: Record<string, Uint8Array> }).captured;
      const pa = captured[a];
      const pb = captured[b];
      let count = 0;
      for (let i = 0; i < pa.length; i += 4) {
        for (let k = 0; k < 4; k++) {
          if (Math.abs(pa[i + k] - pb[i + k]) > level) {
            count++;
            break;
          }
        }
      }
      return count;
    },
    { a, b, level },
  );
}

describe('the rows of the delta and the versions swapped in against the rows drawn from the start', () => {
  let page: Page;

  beforeAll(async () => {
    page = await openMapPage(browser, bundle, CAMERA);
  }, browserTimeout(60_000));

  afterAll(async () => {
    await page?.close();
  });

  it('draws the rows of the delta at their places, and the versions that took them, as the rows written', {
    timeout: browserTimeout(120_000),
  }, async () => {
    const features = scene();
    const change = writes();
    const live = await drawWritten(page, 'live', features, change);
    const built = await drawWritten(page, 'built', written(features, change), null);
    const delta = await differing(page, 'live-delta', 'built-swapped', TOLERANCE.level);
    const swapped = await differing(page, 'live-swapped', 'built-swapped', TOLERANCE.level);
    console.log(
      `[delta] ${built.drawn} pixels drawn; in the frame of the writes ${delta} differ ` +
        `(${live.deltaRows} rows of the delta); once swapped ${swapped} differ ` +
        `(${live.swapped} versions swapped, ${live.deltaAfter} rows of the delta left)`,
    );
    expect(built.drawn).toBeGreaterThan(0);
    expect(live.deltaRows).toBe(change.moves.length + change.created.length);
    expect(delta).toBeLessThanOrEqual(Math.floor(built.drawn * TOLERANCE.share));
    expect(live.swapped).toBeGreaterThan(0);
    expect(live.deltaAfter).toBe(0);
    expect(swapped).toBeLessThanOrEqual(Math.floor(built.drawn * TOLERANCE.share));
  });
});
