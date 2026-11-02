// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The drawing of a layer held as rows in one draw per chunk, with the renderer of the rows on a
 * GL that records its calls, and the renderers by kind as mocks
 *
 * - The ranges drawn, in the order they are drawn, are the rows of the layer in their order,
 *   each once; a chunk ends only at a row drawn at once, and holds rows of every kind
 * - Within a chunk the instances are the rows of the chunk in their order
 * - A chunk is written to the GPU before the main pass of a frame and drawn from that frame on;
 *   nothing is written to a buffer or a texture of the rows while a layer is drawn
 * - The cuts, the chunks out of view and the record of the draws work as by kind
 * - The globe is drawn in one draw as a flat map is; where the drawing in one draw cannot draw
 *   (the program compiling, the switch of the tests), the rows are drawn by kind; a group is
 *   drawn with the chunks of the drawing it had until those of the new one are built, and the old
 *   ones are then released
 * - A write in place of the style of a row reaches its chunk; a row drawn at once is refused
 * - The draws of a mixed layer are a few, and what they hold is in the ledger
 */

import { planarCoordinates } from '@sakuzu/tabane';
import type { ProjectionData } from 'maplibre-gl';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RowField } from '../../api/tables.js';
import type { LayerTable } from '../../feature-table/layer-table.js';
import { writeRowGeometry } from '../../feature-table/row-write.js';
import { ROW_WRITE_GEOMETRY, ROW_WRITE_STYLE } from '../../feature-table/types.js';
import type { Feature, Layer } from '../../shared/types/model.js';
import {
  createTransformFieldsRegistry,
  type TransformFieldsRegistry,
} from '../../store/transform-roles.js';
import { createTestDrawer, feature, seededRandom, tablesOfFeatures } from '../../test-utils.js';
import { createFeatureCompanionRegistry } from '../feature-companion.js';
import { GpuLedger } from '../gpu-ledger.js';
import { retainedDrawRun } from '../renderers/draw-run.js';
import type { RetainedRendererSet } from '../renderers/retained.js';
import {
  type RowSpriteSource,
  type RowsChunkData,
  type RowsChunkLayout,
  readRowsInstance,
} from '../renderers/rows/rows-format.js';
import { RowsRenderer } from '../renderers/rows/rows-renderer.js';
import { beginRenderFrame } from '../shaders/frame.js';
import { TerrainContext } from '../terrain/context.js';
import type { StoreRetainedDrawDeps } from './store-retained-immediate.js';
import { type TableDrawRecord, TableLayerRenderer } from './table-retained.js';

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

const PROJECTION = {
  mainMatrix: new Float32Array(16),
  projectionTransition: 0,
} as unknown as ProjectionData;

interface Call {
  readonly name: string;
  readonly args: unknown[];
}

/** A GL that records its calls (`complete` answers whether the program is compiled) */
function recordingGL(options: { parallel?: boolean; complete?: () => boolean } = {}) {
  const calls: Call[] = [];
  let next = 1;
  const target: Record<string, unknown> = {
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
  };
  const gl = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      if (/^[A-Z_0-9]+$/.test(prop)) return prop.length;
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
        if (prop.startsWith('create')) return { id: next++ };
        if (prop === 'getExtension') return options.parallel ? {} : null;
        if (prop === 'getProgramParameter') {
          return args[1] === 0x91b1 ? (options.complete?.() ?? true) : true;
        }
        if (prop === 'getUniformLocation') return { name: args[1] };
        if (prop === 'getParameter') return 4;
        return undefined;
      };
    },
  }) as unknown as WebGL2RenderingContext;
  return { gl, calls };
}

/** Mocks of the renderers by kind, recording their draws */
function kindRenderers() {
  let next = 1;
  const draws: Array<{ kind: string; from: number; to: number }> = [];
  const disposed: number[] = [];
  const batch = (kind: string, rowFirst: Int32Array) => ({ id: next++, kind, rowFirst }) as never;
  const drawRange = (b: unknown, from: number, to: number) => {
    draws.push({ kind: (b as { kind: string }).kind, from, to });
  };
  const dispose = (b: unknown) => disposed.push((b as { id: number }).id);
  return {
    draws,
    disposed,
    point: {
      buildRetained: () => null,
      drawRetained: () => {},
      disposeRetained: dispose,
      buildRetainedRows: (_i: unknown, _c: unknown, _o: unknown, rowFirst: Int32Array) =>
        batch('point', rowFirst),
      drawRetainedRange: drawRange,
    },
    line: {
      buildRetainedBatch: () => null,
      drawRetainedBatch: () => {},
      disposeRetainedBatch: dispose,
      buildRetainedRows: (_a: unknown, _o: unknown, rowFirst: Int32Array) =>
        batch('line', rowFirst),
      drawRetainedRange: drawRange,
    },
    polygon: {
      buildRetained: () => null,
      drawRetained: () => {},
      disposeRetained: dispose,
      createRetainedRows: (_v: unknown, _i: unknown, _o: unknown, rowFirst: Int32Array) =>
        batch('polygon', rowFirst),
      writeRetainedRows: () => {},
      drawRetainedRange: drawRange,
    },
  };
}

