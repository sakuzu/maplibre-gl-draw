// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows of the layers on the frames the analytic drape paints (`TableLayerRenderer`), on the
 * GL that counts its calls: the points drawn from chunks of their own (the rows the drape paints
 * joined to them and drawn nothing there), the other rows drawn at once in their places, no
 * feature made and no row read in a frame, the points tested against the terrain on those frames
 * only, the chunks of both kinds of frame kept, a chunk that does not fit in the share of the
 * parts that give way drawn at once, and the chunks let go when the drape does not fit
 */

import type { CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDrawOnEngine } from '../../api/impl/create-draw.js';
import { createEngine } from '../../api/impl/engine.js';
import { checkDrawOptions, toEngineOptions } from '../../api/impl/options.js';
import { createStore } from '../../store/built-in/create-store.js';
import {
  compareWork,
  countsOf,
  createCountingGL,
  createCountingStore,
  createDrawingMapStub,
  renderInput,
  workDuring,
} from '../../test-utils.js';
import { BatchManager } from '../renderers/batch-manager.js';
import { DRAPED_ROWS_PART, type RowsChunk, RowsRenderer } from '../renderers/rows/rows-renderer.js';
import { getTerrainDrapeDebug, setTerrainDrapeDebug } from '../terrain/state.js';
import { BulkFramesRenderer } from '../ui/bulk-frames.js';
import { DrapePlanner } from './drape-planner.js';
import {
  type TableDrawRecord,
  type TableLayerRenderer,
  TableLayerRenderer as TableLayerRendererClass,
} from './table-retained.js';

type Instance = ReturnType<typeof countedInstance>;

/**
 * A draw instance over a Store of its own, on a map stub that draws on the counting GL, whose
 * allocations succeed (the drape checks them)
 */
function countedInstance() {
  const counting = createCountingGL();
  const gl = new Proxy(counting.gl as object, {
    get(target, prop) {
      if (prop === 'getError') return () => Reflect.get(target, 'NO_ERROR');
      return Reflect.get(target, prop);
    },
  }) as WebGL2RenderingContext;
  const map = createDrawingMapStub(gl);
  const store = createStore();
  const drawOptions = { store: createCountingStore(store).store };
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
  return { draw, engine, store, map };
}

const instances: Instance[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const instance of instances.splice(0)) instance.draw.destroy();
});

/** The terrain of the map stub: four DEM tiles over the area it shows */
function demTerrain() {
  const tiles = new Map<string, object>([
    ['7/63/63', { id: 'a' }],
    ['7/64/63', { id: 'b' }],
    ['7/63/64', { id: 'c' }],
    ['7/64/64', { id: 'd' }],
  ]);
  return {
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
}

/**
 * An instance on the counting GL over the terrain, at a zoom the drape paints at (the zoom given
 * otherwise), destroyed at the end of the test
 */
function instanceOf(zoom = 13): Instance {
  const instance = countedInstance();
  instances.push(instance);
  Object.assign(instance.map.map as object, {
    terrain: demTerrain(),
    queryTerrainElevation: ([lng, lat]: [number, number]) => 100 + 40 * lng + 25 * lat,
    getZoom: () => zoom,
  });
  return instance;
}

/** The renderer of the rows of an instance */
function rendererOf(instance: Pick<Instance, 'engine'>): TableLayerRenderer {
  const renderer = instance.engine.customLayer.getTableRenderer();
  if (!renderer) throw new Error('the instance draws no rows');
  return renderer;
}

/** Draws frames until the drawing has no work left (throws past 60) */
function settle(instance: Instance, input: () => CustomRenderMethodInput = renderInput): void {
  for (let frame = 1; frame <= 60; frame++) {
    instance.map.render(input());
    if (!instance.draw.hasPendingWork()) return;
  }
  throw new Error('the drawing still has work after 60 frames');
}

/** The ranges drawn in one frame */
function drawsOf(instance: Instance): TableDrawRecord[] {
  const record: TableDrawRecord[] = [];
  const renderer = rendererOf(instance);
  renderer.recordDraws(record);
  instance.map.render();
  renderer.recordDraws(null);
  return record;
}

/** Whether the drape painted the last frame */
function drapeUsed(instance: Instance): boolean {
  return getTerrainDrapeDebug(instance.engine.customLayer.getTerrainContext()).used;
}

/** What the tests read of the renderer */
interface Internals {
  readonly layers: Map<
    string,
    {
      readonly drawing: string;
      readonly groups: Map<
        number,
        {
          chunks: Array<{
            type: string;
            range: { from: number; to: number; kind: string };
            batches: RowsChunk | null;
          }> | null;
          other: { chunks: Array<{ batches: RowsChunk | null }> | null } | null;
        }
      >;
    }
  >;
}

/** The chunks drawn in one draw of the groups of the layers, on the side drawn now */
function rowsChunks(renderer: TableLayerRenderer): RowsChunk[] {
  const out: RowsChunk[] = [];
  for (const layer of (renderer as unknown as Internals).layers.values()) {
    for (const group of layer.groups.values()) {
      for (const chunk of group.chunks ?? []) {
        if (chunk.type === 'rows' && chunk.batches) out.push(chunk.batches);
      }
    }
  }
  return out;
}

/** The chunks of the side of the groups not drawn now */
function otherChunks(renderer: TableLayerRenderer): RowsChunk[] {
  const out: RowsChunk[] = [];
  for (const layer of (renderer as unknown as Internals).layers.values()) {
    for (const group of layer.groups.values()) {
      for (const chunk of group.other?.chunks ?? []) if (chunk.batches) out.push(chunk.batches);
    }
  }
  return out;
}

/** A square ring */
function square(x: number, y: number, side: number): [number, number][] {
  return [
    [x, y],
    [x + side, y],
    [x + side, y + side],
    [x, y + side],
    [x, y],
  ];
}

/** `count` features over the area the map stub shows: a point, a line and a polygon in turn */
function shapes(count: number) {
  const side = Math.ceil(Math.sqrt(count));
  const step = 1.6 / side;
  return Array.from({ length: count }, (_, i) => {
    const x = -0.8 + (i % side) * step;
    const y = -0.8 + Math.floor(i / side) * step;
    if (i % 3 === 0) return { type: 'Point', geometry: { type: 'Point', coordinates: [x, y] } };
    if (i % 3 === 1) {
      return {
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [x, y],
            [x + step / 2, y + step / 3],
          ],
        },
      };
    }
    return {
      type: 'Polygon',
      geometry: { type: 'Polygon', coordinates: [square(x, y, step / 2)] },
    };
  });
}

