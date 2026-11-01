// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The end-to-end tests of how many times a feature is drawn, before a drag, in its middle and once
 * let go (`describeDrawnOnce`, called by a test file for each Store, with the flat test terrain or
 * without)
 *
 * Every feature is drawn once, by one path, whatever the paths are (the drape of the terrain, the
 * rows, the features held, the immediate drawing). The features are half of a blue over a white
 * map: a part drawn once is half of the blue, a part drawn twice is three quarters of it. For each
 * feature (a fill, a solid, dashed and dotted outline, a solid, dashed and dotted line, a circle and
 * a point), the pixels of its box are held to be no darker than half of the blue, and some of them
 * to be half of it (drawn): before it is selected, once selected, in the middle of a drag of every
 * feature, and once let go.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import {
  at,
  idle,
  load,
  type MapPoint,
  mapPointOf,
  openScenePage,
  pressAndMove,
  release,
  type StoreKind,
  select,
  square,
} from './drag-scene.js';
import { type Bundle, bundlePage, launchBrowser } from './harness.js';

const ZOOM = 14;
const BLUE = '#0040ff';
/** The red of half of the blue over white (three quarters of it, drawn twice, is 64) */
const HALF_RED = 128;

/** The selection UI drawn with nothing, so that the features are seen alone */
const NO_STROKE = { width: 0, color: '#000000', opacity: 0, lineStyle: 'solid' };
const NO_POINT = {
  shape: 'circle',
  size: 0,
  fillColor: '#000000',
  fillOpacity: 0,
  strokeColor: '#000000',
  strokeWidth: 0,
  strokeOpacity: 0,
};
const selectionStyle = {
  box: { stroke: NO_STROKE, margin: 0 },
  resizeHandle: { point: NO_POINT },
  rotateHandle: { point: NO_POINT, distance: 0, connector: NO_STROKE },
  vertexHandle: { point: NO_POINT, selected: NO_POINT, followed: NO_POINT },
  midpointHandle: { point: NO_POINT },
  radiusHandle: { point: NO_POINT },
  centerMarker: { point: NO_POINT },
  radiusLine: { stroke: NO_STROKE },
};

/** The places of the features: three columns of three rows (degrees from the center) */
const PLACES: Array<[number, number]> = [
  [-0.006, 0.004],
  [0, 0.004],
  [0.006, 0.004],
  [-0.006, 0],
  [0, 0],
  [0.006, 0],
  [-0.006, -0.004],
  [0, -0.004],
  [0.006, -0.004],
];

const R = 0.0012;
const outline = (lineStyle: string) => ({
  strokeColor: BLUE,
  strokeOpacity: 0.5,
  strokeWidth: 10,
  lineStyle,
  fillOpacity: 0,
});
const lineAt = (x: number, y: number) => [
  at(x - R, y - R / 2),
  at(x, y + R / 2),
  at(x + R, y - R / 2),
];

/** The features, each in its place */
const FEATURES = [
  {
    id: 'fill',
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [square(...PLACES[0]!, R)] },
    style: { fillColor: BLUE, fillOpacity: 0.5, strokeOpacity: 0 },
  },
  ...['solid', 'dashed', 'dotted'].map((lineStyle, k) => ({
    id: `outline-${lineStyle}`,
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [square(...PLACES[1 + k]!, R)] },
    style: outline(lineStyle),
  })),
  ...['solid', 'dashed', 'dotted'].map((lineStyle, k) => ({
    id: `line-${lineStyle}`,
    type: 'LineString',
    geometry: { type: 'LineString', coordinates: lineAt(...PLACES[4 + k]!) },
    style: { strokeColor: BLUE, strokeOpacity: 0.5, strokeWidth: 10, lineStyle },
  })),
  {
    id: 'circle',
    type: 'Circle',
    geometry: { type: 'Point', coordinates: at(...PLACES[7]!) },
    properties: { 'maplibre-gl-draw:radiusMeters': 90 },
    style: {
      strokeColor: BLUE,
      strokeOpacity: 0.5,
      strokeWidth: 10,
      lineStyle: 'dotted',
      fillOpacity: 0,
    },
  },
  {
    id: 'point',
    type: 'Point',
    geometry: { type: 'Point', coordinates: at(...PLACES[8]!) },
    style: { pointColor: BLUE, pointOpacity: 0.5, pointRadius: 12, pointStrokeWidth: 0 },
  },
];

