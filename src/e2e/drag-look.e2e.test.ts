// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of what is drawn while a drag goes on, on the real maplibre and WebGL of the
 * browser, over a Store of objects and over the Store of rows of the library: what is dragged and
 * what goes with it follow the pointer, and nothing is left where they were.
 *
 * - The fill and the outline of a polygon, and a line, on a map with terrain
 * - A thick dotted outline, and an outline whose line style is changed, on a map without terrain
 * - The mark of the vertex of another feature that moves along with a shared vertex
 * - Features whose place is outside the view, moved into it with a feature dragged in the view
 * - The image of the map taken while a shape is drawn has no shape being drawn
 *
 * The pixels of the colors of what is drawn are counted, with their centers (in CSS pixels of the
 * map, from its top left).
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import {
  type Bundle,
  bundlePage,
  type Camera,
  launchBrowser,
  openMapPage,
  type PagePoint,
  pageOf,
  settle,
} from './harness.js';

const CENTER: [number, number] = [139.7, 35.68];

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

type StoreKind = 'objects' | 'rows';

/** An RGB color of a test, as the frame draws it */
type Rgb = readonly [number, number, number];

const FILL: Rgb = [0xc2, 0x92, 0x10];
const OUTLINE: Rgb = [0x2d, 0x7f, 0xf9];
const LINE: Rgb = [0x10, 0xa0, 0x50];
const OTHER_FILL: Rgb = [0x90, 0x20, 0xc0];
const POINT: Rgb = [0xe0, 0x60, 0x00];
const FOLLOWED: Rgb = [0x00, 0xe5, 0xff];
const MAGENTA: Rgb = [0xff, 0x00, 0xff];

const hex = (c: Rgb): string => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** A box of the map: left, top, right, bottom (CSS pixels from its top left) */
type Box = [number, number, number, number];

/**
 * The pixels of a color drawn: their number, those in a box asked for, their center and their box
 * (null for none)
 */
interface Drawn {
  count: number;
  inside: number;
  center: [number, number] | null;
  box: Box | null;
}

/** A feature to create */
interface FeatureInput {
  id: string;
  type: string;
  geometry: { type: string; coordinates: unknown };
  style?: Record<string, unknown>;
}

/** The options of a page */
interface Scene {
  kind: StoreKind;
  zoom: number;
  terrain?: boolean;
  features: FeatureInput[];
  /** The options given to createDraw besides the Store */
  options?: Record<string, unknown>;
  /** Files of images of one color, by ID, put in the Store before the instance is made */
  images?: Record<string, string>;
}

/** A handle drawn with nothing */
const NO_POINT = {
  shape: 'circle',
  size: 0,
  fillColor: '#000000',
  fillOpacity: 0,
  strokeColor: '#000000',
  strokeWidth: 0,
  strokeOpacity: 0,
};

/**
 * The handles of the selection drawn with nothing: they follow a feature moved as a whole and
 * are drawn over it (`drag-reads-moves` holds where), so the shape is measured alone here
 */
const NO_HANDLES = {
  selectionStyle: {
    resizeHandle: { point: NO_POINT },
    rotateHandle: {
      point: NO_POINT,
      distance: 0,
      connector: { width: 0, color: '#000000', opacity: 0, lineStyle: 'solid' },
    },
    vertexHandle: { point: NO_POINT, selected: NO_POINT, followed: NO_POINT },
    midpointHandle: { point: NO_POINT },
  },
};

/** A position at an offset from the center, in degrees */
const at = (dx: number, dy: number): [number, number] => [CENTER[0] + dx, CENTER[1] + dy];

/** A closed ring of nine corners around an offset from the center */
function ring(dx: number, dy: number, rx: number, ry = rx * 0.8): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    out.push(at(dx + Math.cos(a) * rx, dy + Math.sin(a) * ry));
  }
  out.push(out[0] as [number, number]);
  return out;
}

const polygon = (id: string, coordinates: unknown, style: Record<string, unknown>) => ({
  id,
  type: 'Polygon',
  geometry: { type: 'Polygon', coordinates },
  style,
});

