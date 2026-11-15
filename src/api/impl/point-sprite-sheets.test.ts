// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sheets of pictures of the points (`ctx.addPointSprites`, `ctx.webgl.spriteTexture`)
 *
 * - The texture is made, written and given back in the pass of a frame, under the name of the
 *   plugin in the ledger; the library keeps no image once it is written
 * - What is too large is refused before anything is made, and the sheet stays as it was
 * - The ledger comes back to 0 when the plugin is removed, when the instance is destroyed, when
 *   the context is lost, and after a failure that shows later (out of memory, told in
 *   `status.problems`)
 * - A lost context comes back with an empty texture of the last size: another texture, which the
 *   plugin writes again
 * - `sprite` is asked again once in a frame, however many times `update` is called
 * - The examples: flags by an attribute (the whole image replaced, written again when the context
 *   comes back), and pictures by an attribute put one by one as they arrive (written in place,
 *   the sheet made larger when it is full)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Plugin, RowSprite, RowSpriteSheet } from '../../extend/index.js';
import { MemoryStore } from '../../store/memory.js';
import type { Feature as StoredFeature } from '../../store/types.js';
import { createMapStub } from '../../test-utils.js';
import type { PointSpriteSheetSource } from '../../view/renderers/point/point-sprites.js';
import type { Draw } from '../draw.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine, type Engine } from './engine.js';

/** A small image: only its size is read, and it is handed to `texSubImage2D` as it is */
const image = (width: number, height: number): ImageBitmap =>
  ({ width, height, close() {} }) as unknown as ImageBitmap;

/** A context that counts what is alive and what is written */
function context() {
  const alive = new Set<object>();
  const lost = { value: false };
  const error = { value: 0 };
  const writes: Array<{ texture: object | null; x: number; y: number; image: unknown }> = [];
  let bound: object | null = null;
  const known: Record<string, unknown> = {
    TEXTURE_2D: 0x0de1,
    RGBA: 0x1908,
    RGBA8: 0x8058,
    UNSIGNED_BYTE: 0x1401,
    SYNC_STATUS: 0x9114,
    SIGNALED: 0x9119,
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    NO_ERROR: 0,
    OUT_OF_MEMORY: 0x0505,
    createTexture() {
      const texture = {};
      alive.add(texture);
      return texture;
    },
    deleteTexture: (texture: object) => alive.delete(texture),
    bindTexture: (_target: number, texture: object | null) => {
      bound = texture;
    },
    texSubImage2D: (...args: unknown[]) => {
      writes.push({ texture: bound, x: args[2] as number, y: args[3] as number, image: args[6] });
    },
    fenceSync() {
      const sync = { sync: true };
      alive.add(sync);
      return sync;
    },
    deleteSync: (sync: object) => alive.delete(sync),
    getSyncParameter: () => 0x9119,
    getError: () => {
      const value = error.value;
      error.value = 0;
      return value;
    },
    isContextLost: () => lost.value,
  };
  const gl = new Proxy(known, {
    get: (target, name: string) => target[name] ?? (() => {}),
  }) as unknown as WebGL2RenderingContext;
  /** The textures alive (the fences left out) */
  const textures = (): number => [...alive].filter((object) => !('sync' in object)).length;
  return { gl, alive, lost, error, writes, textures };
}

interface Opened {
  readonly engine: Engine;
  readonly draw: Draw;
  /** The sheets put into the drawing, in their order */
  readonly sheets: PointSpriteSheetSource[];
  /** The bytes held under an owner */
  bytesOf(owner: string): number;
  /** Gives every sheet the context, as the map does */
  attach(gl: WebGL2RenderingContext): void;
  /** The map took the context away */
  detach(): void;
  /** Lets a frame begin: what waits for it is done */
  frame(): void;
  /** Tells the map drew a frame (`render`) */
  rendered(): void;
  /** A point feature, as the drawing reads it */
  point(properties: Record<string, unknown>): StoredFeature;
}

const opened: Draw[] = [];

afterEach(() => {
  for (const draw of opened.splice(0)) draw.destroy();
  vi.restoreAllMocks();
});

