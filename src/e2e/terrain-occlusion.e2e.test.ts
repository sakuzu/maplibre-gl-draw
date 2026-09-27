// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests: the terrain hides what is behind a mountain, whatever path draws it
 *
 * Solid lines and polygons are painted on the ground by the analytic drape, and dashed lines
 * and polygons with a dashed outline by the vertex displacement path, after the drape. Both
 * must be hidden by the terrain in front of them. The test terrain (`dem-fixture.ts`) has a
 * peak far higher than the camera, and the camera looks at it from the south, so its north
 * side is out of sight.
 *
 * What is hidden is not taken from the engine: every sample point is checked against the
 * ground maplibre reports (`map.queryTerrainElevation`) along the line of sight from the
 * camera, and the pixels around where it is projected are read from the canvas.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatasetFeatureInput, FeatureInput } from '../index.js';
import { browserTimeout } from '../test-utils.js';
import {
  type Bundle,
  bundlePage,
  type Camera,
  launchBrowser,
  openMapPage,
  settle,
} from './harness.js';

/** A low camera south of the peak, looking north at it */
const CAMERA: Camera = { center: [138.728, 35.33], zoom: 12.6, pitch: 70, bearing: 10 };

/** The vertical exaggeration of the terrain */
const EXAGGERATION = 1.5;

/** Meters the ground must rise above (or stay below) the line of sight for a sure verdict */
const SIGHT_MARGIN_M = 60;

/** Pixels a hidden sample must keep from every visible one, so their pixels do not mix */
const SEPARATION_PX = 10;

/** The colors the features are drawn in (pure, so that the terrain never looks like them) */
const BLUE = '#0000FF';
const RED = '#FF0000';

type Rgb = readonly [number, number, number];

/** A position in `[lng, lat]` */
type LngLat = [number, number];

/** The sample points of a feature, each with its verdict and where it is drawn */
interface Sample {
  x: number;
  y: number;
  hidden: boolean;
  visible: boolean;
}

interface TestWindow {
  map: import('maplibre-gl').Map;
  draw: import('../index.js').MapLibreGLDraw;
  e2e: {
    terrain: {
      addTestTerrain(map: import('maplibre-gl').Map, exaggeration: number): Promise<void>;
    };
  };
  pixels?: { data: Uint8Array; width: number; height: number; ratio: number };
}

let browser: Browser;
let bundle: Bundle;
let page: Page;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
  page = await openMapPage(browser, bundle, CAMERA);
  await page.evaluate(async (exaggeration) => {
    const w = window as unknown as TestWindow;
    // A gray ground, unlike any feature color, below the layers of the draw instance
    w.map.addLayer(
      { id: 'ground', type: 'background', paint: { 'background-color': '#c8c8c8' } },
      w.map.getLayersOrder()[0],
    );
    await w.e2e.terrain.addTestTerrain(w.map, exaggeration);
  }, EXAGGERATION);
  await settle(page);
}, browserTimeout(90_000));

afterAll(async () => {
  await browser?.close();
});

/** Removes every feature and dataset of the previous test */
async function clear(): Promise<void> {
  await page.evaluate(() => {
    const { draw } = window as unknown as TestWindow;
    draw.deleteAllFeatures();
    for (const dataset of draw.getDatasets()) {
      draw.removeDataset(dataset.id);
    }
    // A solid line on the plain keeps the drape in use: the dashed features are drawn after
    // it, in the same frame
    draw.addFeature({
      type: 'LineString',
      coordinates: [
        [138.74, 35.333],
        [138.75, 35.335],
      ],
      properties: { createdZoom: 13 },
      style: { strokeColor: '#00AA00', strokeWidth: 3 },
    });
  });
}

/**
 * Draws until the drape is in use and every tile is in, then keeps the pixels of the canvas
 * (read in the render event, before the frame is shown)
 */
