// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The end-to-end tests of what every place that reads an edit in progress shows and answers, for
 * each drag of one selected feature, over a Store of objects and over the Store of rows of the
 * library, on the real maplibre and WebGL of the browser (`describeDragReads`, called by a test
 * file for each group of drags, so that no file runs for long)
 *
 * The drags: a move (from a press on the outline), a rotation and a resize from the handles of the
 * frame, a vertex, a midpoint, the radius of a circle, and a handle of a handle provider; and the
 * arrow keys. In the middle of each drag, once let go and once cancelled with Escape:
 *
 * - the fill and the outline drawn, and the frame of the selection and its handles
 * - the hit test, held over a grid of the map to the frame (a feature is hit where it is drawn,
 *   nothing where nothing is drawn)
 * - the cursor over the handles (the hit test of the handles)
 * - the snapping: the feature being dragged is no candidate of its own drag, from its start on
 * - the events of the features and the drags, with their marks of intermediate writes
 * - `features.get`, with the sketches applied and without
 * - the selected vertices
 * - the image of the map taken in the middle of a drag
 *
 * Every expectation is the behavior of the library as it is, to hold it while the places that
 * read an edit in progress are brought together. The handles drawn at sizes and distances of their
 * own are hit where they are drawn.
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
  KINDS,
  load,
  type MapPoint,
  mapPointOf,
  mark,
  openScenePage,
  pointLook,
  pressAndMove,
  propertyOf,
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
  times,
} from './drag-scene.js';
import { type Bundle, bundlePage, launchBrowser, settle } from './harness.js';

let browser: Browser;
let bundle: Bundle;

const ZOOM = 14;
/** The steps of the moves of the pointer of a drag (the first only starts the drag) */
const STEPS = 8;

const FILL: Rgb = [0xc2, 0x92, 0x10];
const OUTLINE: Rgb = [0x2d, 0x7f, 0xf9];
const FRAME: Rgb = [0xff, 0x00, 0xff];
const RESIZE: Rgb = [0x00, 0xc0, 0x00];
const ROTATE: Rgb = [0x80, 0x00, 0x00];
const VERTEX: Rgb = [0x00, 0x00, 0x80];
const MIDPOINT: Rgb = [0x00, 0x80, 0x80];
const RADIUS: Rgb = [0x60, 0x30, 0x00];
const COLORS = [FILL, OUTLINE, FRAME, RESIZE, ROTATE, VERTEX, MIDPOINT, RADIUS] as const;
const I_FILL = 0;
const I_OUTLINE = 1;
const I_FRAME = 2;
const I_RESIZE = 3;
const I_ROTATE = 4;
const I_VERTEX = 5;
const I_MIDPOINT = 6;
const I_RADIUS = 7;
const HANDLES = [I_RESIZE, I_ROTATE, I_VERTEX, I_MIDPOINT, I_RADIUS];

/**
 * The colors of the selection UI, at its sizes and distances by default (the select mode hit tests
 * the handles at those, whatever the options draw)
 */
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
  midpointHandle: { point: pointLook('circle', MIDPOINT, 8) },
  radiusHandle: { point: pointLook('circle', RADIUS, 10) },
};

const LOOK = { fillColor: hex(FILL), fillOpacity: 1, strokeColor: hex(OUTLINE), strokeWidth: 4 };
const R = 0.004;
const CORNERS = square(0, 0, R);

const polygonScene = (kind: StoreKind): SceneSpec => ({
  kind,
  features: [
    {
      id: 'p',
      type: 'Polygon',
      geometry: { type: 'Polygon', coordinates: [CORNERS] },
      style: LOOK,
    },
  ],
  options: { selectionStyle },
});

const circleScene = (kind: StoreKind): SceneSpec => ({
  kind,
  features: [
    {
      id: 'p',
      type: 'Circle',
      geometry: { type: 'Point', coordinates: at(0, 0) },
      properties: { 'maplibre-gl-draw:radiusMeters': 300 },
      style: LOOK,
    },
  ],
  options: { selectionStyle },
});

