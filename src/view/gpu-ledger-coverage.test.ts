// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Nothing the drawing allocates on the GPU is left out of the ledger of its instance
 *
 * A GL counts what it is asked for, on its own: the objects it makes and has not deleted, by kind
 * (a buffer, a texture, a render buffer, a frame buffer, a vertex array, a program, a shader),
 * the bytes `bufferData` gives the buffer bound to its target (the index buffer of the vertex
 * array bound), the bytes of the levels `texStorage2D` and `texImage2D` make (the whole chain
 * after `generateMipmap`) and the bytes of `renderbufferStorage`. An instance draws on it the ways
 * it draws (a flat map, the globe, the terrain), and what the GL holds is compared with the ledger
 * of the instance: every object the GL holds is in the ledger, and the bytes agree, buffers and
 * textures apart. A part that allocates without recording, or deletes without taking out, makes
 * the two differ.
 *
 * When the GPU side of the instance goes (the instance destroyed, the context lost, the style
 * swapped), the GL holds nothing and neither does the ledger. A part that forgets something is
 * found there: it is deleted and counted.
 *
 * Then the limit: after every allocation, the bytes held outside the rows stay under it, each part
 * that is always held within its ceiling and the parts that give way within their share (the
 * images give up what is not on the screen, draw smaller and wait, keeping their decoded image;
 * the drape draws without its tables, its meshes or its glyphs), the rows are not held under it,
 * and what is held outside the rows does not grow with the features.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrawOnEngine } from '../api/impl/create-draw.js';
import { createEngine } from '../api/impl/engine.js';
import { checkDrawOptions, toEngineOptions } from '../api/impl/options.js';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../shared/config/feature-style.js';
import { DEFAULT_RENDERING_CONFIG } from '../shared/config/rendering.js';
import { DEFAULT_SELECTION_CONFIG } from '../shared/config/selection.js';
import { createStore } from '../store/built-in/create-store.js';
import { RBushSpatialIndex } from '../store/spatial/spatial-index.js';
import {
  createDrawingMapStub,
  createSyntheticInput,
  createTestDocument,
  expectNotProportional,
  gridPoints,
  renderInput,
} from '../test-utils.js';
import { BufferCache } from './cache/buffer.js';
import { TextureCache } from './cache/texture.js';
import {
  DEFAULT_GPU_LIMIT_BYTES,
  GPU_FLOOR_BYTES,
  GpuLedger,
  HELD_PART_CEILINGS,
  mipmappedTextureBytes,
} from './gpu-ledger.js';
import { createRenderScope } from './layer/render-scope.js';
import { disposeRenderers, initRenderers } from './layer/renderers.js';
import { createProgram } from './shaders/helpers.js';
import { computeAtlasLayout, DemAtlas } from './terrain/dem-atlas.js';
import { terrainMeshBytes } from './terrain/drape/mesh.js';
import {
  type DrapeQuadCorners,
  type QuadDrapeFrame,
  QuadDrapeRenderer,
  type QuadDrapeSurface,
} from './terrain/drape/quad.js';
import { DrapeRenderer } from './terrain/drape/renderer.js';
import { getTerrainDrapeDebug, isTerrainElevationActive } from './terrain/state.js';
import { createSelectionScope } from './ui/selection-scope.js';

// ---------------------------------------------------------------------------
// The GL that counts what it is asked for
// ---------------------------------------------------------------------------

/** The bytes of a texel of each internal format the drawing allocates */
const TEXEL_BYTES: Readonly<Record<string, number>> = {
  R8: 1,
  RG8: 2,
  RGBA8: 4,
  R8UI: 1,
  R16F: 2,
  RGBA16F: 8,
  R32F: 4,
  RG32F: 8,
  RGBA32F: 16,
  DEPTH_COMPONENT24: 4,
};

/** The bytes of a texel of a format, sized or not (an unsized one by its type) */
function texelBytes(internalFormat: unknown, type?: unknown): number {
  const name = String(internalFormat);
  const sized = TEXEL_BYTES[name];
  if (sized !== undefined) return sized;
  if (name === 'RGBA' && type === 'UNSIGNED_BYTE') return 4;
  if (name === 'RGBA' && type === 'FLOAT') return 16;
  // A format this test does not know: add it to the table, with what it takes
  throw new Error(`the counting GL does not know the format ${name} (${String(type)})`);
}

/** The bytes of the levels of a texture, from level 0 of a size */
function levelBytes(width: number, height: number, bytes: number, levels: number): number {
  let w = width;
  let h = height;
  let total = 0;
  for (let level = 0; level < levels; level++) {
    total += w * h * bytes;
    if (w === 1 && h === 1) break;
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }
  return total;
}

/** The kind of the object each call makes */
const MADE: Readonly<Record<string, string>> = {
  createBuffer: 'buffer',
  createTexture: 'texture',
  createRenderbuffer: 'renderbuffer',
  createFramebuffer: 'framebuffer',
  createVertexArray: 'vertex-array',
  createProgram: 'program',
  createShader: 'shader',
  createTransformFeedback: 'transform-feedback',
  createQuery: 'query',
  createSampler: 'sampler',
};

/** The kind of the object each call deletes */
const DELETED: Readonly<Record<string, string>> = {
  deleteBuffer: 'buffer',
  deleteTexture: 'texture',
  deleteRenderbuffer: 'renderbuffer',
  deleteFramebuffer: 'framebuffer',
  deleteVertexArray: 'vertex-array',
  deleteProgram: 'program',
  deleteShader: 'shader',
  deleteTransformFeedback: 'transform-feedback',
  deleteQuery: 'query',
  deleteSampler: 'sampler',
};

/** The calls that give something storage */
const ALLOCATIONS = ['bufferData', 'texStorage2D', 'texImage2D', 'renderbufferStorage'];

interface Storage {
  readonly kind: 'buffer' | 'texture' | 'renderbuffer';
  bytes: number;
  /** Level 0 of a texture and its texel, for `generateMipmap` */
  width?: number;
  height?: number;
  texel?: number;
}

/**
 * A WebGL2 context that keeps every object it makes until it is deleted, with the storage of the
 * buffers, the textures and the render buffers, and accepts every other call
 *
 * The constants are their names, so the formats can be read back.
 */
