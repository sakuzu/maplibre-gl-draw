// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests: the points the drape draws over are as faint behind the peak whether they are
 * drawn from their rows or one at a time from their features
 *
 * The scene of the points behind the peak (`picture-scenes.ts`) is drawn on a frame the drape
 * paints, once from the rows (the test of the terrain in the vertex shader) and once with the
 * geometry not kept (every point drawn from its feature, the test of the terrain on the CPU).
 * The points far behind the peak and far in front of it are drawn the same way in both, and of the
 * 400 points of the grid over the shoulder of the peak, those on the edge of what the peak hides
 * may differ (the two read the ground from different copies of it), a few of them at most.
 *
 * Where points overlap on the screen, a pixel shows the last one drawn: the pixel at the center of
 * each point is held to the last point drawn over it.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrawDocument } from '../index.js';
import { browserTimeout } from '../test-utils.js';
import { type Bundle, bundlePage, type E2EWindow, launchBrowser, openMapPage } from './harness.js';
import {
  GHOST_CAMERA,
  GHOST_GRID,
  GHOST_POINTS,
  GHOST_SCENES,
  ghostGridId,
  ghostPointId,
  TERRAIN_EXAGGERATION,
} from './picture-scenes.js';

/** The most points of the grid whose look may differ between the two ways */
const EDGE_POINTS = 4;

/** The levels a channel of the pixel of a point must differ by for its look to differ */
const LOOK_LEVELS = 40;

/** The CSS px from its center within which a point of the grid covers a pixel (its radius is 2) */
const COVER_PX = 3;

interface GhostWindow extends E2EWindow {
  e2e: {
    terrain: {
      addTestTerrain(map: import('maplibre-gl').Map, exaggeration: number): Promise<void>;
    };
  };
}

/** What a frame of the scene drew: its pixels, the places of the points and the drape */
interface Drawn {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly ratio: number;
  readonly drapeUsed: boolean;
}

let browser: Browser;
let bundle: Bundle;
let page: Page;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
  page = await openMapPage(browser, bundle, GHOST_CAMERA);
  await page.evaluate(async (exaggeration) => {
    const w = window as unknown as GhostWindow;
    // A gray ground, unlike the red of the points, below the layers of the draw instance
    w.map.addLayer(
      { id: 'ground', type: 'background', paint: { 'background-color': '#c8c8c8' } },
      w.map.getLayersOrder()[0],
    );
    await w.e2e.terrain.addTestTerrain(w.map, exaggeration);
  }, TERRAIN_EXAGGERATION);
}, browserTimeout(90_000));

afterAll(async () => {
  await browser?.close();
});

/** The scene with the grid */
const SCENE = GHOST_SCENES.find((scene) => scene.name === 'ghost/grid') as (typeof GHOST_SCENES)[0];

/**
 * Draws the scene with the geometry kept or not, until the drape is in use, every tile is in and
 * the drawing has nothing left to do, and reads the pixels of the last frame
 */
async function drawScene(cacheGeometry: boolean): Promise<Drawn> {
  const drawn = await page.evaluate(
    async ({ document, cacheGeometry }) => {
      const { map, draw } = window as unknown as GhostWindow;
      draw.options.update({ rendering: { cacheGeometry } });
      if (!(await draw.document.load(document as DrawDocument))) {
        throw new Error('the document of the scene was not loaded');
      }
      let read: { pixels: Uint8Array; width: number; height: number } | null = null;
      const frame = (): Promise<void> =>
        new Promise((resolve) => {
          map.once('render', () => {
            const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
            const width = gl.drawingBufferWidth;
            const height = gl.drawingBufferHeight;
            const pixels = new Uint8Array(width * height * 4);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            read = { pixels, width, height };
            resolve();
          });
          map.triggerRepaint();
        });
      // Enough frames for the drape to settle, then until everything is in and built
      for (let i = 0; i < 12; i++) await frame();
      for (let i = 0; i < 200; i++) {
        if (map.loaded() && map.areTilesLoaded() && !draw.hasPendingWork()) break;
        await frame();
      }
      await frame();
      const done = read as unknown as { pixels: Uint8Array; width: number; height: number };
      let text = '';
      for (let i = 0; i < done.pixels.length; i += 0x8000) {
        text += String.fromCharCode(...done.pixels.subarray(i, i + 0x8000));
      }
      return {
        base64: btoa(text),
        width: done.width,
        height: done.height,
        ratio: done.width / map.getCanvas().clientWidth,
        drapeUsed: draw.debug.terrain().drape.used,
      };
    },
    { document: SCENE.document, cacheGeometry },
  );
  return {
    pixels: Buffer.from(drawn.base64, 'base64'),
    width: drawn.width,
    height: drawn.height,
    ratio: drawn.ratio,
    drapeUsed: drawn.drapeUsed,
  };
}

