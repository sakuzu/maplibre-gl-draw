// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of features selected in bulk, on the real maplibre and WebGL of the browser
 *
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
 *
 * With `E2E_DUMP_DIR` set, each comparison also writes its pictures there as PNG: the rows selected
 * in bulk (`<scene>-rows.png`), the features selected one by one (`<scene>-store.png`) and the
 * pixels that differ painted red over a faded picture of the rows (`<scene>-diff.png`).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * features for the selection) or its features (`store`), with every feature selected, the map
 * back at the camera of the test (a drag that missed may have moved it)
 */
async function open(page: Page, features: SceneFeature[], form: 'rows' | 'store'): Promise<void> {
  await page.evaluate(
    async ({ features, form, camera }) => {
      type Contract = import('../index.js').Store;
      const w = window as unknown as Record<string, unknown> & {
        map: import('maplibre-gl').Map;
        draw: import('../index.js').Draw;
        e2e: {
          createDraw: typeof import('../index.js').createDraw;
          tables: {
            createRowBlockBuilder: typeof import('../table/feature-row-blocks.js').createFeatureRowBlockBuilder;
            createTableStore: typeof import('../store/table-memory.js').createTableStore;
          };
          internals: { MemoryContractStore: new () => Contract };
        };
      };
      const { map } = w;
      map.jumpTo({ center: camera.center, zoom: camera.zoom });
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
        const made = w.e2e.tables.createTableStore({ selectionIdsLimit: 3 });
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
      w.draw.selection.setAll();
      await frame();
    },
    { features, form, camera: CAMERA },
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

/**
 * Writes the pictures of a comparison as PNG to `E2E_DUMP_DIR`, when it is set: the two pictures
 * over white, and the pixels that differ by more than `level` painted red over the first faded
 */
async function dump(page: Page, scene: string, a: string, b: string, level: number): Promise<void> {
  const dir = process.env.E2E_DUMP_DIR;
  if (!dir) return;
  const urls = await page.evaluate(
    ({ a, b, level }) => {
      const w = window as unknown as {
        map: import('maplibre-gl').Map;
        captured: Record<string, Uint8Array>;
      };
      const gl = w.map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const pa = w.captured[a];
      const pb = w.captured[b];
      /** A PNG of pixels read from the bottom row up, each set by `paint` */
      const png = (paint: (out: Uint8ClampedArray, o: number, i: number) => void): string => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d') as CanvasRenderingContext2D;
        const image = context.createImageData(width, height);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const i = ((height - 1 - y) * width + x) * 4;
            const o = (y * width + x) * 4;
            paint(image.data, o, i);
            image.data[o + 3] = 255;
          }
        }
        context.putImageData(image, 0, 0);
        return canvas.toDataURL('image/png');
      };
      // The drawing buffer holds premultiplied colors: over white, a channel gains 255 - alpha
      const overWhite =
        (pixels: Uint8Array) =>
        (out: Uint8ClampedArray, o: number, i: number): void => {
          for (let k = 0; k < 3; k++) out[o + k] = pixels[i + k] + 255 - pixels[i + 3];
        };
      const differs = (i: number): boolean => {
        for (let k = 0; k < 4; k++) if (Math.abs(pa[i + k] - pb[i + k]) > level) return true;
        return false;
      };
      return {
        rows: png(overWhite(pa)),
        store: png(overWhite(pb)),
        diff: png((out, o, i) => {
          if (differs(i)) {
            out[o] = 255;
            out[o + 1] = 0;
            out[o + 2] = 0;
            return;
          }
          for (let k = 0; k < 3; k++) {
            const white = pa[i + k] + 255 - pa[i + 3];
            out[o + k] = 255 - (255 - white) * 0.3;
          }
        }),
      };
    },
    { a, b, level },
  );
  mkdirSync(dir, { recursive: true });
  for (const [name, url] of Object.entries(urls)) {
    writeFileSync(
      join(dir, `${scene}-${name}.png`),
      Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'),
    );
  }
}

/** The count of the selection and whether it is in bulk */
async function selection(page: Page): Promise<{ bulk: boolean; count: number }> {
  return page.evaluate(() => {
    const draw = (window as unknown as { draw: import('../index.js').Draw }).draw;
    return { bulk: draw.selection.value.ids === null, count: draw.selection.count() };
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
    await dump(page, 'selected', 'selected-rows', 'selected-store', FRAME_TOLERANCE.level);
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
      await dump(
        page,
        `move-${phase}`,
        `move-rows-${phase}`,
        `move-store-${phase}`,
        FRAME_TOLERANCE.level,
      );
      const drawn = await capture(page, `move-check-${phase}`);
      expect(differs).toBeLessThanOrEqual(Math.floor(drawn * FRAME_TOLERANCE.share));
    }
  });

  it('turn all from the rotation handle, drawn turned in the shader, written once let go', {
    timeout: browserTimeout(120_000),
  }, async () => {
    const features = scene();
    /**
     * The rotation handle: above the middle of the top of the frame, the margin of the frame
     * (10 px) and the distance of the handle (10 px) above the top of the features, on a map
     * untilted and unturned
     */
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
        const handle = w.map.unproject([top.x, top.y - 10 - 10]);
        return [handle.lng, handle.lat] as [number, number];
      });
    await open(page, features, 'store');
    const handle = await handleOf();
    const to = at(0.006, 0.006);
    const original = await cornerOf(page, 'building0');
    await dragged(handle, to, 'rotate-store');
    const turnedByObjects = await cornerOf(page, 'building0');
    // The drag took the handle (a press beside it moves the map, and nothing turns)
    expect(turnedByObjects).not.toEqual(original);
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
      await dump(
        page,
        `rotate-${phase}`,
        `rotate-rows-${phase}`,
        `rotate-store-${phase}`,
        FRAME_TOLERANCE.level,
      );
      const drawn = await capture(page, `rotate-check-${phase}`);
      expect(differs).toBeLessThanOrEqual(Math.floor(drawn * FRAME_TOLERANCE.share));
    }
  });
});
