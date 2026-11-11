// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the rows written in place, drawn in one draw per chunk
 *
 * Rows are drawn, then written through the writer of their tables (`writer.writeRows`), on the real
 * maplibre and WebGL of the browser, and the picture once everything is written is compared with
 * the picture of the rows as written, drawn from the start. Two kinds of writes:
 *
 * - writes that fit the places of their rows in their chunks, written in place: a corner of a
 *   building moved, a point moved, a vertex of a line moved, a vertex of a building taken off, a
 *   dashed line moved, a line made dotted, an outline taken off, a color changed, the radius of a
 *   Circle changed, a row hidden
 * - writes that do not fit: a vertex added to a line, an outline put on a fill (the rows go to the
 *   delta of their layer, and the next versions of their groups take them)
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
  properties?: Record<string, unknown>;
}

/** A write of a field of a row */
interface SceneWrite {
  id: string;
  field: string;
  value: unknown;
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

const RADIUS = 'maplibre-gl-draw:radiusMeters';

/** The rows of the scene: buildings, points, lines, dashed lines, a fill, a Circle, half transparent */
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
    out.push({
      id: `dashed${i}`,
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [at(x - 0.001, -0.003), at(x, -0.0025), at(x + 0.001, -0.003)],
      },
      style: { strokeWidth: 4, lineStyle: 'dashed' },
    });
  }
  out.push({
    id: 'fill',
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [ring(0.006, -0.005, 0.0015, 7)] },
    style: { fillColor: '#f28e2b', fillOpacity: 0.5, strokeWidth: 0 },
  });
  out.push({
    id: 'circle',
    type: 'Circle',
    geometry: { type: 'Point', coordinates: at(-0.006, -0.005) },
    style: { fillColor: '#76b7b2', fillOpacity: 0.5, strokeWidth: 2 },
    properties: { [RADIUS]: 120 },
  });
  return out;
}

/** The writes that fit the places of their rows */
function fitting(): SceneWrite[] {
  const corner = ring(-0.009, 0.004, 0.0012, 5);
  corner[2] = at(-0.009 + 0.0004, 0.004 + 0.0016);
  const fewer = ring(-0.0055, 0.004, 0.0012, 6);
  fewer.splice(3, 1);
  return [
    { id: 'building0', field: 'geometry', value: { type: 'Polygon', coordinates: [corner] } },
    { id: 'building1', field: 'geometry', value: { type: 'Polygon', coordinates: [fewer] } },
    { id: 'point2', field: 'geometry', value: { type: 'Point', coordinates: at(-0.002, 0.0022) } },
    {
      id: 'line3',
      field: 'geometry',
      value: {
        type: 'LineString',
        coordinates: [at(0.0005, -0.001), at(0.0015, 0.0006), at(0.0025, -0.0015)],
      },
    },
    {
      id: 'dashed4',
      field: 'geometry',
      value: {
        type: 'LineString',
        coordinates: [at(0.004, -0.003), at(0.005, -0.002), at(0.006, -0.003)],
      },
    },
    { id: 'line5', field: 'style', value: { strokeWidth: 4, lineStyle: 'dotted' } },
    {
      id: 'building2',
      field: 'style',
      value: { fillColor: '#4e79a7', fillOpacity: 0.6, strokeWidth: 0 },
    },
    {
      id: 'building3',
      field: 'style',
      value: { fillColor: '#ff00ff', fillOpacity: 0.6, strokeWidth: 3 },
    },
    { id: 'circle', field: `properties:${RADIUS}`, value: 200 },
    { id: 'point0', field: 'hidden', value: true },
  ];
}

/** The writes that do not fit the places of their rows */
function notFitting(): SceneWrite[] {
  return [
    {
      id: 'line0',
      field: 'geometry',
      value: {
        type: 'LineString',
        coordinates: [at(-0.01, -0.001), at(-0.0095, 0.0006), at(-0.009, 0), at(-0.008, -0.0015)],
      },
    },
    {
      id: 'fill',
      field: 'style',
      value: { fillColor: '#f28e2b', fillOpacity: 0.5, strokeWidth: 4 },
    },
  ];
}

