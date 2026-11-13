// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The checks of the state of an instance (`debug.checks`)
 *
 * - The option is checked, and only given at creation
 * - The checks of the document and of the selection run once each notification of the Store has
 *   gone out, and a failure throws `DrawError` (`invalidState`) from the write that ended the
 *   transaction; a check allowed to fail is given to `onFailure` and not thrown, a check not run
 *   is not read
 * - Each check finds the state it is about broken
 * - The check of what is drawn runs once a frame is drawn
 * - Edits written by hand, a frame drawn after each, fail no check, those of the drawing of the
 *   rows run every frame (`drawingWrites`, `drawingRebuild`)
 * - The sequences of the reference model of the Store run on both Stores with every check on, and
 *   drawn, a frame after each step: the checks that fail now are listed (`KNOWN_BROKEN`)
 * - The checks of the drawing of the rows find a rule of the drawing broken in the test: a write
 *   of the style of a row not told to the drawing, the styles of a new style rule not resolved
 *   again, a write of the coordinates in place written wrong
 * - The drawing keeps what it writes to the GPU only while those checks run
 */

import { ROW_WRITE_STYLE } from '@sakuzu/kasane/render';
import type { CustomRenderMethodInput } from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDraw } from '../api/draw.js';
import type { Store as PublicStore } from '../api/extension/store.js';
import type { ConsistencyFailure } from '../api/options.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { DrawError } from '../shared/draw-error.js';
import type { DrawStore } from '../store/draw-store.js';
import { MemoryStore } from '../store/memory.js';
import type { Store } from '../store/store.js';
import { createTableStore } from '../store/table-memory.js';
import type { Feature, Layer } from '../store/types.js';
import { writeMarkKeeperOf } from '../store/write-mark-keeper.js';
import { randomSteps, runSteps, storeSubject } from '../test-support/store-model/index.js';
import { writesOf } from '../test-support/writes.js';
import { createMapStub, memoryGL } from '../test-utils.js';
import type { CustomLayerInterface } from '../view/layer/custom-layer.js';
import { TableLayerRenderer } from '../view/layer/table-retained.js';
import { RowsRenderer } from '../view/renderers/rows/rows-renderer.js';
import {
  type ConsistencyCheck,
  ConsistencyChecks,
  checkFeatureCache,
  checkIdIndex,
  checkSelection,
  checkWriteMarks,
  DRAWING_REBUILD_FRAMES,
} from './consistency.js';

function layer(id: string): Layer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    metadata: undefined,
    styleRule: undefined,
  };
}

function point(id: string, x: number, layerId = 'a'): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [x, 0] },
    layerId,
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked: false,
  };
}

type Kind = 'rows' | 'objects';

