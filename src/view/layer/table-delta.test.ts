// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The drawing of the rows of the delta of a layer
 *
 * - The rows of the delta are drawn at their places among the rows of the groups, once each, in
 *   every frame from the frame they are written in: packed in one chunk of the layer and written
 *   to the GPU before the main pass of that frame, with their copies in their groups hidden from
 *   the same frame (a row never goes missing, and is never drawn twice)
 * - At a place within a chunk of a group, the chunk is drawn in two draws with the rows of the
 *   delta in between, a range of the chunk of the delta in one draw; the cuts are counted
 * - A row of the delta written again is written into its place in the chunk of the delta, and the
 *   chunk is packed again only when it does not fit
 * - Drawn by kind (the terrain, the globe), the rows of the delta are drawn at once at their
 *   places
 * - Writes of every kind at random over the frames: what is drawn is the rows of the layer in
 *   their order, every frame
 * - A feature drawn over a row for this client is drawn in the place of the row, which is not
 *   drawn, from the frame it is given
 * - The next versions of the groups: their chunks are built without being drawn, and they are
 *   swapped in the pass before the main one of the frame they are up in; every frame draws the
 *   rows of the layer in their order, once each
 */

import { utf8ColumnFromStrings } from '@sakuzu/tabane';
import type { Geometry } from 'geojson';
import type { ProjectionData } from 'maplibre-gl';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RowField, RowValues } from '../../api/tables.js';
import type { LayerTable } from '../../feature-table/layer-table.js';
import type { Feature, Layer } from '../../shared/types/model.js';
import {
  createTestDrawer,
  feature,
  internalsOf,
  memoryGL,
  orderKey,
  seededRandom,
  tablesOfFeatures,
} from '../../test-utils.js';
import { createFeatureCompanionRegistry } from '../feature-companion.js';
import { GpuLedger } from '../gpu-ledger.js';
import { retainedDrawRun } from '../renderers/draw-run.js';
import type { RetainedRendererSet } from '../renderers/retained.js';
import { type RowsChunk, RowsRenderer } from '../renderers/rows/rows-renderer.js';
import { beginRenderFrame } from '../shaders/frame.js';
import { TerrainContext } from '../terrain/context.js';
import { setTerrainCameraMoving } from '../terrain/state.js';
import type { StoreRetainedDrawDeps } from './store-retained-immediate.js';
import { SPLIT_BUDGET, type TableDrawRecord, TableLayerRenderer } from './table-retained.js';

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

let terrain: TerrainContext;
beforeEach(() => {
  terrain = new TerrainContext();
});

/** A patch of rows */
function patchOf(
  handles: number[],
  fields: Record<string, unknown[]>,
  deleted?: number[],
): RowValues {
  return {
    handles: Int32Array.from(handles),
    fields: new Map(Object.entries(fields) as Array<[RowField, unknown[]]>),
    deleted: deleted ? Uint8Array.from(deleted) : undefined,
  };
}

/** Features of every kind at random, an image (drawn at once) among them */
function features(count: number, seed: number): Feature[] {
  const random = seededRandom(seed);
  return Array.from({ length: count }, (_, i) => {
    const x = random() * 10;
    const y = random() * 10;
    const pick = random();
    if (pick < 0.3) return feature(`p${i}`, 'Point', [x, y]);
    if (pick < 0.55)
      return feature(`l${i}`, 'LineString', [
        [x, y],
        [x + 0.1, y + 0.1],
      ]);
    if (pick < 0.95)
      return feature(`g${i}`, 'Polygon', [
        [
          [x, y],
          [x + 0.1, y],
          [x + 0.1, y + 0.1],
          [x, y],
        ],
      ]);
    return feature(`i${i}`, 'Image', [x, y]);
  });
}

