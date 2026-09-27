// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the table input of the datasets
 *
 * The same rows are drawn once as GeoJSON features and once as a table (bare, and prepared with
 * `prepareTable`), on the real maplibre and WebGL of the browser. The pictures
 * must be the same pixel for pixel, and a click with the real pointer must report the same
 * feature and row. The mixed kind puts points, lines, polygons and two-part lines in one table
 * with a mixed geometry column.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
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
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

type Kind = 'points' | 'lines' | 'polygons' | 'mixed';

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
      kind === 'points'
        ? 'Point'
        : kind === 'lines'
          ? 'LineString'
          : kind === 'multilines'
            ? 'MultiLineString'
            : 'Polygon';
    /** The kind of row `i` of the mixed table */
    const MIXED = ['points', 'lines', 'polygons', 'multilines'];
    /** The coordinates of a row of a kind (a two-part line adds a copy of the line above it) */
    const coordinatesOf = (kind: string, coords: number[][]) =>
      kind === 'points'
        ? coords[0]
        : kind === 'lines'
          ? coords
          : kind === 'multilines'
            ? [coords, coords.map(([x, y]) => [x, y + 0.0012])]
            : [coords];

    w.featuresOf = (kind: string) => {
      const rowsOfKind: Record<string, ReturnType<typeof rowsOf>> = {};
      const kindOf = (i: number) => (kind === 'mixed' ? MIXED[i % MIXED.length] : kind);
      return Array.from({ length: 400 }, (_, i) => {
        const k = kindOf(i);
        rowsOfKind[k] ??= rowsOf(k === 'multilines' ? 'lines' : k);
        const row = rowsOfKind[k][i];
        return {
          type: 'Feature',
          id: `r${i}`,
          geometry: { type: typeOf(k), coordinates: coordinatesOf(k, row.coords) },
          properties: { cls: CLASSES[row.cls], value: row.value },
        };
      });
    };

    /**
     * The mixed table: one child per kind, filled from the last row to the first (the order
     * within a child is not the order of the table)
     */
    const mixedTableOf = () => {
      const features = (w.featuresOf as (k: string) => Array<Record<string, unknown>>)('mixed');
      const children = MIXED.map((kind) => ({
        kind,
        coords: [] as number[],
        rowOffsets: [0],
        partOffsets: [0],
        rows: 0,
      }));
      const types = new Int8Array(features.length);
      const offsets = new Int32Array(features.length);
      for (let i = features.length - 1; i >= 0; i--) {
        const k = i % MIXED.length;
        const child = children[k];
        types[i] = k;
        offsets[i] = child.rows++;
        const coordinates = (features[i].geometry as { coordinates: never }).coordinates;
        if (child.kind === 'points') {
          child.coords.push(...(coordinates as number[]));
          continue;
        }
        const parts: number[][][] = child.kind === 'lines' ? [coordinates] : coordinates;
        for (const part of parts) {
          for (const c of part) child.coords.push(c[0], c[1]);
          child.partOffsets.push(child.coords.length / 2);
        }
        child.rowOffsets.push(child.partOffsets.length - 1);
      }
      return {
        length: features.length,
        geometry: {
          type: 'Mixed',
          types,
          offsets,
          children: children.map((child) => ({
            type: typeOf(child.kind),
            coords: Float64Array.from(child.coords),
            offsets:
              child.kind === 'points'
                ? []
                : child.kind === 'lines'
                  ? [Int32Array.from(child.partOffsets)]
                  : [Int32Array.from(child.rowOffsets), Int32Array.from(child.partOffsets)],
          })),
        },
        ids: features.map((f) => f.id),
        columns: {
          cls: {
            codes: Int32Array.from(features, (f) =>
              CLASSES.indexOf((f.properties as { cls: string }).cls),
            ),
            dictionary: CLASSES,
          },
          value: Float64Array.from(features, (f) => (f.properties as { value: number }).value),
        },
      };
    };

    w.tableOf = (kind: string) => {
      if (kind === 'mixed') return mixedTableOf();
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
  form: 'rows' | 'table' | 'prepared',
): Promise<{ differs: (other: string) => Promise<number>; key: string; drawn: number }> {
  const key = `${kind}-${form}`;
  const drawn = await page.evaluate(
    async ({ kind, form, key }) => {
      const w = window as unknown as Record<string, unknown> & {
        map: import('maplibre-gl').Map;
        draw: import('../index.js').MapLibreGLDraw;
        e2e: { prepareTable: (input: unknown) => unknown };
      };
      const { map, draw } = w;
      for (const c of draw.getDatasets()) draw.removeDataset(c.id);
      const style = w.STYLE as object;
      const options =
        form === 'rows'
          ? { rows: (w.featuresOf as (k: string) => unknown)(kind) }
          : form === 'table'
            ? { table: (w.tableOf as (k: string) => unknown)(kind) }
            : { table: w.e2e.prepareTable((w.tableOf as (k: string) => unknown)(kind)) };
      draw.addDataset({
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
        if (!draw.hasPendingWork()) break;
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

describe('the table input on a real map', () => {
  const targets: Record<Kind, [number, number]> = {
    // Row 47 of each kind (the first vertex of a point, a point on a line, inside a polygon)
    points: [139.66 + 7 * 0.004, 35.655 + 2 * 0.0025],
    lines: [139.66 + 7 * 0.004 + 0.001, 35.655 + 2 * 0.0025 + 0.0005],
    polygons: [139.66 + 7 * 0.004 + 0.0015, 35.655 + 2 * 0.0025 + 0.001],
    // Row 47 is a two-part line whose first part is the line of the lines kind
    mixed: [139.66 + 7 * 0.004 + 0.001, 35.655 + 2 * 0.0025 + 0.0005],
  };

  for (const kind of ['points', 'lines', 'polygons', 'mixed'] as const) {
    it(`${kind}: the same pixels and the same clicked row as the features`, {
      timeout: browserTimeout(90_000),
    }, async () => {
      const page = await openMapPage(browser, bundle, CAMERA);
      await installRows(page);

      // The pictures are read before any pointer event (the pointer itself changes the picture)
      const features = await drawAndRead(page, kind, 'rows');
      const table = await drawAndRead(page, kind, 'table');
      const prepared = await drawAndRead(page, kind, 'prepared');

      // Something was drawn over a good part of the map
      expect(features.drawn).toBeGreaterThan((MAP_SIZE.width * MAP_SIZE.height) / 50);
      expect(await table.differs(features.key)).toBe(0);
      expect(await prepared.differs(features.key)).toBe(0);

      const clickedTable = await clickRow(page, targets[kind]);
      await drawAndRead(page, kind, 'rows');
      const clickedFeature = await clickRow(page, targets[kind]);
      expect(clickedFeature).not.toBeNull();
      expect(clickedFeature?.id).toBe('r47');
      expect(clickedFeature?.row).toBe(47);
      expect(clickedTable).toEqual(clickedFeature);
      await page.close();
    });
  }
});
