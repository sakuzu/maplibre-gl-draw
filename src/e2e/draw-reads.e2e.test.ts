// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of what every place that reads a shape being drawn shows and answers, for each
 * drawing mode (a point, a line, a polygon, a circle and a freehand stroke), over a Store of
 * objects and over the Store of rows of the library, on the real maplibre and WebGL of the browser
 *
 * While the shape is drawn, once it is finished and once it is dropped with Escape:
 *
 * - the shape being drawn (its lines and its vertices) and the feature finished, drawn in their
 *   colors, and the frame of the selection around the feature finished
 * - the hit test: nothing where the shape being drawn is, the feature once finished
 * - the snapping: the pointer is pulled to another feature, and never to the shape being drawn
 * - the events of the shape being drawn (the sketch that shows it), of the features and the document
 * - `features.list` and `features.get`, and the mode
 * - the image of the map taken while the shape is drawn (without the shape)
 *
 * Every expectation is the behavior of the library as it is, to hold it while the places that
 * read an edit in progress are brought together.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import {
  at,
  capture,
  type Drawn,
  events,
  featureAt,
  frame,
  hex,
  KINDS,
  load,
  type MapPoint,
  mapPointOf,
  mark,
  openScenePage,
  pageOfMap,
  pointLook,
  type Recorded,
  type Rgb,
  SCENES_TIMEOUT,
  sequenceOf,
  square,
} from './drag-scene.js';
import { type Bundle, bundlePage, type E2EWrites, launchBrowser, settle } from './harness.js';

const ZOOM = 14;

const PREVIEW: Rgb = [0x10, 0xa0, 0x50];
const PREVIEW_VERTEX: Rgb = [0x00, 0x00, 0x80];
const LINE: Rgb = [0xc0, 0x30, 0x30];
const FILL: Rgb = [0xc2, 0x92, 0x10];
const OUTLINE: Rgb = [0x2d, 0x7f, 0xf9];
const POINT: Rgb = [0xe0, 0x60, 0x00];
const FRAME: Rgb = [0xff, 0x00, 0xff];
const OTHER: Rgb = [0x90, 0x20, 0xc0];
const COLORS = [PREVIEW, PREVIEW_VERTEX, LINE, FILL, OUTLINE, POINT, FRAME, OTHER] as const;
const I_PREVIEW = 0;
const I_PREVIEW_VERTEX = 1;
const I_LINE = 2;
const I_FILL = 3;
const I_OUTLINE = 4;
const I_POINT = 5;
const I_FRAME = 6;
const I_OTHER = 7;

/** The other feature: a square up and to the right of the center, a target of the snapping */
const OTHER_CORNERS = square(0.006, 0.003, 0.0015);

const options = {
  previewStyle: {
    strokeColor: hex(PREVIEW),
    strokeWidth: 4,
    pointColor: hex(PREVIEW_VERTEX),
    pointStrokeColor: hex(PREVIEW_VERTEX),
    pointRadius: 5,
  },
  style: {
    point: { pointColor: hex(POINT), pointRadius: 6, pointStrokeWidth: 0 },
    line: { strokeColor: hex(LINE), strokeWidth: 4 },
    polygon: {
      fillColor: hex(FILL),
      fillOpacity: 1,
      strokeColor: hex(OUTLINE),
      strokeWidth: 4,
    },
  },
  selectionStyle: {
    box: {
      stroke: { width: 2, color: hex(FRAME), opacity: 1, lineStyle: 'solid' },
      margin: 10,
    },
    resizeHandle: { point: pointLook('square', FRAME, 10) },
    rotateHandle: {
      point: pointLook('circle', FRAME, 10),
      distance: 10,
      connector: { width: 2, color: hex(FRAME), opacity: 1, lineStyle: 'solid' },
    },
    vertexHandle: {
      point: pointLook('square', FRAME, 10),
      selected: pointLook('square', FRAME, 10),
      followed: pointLook('square', FRAME, 10),
    },
    midpointHandle: { point: pointLook('circle', FRAME, 8) },
    radiusHandle: { point: pointLook('circle', FRAME, 10) },
  },
};

/** A point of the map at an offset (CSS pixels) from its center */
const fromCenter = (dx: number, dy: number): MapPoint => [320 + dx, 240 + dy];

/** The points the vertices are placed at, and where the pointer is left */
const A = fromCenter(-150, 60);
const B = fromCenter(-50, 100);
const C = fromCenter(50, 60);
const D = fromCenter(0, -20);

/** The last of a list */
const last = <T>(list: readonly T[]): T | undefined => list[list.length - 1];

/** A point of the map between two others */
const between = (a: MapPoint, b: MapPoint, t: number): MapPoint => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