/** Features of every kind interleaved at random, images (drawn at once) among them */
function interleaved(count: number, seed: number): Feature[] {
  const random = seededRandom(seed);
  const out: Feature[] = [];
  for (let i = 0; i < count; i++) {
    const x = random() * 10;
    const y = random() * 10;
    const pick = random();
    if (pick < 0.25) out.push(feature(`p${i}`, 'Point', [x, y]));
    else if (pick < 0.45) {
      out.push(
        feature(`l${i}`, 'LineString', [
          [x, y],
          [x + 0.1, y + 0.1],
          [x + 0.2, y],
        ]),
      );
    } else if (pick < 0.7) {
      out.push(
        feature(`g${i}`, 'Polygon', [
          [
            [x, y],
            [x + 0.1, y],
            [x + 0.1, y + 0.1],
            [x, y + 0.1],
            [x, y],
          ],
        ]),
      );
    } else if (pick < 0.85) {
      out.push(
        feature(
          `d${i}`,
          'LineString',
          [
            [x, y],
            [x + 0.1, y],
          ],
          { style: { lineStyle: 'dashed' } },
        ),
      );
    } else if (pick < 0.9) {
      out.push(feature(`i${i}`, 'Image', [x, y]));
    } else {
      out.push(
        feature(
          `h${i}`,
          'Polygon',
          [
            [
              [x, y],
              [x + 0.1, y],
              [x, y + 0.1],
              [x, y],
            ],
          ],
          { style: { lineStyle: 'dotted', fillOpacity: 0.3 } },
        ),
      );
    }
  }
  return out;
}

let terrain: TerrainContext;

beforeEach(() => {
  terrain = new TerrainContext();
});

function setup(
  features: Feature[],
  targetRows?: number,
  options: {
    parallel?: boolean;
    complete?: () => boolean;
    customRenderers?: Map<string, unknown>;
    transformFields?: TransformFieldsRegistry;
  } = {},
) {
  const { internals, table, tables, writer } = tablesOfFeatures('layer', features, targetRows);
  const mock = recordingGL(options);
  const ledger = new GpuLedger();
  const rows = new RowsRenderer(null, mock.gl, 1, terrain, ledger);
  rows.ensureShader({ vertexShaderPrelude: '', define: '', variantName: 'mercator' });
  const made: RowsChunkData[] = [];
  const released: RowsChunkLayout[] = [];
  const createChunk = rows.createChunk.bind(rows);
  rows.createChunk = (data) => {
    made.push(data);
    return createChunk(data);
  };
  const disposeChunk = rows.disposeChunk.bind(rows);
  rows.disposeChunk = (chunk) => {
    released.push(chunk.data);
    disposeChunk(chunk);
  };
  const kinds = kindRenderers();
  const renderers: RetainedRendererSet = {
    point: kinds.point,
    line: kinds.line,
    polygon: kinds.polygon,
    styles: createTestDrawer(),
    viewport: () => [800, 600],
    run: retainedDrawRun(mock.gl),
    rows,
  } as unknown as RetainedRendererSet;
  const immediate: string[] = [];
  const deps: StoreRetainedDrawDeps = {
    renderers,
    batchManager: {
      beginFrame: () => {},
      processFeature: (f: Feature) => {
        immediate.push(f.id);
        return true;
      },
      endFrame: () => {},
    },
    customRenderers: (options.customRenderers ?? new Map()) as never,
    customRendererContext: {} as never,
    companions: createFeatureCompanionRegistry(),
  };
  const renderer = new TableLayerRenderer({
    gl: mock.gl,
    terrain,
    ledger,
    requestRepaint: () => {},
    buildBudgetMs: Number.POSITIVE_INFINITY,
    ...(options.transformFields && { transformFields: () => options.transformFields ?? null }),
  });
  /** One frame: the pass before the main one, then the layer; returns the ranges drawn */
  const frame = (bounds?: { minX: number; minY: number; maxX: number; maxY: number }) => {
    renderer.prerender();
    beginRenderFrame();
    renderer.beginFrame();
    const record: TableDrawRecord[] = [];
    renderer.recordDraws(record);
    const at = mock.calls.length;
    immediate.length = 0;
    renderer.drawLayer(
      internals,
      table,
      LAYER,
      { projectionData: PROJECTION, zoom: 10, bounds },
      deps,
    );
    renderer.endFrame();
    renderer.recordDraws(null);
    return { record, calls: mock.calls.slice(at), immediate: [...immediate] };
  };
  return {
    internals,
    table,
    tables,
    writer,
    renderer,
    rows,
    frame,
    made,
    released,
    kinds,
    ledger,
    deps,
    mock,
  };
}

