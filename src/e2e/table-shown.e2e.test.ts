// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of another document shown in place of the document on the same map, and of the
 * image of the map taken from the frame (13.7 of the design of the tables, the ruling of
 * 2026-10-15: a version is looked at on the same map, drawn as a document held as rows; the
 * thumbnail of a large map is taken from the screen)
 *
 * On the real maplibre and WebGL of the browser:
 *
 * - a document held as rows shown in place of the document (`draw.document.setShown`) is drawn as
 *   the same rows drawn as the document of an instance, and the selection of the document is not
 *   drawn over it
 * - the document is drawn as before once it is shown again
 * - the image of `draw.captureImage` is the frame without the selection
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../test-utils.js';
import { type Bundle, bundlePage, type Camera, launchBrowser, openMapPage } from './harness.js';

const CENTER: [number, number] = [139.7, 35.68];
const CAMERA: Camera = { center: CENTER, zoom: 14 };

/** The differences allowed between two pictures (as in the other comparisons of the rows) */
const TOLERANCE = { level: 2, share: 0.001 };

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

/** A feature of a scene, with the key of its order */
interface SceneFeature {
  id: string;
  type: string;
  order: string;
  geometry: { type: string; coordinates: unknown };
  style?: Record<string, unknown>;
}

const at = (dx: number, dy: number): [number, number] => [CENTER[0] + dx, CENTER[1] + dy];

function ring(dx: number, dy: number, r: number, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.3;
    out.push(at(dx + r * Math.cos(a), dy + r * Math.sin(a)));
  }
  out.push(out[0]);
  return out;
}

const key = (i: number): string => `k${String(i).padStart(6, '0')}`;

/**
 * Overlapping half transparent buildings and points: `shift` moves them and changes their colors,
 * so that two versions of the document draw different pictures
 */
function scene(shift: number): SceneFeature[] {
  const colors = ['#4e79a7', '#e15759', '#59a14f', '#f28e2b', '#b07aa1'];
  const out: SceneFeature[] = [];
  for (let i = 0; i < 30; i++) {
    const x = -0.008 + (i % 10) * 0.0016 + shift * 0.0004;
    const y = -0.003 + Math.floor(i / 10) * 0.002;
    const color = colors[(i + shift) % colors.length];
    if (i % 2 === 0) {
      out.push({
        id: `building${i}`,
        type: 'Polygon',
        order: key(i * 10),
        geometry: { type: 'Polygon', coordinates: [ring(x, y, 0.0011, 5)] },
        style: { fillColor: color, fillOpacity: 0.55, strokeWidth: 2, strokeOpacity: 0.8 },
      });
    } else {
      out.push({
        id: `point${i}`,
        type: 'Point',
        order: key(i * 10),
        geometry: { type: 'Point', coordinates: at(x, y) },
        style: { pointColor: color, pointRadius: 8, pointOpacity: 0.7 },
      });
    }
  }
  return out;
}

/**
 * Runs in the page: a Store of rows of a scene (one layer, blocks of 8 rows), the pixels of a frame,
 * and a frame once everything is built
 */
const PAGE_HELPERS = `
  window.sceneStore = (features) => {
    const { store, writer } = window.e2e.tables.createTableStore();
    store.createLayer({ id: 'rows', name: 'rows', visible: true, locked: false, opacity: 1,
      kind: 'table', styleRule: undefined, metadata: undefined });
    const builder = window.e2e.tables.createRowBlockBuilder({ targetRows: 8 });
    for (const f of features) {
      builder.addRow({ id: f.id, type: f.type, geometry: f.geometry, order: f.order, style: f.style ?? {} });
    }
    writer.addBlocks('rows', builder.finish());
    return store;
  };
  window.readFrame = () => new Promise((resolve) => {
    const map = window.map;
    map.once('render', () => {
      const gl = map.getCanvas().getContext('webgl2');
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      resolve(pixels);
    });
    map.triggerRepaint();
  });
  window.settleFrame = async () => {
    let pixels = await window.readFrame();
    for (let i = 0; i < 300; i++) {
      if (!window.draw.hasPendingWork()) break;
      pixels = await window.readFrame();
    }
    await window.readFrame();
    return window.readFrame();
  };
  window.captured = {};
`;

/** The pixels of two pictures whose channels differ by more than `level`, and the pixels drawn */
async function differing(
  page: Page,
  a: string,
  b: string,
  level: number,
): Promise<{ differ: number; drawn: number }> {
  return page.evaluate(
    ({ a, b, level }) => {
      const captured = (window as unknown as { captured: Record<string, Uint8Array> }).captured;
      const pa = captured[a];
      const pb = captured[b];
      let differ = 0;
      let drawn = 0;
      for (let i = 0; i < pa.length; i += 4) {
        if (pa[i + 3] > 0 || pb[i + 3] > 0) drawn++;
        for (let k = 0; k < 4; k++) {
          if (Math.abs(pa[i + k] - pb[i + k]) > level) {
            differ++;
            break;
          }
        }
      }
      return { differ, drawn };
    },
    { a, b, level },
  );
}