/** A point of the map between two others */
const between = (a: MapPoint, b: MapPoint, t: number): MapPoint => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

/**
 * The groups of the tests, a test file each: the drags that move or turn the feature as a whole
 * and the arrow keys; the resizes and the radius of a circle; the drags of a vertex, a midpoint
 * and a handle of a handle provider; and the handles drawn at sizes and distances of their own
 */
export type DragReadsGroup = 'moves' | 'resizes' | 'vertices' | 'handles';

/** A drag of one feature */
interface Edit {
  name: string;
  /** The group of the tests it is in */
  group: DragReadsGroup;
  scene: (kind: StoreKind) => SceneSpec;
  /** Where the drag starts, from the frame with the feature selected */
  grab(page: Page, selected: Drawn[]): Promise<MapPoint>;
  by: [number, number];
  /** The cursor over where the drag starts */
  cursor: string;
  /** The kind of `drag.started` (null: none is told) */
  started: string | null;
  /** The handle drawn under the pointer in the middle of the drag */
  carried: number | null;
  /** The other handles drawn in the middle of the drag (the others are not drawn) */
  shown?: number[];
  /** What Escape leaves */
  escape: 'restored' | 'vertex added' | 'last patch written';
  /** Whether a vertex is selected before the drag (to see whether it stays selected) */
  vertexSelected?: boolean;
  /** How far the feature is moved as a whole, when it follows the pointer */
  follows?: [number, number];
  /** Registers what the drag needs on the instance */
  setup?(page: Page): Promise<void>;
}

/** The handle of a handle provider: moves the feature as a whole with the pointer */
async function registerShiftHandle(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Feature = import('../index.js').Feature;
    type Ring = number[][];
    const draw = (window as unknown as { draw: import('../index.js').Draw }).draw;
    let start: { rings: Ring[]; from: number[] } | null = null;
    draw.extensions.handleProviders.add({
      name: 'e2e-shift',
      handles(feature: Feature) {
        if (feature.geometry.type !== 'Polygon') return [];
        const ring = feature.geometry.coordinates[0] as Ring;
        let x = 0;
        let y = 0;
        for (const c of ring.slice(0, -1)) {
          x += c[0] as number;
          y += c[1] as number;
        }
        const n = ring.length - 1;
        return [{ id: 'h', kind: 'scale', position: [x / n, y / n - 0.002], cursor: 'alias' }];
      },
      onDragStart(feature, _handle, event) {
        if (feature?.geometry.type !== 'Polygon') return false;
        start = { rings: feature.geometry.coordinates as Ring[], from: event.lngLat as number[] };
        return true;
      },
      onDrag(_feature, _handle, event) {
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
      onDragEnd() {
        start = null;
      },
    });
  });
}

