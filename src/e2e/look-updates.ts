// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The end-to-end tests of a look changed after a feature is made (`describeLookUpdates`, called
 * by a test file for each Store and each way its features are put in it)
 *
 * For each feature type, the left half of the map holds features made with a look and then
 * changed by `features.update`, one change each, and the right half holds the same shapes made
 * with the look they were changed to. The features changed are selected while they are changed,
 * as an editor changes them. Once everything is built the pixels of each feature changed are held
 * to those of its copy: they are drawn the same, while the features are selected and once they are
 * not. Before the change they are held to differ, so a change the drawing does not show fails.
 *
 * The axes of a look changed: the line style of a stroke (solid, dashed and dotted, both ways),
 * its width, its color and its opacity, and the color and the opacity of a fill; each from a
 * style that sets every key, and from a style that sets few keys or none (the look of the
 * defaults) by one key.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import { idle, load, openScenePage, type StoreKind, select } from './drag-scene.js';
import { type Bundle, bundlePage, type E2EWrites, launchBrowser, MAP_SIZE } from './harness.js';

const ZOOM = 14;

/** How far the copy made with the new look is from the one changed (CSS pixels, to the right) */
const SHIFT = MAP_SIZE.width / 2;

/** The columns and the rows of the cells of the left half */
const GRID = { columns: 3, rows: 5 } as const;

/** The size of a cell of the left half */
const CELL = { width: SHIFT / GRID.columns, height: MAP_SIZE.height / GRID.rows } as const;

/** How far a shape reaches from the center of its cell (CSS pixels) */
const REACH = 32;

/**
 * How the features are put in the Store: made by `features.createMany`, or, in a Store of rows,
 * put in a page of its tables (the rows a document opened holds, written in place)
 */
export type Holding = 'made' | 'block';

/** A shape of a feature type, as the cell draws it */
type ShapeName =
  | 'square'
  | 'hexagon'
  | 'multipolygon'
  | 'circle'
  | 'line'
  | 'multiline'
  | 'freehand';

/**
 * A change of a look: the style made with (none when empty), and the keys of the style it is
 * changed to (the copy is made with the style made with and these keys over it, as an update
 * merges them)
 */
interface Change {
  name: string;
  from: Record<string, unknown>;
  to: Record<string, unknown>;
  /** Whether the change is of a fill (held for the types with one only) */
  fill?: boolean;
}

const BLUE = '#2060e0';
const RED = '#e02040';
const GREEN = '#20a040';

/** The style of a stroke with no fill */
const stroke = (look: Record<string, unknown>): Record<string, unknown> => ({
  strokeColor: BLUE,
  strokeWidth: 4,
  strokeOpacity: 1,
  lineStyle: 'solid',
  fillOpacity: 0,
  ...look,
});

/** The style of a fill with a thin solid outline */
const fill = (look: Record<string, unknown>): Record<string, unknown> => ({
  strokeColor: GREEN,
  strokeWidth: 2,
  strokeOpacity: 1,
  lineStyle: 'solid',
  fillColor: BLUE,
  fillOpacity: 0.4,
  ...look,
});

/** The changes held for every type, the ones of a fill only for a type with one */
const CHANGES: readonly Change[] = [
  {
    name: 'the line style from solid to dashed',
    from: stroke({}),
    to: stroke({ lineStyle: 'dashed' }),
  },
  {
    name: 'the line style from solid to dotted',
    from: stroke({}),
    to: stroke({ lineStyle: 'dotted' }),
  },
  {
    name: 'the line style from dashed to solid',
    from: stroke({ lineStyle: 'dashed' }),
    to: stroke({ lineStyle: 'solid' }),
  },
  {
    name: 'the line style from dashed to dotted',
    from: stroke({ lineStyle: 'dashed' }),
    to: stroke({ lineStyle: 'dotted' }),
  },
  {
    name: 'the width of the stroke',
    from: stroke({ strokeWidth: 2 }),
    to: stroke({ strokeWidth: 10 }),
  },
  { name: 'the color of the stroke', from: stroke({}), to: stroke({ strokeColor: RED }) },
  { name: 'the opacity of the stroke', from: stroke({}), to: stroke({ strokeOpacity: 0.3 }) },
  { name: 'the color of the fill', from: fill({}), to: fill({ fillColor: RED }), fill: true },
  { name: 'the opacity of the fill', from: fill({}), to: fill({ fillOpacity: 1 }), fill: true },
  {
    name: 'a style without a line style to a dashed line',
    from: { strokeWidth: 6, fillOpacity: 0 },
    to: { lineStyle: 'dashed' },
  },
  {
    name: 'a style without a line style to a dotted line',
    from: { strokeWidth: 6, fillOpacity: 0 },
    to: { lineStyle: 'dotted' },
  },
  { name: 'no style to a wide stroke', from: {}, to: { strokeWidth: 10 } },
  { name: 'no style to a stroke of a color', from: {}, to: { strokeColor: BLUE } },
  { name: 'no style to a faint stroke', from: {}, to: { strokeOpacity: 0.3 } },
  { name: 'no style to a fill of a color', from: {}, to: { fillColor: BLUE }, fill: true },
];

