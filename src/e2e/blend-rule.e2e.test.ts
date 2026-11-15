// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the one rule every drawing composites by: a color that is not premultiplied,
 * its opacity in its alpha alone, blended over what is drawn
 *
 * Over a white map, half of a blue (`#0040ff`) at an opacity of one half is (128, 160, 255),
 * whoever draws it: the lines, the fills and the markers of the built-in types over a Store of
 * objects and over a Store of rows (solid and dashed lines), and the shared renderers a renderer of
 * a custom type draws with (`RenderContext.line`, `fill`, `point`). The opacity is given by the
 * style (the opacity of the stroke, the fill or the marker, or of the custom drawing) or by the
 * layer, with an opaque style.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import { at, idle, KINDS, load, mapPointOf, openScenePage } from './drag-scene.js';
import { type Bundle, bundlePage, type E2EWrites, launchBrowser } from './harness.js';

const ZOOM = 14;
const BLUE = '#0040ff';
/** Half of the blue over white */
const EXPECTED = [128, 160, 255];

/** The places of the features, with what draws them (degrees from the center) */
const PLACES = {
  line: [-0.006, 0.003],
  dashed: [0, 0.003],
  fill: [0.006, 0.003],
  point: [-0.006, -0.003],
  customLine: [0, -0.003],
  customFill: [0.006, -0.003],
  customPoint: [0.006, -0.0045],
} as const;

type Place = keyof typeof PLACES;

/** The features: the built-in types, and a custom type that draws with the shared renderers */
function features(opacity: number) {
  const line = (dx: number, dy: number) => [at(dx - 0.002, dy), at(dx + 0.002, dy)];
  const square = (dx: number, dy: number, r: number) => [
    [
      at(dx - r, dy - r),
      at(dx + r, dy - r),
      at(dx + r, dy + r),
      at(dx - r, dy + r),
      at(dx - r, dy - r),
    ],
  ];
  return [
    {
      id: 'line',
      type: 'LineString',
      geometry: { type: 'LineString', coordinates: line(...PLACES.line) },
      style: { strokeColor: BLUE, strokeOpacity: opacity, strokeWidth: 12 },
    },
    {
      id: 'dashed',
      type: 'LineString',
      geometry: { type: 'LineString', coordinates: line(...PLACES.dashed) },
      style: { strokeColor: BLUE, strokeOpacity: opacity, strokeWidth: 12, lineStyle: 'dashed' },
    },
    {
      id: 'fill',
      type: 'Polygon',
      geometry: { type: 'Polygon', coordinates: square(...PLACES.fill, 0.001) },
      style: { fillColor: BLUE, fillOpacity: opacity, strokeOpacity: 0 },
    },
    {
      id: 'point',
      type: 'Point',
      geometry: { type: 'Point', coordinates: at(...PLACES.point) },
      style: { pointColor: BLUE, pointOpacity: opacity, pointRadius: 10, pointStrokeWidth: 0 },
    },
    {
      id: 'custom',
      type: 'E2EShared',
      geometry: { type: 'Point', coordinates: at(...PLACES.customLine) },
      properties: { opacity },
    },
  ];
}

/** Adds the custom type, which draws a line, a fill and a marker with the shared renderers */
async function addCustomType(page: Page): Promise<void> {
  await page.evaluate(
    ({ places, blue }) => {
      const w = window as unknown as { draw: import('../index.js').Draw };
      const center = [139.7, 35.68];
      const p = (d: readonly number[]) => [
        center[0] + (d[0] as number),
        center[1] + (d[1] as number),
      ];
      w.draw.extensions.featureTypes.add({
        type: 'E2EShared',
        geometry: 'Point',
        render(feature, ctx) {
          // The opacity of the style, and of the layer as a renderer of a custom type applies it
          const opacity = (feature.properties as { opacity: number }).opacity * ctx.opacity;
          const [x, y] = places.customLine;
          ctx.line.draw([p([x - 0.002, y]), p([x + 0.002, y])], {
            width: 12,
            color: blue,
            opacity,
            lineStyle: 'solid',
          });
          const [fx, fy] = places.customFill;
          const r = 0.001;
          ctx.fill.draw(
            [
              [
                p([fx - r, fy - r]),
                p([fx + r, fy - r]),
                p([fx + r, fy + r]),
                p([fx - r, fy + r]),
                p([fx - r, fy - r]),
              ],
            ],
            { color: blue, opacity },
          );
          ctx.point.draw(p(places.customPoint), {
            shape: 'circle',
            sizePixels: 20,
            fillColor: blue,
            fillOpacity: opacity,
            strokeColor: blue,
            strokeWidth: 0,
            strokeOpacity: opacity,
          });
        },
      });
    },
    { places: PLACES, blue: BLUE },
  );
}