/**
 * Opens a page with an instance over a Store of a kind holding the features in a layer `L`, and
 * installs what the steps use (`window.t`)
 */
async function open(scene: Scene): Promise<Page> {
  const camera: Camera = { center: CENTER, zoom: scene.zoom };
  const page = await openMapPage(browser, bundle, camera);
  await page.evaluate((s) => {
    type Draw = import('../index.js').Draw;
    const w = window as unknown as Record<string, unknown> & {
      map: import('maplibre-gl').Map;
      draw: Draw;
      e2e: {
        createDraw: typeof import('../index.js').createDraw;
        tables: { createTableStore: typeof import('../kasane/index.js').createTableStore };
        internals: { MemoryContractStore: new () => import('../index.js').Store };
      };
      t: unknown;
    };
    const { map } = w;
    const layer = { id: 'L', name: 'L', visible: true, locked: false, opacity: 1 };
    let store: import('../index.js').Store;
    if (s.kind === 'rows') {
      const made = w.e2e.tables.createTableStore();
      store = made.store as unknown as import('../index.js').Store;
      made.store.createLayer({
        ...layer,
        kind: 'table',
        styleRule: undefined,
        metadata: undefined,
      } as never);
    } else {
      const contract = new w.e2e.internals.MemoryContractStore();
      contract.transact(() => {
        contract.createLayer({
          ...layer,
          items: [],
          styleRule: undefined,
          metadata: undefined,
        } as never);
      }, 'remote');
      store = contract;
    }
    for (const [id, color] of Object.entries(s.images ?? {})) {
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      const context = canvas.getContext('2d') as CanvasRenderingContext2D;
      context.fillStyle = color;
      context.fillRect(0, 0, 16, 16);
      const file = { id, mimeType: 'image/png', dataURL: canvas.toDataURL('image/png') };
      (store as unknown as { createFile(f: unknown): unknown }).createFile(file);
    }
    w.draw.destroy();
    const draw = w.e2e.createDraw(map, {
      ...(s.options ?? {}),
      store,
      initDefaultLayer: false,
    } as never);
    w.draw = draw;
    for (const feature of s.features) {
      if (!draw.features.create({ ...feature, layerId: 'L' } as never)) {
        throw new Error(`${feature.id} was not created`);
      }
    }

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
    const measure = (
      pixels: Uint8Array,
      width: number,
      height: number,
      color: readonly number[],
      within: readonly number[] | null = null,
    ) => {
      let count = 0;
      let inside = 0;
      let sx = 0;
      let sy = 0;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let i = 0; i < pixels.length; i += 4) {
        if ((pixels[i + 3] as number) < 128) continue;
        let near = true;
        for (let k = 0; k < 3; k++) {
          if (Math.abs((pixels[i + k] as number) - (color[k] as number)) >= 24) near = false;
        }
        if (!near) continue;
        const x = (i / 4) % width;
        // The frame is read from the bottom
        const y = height - 1 - Math.floor(i / 4 / width);
        count++;
        if (
          within &&
          x >= (within[0] as number) &&
          y >= (within[1] as number) &&
          x <= (within[2] as number) &&
          y <= (within[3] as number)
        ) {
          inside++;
        }
        sx += x;
        sy += y;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      return count > 0
        ? { count, inside, center: [sx / count, sy / count], box: [x0, y0, x1, y1] }
        : { count, inside, center: null, box: null };
    };
    w.t = {
      // The frame once everything is built, the pixels of each color
      async frame(colors: number[][], boxes: Array<number[] | null>) {
        let pixels = await read();
        for (let i = 0; i < 100 && draw.hasPendingWork(); i++) pixels = await read();
        await read();
        pixels = await read();
        const canvas = map.getCanvas();
        return colors.map((c, i) =>
          measure(pixels, canvas.width, canvas.height, c, boxes[i] ?? null),
        );
      },
      // The pixels of each color of the image of the map
      async capture(colors: number[][]) {
        const blob = await draw.captureImage();
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d') as CanvasRenderingContext2D;
        context.drawImage(bitmap, 0, 0);
        const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        // The image reads from the top: turned over to read as the frame does
        const flipped = new Uint8Array(data.length);
        const rowBytes = bitmap.width * 4;
        for (let y = 0; y < bitmap.height; y++) {
          flipped.set(
            data.subarray((bitmap.height - 1 - y) * rowBytes, (bitmap.height - y) * rowBytes),
            y * rowBytes,
          );
        }
        let opaque = 0;
        for (let i = 3; i < flipped.length; i += 4) if ((flipped[i] as number) >= 128) opaque++;
        return {
          opaque,
          colors: colors.map((c) => measure(flipped, bitmap.width, bitmap.height, c)),
        };
      },
      select(ids: string[]) {
        if (ids.length === 0) draw.selection.clear();
        else draw.selection.set('feature', ids);
      },
      update(id: string, patch: Record<string, unknown>) {
        draw.features.update(id, patch as never);
      },
      setMode(mode: string) {
        draw.setMode(mode as never);
      },
    };
  }, scene);
  if (scene.terrain) {
    await page.evaluate(async () => {
      const w = window as unknown as {
        map: unknown;
        e2e: {
          terrain: {
            addTestTerrain(map: unknown, exaggeration: number, o: unknown): Promise<void>;
          };
        };
      };
      await w.e2e.terrain.addTestTerrain(w.map, 1, { flat: true });
    });
  }
  return page;
}

