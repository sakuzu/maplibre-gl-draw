// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests: the draw factors reach every path, and small sizes leave ink in proportion
 *
 * A dataset multiplies its sizes and its opacity by the factors of `zoomScale`. The retained
 * batches are not the only path it draws through: the selection highlight and the features that
 * cannot be retained (dashed lines) are drawn in immediate mode, and they must get the same
 * factors.
 *
 * A size below one pixel cannot be drawn as a smaller shape, so it is drawn as a fainter one:
 * the ink it leaves on the screen follows its area (a point) or its width (a line, an outline),
 * and goes to nothing with it.
 *
 * The features are pure blue on a white ground, so the ink of a pixel is how far its red is
 * below white, and the ink of a picture is the sum of that over the canvas (in pixels' worth of
 * full coverage).
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatasetBaseStyle, DatasetRow, FeatureInput } from '../index.js';
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
  e2e: {
    terrain: {
      addTestTerrain(
        map: import('maplibre-gl').Map,
        exaggeration: number,
        options?: { flat?: boolean },
      ): Promise<void>;
    };
  };
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
  /** Whether the drape painted the frame */
  draped: boolean;
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
 * Draws until everything is built and reads the canvas (in the render event, before the frame is
 * shown)
 */
async function measure(page: Page): Promise<Picture> {
  return page.evaluate(async () => {
    const { map, draw } = window as unknown as TestWindow;
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
    // Enough frames for the drape to take the new contents over, then until everything is built
    let pixels = await read();
    for (let i = 0; i < 12; i++) pixels = await read();
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
      ink += (255 - pixels[i]) / 255;
      if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 128) {
        const x = (i / 4) % width;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    }
    return {
      ink,
      extent: maxX >= minX ? maxX - minX + 1 : 0,
      draped: draw.debug.terrain().drape.used,
    };
  });
}

/** Tells the datasets of the pictures apart */
let datasetCount = 0;

/**
 * Replaces the datasets with one and reads the picture
 *
 * `zoomScale` is given as constant factors (a function cannot cross into the page). Every picture
 * takes a dataset id of its own: on the terrain, a dataset added under the id of one just removed
 * is not laid on the drape anew.
 */
async function drawDataset(
  page: Page,
  options: TestDataset,
  extra: { factors?: { scale: number; opacity: number }; selected?: string[] } = {},
): Promise<Picture> {
  datasetCount++;
  await page.evaluate(
    ({ id, options, extra }) => {
      const { draw } = window as unknown as TestWindow;
      draw.datasets.removeMany(draw.datasets.list().map((dataset) => dataset.id));
      const factors = extra.factors;
      const dataset = draw.datasets.add({
        id,
        ...options,
        ...(factors ? { zoomScale: () => factors } : {}),
      });
      if (extra.selected) dataset.setSelectedRowIds(extra.selected);
    },
    { id: `data-${datasetCount}`, options, extra },
  );
  return measure(page);
}

/** Replaces the drawn features with these and reads the picture */
async function drawFeatures(page: Page, inputs: FeatureInput[]): Promise<Picture> {
  await page.evaluate((inputs) => {
    const { draw } = window as unknown as TestWindow;
    draw.features.deleteMany(draw.features.list().map((feature) => feature.id));
    draw.features.createMany(inputs);
  }, inputs);
  return measure(page);
}

/**
 * Points spread over the screen, a little over 22 pixels apart, so that their centers fall on
 * every phase of the pixel grid
 */
function pointRows(): DatasetRow[] {
  const rows: DatasetRow[] = [];
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 14; j++) {
      rows.push({
        type: 'Feature',
        id: `p-${i}-${j}`,
        geometry: { type: 'Point', coordinates: [-10 + i * 1.003, -7 + j * 1.007] },
        properties: {},
      });
    }
  }
  return rows;
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

