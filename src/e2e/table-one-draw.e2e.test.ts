// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the drawing of the layers held as rows in one draw per chunk
 *
 * The same rows are drawn on the real maplibre and WebGL of the browser in one draw per chunk
 * (the default on a flat map) and by kind (`tableDiagnosticsOf(draw).setDrawingByKind(true)`,
 * the renderers of points, lines and polygons), and the pictures are compared. Each branch of the program is
 * compared on its own scene: the points of every shape, the segments of the lines (fixed and
 * following the zoom, sharp corners), the outlines of the polygons (thick and thin, a sharp wedge,
 * a half transparent light outline, a hole) and their fills (a half transparent polygon of parts
 * that touch). The dashed and dotted lines and the dashed outlines are cut on the CPU by kind and
 * in the fragments in one draw, so they are compared with a tolerance of their own.
 *
 * A row is also compared with the same feature drawn by the Store (what is drawn between the rows
 * while a row is edited), so the picture does not jump when a row goes from one to the other.
 *
 * Polygons with dashed outlines that follow each other are drawn in their order in one draw (the
 * fill and the outline of one, then of the next), where the drawing at once draws every fill of
 * a run before its outlines: the picture in one draw is compared with the polygons drawn one
 * layer each by the Store, which draws them in their order.
 *
 * The differences allowed are first estimates, to be set from the measurements of these tests.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import { type Bundle, bundlePage, type Camera, launchBrowser, openMapPage } from './harness.js';

const CENTER: [number, number] = [139.7, 35.68];
const CAMERA: Camera = { center: CENTER, zoom: 14 };

/**
 * The differences allowed between two pictures: the share of the pixels drawn whose channels
 * differ by more than `level`
 */
const TOLERANCE = { level: 2, share: 0.001 };
/**
 * The differences allowed for the dashes cut on the CPU and in the fragments. How a line is cut
 * into quads alone moves the coverage of its edges by 3 to 8 levels on the software renderer (the
 * same dotted line drawn in one draw as one segment and as seven segments on one straight line:
 * about 12% of the pixels drawn differ by more than 2 levels), and the CPU draws every dash as
 * quads of its own. Those levels are not counted, and the share of the pixels that differ by more
 * is held to 1% rather than 3%
 */
const DASH_TOLERANCE = { level: 8, share: 0.01 };

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

/** A feature of a scene */
interface SceneFeature {
  id: string;
  type: string;
  geometry: { type: string; coordinates: unknown };
  style?: Record<string, unknown>;
  properties?: Record<string, unknown>;
}

/** A position at an offset from the center, in degrees */
const at = (dx: number, dy: number): [number, number] => [CENTER[0] + dx, CENTER[1] + dy];

function point(id: string, x: number, y: number, style: Record<string, unknown>): SceneFeature {
  return { id, type: 'Point', geometry: { type: 'Point', coordinates: at(x, y) }, style };
}

function line(
  id: string,
  coords: Array<[number, number]>,
  style: Record<string, unknown>,
  properties?: Record<string, unknown>,
): SceneFeature {
  return {
    id,
    type: 'LineString',
    geometry: { type: 'LineString', coordinates: coords.map(([x, y]) => at(x, y)) },
    style,
    properties,
  };
}

function polygon(
  id: string,
  rings: Array<Array<[number, number]>>,
  style: Record<string, unknown>,
  properties?: Record<string, unknown>,
): SceneFeature {
  const closed = rings.map((ring) => [...ring, ring[0]].map(([x, y]) => at(x, y)));
  return {
    id,
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: closed },
    style,
    properties,
  };
}

/** A square ring of a side around a center */
const square = (x: number, y: number, side: number): Array<[number, number]> => [
  [x - side / 2, y - side / 2],
  [x + side / 2, y - side / 2],
  [x + side / 2, y + side / 2],
  [x - side / 2, y + side / 2],
];

/** A created zoom one below the camera: the widths that follow the zoom are twice as wide */
const CREATED = { 'maplibre-gl-draw:createdZoom': 13 };

