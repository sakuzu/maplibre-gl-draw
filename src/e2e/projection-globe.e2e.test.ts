// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of where things are drawn on the globe and in the transition from the globe to
 * Web Mercator against where maplibre projects them (`map.project`), over a Store of objects and
 * the Store of rows: on the globe at zooms from 0 to 24, and in the middle of the transition, at
 * latitudes from 0 to 60 degrees, the fill, the line, the point, the image, the vertex handles
 * and the frames of features selected together land within half a pixel
 * (`projection-scene.ts`). maplibre projects a position on the globe alone in the transition
 * too, while it draws the positions of both projections mixed; the things of the scene stay near
 * the center, where the two are less than a hundredth of a pixel apart.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import { KINDS, openScenePage } from './drag-scene.js';
import { type Bundle, bundlePage, launchBrowser } from './harness.js';
import {
  openProjectionScene,
  type ProjectionView,
  VIEW_LATITUDES,
  VIEW_ZOOMS,
  worstMiss,
} from './projection-scene.js';

let browser: Browser;
let bundle: Bundle;
let page: Page;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
  page = await openScenePage(browser, bundle, 10);
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

describe.each(KINDS)('over a Store of %s', (kind) => {
  it('draws where maplibre projects on the globe at every zoom and in the transition', {
    timeout: browserTimeout(60_000),
  }, async () => {
    await openProjectionScene(page, kind);
    const views: ProjectionView[] = [
      ...VIEW_ZOOMS.flatMap((zoom) =>
        VIEW_LATITUDES.map((latitude) => ({ projection: 'globe' as const, zoom, latitude })),
      ),
      ...VIEW_LATITUDES.map((latitude) => ({
        projection: 'transition' as const,
        zoom: 11.5,
        latitude,
      })),
    ];
    const worst = await worstMiss(page, views);
    expect(worst.px, worst.where).toBeLessThan(0.5);
  });
});
