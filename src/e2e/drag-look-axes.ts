// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The end-to-end tests of how the looks of the features are drawn while a drag goes on, over every
 * axis of a look (`describeLookAxes`, called by a test file for each Store, with the flat test
 * terrain or without)
 *
 * The axes: the line style of a line and of the outline of a polygon (solid, dashed, dotted), its
 * width (a thin 2 px and a thick 16 px), a polygon with a fill and without, and a point drawn as a
 * marker (a circle) and as a picture (an image). Each group of features is selected and moved as a
 * whole from a press on one of them; in the middle of the drag, once let go, and in the middle of
 * a second drag and once it is cancelled with Escape, the pixels of the color of each feature and
 * of the selection UI (its frame, and its handles apart) are counted, with their center:
 *
 * - in the middle, each is drawn moved by the drag, as many of it as before (nothing is left where
 *   it was, nothing is missing)
 * - once let go, it is drawn as before, moved by the drag
 * - once cancelled, it is drawn back where it was
 *
 * The combinations the end-to-end tests of the drags on a map with terrain and without already
 * hold (`drag-look.e2e.test.ts`) are left out. The map is at zoom 14.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import {
  at,
  cancelAndRelease,
  type Drawn,
  type FeatureInput,
  frame,
  hex,
  idle,
  load,
  type MapPoint,
  mapPointOf,
  openScenePage,
  pointLook,
  pressAndMove,
  type Rgb,
  release,
  SCENES_TIMEOUT,
  type StoreKind,
  select,
  shiftOf,
  square,
} from './drag-scene.js';
import { type Bundle, bundlePage, type E2EWrites, launchBrowser } from './harness.js';

const ZOOM = 14;
const STEPS = 8;

/** The colors of the features of a group, one each, and of the selection UI */
const FILL_A: Rgb = [0xc2, 0x92, 0x10];
const FILL_B: Rgb = [0x90, 0x20, 0xc0];
const OUTLINE_1: Rgb = [0x2d, 0x7f, 0xf9];
const OUTLINE_2: Rgb = [0xe0, 0x30, 0x30];
const OUTLINE_3: Rgb = [0x10, 0xa0, 0x50];
const OUTLINE_4: Rgb = [0x00, 0x00, 0x80];
const LINE_1: Rgb = [0xe0, 0x60, 0x00];
const LINE_2: Rgb = [0x00, 0xc0, 0xc0];
const MARKER: Rgb = [0x60, 0x30, 0x00];
const PICTURE: Rgb = [0x40, 0xff, 0x40];
const FRAME: Rgb = [0xff, 0x00, 0xff];
const HANDLE: Rgb = [0x80, 0x80, 0x00];

const selectionStyle = {
  box: {
    stroke: { width: 2, color: hex(FRAME), opacity: 1, lineStyle: 'solid' },
    margin: 10,
  },
  resizeHandle: { point: pointLook('square', HANDLE, 10) },
  rotateHandle: {
    point: pointLook('circle', HANDLE, 10),
    distance: 10,
    connector: { width: 2, color: hex(HANDLE), opacity: 1, lineStyle: 'solid' },
  },
};

/** The places of the features of a group: three columns of two rows (degrees from the center) */
const PLACES: Array<[number, number]> = [
  [-0.006, 0.003],
  [0, 0.003],
  [0.006, 0.003],
  [-0.006, -0.003],
  [0, -0.003],
  [0.006, -0.003],
];

/** A feature of a group and the colors it is drawn in */
interface Item {
  feature: FeatureInput;
  colors: Rgb[];
  /** The colors of strokes 2 px wide, among `colors` */
  thin?: Rgb[];
  /** What it is, for the messages of the tests */
  name: string;
}

/** A polygon with an outline of a line style and a width, with a fill or without */
function polygonItem(
  id: string,
  place: [number, number],
  lineStyle: string,
  width: number,
  outline: Rgb,
  fill: Rgb | null,
): Item {
  return {
    name: `a polygon with a ${width} px ${lineStyle} outline ${fill ? 'and a fill' : 'and no fill'}`,
    feature: {
      id,
      type: 'Polygon',
      geometry: { type: 'Polygon', coordinates: [square(place[0], place[1], 0.0013)] },
      style: {
        strokeColor: hex(outline),
        strokeWidth: width,
        lineStyle,
        ...(fill ? { fillColor: hex(fill), fillOpacity: 1 } : { fillOpacity: 0 }),
      },
    },
    colors: fill ? [outline, fill] : [outline],
    thin: width === 2 ? [outline] : [],
  };
}

/** A line of a line style and a width */
function lineItem(
  id: string,
  place: [number, number],
  lineStyle: string,
  width: number,
  color: Rgb,
): Item {
  const [x, y] = place;
  return {
    name: `a ${width} px ${lineStyle} line`,
    feature: {
      id,
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [at(x - 0.0015, y - 0.001), at(x, y + 0.001), at(x + 0.0015, y - 0.001)],
      },
      style: { strokeColor: hex(color), strokeWidth: width, lineStyle },
    },
    colors: [color],
    thin: width === 2 ? [color] : [],
  };
}

