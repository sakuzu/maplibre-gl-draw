// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the markers of the points with a rotation (`maplibre-gl-draw:rotation`), on
 * the real maplibre and WebGL of the browser
 *
 * A marker with a rotation keeps its direction on the map: it is turned on screen by the rotation
 * plus the bearing of the map. A marker without one stays upright on screen. The same points are
 * drawn in the three ways points are drawn, and the pictures are compared:
 *
 * - the rows in one draw (the default on a flat map), the rows by kind
 *   (`tableDiagnosticsOf(draw).setDrawingByKind(true)`) and the features of a Store of objects
 * - a marker turned by its rotation and by the bearing of the map against the marker of the sum of
 *   the two on a map with the north up, and a marker without a rotation on both maps
 * - the markers while a sketch of this client turns them (the rows by the state of their rows,
 *   the features of the Store on the CPU) against the markers once the sketch is written
 * - the markers once their rotation alone, then their color alone, is written in place against the
 *   markers drawn with those values from the start
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import { type Bundle, bundlePage, type Camera, launchBrowser, openMapPage } from './harness.js';

const CENTER: [number, number] = [139.7, 35.68];
const CAMERA: Camera = { center: CENTER, zoom: 14 };
const ROTATION = 'maplibre-gl-draw:rotation';

/**
 * The differences allowed between two pictures: the share of the pixels drawn whose channels
 * differ by more than `level` (as the drawing in one draw against the drawing by kind)
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

/** A point of a scene */
interface ScenePoint {
  id: string;
  type: 'Point';
  geometry: { type: 'Point'; coordinates: [number, number] };
  style: Record<string, unknown>;
  properties: Record<string, unknown>;
}

/** A position at an offset from the center, in degrees */
const at = (dx: number, dy: number): [number, number] => [CENTER[0] + dx, CENTER[1] + dy];

function point(
  id: string,
  x: number,
  y: number,
  shape: string,
  rotation: number | undefined,
): ScenePoint {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: at(x, y) },
    style: { pointShape: shape, pointRadius: 14, strokeColor: '#ffffff', strokeWidth: 2 },
    properties: rotation === undefined ? {} : { [ROTATION]: rotation },
  };
}

/** Markers of every shape that turns, with rotations and without, half of them with one */
const MARKERS: ScenePoint[] = [
  point('triangle-30', -0.006, 0.003, 'triangle', 30),
  point('triangle', -0.002, 0.003, 'triangle', undefined),
  point('star-75', 0.002, 0.003, 'star', -75),
  point('star-0', 0.006, 0.003, 'star', 0),
  point('square-10', -0.006, -0.003, 'square', 10),
  point('square', -0.002, -0.003, 'square', undefined),
  point('triangle-200', 0.002, -0.003, 'triangle', 200.5),
  point('circle-45', 0.006, -0.003, 'circle', 45),
];

/** How a scene is drawn */
interface SceneOptions {
  /**
   * `rows`: rows of a page of the tables of a Store; `made`: rows of the Store of rows of the
   * library, made by `features.createMany` (which a sketch edits by the IDs of its features);
   * `store`: the features of a Store of objects
   */
  form: 'rows' | 'made' | 'store';
  /** The rows by kind rather than in one draw */
  byKind?: boolean;
  /** The bearing of the map (0 when omitted) */
  bearing?: number;
  /**
   * A sketch of this client that turns every point of the scene about the center by this angle:
   * the picture under `key` is drawn while it is shown, and the one under `${key}-written` once
   * it is written
   */
  turn?: number;
  /**
   * Edits written one after the other once everything is built (each by a sketch committed at
   * once): the picture under `key` is drawn once they are written
   */
  writes?: Array<Record<string, unknown>>;
}

/**
 * Draws a scene in a new instance over a Store of its own, and keeps the pixels of the frame
 * once everything is built under `key`
 *
 * @returns The number of pixels drawn
 */
