// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests: the engine draws on maplibre's globe along the paths maplibre draws
 *
 * On the globe maplibre draws an edge between two vertices along the straight line of the
 * Mercator plane carried onto the sphere, so a parallel stays a parallel. The vertex shaders
 * of the engine project each vertex onto the sphere, and without the subdivision of the globe
 * (`view/globe-subdivision.ts`) the GPU joins two vertices with a chord through the sphere.
 * Here a real maplibre draws the globe and the pixels of the canvas are held to
 * `map.project`, maplibre's own position of a coordinate: a line and a fill of two vertices
 * along a parallel lie on the parallel, the line being drawn lies on it too, a large image lies
 * between its parallels (and a click just inside its edge selects it), and the dashes of
 * a long slanted edge and a click on it follow the path its solid line is drawn along.
 *
 * The points near the edge of the sphere are tested against maplibre's own circle layer: where
 * maplibre draws a circle, the engine draws its marker (maplibre's bounds of a globe in full
 * view fall short of the edge of the sphere, and the view culling used to drop the points
 * between).
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FeatureInput } from '../index.js';
import { browserTimeout } from '../test-utils.js';
import {
  type Bundle,
  bundlePage,
  click,
  type E2EWindow,
  launchBrowser,
  openMapPage,
  pageOf,
  selectedIds,
  settle,
} from './harness.js';

/** The whole globe in view, the parallels curved well away from the chords */
const CAMERA = { center: [0, 20] as [number, number], zoom: 1.2 };

/** The pixels of the canvas, the size of the drawing buffer and the pixel ratio */
interface Picture {
  pixels: number[];
  width: number;
  height: number;
  ratio: number;
}

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

/** Opens a page with the globe at a camera, with a dark background for the sphere */
async function openGlobe(camera: { center: [number, number]; zoom: number }): Promise<Page> {
  const page = await openMapPage(browser, bundle, camera);
  await page.evaluate(() => {
    const { map } = window as unknown as E2EWindow;
    map.setProjection({ type: 'globe' });
    // Under the layers of the engine
    map.addLayer(
      { id: 'ground', type: 'background', paint: { 'background-color': '#202020' } },
      map.getLayersOrder()[0],
    );
  });
  await settle(page);
  return page;
}

/** Draws two frames and reads the pixels of the second, in the render event */
async function readPicture(page: Page): Promise<Picture> {
  return page.evaluate(async () => {
    const { map } = window as unknown as E2EWindow;
    const read = (): Promise<Picture> =>
      new Promise((resolve) => {
        map.once('render', () => {
          const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
          const width = gl.drawingBufferWidth;
          const height = gl.drawingBufferHeight;
          const pixels = new Uint8Array(width * height * 4);
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const ratio = width / map.getCanvas().clientWidth;
          resolve({ pixels: Array.from(pixels), width, height, ratio });
        });
        map.triggerRepaint();
      });
    await read();
    return read();
  });
}

/** The point of the canvas (CSS px) where maplibre puts a coordinate */
async function projected(page: Page, lngLat: [number, number]): Promise<{ x: number; y: number }> {
  return page.evaluate((coord) => {
    const p = (window as unknown as E2EWindow).map.project(coord);
    return { x: p.x, y: p.y };
  }, lngLat);
}

/** The color of the pixel under a point of the canvas (CSS px) */
function colorAt(picture: Picture, x: number, y: number): [number, number, number] {
  const px = Math.round(x * picture.ratio);
  const py = Math.round(y * picture.ratio);
  const i = ((picture.height - 1 - py) * picture.width + px) * 4;
  return [picture.pixels[i], picture.pixels[i + 1], picture.pixels[i + 2]];
}

/** How many pixels within `radius` CSS px of a point are close to a color */
function countNear(
  picture: Picture,
  x: number,
  y: number,
  radius: number,
  color: [number, number, number],
): number {
  let count = 0;
  const r = Math.round(radius * picture.ratio);
  const cx = Math.round(x * picture.ratio);
  const cy = Math.round(y * picture.ratio);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const px = cx + dx;
      const py = cy + dy;
      if (px < 0 || py < 0 || px >= picture.width || py >= picture.height) continue;
      const i = ((picture.height - 1 - py) * picture.width + px) * 4;
      const d =
        Math.abs(picture.pixels[i] - color[0]) +
        Math.abs(picture.pixels[i + 1] - color[1]) +
        Math.abs(picture.pixels[i + 2] - color[2]);
      if (d < 60) count++;
    }
  }
  return count;
}

