// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A move, a rotation, a resize and a drag of vertices of the select mode are shown by a sketch of
 * this client: nothing is written while they go on, the values the sketch gives over the features
 * as they are then are written once let go, and nothing is written when they are cancelled. Over a
 * Store of rows the rows moved as a whole are drawn moved by a moving set, whatever their number,
 * their values untouched. What the drag edits is not hit while it goes on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Draw } from '../../api/draw.js';
import { createDrawOnEngine } from '../../api/impl/create-draw.js';
import type { Engine } from '../../api/impl/engine.js';
import { createEngine } from '../../api/impl/engine.js';
import type { HubEvents } from '../../api/impl/events.js';
import type { FeaturePatch } from '../../api/model.js';
import type { DragNormalizedEvent, MouseNormalizedEvent } from '../../dispatcher/types.js';
import {
  BULK_MOVE_SET,
  SKETCH_MOVE_SET,
  STATE_MOVE_MASK,
  STATE_MOVE_SHIFT,
} from '../../feature-table/feature-row-states.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature } from '../../store/types.js';
import { writesOf } from '../../test-support/writes.js';
import { createMapStub } from '../../test-utils.js';

type Kind = 'objects' | 'rows';

const KINDS: readonly Kind[] = ['objects', 'rows'];

function square(id: string, x: number, y = 0): Feature {
  return {
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x, y],
          [x + 1, y],
          [x + 1, y + 1],
          [x, y + 1],
          [x, y],
        ],
      ],
    },
    layerId: 'l',
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked: false,
  };
}

let engine: Engine;
let draw: Draw;
let store: Store;
let writes: string[];
let events: Array<[string, unknown]>;

function open(kind: Kind, ids: readonly string[], selectionIdsLimit?: number): void {
  vi.useFakeTimers();
  store = kind === 'rows' ? createTableStore({ selectionIdsLimit }).store : new MemoryStore();
  store.createLayer({
    id: 'l',
    name: 'l',
    visible: true,
    locked: false,
    opacity: 1,
    ...(kind === 'rows' ? { kind: 'table' as const } : { items: [] }),
    styleRule: undefined,
    metadata: undefined,
  });
  ids.forEach((id, i) => {
    store.createFeature(square(id, i * 3));
  });
  engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  writes = [];
  draw.on('change', () => writes.push('change'));
  events = [];
  const names = ['sketch.added', 'sketch.removed', 'drag.started', 'drag.ended'] as const;
  for (const name of names) {
    engine.events.on(name, (payload: HubEvents[typeof name]) => events.push([name, payload]));
  }
}

afterEach(() => {
  draw.destroy();
  vi.useRealTimers();
});

function event<T extends MouseNormalizedEvent | DragNormalizedEvent>(
  type: T['type'],
  lng: number,
  lat: number,
  start?: [number, number],
): T {
  const point = engine.map.project([lng, lat]);
  const from = start ? engine.map.project(start) : point;
  const inert = {
    preventDefault: () => {},
    stopPropagation: () => {},
    button: 0,
    buttons: 1,
    clientX: point.x,
    clientY: point.y,
  };
  return {
    type,
    point: { x: point.x, y: point.y },
    lngLat: { lng, lat },
    originalEvent: inert as unknown as MouseEvent,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    dragStartPoint: { x: from.x, y: from.y },
    dragStartLngLat: start ? { lng: start[0], lat: start[1] } : { lng, lat },
  } as unknown as T;
}

const FROM: [number, number] = [0.5, 0.5];

/** Presses the square at the origin and moves the pointer, not letting go */
function press(...moves: ReadonlyArray<[number, number]>): void {
  const router = engine.inputRouter;
  router.dispatch(event<MouseNormalizedEvent>('mousedown', FROM[0], FROM[1]));
  router.dispatch(event<DragNormalizedEvent>('dragstart', FROM[0], FROM[1], FROM));
  for (const [lng, lat] of moves) {
    router.dispatch(event<DragNormalizedEvent>('dragmove', lng, lat, FROM));
  }
}

function letGo(lng: number, lat: number): void {
  engine.inputRouter.dispatch(event<DragNormalizedEvent>('dragend', lng, lat, FROM));
}

