// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the columnar input of the datasets
 *
 * The same rows are drawn once as features and once as a columnar table (with and without the
 * arrays of `prepareDatasetColumnar`), on the real maplibre and WebGL of the browser. The pictures
 * must be the same pixel for pixel, and a click with the real pointer must report the same
 * feature and row.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Bundle,
  bundlePage,
  type Camera,
  click,
  launchBrowser,
  MAP_SIZE,
  openMapPage,
  pageOf,
} from './harness.js';

const CAMERA: Camera = { center: [139.7, 35.68], zoom: 12 };

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

type Kind = 'points' | 'lines' | 'polygons';

/**
 * Builds the rows of a kind in the page (as features and as a table), and the helpers that draw
 * one dataset and read the pixels
 */
async function installRows(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const CLASSES = ['road', 'rail', 'river', 'park'];
    /** Rows around the center: [coordinates of each row, class index, value] */
    const rowsOf = (kind: string) => {
      const rows: Array<{ coords: number[][]; cls: number; value: number }> = [];
      for (let i = 0; i < 400; i++) {
        const x = 139.66 + (i % 20) * 0.004;
        const y = 35.655 + Math.floor(i / 20) * 0.0025;
        const cls = (i * 7) % 4;
        if (kind === 'points') rows.push({ coords: [[x, y]], cls, value: i });
        else if (kind === 'lines') {
          rows.push({
            coords: [
              [x, y],
              [x + 0.002, y + 0.001],
              [x + 0.003, y - 0.0005],
            ],
            cls,
            value: i,
          });
        } else {
          rows.push({
            coords: [
              [x, y],
              [x + 0.003, y],
              [x + 0.003, y + 0.002],
              [x, y + 0.002],
              [x, y],
            ],
            cls,
            value: i,
          });
        }
      }
      return rows;
    };
    const typeOf = (kind: string) =>
      kind === 'points' ? 'Point' : kind === 'lines' ? 'LineString' : 'Polygon';

    w.featuresOf = (kind: string) =>
      rowsOf(kind).map((row, i) => ({
        id: `r${i}`,
        type: typeOf(kind),
        coordinates:
          kind === 'points' ? row.coords[0] : kind === 'lines' ? row.coords : [row.coords],
        properties: { cls: CLASSES[row.cls], value: row.value },
      }));

    w.tableOf = (kind: string) => {
      const rows = rowsOf(kind);
      const coords: number[] = [];
      const rowOffsets = [0];
      const ringOffsets = [0];
      for (const row of rows) {
        for (const c of row.coords) coords.push(c[0], c[1]);
        if (kind === 'lines') rowOffsets.push(coords.length / 2);
        if (kind === 'polygons') {
          ringOffsets.push(coords.length / 2);
          rowOffsets.push(ringOffsets.length - 1);
        }
      }
      const offsets =
        kind === 'points'
          ? []
          : kind === 'lines'
            ? [Int32Array.from(rowOffsets)]
            : [Int32Array.from(rowOffsets), Int32Array.from(ringOffsets)];
      return {
        length: rows.length,
        geometry: { type: typeOf(kind), coords: Float64Array.from(coords), offsets },
        ids: rows.map((_, i) => `r${i}`),
        columns: {
          cls: { codes: Int32Array.from(rows, (r) => r.cls), dictionary: CLASSES },
          value: Float64Array.from(rows, (r) => r.value),
        },
      };
    };

    w.STYLE = {
      styleRule: {
        kind: 'categorical',
        property: 'cls',
        map: { road: '#e15759', rail: '#4e79a7', river: '#59a14f' },
        other: '#f28e2b',
      },
      baseStyle: {
        point: { pointRadius: 5 },
        stroke: { strokeWidth: 3 },
        fill: { fillOpacity: 0.5 },
      },
      interactive: true,
    };
  });
}

/**
 * Adds one dataset, draws until every chunk is built, and returns the pixels of the canvas
 * (read in the render event, before the frame is shown)
 */
