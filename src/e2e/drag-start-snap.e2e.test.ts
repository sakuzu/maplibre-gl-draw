// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of what the start of a drag of a part of one feature snaps to, over a Store of
 * objects and the Store of rows, on the real maplibre and WebGL of the browser
 *
 * The start of a drag leaves out what the drag changes, as its middle does, and no more: a
 * midpoint changes the edge it is on, so the start of its drag snaps to the corner at the end of
 * that edge; a vertex changes itself and its edges, so the start of its drag snaps to none of them
 * but to the other corners of its feature.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import {
  at,
  events,
  KINDS,
  load,
  type MapPoint,
  mapPointOf,
  mark,
  openScenePage,
  pressAndMove,
  type Recorded,
  release,
  SCENES_TIMEOUT,
  type StoreKind,
  select,
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
/** Half the side of the square, in degrees of longitude: about 20 px at zoom 14 */
const R = 0.00086;
/**
 * The corners of a square of about 40 px a side, from the south-west corner (0) along the south
 * edge to the south-east corner (1), then the north-east (2) and the north-west (3): the midpoint
 * of a side is out of the snapping tolerance of its corners, until the pointer moves to one
 */
const CORNERS: Array<[number, number]> = [at(-R, -R), at(R, -R), at(R, R), at(-R, R), at(-R, -R)];

const scene = (kind: StoreKind) => ({
  kind,
  features: [
    {
      id: 'p',
      type: 'Polygon',
      geometry: { type: 'Polygon', coordinates: [CORNERS] },
      style: { fillColor: '#c29210', fillOpacity: 1, strokeColor: '#2d7ff9', strokeWidth: 2 },
    },
  ],
});

/** The snaps told from the press on */
const snapsOf = (recorded: readonly Recorded[]) =>
  recorded
    .filter((e) => e.name === 'snap.changed' && e.snapFeature !== null)
    .map((e) => [e.snapFeature, e.snapVertex]);

describe.each(KINDS)('the start of a drag of a part of a feature over a Store of %s', (kind) => {
  let page: Page;

  beforeAll(async () => {
    page = await openScenePage(browser, bundle, ZOOM);
  }, browserTimeout(60_000));

  afterAll(async () => {
    await page?.close();
  });

  /**
   * Presses a point of the square selected and moves the pointer in one step: the drag starts
   * where the pointer arrives
   */
  async function dragFrom(from: MapPoint, by: [number, number]): Promise<Recorded[]> {
    await load(page, scene(kind), ZOOM);
    await select(page, ['p']);
    await mark(page);
    await pressAndMove(page, from, by, 1);
    const recorded = await events(page);
    await release(page);
    return recorded;
  }

  it('snaps the start of a drag of a midpoint to the corner at the end of its edge', {
    timeout: SCENES_TIMEOUT,
  }, async () => {
    const west = await mapPointOf(page, CORNERS[0] as number[]);
    const east = await mapPointOf(page, CORNERS[1] as number[]);
    const midpoint: MapPoint = [(west[0] + east[0]) / 2, (west[1] + east[1]) / 2];
    // Toward the south-east corner, to 4 px of it: the edge it is on is left out, its corners
    // are not
    const by: [number, number] = [east[0] - midpoint[0] - 4, 0];
    const snaps = snapsOf(await dragFrom(midpoint, by));
    expect(snaps[0]).toEqual(['p', 1]);
  });

  it('snaps the start of a drag of a vertex to none of its edges, but to another corner', {
    timeout: SCENES_TIMEOUT,
  }, async () => {
    const southEast = await mapPointOf(page, CORNERS[1] as number[]);
    const northEast = await mapPointOf(page, CORNERS[2] as number[]);
    // From the south-east corner up its east edge, to 4 px of the north-east corner
    const by: [number, number] = [0, northEast[1] - southEast[1] + 4];
    const snaps = snapsOf(await dragFrom(southEast, by));
    expect(snaps[0]).toEqual(['p', 2]);
    expect(snaps.filter(([, vertex]) => vertex === 1)).toEqual([]);
  });
});