/** An instance whose limit of the GPU is `limitBytes` */
function open(limitBytes = 1_000_000): Opened {
  const store = new MemoryStore();
  const stub = createMapStub();
  const engine = createEngine(
    stub.map,
    { store, initDefaultLayer: false, gpuLimitBytes: limitBytes },
    { deferDefaultMode: true },
  );
  const sheets: PointSpriteSheetSource[] = [];
  const register = engine.customLayer.registerPointSprites.bind(engine.customLayer);
  vi.spyOn(engine.customLayer, 'registerPointSprites').mockImplementation((sheet) => {
    sheets.push(sheet);
    const remove = register(sheet);
    return () => {
      sheets.splice(sheets.indexOf(sheet), 1);
      remove();
    };
  });
  const draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  opened.push(draw);
  const ledger = engine.customLayer.getGpuLedger();
  return {
    engine,
    draw,
    sheets,
    bytesOf: (owner) => ledger.snapshot().byOwner[owner] ?? 0,
    attach: (gl) => {
      for (const sheet of sheets) sheet.onAdd(gl);
    },
    detach: () => {
      for (const sheet of sheets) sheet.onRemove();
    },
    frame: () => engine.context.pointSprites.beginFrame(),
    rendered: () => stub.fireMap('render'),
    point: (properties) =>
      ({
        id: `p${Math.random()}`,
        type: 'Point',
        geometry: { type: 'Point', coordinates: [0, 0] },
        layerId: 'l',
        groupId: undefined,
        properties,
        style: {},
        visible: true,
        locked: false,
      }) as StoredFeature,
  };
}

/** A plugin that adds one sheet and gives it back, and what `sprite` was asked */
function sheetPlugin(
  definition: { gpuShare?: number; image?: ImageBitmap; sprite?: () => RowSprite | null } = {},
  name = 'acme',
) {
  const asked = vi.fn(definition.sprite ?? (() => null));
  const plugin: Plugin<{ sheet: RowSpriteSheet; texture: () => WebGLTexture | null }> = {
    name,
    setup(ctx) {
      const sheet = ctx.addPointSprites({
        gpuShare: definition.gpuShare ?? 0.5,
        image: definition.image ?? image(64, 32),
        sprite: asked,
      });
      return { sheet, texture: () => ctx.webgl.spriteTexture(sheet) };
    },
  };
  return { plugin, asked };
}

