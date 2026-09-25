// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the layer a drawing mode writes into
 *
 * A mode that declares writesFeatures (the built-in drawing modes and any plugin mode that
 * declares it) is not entered while no layer can be written (missing, locked, hidden or
 * locally hidden), the modes fall back to the first writable layer when the active layer
 * cannot be written, and a layer that disappears while drawing discards the drawing and
 * returns to select without an exception.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { MouseNormalizedEvent } from '../../dispatcher/types.js';
import { MemoryStore } from '../../store/memory.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Layer, Mode } from '../../store/types.js';
import { resolveWritableLayerId } from '../../store/writable-layer.js';
import type { ModeContext } from '../handler.js';
import { ModeManagerImpl } from '../manager.js';
import { DrawCircleMode } from './circle.js';
import { DrawFreehandMode } from './freehand.js';
import { DrawImageMode } from './image.js';
import { DrawLineMode } from './line.js';
import { DrawPointMode } from './point.js';
import { DrawPolygonMode } from './polygon.js';

const DRAWING_MODES: Mode[] = [
  'draw_point',
  'draw_line',
  'draw_polygon',
  'draw_circle',
  'draw_freehand',
  'draw_image',
];

function layer(id: string, overrides: Partial<Layer> = {}): Layer {
  return { id, name: id, visible: true, locked: false, opacity: 1, order: [], ...overrides };
}

function click(lng: number, lat: number): MouseNormalizedEvent {
  return {
    type: 'click',
    point: { x: lng * 1000, y: lat * 1000 },
    lngLat: { lng, lat },
    originalEvent: {} as unknown as MouseEvent,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
  } as unknown as MouseNormalizedEvent;
}

let store: MemoryStore;
let manager: ModeManagerImpl;
let activeLayerId: string;
let imageRequests: unknown[];

beforeEach(() => {
  store = new MemoryStore();
  activeLayerId = 'a';
  imageRequests = [];
  const getWritableLayerId = () => resolveWritableLayerId(store, activeLayerId);
  manager = new ModeManagerImpl(store, {
    canEnter: (handler) => !handler.writesFeatures || getWritableLayerId() !== '',
  });
  manager.registerMode('select', () => ({ modeName: 'select' }));
  manager.registerMode('draw_point', () => new DrawPointMode());
  manager.registerMode('draw_line', () => new DrawLineMode());
  manager.registerMode('draw_polygon', () => new DrawPolygonMode());
  manager.registerMode('draw_circle', () => new DrawCircleMode());
  manager.registerMode('draw_freehand', () => new DrawFreehandMode());
  manager.registerMode('draw_image', () => new DrawImageMode());

  let idCounter = 0;
  const canvas = { style: { cursor: '' } };
  const map = {
    getCanvas: () => canvas,
    getZoom: () => 10,
    getCenter: () => ({ lng: 0, lat: 0 }),
    project: (c: [number, number]) => ({ x: c[0] * 1000, y: c[1] * 1000 }),
    dragPan: { enable: () => {}, disable: () => {} },
  };
  manager.setContext({
    map,
    store,
    spatialIndex: new RBushSpatialIndex(),
    eventEmitter: { emit: (_name: string, payload: unknown) => imageRequests.push(payload) },
    autoNameGenerator: { generateName: () => undefined },
    generateFeatureId: () => `f${++idCounter}`,
    getCurrentLayerId: getWritableLayerId,
    setMode: (mode: Mode) => manager.setMode(mode),
  } as unknown as ModeContext);
  manager.start();
});

describe('entering a drawing mode', () => {
  it.each(DRAWING_MODES)('does not enter %s while there is no layer', (mode) => {
    manager.setMode(mode);
    expect(store.getMode()).toBe('select');
    expect(imageRequests).toEqual([]);
  });

  it.each(DRAWING_MODES)('does not enter %s while every layer is locked or hidden', (mode) => {
    store.createLayer(layer('a', { locked: true }));
    store.createLayer(layer('b', { visible: false }));
    manager.setMode(mode);
    expect(store.getMode()).toBe('select');
  });

  it.each(DRAWING_MODES)('does not enter %s while the only layer is locally hidden', (mode) => {
    store.createLayer(layer('a'));
    store.setLocallyHidden('a', true);
    manager.setMode(mode);
    expect(store.getMode()).toBe('select');
  });

  it('gates a plugin mode that declares writesFeatures the same way', () => {
    manager.registerMode('draw_plugin' as Mode, () => ({
      modeName: 'draw_plugin' as Mode,
      writesFeatures: true,
    }));
    manager.setMode('draw_plugin' as Mode);
    expect(store.getMode()).toBe('select');

    store.createLayer(layer('a'));
    manager.setMode('draw_plugin' as Mode);
    expect(store.getMode()).toBe('draw_plugin');
  });

  it('does not gate a mode that does not declare writesFeatures', () => {
    manager.registerMode('measure' as Mode, () => ({ modeName: 'measure' as Mode }));
    manager.setMode('measure' as Mode);
    expect(store.getMode()).toBe('measure');
  });

  it('starts the handler that was asked, constructing it once per transition', () => {
    store.createLayer(layer('a'));
    let created = 0;
    manager.registerMode('draw_plugin' as Mode, () => {
      created++;
      return { modeName: 'draw_plugin' as Mode, writesFeatures: true };
    });
    manager.setMode('draw_plugin' as Mode);
    expect(created).toBe(1);
    expect(manager.getHandler()?.modeName).toBe('draw_plugin');
  });

  it('enters a drawing mode once a writable layer exists', () => {
    store.createLayer(layer('a'));
    manager.setMode('draw_line');
    expect(store.getMode()).toBe('draw_line');
  });
});