/** A Store whose reads given are others (the others read from the Store) */
function over(store: Store, reads: Record<string, unknown>): Store {
  return new Proxy(store, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in reads) return reads[prop];
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function storeOf(kind: Kind, selectionIdsLimit?: number): Store {
  return kind === 'rows'
    ? createTableStore(selectionIdsLimit === undefined ? {} : { selectionIdsLimit }).store
    : new MemoryStore();
}

/** A Store with the checks of the document and of the selection after each notification */
function checked(
  kind: Kind,
  options: { allowed?: ConsistencyCheck[]; selectionIdsLimit?: number } = {},
): { store: Store; failures: ConsistencyFailure[] } {
  const store = storeOf(kind, options.selectionIdsLimit);
  const failures: ConsistencyFailure[] = [];
  const checks = new ConsistencyChecks(
    { allowed: options.allowed ?? [], onFailure: (failure) => failures.push(failure) },
    { store, checkDrawing: () => [], checkDrawnWrites: () => [], checkDrawnRebuild: () => [] },
  );
  (store as DrawStore).setAfterNotify(() => checks.afterNotify());
  return { store, failures };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the option debug.checks', () => {
  it('is checked when the instance is created', () => {
    const { map } = createMapStub();
    expect(() => createDraw(map, { debug: 1 as never })).toThrow(DrawError);
    expect(() => createDraw(map, { debug: { checks: 'yes' as never } })).toThrow(DrawError);
    expect(() =>
      createDraw(map, { debug: { checks: { run: ['nothing' as ConsistencyCheck] } } }),
    ).toThrow(/must be an array of idIndex, selection, writeMarks, featureCache, drawing/);
    expect(() => createDraw(map, { debug: { other: true } as never })).toThrow(DrawError);
    const draw = createDraw(map, { debug: { checks: true } });
    expect(() => draw.options.update({ debug: {} } as never)).toThrow(/only be given when/);
    draw.destroy();
  });

  for (const kind of ['rows', 'objects'] as const) {
    it(`runs once each notification of the Store has gone out (${kind})`, () => {
      const { map } = createMapStub();
      const failures: ConsistencyFailure[] = [];
      const store = storeOf(kind) as unknown as PublicStore;
      const draw = createDraw(map, {
        store,
        initDefaultLayer: false,
        debug: { checks: { onFailure: (failure) => failures.push(failure) } },
      });
      const created = writesOf(draw).layers.create({ name: 'a' })!;
      const a = writesOf(draw).features.create({
        type: 'Point',
        geometry: { type: 'Point', coordinates: [0, 0] },
        layerId: created.id,
      })!;
      draw.selection.set('feature', [a.id]);
      expect(failures).toEqual([]);
      // A selection broken behind the Store: a row marked as selected in bulk, a feature
      // selected that is not there
      const internals = featureTablesInternals(draw.getStore().tables);
      const write = internals
        ? () => {
            internals.states.setBulk(Int32Array.of(internals.ids.handleOf(a.id)), true);
            writesOf(draw).features.update(a.id, { properties: { n: 1 } });
          }
        : () => (draw.getStore() as unknown as Store).setSelection('feature', ['nothing']);
      let thrown: unknown;
      try {
        write();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DrawError);
      expect((thrown as DrawError).code).toBe('invalidState');
      expect((thrown as DrawError).message).toContain('(selection)');
      expect(failures.map((f) => f.check)).toEqual(['selection']);
      // The write was made
      if (internals) expect(writesOf(draw).features.get(a.id)?.properties).toEqual({ n: 1 });
      draw.destroy();
    });
  }

  it('gives a check allowed to fail to onFailure, and reads no check that is not run', () => {
    const { store, failures } = checked('rows', { allowed: ['selection'] });
    store.createLayer(layer('a'));
    store.createFeature(point('p', 0));
    const internals = featureTablesInternals(store.tables)!;
    internals.states.setBulk(Int32Array.of(internals.ids.handleOf('p')), true);
    expect(() => store.updateFeature('p', { properties: { n: 1 } })).not.toThrow();
    expect(failures.map((f) => f.check)).toContain('selection');

    const only = createTableStore().store;
    const read = vi.fn((): string[] => ['broken']);
    const checks = new ConsistencyChecks(
      { run: ['idIndex'] },
      { store: only, checkDrawing: read, checkDrawnWrites: read, checkDrawnRebuild: read },
    );
    checks.afterFrame();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('each check finds the state it is about broken', () => {
  it('writeMarks: a frame that stamped rows and left the mark, marks past the Store and the group', () => {
    const store = createTableStore().store;
    store.createLayer(layer('a'));
    store.createFeature(point('p', 0));
    store.createFeature(point('q', 1));
    const internals = featureTablesInternals(store.tables)!;
    const keeper = writeMarkKeeperOf(store.tables)!;
    internals.flushVersions();
    keeper.watch();
    store.updateFeature('p', { properties: { n: 1 } });
    expect(checkWriteMarks(store)).toEqual([]);
    // Rows put into the delta in a frame that writes no value: stamped with the mark before
    store.transact(() => internals.toDelta([internals.ids.handleOf('q')]));
    expect(checkWriteMarks(store)).toEqual([
      'a frame stamped 1 rows, and the write mark went up 0 times',
    ]);
    expect(checkWriteMarks(store)).toEqual([]);
    // A row with a mark past its group, tables with a mark past the Store
    const place = internals.placeOf(internals.ids.handleOf('p'))!;
    place.group.marks[place.row] = place.group.mark + 1;
    internals.setWriteMark(keeper.mark + 1);
    const problems = checkWriteMarks(store);
    expect(problems[0]).toContain(`the Store is at the write mark ${keeper.mark}`);
    expect(problems[1]).toContain('past the mark');
  });

  it('featureCache: a feature kept changed by its reader, a row read where it is not', () => {
    const store = createTableStore().store;
    store.createLayer(layer('a'));
    store.createFeature(point('p', 0));
    store.createFeature(point('q', 1));
    const internals = featureTablesInternals(store.tables)!;
    internals.flushVersions();
    const cache = internals.featureCache;
    const changed = store.getFeature('p') as Feature;
    (changed.properties as Record<string, unknown>).n = 99;
    cache.watch();
    const p = internals.placeOf(internals.ids.handleOf('p'))!;
    expect(checkFeatureCache(store)).toEqual([
      `the feature kept for the row ${internals.ids.handleOf('p')} of the write mark ${p.group.marks[p.row]} is not the one its row makes now`,
    ]);
    // Given again, it is found too, and what is kept from now on is frozen
    expect(store.getFeature('p')).toBe(changed);
    expect(checkFeatureCache(store)[0]).toContain('is not the one its row makes now');
    const frozen = store.getFeature('q') as Feature;
    expect(Object.isFrozen((frozen.geometry as { coordinates: number[] }).coordinates)).toBe(true);
    expect(checkFeatureCache(store).length).toBe(1);
    // A row read from a group it is not read from any more
    const handle = internals.ids.handleOf('q');
    const before = internals.placeOf(handle)!;
    store.transact(() => internals.toDelta([handle]));
    store.updateFeature('q', { properties: { n: 10 } });
    cache.featureOf('a', before.group, before.row);
    cache.featureOf('a', before.group, before.row);
    expect(checkFeatureCache(store)).toContain(
      `the feature kept for the row ${handle} has the write mark ${before.group.marks[before.row]}, and its row ${internals.placeOf(handle)!.group.marks[internals.placeOf(handle)!.row]}`,
    );
  });

  it('idIndex: an item of a layer that names nothing, a member that is not in its group', () => {
    const items = ['p', 'g', 'gone'];
    const fake = {
      tables: undefined,
      listLayers: () => [{ ...layer('a'), items }],
      listGroups: () => [],
      getFeature: (id: string) =>
        id === 'p'
          ? point('p', 0)
          : id === 'm'
            ? { ...point('m', 1), groupId: 'other' }
            : undefined,
      getGroup: (id: string) =>
        id === 'g'
          ? { id: 'g', layerId: 'a', name: 'g', visible: true, locked: false, featureIds: ['m'] }
          : undefined,
    } as unknown as Store;
    const problems = checkIdIndex(fake);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('the feature "m" is a member of the group "g"');
    expect(problems[1]).toContain('the item "gone" of the layer "a" names nothing');
  });

  it('selection: a selected feature that is hidden, a selection with no type', () => {
    const store = new MemoryStore();
    store.createLayer(layer('a'));
    store.createFeature(point('p', 0));
    store.setSelection('feature', ['p']);
    expect(checkSelection(store)).toEqual([]);
    const hidden = over(store, { isHidden: (id: string) => id === 'p' });
    expect(checkSelection(hidden)).toEqual(['the selected feature "p" is hidden here']);
    const typeless = over(store, { getSelection: () => ({ type: null, ids: ['p'] }) });
    expect(checkSelection(typeless)[0]).toContain('nothing is selected, and the selection holds 1');
  });

  it('selection: a row marked as selected in bulk that is not selected', () => {
    const store = createTableStore().store;
    store.createLayer(layer('a'));
    store.createFeature(point('p', 0));
    expect(checkSelection(store)).toEqual([]);
    const internals = featureTablesInternals(store.tables)!;
    internals.states.setBulk(Int32Array.of(internals.ids.handleOf('p')), true);
    expect(checkSelection(store)[0]).toContain(
      'is marked as selected in bulk, and is not in the selection',
    );
  });
});

/** What a frame of the map gives the layer (a flat map) */
function renderInput(): CustomRenderMethodInput {
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const projectionData = {
    mainMatrix: identity,
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 0],
    projectionTransition: 0,
    fallbackMatrix: identity,
  };
  return {
    farZ: 1,
    nearZ: 0,
    fov: 0.6,
    modelViewProjectionMatrix: identity,
    projectionMatrix: identity,
    shaderData: { variantName: 'mercator', vertexShaderPrelude: '', define: '' },
    defaultProjectionData: projectionData,
    getProjectionData: () => projectionData,
  } as unknown as CustomRenderMethodInput;
}

describe('the check of what is drawn', () => {
  for (const kind of ['rows', 'objects'] as const) {
    it(`runs once a frame is drawn, and finds what the drawing keeps out of date (${kind})`, () => {
      // The checks of the instance, caught as they run after a frame
      let checks: ConsistencyChecks | null = null;
      const afterFrame = ConsistencyChecks.prototype.afterFrame;
      const spy = vi.spyOn(ConsistencyChecks.prototype, 'afterFrame').mockImplementation(function (
        this: ConsistencyChecks,
      ) {
        checks = this;
        afterFrame.call(this);
      });
      const stub = createMapStub();
      Object.assign(stub.map, { getPixelRatio: () => 1 });
      const failures: ConsistencyFailure[] = [];
      const draw = createDraw(stub.map, {
        store: storeOf(kind) as unknown as PublicStore,
        initDefaultLayer: false,
        debug: { checks: { onFailure: (failure) => failures.push(failure) } },
      });
      const created = writesOf(draw).layers.create({ name: 'a' })!;
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const feature = writesOf(draw).features.create({
          type: i % 2 === 0 ? 'Point' : 'LineString',
          geometry:
            i % 2 === 0
              ? { type: 'Point', coordinates: [i, 0] }
              : {
                  type: 'LineString',
                  coordinates: [
                    [i, 0],
                    [i + 0.5, 0.5],
                  ],
                },
          layerId: created.id,
          style: i === 3 ? { lineStyle: 'dashed' } : {},
        })!;
        ids.push(feature.id);
      }
      // A context that compiles every shader, and keeps what is written to it
      const memory = memoryGL().gl;
      const gl = new Proxy(memory, {
        get: (target, prop) =>
          prop === 'getShaderParameter' ? () => true : Reflect.get(target, prop),
      });
      const layers = [...stub.layers.values()] as unknown as Array<{
        onAdd?: (map: unknown, gl: WebGL2RenderingContext) => void;
        render: (gl: WebGL2RenderingContext, input: CustomRenderMethodInput) => void;
      }>;
      for (const slot of layers) slot.onAdd?.(stub.map, gl);
      const frame = (): void => {
        for (const slot of layers) slot.render(gl, renderInput());
        vi.advanceTimersByTime(50);
      };
      for (let i = 0; i < 3; i++) frame();
      expect(spy).toHaveBeenCalledTimes(3);
      expect(failures).toEqual([]);
      // Hidden here: the drawing keeps the feature (or the state of its row) until the next frame
      draw.hidden.add(ids[0]);
      expect(() => (checks as ConsistencyChecks | null)?.afterFrame()).toThrow(/\(drawing\)/);
      expect(failures.map((f) => f.check)).toEqual(['drawing']);
      if (process.env.STORE_MODEL_REPORT) console.log(kind, failures[0].problems);
      failures.length = 0;
      frame();
      expect(failures).toEqual([]);
      spy.mockRestore();
      draw.destroy();
    });
  }
});

/** A draw instance on a map that draws its frames, with every check on and its failures */
function drawnInstance(
  kind: Kind,
  options: {
    allowed?: ConsistencyCheck[];
    selectionIdsLimit?: number;
    checks?: false | { run: ConsistencyCheck[] };
  } = {},
) {
  const stub = createMapStub();
  Object.assign(stub.map, { getPixelRatio: () => 1 });
  const failures: ConsistencyFailure[] = [];
  const store = storeOf(kind, options.selectionIdsLimit);
  const draw = createDraw(stub.map, {
    store: store as unknown as PublicStore,
    initDefaultLayer: false,
    ...(options.checks !== false && {
      debug: {
        checks: {
          ...options.checks,
          allowed: options.allowed ?? ['idIndex', 'selection', 'drawing'],
          onFailure: (failure) => failures.push(failure),
        },
      },
    }),
  });
  const memory = memoryGL().gl;
  const gl = new Proxy(memory, {
    get: (target, prop) => (prop === 'getShaderParameter' ? () => true : Reflect.get(target, prop)),
  });
  const layers = [...stub.layers.values()] as unknown as Array<{
    onAdd?: (map: unknown, gl: WebGL2RenderingContext) => void;
    render: (gl: WebGL2RenderingContext, input: CustomRenderMethodInput) => void;
  }>;
  for (const slot of layers) slot.onAdd?.(stub.map, gl);
  const frame = (): void => {
    for (let i = 0; i < 3; i++) {
      for (const slot of layers) slot.render(gl, renderInput());
      vi.advanceTimersByTime(50);
    }
  };
  const tableRenderer = (layers[0] as unknown as CustomLayerInterface).getTableRenderer();
  return { draw, store, failures, frame, tableRenderer };
}

/** Counts the rows the checks of the drawing of the rows compare (so a test knows they ran) */
function countComparedRows(): { readonly count: () => number; readonly restore: () => void } {
  const spy = vi.spyOn(
    TableLayerRenderer.prototype as unknown as { compareRow: () => void },
    'compareRow',
  );
  return { count: () => spy.mock.calls.length, restore: () => spy.mockRestore() };
}

const SQUARE = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ],
};

