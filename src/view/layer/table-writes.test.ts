// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The writes in place of the rows drawn in one draw, read back from what the GPU holds
 *
 * After each write, the instances, the coordinates and the styles the chunk holds on the GPU
 * are, row by row, the ones of a chunk built from the rows as written (the instances of a place
 * a row no longer fills draw nothing):
 *
 * - a corner of a building moved, a point moved, the center of a Circle moved and its radius
 *   changed: by the coordinates only
 * - a color changed: by the style only
 * - a vertex taken off, one put back within the place, a dashed line moved, a line made dashed,
 *   an outline taken off: the row packed again into its place
 * - a vertex past the place, an outline put on: the chunk built again
 */

import type { Geometry } from 'geojson';
import type { ProjectionData } from 'maplibre-gl';
import { beforeEach, describe, expect, it } from 'vitest';
import { refreshRowShape, writeRowGeometry, writeRowValue } from '../../feature-table/row-write.js';
import {
  ROW_WRITE_GEOMETRY,
  ROW_WRITE_STYLE,
  ROW_WRITE_VALUES,
  type RowWrite,
} from '../../feature-table/types.js';
import { drawPropertyKey } from '../../shared/properties.js';
import type { Feature, FeatureStyle, Layer } from '../../shared/types/model.js';
import { createTestDrawer, feature, memoryGL, tablesOfFeatures } from '../../test-utils.js';
import { createFeatureCompanionRegistry } from '../feature-companion.js';
import { retainedDrawRun } from '../renderers/draw-run.js';
import type { RetainedRendererSet } from '../renderers/retained.js';
import {
  ROWS_INSTANCE_FLOATS,
  ROWS_KIND,
  ROWS_STYLE_FLOATS,
  readRowsInstance,
} from '../renderers/rows/rows-format.js';
import { type RowsChunk, RowsRenderer } from '../renderers/rows/rows-renderer.js';
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

const RADIUS = drawPropertyKey('radiusMeters');

let terrain: TerrainContext;
beforeEach(() => {
  terrain = new TerrainContext();
});

/** How a scene is drawn */
interface DrawnOptions {
  /** The layer (its style rule) */
  readonly layer?: Layer;
  /** The time the builds take per frame (unbounded when omitted) */
  readonly budgetMs?: number;
  /** The rows of a row group */
  readonly targetRows?: number;
  /** The rendering pixel ratio, read every frame */
  readonly pixelRatio?: () => number;
}

/** The tables of features drawn in one draw on a context that keeps what the GPU holds */
function drawn(features: readonly Feature[], options: DrawnOptions = {}) {
  const tables = tablesOfFeatures('layer', features, options.targetRows);
  const view = { layer: options.layer ?? LAYER };
  const mock = memoryGL();
  const rows = new RowsRenderer(null, mock.gl, 1, terrain);
  rows.ensureShader({ vertexShaderPrelude: '', define: '', variantName: 'mercator' });
  const made: RowsChunk[] = [];
  const createChunk = rows.createChunk.bind(rows);
  rows.createChunk = (data) => {
    const chunk = createChunk(data);
    made.push(chunk);
    return chunk;
  };
  const renderers = {
    point: {},
    line: {},
    polygon: {},
    styles: createTestDrawer(),
    viewport: () => [800, 600],
    run: retainedDrawRun(mock.gl),
    rows,
  } as unknown as RetainedRendererSet;
  const deps: StoreRetainedDrawDeps = {
    renderers,
    batchManager: { beginFrame: () => {}, processFeature: () => true, endFrame: () => {} },
    customRenderers: new Map() as never,
    customRendererContext: {} as never,
    companions: createFeatureCompanionRegistry(),
  };
  const renderer = new TableLayerRenderer({
    gl: mock.gl,
    terrain,
    requestRepaint: () => {},
    buildBudgetMs: options.budgetMs ?? Number.POSITIVE_INFINITY,
    pixelRatio: options.pixelRatio ?? 1,
  });
  /** One frame; returns the ranges drawn */
  const frame = (): TableDrawRecord[] => {
    renderer.prerender();
    beginRenderFrame();
    renderer.beginFrame();
    const record: TableDrawRecord[] = [];
    renderer.recordDraws(record);
    renderer.drawLayer(
      tables.internals,
      tables.table,
      view.layer,
      { projectionData: PROJECTION, zoom: 10, bounds: undefined },
      deps,
    );
    renderer.recordDraws(null);
    renderer.endFrame();
    return record;
  };
  /** Frames until everything is built and written, and one more */
  const settle = (): void => {
    for (let i = 0; i < 20; i++) {
      frame();
      if (!renderer.hasPendingWork) break;
    }
    frame();
  };
  settle();
  /** The rows the chunks hold on the GPU, in their order */
  const read = (): ReadRow[] =>
    made
      .filter((chunk) => chunk.uploaded && !chunk.disposed)
      .sort((a, b) => a.data.rowBase - b.data.rowBase)
      .flatMap((chunk) => readChunk(mock, chunk));
  return { ...tables, renderer, frame, settle, read, made, view, deps, mock, rows };
}