async function capture(): Promise<void> {
  const drape = await page.evaluate(async () => {
    const w = window as unknown as TestWindow;
    const { map, draw } = w;
    const read = (): Promise<void> =>
      new Promise((resolve) => {
        map.once('render', () => {
          const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
          const width = gl.drawingBufferWidth;
          const height = gl.drawingBufferHeight;
          const data = new Uint8Array(width * height * 4);
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
          w.pixels = { data, width, height, ratio: width / map.getCanvas().clientWidth };
          resolve();
        });
        map.triggerRepaint();
      });
    // Enough frames for the drape to settle and for the datasets to be handed over to it
    for (let i = 0; i < 12; i++) await read();
    for (let i = 0; i < 100 && !(map.loaded() && map.areTilesLoaded()); i++) await read();
    await read();
    return draw.getTerrainDiagnostics().drape;
  });
  expect(drape.used, `the drape is not in use (${drape.reason})`).toBe(true);
}

/**
 * Samples points along a path, with the verdict of the line of sight from the camera and the
 * point of the canvas they are drawn at
 *
 * @param path The path in `[lng, lat]`
 * @param step The distance between samples in degrees
 */
async function samplePath(path: number[][], step = 0.0002): Promise<Sample[]> {
  return page.evaluate(
    ({ path, step, margin }) => {
      const { map } = window as unknown as TestWindow;
      const transform = (
        map as unknown as {
          _camera: {
            transform: {
              getCameraLngLat(): { lng: number; lat: number };
              getCameraAltitude(): number;
            };
          };
        }
      )._camera.transform;
      const eye = transform.getCameraLngLat();
      const eyeAltitude = transform.getCameraAltitude();
      const out: Sample[] = [];
      for (let i = 0; i + 1 < path.length; i++) {
        const [a, b] = [path[i], path[i + 1]];
        const count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
        for (let k = 0; k < count; k++) {
          const lng = a[0] + ((b[0] - a[0]) * k) / count;
          const lat = a[1] + ((b[1] - a[1]) * k) / count;
          const ground = map.queryTerrainElevation([lng, lat]);
          if (ground === null) continue;
          // The highest the ground rises above the line of sight between the camera and the
          // point (the last few percent are the slope the point sits on)
          let rise = -Infinity;
          for (let s = 1; s < 400; s++) {
            const t = s / 400;
            if (t > 0.98) break;
            const g = map.queryTerrainElevation([
              eye.lng + (lng - eye.lng) * t,
              eye.lat + (lat - eye.lat) * t,
            ]);
            if (g === null) continue;
            rise = Math.max(rise, g - (eyeAltitude + (ground - eyeAltitude) * t));
          }
          const p = map.project([lng, lat]);
          const canvas = map.getCanvas();
          if (p.x < 4 || p.y < 4 || p.x > canvas.clientWidth - 4 || p.y > canvas.clientHeight - 4) {
            continue;
          }
          out.push({ x: p.x, y: p.y, hidden: rise > margin, visible: rise < -margin });
        }
      }
      return out;
    },
    { path, step, margin: SIGHT_MARGIN_M },
  );
}

/** Samples a polygon on a grid of its bounding box (it must be a rectangle) */
async function sampleArea(ring: number[][], step = 0.0006): Promise<Sample[]> {
  const lngs = ring.map((c) => c[0]);
  const lats = ring.map((c) => c[1]);
  const [west, east] = [Math.min(...lngs), Math.max(...lngs)];
  const [south, north] = [Math.min(...lats), Math.max(...lats)];
  const rows: Sample[] = [];
  // Rows inset from the outline, so that only the fill is read
  for (let lat = south + step; lat < north - step / 2; lat += step) {
    rows.push(
      ...(await samplePath(
        [
          [west + step, lat],
          [east - step, lat],
        ],
        step,
      )),
    );
  }
  return rows;
}

/** Keeps the hidden samples that are well away from every visible one on the screen */
function separated(samples: Sample[], others: Sample[] = samples): Sample[] {
  return samples.filter(
    (s) =>
      s.hidden && others.every((o) => o.hidden || Math.hypot(o.x - s.x, o.y - s.y) > SEPARATION_PX),
  );
}

