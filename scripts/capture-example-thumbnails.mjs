// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Takes the pictures of the gallery of the examples (docs/public/examples/<name>.jpg)
 *
 * Builds the examples and the playground with their own vite configurations (in memory, as the
 * end-to-end tests do) and opens each example of docs/examples/catalog.json in headless
 * Chromium (the one `npx playwright-core install chromium-headless-shell` installs, with a
 * software WebGL2). The pages are served from the build in memory; the basemap and the elevation
 * come from the network, as the gallery shows them (each example opens on its own basemap), so
 * this script runs on a developer's machine, not in CI. The playground is taken on the overview
 * of its showcase (`?showcase=overview`, playground/showcase/).
 *
 * An example that opens on an empty map, for the user to draw on (get-started, custom-ui), is
 * taken with a few features drawn from code and one of them selected, as the user would have
 * drawn them. It waits until the map has loaded and stopped rendering and the UI has settled,
 * and takes a picture of 1280 x 800 CSS pixels at half the resolution: 640 x 400 pixels.
 *
 * Usage: npm run site:thumbnails [-- <name> ...]   (every example when none is named)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'docs/public/examples');
const CATALOG = JSON.parse(readFileSync(join(root, 'docs/examples/catalog.json'), 'utf8'));
const ORIGIN = 'http://thumbnails.test';
const VIEWPORT = { width: 1280, height: 800 };
/** The picture is half the size of the page */
const SCALE = 0.5;
/** Opening a page compiles the shaders on the software WebGL2, and some pages load a lot */
const TIMEOUT = 120_000;

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.geojson': 'application/geo+json',
  '.parquet': 'application/octet-stream',
};

/** Builds a vite project in memory: path (without the leading slash) to content */
async function buildProject(project) {
  const result = await build({
    root: join(root, project),
    configFile: join(root, project, 'vite.config.ts'),
    logLevel: 'silent',
    build: { write: false },
  });
  const files = new Map();
  for (const output of Array.isArray(result) ? result : [result]) {
    if (!('output' in output)) throw new Error('vite returned a watcher instead of a bundle');
    for (const file of output.output) {
      files.set(file.fileName, file.type === 'chunk' ? file.code : file.source);
    }
  }
  return files;
}

const requested = process.argv.slice(2);
for (const name of requested) {
  if (!(name in CATALOG)) throw new Error(`No example named ${name} in docs/examples/catalog.json`);
}
const names = Object.keys(CATALOG)
  .filter((name) => requested.length === 0 || requested.includes(name))
  .sort((a, b) => CATALOG[a].order - CATALOG[b].order);

const [examples, playground] = await Promise.all([
  buildProject('examples'),
  buildProject('playground'),
]);
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
mkdirSync(OUT, { recursive: true });

try {
  for (const name of names) {
    const output = join(OUT, `${name}.jpg`);
    writeFileSync(output, await capture(name));
    console.log(`Wrote ${output}`);
  }
} finally {
  await browser.close();
}

/** Opens one example offline and takes its picture */
async function capture(name) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    colorScheme: 'light',
  });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    // The basemap, its tiles and the elevation come from the network
    if (url.origin !== ORIGIN) return route.continue();
    let path = url.pathname.slice(1);
    if (path === '' || path.endsWith('/')) path += 'index.html';
    const [project, ...rest] = path.split('/');
    const files = project === 'playground' ? playground : examples;
    const file = files.get(rest.join('/'));
    if (file === undefined) {
      // The files of examples/public/ (the sample data), which vite copies to the build only
      // when it writes it to disk
      const onDisk = join(root, 'examples/public', rest.join('/'));
      if (existsSync(onDisk)) {
        return route.fulfill({
          contentType: CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
          body: readFileSync(onDisk),
        });
      }
      return route.fulfill({ status: 404, body: 'not found' });
    }
    return route.fulfill({
      contentType: CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
      body: typeof file === 'string' ? file : Buffer.from(file),
    });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(`${name}: page error: ${error}`));

  const query = new URLSearchParams();
  if (name === 'playground') query.set('showcase', 'overview');
  const path = name === 'playground' ? 'playground/' : `examples/${name}/`;
  await page.goto(`${ORIGIN}/${path}?${query}`);

  // The map and the draw instance, then the data the page loads as it opens
  await page.waitForFunction(() => window.draw !== undefined && window.map?.isStyleLoaded(), null, {
    timeout: TIMEOUT,
  });
  await page.evaluate(() => window.loaded);
  if (name === 'playground') {
    await page.waitForFunction(() => document.documentElement.dataset.showcase === 'ready', null, {
      timeout: TIMEOUT,
    });
  }
  await page.evaluate(sketch);
  // The map has nothing left to draw, and the panels of the UI have finished moving
  await page.waitForFunction(() => window.map.loaded() && window.map.areTilesLoaded(), null, {
    timeout: TIMEOUT,
    polling: 250,
  });
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        window.map.once('idle', resolve);
        window.map.triggerRepaint();
      }),
  );
  await page.waitForTimeout(1000);

  const png = await page.screenshot({ type: 'jpeg', quality: 82 });
  await context.close();
  return png;
}

/**
 * Draws a few features around the center of an empty map and selects the area, in the page
 *
 * The places are in pixels from the center, so that they stay clear of the panels.
 */
function sketch() {
  const { draw, map } = window;
  if (draw.features.count() > 0) return;
  const { x, y } = map.project(map.getCenter());
  const at = (dx, dy) => map.unproject([x + dx, y + dy]).toArray();
  const ring = [at(-60, -70), at(90, -50), at(110, 60), at(-40, 80), at(-90, 10)];
  const area = draw.features.create({
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
    properties: { name: 'Area' },
  });
  draw.features.create({
    type: 'LineString',
    geometry: { type: 'LineString', coordinates: [at(-260, 120), at(-170, 30), at(-150, -90)] },
    properties: { name: 'Line' },
  });
  draw.features.create({
    type: 'Point',
    geometry: { type: 'Point', coordinates: at(220, -60) },
    properties: { name: 'Point' },
  });
  draw.selection.set('feature', [area.id]);
}
