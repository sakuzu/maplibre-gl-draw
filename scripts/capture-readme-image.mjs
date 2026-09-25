// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Takes the README images (docs/images/*.jpg)
 *
 * Starts the playground's vite dev server and opens each scene of the showcase
 * (`?showcase=<scene>`, playground/showcase/) in headless Chromium (the one
 * `npx playwright-core install chromium-headless-shell` installs, with a software WebGL2). It
 * waits until the scene is assembled and the basemap tiles (and the elevation tiles) are in,
 * and takes a screenshot. The basemaps come from OpenFreeMap and the elevation from the
 * MapLibre demo tiles, so this needs the network. The resizing to JPEG uses `sips`, which is
 * on macOS.
 *
 * The large-data scene draws two hundred thousand features, which the software WebGL2 cannot
 * finish in time, so it is taken in a second browser that draws on the GPU (ANGLE's Metal
 * backend).
 *
 * Usage: npm run docs:image [-- <scene> ...]   (every scene when none is named)
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const playground = join(root, 'playground');
const images = join(root, 'docs/images');

/** The scenes and the images they make */
const SCENES = ['overview', 'tilted', 'terrain', 'globe', 'large-data'];

/** The scenes taken on the GPU instead of the software WebGL2 */
const GPU_SCENES = new Set(['large-data']);

const VIEWPORT = { width: 1280, height: 760 };
const OUTPUT_WIDTH = 1600;
const JPEG_QUALITY = 80;

const server = await createServer({
  root: playground,
  configFile: join(playground, 'vite.config.ts'),
  logLevel: 'warn',
  server: { open: false, port: 3101 },
});
const tmp = mkdtempSync(join(tmpdir(), 'readme-image-'));
let browser;
let gpuBrowser;

try {
  await server.listen();
  const base = server.resolvedUrls?.local[0];
  if (!base) throw new Error('The dev server has no local URL');

  browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const requested = process.argv.slice(2);
  for (const name of requested) {
    if (!SCENES.includes(name)) throw new Error(`Unknown scene ${name} (${SCENES.join(', ')})`);
  }
  for (const scene of requested.length > 0 ? requested : SCENES) {
    if (GPU_SCENES.has(scene)) {
      gpuBrowser ??= await chromium.launch({
        args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
      });
    }
    const target = GPU_SCENES.has(scene) ? gpuBrowser : browser;
    await capture(target, `${base}?showcase=${scene}`, join(images, `${scene}.jpg`));
  }
} finally {
  await browser?.close();
  await gpuBrowser?.close();
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
}

/** Opens one scene and writes its image */
async function capture(browser, url, output) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  page.on('pageerror', (error) => console.error(`page error: ${error}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`console: ${message.text()}`);
  });

  await page.goto(url);
  await page.waitForFunction(() => document.documentElement.dataset.showcase === 'ready', null, {
    timeout: 120_000,
  });
  // The basemap tiles and the glyphs keep coming in after the first idle
  await page.waitForFunction(() => window.map.loaded() && window.map.areTilesLoaded(), null, {
    timeout: 120_000,
    polling: 250,
  });
  await page.waitForTimeout(1500);

  const png = join(tmp, 'scene.png');
  await page.screenshot({ path: png });
  await page.close();
  execFileSync('sips', [
    '--resampleWidth',
    String(OUTPUT_WIDTH),
    '-s',
    'format',
    'jpeg',
    '-s',
    'formatOptions',
    String(JPEG_QUALITY),
    png,
    '--out',
    output,
  ]);
  console.log(`Wrote ${output}`);
}