/** A row as a chunk holds it on the GPU */
interface ReadRow {
  readonly row: number;
  readonly instances: unknown[];
  readonly points: unknown[];
  readonly style: { values: number[]; createdZoom: number | null } | null;
}

/** The rows of a chunk as the GPU holds them, the instances that draw nothing left out */
function readChunk(mock: ReturnType<typeof memoryGL>, chunk: RowsChunk): ReadRow[] {
  const data = chunk.data;
  const instances = mock.buffers.get(chunk.instanceBuffer as object) as Float32Array;
  const points = chunk.pointBuffer
    ? (mock.buffers.get(chunk.pointBuffer) as Float32Array)
    : new Float32Array(0);
  const coords = mock.textures.get(chunk.coords?.texture as object);
  const rowStyles = mock.textures.get(chunk.rowStyles?.texture as object);
  const palette = mock.textures.get(data.palette.gpu?.texture as object);
  if (!coords || !rowStyles || !palette) throw new Error('the chunk is not on the GPU');
  const position = (index: number): number[] | null =>
    index < 0
      ? null
      : [
          round(coords.data[index * 2] + data.origin[0]),
          round(coords.data[index * 2 + 1] + data.origin[1]),
        ];
  const list = (source: Float32Array, from: number, to: number): unknown[] => {
    const out: unknown[] = [];
    for (let i = from; i < to; i++) {
      const instance = readRowsInstance(source, i);
      const [a, b, c, d] = instance.indices;
      if (instance.kind === ROWS_KIND.fill && a === b && b === c && c === d) continue;
      out.push({
        kind: instance.kind,
        row: instance.row,
        at: instance.indices.map(position),
        t: [instance.t0, instance.t1],
        extra: round(instance.extra),
      });
    }
    return out;
  };
  const out: ReadRow[] = [];
  for (let r = 0; r < data.rows; r++) {
    const drawnInstances = list(instances, data.rowFirst[r], data.rowFirst[r + 1]);
    const style = rowStyles.data.subarray(r * 4, r * 4 + 4);
    const n = style[0];
    out.push({
      row: data.rowBase + r,
      instances: drawnInstances,
      points: list(points, data.pointFirst[r], data.pointFirst[r + 1]),
      style:
        drawnInstances.length === 0
          ? null
          : {
              values: Array.from(
                palette.data.subarray(n * ROWS_STYLE_FLOATS, (n + 1) * ROWS_STYLE_FLOATS),
              ),
              createdZoom: style[2] > 0 ? style[1] : null,
            },
    });
  }
  return out;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** A ring of `n` corners around a center, closed */
function ring(x: number, y: number, r: number, n: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
  }
  out.push(out[0]);
  return out;
}

/** The features of the scenes: a building, a point, a dashed line, a line, a Circle */
function scene(): Feature[] {
  return [
    feature('building', 'Polygon', [ring(0, 0, 0.01, 6)], {
      style: { fillColor: '#3366ff', fillOpacity: 0.5, strokeWidth: 2 },
    }),
    feature('point', 'Point', [0.02, 0.02], { style: { pointColor: '#ff0000' } }),
    feature(
      'dashed',
      'LineString',
      [
        [0, 0.03],
        [0.01, 0.031],
        [0.02, 0.03],
      ],
      { style: { lineStyle: 'dashed', strokeWidth: 3 } },
    ),
    feature('line', 'LineString', [
      [0, 0.04],
      [0.01, 0.041],
      [0.02, 0.04],
    ]),
    feature('circle', 'Circle', [0.03, 0], { properties: { [RADIUS]: 300 } }),
    feature('fill', 'Polygon', [ring(0.05, 0.05, 0.01, 5)], { style: { strokeWidth: 0 } }),
  ];
}