function storageGL() {
  const live = new Map<object, string>();
  const storage = new Map<object, Storage>();
  const bound = new Map<unknown, object | null>();
  /** The index buffer of each vertex array (null: the default one) */
  const elements = new Map<object | null, object | null>();
  let vertexArray: object | null = null;
  /** The texture bound to each unit */
  const units = new Map<unknown, object | null>();
  let unit: unknown = 'TEXTURE0';
  let renderbuffer: object | null = null;
  let next = 1;
  const state = { lost: false };

  const bufferOf = (target: unknown): object | null =>
    target === 'ELEMENT_ARRAY_BUFFER'
      ? (elements.get(vertexArray) ?? null)
      : (bound.get(target) ?? null);

  const calls: Record<string, (...args: unknown[]) => unknown> = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    getUniformLocation: (_program, name) => ({ name }),
    getAttribLocation: () => 0,
    getUniformBlockIndex: () => 0,
    getSupportedExtensions: () => [],
    getExtension: () => null,
    isContextLost: () => state.lost,
    isEnabled: () => false,
    getError: () => 'NO_ERROR',
    checkFramebufferStatus: () => 'FRAMEBUFFER_COMPLETE',
    getParameter: (name) => {
      if (name === 'VIEWPORT') return new Int32Array([0, 0, 800, 600]);
      if (name === 'FRAMEBUFFER_BINDING') return null;
      if (name === 'TEXTURE_BINDING_2D') return units.get(unit) ?? null;
      if (name === 'UNPACK_FLIP_Y_WEBGL' || name === 'UNPACK_PREMULTIPLY_ALPHA_WEBGL') {
        return false;
      }
      return 4096;
    },
    bindBuffer: (target, buffer) => {
      if (target === 'ELEMENT_ARRAY_BUFFER') elements.set(vertexArray, buffer as object | null);
      else bound.set(target, buffer as object | null);
    },
    bindVertexArray: (array) => {
      vertexArray = (array as object | null) ?? null;
    },
    activeTexture: (texture) => {
      unit = texture;
    },
    bindTexture: (_target, texture) => {
      units.set(unit, (texture as object | null) ?? null);
    },
    bindRenderbuffer: (_target, buffer) => {
      renderbuffer = (buffer as object | null) ?? null;
    },
    bufferData: (target, data, _usage, srcOffset, length) => {
      const buffer = bufferOf(target);
      if (!buffer) throw new Error(`bufferData with no buffer bound to ${String(target)}`);
      let bytes: number;
      if (typeof data === 'number') bytes = data;
      else {
        const view = data as ArrayBufferView & { BYTES_PER_ELEMENT?: number };
        const element = view.BYTES_PER_ELEMENT ?? 1;
        if (typeof length === 'number') bytes = length * element;
        else bytes = view.byteLength - ((srcOffset as number | undefined) ?? 0) * element;
      }
      storage.set(buffer, { kind: 'buffer', bytes });
    },
    texStorage2D: (_target, levels, internalFormat, width, height) => {
      const texture = units.get(unit);
      if (!texture) throw new Error('texStorage2D with no texture bound');
      const texel = texelBytes(internalFormat);
      const w = width as number;
      const h = height as number;
      storage.set(texture, {
        kind: 'texture',
        bytes: levelBytes(w, h, texel, levels as number),
        width: w,
        height: h,
        texel,
      });
    },
    texImage2D: (...args) => {
      const texture = units.get(unit);
      if (!texture) throw new Error('texImage2D with no texture bound');
      // Only level 0 is made here (no part of the drawing writes the levels by hand)
      if (args[1] !== 0) throw new Error('texImage2D of a level above 0');
      let width: number;
      let height: number;
      let texel: number;
      if (args.length >= 9) {
        width = args[3] as number;
        height = args[4] as number;
        texel = texelBytes(args[2], args[7]);
      } else {
        const source = args[5] as { width: number; height: number };
        width = source.width;
        height = source.height;
        texel = texelBytes(args[2], args[4]);
      }
      storage.set(texture, {
        kind: 'texture',
        bytes: width * height * texel,
        width,
        height,
        texel,
      });
    },
    generateMipmap: () => {
      const texture = units.get(unit);
      const held = texture ? storage.get(texture) : undefined;
      if (!held || held.width === undefined || held.height === undefined || !held.texel) {
        throw new Error('generateMipmap of a texture with no level 0');
      }
      const levels = Math.floor(Math.log2(Math.max(held.width, held.height))) + 1;
      held.bytes = levelBytes(held.width, held.height, held.texel, levels);
    },
    renderbufferStorage: (_target, internalFormat, width, height) => {
      if (!renderbuffer) throw new Error('renderbufferStorage with no render buffer bound');
      storage.set(renderbuffer, {
        kind: 'renderbuffer',
        bytes: (width as number) * (height as number) * texelBytes(internalFormat),
      });
    },
  };
  for (const [name, kind] of Object.entries(MADE)) {
    calls[name] = () => {
      if (state.lost) return null;
      const object = { kind, id: next++ };
      live.set(object, kind);
      return object;
    };
  }
  for (const name of Object.keys(DELETED)) {
    calls[name] = (object) => {
      if (!object) return;
      live.delete(object as object);
      storage.delete(object as object);
    };
  }

  const target: Record<string, unknown> = {
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    canvas: { width: 800, height: 600, clientWidth: 800 },
  };
  const gl = new Proxy(target, {
    get(t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in t) return t[prop];
      if (/^[A-Z_0-9]+$/.test(prop)) return prop;
      const fn = calls[prop] ?? (() => undefined);
      t[prop] = fn;
      return fn;
    },
  }) as unknown as WebGL2RenderingContext;

  const sum = (kinds: ReadonlyArray<Storage['kind']>): number => {
    let bytes = 0;
    for (const held of storage.values()) if (kinds.includes(held.kind)) bytes += held.bytes;
    return bytes;
  };
  const count = (kind: string): number => [...live.values()].filter((k) => k === kind).length;
  return {
    gl,
    state,
    /** The objects held, with their kind */
    live,
    /** The storage of the objects held */
    storage: storage as ReadonlyMap<object, Storage>,
    /** The bytes of the buffers held */
    bufferBytes: () => sum(['buffer']),
    /** The bytes of the textures and of the render buffers held */
    textureBytes: () => sum(['texture', 'renderbuffer']),
    /** The objects held of a kind */
    count,
    /** The objects held */
    objects: (): number => live.size,
  };
}

type StorageGL = ReturnType<typeof storageGL>;

/**
 * The GL and the ledger hold the same: every object the GL holds is in the ledger and nothing
 * else is, the bytes agree, buffers and textures apart, no shader is left, and the sums of the
 * ledger agree with what it holds
 */
function expectLedgerMatches(mock: StorageGL, ledger: GpuLedger): void {
  const unrecorded = [...mock.live].filter(
    ([object, kind]) => kind !== 'shader' && !ledger.holds(object),
  );
  expect(unrecorded.map(([, kind]) => kind)).toEqual([]);
  const snapshot = ledger.snapshot();
  expect({
    objects: snapshot.objects,
    buffers: snapshot.bufferBytes,
    textures: snapshot.textureBytes,
    shaders: mock.count('shader'),
  }).toEqual({
    objects: mock.objects() - mock.count('shader'),
    buffers: mock.bufferBytes(),
    textures: mock.textureBytes(),
    shaders: 0,
  });
  expect(ledger.audit()).toBe(true);
}

/** The GL and the ledger hold nothing */
function expectNothingHeld(mock: StorageGL, ledger: GpuLedger): void {
  expect(mock.objects()).toBe(0);
  expect(mock.bufferBytes() + mock.textureBytes()).toBe(0);
  expect(ledger.snapshot()).toMatchObject({ bytes: 0, objects: 0 });
  expect(ledger.audit()).toBe(true);
}

/** Has a GL throw at the step-th allocation, as a driver out of memory would fail it */
function failingAt(mock: StorageGL, step: number): void {
  let left = step;
  const gl = mock.gl as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ALLOCATIONS) {
    const call = gl[name] as (...args: unknown[]) => unknown;
    gl[name] = (...args) => {
      left--;
      if (left === 0) throw new Error('no memory');
      return call(...args);
    };
  }
}

/** The parts that give way, as the ledger has them */
const YIELDING_PARTS = new Set(['images', 'drape']);

/**
 * Watches what a GL holds after every allocation it is asked for (a mipmap chain made included):
 * the bytes held outside the rows within the limit of the ledger, those of the parts that give way
 * within their share, and those of each part that is always held within its ceiling. The bytes are
 * the GL's, the parts the ledger's
 */
