// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The checks of the state of an instance (`debug.checks`)
 *
 * - The option is checked, and only given at creation
 * - The checks of the document and of the selection run once each notification of the Store has
 *   gone out, and a failure throws `DrawError` (`invalid-state`) from the write that ended the
 *   transaction; a check allowed to fail is given to `onFailure` and not thrown, a check not run
 *   is not read
 * - Each check finds the state it is about broken
 * - The check of what is drawn runs once a frame is drawn
 * - The sequences of the reference model of the rows run on both Stores with every check on: the
 *   checks that fail now are listed (`KNOWN_BROKEN`)
 */

import type { CustomRenderMethodInput } from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDraw } from '../api/draw.js';
import type { Store as PublicStore } from '../api/extension/store.js';
import type { ConsistencyFailure } from '../api/options.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { writeMarkKeeperOf } from '../feature-table/write-marks.js';
import { DrawError } from '../shared/draw-error.js';
import type { DrawStore } from '../store/draw-store.js';
import { MemoryStore } from '../store/memory.js';
import type { Store } from '../store/store.js';
import { createTableStore } from '../store/table-memory.js';
import type { Feature, Layer } from '../store/types.js';
import { randomSteps, runSteps, storeSubject } from '../test-support/kasane-model/index.js';
import { createMapStub, memoryGL } from '../test-utils.js';
import {
  type ConsistencyCheck,
  ConsistencyChecks,
  checkIdIndex,
  checkSelection,
  checkWriteMarks,
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

function storeOf(kind: Kind, holdLimit?: number): Store {
  return kind === 'rows'
    ? createTableStore(holdLimit === undefined ? {} : { holdLimit }).store
    : new MemoryStore();
}

/** A Store with the checks of the document and of the selection after each notification */
function checked(
  kind: Kind,
  options: { allowed?: ConsistencyCheck[]; holdLimit?: number } = {},
): { store: Store; failures: ConsistencyFailure[] } {
  const store = storeOf(kind, options.holdLimit);
  const failures: ConsistencyFailure[] = [];
  const checks = new ConsistencyChecks(
    { allowed: options.allowed ?? [], onFailure: (failure) => failures.push(failure) },
    { store, checkDrawing: () => [] },
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
    ).toThrow(/must be an array of id-index, selection, write-marks, drawing/);
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
      const created = draw.layers.create({ name: 'a' })!;
      const a = draw.features.create({
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
            draw.features.update(a.id, { properties: { n: 1 } });
          }
        : () => (draw.getStore() as unknown as Store).setSelection('feature', ['nothing']);
      let thrown: unknown;
      try {
        write();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DrawError);
      expect((thrown as DrawError).code).toBe('invalid-state');
      expect((thrown as DrawError).message).toContain('(selection)');
      expect(failures.map((f) => f.check)).toEqual(['selection']);
      // The write was made
      if (internals) expect(draw.features.get(a.id)?.properties).toEqual({ n: 1 });
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
      { run: ['id-index'] },
      { store: only, checkDrawing: read },
    );
    checks.afterFrame();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('each check finds the state it is about broken', () => {
  it('write-marks: a frame that stamped rows and left the mark, marks past the Store and the group', () => {
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

  it('id-index: an item of a layer that names nothing, a member that is not in its group', () => {
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
      const created = draw.layers.create({ name: 'a' })!;
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const feature = draw.features.create({
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
      if (process.env.KASANE_MODEL_REPORT) console.log(kind, failures[0].problems);
      failures.length = 0;
      frame();
      expect(failures).toEqual([]);
      spy.mockRestore();
      draw.destroy();
    });
  }
});

/** A draw instance on a map that draws its frames, with every check on and its failures */
function drawnInstance(kind: Kind) {
  const stub = createMapStub();
  Object.assign(stub.map, { getPixelRatio: () => 1 });
  const failures: ConsistencyFailure[] = [];
  const draw = createDraw(stub.map, {
    store: storeOf(kind) as unknown as PublicStore,
    initDefaultLayer: false,
    debug: {
      checks: {
        allowed: ['id-index', 'selection', 'drawing'],
        onFailure: (failure) => failures.push(failure),
      },
    },
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
  return { draw, failures, frame };
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
    const p = draw.features.create({ type: 'Polygon', geometry: SQUARE, layerId })!;
    return [
      () => draw.selection.set('feature', [p.id]),
      () => draw.features.update(p.id, { style: { fillColor: '#00aa44' } }),
      () => draw.features.update(p.id, { style: { strokeColor: '#3366ff', lineStyle: 'dotted' } }),
      () => draw.selection.clear(),
    ];
  },
  'a dashed polygon selected and deleted': (draw, layerId) => {
    const p = draw.features.create({
      type: 'Polygon',
      geometry: SQUARE,
      layerId,
      style: { lineStyle: 'dashed' },
    })!;
    return [() => draw.selection.set('feature', [p.id]), () => draw.features.delete(p.id)];
  },
  'a line moved and hidden while selected': (draw, layerId) => {
    const l = draw.features.create({
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
        draw.features.update(l.id, {
          geometry: {
            type: 'LineString',
            coordinates: [
              [0.5, 0],
              [1.5, 1],
            ],
          },
        }),
      () => draw.features.update(l.id, { visible: false }),
      () => draw.features.update(l.id, { visible: true }),
    ];
  },
};

/** The edits whose checks fail now, by Store, with the checks */
const KNOWN_DRAWN: Readonly<Record<string, Partial<Record<Kind, readonly ConsistencyCheck[]>>>> =
  {};

describe('edits written by hand, a frame drawn after each, with every check on', () => {
  for (const kind of ['rows', 'objects'] as const) {
    for (const [name, edits] of Object.entries(DRAWN_EDITS)) {
      it(`${name} (${kind})`, () => {
        const { draw, failures, frame } = drawnInstance(kind);
        const layerId = draw.layers.create({ name: 'a' })!.id;
        const steps = edits(draw, layerId);
        frame();
        for (const step of steps) {
          step();
          frame();
        }
        if (process.env.KASANE_MODEL_REPORT && failures.length > 0) {
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

describe('the sequences of the reference model of the rows, with every check on', () => {
  for (const kind of ['rows', 'rows-bulk', 'objects'] as const) {
    it(`fail no check but the known ones (${kind})`, () => {
      const broken = new Set<ConsistencyCheck>();
      for (let seed = 1; seed <= 100; seed++) {
        const steps = randomSteps(seed, { length: 60 });
        runSteps(steps, () => {
          const { store, failures } = checked(kind === 'objects' ? 'objects' : 'rows', {
            allowed: ['id-index', 'selection'],
            ...(kind === 'rows-bulk' && { holdLimit: 2 }),
          });
          const subject = storeSubject(store, () => {
            vi.advanceTimersByTime(1_000);
          });
          return {
            ...subject,
            read: () => {
              for (const failure of failures) broken.add(failure.check);
              if (process.env.KASANE_MODEL_REPORT && failures.length > 0) {
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
