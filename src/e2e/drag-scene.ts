// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The scene of the end-to-end tests of what an edit in progress shows and answers
 *
 * A page with a map (with or without the flat test terrain) is opened once, and every scene
 * makes a new draw instance on it over a Store of its own: an in-memory Store of objects, or the
 * in-memory Store of rows of the library. The scene then reads, from the page:
 *
 * - the frame once everything is built: the pixels of colors asked for, their center and box
 * - the image of the map (`draw.captureImage`), read the same way
 * - the topmost feature at a point, as the hit test of a mode answers it (a mode registered by
 *   the scene hands out its context once, and the context is asked afterwards)
 * - the events of the instance, recorded from a mark
 * - the cursor of the map canvas, which the select mode sets from the handle under the pointer
 *
 * Points of the map are CSS pixels from the top left of its canvas; points of the page are
 * CSS pixels of the viewport (the canvas is shifted from its top left).
 */

import type { Browser, Page } from 'playwright-core';
import { browserTimeout } from '../test-utils.js';
import { type Bundle, openMapPage, type PagePoint, settle } from './harness.js';

/** The Store a scene holds its features in */
export type StoreKind = 'objects' | 'rows';

/** Both Stores */
export const KINDS: readonly StoreKind[] = ['objects', 'rows'];

/** An RGB color of a test, as the frame draws it */
export type Rgb = readonly [number, number, number];

/** A box of the map: left, top, right, bottom (CSS pixels from its top left) */
export type Box = [number, number, number, number];

/** A point of the map (CSS pixels from its top left) */
export type MapPoint = [number, number];

/** The pixels of a color drawn: their number, those in a box asked for, their center and box */
export interface Drawn {
  count: number;
  inside: number;
  center: MapPoint | null;
  box: Box | null;
}

/** A feature to create */
export interface FeatureInput {
  id: string;
  type: string;
  geometry: { type: string; coordinates: unknown };
  properties?: Record<string, unknown>;
  style?: Record<string, unknown>;
}

/** A scene: the Store, its features and the options of the instance */
export interface SceneSpec {
  kind: StoreKind;
  features: FeatureInput[];
  /** The options given to createDraw besides the Store */
  options?: Record<string, unknown>;
  /** Files of images of one color, by ID, put in the Store before the instance is made */
  images?: Record<string, string>;
  /** The options of the in-memory Store of rows (the most features opened, say) */
  rowsOptions?: Record<string, unknown>;
}

/** An event of the instance, as the scene records it */
export interface Recorded {
  name: string;
  /** The ID of the feature, for the events of a feature */
  id?: string;
  /** `intermediate` of `feature.updated` */
  intermediate?: boolean;
  /** The geometry type of the feature of `preview.changed` (null when it is cleared) */
  preview?: string | null;
  /** The number of positions of the feature of `preview.changed` */
  positions?: number;
  /** The feature of the target of `snap.changed` (null for none, or no result) */
  snapFeature?: string | null;
  /** The vertex of the target of `snap.changed` */
  snapVertex?: number | null;
  /** The number of rows `document.changed` tells updated, over its layers */
  rows?: number;
  /** The features of `document.changed` updated */
  updated?: number;
  /** `cancelled` of `drag.ended`, and the kind of `drag.started` and `drag.ended` */
  cancelled?: boolean;
  kind?: string;
  /** The number of vertices of `vertexSelection.changed` (null when cleared) */
  vertices?: number | null;
}

/** What a hit test of the mode context answered */
export interface HitAnswer {
  kind: string;
  id: string;
  featureId?: string;
}

/** The position of the page the map of the scenes is opened at */
export const CENTER: [number, number] = [139.7, 35.68];

/** A position at an offset from the center, in degrees */
export const at = (dx: number, dy: number): [number, number] => [CENTER[0] + dx, CENTER[1] + dy];

/** A color as CSS */
export const hex = (c: Rgb): string => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** A closed ring of `n` corners around an offset from the center */
export function ring(
  dx: number,
  dy: number,
  rx: number,
  ry = rx * 0.8,
  n = 9,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(at(dx + Math.cos(a) * rx, dy + Math.sin(a) * ry));
  }
  out.push(out[0] as [number, number]);
  return out;
}

/** A closed square ring around an offset from the center, from its south-west corner */
export function square(dx: number, dy: number, r: number): Array<[number, number]> {
  return [at(dx - r, dy - r), at(dx + r, dy - r), at(dx + r, dy + r), at(dx - r, dy + r)].concat([
    at(dx - r, dy - r),
  ]);
}