/**
 * The frame once everything is built: the pixels of each color, and those of them in a box given
 * for the color (`inside`)
 */
const frame = (
  page: Page,
  colors: readonly Rgb[],
  boxes: ReadonlyArray<Box | null> = [],
): Promise<Drawn[]> =>
  page.evaluate(
    ([c, b]) =>
      (window as unknown as { t: { frame(c: unknown, b: unknown): Promise<Drawn[]> } }).t.frame(
        c,
        b,
      ),
    [colors, boxes] as unknown as [number[][], number[][]],
  );

const select = (page: Page, ids: string[]): Promise<void> =>
  page.evaluate(
    (i) => (window as unknown as { t: { select(i: string[]): void } }).t.select(i),
    ids,
  );

const update = (page: Page, id: string, patch: Record<string, unknown>): Promise<void> =>
  page.evaluate(
    ([i, p]) =>
      (window as unknown as { t: { update(i: unknown, p: unknown): void } }).t.update(i, p),
    [id, patch] as const,
  );

/** The point of the map (CSS pixels from its top left) where a coordinate is drawn */
async function mapPointOf(page: Page, lngLat: number[]): Promise<[number, number]> {
  return page.evaluate((c) => {
    const p = (window as unknown as { map: import('maplibre-gl').Map }).map.project(
      c as [number, number],
    );
    return [p.x, p.y] as [number, number];
  }, lngLat);
}

/** Presses at a point, moves by a distance in steps, and leaves the button pressed */
async function pressAndMove(page: Page, from: PagePoint, by: [number, number]): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by[0], from.y + by[1], { steps: 8 });
  await settle(page);
}

/** The move of the center of the pixels of a color from one frame to another */
function shift(after: Drawn, before: Drawn): [number, number] {
  expect(before.center).not.toBeNull();
  expect(after.center).not.toBeNull();
  const a = after.center as [number, number];
  const b = before.center as [number, number];
  return [a[0] - b[0], a[1] - b[1]];
}

/** A move within a tolerance (pixels) of another on each axis */
function expectMove(
  actual: [number, number],
  expected: readonly [number, number],
  tolerance = 1.5,
) {
  expect(Math.abs(actual[0] - expected[0])).toBeLessThan(tolerance);
  expect(Math.abs(actual[1] - expected[1])).toBeLessThan(tolerance);
}

/** About as many pixels as another frame drew (none left behind, none missing) */
function expectAsMany(actual: Drawn, expected: Drawn, share = 0.1) {
  expect(expected.count).toBeGreaterThan(50);
  expect(Math.abs(actual.count - expected.count)).toBeLessThanOrEqual(expected.count * share);
}

