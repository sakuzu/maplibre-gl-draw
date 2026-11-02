// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the rows of a Store of rows drawn on the terrain and on the globe, in one
 * draw per chunk:
 *
 * - On the relief of the test terrain, pitched, a point is drawn where maplibre projects the
 *   ground under it (`map.project`), and a click there finds it: the point is drawn at the
 *   elevation the hit testing takes
 * - On the globe a point on the near side is drawn and one on the far side is not, and a line
 *   on the far side neither
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import {
  type Drawn,
  type FeatureInput,
  featureAt,
  frame,
  hex,
  load,
  type Rgb,
} from './drag-scene.js';
import { type Bundle, bundlePage, launchBrowser, openMapPage, settle } from './harness.js';

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

const COLORS: Rgb[] = [
  [0xd0, 0x20, 0x20],
  [0x20, 0xa0, 0x20],
  [0x20, 0x40, 0xd0],
  [0xc0, 0x80, 0x00],
];

/** A point of a color, a circle of a radius */
function point(id: string, at: [number, number], color: Rgb, radius = 6): FeatureInput {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: at },
    style: { pointColor: hex(color), pointRadius: radius, pointStrokeWidth: 0 },
  };
}

/** Where maplibre projects positions, in pixels of the drawing buffer */
function projected(page: Page, positions: Array<[number, number]>): Promise<number[][]> {
  return page.evaluate((list) => {
    const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
    const canvas = map.getCanvas();
    const ratio = canvas.width / canvas.clientWidth;
    return list.map(([lng, lat]) => {
      const p = map.project([lng, lat]);
      return [p.x * ratio, p.y * ratio, p.x, p.y];
    });
  }, positions);
}

describe('the rows on the relief of the terrain', () => {
  it('draw a point where maplibre projects the ground under it, and a click there finds it', {
    timeout: browserTimeout(90_000),
  }, async () => {
    const center: [number, number] = [138.73, 35.36];
    const page = await openMapPage(browser, bundle, { center, zoom: 12.6, pitch: 50, bearing: 20 });
    await page.evaluate(async () => {
      const w = window as unknown as {
        map: unknown;
        e2e: {
          terrain: { addTestTerrain(map: unknown, exaggeration: number): Promise<void> };
        };
      };
      await w.e2e.terrain.addTestTerrain(w.map, 1.5);
    });
    // On the slopes of the peak that face the camera (to the south of it)
    const places: Array<[number, number]> = [
      [center[0] - 0.012, center[1] - 0.006],
      [center[0] + 0.01, center[1] - 0.004],
      [center[0] - 0.006, center[1] - 0.012],
      [center[0] + 0.004, center[1] - 0.01],
    ];
    await load(
      page,
      {
        kind: 'rows',
        features: places.map((at, i) => point(`p${i}`, at, COLORS[i] as Rgb)),
      },
      12.6,
      center,
    );
    await page.evaluate(() => {
      const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
      map.jumpTo({ pitch: 50, bearing: 20 });
    });
    await settle(page);
    const drawn = await frame(page, COLORS);
    const expected = await projected(page, places);
    drawn.forEach((d: Drawn, i) => {
      expect(d.count, `the point ${i}`).toBeGreaterThan(20);
      const [x, y] = expected[i] as number[];
      const [cx, cy] = d.center as [number, number];
      expect(Math.hypot(cx - (x as number), cy - (y as number)), `the point ${i}`).toBeLessThan(
        1.5,
      );
    });
    for (let i = 0; i < places.length; i++) {
      const [, , x, y] = expected[i] as number[];
      expect(await featureAt(page, [x as number, y as number])).toBe(`p${i}`);
    }
    await page.close();
  });

  it('draw a point the peak hides from the camera faint, and the others as they are', {
    timeout: browserTimeout(90_000),
  }, async () => {
    const center: [number, number] = [138.73, 35.36];
    const page = await openMapPage(browser, bundle, { center, zoom: 12.6, pitch: 60, bearing: 0 });
    await page.evaluate(async () => {
      const w = window as unknown as {
        map: unknown;
        e2e: {
          terrain: { addTestTerrain(map: unknown, exaggeration: number): Promise<void> };
        };
      };
      await w.e2e.terrain.addTestTerrain(w.map, 1.5);
    });
    const [front, behind] = COLORS as [Rgb, Rgb];
    // In front of the peak, and behind it as the camera to the south sees it
    const places: Array<[number, number]> = [
      [center[0], center[1] - 0.01],
      [center[0], center[1] + 0.012],
    ];
    await load(
      page,
      {
        kind: 'rows',
        features: [
          point('front', places[0] as [number, number], front, 10),
          point('behind', places[1] as [number, number], behind, 10),
        ],
      },
      12.6,
      center,
    );
    await page.evaluate(() => {
      const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
      map.jumpTo({ pitch: 60, bearing: 0 });
      // A white ground under the layers of the engine, the faint point blended over it
      map.addLayer(
        { id: 'ground', type: 'background', paint: { 'background-color': '#ffffff' } },
        map.getLayersOrder()[0],
      );
    });
    await settle(page);
    const faint = (c: Rgb): Rgb =>
      c.map((v) => Math.round(v * 0.35 + 255 * 0.65)) as unknown as Rgb;
    const [solidFront, solidBehind, faintBehind] = await frame(page, [
      front,
      behind,
      faint(behind),
    ]);
    expect(solidFront?.count).toBeGreaterThan(100);
    expect(solidBehind?.count).toBe(0);
    expect(faintBehind?.count).toBeGreaterThan(100);
    await page.close();
  });
});

describe('the rows on the globe', () => {
  it('draw a point on the near side, and neither a point nor a line on the far side', {
    timeout: browserTimeout(90_000),
  }, async () => {
    const center: [number, number] = [0, 20];
    const page = await openMapPage(browser, bundle, { center, zoom: 1.2 });
    await page.evaluate(() => {
      const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
      map.setProjection({ type: 'globe' });
    });
    await settle(page);
    const [near, far, farLine] = COLORS as [Rgb, Rgb, Rgb];
    await load(
      page,
      {
        kind: 'rows',
        features: [
          point('near', [10, 25], near, 8),
          point('far', [180, -20], far, 8),
          {
            id: 'far-line',
            type: 'LineString',
            geometry: {
              type: 'LineString',
              coordinates: [
                [160, -10],
                [175, -30],
              ],
            },
            style: { strokeColor: hex(farLine), strokeWidth: 6 },
          },
        ],
      },
      1.2,
      center,
    );
    await page.evaluate(() => {
      const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
      map.setProjection({ type: 'globe' });
    });
    await settle(page);
    const [drawnNear, drawnFar, drawnLine] = await frame(page, [near, far, farLine]);
    expect(drawnNear?.count).toBeGreaterThan(50);
    expect(drawnFar?.count).toBe(0);
    expect(drawnLine?.count).toBe(0);
    await page.close();
  });
});