/** How many pixels within `radius` CSS px of a point differ between two pictures */
function countChanged(a: Picture, b: Picture, x: number, y: number, radius: number): number {
  let count = 0;
  const r = Math.round(radius * a.ratio);
  const cx = Math.round(x * a.ratio);
  const cy = Math.round(y * a.ratio);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const i = ((a.height - 1 - (cy + dy)) * a.width + cx + dx) * 4;
      const d =
        Math.abs(a.pixels[i] - b.pixels[i]) +
        Math.abs(a.pixels[i + 1] - b.pixels[i + 1]) +
        Math.abs(a.pixels[i + 2] - b.pixels[i + 2]);
      if (d > 60) count++;
    }
  }
  return count;
}

/** Replaces every feature with the given ones */
async function show(page: Page, features: FeatureInput[]): Promise<void> {
  await page.evaluate((list) => {
    const { draw } = window as unknown as E2EWindow;
    draw.setMode('select');
    draw.deleteAllFeatures();
    for (const feature of list) draw.addFeature(feature);
  }, features);
  await settle(page);
}

/** How far the chord between two coordinates passes from the point at `middle`, in CSS px */
async function chordGap(
  page: Page,
  a: [number, number],
  b: [number, number],
  middle: [number, number],
): Promise<number> {
  const pa = await projected(page, a);
  const pb = await projected(page, b);
  const pm = await projected(page, middle);
  return Math.hypot((pa.x + pb.x) / 2 - pm.x, (pa.y + pb.y) / 2 - pm.y);
}

/** The latitude halfway between two latitudes in Mercator y */
function mercatorHalfway(a: number, b: number): number {
  const y = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return (2 * Math.atan(Math.exp((y(a) + y(b)) / 2)) - Math.PI / 2) * (180 / Math.PI);
}

const GREEN: [number, number, number] = [0, 255, 0];
const MAGENTA: [number, number, number] = [255, 0, 255];
const RED: [number, number, number] = [255, 0, 0];

