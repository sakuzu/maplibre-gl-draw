// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The drawing of the layers from their rows on the terrain and on the globe
 * (`TableLayerRenderer`), on the GL that counts its calls: the rows drawn in one draw and cut for
 * the surface, the elevations of the points, the rows cut again when the surface changes (only
 * those whose fingerprint changed, within the budget, the chunk drawn as it was until then), the
 * chunks built again when a row does not fit, the drawing before kept while the terrain comes and
 * goes, what is given back, and the rows drawn when what is held outside them is at the limit
 */

import type { CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDrawOnEngine } from '../../api/impl/create-draw.js';
import { createEngine } from '../../api/impl/engine.js';
import { checkDrawOptions, toEngineOptions } from '../../api/impl/options.js';
import { createStore } from '../../store/built-in/create-store.js';
import {
  createCountedInstance,
  createCountingGL,
  createDrawingMapStub,
  renderInput,
} from '../../test-utils.js';
import { GPU_FLOOR_BYTES } from '../gpu-ledger.js';
import { ROWS_KIND, type RowsChunkData, readRowsInstance } from '../renderers/rows/rows-format.js';
import { type RowsChunk, RowsRenderer } from '../renderers/rows/rows-renderer.js';
import { anchorElevationMeters } from '../terrain/anchor.js';
import { getTerrainDrapeDebug } from '../terrain/state.js';
import type { TableDrawRecord, TableLayerRenderer } from './table-retained.js';

type Instance = ReturnType<typeof createCountedInstance>;

const instances: Instance[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const instance of instances.splice(0)) instance.draw.destroy();
});

/** An instance on the counting GL, destroyed at the end of the test */
function instanceOf(): Instance {
  const instance = createCountedInstance();
  instances.push(instance);
  return instance;
}

/** The renderer of the rows of an instance */
function rendererOf(instance: Pick<Instance, 'engine'>): TableLayerRenderer {
  const renderer = instance.engine.customLayer.getTableRenderer();
  if (!renderer) throw new Error('the instance draws no rows');
  return renderer;
}

/** The terrain of the map stub: four DEM tiles over the area it shows, the tiles changeable */
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

/** The ground of the map stub: an elevation that changes with the place, raised by `lift` */
const ground = { lift: 0 };

/** Puts the terrain on the map of an instance, its ground the one of `ground` */
function putTerrain(map: { map: unknown }) {
  const made = demTerrain();
  Object.assign(map.map as object, {
    terrain: made.terrain,
    queryTerrainElevation: ([lng, lat]: [number, number]) =>
      100 + 40 * lng + 25 * lat + ground.lift,
  });
  return made;
}

/** Takes the terrain off the map of an instance */
function takeTerrain(map: { map: unknown }): void {
  (map.map as { terrain: unknown }).terrain = undefined;
}

/** A render input of the globe (the projection on its way to the globe) */
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

/** Draws frames until the drawing has no work left (throws past 60) */
function settle(
  instance: Pick<Instance, 'map' | 'draw'>,
  input: () => CustomRenderMethodInput = renderInput,
): number {
  for (let frame = 1; frame <= 60; frame++) {
    instance.map.render(input());
    if (!instance.draw.hasPendingWork()) return frame;
  }
  throw new Error('the drawing still has work after 60 frames');
}

/** What the tests read of the renderer */
interface Internals {
  readonly layers: Map<
    string,
    {
      readonly surfaceKind: string;
      readonly drawing: string;
      readonly groups: Map<
        number,
        {
          chunks: Array<{
            type: string;
            range: { from: number; to: number };
            batches: RowsChunk | null;
          }> | null;
        }
      >;
    }
  >;
  readonly cuts: WeakMap<
    RowsChunk,
    {
      kind: string;
      generation: number;
      anchor: number;
      keys: Int32Array;
      check: unknown;
    }
  >;
}

/** The chunks drawn in one draw of the layers, in order, with what they were cut with */
function rowsChunks(renderer: TableLayerRenderer) {
  const internals = renderer as unknown as Internals;
  const out: Array<{
    gpu: RowsChunk;
    cut: ReturnType<Internals['cuts']['get']>;
    from: number;
    to: number;
  }> = [];
  for (const layer of internals.layers.values()) {
    for (const group of layer.groups.values()) {
      for (const chunk of group.chunks ?? []) {
        if (chunk.type !== 'rows' || !chunk.batches) continue;
        out.push({
          gpu: chunk.batches,
          cut: internals.cuts.get(chunk.batches),
          from: chunk.range.from,
          to: chunk.range.to,
        });
      }
    }
  }
  return out;
}

