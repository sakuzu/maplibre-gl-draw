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
import { DEFAULT_SELECTION_CONFIG } from '../shared/config/selection.js';
import { browserTimeout } from '../test-utils.js';
import { TERRAIN_GHOST_OPACITY } from '../view/terrain/occlusion.js';
import { rowFrameCorners } from '../view/ui/bulk-frames.js';
import { computeResizeHandles, computeRotateHandle } from '../view/ui/handles.js';
import {
  computeBoundingBox,
  computeCombinedBoundingBox,
} from '../view/ui/selection-ui/bounding-box.js';
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
  CIRCLE_PART,
  CIRCLES_SCENES,
  CUSTOM_TYPE,
  DATELINE_CAMERA,
  DATELINE_SCENES,
  FRAME_COLOR,
  GHOST_CAMERA,
  GHOST_POINTS,
  GHOST_SCENES,
  ghostPointId,
  imageWarmUp,
  KINDS,
  MANY_COUNTS,
  MANY_PARTS,
  MANY_SCENES,
  MAP_SETUPS,
  MAPS,
  type MapName,
  type PictureScene,
  ROWS_SCENES,
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
async function take(page: Page, scene: Pick<PictureScene, 'document' | 'calls'>): Promise<Picture> {
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

// ============================================================================
// A selection of many features
// ============================================================================

/** A box of the drawing buffer, in device px from its top left (`x1` and `y1` excluded) */
interface PixelBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * The box of the drawing buffer the frame of a part of a scene of a selection of many features
 * lies in: the box of the feature on the screen, and the pixels of the part around it
 */
async function pixelBoxOf(
  page: Page,
  scene: (typeof MANY_SCENES)[number],
  part: keyof typeof MANY_PARTS,
): Promise<PixelBox> {
  const { id, padPx } = MANY_PARTS[part];
  const feature = scene.document.features.find((f) => f.id === id);
  const bbox = feature ? computeBoundingBox(feature as never) : null;
  if (!bbox) throw new Error(`no box of the part ${part}`);
  return page.evaluate(
    ({ corners, pad }) => {
      const { map } = window as unknown as E2EWindow;
      const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
      const ratio = gl.drawingBufferWidth / map.getCanvas().clientWidth;
      const points = corners.map((c) => map.project(c as [number, number]));
      const xs = points.map((p) => p.x * ratio);
      const ys = points.map((p) => p.y * ratio);
      return {
        x0: Math.max(0, Math.floor(Math.min(...xs) - pad * ratio)),
        y0: Math.max(0, Math.floor(Math.min(...ys) - pad * ratio)),
        x1: Math.min(gl.drawingBufferWidth, Math.ceil(Math.max(...xs) + pad * ratio)),
        y1: Math.min(gl.drawingBufferHeight, Math.ceil(Math.max(...ys) + pad * ratio)),
      };
    },
    { corners: [bbox.topLeft, bbox.topRight, bbox.bottomRight, bbox.bottomLeft], pad: padPx },
  );
}

/** The pixels of a box of a picture, from its top row */
function pixelsIn(picture: Picture, box: PixelBox): Uint8Array {
  const width = box.x1 - box.x0;
  const out = new Uint8Array(width * (box.y1 - box.y0) * 4);
  for (let y = box.y0; y < box.y1; y++) {
    const row = picture.height - 1 - y;
    const from = (row * picture.width + box.x0) * 4;
    out.set(picture.pixels.subarray(from, from + width * 4), (y - box.y0) * width * 4);
  }
  return out;
}

/** Whether a pixel shows the color of the frames, whatever covers it */
function isFrame(pixels: Uint8Array, at: number): boolean {
  const [r, g, b] = FRAME_COLOR;
  const alpha = pixels[at + 3];
  if (alpha < 96) return false;
  // The color of a pixel the line covers in part comes in scaled by its coverage
  const scale = alpha / 255;
  return (
    Math.abs(pixels[at] - r * scale) < 48 &&
    Math.abs(pixels[at + 1] - g * scale) < 48 &&
    Math.abs(pixels[at + 2] - b * scale) < 48
  );
}

/** The extent of the pixels of the color of the frames in a box (null for none) */
function frameExtentIn(picture: Picture, box: PixelBox): PixelBox | null {
  const pixels = pixelsIn(picture, box);
  const width = box.x1 - box.x0;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < pixels.length; i += 4) {
    if (!isFrame(pixels, i)) continue;
    const x = (i / 4) % width;
    const y = Math.floor(i / 4 / width);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + 1);
    y1 = Math.max(y1, y + 1);
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

for (const map of MAPS) {
  describe(`the pictures of a selection of many features on the ${map} map`, () => {
    const scenes = MANY_SCENES.filter((scene) => scene.map === map);
    const taken = new Map<number, Picture>();
    const boxes = new Map<keyof typeof MANY_PARTS, PixelBox>();
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
        taken.set(scene.count, picture);
        if (OUT) await writePicture(OUT, scene.name, picture);
        for (const part of Object.keys(MANY_PARTS) as (keyof typeof MANY_PARTS)[]) {
          boxes.set(part, await pixelBoxOf(page, scene, part));
        }
      });
    }

    /** The pictures of the two counts */
    const pictures = (): [Picture, Picture] => {
      const [few, many] = MANY_COUNTS.map((count) => taken.get(count));
      if (!few || !many) throw new Error('the pictures of the two counts were not taken');
      return [few, many];
    };

    it('frame the image turned with it the same way at both counts', () => {
      const [few, many] = pictures();
      const box = boxes.get('image') as PixelBox;
      expect(frameExtentIn(few, box)).not.toBeNull();
      expect(Buffer.from(pixelsIn(many, box)).equals(Buffer.from(pixelsIn(few, box)))).toBe(true);
    });

    it('frame no feature not selected at either count', () => {
      const [few, many] = pictures();
      const box = boxes.get('free') as PixelBox;
      // The frame of all of them may pass by it, the same at both counts
      expect(Buffer.from(pixelsIn(many, box)).equals(Buffer.from(pixelsIn(few, box)))).toBe(true);
    });

    it('frame an area and a point at the same size at both counts', () => {
      const [few, many] = pictures();
      for (const part of ['area', 'point'] as const) {
        const box = boxes.get(part) as PixelBox;
        const one = frameExtentIn(few, box);
        const other = frameExtentIn(many, box);
        expect(one, part).not.toBeNull();
        expect(other, part).not.toBeNull();
        for (const side of ['x0', 'y0', 'x1', 'y1'] as const) {
          expect(
            Math.abs((other as PixelBox)[side] - (one as PixelBox)[side]),
            `${part} ${side}`,
          ).toBeLessThanOrEqual(1);
        }
      }
    });
  });
}