function corner(feature: Feature | undefined): number[] | undefined {
  return (feature?.geometry as { coordinates: number[][][] } | undefined)?.coordinates[0][0];
}

function near(actual: number[] | undefined, expected: readonly number[]): void {
  expect(Math.abs((actual?.[0] as number) - (expected[0] as number))).toBeLessThan(1e-6);
  expect(Math.abs((actual?.[1] as number) - (expected[1] as number))).toBeLessThan(1e-6);
}

function setOf(id: string): number {
  const tables = draw.getStore().tables;
  const internals = featureTablesInternals(tables);
  const state = internals?.states.stateOf(tables?.getRowRef(id) ?? -1) ?? 0;
  return (state & STATE_MOVE_MASK) >> STATE_MOVE_SHIFT;
}

describe.each(KINDS)('a drag of vertices over a Store of %s', (kind) => {
  /** The second corner of the square, as the document or the drawing has it */
  const second = (feature: unknown): number[] | undefined =>
    (feature as Feature | undefined)?.geometry.type === 'Polygon'
      ? ((feature as Feature).geometry as { coordinates: number[][][] }).coordinates[0][1]
      : undefined;
  const third = (feature: unknown): number[] | undefined =>
    ((feature as Feature | undefined)?.geometry as { coordinates: number[][][] } | undefined)
      ?.coordinates[0][2];

  /** Presses a point and moves the pointer from it */
  function pressAt(from: [number, number], ...moves: ReadonlyArray<[number, number]>): void {
    const router = engine.inputRouter;
    router.dispatch(event<MouseNormalizedEvent>('mousedown', from[0], from[1]));
    router.dispatch(event<DragNormalizedEvent>('dragstart', from[0], from[1], from));
    for (const [lng, lat] of moves) {
      router.dispatch(event<DragNormalizedEvent>('dragmove', lng, lat, from));
    }
  }

  function letGoAt(lng: number, lat: number, from: [number, number]): void {
    engine.inputRouter.dispatch(event<DragNormalizedEvent>('dragend', lng, lat, from));
  }

  const CORNER: [number, number] = [1, 0];

  beforeEach(() => {
    open(kind, ['a']);
    draw.selection.set('feature', ['a']);
  });

  it('writes nothing while a vertex is dragged, and writes it once let go', () => {
    const update = vi.spyOn(store, 'updateFeature');
    pressAt(CORNER, [1.5, -0.5], [2, -1]);
    expect(writes).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    near(second(writesOf(draw).features.get('a')), [1, 0]);
    near(second(draw.rendered.get('a')), [2, -1]);
    letGoAt(2, -1, CORNER);
    expect(writes).toEqual(['change']);
    expect(update.mock.calls.map(([id]) => id)).toEqual(['a']);
    near(second(writesOf(draw).features.get('a')), [2, -1]);
    expect(events[events.length - 2]?.[1]).toMatchObject({ reason: 'committed' });
    expect(events[events.length - 1]).toEqual([
      'drag.ended',
      { kind: 'vertex', featureIds: ['a'], cancelled: false },
    ]);
  });

  it('writes nothing once a drag of a vertex is cancelled', () => {
    pressAt(CORNER, [2, -1]);
    engine.modeManager.getHandler()?.onDragCancel?.(event('dragcancel', 2, -1, CORNER));
    expect(writes).toEqual([]);
    near(second(draw.rendered.get('a')), [1, 0]);
    expect(events[events.length - 1]?.[1]).toMatchObject({ cancelled: true });
  });

  it('keeps a vertex another writer moves meanwhile: both moves stay', () => {
    pressAt(CORNER, [2, -1]);
    const moved = structuredClone(square('a', 0).geometry) as { coordinates: number[][][] };
    (moved.coordinates[0] as number[][])[2] = [5, 5];
    store.updateFeature('a', { geometry: moved as Feature['geometry'] });
    near(third(draw.rendered.get('a')), [5, 5]);
    near(second(draw.rendered.get('a')), [2, -1]);
    letGoAt(2, -1, CORNER);
    near(second(writesOf(draw).features.get('a')), [2, -1]);
    near(third(writesOf(draw).features.get('a')), [5, 5]);
  });

  it('adds nothing while a midpoint is dragged, and adds the vertex once let go', () => {
    const from: [number, number] = [0.5, 0];
    pressAt(from, [0.5, -1]);
    expect(writes).toEqual([]);
    const positions = (feature: unknown) =>
      ((feature as Feature).geometry as { coordinates: number[][][] }).coordinates[0].length;
    expect(positions(writesOf(draw).features.get('a'))).toBe(5);
    expect(positions(draw.rendered.get('a'))).toBe(6);
    near(second(draw.rendered.get('a')), [0.5, -1]);
    letGoAt(0.5, -1, from);
    expect(writes).toEqual(['change']);
    expect(positions(writesOf(draw).features.get('a'))).toBe(6);
    near(second(writesOf(draw).features.get('a')), [0.5, -1]);
  });

  it('adds no vertex once a drag of a midpoint is cancelled', () => {
    const from: [number, number] = [0.5, 0];
    pressAt(from, [0.5, -1]);
    engine.modeManager.getHandler()?.onDragCancel?.(event('dragcancel', 0.5, -1, from));
    expect(writes).toEqual([]);
    const polygon = writesOf(draw).features.get('a')?.geometry as { coordinates: number[][][] };
    expect(polygon.coordinates[0]).toHaveLength(5);
  });

  it('does not hit the feature whose vertex is dragged', () => {
    const { shapes } = engine.context;
    const handle = store.tables?.getRowRef('a');
    const hit = (): boolean =>
      handle === undefined
        ? shapes.hitFeatures().some((feature) => feature.id === 'a')
        : shapes.hitRowsLeftOut()?.(handle) !== true;
    expect(hit()).toBe(true);
    pressAt(CORNER, [2, -1]);
    expect(hit()).toBe(false);
    letGoAt(2, -1, CORNER);
    expect(hit()).toBe(true);
  });
});

