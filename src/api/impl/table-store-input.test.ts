// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The input of the user on an instance over an in-memory Store of rows: a click selects a row,
 * which is held as a feature, a drag of its vertex writes it, the Delete key deletes it
 *
 * The rows are hit on their columns; the row a click hits is made a feature for a moment, then
 * by the selection, and let go of a moment after the selection lets go of it. A drag writes the
 * row in its middle and at its end, and the end is what the row reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DragNormalizedEvent, MouseNormalizedEvent } from '../../dispatcher/types.js';
import { RELEASE_DELAY_MS } from '../../store/draw-store.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature } from '../../store/types.js';
import { createMapStub, createSyntheticInput, internalsOf } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDrawOnEngine } from './create-draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';

let engine: Engine;
let draw: Draw;
let store: Store;

/** A square of side `size` with its south-west corner at a position */
function square(id: string, x: number, y: number, size: number): Feature {
  return {
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x, y],
          [x + size, y],
          [x + size, y + size],
          [x, y + size],
          [x, y],
        ],
      ],
    },
    layerId: 'rows',
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked: false,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  store = createTableStore().store;
  store.createLayer({
    id: 'rows',
    name: 'rows',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  });
  store.createFeature(square('a', 0, 0, 0.5));
  store.createFeature(square('b', 1, 1, 0.5));
  engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
});

afterEach(() => {
  draw.destroy();
  vi.useRealTimers();
});

/** A mouse or drag event at a position (screen point of the map stub) */
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

describe('the input of the user over a Store of rows', () => {
  it('selects a row with a click, held as a feature, and lets go of it a moment after', () => {
    const tables = store.tables;
    if (!tables) throw new Error('rows');
    createSyntheticInput(engine).click([0.25, 0.25]);
    expect(store.getSelection()).toEqual({ type: 'feature', ids: ['a'] });
    const held = internalsOf(tables).getOpenedFeature('a');
    expect(held).toBeDefined();
    expect(draw.features.get('a')).toEqual(held);
    // A click on nothing lets go of it a moment later
    createSyntheticInput(engine).click([5, 5]);
    expect(store.getSelection().ids).toEqual([]);
    vi.advanceTimersByTime(RELEASE_DELAY_MS * 2);
    expect(internalsOf(tables).getOpenedFeature('a')).toBeUndefined();
  });

  it('writes the row of a vertex dragged once let go, and nothing in the middle of the drag', () => {
    const tables = store.tables;
    if (!tables) throw new Error('rows');
    createSyntheticInput(engine).click([0.25, 0.25]);
    let updates = 0;
    store.subscribe((change) => {
      for (const entry of change.features?.updated ?? []) {
        if (entry.id === 'a') updates++;
      }
    });
    const router = engine.inputRouter;
    router.dispatch(event<MouseNormalizedEvent>('mousedown', 0.5, 0));
    router.dispatch(event<DragNormalizedEvent>('dragstart', 0.5, 0, [0.5, 0]));
    router.dispatch(event<DragNormalizedEvent>('dragmove', 0.6, -0.1, [0.5, 0]));
    // The corner dragged, as the row reads it
    const corner = () =>
      (
        tables.get('rows')?.getRow(tables.findRow('a') ?? -1)?.geometry as
          | { coordinates: number[][][] }
          | undefined
      )?.coordinates[0][1];
    expect(corner()).toEqual([0.5, 0]);
    router.dispatch(event<DragNormalizedEvent>('dragmove', 0.7, -0.2, [0.5, 0]));
    expect(updates).toBe(0);
    router.dispatch(event<DragNormalizedEvent>('dragend', 0.7, -0.2, [0.5, 0]));
    expect(corner()).toEqual([0.7, -0.2]);
    expect(updates).toBe(1);
    // Read so once it is no longer held
    store.setSelection(null, []);
    vi.advanceTimersByTime(RELEASE_DELAY_MS * 2);
    expect(internalsOf(tables).getOpenedFeature('a')).toBeUndefined();
    expect(corner()).toEqual([0.7, -0.2]);
  });

  it('deletes the row selected with the Delete key', () => {
    const tables = store.tables;
    if (!tables) throw new Error('rows');
    createSyntheticInput(engine).click([1.25, 1.25]);
    expect(store.getSelection().ids).toEqual(['b']);
    createSyntheticInput(engine).key('Delete');
    expect(store.getFeature('b')).toBeUndefined();
    expect(tables.findRow('b')).toBeUndefined();
    expect(store.getSelection().ids).toEqual([]);
  });
});
