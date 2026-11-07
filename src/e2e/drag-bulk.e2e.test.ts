// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of what every place that reads an edit in progress shows and answers, for the
 * drags and the arrow keys of many features selected at once, on the real maplibre and WebGL of
 * the browser
 *
 * Over the Store of rows of the library, opening at most 3 features for the selection, the five
 * features of the scene are selected in bulk: a drag moves, turns or resizes their rows by the
 * state of their rows (their moving set), written once let go, and the arrow keys move them by
 * the same set, written a moment after the last press. Over a Store of objects, the same features
 * are selected one by one and written in every frame. A move from a press on one of them, a
 * rotation and a resize from the handles of their frame, and the arrow keys; in the middle, once
 * let go (or written) and once cancelled with Escape:
 *
 * - the fills and the outlines drawn, and the frame of the selection and its handles
 * - the hit test, held over a grid of the map to the frame, and at the places of a feature before
 *   and after the edit
 * - the snapping: none of the features edited is a candidate of its own drag
 * - the events of the features, the document and the drags, with their marks of intermediate
 *   writes
 * - `features.get`, with the sketches applied and without
 * - the image of the map taken in the middle of a drag
 *
 * Every expectation is the behavior of the library as it is, to hold it while the places that
 * read an edit in progress are brought together.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import {
  agreement,
  at,
  type Box,
  cancelAndRelease,
  capture,
  cursorAt,
  type Drawn,
  events,
  featureAt,
  frame,
  geometryOf,
  hex,
  idle,
  KINDS,
  load,
  type MapPoint,
  mapPointOf,
  mark,
  openScenePage,
  pointLook,
  pressAndMove,
  type Recorded,
  type Rgb,
  release,
  SCENES_TIMEOUT,
  type SceneSpec,
  type StoreKind,
  select,
  sequenceOf,
  shiftOf,
  square,
} from './drag-scene.js';
import { type Bundle, bundlePage, launchBrowser } from './harness.js';

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

const ZOOM = 14;
const STEPS = 8;

const FILL: Rgb = [0xc2, 0x92, 0x10];
const OUTLINE: Rgb = [0x2d, 0x7f, 0xf9];
const FRAME: Rgb = [0xff, 0x00, 0xff];
const RESIZE: Rgb = [0x00, 0xc0, 0x00];
const ROTATE: Rgb = [0x80, 0x00, 0x00];
const VERTEX: Rgb = [0x00, 0x00, 0x80];
const COLORS = [FILL, OUTLINE, FRAME, RESIZE, ROTATE, VERTEX] as const;
const I_FILL = 0;
const I_OUTLINE = 1;
const I_FRAME = 2;
const I_RESIZE = 3;
const I_ROTATE = 4;
const I_VERTEX = 5;

const selectionStyle = {
  box: {
    stroke: { width: 2, color: hex(FRAME), opacity: 1, lineStyle: 'solid' },
    margin: 10,
  },
  resizeHandle: { point: pointLook('square', RESIZE, 10) },
  rotateHandle: {
    point: pointLook('circle', ROTATE, 10),
    distance: 10,
    connector: { width: 2, color: hex(FRAME), opacity: 1, lineStyle: 'solid' },
  },
  vertexHandle: {
    point: pointLook('square', VERTEX, 12),
    selected: pointLook('square', VERTEX, 12),
    followed: pointLook('square', VERTEX, 12),
  },
  midpointHandle: { point: pointLook('circle', VERTEX, 8) },
};

const LOOK = { fillColor: hex(FILL), fillOpacity: 1, strokeColor: hex(OUTLINE), strokeWidth: 4 };
const IDS = ['b0', 'b1', 'b2', 'b3', 'b4'];
const R = 0.001;
/** The squares of the features, side by side from west to east */
const SQUARES = IDS.map((_, i) => square(-0.006 + i * 0.003, 0, R));

const scene = (kind: StoreKind): SceneSpec => ({
  kind,
  features: IDS.map((id, i) => ({
    id,
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [SQUARES[i]] },
    style: LOOK,
  })),
  options: { selectionStyle },
  rowsOptions: { holdLimit: 3 },
});

/** The selection: its number and whether it is in bulk */
const selectionOf = (page: Page): Promise<{ bulk: boolean; count: number }> =>
  page.evaluate(() => {
    const draw = (window as unknown as { draw: import('../index.js').Draw }).draw;
    return { bulk: draw.selection.get().bulk !== undefined, count: draw.selection.count() };
  });

