// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end test of the time limit of the editing benchmark (`bench/edit.html`): a scene of a
 * bulk edit of 100,000 features stops when its 20 seconds have run out and gives its result,
 * though the edit writes its parts in later tasks, and the page is writable again after it
 *
 * The benchmark is built with its own vite configuration (in memory, the library from its
 * sources) and served to headless Chromium from that build; nothing goes to the network. The
 * times are not measured here: the software WebGL of the browser says nothing of the speed.
 */

import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright-core';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import { launchBrowser } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const BENCH = join(here, '../../bench');
const ORIGIN = 'http://bench.e2e.test';
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

/** The number of features of the page */
const COUNT = 100_000;

/** The limit of a scene of the page, preparation included (ms) */
const SCENE_LIMIT_MS = 20_000;

/** The scenes of the bulk edits, each written in parts */
const SCENES = ['translateAll', 'rotateAll', 'scaleAll', 'translateLayer'];

/** What the page gives of a run of a scene */
interface SceneResult {
  scene: string;
  completed: boolean;
  error: string | null;
  notes: Record<string, number | string>;
}

interface BenchWindow {
  editReady: Promise<unknown>;
  runEditBench(name: string): Promise<SceneResult>;
}

let browser: Browser;
let page: Page;
const files = new Map<string, string | Uint8Array>();

beforeAll(async () => {
  const [launched, result] = await Promise.all([
    launchBrowser(),
    build({
      root: BENCH,
      configFile: join(BENCH, 'vite.config.ts'),
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
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const built = files.get(url.pathname.slice(1));
    if (built === undefined) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({
      contentType: CONTENT_TYPES[extname(url.pathname)] ?? 'application/octet-stream',
      body: typeof built === 'string' ? built : Buffer.from(built),
    });
  });
  page = await context.newPage();
  await page.goto(`${ORIGIN}/edit.html?n=${COUNT}`);
  await page.evaluate(() => (window as unknown as BenchWindow).editReady);
}, browserTimeout(120_000));

afterAll(async () => {
  await browser?.close();
});

describe(`the editing benchmark with ${COUNT.toLocaleString('en')} features`, () => {
  for (const scene of SCENES) {
    it(`${scene} stops when its time runs out and gives its result`, {
      timeout: browserTimeout(90_000),
    }, async () => {
      const started = Date.now();
      const result = await page.evaluate(
        (name) => (window as unknown as BenchWindow).runEditBench(name),
        scene,
      );
      const took = Date.now() - started;
      expect(result.scene).toBe(scene);
      expect(result.completed).toBe(false);
      expect(result.error).toMatch(/time ran out/);
      // The scene gave its result in about its time: an edit left writing would take minutes
      expect(took).toBeLessThan(SCENE_LIMIT_MS * 2);
      // The edit had started and was stopped before it had written every feature
      expect(result.notes, JSON.stringify({ took, result })).toMatchObject({ stopped: 'yes' });
    });
  }

  it('the page is writable after them: a scene that opens the document again is not refused', {
    timeout: browserTimeout(90_000),
  }, async () => {
    const result = await page.evaluate(() =>
      (window as unknown as BenchWindow).runEditBench('updateOne'),
    );
    expect(result.error ?? '').not.toMatch(/read-only/);
  });
});