/** The tables of features drawn in one draw, the writes reaching the drawing */
function setup(list: Feature[], targetRows = 16, versions = false) {
  const tables = tablesOfFeatures('layer', list, targetRows);
  const mock = memoryGL();
  const rows = new RowsRenderer(null, mock.gl, new GpuLedger(), 1, terrain);
  rows.ensureShader({ vertexShaderPrelude: '', define: '', variantName: 'mercator' });
  const made: RowsChunk[] = [];
  const createChunk = rows.createChunk.bind(rows);
  rows.createChunk = (data) => {
    const chunk = createChunk(data);
    made.push(chunk);
    return chunk;
  };
  const kindDraws: Array<{ from: number; to: number }> = [];
  const byKind = {
    buildRetainedRows: (_a: unknown, _b: unknown, _c: unknown, rowFirst: Int32Array) =>
      ({ rowFirst }) as never,
    drawRetainedRange: (_b: unknown, from: number, to: number) => kindDraws.push({ from, to }),
    disposeRetained: () => {},
    disposeRetainedBatch: () => {},
    createRetainedRows: (_v: unknown, _i: unknown, _o: unknown, rowFirst: Int32Array) =>
      ({ rowFirst }) as never,
    writeRetainedRows: () => {},
  };
  const renderers = {
    point: byKind,
    line: byKind,
    polygon: byKind,
    styles: createTestDrawer(),
    viewport: () => [800, 600],
    run: retainedDrawRun(mock.gl),
    rows,
  } as unknown as RetainedRendererSet;
  const atOnce: string[] = [];
  const deps: StoreRetainedDrawDeps = {
    renderers,
    batchManager: {
      beginFrame: () => {},
      processFeature: (f: Feature) => {
        atOnce.push(f.id);
        return true;
      },
      endFrame: () => {},
    },
    customRenderers: new Map() as never,
    customRendererContext: {} as never,
    companions: createFeatureCompanionRegistry(),
  };
  const renderer = new TableLayerRenderer({
    ledger: new GpuLedger(),
    gl: mock.gl,
    terrain,
    requestRepaint: () => {},
    buildBudgetMs: Number.POSITIVE_INFINITY,
    pixelRatio: 1,
  });
  tables.internals.onRowsWritten((layerId, writes) => renderer.rowsWritten(layerId, writes));
  /** One frame: the pass before the main one, then the layer; returns the ranges drawn */
  const frame = (bounds?: { minX: number; minY: number; maxX: number; maxY: number }) => {
    renderer.prerender();
    beginRenderFrame();
    renderer.beginFrame();
    // The row groups taken in and the next versions advanced, as an instance does every frame
    if (versions) renderer.advanceTables(tables.internals);
    const record: TableDrawRecord[] = [];
    renderer.recordDraws(record);
    atOnce.length = 0;
    const table = tables.internals.layerTable('layer') as LayerTable;
    renderer.drawLayer(
      tables.internals,
      table,
      LAYER,
      { projectionData: PROJECTION, zoom: 10, bounds },
      deps,
    );
    renderer.recordDraws(null);
    renderer.endFrame();
    return { record, atOnce: [...atOnce] };
  };
  return { ...tables, renderer, rows, made, frame, mock };
}

/**
 * The ids of the rows drawn, in the order they are drawn: the rows of the ranges recorded that
 * the state of their group does not hide (the delta included)
 */
function drawnIds(record: TableDrawRecord[], table: LayerTable): string[] {
  const out: string[] = [];
  for (const entry of record) {
    const group = entry.delta ? table.delta.group : table.groupAt(entry.groupIndex);
    if (!group) continue;
    for (let row = entry.from; row < entry.to; row++) {
      if ((group.gpuState[row] & 1) !== 0) continue;
      out.push(
        new TextDecoder().decode(
          group.data.ids.bytes.subarray(
            group.data.ids.offsets[row],
            group.data.ids.offsets[row + 1],
          ),
        ),
      );
    }
  }
  return out;
}

/** The ids of the rows of a layer that are shown, in its order */
function shownIds(table: LayerTable, idOf: (handle: number) => string | undefined): string[] {
  const order = table.rowOrder();
  const out: string[] = [];
  for (let i = 0; i < order.handles.length; i++) {
    if ((order.groups[i].gpuState[order.rows[i]] & 1) === 0) {
      out.push(idOf(order.handles[i]) as string);
    }
  }
  return out;
}

