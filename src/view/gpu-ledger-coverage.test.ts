// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Nothing core allocates on the GPU is left out of the ledger
 *
 * A GL counts the storage it is asked for, on its own: the bytes `bufferData` gives the buffer
 * bound to its target (the index buffer of the vertex array bound), the bytes of the levels
 * `texStorage2D` and `texImage2D` make (the whole chain after `generateMipmap`), the bytes of
 * `renderbufferStorage`, and nothing of what was deleted. The parts of the drawing are made and
 * draw on it the ways they draw, and what it holds is compared with the ledger of the instance,
 * buffers and textures apart, after each way (the render buffers go with the textures, as the
 * ledger counts them). A part that allocates without recording, or deletes without taking out,
 * makes the two differ.
 *
 * When the renderers are disposed (`disposeRenderers`, every member of `GPU_OWNERS`), the GL
 * holds nothing and neither does the ledger.
 *
 * A source file of the library that asks the GL for storage records in the ledger too (a new
 * file that allocates is caught here before a way of drawing it is added above).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../shared/config/feature-style.js';
import { DEFAULT_RENDERING_CONFIG } from '../shared/config/rendering.js';
import { DEFAULT_SELECTION_CONFIG } from '../shared/config/selection.js';
import type { Feature, Layer } from '../shared/types/model.js';
import { MemoryStore } from '../store/memory.js';
import { RBushSpatialIndex } from '../store/spatial/spatial-index.js';
import { feature, tablesOfFeatures } from '../test-utils.js';
import { createFeatureCompanionRegistry } from './feature-companion.js';
import { GpuLedger } from './gpu-ledger.js';
import { createRenderScope } from './layer/render-scope.js';
import { disposeRenderers, initRenderers, type Renderers } from './layer/renderers.js';
import type { StoreRetainedDrawDeps } from './layer/store-retained-immediate.js';
import { TableLayerRenderer } from './layer/table-retained.js';
import { TerrainResolver } from './layer/terrain-resolver.js';
import { beginRenderFrame } from './shaders/frame.js';
import { calculateOffsetUniforms, createProgram, type ShaderData } from './shaders/helpers.js';
import { TerrainContext } from './terrain/context.js';
import { DemAtlas } from './terrain/dem-atlas.js';
import { DrapePackBuilder } from './terrain/drape/bin-store.js';
import { DrapeCopyTables, PartitionedDrapeIndex } from './terrain/drape/partitioned.js';
import { QuadDrapeRenderer } from './terrain/drape/quad.js';
import { DrapeRenderer } from './terrain/drape/renderer.js';
import { createSelectionScope } from './ui/selection-scope.js';

// ---------------------------------------------------------------------------
// The GL that counts the storage it is asked for
// ---------------------------------------------------------------------------