/** A feature type held, its shape, and whether it has a fill */
interface TypeCase {
  name: string;
  shape: ShapeName;
  fill: boolean;
}

const TYPES: readonly TypeCase[] = [
  { name: 'a Circle', shape: 'circle', fill: true },
  { name: 'a Polygon of four corners', shape: 'square', fill: true },
  { name: 'a Polygon of six corners', shape: 'hexagon', fill: true },
  { name: 'a MultiPolygon', shape: 'multipolygon', fill: true },
  { name: 'a LineString', shape: 'line', fill: false },
  { name: 'a MultiLineString', shape: 'multiline', fill: false },
  { name: 'a Freehand', shape: 'freehand', fill: false },
];

/** How the pixels of a cell compare with its copy */
interface Compared {
  /** The pixels drawn in the cell or in its copy */
  drawn: number;
  /** The pixels that differ between the cell and its copy */
  differ: number;
}

/** The selection UI drawn with nothing, so that the features selected are seen alone */
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
};

/** The changes of a type, each in a cell */
const changesOf = (type: TypeCase): Change[] =>
  CHANGES.filter((change) => !change.fill || type.fill);

/** The ID of the feature changed in a cell, and of its copy */
const changedId = (type: TypeCase, i: number): string => `${type.shape}-${i}-changed`;
const madeId = (type: TypeCase, i: number): string => `${type.shape}-${i}-made`;

/** The center of a cell of the left half (CSS pixels of the map) */
function cellCenter(i: number): [number, number] {
  return [
    CELL.width * (i % GRID.columns) + CELL.width / 2,
    CELL.height * Math.floor(i / GRID.columns) + CELL.height / 2,
  ];
}

/**
 * Puts the features of a type in the Store: one with the look before each change in the left
 * half, and one with the look after it in the right half
 */
