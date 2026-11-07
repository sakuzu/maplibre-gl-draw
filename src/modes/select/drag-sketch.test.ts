// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A move, a rotation and a resize of the select mode are shown by a sketch of this client: nothing
 * is written while they go on, the values the sketch gives over the features as they are then are
 * written once let go, and nothing is written when they are cancelled. Over a Store of rows the
 * rows are drawn moved by a moving set, whatever their number, their values untouched. What the
 * drag edits is not hit while it goes on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Draw } from '../../api/draw.js';
import type { DrawEvents } from '../../api/events.js';
import { createDrawOnEngine } from '../../api/impl/create-draw.js';
import type { Engine } from '../../api/impl/engine.js';
import { createEngine } from '../../api/impl/engine.js';
import type { DragNormalizedEvent, MouseNormalizedEvent } from '../../dispatcher/types.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import {
  BULK_MOVE_SET,
  SKETCH_MOVE_SET,
  STATE_MOVE_MASK,
  STATE_MOVE_SHIFT,
} from '../../feature-table/row-state.js';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature } from '../../store/types.js';
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

function open(kind: Kind, ids: readonly string[], holdLimit?: number): void {
  vi.useFakeTimers();
  store = kind === 'rows' ? createTableStore({ holdLimit }).store : new MemoryStore();
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
  draw.on('document.changed', () => writes.push('document.changed'));
  events = [];
  const names = ['sketch.added', 'sketch.removed', 'drag.started', 'drag.ended'] as const;
  for (const name of names) {
    draw.on(name, (payload: DrawEvents[typeof name]) => events.push([name, payload]));
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
  const state = internals?.states.stateOf(tables?.findRow(id) ?? -1) ?? 0;
  return (state & STATE_MOVE_MASK) >> STATE_MOVE_SHIFT;
}

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
    near(corner(draw.features.get('a') as unknown as Feature), [0, 0]);
    near(corner(draw.rendered.get('a') as unknown as Feature), [2, 0]);
    near(corner(draw.rendered.get('b') as unknown as Feature), [5, 0]);
    letGo(2.5, 0.5);
    expect(writes).toEqual(['document.changed']);
    expect(update.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    near(corner(draw.features.get('a') as unknown as Feature), [2, 0]);
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
    near(corner(draw.features.get('b') as unknown as Feature), [12, 10]);
  });

  it('leaves out a feature deleted or locked meanwhile, and writes the others', () => {
    press([2.5, 0.5]);
    store.updateFeature('b', { locked: true });
    near(corner(draw.rendered.get('b') as unknown as Feature), [3, 0]);
    letGo(2.5, 0.5);
    near(corner(draw.features.get('a') as unknown as Feature), [2, 0]);
    near(corner(draw.features.get('b') as unknown as Feature), [3, 0]);
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
      const handle = tables?.findRow(id);
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
    expect(draw.selection.get().bulk).toBeDefined();
    const applyBulk = vi.spyOn(store, 'applyBulk');
    press([2.5, 0.5]);
    expect(setOf('a')).toBe(BULK_MOVE_SET);
    expect(applyBulk).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    near(corner(draw.rendered.get('b') as unknown as Feature), [5, 0]);
    letGo(2.5, 0.5);
    expect(writes).toEqual(['document.changed']);
    expect(setOf('a')).toBe(0);
    near(corner(draw.features.get('b') as unknown as Feature), [5, 0]);
  });

  it('of the features selected in bulk leave out a row locked meanwhile', () => {
    open('rows', ['a', 'b'], 1);
    draw.selection.set('feature', ['a', 'b']);
    expect(draw.selection.get().bulk).toBeDefined();
    press([2.5, 0.5]);
    draw.features.update('b', { locked: true });
    expect(setOf('b')).toBe(0);
    expect(setOf('a')).toBe(BULK_MOVE_SET);
    letGo(2.5, 0.5);
    near(corner(draw.features.get('a') as unknown as Feature), [2, 0]);
    near(corner(draw.features.get('b') as unknown as Feature), [3, 0]);
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
    near(corner(draw.features.get('a') as unknown as Feature), [2, 0]);
    near(corner(draw.features.get('b') as unknown as Feature), [5, 0]);
  });

  it('of a selection no longer in bulk are written as the features selected', () => {
    open('rows', ['a', 'b'], 1);
    draw.selection.set('feature', ['a', 'b']);
    press([2.5, 0.5]);
    draw.selection.set('feature', ['a']);
    expect(draw.selection.get().bulk).toBeUndefined();
    letGo(2.5, 0.5);
    near(corner(draw.features.get('a') as unknown as Feature), [2, 0]);
    near(corner(draw.features.get('b') as unknown as Feature), [3, 0]);
  });
});