function watchLimits(mock: StorageGL, ledger: GpuLedger) {
  const broken: string[] = [];
  let allocations = 0;
  const gl = mock.gl as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of [...ALLOCATIONS, 'generateMipmap']) {
    const call = gl[name] as (...args: unknown[]) => unknown;
    gl[name] = (...args) => {
      const result = call(...args);
      allocations++;
      let outside = 0;
      let yielding = 0;
      const held = new Map<string, number>();
      for (const [object, { bytes }] of mock.storage) {
        const part = ledger.partOf(object);
        if (part === undefined) {
          broken.push(`${name}: an object out of the ledger`);
          continue;
        }
        if (ledger.ceilingOf(part) !== undefined) {
          held.set(part, (held.get(part) ?? 0) + bytes);
        } else if (YIELDING_PARTS.has(part)) {
          yielding += bytes;
        } else {
          // The rows are not held under the limit
          continue;
        }
        outside += bytes;
      }
      if (outside > ledger.limitBytes) {
        broken.push(`${name}: ${outside} bytes outside the rows, over ${ledger.limitBytes}`);
      }
      if (yielding > ledger.shareBytes) {
        broken.push(`${name}: ${yielding} bytes giving way, over ${ledger.shareBytes}`);
      }
      for (const [part, bytes] of held) {
        const ceiling = ledger.ceilingOf(part) ?? 0;
        if (bytes > ceiling) broken.push(`${name}: ${bytes} bytes of ${part}, over ${ceiling}`);
      }
      return result;
    };
  }
  return { broken, allocations: (): number => allocations };
}

/** Counts the calls that give something storage */
function countingAllocations(mock: StorageGL): () => number {
  let count = 0;
  const gl = mock.gl as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ALLOCATIONS) {
    const call = gl[name] as (...args: unknown[]) => unknown;
    gl[name] = (...args) => {
      count++;
      return call(...args);
    };
  }
  return () => count;
}

// ---------------------------------------------------------------------------
// What the instances draw
// ---------------------------------------------------------------------------

/** A PNG of one pixel (the decode is the one of FakeImage) */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** The images decoded so far; a test finishes their decode */
let images: FakeImage[] = [];

/** The images made since the test began, each a decode */
let imagesMade = 0;

/** The size of the images the next decodes give */
let imageSize = { width: 300, height: 100 };

class FakeImage {
  width = imageSize.width;
  height = imageSize.height;
  crossOrigin = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  constructor() {
    images.push(this);
    imagesMade++;
  }
}

/** Finishes the decode of every image started, and lets the promises of the decodes settle */
async function decodeImages(): Promise<void> {
  for (const image of images.splice(0)) image.onload?.();
  await Promise.resolve();
  await Promise.resolve();
}

/** A terrain of four DEM tiles over the area the map stub shows */
function demTerrain() {
  const tiles = new Map<string, object>([
    ['7/63/63', { id: 'a' }],
    ['7/64/63', { id: 'b' }],
    ['7/63/64', { id: 'c' }],
    ['7/64/64', { id: 'd' }],
  ]);
  const terrain = {
    exaggeration: 1,
    meshSize: 32,
    tileManager: {
      getRenderableTiles: () =>
        [...tiles.keys()].map((key) => {
          const [z, x, y] = key.split('/').map(Number);
          return { tileID: { canonical: { x, y, z }, key, wrap: 0 } };
        }),
    },
    getTerrainData: (tileID: { key: string }) => ({
      texture: tiles.get(tileID.key),
      u_terrain_matrix: new Float64Array(16).fill(1),
      u_terrain_unpack: [6553.6, 25.6, 0.1, 10000],
      u_terrain_dim: 512,
    }),
  };
  return { terrain, tiles };
}

/** A render input of the globe (the projection on its way to the globe, its shaders) */
function globeInput(): CustomRenderMethodInput {
  const input = renderInput();
  const data = { ...input.defaultProjectionData, projectionTransition: 1 };
  return {
    ...input,
    shaderData: { variantName: 'globe', vertexShaderPrelude: '', define: '' },
    defaultProjectionData: data,
    getProjectionData: () => data,
  } as unknown as CustomRenderMethodInput;
}

/** A square ring at a place, of a side */
function ring(x: number, y: number, side: number): [number, number][] {
  return [
    [x, y],
    [x + side, y],
    [x + side, y + side],
    [x, y + side],
    [x, y],
  ];
}

/** The listeners of the canvas of a map stub, to fire the events of the context */
function canvasEvents(canvas: { addEventListener: unknown; removeEventListener: unknown }) {
  const listeners = new Map<string, Set<() => void>>();
  const add = canvas.addEventListener as (type: string, fn: () => void) => void;
  const remove = canvas.removeEventListener as (type: string, fn: () => void) => void;
  canvas.addEventListener = (type: string, fn: () => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)?.add(fn);
    add(type, fn);
  };
  canvas.removeEventListener = (type: string, fn: () => void) => {
    listeners.get(type)?.delete(fn);
    remove(type, fn);
  };
  return (type: string): void => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn();
  };
}

/**
 * A draw instance over a Store of its own, on a map stub that draws on a GL of its own that
 * counts what it is asked for
 */
function ledgerInstance(options: { terrain?: boolean } = {}) {
  const mock = storageGL();
  const map = createDrawingMapStub(mock.gl);
  const fire = canvasEvents(map.canvas as never);
  if (options.terrain) (map.map as unknown as { terrain: unknown }).terrain = demTerrain().terrain;
  const store = createStore();
  // The work of a frame is done in that frame, so that what the drape holds does not depend on
  // the speed of the machine
  const drawOptions = { store, rendering: { timeSlicing: false } };
  checkDrawOptions(drawOptions);
  const engine = createEngine(
    map.map as MapLibreMap,
    toEngineOptions(drawOptions, () => false),
    {
      deferDefaultMode: true,
    },
  );
  const draw = createDrawOnEngine(engine, drawOptions);
  engine.enterDefaultMode();
  const ledger = engine.customLayer.getGpuLedger();
  return { mock, map, fire, store, engine, draw, ledger, input: createSyntheticInput(engine) };
}

type LedgerInstance = ReturnType<typeof ledgerInstance>;

const instances: LedgerInstance[] = [];

/** An instance that the test destroys at its end if it did not */
function tracked(options?: { terrain?: boolean }): LedgerInstance {
  const instance = ledgerInstance(options);
  instances.push(instance);
  return instance;
}

/** Features of every kind the drawing draws, spread over the area the map stub shows */
function fillDocument(instance: LedgerInstance): string[] {
  const { draw, store } = instance;
  store.createFile({ id: 'file', mimeType: 'image/png', dataURL: PNG });
  const ids = draw.features.createMany([
    { type: 'Point', geometry: { type: 'Point', coordinates: [-0.5, 0.5] } },
    {
      type: 'Point',
      geometry: { type: 'Point', coordinates: [-0.4, 0.5] },
      style: { pointShape: 'star' },
    },
    {
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-0.5, -0.5],
          [0.5, -0.4],
        ],
      },
    },
    {
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-0.5, -0.6],
          [0.5, -0.7],
        ],
      },
      style: { lineStyle: 'dashed' },
    },
    { type: 'Polygon', geometry: { type: 'Polygon', coordinates: [ring(0.1, 0.1, 0.3)] } },
    {
      type: 'Polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [ring(-0.9, -0.2, 0.5), ring(-0.8, -0.1, 0.1)],
      },
    },
    {
      type: 'Image',
      geometry: { type: 'Point', coordinates: [0.6, 0.6] },
      properties: {
        'maplibre-gl-draw:imageFileId': 'file',
        'maplibre-gl-draw:imageWidth': 300,
        'maplibre-gl-draw:imageHeight': 100,
      },
    },
  ] as never);
  return (ids as unknown as { id: string }[]).map((each) =>
    typeof each === 'string' ? each : each.id,
  );
}