/** Whether a color is drawn within two CSS pixels of each sample */
async function colorNear(samples: Sample[], rgb: Rgb): Promise<boolean[]> {
  return page.evaluate(
    ({ samples, rgb }) => {
      const pixels = (window as unknown as TestWindow).pixels;
      if (!pixels) throw new Error('nothing was captured');
      const { data, width, height, ratio } = pixels;
      const like = (i: number): boolean => {
        // Close to the pure color: its own channel high, the others far below it
        const own = rgb.map((c) => c > 128);
        let score = 0;
        for (let c = 0; c < 3; c++) {
          const v = data[i + c];
          score += own[c] ? (v > 150 ? 1 : 0) : v < 90 ? 1 : 0;
        }
        return score === 3;
      };
      return samples.map((s) => {
        const cx = Math.round(s.x * ratio);
        const cy = Math.round(s.y * ratio);
        const reach = Math.ceil(2 * ratio);
        for (let dy = -reach; dy <= reach; dy++) {
          for (let dx = -reach; dx <= reach; dx++) {
            const x = cx + dx;
            const y = height - 1 - (cy + dy);
            if (x < 0 || y < 0 || x >= width || y >= height) continue;
            if (like((y * width + x) * 4)) return true;
          }
        }
        return false;
      });
    },
    { samples, rgb },
  );
}