const EDITS: Edit[] = [
  {
    name: 'a move from a press on the outline',
    group: 'moves',
    scene: polygonScene,
    // A quarter of the way up the west edge: off the vertices and the midpoint, on the outline,
    // so that the pointer stays on an edge of the feature it moves
    grab: async (page) =>
      between(
        await mapPointOf(page, CORNERS[0] as number[]),
        await mapPointOf(page, CORNERS[3] as number[]),
        0.25,
      ),
    by: [120, 60],
    cursor: 'move',
    started: 'feature',
    carried: null,
    escape: 'restored',
    vertexSelected: true,
    follows: [120, 60],
  },
  {
    name: 'a rotation from the rotate handle',
    group: 'moves',
    scene: polygonScene,
    grab: async (_page, selected) => (selected[I_ROTATE] as Drawn).center as MapPoint,
    by: [80, 60],
    cursor: 'grab',
    started: 'handle',
    carried: null,
    shown: [I_ROTATE],
    escape: 'restored',
  },
  {
    name: 'a resize from the south-east handle',
    group: 'resizes',
    scene: polygonScene,
    grab: async (_page, selected) => {
      const box = (selected[I_RESIZE] as Drawn).box as Box;
      return [box[2] - 4.5, box[3] - 4.5];
    },
    by: [30, 25],
    cursor: 'se-resize',
    started: 'handle',
    carried: null,
    shown: [I_RESIZE],
    escape: 'restored',
  },
  {
    name: 'a resize inward from the south-east handle, over the corner of the feature',
    group: 'resizes',
    scene: polygonScene,
    grab: async (_page, selected) => {
      const box = (selected[I_RESIZE] as Drawn).box as Box;
      return [box[2] - 4.5, box[3] - 4.5];
    },
    // The pointer passes over the corner and along the edges of the feature it resizes
    by: [-40, -32],
    cursor: 'se-resize',
    started: 'handle',
    carried: null,
    shown: [I_RESIZE],
    escape: 'restored',
  },
  {
    name: 'a vertex',
    group: 'vertices',
    scene: polygonScene,
    grab: (page) => mapPointOf(page, CORNERS[2] as number[]),
    by: [30, -24],
    cursor: 'pointer',
    started: 'vertex',
    carried: I_VERTEX,
    escape: 'restored',
    vertexSelected: true,
  },
  {
    name: 'a midpoint',
    group: 'vertices',
    scene: polygonScene,
    grab: async (page) =>
      between(
        await mapPointOf(page, CORNERS[0] as number[]),
        await mapPointOf(page, CORNERS[1] as number[]),
        0.5,
      ),
    by: [0, 30],
    cursor: 'crosshair',
    started: 'vertex',
    carried: I_VERTEX,
    escape: 'vertex added',
  },
  {
    name: 'the radius of a circle',
    group: 'resizes',
    scene: circleScene,
    grab: async (_page, selected) => (selected[I_RADIUS] as Drawn).center as MapPoint,
    by: [40, 0],
    cursor: 'pointer',
    started: 'handle',
    carried: I_RADIUS,
    escape: 'restored',
  },
  {
    name: 'a handle of a handle provider',
    group: 'vertices',
    scene: polygonScene,
    setup: registerShiftHandle,
    grab: (page) => mapPointOf(page, at(0, -0.002)),
    by: [60, 30],
    cursor: 'alias',
    started: null,
    carried: null,
    shown: [I_RESIZE, I_ROTATE, I_VERTEX, I_MIDPOINT],
    escape: 'last patch written',
    // The provider moves it from where the drag started: a step of the pointer after the press
    follows: [(60 * (STEPS - 1)) / STEPS, (30 * (STEPS - 1)) / STEPS],
  },
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

/** The hit test answers as the frame draws: the feature where it is drawn, none elsewhere */
async function expectHitsAsDrawn(page: Page): Promise<void> {
  const answers = await agreement(page, [FILL], [FILL, OUTLINE]);
  expect(answers.inside).toBeGreaterThan(10);
  expect(answers.outside).toBeGreaterThan(100);
  expect(answers.missedInside).toEqual([]);
  expect(answers.hitOutside).toEqual([]);
  expect(answers.ids).toEqual(['p']);
}

/**
 * The snaps told from the press on, the snap of the start of the drag included: none of them is
 * to the feature being dragged
 */
function expectNoSnapToItself(recorded: readonly Recorded[]): void {
  const snaps = recorded.filter((e) => e.name === 'snap.changed');
  expect(snaps.filter((e) => e.snapFeature === 'p')).toEqual([]);
}

const vertexSelection = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { draw: import('../index.js').Draw }).draw.vertexSelection.get(),
  );

const SELECTED_VERTEX = { featureId: 'p', vertices: [{ ring: 0, index: 2 }] };