/** The edits of the rows of a scene: written in place, and kept in the features */
function editor(live: ReturnType<typeof drawn>, features: Feature[]) {
  const group = live.table.groupAt(0);
  const tell = (row: number, what: number, extra: Partial<RowWrite> = {}): void => {
    live.renderer.rowsWritten('layer', [
      { group: group.handle, row, what, sameShape: true, from: 0, to: 0, keys: [], ...extra },
    ]);
  };
  return {
    geometry(row: number, geometry: Geometry): void {
      const write = writeRowGeometry(live.table, group, row, geometry);
      features[row] = { ...features[row], geometry: geometry as Feature['geometry'] };
      tell(row, ROW_WRITE_GEOMETRY, write);
    },
    style(row: number, style: FeatureStyle): void {
      const styles = live.internals.styles;
      const next = styles.intern(style);
      styles.retain(next);
      styles.release(group.data.styles[row]);
      group.data.styles[row] = next;
      features[row] = { ...features[row], style };
      tell(row, ROW_WRITE_STYLE);
    },
    radius(row: number, radius: number): void {
      writeRowValue(group, row, RADIUS, radius);
      const shape = refreshRowShape(live.table, group, row);
      features[row] = {
        ...features[row],
        properties: { ...features[row].properties, [RADIUS]: radius },
      };
      tell(row, ROW_WRITE_GEOMETRY | ROW_WRITE_VALUES, {
        sameShape: shape.sameTriangles,
        from: 0,
        to: shape.ring,
        keys: [RADIUS],
      });
    },
  };
}

/** Writes, draws the frames, and checks the GPU holds what a chunk built from the rows holds */
function expectAsBuilt(live: ReturnType<typeof drawn>, features: Feature[]): void {
  live.settle();
  const built = drawn(features);
  expect(live.read()).toEqual(built.read());
}

describe('the writes in place of the rows drawn in one draw', () => {
  it('writes the positions of the rows that keep their shape, and only them', () => {
    const features = scene();
    const live = drawn(features);
    const edit = editor(live, features);
    // A corner of the building, the point, the center of the Circle and its radius
    const corners = ring(0, 0, 0.01, 6);
    corners[2] = [corners[2][0] + 0.003, corners[2][1]];
    edit.geometry(0, { type: 'Polygon', coordinates: [corners] });
    edit.geometry(1, { type: 'Point', coordinates: [0.025, 0.021] });
    edit.geometry(4, { type: 'Point', coordinates: [0.031, 0.001] });
    expectAsBuilt(live, features);
    edit.radius(4, 450);
    expectAsBuilt(live, features);
    expect(live.renderer.writeStats).toMatchObject({ coordsOnly: 4, rebuilt: 0 });
  });

  it('writes a color by the style of its row only', () => {
    const features = scene();
    const live = drawn(features);
    const edit = editor(live, features);
    edit.style(0, { fillColor: '#00ff00', fillOpacity: 0.5, strokeWidth: 2 });
    edit.style(1, { pointColor: '#00ffff' });
    edit.style(3, { strokeColor: '#123456' });
    expectAsBuilt(live, features);
    expect(live.renderer.writeStats).toMatchObject({ styleOnly: 3, rebuilt: 0 });
  });

  it('packs a row again into its place when it fits, the rest of its place drawing nothing', () => {
    const features = scene();
    const live = drawn(features);
    const edit = editor(live, features);
    // A corner of the building taken off, then put back elsewhere
    const five = ring(0, 0, 0.01, 6);
    five.splice(3, 1);
    edit.geometry(0, { type: 'Polygon', coordinates: [five] });
    expectAsBuilt(live, features);
    const six = ring(0, 0, 0.012, 6);
    edit.geometry(0, { type: 'Polygon', coordinates: [six] });
    expectAsBuilt(live, features);
    // A dashed line moved, a line made dashed, an outline taken off
    edit.geometry(2, {
      type: 'LineString',
      coordinates: [
        [0, 0.03],
        [0.012, 0.033],
        [0.02, 0.03],
      ],
    });
    edit.style(3, { lineStyle: 'dotted', strokeWidth: 2 });
    edit.style(0, { fillColor: '#3366ff', fillOpacity: 0.5, strokeWidth: 0 });
    expectAsBuilt(live, features);
    expect(live.renderer.writeStats.rebuilt).toBe(0);
    expect(live.renderer.writeStats.inPlace).toBe(5);
  });

  it('builds the chunk again for a row past its place', () => {
    const features = scene();
    const live = drawn(features);
    const edit = editor(live, features);
    // A vertex added to the line, and an outline put on the fill
    edit.geometry(3, {
      type: 'LineString',
      coordinates: [
        [0, 0.04],
        [0.005, 0.045],
        [0.01, 0.041],
        [0.02, 0.04],
      ],
    });
    edit.style(5, { strokeWidth: 3 });
    expectAsBuilt(live, features);
    expect(live.renderer.writeStats.rebuilt).toBe(2);
    // The chunk built again packs the rows as they are, and takes the next writes in place
    const corners = ring(0, 0, 0.01, 6);
    corners[0] = [0.0105, 0.0005];
    corners[6] = corners[0];
    edit.geometry(0, { type: 'Polygon', coordinates: [corners] });
    expectAsBuilt(live, features);
    expect(live.renderer.writeStats.rebuilt).toBe(2);
  });

  it('collapses the instances a row no longer fills and keeps its places', () => {
    const features = scene();
    const live = drawn(features);
    const edit = editor(live, features);
    edit.style(0, { fillColor: '#3366ff', fillOpacity: 0.5, strokeWidth: 0 });
    live.settle();
    const chunk = live.made.find((c) => c.uploaded && !c.disposed) as RowsChunk;
    const data = chunk.data;
    const instances = live.read();
    expect(instances[0].instances.length).toBeLessThan(data.rowFirst[1] - data.rowFirst[0]);
    // The places of the rows did not move
    expect(data.rowFirst[1]).toBeGreaterThan(0);
    expect(ROWS_INSTANCE_FLOATS).toBe(8);
  });
});