/** Edits written by hand, a frame drawn after each, by name */
const DRAWN_EDITS: Readonly<
  Record<string, (draw: ReturnType<typeof createDraw>, layerId: string) => Array<() => void>>
> = {
  'a style written while the polygon is selected': (draw, layerId) => {
    const p = writesOf(draw).features.create({ type: 'Polygon', geometry: SQUARE, layerId })!;
    return [
      () => draw.selection.set('feature', [p.id]),
      () => writesOf(draw).features.update(p.id, { style: { fillColor: '#00aa44' } }),
      () =>
        writesOf(draw).features.update(p.id, {
          style: { strokeColor: '#3366ff', lineStyle: 'dotted' },
        }),
      () => draw.selection.clear(),
    ];
  },
  'a dashed polygon selected and deleted': (draw, layerId) => {
    const p = writesOf(draw).features.create({
      type: 'Polygon',
      geometry: SQUARE,
      layerId,
      style: { lineStyle: 'dashed' },
    })!;
    return [
      () => draw.selection.set('feature', [p.id]),
      () => writesOf(draw).features.delete(p.id),
    ];
  },
  'a line moved and hidden while selected': (draw, layerId) => {
    const l = writesOf(draw).features.create({
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
      layerId,
    })!;
    return [
      () => draw.selection.set('feature', [l.id]),
      () =>
        writesOf(draw).features.update(l.id, {
          geometry: {
            type: 'LineString',
            coordinates: [
              [0.5, 0],
              [1.5, 1],
            ],
          },
        }),
      () => writesOf(draw).features.update(l.id, { visible: false }),
      () => writesOf(draw).features.update(l.id, { visible: true }),
    ];
  },
  'a point moved in place and its color written': (draw, layerId) => {
    const p = writesOf(draw).features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0.2, 0.2] },
      layerId,
    })!;
    writesOf(draw).features.create({ type: 'Polygon', geometry: SQUARE, layerId });
    return [
      () =>
        writesOf(draw).features.update(p.id, {
          geometry: { type: 'Point', coordinates: [0.3, 0.25] },
        }),
      () => writesOf(draw).features.update(p.id, { style: { pointColor: '#00aa44' } }),
      () =>
        writesOf(draw).features.update(p.id, {
          geometry: { type: 'Point', coordinates: [0.4, 0.3] },
        }),
    ];
  },
  'a line made dashed, moved, and solid again': (draw, layerId) => {
    const line = (dx: number) => ({
      type: 'LineString' as const,
      coordinates: [
        [dx, 0],
        [dx + 0.5, 0.5],
        [dx + 1, 0],
      ],
    });
    const l = writesOf(draw).features.create({ type: 'LineString', geometry: line(0), layerId })!;
    writesOf(draw).features.create({ type: 'Polygon', geometry: SQUARE, layerId });
    return [
      () => writesOf(draw).features.update(l.id, { style: { lineStyle: 'dashed' } }),
      () => writesOf(draw).features.update(l.id, { geometry: line(0.25) }),
      () => writesOf(draw).features.update(l.id, { style: { lineStyle: 'solid', strokeWidth: 6 } }),
      () => writesOf(draw).features.update(l.id, { geometry: line(0.5) }),
    ];
  },
  'polygons given a style rule by their layer, and a value it reads written': (draw, layerId) => {
    const ids = [0, 1, 2].map(
      (i) =>
        writesOf(draw).features.create({
          type: 'Polygon',
          geometry: SQUARE,
          layerId,
          properties: { kind: i % 2 === 0 ? 'a' : 'b' },
        })!.id,
    );
    return [
      () =>
        writesOf(draw).layers.update(layerId, {
          styleRule: {
            kind: 'categorical',
            property: 'kind',
            map: { a: '#ff0000', b: '#0000ff' },
            other: '#888888',
          },
        }),
      () => writesOf(draw).features.update(ids[1], { properties: { kind: 'a' } }),
      () => writesOf(draw).layers.update(layerId, { styleRule: undefined }),
    ];
  },
  'a sketch of a vertex of a line moved, changed, and committed': (draw, layerId) => {
    const l = writesOf(draw).features.create({
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [0.5, 0.5],
          [1, 0],
        ],
      },
      layerId,
    })!;
    writesOf(draw).features.create({ type: 'Polygon', geometry: SQUARE, layerId });
    const edit = (y: number) => ({
      kind: 'vertexMove' as const,
      featureId: l.id,
      vertices: [{ ring: 0, index: 1 }],
      positions: [[0.5, y]],
    });
    let id = '';
    return [
      () => {
        id = draw.sketches.add({ edits: [edit(0.6)] })!.id;
      },
      () => draw.sketches.update(id, { edits: [edit(0.8)] }),
      () => draw.sketches.commit(id),
    ];
  },
  'a sketch of polygons turned, one of them deleted, and removed': (draw, layerId) => {
    const ids = [0, 1].map(
      (i) =>
        writesOf(draw).features.create({
          type: 'Polygon',
          geometry: {
            type: 'Polygon',
            coordinates: [SQUARE.coordinates[0].map(([x, y]) => [x + i * 2, y])],
          },
          layerId,
        })!.id,
    );
    let id = '';
    return [
      () => {
        id = draw.sketches.add({
          edits: [
            { kind: 'rotate', target: { featureIds: ids }, center: [1.5, 0.5], angleDegrees: 30 },
          ],
        })!.id;
      },
      () => writesOf(draw).features.delete(ids[0]),
      () => draw.sketches.remove(id),
    ];
  },
  'a sketch creating a line above a polygon, drawn on and committed': (draw, layerId) => {
    const p = writesOf(draw).features.create({ type: 'Polygon', geometry: SQUARE, layerId })!;
    writesOf(draw).features.create({ type: 'Polygon', geometry: SQUARE, layerId });
    const create = (x: number) => ({
      kind: 'create' as const,
      feature: {
        type: 'LineString',
        geometry: {
          type: 'LineString' as const,
          coordinates: [
            [0, 0],
            [x, 1],
          ],
        },
        layerId,
      },
      placedVertexCount: 1,
      below: p.id,
    });
    let id = '';
    return [
      () => {
        id = draw.sketches.add({ edits: [create(0.5)] })!.id;
      },
      () => draw.sketches.update(id, { edits: [create(0.9)] }),
      () => draw.sketches.commit(id),
    ];
  },
  'features hidden here, shown again and deleted': (draw, layerId) => {
    const a = writesOf(draw).features.create({ type: 'Polygon', geometry: SQUARE, layerId })!;
    const b = writesOf(draw).features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0.5, 0.5] },
      layerId,
    })!;
    return [
      () => draw.hidden.add(a.id),
      () => draw.hidden.remove(a.id),
      () => writesOf(draw).features.delete(b.id),
    ];
  },
};