describe.each(KINDS)('a drag of a handle of a provider over a Store of %s', (kind) => {
  const FROM_HANDLE: [number, number] = [0.5, 3];
  /** The patches the handle gives, by the position of the pointer */
  let patchAt: (lng: number) => FeaturePatch | null;
  let ended: Array<number | undefined>;

  beforeEach(() => {
    open(kind, ['a']);
    patchAt = (lng) => ({ properties: { at: lng } });
    ended = [];
    draw.extensions.handleProviders.add({
      name: 'grip',
      handles: () => [{ id: 'g', kind: 'resize', position: FROM_HANDLE }],
      onHandleDrag: (_feature, _handle, pointer) => patchAt(pointer.lngLat[0] as number),
      onHandleDragEnd: (feature) => {
        ended.push(feature?.properties.at as number | undefined);
      },
    });
    draw.selection.set('feature', ['a']);
  });

  function pressHandle(...moves: readonly number[]): void {
    const router = engine.inputRouter;
    const [lng, lat] = FROM_HANDLE;
    router.dispatch(event<MouseNormalizedEvent>('mousedown', lng, lat));
    router.dispatch(event<DragNormalizedEvent>('dragstart', lng, lat, FROM_HANDLE));
    for (const x of moves) {
      router.dispatch(event<DragNormalizedEvent>('dragmove', x, lat, FROM_HANDLE));
    }
  }

  const letGoHandle = (lng: number): void => {
    engine.inputRouter.dispatch(
      event<DragNormalizedEvent>('dragend', lng, FROM_HANDLE[1], FROM_HANDLE),
    );
  };

  it('shows its patches, writes nothing while it goes on, and writes once let go', () => {
    pressHandle(1, 2);
    expect(writes).toEqual([]);
    expect(writesOf(draw).features.get('a')?.properties.at).toBeUndefined();
    expect(draw.rendered.get('a')?.properties.at).toBe(2);
    letGoHandle(3);
    expect(writes).toEqual(['change']);
    expect(writesOf(draw).features.get('a')?.properties.at).toBe(3);
    expect(ended).toEqual([3]);
    expect(draw.sketches.count()).toBe(0);
  });

  it('keeps what the patches of the earlier moves changed', () => {
    let move = 0;
    patchAt = () => ({ properties: { [`key${++move}`]: move } });
    pressHandle(1, 2);
    letGoHandle(3);
    expect(writesOf(draw).features.get('a')?.properties).toMatchObject({
      key1: 1,
      key2: 2,
      key3: 3,
    });
  });

  it('writes nothing once cancelled, and tells the end to the provider', () => {
    pressHandle(1, 2);
    engine.modeManager.getHandler()?.onDragCancel?.(event('dragcancel', 2, 3, FROM_HANDLE));
    expect(writes).toEqual([]);
    expect(draw.rendered.get('a')?.properties.at).toBeUndefined();
    expect(ended).toEqual([undefined]);
    letGoHandle(2);
    expect(ended).toEqual([undefined]);
  });

  it('writes nothing when its last call gives no patch', () => {
    pressHandle(1);
    patchAt = () => null;
    letGoHandle(2);
    expect(writes).toEqual([]);
    expect(draw.sketches.count()).toBe(0);
  });

  it('writes nothing when its patches give the feature what it has', () => {
    writesOf(draw).features.update('a', { properties: { at: 5 } });
    writes.length = 0;
    pressHandle(1);
    letGoHandle(5);
    expect(writes).toEqual([]);
    expect(draw.sketches.count()).toBe(0);
  });

  it('writes nothing once its feature is locked', () => {
    pressHandle(1);
    writesOf(draw).features.update('a', { locked: true });
    writes.length = 0;
    letGoHandle(2);
    expect(writes).toEqual([]);
    expect(writesOf(draw).features.get('a')?.properties.at).toBeUndefined();
  });
});