/** A group of features drawn and dragged together */
interface Group {
  name: string;
  items: Item[];
}

/** The groups of a line style: the polygons and the lines of both widths */
function lineStyleGroup(lineStyle: string, terrain: boolean): Group {
  const items = [
    polygonItem(`${lineStyle}-p2f`, PLACES[0]!, lineStyle, 2, OUTLINE_1, FILL_A),
    polygonItem(`${lineStyle}-p2`, PLACES[1]!, lineStyle, 2, OUTLINE_2, null),
    polygonItem(`${lineStyle}-p16f`, PLACES[3]!, lineStyle, 16, OUTLINE_3, FILL_B),
    polygonItem(`${lineStyle}-p16`, PLACES[4]!, lineStyle, 16, OUTLINE_4, null),
    lineItem(`${lineStyle}-l2`, PLACES[2]!, lineStyle, 2, LINE_1),
    lineItem(`${lineStyle}-l16`, PLACES[5]!, lineStyle, 16, LINE_2),
  ];
  // A thick dotted outline with a fill on a map without terrain is held by the tests of the drags
  return {
    name: `${lineStyle} lines and outlines`,
    items:
      lineStyle === 'dotted' && !terrain
        ? items.filter((item) => item.feature.id !== 'dotted-p16f')
        : items,
  };
}

/** The group of the points: a marker (a circle) and a picture (an image) */
const pointGroup = (): Group => ({
  name: 'points drawn as a circle and as an image',
  items: [
    {
      name: 'a point drawn as a circle',
      feature: {
        id: 'marker',
        type: 'Point',
        geometry: { type: 'Point', coordinates: at(...PLACES[0]!) },
        style: { pointColor: hex(MARKER), pointRadius: 8, pointStrokeWidth: 0 },
      },
      colors: [MARKER],
    },
    {
      name: 'a point drawn as an image',
      feature: {
        id: 'picture',
        type: 'Image',
        geometry: { type: 'Point', coordinates: at(...PLACES[2]!) },
        properties: {
          'maplibre-gl-draw:createdZoom': ZOOM,
          'maplibre-gl-draw:imageFileId': 'picture',
          'maplibre-gl-draw:imageWidth': 30,
          'maplibre-gl-draw:imageHeight': 30,
        },
        style: { imageOpacity: 1 },
      },
      colors: [PICTURE],
    },
  ],
});

/** Puts the features of a group in place of the ones before, nothing selected */
async function show(page: Page, group: Group, before: Group | null): Promise<void> {
  await page.evaluate(
    ({ add, remove, center, zoom }) => {
      const w = window as unknown as {
        draw: import('../index.js').Draw;
        map: import('maplibre-gl').Map;
      };
      w.draw.selection.clear();
      if (remove.length > 0)
        (window as unknown as E2EWrites).e2e.writesOf(w.draw).features.deleteMany(remove);
      const created = (window as unknown as E2EWrites).e2e
        .writesOf(w.draw)
        .features.createMany(add.map((f) => ({ ...f, layerId: 'L' })) as never);
      if (!created) throw new Error('the features were not created');
      w.map.jumpTo({ center, zoom });
    },
    {
      add: group.items.map((item) => item.feature),
      remove: before ? before.items.map((item) => item.feature.id) : [],
      center: at(0, 0),
      zoom: ZOOM,
    },
  );
  await idle(page);
}

/** Within a tolerance (pixels) of a move on each axis */
function expectMove(
  actual: readonly number[],
  expected: readonly number[],
  tolerance: number,
  what: string,
): void {
  expect(Math.abs((actual[0] as number) - (expected[0] as number)), what).toBeLessThan(tolerance);
  expect(Math.abs((actual[1] as number) - (expected[1] as number)), what).toBeLessThan(tolerance);
}

/** How closely a color drawn is held to another frame */
interface Closeness {
  /** The share of the pixels its number may differ by */
  share: number;
  /** The distance (pixels) its center may be off, on each axis (null: the center is not held) */
  center: number | null;
}

const TIGHT: Closeness = { share: 0.05, center: 1.5 };
const LOOSE: Closeness = { share: 0.08, center: 2 };
/**
 * A stroke 2 px wide painted on the terrain by the drape is held loosely: its pixels follow where
 * it falls on the pixels of the drape, within about a pixel of its width (the tests of the width
 * on the terrain allow as much), so its number and its center are not those of the same stroke
 * elsewhere. Its box is held as for the others
 */
const DRAPED_THIN: Closeness = { share: 0.6, center: null };

/**
 * About as many pixels of a color as another frame drew, moved by a distance from where it drew
 * them: their box (nothing left where it was, nothing missing at its sides), their number and
 * their center
 */