/** The rows the ranges cover, in order, as `group:row` */
function coverage(record: TableDrawRecord[]): string[] {
  const out: string[] = [];
  for (const entry of record) {
    for (let row = entry.from; row < entry.to; row++) out.push(`${entry.groupIndex}:${row}`);
  }
  return out;
}

function allRows(table: LayerTable): string[] {
  const out: string[] = [];
  for (let g = 0; g < table.groupCount; g++) {
    for (let row = 0; row < table.groupAt(g).data.length; row++) out.push(`${g}:${row}`);
  }
  return out;
}

/**
 * The handles of the rows drawn, in the order they are drawn: the rows of the ranges recorded
 * that the state of their group does not hide, the rows of the delta included
 */
function drawnHandles(record: TableDrawRecord[], table: LayerTable): number[] {
  const out: number[] = [];
  for (const entry of record) {
    const group = entry.delta ? table.delta.group : table.groupAt(entry.groupIndex);
    if (!group) continue;
    for (let row = entry.from; row < entry.to; row++) {
      if ((group.gpuState[row] & 1) === 0) out.push(group.data.handles[row]);
    }
  }
  return out;
}

/** Every row of a layer that is not hidden, in its order */
function visibleHandles(table: LayerTable): number[] {
  const order = table.rowOrder();
  const out: number[] = [];
  for (let i = 0; i < order.handles.length; i++) {
    if ((order.groups[i].gpuState[order.rows[i]] & 1) === 0) out.push(order.handles[i]);
  }
  return out;
}

function inOrder(record: TableDrawRecord[]): boolean {
  for (let i = 1; i < record.length; i++) {
    const a = record[i - 1];
    const b = record[i];
    if (b.groupIndex < a.groupIndex) return false;
    if (b.groupIndex === a.groupIndex && b.from < a.to) return false;
  }
  return true;
}

const draws = (calls: Call[]) => calls.filter((c) => c.name === 'drawArraysInstanced').length;

