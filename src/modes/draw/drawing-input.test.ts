// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the input of the click-driven drawing modes: undoing and redoing vertices while
 * drawing, and the double click that must not zoom the map
 *
 * The real ModeManager and drawing modes are used; the clicks and keys are delivered to the
 * current mode through the input route the InputRouter uses. The map projects linearly (1 degree = 100 px), so
 * the vertices below are far apart on the screen.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  KeyNormalizedEvent,
  MouseNormalizedEvent,
  NormalizedEvent,
} from '../../dispatcher/types.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import { MemoryStore } from '../../store/memory.js';
import type { Coordinate } from '../../store/types.js';
import { createModeHarness } from '../../test-utils.js';
import { ModeManagerImpl } from '../manager.js';
import { drawLineMode } from './line.js';
import { drawPolygonMode } from './polygon.js';

const NO_MODIFIERS = { shift: false, ctrl: false, alt: false, meta: false };

const A: Coordinate = [0, 0];
const B: Coordinate = [1, 0];
const C: Coordinate = [1, 1];
const D: Coordinate = [0, 1];

let store: MemoryStore;
let manager: ModeManagerImpl;
let harness: ReturnType<typeof createModeHarness>;

/** Delivers an event to the current mode; true when it consumed it */
function deliver(event: NormalizedEvent): boolean {
  const handler = manager.getHandler();
  return handler ? harness.route.toMode(handler, event, event, null) === true : false;
}

function click([lng, lat]: Coordinate): void {
  const event: MouseNormalizedEvent = {
    type: 'click',
    point: { x: lng * 100, y: -lat * 100 },
    lngLat: { lng, lat },
    originalEvent: { preventDefault() {} } as MouseEvent,
    modifiers: { ...NO_MODIFIERS },
  };
  deliver({ ...event, type: 'mousemove' });
  deliver(event);
}

function key(k: string): void {
  const event: KeyNormalizedEvent = {
    type: 'keydown',
    key: k,
    code: k,
    modifiers: { ...NO_MODIFIERS },
    originalEvent: { preventDefault() {} } as KeyboardEvent,
  };
  deliver(event);
}

beforeEach(() => {
  store = new MemoryStore();
  store.createLayer({
    id: 'l1',
    name: 'l1',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  });
  const canvas = { style: {} as { cursor?: string } };
  const map = {
    getZoom: () => 10,
    getCanvas: () => canvas,
    project: (c: Coordinate) => ({ x: c[0] * 100, y: -c[1] * 100 }),
    unproject: (p: [number, number]) => ({ lng: p[0] / 100, lat: -p[1] / 100 }),
  } as unknown as MapLibreMap;

  manager = new ModeManagerImpl(store);
  harness = createModeHarness({ store, map, modeManager: manager, getWritableLayerId: () => 'l1' });
  manager.registerMode('select', () => ({ modeName: 'select' }));
  harness.register('draw_line', drawLineMode);
  harness.register('draw_polygon', drawPolygonMode);
  manager.start();
});

describe('undoing and redoing vertices while drawing a line', () => {
  it('takes back the last vertex and puts it back', () => {
    manager.setMode('draw_line');
    click(A);
    click(B);
    click(C);

    expect(manager.undoVertex()).toBe(true);
    expect(manager.undoVertex()).toBe(true);
    expect(manager.redoVertex()).toBe(true);
    key('Enter');

    expect(store.listFeatures().map((f) => coordinatesOf(f))).toEqual([[A, B]]);
  });

  it('returns false with nothing to undo or redo, and a new vertex drops the redo', () => {
    manager.setMode('draw_line');
    expect(manager.undoVertex()).toBe(false);
    expect(manager.redoVertex()).toBe(false);

    click(A);
    click(B);
    expect(manager.undoVertex()).toBe(true);
    click(C);
    expect(manager.redoVertex()).toBe(false);
    key('Enter');

    expect(store.listFeatures().map((f) => coordinatesOf(f))).toEqual([[A, C]]);
  });

  it('is false in a mode without a drawing (select)', () => {
    expect(manager.undoVertex()).toBe(false);
    expect(manager.redoVertex()).toBe(false);
  });
});

describe('undoing and redoing vertices while drawing a polygon', () => {
  it('commits the ring without the vertex that was taken back', () => {
    manager.setMode('draw_polygon');
    click(A);
    click(B);
    click(C);
    click(D);
    expect(manager.undoVertex()).toBe(true);
    key('Enter');

    const ring = (coordinatesOf(store.listFeatures()[0]) as Coordinate[][])[0];
    expect(ring).toEqual([A, B, C, A]);
  });
});

describe('a double click while drawing', () => {
  it('is consumed by every click-driven drawing mode (MapLibre does not zoom)', () => {
    for (const mode of ['draw_line', 'draw_polygon'] as const) {
      manager.setMode(mode);
      // The router prevents the default action of a double click the mode consumes
      const consumed = deliver({
        type: 'dblclick',
        point: { x: 0, y: 0 },
        lngLat: { lng: 0, lat: 0 },
        originalEvent: {} as MouseEvent,
        modifiers: { ...NO_MODIFIERS },
      });
      expect(consumed).toBe(true);
      manager.setMode('select');
    }
  });
});
