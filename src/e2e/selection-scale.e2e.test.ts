// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the sizes in pixels the selection UI lays on the map, on the real maplibre
 * and WebGL of the browser, over a Store of objects and over the Store of rows of the library
 *
 * The margin of the frame, the distance of the rotate handle and the move of an arrow key are
 * sizes of the current view: they are turned into lengths on the ground with the scale of the
 * frame drawn, and laid around the feature, so they tilt and turn with the map. The frame of a
 * point is drawn on the screen around its marker. The tests hold:
 *
 * - untilted, on a flat Web Mercator view, on the globe and in the middle of the transition from
 *   the globe to Web Mercator, the margin and the distance in pixels, measured against the vertex
 *   handles drawn beside them
 * - flat, tilted and turned, on the globe and over terrain: the handles and the frame are grabbed
 *   where they are drawn and not beside them
 * - the frame of a point, around its marker, grabbed where it is drawn
 * - the arrow keys on a turned map, along the screen
 *
 * What is drawn is read from the pixels of the frame (in CSS pixels of the map, from its top
 * left), and what is grabbed from the cursor the select mode sets.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import {
  CENTER,
  cursorAt,
  hex,
  KINDS,
  load,
  type MapPoint,
  mapPointOf,
  openScenePage,
  pointLook,
  type Rgb,
  SCENES_TIMEOUT,
  type SceneSpec,
  type StoreKind,
  select,
} from './drag-scene.js';
import { type Bundle, bundlePage, launchBrowser, settle } from './harness.js';

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

const FILL: Rgb = [0xc2, 0x92, 0x10];
const OUTLINE: Rgb = [0x2d, 0x7f, 0xf9];
const FRAME: Rgb = [0xff, 0x00, 0xff];
const CONNECTOR: Rgb = [0x60, 0x60, 0x60];
const RESIZE: Rgb = [0x00, 0xc0, 0x00];
const ROTATE: Rgb = [0x80, 0x00, 0x00];
const MARKER: Rgb = [0xe0, 0x60, 0x00];
const VERTEX: Rgb = [0x00, 0x30, 0xd0];

const MARGIN = 10;
const DISTANCE = 10;
/** The half size of the resize and rotate handles */
const HALF = 5;

/**
 * The selection UI in the colors of the tests, at the margin and the distance by default; the
 * vertex and midpoint handles a pixel or two across, out of the way of the frame
 */
const selectionStyle = {
  boundingBox: {
    stroke: { width: 2, color: hex(FRAME), opacity: 1, lineStyle: 'solid' },
    margin: MARGIN,
  },
  resizeHandle: { point: pointLook('square', RESIZE, 2 * HALF) },
  rotateHandle: {
    point: pointLook('square', ROTATE, 2 * HALF),
    distance: DISTANCE,
    connector: { width: 2, color: hex(CONNECTOR), opacity: 1, lineStyle: 'solid' },
  },
  vertexHandle: {
    point: pointLook('square', OUTLINE, 2),
    selected: pointLook('square', OUTLINE, 2),
    followed: pointLook('square', OUTLINE, 2),
  },
  midpointHandle: { point: pointLook('square', OUTLINE, 2) },
  radiusHandle: { point: pointLook('square', RESIZE, 2 * HALF) },
};

/** The same with vertex handles to measure from, drawn as the other handles are */
const measuredStyle = {
  ...selectionStyle,
  vertexHandle: {
    point: pointLook('square', VERTEX, 2 * HALF),
    selected: pointLook('square', VERTEX, 2 * HALF),
    followed: pointLook('square', VERTEX, 2 * HALF),
  },
};

/** The camera and the ground of a scene */
interface View {
  name: string;
  center: [number, number];
  zoom: number;
  pitch?: number;
  bearing?: number;
  globe?: boolean;
  /** The half size of the square of the scene, in degrees */
  size: number;
}

/** A slope of the peak of the test terrain */
const SLOPE: [number, number] = [138.745, 35.368];

const VIEWS: readonly View[] = [
  { name: 'tilted and turned', center: CENTER, zoom: 14, pitch: 55, bearing: 30, size: 0.003 },
  { name: 'on the globe', center: [139.7, 30], zoom: 2.6, globe: true, size: 6 },
  {
    name: 'on the globe turned to its side',
    center: [139.7, 30],
    zoom: 2.6,
    bearing: 70,
    pitch: 30,
    globe: true,
    size: 6,
  },
];