/** Puts images on the map, each of an image of its own */
function placeImages(instance: LedgerInstance, count: number): void {
  const { draw, store } = instance;
  for (let i = 0; i < count; i++) {
    // Another image for each: the cache keeps the textures by their data
    const dataURL = PNG.replace('base64,', `base64,${'A'.repeat(4 * (i + 1))}`);
    store.createFile({ id: `image-${i}`, mimeType: 'image/png', dataURL });
  }
  draw.features.createMany(
    Array.from({ length: count }, (_, i) => ({
      type: 'Image',
      geometry: { type: 'Point', coordinates: [-0.6 + 0.3 * i, 0.2] },
      properties: {
        'maplibre-gl-draw:imageFileId': `image-${i}`,
        'maplibre-gl-draw:imageWidth': 300,
        'maplibre-gl-draw:imageHeight': 100,
      },
    })) as never,
  );
}

/** Four corners around the place the map stub shows */
const CORNERS: DrapeQuadCorners = {
  topLeft: [-10, 10],
  topRight: [10, 10],
  bottomLeft: [-10, -10],
  bottomRight: [10, -10],
};

/** A frame of the quad drape over the world tile, with a mesh of 4 */
function quadFrame(renderer: QuadDrapeRenderer): QuadDrapeFrame {
  const projection = renderInput().defaultProjectionData;
  const data = {
    texture: { id: 'dem' },
    matrix: new Float64Array(16).fill(1),
    unpack: [6553.6, 25.6, 0.1, 10000],
    dim: 512,
    exaggeration: 1,
  };
  return {
    renderer,
    shaderData: { variantName: 'mercator', vertexShaderPrelude: '', define: '' },
    tiles: [{ x: 0, y: 0, z: 0, tileID: { key: '0/0/0' } }],
    meshSize: 4,
    light: { direction: [0, 0, 1], strength: 0 },
    keepDepthTest: false,
    getTerrainData: () => data,
    getProjectionData: () => projection as never,
  };
}

/** A fill with one glyph of text, its tables told by a key */
function textSurface(key: string): QuadDrapeSurface {
  return {
    fill: { color: [1, 1, 1, 1], borderColor: [0, 0, 0, 1], border: [0, 0] },
    text: {
      atlas: { id: 'atlas' },
      atlasWidth: 64,
      atlasHeight: 64,
      glyphs: new Float32Array([0.1, 0.1, 0.9, 0.9, 0, 0, 1, 1]),
      glyphCount: 1,
      key,
      atlasTexelsPerUnit: [64, 64],
      color: [0, 0, 0, 1],
      haloColor: [0, 0, 0, 0],
      haloWidth: 0,
      edge: 0.5,
      valuePerTexel: 0.1,
      lodBias: 0,
    },
  };
}

beforeEach(() => {
  images = [];
  imagesMade = 0;
  imageSize = { width: 300, height: 100 };
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => undefined }),
    }),
  });
});