describe.each(KINDS)('a drag of a handle shown by a sketch of its extension over %s', (kind) => {
  it('leaves the features of the sketch out of the hits while it goes on', () => {
    open(kind, ['a']);
    const FROM_HANDLE: [number, number] = [0.5, 3];
    let sketch: string | null = null;
    draw.extensions.handleProviders.add({
      name: 'own',
      handles: () => [{ id: 'g', kind: 'resize', position: FROM_HANDLE }],
      onHandleDragStart: () => {
        sketch = draw.sketches.add({
          edits: [{ kind: 'set', featureId: 'a', patch: { properties: { at: 1 } } }],
        })?.id as string;
        return true;
      },
      onHandleDrag: () => null,
      onHandleDragEnd: () => {
        draw.sketches.remove(sketch as string);
      },
    });
    draw.selection.set('feature', ['a']);
    const { shapes } = engine.context;
    const handle = store.tables?.getRowRef('a');
    const hit = (): boolean =>
      handle === undefined
        ? shapes.hitFeatures().some((feature) => feature.id === 'a')
        : shapes.hitRowsLeftOut()?.(handle) !== true;
    const router = engine.inputRouter;
    const [lng, lat] = FROM_HANDLE;
    router.dispatch(event<MouseNormalizedEvent>('mousedown', lng, lat));
    router.dispatch(event<DragNormalizedEvent>('dragstart', lng, lat, FROM_HANDLE));
    expect(hit()).toBe(false);
    router.dispatch(event<DragNormalizedEvent>('dragend', lng, lat, FROM_HANDLE));
    expect(hit()).toBe(true);
  });
});

describe('a drag of a vertex over a Store of rows', () => {
  it('draws a frame over the row of the delta it is drawn as, not making the delta again', () => {
    open('rows', ['a']);
    draw.selection.set('feature', ['a']);
    const router = engine.inputRouter;
    const from: [number, number] = [1, 0];
    router.dispatch(event<MouseNormalizedEvent>('mousedown', 1, 0));
    router.dispatch(event<DragNormalizedEvent>('dragstart', 1, 0, from));
    router.dispatch(event<DragNormalizedEvent>('dragmove', 1.5, 0, from));
    const internals = featureTablesInternals(draw.getStore().tables);
    const delta = internals?.rowTable('l')?.delta;
    const group = delta?.group;
    router.dispatch(event<DragNormalizedEvent>('dragmove', 2, 0, from));
    expect(delta?.group).toBe(group);
    const geometry = internals?.sketchGeometryOf('a') as { coordinates: number[][][] };
    near(geometry.coordinates[0][1], [2, 0]);
    expect(internals?.checkSketches(new Set(['a']))).toEqual([]);
    // The row is drawn by its sketch: what reads the rows drawn goes on reading it
    expect(draw.getStore().tables?.get('l')?.listDrawnRows([-180, -90, 180, 90])).toHaveLength(1);
  });
});

