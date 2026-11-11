// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The end-to-end tests of many features of different looks drawn together, each with the look it
 * has (`describeLookMatrix`, called by a test file for each Store and each way its features are
 * put in it)
 *
 * Every feature type is held with every line style, and the points with their shapes, an outline
 * and none, each in a cell of the left half of the map with colors no other feature has (a stroke,
 * a fill, a marker). The right half holds a copy of each, made with the look its feature has. The
 * looks are given as an application writes them: widths that are not integers, a created zoom
 * other than the zoom of the map or none, and styles with some keys only. Once everything is
 * built, then once half of the features are changed (their line style, width and colors, the
 * shape, size and colors of a point; the colors moved round among the features changed, so a
 * look left behind shows as the colors of another), each feature and its copy:
 *
 * - draw their own colors
 * - draw no color of another feature (a feature drawn with the look of another)
 * - are drawn the same, pixel for pixel
 *
 * A drawing that reads the look of another row on some GPUs only (a number taken out of a float
 * by a division) is not seen here: SwiftShader divides exactly. The shaders are held to take no
 * number out of a float so (`compile.test.ts`, `rows-tag.test.ts`).
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import { idle, load, openScenePage, type StoreKind } from './drag-scene.js';
import { type Bundle, bundlePage, launchBrowser, MAP_SIZE } from './harness.js';
import type { Holding } from './look-updates.js';

/** The zoom of the map, past the created zoom of the features that have one */
const ZOOM = 12.92;
/** The created zoom of half of the features */
const CREATED_ZOOM = 12;

const SHIFT = MAP_SIZE.width / 2;
const GRID = { columns: 4, rows: 7 } as const;
const CELL = { width: SHIFT / GRID.columns, height: MAP_SIZE.height / GRID.rows } as const;
/** How far a shape reaches from the center of its cell (CSS pixels) */
const REACH = 18;

/** The levels of the channels of the colors of the features (far enough apart to tell) */
const LEVELS = [0x10, 0x60, 0xb0, 0xf0];
/** Every color no other is near, the grays left out */
const COLORS: string[] = LEVELS.flatMap((r) => LEVELS.flatMap((g) => LEVELS.map((b) => [r, g, b])))
  .filter(([r, g, b]) => !(r === g && g === b))
  .map((c) => `#${c.map((v) => (v as number).toString(16).padStart(2, '0')).join('')}`);

type Shape =
  | 'square'
  | 'hexagon'
  | 'multipolygon'
  | 'circle'
  | 'line'
  | 'multiline'
  | 'freehand'
  | 'point'
  | 'multipoint';

/** A feature of the matrix: its shape, and what its look varies */
interface Entry {
  shape: Shape;
  /** The line style of its stroke, or the shape of its marker */
  variant: string;
  /** Whether it has a fill (the areas) or a marker (the points) */
  area: boolean;
  point: boolean;
}

const AREAS: Shape[] = ['square', 'hexagon', 'multipolygon', 'circle'];
const LINES: Shape[] = ['line', 'multiline', 'freehand'];
const LINE_STYLES = ['solid', 'dashed', 'dotted'];

const ENTRIES: Entry[] = [
  ...AREAS.flatMap((shape) =>
    LINE_STYLES.map((variant) => ({ shape, variant, area: true, point: false })),
  ),
  ...LINES.flatMap((shape) =>
    LINE_STYLES.map((variant) => ({ shape, variant, area: false, point: false })),
  ),
  ...['circle', 'square', 'triangle', 'star'].map((variant) => ({
    shape: 'point' as Shape,
    variant,
    area: false,
    point: true,
  })),
  { shape: 'multipoint', variant: 'circle', area: false, point: true },
];

/** The look of a feature: its style and the colors it draws */
interface Look {
  style: Record<string, unknown>;
  colors: string[];
}

/** The next line style, and the next shape of a marker */
const nextOf = (list: string[], value: string): string =>
  list[(list.indexOf(value) + 1) % list.length] as string;
const MARKERS = ['circle', 'square', 'triangle', 'star'];

/**
 * The first look of each feature: colors of its own, a width that is not an integer, and every
 * third one with some keys only
 */
