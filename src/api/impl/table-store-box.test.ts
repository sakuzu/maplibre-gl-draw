// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A box drawn over a Store of rows: while it is drawn, the rows in it are
 * marked in their state (selected in bulk) and not held, and the selection UI shows them as a
 * Store of objects shows the features its box selects while it is drawn. Let go, the rows are
 * selected and held, and the marks are gone.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DragNormalizedEvent, MouseNormalizedEvent } from '../../dispatcher/types.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import { GPU_STATE_BULK, STATE_BULK, toGpuState } from '../../feature-table/row-state.js';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature, Layer } from '../../store/types.js';
import { createMapStub, internalsOf } from '../../test-utils.js';
import { getBoxMarkedFeatureIds, getSelectedFeatureIds } from '../../view/ui/helper.js';
import type { Draw } from '../draw.js';
import type { FeatureTables } from '../tables.js';
import { createDrawOnEngine } from './create-draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';

interface Instance {
  engine: Engine;
  draw: Draw;
  store: Store;
}

const instances: Instance[] = [];

function square(id: string, x: number, y: number): Feature {
  return {
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x, y],
          [x + 0.5, y],
          [x + 0.5, y + 0.5],
          [x, y + 0.5],
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

/** The same squares in a Store of rows or of objects, with an instance over it */
function setup(rows: boolean): Instance {
  vi.useFakeTimers();
  const store = rows ? createTableStore().store : new MemoryStore();
  const base = {
    id: 'l',
    name: 'l',
    visible: true,
    locked: false,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
  };
  store.createLayer((rows ? { ...base, kind: 'table' } : { ...base, items: [] }) as Layer);
  store.createFeature(square('a', 0, 0));
  store.createFeature(square('b', 1, 0));
  store.createFeature(square('c', 2, 0));
  store.createFeature(square('far', 10, 10));
  store.createFeature({ ...square('locked', 0.5, 1), locked: true });
  const engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  const instance = { engine, draw, store };
  instances.push(instance);
  return instance;
}

afterEach(() => {
  for (const { draw } of instances.splice(0)) draw.destroy();
  vi.useRealTimers();
});

/** A mouse or drag event at a position, with shift held */
function event<T extends MouseNormalizedEvent | DragNormalizedEvent>(
  engine: Engine,
  type: T['type'],
  lng: number,
  lat: number,
  start: [number, number],
): T {
  const point = engine.map.project([lng, lat]);
  const from = engine.map.project(start);
  const inert = {
    preventDefault: () => {},
    stopPropagation: () => {},
    button: 0,
    buttons: 1,
    clientX: point.x,
    clientY: point.y,
    shiftKey: true,
  };
  return {
    type,
    point: { x: point.x, y: point.y },
    lngLat: { lng, lat },
    originalEvent: inert as unknown as MouseEvent,
    modifiers: { shift: true, ctrl: false, alt: false, meta: false },
    dragStartPoint: { x: from.x, y: from.y },
    dragStartLngLat: { lng: start[0], lat: start[1] },
  } as unknown as T;
}

const START: [number, number] = [-0.2, -0.2];

/** Draws a box from START, reads the middle of the drag at each corner, and lets it go */
function drawBox(
  { engine }: Instance,
  corners: Array<[number, number]>,
  read: (index: number) => void,
): void {
  const router = engine.inputRouter;
  router.dispatch(event<MouseNormalizedEvent>(engine, 'mousedown', ...START, START));
  router.dispatch(event<DragNormalizedEvent>(engine, 'dragstart', ...START, START));
  corners.forEach(([lng, lat], index) => {
    router.dispatch(event<DragNormalizedEvent>(engine, 'dragmove', lng, lat, START));
    read(index);
  });
  const [lng, lat] = corners[corners.length - 1];
  router.dispatch(event<DragNormalizedEvent>(engine, 'dragend', lng, lat, START));
}

/** Whether a row is marked, in the sets of handles and in the byte the GPU reads */
function marked(tables: FeatureTables, id: string): [boolean, boolean] {
  const internals = featureTablesInternals(tables);
  const handle = tables.findRow(id) ?? -1;
  const place = internals?.placeOf(handle);
  const copy = place ? place.group.state[place.row] : 0;
  return [
    ((internals?.states.stateOf(handle) ?? 0) & STATE_BULK) !== 0,
    (toGpuState(copy) & GPU_STATE_BULK) !== 0,
  ];
}

const CORNERS: Array<[number, number]> = [
  [0.7, 0.7],
  [1.7, 1.7],
  [0.7, 0.7],
];

describe('a box drawn over a Store of rows', () => {
  it('shows the rows in the box as a Store of objects shows the features it selects', () => {
    const objects = setup(false);
    const shownByObjects: string[][] = [];
    drawBox(objects, CORNERS, () => {
      shownByObjects.push([...getSelectedFeatureIds(objects.store)].sort());
    });
    expect(shownByObjects).toEqual([['a'], ['a', 'b'], ['a']]);

    const rows = setup(true);
    const tables = rows.store.tables as FeatureTables;
    drawBox(rows, CORNERS, (index) => {
      expect([...(getBoxMarkedFeatureIds(rows.store) ?? [])].sort()).toEqual(shownByObjects[index]);
      // Marked, not selected nor held
      expect(rows.store.getSelection().ids).toEqual([]);
      expect(internalsOf(tables).getOpenedFeature('a')).toBeUndefined();
      expect(marked(tables, 'a')).toEqual([true, true]);
      expect(marked(tables, 'b')).toEqual(index === 1 ? [true, true] : [false, false]);
      expect(marked(tables, 'locked')).toEqual([false, false]);
    });
    // Let go: selected and held, no mark left
    expect(rows.store.getSelection().ids).toEqual(['a']);
    expect(internalsOf(tables).getOpenedFeature('a')).toBeDefined();
    expect(getBoxMarkedFeatureIds(rows.store)).toBeNull();
    expect(featureTablesInternals(tables)?.states.bulkHandles().size).toBe(0);
    for (const id of ['a', 'b', 'c']) expect(marked(tables, id)).toEqual([false, false]);
  });

  it('shows nothing marked when no box is drawn, and none over a Store of objects', () => {
    const rows = setup(true);
    expect(getBoxMarkedFeatureIds(rows.store)).toBeNull();
    const objects = setup(false);
    drawBox(objects, [[1.7, 1.7]], () => {
      expect(getBoxMarkedFeatureIds(objects.store)).toBeNull();
    });
  });
});