async function putFeatures(page: Page, type: TypeCase, holding: Holding): Promise<string[]> {
  const changes = changesOf(type);
  return page.evaluate(
    ({ shape, changes, ids, centers, shift, reach, zoom, holding }) => {
      const w = window as unknown as {
        draw: import('../index.js').Draw;
        map: import('maplibre-gl').Map;
        writer: import('../kasane/index.js').FeatureTablesWriter;
        e2e: {
          tables: {
            createPageBuilder: typeof import('../table/feature-row-blocks.js').createFeaturePageBuilder;
          };
        };
      };
      const { draw, map } = w;
      const lngLat = (x: number, y: number): [number, number] => {
        const p = map.unproject([x, y]);
        return [p.lng, p.lat];
      };
      const closed = (points: Array<[number, number]>): Array<[number, number]> => [
        ...points,
        points[0] as [number, number],
      ];
      const around = (cx: number, cy: number, r: number, n: number, turn: number) =>
        Array.from({ length: n }, (_, k): [number, number] => {
          const a = turn + (k / n) * Math.PI * 2;
          return lngLat(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        });
      const zigzag = (cx: number, cy: number, n: number, dy: number) =>
        Array.from({ length: n }, (_, k): [number, number] =>
          lngLat(cx - reach + (2 * reach * k) / (n - 1), cy + (k % 2 === 0 ? -dy : dy)),
        );
      const shapeAt = (
        cx: number,
        cy: number,
      ): { type: string; geometry: unknown; properties?: Record<string, unknown> } => {
        switch (shape) {
          case 'square':
            return {
              type: 'Polygon',
              geometry: {
                type: 'Polygon',
                coordinates: [closed(around(cx, cy, reach, 4, 0.25 * Math.PI))],
              },
            };
          case 'hexagon':
            return {
              type: 'Polygon',
              geometry: { type: 'Polygon', coordinates: [closed(around(cx, cy, reach, 6, 0.3))] },
            };
          case 'multipolygon':
            return {
              type: 'MultiPolygon',
              geometry: {
                type: 'MultiPolygon',
                coordinates: [
                  [closed(around(cx - reach / 2, cy, reach / 2, 4, 0.25 * Math.PI))],
                  [closed(around(cx + reach / 2, cy, reach / 2, 5, 0.1))],
                ],
              },
            };
          case 'circle': {
            const center = map.unproject([cx, cy]);
            const edge = map.unproject([cx + reach, cy]);
            return {
              type: 'Circle',
              geometry: { type: 'Point', coordinates: [center.lng, center.lat] },
              properties: { 'maplibre-gl-draw:radiusMeters': center.distanceTo(edge) },
            };
          }
          case 'line':
            return {
              type: 'LineString',
              geometry: { type: 'LineString', coordinates: zigzag(cx, cy, 4, reach / 2) },
            };
          case 'multiline':
            return {
              type: 'MultiLineString',
              geometry: {
                type: 'MultiLineString',
                coordinates: [
                  zigzag(cx, cy - reach / 2, 3, reach / 4),
                  zigzag(cx, cy + reach / 2, 5, reach / 4),
                ],
              },
            };
          default:
            // A freehand stroke: many close points along a wave
            return {
              type: 'Freehand',
              geometry: {
                type: 'LineString',
                coordinates: Array.from({ length: 40 }, (_, k): [number, number] =>
                  lngLat(cx - reach + (2 * reach * k) / 39, cy + Math.sin(k / 4) * (reach / 2)),
                ),
              },
            };
        }
      };
      const featureAt = (cx: number, cy: number, id: string, style: Record<string, unknown>) => {
        const made = shapeAt(cx, cy);
        return {
          ...made,
          id,
          // The zoom a feature drawn by a mode is made at
          properties: { ...made.properties, 'maplibre-gl-draw:createdZoom': zoom },
          style,
          layerId: 'L',
        };
      };
      const inputs = changes.flatMap((change, i) => {
        const [cx, cy] = centers[i] as [number, number];
        const [changed, made] = ids[i] as [string, string];
        return [
          featureAt(cx, cy, changed, change.from),
          featureAt(cx + shift, cy, made, { ...change.from, ...change.to }),
        ];
      });
      if (holding === 'block') {
        const builder = w.e2e.tables.createPageBuilder({});
        inputs.forEach((f, i) => {
          builder.addRow({
            id: f.id,
            type: f.type,
            geometry: f.geometry,
            order: `k${String(i).padStart(6, '0')}`,
            style: f.style,
            properties: f.properties,
            visible: true,
            locked: false,
          } as never);
        });
        w.writer.addPages('L', builder.finish());
      } else if (
        !(window as unknown as E2EWrites).e2e.writesOf(draw).features.createMany(inputs as never)
      ) {
        throw new Error('the features were not created');
      }
      return inputs.map((input) => input.id);
    },
    {
      shape: type.shape,
      changes,
      ids: changes.map((_, i) => [changedId(type, i), madeId(type, i)]),
      centers: changes.map((_, i) => cellCenter(i)),
      shift: SHIFT,
      reach: REACH,
      zoom: ZOOM,
      holding,
    },
  );
}

/** Changes the look of the features of the left half to the look of their copies */
async function changeLooks(page: Page, type: TypeCase): Promise<void> {
  const patches = changesOf(type).map((change, i) => ({
    id: changedId(type, i),
    style: change.to,
  }));
  await page.evaluate((patches) => {
    const w = window as unknown as { draw: import('../index.js').Draw };
    for (const { id, style } of patches) {
      if (
        !(window as unknown as E2EWrites).e2e
          .writesOf(w.draw)
          .features.update(id, { style } as never)
      ) {
        throw new Error(`the feature ${id} was not updated`);
      }
    }
  }, patches);
}

/**
 * The pixels of each cell of the left half held to its copy in the right half, once everything is
 * built
 */
async function compareCells(page: Page, cells: number): Promise<Compared[]> {
  return page.evaluate(
    async ({ cells, cell, columns, shift }) => {
      const w = window as unknown as {
        draw: import('../index.js').Draw;
        map: import('maplibre-gl').Map;
      };
      const { draw, map } = w;
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
      // The frame is read from the bottom
      const at = (x: number, y: number): number => ((height - 1 - y) * width + x) * 4;
      const dx = Math.round(shift * ratio);
      const out: Array<{ drawn: number; differ: number }> = [];
      for (let c = 0; c < cells; c++) {
        const x0 = Math.round(cell.width * (c % columns) * ratio);
        const y0 = Math.round(cell.height * Math.floor(c / columns) * ratio);
        const x1 = Math.round(x0 + cell.width * ratio);
        const y1 = Math.round(y0 + cell.height * ratio);
        let drawn = 0;
        let differ = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const a = at(x, y);
            const b = at(x + dx, y);
            if ((pixels[a + 3] as number) === 0 && (pixels[b + 3] as number) === 0) continue;
            drawn++;
            for (let k = 0; k < 4; k++) {
              if (Math.abs((pixels[a + k] as number) - (pixels[b + k] as number)) >= 48) {
                differ++;
                break;
              }
            }
          }
        }
        out.push({ drawn, differ });
      }
      return out;
    },
    { cells, cell: CELL, columns: GRID.columns, shift: SHIFT },
  );
}