/** The scenes of each branch of the program */
const SCENES: Record<string, SceneFeature[]> = {
  points: (['circle', 'square', 'triangle', 'star'] as const).flatMap((shape, i) => [
    point(`${shape}-a`, -0.009 + i * 0.006, 0.004, { pointShape: shape, pointRadius: 10 }),
    point(`${shape}-b`, -0.009 + i * 0.006, 0, {
      pointShape: shape,
      pointRadius: 7,
      pointColor: '#3366ff',
      strokeColor: '#ffffff',
      strokeWidth: 3,
      strokeOpacity: 0.5,
    }),
    point(`${shape}-c`, -0.009 + i * 0.006, -0.004, { pointShape: shape, pointRadius: 0.3 }),
  ]),
  lines: [
    // Sharp corners (the miter falls back to a bevel) on a fixed width, half transparent
    line(
      'zigzag',
      [
        [-0.01, 0.004],
        [-0.006, -0.002],
        [-0.005, 0.004],
        [0, -0.003],
        [0.002, 0.005],
      ],
      { strokeWidth: 8, strokeColor: '#e15759', strokeOpacity: 0.6 },
    ),
    // A width that follows the zoom from its created zoom
    line(
      'created',
      [
        [-0.01, -0.005],
        [0.008, -0.004],
        [0.009, 0.002],
      ],
      { strokeWidth: 3, strokeColor: '#4e79a7' },
      CREATED,
    ),
    // Thinner than a pixel
    line(
      'thin',
      [
        [-0.01, 0.006],
        [0.01, 0.007],
      ],
      { strokeWidth: 0.4 },
    ),
  ],
  outlines: [
    // A light outline at half its opacity on a dark fill (a factor on its alpha only)
    polygon('light', [square(-0.006, 0.002, 0.005)], {
      fillColor: '#202020',
      fillOpacity: 1,
      strokeColor: '#ffffff',
      strokeOpacity: 0.5,
      strokeWidth: 10,
    }),
    // A sharp wedge: the miter is only shortened
    polygon(
      'wedge',
      [
        [
          [0, -0.005],
          [0.009, -0.004],
          [0, -0.0035],
        ],
      ],
      { fillOpacity: 0.3, strokeWidth: 6, strokeColor: '#59a14f' },
    ),
    // A hole, a thin outline that follows the zoom
    polygon(
      'hole',
      [square(0.006, 0.003, 0.006), square(0.006, 0.003, 0.002).reverse()],
      { fillOpacity: 0.4, strokeWidth: 0.6 },
      CREATED,
    ),
  ],
  fills: [
    // Parts that touch, half transparent fill and outline
    {
      id: 'parts',
      type: 'MultiPolygon',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[...square(-0.003, 0, 0.006), square(-0.003, 0, 0.006)[0]].map(([x, y]) => at(x, y))],
          [[...square(0.003, 0, 0.006), square(0.003, 0, 0.006)[0]].map(([x, y]) => at(x, y))],
        ],
      },
      style: { fillColor: '#f28e2b', fillOpacity: 0.5, strokeWidth: 6, strokeOpacity: 0.5 },
    },
  ],
  dashes: [
    line(
      'dashed',
      [
        [-0.01, 0.005],
        [-0.002, 0.002],
        [0.008, 0.006],
      ],
      { lineStyle: 'dashed', strokeWidth: 4 },
    ),
    line(
      'dotted',
      [
        [-0.01, 0],
        [0.009, -0.001],
      ],
      { lineStyle: 'dotted', strokeWidth: 6, strokeColor: '#4e79a7' },
      CREATED,
    ),
    polygon('dashed-outline', [square(0, -0.004, 0.005)], {
      lineStyle: 'dashed',
      strokeWidth: 3,
      fillOpacity: 0.2,
    }),
  ],
};

/** Every kind interleaved, half transparent (the order shows in the colors) */
function interleaved(): SceneFeature[] {
  const out: SceneFeature[] = [];
  for (let i = 0; i < 120; i++) {
    const x = -0.01 + (i % 12) * 0.0018;
    const y = -0.006 + Math.floor(i / 12) * 0.0012;
    const style = { strokeOpacity: 0.7, fillOpacity: 0.5 };
    if (i % 3 === 0) out.push(point(`p${i}`, x, y, { ...style, pointRadius: 9 }));
    else if (i % 3 === 1) {
      out.push(
        line(
          `l${i}`,
          [
            [x - 0.002, y],
            [x + 0.002, y + 0.0008],
          ],
          { ...style, strokeWidth: 5 },
        ),
      );
    } else out.push(polygon(`g${i}`, [square(x, y, 0.0015)], { ...style, strokeWidth: 3 }));
  }
  return out;
}

/**
 * Draws a scene in a new instance over a Store of its own, and keeps the pixels of the frame
 * once everything is built under `key`
 *
 * @param form `rows`: the features held as rows of one layer, in one draw (or by kind with
 *   `byKind`); `store`: the features of the Store, each in the layer `layers` gives it
 * @returns The number of pixels drawn
 */