/** The features of a scene with writes applied (the same writes the writer takes) */
function written(features: SceneFeature[], writes: SceneWrite[]): SceneFeature[] {
  return features.map((f) => {
    let out = { ...f, properties: { ...(f.properties ?? {}) } };
    for (const write of writes) {
      if (write.id !== f.id) continue;
      if (write.field === 'geometry')
        out = { ...out, geometry: write.value as SceneFeature['geometry'] };
      else if (write.field === 'style')
        out = { ...out, style: write.value as Record<string, unknown> };
      else if (write.field === 'hidden') out = { ...out, visible: !write.value } as never;
      else out.properties[write.field.slice('properties:'.length)] = write.value;
    }
    return out;
  });
}

/**
 * Draws a scene as rows in a new instance, applies writes once everything is drawn, and keeps the
 * pixels of the frame once everything is written and built again under `key`
 *
 * @returns The number of pixels drawn, and what the writes in place did
 */
async function drawWritten(
  page: Page,
  key: string,
  features: SceneFeature[],
  writes: SceneWrite[],
): Promise<{ drawn: number; inPlace: number; rebuilt: number }> {
  return page.evaluate(
    async ({ key, features, writes }) => {
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
      const builder = w.e2e.tables.createPageBuilder({});
      features.forEach((f, i) => {
        builder.addRow({
          id: f.id,
          type: f.type,
          geometry: f.geometry,
          order: `k${String(i).padStart(6, '0')}`,
          style: f.style ?? {},
          properties: f.properties ?? {},
          visible: (f as { visible?: boolean }).visible !== false,
          locked: false,
        } as never);
      });
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
      for (const write of writes) {
        const handle = tables.getRowRef(write.id);
        if (handle === undefined) throw new Error(`no row ${write.id}`);
        writer.writeRows({
          handles: Int32Array.of(handle),
          fields: new Map([[write.field as never, [write.value]]]),
        });
      }
      const pixels = await settle();
      w.captured ??= {};
      (w.captured as Record<string, Uint8Array>)[key] = pixels;
      let drawn = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) drawn++;
      const stats = w.e2e.internals.tableDiagnosticsOf(w.draw).editStats();
      return { drawn, inPlace: stats.inPlace, rebuilt: stats.rebuilt };
    },
    { key, features, writes },
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

describe('the rows written in place against the rows as written drawn from the start', () => {
  let page: Page;

  beforeAll(async () => {
    page = await openMapPage(browser, bundle, CAMERA);
  }, browserTimeout(60_000));

  afterAll(async () => {
    await page?.close();
  });

  /** Writes a scene, draws the scene as written from the start, and compares the pictures */
  async function compare(name: string, writes: SceneWrite[]) {
    const features = scene();
    const live = await drawWritten(page, `${name}-written`, features, writes);
    const built = await drawWritten(page, `${name}-built`, written(features, writes), []);
    const differs = await differing(page, `${name}-written`, `${name}-built`, TOLERANCE.level);
    console.log(
      `[writes in place] ${name}: ${live.drawn} pixels drawn, ${differs} differ ` +
        `(${live.inPlace} in place, ${live.rebuilt} built again)`,
    );
    expect(live.drawn).toBeGreaterThan(0);
    expect(built.drawn).toBeGreaterThan(0);
    expect(differs).toBeLessThanOrEqual(Math.floor(live.drawn * TOLERANCE.share));
    return live;
  }

  it('draws the rows written in their places as the rows as written', {
    timeout: browserTimeout(90_000),
  }, async () => {
    const live = await compare('fitting', fitting());
    expect(live.rebuilt).toBe(0);
    expect(live.inPlace).toBeGreaterThan(0);
  });

  it('draws the rows that did not fit their places, through the delta, as the rows as written', {
    timeout: browserTimeout(90_000),
  }, async () => {
    const live = await compare('not-fitting', notFitting());
    expect(live.rebuilt).toBeGreaterThan(0);
  });
});