/** Moves the pointer to a point of the map, in steps */
async function moveTo(page: Page, point: MapPoint, steps = 4): Promise<void> {
  const p = await pageOfMap(page, point);
  await page.mouse.move(p.x, p.y, { steps });
  await settle(page);
}

/** A click at a point of the map */
async function clickAt(page: Page, point: MapPoint): Promise<void> {
  await moveTo(page, point, 1);
  await page.mouse.down();
  await page.mouse.up();
  await settle(page);
}

/** A key pressed on the canvas */
async function press(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
  await settle(page);
}

const modeOf = (page: Page): Promise<string> =>
  page.evaluate(() =>
    (window as unknown as { draw: import('../index.js').Draw }).draw.getMode(),
  ) as Promise<string>;

const setMode = async (page: Page, name: string): Promise<void> => {
  await page.evaluate(
    (m) => (window as unknown as { draw: import('../index.js').Draw }).draw.setMode(m as never),
    name,
  );
  await settle(page);
};

/** The features of the instance: their IDs, types and number of positions */
const listed = (page: Page): Promise<Array<{ id: string; type: string; positions: number }>> =>
  page.evaluate(() => {
    const draw = (window as unknown as { draw: import('../index.js').Draw }).draw;
    const count = (v: unknown): number =>
      Array.isArray(v) && typeof v[0] === 'number'
        ? 1
        : Array.isArray(v)
          ? v.reduce((n: number, x) => n + count(x), 0)
          : 0;
    const { readFeature } = (window as unknown as E2EWrites).e2e;
    return draw.features.list(undefined, { limit: 100 }).map((f) => ({
      id: f.id,
      type: readFeature(f).featureType,
      positions: count((f.geometry as { coordinates?: unknown }).coordinates),
    }));
  });

const selectedIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => [
    ...((window as unknown as { draw: import('../index.js').Draw }).draw.selection.value.ids ?? []),
  ]);

/** Back to the select mode with the other feature alone, nothing selected, the map at its center */
const reset = async (page: Page): Promise<void> => {
  await page.evaluate(
    ({ center, zoom }) => {
      const w = window as unknown as {
        draw: import('../index.js').Draw;
        map: import('maplibre-gl').Map;
      };
      w.draw.setMode('select');
      w.draw.selection.clear();
      const ids = w.draw.features
        .list(undefined, { limit: 100 })
        .map((f) => f.id)
        .filter((id) => id !== 'n');
      if (ids.length > 0)
        (window as unknown as E2EWrites).e2e.writesOf(w.draw).features.deleteMany(ids);
      w.map.jumpTo({ center, zoom });
    },
    { center: at(0, 0), zoom: ZOOM },
  );
  await settle(page);
};

/**
 * The events of the sketch of the shape being drawn, as the type and the number of positions they
 * tell
 */
const previews = (recorded: readonly Recorded[]): string[] =>
  recorded
    .filter((e) => e.name === 'drawing')
    .map((e) => (e.preview ? `${e.preview} ${e.positions}` : 'cleared'));

/** The targets of the `snap.changed` events */
const snaps = (recorded: readonly Recorded[]): Array<string | null> =>
  recorded.filter((e) => e.name === 'snap.changed').map((e) => e.snapFeature ?? null);

/** A drawing mode, and how a shape is drawn, finished and dropped in it */
interface Drawing {
  mode: string;
  /** Draws the shape up to its middle: the pointer left where it is, the button pressed or not */
  begin(page: Page): Promise<void>;
  /** Finishes the shape from its middle */
  finish(page: Page): Promise<void>;
  /** Drops the shape from its middle with Escape */
  drop(page: Page): Promise<void>;
  /** A point on the shape being drawn, off its vertices */
  on: MapPoint;
  /** The shape being drawn told while the shape is drawn, the last one */
  lastPreview: string | null;
  /** The type of the feature finished, and its number of positions */
  created: { type: string; positions: number } | null;
  /** The color the feature finished is drawn in */
  createdColor: number | null;
  /** The mode once the shape is finished, and once it is dropped */
  modeAfter: string;
  modeAfterDrop: string;
  /** Whether the feature finished is selected */
  selects: boolean;
  /** Whether the pointer is moved over the corner of the other feature in the middle */
  snapsToOther: boolean;
}