/** The number of positions of a geometry */
function positionsOf(geometry: unknown): number {
  let n = 0;
  const walk = (v: unknown): void => {
    if (Array.isArray(v) && typeof v[0] === 'number') n++;
    else if (Array.isArray(v)) for (const x of v) walk(x);
  };
  walk((geometry as { coordinates?: unknown } | null)?.coordinates);
  return n;
}

/** What a drag shows and answers before it, in its middle, and once it ended */
interface Run {
  grabbed: MapPoint;
  selected: Drawn[];
  geometry: unknown;
  radius: unknown;
  mid: Drawn[];
  midGeometry: unknown;
  midRadius: unknown;
  midEvents: Recorded[];
  image: Drawn[];
  end: Drawn[];
  endGeometry: unknown;
  endRadius: unknown;
  endEvents: Recorded[];
}

const RADIUS_KEY = 'maplibre-gl-draw:radiusMeters';

/**
 * Makes the scene of an edit, selects the feature, drags it and holds the reads in the middle of
 * the drag, then lets go or presses Escape and holds the reads once it ended
 */
async function run(page: Page, kind: StoreKind, edit: Edit, cancelled: boolean): Promise<Run> {
  await load(page, edit.scene(kind), ZOOM);
  await edit.setup?.(page);
  await select(page, ['p']);
  if (edit.vertexSelected) {
    await page.evaluate(
      (v) =>
        (window as unknown as { draw: import('../index.js').Draw }).draw.vertexSelection.set(
          v.featureId,
          v.vertices,
        ),
      SELECTED_VERTEX,
    );
  }
  const selected = await frame(page, COLORS);
  const geometry = await geometryOf(page, 'p');
  const radius = await propertyOf(page, 'p', RADIUS_KEY);
  const grabbed = await edit.grab(page, selected);
  // The hit test of the handles: the cursor over where the drag starts
  expect(await cursorAt(page, grabbed)).toBe(edit.cursor);

  await mark(page);
  await pressAndMove(page, grabbed, edit.by, STEPS);
  const mid = await frame(page, COLORS);
  const midGeometry = await geometryOf(page, 'p');
  expect(await geometryOf(page, 'p', true)).toEqual(midGeometry);
  const midRadius = await propertyOf(page, 'p', RADIUS_KEY);
  await expectHitsAsDrawn(page);
  const image = await capture(page, [FILL]);
  const midEvents = await events(page);
  if (edit.vertexSelected) expect(await vertexSelection(page)).toEqual(SELECTED_VERTEX);

  await mark(page);
  if (cancelled) await cancelAndRelease(page);
  else await release(page);
  const end = await frame(page, COLORS);
  const endGeometry = await geometryOf(page, 'p');
  expect(await geometryOf(page, 'p', true)).toEqual(endGeometry);
  const endRadius = await propertyOf(page, 'p', RADIUS_KEY);
  await expectHitsAsDrawn(page);
  const endEvents = await events(page);
  // A vertex selected stays selected, whether the drag is written or cancelled
  if (edit.vertexSelected) expect(await vertexSelection(page)).toEqual(SELECTED_VERTEX);
  for (const recorded of [midEvents, endEvents]) {
    expect(recorded.filter((e) => e.name === 'vertexSelection.changed')).toEqual([]);
  }
  return {
    grabbed,
    selected,
    geometry,
    radius,
    mid,
    midGeometry,
    midRadius,
    midEvents,
    image,
    end,
    endGeometry,
    endRadius,
    endEvents,
  };
}