/**
 * The checks a failure of which is noted and lets the edits go on (the checks of the drawing of
 * the rows are never allowed to fail on the edits and on the sequences drawn)
 */
const OLD_CHECKS: ConsistencyCheck[] = ['idIndex', 'selection', 'featureCache', 'drawing'];

/** The edits whose checks fail now, by Store (and drawing), with the checks */
const KNOWN_DRAWN: Readonly<
  Record<string, Partial<Record<Kind | 'rows by kind', readonly ConsistencyCheck[]>>>
> = {};

describe('edits written by hand, a frame drawn after each, with every check on', () => {
  // A fixed sequence is short: what the drawing keeps is made again each frame
  beforeEach(() => {
    ConsistencyChecks.rebuildEvery = 1;
  });
  afterEach(() => {
    ConsistencyChecks.rebuildEvery = DRAWING_REBUILD_FRAMES;
  });

  for (const kind of ['rows', 'rows by kind', 'objects'] as const) {
    for (const [name, edits] of Object.entries(DRAWN_EDITS)) {
      it(`${name} (${kind})`, () => {
        const { draw, failures, frame, tableRenderer } = drawnInstance(
          kind === 'objects' ? 'objects' : 'rows',
          { allowed: OLD_CHECKS },
        );
        // The rows drawn by the renderers of their kinds, as on the terrain and the globe
        if (kind === 'rows by kind') tableRenderer?.setDrawingByKind(true);
        const compared = countComparedRows();
        const layerId = writesOf(draw).layers.create({ name: 'a' })!.id;
        const steps = edits(draw, layerId);
        frame();
        for (const step of steps) {
          step();
          frame();
        }
        // The rows are compared (the Store of objects has none)
        if (kind === 'rows') expect(compared.count()).toBeGreaterThan(0);
        compared.restore();
        if (process.env.STORE_MODEL_REPORT && failures.length > 0) {
          console.log(`${kind} | ${name} | ${failures[0].check}: ${failures[0].problems[0]}`);
        }
        const broken = [...new Set(failures.map((f) => f.check))].sort();
        expect(broken).toEqual([...(KNOWN_DRAWN[name]?.[kind] ?? [])].sort());
        draw.destroy();
      });
    }
  }
});