describe.each(KINDS)('a drag over a Store of %s', (kind) => {
  beforeEach(() => {
    open(kind, ['a', 'b']);
    draw.selection.set('feature', ['a', 'b']);
  });

  it('writes nothing while it goes on, and writes once let go', () => {
    const update = vi.spyOn(store, 'updateFeature');
    press([1.5, 0.5], [2.5, 0.5]);
    expect(writes).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    near(corner(writesOf(draw).features.get('a') as unknown as Feature), [0, 0]);
    near(corner(draw.rendered.get('a') as unknown as Feature), [2, 0]);
    near(corner(draw.rendered.get('b') as unknown as Feature), [5, 0]);
    letGo(2.5, 0.5);
    expect(writes).toEqual(['change']);
    expect(update.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    near(corner(writesOf(draw).features.get('a') as unknown as Feature), [2, 0]);
    near(corner(draw.rendered.get('a') as unknown as Feature), [2, 0]);
    expect(events.map(([name]) => name)).toEqual([
      'drag.started',
      'sketch.added',
      'sketch.removed',
      'drag.ended',
    ]);
    expect(events[2]?.[1]).toMatchObject({ reason: 'committed' });
    expect(draw.sketches.count()).toBe(0);
  });

  it('writes nothing once cancelled, and draws the features where they are', () => {
    press([2.5, 0.5]);
    engine.modeManager.getHandler()?.onDragCancel?.(event('dragcancel', 2.5, 0.5, FROM));
    expect(writes).toEqual([]);
    near(corner(draw.rendered.get('a') as unknown as Feature), [0, 0]);
    expect(events[events.length - 2]?.[1]).toMatchObject({ reason: 'cancelled' });
    expect(events[events.length - 1]).toEqual([
      'drag.ended',
      { kind: 'feature', featureIds: ['a', 'b'], cancelled: true },
    ]);
  });

  it('writes nothing once let go where it started', () => {
    press([2.5, 0.5], FROM);
    letGo(FROM[0], FROM[1]);
    expect(writes).toEqual([]);
    expect(events[events.length - 1]?.[1]).toMatchObject({ cancelled: false });
  });

  it('applies the sketch again over what is written meanwhile, and writes over it', () => {
    press([2.5, 0.5]);
    store.updateFeature('b', { geometry: square('b', 10, 10).geometry });
    near(corner(draw.rendered.get('b') as unknown as Feature), [12, 10]);
    letGo(2.5, 0.5);
    near(corner(writesOf(draw).features.get('b') as unknown as Feature), [12, 10]);
  });

  it('leaves out a feature deleted or locked meanwhile, and writes the others', () => {
    press([2.5, 0.5]);
    store.updateFeature('b', { locked: true });
    near(corner(draw.rendered.get('b') as unknown as Feature), [3, 0]);
    letGo(2.5, 0.5);
    near(corner(writesOf(draw).features.get('a') as unknown as Feature), [2, 0]);
    near(corner(writesOf(draw).features.get('b') as unknown as Feature), [3, 0]);
  });

  it('stops once every feature is deleted: nothing is written, and its end is cancelled', () => {
    press([2.5, 0.5]);
    store.transact(() => {
      store.deleteFeature('a');
      store.deleteFeature('b');
    });
    writes.length = 0;
    engine.inputRouter.dispatch(event<DragNormalizedEvent>('dragmove', 3.5, 0.5, FROM));
    expect(events[events.length - 1]?.[1]).toMatchObject({ cancelled: true });
    letGo(3.5, 0.5);
    expect(writes).toEqual([]);
    expect(events.filter(([name]) => name === 'drag.ended')).toHaveLength(1);
  });

  it('is not hit while it goes on, and is hit once let go', () => {
    const { shapes } = engine.context;
    const tables = draw.getStore().tables;
    const hits = (id: string): boolean => {
      const handle = tables?.getRowRef(id);
      return handle === undefined
        ? shapes.hitFeatures().some((feature) => feature.id === id)
        : shapes.hitRowsLeftOut()?.(handle) !== true;
    };
    expect(hits('a')).toBe(true);
    press([2.5, 0.5]);
    expect(hits('a')).toBe(false);
    expect(hits('b')).toBe(false);
    letGo(2.5, 0.5);
    expect(hits('a')).toBe(true);
  });
});

describe('the rows of a drag', () => {
  it('are moved by the moving set of the sketch, and leave it once written', () => {
    open('rows', ['a', 'b']);
    draw.selection.set('feature', ['a', 'b']);
    press([2.5, 0.5]);
    expect(setOf('a')).toBe(SKETCH_MOVE_SET);
    expect(setOf('b')).toBe(SKETCH_MOVE_SET);
    letGo(2.5, 0.5);
    expect(setOf('a')).toBe(0);
    const states = featureTablesInternals(draw.getStore().tables)?.states;
    expect(states?.transform(SKETCH_MOVE_SET)).toBeNull();
  });

  it('ask for a frame at each move: no change of the Store tells it', () => {
    open('rows', ['a']);
    draw.selection.set('feature', ['a']);
    press([1.5, 0.5]);
    const repaint = vi.spyOn(engine.map, 'triggerRepaint');
    engine.inputRouter.dispatch(event<DragNormalizedEvent>('dragmove', 2.5, 0.5, FROM));
    expect(repaint).toHaveBeenCalled();
  });

  it('of the features selected in bulk are moved by their set, and written once', () => {
    open('rows', ['a', 'b'], 1);
    draw.selection.set('feature', ['a', 'b']);
    expect(draw.selection.value.ids).toBeNull();
    const applyBulk = vi.spyOn(store, 'applyBulk');
    press([2.5, 0.5]);
    expect(setOf('a')).toBe(BULK_MOVE_SET);
    expect(applyBulk).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    near(corner(draw.rendered.get('b') as unknown as Feature), [5, 0]);
    letGo(2.5, 0.5);
    expect(writes).toEqual(['change']);
    expect(setOf('a')).toBe(0);
    near(corner(writesOf(draw).features.get('b') as unknown as Feature), [5, 0]);
  });

  it('of the features selected in bulk leave out a row locked meanwhile', () => {
    open('rows', ['a', 'b'], 1);
    draw.selection.set('feature', ['a', 'b']);
    expect(draw.selection.value.ids).toBeNull();
    press([2.5, 0.5]);
    writesOf(draw).features.update('b', { locked: true });
    expect(setOf('b')).toBe(0);
    expect(setOf('a')).toBe(BULK_MOVE_SET);
    letGo(2.5, 0.5);
    near(corner(writesOf(draw).features.get('a') as unknown as Feature), [2, 0]);
    near(corner(writesOf(draw).features.get('b') as unknown as Feature), [3, 0]);
  });

  it('of the features selected in bulk are written with a row another sketch edits too', () => {
    open('rows', ['a', 'b'], 1);
    draw.selection.set('feature', ['a', 'b']);
    press([2.5, 0.5]);
    const other = { kind: 'translate', target: { featureIds: ['b'] }, from: [0, 0], to: [0, 0] };
    draw.sketches.add({ owner: 'someone', edits: [other] as never });
    expect(setOf('b')).toBe(0);
    near(corner(draw.rendered.get('b') as unknown as Feature), [5, 0]);
    letGo(2.5, 0.5);
    near(corner(writesOf(draw).features.get('a') as unknown as Feature), [2, 0]);
    near(corner(writesOf(draw).features.get('b') as unknown as Feature), [5, 0]);
  });

  it('of a selection no longer in bulk are written as the features selected', () => {
    open('rows', ['a', 'b'], 1);
    draw.selection.set('feature', ['a', 'b']);
    press([2.5, 0.5]);
    draw.selection.set('feature', ['a']);
    expect(draw.selection.value.ids).not.toBeNull();
    letGo(2.5, 0.5);
    near(corner(writesOf(draw).features.get('a') as unknown as Feature), [2, 0]);
    near(corner(writesOf(draw).features.get('b') as unknown as Feature), [3, 0]);
  });
});
