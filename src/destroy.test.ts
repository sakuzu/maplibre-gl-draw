// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for draw.destroy() on a whole draw instance
 *
 * destroy releases everything createMapLibreGLDraw acquired (the layers and the listeners on
 * the map, the listeners on the canvas, the timers, the registrations of the extension points,
 * the plugins) and gives back what it changed on the map (boxZoom, the focusability of the
 * canvas). A second destroy, and any call after it, is ignored rather than thrown.
 *
 * The map is a stub that records what is added to it, so a leak shows up as a count that does
 * not go back to where it started. The events of the datasets, which need a
 * whole instance too, are tested on the same stub.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Plugin } from './index.js';
import { createMapLibreGLDraw } from './maplibre-gl-draw.js';

type Listener = (...args: unknown[]) => void;

interface StubLayer {
  id: string;
  onRemove?: (map: unknown, gl: unknown) => void;
}

/** A stub of the maplibre Map that records its listeners and layers */
function createMapStub(options: { boxZoomEnabled?: boolean } = {}) {
  const mapListeners = new Map<string, Set<Listener>>();
  const canvasListeners = new Map<string, Set<Listener>>();
  const layers = new Map<string, StubLayer>();
  let boxZoomEnabled = options.boxZoomEnabled ?? true;

  const canvas = {
    tabIndex: -1,
    style: { outline: '' } as Record<string, string>,
    addEventListener: (type: string, fn: Listener) => {
      if (!canvasListeners.has(type)) canvasListeners.set(type, new Set());
      canvasListeners.get(type)?.add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      canvasListeners.get(type)?.delete(fn);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    focus: () => {},
    clientWidth: 800,
    clientHeight: 600,
    width: 800,
    height: 600,
  };

  const map = {
    style: { _loaded: true },
    on: (type: string, fn: Listener) => {
      if (!mapListeners.has(type)) mapListeners.set(type, new Set());
      mapListeners.get(type)?.add(fn);
      return map;
    },
    off: (type: string, fn: Listener) => {
      mapListeners.get(type)?.delete(fn);
      return map;
    },
    once: () => map,
    getCanvas: () => canvas,
    getCanvasContainer: () => canvas,
    getContainer: () => canvas,
    getLayer: (id: string) => layers.get(id),
    addLayer: (layer: StubLayer) => {
      layers.set(layer.id, layer);
      return map;
    },
    removeLayer: (id: string) => {
      const layer = layers.get(id);
      layers.delete(id);
      layer?.onRemove?.(map, null);
      return map;
    },
    getStyle: () => ({ layers: [...layers.values()].map((l) => ({ id: l.id })) }),
    triggerRepaint: vi.fn(),
    getZoom: () => 10,
    getPitch: () => 0,
    getBearing: () => 0,
    getCenter: () => ({ lng: 0, lat: 0 }),
    getBounds: () => ({
      getWest: () => -1,
      getEast: () => 1,
      getSouth: () => -1,
      getNorth: () => 1,
      getSouthWest: () => ({ lng: -1, lat: -1 }),
      getNorthEast: () => ({ lng: 1, lat: 1 }),
    }),
    project: (lngLat: { lng: number; lat: number } | [number, number]) => {
      const [lng, lat] = Array.isArray(lngLat) ? lngLat : [lngLat.lng, lngLat.lat];
      return { x: lng * 100 + 400, y: 300 - lat * 100 };
    },
    unproject: (p: [number, number] | { x: number; y: number }) => {
      const [x, y] = Array.isArray(p) ? p : [p.x, p.y];
      return { lng: (x - 400) / 100, lat: (300 - y) / 100 };
    },
    getTerrain: () => null,
    boxZoom: {
      isEnabled: () => boxZoomEnabled,
      enable: () => {
        boxZoomEnabled = true;
      },
      disable: () => {
        boxZoomEnabled = false;
      },
    },
    dragPan: { isEnabled: () => true, enable: () => {}, disable: () => {} },
    doubleClickZoom: { isEnabled: () => true, enable: () => {}, disable: () => {} },
  };

  const count = (listeners: Map<string, Set<Listener>>) =>
    [...listeners.values()].reduce((sum, set) => sum + set.size, 0);

  return {
    map: map as unknown as MapLibreMap,
    canvas,
    layers,
    mapListenerCount: () => count(mapListeners),
    canvasListenerCount: () => count(canvasListeners),
    isBoxZoomEnabled: () => boxZoomEnabled,
  };
}

describe('draw.destroy()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes every layer and listener it added to the map and the canvas', () => {
    const stub = createMapStub();
    const draw = createMapLibreGLDraw(stub.map);

    expect(stub.layers.size).toBeGreaterThan(0);
    expect(stub.mapListenerCount()).toBeGreaterThan(0);
    expect(stub.canvasListenerCount()).toBeGreaterThan(0);

    draw.destroy();

    expect(stub.layers.size).toBe(0);
    expect(stub.mapListenerCount()).toBe(0);
    expect(stub.canvasListenerCount()).toBe(0);
  });

  it('leaves no timer running', () => {
    const stub = createMapStub();
    const draw = createMapLibreGLDraw(stub.map);
    draw.addFeature({ type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } });
    draw.destroy();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives boxZoom back in the state it found it', () => {
    const enabled = createMapStub({ boxZoomEnabled: true });
    const first = createMapLibreGLDraw(enabled.map);
    expect(enabled.isBoxZoomEnabled()).toBe(false);
    first.destroy();
    expect(enabled.isBoxZoomEnabled()).toBe(true);

    // The host (or another draw instance) had turned it off: destroy must not turn it on
    const disabled = createMapStub({ boxZoomEnabled: false });
    const second = createMapLibreGLDraw(disabled.map);
    second.destroy();
    expect(disabled.isBoxZoomEnabled()).toBe(false);
  });

  it('gives the canvas back its focusability and outline', () => {
    const stub = createMapStub();
    stub.canvas.tabIndex = -1;
    stub.canvas.style.outline = '1px solid red';
    const draw = createMapLibreGLDraw(stub.map);
    expect(stub.canvas.tabIndex).toBe(0);

    draw.destroy();

    expect(stub.canvas.tabIndex).toBe(-1);
    expect(stub.canvas.style.outline).toBe('1px solid red');
  });

  it('uninstalls the plugins', () => {
    const stub = createMapStub();
    const draw = createMapLibreGLDraw(stub.map);
    const plugin: Plugin = { name: 'probe', onInstall: vi.fn(), onUninstall: vi.fn() };
    draw.addPlugin(plugin);

    draw.destroy();

    expect(plugin.onUninstall).toHaveBeenCalledTimes(1);
  });

  it('ignores a second destroy', () => {
    const stub = createMapStub();
    const draw = createMapLibreGLDraw(stub.map);
    const plugin: Plugin = { name: 'probe', onUninstall: vi.fn() };
    draw.addPlugin(plugin);

    draw.destroy();
    expect(() => draw.destroy()).not.toThrow();
    expect(plugin.onUninstall).toHaveBeenCalledTimes(1);
    expect(stub.isBoxZoomEnabled()).toBe(true);
  });

  it('ignores the calls made after destroy instead of throwing, and adds nothing to the map', () => {
    const stub = createMapStub();
    const draw = createMapLibreGLDraw(stub.map);
    const lateInstall = vi.fn();
    draw.destroy();

    expect(() => {
      draw.setMode('draw_line');
      draw.setMode('select');
      draw.addFeature({ type: 'Point', geometry: { type: 'Point', coordinates: [1, 1] } });
      draw.getAllFeatures();
      draw.setReadOnly(true);
      draw.setReadOnly(false);
      draw.setInteractionLock(true);
      draw.setRenderScale(2);
      draw.on('draw.feature.create', () => {});
      draw.addPlugin({ name: 'late', onInstall: lateInstall });
      draw.snapping.register({ name: 'late', candidates: () => [] });
    }).not.toThrow();

    expect(lateInstall).not.toHaveBeenCalled();

    expect(stub.layers.size).toBe(0);
    expect(stub.mapListenerCount()).toBe(0);
    expect(stub.canvasListenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the dataset events of the instance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits draw.dataset.add and draw.dataset.remove, and the same events reach a plugin', () => {
    const stub = createMapStub();
    const draw = createMapLibreGLDraw(stub.map);
    const log: string[] = [];
    draw.on('draw.dataset.add', ({ datasetId }) => {
      log.push(`add ${datasetId} ${draw.getDataset(datasetId) ? 'got' : 'none'}`);
    });
    draw.on('draw.dataset.remove', ({ datasetId }) => {
      log.push(`remove ${datasetId} ${draw.getDataset(datasetId) ? 'got' : 'none'}`);
    });
    const pluginLog: string[] = [];
    draw.addPlugin({
      name: 'follower',
      onInstall: (ctx) => {
        ctx.on('dataset.add', ({ datasetId }) => pluginLog.push(`add ${datasetId}`));
        ctx.on('dataset.remove', ({ datasetId }) => pluginLog.push(`remove ${datasetId}`));
      },
    });

    const parcels = draw.addDataset({ id: 'parcels', rows: [] });
    draw.addDataset({ id: 'roads', rows: [] });
    draw.removeDataset('roads');
    parcels.remove();

    expect(log).toEqual([
      'add parcels got',
      'add roads got',
      'remove roads none',
      'remove parcels none',
    ]);
    expect(pluginLog).toEqual(['add parcels', 'add roads', 'remove roads', 'remove parcels']);
  });

  it('emits draw.dataset.reorder when a move changes the order, to the host and to a plugin', () => {
    const stub = createMapStub();
    const draw = createMapLibreGLDraw(stub.map);
    draw.addDataset({ id: 'parcels', rows: [] });
    draw.addDataset({ id: 'roads', rows: [] });
    const orders: string[][] = [];
    draw.on('draw.dataset.reorder', ({ order }) => orders.push(order));
    const pluginOrders: string[][] = [];
    draw.addPlugin({
      name: 'follower',
      onInstall: (ctx) => {
        ctx.on('dataset.reorder', ({ order }) => pluginOrders.push(order));
      },
    });

    draw.moveDataset('roads', { index: 0 });
    draw.moveDataset('roads', { index: 0 });

    expect(orders).toEqual([['roads', 'parcels']]);
    expect(pluginOrders).toEqual([['roads', 'parcels']]);
  });

  it('does not emit draw.dataset.remove when the instance is destroyed', () => {
    const stub = createMapStub();
    const draw = createMapLibreGLDraw(stub.map);
    draw.addDataset({ id: 'parcels', rows: [] });
    const removed = vi.fn();
    draw.on('draw.dataset.remove', removed);

    draw.destroy();

    expect(removed).not.toHaveBeenCalled();
  });
});