/** What the middle of a drag shows and answers, whether it is then let go or cancelled */
function expectMiddle(edit: Edit, r: Run): void {
  // The feature is drawn as it is edited, and read so
  expect(differs(r.mid[I_FILL] as Drawn, r.selected[I_FILL] as Drawn)).toBe(true);
  expect(JSON.stringify([r.midGeometry, r.midRadius])).not.toBe(
    JSON.stringify([r.geometry, r.radius]),
  );
  expect((r.mid[I_OUTLINE] as Drawn).count).toBeGreaterThan(200);
  // The frame is drawn; the handles are not, but the one carried under the pointer and the ones
  // of the edit
  expect((r.mid[I_FRAME] as Drawn).count).toBeGreaterThan(200);
  for (const i of HANDLES) {
    const drawn = r.mid[i] as Drawn;
    if (i === edit.carried) {
      expect(drawn.count).toBeGreaterThan(50);
      expectNear(drawn.center, [r.grabbed[0] + edit.by[0], r.grabbed[1] + edit.by[1]], 2);
    } else if (edit.shown?.includes(i)) {
      expectSame(drawn, { ...(r.selected[i] as Drawn), center: drawn.center }, 0.1);
    } else {
      expect(drawn.count, `the pixels of the handle of color ${i}`).toBe(0);
    }
  }
  // The image taken in the middle of the drag shows the feature where it is dragged. This holds
  // the behavior as it is, which nothing decides yet: it may change later
  expectSame(r.image[0] as Drawn, r.mid[I_FILL] as Drawn, 0.05);
  // The events: a write in the middle for each move of the pointer after the first, which starts
  // the drag (a midpoint adds its vertex first, written)
  const started = edit.started ? [`start ${edit.started}`] : [];
  const inserted = edit.escape === 'vertex added' ? ['U p', 'D'] : [];
  expect(sequenceOf(r.midEvents)).toEqual([
    ...started,
    ...inserted,
    ...times(STEPS - 1, ['I p', 'D']),
  ]);
  expectNoSnapToItself(r.midEvents);
  expect(r.midEvents.filter((e) => e.name === 'preview.changed')).toEqual([]);
}