/** The box of the drawing buffer around positions, with some pixels around them */
async function pixelBoxAround(
  page: Page,
  positions: readonly (readonly number[])[],
  padPx: number,
): Promise<PixelBox> {
  return page.evaluate(
    ({ at, pad }) => {
      const { map } = window as unknown as E2EWindow;
      const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
      const ratio = gl.drawingBufferWidth / map.getCanvas().clientWidth;
      const points = at.map((c) => map.project(c as [number, number]));
      const xs = points.map((p) => p.x * ratio);
      const ys = points.map((p) => p.y * ratio);
      return {
        x0: Math.max(0, Math.floor(Math.min(...xs) - pad * ratio)),
        y0: Math.max(0, Math.floor(Math.min(...ys) - pad * ratio)),
        x1: Math.min(gl.drawingBufferWidth, Math.ceil(Math.max(...xs) + pad * ratio)),
        y1: Math.min(gl.drawingBufferHeight, Math.ceil(Math.max(...ys) + pad * ratio)),
      };
    },
    { at: positions as number[][], pad: padPx },
  );
}

/** The pixels around a handle the box of it holds: the handle (10 px) and the ends of the lines */
const HANDLE_PAD_PX = 8;

/** The fewest pixels of the color of the frames in the box of a handle drawn there */
const HANDLE_PIXELS = 60;