const KINDS: StoreKind[] = ['objects', 'rows'];
const DRAG: [number, number] = [60, 30];

describe.each(KINDS)('a drag over a Store of %s', (kind) => {
  describe.each([10, 12])('on a map with terrain at zoom %i', (zoom) => {
    /** Farther than the size of what is dragged, so that where it was and where it goes part */
    const FAR: [number, number] = [110, 50];
    // A polygon about 30 px across, a line about 90 px across
    const r = zoom === 10 ? 0.01 : 0.0025;

    /**
     * Selects a feature, drags it from a point by `FAR` and reads the frame in the middle of the
     * drag: the pixels of each color where they were drawn before (left behind), and where they
     * are drawn moved by the drag
     */
    async function dragOver(page: Page, id: string, from: number[], colors: Rgb[]) {
      // Read before it is selected: the highlight of the selection changes its colors
      const before = await frame(page, colors);
      await select(page, [id]);
      for (const drawn of before) expect(drawn.count).toBeGreaterThan(50);
      const boxes = before.map((d) => d.box as Box);
      const moved = boxes.map(
        ([x0, y0, x1, y1]): Box => [
          x0 + FAR[0] - 4,
          y0 + FAR[1] - 4,
          x1 + FAR[0] + 4,
          y1 + FAR[1] + 4,
        ],
      );
      await pressAndMove(page, await pageOf(page, from), FAR);
      const behind = await frame(page, colors, boxes);
      const ahead = await frame(page, colors, moved);
      await page.mouse.up();
      return colors.map((_, i) => ({
        before: before[i] as Drawn,
        behind: (behind[i] as Drawn).inside,
        ahead: (ahead[i] as Drawn).inside,
      }));
    }

    it.each(['solid', 'dotted'])(
      'moves the fill and the %s outline of a polygon in the middle of the drag',
      {
        timeout: browserTimeout(90_000),
      },
      async (lineStyle) => {
        const page = await open({
          kind,
          zoom,
          terrain: true,
          options: NO_HANDLES,
          features: [
            polygon('p', [ring(0, 0, r)], {
              fillColor: hex(FILL),
              fillOpacity: 1,
              strokeColor: hex(OUTLINE),
              strokeWidth: 4,
              lineStyle,
            }),
          ],
        });
        const result = await dragOver(page, 'p', CENTER, [FILL, OUTLINE]);
        await page.close();
        for (const { before, behind, ahead } of result) {
          expect(behind).toBe(0);
          expect(ahead).toBeGreaterThan(before.count * 0.9);
        }
      },
    );

    it.each(['solid', 'dashed'])(
      'moves a %s line in the middle of the drag',
      {
        timeout: browserTimeout(90_000),
      },
      async (lineStyle) => {
        const page = await open({
          kind,
          zoom,
          terrain: true,
          options: NO_HANDLES,
          features: [
            {
              id: 'l',
              type: 'LineString',
              geometry: {
                type: 'LineString',
                coordinates: [at(-3 * r, -r), at(0, 0), at(3 * r, -r)],
              },
              style: { strokeColor: hex(LINE), strokeWidth: 6, lineStyle },
            },
          ],
        });
        // A third of the way along the first segment, off its vertices and its midpoint
        const result = await dragOver(page, 'l', at(-2 * r, (-2 * r) / 3), [LINE]);
        await page.close();
        for (const { before, behind, ahead } of result) {
          expect(behind).toBe(0);
          expect(ahead).toBeGreaterThan(before.count * 0.9);
        }
      },
    );
  });

  describe('on a map without terrain', () => {
    const DOTTED = {
      strokeColor: hex(OUTLINE),
      strokeWidth: 16,
      lineStyle: 'dotted',
      fillColor: hex(FILL),
      fillOpacity: 1,
    };

    it('moves a thick dotted outline with its fill in the middle of the drag and once let go', {
      timeout: browserTimeout(90_000),
    }, async () => {
      for (const madeDotted of [false, true]) {
        const page = await open({
          kind,
          zoom: 12,
          options: NO_HANDLES,
          features: [
            polygon('p', [ring(0, 0, 0.02)], madeDotted ? { fillColor: hex(FILL) } : DOTTED),
          ],
        });
        await select(page, ['p']);
        await frame(page, [FILL]);
        if (madeDotted) await update(page, 'p', { style: DOTTED });
        await select(page, []);
        const [fill0, outline0] = await frame(page, [FILL, OUTLINE]);
        await select(page, ['p']);
        await pressAndMove(page, await pageOf(page, CENTER), DRAG);
        const [fill1, outline1] = await frame(page, [FILL, OUTLINE]);
        await page.mouse.up();
        await settle(page);
        await select(page, []);
        const [fill2, outline2] = await frame(page, [FILL, OUTLINE]);
        await page.close();
        expectMove(shift(fill1 as Drawn, fill0 as Drawn), DRAG, 3);
        expectMove(shift(outline1 as Drawn, outline0 as Drawn), DRAG, 3);
        expectAsMany(outline1 as Drawn, outline0 as Drawn);
        expectMove(shift(fill2 as Drawn, fill0 as Drawn), DRAG, 1.5);
        expectMove(shift(outline2 as Drawn, outline0 as Drawn), DRAG, 1.5);
        expectAsMany(outline2 as Drawn, outline0 as Drawn, 0.05);
      }
    });

    it('draws a thick outline whose line style is changed as one drawn so from the start', {
      timeout: browserTimeout(90_000),
    }, async () => {
      for (const lineStyle of ['dashed', 'solid']) {
        const fresh = await open({
          kind,
          zoom: 12,
          features: [polygon('p', [ring(0, 0, 0.02)], { ...DOTTED, lineStyle })],
        });
        const [expected] = await frame(fresh, [OUTLINE]);
        await fresh.close();
        const page = await open({
          kind,
          zoom: 12,
          features: [polygon('p', [ring(0, 0, 0.02)], DOTTED)],
        });
        await select(page, ['p']);
        await frame(page, [OUTLINE]);
        await pressAndMove(page, await pageOf(page, CENTER), DRAG);
        await page.mouse.up();
        await settle(page);
        await update(page, 'p', { style: { lineStyle } });
        await select(page, []);
        const [actual] = await frame(page, [OUTLINE]);
        await page.close();
        expectAsMany(actual as Drawn, expected as Drawn, 0.05);
        expectMove(shift(actual as Drawn, expected as Drawn), DRAG, 1.5);
      }
    });

    it('draws the mark of the vertex that moves along with a shared vertex where it is moved', {
      timeout: browserTimeout(90_000),
    }, async () => {
      const d = 0.01;
      // Two squares that share their edge at the center (two vertices)
      const left = [[at(-2 * d, -d), at(0, -d), at(0, d), at(-2 * d, d), at(-2 * d, -d)]];
      const right = [[at(0, -d), at(2 * d, -d), at(2 * d, d), at(0, d), at(0, -d)]];
      const page = await open({
        kind,
        zoom: 13,
        features: [
          polygon('a', left, { fillColor: hex(FILL), fillOpacity: 1 }),
          polygon('b', right, { fillColor: hex(OTHER_FILL), fillOpacity: 1 }),
        ],
        options: {
          topology: { sharedVertexDrag: true },
          snapping: { enabled: false },
          selectionStyle: {
            vertexHandle: {
              followed: {
                shape: 'square',
                size: 14,
                fillColor: hex(FOLLOWED),
                fillOpacity: 1,
                strokeColor: hex(FOLLOWED),
                strokeWidth: 0,
                strokeOpacity: 1,
              },
            },
          },
        },
      });
      await select(page, ['a']);
      await frame(page, [FOLLOWED]);
      const shared = at(0, d);
      const [x, y] = await mapPointOf(page, shared);
      const by: [number, number] = [30, -24];
      await pressAndMove(page, await pageOf(page, shared), by);
      const [followed] = await frame(page, [FOLLOWED]);
      await page.mouse.up();
      await page.close();
      expect((followed as Drawn).count).toBeGreaterThan(40);
      expectMove((followed as Drawn).center as [number, number], [x + by[0], y + by[1]], 2);
    });

    it('draws the features outside the view moved into it in the middle of the drag', {
      timeout: browserTimeout(90_000),
    }, async () => {
      const zoom = 13;
      // 640 px wide at zoom 13: a degree of longitude is about 11,650 px, so 0.02 is 233 px
      const inside = 0.02;
      const outside = 0.04;
      /** The features outside the view, placed at an offset of longitude */
      const outsideAt = (dx: number) => [
        polygon('out', [ring(dx, 0.003, 0.002)], { fillColor: hex(OTHER_FILL), fillOpacity: 1 }),
        {
          id: 'pt',
          type: 'Point',
          geometry: { type: 'Point', coordinates: at(dx, 0) },
          style: { pointColor: hex(POINT), pointRadius: 8, pointStrokeWidth: 0 },
        },
        {
          id: 'img',
          type: 'Image',
          geometry: { type: 'Point', coordinates: at(dx, -0.003) },
          properties: {
            'maplibre-gl-draw:createdZoom': zoom,
            'maplibre-gl-draw:imageFileId': 'magenta',
            'maplibre-gl-draw:imageWidth': 30,
            'maplibre-gl-draw:imageHeight': 30,
          },
          style: { imageOpacity: 1 },
        },
      ];
      const colors = [OTHER_FILL, POINT, MAGENTA];
      const scene = (dx: number): Scene => ({
        kind,
        zoom,
        images: { magenta: hex(MAGENTA) },
        features: [
          polygon('in', [ring(inside, 0, 0.002)], { fillColor: hex(FILL), fillOpacity: 1 }),
          ...outsideAt(dx),
        ],
      });
      // What is drawn of them once they are in the view, to compare with
      const moved = await open(scene(0));
      const expected = await frame(moved, colors);
      await moved.close();
      const page = await open(scene(outside));
      await select(page, ['in', 'out', 'pt', 'img']);
      const before = await frame(page, colors);
      const [x0] = await mapPointOf(page, at(outside, 0));
      const [x1] = await mapPointOf(page, at(0, 0));
      await pressAndMove(page, await pageOf(page, at(inside, 0)), [x1 - x0, 0]);
      const middle = await frame(page, colors);
      await page.mouse.up();
      await page.close();
      for (let i = 0; i < colors.length; i++) {
        const drawn = middle[i] as Drawn;
        const wanted = expected[i] as Drawn;
        expect((before[i] as Drawn).count).toBe(0);
        expect(wanted.count).toBeGreaterThan(100);
        expect(drawn.count).toBeGreaterThan(wanted.count * 0.8);
        expectMove(drawn.center as [number, number], wanted.center as [number, number], 3);
      }
    });
  });
});