function describeDrags(group: DragReadsGroup): void {
  describe.each(KINDS)('a drag of one feature over a Store of %s', (kind) => {
    let page: Page;

    beforeAll(async () => {
      page = await openScenePage(browser, bundle, ZOOM);
    }, browserTimeout(60_000));

    afterAll(async () => {
      await page?.close();
    });

    describe.each(EDITS.filter((edit) => edit.group === group))('$name', (edit) => {
      it('is drawn, hit and read as it goes in its middle, and as written once let go', {
        timeout: SCENES_TIMEOUT,
      }, async () => {
        const r = await run(page, kind, edit, false);
        expectMiddle(edit, r);
        // Let go: written as the middle showed it last
        expect(r.endGeometry).toEqual(r.midGeometry);
        expect(r.endRadius).toEqual(r.midRadius);
        expectSame(r.end[I_FILL] as Drawn, r.mid[I_FILL] as Drawn);
        expect((r.end[I_FRAME] as Drawn).count).toBeGreaterThan(200);
        const ended = edit.started ? [`end ${edit.started}`] : [];
        expect(sequenceOf(r.endEvents)).toEqual(['U p', 'D', ...ended]);
        if (edit.follows) {
          // Moved as far as the pointer: no snap pulled it
          expectNear(shiftOf(r.end[I_FILL] as Drawn, r.selected[I_FILL] as Drawn), edit.follows);
          expectNear(shiftOf(r.end[I_FRAME] as Drawn, r.selected[I_FRAME] as Drawn), edit.follows);
        }
        // The handles are drawn again around the feature as written, and hit there
        expect((r.end[I_RESIZE] as Drawn).count).toBe((r.selected[I_RESIZE] as Drawn).count);
        const box = (r.end[I_RESIZE] as Drawn).box as Box;
        expect(await cursorAt(page, [box[2] - 4.5, box[3] - 4.5])).toBe('se-resize');
        const turn = edit.scene === polygonScene ? I_ROTATE : I_RADIUS;
        const handle = r.end[turn] as Drawn;
        expect(handle.count).toBeGreaterThan(50);
        expect(await cursorAt(page, handle.center as MapPoint)).toBe(
          turn === I_ROTATE ? 'grab' : 'pointer',
        );
      });

      it('is drawn, hit and read as it goes in its middle, and as before once cancelled', {
        timeout: SCENES_TIMEOUT,
      }, async () => {
        const r = await run(page, kind, edit, true);
        expectMiddle(edit, r);
        const ended = edit.started ? [`end ${edit.started} cancelled`] : [];
        if (edit.escape === 'last patch written') {
          // The handle of a provider takes the end of the drag as its last patch, written
          expect(r.endGeometry).toEqual(r.midGeometry);
          expectSame(r.end[I_FILL] as Drawn, r.mid[I_FILL] as Drawn);
          expect(sequenceOf(r.endEvents)).toEqual(['U p', 'D', ...ended]);
          return;
        }
        // The feature goes back in a write in the middle (and a Store of rows writes its row back)
        const back = kind === 'rows' ? ['I p', 'D', 'U p', 'D'] : ['I p', 'D'];
        expect(sequenceOf(r.endEvents)).toEqual([...back, ...ended]);
        expect(r.endRadius).toEqual(r.radius);
        expectSame(r.end[I_FILL] as Drawn, r.selected[I_FILL] as Drawn);
        expectSame(r.end[I_FRAME] as Drawn, r.selected[I_FRAME] as Drawn);
        if (edit.escape === 'vertex added') {
          // The vertex a midpoint added when it was grabbed stays, at the midpoint
          expect(positionsOf(r.endGeometry)).toBe(positionsOf(r.geometry) + 1);
          expect((r.end[I_VERTEX] as Drawn).count).toBeGreaterThan(
            (r.selected[I_VERTEX] as Drawn).count,
          );
        } else {
          expect(r.endGeometry).toEqual(r.geometry);
          for (const i of HANDLES) expectSame(r.end[i] as Drawn, r.selected[i] as Drawn, 0.05);
        }
      });
    });

    // The arrow keys move the feature as a whole, with the drags of the group that do
    if (group !== 'moves') return;

    it('moves the selection with the arrow keys, each press written at once', {
      timeout: SCENES_TIMEOUT,
    }, async () => {
      await load(page, polygonScene(kind), ZOOM);
      await select(page, ['p']);
      const selected = await frame(page, COLORS);
      // A click on the feature gives the canvas the focus of the keys
      await cursorAt(page, (selected[I_FILL] as Drawn).center as MapPoint);
      await page.mouse.down();
      await page.mouse.up();
      await settle(page);
      await mark(page);
      await page.keyboard.press('Shift+ArrowRight');
      await page.keyboard.press('Shift+ArrowDown');
      await settle(page);
      const moved = await frame(page, COLORS);
      expect(sequenceOf(await events(page))).toEqual(times(2, ['U p', 'D']));
      for (const i of [I_FILL, I_OUTLINE, I_FRAME, I_RESIZE, I_ROTATE, I_VERTEX, I_MIDPOINT]) {
        expect((moved[i] as Drawn).count).toBe((selected[i] as Drawn).count);
        expectNear(shiftOf(moved[i] as Drawn, selected[i] as Drawn), [10, 10], 1);
      }
      await expectHitsAsDrawn(page);
    });
  });
}

/** The handles at sizes and a distance and margin of their own, in the colors of the tests */
const largeSelectionStyle = {
  ...selectionStyle,
  box: { ...selectionStyle.box, margin: 20 },
  resizeHandle: { point: pointLook('square', RESIZE, 16) },
  rotateHandle: {
    ...selectionStyle.rotateHandle,
    point: pointLook('circle', ROTATE, 16),
    distance: 30,
  },
  vertexHandle: {
    point: pointLook('square', VERTEX, 18),
    selected: pointLook('square', VERTEX, 18),
    followed: pointLook('square', VERTEX, 18),
  },
  midpointHandle: { point: pointLook('square', MIDPOINT, 14) },
  radiusHandle: { point: pointLook('square', RADIUS, 16) },
};