/** The surface the layers of an instance are classified for */
function surfaceKinds(renderer: TableLayerRenderer): string[] {
  return [...(renderer as unknown as Internals).layers.values()].map(
    (layer) => `${layer.drawing}/${layer.surfaceKind}`,
  );
}

/** Records the packed arrays of every chunk made from now on */
function recordChunks(): RowsChunkData[] {
  const made: RowsChunkData[] = [];
  const original = RowsRenderer.prototype.createChunk;
  vi.spyOn(RowsRenderer.prototype, 'createChunk').mockImplementation(function (
    this: RowsRenderer,
    data: RowsChunkData,
  ) {
    made.push({ ...data, instances: data.instances.slice(), coords: data.coords.slice() });
    return original.call(this, data);
  });
  return made;
}

/** A clock that moves on by `step` ms whenever it is read (the budget of a frame runs out with it) */
function stepClock(step: number): void {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => {
    now += step;
    return now;
  });
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

/** `count` features over the area the map stub shows, a point, a line and a polygon in turn */
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

/** The ranges drawn in one frame */
function drawsOf(instance: Instance, input: () => CustomRenderMethodInput = renderInput) {
  const record: TableDrawRecord[] = [];
  const renderer = rendererOf(instance);
  renderer.recordDraws(record);
  instance.map.render(input());
  renderer.recordDraws(null);
  return record;
}