describe('the image of the map', () => {
  it('has no shape being drawn', { timeout: browserTimeout(90_000) }, async () => {
    const page = await open({
      kind: 'objects',
      zoom: 12,
      features: [],
      options: {
        previewStyle: { strokeColor: hex(LINE), strokeWidth: 4 },
        // No mark of a snap at the pointer, which is drawn over the map
        snapping: { enabled: false },
      },
    });
    await page.evaluate(() =>
      (window as unknown as { t: { setMode(m: string): void } }).t.setMode('draw_polygon'),
    );
    for (const p of [at(-0.02, -0.01), at(0.02, -0.01), at(0.02, 0.012)]) {
      const point = await pageOf(page, p);
      await page.mouse.click(point.x, point.y);
      await settle(page);
    }
    const [drawn] = await frame(page, [LINE]);
    const image = await page.evaluate(
      (c) => {
        const w = window as unknown as {
          t: { capture(c: unknown): Promise<{ opaque: number; colors: Drawn[] }> };
        };
        return w.t.capture(c);
      },
      [LINE] as unknown as number[][],
    );
    await page.close();
    // The frame draws the shape being drawn; the image has nothing of it
    expect((drawn as Drawn).count).toBeGreaterThan(100);
    expect(image.colors[0]?.count).toBe(0);
    expect(image.opaque).toBe(0);
  });
});