function expectMoved(
  actual: Drawn,
  before: Drawn,
  by: readonly [number, number],
  what: string,
  closeness: Closeness,
): void {
  expect(before.count, what).toBeGreaterThan(30);
  expect(actual.box, what).not.toBeNull();
  const box = actual.box as number[];
  const was = before.box as number[];
  for (let k = 0; k < 4; k++) {
    expect(
      Math.abs((box[k] as number) - (was[k] as number) - (by[k % 2] as number)),
      what,
    ).toBeLessThanOrEqual(2);
  }
  expect(Math.abs(actual.count - before.count), what).toBeLessThanOrEqual(
    Math.max(4, before.count * closeness.share),
  );
  if (closeness.center !== null) {
    expectMove(shiftOf(actual, before), by, closeness.center, what);
  }
}

/** Registers the tests of the axes of the looks over a Store, with the flat test terrain or not */
export function describeLookAxes(kind: StoreKind, terrain: boolean): void {
  const groups: Group[] = [
    lineStyleGroup('solid', terrain),
    lineStyleGroup('dashed', terrain),
    lineStyleGroup('dotted', terrain),
    pointGroup(),
  ];

  let browser: Browser;
  let bundle: Bundle;
  let page: Page;
  /** The group whose features are in the Store */
  let shown: Group | null = null;

  beforeAll(async () => {
    [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
    page = await openScenePage(browser, bundle, ZOOM, terrain);
    // One instance for every group: a new instance over a Store of rows builds its programs again
    await load(
      page,
      { kind, features: [], options: { selectionStyle }, images: { picture: hex(PICTURE) } },
      ZOOM,
    );
  }, browserTimeout(90_000));

  afterAll(async () => {
    await browser?.close();
  });

  describe.each(groups)('$name', (group) => {
    it('are drawn moved in the middle of a drag, where they went once let go, and back once cancelled', {
      timeout: SCENES_TIMEOUT,
    }, async () => {
      await show(page, group, shown);
      shown = group;
      const ids = group.items.map((item) => item.feature.id);
      await select(page, ids);
      const colors = [...group.items.flatMap((item) => item.colors), FRAME];
      const names = [
        ...group.items.flatMap((item) => item.colors.map((_, i) => `${item.name} (${i})`)),
        'the frame of the selection',
      ];
      const selected = await frame(page, [...colors, HANDLE]);
      // From a press on the first feature: inside its fill, on its outline or on its marker
      const first = group.items[0] as Item;
      const grab: MapPoint =
        first.feature.type === 'Polygon'
          ? await mapPointOf(page, at(PLACES[0]![0], PLACES[0]![1]))
          : await mapPointOf(page, first.feature.geometry.coordinates as number[]);

      const by: [number, number] = [40, 30];
      await pressAndMove(page, grab, by, STEPS);
      const mid = await frame(page, [...colors, HANDLE]);
      await release(page);
      await idle(page);
      const end = await frame(page, [...colors, HANDLE]);

      const back: [number, number] = [-30, 25];
      const grabbed: MapPoint = [grab[0] + by[0], grab[1] + by[1]];
      await pressAndMove(page, grabbed, back, STEPS);
      const mid2 = await frame(page, [...colors, HANDLE]);
      await cancelAndRelease(page);
      await idle(page);
      const cancelled = await frame(page, [...colors, HANDLE]);

      const thin = new Set(group.items.flatMap((item) => item.thin ?? []));
      colors.forEach((color, i) => {
        const what = names[i] as string;
        const at0 = selected[i] as Drawn;
        const draped = terrain && thin.has(color);
        const loose = draped ? DRAPED_THIN : LOOSE;
        const tight = draped ? DRAPED_THIN : TIGHT;
        expectMoved(mid[i] as Drawn, at0, by, `${what}, in the middle of the drag`, loose);
        expectMoved(end[i] as Drawn, at0, by, `${what}, once let go`, tight);
        expectMoved(mid2[i] as Drawn, end[i] as Drawn, back, `${what}, in the second drag`, loose);
        expectMoved(
          cancelled[i] as Drawn,
          end[i] as Drawn,
          [0, 0],
          `${what}, once cancelled`,
          tight,
        );
      });
      // The handles of the frame (and the line to the rotate handle) are not drawn while it is
      // moved, and are drawn again around the features once let go and once cancelled
      const handles = colors.length;
      expect((selected[handles] as Drawn).count).toBeGreaterThan(300);
      expect((mid[handles] as Drawn).count).toBe(0);
      expect((mid2[handles] as Drawn).count).toBe(0);
      expectMoved(
        end[handles] as Drawn,
        selected[handles] as Drawn,
        by,
        'the handles, once let go',
        TIGHT,
      );
      expectMoved(
        cancelled[handles] as Drawn,
        end[handles] as Drawn,
        [0, 0],
        'the handles, once cancelled',
        TIGHT,
      );
    });
  });
}
