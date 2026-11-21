// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The pictures of the table of what the instance does: how the selection, the hidden features
 * and the locked features look on a flat map
 *
 * Each scene writes the same document through the public API on the page of `harness.ts`, makes
 * the calls of the scene, draws a frame and reads every pixel of the canvas (`gl.readPixels`).
 * The pictures are not kept in the repository. A rework compares the pictures taken before it
 * with those taken after it, on the same machine:
 *
 *   PARITY_PICTURES_OUT=<folder>     writes the picture of every scene into the folder
 *   PARITY_PICTURES_BEFORE=<folder>  compares every scene with its picture in the folder: a
 *                                    scene with any pixel that differs fails
 *
 * Without them, the scenes check that a picture is the same when it is taken again, and that the
 * selection, the hiding and the lock each change what is drawn, so that the scenes show them.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FeatureInput } from '../index.js';
import { browserTimeout } from '../test-utils.js';
import { type Bundle, bundlePage, type E2EWindow, launchBrowser, openMapPage } from './harness.js';

/** The center of the flat map of the page (zoom 14: one pixel is about 0.00004 degrees) */
const CENTER: [number, number] = [139.7, 35.68];

/** A position from the center of the map, in thousandths of a degree */
const at = (dx: number, dy: number): [number, number] => [
  CENTER[0] + dx / 1000,
  CENTER[1] + dy / 1000,
];

/** A square ring from a corner, in thousandths of a degree */
const ring = (x: number, y: number, size: number): [number, number][] => [
  at(x, y),
  at(x + size, y),
  at(x + size, y + size),
  at(x, y + size),
  at(x, y),
];

/** The features of the document of every scene: `other` is in the layer `second` */
const FEATURES: FeatureInput[] = [
  {
    id: 'poly',
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [ring(-4, -2, 3)] },
    style: { fillColor: '#3366ff', fillOpacity: 0.5, strokeColor: '#003399', strokeWidth: 2 },
  },
  {
    id: 'line',
    type: 'LineString',
    geometry: { type: 'LineString', coordinates: [at(1, -2), at(3, 1), at(4, -1)] },
    style: { strokeColor: '#cc3300', strokeWidth: 3 },
  },
  {
    id: 'point',
    type: 'Point',
    geometry: { type: 'Point', coordinates: at(-2, 3) },
    style: { pointColor: '#009966', pointRadius: 8 },
  },
  {
    id: 'circle',
    type: 'Circle',
    geometry: { type: 'Point', coordinates: at(2, 3.5) },
    properties: { 'maplibre-gl-draw:radiusMeters': 60 },
  },
  { id: 'ga', type: 'Point', geometry: { type: 'Point', coordinates: at(-5, 4) } },
  { id: 'gb', type: 'Point', geometry: { type: 'Point', coordinates: at(-4, 4.5) } },
  {
    id: 'other',
    layerId: 'second',
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [ring(0, -4.5, 2)] },
  },
];

/** A call of the public API the page makes: the path of the method and its arguments */
type Call = readonly [string, ...unknown[]];

/** The scenes: their names and the calls that set them up after the document is written */
const SCENES: ReadonlyArray<readonly [string, readonly Call[]]> = [
  ['nothing selected', []],
  ['a polygon selected', [['selection.set', 'feature', ['poly']]]],
  ['a line selected', [['selection.set', 'feature', ['line']]]],
  ['a point selected', [['selection.set', 'feature', ['point']]]],
  ['a circle selected', [['selection.set', 'feature', ['circle']]]],
  ['two features selected', [['selection.set', 'feature', ['poly', 'line']]]],
  ['a group selected', [['selection.set', 'group', ['group']]]],
  ['a layer selected', [['selection.set', 'layer', ['second']]]],
  [
    'a vertex of a selected line selected',
    [
      ['selection.set', 'feature', ['line']],
      ['vertexSelection.set', 'line', [{ ring: 0, index: 1 }]],
    ],
  ],
  ['a feature hidden', [['features.update', 'poly', { visible: false }]]],
  ['a feature hidden by this client', [['hidden.add', 'poly']]],
  ['a group hidden', [['groups.update', 'group', { visible: false }]]],
  ['a layer hidden', [['layers.update', 'second', { visible: false }]]],
  ['a locked feature', [['features.update', 'poly', { locked: true }]]],
  [
    'a locked feature selected',
    [
      ['features.update', 'poly', { locked: true }],
      ['selection.set', 'feature', ['poly']],
    ],
  ],
  [
    'a locked feature selected with another',
    [
      ['features.update', 'poly', { locked: true }],
      ['selection.set', 'feature', ['poly', 'line']],
    ],
  ],
  [
    'a feature of a locked layer selected',
    [
      ['layers.update', 'second', { locked: true }],
      ['selection.set', 'feature', ['other']],
    ],
  ],
];

/** A picture: the size of the drawing buffer and its pixels (RGBA, from the bottom row) */
interface Picture {
  width: number;
  height: number;
  pixels: Buffer;
}

