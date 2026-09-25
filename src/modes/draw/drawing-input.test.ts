// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the input of the click-driven drawing modes: undoVertex / redoVertex while
 * drawing, and the double click that must not zoom the map
 *
 * The real ModeManager and drawing modes are used; the clicks and keys are delivered to the
 * current handler the way InputRouter does. The map projects linearly (1 degree = 100 px), so
 * the vertices below are far apart on the screen.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { beforeEach, describe, expect, it } from 'vitest';
import type { KeyNormalizedEvent, MouseNormalizedEvent } from '../../dispatcher/types.js';
import { MemoryStore } from '../../store/memory.js';
import type { Coordinate, Mode } from '../../store/types.js';
import type { ModeContext } from '../handler.js';
import { ModeManagerImpl } from '../manager.js';
import { DrawLineMode } from './line.js';
import { DrawPolygonMode } from './polygon.js';

const NO_MODIFIERS = { shift: false, ctrl: false, alt: false, meta: false };

const A: Coordinate = [0, 0];
const B: Coordinate = [1, 0];
const C: Coordinate = [1, 1];
const D: Coordinate = [0, 1];

let store: MemoryStore;
let manager: ModeManagerImpl;

function click([lng, lat]: Coordinate): void {
  const event: MouseNormalizedEvent = {
    type: 'click',
    point: { x: lng * 100, y: -lat * 100 },
    lngLat: { lng, lat },
    originalEvent: { preventDefault() {} } as MouseEvent,
    modifiers: { ...NO_MODIFIERS },
  };
  manager.getHandler()?.onMouseMove?.({ ...event, type: 'mousemove' });
  manager.getHandler()?.onClick?.(event);
}

function key(k: string): void {
  const event: KeyNormalizedEvent = {
    type: 'keydown',
    key: k,
    code: k,
    modifiers: { ...NO_MODIFIERS },
    originalEvent: { preventDefault() {} } as KeyboardEvent,
  };
  manager.getHandler()?.onKeyDown?.(event);
}

beforeEach(() => {
  store = new MemoryStore();
  store.createLayer({ id: 'l1', name: 'l1', visible: true, locked: false, opacity: 1, order: [] });
  const canvas = { style: {} as { cursor?: string } };
  const map = {
    getZoom: () => 10,
    getCanvas: () => canvas,
    project: (c: Coordinate) => ({ x: c[0] * 100, y: -c[1] * 100 }),
    unproject: (p: [number, number]) => ({ lng: p[0] / 100, lat: -p[1] / 100 }),
  } as unknown as MapLibreMap;

  manager = new ModeManagerImpl(store);
  manager.registerMode('select', () => ({ modeName: 'select' }));
  manager.registerMode('draw_line', () => new DrawLineMode());
  manager.registerMode('draw_polygon', () => new DrawPolygonMode());
  let id = 0;
  manager.setContext({
    map,
    store,
    autoNameGenerator: { generateName: () => undefined },
    generateFeatureId: () => `f${++id}`,
    getCurrentLayerId: () => 'l1',
    setMode: (mode: Mode) => manager.setMode(mode),
  } as unknown as ModeContext);
  manager.start();
});

describe('undoVertex / redoVertex while drawing a line', () => {
  it('takes back the last vertex and puts it back', () => {
    manager.setMode('draw_line');
    click(A);
    click(B);
    click(C);

    expect(manager.undoVertex()).toBe(true);
    expect(manager.undoVertex()).toBe(true);
    expect(manager.redoVertex()).toBe(true);
    key('Enter');

    expect(store.getAllFeatures().map((f) => f.coordinates)).toEqual([[A, B]]);
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

    expect(store.getAllFeatures().map((f) => f.coordinates)).toEqual([[A, C]]);
  });

  it('is false in a mode without a drawing (select)', () => {
    expect(manager.undoVertex()).toBe(false);
    expect(manager.redoVertex()).toBe(false);
  });
});

describe('undoVertex / redoVertex while drawing a polygon', () => {
  it('commits the ring without the vertex that was taken back', () => {
    manager.setMode('draw_polygon');
    click(A);
    click(B);
    click(C);
    click(D);
    expect(manager.undoVertex()).toBe(true);
    key('Enter');

    const ring = (store.getAllFeatures()[0].coordinates as Coordinate[][])[0];
    expect(ring).toEqual([A, B, C, A]);
  });
});

describe('a double click while drawing', () => {
  it('is consumed by every click-driven drawing mode (MapLibre does not zoom)', () => {
    for (const mode of ['draw_line', 'draw_polygon'] as const) {
      manager.setMode(mode);
      let prevented = false;
      manager.getHandler()?.onDoubleClick?.({
        type: 'dblclick',
        point: { x: 0, y: 0 },
        lngLat: { lng: 0, lat: 0 },
        originalEvent: {
          preventDefault() {
            prevented = true;
          },
        } as MouseEvent,
        modifiers: { ...NO_MODIFIERS },
      });
      expect(prevented).toBe(true);
      manager.setMode('select');
    }
  });
});
