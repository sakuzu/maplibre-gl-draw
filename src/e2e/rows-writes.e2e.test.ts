// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What is drawn of a circle after one of its attributes is written
 *
 * A circle apart from small ones, alone or among 70 or 1,100, none selected or all of them, on a
 * flat map, on the terrain and on the globe. The attributes its drawing reads (its radius, its
 * created zoom) and another one are written, and the pictures of the next frame and of the frame
 * the drawing has finished in are held to the picture of the same document loaded anew around the
 * circle, and to the picture before the write elsewhere.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrawDocument } from '../index.js';
import { browserTimeout } from '../test-utils.js';
import { computeBoundingBox } from '../view/ui/selection-ui/bounding-box.js';
import { difference, type Picture } from './compare-pictures.js';
import { type Bundle, bundlePage, type E2EWindow, launchBrowser, openMapPage } from './harness.js';
import { MAP_SETUPS, TERRAIN_EXAGGERATION } from './picture-scenes.js';

/** What the test page carries besides the map and the draw instance */
interface TerrainWindow extends E2EWindow {
  e2e: {
    terrain: {
      addTestTerrain(map: import('maplibre-gl').Map, exaggeration: number): Promise<void>;
    };
  };
}

type MapName = 'flat' | 'terrain' | 'globe';

const RADIUS = 'maplibre-gl-draw:radiusMeters';
const CREATED_ZOOM = 'maplibre-gl-draw:createdZoom';

/** The ID of the circle written */
const WRITTEN = 'written';
const LAYER = 'layer';

/** The radius of the circle written, in CSS px at the center of the camera */
const RADIUS_PX = 10;

/** The pixels around the boxes of the circle its line, its frame and its handles lie in */
const PAD_PX = 34;

/** The largest difference of a channel around the circle (its edges are cut anew when loaded) */
const LEVELS = 8;

/** The frames the page draws at most before a picture, waiting for the drawing to finish */
const SETTLE_FRAMES = 300;

/** The degrees of longitude of a CSS px, and its meters at the center of the camera of a map */
function scaleOf(map: MapName): { degrees: number; meters: number } {
  const { camera } = MAP_SETUPS[map];
  const degrees = 360 / (512 * 2 ** camera.zoom);
  return { degrees, meters: degrees * 111_320 * Math.cos((camera.center[1] * Math.PI) / 180) };
}

/** A document of `count` circles: the one written among the small ones, in two blocks beside it */
function documentOf(map: MapName, count: number): DrawDocument {
  const { center, zoom } = MAP_SETUPS[map].camera;
  const { degrees, meters } = scaleOf(map);
  const circle = (id: string, x: number, y: number, radius: number, color: string) => ({
    id,
    type: 'Circle',
    geometry: {
      type: 'Point' as const,
      coordinates: [center[0] + x * degrees, center[1] + y * degrees],
    },
    layerId: LAYER,
    visible: true,
    locked: false,
    properties: { [RADIUS]: radius * meters, [CREATED_ZOOM]: zoom },
    style: {
      fillColor: color,
      fillOpacity: 1,
      strokeColor: color,
      strokeOpacity: 1,
      strokeWidth: 2,
    },
  });
  const features: unknown[] = [];
  const rows = 25;
  for (let i = 0; i < count - 1; i++) {
    const east = i % 2 === 1 ? 1 : -1;
    const k = Math.floor(i / 2);
    const x = east * (130 + (40 * Math.floor(k / rows)) / 22);
    const y = -90 + (180 * (k % rows)) / (rows - 1);
    features.push(circle(`small-${i}`, x, y, 1.5, '#3a7d44'));
  }
  // Not the first row, from which the others are taken
  features.splice(Math.ceil(features.length / 2), 0, circle(WRITTEN, 0, 0, RADIUS_PX, '#2e86ab'));
  return {
    version: '3.0.0',
    metadata: { title: 'writes' },
    layerOrder: [LAYER],
    layers: [
      {
        id: LAYER,
        name: 'Circles',
        visible: true,
        locked: false,
        opacity: 1,
        styleRule: undefined,
        metadata: undefined,
        items: features.map((f) => (f as { id: string }).id),
      },
    ],
    features,
  } as unknown as DrawDocument;
}

