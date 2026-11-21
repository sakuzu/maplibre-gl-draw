// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end test of the time limit of the editing benchmark (`bench/edit.html`): a scene of a
 * bulk edit stops when its time has run out and gives its result, though the edit writes its
 * parts in later tasks, and the page is writable again after it. The page is given no time to run
 * a scene once it is prepared (`run=0`), so every scene runs out of time whatever the speed of the
 * machine, on a document small enough to be prepared well within the 20 seconds of the page
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
const COUNT = 10_000;

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
  // No time to run a scene once it is prepared: the edit is stopped at its next part
  await page.goto(`${ORIGIN}/edit.html?n=${COUNT}&run=0`);
  await page.evaluate(() => (window as unknown as BenchWindow).editReady);
}, browserTimeout(120_000));

afterAll(async () => {
  await browser?.close();
});

/** Runs a scene of the page and gives its result */
function run(name: string): Promise<SceneResult> {
  return page.evaluate((scene) => (window as unknown as BenchWindow).runEditBench(scene), name);
}

/**
 * Opens the document of the page with the scene `open`, so that the scene after it starts from
 * the document as made without loading it again in its preparation; it would be refused if the
 * scene before had left the page read-only
 */
async function openDocument(): Promise<void> {
  const result = await run('open');
  expect(result.error ?? '').not.toMatch(/read-only/);
}

describe(`the editing benchmark with ${COUNT.toLocaleString('en')} features`, () => {
  for (const scene of SCENES) {
    it(`${scene} stops when its time runs out and gives its result`, {
      timeout: browserTimeout(120_000),
    }, async () => {
      await openDocument();
      const started = Date.now();
      const result = await run(scene);
      const took = Date.now() - started;
      expect(result.scene).toBe(scene);
      expect(result.completed).toBe(false);
      expect(result.error).toMatch(/time ran out/);
      // The scene gave its result in about its time: an edit left writing would take minutes
      expect(took).toBeLessThan(SCENE_LIMIT_MS * 2);
      // The edit had started: it gave the number of features it changed
      const detail = JSON.stringify({ took, result });
      expect(typeof result.notes.changed, detail).toBe('number');
      // The edit was still writing when the time ran out, and was stopped
      expect(result.notes.changed as number, detail).toBeLessThan(COUNT);
      expect(result.notes, detail).toMatchObject({ stopped: 'yes' });
    });
  }

  it('the page is writable after the last of them', {
    timeout: browserTimeout(60_000),
  }, async () => {
    await openDocument();
  });
});