describe('a sheet of pictures', () => {
  it('is made and written in a frame once the map gives a context, under the plugin', () => {
    const view = open();
    const { gl, writes, textures } = context();
    const { plugin } = sheetPlugin();
    const { texture } = view.draw.use(plugin);
    expect(texture()).toBeNull();
    expect(view.bytesOf('acme')).toBe(0);
    view.attach(gl);
    // Nothing touches the context outside a frame
    expect(textures()).toBe(0);
    view.frame();
    expect(textures()).toBe(1);
    expect(view.bytesOf('acme')).toBe(64 * 32 * 4);
    expect(writes).toEqual([{ texture: texture(), x: 0, y: 0, image: expect.anything() }]);
    // The image is written once: nothing waits any more
    view.frame();
    expect(writes).toHaveLength(1);
  });

  it('refuses an image past its part of the limit, adding nothing', () => {
    const view = open(10_000);
    const { plugin } = sheetPlugin({ gpuShare: 0.5, image: image(64, 32) });
    expect(() => view.draw.use(plugin)).toThrow(
      expect.objectContaining({ code: 'tooLarge', retryable: false }),
    );
    expect(view.sheets).toHaveLength(0);
    // Its share was not taken: the whole part of the extensions is still there
    const { plugin: small } = sheetPlugin({ gpuShare: 0.9, image: image(16, 16) }, 'small');
    expect(() => view.draw.use(small)).not.toThrow();
  });

  it('refuses shares that come to more than 0.9', () => {
    const view = open();
    view.draw.use(sheetPlugin({ gpuShare: 0.6, image: image(8, 8) }, 'a').plugin);
    expect(() =>
      view.draw.use(sheetPlugin({ gpuShare: 0.4, image: image(8, 8) }, 'b').plugin),
    ).toThrow(expect.objectContaining({ code: 'tooLarge' }));
    expect(view.sheets).toHaveLength(1);
  });

  it('refuses what is not a definition', () => {
    const view = open();
    const bad = (definition: unknown): Plugin => ({
      name: 'bad',
      setup: (ctx) => {
        ctx.addPointSprites(definition as never);
      },
    });
    for (const definition of [
      null,
      { gpuShare: 0, image: image(8, 8), sprite: () => null },
      { gpuShare: 0.1, image: {}, sprite: () => null },
      { gpuShare: 0.1, image: image(8, 8) },
    ]) {
      expect(() => view.draw.use(bad(definition))).toThrow(
        expect.objectContaining({ code: 'invalidInput' }),
      );
    }
    expect(view.sheets).toHaveLength(0);
  });

  it('replaces its whole image, taking its size, and stays as it was past its part', () => {
    const view = open(100_000);
    const { gl, writes, textures } = context();
    const { sheet, texture } = view.draw.use(sheetPlugin({ gpuShare: 0.5 }).plugin);
    view.attach(gl);
    view.frame();
    const first = texture();
    sheet.update(image(64, 32));
    view.frame();
    // The same size: written into the same texture
    expect(texture()).toBe(first);
    expect(writes).toHaveLength(2);
    // Past its part of the limit (50,000 bytes)
    expect(() => sheet.update(image(128, 128))).toThrow(
      expect.objectContaining({ code: 'tooLarge' }),
    );
    view.frame();
    expect(texture()).toBe(first);
    expect(view.bytesOf('acme')).toBe(64 * 32 * 4);
    // Another size within it: the texture is made again, the old one given back first
    sheet.update(image(100, 100));
    view.frame();
    expect(texture()).not.toBe(first);
    expect(textures()).toBe(1);
    expect(view.bytesOf('acme')).toBe(100 * 100 * 4);
  });

  it('is written in place, and refuses a place out of it', () => {
    const view = open();
    const { gl, writes } = context();
    const { sheet, texture } = view.draw.use(sheetPlugin().plugin);
    view.attach(gl);
    view.frame();
    sheet.update(image(16, 16), 48, 16);
    view.frame();
    expect(writes[writes.length - 1]).toEqual({
      texture: texture(),
      x: 48,
      y: 16,
      image: expect.anything(),
    });
    for (const [x, y] of [
      [49, 16],
      [0, 17],
      [-1, 0],
      [0.5, 0],
    ]) {
      expect(() => sheet.update(image(16, 16), x, y)).toThrow(
        expect.objectContaining({ code: 'invalidInput' }),
      );
    }
    expect(() => sheet.update(image(16, 16), 0)).toThrow(
      expect.objectContaining({ code: 'invalidInput' }),
    );
  });

  it('is made again empty by a size, and stays as it was past its part', () => {
    const view = open(100_000);
    const { gl, writes, textures } = context();
    const { sheet, texture } = view.draw.use(sheetPlugin({ gpuShare: 0.5 }).plugin);
    view.attach(gl);
    view.frame();
    const first = texture();
    sheet.update(image(8, 8), 0, 0);
    // What waits goes with the sheet it was for
    sheet.resize(128, 64);
    view.frame();
    expect(texture()).not.toBe(first);
    expect(textures()).toBe(1);
    expect(writes).toHaveLength(1);
    expect(view.bytesOf('acme')).toBe(128 * 64 * 4);
    // A write into the new size
    sheet.update(image(8, 8), 120, 56);
    view.frame();
    expect(writes).toHaveLength(2);
    const second = texture();
    expect(() => sheet.resize(256, 256)).toThrow(expect.objectContaining({ code: 'tooLarge' }));
    expect(() => sheet.resize(0, 8)).toThrow(expect.objectContaining({ code: 'invalidInput' }));
    view.frame();
    expect(texture()).toBe(second);
    expect(view.bytesOf('acme')).toBe(128 * 64 * 4);
  });

  it('gives everything back with the plugin, and with the instance', () => {
    const view = open();
    const { gl, alive } = context();
    view.draw.use(sheetPlugin({}, 'a').plugin);
    const { texture } = view.draw.use(sheetPlugin({ gpuShare: 0.3 }, 'b').plugin);
    view.attach(gl);
    view.frame();
    expect(alive.size).toBeGreaterThan(0);
    view.draw.extensions.plugins.remove('b');
    expect(view.bytesOf('b')).toBe(0);
    expect(texture()).toBeNull();
    expect(view.bytesOf('a')).toBeGreaterThan(0);
    view.draw.destroy();
    expect(alive.size).toBe(0);
    expect(view.engine.customLayer.getGpuLedger().snapshot().objects).toBe(0);
  });

  it('comes back empty of the last size after a lost context: another texture', () => {
    const view = open();
    const { gl, alive, lost, writes } = context();
    const { sheet, texture } = view.draw.use(sheetPlugin().plugin);
    view.attach(gl);
    view.frame();
    sheet.resize(128, 128);
    view.frame();
    const before = texture();
    lost.value = true;
    view.detach();
    expect(view.bytesOf('acme')).toBe(0);
    expect(alive.size).toBe(0);
    expect(texture()).toBeNull();
    // A write while it is lost is not kept
    sheet.update(image(8, 8), 0, 0);
    lost.value = false;
    view.attach(gl);
    view.frame();
    const after = texture();
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(view.bytesOf('acme')).toBe(128 * 128 * 4);
    // Empty: nothing written into it
    expect(writes.filter((write) => write.texture === after)).toHaveLength(0);
  });

  it('gives its texture back when the GPU runs out of memory, told as a problem', () => {
    const view = open();
    const { gl, error } = context();
    const { texture } = view.draw.use(
      sheetPlugin({ sprite: () => ({ uv: [0, 0, 1, 1], halfWidthPixels: 4, halfHeightPixels: 4 }) })
        .plugin,
    );
    view.attach(gl);
    view.frame();
    const point = view.point({});
    expect(view.engine.context.pointSprites.ofFeature(point)).not.toBeNull();
    error.value = gl.OUT_OF_MEMORY;
    // Read once the fence after the texture is passed
    view.frame();
    expect(texture()).toBeNull();
    expect(view.bytesOf('acme')).toBe(0);
    // Its points keep their markers
    view.frame();
    expect(view.engine.context.pointSprites.ofFeature(view.point({}))).toBeNull();
    const problem = view.draw.status.value.problems.find((p) => p.label === 'acme');
    expect(problem).toBeDefined();
    expect(problem?.error.code).toBe('invalidState');
    expect(String((problem?.error.cause as Error | undefined)?.message)).toContain('OUT_OF_MEMORY');
  });

  it('asks sprite again once in a frame, however many times it is updated', () => {
    const view = open();
    const { gl } = context();
    const { sheet } = view.draw.use(
      sheetPlugin({ sprite: () => ({ uv: [0, 0, 1, 1], halfWidthPixels: 4, halfHeightPixels: 4 }) })
        .plugin,
    );
    view.attach(gl);
    view.frame();
    const sprites = view.engine.context.pointSprites;
    const generation = sprites.generation();
    sheet.update();
    sheet.update(image(8, 8), 0, 0);
    sheet.update();
    expect(sprites.generation()).toBe(generation);
    view.frame();
    expect(sprites.generation()).toBe(generation + 1);
    view.frame();
    expect(sprites.generation()).toBe(generation + 1);
  });

  it('tells a sprite that throws or gives what is not a picture, the point keeping its marker', () => {
    const view = open();
    const { gl } = context();
    let give: () => unknown = () => {
      throw new Error('in sprite');
    };
    view.draw.use(sheetPlugin({ sprite: () => give() as RowSprite }).plugin);
    view.attach(gl);
    view.frame();
    const sprites = view.engine.context.pointSprites;
    expect(sprites.ofFeature(view.point({}))).toBeNull();
    give = () => ({ uv: [0, 0, 1], halfWidthPixels: 4, halfHeightPixels: 4 });
    expect(sprites.ofFeature(view.point({}))).toBeNull();
    const problems = view.draw.status.value.problems.filter((p) => p.label === 'acme');
    expect(problems).toHaveLength(2);
  });
});