/** The pictures of a scene: before the write, in the next frame, finished, and loaded anew */
interface Pictures {
  readonly before: Picture;
  readonly next: Picture;
  readonly finished: Picture;
  readonly loaded: Picture;
}

/** The attributes written, and whether they change what is drawn */
function writesOf(
  map: MapName,
): { name: string; values: Record<string, unknown>; drawn: boolean }[] {
  const radius = RADIUS_PX * scaleOf(map).meters;
  const zoom = MAP_SETUPS[map].camera.zoom;
  return [
    { name: 'four times the radius', values: { [RADIUS]: 4 * radius }, drawn: true },
    { name: 'a fifth of the radius', values: { [RADIUS]: radius / 5 }, drawn: true },
    { name: 'no radius', values: { [RADIUS]: undefined }, drawn: true },
    { name: 'two less of the created zoom', values: { [CREATED_ZOOM]: zoom - 2 }, drawn: true },
    { name: 'another attribute', values: { name: 'x' }, drawn: false },
  ];
}

/** The counts of circles of a map */
const COUNTS: Record<MapName, readonly number[]> = {
  flat: [1, 70, 1_100],
  terrain: [70],
  globe: [70],
};

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

/** Opens the page of a map */
async function openPage(name: MapName): Promise<Page> {
  const setup = MAP_SETUPS[name];
  const page = await openMapPage(browser, bundle, setup.camera);
  await page.evaluate(
    async ({ terrain, globe, exaggeration }) => {
      const w = window as unknown as TerrainWindow;
      if (globe) w.map.setProjection({ type: 'globe' });
      if (terrain) await w.e2e.terrain.addTestTerrain(w.map, exaggeration);
      w.draw.setMode('select');
    },
    { terrain: setup.terrain, globe: setup.globe, exaggeration: TERRAIN_EXAGGERATION },
  );
  return page;
}