function describeHandles(): void {
  describe.each(KINDS)(
    'the handles drawn at the sizes and distances of the options over a Store of %s',
    (kind) => {
      let page: Page;

      beforeAll(async () => {
        page = await openScenePage(browser, bundle, ZOOM);
      }, browserTimeout(60_000));

      afterAll(async () => {
        await page?.close();
      });

      /** The cursor over a point and over the points a little short of the corners of a handle */
      async function expectHandleAt(point: MapPoint, half: number, cursor: string): Promise<void> {
        for (const [dx, dy] of [
          [0, 0],
          [half - 2, half - 2],
          [-(half - 2), -(half - 2)],
        ] as const) {
          expect(await cursorAt(page, [point[0] + dx, point[1] + dy])).toBe(cursor);
        }
      }

      it('hits each handle of a polygon where it is drawn, and turns it from there', {
        timeout: SCENES_TIMEOUT,
      }, async () => {
        const scene = polygonScene(kind);
        await load(page, { ...scene, options: { selectionStyle: largeSelectionStyle } }, ZOOM);
        await select(page, ['p']);
        const selected = await frame(page, COLORS);
        const fill = (selected[I_OUTLINE] as Drawn).box as Box;
        const resize = (selected[I_RESIZE] as Drawn).box as Box;
        // The resize handles stand on the frame, the margin out of the outline
        expect(Math.abs(resize[2] - 8 - fill[2] - 20)).toBeLessThan(3);
        await expectHandleAt([resize[2] - 7.5, resize[3] - 7.5], 8, 'se-resize');
        await expectHandleAt([resize[0] + 7.5, resize[1] + 7.5], 8, 'nw-resize');
        const rotate = (selected[I_ROTATE] as Drawn).center as MapPoint;
        // The rotate handle stands above the frame
        expect(rotate[1]).toBeLessThan(resize[1]);
        await expectHandleAt(rotate, 8, 'grab');
        await expectHandleAt(await mapPointOf(page, CORNERS[2] as number[]), 9, 'pointer');
        const midpoint = between(
          await mapPointOf(page, CORNERS[0] as number[]),
          await mapPointOf(page, CORNERS[1] as number[]),
          0.5,
        );
        await expectHandleAt(midpoint, 7, 'crosshair');

        await mark(page);
        await pressAndMove(page, rotate, [80, 60], STEPS);
        await release(page);
        expect(sequenceOf(await events(page))[0]).toBe('start handle');
        const turned = await frame(page, COLORS);
        expect(differs(turned[I_OUTLINE] as Drawn, selected[I_OUTLINE] as Drawn)).toBe(true);
        expectNear(
          (turned[I_FILL] as Drawn).center,
          (selected[I_FILL] as Drawn).center as MapPoint,
        );
      });

      it('hits the radius handle of a circle where it is drawn', {
        timeout: SCENES_TIMEOUT,
      }, async () => {
        const scene = circleScene(kind);
        await load(page, { ...scene, options: { selectionStyle: largeSelectionStyle } }, ZOOM);
        await select(page, ['p']);
        const selected = await frame(page, COLORS);
        await expectHandleAt((selected[I_RADIUS] as Drawn).center as MapPoint, 8, 'pointer');
        const resize = (selected[I_RESIZE] as Drawn).box as Box;
        await expectHandleAt([resize[2] - 7.5, resize[3] - 7.5], 8, 'se-resize');
      });
    },
  );
}

/**
 * Registers the tests of a group of drags of one feature, over a Store of objects and over the
 * Store of rows, on a browser of their own
 */
export function describeDragReads(group: DragReadsGroup): void {
  beforeAll(async () => {
    [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
  }, browserTimeout(60_000));

  afterAll(async () => {
    await browser?.close();
  });

  if (group === 'handles') describeHandles();
  else describeDrags(group);
}
