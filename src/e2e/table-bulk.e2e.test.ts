// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of features selected in bulk, on the real maplibre and WebGL of the browser
 * (11.3, 11.4 and 11.6 of the design)
 *
 * A Store of rows that opens at most 3 features for the selection selects the rows of the scene in
 * bulk; a Store of objects holding the same features selects them one by one. The pictures are
 * compared:
 *
 * - selected: the frame of each feature (drawn from the extents of the rows on the GPU), the frame
 *   of all of them and its handles, as the selection UI draws them for features selected one by
 *   one
 * - in the middle of a drag from a feature selected, and once let go: the rows are drawn moved by
 *   their state in the middle (not written), and written once let go, as the features one by one
 *   are written in every frame
 * - in the middle of a rotation from the handle of the frame, and once let go: the rows are drawn
 *   turned by the transform of their moving set in the shader, and written once let go
 *
 * The frames of the rows are lines of the width of the stroke of the selection UI without the
 * smoothing of its edges, so the pictures with frames are compared with a tolerance of their own.
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
  settle,
} from './harness.js';

const CENTER: [number, number] = [139.7, 35.68];
const CAMERA: Camera = { center: CENTER, zoom: 14 };

/**
 * The differences allowed where frames are drawn: the frames of the rows are drawn without the
 * smoothing of the edges of the lines of the selection UI (their edges differ by a pixel)
 */
const FRAME_TOLERANCE = { level: 24, share: 0.02 };

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

/** A feature of the scene */
interface SceneFeature {
  id: string;
  type: string;
  geometry: { type: string; coordinates: unknown };
  style?: Record<string, unknown>;
}

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

/** Buildings, points and lines, half transparent */
function scene(): SceneFeature[] {
  const out: SceneFeature[] = [];
  for (let i = 0; i < 4; i++) {
    const x = -0.006 + i * 0.004;
    out.push({
      id: `building${i}`,
      type: 'Polygon',
      geometry: { type: 'Polygon', coordinates: [ring(x, 0.003, 0.0012, 5)] },
      style: { fillColor: '#4e79a7', fillOpacity: 0.6, strokeWidth: 3, strokeOpacity: 0.8 },
    });
    out.push({
      id: `point${i}`,
      type: 'Point',
      geometry: { type: 'Point', coordinates: at(x, 0) },
      style: { pointColor: '#e15759', pointRadius: 7, pointOpacity: 0.8 },
    });
    out.push({
      id: `line${i}`,
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [at(x - 0.001, -0.002), at(x, -0.0015), at(x + 0.001, -0.0025)],
      },
      style: { strokeWidth: 5, strokeColor: '#59a14f', strokeOpacity: 0.7 },
    });
  }
  return out;
}

/**
 * Makes a new instance over a Store holding the scene, its rows (`rows`, opening at most 3
 * features for the selection) or its features (`store`), with every feature selected
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
        const made = w.e2e.tables.createTableStore({ holdLimit: 3 });
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
        made.writer.addBlocks('rows', builder.finish());
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
      w.draw.selection.setAll();
      await frame();
    },
    { features, form },
  );
}

/** Keeps the pixels of the frame once everything is drawn under `key`; the pixels drawn */
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

/** The count of the selection and whether it is in bulk */
async function selection(page: Page): Promise<{ bulk: boolean; count: number }> {
  return page.evaluate(() => {
    const draw = (window as unknown as { draw: import('../index.js').Draw }).draw;
    return { bulk: draw.selection.get().bulk !== undefined, count: draw.selection.count() };
  });
}

/** The first position of the outer ring of a building, as the document reads it */
async function cornerOf(page: Page, id: string): Promise<number[]> {
  return page.evaluate((id) => {
    const draw = (window as unknown as { draw: import('../index.js').Draw }).draw;
    const geometry = draw.features.get(id)?.geometry as { coordinates: number[][][] } | undefined;
    return geometry ? geometry.coordinates[0][0] : [];
  }, id);
}