async function drawScene(
  page: Page,
  key: string,
  features: SceneFeature[],
  form: 'rows' | 'store',
  options: { byKind?: boolean; layers?: string[]; dims?: 'xyz' | 'xyzm' } = {},
): Promise<number> {
  return page.evaluate(
    async ({ key, features, form, byKind, layers, dims }) => {
      type Contract = import('../index.js').Store;
      const w = window as unknown as Record<string, unknown> & {
        map: import('maplibre-gl').Map;
        draw: import('../index.js').Draw;
        e2e: {
          createDraw: typeof import('../index.js').createDraw;
          tables: {
            createFeatureTables: typeof import('../kasane/index.js').createFeatureTables;
            createRowBlockBuilder: typeof import('../table/feature-row-blocks.js').createFeatureRowBlockBuilder;
          };
          internals: {
            MemoryContractStore: new () => Contract;
            tableDiagnosticsOf: typeof import('../api/impl/table-diagnostics.js').tableDiagnosticsOf;
          };
        };
      };
      const { map } = w;
      const store = new w.e2e.internals.MemoryContractStore();
      const layerIds = form === 'rows' ? ['rows'] : [...new Set(layers ?? ['rows'])];
      store.transact(() => {
        for (const id of layerIds) {
          store.createLayer({
            id,
            name: id,
            visible: true,
            locked: false,
            opacity: 1,
            items: [],
            styleRule: undefined,
            metadata: undefined,
          });
        }
        if (form === 'store') {
          features.forEach((f, i) => {
            store.createFeature({
              id: f.id,
              type: f.type,
              geometry: f.geometry,
              style: f.style ?? {},
              properties: f.properties ?? {},
              layerId: layers?.[i] ?? 'rows',
              groupId: undefined,
              visible: true,
              locked: false,
            } as never);
          });
        }
      }, 'remote');
      if (form === 'rows') {
        // The rows of a layer of z (and m): the same x and y, with a z (and an m) after them
        const lift = (value: unknown): unknown =>
          Array.isArray(value) && typeof value[0] === 'number'
            ? dims === 'xyzm'
              ? [value[0], value[1], 50, 1.7e12]
              : [value[0], value[1], 50]
            : Array.isArray(value)
              ? value.map(lift)
              : value;
        const { tables, writer } = w.e2e.tables.createFeatureTables(
          dims ? { dimensionsOf: () => dims } : undefined,
        );
        const builder = w.e2e.tables.createRowBlockBuilder(dims ? { dimensions: dims } : {});
        features.forEach((f, i) => {
          builder.addRow({
            id: f.id,
            type: f.type,
            geometry: dims
              ? { ...f.geometry, coordinates: lift(f.geometry.coordinates) }
              : f.geometry,
            order: `k${String(i).padStart(6, '0')}`,
            style: f.style ?? {},
            properties: f.properties ?? {},
            visible: true,
            locked: false,
          } as never);
        });
        writer.addRowBlocks('rows', builder.finish());
        Object.defineProperty(store, 'tables', { value: tables });
      }
      w.draw.destroy();
      w.draw = w.e2e.createDraw(map, { store, initDefaultLayer: false });
      if (byKind) w.e2e.internals.tableDiagnosticsOf(w.draw).setDrawingByKind(true);

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
      for (let i = 0; i < 200; i++) {
        if (!w.draw.hasPendingWork()) break;
        pixels = await read();
      }
      // Two more frames with everything built (a chunk is drawn the frame after it is written)
      await read();
      pixels = await read();
      w.captured ??= {};
      (w.captured as Record<string, Uint8Array>)[key] = pixels;
      let count = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) count++;
      return count;
    },
    {
      key,
      features,
      form,
      byKind: options.byKind ?? false,
      layers: options.layers ?? null,
      dims: options.dims ?? null,
    },
  );
}

/** The pixels of two pictures whose channels differ by more than `level` */
async function differing(page: Page, a: string, b: string, level: number): Promise<number> {
  return page.evaluate(
    ({ a, b, level }) => {
      const captured = (window as unknown as { captured: Record<string, Uint8Array> }).captured;
      const pa = captured[a];
      const pb = captured[b];
      let count = 0;
      for (let i = 0; i < pa.length; i += 4) {
        for (let k = 0; k < 4; k++) {
          if (Math.abs(pa[i + k] - pb[i + k]) > level) {
            count++;
            break;
          }
        }
      }
      return count;
    },
    { a, b, level },
  );
}

/** Draws a scene in one draw and another way, and checks the difference is within a tolerance */
async function compare(
  page: Page,
  name: string,
  features: SceneFeature[],
  other: { form: 'rows' | 'store'; byKind?: boolean; layers?: string[]; dims?: 'xyz' | 'xyzm' },
  tolerance: { level: number; share: number },
): Promise<void> {
  const drawn = await drawScene(page, `${name}-one-draw`, features, 'rows');
  await drawScene(page, `${name}-other`, features, other.form, other);
  const differs = await differing(page, `${name}-one-draw`, `${name}-other`, tolerance.level);
  console.log(`[one draw] ${name}: ${drawn} pixels drawn, ${differs} differ`);
  expect(drawn).toBeGreaterThan(0);
  expect(differs).toBeLessThanOrEqual(Math.floor(drawn * tolerance.share));
}