/** The rows a record covers, in order, as `group:row` */
function coverage(record: TableDrawRecord[]): string[] {
  const out: string[] = [];
  for (const entry of record) {
    for (let row = entry.from; row < entry.to; row++) out.push(`${entry.groupIndex}:${row}`);
  }
  return out;
}

/** Points with a value each, in groups of 8 rows */
function valued(count: number): Feature[] {
  return Array.from({ length: count }, (_, i) =>
    feature(`p${i}`, 'Point', [i * 0.001, 0], { properties: { kind: i % 3 === 0 ? 'a' : 'b' } }),
  );
}

describe('the styles resolved again', () => {
  const rule = (a: string): Layer => ({
    ...LAYER,
    styleRule: { kind: 'categorical', property: 'kind', map: { a }, other: '#996633' },
  });

  it('resolves the styles of a new style rule a group at a time, with the chunks and the palette kept', () => {
    const features = valued(40);
    const live = drawn(features, { layer: rule('#336699'), budgetMs: 0, targetRows: 8 });
    const chunks = live.made.length;
    const palette = live.made[0].data.palette;
    live.view.layer = rule('#ff0000');
    // One group a frame (a budget of one step), every row drawn in every frame
    const all = coverage(live.frame());
    expect(all.length).toBe(40);
    for (let i = 0; i < 6; i++) expect(coverage(live.frame())).toEqual(all);
    live.settle();
    expect(live.made.length).toBe(chunks);
    expect(live.made.every((chunk) => chunk.data.palette === palette)).toBe(true);
    expect(live.read()).toEqual(drawn(features, { layer: rule('#ff0000'), targetRows: 8 }).read());
    // The styles of the rule before are taken back as their rows left them
    expect(palette.size).toBe(2);
  });

  it('writes the values of the styles again for a new pixel ratio, the chunks kept', () => {
    let ratio = 1;
    const features = scene();
    const live = drawn(features, { pixelRatio: () => ratio });
    const chunks = live.made.length;
    ratio = 2;
    live.settle();
    expect(live.made.length).toBe(chunks);
    expect(live.read()).toEqual(drawn(features, { pixelRatio: () => 2 }).read());
  });

  it('keeps drawing the chunks of a group cut again until the new ones are built', () => {
    const features = scene();
    const live = drawn(features, { budgetMs: 0 });
    const all = coverage(live.frame());
    // A provider of companions for the line: it is drawn at once from now on
    live.deps.companions.register({
      id: 'test',
      has: (f: Feature) => f.id === 'line',
      draw: () => {},
    } as never);
    let cut = false;
    for (let i = 0; i < 6; i++) {
      const record = live.frame();
      expect(coverage(record)).toEqual(all);
      if (record.some((entry) => entry.kind === 'immediate')) cut = true;
    }
    expect(cut).toBe(true);
  });
});