/** Over the peak of the test terrain, on its slope, tilted and turned */
const TERRAIN_VIEW: View = {
  name: 'over terrain, tilted and turned',
  center: SLOPE,
  zoom: 14,
  pitch: 50,
  bearing: -25,
  size: 0.003,
};

const LOOK = { fillColor: hex(FILL), fillOpacity: 1, strokeColor: hex(OUTLINE), strokeWidth: 2 };

/** A square around a position */
function squareAround([lng, lat]: [number, number], r: number): Array<[number, number]> {
  return [
    [lng - r, lat - r],
    [lng + r, lat - r],
    [lng + r, lat + r],
    [lng - r, lat + r],
    [lng - r, lat - r],
  ];
}

const polygonScene = (
  kind: StoreKind,
  view: Pick<View, 'center' | 'size'>,
  style: object = selectionStyle,
): SceneSpec => ({
  kind,
  features: [
    {
      id: 'p',
      type: 'Polygon',
      geometry: { type: 'Polygon', coordinates: [squareAround(view.center, view.size)] },
      style: LOOK,
    },
  ],
  options: { selectionStyle: style },
});

const pointScene = (kind: StoreKind, center: [number, number]): SceneSpec => ({
  kind,
  features: [
    {
      id: 'p',
      type: 'Point',
      geometry: { type: 'Point', coordinates: center },
      style: { pointShape: 'circle', pointRadius: 6, pointColor: hex(MARKER), pointStrokeWidth: 0 },
    },
  ],
  options: { selectionStyle },
});

/**
 * Opens a page with the map, and the test terrain (its peak, not flat) on it or not: the terrain is
 * put on once, before any scene
 */
async function openPage(terrain: boolean): Promise<Page> {
  const page = await openScenePage(browser, bundle, 14);
  if (terrain) {
    await page.evaluate(async () => {
      const w = window as unknown as {
        map: unknown;
        e2e: {
          terrain: {
            addTestTerrain(map: unknown, exaggeration: number, o: unknown): Promise<void>;
          };
        };
      };
      await w.e2e.terrain.addTestTerrain(w.map, 1, {});
    });
  }
  return page;
}

/** Opens a scene and puts the camera and the projection of a view on it */
async function openView(
  page: Page,
  spec: SceneSpec,
  view: Omit<View, 'name' | 'size'>,
): Promise<void> {
  await load(page, spec, view.zoom);
  await page.evaluate(async (v) => {
    const { map } = window as unknown as { map: import('maplibre-gl').Map };
    map.setProjection({ type: v.globe ? 'globe' : 'mercator' });
    map.jumpTo({ center: v.center, zoom: v.zoom, pitch: v.pitch ?? 0, bearing: v.bearing ?? 0 });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 15_000);
      map.once('idle', () => {
        clearTimeout(timer);
        resolve();
      });
      map.triggerRepaint();
    });
  }, view);
  await settle(page);
}

/** A group of pixels of a color, side by side: its center and its box */
interface Cluster {
  center: MapPoint;
  box: [number, number, number, number];
  count: number;
}

/** What the frame shows: the groups of pixels of each color asked, and the walks asked */
interface Seen {
  clusters: Cluster[][];
  /** The distance in CSS pixels from a point along a direction to the first pixel of a color */
  walks: Array<number | null>;
}

/** A walk from a point of the map along a direction to the first pixel of a color */
interface Walk {
  from: MapPoint;
  direction: MapPoint;
  color: Rgb;
}

/**
 * Reads the frame once everything is built: the groups of pixels of each color (8-connected, of a
 * few pixels at least) and the walks
 */
