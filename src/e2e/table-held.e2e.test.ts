// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the rows held as features, drawn in one draw per chunk
 *
 * Rows of an in-memory Store of rows are drawn, then held as features (`tables.hold`, without a
 * selection, so no handle is drawn over them), on the real maplibre and WebGL of the browser,
 * and the pictures are compared with the pictures of the rows as they are then, drawn from the
 * start:
 *
 * - held and not changed: drawn from their rows as they were
 * - in the middle of an edit that fits the places of their rows (a corner of a building moved, a
 *   point moved): written in place
 * - in the middle of an edit that does not fit (a vertex added to a line, an outline put on a
 *   fill): drawn from the delta of their layer, their copies in their groups hidden
 *
 * The rows written in place keep the origin of their chunk, and a chunk built again may take
 * another, so the pictures are compared with the tolerance of the other comparisons of the
 * drawing in one draw.
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

/** A feature of a scene */
interface SceneFeature {
  id: string;
  type: string;
  geometry: { type: string; coordinates: unknown };
  style?: Record<string, unknown>;
}

/** An edit of a feature held: the fields of it written in the middle of the edit */
interface SceneEdit {
  id: string;
  geometry?: SceneFeature['geometry'];
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

/** The rows held in every scene */
const HELD = ['building0', 'point2', 'line0', 'fill', 'building3'];

/** Edits that fit the places of their rows */
function fitting(): SceneEdit[] {
  const corner = ring(-0.009, 0.004, 0.0012, 5);
  corner[2] = at(-0.009 + 0.0004, 0.004 + 0.0016);
  return [
    { id: 'building0', geometry: { type: 'Polygon', coordinates: [corner] } },
    { id: 'point2', geometry: { type: 'Point', coordinates: at(-0.002, 0.0022) } },
  ];
}

/** Edits that do not fit the places of their rows */
function notFitting(): SceneEdit[] {
  return [
    {
      id: 'line0',
      geometry: {
        type: 'LineString',
        coordinates: [at(-0.01, -0.001), at(-0.0095, 0.0006), at(-0.009, 0), at(-0.008, -0.0015)],
      },
    },
    { id: 'fill', style: { fillColor: '#f28e2b', fillOpacity: 0.5, strokeWidth: 4 } },
  ];
}

/** The features of a scene with edits applied */
function edited(features: SceneFeature[], edits: SceneEdit[]): SceneFeature[] {
  return features.map((f) => {
    const edit = edits.find((e) => e.id === f.id);
    if (!edit) return f;
    return {
      ...f,
      ...(edit.geometry && { geometry: edit.geometry }),
      ...(edit.style && { style: edit.style }),
    };
  });
}

/**
 * Draws a scene as rows of an in-memory Store of rows in a new instance, holds rows, writes edits
 * in their middle once everything is drawn, and keeps the pixels of the frame once everything is
 * written under `key`
 *
 * @returns The number of pixels drawn, and the rows of the delta of the layer
 */
async function drawHeld(
  page: Page,
  key: string,
  features: SceneFeature[],
  held: string[],
  edits: SceneEdit[],
): Promise<{ drawn: number; delta: number }> {
  return page.evaluate(
    async ({ key, features, held, edits }) => {
      const w = window as unknown as Record<string, unknown> & {
        map: import('maplibre-gl').Map;
        draw: import('../index.js').Draw;
        e2e: {
          createDraw: typeof import('../index.js').createDraw;
          tables: {
            createRowBlockBuilder: typeof import('../table/row-group-builder.js').createRowBlockBuilder;
            createTableStore: typeof import('../store/table-memory.js').createTableStore;
          };
          internals: {
            tableDiagnosticsOf: typeof import('../api/impl/table-diagnostics.js').tableDiagnosticsOf;
            featureTablesInternals: typeof import('../feature-table/feature-tables.js').featureTablesInternals;
          };
        };
      };
      const { map } = w;
      const { store, writer } = w.e2e.tables.createTableStore();
      store.createLayer({
        id: 'rows',
        name: 'rows',
        visible: true,
        locked: false,
        opacity: 1,
        kind: 'table',
        styleRule: undefined,
        metadata: undefined,
      });
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
      writer.addRowBlocks('rows', builder.finish());
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
        for (let i = 0; i < 200; i++) {
          if (!w.draw.hasPendingWork()) break;
          pixels = await read();
        }
        // Two more frames with everything built (a chunk is drawn the frame after it is written)
        await read();
        pixels = await read();
        return pixels;
      };
      await settle();
      // Held without a selection: no handle is drawn over them
      w.e2e.internals.featureTablesInternals(store.tables)?.open('e2e', held);
      for (const edit of edits) {
        const updates: Record<string, unknown> = {};
        if (edit.geometry) updates.geometry = edit.geometry;
        if (edit.style) updates.style = edit.style;
        store.updateFeature(edit.id, updates as never, { isIntermediate: true });
      }
      const pixels = await settle();
      w.captured ??= {};
      (w.captured as Record<string, Uint8Array>)[key] = pixels;
      let drawn = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) drawn++;
      const delta = w.e2e.internals.tableDiagnosticsOf(w.draw).editStats().deltaRows;
      return { drawn, delta };
    },
    { key, features, held, edits },
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

describe('the rows held as features against the rows as they are drawn from the start', () => {
  let page: Page;

  beforeAll(async () => {
    page = await openMapPage(browser, bundle, CAMERA);
  }, browserTimeout(60_000));

  afterAll(async () => {
    await page?.close();
  });

  /** Holds and edits a scene, draws the scene as edited from the start, compares the pictures */
  async function compare(name: string, edits: SceneEdit[]) {
    const features = scene();
    const live = await drawHeld(page, `${name}-held`, features, HELD, edits);
    const built = await drawHeld(page, `${name}-built`, edited(features, edits), [], []);
    const differs = await differing(page, `${name}-held`, `${name}-built`, TOLERANCE.level);
    console.log(
      `[rows held] ${name}: ${live.drawn} pixels drawn, ${differs} differ ` +
        `(${live.delta} rows in the delta)`,
    );
    expect(live.drawn).toBeGreaterThan(0);
    expect(built.drawn).toBeGreaterThan(0);
    expect(differs).toBeLessThanOrEqual(Math.floor(live.drawn * TOLERANCE.share));
    return live;
  }

  it('draws the rows held and not changed from their rows', {
    timeout: browserTimeout(90_000),
  }, async () => {
    const live = await compare('unchanged', []);
    expect(live.delta).toBe(0);
  });

  it('draws the rows held in the middle of an edit that fits, written in place', {
    timeout: browserTimeout(90_000),
  }, async () => {
    const live = await compare('fitting', fitting());
    expect(live.delta).toBe(0);
  });

  it('draws the rows held in the middle of an edit that does not fit, from the delta', {
    timeout: browserTimeout(90_000),
  }, async () => {
    const live = await compare('not-fitting', notFitting());
    expect(live.delta).toBeGreaterThan(0);
  });
});