const DRAWINGS: Drawing[] = [
  {
    mode: 'drawPoint',
    begin: (page) => moveTo(page, D),
    finish: (page) => clickAt(page, D),
    drop: (page) => press(page, 'Escape'),
    on: D,
    lastPreview: null,
    created: { type: 'Point', positions: 1 },
    createdColor: I_POINT,
    modeAfter: 'select',
    modeAfterDrop: 'select',
    selects: true,
    snapsToOther: true,
  },
  {
    mode: 'drawLine',
    begin: async (page) => {
      await clickAt(page, A);
      await clickAt(page, B);
      await clickAt(page, C);
      await moveTo(page, D);
    },
    finish: async (page) => {
      await moveTo(page, C);
      await clickAt(page, C);
    },
    drop: (page) => press(page, 'Escape'),
    on: between(A, B, 0.4),
    lastPreview: 'LineString 4',
    created: { type: 'LineString', positions: 3 },
    createdColor: I_LINE,
    modeAfter: 'select',
    modeAfterDrop: 'drawLine',
    selects: true,
    snapsToOther: true,
  },
  {
    mode: 'drawPolygon',
    begin: async (page) => {
      await clickAt(page, A);
      await clickAt(page, B);
      await clickAt(page, C);
      await moveTo(page, D);
    },
    finish: async (page) => {
      await moveTo(page, A);
      await clickAt(page, A);
    },
    drop: (page) => press(page, 'Escape'),
    on: between(A, B, 0.4),
    lastPreview: 'Polygon 5',
    created: { type: 'Polygon', positions: 4 },
    createdColor: I_OUTLINE,
    modeAfter: 'select',
    modeAfterDrop: 'drawPolygon',
    selects: true,
    snapsToOther: true,
  },
  {
    mode: 'drawCircle',
    begin: async (page) => {
      await clickAt(page, B);
      await moveTo(page, C);
    },
    finish: async (page) => {
      await moveTo(page, C);
      await clickAt(page, C);
    },
    drop: (page) => press(page, 'Escape'),
    on: between(B, C, 0.5),
    lastPreview: 'Circle 1',
    created: { type: 'Circle', positions: 1 },
    createdColor: I_FILL,
    modeAfter: 'select',
    modeAfterDrop: 'drawCircle',
    selects: true,
    snapsToOther: true,
  },
  {
    mode: 'drawFreehand',
    begin: async (page) => {
      const p = await pageOfMap(page, A);
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await moveTo(page, B, 8);
      await moveTo(page, C, 8);
    },
    finish: async (page) => {
      await page.mouse.up();
      await settle(page);
    },
    drop: async (page) => {
      await press(page, 'Escape');
      await page.mouse.up();
      await settle(page);
    },
    on: between(A, B, 0.5),
    lastPreview: null,
    created: { type: 'Freehand', positions: -1 },
    createdColor: I_LINE,
    modeAfter: 'drawFreehand',
    modeAfterDrop: 'drawFreehand',
    selects: false,
    // The moves of a stroke are not snapped
    snapsToOther: false,
  },
];

/** The events of a shape finished or dropped, as short words (the shapes being drawn apart) */
function featureEvents(recorded: readonly Recorded[]): string[] {
  return sequenceOf(recorded).map((e) => (e.startsWith('created ') ? 'created' : e));
}

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