/** A point style of one color */
export const pointLook = (shape: string, color: Rgb, size: number) => ({
  shape,
  size,
  fillColor: hex(color),
  fillOpacity: 1,
  strokeColor: hex(color),
  strokeWidth: 0,
  strokeOpacity: 1,
});

/**
 * Opens a page with a map at a zoom, with the flat test terrain or without, and installs what the
 * scenes read through (`window.t`)
 */
export async function openScenePage(
  browser: Browser,
  bundle: Bundle,
  zoom: number,
  terrain = false,
): Promise<Page> {
  const page = await openMapPage(browser, bundle, { center: CENTER, zoom });
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
      await w.e2e.terrain.addTestTerrain(w.map, 1, { flat: true });
    });
  }
  return page;
}

/**
 * Makes a new instance on the page over a Store of a kind holding the features in a layer `L`,
 * the map back at the center and the zoom of the page (a drag that missed may have moved it),
 * and waits until everything is built
 *
 * @param center - The center the map is put back at (the center of the page when omitted)
 */
export async function load(
  page: Page,
  spec: SceneSpec,
  zoom: number,
  center: readonly [number, number] = CENTER,
): Promise<void> {
  await page.evaluate(
    async ({ s, zoom, center }) => {
      type Draw = import('../index.js').Draw;
      type Store = import('../index.js').Store;
      const w = window as unknown as Record<string, unknown> & {
        map: import('maplibre-gl').Map;
        draw: Draw;
        e2e: {
          createDraw: typeof import('../index.js').createDraw;
          tables: { createTableStore: typeof import('../kasane/index.js').createTableStore };
          internals: { MemoryContractStore: new () => Store };
        };
        t: unknown;
      };
      const { map } = w;
      map.jumpTo({ center, zoom });
      const layer = { id: 'L', name: 'L', visible: true, locked: false, opacity: 1 };
      let store: Store;
      if (s.kind === 'rows') {
        const made = w.e2e.tables.createTableStore((s.rowsOptions ?? {}) as never);
        store = made.store as unknown as Store;
        // The writer of its tables, which puts row blocks in them
        w.writer = made.writer;
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
      w.store = store;
      if (s.features.length > 0) {
        const created = draw.features.createMany(
          s.features.map((f) => ({ ...f, layerId: 'L' })) as never,
        );
        if (!created) throw new Error('the features were not created');
      }

      // The context of a mode, handed out once: its hit test is asked in any mode afterwards
      let probe: import('../index.js').ModeContext | null = null;
      draw.extensions.modes.add('e2e-probe', (ctx) => {
        probe = ctx;
        return {};
      });
      draw.setMode('e2e-probe' as never);
      draw.setMode('select');

      // The events, from a mark
      const recorded: Array<Record<string, unknown>> = [];
      type Geometry = { type: string; coordinates?: unknown };
      const positions = (geometry: Geometry | undefined): number => {
        let n = 0;
        const walk = (v: unknown): void => {
          if (Array.isArray(v) && typeof v[0] === 'number') n++;
          else if (Array.isArray(v)) for (const x of v) walk(x);
        };
        walk(geometry?.coordinates);
        return n;
      };
      draw.on('feature.updated', (e) =>
        recorded.push({ name: 'feature.updated', id: e.feature.id, intermediate: e.intermediate }),
      );
      draw.on('feature.created', (e) =>
        recorded.push({ name: 'feature.created', id: e.feature.id }),
      );
      draw.on('feature.deleted', (e) =>
        recorded.push({ name: 'feature.deleted', id: e.feature.id }),
      );
      draw.on('preview.changed', (e) =>
        recorded.push({
          name: 'preview.changed',
          preview: e.feature ? e.feature.type : null,
          positions: e.feature ? positions(e.feature.geometry as Geometry) : 0,
        }),
      );
      draw.on('snap.changed', (e) =>
        recorded.push({
          name: 'snap.changed',
          snapFeature: e.result?.target?.featureId ?? null,
          snapVertex: e.result?.target?.vertex?.index ?? null,
        }),
      );
      draw.on('document.changed', (e) => {
        let rows = 0;
        for (const change of e.rows?.layers.values() ?? []) rows += change.updated.length;
        recorded.push({
          name: 'document.changed',
          rows,
          updated: e.features?.updated?.length ?? 0,
        });
      });
      draw.on('drag.started', (e) => recorded.push({ name: 'drag.started', kind: e.kind }));
      draw.on('drag.ended', (e) =>
        recorded.push({ name: 'drag.ended', kind: e.kind, cancelled: e.cancelled }),
      );
      draw.on('vertexSelection.changed', (e) =>
        recorded.push({
          name: 'vertexSelection.changed',
          vertices: e.selection ? e.selection.vertices.length : null,
        }),
      );

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
      const measureAll = (
        pixels: Uint8Array,
        width: number,
        height: number,
        colors: number[][],
        boxes: Array<number[] | null>,
      ) => colors.map((c, i) => measure(pixels, width, height, c, boxes[i] ?? null));

      w.t = {
        // The frame once everything is built, the pixels of each color
        async frame(colors: number[][], boxes: Array<number[] | null>) {
          let pixels = await read();
          for (let i = 0; i < 100 && draw.hasPendingWork(); i++) pixels = await read();
          await read();
          pixels = await read();
          const canvas = map.getCanvas();
          return measureAll(pixels, canvas.width, canvas.height, colors, boxes);
        },
        // The next frame, without waiting for the work of the drawing
        async quickFrame(colors: number[][], boxes: Array<number[] | null>) {
          const pixels = await read();
          const canvas = map.getCanvas();
          return measureAll(pixels, canvas.width, canvas.height, colors, boxes);
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
          return measureAll(flipped, bitmap.width, bitmap.height, colors, []);
        },
        // The answers of the hit test over a grid of the map against the frame: where the frame
        // draws only `inside` colors around a point (within 2 px) the feature of the point is
        // asked, and where it draws none of `drawn` (within 9 px, past the click tolerance) none
        async agreement(inside: number[][], drawn: number[][], step: number) {
          const pixels = await read();
          const canvas = map.getCanvas();
          const width = canvas.width;
          const height = canvas.height;
          const ratio = width / canvas.clientWidth;
          const near = (x: number, y: number, colors: number[][]): boolean => {
            const i = ((height - 1 - y) * width + x) * 4;
            if ((pixels[i + 3] as number) < 128) return false;
            return colors.some((c) =>
              c.every((v, k) => Math.abs((pixels[i + k] as number) - v) < 24),
            );
          };
          const around = (px: number, py: number, r: number, colors: number[][]) => {
            let all = true;
            let any = false;
            for (let y = py - r; y <= py + r; y++) {
              for (let x = px - r; x <= px + r; x++) {
                const hit = x >= 0 && y >= 0 && x < width && y < height && near(x, y, colors);
                all &&= hit;
                any ||= hit;
              }
            }
            return { all, any };
          };
          const result = {
            inside: 0,
            outside: 0,
            missedInside: [] as Array<[number, number, string | null]>,
            hitOutside: [] as Array<[number, number, string | null]>,
            ids: [] as string[],
          };
          const ids = new Set<string>();
          for (let y = step / 2; y < canvas.clientHeight; y += step) {
            for (let x = step / 2; x < canvas.clientWidth; x += step) {
              const px = Math.round(x * ratio);
              const py = Math.round(y * ratio);
              const hit = (probe as import('../index.js').ModeContext | null)?.hitTest([x, y]);
              const id = hit?.kind === 'feature' ? hit.id : null;
              if (around(px, py, Math.round(2 * ratio), inside).all) {
                result.inside++;
                if (id === null) result.missedInside.push([x, y, id]);
                else ids.add(id);
              } else if (!around(px, py, Math.round(9 * ratio), drawn).any) {
                result.outside++;
                if (id !== null) result.hitOutside.push([x, y, id]);
              }
            }
          }
          result.ids = [...ids].sort();
          return result;
        },
        hit(point: number[]) {
          const hit = (probe as import('../index.js').ModeContext | null)?.hitTest(
            point as [number, number],
          );
          return hit ? { kind: hit.kind, id: hit.id, featureId: hit.featureId } : null;
        },
        mark() {
          recorded.length = 0;
        },
        events() {
          return recorded.slice();
        },
      };

      const frame = (): Promise<void> =>
        new Promise((resolve) => {
          map.once('render', () => resolve());
          map.triggerRepaint();
        });
      await frame();
      for (let i = 0; i < 200 && draw.hasPendingWork(); i++) await frame();
    },
    { s: spec, zoom, center: [center[0], center[1]] as [number, number] },
  );
  await settle(page);
}

interface SceneWindow {
  t: {
    frame(c: unknown, b: unknown): Promise<Drawn[]>;
    quickFrame(c: unknown, b: unknown): Promise<Drawn[]>;
    capture(c: unknown): Promise<Drawn[]>;
    agreement(inside: unknown, drawn: unknown, step: number): Promise<Agreement>;
    hit(point: number[]): HitAnswer | null;
    mark(): void;
    events(): Recorded[];
  };
  map: import('maplibre-gl').Map;
  draw: import('../index.js').Draw;
}

/**
 * The frame once everything is built: the pixels of each color, and those of them in a box given
 * for the color (`inside`)
 */
export const frame = (
  page: Page,
  colors: readonly Rgb[],
  boxes: ReadonlyArray<Box | null> = [],
): Promise<Drawn[]> =>
  page.evaluate(([c, b]) => (window as unknown as SceneWindow).t.frame(c, b), [
    colors,
    boxes,
  ] as unknown as [number[][], number[][]]);

/** The next frame, without waiting for the work of the drawing (a state that soon goes) */
export const quickFrame = (
  page: Page,
  colors: readonly Rgb[],
  boxes: ReadonlyArray<Box | null> = [],
): Promise<Drawn[]> =>
  page.evaluate(([c, b]) => (window as unknown as SceneWindow).t.quickFrame(c, b), [
    colors,
    boxes,
  ] as unknown as [number[][], number[][]]);

/** The pixels of each color of the image of the map (`draw.captureImage`) */
export const capture = (page: Page, colors: readonly Rgb[]): Promise<Drawn[]> =>
  page.evaluate(
    (c) => (window as unknown as SceneWindow).t.capture(c),
    colors as unknown as number[][],
  );

/** The answers of the hit test over a grid of the map, held to the frame */
export interface Agreement {
  /** The points where only the colors of a feature are drawn around */
  inside: number;
  /** The points where nothing of the features is drawn near */
  outside: number;
  /** The points inside where no feature was hit (the map point, and what was hit) */
  missedInside: Array<[number, number, string | null]>;
  /** The points outside where a feature was hit */
  hitOutside: Array<[number, number, string | null]>;
  /** The features hit at the points inside */
  ids: string[];
}

/**
 * The answers of the hit test over a grid of the map (a point every `step` CSS pixels), held to
 * the next frame: a feature is hit where only `inside` colors are drawn around the point, and
 * none where nothing of `drawn` is drawn near it
 */
export const agreement = (
  page: Page,
  inside: readonly Rgb[],
  drawn: readonly Rgb[],
  step = 16,
): Promise<Agreement> =>
  page.evaluate(([i, d, s]) => (window as unknown as SceneWindow).t.agreement(i, d, s as number), [
    inside,
    drawn,
    step,
  ] as unknown as [number[][], number[][], number]);

/** The topmost thing at a point of the map, as the hit test of a mode answers it */
export const hitAt = (page: Page, point: MapPoint): Promise<HitAnswer | null> =>
  page.evaluate((p) => (window as unknown as SceneWindow).t.hit(p), point as number[]);

/** The feature at a point of the map (null for nothing, or what is not a feature) */
export async function featureAt(page: Page, point: MapPoint): Promise<string | null> {
  const hit = await hitAt(page, point);
  return hit?.kind === 'feature' ? hit.id : null;
}

/** Forgets the events recorded so far */
export const mark = (page: Page): Promise<void> =>
  page.evaluate(() => (window as unknown as SceneWindow).t.mark());

/** The events recorded since the last mark */
export const events = (page: Page): Promise<Recorded[]> =>
  page.evaluate(() => (window as unknown as SceneWindow).t.events());

/** The events of a name recorded since the last mark */
export async function eventsNamed(page: Page, name: string): Promise<Recorded[]> {
  return (await events(page)).filter((e) => e.name === name);
}

/**
 * The events of the features and the drags recorded, in order, as short words: `U` and `I` for a
 * feature updated (final and intermediate) followed by its ID, `D` for a change of the document,
 * and the drags with their kind (the snaps and the selection of vertices left out)
 */
export function sequenceOf(recorded: readonly Recorded[]): string[] {
  const out: string[] = [];
  for (const e of recorded) {
    if (e.name === 'feature.updated') out.push(`${e.intermediate ? 'I' : 'U'} ${e.id}`);
    else if (e.name === 'document.changed') out.push('D');
    else if (e.name === 'drag.started') out.push(`start ${e.kind}`);
    else if (e.name === 'drag.ended') out.push(`end ${e.kind}${e.cancelled ? ' cancelled' : ''}`);
    else if (e.name === 'feature.created') out.push(`created ${e.id}`);
    else if (e.name === 'feature.deleted') out.push(`deleted ${e.id}`);
  }
  return out;
}

/** A sequence repeated */
export const times = (n: number, sequence: readonly string[]): string[] =>
  Array.from({ length: n }, () => sequence).flat();

/** Selects features (none: clears the selection) */
export const select = (page: Page, ids: string[]): Promise<void> =>
  page.evaluate((i) => {
    const draw = (window as unknown as SceneWindow).draw;
    if (i.length === 0) draw.selection.clear();
    else draw.selection.set('feature', i);
  }, ids);

/**
 * The geometry of a feature as the document holds it (`features.get`), or as it is drawn, with
 * the sketches applied (`rendered.get`)
 */
export const geometryOf = (
  page: Page,
  id: string,
  rendered = false,
): Promise<{ type: string; coordinates: unknown } | null> =>
  page.evaluate(
    ([i, a]) => {
      const draw = (window as unknown as SceneWindow).draw;
      const feature = a ? draw.rendered.get(i as string) : draw.features.get(i as string);
      return (feature?.geometry as { type: string; coordinates: unknown } | undefined) ?? null;
    },
    [id, rendered] as const,
  );

/** A value of the properties of a feature, as `features.get` reads it */
export const propertyOf = (page: Page, id: string, key: string): Promise<unknown> =>
  page.evaluate(
    ([i, k]) => {
      const draw = (window as unknown as SceneWindow).draw;
      return (draw.features.get(i as string)?.properties as Record<string, unknown> | undefined)?.[
        k as string
      ];
    },
    [id, key] as const,
  );

/** The cursor of the map canvas once the pointer is moved to a point of the map */
export async function cursorAt(page: Page, point: MapPoint): Promise<string> {
  const p = await pageOfMap(page, point);
  await page.mouse.move(p.x, p.y);
  await settle(page);
  return page.evaluate(() => (window as unknown as SceneWindow).map.getCanvas().style.cursor);
}

/** The point of the map (CSS pixels from its top left) where a coordinate is drawn */
export async function mapPointOf(page: Page, lngLat: readonly number[]): Promise<MapPoint> {
  return page.evaluate((c) => {
    const p = (window as unknown as SceneWindow).map.project(c as [number, number]);
    return [p.x, p.y] as MapPoint;
  }, lngLat as number[]);
}

/** The point of the page at a point of the map */
export async function pageOfMap(page: Page, point: MapPoint): Promise<PagePoint> {
  return page.evaluate((p) => {
    const rect = (window as unknown as SceneWindow).map.getCanvas().getBoundingClientRect();
    return { x: rect.left + (p[0] as number), y: rect.top + (p[1] as number) };
  }, point as number[]);
}

/** Presses at a point of the map, moves by a distance in steps, and leaves the button pressed */
export async function pressAndMove(
  page: Page,
  from: MapPoint,
  by: readonly [number, number],
  steps = 8,
): Promise<void> {
  const p = await pageOfMap(page, from);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + by[0], p.y + by[1], { steps });
  await settle(page);
}