async function drawScene(
  page: Page,
  key: string,
  points: ScenePoint[],
  options: SceneOptions,
): Promise<number> {
  return page.evaluate(
    async ({ key, points, form, byKind, bearing, turn, writes, center }) => {
      type Contract = import('../index.js').Store;
      const w = window as unknown as Record<string, unknown> & {
        map: import('maplibre-gl').Map;
        draw: import('../index.js').Draw;
        e2e: {
          createDraw: typeof import('../index.js').createDraw;
          tables: {
            createTableStore: typeof import('../kasane/index.js').createTableStore;
            createFeatureTables: typeof import('../kasane/index.js').createFeatureTables;
            createPageBuilder: typeof import('../table/feature-row-blocks.js').createFeaturePageBuilder;
          };
          internals: {
            MemoryContractStore: new () => Contract;
            tableDiagnosticsOf: typeof import('../api/impl/table-diagnostics.js').tableDiagnosticsOf;
          };
          writesOf: typeof import('../test-support/writes.js').writesOf;
        };
      };
      const { map } = w;
      map.jumpTo({ bearing });
      const layer = { id: 'points', name: 'points', visible: true, locked: false, opacity: 1 };
      const made = form === 'made' ? w.e2e.tables.createTableStore() : null;
      made?.store.createLayer({
        ...layer,
        kind: 'table',
        styleRule: undefined,
        metadata: undefined,
      } as never);
      const store =
        (made?.store as unknown as Contract) ?? new w.e2e.internals.MemoryContractStore();
      if (!made)
        store.transact(() => {
          store.createLayer({
            id: 'points',
            name: 'points',
            visible: true,
            locked: false,
            opacity: 1,
            items: [],
            styleRule: undefined,
            metadata: undefined,
          });
          if (form === 'store') {
            for (const p of points) {
              store.createFeature({
                id: p.id,
                type: p.type,
                geometry: p.geometry,
                style: p.style,
                properties: p.properties,
                layerId: 'points',
                groupId: undefined,
                visible: true,
                locked: false,
              } as never);
            }
          }
        }, 'remote');
      if (form === 'rows') {
        const { tables, writer } = w.e2e.tables.createFeatureTables();
        const builder = w.e2e.tables.createPageBuilder({});
        points.forEach((p, i) => {
          builder.addRow({
            id: p.id,
            type: p.type,
            geometry: p.geometry as never,
            key: `k${String(i).padStart(6, '0')}`,
            style: p.style,
            properties: p.properties,
            hidden: false,
            locked: false,
          });
        });
        writer.addPages('points', builder.finish());
        Object.defineProperty(store, 'tables', { value: tables });
      }
      w.draw.destroy();
      w.draw = w.e2e.createDraw(map, { store, initDefaultLayer: false });
      if (made) {
        const created = w.e2e
          .writesOf(w.draw)
          .features.createMany(points.map((p) => ({ ...p, layerId: 'points' })) as never);
        if (!created) throw new Error('the features were not created');
      }
      if (byKind) w.e2e.internals.tableDiagnosticsOf(w.draw).setDrawingByKind(true);

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
      const settled = async (): Promise<Uint8Array> => {
        await read();
        for (let i = 0; i < 200; i++) {
          if (!w.draw.hasPendingWork()) break;
          await read();
        }
        // Two more frames with everything built (a chunk is drawn the frame after it is written)
        await read();
        return read();
      };
      w.captured ??= {};
      const captured = w.captured as Record<string, Uint8Array>;

      let pixels: Uint8Array;
      if (writes !== null) {
        await settled();
        for (const edit of writes) {
          const sketch = w.draw.sketches.add({ edits: [edit as never] });
          if (!sketch || !w.draw.sketches.commit(sketch.id)) throw new Error('not written');
          await settled();
        }
        pixels = await settled();
      } else if (turn === null) pixels = await settled();
      else {
        await settled();
        const sketch = w.draw.sketches.add({
          edits: [
            {
              kind: 'rotate',
              target: { featureIds: points.map((p) => p.id) },
              center,
              angleDegrees: turn,
            },
          ],
        });
        if (!sketch) throw new Error('the sketch was refused');
        pixels = await settled();
        if (!w.draw.sketches.commit(sketch.id)) throw new Error('the sketch was not written');
        captured[`${key}-written`] = await settled();
      }
      captured[key] = pixels;
      let count = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) count++;
      return count;
    },
    {
      key,
      points,
      form: options.form,
      byKind: options.byKind ?? false,
      bearing: options.bearing ?? 0,
      turn: options.turn ?? null,
      writes: options.writes ?? null,
      center: CENTER,
    },
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

/** Checks two pictures differ within the tolerance */
async function expectSame(page: Page, a: string, b: string, drawn: number): Promise<void> {
  const differs = await differing(page, a, b, TOLERANCE.level);
  console.log(`[point rotation] ${a} / ${b}: ${drawn} pixels drawn, ${differs} differ`);
  expect(drawn).toBeGreaterThan(0);
  expect(differs).toBeLessThanOrEqual(Math.floor(drawn * TOLERANCE.share));
}

/**
 * The reach of the pixels drawn from the center of the map to its left and to its right (device
 * pixels; the canvas is drawn at a ratio of 1), of a picture of one marker at the center
 */
async function reach(page: Page, key: string): Promise<{ left: number; right: number }> {
  return page.evaluate((key) => {
    const w = window as unknown as {
      map: import('maplibre-gl').Map;
      captured: Record<string, Uint8Array>;
    };
    const pixels = w.captured[key];
    const gl = w.map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
    const width = gl.drawingBufferWidth;
    const cx = width / 2;
    let left = 0;
    let right = 0;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] < 128) continue;
      const x = ((i - 3) / 4) % width;
      left = Math.max(left, cx - x);
      right = Math.max(right, x - cx);
    }
    return { left, right };
  }, key);
}

