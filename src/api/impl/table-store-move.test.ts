// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A drag of many features held as rows: from `moveOpenedByStateFrom` rows held,
 * the rows of the selection are drawn moved by their state while the drag goes on, their features
 * follow the pointer, and the rows are written once, when the drag ends. With fewer, the rows are
 * written in the middle of the drag, as before.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DragNormalizedEvent, MouseNormalizedEvent } from '../../dispatcher/types.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import { STATE_MOVE_MASK } from '../../feature-table/row-state.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature } from '../../store/types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { FeatureTables } from '../tables.js';
import { createDrawOnEngine } from './create-draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';

let engine: Engine;
let draw: Draw;
let store: Store;

function square(id: string, x: number): Feature {
  return {
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x, 0],
          [x + 0.5, 0],
          [x + 0.5, 0.5],
          [x, 0.5],
          [x, 0],
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

const IDS = ['a', 'b', 'c', 'd'];

function setup(from: number): FeatureTables {
  vi.useFakeTimers();
  store = createTableStore({ moveOpenedByStateFrom: from }).store;
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
  IDS.forEach((id, i) => {
    store.createFeature(square(id, i));
  });
  engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  return store.tables as FeatureTables;
}

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

/** The first corner of the square of a row, as the row holds it */
function rowCorner(tables: FeatureTables, id: string): number[] | undefined {
  const geometry = tables.get('rows')?.getRow(tables.findRow(id) ?? -1)?.geometry as
    | { coordinates: number[][][] }
    | undefined;
  return geometry?.coordinates[0][0];
}

/** The first corner of the square of a feature */
function featureCorner(id: string): number[] | undefined {
  return (store.getFeature(id)?.geometry as { coordinates: number[][][] } | undefined)
    ?.coordinates[0][0];
}

/** Whether a row is in a moving set */
function moving(tables: FeatureTables, id: string): boolean {
  const state = featureTablesInternals(tables)?.states.stateOf(tables.findRow(id) ?? -1) ?? 0;
  return (state & STATE_MOVE_MASK) !== 0;
}

/**
 * Drags the selection by the body of the square of `a` one degree to the east along its parallel,
 * and reads the middle of the drag
 *
 * A move along a parallel turns the positions about the axis of the poles: every one moves by the
 * same degrees of longitude, so the rows held are moved by one translation of the degrees.
 */
function dragSelection(read: () => void): void {
  const router = engine.inputRouter;
  router.dispatch(event<MouseNormalizedEvent>('mousedown', 0.25, 0.25));
  router.dispatch(event<DragNormalizedEvent>('dragstart', 0.25, 0.25, [0.25, 0.25]));
  router.dispatch(event<DragNormalizedEvent>('dragmove', 0.75, 0.25, [0.25, 0.25]));
  router.dispatch(event<DragNormalizedEvent>('dragmove', 1.25, 0.25, [0.25, 0.25]));
  read();
  router.dispatch(event<DragNormalizedEvent>('dragend', 1.25, 0.25, [0.25, 0.25]));
}

/** A corner near the one expected (about 0.1 mm) */
function expectCornerNear(actual: number[] | undefined, expected: readonly number[]): void {
  expect(Math.abs((actual?.[0] as number) - (expected[0] as number))).toBeLessThan(1e-9);
  expect(Math.abs((actual?.[1] as number) - (expected[1] as number))).toBeLessThan(1e-9);
}

describe('a drag of many features held as rows', () => {
  it('moves the rows by their state in the middle of the drag, and writes them at its end', () => {
    const tables = setup(3);
    draw.selection.set('feature', IDS);
    dragSelection(() => {
      IDS.forEach((id, i) => {
        expect(rowCorner(tables, id)).toEqual([i, 0]);
        expectCornerNear(featureCorner(id), [i + 1, 0]);
        expect(moving(tables, id)).toBe(true);
      });
      const [dLng, dLat] = featureTablesInternals(tables)?.states.translation(1) ?? [];
      expect(Math.abs((dLng as number) - 1)).toBeLessThan(1e-9);
      expect(Math.abs(dLat as number)).toBeLessThan(1e-9);
    });
    IDS.forEach((id, i) => {
      expectCornerNear(rowCorner(tables, id), [i + 1, 0]);
      expectCornerNear(featureCorner(id), [i + 1, 0]);
      expect(moving(tables, id)).toBe(false);
    });
  });

  it('writes the rows in the middle of the drag when fewer rows are held', () => {
    const tables = setup(10);
    draw.selection.set('feature', IDS);
    dragSelection(() => {
      IDS.forEach((id, i) => {
        expectCornerNear(rowCorner(tables, id), [i + 1, 0]);
        expect(moving(tables, id)).toBe(false);
      });
    });
    IDS.forEach((id, i) => {
      expectCornerNear(rowCorner(tables, id), [i + 1, 0]);
    });
  });
});
