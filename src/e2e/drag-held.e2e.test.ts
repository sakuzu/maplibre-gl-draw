// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of what every place that reads an edit in progress shows and answers, for a
 * drag of many features selected one by one, on the real maplibre and WebGL of the browser
 *
 * A hundred small squares are in the scene; 99 of them or all of them are selected. A move from a
 * press on one of them, and a rotation from the rotate handle of their frame, are shown by a sketch
 * whatever their number, and written once let go: over the Store of rows of the library their rows
 * are held as features and drawn moved by the moving set of the sketch. A handle of a handle
 * provider in the middle of one square selected alone moves the square as a whole, with the others
 * held besides up to 99 or 100 rows, and is shown by a sketch too. In the middle, once let go and
 * once cancelled with Escape:
 *
 * - the fills and the outlines drawn, and the frames of the selection and its handles
 * - the hit test, held over a grid of the map to the frame
 * - the snapping: none of the features dragged is a candidate of its own drag, from its start on
 * - the events of the features, the document and the drags
 * - `features.get`, which reads the document, and `rendered.get`, which reads what is drawn
 * - the image of the map taken in the middle of a drag
 *
 * Every expectation is the behavior of the library as it is, to hold it while the places that
 * read an edit in progress are brought together, but for the snap of the start of a drag: it
 * leaves out what the drag changes, as the snaps of its middle do.
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
/** The fill and the outline of the last square, the one left out of the selection of 99 */
const LAST: Rgb = [0x90, 0x20, 0xc0];
const FRAME: Rgb = [0xff, 0x00, 0xff];
const RESIZE: Rgb = [0x00, 0xc0, 0x00];
const ROTATE: Rgb = [0x80, 0x00, 0x00];
/** The fill of the first square, the one a handle of a handle provider moves */
const FIRST: Rgb = [0x10, 0xa0, 0x50];
const COLORS = [FILL, OUTLINE, LAST, FRAME, RESIZE, ROTATE, FIRST] as const;
const I_FILL = 0;
const I_OUTLINE = 1;
const I_LAST = 2;
const I_FRAME = 3;
const I_RESIZE = 4;
const I_ROTATE = 5;
const I_FIRST = 6;

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
  // Small, so that the handles of a square selected alone (and the handle of a handle provider,
  // drawn with their look) leave its fill seen
  vertexHandle: {
    point: pointLook('square', FRAME, 4),
    selected: pointLook('square', FRAME, 4),
    followed: pointLook('square', FRAME, 4),
  },
  midpointHandle: { point: pointLook('circle', FRAME, 4) },
};

/**
 * The squares: ten rows of ten, about 14 px across and 33 px apart, so that the frame of the
 * selection around each (square to the screen, the margin out) stays off the squares beside it
 */
const COUNT = 100;
const IDS = Array.from({ length: COUNT }, (_, i) => `s${i}`);
const SQUARES = IDS.map((_, i) =>
  square(-0.0063 + (i % 10) * 0.0014, 0.0054 - Math.floor(i / 10) * 0.0012, 0.0003),
);

const scene = (kind: StoreKind): SceneSpec => ({
  kind,
  features: IDS.map((id, i) => ({
    id,
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [SQUARES[i]] },
    style: {
      fillColor: hex(i === COUNT - 1 ? LAST : i === 0 ? FIRST : FILL),
      fillOpacity: 1,
      strokeColor: hex(i === COUNT - 1 ? LAST : OUTLINE),
      strokeWidth: 2,
    },
  })),
  options: { selectionStyle },
});

/** How long after the selection is cleared the rows held for it are let go of (ms) */
const RELEASE_DELAY_MS = 100;

/** Writes the squares back where the scene has them, nothing selected and nothing held */
async function restore(page: Page): Promise<void> {
  await page.evaluate(
    ({ ids, squares, center, zoom }) => {
      const w = window as unknown as {
        draw: import('../index.js').Draw;
        map: import('maplibre-gl').Map;
      };
      w.draw.selection.clear();
      // The rows held for a selection are let go of a moment after it is cleared
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
  await page.waitForTimeout(RELEASE_DELAY_MS + 50);
  await idle(page);
}

/** The number of rows held as features (none over a Store of objects) */
const heldCount = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const w = window as unknown as {
      store: import('../index.js').Store;
      e2e: {
        internals: {
          featureTablesInternals: typeof import('../feature-table/feature-tables.js').featureTablesInternals;
        };
      };
    };
    return w.e2e.internals.featureTablesInternals(w.store.tables)?.heldCount ?? 0;
  });

/** A drag of the squares selected */
interface Edit {
  name: string;
  grab(page: Page, selected: Drawn[]): Promise<MapPoint>;
  by: [number, number];
  moves: boolean;
}