/** Writes the document, makes the calls of a scene, and reads the pixels of the next frame */
async function picture(page: Page, calls: readonly Call[]): Promise<Picture> {
  const { width, height, base64 } = await page.evaluate(
    async ({ features, calls }) => {
      const { draw, map } = window as unknown as E2EWindow;
      draw.setReadOnly(false);
      draw.setMode('select');
      draw.selection.clear();
      draw.hidden.clear();
      // What the scene before locked is deleted with the locks ignored; the two deletions are
      // bulk edits, written one after the other
      if (draw.layers.has('second')) await draw.layers.delete('second', { ignoreLocks: true });
      await draw.features.deleteMany(
        draw.features.list().map((feature) => feature.id),
        { ignoreLocks: true },
      );
      draw.layers.create({ id: 'second', name: 'Second' });
      for (const feature of features) draw.features.create(feature);
      draw.groups.create({ id: 'group', featureIds: ['ga', 'gb'] });
      for (const [path, ...args] of calls) {
        const [resource, method] = path.split('.');
        const target = (draw as unknown as Record<string, Record<string, unknown>>)[resource];
        (target[method] as (...a: unknown[]) => unknown).apply(target, args);
      }
      const frame = (): Promise<void> =>
        new Promise((resolve) => requestAnimationFrame(() => resolve()));
      await frame();
      await frame();
      return new Promise<{ width: number; height: number; base64: string }>((resolve) => {
        map.once('render', () => {
          const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
          const w = gl.drawingBufferWidth;
          const h = gl.drawingBufferHeight;
          const pixels = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          let text = '';
          for (let i = 0; i < pixels.length; i += 0x8000) {
            text += String.fromCharCode(...pixels.subarray(i, i + 0x8000));
          }
          resolve({ width: w, height: h, base64: btoa(text) });
        });
        map.triggerRepaint();
      });
    },
    { features: FEATURES, calls: calls as Call[] },
  );
  return { width, height, pixels: Buffer.from(base64, 'base64') };
}

/** How two pictures differ: the number of pixels that differ and the largest difference */
function difference(a: Picture, b: Picture): { pixels: number; largest: number } {
  if (a.width !== b.width || a.height !== b.height) {
    return { pixels: Math.max(a.width * a.height, b.width * b.height), largest: 255 };
  }
  let pixels = 0;
  let largest = 0;
  for (let i = 0; i < a.pixels.length; i += 4) {
    let differs = false;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a.pixels[i + c] - b.pixels[i + c]);
      if (d > 0) differs = true;
      if (d > largest) largest = d;
    }
    if (differs) pixels += 1;
  }
  return { pixels, largest };
}

/** The file of the picture of a scene in a folder */
const fileOf = (folder: string, scene: string) =>
  join(folder, `${scene.replace(/[^a-z0-9]+/gi, '-')}.rgba.gz`);

async function writePicture(folder: string, scene: string, p: Picture): Promise<void> {
  const header = Buffer.from(`${JSON.stringify({ width: p.width, height: p.height })}\n`);
  await mkdir(folder, { recursive: true });
  await writeFile(fileOf(folder, scene), await promisify(gzip)(Buffer.concat([header, p.pixels])));
}

async function readPicture(folder: string, scene: string): Promise<Picture> {
  const data = await promisify(gunzip)(await readFile(fileOf(folder, scene)));
  const end = data.indexOf(0x0a);
  const { width, height } = JSON.parse(data.subarray(0, end).toString()) as {
    width: number;
    height: number;
  };
  return { width, height, pixels: data.subarray(end + 1) };
}

const OUT = process.env.PARITY_PICTURES_OUT;
const BEFORE = process.env.PARITY_PICTURES_BEFORE;

let browser: Browser;
let page: Page;
const taken = new Map<string, Picture>();

beforeAll(async () => {
  let bundle: Bundle;
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
  page = await openMapPage(browser, bundle, { center: CENTER, zoom: 14 });
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

describe('the pictures of the selection, the hiding and the lock on a flat map', () => {
  for (const [scene, calls] of SCENES) {
    it(scene, async () => {
      const p = await picture(page, calls);
      taken.set(scene, p);
      if (OUT) await writePicture(OUT, scene, p);
      if (BEFORE) {
        expect(difference(p, await readPicture(BEFORE, scene)), scene).toEqual({
          pixels: 0,
          largest: 0,
        });
      }
    });
  }

  it('a picture taken again is the same', async () => {
    for (const scene of ['a polygon selected', 'a locked feature selected with another']) {
      const calls = SCENES.find(([name]) => name === scene)?.[1] ?? [];
      const again = await picture(page, calls);
      expect(difference(again, taken.get(scene) as Picture), scene).toEqual({
        pixels: 0,
        largest: 0,
      });
    }
  });

  it('the selection, the hiding and the lock change what is drawn', () => {
    const plain = taken.get('nothing selected') as Picture;
    for (const [scene] of SCENES) {
      if (scene === 'nothing selected' || scene === 'a locked feature') continue;
      expect(difference(taken.get(scene) as Picture, plain).pixels, scene).toBeGreaterThan(0);
    }
  });
});