describe('the layer a drawing is committed into', () => {
  it('commits into the active layer when it can be written', () => {
    store.createLayer(layer('b'));
    store.createLayer(layer('a'));
    manager.setMode('draw_point');
    manager.getHandler()?.onClick?.(click(1, 1));
    const [feature] = store.getAllFeatures();
    expect(feature.layerId).toBe('a');
  });

  it('falls back to the first writable layer when the active layer is locked', () => {
    store.createLayer(layer('a', { locked: true }));
    store.createLayer(layer('b', { visible: false }));
    store.createLayer(layer('c'));
    manager.setMode('draw_point');
    manager.getHandler()?.onClick?.(click(1, 1));
    const [feature] = store.getAllFeatures();
    expect(feature.layerId).toBe('c');
    // The active layer itself is not changed
    expect(activeLayerId).toBe('a');
  });

  it('asks the host for an image with the writable layer', () => {
    store.createLayer(layer('a', { visible: false }));
    store.createLayer(layer('b'));
    manager.setMode('draw_image');
    expect(imageRequests).toEqual([expect.objectContaining({ layerId: 'b' })]);
    expect(store.getMode()).toBe('select');
  });
});

describe('losing the layer while drawing', () => {
  it('discards a point and returns to select when the layer was deleted', () => {
    store.createLayer(layer('a'));
    manager.setMode('draw_point');
    store.deleteLayer('a');

    expect(() => manager.getHandler()?.onClick?.(click(1, 1))).not.toThrow();
    expect(store.getMode()).toBe('select');
    expect(store.getAllFeatures()).toEqual([]);
  });

  it('discards a line and returns to select when the layer was locked', () => {
    store.createLayer(layer('a'));
    manager.setMode('draw_line');
    const handler = manager.getHandler();
    handler?.onClick?.(click(1, 1));
    handler?.onClick?.(click(2, 2));
    store.updateLayer('a', { locked: true });

    expect(() =>
      handler?.onKeyDown?.({ key: 'Enter' } as Parameters<
        NonNullable<typeof handler.onKeyDown>
      >[0]),
    ).not.toThrow();
    expect(store.getMode()).toBe('select');
    expect(store.getAllFeatures()).toEqual([]);
    expect(store.getTentative()).toBeNull();
  });

  it('discards a point and returns to select when the layer was locally hidden', () => {
    store.createLayer(layer('a'));
    manager.setMode('draw_point');
    store.setLocallyHidden('a', true);

    expect(() => manager.getHandler()?.onClick?.(click(1, 1))).not.toThrow();
    expect(store.getMode()).toBe('select');
    expect(store.getAllFeatures()).toEqual([]);
  });

  it('discards a polygon and returns to select when the layer was hidden', () => {
    store.createLayer(layer('a'));
    manager.setMode('draw_polygon');
    const handler = manager.getHandler();
    handler?.onClick?.(click(1, 1));
    handler?.onClick?.(click(2, 1));
    handler?.onClick?.(click(2, 2));
    store.updateLayer('a', { visible: false });

    expect(() =>
      handler?.onKeyDown?.({ key: 'Enter' } as Parameters<
        NonNullable<typeof handler.onKeyDown>
      >[0]),
    ).not.toThrow();
    expect(store.getMode()).toBe('select');
    expect(store.getAllFeatures()).toEqual([]);
  });

  it('commits into another writable layer when one remains', () => {
    store.createLayer(layer('a'));
    store.createLayer(layer('b'));
    manager.setMode('draw_line');
    const handler = manager.getHandler();
    handler?.onClick?.(click(1, 1));
    handler?.onClick?.(click(2, 2));
    store.deleteLayer('a');

    handler?.onKeyDown?.({ key: 'Enter' } as Parameters<NonNullable<typeof handler.onKeyDown>>[0]);
    const [feature] = store.getAllFeatures();
    expect(feature.layerId).toBe('b');
  });
});