afterEach(() => {
  for (const instance of instances.splice(0)) {
    if (!instance.engine.isDestroyed()) instance.draw.destroy();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe('the ledger of an instance holds everything its drawing allocates', () => {
  it('on a flat map, with features of every kind, selected, and drawn', async () => {
    const instance = tracked();
    const { mock, map, draw, ledger } = instance;
    expect(mock.objects()).toBeGreaterThan(0);
    expectLedgerMatches(mock, ledger);

    const ids = fillDocument(instance);
    map.render();
    await decodeImages();
    map.render();
    expect(ledger.snapshot().byPart.images ?? 0).toBeGreaterThan(0);
    expectLedgerMatches(mock, ledger);

    // The selection interface: the frames, the strokes and the handles
    draw.selection.set('feature', ids);
    map.render();
    expectLedgerMatches(mock, ledger);
    draw.selection.set('feature', [ids[4]]);
    map.render();
    expectLedgerMatches(mock, ledger);
    draw.selection.clear();
    map.render();
    expectLedgerMatches(mock, ledger);
  });

  it('with the geometry being drawn', () => {
    const { mock, map, draw, ledger, input } = tracked();
    draw.setMode('drawPolygon');
    input.click([-0.5, -0.5]);
    input.click([0.5, -0.5]);
    input.click([0.5, 0.5]);
    map.render();
    expectLedgerMatches(mock, ledger);
    draw.setMode('drawLine');
    input.click([-0.5, 0.5]);
    input.click([0, 0.6]);
    map.render();
    expectLedgerMatches(mock, ledger);
  });

  it('on the globe', async () => {
    const instance = tracked();
    const { mock, map, ledger } = instance;
    fillDocument(instance);
    map.render(globeInput());
    await decodeImages();
    map.render(globeInput());
    map.render(globeInput());
    expectLedgerMatches(mock, ledger);
    // Back to the flat map
    map.render();
    expectLedgerMatches(mock, ledger);
  });

  it('on the terrain, with the atlas of the elevations and the drape', async () => {
    const instance = tracked({ terrain: true });
    const { mock, map, ledger } = instance;
    fillDocument(instance);
    for (let frame = 0; frame < 4; frame++) map.render();
    await decodeImages();
    for (let frame = 0; frame < 4; frame++) map.render();
    expect(ledger.snapshot().byPart.demAtlas ?? 0).toBeGreaterThan(0);
    expect(getTerrainDrapeDebug(instance.engine.customLayer.getTerrainContext()).used).toBe(true);
    expect(ledger.snapshot().byPart.drape ?? 0).toBeGreaterThan(0);
    expectLedgerMatches(mock, ledger);
    // The terrain goes away
    (map.map as unknown as { terrain: unknown }).terrain = undefined;
    map.render();
    expectLedgerMatches(mock, ledger);
  });
});

describe('the GPU side of an instance gives everything back', () => {
  it('when the instance is destroyed', async () => {
    const instance = ledgerInstance({ terrain: true });
    const { mock, map, draw, ledger } = instance;
    const ids = fillDocument(instance);
    map.render();
    await decodeImages();
    draw.selection.set('feature', ids);
    map.render();
    expect(ledger.snapshot().bytes).toBeGreaterThan(0);
    draw.destroy();
    expectNothingHeld(mock, ledger);
    expect(ledger.snapshot()).toMatchObject({ leakedBytes: 0, leakedObjects: 0 });
  });

  it('when the context is lost, and builds again when it comes back', async () => {
    const instance = tracked();
    const { mock, map, fire, ledger } = instance;
    fillDocument(instance);
    map.render();
    await decodeImages();
    map.render();
    mock.state.lost = true;
    fire('webglcontextlost');
    expectNothingHeld(mock, ledger);
    // A frame of a lost context draws nothing and makes nothing
    map.render();
    expectNothingHeld(mock, ledger);
    mock.state.lost = false;
    fire('webglcontextrestored');
    map.render();
    expect(ledger.snapshot().bytes).toBeGreaterThan(0);
    expectLedgerMatches(mock, ledger);
    expect(ledger.snapshot().leakedObjects).toBe(0);
  });

  it('when the style is swapped (maplibre takes the layers off and the host adds them back)', async () => {
    const instance = tracked();
    const { mock, map, engine, ledger } = instance;
    fillDocument(instance);
    map.render();
    await decodeImages();
    map.render();
    const layers = engine.customLayer.getSlotLayers();
    const stub = map.map as unknown as {
      removeLayer: (id: string) => void;
      addLayer: (layer: unknown) => void;
    };
    for (const layer of layers) stub.removeLayer(layer.id);
    expectNothingHeld(mock, ledger);
    for (const layer of layers) stub.addLayer(layer);
    map.render();
    map.render();
    expectLedgerMatches(mock, ledger);
    expect(ledger.snapshot().leakedObjects).toBe(0);
  });

  it('of a layer of the document that is deleted, by what its features held', () => {
    const { mock, map, draw, ledger } = tracked();
    const kept = draw.layers.create({ name: 'kept' }) as unknown as { id: string } | string;
    const keptId = typeof kept === 'string' ? kept : kept.id;
    draw.features.createMany(gridPoints(50).map((each) => ({ ...each, layerId: keptId })) as never);
    map.render();
    const before = ledger.snapshot();
    const gone = draw.layers.create({ name: 'gone' }) as unknown as { id: string } | string;
    const goneId = typeof gone === 'string' ? gone : gone.id;
    draw.features.createMany(
      gridPoints(200).map((each) => ({ ...each, layerId: goneId })) as never,
    );
    map.render();
    expect(ledger.snapshot().rowBytes).toBeGreaterThan(before.rowBytes);
    draw.layers.delete(goneId);
    map.render();
    expect(ledger.snapshot().rowBytes).toBe(before.rowBytes);
    expectLedgerMatches(mock, ledger);
  });

  it('and finds what a part forgot when the instance is destroyed: deleted and counted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const instance = ledgerInstance();
    const { mock, map, draw, ledger } = instance;
    map.render();
    // A part that makes a buffer and never gives it back
    const forgotten = mock.gl.createBuffer();
    ledger.record(forgotten, 'strokes', 'buffer');
    mock.gl.bindBuffer(mock.gl.ARRAY_BUFFER, forgotten);
    mock.gl.bufferData(mock.gl.ARRAY_BUFFER, 1_000, mock.gl.STATIC_DRAW);
    ledger.record(forgotten, 'strokes', 'buffer', 1_000);
    draw.destroy();
    expectNothingHeld(mock, ledger);
    expect(ledger.snapshot()).toMatchObject({ leakedBytes: 1_000, leakedObjects: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('left behind'), {
      strokes: 1_000,
    });
  });

  it('when an image decodes after the instance is destroyed', async () => {
    const instance = ledgerInstance();
    const { mock, map, draw, ledger } = instance;
    fillDocument(instance);
    map.render();
    expect(images.length).toBeGreaterThan(0);
    draw.destroy();
    await decodeImages();
    map.render();
    expectNothingHeld(mock, ledger);
  });

  it('of one instance without touching what another holds', () => {
    const one = tracked();
    const other = tracked();
    one.draw.features.createMany(gridPoints(100) as never);
    other.draw.features.createMany(gridPoints(300) as never);
    one.map.render();
    other.map.render();
    const held = other.ledger.snapshot();
    expect(one.ledger.snapshot().rowBytes).toBeLessThan(held.rowBytes);
    one.draw.destroy();
    expectNothingHeld(one.mock, one.ledger);
    expect(other.ledger.snapshot()).toEqual(held);
    expectLedgerMatches(other.mock, other.ledger);
  });
});

describe('the parts of the terrain', () => {
  it('the atlas of the elevations, baked, again at another size, and disposed', () => {
    const mock = storageGL();
    const ledger = new GpuLedger();
    const { terrain, tiles } = demTerrain();
    const atlas = new DemAtlas(mock.gl, ledger);
    expect(atlas.build(terrain as never, 0.5, true)).not.toBeNull();
    const before = mock.textureBytes();
    expect(before).toBeGreaterThan(0);
    expectLedgerMatches(mock, ledger);
    tiles.set('7/65/63', { id: 'e' });
    expect(atlas.build(terrain as never, 0.5, true)).not.toBeNull();
    expect(mock.textureBytes()).not.toBe(before);
    expectLedgerMatches(mock, ledger);
    atlas.dispose();
    expectNothingHeld(mock, ledger);
  });

  it('the drape, its mesh at two sizes, and disposed', () => {
    const mock = storageGL();
    const ledger = new GpuLedger();
    const renderer = new DrapeRenderer(mock.gl, ledger);
    const shaderData = { vertexShaderPrelude: '', define: '', variantName: 'mercator' };
    expect(renderer.ensure(shaderData, 64)).toBe(true);
    expect(mock.bufferBytes()).toBe(terrainMeshBytes(64));
    expectLedgerMatches(mock, ledger);
    expect(renderer.ensure(shaderData, 128)).toBe(true);
    expectLedgerMatches(mock, ledger);
    renderer.dispose();
    expectNothingHeld(mock, ledger);
  });
});

describe('a build of the GPU side that fails', () => {
  /** The renderers of an instance, made on a GL */
  function makeRenderers(mock: StorageGL, scope = createRenderScope(createSelectionScope())) {
    const map = {
      getCanvas: () => ({ width: 800, height: 600, clientWidth: 800, clientHeight: 600 }),
      triggerRepaint: () => {},
      getZoom: () => 12,
      getPitch: () => 0,
      getTerrain: () => null,
      transform: { tileSize: 512 },
    } as unknown as MapLibreMap;
    const renderers = initRenderers({
      gl: mock.gl,
      map,
      store: createTestDocument(),
      spatialIndex: new RBushSpatialIndex(),
      featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
      selectionConfig: DEFAULT_SELECTION_CONFIG,
      renderingConfig: DEFAULT_RENDERING_CONFIG,
      customFeatureHandlers: undefined,
      pixelRatio: 1,
      scope,
    });
    renderers.shaderInitializer.ensureShaders({
      vertexShaderPrelude: '',
      define: '',
      variantName: 'mercator',
    });
    return { renderers, scope };
  }

  it('leaves nothing when it fails at any allocation', () => {
    const whole = storageGL();
    const allocations = countingAllocations(whole);
    const { renderers, scope } = makeRenderers(whole);
    const steps = allocations();
    expect(steps).toBeGreaterThanOrEqual(3);
    expectLedgerMatches(whole, scope.gpu);
    disposeRenderers(renderers);
    expectNothingHeld(whole, scope.gpu);

    for (let step = 1; step <= steps; step++) {
      const mock = storageGL();
      const scope = createRenderScope(createSelectionScope());
      failingAt(mock, step);
      expect(() => scope.gpu.scope(mock.gl, () => makeRenderers(mock, scope))).toThrow('no memory');
      expectNothingHeld(mock, scope.gpu);
    }
  });

  it('frees the shaders and the program of a program that does not build', () => {
    for (const failing of ['vertex', 'fragment', 'link'] as const) {
      const mock = storageGL();
      const gl = mock.gl as unknown as Record<string, unknown>;
      let compiled = 0;
      gl.getShaderParameter = () => {
        compiled++;
        return !(failing === 'vertex' ? compiled === 1 : failing === 'fragment' && compiled === 2);
      };
      gl.getProgramParameter = () => failing !== 'link';
      expect(() => createProgram(mock.gl, 'v', 'f')).toThrow();
      expect(mock.objects()).toBe(0);
    }
  });

  it('of a renderer whose program does not link leaves nothing once the renderers go', () => {
    const mock = storageGL();
    const scope = createRenderScope(createSelectionScope());
    (mock.gl as unknown as Record<string, unknown>).getProgramParameter = () => false;
    expect(() => scope.gpu.scope(mock.gl, () => makeRenderers(mock, scope))).toThrow();
    expectNothingHeld(mock, scope.gpu);
  });
});

describe('the limit of what is held outside the rows', () => {
  /** An image decoded, of a size */
  const decoded = (width: number, height: number) =>
    ({ width, height }) as unknown as HTMLImageElement;

  /** The texture a cache holds for an image, or null */
  const held = (cache: TextureCache, src: string): object | null =>
    (cache as unknown as { imageCache: Map<string, object> }).imageCache.get(src) ?? null;

  /** A cache with images waiting for their upload */
  function cacheOf(mock: StorageGL, ledger: GpuLedger, sources: Record<string, HTMLImageElement>) {
    const cache = new TextureCache(mock.gl, ledger);
    const internals = cache as unknown as {
      decodedImages: Map<string, HTMLImageElement>;
      uploadImage(src: string, img: HTMLImageElement): { texture: object } | null;
    };
    for (const [src, img] of Object.entries(sources)) internals.decodedImages.set(src, img);
    return {
      cache,
      upload: (src: string) => internals.uploadImage(src, sources[src] as never),
    };
  }

  it('is 64,000,000 bytes, more than the floor', () => {
    expect(new GpuLedger().limitBytes).toBe(64_000_000);
    expect(tracked().ledger.limitBytes).toBe(64_000_000);
    expect(GPU_FLOOR_BYTES).toBeLessThan(DEFAULT_GPU_LIMIT_BYTES);
    expect(() => new GpuLedger(GPU_FLOOR_BYTES - 1)).toThrow();
  });

  it('makes the texture of an image whole while it fits', () => {
    const mock = storageGL();
    const ledger = new GpuLedger(GPU_FLOOR_BYTES + 10_000_000);
    const { upload } = cacheOf(mock, ledger, { a: decoded(1000, 1000) });
    upload('a');
    expect(mock.textureBytes()).toBe(mipmappedTextureBytes(1000, 1000, 4));
    expect(ledger.outsideRowBytes).toBe(mock.textureBytes());
    expectLedgerMatches(mock, ledger);
  });

  it('gives up the images not on the screen first, for one that does not fit', () => {
    const mock = storageGL();
    const ledger = new GpuLedger(GPU_FLOOR_BYTES + 6_000_000);
    const sources = { a: decoded(1000, 1000), b: decoded(1000, 1000) };
    const { cache, upload } = cacheOf(mock, ledger, sources);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    upload('a');
    // a was drawn ten seconds ago: it is not on the screen
    now.mockReturnValue(1_010_000);
    upload('b');
    expect(ledger.outsideRowBytes).toBeLessThanOrEqual(6_000_000);
    expect(held(cache, 'a')).toBeNull();
    expect(held(cache, 'b')).not.toBeNull();
    expect(mock.textureBytes()).toBe(mipmappedTextureBytes(1000, 1000, 4));
    expectLedgerMatches(mock, ledger);
  });

  it('draws an image on the screen from a smaller picture past the limit, and whole again', () => {
    const mock = storageGL();
    const ledger = new GpuLedger(GPU_FLOOR_BYTES + 6_000_000);
    const sources = { a: decoded(1000, 1000), b: decoded(1000, 1000) };
    const { cache, upload } = cacheOf(mock, ledger, sources);
    upload('a');
    // a is on the screen: b is drawn from a smaller picture
    const reduced = upload('b');
    expect(reduced).not.toBeNull();
    expect(held(cache, 'a')).not.toBeNull();
    expect(ledger.outsideRowBytes).toBeLessThanOrEqual(6_000_000);
    expect(mock.textureBytes()).toBeLessThan(2 * mipmappedTextureBytes(1000, 1000, 4));
    expectLedgerMatches(mock, ledger);
    // The room comes back: its whole picture is made again
    ledger.limitBytes = GPU_FLOOR_BYTES + 20_000_000;
    cache.sweep(Date.now());
    expect(held(cache, 'b')).toBeNull();
    expect(upload('b')).not.toBeNull();
    expect(mock.textureBytes()).toBe(2 * mipmappedTextureBytes(1000, 1000, 4));
    expectLedgerMatches(mock, ledger);
  });

  it('waits with an image when next to nothing is left', () => {
    const mock = storageGL();
    const ledger = new GpuLedger(GPU_FLOOR_BYTES + 100);
    const { upload } = cacheOf(mock, ledger, { a: decoded(1000, 1000) });
    expect(upload('a')).toBeNull();
    expectNothingHeld(mock, ledger);
  });

  it('holds a table of the drape under it, or draws the frame without the drape', () => {
    const mock = storageGL();
    const ledger = new GpuLedger();
    const renderer = new DrapeRenderer(mock.gl, ledger) as unknown as {
      rowsUnderLimit(width: number, channels: number, needed: number, most: number): number;
    };
    ledger.limitBytes = GPU_FLOOR_BYTES + 1_000_000;
    // A row of 1,024 texels of 16 bytes is 16 KB: 61 rows fit
    expect(renderer.rowsUnderLimit(1024, 4, 10, 4096)).toBe(15);
    expect(renderer.rowsUnderLimit(1024, 4, 50, 4096)).toBe(50);
    expect(renderer.rowsUnderLimit(1024, 4, 100, 4096)).toBe(0);
  });

  it('refuses the tables and the mesh of the drape that do not fit, and the frames still draw', () => {
    const instance = tracked({ terrain: true });
    const { mock, map, ledger, draw } = instance;
    // Next to nothing is left to the parts that give way
    ledger.limitBytes = GPU_FLOOR_BYTES + 1;
    draw.features.createMany([
      { type: 'Polygon', geometry: { type: 'Polygon', coordinates: [ring(0.1, 0.1, 0.3)] } },
      { type: 'Polygon', geometry: { type: 'Polygon', coordinates: [ring(-0.5, -0.5, 0.3)] } },
    ] as never);
    expect(() => {
      for (let frame = 0; frame < 4; frame++) map.render();
    }).not.toThrow();
    const terrain = instance.engine.customLayer.getTerrainContext();
    const drape = getTerrainDrapeDebug(terrain);
    expect(drape.used).toBe(false);
    expect(ledger.snapshot().byPart.drape ?? 0).toBe(0);
    // The features are drawn without it, as rows, on the ground: the atlas of the elevations is
    // always held
    expect(ledger.snapshot().rowBytes).toBeGreaterThan(0);
    expect(ledger.snapshot().byPart.demAtlas ?? 0).toBeGreaterThan(0);
    expect(isTerrainElevationActive(terrain)).toBe(true);
    expectLedgerMatches(mock, ledger);
  });

  it('does not refuse the rows', () => {
    const { map, ledger, draw } = tracked();
    ledger.limitBytes = GPU_FLOOR_BYTES + 1;
    draw.features.createMany(gridPoints(500) as never);
    map.render();
    expect(ledger.snapshot().byPart.points ?? 0).toBeGreaterThan(500 * 40);
  });

  it('keeps an image waiting past it, and the frames still draw', async () => {
    const instance = tracked();
    const { mock, map, ledger } = instance;
    ledger.limitBytes = GPU_FLOOR_BYTES + 1_000;
    fillDocument(instance);
    map.render();
    await decodeImages();
    expect(() => map.render()).not.toThrow();
    expect(ledger.snapshot().byPart.images ?? 0).toBeLessThan(1_000);
    expect(ledger.snapshot().rowBytes).toBeGreaterThan(0);
    expectLedgerMatches(mock, ledger);
  });

  it('keeps an image that waits decoded, asks for no frame, and draws it once there is room', async () => {
    const instance = tracked();
    const { mock, map, ledger } = instance;
    const repaint = (map.map as unknown as { triggerRepaint: ReturnType<typeof vi.fn> })
      .triggerRepaint;
    ledger.limitBytes = GPU_FLOOR_BYTES + 1_000;
    fillDocument(instance);
    map.render();
    await decodeImages();
    expect(imagesMade).toBe(1);
    const asked = repaint.mock.calls.length;
    for (let frame = 0; frame < 5; frame++) {
      map.render();
      await decodeImages();
    }
    // The image is not decoded again, and no frame is asked for while it waits
    expect(imagesMade).toBe(1);
    expect(repaint.mock.calls.length).toBe(asked);
    expect(ledger.snapshot().byPart.images ?? 0).toBe(0);
    // The room comes back: the next frame draws it, from the image kept decoded
    ledger.limitBytes = DEFAULT_GPU_LIMIT_BYTES;
    map.render();
    expect(imagesMade).toBe(1);
    expect(ledger.snapshot().byPart.images ?? 0).toBe(mipmappedTextureBytes(300, 100, 4));
    expectLedgerMatches(mock, ledger);
  });
});

/** Draws the frames of a scene with its images decoded */
async function drawScene(instance: LedgerInstance, input?: () => CustomRenderMethodInput) {
  const { map } = instance;
  for (let frame = 0; frame < 3; frame++) map.render(input?.());
  await decodeImages();
  for (let frame = 0; frame < 3; frame++) map.render(input?.());
}

describe('after every allocation, what is held outside the rows', () => {
  const scenes: Array<{
    name: string;
    terrain?: boolean;
    globe?: boolean;
    largeImages?: number;
    share?: number;
  }> = [
    { name: 'on a flat map' },
    { name: 'on the terrain', terrain: true },
    { name: 'on the globe', globe: true },
    { name: 'with many large images', largeImages: 4 },
    { name: 'with many large images, on the terrain', largeImages: 4, terrain: true },
    { name: 'under a lowered limit, on the terrain', terrain: true, largeImages: 2, share: 3e5 },
  ];

  for (const scene of scenes) {
    it(`stays within the limit, the share and the ceilings, ${scene.name}`, async () => {
      if (scene.largeImages) imageSize = { width: 2048, height: 2048 };
      const instance = tracked({ terrain: scene.terrain });
      const { mock, draw, ledger } = instance;
      if (scene.share !== undefined) ledger.limitBytes = GPU_FLOOR_BYTES + scene.share;
      const watch = watchLimits(mock, ledger);
      const ids = fillDocument(instance);
      if (scene.largeImages) placeImages(instance, scene.largeImages);
      await drawScene(instance, scene.globe ? globeInput : undefined);
      draw.selection.set('feature', ids);
      await drawScene(instance, scene.globe ? globeInput : undefined);
      expect(watch.allocations()).toBeGreaterThan(0);
      expect(watch.broken).toEqual([]);
      if (scene.largeImages && !scene.share) {
        // The images take their share, and no more
        expect(ledger.snapshot().byPart.images ?? 0).toBeGreaterThan(ledger.shareBytes / 2);
      }
      if (scene.terrain) expect(ledger.snapshot().byPart.demAtlas ?? 0).toBeGreaterThan(0);
      expectLedgerMatches(mock, ledger);
    });
  }

  it('stays within the limit when the terrain comes after images that took their share', async () => {
    imageSize = { width: 2048, height: 2048 };
    const instance = tracked();
    const { mock, map, draw, ledger } = instance;
    const watch = watchLimits(mock, ledger);
    placeImages(instance, 3);
    await drawScene(instance);
    // Next to nothing is left of the share
    expect(ledger.roomBytes).toBeLessThan(ledger.shareBytes / 100);
    draw.features.createMany([
      { type: 'Polygon', geometry: { type: 'Polygon', coordinates: [ring(0.1, 0.1, 0.3)] } },
    ] as never);
    (map.map as unknown as { terrain: unknown }).terrain = demTerrain().terrain;
    for (let frame = 0; frame < 4; frame++) map.render();
    expect(watch.broken).toEqual([]);
    expect(ledger.outsideRowBytes).toBeLessThanOrEqual(ledger.limitBytes);
    // The atlas of the elevations is made, and the features follow the ground
    expect(ledger.snapshot().byPart.demAtlas ?? 0).toBeGreaterThan(0);
    expect(isTerrainElevationActive(instance.engine.customLayer.getTerrainContext())).toBe(true);
    expectLedgerMatches(mock, ledger);
  });

  it('holds the largest atlas of the elevations within its ceiling', () => {
    // Tiles of zoom 7, 8 x 8 of them: the most texels the atlas lays out on each side
    const tiles: { x: number; y: number; z: number; tileID: { key: string } }[] = [];
    for (let x = 40; x < 48; x++) {
      for (let y = 40; y < 48; y++) tiles.push({ x, y, z: 7, tileID: { key: `7/${x}/${y}` } });
    }
    const layout = computeAtlasLayout(tiles, 0.34);
    expect(layout).toMatchObject({ width: 2048, height: 2048 });
    const mock = storageGL();
    const ledger = new GpuLedger();
    const watch = watchLimits(mock, ledger);
    const terrain = {
      exaggeration: 1,
      tileManager: {
        getRenderableTiles: () =>
          tiles.map((tile) => ({
            tileID: { canonical: { x: tile.x, y: tile.y, z: 7 }, key: tile.tileID.key, wrap: 0 },
          })),
      },
      getTerrainData: () => ({
        texture: { id: 'dem' },
        u_terrain_matrix: new Float64Array(16).fill(1),
        u_terrain_unpack: [6553.6, 25.6, 0.1, 10000],
        u_terrain_dim: 512,
      }),
    };
    const atlas = new DemAtlas(mock.gl, ledger);
    expect(atlas.build(terrain as never, 0.34, true)).not.toBeNull();
    expect(ledger.snapshot().byPart.demAtlas).toBe(HELD_PART_CEILINGS.get('demAtlas'));
    expect(watch.broken).toEqual([]);
    atlas.dispose();
    expectNothingHeld(mock, ledger);
  });

  it('holds the shapes of the points within their ceiling, the oldest going first', () => {
    const mock = storageGL();
    const ledger = new GpuLedger();
    const watch = watchLimits(mock, ledger);
    const cache = new BufferCache(mock.gl, { ledger, part: 'pointShapes' });
    const ceiling = ledger.ceilingOf('pointShapes') ?? 0;
    expect(ceiling).toBe(2_000_000);
    let made = 0;
    // Shapes of 300,000 bytes: 6 fit under the ceiling
    const shape = () => {
      made++;
      return {
        vertices: new Float32Array(75_000),
        vertexCount: 37_500,
        drawMode: 0,
        stride: 8,
        attributes: [{ index: 0, size: 2, offset: 0 }],
      };
    };
    const now = vi.spyOn(Date, 'now');
    for (let i = 0; i < 10; i++) {
      now.mockReturnValue(1_000 + i);
      expect(cache.getOrCreate(`shape-${i}`, 'same', shape)).not.toBeNull();
    }
    expect(watch.broken).toEqual([]);
    expect(made).toBe(10);
    expect(cache.size).toBe(6);
    expect(ledger.snapshot().byPart.pointShapes).toBe(6 * 300_000);
    // The oldest went: it is made again when it is drawn next
    now.mockReturnValue(2_000);
    const again = cache.getOrCreate('shape-0', 'same', shape);
    expect(again).not.toBeNull();
    expect(made).toBe(11);
    expect(mock.live.has(again?.buffer as object)).toBe(true);
    // A shape drawn once, out of the cache, has its room made too
    expect(cache.makeRoom(600_000)).toBe(true);
    expect((ledger.snapshot().byPart.pointShapes ?? 0) + 600_000).toBeLessThanOrEqual(ceiling);
    // One larger than the ceiling is not made
    expect(cache.makeRoom(ceiling + 1)).toBe(false);
    expect(watch.broken).toEqual([]);
    expectLedgerMatches(mock, ledger);
    cache.dispose();
    expectNothingHeld(mock, ledger);
  });
});

describe('the drape past the share of the parts that give way', () => {
  const shaderData = { vertexShaderPrelude: '', define: '', variantName: 'mercator' };

  it('makes no mesh of the drape that does not fit, and the frame is drawn without the drape', () => {
    const mock = storageGL();
    const ledger = new GpuLedger(GPU_FLOOR_BYTES + terrainMeshBytes(64) - 1);
    const renderer = new DrapeRenderer(mock.gl, ledger);
    expect(renderer.ensure(shaderData, 64)).toBe(false);
    expect(renderer.lastError).toContain('gpu-limit');
    expectNothingHeld(mock, ledger);
    ledger.limitBytes = GPU_FLOOR_BYTES + terrainMeshBytes(64);
    expect(renderer.ensure(shaderData, 64)).toBe(true);
    expect(ledger.snapshot().byPart.drape).toBe(terrainMeshBytes(64));
    renderer.dispose();
    expectNothingHeld(mock, ledger);
  });

  it('pastes no image with a mesh that does not fit (it is drawn without the drape)', () => {
    const mock = storageGL();
    const ledger = new GpuLedger(GPU_FLOOR_BYTES + terrainMeshBytes(4) - 1);
    const renderer = new QuadDrapeRenderer(mock.gl, ledger);
    const frame = quadFrame(renderer);
    expect(renderer.drawQuad(CORNERS, { id: 'image' }, 1, frame)).toBe(false);
    expect(renderer.lastError).toContain('gpu-limit');
    expectNothingHeld(mock, ledger);
    ledger.limitBytes = GPU_FLOOR_BYTES + terrainMeshBytes(4);
    expect(renderer.drawQuad(CORNERS, { id: 'image' }, 1, frame)).toBe(true);
    renderer.dispose();
    expectNothingHeld(mock, ledger);
  });

  it('draws an image on the terrain without the drape when its mesh does not fit', async () => {
    const instance = tracked({ terrain: true });
    const { mock, map, ledger } = instance;
    // Room for the whole picture of the image, and not for a mesh of the drape
    ledger.limitBytes = GPU_FLOOR_BYTES + mipmappedTextureBytes(300, 100, 4) + 1_000;
    const watch = watchLimits(mock, ledger);
    placeImages(instance, 1);
    await drawScene(instance);
    expect(ledger.snapshot().byPart.images ?? 0).toBeGreaterThan(0);
    expect(ledger.roomBytes).toBeLessThan(terrainMeshBytes(32));
    expect(ledger.snapshot().byPart.drape ?? 0).toBe(0);
    // The quads of the images draw it, with their own program
    const used: string[] = [];
    const gl = mock.gl as unknown as Record<string, (...args: unknown[]) => unknown>;
    const useProgram = gl.useProgram;
    gl.useProgram = (program) => {
      used.push(ledger.partOf(program as object) ?? 'none');
      return useProgram(program);
    };
    map.render();
    expect(used).toContain('imageQuads');
    expect(watch.broken).toEqual([]);
    expectLedgerMatches(mock, ledger);
  });

  it('paints no quad whose glyphs do not fit, and gives up the glyphs not used in the frame first', () => {
    const roomy = storageGL();
    const probe = new GpuLedger();
    const sized = new QuadDrapeRenderer(roomy.gl, probe);
    expect(sized.drawSurface(CORNERS, textSurface('one'), 1, quadFrame(sized))).toBe(true);
    const glyphBytes = (probe.snapshot().byPart.drape ?? 0) - terrainMeshBytes(4);
    expect(glyphBytes).toBeGreaterThan(16);
    sized.dispose();

    const mock = storageGL();
    // Room for the mesh and the glyphs of one text, not for a texture of 16 bytes more
    const ledger = new GpuLedger(GPU_FLOOR_BYTES + terrainMeshBytes(4) + glyphBytes + 8);
    const watch = watchLimits(mock, ledger);
    const renderer = new QuadDrapeRenderer(mock.gl, ledger);
    const first = quadFrame(renderer);
    expect(renderer.drawSurface(CORNERS, textSurface('one'), 1, first)).toBe(true);
    // The glyphs of the first text are used in this frame: the second is not painted at all,
    // rather than painted without its text
    expect(renderer.drawSurface(CORNERS, textSurface('two'), 1, first)).toBe(false);
    expect(renderer.lastError).toContain('gpu-limit');
    // In the next frame the glyphs of the first text are not used yet: they go for the second
    const second = quadFrame(renderer);
    expect(renderer.drawSurface(CORNERS, textSurface('two'), 1, second)).toBe(true);
    // A fill without text needs a texture bound to its samplers, which does not fit either
    const fill = textSurface('none').fill;
    expect(renderer.drawSurface(CORNERS, { fill, text: null }, 1, second)).toBe(false);
    expect(watch.broken).toEqual([]);
    expectLedgerMatches(mock, ledger);
    renderer.dispose();
    expectNothingHeld(mock, ledger);
  });
});

describe('what is held outside the rows', () => {
  /**
   * The bytes held outside the rows by an instance over `size` features, drawn, per part
   *
   * The tables of the drape are left out: they hold the edges and the styles of the features in
   * the view, so they grow with them (the drape draws without them past the limit)
   */
  function outsideBytes(size: number, terrain: boolean): number {
    const instance = tracked({ terrain });
    const { map, draw, ledger } = instance;
    const points = gridPoints(size);
    // Points, lines and squares in turn, on the same grid
    const step = 2 / Math.ceil(Math.sqrt(size));
    const features = points.map((point, i) => {
      const [x, y] = point.geometry.coordinates;
      if (i % 3 === 1) {
        return {
          type: 'LineString',
          geometry: {
            type: 'LineString',
            coordinates: [
              [x, y],
              [x + step / 2, y],
            ],
          },
        };
      }
      if (i % 3 === 2) {
        return {
          type: 'Polygon',
          geometry: { type: 'Polygon', coordinates: [ring(x, y, step / 2)] },
        };
      }
      return point;
    });
    draw.features.createMany(features as never);
    for (let frame = 0; frame < 3; frame++) map.render();
    const snapshot = ledger.snapshot();
    if (terrain) {
      expect(getTerrainDrapeDebug(instance.engine.customLayer.getTerrainContext()).used).toBe(true);
      expect(snapshot.byPart.demAtlas ?? 0).toBeGreaterThan(0);
    }
    draw.destroy();
    return snapshot.outsideRowBytes - (snapshot.byPart.drape ?? 0);
  }

  it('does not grow with the features, on a flat map (the immediate drawing)', () => {
    expectNotProportional((size) => outsideBytes(size, false), 'the bytes outside the rows');
  });

  it('does not grow with the features, on the terrain (the atlas of the elevations)', () => {
    expectNotProportional((size) => outsideBytes(size, true), 'the bytes outside the rows');
  });
});

// ---------------------------------------------------------------------------
// The sources
// ---------------------------------------------------------------------------

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** The source files of the library (not the tests, nor what only the tests use) */
async function librarySources(dir = SRC): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'e2e') continue;
      out.push(...(await librarySources(path)));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      entry.name !== 'test-utils.ts'
    ) {
      out.push(path);
    }
  }
  return out;
}

/** A call that gives a buffer, a texture or a render buffer its storage */
const ALLOCATION =
  /\.(bufferData|texStorage2D|texImage2D|texStorage3D|texImage3D|renderbufferStorage(Multisample)?|copyTexImage2D|compressedTexImage2D)\(/;

describe('the sources that allocate on the GPU', () => {
  it('record what they allocate in the ledger', async () => {
    const unrecorded: string[] = [];
    let allocating = 0;
    for (const path of await librarySources()) {
      const text = await readFile(path, 'utf8');
      if (!ALLOCATION.test(text)) continue;
      allocating++;
      if (!/\.record\(/.test(text)) unrecorded.push(relative(SRC, path));
    }
    expect(allocating).toBeGreaterThan(10);
    expect(unrecorded).toEqual([]);
  });
});