describe('another document shown in place of the document', () => {
  let page: Page;

  beforeAll(async () => {
    page = await openMapPage(browser, bundle, CAMERA);
    await page.addScriptTag({ content: PAGE_HELPERS });
  }, browserTimeout(60_000));

  afterAll(async () => {
    await page?.close();
  });

  it('is drawn as the same rows drawn as the document, without the selection of the document', {
    timeout: browserTimeout(120_000),
  }, async () => {
    const live = scene(0);
    const version = scene(3);
    // The other document drawn as the document of an instance
    await page.evaluate(async (features) => {
      const w = window as unknown as Record<string, unknown> & {
        map: import('maplibre-gl').Map;
        draw: import('../index.js').Draw;
        e2e: { createDraw: typeof import('../index.js').createDraw };
        sceneStore: (f: unknown) => import('../index.js').Store;
        settleFrame: () => Promise<Uint8Array>;
        captured: Record<string, Uint8Array>;
      };
      w.draw.destroy();
      w.draw = w.e2e.createDraw(w.map, { store: w.sceneStore(features), initDefaultLayer: false });
      w.captured.reference = await w.settleFrame();
    }, version);
    // The document, with a selection, then the other document shown in its place, then the
    // document again
    const ids = await page.evaluate(
      async ({ live, version }) => {
        const w = window as unknown as Record<string, unknown> & {
          map: import('maplibre-gl').Map;
          draw: import('../index.js').Draw;
          e2e: { createDraw: typeof import('../index.js').createDraw };
          sceneStore: (f: unknown) => import('../index.js').Store;
          settleFrame: () => Promise<Uint8Array>;
          captured: Record<string, Uint8Array>;
        };
        w.draw.destroy();
        w.draw = w.e2e.createDraw(w.map, { store: w.sceneStore(live), initDefaultLayer: false });
        w.captured.live = await w.settleFrame();
        w.draw.selection.set('feature', ['building4', 'point7']);
        w.captured.selected = await w.settleFrame();
        w.draw.document.setShown(w.sceneStore(version));
        w.captured.shown = await w.settleFrame();
        const readOnly = w.draw.isReadOnly();
        w.draw.document.setShown(null);
        w.captured.back = await w.settleFrame();
        return { readOnly, selected: w.draw.selection.get().ids };
      },
      { live, version },
    );
    const shown = await differing(page, 'shown', 'reference', TOLERANCE.level);
    const back = await differing(page, 'back', 'selected', TOLERANCE.level);
    const changed = await differing(page, 'live', 'reference', TOLERANCE.level);
    console.log(
      `[shown] ${shown.drawn} pixels drawn; the document shown differs from its own drawing in ` +
        `${shown.differ}; the document shown again differs in ${back.differ}; the two versions ` +
        `differ in ${changed.differ}`,
    );
    expect(ids.readOnly).toBe(true);
    expect(ids.selected).toEqual(['building4', 'point7']);
    // The two versions differ, so a picture of the document would not pass for the other
    expect(changed.differ).toBeGreaterThan(Math.floor(changed.drawn * 0.05));
    expect(shown.differ).toBeLessThanOrEqual(Math.floor(shown.drawn * TOLERANCE.share));
    expect(back.differ).toBeLessThanOrEqual(Math.floor(back.drawn * TOLERANCE.share));
  });

  it('takes an image of the frame without the selection', {
    timeout: browserTimeout(120_000),
  }, async () => {
    const result = await page.evaluate(async (features) => {
      const w = window as unknown as Record<string, unknown> & {
        map: import('maplibre-gl').Map;
        draw: import('../index.js').Draw;
        e2e: { createDraw: typeof import('../index.js').createDraw };
        sceneStore: (f: unknown) => import('../index.js').Store;
        settleFrame: () => Promise<Uint8Array>;
        captured: Record<string, Uint8Array>;
      };
      w.draw.destroy();
      w.draw = w.e2e.createDraw(w.map, { store: w.sceneStore(features), initDefaultLayer: false });
      const plain = await w.settleFrame();
      w.draw.selection.set('feature', ['building4', 'point7']);
      const selected = await w.settleFrame();
      const blob = await w.draw.captureImage();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d') as CanvasRenderingContext2D;
      context.drawImage(bitmap, 0, 0);
      const image = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      // The image reads from the top, the frame from the bottom
      const width = bitmap.width;
      const height = bitmap.height;
      const flipped = new Uint8Array(image.length);
      for (let y = 0; y < height; y++) {
        flipped.set(
          image.subarray((height - 1 - y) * width * 4, (height - y) * width * 4),
          y * width * 4,
        );
      }
      // The frame is premultiplied by its alpha, the image is not
      const straight = (pixels: Uint8Array): Uint8Array => {
        const out = new Uint8Array(pixels.length);
        for (let i = 0; i < pixels.length; i += 4) {
          const a = pixels[i + 3];
          out[i + 3] = a;
          if (a === 0) continue;
          for (let k = 0; k < 3; k++)
            out[i + k] = Math.min(255, Math.round((pixels[i + k] * 255) / a));
        }
        return out;
      };
      w.captured.image = flipped;
      w.captured.plain = straight(plain);
      w.captured.selectedFrame = straight(selected);
      return { width, height, canvas: [w.map.getCanvas().width, w.map.getCanvas().height] };
    }, scene(0));
    // The colors of a pixel of little alpha lose their precision in the image: a share of the
    // pixels drawn may differ
    const image = await differing(page, 'image', 'plain', 3);
    const withSelection = await differing(page, 'plain', 'selectedFrame', 3);
    console.log(
      `[image] ${result.width}x${result.height}; differs from the frame without the selection in ` +
        `${image.differ} of ${image.drawn}; the selection changes ${withSelection.differ}`,
    );
    expect([result.width, result.height]).toEqual(result.canvas);
    expect(withSelection.differ).toBeGreaterThan(0);
    expect(image.differ).toBeLessThanOrEqual(Math.floor(image.drawn * 0.01));
    expect(image.differ).toBeLessThan(withSelection.differ);
  });
});