for (const map of MAPS) {
  describe(`the pictures of a selection of many circles alone on the ${map} map`, () => {
    const scenes = CIRCLES_SCENES.filter((scene) => scene.map === map);
    const taken = new Map<number, Picture>();
    const boxes = new Map<string, PixelBox>();
    let page: Page;

    beforeAll(async () => {
      page = await openPage(map);
      const features = scenes[0].document.features as never[];
      const { margin } = DEFAULT_SELECTION_CONFIG.boundingBox;
      const { zoom } = MAP_SETUPS[map].camera;
      const part = computeBoundingBox(
        scenes[0].document.features.find((f) => f.id === CIRCLE_PART.id) as never,
      );
      const all = computeCombinedBoundingBox(features);
      if (!part || !all) throw new Error('no box of the circles');
      const [topLeft, topRight, bottomRight, bottomLeft] = rowFrameCorners(
        [all.bottomLeft[0], all.bottomLeft[1], all.topRight[0], all.topRight[1]],
        margin,
        zoom,
      );
      const frame = { topLeft, topRight, bottomRight, bottomLeft, center: all.center };
      const handles = [
        ...computeResizeHandles(frame),
        computeRotateHandle(frame, DEFAULT_SELECTION_CONFIG.rotateHandle.distance, zoom),
      ];
      boxes.set(
        'circle',
        await pixelBoxAround(
          page,
          [part.topLeft, part.topRight, part.bottomRight, part.bottomLeft],
          CIRCLE_PART.padPx,
        ),
      );
      for (const [i, handle] of handles.entries()) {
        const box = await pixelBoxAround(page, [handle.position], HANDLE_PAD_PX);
        boxes.set(`handle ${i}`, box);
      }
    }, browserTimeout(90_000));

    afterAll(async () => {
      await page?.close();
    });

    for (const scene of scenes) {
      it(scene.name, async () => {
        const picture = await take(page, scene);
        taken.set(scene.count, picture);
        if (OUT) await writePicture(OUT, scene.name, picture);
      });
    }

    it('frame a circle, frame all of them and draw the handles the same way at both counts', () => {
      const [few, many] = MANY_COUNTS.map((count) => taken.get(count));
      if (!few || !many) throw new Error('the pictures of the two counts were not taken');
      expect(boxes.size).toBe(6);
      const whole = { x0: 0, y0: 0, x1: few.width, y1: few.height };
      for (const [part, box] of [...boxes, ['all', whole] as const]) {
        const one = frameExtentIn(few, box);
        const other = frameExtentIn(many, box);
        expect(one, part).not.toBeNull();
        expect(other, part).not.toBeNull();
        for (const side of ['x0', 'y0', 'x1', 'y1'] as const) {
          expect(
            Math.abs((other as PixelBox)[side] - (one as PixelBox)[side]),
            `${part} ${side}`,
          ).toBeLessThanOrEqual(1);
        }
        if (!part.startsWith('handle')) continue;
        for (const picture of [few, many]) {
          const pixels = pixelsIn(picture, box);
          let drawn = 0;
          for (let i = 0; i < pixels.length; i += 4) if (isFrame(pixels, i)) drawn++;
          expect(drawn, part).toBeGreaterThan(HANDLE_PIXELS);
        }
      }
    });
  });
}

describe('the pictures of a selection of many features across the antimeridian', () => {
  const taken = new Map<number, Picture>();
  let page: Page;

  beforeAll(async () => {
    page = await openMapPage(browser, bundle, DATELINE_CAMERA);
  }, browserTimeout(90_000));

  afterAll(async () => {
    await page?.close();
  });

  for (const scene of DATELINE_SCENES) {
    it(scene.name, async () => {
      const picture = await take(page, scene);
      taken.set(scene.count, picture);
      if (OUT) await writePicture(OUT, scene.name, picture);
    });
  }

  it('frame the features of each copy of the world with their handles the same way at both counts', () => {
    const [few, many] = MANY_COUNTS.map((count) => taken.get(count));
    if (!few || !many) throw new Error('the pictures of the two counts were not taken');
    // Past a few, the frames are drawn from the rows: their lines may differ by a few levels at
    // their edges. Beyond that, the pictures differ by the point added and its frame only, in a
    // box of a few tens of pixels: the frames of all of them and their handles, one set on each
    // copy of the world, are where they are at both counts
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    let changed = 0;
    for (let i = 0; i < few.pixels.length; i += 4) {
      let largest = 0;
      for (let c = 0; c < 4; c++) {
        largest = Math.max(largest, Math.abs(few.pixels[i + c] - many.pixels[i + c]));
      }
      if (largest <= 8) continue;
      changed++;
      const x = (i / 4) % few.width;
      const y = Math.floor(i / 4 / few.width);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    expect(changed).toBeGreaterThan(0);
    expect(x1 - x0).toBeLessThanOrEqual(40);
    expect(y1 - y0).toBeLessThanOrEqual(40);
  });
});

// ============================================================================
// The points behind the peak
// ============================================================================

/** The alpha of the line of a frame drawn faint, where it covers its pixels whole */
const FAINT_ALPHA = Math.round(255 * TERRAIN_GHOST_OPACITY);

/**
 * The pixels of the color of the frames in a box of the drawing buffer that a line of a frame
 * covers whole: those of a faint frame, and those of a frame drawn in full (the frame of all the
 * features selected can pass by the box); and the sum of the alpha of the pixels of the color of
 * the frames (it stays when a line moves by a part of a pixel)
 */
function frameLinesIn(
  picture: Picture,
  box: PixelBox,
): { faint: number; full: number; ink: number } {
  const pixels = pixelsIn(picture, box);
  const [r, g, b] = FRAME_COLOR;
  let faint = 0;
  let full = 0;
  let ink = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3];
    const scale = alpha / 255;
    if (
      Math.abs(pixels[i] - r * scale) >= 4 ||
      Math.abs(pixels[i + 1] - g * scale) >= 4 ||
      Math.abs(pixels[i + 2] - b * scale) >= 4
    ) {
      continue;
    }
    ink += alpha;
    if (Math.abs(alpha - FAINT_ALPHA) <= 4) faint++;
    else if (alpha >= 240) full++;
  }
  return { faint, full, ink };
}