describe('the edges on the globe follow the paths maplibre draws', () => {
  let page: Page;

  beforeAll(async () => {
    page = await openGlobe(CAMERA);
  }, browserTimeout(60_000));

  afterAll(async () => {
    await page?.close();
  });

  it('a line of two vertices along a parallel runs along the parallel', async () => {
    // The chord would pass well away from the parallel, so the test tells them apart
    expect(await chordGap(page, [-60, 45], [60, 45], [0, 45])).toBeGreaterThan(10);

    await show(page, [
      {
        type: 'LineString',
        coordinates: [
          [-60, 45],
          [60, 45],
        ],
        style: { strokeColor: '#00FF00', strokeWidth: 4, strokeOpacity: 1 },
      },
    ]);
    const picture = await readPicture(page);
    for (const lng of [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50]) {
      const p = await projected(page, [lng, 45]);
      expect(colorAt(picture, p.x, p.y), `longitude ${lng}`).toEqual(GREEN);
    }
  });

  it('a fill between two parallels reaches them', async () => {
    expect(await chordGap(page, [-40, 20], [40, 20], [0, 20])).toBeGreaterThan(8);

    await show(page, [
      {
        type: 'Polygon',
        coordinates: [
          [
            [-40, 20],
            [40, 20],
            [40, 50],
            [-40, 50],
            [-40, 20],
          ],
        ],
        style: { fillColor: '#FF00FF', fillOpacity: 1, strokeOpacity: 0, strokeWidth: 0 },
      },
    ]);
    const picture = await readPicture(page);
    for (const lng of [-30, -15, 0, 15, 30]) {
      // Just inside each parallel (the chords cut these off) and just outside
      for (const [lat, inside] of [
        [21, true],
        [49, true],
        [18.5, false],
        [51.5, false],
      ] as const) {
        const p = await projected(page, [lng, lat]);
        const color = colorAt(picture, p.x, p.y);
        expect(color.join() === MAGENTA.join(), `(${lng}, ${lat})`).toBe(inside);
      }
    }
  });

  it('a large image lies between its parallels, and a click inside its edge selects it', async () => {
    // 400 x 160 px at zoom 1, centered on (0, 30): 140.6 degrees wide, and
    // 160 * 360 * cos(30) / 1024 degrees high (ImageRenderer's conversion)
    const halfWidth = (400 * 360) / 1024 / 2;
    const halfHeight = (160 * 360 * Math.cos(Math.PI / 6)) / 1024 / 2;
    const south = 30 - halfHeight;
    const north = 30 + halfHeight;
    expect(
      await chordGap(page, [-halfWidth, south], [halfWidth, south], [0, south]),
    ).toBeGreaterThan(15);

    await page.evaluate(
      async ({ id }) => {
        const { draw } = window as unknown as E2EWindow;
        draw.setMode('select');
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('No 2D canvas');
        context.fillStyle = '#FF00FF';
        context.fillRect(0, 0, 64, 64);
        await draw.load({
          version: '2.0.0',
          metadata: { title: 'image' },
          layerOrder: ['images'],
          layers: [
            { id: 'images', name: 'Images', visible: true, locked: false, opacity: 1, order: [id] },
          ],
          features: [
            {
              id,
              type: 'Image',
              coordinates: [0, 30],
              layerId: 'images',
              visible: true,
              locked: false,
              properties: {
                createdZoom: 1,
                imageFileId: 'file-magenta',
                imageWidth: 64,
                imageHeight: 64,
              },
              style: { width: 400, height: 160, imageOpacity: 1 },
            },
          ],
          files: {
            'file-magenta': {
              id: 'file-magenta',
              mimeType: 'image/png',
              dataURL: canvas.toDataURL('image/png'),
            },
          },
        } as never);
      },
      { id: 'image' },
    );
    // The texture loads asynchronously
    let picture = await readPicture(page);
    const middle = await projected(page, [0, 30]);
    for (let i = 0; i < 50 && colorAt(picture, middle.x, middle.y).join() !== MAGENTA.join(); i++) {
      await settle(page);
      picture = await readPicture(page);
    }
    expect(colorAt(picture, middle.x, middle.y)).toEqual(MAGENTA);

    for (const lng of [-45, -20, 0, 20, 45]) {
      // Just inside each parallel (the chords cut these off or add them) and just outside
      for (const [lat, inside] of [
        [south + 1.5, true],
        [north - 1.5, true],
        [south - 1.5, false],
        [north + 1.5, false],
      ] as const) {
        const p = await projected(page, [lng, lat]);
        const color = colorAt(picture, p.x, p.y);
        expect(color.join() === MAGENTA.join(), `(${lng}, ${lat})`).toBe(inside);
      }
    }

    // What is drawn there is what a click selects
    await click(page, await pageOf(page, [20, south + 1.5]));
    expect(await selectedIds(page)).toEqual(['image']);
  });

  it('a dashed line of two vertices runs along the path of the solid line', async () => {
    // A long slanted edge: its dashes follow the straight line of the Mercator plane, as the
    // solid line does, not the straight line in degrees several pixels away
    const onPath = await projected(page, [0, mercatorHalfway(0, 50)]);
    const inDegrees = await projected(page, [0, 25]);
    expect(Math.hypot(onPath.x - inDegrees.x, onPath.y - inDegrees.y)).toBeGreaterThan(7);

    await show(page, [
      {
        type: 'LineString',
        coordinates: [
          [-60, 0],
          [60, 50],
        ],
        style: { strokeColor: '#00FF00', strokeWidth: 4, strokeOpacity: 1, lineStyle: 'dashed' },
      },
    ]);
    const picture = await readPicture(page);
    // A dash is 16 px and a gap 8 px, so a dash reaches within 5 px of any point of the path
    expect(countNear(picture, onPath.x, onPath.y, 5, GREEN)).toBeGreaterThan(4);
  });

  it('the line being drawn runs along the parallel too', async () => {
    await show(page, []);
    const empty = await readPicture(page);
    const west = await pageOf(page, [-50, 45]);
    const east = await pageOf(page, [50, 45]);
    await page.evaluate(() => {
      const { draw } = window as unknown as E2EWindow;
      // No guide along the parallel: only the line being drawn is there
      draw.snapping.setEnabled(false);
      draw.setMode('draw_line');
    });
    await click(page, west);
    await page.mouse.move(east.x, east.y, { steps: 4 });
    await settle(page);
    const drawing = await readPicture(page);
    await page.keyboard.press('Escape');
    await page.evaluate(() => (window as unknown as E2EWindow).draw.snapping.setEnabled(true));
    await settle(page);

    // The line being drawn is dashed: a dash reaches within 6 px of any point of it
    for (const lng of [-30, -15, 0, 15, 30]) {
      const p = await projected(page, [lng, 45]);
      expect(countChanged(empty, drawing, p.x, p.y, 6), `longitude ${lng}`).toBeGreaterThan(4);
    }
  });

  it('a click on the drawn path of a long slanted edge selects it', async () => {
    await show(page, [
      {
        id: 'slanted',
        type: 'LineString',
        coordinates: [
          [-60, 0],
          [60, 50],
        ],
        style: { strokeColor: '#00FF00', strokeWidth: 4, strokeOpacity: 1 },
      },
    ]);
    // The edge is drawn along the straight line of the Mercator plane: at longitude 0 it is at
    // the latitude halfway in Mercator y, several pixels from the halfway latitude in degrees
    const lat = mercatorHalfway(0, 50);
    const onPath = await projected(page, [0, lat]);
    const inDegrees = await projected(page, [0, 25]);
    expect(Math.hypot(onPath.x - inDegrees.x, onPath.y - inDegrees.y)).toBeGreaterThan(7);

    const picture = await readPicture(page);
    expect(colorAt(picture, onPath.x, onPath.y)).toEqual(GREEN);
    await click(page, await pageOf(page, [0, lat]));
    expect(await selectedIds(page)).toEqual(['slanted']);
  });
});

