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
import type { RenderContext } from '../../api/extension/render.js';
import type { GpuRowBuffer } from '../../api/extension/webgl.js';
import type { LayerTableView, RowField } from '../../api/tables.js';
import type { GpuRowsSource, HeldGpuRows } from '../../extension/renderers.js';
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
import {
  createSelectionExtensionRegistry,
  type SelectionExtensionRegistry,
} from '../ui/selection-ui/index.js';
import type { StoreRetainedDrawDeps } from './store-retained-immediate.js';
import {
  GPU_ROWS_IDLE_FRAMES,
  type TableDrawRecord,
  TableLayerRenderer,
} from './table-retained.js';

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
    R8UI: 0x8232,
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
    extensions?: SelectionExtensionRegistry;
    buildBudgetMs?: number;
  } = {},
) {
  const { internals, table, tables, writer } = tablesOfFeatures('layer', features, targetRows);
  const mock = recordingGL(options);
  const ledger = new GpuLedger();
  const rows = new RowsRenderer(null, mock.gl, ledger, 1, terrain);
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
    buildBudgetMs: options.buildBudgetMs ?? Number.POSITIVE_INFINITY,
    ...(options.transformFields && { transformFields: () => options.transformFields ?? null }),
    ...(options.extensions && { extensions: options.extensions }),
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

describe('the rows drawn at once by the extent of their footprint', () => {
  /** The box of the view of the tests */
  const VIEW = { minX: 0, minY: 0, maxX: 1, maxY: 1 };

  /**
   * Rows of a custom type laid on the map around their anchor, `half` degrees on each side, and
   * rows of a custom type of a size on the screen, `halfWidthPx` by `halfHeightPx`
   */
  function footprints(features: Feature[], half: number) {
    const extensions = createSelectionExtensionRegistry();
    let read = 0;
    extensions.registerBoundingBox('Board', (f) => {
      read++;
      const [x, y] = (f.geometry as { coordinates: number[] }).coordinates;
      return {
        topLeft: [x - half, y + half],
        topRight: [x + half, y + half],
        bottomRight: [x + half, y - half],
        bottomLeft: [x - half, y - half],
        center: [x, y],
      };
    });
    extensions.registerBoundingBox('Badge', (f) => {
      const [x, y] = (f.geometry as { coordinates: number[] }).coordinates;
      return {
        topLeft: [x, y],
        topRight: [x, y],
        bottomRight: [x, y],
        bottomLeft: [x, y],
        center: [x, y],
      };
    });
    extensions.registerPointFrameExtent('Badge', () => ({ halfWidth: 200, halfHeight: 100 }));
    const drawn: string[] = [];
    const draw = (f: Feature): void => {
      drawn.push(f.id);
    };
    const setUp = setup(features, features.length, {
      customRenderers: new Map<string, unknown>([
        ['Board', { name: 'Board', draw }],
        ['Badge', { name: 'Badge', draw }],
      ]),
      extensions,
    });
    return { ...setUp, drawn, reads: () => read };
  }

  it('draws a row whose anchor is out of view and whose footprint on the map meets it', () => {
    const features = [
      feature('far', 'Board', [30, 30]),
      // Its anchor 2 degrees east of the view, its footprint 3 degrees on each side
      feature('over', 'Board', [3, 0.5]),
      feature('inside', 'Board', [0.5, 0.5]),
    ];
    const { frame, drawn } = footprints(features, 3);
    frame(VIEW);
    drawn.length = 0;
    frame(VIEW);
    expect(drawn).toEqual(['over', 'inside']);
  });

  it('draws a row of a size on the screen as far as it reaches at the zoom of the frame', () => {
    // At zoom 10 a pixel is 360 / 2^19 degrees: the badge reaches about 0.154 degrees
    const features = [
      feature('near', 'Badge', [1.1, 0.5]),
      feature('beyond', 'Badge', [1.3, 0.5]),
      feature('below', 'Badge', [0.5, -0.1]),
    ];
    const { frame, drawn } = footprints(features, 0);
    frame(VIEW);
    drawn.length = 0;
    frame(VIEW);
    expect(drawn).toEqual(['near', 'below']);
  });

  it('looks at the rows in view only and reads no footprint once read, whatever the number of rows', () => {
    const visited: number[] = [];
    for (const count of [2_000, 20_000]) {
      const random = seededRandom(41);
      const at = new Set<number>();
      while (at.size < 40) at.add(Math.floor(random() * count));
      const features: Feature[] = [];
      for (let i = 0; i < count; i++) {
        // The rows in view have their anchors out of it, west of it, their footprints over it
        const position = at.has(i)
          ? [-0.3, 0.05 + random() * 0.9]
          : [5 + random() * 95, 5 + random() * 45];
        features.push(feature(`b${i}`, 'Board', position));
      }
      const { frame, drawn, renderer, reads } = footprints(features, 0.5);
      frame(VIEW);
      frame(VIEW);
      const before = reads();
      drawn.length = 0;
      frame(VIEW);
      expect(drawn).toEqual(features.filter((_, i) => at.has(i)).map((f) => f.id));
      // No footprint is read again in a frame of the same rows
      expect(reads()).toBe(before);
      visited.push(renderer.atOnceStats.visited);
    }
    expect(visited).toEqual([40, 40]);
  });

  it('reads the footprint of a row again once it is written', () => {
    const features = [feature('a', 'Board', [30, 30]), feature('b', 'Board', [40, 30])];
    const { frame, drawn, table, renderer, reads } = footprints(features, 0.5);
    frame(VIEW);
    frame(VIEW);
    const group = table.groupAt(0);
    const before = reads();
    const written = writeRowGeometry(
      table,
      group,
      1,
      { type: 'Point', coordinates: [1.2, 0.5] },
      planarCoordinates,
    );
    renderer.rowsWritten('layer', [
      {
        group: group.handle,
        row: 1,
        handle: group.data.handles[1],
        what: ROW_WRITE_GEOMETRY,
        ...written,
        keys: [],
      },
    ]);
    drawn.length = 0;
    frame(VIEW);
    expect(drawn).toEqual(['b']);
    expect(reads()).toBe(before + 1);
  });
});

describe('the rows an extension holds on the GPU', () => {
  /** The bytes a row of the tests takes */
  const ROW_BYTES = 100;
  const CONTEXT = {} as RenderContext;
  const VIEW = { minX: -1, minY: -1, maxX: 2, maxY: 2 };

  /** What one range of rows holds */
  interface Held {
    readonly rows: number[];
    readonly states: number[];
    readonly writes: Array<[number, number]>;
    /** The calls of `setStates` */
    stateCalls: number;
    released: boolean;
  }

  interface Options {
    /** The bytes every range together may hold */
    limitBytes?: number;
    /** The rows a call of `add` takes at most, before its time is up */
    rowsPerCall?: number;
    /** Whether a call of `update` holds the row as written */
    fits?: () => boolean;
    /** Whether a call of `draw` draws */
    draws?: () => boolean;
    /** Whether a call of `add` throws, once it made its buffer */
    fails?: () => boolean;
  }

  /**
   * An extension that holds rows as the contract asks: it allocates a buffer for the rows of each
   * call of `add`, records it, and never goes over its limit
   */
  function ribbons(
    gl: () => WebGL2RenderingContext,
    ledger: () => GpuLedger,
    options: Options = {},
  ) {
    const made: Held[] = [];
    const log: string[] = [];
    let usedBytes = 0;
    const source: GpuRowsSource = {
      create(_view: LayerTableView): HeldGpuRows {
        const held: Held = { rows: [], states: [], writes: [], stateCalls: 0, released: false };
        made.push(held);
        const buffers: Array<{ buffer: WebGLBuffer; bytes: number }> = [];
        const buffer: GpuRowBuffer = {
          add(rows, stopAtMilliseconds) {
            const room = Math.floor(((options.limitBytes ?? Infinity) - usedBytes) / ROW_BYTES);
            const count = Math.min(rows.length, room, options.rowsPerCall ?? Infinity);
            // Stopped by the clock, not by a refusal: it comes back past its time
            if (count === options.rowsPerCall && Number.isFinite(stopAtMilliseconds)) {
              while (performance.now() <= stopAtMilliseconds);
            }
            if (count <= 0) return 0;
            const buffer = gl().createBuffer();
            const bytes = count * ROW_BYTES;
            ledger().record(buffer, 'ribbons', 'buffer', bytes);
            buffers.push({ buffer, bytes });
            usedBytes += bytes;
            if (options.fails?.()) throw new Error('no memory');
            held.rows.push(...rows.subarray(0, count));
            return count;
          },
          update(index, row) {
            held.writes.push([index, row]);
            return options.fits?.() ?? true;
          },
          setStates(from, states) {
            held.stateCalls++;
            for (let i = 0; i < states.length; i++) held.states[from + i] = states[i];
          },
          render(from, to, ctx) {
            expect(ctx).toBe(CONTEXT);
            if (options.draws && !options.draws()) return false;
            log.push(`held ${made.indexOf(held)} ${from}-${to}`);
            return true;
          },
        };
        return {
          buffer,
          release() {
            expect(held.released).toBe(false);
            held.released = true;
            for (const { buffer, bytes } of buffers) {
              ledger().release(buffer);
              usedBytes -= bytes;
            }
          },
        };
      },
    };
    const type = (name: string, of: GpuRowsSource = source) => ({
      name,
      draw: (f: Feature) => log.push(`one ${f.id}`),
      gpuRows: of,
      gpuRowsContext: () => CONTEXT,
    });
    return { source, made, log, type, used: () => usedBytes };
  }

  /** A layer of rows held by an extension: `Ribbon` and `Sticker` give the same source */
  function layer(features: Feature[], options: Options & { buildBudgetMs?: number } = {}) {
    let gl: WebGL2RenderingContext | null = null;
    let ledger: GpuLedger | null = null;
    const held = ribbons(
      () => gl as WebGL2RenderingContext,
      () => ledger as GpuLedger,
      options,
    );
    const customRenderers = new Map<string, unknown>([
      ['Ribbon', held.type('Ribbon')],
      ['Sticker', held.type('Sticker')],
    ]);
    const setUp = setup(features, 100_000, {
      customRenderers,
      ...(options.buildBudgetMs !== undefined && { buildBudgetMs: options.buildBudgetMs }),
    });
    gl = setUp.mock.gl;
    ledger = setUp.ledger;
    setUp.internals.onRowsWritten((layerId, writes) => setUp.renderer.rowsWritten(layerId, writes));
    /** The bytes of the extension the ledger holds */
    const heldBytes = (): number => setUp.ledger.snapshot().byOwner.ribbons ?? 0;
    return { ...setUp, ...held, customRenderers, heldBytes };
  }

  function ribbonRows(count: number, type = 'Ribbon'): Feature[] {
    return Array.from({ length: count }, (_, i) => feature(`r${i}`, type, [i * 0.001, 0]));
  }

  const dashed = (id: string): Feature =>
    feature(
      id,
      'LineString',
      [
        [0, 0],
        [1, 1],
      ],
      { style: { lineStyle: 'dashed' } },
    );

  const ranges = (record: TableDrawRecord[]): Array<[string, number, number]> =>
    record.map((entry) => [entry.kind, entry.from, entry.to]);

  it('gives the rows once and draws them in one call, between the rows drawn otherwise', () => {
    const features = [
      feature('p', 'Point', [0, 0]),
      feature('a', 'Ribbon', [0, 0]),
      feature('b', 'Sticker', [0.1, 0]),
      feature('c', 'Ribbon', [0.2, 0]),
      dashed('d'),
      feature('e', 'Ribbon', [0.3, 0]),
    ];
    const { frame, made, log, table, tables } = layer(features);
    frame();
    log.length = 0;
    const { record } = frame();
    expect(ranges(record)).toEqual([
      ['rows', 0, 1],
      ['extension', 1, 4],
      ['rows', 4, 5],
      ['extension', 5, 6],
    ]);
    expect(drawnHandles(record, table)).toEqual(visibleHandles(table));
    // Rows of two types that give the same source are one range, whatever their order
    expect(made.map((held) => held.rows)).toEqual([
      ['a', 'b', 'c'].map((id) => tables.findRow(id)),
      [tables.findRow('e')],
    ]);
    expect(log).toEqual(['held 0 0-3', 'held 1 0-1']);
    // Every row was given once, with its state
    expect(made.map((held) => held.states)).toEqual([[0, 0, 0], [0]]);
  });

  it('cuts a range where another source holds the rows', () => {
    const features = [feature('a', 'Ribbon', [0, 0]), feature('b', 'Other', [0.1, 0])];
    const { frame, customRenderers, type, made } = layer(features);
    const other = ribbons(
      () => ({ createBuffer: () => ({}) }) as never,
      () => new GpuLedger(),
    );
    customRenderers.set('Other', type('Other', other.source));
    frame();
    const { record } = frame();
    expect(ranges(record)).toEqual([
      ['extension', 0, 1],
      ['extension', 1, 2],
    ]);
    expect(made).toHaveLength(1);
    expect(other.made).toHaveLength(1);
  });

  it('draws a row with a companion from its feature, in its place', () => {
    const features = ribbonRows(3);
    const { frame, deps, log, made } = layer(features);
    deps.companions.register({
      id: 'ring',
      has: (f) => f.id === 'r1',
      draw: () => {},
      hitTest: () => null,
      onCompanionClick: () => undefined,
    });
    frame();
    log.length = 0;
    const { record } = frame();
    expect(ranges(record)).toEqual([
      ['extension', 0, 1],
      ['immediate', 1, 2],
      ['extension', 2, 3],
    ]);
    expect(log).toEqual(['held 0 0-1', 'one r1', 'held 1 0-1']);
    expect(made).toHaveLength(2);
  });

  it('draws by the features while the drawing in one draw is not there, and makes nothing', () => {
    const { frame, made, log, renderer, heldBytes } = layer(ribbonRows(3));
    renderer.setDrawingByKind(true);
    frame();
    log.length = 0;
    const { record } = frame();
    expect(ranges(record)).toEqual([['immediate', 0, 3]]);
    expect(log).toEqual(['one r0', 'one r1', 'one r2']);
    expect(made).toEqual([]);
    expect(heldBytes()).toBe(0);
  });

  it('does no work for each row in a frame: the calls are the same for 1,000 rows and 10,000', () => {
    const steady = (count: number) => {
      const { frame, made, log, renderer } = layer(ribbonRows(count));
      frame();
      frame();
      log.length = 0;
      const at = made[0].rows.length;
      const states = made[0].states.length;
      const { calls, record, immediate } = frame();
      expect(made).toHaveLength(1);
      expect(made[0].rows.length).toBe(at);
      expect(made[0].states.length).toBe(states);
      expect(immediate).toEqual([]);
      expect(renderer.atOnceStats.visited).toBe(0);
      expect(renderer.hasPendingWork).toBe(false);
      return { calls: calls.length, drawn: log, ranges: record.length, rows: at };
    };
    const small = steady(1_000);
    const large = steady(10_000);
    expect(small.rows).toBe(1_000);
    expect(large.rows).toBe(10_000);
    expect(large.calls).toBe(small.calls);
    expect(large.ranges).toBe(1);
    expect(large.drawn).toEqual(['held 0 0-10000']);
    expect(small.drawn).toEqual(['held 0 0-1000']);
  });

  it('gives the rows within the budget, and draws the rows it does not hold yet from their features', () => {
    const { frame, made, log, renderer, table } = layer(ribbonRows(10), {
      rowsPerCall: 3,
      buildBudgetMs: 0,
    });
    // The first step of the frame reads the extents
    expect(ranges(frame().record)).toEqual([['immediate', 0, 10]]);
    const taken: number[] = [];
    for (let i = 0; i < 4; i++) {
      log.length = 0;
      const { record } = frame();
      taken.push(made[0].rows.length);
      expect(drawnHandles(record, table)).toEqual(visibleHandles(table));
      if (i === 0) {
        expect(ranges(record)).toEqual([
          ['extension', 0, 3],
          ['immediate', 3, 10],
        ]);
        expect(log[0]).toBe('held 0 0-3');
        expect(log[1]).toBe('one r3');
      }
      expect(renderer.hasPendingWork).toBe(i < 3);
    }
    expect(taken).toEqual([3, 6, 9, 10]);
    expect(made).toHaveLength(1);
  });

  it('gives the frame of the writes the rows as written, also out of view', () => {
    const features = ribbonRows(3);
    const { frame, made, tables, writer, log } = layer(features);
    frame();
    const handle = tables.findRow('r1') as number;
    writer.apply({ handles: Int32Array.of(handle), fields: new Map([['property:name', ['n']]]) });
    log.length = 0;
    frame({ minX: 50, minY: 50, maxX: 51, maxY: 51 });
    expect(log).toEqual([]);
    expect(made[0].writes).toEqual([[1, handle]]);
    writer.apply({
      handles: Int32Array.of(handle),
      fields: new Map([['style', [{ strokeColor: '#00ff00' }]]]),
    });
    frame();
    expect(made[0].writes[1]).toEqual([1, handle]);
    expect(made).toHaveLength(1);
  });

  it('draws a row it cannot hold as written from the delta, in its place between two calls', () => {
    const { frame, made, tables, writer, log, internals, table } = layer(ribbonRows(4), {
      fits: () => false,
    });
    frame();
    writer.apply({
      handles: Int32Array.of(tables.findRow('r1') as number),
      fields: new Map([['property:name', ['n']]]),
    });
    log.length = 0;
    const { record } = frame();
    expect(internals.deltaRowCount()).toBe(1);
    expect(drawnHandles(record, table)).toEqual(visibleHandles(table));
    // The row hidden in its range, and the row of the delta held by a range of its own
    expect(made[0].states).toEqual([0, 1, 0, 0].map((hidden, i) => made[0].states[i] | hidden));
    expect(made[1].rows).toEqual([tables.findRow('r1')]);
    expect(log).toEqual(['held 0 0-2', 'held 1 0-1', 'held 0 2-4']);
  });

  it('takes a row its renderer stops taking out of its range, and draws it in its place', () => {
    const features = ribbonRows(3);
    const { frame, made, tables, writer, deps, log, table, internals } = layer(features);
    deps.companions.register({
      id: 'ring',
      has: (f) => f.properties?.ring === true,
      hasRow: (view, handle) => view.getRowValue(handle, 'ring') === true,
      classifyKeys: ['ring'],
      draw: () => {},
      hitTest: () => null,
      onCompanionClick: () => undefined,
    });
    frame();
    writer.apply({
      handles: Int32Array.of(tables.findRow('r1') as number),
      fields: new Map([['property:ring', [true]]]),
    });
    log.length = 0;
    const { record } = frame();
    expect(internals.deltaRowCount()).toBe(1);
    expect(drawnHandles(record, table)).toEqual(visibleHandles(table));
    // The row hidden in its range comes before the place of its row of the delta
    expect(log).toEqual(['held 0 0-2', 'one r1', 'held 0 2-3']);
    expect(made).toHaveLength(1);
  });

  it('gives the state of the rows when it changes, and not in the frames after', () => {
    const { frame, made, internals, tables } = layer(ribbonRows(3));
    frame();
    expect(made[0].stateCalls).toBe(1);
    internals.states.setHidden(Int32Array.of(tables.findRow('r2') as number), true);
    frame();
    expect(made[0].states[2] & 1).toBe(1);
    expect(made[0].states[0] & 1).toBe(0);
    expect(made[0].stateCalls).toBe(2);
    frame();
    frame();
    expect(made[0].stateCalls).toBe(2);
    internals.states.setMoving(Int32Array.of(tables.findRow('r0') as number), 2);
    frame();
    expect(made[0].states[0]).not.toBe(0);
    expect(made[0].stateCalls).toBe(3);
  });

  it('draws a chunk out of view that a moving set brings into it', () => {
    const features = [feature('a', 'Ribbon', [10, 10])];
    const { frame, log, internals, tables } = layer(features);
    frame();
    log.length = 0;
    frame(VIEW);
    expect(log).toEqual([]);
    internals.states.setMoving(Int32Array.of(tables.findRow('a') as number), 2);
    internals.states.setTranslation(2, -10, -10);
    frame(VIEW);
    expect(log).toEqual(['held 0 0-1']);
  });

  it('gives no rows to a chunk out of view, and gives them once it comes into view', () => {
    const { frame, made, heldBytes, log } = layer([feature('a', 'Ribbon', [10, 10])]);
    frame(VIEW);
    frame(VIEW);
    expect(made).toEqual([]);
    expect(heldBytes()).toBe(0);
    frame({ minX: 9, minY: 9, maxX: 11, maxY: 11 });
    expect(heldBytes()).toBe(ROW_BYTES);
    expect(log).toEqual(['held 0 0-1']);
  });

  it('reads the extents of the rows within the budget, not in one frame', () => {
    const extensions = createSelectionExtensionRegistry();
    let read = 0;
    extensions.registerBoundingBox('Ribbon', (f) => {
      read++;
      const [x, y] = (f.geometry as { coordinates: number[] }).coordinates;
      return {
        topLeft: [x - 1, y + 1],
        topRight: [x + 1, y + 1],
        bottomRight: [x + 1, y - 1],
        bottomLeft: [x - 1, y - 1],
        center: [x, y],
      };
    });
    const held = ribbons(
      () => mockGl,
      () => setUp.ledger,
    );
    const setUp = setup(ribbonRows(2_000), 100_000, {
      customRenderers: new Map([['Ribbon', held.type('Ribbon')]]),
      extensions,
      buildBudgetMs: 0,
    });
    const mockGl = setUp.mock.gl;
    const reads: number[] = [];
    for (let i = 0; i < 5; i++) {
      const before = read;
      setUp.frame(VIEW);
      reads.push(read - before);
    }
    // The first frame goes to the slices of the extents, one for each frame while its budget lasts
    expect(Math.max(...reads)).toBeLessThanOrEqual(512);
    expect(read).toBe(2_000);
  });

  describe('at its limit', () => {
    it('holds up to the limit exactly, and draws nothing else of them from their features', () => {
      const { frame, made, log, heldBytes, renderer } = layer(ribbonRows(5), {
        limitBytes: 5 * ROW_BYTES,
      });
      frame();
      log.length = 0;
      const { record } = frame();
      expect(ranges(record)).toEqual([['extension', 0, 5]]);
      expect(heldBytes()).toBe(5 * ROW_BYTES);
      expect(made[0].rows).toHaveLength(5);
      expect(renderer.hasPendingWork).toBe(false);
    });

    it('draws the row past the limit from its feature, in its place, and asks for no more frames', () => {
      const { frame, made, log, heldBytes, renderer, table } = layer(ribbonRows(5), {
        limitBytes: 4 * ROW_BYTES,
      });
      frame();
      expect(renderer.hasPendingWork).toBe(false);
      for (let i = 0; i < 3; i++) {
        log.length = 0;
        const { record } = frame();
        expect(ranges(record)).toEqual([
          ['extension', 0, 4],
          ['immediate', 4, 5],
        ]);
        expect(log).toEqual(['held 0 0-4', 'one r4']);
        expect(drawnHandles(record, table)).toEqual(visibleHandles(table));
        expect(heldBytes()).toBe(4 * ROW_BYTES);
        expect(renderer.hasPendingWork).toBe(false);
      }
      expect(made).toHaveLength(1);
    });

    it('draws every row from its feature when it refuses the first one', () => {
      const { frame, log, heldBytes, renderer } = layer(ribbonRows(3), { limitBytes: 0 });
      frame();
      log.length = 0;
      const { record } = frame();
      expect(ranges(record)).toEqual([['immediate', 0, 3]]);
      expect(log).toEqual(['one r0', 'one r1', 'one r2']);
      expect(heldBytes()).toBe(0);
      expect(renderer.hasPendingWork).toBe(false);
    });

    it('asks a refusal again only once something was released', () => {
      const features = [...ribbonRows(2), dashed('d'), feature('z', 'Ribbon', [0, 0])];
      const { frame, made, internals, tables } = layer(features, { limitBytes: 2 * ROW_BYTES });
      frame();
      frame();
      expect(made.map((held) => held.rows.length)).toEqual([2, 0]);
      // The rows of the first chunk hidden: released, and the room goes to the other
      internals.states.setHidden(
        Int32Array.from(['r0', 'r1'].map((id) => tables.findRow(id) as number)),
        true,
      );
      frame();
      frame();
      expect(made[0].released).toBe(true);
      expect(made[1].rows).toEqual([tables.findRow('z')]);
    });

    it('releases what was not in view for the longest for the rows in view, and only then', () => {
      const far = feature('far', 'Ribbon', [100, 50]);
      const older = feature('older', 'Ribbon', [100, 60]);
      const features = [far, dashed('d1'), older, dashed('d2'), feature('near', 'Ribbon', [0, 0])];
      const { frame, made, heldBytes, tables, renderer } = layer(features, {
        limitBytes: 2 * ROW_BYTES,
      });
      const near = { minX: -1, minY: -1, maxX: 1, maxY: 1 };
      frame({ minX: 99, minY: 49, maxX: 101, maxY: 61 });
      expect(heldBytes()).toBe(2 * ROW_BYTES);
      // The chunk in view is refused: nothing is idle for long enough yet
      for (let i = 0; i < GPU_ROWS_IDLE_FRAMES - 2; i++) frame(near);
      expect(made.some((held) => held.released)).toBe(false);
      expect(renderer.hasPendingWork).toBe(false);
      for (let i = 0; i < 70; i++) frame(near);
      const released = made.filter((held) => held.released);
      expect(released).toHaveLength(1);
      expect(heldBytes()).toBe(2 * ROW_BYTES);
      expect(made[made.length - 1].rows).toEqual([tables.findRow('near')]);
    });

    it('survives a failed allocation told after it took rows: the rows are drawn from their features', () => {
      let failed = false;
      const { frame, log, renderer, table } = layer(ribbonRows(3), { draws: () => !failed });
      frame();
      failed = true;
      log.length = 0;
      const { record } = frame();
      expect(ranges(record)).toEqual([['immediate', 0, 3]]);
      expect(log).toEqual(['one r0', 'one r1', 'one r2']);
      expect(drawnHandles(record, table)).toEqual(visibleHandles(table));
      expect(renderer.hasPendingWork).toBe(false);
    });

    it('keeps the features of the rows it does not draw, up to the limit, as for the rows drawn at once', () => {
      let draws = true;
      const { frame, renderer, log } = layer(ribbonRows(3), { draws: () => draws });
      frame();
      frame();
      expect(renderer.atOnceStats.visited).toBe(0);
      draws = false;
      log.length = 0;
      frame();
      expect(log).toEqual(['one r0', 'one r1', 'one r2']);
      expect(renderer.checkCopies()).toEqual([]);
    });
  });

  describe('what it holds goes back', () => {
    it('when taking rows fails: the range is released, and its rows are drawn one by one', () => {
      const { frame, made, heldBytes, ledger } = layer(ribbonRows(2), { fails: () => true });
      expect(() => frame()).toThrow('no memory');
      expect(made[0].released).toBe(true);
      expect(heldBytes()).toBe(0);
      expect(ledger.audit()).toBe(true);
      expect(() => frame()).not.toThrow();
    });

    it('when the rows of a chunk are all hidden, and comes back when one is shown', () => {
      const { frame, made, heldBytes, internals, tables, log } = layer(ribbonRows(2));
      frame();
      expect(heldBytes()).toBe(2 * ROW_BYTES);
      const handles = Int32Array.from(['r0', 'r1'].map((id) => tables.findRow(id) as number));
      internals.states.setHidden(handles, true);
      log.length = 0;
      frame();
      expect(heldBytes()).toBe(0);
      expect(made[0].released).toBe(true);
      expect(log).toEqual([]);
      internals.states.setHidden(handles, false);
      frame();
      frame();
      expect(heldBytes()).toBe(2 * ROW_BYTES);
      expect(made).toHaveLength(2);
    });

    it('when a layer is not drawn any more, and comes back when it is drawn', () => {
      const { renderer, frame, made, heldBytes } = layer(ribbonRows(2));
      frame();
      expect(heldBytes()).toBe(2 * ROW_BYTES);
      // A frame that draws other layers only
      renderer.prerender();
      beginRenderFrame();
      renderer.beginFrame();
      renderer.endFrame();
      expect(heldBytes()).toBe(0);
      expect(made[0].released).toBe(true);
      frame();
      expect(heldBytes()).toBe(2 * ROW_BYTES);
    });

    it('when the rows of a layer leave the tables', () => {
      const { frame, heldBytes, writer, renderer, made } = layer(ribbonRows(2));
      frame();
      writer.clear();
      renderer.prerender();
      expect(heldBytes()).toBe(0);
      expect(made[0].released).toBe(true);
    });

    it('when the instance is destroyed or the context lost, once for each range', () => {
      const features = [...ribbonRows(2), dashed('d'), feature('z', 'Sticker', [0, 0])];
      const { frame, heldBytes, renderer, deps, made } = layer(features);
      frame();
      expect(heldBytes()).toBe(3 * ROW_BYTES);
      renderer.dispose(deps.renderers);
      expect(heldBytes()).toBe(0);
      expect(made.every((held) => held.released)).toBe(true);
    });

    it('when the rows of a delta are packed again', () => {
      const { frame, heldBytes, tables, writer, made } = layer(ribbonRows(4), {
        fits: () => false,
      });
      frame();
      const handle = tables.findRow('r1') as number;
      const write = (value: string) =>
        writer.apply({
          handles: Int32Array.of(handle),
          fields: new Map([['property:name', [value]]]),
        });
      write('a');
      frame();
      const held = heldBytes();
      write('b');
      frame();
      write('c');
      frame();
      expect(heldBytes()).toBe(held);
      expect(made.filter((range) => !range.released)).toHaveLength(2);
    });

    it('when a style rule changes: the rows are given again, and never held twice', () => {
      const { frame, heldBytes, made, deps, internals, table, renderer, ledger } = layer(
        ribbonRows(3),
      );
      frame();
      const ruled: Layer = {
        ...LAYER,
        styleRule: {
          kind: 'categorical',
          property: 'class',
          map: { a: '#ff0000' },
          other: '#00ff00',
        },
      };
      renderer.prerender();
      beginRenderFrame();
      renderer.beginFrame();
      renderer.drawLayer(
        internals,
        table,
        ruled,
        { projectionData: PROJECTION, zoom: 10, bounds: undefined },
        deps,
      );
      renderer.endFrame();
      expect(made).toHaveLength(2);
      expect(made[0].released).toBe(true);
      expect(heldBytes()).toBe(3 * ROW_BYTES);
      expect(ledger.snapshot().peakBytes).toBeLessThan(6 * ROW_BYTES);
    });

    it('when its renderer changes: what the source of before holds is released', () => {
      const { frame, renderer, customRenderers, type, made, heldBytes } = layer(ribbonRows(2));
      frame();
      const other = ribbons(
        () => ({ createBuffer: () => ({}) }) as never,
        () => new GpuLedger(),
      );
      customRenderers.set('Ribbon', type('Ribbon', other.source));
      renderer.reclassify();
      frame();
      frame();
      frame();
      expect(made[0].released).toBe(true);
      expect(heldBytes()).toBe(0);
      expect(other.made[0].rows).toHaveLength(2);
    });
  });

  it('passes the checks of what is drawn against the rows', () => {
    const features = [...ribbonRows(3), dashed('d'), feature('z', 'Sticker', [0, 0])];
    const { frame, renderer } = layer(features);
    frame();
    frame();
    expect(renderer.checkCopies()).toEqual([]);
    expect(renderer.checkRebuild()).toEqual([]);
  });
});