/** The checks that fail now on the sequences of the reference model, by Store */
const KNOWN_BROKEN: Readonly<
  Record<'rows' | 'rows-bulk' | 'objects', readonly ConsistencyCheck[]>
> = {
  rows: [],
  'rows-bulk': [],
  objects: [],
};

describe('the sequences of the reference model of the Store, with every check on', () => {
  for (const kind of ['rows', 'rows-bulk', 'objects'] as const) {
    it(`fail no check but the known ones (${kind})`, () => {
      const broken = new Set<ConsistencyCheck>();
      for (let seed = 1; seed <= 100; seed++) {
        const steps = randomSteps(seed, { length: 60 });
        runSteps(steps, () => {
          const { store, failures } = checked(kind === 'objects' ? 'objects' : 'rows', {
            allowed: ['idIndex', 'selection'],
            ...(kind === 'rows-bulk' && { selectionIdsLimit: 2 }),
          });
          const subject = storeSubject(store, () => {
            vi.advanceTimersByTime(1_000);
          });
          return {
            ...subject,
            read: () => {
              for (const failure of failures) broken.add(failure.check);
              if (process.env.STORE_MODEL_REPORT && failures.length > 0) {
                console.log(
                  `${kind} | seed ${seed} | ${failures[0].check}: ${failures[0].problems[0]}`,
                );
              }
              failures.length = 0;
              return subject.read();
            },
          };
        });
      }
      expect([...broken].sort()).toEqual([...KNOWN_BROKEN[kind]].sort());
    });
  }
});

