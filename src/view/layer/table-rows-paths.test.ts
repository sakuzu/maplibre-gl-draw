// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The chunks of the rows a document gives, and what they hold on the GPU, on the GL that counts
 * its calls:
 *
 * - A document of polygons, lines and points mixed in one layer gives the same chunks whether it
 *   is loaded straight into a new instance or after a document with the same layer and no
 *   features was loaded and drawn: the same chunks, rows, instances, coordinates, styles, order of
 *   the draws and textures, with or without frames drawn while it loads, and with or without the
 *   budget of the frames running out
 * - The bytes the rows hold on the GPU, read from the ledger of the instance once the drawing has
 *   no work left, for a layer of 20,000 features and for 200 layers of one feature each, stay
 *   within bounds of the bytes held before the textures of the chunks were sized as they are now,
 *   and go back to what was held before anything was loaded once a document without layers
 *   replaces them
 */

import { LngLatBounds } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentLayer, DrawDocument, Feature } from '../../index.js';
import { createCountedInstance } from '../../test-utils.js';
import {
  ROWS_INSTANCE_FLOATS,
  ROWS_ROW_STYLE_FLOATS,
  ROWS_STYLE_FLOATS,
  ROWS_STYLE_WIDTH,
  type RowsChunkData,
  readRowsInstance,
} from '../renderers/rows/rows-format.js';
import { type RowsChunk, RowsRenderer } from '../renderers/rows/rows-renderer.js';
import type { TableLayerRenderer } from './table-retained.js';

type Instance = ReturnType<typeof createCountedInstance>;

const instances: Instance[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const instance of instances.splice(0)) instance.draw.destroy();
});

// ============================================================================
// The documents
// ============================================================================

/** The ID of the layer of the documents of one layer */
const LAYER_ID = 'mixed';

/** The size of a cell of the grid of the features, in degrees */
const CELL = 0.003;

/** Where the grid of the features starts */
const ORIGIN: [number, number] = [139.4, 35.6];

/** The kinds of ten features in turn: 5 polygons, 3 lines and 2 points, one kind after another */
const MIXED_KINDS = ['p', 'l', 'pt', 'p', 'l', 'p', 'l', 'p', 'pt', 'p'] as const;

/** The columns of the grid of `n` features */
function columnsOf(n: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(n)));
}

/** The box of the grid of `n` features */
function boxOf(n: number): [number, number, number, number] {
  const columns = columnsOf(n);
  const rows = Math.max(1, Math.ceil(n / columns));
  return [ORIGIN[0], ORIGIN[1], ORIGIN[0] + columns * CELL, ORIGIN[1] + rows * CELL];
}

/**
 * The feature of a kind in the cell `i` of the grid of `n` features (a polygon one in five a
 * 24-gon, a square otherwise, or a square always with `square`)
 */
function featureAt(
  n: number,
  i: number,
  kind: 'p' | 'l' | 'pt',
  layerId: string,
  square = false,
): Feature {
  const columns = columnsOf(n);
  const x = ORIGIN[0] + (i % columns) * CELL;
  const y = ORIGIN[1] + Math.floor(i / columns) * CELL;
  const s = CELL * 0.8;
  let feature: Pick<Feature, 'id' | 'type' | 'geometry'>;
  if (kind === 'p') {
    const ring: [number, number][] = [];
    if (!square && i % 5 === 4) {
      const r = CELL * 0.4;
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        ring.push([x + r + r * Math.cos(a), y + r + r * Math.sin(a)]);
      }
    } else {
      ring.push([x, y], [x + s, y], [x + s, y + s], [x, y + s]);
    }
    ring.push(ring[0]);
    feature = { id: `p-${i}`, type: 'Polygon', geometry: { type: 'Polygon', coordinates: [ring] } };
  } else if (kind === 'l') {
    feature = {
      id: `l-${i}`,
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [x, y],
          [x + s * 0.25, y + s],
          [x + s * 0.5, y],
          [x + s * 0.75, y + s],
          [x + s, y],
        ],
      },
    };
  } else {
    feature = {
      id: `pt-${i}`,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [x + CELL * 0.4, y + CELL * 0.4] },
    };
  }
  return {
    ...feature,
    layerId,
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked: false,
  };
}