describe('the drawing of the rows of the delta', () => {
  it('draws a row placed elsewhere at its new place from the frame it is written in', () => {
    const list = features(120, 1);
    const live = setup(list);
    live.frame();
    live.frame();
    const table = live.table;
    // Moved to the middle of another group, to the front, and to the back
    const ids = [list[0].id, list[50].id, list[100].id];
    const keys = [`${orderKey(70)}x`, orderKey(0).slice(0, -1), orderKey(999)];
    for (let i = 0; i < ids.length; i++) {
      const handle = live.tables.findRow(ids[i]) as number;
      if (handle === undefined) continue;
      live.writer.apply(patchOf([handle], { order: [keys[i]] }));
      const { record } = live.frame();
      expect(drawnIds(record, table)).toEqual(shownIds(table, live.tables.getRowId));
      // The row of the delta is drawn from its chunk, on the GPU in this frame
      expect(record.some((entry) => entry.delta && entry.kind === 'rows')).toBe(true);
    }
    expect(live.internals.deltaRowCount()).toBe(3);
  });

  it('draws a new row at its place, and the rows of a layer that has no group', () => {
    const list = features(40, 2);
    const live = setup(list);
    live.frame();
    const [fresh, other] = live.writer.allocateHandles(utf8ColumnFromStrings(['new', 'elsewhere']));
    const geometry: Geometry = { type: 'Point', coordinates: [1, 1] };
    live.writer.apply(
      patchOf([fresh], {
        type: ['Point'],
        layerId: ['layer'],
        geometry: [geometry],
        order: [`${orderKey(20)}a`],
      }),
    );
    const { record } = live.frame();
    expect(drawnIds(record, live.table)).toEqual(shownIds(live.table, live.tables.getRowId));
    expect(drawnIds(record, live.table)).toContain('new');
    // A layer that has only rows of its delta
    live.writer.apply(
      patchOf([other], {
        type: ['Point'],
        layerId: ['second'],
        geometry: [geometry],
        order: [orderKey(1)],
      }),
    );
    const second = live.internals.layerTable('second') as LayerTable;
    expect(second.groupCount).toBe(0);
    live.renderer.prerender();
    const record2: TableDrawRecord[] = [];
    live.renderer.recordDraws(record2);
    live.renderer.drawLayer(
      live.internals,
      second,
      { ...LAYER, id: 'second' },
      { projectionData: PROJECTION, zoom: 10, bounds: undefined },
      {
        renderers: {
          styles: createTestDrawer(),
          viewport: () => [800, 600],
          run: retainedDrawRun(live.mock.gl),
          rows: live.rows,
          point: {},
          line: {},
          polygon: {},
        } as unknown as RetainedRendererSet,
        batchManager: { beginFrame: () => {}, processFeature: () => true, endFrame: () => {} },
        customRenderers: new Map() as never,
        customRendererContext: {} as never,
        companions: createFeatureCompanionRegistry(),
      },
    );
    expect(drawnIds(record2, second)).toEqual(['elsewhere']);
  });

  it('cuts a chunk of a group at the places of the rows of the delta, and counts the cuts', () => {
    const list = features(64, 3).map((f) =>
      f.type === 'Image' ? feature(f.id, 'Point', [0, 0]) : f,
    );
    const live = setup(list, 64);
    live.frame();
    live.frame();
    const handles = [3, 9, 9].map((i, k) => live.tables.findRow(list[i + k * 20].id) as number);
    live.writer.apply(
      patchOf(handles, { order: [`${orderKey(10)}a`, `${orderKey(30)}a`, `${orderKey(30)}b`] }),
    );
    const { record } = live.frame();
    expect(drawnIds(record, live.table)).toEqual(shownIds(live.table, live.tables.getRowId));
    // One chunk of the group, cut at two places: three ranges, and two of the delta in between
    const main = record.filter((entry) => !entry.delta);
    const delta = record.filter((entry) => entry.delta);
    expect(main).toHaveLength(3);
    expect(delta.map((entry) => [entry.from, entry.to])).toEqual([
      [0, 1],
      [1, 3],
    ]);
    expect(live.renderer.writeStats.cuts).toBe(2);
  });

  it('writes a row of the delta into its place in the chunk of the delta, or packs it again', () => {
    const list = features(40, 4).map((f, i) =>
      i === 5
        ? feature(f.id, 'LineString', [
            [0, 0],
            [1, 1],
            [2, 0],
          ])
        : f,
    );
    const live = setup(list);
    live.frame();
    const handle = live.tables.findRow(list[5].id) as number;
    live.writer.apply(patchOf([handle], { order: [`${orderKey(30)}a`] }));
    live.frame();
    const chunk = live.renderer.deltaChunks('layer')[0];
    const made = live.made.length;
    // A color, and a vertex taken off: within its place
    live.writer.apply(patchOf([handle], { style: [{ strokeColor: '#00ff00' }] }));
    live.writer.apply(
      patchOf([handle], {
        geometry: [
          {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
        ],
      }),
    );
    let { record } = live.frame();
    expect(live.made.length).toBe(made);
    expect(live.renderer.deltaChunks('layer')[0]).toBe(chunk);
    expect(drawnIds(record, live.table)).toEqual(shownIds(live.table, live.tables.getRowId));
    // Past its place: the chunk of the delta is packed again, in the same frame
    live.writer.apply(
      patchOf([handle], {
        geometry: [
          {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1],
              [2, 0],
              [3, 1],
            ],
          },
        ],
      }),
    );
    ({ record } = live.frame());
    expect(live.made.length).toBe(made + 1);
    expect(live.renderer.deltaChunks('layer')[0]).not.toBe(chunk);
    expect(record.some((entry) => entry.delta && entry.kind === 'rows')).toBe(true);
    expect(drawnIds(record, live.table)).toEqual(shownIds(live.table, live.tables.getRowId));
  });

  it('draws the rows of the delta at once at their places when the layer is drawn by kind', () => {
    const list = features(50, 5);
    const live = setup(list);
    live.renderer.setDrawingByKind(true);
    live.frame();
    live.frame();
    const handle = live.tables.findRow(list[7].id) as number;
    live.writer.apply(patchOf([handle], { order: [`${orderKey(40)}a`] }));
    const { record, atOnce } = live.frame();
    expect(drawnIds(record, live.table)).toEqual(shownIds(live.table, live.tables.getRowId));
    expect(record.filter((entry) => entry.delta).every((entry) => entry.kind === 'immediate')).toBe(
      true,
    );
    expect(atOnce).toContain(list[7].id);
  });

  it('draws the rows of the layer in their order every frame, whatever is written at random', () => {
    for (const seed of [21, 22, 23]) {
      const random = seededRandom(seed);
      const list = features(150, seed);
      const live = setup(list, 16);
      live.frame();
      let created = 0;
      for (let step = 0; step < 60; step++) {
        const order = live.table.rowOrder();
        const at = Math.floor(random() * order.handles.length);
        const handle = order.handles[at];
        const pick = random();
        if (pick < 0.35) {
          live.writer.apply(
            patchOf([handle], { order: [`${orderKey(Math.floor(random() * 150))}m`] }),
          );
        } else if (pick < 0.5) {
          const id = `n${created++}`;
          const [fresh] = live.writer.allocateHandles(utf8ColumnFromStrings([id]));
          live.writer.apply(
            patchOf([fresh], {
              type: ['Polygon'],
              layerId: ['layer'],
              geometry: [
                {
                  type: 'Polygon',
                  coordinates: [
                    [
                      [0, 0],
                      [1, 0],
                      [0, 1],
                      [0, 0],
                    ],
                  ],
                },
              ],
              order: [`${orderKey(Math.floor(random() * 150))}n`],
            }),
          );
        } else if (pick < 0.65) {
          live.writer.apply(
            patchOf([handle], { style: [{ strokeColor: '#00ff00', pointColor: '#0000ff' }] }),
          );
        } else if (pick < 0.75) {
          live.writer.apply(patchOf([handle], {}, [1]));
        } else if (pick < 0.85) {
          live.writer.apply(patchOf([handle], { visible: [false] }));
        } else {
          live.renderer.setArtificialCuts(Math.floor(random() * 5));
        }
        const { record } = live.frame(
          random() < 0.3 ? { minX: 0, minY: 0, maxX: 5, maxY: 5 } : undefined,
        );
        const drawn = drawnIds(record, live.table);
        // Every row once, in the order of the layer (out of the view, the chunks are skipped)
        const shown = shownIds(live.table, live.tables.getRowId);
        expect(new Set(drawn).size).toBe(drawn.length);
        const place = new Map(shown.map((id, i) => [id, i]));
        for (let i = 1; i < drawn.length; i++) {
          expect(place.get(drawn[i]) as number).toBeGreaterThan(place.get(drawn[i - 1]) as number);
        }
        const full = live.frame();
        expect(drawnIds(full.record, live.table)).toEqual(shown);
      }
    }
  });

  it('draws a feature drawn over a row in its place, from the frame it is given, and not the row', () => {
    const list = features(60, 5);
    const live = setup(list);
    live.frame();
    const over = list[20];
    internalsOf(live.tables).showInPlace('peer', [
      { ...over, geometry: { type: 'Point', coordinates: [50, 50] } },
    ]);
    const { record } = live.frame();
    const all = live.table.rowOrder();
    const expected: string[] = [];
    for (let i = 0; i < all.handles.length; i++) {
      const id = live.tables.getRowId(all.handles[i]) as string;
      if (id === over.id) expected.push(`\u0000overlay\u0000peer\u0000${id}`);
      else expected.push(id);
    }
    expect(drawnIds(record, live.table)).toEqual(expected);
    // Taken away: the row is drawn again in its place
    internalsOf(live.tables).showInPlace('peer', []);
    expect(drawnIds(live.frame().record, live.table)).toEqual(
      shownIds(live.table, live.tables.getRowId),
    );
    expect(shownIds(live.table, live.tables.getRowId)).toContain(over.id);
  });

  it('draws every row once in every frame while the next versions are built and swapped', () => {
    for (const seed of [41, 42]) {
      const random = seededRandom(seed);
      const list = features(300, seed);
      const live = setup(list, 32, true);
      live.frame();
      for (let step = 0; step < 80; step++) {
        if (random() < 0.5) {
          const order = live.table.rowOrder();
          const handle = order.handles[Math.floor(random() * order.handles.length)];
          const pick = random();
          if (pick < 0.6) {
            live.writer.apply(
              patchOf([handle], { order: [`${orderKey(Math.floor(random() * 300))}m`] }),
            );
          } else if (pick < 0.8) {
            live.writer.apply(patchOf([handle], { style: [{ strokeColor: '#00ff00' }] }));
          } else {
            live.writer.apply(patchOf([handle], { 'property:n': [step] }));
          }
        }
        const { record } = live.frame();
        expect(drawnIds(record, live.table)).toEqual(shownIds(live.table, live.tables.getRowId));
      }
      // Once nothing is written, the versions take every row of the delta
      for (let i = 0; i < 20 && live.internals.hasPendingWork; i++) live.frame();
      const { record } = live.frame();
      expect(live.internals.deltaRowCount()).toBe(0);
      expect(live.internals.versionStats().swapped).toBeGreaterThan(3);
      expect(drawnIds(record, live.table)).toEqual(shownIds(live.table, live.tables.getRowId));
      expect(record.some((entry) => entry.delta)).toBe(false);
    }
  });

  it('draws the members of a group in the order before until a reorder is swapped in', () => {
    const list = features(200, 43).map((f) =>
      f.type === 'Image' ? feature(f.id, 'Point', [1, 1]) : f,
    );
    const live = setup(list, 32, true);
    live.frame();
    live.frame();
    live.writer.applyGroups({
      handles: Int32Array.of(5),
      fields: new Map([
        ['id', ['g']],
        ['order', [`${orderKey(20)}g`]],
        ['layerId', ['layer']],
      ]),
    });
    const members = [30, 31, 32, 150, 151].map((i) => live.tables.findRow(list[i].id) as number);
    live.writer.apply(
      patchOf(members, {
        groupId: members.map(() => 'g'),
        member: members.map((_, i) => `m${i}`),
      }),
    );
    for (let i = 0; i < 30 && live.internals.hasPendingWork; i++) {
      const { record } = live.frame();
      expect(drawnIds(record, live.table)).toEqual(shownIds(live.table, live.tables.getRowId));
    }
    expect(live.internals.deltaRowCount()).toBe(0);
    const before = shownIds(live.table, live.tables.getRowId);
    live.writer.applyGroups({
      handles: Int32Array.of(5),
      fields: new Map([['order', [`${orderKey(120)}g`]]]),
    });
    let changed = false;
    for (let i = 0; i < 30; i++) {
      const { record } = live.frame();
      const shown = shownIds(live.table, live.tables.getRowId);
      expect(drawnIds(record, live.table)).toEqual(shown);
      changed ||= shown.join() !== before.join();
      if (!live.internals.hasPendingWork) break;
    }
    expect(changed).toBe(true);
    expect(live.internals.groups.orderOf(5)).toBe(`${orderKey(120)}g`);
  });

  it('draws an import written a thousand rows at a time from the frame its groups are up', () => {
    const list = features(100, 44).map((f) =>
      f.type === 'Image' ? feature(f.id, 'Point', [1, 1]) : f,
    );
    const live = setup(list, 50, true);
    live.frame();
    live.frame();
    let made = 0;
    let drawnBefore = new Set<string>();
    for (let write = 0; write < 6; write++) {
      const ids = Array.from({ length: 1000 }, (_, i) => `import${write * 1000 + i}`);
      const handles = live.writer.allocateHandles(utf8ColumnFromStrings(ids));
      live.writer.apply(
        patchOf(Array.from(handles), {
          type: ids.map(() => 'Point'),
          layerId: ids.map(() => 'layer'),
          geometry: ids.map((_, i) => ({ type: 'Point', coordinates: [i / 100, write] })),
          order: ids.map(
            (_, i) => `${orderKey(999_000)}${String(write * 1000 + i).padStart(6, '0')}`,
          ),
        }),
      );
      for (let i = 0; i < 3; i++) {
        const { record } = live.frame();
        // Never in the delta: a group of new rows is drawn from the frame its chunks are up,
        // the rows in their order, once each, and a row drawn is drawn in every frame after
        expect(live.internals.deltaRowCount()).toBe(0);
        const drawn = drawnIds(record, live.table);
        const shown = shownIds(live.table, live.tables.getRowId);
        const place = new Map(shown.map((id, k) => [id, k]));
        for (let k = 1; k < drawn.length; k++) {
          expect(place.get(drawn[k]) as number).toBeGreaterThan(place.get(drawn[k - 1]) as number);
        }
        const now = new Set(drawn);
        for (const id of drawnBefore) expect(now.has(id)).toBe(true);
        drawnBefore = now;
        made = Math.max(made, live.table.rowCount);
      }
    }
    for (let i = 0; i < 20 && live.internals.hasPendingWork; i++) live.frame();
    const { record } = live.frame();
    expect(live.table.rowCount).toBe(6100);
    expect(drawnIds(record, live.table)).toEqual(shownIds(live.table, live.tables.getRowId));
    expect(made).toBeGreaterThan(100);
  });

  it('builds the chunks of the versions while the camera moves only when given a budget for it', () => {
    for (const budget of [0, 50]) {
      const list = features(200, 45).map((f) =>
        f.type === 'Image' ? feature(f.id, 'Point', [1, 1]) : f,
      );
      const live = setup(list, 32, true);
      live.frame();
      live.frame();
      live.renderer.setVersionBudgetWhileMoving(budget);
      setTerrainCameraMoving(terrain, true);
      const handle = live.tables.findRow(list[10].id) as number;
      live.writer.apply(patchOf([handle], { order: [`${orderKey(150)}x`] }));
      for (let i = 0; i < 12; i++) {
        const { record } = live.frame();
        expect(drawnIds(record, live.table)).toEqual(shownIds(live.table, live.tables.getRowId));
      }
      // Without a budget the versions wait for the camera to stop: the row stays in the delta
      expect(live.internals.deltaRowCount()).toBe(budget === 0 ? 1 : 0);
      setTerrainCameraMoving(terrain, false);
      for (let i = 0; i < 12 && live.internals.hasPendingWork; i++) live.frame();
      expect(live.internals.deltaRowCount()).toBe(0);
    }
  });

  it('starts the versions of the groups cut past the budget of the cuts first', () => {
    const seen: number[] = [];
    for (const scattered of [10, 120]) {
      const list = features(400, 46).map((f) =>
        f.type === 'Image' ? feature(f.id, 'Point', [1, 1]) : f,
      );
      const live = setup(list, 64, true);
      live.frame();
      live.frame();
      // Rows put at places spread over the layer: as many cuts in the frames
      const handles = Array.from(
        { length: scattered },
        (_, i) => live.tables.findRow(list[i].id) as number,
      );
      live.writer.apply(
        patchOf(handles, {
          order: handles.map((_, i) => `${orderKey(Math.floor((i * 397) % 400))}c${i}`),
        }),
      );
      live.frame();
      const cuts = live.renderer.writeStats.cuts;
      seen.push(cuts);
      live.frame();
      // Past the budget, the versions start in the next frame; within it, they wait
      const started =
        live.internals.versionStats().swapped + live.internals.builtVersions('layer').length;
      if (cuts > SPLIT_BUDGET) expect(started).toBeGreaterThan(0);
      else expect(started).toBe(0);
    }
    // Both sides of the budget were seen
    expect(Math.min(...seen)).toBeLessThanOrEqual(SPLIT_BUDGET);
    expect(Math.max(...seen)).toBeGreaterThan(SPLIT_BUDGET);
  });
});