/** Has the drape not paint the frames while `off()` is true */
function drapeWhile(off: () => boolean): void {
  const planFrame = DrapePlanner.prototype.planFrame;
  vi.spyOn(DrapePlanner.prototype, 'planFrame').mockImplementation(function (
    this: DrapePlanner,
    ...args: Parameters<DrapePlanner['planFrame']>
  ) {
    return off() ? false : planFrame.apply(this, args);
  });
}

describe('the rows on a frame the drape paints', () => {
  it('draw the points from chunks of their own, the rows the drape paints joined to them', () => {
    const instance = instanceOf();
    instance.draw.features.createMany(shapes(600) as never);
    settle(instance);
    expect(drapeUsed(instance)).toBe(true);
    const renderer = rendererOf(instance);
    expect(
      [...(renderer as unknown as Internals).layers.values()].map((layer) => layer.drawing),
    ).toEqual(['draped']);
    // The points, the lines and the polygons interleaved: one chunk, under the part that gives way
    const chunks = rowsChunks(renderer);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].part).toBe(DRAPED_ROWS_PART);
    expect(chunks[0].data.rows).toBe(600);
    // Only the points have instances in it (one each)
    expect(chunks[0].data.instanceCount).toBe(200);
    const ledger = instance.engine.customLayer.getGpuLedger();
    expect(ledger.partOf(chunks[0].instanceBuffer)).toBe(DRAPED_ROWS_PART);
    const draws = drawsOf(instance);
    expect(draws.map((draw) => [draw.kind, draw.from, draw.to])).toEqual([['rows', 0, 600]]);
  });

  it('draw no point one at a time, and make no feature, in a frame', () => {
    const instance = instanceOf();
    instance.draw.features.createMany(shapes(600) as never);
    settle(instance);
    const renderer = rendererOf(instance);
    const processed = vi.spyOn(BatchManager.prototype, 'processFeature');
    const made = renderer.stats.featuresMade;
    instance.map.render();
    expect(processed).not.toHaveBeenCalled();
    expect(renderer.stats.featuresMade).toBe(made);
  });

  it('draw a Circle, a feature of a custom type and a shape not instanced at once, in their places', () => {
    const instance = instanceOf();
    instance.draw.extensions.featureTypes.add({
      type: 'Mark',
      geometry: 'Point',
      renderer: { onAdd() {}, draw() {}, onRemove() {} },
    });
    const point = (x: number) => ({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [x, 0] },
    });
    instance.draw.features.createMany([
      point(-0.5),
      {
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-0.5, 0.2],
            [0.5, 0.3],
          ],
        },
      },
      {
        type: 'Circle',
        geometry: { type: 'Point', coordinates: [0, 0] },
        properties: { 'maplibre-gl-draw:radiusMeters': 500 },
      },
      point(0.1),
      { type: 'Mark', geometry: { type: 'Point', coordinates: [0.2, 0] } },
      { type: 'Polygon', geometry: { type: 'Polygon', coordinates: [square(0.4, 0.4, 0.1)] } },
      { type: 'Polygon', geometry: { type: 'Polygon', coordinates: [square(0.6, 0.4, 0.1)] } },
      point(0.3),
      point(0.5),
    ] as never);
    settle(instance);
    expect(drapeUsed(instance)).toBe(true);
    const draws = drawsOf(instance);
    // The line joins the run of the points before it; the polygons after a run drawn at once make
    // a run of their own, drawn by the drape and not here
    expect(draws.map((draw) => [draw.kind, draw.from, draw.to])).toEqual([
      ['rows', 0, 2],
      ['immediate', 2, 3],
      ['rows', 3, 4],
      ['immediate', 4, 5],
      ['rows', 7, 9],
    ]);
  });

  it('test the points against the terrain on the frames the drape paints only', () => {
    const instance = instanceOf();
    instance.draw.features.createMany(shapes(300) as never);
    let off = false;
    drapeWhile(() => off);
    settle(instance);
    const drawn = vi.spyOn(RowsRenderer.prototype, 'drawRange');
    instance.map.render();
    expect(drawn.mock.calls.length).toBeGreaterThan(0);
    expect(drawn.mock.calls.every((call) => call[7] === true)).toBe(true);
    off = true;
    settle(instance);
    drawn.mockClear();
    instance.map.render();
    expect(drawn.mock.calls.length).toBeGreaterThan(0);
    expect(drawn.mock.calls.every((call) => call[7] === false)).toBe(true);
  });

  it('keep the chunks of both kinds of frame, and cut and build nothing again going from one to the other', () => {
    const instance = instanceOf();
    instance.draw.features.createMany(shapes(600) as never);
    let off = false;
    drapeWhile(() => off);
    settle(instance);
    const renderer = rendererOf(instance);
    const draped = rowsChunks(renderer);
    off = true;
    settle(instance);
    const flat = rowsChunks(renderer);
    expect(flat[0].part).toBe('rows');
    expect(otherChunks(renderer)).toEqual(draped);
    const built = renderer.stats.chunksBuilt;
    const packed = renderer.stats.rowsPacked;
    for (const state of [false, true, false, true]) {
      off = state;
      settle(instance);
      expect(rowsChunks(renderer)).toEqual(state ? flat : draped);
      expect(otherChunks(renderer)).toEqual(state ? draped : flat);
    }
    expect(renderer.stats.chunksBuilt).toBe(built);
    expect(renderer.stats.rowsPacked).toBe(packed);
    // A point moved while the other side is drawn is drawn where it is on both
    const point = instance.draw.features.list().find((feature) => feature.type === 'Point');
    instance.draw.features.update(point?.id as string, {
      geometry: { type: 'Point', coordinates: [0.05, 0.05] },
    });
    settle(instance);
    off = false;
    settle(instance);
    expect(rowsChunks(renderer)).toEqual(draped);
    expect(renderer.stats.chunksBuilt).toBe(built);
  });

  it('draw the points at once while their chunk does not fit, and from it once it fits', () => {
    const instance = instanceOf();
    const ledger = instance.engine.customLayer.getGpuLedger();
    let room = false;
    const fits = ledger.fits.bind(ledger);
    // The chunks of the rows find no room (written, and drawn, by the layers); the drape does
    let uploading = 0;
    vi.spyOn(ledger, 'fits').mockImplementation((bytes) =>
      uploading > 0 && !room ? false : fits(bytes),
    );
    const drawLayer = TableLayerRendererClass.prototype.drawLayer;
    vi.spyOn(TableLayerRendererClass.prototype, 'drawLayer').mockImplementation(function (
      this: TableLayerRenderer,
      ...args: Parameters<TableLayerRenderer['drawLayer']>
    ) {
      uploading++;
      try {
        return drawLayer.apply(this, args);
      } finally {
        uploading--;
      }
    });
    const flush = RowsRenderer.prototype.flushUploads;
    vi.spyOn(RowsRenderer.prototype, 'flushUploads').mockImplementation(function (
      this: RowsRenderer,
    ) {
      uploading++;
      try {
        flush.call(this);
      } finally {
        uploading--;
      }
    });
    instance.draw.features.createMany(shapes(300) as never);
    settle(instance);
    expect(drapeUsed(instance)).toBe(true);
    const processed = vi.spyOn(BatchManager.prototype, 'processFeature');
    const refused = drawsOf(instance);
    expect(refused.map((draw) => draw.kind)).toEqual(['immediate']);
    expect(processed).toHaveBeenCalledTimes(100);
    // The chunk refused holds nothing on the GPU
    const [chunk] = rowsChunks(rendererOf(instance));
    expect(chunk.refused).toBeGreaterThan(0);
    expect(chunk.instanceBuffer).toBeNull();
    room = true;
    settle(instance);
    processed.mockClear();
    const drawn = drawsOf(instance);
    expect(drawn.map((draw) => draw.kind)).toEqual(['rows']);
    expect(processed).not.toHaveBeenCalled();
  });

  it('are let go, on the side kept apart, when the drape does not fit', () => {
    const instance = instanceOf();
    instance.draw.features.createMany(shapes(600) as never);
    const context = instance.engine.customLayer.getTerrainContext();
    let refused = false;
    const planFrame = DrapePlanner.prototype.planFrame;
    vi.spyOn(DrapePlanner.prototype, 'planFrame').mockImplementation(function (
      this: DrapePlanner,
      ...args: Parameters<DrapePlanner['planFrame']>
    ) {
      if (!refused) return planFrame.apply(this, args);
      setTerrainDrapeDebug(context, {
        ...getTerrainDrapeDebug(context),
        used: false,
        reason: 'gpu-limit: the mesh of 32',
      });
      return false;
    });
    settle(instance);
    const renderer = rendererOf(instance);
    const [draped] = rowsChunks(renderer);
    const ledger = instance.engine.customLayer.getGpuLedger();
    expect(ledger.holds(draped.instanceBuffer)).toBe(true);
    refused = true;
    settle(instance);
    expect(otherChunks(renderer)).toEqual([]);
    expect(ledger.holds(draped.instanceBuffer)).toBe(false);
    expect(ledger.audit()).toBe(true);
  });

  it('draw the frames of the points selected tested against the terrain on those frames only', () => {
    const instance = instanceOf();
    const made = instance.draw.features.createMany(shapes(3_300) as never) as unknown as Array<{
      id: string;
    }>;
    let off = false;
    drapeWhile(() => off);
    settle(instance);
    instance.draw.selection.set(
      'feature',
      made.map((feature) => feature.id),
    );
    const drawn = vi.spyOn(BulkFramesRenderer.prototype, 'drawGroups');
    settle(instance);
    expect(drawn).toHaveBeenCalled();
    expect(drawn.mock.calls.every((call) => call[0].ghosts === true)).toBe(true);
    off = true;
    drawn.mockClear();
    settle(instance);
    expect(drawn).toHaveBeenCalled();
    expect(drawn.mock.calls[drawn.mock.calls.length - 1]?.[0].ghosts).toBe(false);
  });
});