/** Writes the features back where the scene has them, nothing selected */
async function restore(page: Page): Promise<void> {
  await page.evaluate(
    ({ ids, squares, center, zoom }) => {
      const w = window as unknown as {
        draw: import('../index.js').Draw;
        map: import('maplibre-gl').Map;
      };
      w.draw.selection.clear();
      w.draw.transact(() => {
        ids.forEach((id, i) => {
          w.draw.features.update(id, {
            geometry: { type: 'Polygon', coordinates: [squares[i]] },
          } as never);
        });
      });
      w.map.jumpTo({ center, zoom });
    },
    { ids: IDS, squares: SQUARES, center: at(0, 0), zoom: ZOOM },
  );
  await idle(page);
}

/** The center of a feature of the scene, as the scene places it, on the map */
const centerOf = (page: Page, i: number): Promise<MapPoint> =>
  mapPointOf(page, at(-0.006 + i * 0.003, 0));

/** An edit of the features selected */
interface Edit {
  name: string;
  /** Where the drag starts, from the frame with the features selected */
  grab(page: Page, selected: Drawn[]): Promise<MapPoint>;
  by: [number, number];
  cursor: string;
  /** Whether it moves the features as a whole (by `by`) */
  moves: boolean;
}

const EDITS: Edit[] = [
  {
    name: 'a move from a press on one',
    // On the west edge of the second feature, off its corners
    grab: async (page) => {
      const [, y] = await centerOf(page, 1);
      const [x0] = await mapPointOf(page, SQUARES[1]?.[0] as number[]);
      return [x0, y - 8];
    },
    by: [40, 90],
    cursor: 'move',
    moves: true,
  },
  {
    name: 'a rotation from the rotate handle',
    grab: async (_page, selected) => (selected[I_ROTATE] as Drawn).center as MapPoint,
    by: [80, 60],
    cursor: 'grab',
    moves: false,
  },
  {
    name: 'a resize from the south-east handle',
    grab: async (_page, selected) => {
      const box = (selected[I_RESIZE] as Drawn).box as Box;
      return [box[2] - 4.5, box[3] - 4.5];
    },
    by: [30, 25],
    cursor: 'se-resize',
    moves: false,
  },
];

/** Whether a color is drawn otherwise than in another frame (moved, turned or of another size) */
function differs(a: Drawn, b: Drawn): boolean {
  if (!a.box || !b.box) return a.count !== b.count;
  const [dx, dy] = shiftOf(a, b);
  const box = a.box.some((v, i) => Math.abs(v - (b.box as Box)[i]!) > 3);
  return box || Math.hypot(dx, dy) > 3 || Math.abs(a.count - b.count) > b.count * 0.03;
}

/** The snaps told after the drag started: none of them is to a feature edited */
function expectNoSnapToThemselves(recorded: readonly Recorded[]): void {
  const snaps = recorded.filter((e) => e.name === 'snap.changed');
  expect(snaps.filter((e) => IDS.includes(e.snapFeature ?? ''))).toEqual([]);
}

/** What the reads give at a moment of an edit */
interface Reads {
  drawn: Drawn[];
  geometry: unknown;
  sketched: unknown;
  hits: Awaited<ReturnType<typeof agreement>>;
  /** The feature hit at the center of the second feature before the edit */
  hitBefore: string | null;
  events: Recorded[];
  selection: { bulk: boolean; count: number };
}

async function readAll(page: Page): Promise<Reads> {
  const drawn = await frame(page, COLORS);
  return {
    drawn,
    geometry: await geometryOf(page, 'b1'),
    sketched: await geometryOf(page, 'b1', true),
    hits: await agreement(page, [FILL], [FILL, OUTLINE]),
    hitBefore: await featureAt(page, await centerOf(page, 1)),
    events: await events(page),
    selection: await selectionOf(page),
  };
}

/** Within a tolerance (pixels) of another point on each axis */
function expectNear(
  actual: readonly number[] | null,
  expected: readonly number[],
  tolerance = 1.5,
): void {
  expect(actual).not.toBeNull();
  const a = actual as number[];
  expect(Math.abs((a[0] as number) - (expected[0] as number))).toBeLessThan(tolerance);
  expect(Math.abs((a[1] as number) - (expected[1] as number))).toBeLessThan(tolerance);
}

/** About as many pixels of a color as another frame drew, about where it drew them */
function expectSame(actual: Drawn, expected: Drawn, share = 0.03, tolerance = 1.5): void {
  if (expected.count === 0) {
    expect(actual.count).toBe(0);
    return;
  }
  expect(Math.abs(actual.count - expected.count)).toBeLessThanOrEqual(expected.count * share);
  expectNear(actual.center, expected.center as MapPoint, tolerance);
}