function firstLooks(): Look[] {
  let color = 0;
  const take = (): string => COLORS[color++] as string;
  return ENTRIES.map((entry, i) => {
    const few = i % 3 === 2;
    if (entry.point) {
      const fill = take();
      // An outline on every other point (a star's thin arms draw too little of one to count)
      const stroke = i % 2 === 0 && entry.variant !== 'star' ? take() : null;
      return {
        style: {
          pointColor: fill,
          pointShape: entry.variant,
          pointRadius: few ? undefined : 9.5,
          ...(stroke
            ? { pointStrokeColor: stroke, pointStrokeWidth: 3.5 }
            : { pointStrokeWidth: 0 }),
        },
        colors: stroke ? [fill, stroke] : [fill],
      };
    }
    const stroke = take();
    const fill = entry.area ? take() : null;
    return {
      style: {
        strokeColor: stroke,
        lineStyle: entry.variant,
        ...(few ? {} : { strokeWidth: 1.75 + (i % 4) * 0.75, strokeOpacity: 1 }),
        ...(fill ? { fillColor: fill, fillOpacity: 1 } : {}),
      },
      colors: fill ? [stroke, fill] : [stroke],
    };
  });
}

/**
 * The changes of half of the features: another line style, width and colors, another shape, size
 * and colors of a marker. The colors are those of the features changed, moved round by two (as
 * many as a feature draws at most), so no feature changed keeps one of its colors
 */
function changes(first: Look[]): Map<number, Look> {
  const changed = ENTRIES.map((_, i) => i).filter((i) => i % 2 === 1);
  const pool = changed.flatMap((i) => (first[i] as Look).colors);
  let at = 2;
  const out = new Map<number, Look>();
  changed.forEach((i) => {
    const entry = ENTRIES[i] as Entry;
    const own = first[i] as Look;
    const colors = own.colors.map(() => pool[at++ % pool.length] as string);
    if (entry.point) {
      out.set(i, {
        style: {
          pointColor: colors[0],
          pointShape: nextOf(MARKERS, entry.variant),
          pointRadius: 9.25,
        },
        colors,
      });
    } else {
      out.set(i, {
        style: {
          strokeColor: colors[0],
          lineStyle: nextOf(LINE_STYLES, entry.variant),
          strokeWidth: 3.75,
          ...(entry.area ? { fillColor: colors[1] } : {}),
        },
        colors,
      });
    }
  });
  return out;
}

/** The style a feature has once a change is merged into its style, as an update merges it */
function merged(
  base: Record<string, unknown>,
  change: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base, ...change };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

/** The center of a cell of the left half (CSS pixels of the map) */
function cellCenter(i: number): [number, number] {
  return [
    CELL.width * (i % GRID.columns) + CELL.width / 2,
    CELL.height * Math.floor(i / GRID.columns) + CELL.height / 2,
  ];
}

const featureId = (i: number): string => `m${i}`;
const copyId = (i: number, round: number): string => `m${i}-copy${round}`;

/**
 * Puts features in the Store: in the left half (`copy` false) or their copies in the right half,
 * made by `features.createMany` or put in a page
 */