function rgbOf(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function share(flags: boolean[]): number {
  return flags.filter(Boolean).length / Math.max(flags.length, 1);
}

/** A line from the plain in front of the peak over its east shoulder to the far side */
const LINE_OVER_THE_PEAK: LngLat[] = [
  [138.722, 35.342],
  [138.732, 35.358],
  [138.745, 35.38],
];

/** A rectangle on the far side of the peak */
const BEHIND: LngLat[] = [
  [138.722, 35.372],
  [138.742, 35.372],
  [138.742, 35.385],
  [138.722, 35.385],
  [138.722, 35.372],
];

/** A rectangle on the near slope */
const IN_FRONT: LngLat[] = [
  [138.704, 35.334],
  [138.714, 35.334],
  [138.714, 35.341],
  [138.704, 35.341],
  [138.704, 35.334],
];

/** The style of a line or an outline in one of the two paths */
type Stroke = 'solid' | 'dashed';

/** Adds a Store feature */
async function addFeature(feature: FeatureInput): Promise<string> {
  const id = await page.evaluate(
    (f) => (window as unknown as TestWindow).draw.addFeature(f),
    feature,
  );
  if (id === null) throw new Error('the feature was not added');
  return id;
}

function lineOf(path: LngLat[], color: string, stroke: Stroke): FeatureInput {
  return {
    type: 'LineString',
    coordinates: path,
    properties: { createdZoom: 13 },
    style: { strokeColor: color, strokeWidth: 4, lineStyle: stroke },
  };
}

function polygonOf(ring: LngLat[], color: string, stroke: Stroke): FeatureInput {
  return {
    type: 'Polygon',
    coordinates: [ring],
    properties: { createdZoom: 13 },
    style: {
      fillColor: color,
      fillOpacity: 1,
      strokeColor: color,
      strokeWidth: 3,
      strokeOpacity: 1,
      lineStyle: stroke,
    },
  };
}

/** Checks that the hidden samples show no trace of the color and the visible ones do */
async function expectHiddenBehindThePeak(
  hidden: Sample[],
  visible: Sample[],
  hex: string,
  seenShare: number,
): Promise<void> {
  expect(hidden.length, 'hidden samples on the screen').toBeGreaterThan(10);
  expect(visible.length, 'visible samples on the screen').toBeGreaterThan(10);
  expect(share(await colorNear(hidden, rgbOf(hex))), 'drawn where it is hidden').toBe(0);
  expect(share(await colorNear(visible, rgbOf(hex))), 'drawn where it is seen').toBeGreaterThan(
    seenShare,
  );
}

describe('the terrain hides what lies behind the peak', () => {
  it.each(['solid', 'dashed'] as const)('a %s line over the peak', async (stroke) => {
    await clear();
    await addFeature(lineOf(LINE_OVER_THE_PEAK, BLUE, stroke));
    await capture();
    const samples = await samplePath(LINE_OVER_THE_PEAK);
    // The gaps of the dashes leave some visible samples bare
    await expectHiddenBehindThePeak(
      separated(samples),
      samples.filter((s) => s.visible),
      BLUE,
      0.6,
    );
  });

  it.each(['solid', 'dashed'] as const)(
    'polygons with a %s outline behind and in front of the peak',
    async (stroke) => {
      await clear();
      await addFeature(polygonOf(BEHIND, RED, stroke));
      await addFeature(polygonOf(IN_FRONT, RED, stroke));
      await capture();
      const behind = await sampleArea(BEHIND);
      const front = await sampleArea(IN_FRONT);
      expect(behind.every((s) => s.hidden)).toBe(true);
      await expectHiddenBehindThePeak(
        separated(behind, front),
        front.filter((s) => s.visible),
        RED,
        0.95,
      );
    },
  );

  it.each(['solid', 'dashed'] as const)(
    'polygons with a %s outline of a dataset',
    async (stroke) => {
      await clear();
      await page.evaluate(
        ({ features }) => {
          const { draw } = window as unknown as TestWindow;
          draw.addDataset({ id: 'dataset', features });
        },
        {
          features: [BEHIND, IN_FRONT].map(
            (ring, i): DatasetFeatureInput => ({
              id: `area-${i}`,
              ...(polygonOf(ring, RED, stroke) as Pick<
                DatasetFeatureInput,
                'type' | 'coordinates' | 'properties' | 'style'
              >),
            }),
          ),
        },
      );
      await capture();
      const behind = await sampleArea(BEHIND);
      const front = await sampleArea(IN_FRONT);
      await expectHiddenBehindThePeak(
        separated(behind, front),
        front.filter((s) => s.visible),
        RED,
        0.95,
      );
    },
  );
});

describe('the symbols and the selection stay in front of the terrain', () => {
  /** The color at the point a coordinate is drawn at */
  async function colorAt(lngLat: number[]): Promise<Rgb> {
    return page.evaluate((coord) => {
      const { map, pixels } = window as unknown as TestWindow;
      if (!pixels) throw new Error('nothing was captured');
      const p = map.project(coord as [number, number]);
      const x = Math.round(p.x * pixels.ratio);
      const y = pixels.height - 1 - Math.round(p.y * pixels.ratio);
      const i = (y * pixels.width + x) * 4;
      return [pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]] as const;
    }, lngLat);
  }

  const FRONT_POINT: LngLat = [138.707, 35.3375];
  const HIDDEN_POINT: LngLat = [138.732, 35.3785];

  it('a point in front is drawn in full and a hidden one as a ghost', async () => {
    await clear();
    for (const [coord, shape] of [
      [FRONT_POINT, 'circle'],
      [HIDDEN_POINT, 'circle'],
      [[FRONT_POINT[0] + 0.004, FRONT_POINT[1]], 'star'],
      [[HIDDEN_POINT[0] + 0.004, HIDDEN_POINT[1]], 'star'],
    ] as const) {
      await addFeature({
        type: 'Point',
        coordinates: coord,
        style: { pointColor: RED, pointRadius: 9, pointShape: shape },
      } as FeatureInput);
    }
    await capture();
    const [front] = await samplePath([FRONT_POINT, FRONT_POINT]);
    const [hidden] = await samplePath([HIDDEN_POINT, HIDDEN_POINT]);
    expect(front.visible && hidden.hidden).toBe(true);
    for (const dx of [0, 0.004]) {
      const [fr, fg] = await colorAt([FRONT_POINT[0] + dx, FRONT_POINT[1]]);
      expect(fr).toBeGreaterThan(230);
      expect(fg).toBeLessThan(40);
      // The ghost: red over the gray ground, faint but there
      const [hr, hg] = await colorAt([HIDDEN_POINT[0] + dx, HIDDEN_POINT[1]]);
      expect(hr - hg).toBeGreaterThan(40);
      expect(hg).toBeGreaterThan(90);
    }
  });

  it('the handles of a selected line are drawn at a hidden vertex too', async () => {
    await clear();
    const id = await addFeature(lineOf(LINE_OVER_THE_PEAK, BLUE, 'dashed'));
    const far = LINE_OVER_THE_PEAK[LINE_OVER_THE_PEAK.length - 1];
    const [sample] = await samplePath([far, far]);
    expect(sample.hidden).toBe(true);
    await capture();
    const ground = await colorAt(far);
    await page.evaluate((featureId) => {
      (window as unknown as TestWindow).draw.select(featureId);
    }, id);
    await capture();
    const selected = await colorAt(far);
    expect(Math.max(...selected.map((c, i) => Math.abs(c - ground[i])))).toBeGreaterThan(40);
  });
});