describe('the rows drawn in one draw against the rows drawn by kind', () => {
  let page: Page;

  beforeAll(async () => {
    page = await openMapPage(browser, bundle, CAMERA);
  }, browserTimeout(60_000));

  afterAll(async () => {
    await page?.close();
  });

  for (const branch of ['points', 'lines', 'outlines', 'fills'] as const) {
    it(`draws the ${branch} as the renderer of their kind does`, {
      timeout: browserTimeout(90_000),
    }, async () => {
      await compare(page, branch, SCENES[branch], { form: 'rows', byKind: true }, TOLERANCE);
    });
  }

  it('draws rows of every kind interleaved in their order, as by kind', {
    timeout: browserTimeout(90_000),
  }, async () => {
    await compare(page, 'interleaved', interleaved(), { form: 'rows', byKind: true }, TOLERANCE);
    // In a few draws
    const ranges = await page.evaluate(async () => {
      const w = window as unknown as {
        draw: import('../index.js').Draw;
        map: import('maplibre-gl').Map;
        e2e: {
          internals: {
            tableDiagnosticsOf: typeof import('../api/impl/table-diagnostics.js').tableDiagnosticsOf;
          };
        };
      };
      w.e2e.internals.tableDiagnosticsOf(w.draw).setDrawingByKind(false);
      const frame = () =>
        new Promise<void>((resolve) => {
          w.map.once('render', () => resolve());
          w.map.triggerRepaint();
        });
      // The chunks in one draw are packed, written, then drawn
      await frame();
      for (let i = 0; i < 200 && w.draw.hasPendingWork(); i++) await frame();
      await frame();
      await frame();
      const record = w.e2e.internals.tableDiagnosticsOf(w.draw).recordDraws();
      await new Promise<void>((resolve) => {
        w.map.once('render', () => resolve());
        w.map.triggerRepaint();
      });
      w.e2e.internals.tableDiagnosticsOf(w.draw).stopRecording();
      return record.map((entry) => entry.kind);
    });
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every((kind) => kind === 'rows')).toBe(true);
    expect(ranges.length).toBeLessThan(5);
  });

  it('cuts the dashes as the lines dashed on the CPU are cut', {
    timeout: browserTimeout(90_000),
  }, async () => {
    await compare(page, 'dashes', SCENES.dashes, { form: 'rows', byKind: true }, DASH_TOLERANCE);
  });
});

describe('the rows of a layer of z and m against the rows of xy', () => {
  let page: Page;

  beforeAll(async () => {
    page = await openMapPage(browser, bundle, CAMERA);
  }, browserTimeout(60_000));

  afterAll(async () => {
    await page?.close();
  });

  // The z and the m are held, not drawn: the pictures are the same, pixel for pixel
  for (const dims of ['xyz', 'xyzm'] as const) {
    it(`draws the rows of a layer of ${dims} as the rows of xy of the same x and y`, {
      timeout: browserTimeout(90_000),
    }, async () => {
      await compare(
        page,
        `dims-${dims}`,
        interleaved(),
        { form: 'rows', dims },
        {
          level: 0,
          share: 0,
        },
      );
    });
  }
});

describe('a row drawn in one draw against its feature drawn by the Store', () => {
  let page: Page;

  beforeAll(async () => {
    page = await openMapPage(browser, bundle, CAMERA);
  }, browserTimeout(60_000));

  afterAll(async () => {
    await page?.close();
  });

  // What is drawn between the rows while a row is edited is its feature, drawn by the Store:
  // the picture must not jump at the start and at the end of the edit
  for (const branch of ['points', 'lines', 'outlines', 'fills'] as const) {
    it(`draws the ${branch} as their features are drawn`, {
      timeout: browserTimeout(90_000),
    }, async () => {
      await compare(page, `store-${branch}`, SCENES[branch], { form: 'store' }, TOLERANCE);
    });
  }

  it('draws polygons with dashed outlines in their order, the fill and the outline of each in turn', {
    timeout: browserTimeout(90_000),
  }, async () => {
    // Two half transparent polygons with dashed outlines that overlap: in one draw, the fill of
    // the second covers the outline of the first. The Store draws each in a layer of its own,
    // so in their order too (in one layer it would draw both fills before both outlines)
    const features = [
      polygon('first', [square(-0.002, 0, 0.007)], {
        lineStyle: 'dashed',
        strokeWidth: 8,
        strokeColor: '#e15759',
        fillColor: '#4e79a7',
        fillOpacity: 0.6,
      }),
      polygon('second', [square(0.002, 0.001, 0.007)], {
        lineStyle: 'dashed',
        strokeWidth: 8,
        strokeColor: '#59a14f',
        fillColor: '#f28e2b',
        fillOpacity: 0.6,
      }),
    ];
    await compare(
      page,
      'dashed-order',
      features,
      { form: 'store', layers: ['a', 'b'] },
      DASH_TOLERANCE,
    );
  });
});