describe('the work of a frame the drape paints', () => {
  /** The work of one frame of a document of `size` features, settled, with `move` before it */
  function frameWork(size: number, move: boolean) {
    const instance = instanceOf();
    instance.draw.features.createMany(shapes(size) as never);
    settle(instance);
    expect(drapeUsed(instance)).toBe(true);
    if (move) {
      const map = instance.map.map as unknown as {
        getCenter: () => { lng: number; lat: number };
        getBounds: () => unknown;
      };
      const bounds = map.getBounds();
      map.getCenter = () => ({ lng: 0.01, lat: 0 });
      map.getBounds = () => {
        const b = bounds as Record<string, () => unknown>;
        return {
          ...b,
          getWest: () => -0.99,
          getEast: () => 1.01,
          getSouthWest: () => ({ lng: -0.99, lat: -1 }),
          getNorthEast: () => ({ lng: 1.01, lat: 1 }),
        };
      };
    }
    const renderer = rendererOf(instance);
    const made = renderer.stats.featuresMade;
    const work = workDuring(countsOf(instance.store), () => instance.map.render());
    const result = {
      rows: work.rowsTouched,
      objects: work.objectsCreated + renderer.stats.featuresMade - made,
    };
    instance.draw.destroy();
    instances.splice(instances.indexOf(instance), 1);
    return result;
  }

  for (const move of [false, true]) {
    const when = move ? 'the camera moved' : 'the camera still';
    it(`touches no row and makes no object, ${when}`, () => {
      for (const what of ['rows', 'objects'] as const) {
        const comparison = compareWork((size) => frameWork(size, move)[what], { zero: true });
        expect(comparison.ratio, what).toBeLessThan(2);
        expect([comparison.small, comparison.large], what).toEqual([0, 0]);
      }
    });
  }
});