/** Outlined squares without a fill */
function outlineRows(): DatasetRow[] {
  const rows: DatasetRow[] = [];
  for (let k = 0; k < 4; k++) {
    const x = -10 + k * 5.03;
    rows.push({
      type: 'Feature',
      id: `g-${k}`,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [x, -6],
            [x + 4, -5.7],
            [x + 4.2, 6],
            [x + 0.3, 6.1],
            [x, -6],
          ],
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

function outlineStyle(width: number): DatasetBaseStyle {
  return { fill: { fillOpacity: 0, strokeColor: BLUE, strokeWidth: width } };
}

/** The sizes below one pixel the ink is measured at, with one pixel as the reference */
const SIZES = [1, 0.5, 0.25, 0.1];

/**
 * Checks that the ink falls with the size: steadily, and down to a few percent of the one-pixel
 * ink at a tenth of a pixel
 *
 * @param power 2 for an area (a point), 1 for a width (a line)
 */
function expectInkInProportion(inks: number[], power: number): void {
  const [reference] = inks;
  expect(reference).toBeGreaterThan(0);
  for (let i = 1; i < inks.length; i++) {
    expect(inks[i]).toBeLessThan(inks[i - 1]);
    const ideal = SIZES[i] ** power;
    // Within a quarter of the ideal ratio (the canvas has 8 bits a channel)
    expect(inks[i] / reference).toBeGreaterThan(ideal * 0.75);
    expect(inks[i] / reference).toBeLessThan(ideal * 1.25 + 0.005);
  }
  expect(inks[inks.length - 1] / reference).toBeLessThan(power === 2 ? 0.03 : 0.12);
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

/** The ink of a picture at each size of `SIZES` */
async function inksOver(draw: (size: number) => Promise<Picture>): Promise<number[]> {
  const inks: number[] = [];
  for (const size of SIZES) inks.push((await draw(size)).ink);
  return inks;
}

describe('sizes below one pixel leave ink in proportion to their size', () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage();
  }, browserTimeout(60_000));

  afterAll(async () => {
    await page?.close();
  });

  it('points: the ink follows the area', async () => {
    const rows = pointRows();
    const inks = await inksOver((radius) =>
      drawDataset(page, { rows, baseStyle: pointStyle(radius) }),
    );
    expectInkInProportion(inks, 2);
  });

  it('points made small by the factor of the dataset alike', async () => {
    const rows = pointRows();
    const inks = await inksOver((scale) =>
      drawDataset(page, { rows, baseStyle: pointStyle(1) }, { factors: { scale, opacity: 1 } }),
    );
    expectInkInProportion(inks, 2);
  });

  it('lines: the ink follows the width', async () => {
    const rows = lineRows();
    const inks = await inksOver((width) =>
      drawDataset(page, { rows, baseStyle: lineStyle(width) }),
    );
    expectInkInProportion(inks, 1);
  });

  it('dashed lines: the ink follows the width (the caps of the dashes included)', async () => {
    const rows = lineRows();
    const inks = await inksOver((width) =>
      drawDataset(page, { rows, baseStyle: lineStyle(width, true) }),
    );
    expectInkInProportion(inks, 1);
  });

  it('polygon outlines: the ink follows the width', async () => {
    const rows = outlineRows();
    const inks = await inksOver((width) =>
      drawDataset(page, { rows, baseStyle: outlineStyle(width) }),
    );
    expectInkInProportion(inks, 1);
  });

  it('drawn features alike', async () => {
    await drawDataset(page, { rows: [], baseStyle: {} });
    const points = await inksOver((radius) =>
      drawFeatures(
        page,
        pointRows().map((row) => ({
          type: 'Point',
          geometry: row.geometry as FeatureInput['geometry'],
          properties: {},
          style: { pointColor: BLUE, pointRadius: radius, pointStrokeWidth: 0 },
        })),
      ),
    );
    expectInkInProportion(points, 2);
    const lines = await inksOver((width) =>
      drawFeatures(
        page,
        lineRows().map((row) => ({
          type: 'LineString',
          geometry: row.geometry as FeatureInput['geometry'],
          properties: {},
          style: { strokeColor: BLUE, strokeWidth: width, lineStyle: 'solid' },
        })),
      ),
    );
    expectInkInProportion(lines, 1);
  });
});

describe('on the terrain (the drape)', () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage();
    await page.evaluate(async () => {
      const w = window as unknown as TestWindow;
      await w.e2e.terrain.addTestTerrain(w.map, 1, { flat: true });
    });
    await settle(page);
  }, browserTimeout(60_000));

  afterAll(async () => {
    await page?.close();
  });

  /** Draws the dataset and checks that the drape painted it */
  async function drawDraped(options: TestDataset): Promise<Picture> {
    const picture = await drawDataset(page, options);
    expect(picture.draped).toBe(true);
    return picture;
  }

  it('lines: the ink follows the width', async () => {
    const rows = lineRows();
    const inks = await inksOver((width) => drawDraped({ rows, baseStyle: lineStyle(width) }));
    expectInkInProportion(inks, 1);
  });

  it('polygon outlines: the ink follows the width', async () => {
    const rows = outlineRows();
    const inks = await inksOver((width) => drawDraped({ rows, baseStyle: outlineStyle(width) }));
    expectInkInProportion(inks, 1);
  });
});