const EDITS: Edit[] = [
  {
    name: 'a move from a press on one',
    // The middle of the first square, up and to the left: no square goes over the last one (in
    // the corner down and to the right), which the selection of 99 leaves where it is
    grab: (page) => mapPointOf(page, at(-0.0063, 0.0054)),
    by: [-40, -30],
    moves: true,
  },
  {
    name: 'a rotation from the rotate handle',
    grab: async (_page, selected) => (selected[I_ROTATE] as Drawn).center as MapPoint,
    by: [30, 0],
    moves: false,
  },
];

/** The cases: the number of squares selected, and the drag */
const CASES = [
  { selected: 99, edit: EDITS[0] as Edit },
  { selected: 100, edit: EDITS[0] as Edit },
  { selected: 100, edit: EDITS[1] as Edit },
];

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

/** Whether a color is drawn otherwise than in another frame (moved, turned or of another size) */
function differs(a: Drawn, b: Drawn): boolean {
  if (!a.box || !b.box) return a.count !== b.count;
  const [dx, dy] = shiftOf(a, b);
  const box = a.box.some((v, i) => Math.abs(v - (b.box as Box)[i]!) > 3);
  return box || Math.hypot(dx, dy) > 3 || Math.abs(a.count - b.count) > b.count * 0.03;
}

/** What the reads give at a moment of a drag */
interface Reads {
  drawn: Drawn[];
  first: unknown;
  firstSketched: unknown;
  last: unknown;
  lastSketched: unknown;
  events: Recorded[];
}

async function readAll(page: Page): Promise<Reads> {
  return {
    drawn: await frame(page, COLORS),
    first: await geometryOf(page, IDS[0] as string),
    firstSketched: await geometryOf(page, IDS[0] as string, true),
    last: await geometryOf(page, IDS[COUNT - 1] as string),
    lastSketched: await geometryOf(page, IDS[COUNT - 1] as string, true),
    events: await events(page),
  };
}

/** The hit test answers as the frame draws: the squares where they are drawn, none elsewhere */
async function expectHitsAsDrawn(page: Page, moment: string): Promise<void> {
  const answers = await agreement(page, [FILL, LAST, FIRST], [FILL, LAST, FIRST, OUTLINE], 8);
  expect(answers.inside, moment).toBeGreaterThan(30);
  expect(answers.outside, moment).toBeGreaterThan(1000);
  expect(answers.missedInside, moment).toEqual([]);
  expect(answers.hitOutside, moment).toEqual([]);
  expect(answers.ids.length, moment).toBeGreaterThan(30);
}

/**
 * The hit test in the middle of a drag shown by a sketch leaves out what it edits: only the squares
 * left where they are are hit, nothing elsewhere
 */
async function expectLeftOut(page: Page, left: readonly string[]): Promise<void> {
  const answers = await agreement(page, [FILL, LAST, FIRST], [FILL, LAST, FIRST, OUTLINE], 8);
  expect(answers.inside).toBeGreaterThan(30);
  expect(answers.hitOutside).toEqual([]);
  expect(answers.ids).toEqual(left);
}

/** The events of each kind, counted: the features updated and the rest */
function counted(recorded: readonly Recorded[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of sequenceOf(recorded)) {
    const key = e.startsWith('U ') ? 'U' : e;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** Holds rows of the Store of rows as features for an owner of the test, without a selection */
const hold = (page: Page, ids: string[]): Promise<void> =>
  page.evaluate((i) => {
    const w = window as unknown as {
      store: import('../index.js').Store;
      e2e: {
        internals: {
          featureTablesInternals: typeof import('../feature-table/feature-tables.js').featureTablesInternals;
        };
      };
    };
    w.e2e.internals.featureTablesInternals(w.store.tables)?.open('e2e-held', i);
  }, ids);

/**
 * Registers a handle provider whose handle, in the middle of a square, moves it as a whole with
 * the pointer by one translation of its longitudes and latitudes
 */
async function registerShiftHandle(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Ring = number[][];
    const draw = (window as unknown as { draw: import('../index.js').Draw }).draw;
    let start: { rings: Ring[]; from: number[] } | null = null;
    draw.extensions.handleProviders.add({
      name: 'e2e-shift',
      handles(feature) {
        if (feature.geometry.type !== 'Polygon') return [];
        const ring = feature.geometry.coordinates[0] as Ring;
        let x = 0;
        let y = 0;
        for (const c of ring.slice(0, -1)) {
          x += c[0] as number;
          y += c[1] as number;
        }
        const n = ring.length - 1;
        return [{ id: 'h', kind: 'resize', position: [x / n, y / n], cursor: 'alias' }];
      },
      onHandleDragStart(feature, _handle, event) {
        if (feature?.geometry.type !== 'Polygon') return false;
        start = { rings: feature.geometry.coordinates as Ring[], from: event.lngLat as number[] };
        return true;
      },
      onHandleDrag(_feature, _handle, event) {
        if (!start) return null;
        const s = start;
        const dx = (event.lngLat[0] as number) - (s.from[0] as number);
        const dy = (event.lngLat[1] as number) - (s.from[1] as number);
        return {
          geometry: {
            type: 'Polygon',
            coordinates: s.rings.map((r) =>
              r.map((c) => [(c[0] as number) + dx, (c[1] as number) + dy]),
            ),
          },
        };
      },
      onHandleDragEnd() {
        start = null;
      },
    });
  });
}