describe('the rows on the terrain and on the globe', () => {
  it('are drawn in one draw a chunk, classified and cut for the surface', () => {
    const instance = instanceOf();
    putTerrain(instance.map);
    instance.draw.features.createMany(shapes(300) as never);
    settle(instance);
    expect(surfaceKinds(rendererOf(instance))).toEqual(['one-draw/terrain']);
    const draws = drawsOf(instance);
    expect(draws.length).toBeGreaterThan(0);
    expect(draws.every((draw) => draw.kind === 'rows')).toBe(true);
    for (const chunk of rowsChunks(rendererOf(instance))) expect(chunk.cut?.kind).toBe('terrain');

    takeTerrain(instance.map);
    settle(instance, globeInput);
    expect(surfaceKinds(rendererOf(instance))).toEqual(['one-draw/globe']);
    const globe = drawsOf(instance, globeInput);
    expect(globe.length).toBeGreaterThan(0);
    expect(globe.every((draw) => draw.kind === 'rows')).toBe(true);
    for (const chunk of rowsChunks(rendererOf(instance))) expect(chunk.cut?.kind).toBe('globe');
  });

  it('draw the dashed lines at once, as their dashes are cut there', () => {
    const instance = instanceOf();
    putTerrain(instance.map);
    instance.draw.features.createMany([
      ...shapes(90),
      {
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-0.5, 0.9],
            [0.5, 0.9],
          ],
        },
        style: { lineStyle: 'dashed' },
      },
    ] as never);
    settle(instance);
    const kinds = new Set(drawsOf(instance).map((draw) => draw.kind));
    expect(kinds).toEqual(new Set(['rows', 'immediate']));
  });

  it('give the points the elevation the hit testing projects them with', () => {
    const made = recordChunks();
    const instance = instanceOf();
    putTerrain(instance.map);
    const places: [number, number][] = Array.from({ length: 80 }, (_, i) => [
      -0.9 + (i % 9) * 0.2,
      -0.9 + Math.floor(i / 9) * 0.2,
    ]);
    instance.draw.features.createMany(
      places.map((coordinates) => ({
        type: 'Point',
        geometry: { type: 'Point', coordinates },
      })) as never,
    );
    settle(instance);
    const terrain = instance.engine.customLayer.getTerrainContext();
    const chunk = made[made.length - 1];
    expect(chunk.lines.surface).toBe(true);
    const heights: number[] = [];
    let point = 0;
    for (let i = 0; i < chunk.instanceCount; i++) {
      const instanceOfRow = readRowsInstance(chunk.instances, i);
      if (instanceOfRow.kind !== ROWS_KIND.point) continue;
      const [lng, lat] = places[chunk.rowBase + instanceOfRow.row];
      expect(instanceOfRow.extra).toBe(Math.fround(anchorElevationMeters(terrain, lng, lat)));
      heights.push(instanceOfRow.extra);
      point++;
    }
    expect(point).toBe(places.length);
    // The ground is not flat: the points stand at elevations of their own
    expect(new Set(heights).size).toBeGreaterThan(10);
  });

  it('cut the fills with the step of the surface, and their outlines on the step of their fills', () => {
    const made = recordChunks();
    const instance = instanceOf();
    putTerrain(instance.map);
    instance.draw.features.createMany(
      Array.from({ length: 70 }, () => ({
        type: 'Polygon',
        geometry: { type: 'Polygon', coordinates: [square(-0.5, -0.5, 1)] },
      })) as never,
    );
    settle(instance);
    const chunk = made[made.length - 1];
    const counts = { fill: 0, outline: 0 };
    for (let i = chunk.rowFirst[0]; i < chunk.rowFirst[1]; i++) {
      const kind = readRowsInstance(chunk.instances, i).kind;
      if (kind === ROWS_KIND.fill) counts.fill++;
      if (kind === ROWS_KIND.outline) counts.outline++;
    }
    // A square is 2 triangles and 4 edges on a flat map
    expect(counts.fill).toBeGreaterThan(2);
    expect(counts.outline).toBeGreaterThan(4);
  });

  it('after the elevations change, pack again only the rows whose fingerprint changed, within the budget, drawn as they were until all are packed', () => {
    const instance = instanceOf();
    const { tiles } = putTerrain(instance.map);
    instance.draw.features.createMany(shapes(3_000) as never);
    settle(instance);
    const renderer = rendererOf(instance);
    const before = rowsChunks(renderer);
    expect(before).toHaveLength(1);
    const cutBefore = before[0].cut;
    if (!cutBefore) throw new Error('the chunk is not cut for the terrain');
    const keysBefore = cutBefore.keys.slice();
    const anchor = before[0].cut?.anchor;

    // A tile of the terrain leaves and the ground rises: new elevations
    tiles.delete('7/64/64');
    ground.lift = 10;
    try {
      stepClock(1);
      const patched = vi.spyOn(RowsRenderer.prototype, 'patchRows');
      const drawn = vi.spyOn(RowsRenderer.prototype, 'drawRange');
      const perFrame: number[] = [];
      let frames = 0;
      for (; frames < 60; frames++) {
        const packed = renderer.stats.rowsPacked;
        drawn.mockClear();
        instance.map.render();
        perFrame.push(renderer.stats.rowsPacked - packed);
        const cut = rowsChunks(renderer)[0].cut;
        if (cut?.check) {
          // Nothing is written into the chunk until every row is checked, and it is drawn
          expect(patched).not.toHaveBeenCalled();
          expect(drawn.mock.calls.some(([chunk]) => chunk === before[0].gpu)).toBe(true);
        }
        if (!instance.draw.hasPendingWork()) break;
      }
      const after = rowsChunks(renderer);
      // Written in place: the chunk is the same
      expect(after[0].gpu).toBe(before[0].gpu);
      expect(after[0].cut?.anchor).not.toBe(anchor);
      const keysAfter = after[0].cut?.keys as Int32Array;
      let changed = 0;
      for (let i = 0; i < keysAfter.length; i++) if (keysAfter[i] !== keysBefore[i]) changed++;
      const packed = perFrame.reduce((sum, rows) => sum + rows, 0);
      expect(changed).toBeGreaterThanOrEqual(1_000);
      expect(packed).toBe(changed);
      expect(patched).toHaveBeenCalledTimes(changed);
      // Over the frames, the rows of a frame bounded by the budget (a slice of rows between two
      // looks at the clock, which moves on by 1 ms a look, for 12 ms)
      expect(perFrame.filter((rows) => rows > 0).length).toBeGreaterThan(1);
      for (const rows of perFrame) expect(rows).toBeLessThanOrEqual(64 * 14);
    } finally {
      ground.lift = 0;
    }
  });

  it('build again only the chunk with a row that does not fit its place', () => {
    const instance = instanceOf();
    const { terrain } = putTerrain(instance.map);
    // Large polygons the new step cuts finer, then a dashed line drawn at once (where the chunks
    // end), then small polygons inside one cell of both steps
    const cell = 1 / (128 * 64);
    const smallAt = (k: number): [number, number] => {
      // The middle of a cell of the finer step (the coarser one has its lines on every other)
      const mx = 0.5 + (k * 2 + 0.5) * cell;
      const my = 0.5 + (k * 2 + 0.5) * cell;
      const lng = mx * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;
      return [lng, lat];
    };
    instance.draw.features.createMany([
      ...Array.from({ length: 70 }, () => ({
        type: 'Polygon',
        geometry: { type: 'Polygon', coordinates: [square(-0.5, -0.5, 1)] },
      })),
      {
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-0.5, 0.9],
            [0.5, 0.9],
          ],
        },
        style: { lineStyle: 'dashed' },
      },
      ...Array.from({ length: 70 }, (_, k) => {
        const [x, y] = smallAt(k);
        return {
          type: 'Polygon',
          geometry: { type: 'Polygon', coordinates: [square(x, y - 0.00001, 0.00001)] },
        };
      }),
    ] as never);
    settle(instance);
    const renderer = rendererOf(instance);
    const before = rowsChunks(renderer);
    expect(before).toHaveLength(2);
    const built = renderer.stats.chunksBuilt;

    // A finer mesh of the terrain: a finer step
    terrain.meshSize = 64;
    settle(instance);
    const after = rowsChunks(renderer);
    expect(after).toHaveLength(2);
    // The large polygons do not fit their places: their chunk is built again
    expect(after[0].gpu).not.toBe(before[0].gpu);
    // The small ones fit: written into the chunk drawn
    expect(after[1].gpu).toBe(before[1].gpu);
    expect(after[1].cut?.generation).toBe(after[0].cut?.generation);
    expect(renderer.stats.chunksBuilt - built).toBe(1);
  });

  it('draw the chunks of the drawing before until the new ones are built in view, when the terrain comes and goes', () => {
    const instance = instanceOf();
    for (let i = 0; i < 3; i++) instance.draw.features.createMany(shapes(1_500) as never);
    settle(instance);
    const renderer = rendererOf(instance);
    const rowsDrawn = (record: TableDrawRecord[]) =>
      record.reduce((sum, draw) => sum + draw.to - draw.from, 0);
    const all = rowsDrawn(drawsOf(instance));
    const flat = new Set(rowsChunks(renderer).map((chunk) => chunk.gpu));

    const drawn = vi.spyOn(RowsRenderer.prototype, 'drawRange');
    const check = (kind: 'terrain' | 'flat') => {
      // A frame with next to no budget: the chunks are built over the frames
      stepClock(50);
      drawn.mockClear();
      const record = drawsOf(instance);
      vi.mocked(performance.now).mockRestore();
      // Every row is drawn in the frame, from the chunks of the drawing before
      expect(rowsDrawn(record)).toBe(all);
      const chunks = drawn.mock.calls.map(([chunk]) => chunk);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.some((chunk) => !builtFor(chunk, kind))).toBe(true);
      settle(instance);
      drawn.mockClear();
      expect(rowsDrawn(drawsOf(instance))).toBe(all);
      expect(drawn.mock.calls.every(([chunk]) => builtFor(chunk, kind))).toBe(true);
    };
    const builtFor = (chunk: RowsChunk, kind: 'terrain' | 'flat') => {
      const cut = (renderer as unknown as Internals).cuts.get(chunk);
      return kind === 'flat' ? !cut && !flat.has(chunk) : cut?.kind === 'terrain';
    };

    putTerrain(instance.map);
    check('terrain');
    takeTerrain(instance.map);
    check('flat');
  });
});