describe('the drawing of a layer held as rows in one draw per chunk', () => {
  it('draws every row once, in the order of the layer, a chunk ending only at a row drawn at once', () => {
    for (const seed of [1, 2, 3]) {
      const features = interleaved(400, seed);
      const { table, frame } = setup(features, 64);
      frame(); // packs
      const { record, calls, immediate } = frame();
      expect(inOrder(record)).toBe(true);
      expect(coverage(record)).toEqual(allRows(table));
      expect(new Set(record.map((entry) => entry.kind))).toEqual(new Set(['rows', 'immediate']));
      // Every range in one draw is one draw, and only the images are drawn at once
      expect(draws(calls)).toBe(record.filter((entry) => entry.kind === 'rows').length);
      expect(immediate.every((id) => id.startsWith('i'))).toBe(true);
      expect(immediate.length).toBe(features.filter((f) => f.id.startsWith('i')).length);
      // Two chunks drawn in one draw are never next to each other but across a group
      for (let i = 1; i < record.length; i++) {
        const a = record[i - 1];
        const b = record[i];
        if (a.groupIndex === b.groupIndex)
          expect(a.kind === 'rows' && b.kind === 'rows').toBe(false);
      }
    }
  });

  it('packs the instances of a chunk in the order of its rows, each row once', () => {
    const { frame, made } = setup(interleaved(300, 4), 100);
    frame();
    expect(made.length).toBeGreaterThan(0);
    for (const data of made) {
      let last = -1;
      for (let r = 0; r < data.rows; r++) {
        for (let i = data.rowFirst[r]; i < data.rowFirst[r + 1]; i++) {
          const instance = readRowsInstance(data.instances, i);
          expect(instance.row).toBe(data.rowBase + r);
          expect(instance.row).toBeGreaterThanOrEqual(last);
          last = instance.row;
        }
      }
      expect(data.rowFirst[data.rows]).toBe(data.instanceCount);
    }
  });

  it('writes a chunk before the main pass and draws it from that frame on, writing nothing while drawing', () => {
    const { frame } = setup(interleaved(200, 5), 100);
    // The first frame packs the chunks and draws only the rows drawn at once
    const first = frame();
    expect(first.record.filter((entry) => entry.kind === 'rows')).toEqual([]);
    expect(first.calls.some((c) => c.name === 'bufferData')).toBe(false);
    // The second frame writes them before its main pass, and draws them
    const second = frame();
    expect(second.record.filter((entry) => entry.kind === 'rows').length).toBeGreaterThan(0);
    for (const name of ['bufferData', 'bufferSubData', 'texStorage2D', 'texSubImage2D']) {
      expect(second.calls.some((c) => c.name === name)).toBe(false);
    }
  });

  it('skips the chunks out of view and keeps the order of the others', () => {
    const { table, frame } = setup(interleaved(300, 6), 50);
    frame({ minX: 0, minY: 0, maxX: 3, maxY: 3 });
    const { record } = frame({ minX: 0, minY: 0, maxX: 3, maxY: 3 });
    const inOneDraw = record.filter((entry) => entry.kind === 'rows');
    expect(inOneDraw.length).toBeGreaterThan(0);
    expect(coverage(inOneDraw).length).toBeLessThan(allRows(table).length);
    expect(inOrder(record)).toBe(true);
  });

  it('cuts the ranges in view at the places asked for, one more draw per cut, the rows unchanged', () => {
    const features = interleaved(500, 7);
    const plain = setup(features, 100);
    plain.frame();
    const before = plain.frame().record;
    const plainDraws = before.filter((entry) => entry.kind === 'rows').length;
    for (const cuts of [1, 10, 100]) {
      const { renderer, frame } = setup(features, 100);
      renderer.setArtificialCuts(cuts);
      // Packed, then written and drawn: the cuts are placed among the chunks drawn
      frame();
      frame();
      const { record, calls } = frame();
      expect(inOrder(record)).toBe(true);
      expect(coverage(record)).toEqual(coverage(before));
      expect(draws(calls)).toBe(plainDraws + cuts);
    }
  });

  it('draws in one draw on the globe as on a flat map, and by kind on the switch of the tests', () => {
    const { renderer, frame } = setup(interleaved(200, 8), 100);
    terrain.globeGrids = { fill: 0.001, line: 0.001 };
    // Packed, written, then drawn
    frame();
    frame();
    let { record } = frame();
    expect(record.some((entry) => entry.kind === 'rows')).toBe(true);
    expect(record.some((entry) => entry.kind === 'polygon')).toBe(false);
    terrain.globeGrids = null;
    renderer.setDrawingByKind(true);
    // The chunks by kind are built while the chunks in one draw draw the rows
    frame();
    ({ record } = frame());
    expect(record.some((entry) => entry.kind === 'rows')).toBe(false);
    renderer.setDrawingByKind(false);
    // Packed, written, then drawn (the drawing of a group is chosen before its chunks are built)
    frame();
    frame();
    ({ record } = frame());
    expect(record.some((entry) => entry.kind === 'rows')).toBe(true);
    expect(record.some((entry) => entry.kind === 'polygon')).toBe(false);
  });

  it('draws a group by kind while its chunks in one draw are built, then releases the chunks by kind', () => {
    const { table, renderer, frame, kinds } = setup(interleaved(300, 9), 100);
    renderer.setDrawingByKind(true);
    frame();
    frame();
    const built = kinds.disposed.length;
    renderer.setDrawingByKind(false);
    // The chunks in one draw are being built: the groups keep being drawn by kind, whole
    const meanwhile = frame().record;
    expect(coverage(meanwhile)).toEqual(allRows(table));
    expect(meanwhile.some((entry) => entry.kind === 'rows')).toBe(false);
    // Once they are built, they are drawn, and the chunks by kind are released
    frame();
    const after = frame().record;
    expect(coverage(after)).toEqual(allRows(table));
    expect(after.some((entry) => entry.kind === 'polygon')).toBe(false);
    expect(kinds.disposed.length).toBeGreaterThan(built);
  });

  it('draws by kind while the program compiles, and in one draw once it is ready', () => {
    let complete = false;
    const { table, frame } = setup(interleaved(200, 10), 100, {
      parallel: true,
      complete: () => complete,
    });
    frame();
    let { record } = frame();
    expect(coverage(record)).toEqual(allRows(table));
    expect(record.some((entry) => entry.kind === 'rows')).toBe(false);
    complete = true;
    frame();
    frame();
    ({ record } = frame());
    expect(coverage(record)).toEqual(allRows(table));
    expect(record.every((entry) => entry.kind === 'rows' || entry.kind === 'immediate')).toBe(true);
  });

  it('writes the style of a row written in place into its chunk, and makes a row drawn at once again', () => {
    const features = [
      feature('a', 'Point', [1, 1]),
      feature('b', 'Point', [2, 2], { style: { pointColor: '#ff0000' } }),
      feature('i', 'Image', [3, 3]),
    ];
    const { table, renderer, frame, made } = setup(features);
    frame();
    frame();
    const group = table.groupAt(0);
    const data = made[0];
    expect(data.rowStyle[0]).not.toBe(data.rowStyle[1]);
    // Row 0 takes the style of row 1, and the image is written: both are taken before the
    // next frame
    group.data.styles[0] = group.data.styles[1];
    const write = { sameShape: true, from: 0, to: 0, keys: [] };
    renderer.rowsWritten('layer', [
      {
        group: group.handle,
        row: 0,
        handle: group.data.handles[0],
        what: ROW_WRITE_STYLE,
        ...write,
      },
      {
        group: group.handle,
        row: 2,
        handle: group.data.handles[2],
        what: ROW_WRITE_STYLE,
        ...write,
      },
    ]);
    expect(data.rowStyle[0]).not.toBe(data.rowStyle[1]);
    frame();
    expect(data.rowStyle[0]).toBe(data.rowStyle[1]);
    expect(renderer.writeStats).toMatchObject({ inPlace: 1, styleOnly: 1, rebuilt: 0 });
  });

  it('draws the points of an extension with pictures in the chunks, among the other rows', () => {
    const source: RowSpriteSource = {
      texture: null,
      revision: 1,
      sprite: (style) =>
        style?.pointColor === '#ff0000'
          ? { uv: [0, 0, 1, 1], halfWidth: 8, halfHeight: 8, direction: -1 }
          : null,
    };
    const features = [
      feature('g', 'Polygon', [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ]),
      feature('a', 'Point', [1, 1], { style: { pointColor: '#ff0000' } }),
      feature('b', 'Point', [2, 2]),
      feature('l', 'LineString', [
        [0, 0],
        [1, 1],
      ]),
    ];
    const extension = { name: 'pictures', rowSprites: source, draw: () => {} };
    const { frame, made } = setup(features, undefined, {
      customRenderers: new Map([['Point', extension]]),
    });
    frame();
    const { record, immediate } = frame();
    expect(record.map((entry) => [entry.kind, entry.from, entry.to])).toEqual([
      ['rows', 0, 2],
      ['immediate', 2, 3],
      ['rows', 3, 4],
    ]);
    // The point without a picture is drawn by the extension, at once
    expect(immediate).toEqual([]);
    expect(made[0].sprites).toBe(source);
    expect(made[1].sprites).toBeNull();
  });

  it('draws at once the points of an extension whose type declares a scale field, pictures or not', () => {
    const source: RowSpriteSource = {
      texture: null,
      revision: 1,
      sprite: () => ({ uv: [0, 0, 1, 1], halfWidth: 8, halfHeight: 8, direction: -1 }),
    };
    const features = [
      feature('g', 'Polygon', [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ]),
      feature('a', 'Pin', [1, 1]),
      feature('b', 'Mark', [2, 2]),
      feature('l', 'LineString', [
        [0, 0],
        [1, 1],
      ]),
    ];
    const transformFields = createTransformFieldsRegistry();
    transformFields.register('Pin', { scaleKey: 'size' });
    transformFields.register('Mark', { angleDegreesKey: 'angle' });
    const { frame, made } = setup(features, undefined, {
      customRenderers: new Map([
        ['Pin', { name: 'Pin', rowSprites: source, draw: () => {} }],
        ['Mark', { name: 'Mark', rowSprites: source, draw: () => {} }],
      ]),
      transformFields,
    });
    frame();
    const { record } = frame();
    // The point of the type with a scale field is drawn at once; the other one with its picture
    expect(record.map((entry) => [entry.kind, entry.from, entry.to])).toEqual([
      ['rows', 0, 1],
      ['immediate', 1, 2],
      ['rows', 2, 4],
    ]);
    expect(made.map((data) => data.sprites)).toEqual([null, source]);
  });

  it('writes the state of the rows before the main pass, and nothing while drawing', () => {
    const { internals, frame, mock } = setup(interleaved(200, 12), 100);
    frame();
    frame();
    internals.states.setHidden(Int32Array.of(0, 5, 9), true);
    const before = mock.calls.length;
    const { calls } = frame();
    const all = mock.calls.slice(before);
    const drawing = new Set(calls);
    const written = all.filter((c) => !drawing.has(c) && c.name === 'texSubImage2D');
    // The texture of the state of the group of the rows, written in the pass before the main one
    expect(written.length).toBe(1);
    for (const name of ['bufferData', 'bufferSubData', 'texStorage2D', 'texSubImage2D']) {
      expect(calls.some((c) => c.name === name)).toBe(false);
    }
  });

  it('draws every row once in every frame, a row past its place from the delta', () => {
    const features = interleaved(300, 13);
    const { table, renderer, frame, internals } = setup(features, 1000);
    frame();
    frame();
    const group = table.groupAt(0);
    // A line row made longer than its place
    const row = features.findIndex((f) => f.id.startsWith('l'));
    const longer = writeRowGeometry(
      table,
      group,
      row,
      {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [0.1, 0.1],
          [0.2, 0],
          [0.3, 0.1],
        ],
      },
      planarCoordinates,
    );
    renderer.rowsWritten('layer', [
      {
        group: group.handle,
        row,
        handle: group.data.handles[row],
        what: ROW_WRITE_GEOMETRY,
        ...longer,
        keys: [],
      },
    ]);
    for (let i = 0; i < 4; i++) {
      const { record } = frame();
      expect(drawnHandles(record, table)).toEqual(visibleHandles(table));
      expect(record.some((entry) => entry.delta && entry.kind === 'rows')).toBe(true);
    }
    expect(renderer.writeStats.rebuilt).toBe(1);
    expect(internals.deltaRowCount()).toBe(1);
    expect(renderer.hasPendingWork).toBe(false);
  });

  it('draws a row written into another kind of run from the delta, every row drawn meanwhile', () => {
    const features = interleaved(200, 14);
    const { table, internals, renderer, frame } = setup(features, 1000);
    renderer.setDrawingByKind(true);
    frame();
    frame();
    const group = table.groupAt(0);
    // A solid line made dashed: by kind, it is drawn at once
    const row = features.findIndex((f) => f.id.startsWith('l'));
    const dashed = internals.styles.intern({ lineStyle: 'dashed' });
    internals.styles.retain(dashed);
    internals.styles.release(group.data.styles[row]);
    group.data.styles[row] = dashed;
    renderer.rowsWritten('layer', [
      {
        group: group.handle,
        row,
        handle: group.data.handles[row],
        what: ROW_WRITE_STYLE,
        sameShape: true,
        from: 0,
        to: 0,
        keys: [],
      },
    ]);
    let atOnce = false;
    for (let i = 0; i < 4; i++) {
      const { record } = frame();
      expect(drawnHandles(record, table)).toEqual(visibleHandles(table));
      atOnce ||= record.some((entry) => entry.delta && entry.kind === 'immediate');
    }
    expect(renderer.writeStats.reclassified).toBe(1);
    expect(internals.deltaRowCount()).toBe(1);
    expect(atOnce).toBe(true);
  });

  it('records what the chunks hold in the ledger, and releases it with them', () => {
    const { renderer, frame, ledger } = setup(interleaved(200, 11), 100);
    frame();
    frame();
    expect(ledger.snapshot().byOwner.rows).toBeGreaterThan(0);
    renderer.dispose();
    // The buffer of the corners of the strip, the empty picture and the elevation of 0 stay with
    // the renderer
    expect(ledger.snapshot().byOwner.rows).toBe(16 + 4 + 4);
  });
});

