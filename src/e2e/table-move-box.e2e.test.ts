// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of a box drawn over rows, on the real maplibre and WebGL of the browser
 *
 * While a box is drawn over rows with Shift, the rows in it are marked and not selected (9.2): the
 * picture in the middle of the drag (the rows, the rubber band, the frames of the selection UI and
 * its handles) is compared with the one of a Store of objects holding the same features in the
 * middle of the same drag, which selects the features in the box
 *
 * The rows drawn in one draw and the features of the Store differ by the tolerance of the other
 * comparisons of the drawing in one draw.
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
  pageOf,
  selectedIds,
  settle,
} from './harness.js';

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

/** A feature of a scene */
interface SceneFeature {
  id: string;
  type: string;
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

/** The rows of the scene: buildings, points, lines, a fill, half transparent */
function scene(): SceneFeature[] {
  const out: SceneFeature[] = [];
  for (let i = 0; i < 6; i++) {
    const x = -0.009 + i * 0.0035;
    out.push({
      id: `building${i}`,
      type: 'Polygon',
      geometry: { type: 'Polygon', coordinates: [ring(x, 0.004, 0.0012, 5 + (i % 2))] },
      style: { fillColor: '#4e79a7', fillOpacity: 0.6, strokeWidth: 3, strokeOpacity: 0.8 },
    });
    out.push({
      id: `point${i}`,
      type: 'Point',
      geometry: { type: 'Point', coordinates: at(x, 0.0015) },
      style: { pointColor: '#e15759', pointRadius: 7, pointOpacity: 0.8 },
    });
    out.push({
      id: `line${i}`,
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [at(x - 0.001, -0.001), at(x, 0), at(x + 0.001, -0.0015)],
      },
      style: { strokeWidth: 5, strokeColor: '#59a14f', strokeOpacity: 0.7 },
    });
  }
  out.push({
    id: 'fill',
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [ring(0.006, -0.005, 0.0015, 7)] },
    style: { fillColor: '#f28e2b', fillOpacity: 0.5, strokeWidth: 0 },
  });
  return out;
}

/**
 * Makes a new instance over a Store of its own holding a scene: its rows (`rows`, an in-memory
 * Store of rows) or its features (`store`, an in-memory Store of objects), and waits until
 * everything is drawn
 */
async function open(page: Page, features: SceneFeature[], form: 'rows' | 'store'): Promise<void> {
  await page.evaluate(
    async ({ features, form }) => {
      type Contract = import('../index.js').Store;
      const w = window as unknown as Record<string, unknown> & {
        map: import('maplibre-gl').Map;
        draw: import('../index.js').Draw;
        e2e: {
          createDraw: typeof import('../index.js').createDraw;
          tables: {
            createRowBlockBuilder: typeof import('../table/row-group-builder.js').createRowBlockBuilder;
            createTableStore: typeof import('../store/table-memory.js').createTableStore;
          };
          internals: { MemoryContractStore: new () => Contract };
        };
      };
      const { map } = w;
      const layer = {
        id: 'rows',
        name: 'rows',
        visible: true,
        locked: false,
        opacity: 1,
        styleRule: undefined,
        metadata: undefined,
      };
      let store: Contract;
      if (form === 'rows') {
        const made = w.e2e.tables.createTableStore();
        store = made.store as unknown as Contract;
        store.createLayer({ ...layer, kind: 'table' } as never);
        const builder = w.e2e.tables.createRowBlockBuilder({});
        features.forEach((f, i) => {
          builder.addRow({
            id: f.id,
            type: f.type,
            geometry: f.geometry,
            order: `k${String(i).padStart(6, '0')}`,
            style: f.style ?? {},
            properties: {},
            visible: true,
            locked: false,
          } as never);
        });
        made.writer.addRowBlocks('rows', builder.finish());
      } else {
        store = new w.e2e.internals.MemoryContractStore();
        const contract = store;
        contract.transact(() => {
          contract.createLayer({ ...layer, items: [] } as never);
          for (const f of features) {
            contract.createFeature({
              id: f.id,
              type: f.type,
              geometry: f.geometry,
              style: f.style ?? {},
              properties: {},
              layerId: 'rows',
              groupId: undefined,
              visible: true,
              locked: false,
            } as never);
          }
        }, 'remote');
      }
      w.store = store;
      w.draw.destroy();
      w.draw = w.e2e.createDraw(map, { store, initDefaultLayer: false });
      const frame = (): Promise<void> =>
        new Promise((resolve) => {
          map.once('render', () => resolve());
          map.triggerRepaint();
        });
      await frame();
      for (let i = 0; i < 200; i++) {
        if (!w.draw.hasPendingWork()) break;
        await frame();
      }
    },
    { features, form },
  );
}

/**
 * Keeps the pixels of the frame once everything is drawn under `key`
 *
 * @returns The number of pixels drawn
 */
async function capture(page: Page, key: string): Promise<number> {
  return page.evaluate(async (key) => {
    const w = window as unknown as Record<string, unknown> & {
      map: import('maplibre-gl').Map;
      draw: import('../index.js').Draw;
    };
    const { map } = w;
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
    for (let i = 0; i < 200; i++) {
      if (!w.draw.hasPendingWork()) break;
      pixels = await read();
    }
    // Two more frames with everything built (a chunk is drawn the frame after it is written)
    await read();
    pixels = await read();
    w.captured ??= {};
    (w.captured as Record<string, Uint8Array>)[key] = pixels;
    let drawn = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) drawn++;
    return drawn;
  }, key);
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

describe('a box drawn over rows', () => {
  let page: Page;

  beforeAll(async () => {
    page = await openMapPage(browser, bundle, CAMERA);
  }, browserTimeout(60_000));

  afterAll(async () => {
    await page?.close();
  });

  it('shows the rows in a box being drawn as a Store of objects shows the features it selects', {
    timeout: browserTimeout(120_000),
  }, async () => {
    const features = scene();
    /** Draws a box with Shift over half of the scene, keeps the picture in its middle */
    const box = async (key: string): Promise<{ drawn: number; selected: string[] }> => {
      const from = await pageOf(page, at(-0.011, 0.0065));
      const to = await pageOf(page, at(0.0015, -0.003));
      await page.keyboard.down('Shift');
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await settle(page);
      const drawn = await capture(page, key);
      const selected = await selectedIds(page);
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await settle(page);
      return { drawn, selected };
    };

    await open(page, features, 'store');
    const objects = await box('box-store');
    const selectedByObjects = (await selectedIds(page)).sort();

    await open(page, features, 'rows');
    const rows = await box('box-rows');
    const selectedByRows = (await selectedIds(page)).sort();

    const differs = await differing(page, 'box-rows', 'box-store', TOLERANCE.level);
    console.log(
      `[box] ${rows.drawn} pixels drawn, ${differs} differ ` +
        `(${objects.selected.length} features selected by the box of the objects)`,
    );
    // The Store of objects selects in the middle of the drag; the Store of rows only marks
    expect(objects.selected.length).toBeGreaterThan(1);
    expect(rows.selected).toEqual([]);
    expect(rows.drawn).toBeGreaterThan(0);
    expect(differs).toBeLessThanOrEqual(Math.floor(objects.drawn * TOLERANCE.share));
    // Let go, both select the same features
    expect(selectedByRows).toEqual(selectedByObjects);
    expect(selectedByRows.length).toBe(objects.selected.length);
  });
});
