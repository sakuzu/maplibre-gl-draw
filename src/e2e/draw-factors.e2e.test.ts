// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests: the draw factors reach every path
 *
 * A dataset multiplies its sizes and its opacity by the factors of `zoomScale`. The retained
 * batches are not the only path it draws through: the selection highlight and the features that
 * cannot be retained (dashed lines) are drawn in immediate mode, and they must get the same
 * factors.
 *
 * The features are pure blue on a white ground, so the ink of a pixel is how far its red is
 * below white, and the ink of a picture is the sum of that over the canvas (in pixels' worth of
 * full coverage).
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatasetBaseStyle, DatasetRow } from '../index.js';
import { browserTimeout } from '../test-utils.js';
import {
  type Bundle,
  bundlePage,
  type Camera,
  launchBrowser,
  openMapPage,
  settle,
} from './harness.js';

const CAMERA: Camera = { center: [0, 0], zoom: 4 };

/** The color of every feature, far from the white ground */
const BLUE = '#0000FF';

interface TestWindow {
  map: import('maplibre-gl').Map;
  draw: import('../index.js').Draw;
}

/** The rows and the look of a test dataset */
interface TestDataset {
  rows: DatasetRow[];
  baseStyle: DatasetBaseStyle;
}

/** What a picture left on the canvas */
interface Picture {
  /** The ink, in pixels of full coverage */
  ink: number;
  /** The width of the box around the pixels with a channel below half (device pixels) */
  extent: number;
}

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, browserTimeout(90_000));

afterAll(async () => {
  await browser?.close();
});

/** Opens a page with a white ground under the layers of the draw instance */
async function openPage(camera: Camera = CAMERA): Promise<Page> {
  const page = await openMapPage(browser, bundle, camera);
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.map.addLayer(
      { id: 'ground', type: 'background', paint: { 'background-color': '#ffffff' } },
      w.map.getLayersOrder()[0],
    );
  });
  await settle(page);
  return page;
}

/**
 * Replaces the datasets with one, draws until everything is built and reads the canvas
 *
 * `zoomScale` is given as constant factors (a function cannot cross into the page).
 */
async function drawDataset(
  page: Page,
  options: TestDataset,
  extra: { factors?: { scale: number; opacity: number }; selected?: string[] } = {},
): Promise<Picture> {
  return page.evaluate(
    async ({ options, extra }) => {
      const { map, draw } = window as unknown as TestWindow;
      draw.datasets.removeMany(draw.datasets.list().map((dataset) => dataset.id));
      const factors = extra.factors;
      const dataset = draw.datasets.add({
        id: 'data',
        ...options,
        ...(factors ? { zoomScale: () => factors } : {}),
      });
      if (extra.selected) dataset.setSelectedRowIds(extra.selected);
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
        if (!draw.hasPendingWork() && map.loaded()) break;
        pixels = await read();
      }
      pixels = await read();

      const width = map.getCanvas().width;
      let ink = 0;
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < pixels.length; i += 4) {
        const coverage = (255 - pixels[i]) / 255;
        ink += coverage;
        if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 128) {
          const x = (i / 4) % width;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
      }
      return {
        ink,
        extent: maxX >= minX ? maxX - minX + 1 : 0,
      };
    },
    { options, extra },
  );
}

/** Lines across the screen at a slant (so that they cross every phase of the pixel grid) */
function lineRows(): DatasetRow[] {
  const rows: DatasetRow[] = [];
  for (let k = 0; k < 8; k++) {
    rows.push({
      type: 'Feature',
      id: `l-${k}`,
      geometry: {
        type: 'LineString',
        coordinates: [
          [-11, -8 + k * 2],
          [11, -6.7 + k * 2],
        ],
      },
      properties: {},
    });
  }
  return rows;
}

function pointStyle(radius: number): DatasetBaseStyle {
  return { point: { pointColor: BLUE, pointRadius: radius, pointStrokeWidth: 0 } };
}

function lineStyle(width: number, dashed = false): DatasetBaseStyle {
  return {
    stroke: { strokeColor: BLUE, strokeWidth: width, lineStyle: dashed ? 'dashed' : 'solid' },
  };
}

describe('the draw factors of a dataset on every path', () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage();
  }, browserTimeout(60_000));

  afterAll(async () => {
    await page?.close();
  });

  it('a selected point is drawn at the size of its factor', async () => {
    const rows: DatasetRow[] = [
      {
        type: 'Feature',
        id: 'a',
        geometry: { type: 'Point', coordinates: [0, 0] },
        properties: {},
      },
    ];
    const baseStyle = pointStyle(16);
    const plain = await drawDataset(page, { rows, baseStyle }, { selected: ['a'] });
    const half = await drawDataset(
      page,
      { rows, baseStyle },
      { selected: ['a'], factors: { scale: 0.5, opacity: 1 } },
    );

    // The highlight ring is around the point, so it is the outermost part of the picture
    expect(plain.extent).toBeGreaterThan(32);
    expect(Math.abs(half.extent - plain.extent / 2)).toBeLessThanOrEqual(1.5);
  });

  it('a dashed line takes the size and the opacity of its factor', async () => {
    const rows = lineRows();
    const baseStyle = lineStyle(8, true);
    const plain = await drawDataset(page, { rows, baseStyle });
    const thin = await drawDataset(
      page,
      { rows, baseStyle },
      { factors: { scale: 0.5, opacity: 1 } },
    );
    const faint = await drawDataset(
      page,
      { rows, baseStyle },
      { factors: { scale: 1, opacity: 0.5 } },
    );

    expect(plain.ink).toBeGreaterThan(1000);
    // Half the width (and dashes and gaps half as long) is half the ink
    expect(thin.ink / plain.ink).toBeGreaterThan(0.4);
    expect(thin.ink / plain.ink).toBeLessThan(0.6);
    expect(faint.ink / plain.ink).toBeGreaterThan(0.4);
    expect(faint.ink / plain.ink).toBeLessThan(0.6);
  });
});