/** The hit test answers as the frame draws: each feature where it is drawn, none elsewhere */
function expectHitsAsDrawn(hits: Reads['hits']): void {
  expect(hits.inside).toBeGreaterThan(20);
  expect(hits.outside).toBeGreaterThan(500);
  expect(hits.missedInside).toEqual([]);
  expect(hits.hitOutside).toEqual([]);
  expect(hits.ids).toEqual(IDS);
}

/** The features hit at their centers as the scene places them (before any edit) */
async function hitsAtTheirPlaces(page: Page): Promise<Array<string | null>> {
  const out: Array<string | null> = [];
  for (let i = 0; i < IDS.length; i++) out.push(await featureAt(page, await centerOf(page, i)));
  return out;
}

/** The events of the features written in the middle of a drag: each step writes all of them */
const stepWrites = (prefix: 'I' | 'U'): string[] => [...IDS.map((id) => `${prefix} ${id}`), 'D'];

/** The number of rows each `document.changed` tells written */
const rowsWritten = (recorded: readonly Recorded[]): number[] =>
  recorded.filter((e) => e.name === 'document.changed').map((e) => e.rows ?? 0);

describe.each(KINDS)('many features selected over a Store of %s', (kind) => {
  let page: Page;
  /** Selected in bulk over the Store of rows (one by one over a Store of objects) */
  const bulk = kind === 'rows';

  beforeAll(async () => {
    page = await openScenePage(browser, bundle, ZOOM);
    // One instance for every test: a new instance over a Store of rows builds its programs again
    await load(page, scene(kind), ZOOM);
  }, browserTimeout(90_000));

  afterAll(async () => {
    await page?.close();
  });

  /** Selects the features of the scene where it places them, and reads them so */
  async function selectAll(): Promise<Reads> {
    await restore(page);
    await select(page, IDS);
    const selected = await readAll(page);
    expect(selected.selection).toEqual({ bulk, count: IDS.length });
    expectHitsAsDrawn(selected.hits);
    return selected;
  }

  describe.each(EDITS)('$name', (edit) => {
    /** The drag from the frame of the features selected, read in its middle and once it ended */
    async function run(cancelled: boolean) {
      const selected = await selectAll();
      const grabbed = await edit.grab(page, selected.drawn);
      // The hit test of the handles: the cursor over where the drag starts. A press in the frame
      // of features selected in bulk moves them, and the cursor is the one over the feature
      // under the pointer
      const cursor = edit.cursor === 'move' && bulk ? 'pointer' : edit.cursor;
      expect(await cursorAt(page, grabbed)).toBe(cursor);
      await mark(page);
      await pressAndMove(page, grabbed, edit.by, STEPS);
      const mid = await readAll(page);
      const places = await hitsAtTheirPlaces(page);
      const [cx, cy] = await centerOf(page, 1);
      const movedHit = await featureAt(page, [cx + edit.by[0], cy + edit.by[1]]);
      const image = await capture(page, [FILL]);
      await mark(page);
      if (cancelled) await cancelAndRelease(page);
      else await release(page);
      await idle(page);
      const end = await readAll(page);
      expect(end.selection).toEqual({ bulk, count: IDS.length });

      // The middle: drawn as it goes, the frame with them
      const started = edit.moves ? 'feature' : 'handle';
      expect(differs(mid.drawn[I_FILL] as Drawn, selected.drawn[I_FILL] as Drawn)).toBe(true);
      expect((mid.drawn[I_OUTLINE] as Drawn).count).toBeGreaterThan(1000);
      expect((mid.drawn[I_FRAME] as Drawn).count).toBeGreaterThan(1000);
      if (edit.moves) {
        for (const i of [I_FILL, I_OUTLINE, I_FRAME]) {
          expectNear(shiftOf(mid.drawn[i] as Drawn, selected.drawn[i] as Drawn), edit.by);
        }
      }
      // The handles in the middle: the resize handles of a resize, the rotate handle of a
      // rotation, none of a move; never the handles of the vertices
      const shown = edit.name.includes('resize') ? I_RESIZE : edit.moves ? null : I_ROTATE;
      for (const i of [I_RESIZE, I_ROTATE, I_VERTEX]) {
        if (i === shown) {
          expect(
            Math.abs((mid.drawn[i] as Drawn).count - (selected.drawn[i] as Drawn).count),
          ).toBeLessThanOrEqual((selected.drawn[i] as Drawn).count * 0.1);
        } else {
          expect((mid.drawn[i] as Drawn).count, `the pixels of the handles of color ${i}`).toBe(0);
        }
      }
      // The image taken in the middle of the drag shows the features where they are dragged.
      // This holds the behavior as it is, which nothing decides yet: it may change later
      expectSame(image[0] as Drawn, mid.drawn[I_FILL] as Drawn, 0.05);
      // The rows of a bulk drag are seen where they are drawn, and read where they are written
      if (!bulk) expect(mid.sketched).toEqual(mid.geometry);
      expectNoSnapToThemselves(
        mid.events.slice(mid.events.findIndex((e) => e.name === 'drag.started') + 1),
      );
      if (bulk) {
        // Their rows are drawn moved by their state and written once let go: read, hit and told
        // as they were before the drag in its middle (this holds the behavior as it is)
        expect(mid.geometry).toEqual(selected.geometry);
        expect(places).toEqual(IDS);
        if (edit.moves) expect(movedHit).toBeNull();
        expect(sequenceOf(mid.events)).toEqual([`start ${started}`]);
      } else {
        expect(mid.geometry).not.toEqual(selected.geometry);
        expectHitsAsDrawn(mid.hits);
        if (edit.moves) expect(movedHit).toBe('b1');
        expect(sequenceOf(mid.events)).toEqual([
          `start ${started}`,
          ...Array.from({ length: STEPS - 1 }, () => stepWrites('I')).flat(),
        ]);
      }
      return { selected, mid, end };
    }

    it('is drawn, hit and read in its middle as the Store shows it, and written once let go', {
      timeout: SCENES_TIMEOUT,
    }, async () => {
      const { selected, mid, end } = await run(false);
      const started = edit.moves ? 'feature' : 'handle';
      expect(end.geometry).not.toEqual(selected.geometry);
      if (!bulk) expect(end.geometry).toEqual(mid.geometry);
      expect(end.sketched).toEqual(end.geometry);
      expectSame(end.drawn[I_FILL] as Drawn, mid.drawn[I_FILL] as Drawn);
      expectSame(end.drawn[I_OUTLINE] as Drawn, mid.drawn[I_OUTLINE] as Drawn);
      expect((end.drawn[I_FRAME] as Drawn).count).toBeGreaterThan(1000);
      expect((end.drawn[I_RESIZE] as Drawn).count).toBe((selected.drawn[I_RESIZE] as Drawn).count);
      expect((end.drawn[I_ROTATE] as Drawn).count).toBeGreaterThan(50);
      expectHitsAsDrawn(end.hits);
      if (bulk) {
        expect(sequenceOf(end.events)).toEqual(['D', `end ${started}`]);
        expect(rowsWritten(end.events)).toEqual([IDS.length]);
      } else {
        expect(sequenceOf(end.events)).toEqual([...stepWrites('U'), `end ${started}`]);
      }
    });

    it('is drawn, hit and read in its middle as the Store shows it, and as before once cancelled', {
      timeout: SCENES_TIMEOUT,
    }, async () => {
      const { selected, end } = await run(true);
      const started = edit.moves ? 'feature' : 'handle';
      expect(end.geometry).toEqual(selected.geometry);
      expect(end.sketched).toEqual(end.geometry);
      for (const i of [I_FILL, I_OUTLINE, I_FRAME, I_RESIZE, I_ROTATE, I_VERTEX]) {
        expectSame(end.drawn[i] as Drawn, selected.drawn[i] as Drawn, 0.05);
      }
      expectHitsAsDrawn(end.hits);
      if (bulk) {
        // Nothing was written: the moving set is let go of
        expect(sequenceOf(end.events)).toEqual([`end ${started} cancelled`]);
      } else {
        expect(sequenceOf(end.events)).toEqual([...stepWrites('I'), `end ${started} cancelled`]);
      }
    });
  });

  describe('the arrow keys', () => {
    /** Three presses of Shift and an arrow key (20 px east and 10 px south), read right after */
    async function run() {
      const selected = await selectAll();
      await page.evaluate(() =>
        (window as unknown as { map: import('maplibre-gl').Map }).map.getCanvas().focus(),
      );
      await mark(page);
      // Out of the east edge of the second feature, past the tolerance of a click: in it once it
      // moved 20 px east
      const [x1] = await mapPointOf(page, SQUARES[1]?.[1] as number[]);
      const [, y] = await centerOf(page, 1);
      const edge: MapPoint = [x1 + 12, y];
      expect(await featureAt(page, edge)).toBeNull();
      const mid = await page.evaluate(
        async ({ colors, point }) => {
          const w = window as unknown as {
            draw: import('../index.js').Draw;
            map: import('maplibre-gl').Map;
            t: {
              quickFrame(c: unknown, b: unknown): Promise<Drawn[]>;
              hit(p: number[]): { kind: string; id: string } | null;
            };
          };
          // Dispatched on the canvas and read in the same task of the test, so that the reads
          // come well before the moves of the keys are written
          const canvas = w.map.getCanvas();
          for (const key of ['ArrowRight', 'ArrowRight', 'ArrowDown']) {
            const init = { key, shiftKey: true, bubbles: true };
            canvas.dispatchEvent(new KeyboardEvent('keydown', init));
            canvas.dispatchEvent(new KeyboardEvent('keyup', init));
          }
          const geometry = w.draw.features.get('b1')?.geometry ?? null;
          const hit = w.t.hit(point)?.id ?? null;
          const drawn = await w.t.quickFrame(colors, []);
          const after = w.draw.features.get('b1')?.geometry ?? null;
          return {
            drawn,
            geometry,
            hit,
            unchanged: JSON.stringify(after) === JSON.stringify(geometry),
          };
        },
        { colors: COLORS as unknown as number[][], point: edge },
      );
      const midEvents = await events(page);
      // Drawn moved by the presses, the frame and the handles with them
      for (const i of [I_FILL, I_OUTLINE, I_FRAME, I_RESIZE, I_ROTATE]) {
        expect((mid.drawn[i] as Drawn).count).toBe((selected.drawn[i] as Drawn).count);
        expectNear(shiftOf(mid.drawn[i] as Drawn, selected.drawn[i] as Drawn), [20, 10], 1);
      }
      // Nothing was written while the reads were made
      expect(mid.unchanged).toBe(true);
      if (bulk) {
        // Shown by the moving set and not written yet: read, hit and told as before the presses
        // (this holds the behavior as it is)
        expect(mid.geometry).toEqual(selected.geometry);
        expect(mid.hit).toBeNull();
        expect(sequenceOf(midEvents)).toEqual([]);
      } else {
        // Each press written at once
        expect(mid.geometry).not.toEqual(selected.geometry);
        expect(mid.hit).toBe('b1');
        expect(sequenceOf(midEvents)).toEqual([
          ...stepWrites('U'),
          ...stepWrites('U'),
          ...stepWrites('U'),
        ]);
      }
      await mark(page);
      return { selected, mid, edge };
    }

    it('moves the features at once, shown as the Store shows them, and written', {
      timeout: SCENES_TIMEOUT,
    }, async () => {
      const { selected, mid, edge } = await run();
      // Past the moment the moves of the keys held are written
      await page.waitForTimeout(400);
      await idle(page);
      const end = await readAll(page);
      expect(end.selection).toEqual({ bulk, count: IDS.length });
      for (const i of [I_FILL, I_OUTLINE, I_FRAME, I_RESIZE, I_ROTATE]) {
        expectSame(end.drawn[i] as Drawn, mid.drawn[i] as Drawn, 0.01, 1);
      }
      expect(end.geometry).not.toEqual(selected.geometry);
      expectHitsAsDrawn(end.hits);
      expect(await featureAt(page, edge)).toBe('b1');
      if (bulk) {
        // Written once, a moment after the last press
        expect(sequenceOf(end.events)).toEqual(['D']);
        expect(rowsWritten(end.events)).toEqual([IDS.length]);
      } else {
        expect(sequenceOf(end.events)).toEqual([]);
        expect(end.geometry).toEqual(mid.geometry);
      }
    });

    it('moves the features at once, and Escape writes them and clears the selection', {
      timeout: SCENES_TIMEOUT,
    }, async () => {
      const { selected, mid } = await run();
      await page.keyboard.press('Escape');
      await idle(page);
      const end = await readAll(page);
      expect(end.selection).toEqual({ bulk: false, count: 0 });
      for (const i of [I_FILL, I_OUTLINE]) {
        expectSame(end.drawn[i] as Drawn, mid.drawn[i] as Drawn, 0.01, 1);
      }
      for (const i of [I_FRAME, I_RESIZE, I_ROTATE]) expect((end.drawn[i] as Drawn).count).toBe(0);
      expect(end.geometry).not.toEqual(selected.geometry);
      expectHitsAsDrawn(end.hits);
      if (bulk) {
        // The moves waiting are written before the selection is cleared
        expect(sequenceOf(end.events)).toEqual(['D']);
        expect(rowsWritten(end.events)).toEqual([IDS.length]);
      } else {
        expect(sequenceOf(end.events)).toEqual([]);
        expect(end.geometry).toEqual(mid.geometry);
      }
    });
  });
});