type Uv = readonly [number, number, number, number];

/**
 * The example of flags: a sheet of every flag, the picture of a point chosen by an attribute. The
 * whole image is replaced by the function the plugin gives; a lost context comes back with
 * another, empty texture, which the plugin sees after a frame and writes the image into again
 */
const flags = (
  first: ImageBitmap,
  places: ReadonlyMap<string, Uv>,
): Plugin<(next: ImageBitmap) => void> => ({
  name: 'acme-flags',
  setup(ctx) {
    let current = first;
    const sheet = ctx.addPointSprites({
      gpuShare: 0.05,
      image: first,
      sprite(row) {
        const country = row.property('acme:country');
        const uv = typeof country === 'string' ? places.get(country) : undefined;
        return uv ? { uv, halfWidthPixels: 12, halfHeightPixels: 8 } : null;
      },
    });
    // The texture the image was written into: another one is empty
    let seen: WebGLTexture | null = null;
    const check = (): void => {
      const texture = ctx.webgl.spriteTexture(sheet);
      if (texture && seen && texture !== seen) sheet.update(current);
      if (texture) seen = texture;
    };
    ctx.map.on('render', check);
    ctx.signal.addEventListener('abort', () => ctx.map.off('render', check));
    return (next) => {
      current = next;
      // The image of another size makes another texture, written already
      seen = null;
      sheet.update(next);
    };
  },
});