/** Loads a document, writes attributes of the circle, loads it as written, and takes the pictures */
async function take(
  page: Page,
  document: DrawDocument,
  selected: boolean,
  values: Record<string, unknown>,
): Promise<Pictures> {
  const taken = await page.evaluate(
    async ({ document, selected, entries, written, frames }) => {
      const { draw, map } = window as unknown as E2EWindow;
      const settle = async (): Promise<void> => {
        for (let i = 0; i < frames; i++) {
          if (i >= 2 && !draw.hasPendingWork() && map.loaded()) return;
          map.triggerRepaint();
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        throw new Error('the drawing did not finish');
      };
      const picture = () =>
        new Promise<{ width: number; height: number; base64: string }>((resolve) => {
          map.once('render', () => {
            const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
            const width = gl.drawingBufferWidth;
            const height = gl.drawingBufferHeight;
            const pixels = new Uint8Array(width * height * 4);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            let text = '';
            for (let i = 0; i < pixels.length; i += 0x8000) {
              text += String.fromCharCode(...pixels.subarray(i, i + 0x8000));
            }
            resolve({ width, height, base64: btoa(text) });
          });
          map.triggerRepaint();
        });
      const load = async (source: DrawDocument): Promise<void> => {
        draw.selection.clear();
        if (!(await draw.document.load(source))) throw new Error('the document was not loaded');
        if (selected) {
          draw.selection.set(
            'feature',
            source.features.map((f) => f.id),
          );
        }
        await settle();
      };
      await load(document as DrawDocument);
      const before = await picture();
      // A value that is undefined does not cross to the page in an object
      const properties = Object.fromEntries(
        entries.map(([key, value]) => [key, value === null ? undefined : value]),
      );
      draw.features.update(written, { properties });
      const next = await picture();
      await settle();
      const finished = await picture();
      await load(draw.document.toJSON());
      const loaded = await picture();
      return { before, next, finished, loaded };
    },
    {
      document,
      selected,
      entries: Object.entries(values).map(([key, value]) => [key, value ?? null] as const),
      written: WRITTEN,
      frames: SETTLE_FRAMES,
    },
  );
  const pictureOf = ({ width, height, base64 }: (typeof taken)['next']): Picture => ({
    width,
    height,
    pixels: Buffer.from(base64, 'base64'),
  });
  return {
    before: pictureOf(taken.before),
    next: pictureOf(taken.next),
    finished: pictureOf(taken.finished),
    loaded: pictureOf(taken.loaded),
  };
}

/** A box of the drawing buffer, in device px from its top left (`x1` and `y1` excluded) */
interface PixelBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** The box the circle is drawn in with any of the radiuses */
async function rangeOf(page: Page, map: MapName, document: DrawDocument): Promise<PixelBox> {
  const written = document.features.find((f) => f.id === WRITTEN);
  const bbox = computeBoundingBox({
    ...written,
    properties: { [RADIUS]: 4 * RADIUS_PX * scaleOf(map).meters },
  } as never);
  if (!bbox) throw new Error('no box of the circle');
  return page.evaluate(
    ({ corners, pad }) => {
      const { map } = window as unknown as E2EWindow;
      const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
      const ratio = gl.drawingBufferWidth / map.getCanvas().clientWidth;
      const points = corners.map((c) => map.project(c as [number, number]));
      const xs = points.map((p) => p.x * ratio);
      const ys = points.map((p) => p.y * ratio);
      return {
        x0: Math.floor(Math.min(...xs) - pad * ratio),
        y0: Math.floor(Math.min(...ys) - pad * ratio),
        x1: Math.ceil(Math.max(...xs) + pad * ratio),
        y1: Math.ceil(Math.max(...ys) + pad * ratio),
      };
    },
    { corners: [bbox.topLeft, bbox.topRight, bbox.bottomRight, bbox.bottomLeft], pad: PAD_PX },
  );
}

/** The pixels of two pictures that differ by more than `levels`, inside a box or outside it */
function differing(a: Picture, b: Picture, box: PixelBox, inside: boolean, levels: number): number {
  let count = 0;
  for (let i = 0; i < a.pixels.length; i += 4) {
    const x = (i / 4) % a.width;
    const y = a.height - 1 - Math.floor(i / 4 / a.width);
    const within = x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1;
    if (within !== inside) continue;
    for (let c = 0; c < 4; c++) {
      if (Math.abs(a.pixels[i + c] - b.pixels[i + c]) <= levels) continue;
      count++;
      break;
    }
  }
  return count;
}

for (const map of ['flat', 'terrain', 'globe'] as const) {
  describe(`a circle written on the ${map} map`, () => {
    let page: Page;

    beforeAll(async () => {
      page = await openPage(map);
    }, browserTimeout(90_000));

    afterAll(async () => {
      await page?.close();
    });

    for (const count of COUNTS[map]) {
      for (const selected of [false, true]) {
        for (const { name, values, drawn } of writesOf(map)) {
          it(`${name}, of ${count}${selected ? ', all selected' : ''}`, async () => {
            const document = documentOf(map, count);
            const range = await rangeOf(page, map, document);
            const { before, next, finished, loaded } = await take(page, document, selected, values);
            for (const [when, picture] of Object.entries({ next, finished })) {
              if (drawn) {
                expect(differing(picture, loaded, range, true, LEVELS), `${when}, circle`).toBe(0);
                expect(differing(picture, before, range, false, 0), `${when}, elsewhere`).toBe(0);
                expect(difference(picture, before).pixels, when).toBeGreaterThan(0);
              } else {
                expect(difference(picture, before).pixels, when).toBe(0);
              }
            }
          });
        }
      }
    }
  });
}
