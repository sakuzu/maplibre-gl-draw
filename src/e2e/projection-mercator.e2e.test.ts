// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of where things are drawn on Web Mercator against where maplibre projects them
 * (`map.project`), over a Store of objects and the Store of rows, at zooms from 0 to 24 and
 * latitudes from 0 to 60 degrees: the fill, the line, the point, the image, the vertex handles
 * and the frames of features selected together land within half a pixel (`projection-scene.ts`)
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import { KINDS, openScenePage } from './drag-scene.js';
import { type Bundle, bundlePage, launchBrowser } from './harness.js';
import { openProjectionScene, VIEW_LATITUDES, VIEW_ZOOMS, worstMiss } from './projection-scene.js';

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
  it('draws where maplibre projects on Web Mercator at every zoom', {
    timeout: browserTimeout(60_000),
  }, async () => {
    await openProjectionScene(page, kind);
    const views = VIEW_ZOOMS.flatMap((zoom) =>
      VIEW_LATITUDES.map((latitude) => ({ projection: 'mercator' as const, zoom, latitude })),
    );
    const worst = await worstMiss(page, kind, views);
    expect(worst.px, worst.where).toBeLessThan(0.5);
  });
});