/** Lets the button go, and waits for the frame */
export async function release(page: Page): Promise<void> {
  await page.mouse.up();
  await settle(page);
}

/** Presses Escape (with the button still pressed: the drag is cancelled), then lets go */
export async function cancelAndRelease(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await settle(page);
  await page.mouse.up();
  await settle(page);
}

/** Waits until the drawing has no work left (a write in steps, say) */
export async function idle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as SceneWindow;
    for (let i = 0; i < 200 && w.draw.hasPendingWork(); i++) {
      await new Promise<void>((resolve) => {
        w.map.once('render', () => resolve());
        w.map.triggerRepaint();
      });
    }
  });
  await settle(page);
}

/** The move of the center of the pixels of a color from one frame to another */
export function shiftOf(after: Drawn, before: Drawn): [number, number] {
  if (!after.center || !before.center) {
    throw new Error(`nothing drawn to compare: ${after.count} and ${before.count} pixels`);
  }
  return [after.center[0] - before.center[0], after.center[1] - before.center[1]];
}

/** A box moved by a distance and grown by a margin on each side */
export function movedBox(box: Box | null, by: readonly [number, number], margin = 4): Box {
  if (!box) throw new Error('no box to move');
  return [
    box[0] + by[0] - margin,
    box[1] + by[1] - margin,
    box[2] + by[0] + margin,
    box[3] + by[1] + margin,
  ];
}

/** The time a test of a page with several scenes may take */
export const SCENES_TIMEOUT = browserTimeout(240_000);