/**
 * The example of pictures put as they arrive: a point names the URL of its picture, each picture
 * is put into the next cell of the sheet once it is loaded, and the sheet is made twice as large,
 * every picture put again, when it is full. The plugin keeps the pictures it loaded (its own
 * choice) and puts them again when the context comes back
 */
const pictures = (
  empty: ImageBitmap,
  load: (url: string) => Promise<ImageBitmap>,
  cell = 32,
): Plugin<void> => ({
  name: 'acme-pictures',
  setup(ctx) {
    let size = empty.width;
    const placed = new Map<string, { readonly at: number; readonly image: ImageBitmap }>();
    const loading = new Set<string>();
    const place = (at: number): readonly [number, number] => {
      const per = size / cell;
      return [(at % per) * cell, Math.floor(at / per) * cell];
    };
    const sheet = ctx.addPointSprites({
      gpuShare: 0.5,
      image: empty,
      sprite(row) {
        const url = row.property('acme:picture');
        if (typeof url !== 'string') return null;
        const known = placed.get(url);
        if (!known) {
          if (!loading.has(url)) {
            loading.add(url);
            void load(url).then((image) => arrive(url, image));
          }
          return null;
        }
        const [x, y] = place(known.at);
        return {
          uv: [x / size, y / size, (x + cell) / size, (y + cell) / size],
          halfWidthPixels: cell / 2,
          halfHeightPixels: cell / 2,
        };
      },
    });
    const putAll = (): void => {
      for (const { at, image: picture } of placed.values()) sheet.update(picture, ...place(at));
    };
    const arrive = (url: string, picture: ImageBitmap): void => {
      if (ctx.signal.aborted) return;
      const at = placed.size;
      placed.set(url, { at, image: picture });
      if (at < (size / cell) ** 2) {
        sheet.update(picture, ...place(at));
        return;
      }
      // Full: twice as large, every picture put again
      size *= 2;
      sheet.resize(size, size);
      seen = null;
      putAll();
    };
    let seen: WebGLTexture | null = null;
    const check = (): void => {
      const texture = ctx.webgl.spriteTexture(sheet);
      if (texture && seen && texture !== seen) putAll();
      if (texture) seen = texture;
    };
    ctx.map.on('render', check);
    ctx.signal.addEventListener('abort', () => ctx.map.off('render', check));
  },
});