describe.each(KINDS)('many features dragged over a Store of %s', (kind) => {
  let page: Page;

  beforeAll(async () => {
    page = await openScenePage(browser, bundle, ZOOM);
    // One instance for every test: a new instance over a Store of rows builds its programs again
    await load(page, scene(kind), ZOOM);
    // Its handle is drawn and grabbed on a feature selected alone (the cases of one square)
    await registerShiftHandle(page);
  }, browserTimeout(90_000));

  afterAll(async () => {
    await page?.close();
  });

  describe.each(CASES)('$selected selected, $edit.name', ({ selected: n, edit }) => {
    const ids = IDS.slice(0, n);
    /** Whether the last square goes with the drag */
    const lastMoves = n === COUNT;

    async function run(cancelled: boolean) {
      await restore(page);
      await select(page, ids);
      expect(await heldCount(page)).toBe(kind === 'rows' ? n : 0);
      const selected = await readAll(page);
      await expectHitsAsDrawn(page, 'selected');
      const grabbed = await edit.grab(page, selected.drawn);
      await mark(page);
      await pressAndMove(page, grabbed, edit.by, STEPS);
      const mid = await readAll(page);
      await expectLeftOut(page, lastMoves ? [] : [IDS[COUNT - 1] as string]);
      const image = await capture(page, [FILL]);
      await mark(page);
      if (cancelled) await cancelAndRelease(page);
      else await release(page);
      await idle(page);
      const end = await readAll(page);
      await expectHitsAsDrawn(page, 'once ended');

      // The middle: drawn as it goes, the frames with them, read and told so
      expect(differs(mid.drawn[I_FILL] as Drawn, selected.drawn[I_FILL] as Drawn)).toBe(true);
      expect((mid.drawn[I_FILL] as Drawn).count).toBeGreaterThan(10_000);
      expect((mid.drawn[I_FRAME] as Drawn).count).toBeGreaterThan(1000);
      if (edit.moves) {
        for (const i of [I_FILL, I_OUTLINE, I_FRAME]) {
          expectNear(shiftOf(mid.drawn[i] as Drawn, selected.drawn[i] as Drawn), edit.by);
        }
      }
      expect(differs(mid.drawn[I_LAST] as Drawn, selected.drawn[I_LAST] as Drawn)).toBe(lastMoves);
      expect((mid.drawn[I_RESIZE] as Drawn).count).toBe(0);
      expect((mid.drawn[I_ROTATE] as Drawn).count > 0).toBe(!edit.moves);
      // The image taken in the middle of the drag shows them where they are dragged. This holds
      // the behavior as it is, which nothing decides yet: it may change later
      expectSame(image[0] as Drawn, mid.drawn[I_FILL] as Drawn, 0.05);
      // Shown by a sketch: read as they were, and seen as they go
      expect(mid.first).toEqual(selected.first);
      expect(mid.last).toEqual(selected.last);
      expect(mid.firstSketched).not.toEqual(selected.first);
      expect(JSON.stringify(mid.lastSketched) !== JSON.stringify(selected.last)).toBe(lastMoves);
      // From the start of the drag on, the snap of its start included
      const snaps = mid.events.filter((e) => e.name === 'snap.changed');
      expect(snaps.filter((e) => ids.includes(e.snapFeature ?? ''))).toEqual([]);
      const started = edit.moves ? 'feature' : 'handle';
      expect(counted(mid.events)).toEqual({ [`start ${started}`]: 1 });
      return { selected, mid, end, started };
    }

    it('is drawn, hit and read as it goes in its middle, and as written once let go', {
      timeout: SCENES_TIMEOUT,
    }, async () => {
      const { mid, end, started } = await run(false);
      expect(end.first).toEqual(mid.firstSketched);
      expect(end.last).toEqual(mid.lastSketched);
      expectSame(end.drawn[I_FILL] as Drawn, mid.drawn[I_FILL] as Drawn);
      expectSame(end.drawn[I_LAST] as Drawn, mid.drawn[I_LAST] as Drawn);
      expect((end.drawn[I_RESIZE] as Drawn).count).toBeGreaterThan(100);
      expect(sequenceOf(end.events)).toEqual([
        ...ids.map((id) => `U ${id}`),
        'D',
        `end ${started}`,
      ]);
      expect(await heldCount(page)).toBe(kind === 'rows' ? n : 0);
    });

    it('is drawn, hit and read as it goes in its middle, and as before once cancelled', {
      timeout: SCENES_TIMEOUT,
    }, async () => {
      const { selected, end, started } = await run(true);
      expect(end.first).toEqual(selected.first);
      expect(end.last).toEqual(selected.last);
      for (const i of [I_FILL, I_OUTLINE, I_LAST, I_FRAME, I_RESIZE, I_ROTATE]) {
        expectSame(end.drawn[i] as Drawn, selected.drawn[i] as Drawn, 0.05);
      }
      // Nothing was written
      expect(sequenceOf(end.events)).toEqual([`end ${started} cancelled`]);
    });
  });

  describe.each([99, 100])('a handle of a handle provider on one square, %i rows held', (n) => {
    const BY: [number, number] = [-30, -20];
    /** The provider moves the square from where the drag started: a step after the press */
    const FOLLOWS: [number, number] = [
      (BY[0] * (STEPS - 1)) / STEPS,
      (BY[1] * (STEPS - 1)) / STEPS,
    ];

    async function run(cancelled: boolean) {
      await restore(page);
      // The first square selected, and the others held besides (over the Store of rows)
      await hold(page, IDS.slice(1, n));
      await select(page, [IDS[0] as string]);
      expect(await heldCount(page)).toBe(kind === 'rows' ? n : 0);
      const selected = await readAll(page);
      await expectHitsAsDrawn(page, 'selected');
      const grabbed = await mapPointOf(page, at(-0.0063, 0.0054));
      expect(await cursorAt(page, grabbed)).toBe('alias');
      await mark(page);
      await pressAndMove(page, grabbed, BY, STEPS);
      const mid = await readAll(page);
      await expectLeftOut(page, IDS.slice(1));
      const image = await capture(page, [FIRST]);
      await mark(page);
      if (cancelled) await cancelAndRelease(page);
      else await release(page);
      await idle(page);
      const end = await readAll(page);
      await expectHitsAsDrawn(page, 'once ended');
      await hold(page, []);

      // The middle: the square drawn as it goes, nothing written, and nothing else moved
      expectNear(shiftOf(mid.drawn[I_FIRST] as Drawn, selected.drawn[I_FIRST] as Drawn), FOLLOWS);
      expectSame(mid.drawn[I_FILL] as Drawn, selected.drawn[I_FILL] as Drawn, 0.01, 0.5);
      expectSame(mid.drawn[I_LAST] as Drawn, selected.drawn[I_LAST] as Drawn, 0.01, 0.5);
      expect((mid.drawn[I_FRAME] as Drawn).count).toBeGreaterThan(100);
      // The image taken in the middle of the drag shows it where it is dragged. This holds the
      // behavior as it is, which nothing decides yet: it may change later. The image has none of
      // the handles drawn over the square, so it shows all of its fill
      expect((image[0] as Drawn).box).toEqual((mid.drawn[I_FIRST] as Drawn).box);
      expectNear((image[0] as Drawn).center, (mid.drawn[I_FIRST] as Drawn).center as MapPoint);
      expect(mid.first).toEqual(selected.first);
      expect(mid.firstSketched).not.toEqual(selected.first);
      expect(mid.last).toEqual(selected.last);
      const snaps = mid.events.filter((e) => e.name === 'snap.changed');
      expect(snaps.filter((e) => e.snapFeature === IDS[0])).toEqual([]);
      expect(sequenceOf(mid.events)).toEqual([]);
      expect(end.firstSketched).toEqual(end.first);
      expectSame(end.drawn[I_FILL] as Drawn, selected.drawn[I_FILL] as Drawn, 0.01, 0.5);
      if (cancelled) {
        // Cancelled: nothing was written, and the square is drawn where it was
        expect(end.first).toEqual(selected.first);
        expectSame(end.drawn[I_FIRST] as Drawn, selected.drawn[I_FIRST] as Drawn);
        expect(sequenceOf(end.events)).toEqual([]);
        return;
      }
      // Let go: written as the middle showed it last
      expect(end.first).toEqual(mid.firstSketched);
      expectSame(end.drawn[I_FIRST] as Drawn, mid.drawn[I_FIRST] as Drawn);
      expect(sequenceOf(end.events)).toEqual([`U ${IDS[0]}`, 'D']);
    }

    it('is drawn, hit and read as it goes in its middle, and as written once let go', {
      timeout: SCENES_TIMEOUT,
    }, async () => {
      await run(false);
    });

    it('is drawn, hit and read as it goes in its middle, and as before once cancelled', {
      timeout: SCENES_TIMEOUT,
    }, async () => {
      await run(true);
    });
  });
});