/** The bytes of a texel of each internal format core allocates */
const TEXEL_BYTES: Readonly<Record<string, number>> = {
  R8: 1,
  R8UI: 1,
  RG8: 2,
  RGBA8: 4,
  R16F: 2,
  RG16F: 4,
  RGBA16F: 8,
  R32F: 4,
  R32UI: 4,
  RG32F: 8,
  RGBA32F: 16,
  RGBA32UI: 16,
  DEPTH_COMPONENT24: 4,
  DEPTH_COMPONENT32F: 4,
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

/** The number of levels of the whole chain of a size */
function chainLevels(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

interface Storage {
  readonly kind: 'buffer' | 'texture' | 'renderbuffer';
  bytes: number;
  /** Level 0 of a texture and its texel, for `generateMipmap` */
  width?: number;
  height?: number;
  texel?: number;
}

/**
 * A WebGL2 context that keeps the storage of every buffer, texture and render buffer it is
 * asked for, and accepts every other call
 *
 * The constants are their names, so the formats can be read back.
 */
function storageGL(size: { width: number; height: number } = { width: 800, height: 600 }) {
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
    getExtension: () => ({}),
    isContextLost: () => false,
    isEnabled: () => false,
    getError: () => 'NO_ERROR',
    checkFramebufferStatus: () => 'FRAMEBUFFER_COMPLETE',
    getParameter: (name) => {
      if (name === 'VIEWPORT') return new Int32Array([0, 0, size.width, size.height]);
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
      // Only level 0 is made here (no part of core writes the levels by hand)
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
      held.bytes = levelBytes(
        held.width,
        held.height,
        held.texel,
        chainLevels(held.width, held.height),
      );
    },
    renderbufferStorage: (_target, internalFormat, width, height) => {
      if (!renderbuffer) throw new Error('renderbufferStorage with no render buffer bound');
      storage.set(renderbuffer, {
        kind: 'renderbuffer',
        bytes: (width as number) * (height as number) * texelBytes(internalFormat),
      });
    },
    deleteBuffer: (object) => {
      if (object) storage.delete(object as object);
    },
    deleteTexture: (object) => {
      if (object) storage.delete(object as object);
    },
    deleteRenderbuffer: (object) => {
      if (object) storage.delete(object as object);
    },
  };

  const target: Record<string, unknown> = {
    drawingBufferWidth: size.width,
    drawingBufferHeight: size.height,
    canvas: { width: size.width, height: size.height, clientWidth: size.width },
  };
  const gl = new Proxy(target, {
    get(t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in t) return t[prop];
      if (/^[A-Z_0-9]+$/.test(prop)) return prop;
      const fn =
        calls[prop] ??
        (prop.startsWith('create') ? () => ({ kind: prop, id: next++ }) : () => undefined);
      t[prop] = fn;
      return fn;
    },
  }) as unknown as WebGL2RenderingContext;

  const sum = (kinds: ReadonlyArray<Storage['kind']>): number => {
    let bytes = 0;
    for (const held of storage.values()) if (kinds.includes(held.kind)) bytes += held.bytes;
    return bytes;
  };
  return {
    gl,
    /** The bytes of the buffers held */
    bufferBytes: () => sum(['buffer']),
    /** The bytes of the textures and of the render buffers held */
    textureBytes: () => sum(['texture', 'renderbuffer']),
    /** The bytes of the render buffers held */
    renderbufferBytes: () => sum(['renderbuffer']),
  };
}

type StorageGL = ReturnType<typeof storageGL>;

/** The GL and the ledger hold the same bytes, buffers and textures apart */
function expectLedgerMatches(mock: StorageGL, ledger: GpuLedger): void {
  const snapshot = ledger.snapshot();
  expect({ buffers: snapshot.bufferBytes, textures: snapshot.textureBytes }).toEqual({
    buffers: mock.bufferBytes(),
    textures: mock.textureBytes(),
  });
}

// ---------------------------------------------------------------------------
// What the parts draw with
// ---------------------------------------------------------------------------

const SHADER_DATA: ShaderData = { vertexShaderPrelude: '', define: '', variantName: 'mercator' };

const CENTER: [number, number] = [139.7, 35.68];

function projection(): ProjectionData {
  return {
    mainMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 0],
    projectionTransition: 0,
    fallbackMatrix: new Float32Array(16),
  } as unknown as ProjectionData;
}

function mapStub(): MapLibreMap {
  return {
    getCanvas: () => ({ width: 800, height: 600, clientWidth: 800, clientHeight: 600 }),
    triggerRepaint: () => {},
    getZoom: () => 14,
    getPitch: () => 0,
    getBearing: () => 0,
    getCenter: () => ({ lng: CENTER[0], lat: CENTER[1] }),
    getTerrain: () => null,
    areTilesLoaded: () => true,
    transform: { tileSize: 512 },
  } as unknown as MapLibreMap;
}

const LAYER: Layer = {
  id: 'layer',
  name: 'layer',
  visible: true,
  locked: false,
  opacity: 1,
  items: [],
  styleRule: undefined,
  metadata: undefined,
};

/** An embedded PNG (only its prefix is read: the decode is the one of FakeImage) */
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

/** The images the texture cache decodes; a test finishes their decode */
let images: FakeImage[] = [];

class FakeImage {
  width = 300;
  height = 100;
  crossOrigin = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  constructor() {
    images.push(this);
  }
}

/** The renderers of an instance on the counting GL, with their shaders made for a view */
function engine(
  mock: StorageGL,
  store = new MemoryStore(),
  scope = createRenderScope(createSelectionScope()),
) {
  const renderers = initRenderers({
    gl: mock.gl,
    map: mapStub(),
    store,
    spatialIndex: new RBushSpatialIndex(),
    featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
    selectionConfig: DEFAULT_SELECTION_CONFIG,
    renderingConfig: DEFAULT_RENDERING_CONFIG,
    customFeatureHandlers: undefined,
    pixelRatio: 1,
    scope,
  });
  const projectionData = projection();
  renderers.shaderInitializer.ensureShaders(SHADER_DATA);
  renderers.shaderInitializer.setOffsetUniforms(CENTER, projectionData);
  renderers.shaderInitializer.setProjectionData(projectionData);
  return { renderers, scope, ledger: scope.gpu, projectionData };
}