describe('the points near the edge of the sphere', () => {
  it('a point that maplibre draws near the edge of the sphere is drawn', async () => {
    // A globe in full view, turned, whose bounds as maplibre reports them stop short of its
    // north edge by degrees
    const page = await openGlobe({ center: [0, -30], zoom: 1 });
    await page.evaluate(() => (window as unknown as E2EWindow).map.setBearing(30));
    await settle(page);

    // The north edge of the sphere up the meridian of the center: the last latitude that
    // maplibre projects and unprojects back to itself (beyond it lies the far side)
    const [edge, north] = await page.evaluate(() => {
      const { map } = window as unknown as E2EWindow;
      let last = -30;
      for (let lat = -30; lat < 90; lat += 0.02) {
        const back = map.unproject(map.project([0, lat]));
        if (Math.abs(back.lat - lat) > 0.05 || Math.abs(back.lng) > 0.05) break;
        last = lat;
      }
      return [last, map.getBounds().getNorth()];
    });
    const coordinate: [number, number] = [0, edge - 1];
    // The point lies beyond the bounds maplibre reports
    expect(coordinate[1]).toBeGreaterThan(north);

    // maplibre draws its own circle there
    await page.evaluate((coord) => {
      const { map } = window as unknown as E2EWindow;
      map.addSource('reference', {
        type: 'geojson',
        data: { type: 'Point', coordinates: coord },
      });
      map.addLayer({
        id: 'reference',
        type: 'circle',
        source: 'reference',
        paint: { 'circle-color': '#FF0000', 'circle-radius': 6 },
      });
      // Above the layers of the engine, which draw nothing yet
      map.moveLayer('reference');
    }, coordinate);
    await page.waitForFunction(() => (window as unknown as E2EWindow).map.loaded());
    const reference = await readPicture(page);
    const at = await projected(page, coordinate);
    expect(countNear(reference, at.x, at.y, 3, RED)).toBeGreaterThan(10);

    // and the engine draws its marker there
    await page.evaluate((coord) => {
      const { map, draw } = window as unknown as E2EWindow;
      map.removeLayer('reference');
      draw.addFeature({
        type: 'Point',
        coordinates: coord,
        style: { pointColor: '#00FF00', pointRadius: 6 },
      });
    }, coordinate);
    await settle(page);
    const drawn = await readPicture(page);
    expect(countNear(drawn, at.x, at.y, 3, GREEN)).toBeGreaterThan(10);
    await page.close();
  });
});
