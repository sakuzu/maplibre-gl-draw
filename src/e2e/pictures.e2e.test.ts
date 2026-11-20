// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The pictures of what is drawn: every scene of `picture-scenes.ts` (every map, every kind of
 * feature and every state), drawn on the page of `harness.ts` and read back pixel by pixel
 * (`gl.readPixels`)
 *
 * A change to the drawing is held to the pictures taken before it, on the same machine:
 *
 *   DRAW_PICTURES_OUT=<folder> npm run pictures:take    writes the picture of every scene
 *   npm run pictures:compare -- <before> <after>        compares two folders of them
 *
 * (`compare-pictures.ts` tells how a scene that is allowed to change is named.) The pictures are
 * not kept in the repository. Every run takes every scene twice, one set after the other, and
 * fails unless the two sets are the same to the pixel: the same document drawn again gives the
 * same picture.
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrawDocument } from '../index.js';
import { browserTimeout } from '../test-utils.js';
import {
  compareSets,
  describeComparison,
  difference,
  type Picture,
  writePicture,
} from './compare-pictures.js';
import { type Bundle, bundlePage, type E2EWindow, launchBrowser, openMapPage } from './harness.js';
import {
  type Call,
  CUSTOM_TYPE,
  imageWarmUp,
  KINDS,
  MAP_SETUPS,
  MAPS,
  type MapName,
  type PictureScene,
  SCENES,
  STATES,
  TERRAIN_EXAGGERATION,
} from './picture-scenes.js';

/** The frames the page draws at most before a picture, waiting for the drawing to finish */
const SETTLE_FRAMES = 300;

/** What the test page carries besides the map and the draw instance */
interface PicturesWindow extends E2EWindow {
  e2e: {
    terrain: {
      addTestTerrain(map: import('maplibre-gl').Map, exaggeration: number): Promise<void>;
    };
  };
}

const OUT = process.env.DRAW_PICTURES_OUT;

let browser: Browser;
let bundle: Bundle;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([launchBrowser(), bundlePage()]);
}, browserTimeout(60_000));

afterAll(async () => {
  await browser?.close();
});

/**
 * Opens the page of a map: its camera, its terrain or its globe, the custom type of the scenes,
 * and the image of the scenes decoded once
 */
async function openPage(map: MapName): Promise<Page> {
  const setup = MAP_SETUPS[map];
  const page = await openMapPage(browser, bundle, setup.camera);
  const warmUp = imageWarmUp(map);
  await page.evaluate(
    async ({ terrain, globe, exaggeration, customType, warmUpDocument, warmUpAt, frames }) => {
      const w = window as unknown as PicturesWindow;
      const { map, draw } = w;
      if (globe) map.setProjection({ type: 'globe' });
      if (terrain) await w.e2e.terrain.addTestTerrain(map, exaggeration);
      // A custom type drawn one feature at a time by its own renderer, with the shared fill,
      // line and point renderers
      draw.extensions.featureTypes.add({
        type: customType,
        geometry: 'Polygon',
        renderer: {
          onAdd() {},
          draw(feature, ctx) {
            const rings = (feature.geometry as { coordinates: number[][][] }).coordinates;
            const color = feature.style.fillColor ?? '#808080';
            ctx.fill.draw(rings, { color, opacity: 0.5 * ctx.opacity });
            ctx.line.draw(
              rings[0],
              { width: 3, color: '#202020', opacity: ctx.opacity, lineStyle: 'dashed' },
              { closed: true },
            );
            ctx.point.draw(rings[0][0], {
              shape: 'star',
              size: 10,
              fillColor: color,
              fillOpacity: ctx.opacity,
              strokeColor: '#ffffff',
              strokeWidth: 2,
              strokeOpacity: ctx.opacity,
            });
          },
          onRemove() {},
        },
      });
      // The image is decoded asynchronously once; every scene after it finds it decoded
      await draw.document.load(warmUpDocument as never);
      const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
      const p = map.project(warmUpAt as [number, number]);
      const ratio = gl.drawingBufferWidth / map.getCanvas().clientWidth;
      const read = (): Promise<number> =>
        new Promise((resolve) => {
          map.once('render', () => {
            const pixel = new Uint8Array(4);
            gl.readPixels(
              Math.round(p.x * ratio),
              gl.drawingBufferHeight - 1 - Math.round(p.y * ratio),
              1,
              1,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              pixel,
            );
            resolve(pixel[3]);
          });
          map.triggerRepaint();
        });
      for (let i = 0; i < frames; i++) {
        if ((await read()) > 0) return;
      }
      throw new Error('the image of the scenes was not drawn');
    },
    {
      terrain: setup.terrain,
      globe: setup.globe,
      exaggeration: TERRAIN_EXAGGERATION,
      customType: CUSTOM_TYPE,
      warmUpDocument: warmUp.document,
      warmUpAt: warmUp.at,
      frames: SETTLE_FRAMES,
    },
  );
  return page;
}