/** A GL that keeps the objects it made and deleted, over the counting GL */
function trackingGL() {
  const counting = createCountingGL();
  const live = new Set<object>();
  const deleted = new Set<object>();
  const state = { lost: false };
  const gl = new Proxy(counting.gl as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      if (prop === 'isContextLost') return () => state.lost;
      if (prop.startsWith('create')) {
        return (...args: unknown[]) => {
          if (state.lost) return null;
          const made = (value as (...a: unknown[]) => unknown)(...args);
          if (made && typeof made === 'object') live.add(made);
          return made;
        };
      }
      if (prop.startsWith('delete')) {
        return (object: unknown) => {
          if (object && typeof object === 'object') {
            live.delete(object);
            deleted.add(object);
          }
          return (value as (...a: unknown[]) => unknown)(object);
        };
      }
      return value;
    },
  }) as WebGL2RenderingContext;
  return { gl, live, deleted, state };
}

/** An instance on a GL that keeps what it made, with the objects its rows recorded */
function trackedInstance() {
  const tracking = trackingGL();
  const map = createDrawingMapStub(tracking.gl);
  // The listeners of the canvas, to fire the events of the context
  const listeners = new Map<string, Set<() => void>>();
  const target = map.canvas as unknown as {
    addEventListener: (type: string, fn: () => void) => void;
    removeEventListener: (type: string, fn: () => void) => void;
  };
  const add = target.addEventListener;
  const remove = target.removeEventListener;
  target.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)?.add(fn);
    add(type, fn);
  };
  target.removeEventListener = (type, fn) => {
    listeners.get(type)?.delete(fn);
    remove(type, fn);
  };
  const fire = (type: string): void => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn();
  };
  const store = createStore();
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
  // The objects the drawing of the rows records (the rows and their state)
  const rows = new Set<object>();
  const record = ledger.record.bind(ledger);
  vi.spyOn(ledger, 'record').mockImplementation((object, holder, kind, bytes) => {
    if (object && (holder === 'rows' || holder === 'rowState')) rows.add(object as object);
    record(object, holder, kind, bytes);
  });
  return { ...tracking, map, fire, draw, engine, ledger, rows };
}