describe('the check of the classification of a row written in place', () => {
  /** A layer drawn in one draw whose writes in place reach the renderer, as the instance does */
  function written(features: Feature[]) {
    const setUp = setup(features, 1000);
    setUp.internals.onRowsWritten((layerId, writes) => setUp.renderer.rowsWritten(layerId, writes));
    return setUp;
  }

  it('draws a row from the delta when an attribute a provider of companions reads gives it one', () => {
    const features = interleaved(200, 21);
    const { internals, tables, writer, renderer, frame, deps, table } = written(features);
    const companions: string[] = [];
    deps.companions.register({
      id: 'ring',
      has: (f) => f.properties?.ring === true,
      draw: (f) => {
        companions.push(f.id);
      },
      hitTest: () => null,
      onCompanionClick: () => undefined,
    });
    frame();
    frame();
    const line = features.find((f) => f.id.startsWith('l')) as Feature;
    const handle = tables.findRow(line.id) as number;
    writer.apply({
      handles: Int32Array.of(handle),
      fields: new Map([['property:ring', [true]]]),
    });
    let atOnce = false;
    for (let i = 0; i < 4; i++) {
      const { record, immediate } = frame();
      expect(drawnHandles(record, table)).toEqual(visibleHandles(table));
      atOnce ||= immediate.includes(line.id);
    }
    // Not written into its place in the chunk: drawn at once from the delta, with its companion
    expect(renderer.writeStats.reclassified).toBe(1);
    expect(renderer.writeStats.inPlace).toBe(0);
    expect(internals.deltaRowCount()).toBe(1);
    expect(atOnce).toBe(true);
    expect(companions).toContain(line.id);
  });

  it('classifies a row again on a write of a key a provider of companions declares it reads, and only then', () => {
    const features = interleaved(200, 24);
    const { internals, tables, writer, renderer, frame, deps, table } = written(features);
    const asked: number[] = [];
    deps.companions.register({
      id: 'ring',
      has: (f) => f.properties?.ring === true,
      hasRow: (view, handle) => {
        asked.push(handle);
        return view.getRowValue(handle, 'ring') === true;
      },
      classifyKeys: ['ring'],
      draw: () => {},
      hitTest: () => null,
      onCompanionClick: () => undefined,
    });
    frame();
    frame();
    const line = features.find((f) => f.id.startsWith('l')) as Feature;
    const handle = tables.findRow(line.id) as number;
    asked.length = 0;
    // A key it does not read: the row keeps its classification, the provider is not asked
    writer.apply({ handles: Int32Array.of(handle), fields: new Map([['property:name', ['n']]]) });
    for (let i = 0; i < 2; i++) {
      const { record } = frame();
      expect(drawnHandles(record, table)).toEqual(visibleHandles(table));
    }
    expect(asked).toEqual([]);
    expect(renderer.writeStats.reclassified).toBe(0);
    expect(internals.deltaRowCount()).toBe(0);
    // The key it reads: classified again, drawn at once from the delta with its companion
    writer.apply({ handles: Int32Array.of(handle), fields: new Map([['property:ring', [true]]]) });
    let atOnce = false;
    for (let i = 0; i < 4; i++) {
      const { record, immediate } = frame();
      expect(drawnHandles(record, table)).toEqual(visibleHandles(table));
      atOnce ||= immediate.includes(line.id);
    }
    expect(asked).toContain(handle);
    expect(renderer.writeStats.reclassified).toBe(1);
    expect(internals.deltaRowCount()).toBe(1);
    expect(atOnce).toBe(true);
  });

  it('classifies a row again on any write of its attributes while a provider of companions tells no keys', () => {
    const features = interleaved(200, 25);
    const { tables, writer, renderer, frame, deps } = written(features);
    const asked: number[] = [];
    deps.companions.register({
      id: 'ring',
      has: (f) => f.properties?.ring === true,
      hasRow: (view, handle) => {
        asked.push(handle);
        return view.getRowValue(handle, 'ring') === true;
      },
      draw: () => {},
      hitTest: () => null,
      onCompanionClick: () => undefined,
    });
    frame();
    frame();
    const line = features.find((f) => f.id.startsWith('l')) as Feature;
    const handle = tables.findRow(line.id) as number;
    asked.length = 0;
    writer.apply({ handles: Int32Array.of(handle), fields: new Map([['property:name', ['n']]]) });
    frame();
    expect(asked).toContain(handle);
    expect(renderer.writeStats.reclassified).toBe(0);
  });

  it('writes in place an attribute nothing classifies by, and a row only hidden or shown', () => {
    const features = interleaved(200, 22);
    const { internals, tables, writer, renderer, frame, table } = written(features);
    frame();
    frame();
    const polygon = features.find((f) => f.id.startsWith('g')) as Feature;
    const handle = tables.findRow(polygon.id) as number;
    writer.apply({
      handles: Int32Array.of(handle),
      fields: new Map<RowField, unknown[]>([
        ['property:name', ['a name']],
        ['visible', [false]],
      ]),
    });
    for (let i = 0; i < 2; i++) {
      const { record } = frame();
      expect(drawnHandles(record, table)).toEqual(visibleHandles(table));
    }
    expect(renderer.writeStats.reclassified).toBe(0);
    expect(internals.deltaRowCount()).toBe(0);
    expect(visibleHandles(table)).not.toContain(handle);
  });

  it('draws a row from the delta when a renderer of its type takes it after a write', () => {
    const features = [
      ...interleaved(100, 23),
      feature('c0', 'Point', [1, 1]),
      feature('c1', 'Point', [2, 2]),
    ];
    const drawn: string[] = [];
    const customRenderers = new Map<string, unknown>([
      [
        'Point',
        {
          type: 'Point',
          appliesTo: (f: Feature) => f.properties?.custom === true,
          draw: (f: Feature) => {
            drawn.push(f.id);
          },
        },
      ],
    ]);
    const setUp = setup(features, 1000, { customRenderers });
    setUp.internals.onRowsWritten((layerId, writes) => setUp.renderer.rowsWritten(layerId, writes));
    const { tables, writer, renderer, frame, table } = setUp;
    frame();
    frame();
    writer.apply({
      handles: Int32Array.of(tables.findRow('c1') as number),
      fields: new Map([['property:custom', [true]]]),
    });
    for (let i = 0; i < 3; i++) {
      const { record } = frame();
      expect(drawnHandles(record, table)).toEqual(visibleHandles(table));
    }
    expect(renderer.writeStats.reclassified).toBe(1);
    expect(setUp.internals.deltaRowCount()).toBe(1);
  });
});