describe('the pictures of the points behind the peak', () => {
  const taken = new Map<string, Picture>();
  let page: Page;

  beforeAll(async () => {
    page = await openMapPage(browser, bundle, GHOST_CAMERA);
    await page.evaluate(async (exaggeration) => {
      const w = window as unknown as PicturesWindow;
      await w.e2e.terrain.addTestTerrain(w.map, exaggeration);
    }, TERRAIN_EXAGGERATION);
  }, browserTimeout(90_000));

  afterAll(async () => {
    await page?.close();
  });

  for (const scene of GHOST_SCENES) {
    it(scene.name, async () => {
      const picture = await take(page, scene);
      taken.set(scene.name, picture);
      if (OUT) await writePicture(OUT, scene.name, picture);
    });
  }

  it('frame a point behind the peak as faint at both counts, and fainter than one in front', async () => {
    const few = taken.get('ghost/few');
    const many = taken.get('ghost/many');
    if (!few || !many) throw new Error('the pictures of the two counts were not taken');
    // The box of the frame of a point: its marker and the margin around it, and the line
    const boxes = await page.evaluate(
      (points) => {
        const { map } = window as unknown as E2EWindow;
        const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
        const ratio = gl.drawingBufferWidth / map.getCanvas().clientWidth;
        return points.map((at) => {
          const p = map.project(at as [number, number]);
          const reach = 24 * ratio;
          return {
            x0: Math.max(0, Math.floor(p.x * ratio - reach)),
            y0: Math.max(0, Math.floor(p.y * ratio - reach)),
            x1: Math.min(gl.drawingBufferWidth, Math.ceil(p.x * ratio + reach)),
            y1: Math.min(gl.drawingBufferHeight, Math.ceil(p.y * ratio + reach)),
          };
        });
      },
      [...GHOST_POINTS.hidden, ...GHOST_POINTS.seen] as unknown as number[][],
    );
    const hidden = GHOST_POINTS.hidden.length;
    for (const [i, box] of boxes.entries()) {
      const behind = i < hidden;
      const id = behind ? ghostPointId('hidden', i) : ghostPointId('seen', i - hidden);
      const [one, other] = [frameLinesIn(few, box), frameLinesIn(many, box)];
      for (const lines of [one, other]) {
        if (behind) expect(lines.faint, id).toBeGreaterThan(lines.full);
        else expect(lines.full, id).toBeGreaterThan(lines.faint);
      }
      // As faint at both counts
      expect(Math.abs(other.ink - one.ink), id).toBeLessThanOrEqual(one.ink * 0.15);
    }
  });
});

// ============================================================================
// The textures the rows are read from
// ============================================================================

for (const map of MAPS) {
  const scenes = ROWS_SCENES.filter((scene) => scene.map === map);
  describe(`the pictures of the textures of the rows on the ${map} map`, () => {
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
  });
}