/**
 * The checks that fail now on the sequences of the reference model drawn, by Store: the checks
 * of the drawing of the rows are never allowed to fail there (a failure of another is noted and
 * the sequence goes on)
 */
const KNOWN_BROKEN_DRAWN: Readonly<
  Record<'rows' | 'rows-bulk' | 'rows by kind', readonly ConsistencyCheck[]>
> = {
  rows: [],
  'rows-bulk': [],
  'rows by kind': [],
};

describe('the sequences of the reference model of the Store drawn, with every check on', () => {
  for (const kind of ['rows', 'rows-bulk', 'rows by kind'] as const) {
    it(`fail no check but the known ones, a frame drawn after each step (${kind})`, () => {
      const broken = new Set<ConsistencyCheck>();
      const differed: string[] = [];
      const compared = countComparedRows();
      for (let seed = 1; seed <= 40; seed++) {
        const steps = randomSteps(seed, { length: 60 });
        const result = runSteps(steps, () => {
          const drawn = drawnInstance('rows', {
            allowed: OLD_CHECKS,
            ...(kind === 'rows-bulk' && { selectionIdsLimit: 2 }),
          });
          if (kind === 'rows by kind') drawn.tableRenderer?.setDrawingByKind(true);
          const subject = storeSubject(drawn.store, drawn.frame);
          return {
            ...subject,
            read: () => {
              for (const failure of drawn.failures) broken.add(failure.check);
              if (process.env.STORE_MODEL_REPORT && drawn.failures.length > 0) {
                const failure = drawn.failures[0];
                console.log(
                  `${kind} drawn | seed ${seed} | ${failure.check}: ${failure.problems[0]}`,
                );
              }
              drawn.failures.length = 0;
              return subject.read();
            },
            dispose: () => drawn.draw.destroy(),
          };
        });
        if (result) differed.push(`seed ${seed} step ${result.step}: ${result.reason}`);
      }
      expect(differed).toEqual([]);
      // The rows drawn in one draw are compared (by kind, their kinds and their state only)
      if (kind !== 'rows by kind') expect(compared.count()).toBeGreaterThan(0);
      compared.restore();
      expect([...broken].sort()).toEqual([...KNOWN_BROKEN_DRAWN[kind]].sort());
    });
  }
});