/** Writes the document of a scene, makes its calls, and reads the pixels once it is drawn */
async function take(page: Page, scene: PictureScene): Promise<Picture> {
  const { width, height, base64 } = await page.evaluate(
    async ({ document, calls, frames }) => {
      const { draw, map } = window as unknown as E2EWindow;
      draw.setReadOnly(false);
      draw.setMode('select');
      draw.selection.clear();
      draw.hidden.clear();
      if (!(await draw.document.load(document as DrawDocument))) {
        throw new Error('the document of the scene was not loaded');
      }
      for (const [path, ...args] of calls as Call[]) {
        const [resource, method] = path.split('.');
        const target = (draw as unknown as Record<string, Record<string, unknown>>)[resource];
        (target[method] as (...a: unknown[]) => unknown).apply(target, args);
      }
      const frame = (): Promise<void> =>
        new Promise((resolve) => requestAnimationFrame(() => resolve()));
      for (let i = 0; ; i++) {
        if (i >= 2 && !draw.hasPendingWork() && map.loaded()) break;
        if (i >= frames) throw new Error('the drawing did not finish');
        map.triggerRepaint();
        await frame();
      }
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
    { document: scene.document, calls: scene.calls as Call[], frames: SETTLE_FRAMES },
  );
  return { width, height, pixels: Buffer.from(base64, 'base64') };
}

describe('the scenes', () => {
  it('hold every value of the three axes, and every combination of them once', () => {
    const required = {
      map: ['flat', 'pitched', 'terrain', 'globe'],
      kind: [
        'point-circle',
        'point-square',
        'point-triangle',
        'point-star',
        'line-solid',
        'line-dashed',
        'line-dotted',
        'area',
        'image',
        'circle',
        'freehand',
        'custom-type',
      ],
      state: [
        'plain',
        'selected',
        'hidden-here',
        'locked',
        'layer-opacity',
        'style-rule',
        'interleaved',
      ],
    };
    for (const axis of ['map', 'kind', 'state'] as const) {
      const values = new Set(SCENES.map((scene) => scene[axis]));
      for (const value of required[axis]) expect(values, `${axis} ${value}`).toContain(value);
    }
    const names = SCENES.map((scene) => scene.name);
    expect(new Set(names).size).toBe(names.length);
    expect(SCENES).toHaveLength(MAPS.length * KINDS.length * STATES.length);
    for (const map of MAPS) {
      for (const kind of KINDS) {
        for (const state of STATES) {
          expect(names, `${map}/${kind}/${state}`).toContain(`${map}/${kind}/${state}`);
        }
      }
    }
  });

  it('each hold the two features a and b of its kind', () => {
    for (const scene of SCENES) {
      const types = scene.document.features
        .filter((f) => f.id === 'a' || f.id === 'b')
        .map((f) => f.type);
      expect(types, scene.name).toHaveLength(2);
    }
  });
});

for (const map of MAPS) {
  describe(`the pictures on the ${map} map`, () => {
    const scenes = SCENES.filter((scene) => scene.map === map);
    const taken = new Map<string, Picture>();
    let page: Page;

    beforeAll(async () => {
      page = await openPage(map);
    }, browserTimeout(90_000));

    afterAll(async () => {
      await page?.close();
    });

    for (const scene of scenes) {
      it(scene.name, async () => {
        const picture = await take(page, scene);
        taken.set(scene.name, picture);
        if (OUT) await writePicture(OUT, scene.name, picture);
      });
    }

    it('every scene taken again, after the others, gives the same picture', {
      timeout: browserTimeout(300_000),
    }, async () => {
      const again = new Map<string, Picture>();
      for (const scene of scenes) again.set(scene.name, await take(page, scene));
      expect(taken.size).toBe(scenes.length);
      const failed = compareSets(taken, again)
        .filter((c) => c.failed)
        .map(describeComparison);
      expect(failed).toEqual([]);
    });

    it('a state changes what is drawn, but for the lock alone and the style rule of an image', () => {
      for (const scene of scenes) {
        if (scene.state === 'plain' || scene.state === 'locked') continue;
        // An image takes no color from the style rule of its layer
        if (scene.state === 'style-rule' && scene.kind === 'image') continue;
        const plain = taken.get(`${map}/${scene.kind}/plain`) as Picture;
        expect(
          difference(taken.get(scene.name) as Picture, plain).pixels,
          scene.name,
        ).toBeGreaterThan(0);
      }
    });
  });
}
