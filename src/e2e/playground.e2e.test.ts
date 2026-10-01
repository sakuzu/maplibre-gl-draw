// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end test of the playground: the page opens with the standard UI and its added tools,
 * without an error
 *
 * The playground is built with its own vite configuration (in memory, the library from its
 * sources and the standard UI from ui/dist/) and served to headless Chromium from that build.
 * Nothing goes to the network: the basemap is replaced through the address of the page
 * (`?style=`, examples/basemap.ts) by an empty style served here.
 */

import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright-core';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import { type E2EWindow, launchBrowser, settle } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const PLAYGROUND = join(here, '../../playground');
const ORIGIN = 'http://playground.e2e.test';
const EMPTY_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef0f2' } }],
};
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

let browser: Browser;
const files = new Map<string, string | Uint8Array>();

beforeAll(async () => {
  const [launched, result] = await Promise.all([
    launchBrowser(),
    build({
      root: PLAYGROUND,
      configFile: join(PLAYGROUND, 'vite.config.ts'),
      logLevel: 'silent',
      build: { write: false, minify: false },
    }),
  ]);
  browser = launched;
  for (const output of Array.isArray(result) ? result : [result]) {
    if (!('output' in output)) throw new Error('vite returned a watcher instead of a bundle');
    for (const file of output.output) {
      files.set(file.fileName, file.type === 'chunk' ? file.code : file.source);
    }
  }
}, browserTimeout(120_000));

afterAll(async () => {
  await browser?.close();
});

describe('the playground', () => {
  it('opens with the standard UI and the tools of the plugin and the custom type', {
    timeout: 60_000,
  }, async () => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 720 } });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();
      const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (path === 'e2e/style.json') return route.fulfill({ json: EMPTY_STYLE });
      const built = files.get(path);
      if (built === undefined) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({
        contentType: CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
        body: typeof built === 'string' ? built : Buffer.from(built),
      });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`${ORIGIN}/?style=${encodeURIComponent(`${ORIGIN}/e2e/style.json`)}`);
    await page.waitForFunction(
      () => (window as unknown as Partial<E2EWindow>).map?.isStyleLoaded() === true,
      undefined,
      { timeout: browserTimeout(30_000) },
    );
    await settle(page);

    await page.getByRole('button', { name: 'Stamp', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Route', exact: true }).waitFor();
    await context.close();
    expect(errors).toEqual([]);
  });
});