describe('the checks of the drawing of the rows find a rule of the drawing broken', () => {
  beforeEach(() => {
    ConsistencyChecks.rebuildEvery = 1;
  });
  afterEach(() => {
    ConsistencyChecks.rebuildEvery = DRAWING_REBUILD_FRAMES;
    vi.restoreAllMocks();
  });

  /** The checks that failed on the frames after an edit, with the drawing of the rows checked */
  function failedAfter(
    make: (draw: ReturnType<typeof createDraw>, layerId: string) => () => void,
  ): string[] {
    const { draw, failures, frame } = drawnInstance('rows', {
      allowed: ['idIndex', 'selection', 'drawing', 'drawingWrites', 'drawingRebuild'],
    });
    const layerId = writesOf(draw).layers.create({ name: 'a' })!.id;
    const edit = make(draw, layerId);
    frame();
    expect(failures).toEqual([]);
    edit();
    frame();
    if (process.env.STORE_MODEL_REPORT) {
      for (const failure of failures) console.log(failure.check, failure.problems[0]);
    }
    draw.destroy();
    return [...new Set(failures.map((failure) => failure.check))].sort();
  }

  const line = {
    type: 'LineString' as const,
    coordinates: [
      [0, 0],
      [0.5, 0.5],
      [1, 0],
    ],
  };

  it('drawingRebuild: a write of the style of a row is not told to the drawing', () => {
    const rowsWritten = TableLayerRenderer.prototype.rowsWritten;
    vi.spyOn(TableLayerRenderer.prototype, 'rowsWritten').mockImplementation(function (
      this: TableLayerRenderer,
      layerId,
      writes,
    ) {
      // The writes of the style are lost on their way to the drawing
      const told = writes.filter((write) => (write.what & ROW_WRITE_STYLE) === 0);
      rowsWritten.call(this, layerId, told);
    });
    const failed = failedAfter((draw, layerId) => {
      const l = writesOf(draw).features.create({ type: 'LineString', geometry: line, layerId })!;
      return () => writesOf(draw).features.update(l.id, { style: { strokeColor: '#00aa44' } });
    });
    expect(failed).toEqual(['drawingRebuild']);
  });

  it('drawingRebuild: the styles of the rows are not resolved again for a new style rule', () => {
    vi.spyOn(
      TableLayerRenderer.prototype as unknown as {
        restyleGroup: (
          cache: { styleGeneration: number },
          group: { styleGeneration: number },
        ) => void;
      },
      'restyleGroup',
    ).mockImplementation((cache, group) => {
      // Marked as resolved, and nothing resolved
      group.styleGeneration = cache.styleGeneration;
    });
    const failed = failedAfter((draw, layerId) => {
      writesOf(draw).features.create({
        type: 'Polygon',
        geometry: SQUARE,
        layerId,
        properties: { kind: 'a' },
      });
      return () =>
        writesOf(draw).layers.update(layerId, {
          styleRule: {
            kind: 'categorical',
            property: 'kind',
            map: { a: '#ff0000' },
            other: '#888888',
          },
        });
    });
    expect(failed).toEqual(['drawingRebuild']);
  });

  it('drawingWrites: a write of the coordinates of a row in place is written wrong', () => {
    const patchCoords = RowsRenderer.prototype.patchCoords;
    vi.spyOn(RowsRenderer.prototype, 'patchCoords').mockImplementation(function (
      this: RowsRenderer,
      chunk,
      coordFrom,
      values,
      count,
    ) {
      // Half a degree off
      const wrong = Array.from(values, (value) => value + 0.5);
      patchCoords.call(this, chunk, coordFrom, wrong, count);
    });
    const failed = failedAfter((draw, layerId) => {
      const p = writesOf(draw).features.create({
        type: 'Point',
        geometry: { type: 'Point', coordinates: [0.2, 0.2] },
        layerId,
      })!;
      return () =>
        writesOf(draw).features.update(p.id, {
          geometry: { type: 'Point', coordinates: [0.3, 0.3] },
        });
    });
    expect(failed).toEqual(['drawingRebuild', 'drawingWrites']);
  });
});