/** In a box of the map: the pixels drawn, those of half of the blue and those darker */
interface Drawn {
  drawn: number;
  half: number;
  darker: number;
}

/** The box of each feature on the map (CSS pixels), moved by a distance */
async function boxes(page: Page, by: readonly [number, number]): Promise<number[][]> {
  return Promise.all(
    PLACES.map(async ([x, y]) => {
      const a = await mapPointOf(page, at(x - R * 1.6, y + R * 1.6));
      const b = await mapPointOf(page, at(x + R * 1.6, y - R * 1.6));
      return [a[0] + by[0], a[1] + by[1], b[0] + by[0], b[1] + by[1]];
    }),
  );
}

/** What each box draws in the next frame once everything is built */
async function drawnIn(page: Page, boxesOf: number[][], wait = true): Promise<Drawn[]> {
  if (wait) await idle(page);
  return page.evaluate(
    async ({ boxesOf, half }) => {
      const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
      const pixels: Uint8Array = await new Promise((resolve) => {
        map.once('render', () => {
          const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
          const out = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
          gl.readPixels(
            0,
            0,
            gl.drawingBufferWidth,
            gl.drawingBufferHeight,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            out,
          );
          resolve(out);
        });
        map.triggerRepaint();
      });
      const canvas = map.getCanvas();
      const width = canvas.width;
      const height = canvas.height;
      const ratio = width / canvas.clientWidth;
      return boxesOf.map(([x0, y0, x1, y1]) => {
        let drawn = 0;
        let halfCount = 0;
        let darker = 0;
        const top = Math.max(0, Math.round((y0 as number) * ratio));
        const left = Math.max(0, Math.round((x0 as number) * ratio));
        for (let y = top; y < Math.min(height, (y1 as number) * ratio); y++) {
          for (let x = left; x < Math.min(width, (x1 as number) * ratio); x++) {
            const red = pixels[((height - 1 - y) * width + x) * 4] as number;
            if (red > 200) continue;
            drawn++;
            if (Math.abs(red - half) <= 4) halfCount++;
            else if (red < half - 20) darker++;
          }
        }
        return { drawn, half: halfCount, darker };
      });
    },
    { boxesOf, half: HALF_RED },
  );
}

/**
 * Holds every feature to be drawn once: most of what it draws is half of the blue. A feature
 * drawn twice is three quarters of it nearly everywhere; the few pixels where the pieces of one
 * feature overlap (the round ends of its dashes, its joins) are allowed for
 */
function expectOnce(drawn: Drawn[], when: string): void {
  drawn.forEach((cell, i) => {
    const what = `${FEATURES[i]?.id}, ${when}`;
    expect.soft(cell.half, `${what}: drawn`).toBeGreaterThan(cell.drawn * 0.5);
    expect.soft(cell.darker, `${what}: drawn more than once`).toBeLessThan(cell.drawn * 0.1);
  });
}

/** Registers the tests of the features drawn once, over a Store, with the terrain or without */
export function describeDrawnOnce(kind: StoreKind, terrain: boolean): void {
  let browser: Browser;
  let bundle: Bundle;
  let page: Page;

  beforeAll(async () => {
    [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
    page = await openScenePage(browser, bundle, ZOOM, terrain);
    await page.evaluate(() => {
      const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
      map.addLayer(
        { id: 'e2e-white', type: 'background', paint: { 'background-color': '#ffffff' } },
        map.getStyle().layers[0]?.id,
      );
    });
  }, browserTimeout(90_000));

  afterAll(async () => {
    await browser?.close();
  });

  it('draws every feature once, before a drag, in its middle and once let go', {
    timeout: browserTimeout(60_000),
  }, async () => {
    await load(page, { kind, features: FEATURES, options: { selectionStyle } }, ZOOM);
    const still = await boxes(page, [0, 0]);
    expectOnce(await drawnIn(page, still), 'before it is selected');
    await select(
      page,
      FEATURES.map((f) => f.id),
    );
    expectOnce(await drawnIn(page, still), 'once selected');
    // From a press on the solid line
    const grab: MapPoint = await mapPointOf(page, at(PLACES[4]![0], PLACES[4]![1] + R / 2));
    const by: [number, number] = [30, 20];
    await pressAndMove(page, grab, by, 8);
    const moved = await boxes(page, by);
    expectOnce(await drawnIn(page, moved, false), 'in the middle of a drag');
    await release(page);
    expectOnce(await drawnIn(page, moved), 'once let go');
  });
}