describe('features selected in bulk', () => {
  let page: Page;

  beforeAll(async () => {
    page = await openMapPage(browser, bundle, CAMERA);
  }, browserTimeout(60_000));

  afterAll(async () => {
    await page?.close();
  });

  it('show the frame of each feature, the frame of all and its handles, as one by one', {
    timeout: browserTimeout(120_000),
  }, async () => {
    const features = scene();
    await open(page, features, 'store');
    const objects = await capture(page, 'selected-store');
    expect(await selection(page)).toEqual({ bulk: false, count: features.length });
    await open(page, features, 'rows');
    const rows = await capture(page, 'selected-rows');
    expect(await selection(page)).toEqual({ bulk: true, count: features.length });
    const differs = await differing(page, 'selected-rows', 'selected-store', FRAME_TOLERANCE.level);
    console.log(`[selected] ${rows} pixels drawn (${objects} one by one), ${differs} differ`);
    expect(rows).toBeGreaterThan(0);
    expect(differs).toBeLessThanOrEqual(Math.floor(objects * FRAME_TOLERANCE.share));
  });

  /** Drags from a point to another in steps, keeping the picture in the middle and once let go */
  async function dragged(from: [number, number], to: [number, number], key: string): Promise<void> {
    const start = await pageOf(page, from);
    const end = await pageOf(page, to);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await settle(page);
    await capture(page, `${key}-middle`);
    await page.mouse.up();
    await settle(page);
    await capture(page, `${key}-ended`);
  }

  it('move all from a press on one, drawn moved by their state, written once let go', {
    timeout: browserTimeout(120_000),
  }, async () => {
    const features = scene();
    const from = at(-0.006, 0.003);
    const to = at(-0.0045, 0.002);
    await open(page, features, 'store');
    await dragged(from, to, 'move-store');
    const movedByObjects = await cornerOf(page, 'building3');
    await open(page, features, 'rows');
    const before = await cornerOf(page, 'building3');
    await dragged(from, to, 'move-rows');
    expect(await selection(page)).toEqual({ bulk: true, count: features.length });
    // Written once let go, where the features one by one are
    expect(await cornerOf(page, 'building3')).toEqual(movedByObjects);
    expect(await cornerOf(page, 'building3')).not.toEqual(before);
    for (const phase of ['middle', 'ended']) {
      const differs = await differing(
        page,
        `move-rows-${phase}`,
        `move-store-${phase}`,
        FRAME_TOLERANCE.level,
      );
      console.log(`[move] ${phase}: ${differs} pixels differ`);
      const drawn = await capture(page, `move-check-${phase}`);
      expect(differs).toBeLessThanOrEqual(Math.floor(drawn * FRAME_TOLERANCE.share));
    }
  });

  it('turn all from the rotation handle, drawn turned in the shader, written once let go', {
    timeout: browserTimeout(120_000),
  }, async () => {
    const features = scene();
    /** The rotation handle: above the middle of the top of the frame (its margin and distance) */
    const handleOf = async (): Promise<[number, number]> =>
      page.evaluate(() => {
        const w = window as unknown as {
          map: import('maplibre-gl').Map;
          draw: import('../index.js').Draw;
        };
        const all = w.draw.selection.features(undefined, { limit: 1000 });
        let north = Number.NEGATIVE_INFINITY;
        let west = Number.POSITIVE_INFINITY;
        let east = Number.NEGATIVE_INFINITY;
        const walk = (value: unknown): void => {
          if (!Array.isArray(value)) return;
          if (typeof value[0] === 'number') {
            west = Math.min(west, value[0] as number);
            east = Math.max(east, value[0] as number);
            north = Math.max(north, value[1] as number);
          } else for (const child of value) walk(child);
        };
        for (const feature of all) walk((feature.geometry as { coordinates: unknown }).coordinates);
        const top = w.map.project([(west + east) / 2, north]);
        const ll = w.map.unproject([top.x, top.y - 20]);
        return [ll.lng, ll.lat] as [number, number];
      });
    await open(page, features, 'store');
    const handle = await handleOf();
    const to = at(0.006, 0.006);
    await dragged(handle, to, 'rotate-store');
    const turnedByObjects = await cornerOf(page, 'building0');
    await open(page, features, 'rows');
    await dragged(handle, to, 'rotate-rows');
    const turnedByRows = await cornerOf(page, 'building0');
    expect(turnedByRows[0]).toBeCloseTo(turnedByObjects[0], 9);
    expect(turnedByRows[1]).toBeCloseTo(turnedByObjects[1], 9);
    for (const phase of ['middle', 'ended']) {
      const differs = await differing(
        page,
        `rotate-rows-${phase}`,
        `rotate-store-${phase}`,
        FRAME_TOLERANCE.level,
      );
      console.log(`[rotate] ${phase}: ${differs} pixels differ`);
      const drawn = await capture(page, `rotate-check-${phase}`);
      expect(differs).toBeLessThanOrEqual(Math.floor(drawn * FRAME_TOLERANCE.share));
    }
  });
});