describe('the markers of the points with a rotation', () => {
  let page: Page;

  beforeAll(async () => {
    page = await openMapPage(browser, bundle, CAMERA);
  }, browserTimeout(60_000));

  afterAll(async () => {
    await page?.close();
  });

  it('turns a marker with the map, by its rotation counterclockwise, and keeps one without upright', {
    timeout: browserTimeout(90_000),
  }, async () => {
    const one = (rotation: number | undefined) => [point('p', 0, 0, 'triangle', rotation)];
    // A rotation and a bearing draw the marker of their sum on a map with the north up
    const drawn = await drawScene(page, 'turned-on-map', one(30), { form: 'rows', bearing: 40 });
    await drawScene(page, 'turned-north-up', one(70), { form: 'rows' });
    await expectSame(page, 'turned-on-map', 'turned-north-up', drawn);
    // Without a rotation the marker stays upright whatever the bearing
    const upright = await drawScene(page, 'upright-on-map', one(undefined), {
      form: 'rows',
      bearing: 40,
    });
    await drawScene(page, 'upright-north-up', one(undefined), { form: 'rows' });
    await expectSame(page, 'upright-on-map', 'upright-north-up', upright);
    // The turned marker is not the upright one
    expect(await differing(page, 'turned-north-up', 'upright-north-up', 8)).toBeGreaterThan(
      upright * 0.05,
    );
    // A triangle turned by 90 degrees counterclockwise points to the left (the west)
    await drawScene(page, 'west', one(90), { form: 'rows' });
    const west = await reach(page, 'west');
    console.log(`[point rotation] a triangle turned by 90 degrees reaches ${JSON.stringify(west)}`);
    expect(west.left).toBeGreaterThan(west.right + 4);
    // A rotation of 0 is the marker upright with the north up
    await drawScene(page, 'zero', one(0), { form: 'rows' });
    expect(await differing(page, 'zero', 'upright-north-up', 0)).toBe(0);
  });

  for (const way of ['one-draw', 'by-kind', 'store'] as const) {
    it(`draws a turned square whole, its corners beyond the billboard of the upright one, drawn ${way}`, {
      timeout: browserTimeout(90_000),
    }, async () => {
      const name = `whole-${way}`;
      const options: SceneOptions = {
        form: way === 'store' ? 'store' : 'rows',
        byKind: way === 'by-kind',
      };
      // Half its side is its outer radius, 16 pixels: turned by 45 degrees, its corners reach
      // 16√2 (22.6) pixels to the left and to the right, beyond the 17 of the billboard upright
      const square = (rotation: number) => [point('p', 0, 0, 'square', rotation)];
      const upright = await drawScene(page, `${name}-0`, square(0), options);
      const turned = await drawScene(page, `${name}-45`, square(45), options);
      const corners = await reach(page, `${name}-45`);
      console.log(
        `[point rotation] a square turned by 45 degrees: ${turned} pixels drawn against ${upright}, reaching ${JSON.stringify(corners)}`,
      );
      expect(corners.left).toBeGreaterThanOrEqual(21);
      expect(corners.right).toBeGreaterThanOrEqual(21);
      // The same area, but for the band of its edge
      expect(Math.abs(turned - upright)).toBeLessThanOrEqual(upright * 0.03);
    });
  }

  for (const bearing of [0, 40]) {
    it(`draws the markers at the same angles in the three ways, at a bearing of ${bearing}`, {
      timeout: browserTimeout(90_000),
    }, async () => {
      const name = `three-${bearing}`;
      const drawn = await drawScene(page, `${name}-one-draw`, MARKERS, { form: 'rows', bearing });
      await drawScene(page, `${name}-by-kind`, MARKERS, { form: 'rows', byKind: true, bearing });
      await drawScene(page, `${name}-store`, MARKERS, { form: 'store', bearing });
      await expectSame(page, `${name}-one-draw`, `${name}-by-kind`, drawn);
      await expectSame(page, `${name}-one-draw`, `${name}-store`, drawn);
    });
  }

  for (const way of ['one-draw', 'by-kind', 'store'] as const) {
    it(`turns the markers while a sketch turns them as they are written, drawn ${way}`, {
      timeout: browserTimeout(90_000),
    }, async () => {
      const name = `sketch-${way}`;
      const options: SceneOptions = {
        form: way === 'store' ? 'store' : 'made',
        byKind: way === 'by-kind',
        bearing: 25,
        turn: 50,
      };
      const drawn = await drawScene(page, name, MARKERS, options);
      await expectSame(page, name, `${name}-written`, drawn);
      // The sketch turned them: the markers before it are drawn elsewhere and at other angles
      await drawScene(page, `${name}-before`, MARKERS, { ...options, turn: undefined });
      expect(await differing(page, `${name}-before`, name, 8)).toBeGreaterThan(drawn * 0.05);
    });
  }

  for (const way of ['one-draw', 'by-kind', 'store'] as const) {
    it(`turns the markers by their rotation written alone, and keeps it with a color written, drawn ${way}`, {
      timeout: browserTimeout(90_000),
    }, async () => {
      const name = `write-${way}`;
      const options: SceneOptions = {
        form: way === 'store' ? 'store' : 'made',
        byKind: way === 'by-kind',
        bearing: 25,
      };
      const set = (id: string, patch: Record<string, unknown>) => ({
        kind: 'set',
        featureId: id,
        patch,
      });
      // A rotation given, changed and taken away, then a color with a rotation kept
      const writes = [
        set('triangle', { properties: { [ROTATION]: 120 } }),
        set('star-75', { properties: { [ROTATION]: 10 } }),
        set('square-10', { properties: { [ROTATION]: undefined } }),
        set('triangle-30', { style: { pointColor: '#3366ff' } }),
      ];
      const written = MARKERS.map((p) => {
        if (p.id === 'triangle') return { ...p, properties: { [ROTATION]: 120 } };
        if (p.id === 'star-75') return { ...p, properties: { [ROTATION]: 10 } };
        if (p.id === 'square-10') return { ...p, properties: {} };
        if (p.id === 'triangle-30') return { ...p, style: { ...p.style, pointColor: '#3366ff' } };
        return p;
      });
      const drawn = await drawScene(page, name, MARKERS, { ...options, writes });
      await drawScene(page, `${name}-fresh`, written, options);
      await expectSame(page, name, `${name}-fresh`, drawn);
    });
  }
});