/** Every object the rows recorded is held and alive, or given back and deleted */
function expectRowsGivenBack(instance: ReturnType<typeof trackedInstance>, held: boolean): void {
  expect(instance.rows.size).toBeGreaterThan(0);
  const wrong: string[] = [];
  for (const object of instance.rows) {
    const kept = instance.ledger.holds(object as never);
    if (kept && !held) wrong.push('held');
    if (kept && !instance.live.has(object)) wrong.push('held but deleted');
    if (!kept && instance.live.has(object)) wrong.push('alive but not held');
  }
  expect(wrong).toEqual([]);
  expect(instance.ledger.audit()).toBe(true);
}

describe('what the rows hold on the GPU on the terrain and on the globe', () => {
  it('is given back when the terrain comes and goes, and between the globe and the flat map', () => {
    const instance = trackedInstance();
    instance.draw.features.createMany(shapes(600) as never);
    settle(instance);
    putTerrain(instance.map);
    settle(instance);
    takeTerrain(instance.map);
    settle(instance);
    expectRowsGivenBack(instance, true);
    settle(instance, globeInput);
    expect(surfaceKinds(rendererOf(instance))).toEqual(['one-draw/globe']);
    settle(instance);
    putTerrain(instance.map);
    settle(instance);
    expectRowsGivenBack(instance, true);
    instance.draw.destroy();
    expectRowsGivenBack(instance, false);
    expect(instance.live.size).toBe(0);
  });

  it('is given back when the context is lost on the terrain', () => {
    const instance = trackedInstance();
    putTerrain(instance.map);
    instance.draw.features.createMany(shapes(600) as never);
    settle(instance);
    expect(instance.ledger.snapshot().byPart.rows ?? 0).toBeGreaterThan(0);
    instance.state.lost = true;
    instance.fire('webglcontextlost');
    for (const object of instance.rows) expect(instance.ledger.holds(object as never)).toBe(false);
    expect(instance.ledger.snapshot().byPart.rows ?? 0).toBe(0);
    expect(instance.ledger.snapshot().byPart.rowState ?? 0).toBe(0);
    instance.draw.destroy();
  });

  it('is drawn when what is held outside the rows is at the limit, the drape refused', () => {
    const instance = trackedInstance();
    instance.ledger.limitBytes = GPU_FLOOR_BYTES + 1;
    putTerrain(instance.map);
    instance.draw.features.createMany(shapes(600) as never);
    expect(() => settle(instance)).not.toThrow();
    expect(() => instance.map.render()).not.toThrow();
    const snapshot = instance.ledger.snapshot();
    expect(snapshot.byPart.rows ?? 0).toBeGreaterThan(0);
    expect(snapshot.byPart.drape ?? 0).toBe(0);
    expect(getTerrainDrapeDebug(instance.engine.customLayer.getTerrainContext()).used).toBe(false);
    expect(instance.ledger.audit()).toBe(true);
    instance.draw.destroy();
  });
});