async function look(
  page: Page,
  colors: readonly Rgb[],
  walks: readonly Walk[] = [],
): Promise<Seen> {
  return page.evaluate(
    async ({ colors, walks }) => {
      const w = window as unknown as {
        map: import('maplibre-gl').Map;
        draw: import('../index.js').Draw;
      };
      const { map, draw } = w;
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
      for (let i = 0; i < 100 && draw.hasPendingWork(); i++) pixels = await read();
      await read();
      pixels = await read();
      const canvas = map.getCanvas();
      const width = canvas.width;
      const height = canvas.height;
      const ratio = width / canvas.clientWidth;
      const near = (x: number, y: number, color: number[]): boolean => {
        if (x < 0 || y < 0 || x >= width || y >= height) return false;
        const i = ((height - 1 - y) * width + x) * 4;
        if ((pixels[i + 3] as number) < 128) return false;
        return color.every((v, k) => Math.abs((pixels[i + k] as number) - v) < 24);
      };
      const clusters = colors.map((color) => {
        const label = new Int32Array(width * height).fill(-1);
        const found: Array<{ sx: number; sy: number; n: number; box: number[] }> = [];
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (label[y * width + x] !== -1 || !near(x, y, color)) continue;
            const id = found.length;
            const group = { sx: 0, sy: 0, n: 0, box: [x, y, x, y] };
            found.push(group);
            const stack = [x, y];
            label[y * width + x] = id;
            while (stack.length > 0) {
              const cy = stack.pop() as number;
              const cx = stack.pop() as number;
              group.sx += cx;
              group.sy += cy;
              group.n++;
              group.box = [
                Math.min(group.box[0] as number, cx),
                Math.min(group.box[1] as number, cy),
                Math.max(group.box[2] as number, cx),
                Math.max(group.box[3] as number, cy),
              ];
              for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                  const nx = cx + dx;
                  const ny = cy + dy;
                  if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                  if (label[ny * width + nx] !== -1 || !near(nx, ny, color)) continue;
                  label[ny * width + nx] = id;
                  stack.push(nx, ny);
                }
              }
            }
          }
        }
        return found
          .filter((g) => g.n >= 4)
          .map((g) => ({
            center: [g.sx / g.n / ratio, g.sy / g.n / ratio],
            box: g.box.map((v) => v / ratio),
            count: g.n,
          }));
      });
      const walked = walks.map((walk) => {
        const length = Math.hypot(walk.direction[0] as number, walk.direction[1] as number);
        const ux = (walk.direction[0] as number) / length;
        const uy = (walk.direction[1] as number) / length;
        for (let d = 0; d < 2000; d += 0.25) {
          const x = Math.round(((walk.from[0] as number) + ux * d) * ratio);
          const y = Math.round(((walk.from[1] as number) + uy * d) * ratio);
          if (x < 0 || y < 0 || x >= width || y >= height) return null;
          if (near(x, y, walk.color as unknown as number[])) return d;
        }
        return null;
      });
      return { clusters, walks: walked };
    },
    { colors: colors as unknown as number[][], walks: walks as unknown as Walk[] },
  ) as Promise<Seen>;
}