/** Puts a white background under the drawing */
async function whiteBackground(page: Page): Promise<void> {
  await page.evaluate(() => {
    const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
    if (map.getLayer('e2e-white')) return;
    const first = map.getStyle().layers[0]?.id;
    map.addLayer(
      { id: 'e2e-white', type: 'background', paint: { 'background-color': '#ffffff' } },
      first,
    );
  });
}

/** The color drawn at each place, once everything is built */
async function colors(page: Page): Promise<Record<Place, number[]>> {
  const points = await Promise.all(
    (Object.keys(PLACES) as Place[]).map(async (place) => {
      const [x, y] = PLACES[place];
      return [place, await mapPointOf(page, at(x, y))] as const;
    }),
  );
  await idle(page);
  return page.evaluate(
    async (points) => {
      const map = (window as unknown as { map: import('maplibre-gl').Map }).map;
      return new Promise<Record<string, number[]>>((resolve) => {
        map.once('render', () => {
          const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
          const ratio = gl.drawingBufferWidth / map.getCanvas().clientWidth;
          const out: Record<string, number[]> = {};
          for (const [place, [x, y]] of points) {
            const pixel = new Uint8Array(4);
            gl.readPixels(
              Math.round(x * ratio),
              gl.drawingBufferHeight - 1 - Math.round(y * ratio),
              1,
              1,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              pixel,
            );
            out[place] = [pixel[0] as number, pixel[1] as number, pixel[2] as number];
          }
          resolve(out);
        });
        map.triggerRepaint();
      });
    },
    points as unknown as Array<[string, [number, number]]>,
  ) as Promise<Record<Place, number[]>>;
}

/** Holds every place to half of the blue over white */
function expectHalfBlue(drawn: Record<Place, number[]>, what: string): void {
  for (const [place, color] of Object.entries(drawn)) {
    color.forEach((v, k) => {
      expect
        .soft(Math.abs(v - (EXPECTED[k] as number)), `${place} ${what}: ${color}`)
        .toBeLessThanOrEqual(3);
    });
  }
}

describe.each(KINDS)('the colors composited over a Store of %s', (kind) => {
  let browser: Browser;
  let bundle: Bundle;
  let page: Page;

  beforeAll(async () => {
    [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
    page = await openScenePage(browser, bundle, ZOOM);
  }, browserTimeout(90_000));

  afterAll(async () => {
    await browser?.close();
  });

  it('are half of the color at an opacity of one half, given by the style', {
    timeout: browserTimeout(60_000),
  }, async () => {
    await whiteBackground(page);
    await load(page, { kind, features: [] }, ZOOM);
    await addCustomType(page);
    await page.evaluate((fs) => {
      const w = window as unknown as { draw: import('../index.js').Draw };
      (window as unknown as E2EWrites).e2e
        .writesOf(w.draw)
        .features.createMany(fs.map((f) => ({ ...f, layerId: 'L' })) as never);
    }, features(0.5));
    expectHalfBlue(await colors(page), 'by the style');
  });

  it('are half of the color at an opacity of one half, given by the layer', {
    timeout: browserTimeout(60_000),
  }, async () => {
    await whiteBackground(page);
    await load(page, { kind, features: [] }, ZOOM);
    await addCustomType(page);
    await page.evaluate((fs) => {
      const w = window as unknown as { draw: import('../index.js').Draw };
      (window as unknown as E2EWrites).e2e.writesOf(w.draw).layers.update('L', { opacity: 0.5 });
      (window as unknown as E2EWrites).e2e
        .writesOf(w.draw)
        .features.createMany(fs.map((f) => ({ ...f, layerId: 'L' })) as never);
    }, features(1));
    expectHalfBlue(await colors(page), 'by the layer');
  });
});