/** A terrain of two DEM tiles side by side, whose tiles can be changed */
function demTerrain() {
  const tiles = new Map<string, object>([
    ['12/3638/1613', { id: 'a' }],
    ['12/3639/1613', { id: 'b' }],
  ]);
  const terrain = {
    exaggeration: 1,
    tileManager: {
      getRenderableTiles: () =>
        [...tiles.keys()].map((key) => {
          const [z, x, y] = key.split('/').map(Number);
          return { tileID: { canonical: { x, y, z }, key } };
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

function square(x: number, y: number, s: number): [number, number][] {
  return [
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
    [x, y],
  ];
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

/** The calls that give something storage */
const ALLOCATIONS = ['bufferData', 'texStorage2D', 'texImage2D', 'renderbufferStorage'];

/** Counts the calls that make and delete what the GL holds */
function countingCalls(mock: { gl: WebGL2RenderingContext }) {
  const counts = new Map<string, number>();
  const gl = mock.gl as unknown as Record<string, (...args: unknown[]) => unknown>;
  const count = (name: string): void => {
    const call = gl[name] as (...args: unknown[]) => unknown;
    gl[name] = (...args) => {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return call(...args);
    };
  };
  for (const what of ['Buffer', 'Texture', 'Program', 'Shader']) {
    for (const name of [`create${what}`, `delete${what}`]) count(name);
  }
  for (const name of ALLOCATIONS) count(name);
  return {
    created: (what: string): number => counts.get(`create${what}`) ?? 0,
    deleted: (what: string): number => counts.get(`delete${what}`) ?? 0,
    allocations: (): number => ALLOCATIONS.reduce((sum, name) => sum + (counts.get(name) ?? 0), 0),
  };
}

/** Has a GL throw at the step-th allocation, as a driver out of memory would fail it */
function failingAt(mock: { gl: WebGL2RenderingContext }, step: number): void {
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

/** Has a GL refuse a shader or the link of a program */
function failingProgram(
  mock: { gl: WebGL2RenderingContext },
  failing: 'vertex' | 'fragment' | 'link',
): void {
  const gl = mock.gl as unknown as Record<string, unknown>;
  let compiled = 0;
  gl.getShaderParameter = () => {
    compiled++;
    return !(failing === 'vertex' ? compiled === 1 : failing === 'fragment' && compiled === 2);
  };
  gl.getProgramParameter = () => failing !== 'link';
}

describe('the GPU ledger holds everything core allocates', () => {
  beforeEach(() => {
    images = [];
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
    vi.unstubAllGlobals();
  });

  it('when the renderers of an instance are made, and nothing once they are disposed', () => {
    const mock = storageGL();
    const { renderers, ledger } = engine(mock);
    expect(mock.bufferBytes()).toBeGreaterThan(0);
    expectLedgerMatches(mock, ledger);

    disposeRenderers(renderers);
    expect(mock.bufferBytes() + mock.textureBytes()).toBe(0);
    expect(ledger.snapshot().bytes).toBe(0);
  });

  it('gives everything back through making and disposing the renderers, again and again', () => {
    const mock = storageGL();
    const counted = countingCalls(mock);
    for (let round = 0; round < 3; round++) {
      const { renderers, ledger } = engine(mock);
      expectLedgerMatches(mock, ledger);
      disposeRenderers(renderers);
      expect(ledger.snapshot().bytes).toBe(0);
      expect(ledger.audit()).toBe(true);
    }
    expect(mock.bufferBytes() + mock.textureBytes()).toBe(0);
    expect(counted.created('Buffer')).toBe(counted.deleted('Buffer'));
    expect(counted.created('Texture')).toBe(counted.deleted('Texture'));
    expect(counted.created('Program')).toBe(counted.deleted('Program'));
    expect(counted.created('Shader')).toBe(counted.deleted('Shader'));
  });

  it('leaves nothing when making the renderers fails at any allocation', () => {
    // The allocations of a whole making, counted once
    const whole = storageGL();
    const total = countingCalls(whole);
    engine(whole);
    const steps = total.allocations();
    expect(steps).toBeGreaterThan(3);
    for (let step = 1; step <= steps; step++) {
      const mock = storageGL();
      const scope = createRenderScope(createSelectionScope());
      failingAt(mock, step);
      expect(() => scope.gpu.scope(mock.gl, () => engine(mock, undefined, scope))).toThrow(
        'no memory',
      );
      expect(scope.gpu.snapshot().bytes).toBe(0);
      expect(mock.bufferBytes() + mock.textureBytes()).toBe(0);
    }
  });

  it('frees the shaders and the program of a program that does not build', () => {
    for (const failing of ['vertex', 'fragment', 'link'] as const) {
      const mock = storageGL();
      const counted = countingCalls(mock);
      failingProgram(mock, failing);
      expect(() => createProgram(mock.gl, 'v', 'f')).toThrow();
      expect(counted.created('Shader')).toBe(counted.deleted('Shader'));
      expect(counted.created('Program')).toBe(counted.deleted('Program'));
    }
  });

  it('when the features of the Store are drawn one by one', () => {
    const mock = storageGL();
    const { renderers, ledger, projectionData } = engine(mock);
    const drawn: Feature[] = [
      feature('point', 'Point', CENTER),
      feature('line', 'LineString', [CENTER, [CENTER[0] + 0.01, CENTER[1] + 0.01]]),
      feature('polygon', 'Polygon', [square(CENTER[0], CENTER[1], 0.01)]),
      feature('holed', 'Polygon', [
        square(CENTER[0], CENTER[1], 0.02),
        square(CENTER[0] + 0.005, CENTER[1] + 0.005, 0.005),
      ]),
      feature('circle', 'Circle', CENTER, {
        properties: { 'maplibre-gl-draw:radius': 100, 'maplibre-gl-draw:createdZoom': 14 },
      }),
    ];
    renderers.sdfLineRenderer.beginDraw(projectionData);
    for (const each of drawn) {
      renderers.featureDrawer.drawFeature(each, projectionData, 14, LAYER);
      expectLedgerMatches(mock, ledger);
    }
    renderers.sdfLineRenderer.endDraw();
    // A point drawn without an id is made and deleted in its draw
    renderers.pointShapeRenderer.draw(CENTER, renderers.featureDrawer.getPointStyle(undefined));
    expectLedgerMatches(mock, ledger);
    // A longer line grows the buffers of the line drawn at once
    const long: [number, number][] = [];
    for (let i = 0; i < 2000; i++) long.push([CENTER[0] + i * 1e-4, CENTER[1] + (i % 2) * 1e-4]);
    renderers.sdfLineRenderer.beginDraw(projectionData);
    renderers.featureDrawer.drawFeature(feature('long', 'LineString', long), projectionData, 14);
    renderers.sdfLineRenderer.endDraw();
    expect(mock.textureBytes()).toBeGreaterThan(0);
    expectLedgerMatches(mock, ledger);

    disposeRenderers(renderers);
    expect(mock.bufferBytes() + mock.textureBytes()).toBe(0);
    expect(ledger.snapshot().bytes).toBe(0);
  });

  it('when the features are drawn in batches at once, and kept in retained batches', () => {
    const mock = storageGL();
    const { renderers, ledger, projectionData } = engine(mock);
    const batches = renderers.batchManager;
    batches.beginFrame(projectionData, 14, LAYER);
    for (let i = 0; i < 50; i++) {
      const x = CENTER[0] + i * 0.001;
      batches.processFeature(feature(`p${i}`, 'Point', [x, CENTER[1]]), false);
      batches.processFeature(
        feature(`l${i}`, 'LineString', [
          [x, CENTER[1]],
          [x + 0.0005, CENTER[1] + 0.0005],
        ]),
        false,
      );
      batches.processFeature(feature(`a${i}`, 'Polygon', [square(x, CENTER[1], 0.0005)]), false);
    }
    batches.endFrame();
    expectLedgerMatches(mock, ledger);

    const point = renderers.pointInstanceRenderer;
    const polygon = renderers.sdfPolygonRenderer;
    const line = renderers.sdfLineRenderer;
    const points = point.buildRetained(
      [
        {
          coord: CENTER,
          fillColor: [1, 0, 0, 1],
          fillSize: 5,
          strokeColor: [0, 0, 0, 1],
          strokeWidth: 1,
        },
      ],
      'circle',
    );
    const polygons = polygon.buildRetained([
      {
        coordinates: [square(CENTER[0], CENTER[1], 0.01)],
        style: {
          fillColor: [1, 0, 0, 0.5],
          fillOpacity: 1,
          strokeColor: [0, 0, 0, 1],
          strokeWidth: 2,
          strokeOpacity: 1,
        },
        createdZoom: 14,
        featureId: 'a',
      },
    ]);
    const lines = line.buildRetainedBatch(
      [
        {
          coords: [CENTER, [CENTER[0] + 0.01, CENTER[1]]],
          featureId: 'l',
          closed: false,
          strokeWidth: 2,
          createdZoom: 14,
          color: [0, 0, 1, 1],
          opacity: 1,
        },
      ],
      { lineStyle: 'solid' },
    );
    expect(points && polygons && lines).toBeTruthy();
    expectLedgerMatches(mock, ledger);
    if (points) point.disposeRetained(points);
    if (polygons) polygon.disposeRetained(polygons);
    if (lines) line.disposeRetainedBatch(lines);
    expectLedgerMatches(mock, ledger);

    disposeRenderers(renderers);
    expect(mock.bufferBytes() + mock.textureBytes()).toBe(0);
    expect(ledger.snapshot().bytes).toBe(0);
  });

  it('when the polygons are drawn in a batch, and the strokes, the outlines and the fills of the interface', () => {
    const mock = storageGL();
    const { renderers, ledger, projectionData } = engine(mock);
    renderers.polygonBatchRenderer.drawBatch(
      [
        { coordinates: [square(CENTER[0], CENTER[1], 0.01)], color: [1, 0, 0, 1] },
        { coordinates: [square(CENTER[0] + 0.02, CENTER[1], 0.01)], color: [0, 1, 0, 1] },
      ],
      projectionData,
    );
    expectLedgerMatches(mock, ledger);
    const stroke = {
      width: 2,
      color: [0, 0, 1, 1] as [number, number, number, number],
      opacity: 1,
      lineStyle: 'solid' as const,
    };
    renderers.strokeRenderer.draw(
      square(CENTER[0], CENTER[1], 0.01),
      stroke,
      { widthUnit: 'pixels', closed: true },
      14,
      projectionData,
    );
    expectLedgerMatches(mock, ledger);
    renderers.outlineRenderer.draw(
      CENTER,
      0,
      [
        { x: -10, y: -10 },
        { x: 10, y: -10 },
        { x: 10, y: 10 },
        { x: -10, y: 10 },
      ],
      stroke,
      1,
      projectionData,
    );
    expectLedgerMatches(mock, ledger);
    renderers.fillShaderManager.drawPolygon(
      square(CENTER[0], CENTER[1], 0.01),
      [1, 1, 0, 0.5],
      projectionData,
    );
    expectLedgerMatches(mock, ledger);
    renderers.boxSelectionRenderer.draw(
      {
        startPoint: CENTER,
        endPoint: [CENTER[0] + 0.01, CENTER[1] + 0.01],
        previousSelection: [],
      } as Parameters<Renderers['boxSelectionRenderer']['draw']>[0],
      projectionData,
      14,
    );
    expectLedgerMatches(mock, ledger);

    disposeRenderers(renderers);
    expect(mock.bufferBytes() + mock.textureBytes()).toBe(0);
    expect(ledger.snapshot().bytes).toBe(0);
  });

  it('when an image is uploaded with its mipmaps, drawn, and when it is forgotten', () => {
    const mock = storageGL();
    const store = new MemoryStore();
    store.createFile({ id: 'file', mimeType: 'image/png', dataURL: PNG });
    const { renderers, ledger, projectionData } = engine(mock, store);
    const image = feature('image', 'Image', CENTER, {
      properties: {
        'maplibre-gl-draw:imageFileId': 'file',
        'maplibre-gl-draw:imageWidth': 300,
        'maplibre-gl-draw:imageHeight': 100,
        'maplibre-gl-draw:createdZoom': 14,
      },
    });
    renderers.imageRenderer.draw(image, projectionData, 14);
    for (const each of images) each.onload?.();
    return Promise.resolve().then(() => {
      renderers.imageRenderer.draw(image, projectionData, 14);
      // 300 x 100 and the levels down to 1 x 1, 4 bytes a texel
      expect(mock.textureBytes()).toBe(levelBytes(300, 100, 4, 9));
      expectLedgerMatches(mock, ledger);
      // The grid of a picture on the globe
      const terrain = new TerrainContext();
      terrain.globeGrids = { fill: 1e-7, line: 1e-7 };
      renderers.quadShader.useTerrainState(terrain);
      const quadBytes = ledger.snapshot().byOwner.images ?? 0;
      renderers.imageRenderer.draw(image, projectionData, 14);
      expect(ledger.snapshot().byOwner.images ?? 0).toBeGreaterThan(quadBytes);
      expectLedgerMatches(mock, ledger);
      // A finer grid grows its buffers
      terrain.globeGrids = { fill: 2e-8, line: 2e-8 };
      renderers.imageRenderer.draw(image, projectionData, 14);
      expectLedgerMatches(mock, ledger);

      // Not drawn for a while, its texture goes; drawn again, it comes back from the decoded image
      renderers.textureCache.sweep(Date.now() + 1_000);
      expect(mock.textureBytes()).toBe(levelBytes(300, 100, 4, 9));
      renderers.textureCache.sweep(Date.now() + 60_000);
      expect(mock.textureBytes()).toBe(0);
      expectLedgerMatches(mock, ledger);
      renderers.imageRenderer.draw(image, projectionData, 14);
      expect(mock.textureBytes()).toBe(levelBytes(300, 100, 4, 9));

      renderers.textureCache.clear();
      expect(mock.textureBytes()).toBe(0);
      expectLedgerMatches(mock, ledger);
      disposeRenderers(renderers);
      expect(mock.bufferBytes() + mock.textureBytes()).toBe(0);
      expect(ledger.snapshot().bytes).toBe(0);
    });
  });

  it('when the rows are drawn by kind, and in one draw per chunk', () => {
    const features: Feature[] = [];
    for (let i = 0; i < 400; i++) {
      const x = CENTER[0] + (i % 20) * 0.003;
      const y = CENTER[1] + Math.floor(i / 20) * 0.003;
      if (i % 3 === 0) features.push(feature(`f${i}`, 'Point', [x, y]));
      else if (i % 3 === 1)
        features.push(
          feature(`f${i}`, 'LineString', [
            [x, y],
            [x + 0.002, y],
          ]),
        );
      else features.push(feature(`f${i}`, 'Polygon', [square(x, y, 0.002)]));
    }
    for (const oneDraw of [false, true]) {
      const { internals, table } = tablesOfFeatures('layer', features);
      const mock = storageGL();
      const { renderers, ledger } = engine(mock);
      const terrain = new TerrainContext();
      const retained = renderers.batchManager.getRetainedRenderers();
      if (!retained) throw new Error('the retained renderers are not there');
      expect(retained.rows).toBeDefined();
      const deps: StoreRetainedDrawDeps = {
        // Without the renderer of the rows, the rows are drawn by kind
        renderers: oneDraw ? retained : { ...retained, rows: undefined },
        batchManager: { beginFrame: () => {}, processFeature: () => true, endFrame: () => {} },
        customRenderers: new Map(),
        customRendererContext: {} as never,
        companions: createFeatureCompanionRegistry(),
      };
      const tableRenderer = new TableLayerRenderer({
        gl: mock.gl,
        terrain,
        ledger,
        requestRepaint: () => {},
        buildBudgetMs: Number.POSITIVE_INFINITY,
      });
      const frame = (): void => {
        tableRenderer.prerender();
        beginRenderFrame();
        const projectionData = projection();
        renderers.shaderInitializer.applyOffsetUniforms(
          calculateOffsetUniforms(CENTER, projectionData),
        );
        tableRenderer.beginFrame();
        tableRenderer.drawLayer(
          internals,
          table,
          LAYER,
          { projectionData, zoom: 14, bounds: undefined },
          deps,
        );
        tableRenderer.endFrame();
      };
      frame();
      frame();
      frame();
      expect(mock.bufferBytes()).toBeGreaterThan(0);
      if (oneDraw) expect(ledger.snapshot().byOwner.rows ?? 0).toBeGreaterThan(0);
      expectLedgerMatches(mock, ledger);

      tableRenderer.dispose(deps.renderers);
      expectLedgerMatches(mock, ledger);
      disposeRenderers(renderers);
      expect(mock.bufferBytes() + mock.textureBytes()).toBe(0);
      expect(ledger.snapshot().bytes).toBe(0);
    }
  });

  it('when the DEM atlas is baked, again at another size, and disposed', () => {
    const mock = storageGL();
    const ledger = new GpuLedger();
    const { terrain, tiles } = demTerrain();
    const atlas = new DemAtlas(mock.gl, ledger);
    expect(atlas.build(terrain, 0.5, true)).not.toBeNull();
    expect(mock.textureBytes()).toBeGreaterThan(0);
    expectLedgerMatches(mock, ledger);
    const before = mock.textureBytes();
    tiles.set('12/3640/1613', { id: 'c' });
    atlas.build(terrain, 0.5, true);
    expect(mock.textureBytes()).not.toBe(before);
    expectLedgerMatches(mock, ledger);

    atlas.dispose();
    expect(mock.bufferBytes() + mock.textureBytes()).toBe(0);
    expect(ledger.snapshot().bytes).toBe(0);
  });

  it('when the terrain of an instance makes its DEM atlas', () => {
    const mock = storageGL();
    const ledger = new GpuLedger();
    const map = mapStub() as unknown as Record<string, unknown>;
    map.terrain = demTerrain().terrain;
    const resolver = new TerrainResolver(
      map as unknown as MapLibreMap,
      new TerrainContext(),
      ledger,
    );
    resolver.resolve(mock.gl);
    expect(ledger.snapshot().byOwner['dem-atlas'] ?? 0).toBeGreaterThan(0);
    expectLedgerMatches(mock, ledger);
    resolver.releaseGpu();
    expect(mock.bufferBytes() + mock.textureBytes()).toBe(0);
    expect(ledger.snapshot().bytes).toBe(0);
  });

  it('when the drape makes its mesh and grows its tables, of the elements and of the rows', () => {
    for (const rows of [false, true]) {
      const mock = storageGL();
      const ledger = new GpuLedger();
      const renderer = new DrapeRenderer(mock.gl, rows).useLedger(ledger);
      expect(renderer.ensure(SHADER_DATA, 64)).toBe(true);
      expect(mock.bufferBytes()).toBeGreaterThan(0);
      expectLedgerMatches(mock, ledger);
      // Another mesh size makes the mesh again
      expect(renderer.ensure(SHADER_DATA, 128)).toBe(true);
      expectLedgerMatches(mock, ledger);
      if (rows) {
        const index = new PartitionedDrapeIndex();
        const copies = new DrapeCopyTables();
        expect(renderer.uploadRows(index.storage, copies)).toBe(true);
        expectLedgerMatches(mock, ledger);
        // More edges than the textures have room for: they are made again, larger
        index.storage.edges.alloc(2048 * 40);
        index.storage.runs.alloc(2048 * 40);
        expect(renderer.uploadRows(index.storage, copies)).toBe(true);
        expectLedgerMatches(mock, ledger);
      } else {
        expect(renderer.upload(new DrapePackBuilder())).toBe(true);
        expectLedgerMatches(mock, ledger);
      }
      expect(mock.textureBytes()).toBeGreaterThan(0);

      renderer.dispose();
      expect(mock.bufferBytes() + mock.textureBytes()).toBe(0);
      expect(ledger.snapshot().bytes).toBe(0);
    }
  });

  it('when the drape of the quads makes its mesh', () => {
    const mock = storageGL();
    const ledger = new GpuLedger();
    const renderer = new QuadDrapeRenderer(mock.gl).useLedger(ledger);
    renderer.ensure({ glsl: '', bind: () => {} }, SHADER_DATA, 64);
    expect(mock.bufferBytes()).toBeGreaterThan(0);
    expectLedgerMatches(mock, ledger);
    renderer.ensure({ glsl: '', bind: () => {} }, SHADER_DATA, 32);
    expectLedgerMatches(mock, ledger);
    renderer.dispose();
    expect(mock.bufferBytes()).toBe(0);
    expect(ledger.snapshot().bytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The sources
// ---------------------------------------------------------------------------

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** The source files of the library (not the tests, nor what only the tests use) */
function librarySources(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'e2e' || entry.name === 'test-support') continue;
      out.push(...librarySources(path));
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
  it('record what they allocate in the ledger', () => {
    const unrecorded: string[] = [];
    let allocating = 0;
    for (const path of librarySources()) {
      const text = readFileSync(path, 'utf8');
      if (!ALLOCATION.test(text)) continue;
      allocating++;
      if (!/\.record\(/.test(text)) unrecorded.push(relative(SRC, path));
    }
    expect(allocating).toBeGreaterThan(10);
    expect(unrecorded).toEqual([]);
  });
});