function layerOf(id: string, items: readonly string[]): DocumentLayer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    items,
    styleRule: undefined,
    metadata: undefined,
  };
}

/** `n` features in one layer, 5 polygons, 3 lines and 2 points in every ten, mixed */
function mixedDocument(n: number): DrawDocument {
  const features = Array.from({ length: n }, (_, i) =>
    featureAt(n, i, MIXED_KINDS[i % MIXED_KINDS.length], LAYER_ID),
  );
  return {
    version: '3.0.0',
    layers: [
      layerOf(
        LAYER_ID,
        features.map((f) => f.id),
      ),
    ],
    layerOrder: [LAYER_ID],
    groups: [],
    features,
    files: {},
  };
}

/** The layer of the mixed documents, with no features */
function emptyLayerDocument(): DrawDocument {
  return mixedDocument(0);
}

/** A document without layers */
function noLayerDocument(): DrawDocument {
  return { version: '3.0.0', layers: [], layerOrder: [], groups: [], features: [], files: {} };
}

/** `count` layers of one feature each: a point, a line of 5 points and a square, in turn */
function oneFeatureLayers(count: number): DrawDocument {
  const kinds = ['pt', 'l', 'p'] as const;
  const features = Array.from({ length: count }, (_, i) => ({
    ...featureAt(count, i, kinds[i % 3], `layer-${i}`, true),
    id: `f-${i}`,
  }));
  const layers = features.map((f, i) => layerOf(`layer-${i}`, [f.id]));
  return {
    version: '3.0.0',
    layers,
    layerOrder: layers.map((l) => l.id),
    groups: [],
    features,
    files: {},
  };
}

// ============================================================================
// The instance
// ============================================================================

/** A new instance whose map looks at a box */
function instanceOver(box: [number, number, number, number]): Instance {
  const instance = createCountedInstance({ defaultMode: 'select' });
  instances.push(instance);
  const map = instance.map.map as unknown as Record<string, unknown>;
  map.getCenter = () => ({ lng: (box[0] + box[2]) / 2, lat: (box[1] + box[3]) / 2 });
  map.getBounds = () => new LngLatBounds([box[0], box[1]], [box[2], box[3]]);
  return instance;
}

function rendererOf(instance: Instance): TableLayerRenderer {
  const renderer = instance.engine.customLayer.getTableRenderer();
  if (!renderer) throw new Error('the instance draws no rows');
  return renderer;
}

/** Draws frames until the drawing has no work left */
function settle(instance: Instance): void {
  for (let frame = 1; frame <= 2_000; frame++) {
    instance.map.render();
    if (!instance.draw.hasPendingWork()) return;
  }
  throw new Error('the drawing still has work after 2,000 frames');
}