/** Where the points of the scene are drawn (CSS px), by their IDs */
async function placesOf(): Promise<Map<string, { x: number; y: number }>> {
  const places = await page.evaluate((document) => {
    const { map } = window as unknown as GhostWindow;
    return (document as DrawDocument).features
      .filter((f) => f.type === 'Point')
      .map((f) => {
        const p = map.project(
          (f.geometry as unknown as { coordinates: [number, number] }).coordinates,
        );
        return [f.id, { x: p.x, y: p.y }] as const;
      });
  }, SCENE.document);
  return new Map(places);
}

/** The color of the pixel at a place (CSS px) */
function colorAt(drawn: Drawn, place: { x: number; y: number }): [number, number, number] {
  const x = Math.round(place.x * drawn.ratio);
  const y = drawn.height - 1 - Math.round(place.y * drawn.ratio);
  const i = (y * drawn.width + x) * 4;
  return [drawn.pixels[i], drawn.pixels[i + 1], drawn.pixels[i + 2]];
}

/** Whether two colors differ by the levels of a look */
function lookDiffers(a: readonly number[], b: readonly number[]): boolean {
  return a.some((value, c) => Math.abs(value - b[c]) > LOOK_LEVELS);
}

describe('the points behind the peak on a frame the drape paints', () => {
  let rows: Drawn;
  let features: Drawn;
  let places: Map<string, { x: number; y: number }>;

  beforeAll(async () => {
    rows = await drawScene(true);
    features = await drawScene(false);
    places = await placesOf();
  }, browserTimeout(120_000));

  it('are drawn on a frame the drape paints, both ways', () => {
    expect(rows.drapeUsed).toBe(true);
    expect(features.drapeUsed).toBe(true);
  });

  it('far behind the peak are drawn faint, and far in front of it in full, from the rows', () => {
    for (const kind of ['hidden', 'seen'] as const) {
      GHOST_POINTS[kind].forEach((_, i) => {
        const id = ghostPointId(kind, i);
        const [r, g] = colorAt(rows, places.get(id) as { x: number; y: number });
        if (kind === 'seen') {
          expect(r, id).toBeGreaterThan(230);
          expect(g, id).toBeLessThan(40);
        } else {
          // Red over the gray ground, faint but there
          expect(r - g, id).toBeGreaterThan(40);
          expect(g, id).toBeGreaterThan(90);
        }
      });
    }
  });

  it('far behind the peak and far in front of it look the same both ways', () => {
    for (const kind of ['hidden', 'seen'] as const) {
      GHOST_POINTS[kind].forEach((_, i) => {
        const id = ghostPointId(kind, i);
        const place = places.get(id) as { x: number; y: number };
        expect(lookDiffers(colorAt(rows, place), colorAt(features, place)), id).toBe(false);
      });
    }
  });

  it('of the grid over the shoulder of the peak look the same both ways, but a few on its edge', () => {
    const side = GHOST_GRID.side;
    const grid: { x: number; y: number }[] = [];
    for (let row = 0; row < side; row++) {
      for (let column = 0; column < side; column++) {
        grid.push(places.get(ghostGridId(column, row)) as { x: number; y: number });
      }
    }
    // The point that shows at the center of each point: the last one drawn over it
    const differing = new Set<number>();
    let faint = 0;
    let full = 0;
    for (let i = 0; i < grid.length; i++) {
      let shown = i;
      for (let j = grid.length - 1; j > i; j--) {
        if (Math.hypot(grid[j].x - grid[i].x, grid[j].y - grid[i].y) <= COVER_PX) {
          shown = j;
          break;
        }
      }
      const one = colorAt(rows, grid[i]);
      if (shown === i) {
        if (one[1] > 90) faint++;
        else full++;
      }
      if (lookDiffers(one, colorAt(features, grid[i]))) differing.add(shown);
    }
    console.info(
      `the grid: ${differing.size} of ${grid.length} points look different; of the points ` +
        `shown at their centers, ${faint} are faint and ${full} in full`,
    );
    // The grid crosses the edge of what the peak hides
    expect(faint).toBeGreaterThan(40);
    expect(full).toBeGreaterThan(40);
    expect(differing.size).toBeLessThanOrEqual(EDGE_POINTS);
  });
});