const along = (from: MapPoint, direction: MapPoint, distance: number): MapPoint => {
  const length = Math.hypot(direction[0], direction[1]);
  return [
    from[0] + (direction[0] / length) * distance,
    from[1] + (direction[1] / length) * distance,
  ];
};
const away = (point: MapPoint, from: MapPoint): MapPoint => [
  point[0] - from[0],
  point[1] - from[1],
];
const distanceOf = (a: MapPoint, b: MapPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The point of the map of a position */
const pointOf = (page: Page, lngLat: [number, number]) => mapPointOf(page, lngLat);

/**
 * The handles of the frame of a polygon are grabbed where they are drawn, and not beside them; the
 * frame is grabbed inside the line drawn and not outside it
 */
async function expectGrabbedAsDrawn(page: Page, center: MapPoint): Promise<void> {
  const seen = await look(page, [ROTATE, RESIZE]);
  const rotates = seen.clusters[0] as Cluster[];
  const resizes = seen.clusters[1] as Cluster[];
  expect(rotates).toHaveLength(1);
  expect(resizes).toHaveLength(4);
  const rotate = (rotates[0] as Cluster).center;
  expect(await cursorAt(page, rotate)).toBe('grab');
  expect(await cursorAt(page, along(rotate, away(rotate, center), HALF + 5))).not.toBe('grab');
  for (const { center: handle } of resizes) {
    expect(await cursorAt(page, handle)).toMatch(/-resize$/);
    expect(await cursorAt(page, along(handle, away(handle, center), HALF + 5))).not.toMatch(
      /-resize$/,
    );
  }

  // The frame, down, left and right of the middle of the feature (away from the rotate handle):
  // a press just inside its line moves, one just outside does not
  const directions: MapPoint[] = [
    [0, 1],
    [-1, 0.2],
    [1, 0.2],
  ];
  const walked = await look(
    page,
    [],
    directions.map((direction) => ({ from: center, direction, color: FRAME })),
  );
  let tested = 0;
  for (let i = 0; i < directions.length; i++) {
    const d = walked.walks[i];
    if (d === null || d === undefined) continue;
    const onFrame = along(center, directions[i] as MapPoint, d);
    if (resizes.some((r) => distanceOf(r.center, onFrame) < 3 * HALF)) continue;
    expect(await cursorAt(page, along(center, directions[i] as MapPoint, d - 3))).toBe('move');
    expect(await cursorAt(page, along(center, directions[i] as MapPoint, d + 6))).not.toBe('move');
    tested++;
  }
  expect(tested).toBeGreaterThan(0);
}

/**
 * The margin of the frame and the distance of the rotate handle as drawn, untilted: from the
 * vertex handle at the north-east corner of the square to the resize handle beside it, and from the
 * middle of the two vertex handles of the top to the rotate handle, less the margin (the handles
 * are drawn alike, so they are measured against one another)
 */
async function drawnMargins(
  page: Page,
): Promise<{ east: number; north: number; distance: number }> {
  const seen = await look(page, [VERTEX, RESIZE, ROTATE]);
  const vertices = (seen.clusters[0] as Cluster[]).map((c) => c.center);
  const resizes = (seen.clusters[1] as Cluster[]).map((c) => c.center);
  const rotates = seen.clusters[2] as Cluster[];
  expect(vertices).toHaveLength(4);
  expect(resizes).toHaveLength(4);
  expect(rotates).toHaveLength(1);
  const rotate = (rotates[0] as Cluster).center;
  const ne = vertices.reduce((a, b) => (a[0] - a[1] > b[0] - b[1] ? a : b));
  const nw = vertices.reduce((a, b) => (-a[0] - a[1] > -b[0] - b[1] ? a : b));
  const handle = resizes.reduce((a, b) => (distanceOf(a, ne) < distanceOf(b, ne) ? a : b));
  return {
    east: handle[0] - ne[0],
    north: ne[1] - handle[1],
    distance: (ne[1] + nw[1]) / 2 - MARGIN - rotate[1],
  };
}

/**
 * The frame of a point is grabbed inside the line drawn around its marker, and not outside it
 */
async function expectPointFrameGrabbedAsDrawn(page: Page): Promise<void> {
  const seen = await look(page, [MARKER, FRAME]);
  const markers = seen.clusters[0] as Cluster[];
  const frames = seen.clusters[1] as Cluster[];
  expect(markers).toHaveLength(1);
  expect(frames).toHaveLength(1);
  const marker = (markers[0] as Cluster).center;
  // The frame stands around the marker, a square of the screen: 6 px of the marker and the
  // margin on each side
  const frame = (frames[0] as Cluster).box;
  expect(Math.abs((frame[0] + frame[2]) / 2 - marker[0])).toBeLessThan(1);
  expect(Math.abs((frame[1] + frame[3]) / 2 - marker[1])).toBeLessThan(1);
  expect(Math.abs((frame[2] - frame[0]) / 2 - (6 + MARGIN))).toBeLessThan(2);
  const directions: MapPoint[] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const walked = await look(
    page,
    [],
    directions.map((direction) => ({ from: marker, direction, color: FRAME })),
  );
  for (let i = 0; i < directions.length; i++) {
    const d = walked.walks[i] as number;
    expect(d).not.toBeNull();
    expect(await cursorAt(page, along(marker, directions[i] as MapPoint, d - 2))).toBe('move');
    expect(await cursorAt(page, along(marker, directions[i] as MapPoint, d + 5))).not.toBe('move');
  }
}

describe.each(KINDS)('the selection UI laid on the map over a Store of %s', (kind) => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(false);
  }, browserTimeout(60_000));

  afterAll(async () => {
    await page?.close();
  });

  const measured: Array<{ name: string; view: Omit<View, 'name'> }> = [
    {
      name: 'on a flat Web Mercator view',
      view: { center: CENTER, zoom: 14, size: 0.004 },
    },
    {
      // A frame a few degrees across, around the center of the view: farther out the curve of
      // the sphere shortens it
      name: 'on the globe',
      view: { center: [139.7, 30] as [number, number], zoom: 2.6, globe: true, size: 2 },
    },
    {
      // The scale of Web Mercator at the latitude of the frame and the scale of the globe at the
      // center of the view, mixed by the transition
      name: 'in the middle of the transition from the globe to Web Mercator',
      view: { center: [139.7, 35.68] as [number, number], zoom: 11.5, globe: true, size: 0.02 },
    },
  ];
  for (const { name, view } of measured) {
    it(`stands the frame the margin and the rotate handle the distance out, in pixels, untilted ${name}`, {
      timeout: SCENES_TIMEOUT,
    }, async () => {
      await openView(page, polygonScene(kind, view, measuredStyle), view);
      await select(page, ['p']);
      const drawn = await drawnMargins(page);
      expect(Math.abs(drawn.east - MARGIN)).toBeLessThan(1);
      expect(Math.abs(drawn.north - MARGIN)).toBeLessThan(1);
      expect(Math.abs(drawn.distance - DISTANCE)).toBeLessThan(1);
    });
  }

  it('grabs the handles and the frame where they are drawn on a flat Web Mercator view', {
    timeout: SCENES_TIMEOUT,
  }, async () => {
    const view = { center: CENTER, zoom: 14, size: 0.004 };
    await openView(page, polygonScene(kind, view), view);
    await select(page, ['p']);
    await expectGrabbedAsDrawn(page, await pointOf(page, CENTER));
  });

  for (const view of VIEWS) {
    it(`grabs the handles and the frame where they are drawn ${view.name}`, {
      timeout: SCENES_TIMEOUT,
    }, async () => {
      await openView(page, polygonScene(kind, view), view);
      await select(page, ['p']);
      await expectGrabbedAsDrawn(page, await pointOf(page, view.center));
    });
  }

  for (const view of [
    { name: 'on a flat Web Mercator view', center: CENTER, zoom: 14 },
    VIEWS[0] as View,
  ]) {
    it(`grabs the frame of a point where it is drawn around its marker ${view.name}`, {
      timeout: SCENES_TIMEOUT,
    }, async () => {
      await openView(page, pointScene(kind, view.center), view);
      await select(page, ['p']);
      await expectPointFrameGrabbedAsDrawn(page);
    });
  }

  it('moves the selection along the screen with the arrow keys on a turned map', {
    timeout: SCENES_TIMEOUT,
  }, async () => {
    const view = { center: CENTER, zoom: 14, bearing: 30 };
    await openView(page, pointScene(kind, CENTER), view);
    await select(page, ['p']);
    const before = await pointOf(page, CENTER);
    // A click on the point gives the canvas the focus of the keys
    await cursorAt(page, before);
    await page.mouse.down();
    await page.mouse.up();
    await settle(page);
    const positionOf = async (): Promise<MapPoint> => {
      const position = await page.evaluate(() => {
        const draw = (window as unknown as { draw: import('../index.js').Draw }).draw;
        const feature = draw.features.get('p');
        if (!feature) throw new Error('the point is gone');
        return (feature.geometry as unknown as { coordinates: [number, number] }).coordinates;
      });
      return pointOf(page, position);
    };
    const start = await positionOf();
    await page.keyboard.press('Shift+ArrowUp');
    await settle(page);
    const up = await positionOf();
    expect(up[0] - start[0]).toBeCloseTo(0, 1);
    expect(up[1] - start[1]).toBeCloseTo(-10, 1);
    await page.keyboard.press('Shift+ArrowRight');
    await settle(page);
    const right = await positionOf();
    expect(right[0] - up[0]).toBeCloseTo(10, 1);
    expect(right[1] - up[1]).toBeCloseTo(0, 1);
  });
});

describe.each(KINDS)('the selection UI laid over terrain over a Store of %s', (kind) => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(true);
  }, browserTimeout(60_000));

  afterAll(async () => {
    await page?.close();
  });

  it(`grabs the handles and the frame where they are drawn ${TERRAIN_VIEW.name}`, {
    timeout: SCENES_TIMEOUT,
  }, async () => {
    await openView(page, polygonScene(kind, TERRAIN_VIEW), TERRAIN_VIEW);
    await select(page, ['p']);
    await expectGrabbedAsDrawn(page, await pointOf(page, TERRAIN_VIEW.center));
  });

  it(`grabs the frame of a point where it is drawn around its marker ${TERRAIN_VIEW.name}`, {
    timeout: SCENES_TIMEOUT,
  }, async () => {
    await openView(page, pointScene(kind, TERRAIN_VIEW.center), TERRAIN_VIEW);
    await select(page, ['p']);
    await expectPointFrameGrabbedAsDrawn(page);
  });
});