/** The share of the pixels drawn a cell and its copy may differ by when drawn the same */
const SAME = 0.04;
/** The share they differ by at least when their looks differ */
const DIFFERENT = 0.08;

/** Holds the cells of the changes of a type the same as their copies */
function expectSame(changes: readonly Change[], cells: readonly Compared[], when: string): void {
  changes.forEach((change, i) => {
    const cell = cells[i] as Compared;
    const what = `${change.name}, ${when}`;
    expect.soft(cell.drawn, what).toBeGreaterThan(100);
    expect.soft(cell.differ / cell.drawn, what).toBeLessThan(SAME);
  });
}

/**
 * Registers the tests of the looks changed after the features are put in a Store, over a Store
 * of a kind
 */
export function describeLookUpdates(kind: StoreKind, holding: Holding): void {
  let browser: Browser;
  let bundle: Bundle;
  let page: Page;
  /** The features in the Store */
  let shown: string[] = [];

  beforeAll(async () => {
    [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
    page = await openScenePage(browser, bundle, ZOOM);
    await load(page, { kind, features: [], options: { selectionStyle } }, ZOOM);
  }, browserTimeout(90_000));

  afterAll(async () => {
    await browser?.close();
  });

  describe.each(TYPES)('$name', (type) => {
    it('is drawn with a look changed after it was made as if made with it', {
      timeout: browserTimeout(60_000),
    }, async () => {
      if (shown.length > 0) {
        await page.evaluate((ids) => {
          const w = window as unknown as { draw: import('../index.js').Draw };
          (window as unknown as E2EWrites).e2e.writesOf(w.draw).features.deleteMany(ids);
        }, shown);
      }
      shown = await putFeatures(page, type, holding);
      const changes = changesOf(type);

      const before = await compareCells(page, changes.length);
      changes.forEach((change, i) => {
        const cell = before[i] as Compared;
        const what = `${change.name}, before it is changed`;
        expect.soft(cell.drawn, what).toBeGreaterThan(100);
        expect.soft(cell.differ / cell.drawn, what).toBeGreaterThan(DIFFERENT);
      });

      // Changed while they are selected, as an editor changes them
      await select(
        page,
        changes.map((_, i) => changedId(type, i)),
      );
      await idle(page);
      await changeLooks(page, type);
      expectSame(changes, await compareCells(page, changes.length), 'once changed, selected');
      await select(page, []);
      expectSame(changes, await compareCells(page, changes.length), 'once changed and let go');
    });
  });
}