describe('the examples of the sheets of pictures', () => {
  it('gives a point the flag of its country, and the marker to a country without one', () => {
    const view = open();
    const { gl, writes } = context();
    const first = image(64, 32);
    const replace = view.draw.use(
      flags(
        first,
        new Map<string, Uv>([
          ['jp', [0, 0, 0.5, 1]],
          ['fr', [0.5, 0, 1, 1]],
        ]),
      ),
    );
    view.attach(gl);
    view.frame();
    view.rendered();
    const sheets = view.engine.context.pointSprites;
    expect(sheets.ofFeature(view.point({ 'acme:country': 'fr' }))?.sprite).toEqual({
      uv: [0.5, 0, 1, 1],
      halfWidth: 12,
      halfHeight: 8,
      rotates: false,
    });
    expect(sheets.ofFeature(view.point({ 'acme:country': 'xx' }))).toBeNull();
    expect(writes.map((write) => write.image)).toEqual([first]);
    // The whole image replaced
    const next = image(64, 32);
    replace(next);
    view.frame();
    view.rendered();
    expect(writes.map((write) => write.image)).toEqual([first, next]);
  });

  it('writes the flags again when the context comes back', () => {
    const view = open();
    const { gl, lost, writes } = context();
    const first = image(64, 32);
    view.draw.use(flags(first, new Map<string, Uv>([['jp', [0, 0, 1, 1]]])));
    view.attach(gl);
    view.frame();
    view.rendered();
    lost.value = true;
    view.detach();
    lost.value = false;
    view.attach(gl);
    // The new texture is empty until the plugin sees it after a frame
    view.frame();
    view.rendered();
    expect(writes).toHaveLength(1);
    view.frame();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({ texture: writes[1].texture, x: 0, y: 0, image: first });
    expect(writes[1].texture).not.toBe(writes[0].texture);
    // Nothing more once it is written
    view.rendered();
    view.frame();
    expect(writes).toHaveLength(2);
  });

  it('puts the pictures as they arrive, and makes the sheet larger when it is full', async () => {
    const view = open();
    const { gl, lost, writes } = context();
    const loaded = new Map<string, ImageBitmap>();
    const load = vi.fn(async (url: string) => {
      const picture = image(32, 32);
      loaded.set(url, picture);
      return picture;
    });
    view.draw.use(pictures(image(64, 64), load));
    view.attach(gl);
    view.frame();
    view.rendered();
    const sheets = view.engine.context.pointSprites;
    const points = ['a', 'b', 'c', 'd', 'e'].map((url) => view.point({ 'acme:picture': url }));
    // Not loaded yet: the markers, each picture loaded once
    for (const p of points) expect(sheets.ofFeature(p)).toBeNull();
    for (const p of points) sheets.ofFeature(view.point({ ...p.properties }));
    expect(load).toHaveBeenCalledTimes(5);
    await Promise.resolve();
    await Promise.resolve();
    view.frame();
    view.rendered();
    // The fifth did not fit the 2 × 2 cells: twice as large, every picture put again in its cell
    expect(view.bytesOf('acme-pictures')).toBe(128 * 128 * 4);
    const last = writes.slice(-5);
    expect(last.map((write) => [write.x, write.y])).toEqual([
      [0, 0],
      [32, 0],
      [64, 0],
      [96, 0],
      [0, 32],
    ]);
    expect(last.map((write) => write.image)).toEqual(
      ['a', 'b', 'c', 'd', 'e'].map((u) => loaded.get(u)),
    );
    expect(new Set(last.map((write) => write.texture)).size).toBe(1);
    expect(sheets.ofFeature(view.point({ 'acme:picture': 'e' }))?.sprite.uv).toEqual([
      0, 0.25, 0.25, 0.5,
    ]);
    // The pictures put again once the context comes back
    const count = writes.length;
    lost.value = true;
    view.detach();
    lost.value = false;
    view.attach(gl);
    view.frame();
    view.rendered();
    view.frame();
    expect(writes).toHaveLength(count + 5);
    expect(writes.slice(-5).map((write) => [write.x, write.y])).toEqual(
      last.map((write) => [write.x, write.y]),
    );
    expect(writes[writes.length - 1].texture).not.toBe(last[0].texture);
  });
});