async function drawAndRead(
  page: Page,
  kind: Kind,
  form: 'features' | 'columnar' | 'prepared',
): Promise<{ differs: (other: string) => Promise<number>; key: string; drawn: number }> {
  const key = `${kind}-${form}`;
  const drawn = await page.evaluate(
    async ({ kind, form, key }) => {
      const w = window as unknown as Record<string, unknown> & {
        map: import('maplibre-gl').Map;
        draw: import('../index.js').MapLibreGLDraw;
        e2e: { prepareDatasetColumnar: (input: unknown) => unknown };
      };
      const { map, draw } = w;
      for (const c of draw.getDatasets()) draw.removeDataset(c.id);
      const style = w.STYLE as object;
      const options =
        form === 'features'
          ? { features: (w.featuresOf as (k: string) => unknown)(kind) }
          : form === 'columnar'
            ? { columnar: (w.tableOf as (k: string) => unknown)(kind) }
            : (() => {
                const table = (w.tableOf as (k: string) => unknown)(kind);
                return { columnar: table, prepared: w.e2e.prepareDatasetColumnar(table) };
              })();
      const dataset = draw.addDataset({
        id: 'data',
        ...style,
        ...(options as object),
      } as Parameters<typeof draw.addDataset>[0]);
      w.captured ??= {};
      const captured = w.captured as Record<string, Uint8Array>;
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
      for (let i = 0; i < 100; i++) {
        if (!(dataset as unknown as { hasPendingBuild: boolean }).hasPendingBuild) break;
        pixels = await read();
      }
      // One more frame, with everything built
      pixels = await read();
      captured[key] = pixels;
      let count = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) count++;
      return count;
    },
    { kind, form, key },
  );
  return {
    key,
    drawn,
    differs: (other: string) =>
      page.evaluate(
        ({ a, b }) => {
          const captured = (window as unknown as { captured: Record<string, Uint8Array> }).captured;
          const pa = captured[a];
          const pb = captured[b];
          let count = 0;
          for (let i = 0; i < pa.length; i += 4) {
            if (
              pa[i] !== pb[i] ||
              pa[i + 1] !== pb[i + 1] ||
              pa[i + 2] !== pb[i + 2] ||
              pa[i + 3] !== pb[i + 3]
            ) {
              count++;
            }
          }
          return count;
        },
        { a: key, b: other },
      ),
  };
}

/** The click of the dataset on the page, reported as plain values */
async function clickRow(
  page: Page,
  lngLat: [number, number],
): Promise<{ id: string; row: number; properties: unknown; coordinates: unknown } | null> {
  await page.evaluate(() => {
    const w = window as unknown as {
      draw: import('../index.js').MapLibreGLDraw;
      clicked: unknown;
    };
    w.clicked = null;
    w.draw.getDataset('data')?.on('click', ({ feature, row }) => {
      w.clicked = {
        id: feature.id,
        row,
        properties: feature.properties,
        coordinates: feature.coordinates,
      };
    });
  });
  await click(page, await pageOf(page, lngLat));
  return page.evaluate(
    () =>
      (window as unknown as { clicked: never }).clicked as {
        id: string;
        row: number;
        properties: unknown;
        coordinates: unknown;
      } | null,
  );
}

describe('the columnar input on a real map', () => {
  const targets: Record<Kind, [number, number]> = {
    // Row 47 of each kind (the first vertex of a point, a point on a line, inside a polygon)
    points: [139.66 + 7 * 0.004, 35.655 + 2 * 0.0025],
    lines: [139.66 + 7 * 0.004 + 0.001, 35.655 + 2 * 0.0025 + 0.0005],
    polygons: [139.66 + 7 * 0.004 + 0.0015, 35.655 + 2 * 0.0025 + 0.001],
  };

  for (const kind of ['points', 'lines', 'polygons'] as const) {
    it(`${kind}: the same pixels and the same clicked row as the features`, {
      timeout: 90_000,
    }, async () => {
      const page = await openMapPage(browser, bundle, CAMERA);
      await installRows(page);

      // The pictures are read before any pointer event (the pointer itself changes the picture)
      const features = await drawAndRead(page, kind, 'features');
      const columnar = await drawAndRead(page, kind, 'columnar');
      const prepared = await drawAndRead(page, kind, 'prepared');

      // Something was drawn over a good part of the map
      expect(features.drawn).toBeGreaterThan((MAP_SIZE.width * MAP_SIZE.height) / 50);
      expect(await columnar.differs(features.key)).toBe(0);
      expect(await prepared.differs(features.key)).toBe(0);

      const clickedColumnar = await clickRow(page, targets[kind]);
      await drawAndRead(page, kind, 'features');
      const clickedFeature = await clickRow(page, targets[kind]);
      expect(clickedFeature).not.toBeNull();
      expect(clickedFeature?.id).toBe('r47');
      expect(clickedFeature?.row).toBe(47);
      expect(clickedColumnar).toEqual(clickedFeature);
      await page.close();
    });
  }
});
