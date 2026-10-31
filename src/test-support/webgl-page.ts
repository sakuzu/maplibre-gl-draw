// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A page of headless Chromium (ANGLE on SwiftShader) with maplibre's build, for the tests that run
 * the shaders of the engine on a real WebGL2
 *
 * The browser is the one playwright-core installs (`npx playwright-core install
 * chromium-headless-shell`).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright-core';
import { browserTimeout } from '../test-utils.js';
import type { ShaderData } from '../view/shaders/helpers.js';

const maplibreDist = join(
  dirname(createRequire(import.meta.url).resolve('maplibre-gl/package.json')),
  'dist',
);
const ORIGIN = 'http://glsl.test';

/** Starts headless Chromium with a software WebGL2 */
export async function launchWebGlBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({
      args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
    });
  } catch (error) {
    throw new Error(
      `Headless Chromium could not be started. Install it with ` +
        `\`npx playwright-core install chromium-headless-shell\`.\n${String(error)}`,
    );
  }
}

/** Serves the maplibre build to the page, so the page can run a real map */
export async function openMaplibrePage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultTimeout(browserTimeout(30_000));
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') {
      return route.fulfill({
        contentType: 'text/html',
        body:
          '<!doctype html><div id="map" style="width:256px;height:256px"></div>' +
          '<script type="module">' +
          "import * as maplibre from '/maplibre-gl.mjs';" +
          "maplibre.setWorkerUrl('/maplibre-gl-worker.mjs');" +
          'window.maplibre = maplibre;' +
          '</script>',
      });
    }
    return route.fulfill({
      contentType: 'text/javascript',
      body: readFileSync(join(maplibreDist, path.slice(1))),
    });
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => 'maplibre' in window);
  return page;
}

/**
 * The preludes maplibre hands to a custom layer, by projection
 *
 * A background-only map is rendered once in Mercator and once on the globe, and a custom layer
 * records the `shaderData` of each.
 */
export async function capturePreludes(page: Page): Promise<ShaderData[]> {
  return page.evaluate(async (renderTimeout) => {
    const maplibre = (window as unknown as { maplibre: typeof import('maplibre-gl') }).maplibre;
    const map = new maplibre.Map({
      container: 'map',
      style: {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#fff' } }],
      },
      center: [0, 0],
      zoom: 1,
    });
    const seen = new Map<string, ShaderData>();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('maplibre did not render')), renderTimeout);
      map.on('load', () => {
        map.addLayer({
          id: 'capture',
          type: 'custom',
          renderingMode: '3d',
          render(_gl: unknown, options: { shaderData: ShaderData }) {
            const { variantName, vertexShaderPrelude, define } = options.shaderData;
            seen.set(variantName, { variantName, vertexShaderPrelude, define });
            if (seen.size >= 2) {
              clearTimeout(timer);
              resolve();
            } else {
              map.setProjection({ type: 'globe' });
              map.triggerRepaint();
            }
          },
        });
      });
    });
    map.remove();
    return [...seen.values()];
  }, browserTimeout(15_000));
}