/** Loads a document, drawing a frame whenever the load gives the thread back (with `frames`) */
async function load(instance: Instance, document: DrawDocument, frames: boolean): Promise<void> {
  let done = false;
  const loading = instance.draw.document.load(document).then((result) => {
    done = true;
    if (!result) throw new Error('the document was not loaded');
  });
  if (frames) {
    while (!done) {
      instance.map.render();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  await loading;
}

/** A clock that moves on by `step` ms whenever it is read (the budgets of the frames run out) */
function slowClock(step: number): void {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => {
    now += step;
    return now;
  });
}

/** What the renderer of the rows keeps of a group and of its chunks, read by the tests */
interface ChunkInternals {
  type: string;
  range: { from: number; to: number; kind: string };
  batches: RowsChunk | null;
}
interface GroupInternals {
  chunks: ChunkInternals[] | null;
  retiring: ChunkInternals[] | null;
  other: { chunks: ChunkInternals[] | null } | null;
  texture: { width: number; height: number; rows: number } | null;
  bytes: Uint8Array;
}
interface RendererInternals {
  layers: Map<
    string,
    { groups: Map<number, GroupInternals>; extras: Map<unknown, GroupInternals> }
  >;
  reader: {
    table(
      layerId: string,
    ):
      | { groupCount: number; groupAt(g: number): { handle: number; state: Uint16Array } }
      | undefined;
    deltaParts(table: unknown): readonly unknown[];
    deltaInserts(table: unknown): readonly unknown[];
  };
}

/** The chunks of rows the renderer of an instance draws, by layer */
function chunksOf(instance: Instance): RowsChunk[] {
  const renderer = rendererOf(instance) as unknown as RendererInternals;
  const out: RowsChunk[] = [];
  for (const layer of renderer.layers.values()) {
    for (const group of [...layer.groups.values(), ...layer.extras.values()]) {
      for (const chunk of group.chunks ?? []) if (chunk.batches) out.push(chunk.batches);
    }
  }
  return out;
}

// ============================================================================
// The chunks, loaded straight and after an empty document
// ============================================================================

/** What is written to the GPU of a chunk: its arrays as uploaded, with the writes in place after */
interface Mirror {
  instances: Float32Array;
  coords: Float32Array;
  rowStyles: Float32Array;
  patches: number;
}

/**
 * Keeps a copy of what every chunk uploads, and of the writes in place uploaded after, and a list
 * of the float textures the renderer makes ([width, height, bytes per texel])
 */
function watchUploads(): { mirrors: WeakMap<RowsChunk, Mirror>; textures: number[][] } {
  const mirrors = new WeakMap<RowsChunk, Mirror>();
  const textures: number[][] = [];
  const proto = RowsRenderer.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const upload = proto.uploadChunk;
  vi.spyOn(proto, 'uploadChunk').mockImplementation(function (this: unknown, ...args: unknown[]) {
    const chunk = args[0] as RowsChunk;
    const data = chunk.packed as RowsChunkData | null;
    if (data && !chunk.disposed) {
      mirrors.set(chunk, {
        instances: data.instances.slice(0, data.instanceCount * ROWS_INSTANCE_FLOATS),
        coords: data.coords.slice(0, data.coordCount * 2),
        rowStyles: data.rowStyles.slice(0, data.rows * ROWS_ROW_STYLE_FLOATS),
        patches: 0,
      });
    }
    return upload.apply(this, args);
  });
  const patches = proto.uploadPatches;
  vi.spyOn(proto, 'uploadPatches').mockImplementation(function (this: unknown, ...args: unknown[]) {
    const chunk = args[0] as RowsChunk;
    const mirror = mirrors.get(chunk);
    if (mirror && chunk.writes && chunk.uploaded && !chunk.disposed) {
      mirror.patches++;
      const apply = (
        target: Float32Array,
        floats: number,
        writes: { forEach(read: (t: number, v: Float32Array, at: number) => void): void },
      ) => {
        writes.forEach((texel, values, at) => {
          for (let k = 0; k < floats; k++) target[texel * floats + k] = values[at + k];
        });
      };
      apply(mirror.instances, ROWS_INSTANCE_FLOATS, chunk.writes.instances);
      apply(mirror.coords, 2, chunk.writes.coords);
      apply(mirror.rowStyles, ROWS_ROW_STYLE_FLOATS, chunk.writes.rowStyles);
    }
    return patches.apply(this, args);
  });
  const make = proto.createFloatTexture;
  vi.spyOn(proto, 'createFloatTexture').mockImplementation(function (
    this: unknown,
    ...args: unknown[]
  ) {
    textures.push([args[1] as number, args[2] as number, args[3] as number]);
    return make.apply(this, args);
  });
  return { mirrors, textures };
}

/** Everything compared of the chunks of the layer of an instance */
function describeChunks(
  instance: Instance,
  mirrors: WeakMap<RowsChunk, Mirror>,
): Record<string, unknown> {
  const renderer = rendererOf(instance) as unknown as RendererInternals;
  const table = renderer.reader.table(LAYER_ID);
  if (!table) throw new Error('the layer holds no rows');
  const layer = renderer.layers.get(LAYER_ID);
  if (!layer) throw new Error('the layer is not drawn');
  const keyOf = new Map<RowsChunk, string>();
  const chunks: Record<string, unknown>[] = [];
  const describeOne = (key: string, chunk: ChunkInternals) => {
    const out: Record<string, unknown> = { key, type: chunk.type, range: { ...chunk.range } };
    chunks.push(out);
    const gpu = chunk.batches;
    if (!gpu) return;
    keyOf.set(gpu, key);
    const data = gpu.data;
    const mirror = mirrors.get(gpu);
    if (!mirror) throw new Error(`the chunk ${key} was not uploaded`);
    const fields = ['kind', 'row', 'i0', 'i1', 'i2', 'i3', 't0', 't1', 'extra'] as const;
    const decoded = Object.fromEntries(
      fields.map((field) => [field, new Float64Array(data.instanceCount)]),
    ) as Record<(typeof fields)[number], Float64Array>;
    for (let i = 0; i < data.instanceCount; i++) {
      const instance = readRowsInstance(mirror.instances, i);
      decoded.kind[i] = instance.kind;
      decoded.row[i] = instance.row;
      for (let k = 0; k < 4; k++) decoded[`i${k}` as 'i0'][i] = instance.indices[k];
      decoded.t0[i] = instance.t0;
      decoded.t1[i] = instance.t1;
      decoded.extra[i] = instance.extra;
    }
    // The values of the resolved style of each row (the numbers of two palettes could differ)
    const styleValues = new Float32Array(data.rows * ROWS_STYLE_FLOATS);
    for (let r = 0; r < data.rows; r++) {
      const style = data.rowStyle[r];
      if (style < 0) continue;
      styleValues.set(
        data.palette.values.subarray(style * ROWS_STYLE_FLOATS, (style + 1) * ROWS_STYLE_FLOATS),
        r * ROWS_STYLE_FLOATS,
      );
    }
    Object.assign(out, {
      part: gpu.part,
      uploaded: gpu.uploaded,
      refused: gpu.refused,
      disposed: gpu.disposed,
      origin: [...data.origin],
      rowBase: data.rowBase,
      rows: data.rows,
      instanceCount: data.instanceCount,
      coordCount: data.coordCount,
      lines: { ...data.lines },
      rowFirst: data.rowFirst,
      coordFirst: data.coordFirst,
      instances: decoded,
      coords: mirror.coords,
      rowStyles: mirror.rowStyles,
      rowStyleNumbers: data.rowStyle,
      styleValues,
      patchesUploaded: mirror.patches,
      coordTexture: gpu.coords ? [gpu.coords.width, gpu.coords.height] : null,
      rowStyleTexture: gpu.rowStyles ? [gpu.rowStyles.width, gpu.rowStyles.height] : null,
      paletteTexture: data.palette.gpu ? [data.palette.gpu.width, data.palette.gpu.height] : null,
      paletteCount: data.palette.count,
    });
  };
  const groups: Record<string, unknown>[] = [];
  for (let g = 0; g < table.groupCount; g++) {
    const group = table.groupAt(g);
    const cache = layer.groups.get(group.handle);
    groups.push({
      index: g,
      rows: group.state.length,
      cached: cache !== undefined,
      chunks: cache?.chunks?.length ?? -1,
      retiring: cache?.retiring?.length ?? 0,
      other: cache?.other?.chunks?.length ?? 0,
      stateTexture: cache?.texture
        ? [cache.texture.width, cache.texture.height, cache.texture.rows]
        : null,
      stateBytes: cache?.bytes ?? null,
    });
    for (const [i, chunk] of (cache?.chunks ?? []).entries()) describeOne(`g${g}/c${i}`, chunk);
  }
  let part = 0;
  for (const cache of layer.extras.values()) {
    for (const [i, chunk] of (cache.chunks ?? []).entries())
      describeOne(`delta${part}/c${i}`, chunk);
    part++;
  }
  // The order the chunks are drawn in, in one frame
  const proto = RowsRenderer.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const drawRange = proto.drawRange;
  const order: unknown[] = [];
  const spy = vi.spyOn(proto, 'drawRange').mockImplementation(function (
    this: unknown,
    ...args: unknown[]
  ) {
    order.push([
      keyOf.get(args[0] as RowsChunk) ?? 'unknown',
      args[1],
      args[2],
      args[7] ?? false,
      args[8] ?? false,
    ]);
    return drawRange.apply(this, args);
  });
  const record: Record<string, unknown>[] = [];
  rendererOf(instance).recordDraws(record as never);
  instance.map.render();
  rendererOf(instance).recordDraws(null);
  spy.mockRestore();
  return {
    groupCount: table.groupCount,
    deltaParts: renderer.reader.deltaParts(table).length,
    deltaInserts: renderer.reader.deltaInserts(table).length,
    extras: layer.extras.size,
    groups,
    chunkCount: chunks.length,
    rowsPerChunk: chunks.map((c) => c.rows),
    instanceTotal: chunks.reduce((sum, c) => sum + ((c.instanceCount as number) ?? 0), 0),
    coordTotal: chunks.reduce((sum, c) => sum + ((c.coordCount as number) ?? 0), 0),
    chunks,
    drawOrder: order,
    drawRecord: record.map(({ group: _group, ...rest }) => rest),
  };
}

/** Every difference between two descriptions, the arrays of numbers summed up */
function differences(a: unknown, b: unknown, path = ''): string[] {
  const numbers = (v: unknown): v is ArrayLike<number> =>
    (ArrayBuffer.isView(v) && !(v instanceof DataView)) ||
    (Array.isArray(v) && v.every((x) => typeof x === 'number'));
  if (numbers(a) && numbers(b)) {
    const out: string[] = [];
    if (a.length !== b.length) out.push(`${path}: length ${a.length} vs ${b.length}`);
    const n = Math.min(a.length, b.length);
    let count = 0;
    const first: string[] = [];
    for (let i = 0; i < n; i++) {
      if (Object.is(a[i], b[i])) continue;
      count++;
      if (first.length < 5) first.push(`[${i}] ${a[i]} vs ${b[i]}`);
    }
    if (count > 0) out.push(`${path}: ${count} of ${n} differ, first ${first.join(', ')}`);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: string[] = [];
    if (a.length !== b.length) out.push(`${path}: length ${a.length} vs ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      out.push(...differences(a[i], b[i], `${path}[${i}]`));
    }
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const out: string[] = [];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      out.push(
        ...differences(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
          `${path}.${key}`,
        ),
      );
    }
    return out;
  }
  return Object.is(a, b) ? [] : [`${path}: ${String(a)} vs ${String(b)}`];
}

/**
 * The chunks of the mixed document of `n` features loaded straight into a new instance, and
 * loaded into a new instance after the layer without features was loaded and drawn
 */
async function bothPaths(
  n: number,
  frames: boolean,
  clockStep: number | null,
  afterEmpty: (document: DrawDocument) => DrawDocument = (document) => document,
) {
  const { mirrors, textures } = watchUploads();
  if (clockStep !== null) slowClock(clockStep);
  const straight = instanceOver(boxOf(n));
  settle(straight);
  textures.length = 0;
  await load(straight, mixedDocument(n), frames);
  settle(straight);
  const straightTextures = textures.splice(0);
  const after = instanceOver(boxOf(n));
  settle(after);
  await load(after, emptyLayerDocument(), false);
  settle(after);
  textures.length = 0;
  await load(after, afterEmpty(mixedDocument(n)), frames);
  settle(after);
  const afterTextures = textures.splice(0);
  const described = (instance: Instance, made: number[][]): Record<string, unknown> => ({
    ...describeChunks(instance, mirrors),
    textures: made,
  });
  return {
    straight: described(straight, straightTextures),
    after: described(after, afterTextures),
  };
}

describe('the chunks of a document of mixed kinds, loaded straight and after an empty document', () => {
  for (const n of [2_000, 20_000]) {
    for (const frames of [false, true]) {
      for (const clockStep of [null, 2]) {
        const clock =
          clockStep === null ? 'the clock as it is' : 'the budget of the frames run out';
        it(`are the same for ${n} features, ${frames ? 'with' : 'without'} frames while it loads, with ${clock}`, async () => {
          const { straight, after } = await bothPaths(n, frames, clockStep);
          // The comparison compares something: chunks drawn, with their instances
          expect(straight.chunkCount as number).toBeGreaterThan(0);
          expect((straight.drawOrder as unknown[]).length).toBeGreaterThanOrEqual(
            straight.chunkCount as number,
          );
          expect(straight.instanceTotal as number).toBeGreaterThan(n);
          expect((straight.textures as unknown[]).length).toBeGreaterThan(0);
          expect(differences(straight, after)).toEqual([]);
        });
      }
    }
  }

  it('differ when one feature of one of them is dashed (the comparison tells them apart)', async () => {
    const { straight, after } = await bothPaths(2_000, false, null, (document) => ({
      ...document,
      features: document.features.map((f) =>
        f.id === 'p-7' ? { ...f, style: { lineStyle: 'dashed' } } : f,
      ),
    }));
    const found = differences(straight, after);
    expect(found.some((line) => line.includes('.instances.kind'))).toBe(true);
    expect(found.some((line) => line.includes('.styleValues'))).toBe(true);
  });
});

// ============================================================================
// What the rows hold on the GPU
// ============================================================================

/**
 * The bytes of the rows held on the GPU for the documents of the tests before the textures of the
 * chunks were sized as they are now (their widths the counts they hold, up to the widest), read
 * from the ledger as these tests read them
 */
const BEFORE = {
  /** One layer of the mixed document of 20,000 features */
  mixed20000: 6_719_128,
  /** 200 layers of one feature each */
  layers200: 3_346_632,
} as const;

/** The bytes of one line of the texture of the values of the styles of a layer */
const STYLE_LINE_BYTES = ROWS_STYLE_WIDTH * ROWS_STYLE_FLOATS;

/** The bytes of the rows the ledger of an instance holds */
function rowBytesOf(instance: Instance): number {
  return instance.engine.customLayer.getGpuLedger().snapshot().rowBytes;
}

describe('the bytes of the rows on the GPU', () => {
  it('of a layer of 20,000 features stay within 1% over those held before, and go back with the layer', async () => {
    const instance = instanceOver(boxOf(20_000));
    settle(instance);
    const empty = rowBytesOf(instance);
    await load(instance, mixedDocument(20_000), false);
    settle(instance);
    const held = rowBytesOf(instance);
    expect(held).toBeGreaterThanOrEqual(BEFORE.mixed20000);
    expect(held).toBeLessThanOrEqual(BEFORE.mixed20000 * 1.01);
    await load(instance, noLayerDocument(), false);
    settle(instance);
    expect(rowBytesOf(instance)).toBe(empty);
    // The layer kept without features keeps the texture of the values of its styles
    await load(instance, mixedDocument(20_000), false);
    settle(instance);
    await load(instance, emptyLayerDocument(), false);
    settle(instance);
    expect(rowBytesOf(instance)).toBeLessThanOrEqual(empty + STYLE_LINE_BYTES);
  });

  it('of 200 layers of one feature each stay within 64 bytes a chunk over those held before, and go back with the layers', async () => {
    const document = oneFeatureLayers(200);
    const instance = instanceOver(boxOf(200));
    settle(instance);
    const empty = rowBytesOf(instance);
    await load(instance, document, false);
    settle(instance);
    const held = rowBytesOf(instance);
    const chunks = chunksOf(instance).length;
    expect(chunks).toBe(200);
    expect(held).toBeGreaterThanOrEqual(BEFORE.layers200);
    expect(held).toBeLessThanOrEqual(BEFORE.layers200 + 64 * chunks);
    await load(instance, noLayerDocument(), false);
    settle(instance);
    expect(rowBytesOf(instance)).toBe(empty);
  });
});