async function put(
  page: Page,
  items: Array<{ i: number; id: string; style: Record<string, unknown> }>,
  copy: boolean,
  holding: Holding,
): Promise<void> {
  await page.evaluate(
    ({ items, entries, centers, shift, reach, createdZoom, holding, copy }) => {
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
      const ll = (x: number, y: number): [number, number] => {
        const p = map.unproject([x, y]);
        return [p.lng, p.lat];
      };
      const around = (cx: number, cy: number, r: number, n: number, turn: number) => {
        const ring = Array.from({ length: n }, (_, k): [number, number] => {
          const a = turn + (k / n) * Math.PI * 2;
          return ll(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        });
        return [...ring, ring[0] as [number, number]];
      };
      const zigzag = (cx: number, cy: number, n: number, dy: number) =>
        Array.from({ length: n }, (_, k): [number, number] =>
          ll(cx - reach + (2 * reach * k) / (n - 1), cy + (k % 2 === 0 ? -dy : dy)),
        );
      const geometryOf = (shape: string, cx: number, cy: number) => {
        switch (shape) {
          case 'square':
            return {
              type: 'Polygon',
              geometry: { type: 'Polygon', coordinates: [around(cx, cy, reach, 4, Math.PI / 4)] },
            };
          case 'hexagon':
            return {
              type: 'Polygon',
              geometry: { type: 'Polygon', coordinates: [around(cx, cy, reach, 6, 0.3)] },
            };
          case 'multipolygon':
            return {
              type: 'MultiPolygon',
              geometry: {
                type: 'MultiPolygon',
                coordinates: [
                  [around(cx - reach / 2, cy, reach / 2, 4, Math.PI / 4)],
                  [around(cx + reach / 2, cy, reach / 2, 5, 0.1)],
                ],
              },
            };
          case 'circle': {
            const center = map.unproject([cx, cy]);
            return {
              type: 'Circle',
              geometry: { type: 'Point', coordinates: [center.lng, center.lat] },
              properties: {
                'maplibre-gl-draw:radiusMeters': center.distanceTo(map.unproject([cx + reach, cy])),
              },
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
                  zigzag(cx, cy + reach / 2, 4, reach / 4),
                ],
              },
            };
          case 'freehand':
            return {
              type: 'Freehand',
              geometry: {
                type: 'LineString',
                coordinates: Array.from({ length: 30 }, (_, k): [number, number] =>
                  ll(cx - reach + (2 * reach * k) / 29, cy + Math.sin(k / 3) * (reach / 2)),
                ),
              },
            };
          case 'point':
            return { type: 'Point', geometry: { type: 'Point', coordinates: ll(cx, cy) } };
          default:
            return {
              type: 'MultiPoint',
              geometry: {
                type: 'MultiPoint',
                coordinates: [ll(cx - reach / 2, cy), ll(cx + reach / 2, cy)],
              },
            };
        }
      };
      const inputs = items.map(({ i, id, style }) => {
        const [cx, cy] = centers[i] as [number, number];
        const made = geometryOf(
          (entries[i] as { shape: string }).shape,
          cx + (copy ? shift : 0),
          cy,
        ) as {
          type: string;
          geometry: unknown;
          properties?: Record<string, unknown>;
        };
        return {
          ...made,
          id,
          properties: {
            ...made.properties,
            // Half of the features follow the zoom from a created zoom, the others do not
            ...(i % 2 === 0 ? { 'maplibre-gl-draw:createdZoom': createdZoom } : {}),
          },
          style,
          layerId: 'L',
        };
      });
      if (holding === 'block' && !copy) {
        const builder = w.e2e.tables.createPageBuilder({});
        inputs.forEach((f, k) => {
          builder.addRow({
            id: f.id,
            type: f.type,
            geometry: f.geometry,
            order: `a${String(k).padStart(4, '0')}`,
            style: f.style,
            properties: f.properties,
            visible: true,
            locked: false,
          } as never);
        });
        w.writer.addPages('L', builder.finish());
      } else if (!draw.features.createMany(inputs as never)) {
        throw new Error('the features were not created');
      }
    },
    {
      items,
      entries: ENTRIES,
      centers: ENTRIES.map((_, i) => cellCenter(i)),
      shift: SHIFT,
      reach: REACH,
      createdZoom: CREATED_ZOOM,
      holding,
      copy,
    },
  );
}

/** What a cell and its copy draw */
interface Cell {
  /** The pixels of each color the feature draws, in its cell and in the cell of its copy */
  own: number[];
  copyOwn: number[];
  /** The pixels of the colors of the other features, in the cell and in the cell of its copy */
  foreign: string[];
  /** The pixels drawn in the cell or its copy, and those that differ between them */
  drawn: number;
  differ: number;
}