describe('what the drawing keeps of what it writes to the GPU', () => {
  /** What the drawing of the rows keeps, after a few frames of a layer with rows */
  function kept(checks: false | { run: ConsistencyCheck[] } | undefined) {
    const drawn = drawnInstance('rows', { checks });
    const layerId = writesOf(drawn.draw).layers.create({ name: 'a' })!.id;
    writesOf(drawn.draw).features.create({ type: 'Polygon', geometry: SQUARE, layerId });
    drawn.frame();
    const renderer = drawn.tableRenderer as unknown as {
      renderers: { rows: { copies: unknown } } | null;
      stateCopies: unknown;
    };
    const result = {
      chunks: renderer.renderers?.rows.copies ?? null,
      states: renderer.stateCopies,
    };
    drawn.draw.destroy();
    return result;
  }

  it('is nothing without the checks of the drawing of the rows', () => {
    for (const checks of [false, { run: ['idIndex', 'drawing'] }] as const) {
      const { chunks, states } = kept(checks === false ? false : { run: [...checks.run] });
      expect(chunks).toBeNull();
      expect(states).toBeNull();
    }
  });

  it('is what the GPU holds while one of them runs', () => {
    for (const run of [['drawingWrites'], ['drawingRebuild'], undefined] as const) {
      const { chunks, states } = kept(run ? { run: [...run] } : undefined);
      expect(chunks).not.toBeNull();
      expect(states).not.toBeNull();
    }
  });
});