describe.each(KINDS)('the shape being drawn over a Store of %s', (kind) => {
  let page: Page;

  beforeAll(async () => {
    page = await openScenePage(browser, bundle, ZOOM);
    // One instance for every test: a new instance over a Store of rows builds its programs again
    await load(page, scene, ZOOM);
  }, browserTimeout(90_000));

  afterAll(async () => {
    await page?.close();
  });

  const scene = {
    kind,
    features: [
      {
        id: 'n',
        type: 'Polygon',
        geometry: { type: 'Polygon', coordinates: [OTHER_CORNERS] },
        style: { fillColor: hex(OTHER), fillOpacity: 1, strokeColor: hex(OTHER), strokeWidth: 2 },
      },
    ],
    options,
  };

  /** What the middle of a drawing shows and answers */
  async function middle(d: Drawing): Promise<void> {
    await reset(page);
    const other = await frame(page, COLORS);
    expect((other[I_OTHER] as Drawn).count).toBeGreaterThan(1000);
    await setMode(page, d.mode);
    await mark(page);
    await d.begin(page);
    const drawn = await frame(page, COLORS);
    const recorded = await events(page);
    // The shape being drawn: its lines and its vertices, and nothing of a feature
    if (d.lastPreview === null && d.mode === 'drawPoint') {
      expect((drawn[I_PREVIEW] as Drawn).count).toBe(0);
    } else {
      expect((drawn[I_PREVIEW] as Drawn).count).toBeGreaterThan(200);
    }
    if (d.mode === 'drawLine' || d.mode === 'drawPolygon') {
      expect((drawn[I_PREVIEW_VERTEX] as Drawn).count).toBeGreaterThan(100);
    } else if (d.mode === 'drawCircle') {
      // The outlines of the marker of the center and of the handle of the radius
      expect((drawn[I_PREVIEW_VERTEX] as Drawn).count).toBeGreaterThan(20);
    } else {
      expect((drawn[I_PREVIEW_VERTEX] as Drawn).count).toBe(0);
    }
    for (const i of [I_LINE, I_FILL, I_OUTLINE, I_POINT, I_FRAME]) {
      expect((drawn[i] as Drawn).count, `the pixels of the color ${i}`).toBe(0);
    }
    expect((drawn[I_OTHER] as Drawn).count).toBe((other[I_OTHER] as Drawn).count);
    // Told as it is drawn, written nowhere
    const told = previews(recorded);
    if (d.lastPreview === null) {
      if (d.mode === 'drawPoint') expect(told).toEqual([]);
      else expect(told.length).toBeGreaterThan(2);
    } else {
      expect(last(told)).toBe(d.lastPreview);
    }
    expect(featureEvents(recorded)).toEqual([]);
    expect((await listed(page)).map((f) => f.id)).toEqual(['n']);
    // Not hit where it is drawn; the other feature is
    expect(await featureAt(page, d.on)).toBeNull();
    expect(await featureAt(page, await mapPointOf(page, at(0.006, 0.003) as number[]))).toBe('n');
    // The image of the map has nothing of it
    const image = await capture(page, [PREVIEW, PREVIEW_VERTEX, OTHER]);
    expect((image[0] as Drawn).count).toBe(0);
    expect((image[1] as Drawn).count).toBe(0);
    expect((image[2] as Drawn).count).toBeGreaterThan(1000);
  }

  /** Moves the pointer over the corner of the other feature and over the shape being drawn */
  async function hover(d: Drawing): Promise<void> {
    await mark(page);
    const corner = await mapPointOf(page, OTHER_CORNERS[0] as number[]);
    await moveTo(page, corner);
    await moveTo(page, d.on);
    const targets = snaps(await events(page));
    if (d.snapsToOther) {
      // Pulled to the corner of the other feature, and let go of over the shape being drawn
      expect(targets).toContain('n');
      expect(last(targets)).toBeNull();
    }
    expect(targets.filter((t) => t !== null && t !== 'n')).toEqual([]);
  }

  describe.each(DRAWINGS)('$mode', (d) => {
    it('draws the shape as it goes, unhit and unwritten, and the feature once finished', {
      timeout: SCENES_TIMEOUT,
    }, async () => {
      await middle(d);
      if (d.mode !== 'drawFreehand') await hover(d);
      await mark(page);
      await d.finish(page);
      const done = await frame(page, COLORS);
      const recorded = await events(page);
      expect((done[I_PREVIEW] as Drawn).count).toBe(0);
      expect((done[I_PREVIEW_VERTEX] as Drawn).count).toBe(0);
      expect((done[d.createdColor as number] as Drawn).count).toBeGreaterThan(100);
      expect((done[I_FRAME] as Drawn).count > 0).toBe(d.selects);
      const features = await listed(page);
      expect(features.map((f) => f.id)[0]).toBe('n');
      expect(features).toHaveLength(2);
      const created = features[1] as { id: string; type: string; positions: number };
      expect(created.type).toBe(d.created?.type);
      if ((d.created?.positions ?? 0) > 0) expect(created.positions).toBe(d.created?.positions);
      else expect(created.positions).toBeGreaterThan(2);
      // Both Stores tell the feature created by its ID in the one change
      expect(featureEvents(recorded)).toEqual(['created', 'D']);
      expect(recorded.find((e) => e.name === 'created')?.id).toBe(created.id);
      if (d.mode !== 'drawPoint') expect(last(previews(recorded))).toBe('cleared');
      else expect(previews(recorded)).toEqual([]);
      expect(await modeOf(page)).toBe(d.modeAfter);
      expect(await selectedIds(page)).toEqual(d.selects ? [created.id] : []);
      // Hit where it is drawn
      expect(await featureAt(page, d.on)).toBe(created.id);
    });

    it('draws the shape as it goes, unhit and unwritten, and nothing once dropped', {
      timeout: SCENES_TIMEOUT,
    }, async () => {
      await middle(d);
      await mark(page);
      await d.drop(page);
      const dropped = await frame(page, COLORS);
      const recorded = await events(page);
      for (const i of [I_PREVIEW, I_PREVIEW_VERTEX, I_LINE, I_FILL, I_OUTLINE, I_POINT]) {
        expect((dropped[i] as Drawn).count, `the pixels of the color ${i}`).toBe(0);
      }
      expect((dropped[I_FRAME] as Drawn).count).toBe(0);
      expect(featureEvents(recorded)).toEqual([]);
      if (d.mode !== 'drawPoint') expect(previews(recorded)).toEqual(['cleared']);
      else expect(previews(recorded)).toEqual([]);
      expect((await listed(page)).map((f) => f.id)).toEqual(['n']);
      expect(await modeOf(page)).toBe(d.modeAfterDrop);
      expect(await featureAt(page, d.on)).toBeNull();
    });
  });
});