describe('the rows drawn at once out of view', () => {
  /** The box of the view of the tests */
  const VIEW = { minX: 0, minY: 0, maxX: 1, maxY: 1 };

  /**
   * Images (drawn at once) scattered over the layer in its order, `inView` of them in the view
   * and the others far from it, each with a companion
   */
  function scattered(count: number, inView: number, seed: number) {
    const random = seededRandom(seed);
    const at = new Set<number>();
    while (at.size < inView) at.add(Math.floor(random() * count));
    const features: Feature[] = [];
    for (let i = 0; i < count; i++) {
      const position = at.has(i)
        ? [0.05 + random() * 0.9, 0.05 + random() * 0.9]
        : [5 + random() * 95, 5 + random() * 45];
      features.push(feature(`i${i}`, 'Image', position));
    }
    // One group, so the rows are one chunk drawn at once that meets the view
    const setUp = setup(features, count);
    const companions: string[] = [];
    setUp.deps.companions.register({
      id: 'ring',
      has: () => true,
      draw: (f) => {
        companions.push(f.id);
      },
      hitTest: () => null,
      onCompanionClick: () => undefined,
    });
    const inViewIds = features.filter((_, i) => at.has(i)).map((f) => f.id);
    return { ...setUp, features, companions, inViewIds };
  }

  it('looks at the rows in view only, as many whatever the number of the rows of the layer', () => {
    const visited: number[] = [];
    for (const count of [2_000, 20_000]) {
      const { renderer, frame, companions, inViewIds } = scattered(count, 40, 31);
      // The features of the rows are kept over the first frames
      frame(VIEW);
      frame(VIEW);
      companions.length = 0;
      const { immediate } = frame(VIEW);
      // The rows in view, in their order, each with its companion
      expect(immediate).toEqual(inViewIds);
      expect(companions).toEqual(inViewIds);
      expect(renderer.atOnceStats.drawn).toBe(40);
      visited.push(renderer.atOnceStats.visited);
      // Without a view, every row
      expect(frame().immediate.length).toBe(count);
    }
    expect(visited).toEqual([40, 40]);
  });

  it('looks at no row of a chunk out of view, and draws the rows of a moving set where they are moved', () => {
    const { renderer, frame, internals, features, inViewIds } = scattered(2_000, 40, 32);
    frame(VIEW);
    frame(VIEW);
    // A view where no row is
    const { immediate } = frame({ minX: -50, minY: -50, maxX: -40, maxY: -40 });
    expect(immediate).toEqual([]);
    expect(renderer.atOnceStats.visited).toBe(0);
    // A row far away moved into the view, a row in view moved out of it
    const away = features.find((f) => !inViewIds.includes(f.id)) as Feature;
    const [ax, ay] = (away.geometry as { coordinates: number[] }).coordinates;
    const ids = internals.ids;
    internals.states.setMoving(Int32Array.of(ids.handleOf(away.id)), 1);
    internals.states.setTranslation(1, 0.5 - ax, 0.5 - ay);
    internals.states.setMoving(Int32Array.of(ids.handleOf(inViewIds[0])), 2);
    internals.states.setTranslation(2, 30, 30);
    const moved = frame(VIEW).immediate;
    expect(moved).toContain(away.id);
    expect(moved).not.toContain(inViewIds[0]);
    expect(moved.length).toBe(40);
  });

  it('draws a row written into the view, and leaves out a row written out of it', () => {
    const { renderer, frame, table, features, inViewIds } = scattered(2_000, 40, 33);
    frame(VIEW);
    frame(VIEW);
    const group = table.groupAt(0);
    const write = (id: string, position: number[]): void => {
      const row = features.findIndex((f) => f.id === id);
      const written = writeRowGeometry(
        table,
        group,
        row,
        { type: 'Point', coordinates: position },
        planarCoordinates,
      );
      renderer.rowsWritten('layer', [
        {
          group: group.handle,
          row,
          handle: group.data.handles[row],
          what: ROW_WRITE_GEOMETRY,
          ...written,
          keys: [],
        },
      ]);
    };
    const away = features.find((f) => !inViewIds.includes(f.id)) as Feature;
    write(away.id, [0.5, 0.5]);
    write(inViewIds[1], [60, 30]);
    const { immediate } = frame(VIEW);
    expect(immediate).toContain(away.id);
    expect(immediate).not.toContain(inViewIds[1]);
    expect(immediate.length).toBe(40);
  });
});