/** What each cell draws, once everything is built */
async function readCells(page: Page, looks: Look[]): Promise<Cell[]> {
  return page.evaluate(
    async ({ looks, cell, columns, shift, palette }) => {
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
      const rgb = (hex: string) => [1, 3, 5].map((k) => Number.parseInt(hex.slice(k, k + 2), 16));
      const colors = palette.map(rgb);
      // The color of the palette a pixel is (-1 for none): near it for its own colors, closer for
      // the colors of the others (a blend at an edge passes near other colors)
      const colorAt = (x: number, y: number, near: number): number => {
        const i = ((height - 1 - y) * width + x) * 4;
        if ((pixels[i + 3] as number) < 250) return -1;
        return colors.findIndex((c) =>
          c.every((v, k) => Math.abs((pixels[i + k] as number) - (v as number)) < near),
        );
      };
      return looks.map((look, c) => {
        const x0 = Math.round(cell.width * (c % columns) * ratio);
        const y0 = Math.round(cell.height * Math.floor(c / columns) * ratio);
        const x1 = Math.round(x0 + cell.width * ratio);
        const y1 = Math.round(y0 + cell.height * ratio);
        const dx = Math.round(shift * ratio);
        const ownIndex = look.colors.map((hex) => palette.indexOf(hex));
        const own = ownIndex.map(() => 0);
        const copyOwn = ownIndex.map(() => 0);
        const foreign = new Map<number, number>();
        let drawn = 0;
        let differ = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            for (const [px, counts] of [
              [x, own],
              [x + dx, copyOwn],
            ] as const) {
              const found = colorAt(px, y, 24);
              if (found < 0) continue;
              const k = ownIndex.indexOf(found);
              if (k >= 0) counts[k] = (counts[k] as number) + 1;
              else if (colorAt(px, y, 8) === found)
                foreign.set(found, (foreign.get(found) ?? 0) + 1);
            }
            const a = ((height - 1 - y) * width + x) * 4;
            const b = a + dx * 4;
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
        return {
          own,
          copyOwn,
          // A blend at an edge may come near another color for a few pixels; a look drawn with
          // the colors of another feature draws many
          foreign: [...foreign].filter(([, n]) => n > 24).map(([k, n]) => `${palette[k]} ${n}`),
          drawn,
          differ,
        };
      });
    },
    { looks, cell: CELL, columns: GRID.columns, shift: SHIFT, palette: COLORS },
  );
}

/** Holds every cell to the look of its feature */
function expectLooks(cells: Cell[], looks: Look[], when: string): void {
  cells.forEach((cell, i) => {
    const entry = ENTRIES[i] as Entry;
    const what = `${entry.shape} ${entry.variant} (${featureId(i)}), ${when}`;
    const colors = (looks[i] as Look).colors;
    cell.own.forEach((n, k) => {
      expect.soft(n, `${what}: its color ${colors[k]}`).toBeGreaterThan(8);
    });
    cell.copyOwn.forEach((n, k) => {
      expect.soft(n, `${what}: its color ${colors[k]} in its copy`).toBeGreaterThan(8);
    });
    expect.soft(cell.foreign, `${what}: the colors of other features`).toEqual([]);
    expect
      .soft(cell.differ / Math.max(cell.drawn, 1), `${what}: against its copy`)
      .toBeLessThan(0.04);
  });
}

/** Registers the tests of many features of different looks drawn together, over a Store */
export function describeLookMatrix(kind: StoreKind, holding: Holding): void {
  let browser: Browser;
  let bundle: Bundle;
  let page: Page;

  beforeAll(async () => {
    [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
    page = await openScenePage(browser, bundle, ZOOM);
    await load(page, { kind, features: [] }, ZOOM);
  }, browserTimeout(90_000));

  afterAll(async () => {
    await browser?.close();
  });

  it('draws each feature with its look, once made and once half of them are changed', {
    timeout: browserTimeout(60_000),
  }, async () => {
    const first = firstLooks();
    const clean = (style: Record<string, unknown>) => merged(style, {});
    await put(
      page,
      first.map((look, i) => ({ i, id: featureId(i), style: clean(look.style) })),
      false,
      holding,
    );
    await put(
      page,
      first.map((look, i) => ({ i, id: copyId(i, 0), style: clean(look.style) })),
      true,
      'made',
    );
    await idle(page);
    expectLooks(await readCells(page, first), first, 'once made');

    const changed = changes(first);
    const now = first.map((look, i) => {
      const change = changed.get(i);
      return change
        ? { style: merged(clean(look.style), change.style), colors: change.colors }
        : look;
    });
    await page.evaluate(
      ({ patches, copies }) => {
        const w = window as unknown as { draw: import('../index.js').Draw };
        for (const { id, style } of patches) {
          if (!w.draw.features.update(id, { style } as never)) throw new Error(`${id} not updated`);
        }
        w.draw.features.deleteMany(copies);
      },
      {
        patches: [...changed].map(([i, look]) => ({ id: featureId(i), style: look.style })),
        copies: [...changed.keys()].map((i) => copyId(i, 0)),
      },
    );
    await put(
      page,
      [...changed.keys()].map((i) => ({ i, id: copyId(i, 1), style: (now[i] as Look).style })),
      true,
      'made',
    );
    await idle(page);
    expectLooks(await readCells(page, now), now, 'once half of them are changed');
  });
}
