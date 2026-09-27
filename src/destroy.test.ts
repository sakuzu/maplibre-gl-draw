// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for draw.destroy() on a whole draw instance
 *
 * destroy releases everything createDraw acquired (the layers and the listeners on
 * the map, the listeners on the canvas, the timers, the registrations of the extension points,
 * the plugins) and gives back what it changed on the map (boxZoom, the focusability of the
 * canvas). A second destroy, and any call after it, is ignored rather than thrown.
 *
 * The map is a stub that records what is added to it, so a leak shows up as a count that does
 * not go back to where it started. The events of the datasets, which need a
 * whole instance too, are tested on the same stub.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDraw } from './api/v2/draw.js';
import type { Plugin } from './api/v2/extension/plugin.js';
import { createMapStub } from './test-utils.js';

describe('draw.destroy()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes every layer and listener it added to the map and the canvas', () => {
    const stub = createMapStub();
    const draw = createDraw(stub.map);

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
    const draw = createDraw(stub.map);
    draw.features.create({ type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } });
    draw.destroy();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives boxZoom back in the state it found it', () => {
    const enabled = createMapStub({ boxZoomEnabled: true });
    const first = createDraw(enabled.map);
    expect(enabled.isBoxZoomEnabled()).toBe(false);
    first.destroy();
    expect(enabled.isBoxZoomEnabled()).toBe(true);

    // The host (or another draw instance) had turned it off: destroy must not turn it on
    const disabled = createMapStub({ boxZoomEnabled: false });
    const second = createDraw(disabled.map);
    second.destroy();
    expect(disabled.isBoxZoomEnabled()).toBe(false);
  });

  it('gives the canvas back its focusability and outline', () => {
    const stub = createMapStub();
    stub.canvas.tabIndex = -1;
    stub.canvas.style.outline = '1px solid red';
    const draw = createDraw(stub.map);
    expect(stub.canvas.tabIndex).toBe(0);

    draw.destroy();

    expect(stub.canvas.tabIndex).toBe(-1);
    expect(stub.canvas.style.outline).toBe('1px solid red');
  });

  it('uninstalls the plugins', () => {
    const stub = createMapStub();
    const draw = createDraw(stub.map);
    const plugin: Plugin = { name: 'probe', onAdd: vi.fn(), onRemove: vi.fn() };
    draw.extensions.plugins.add(plugin);

    draw.destroy();

    expect(plugin.onRemove).toHaveBeenCalledTimes(1);
  });

  it('ignores a second destroy', () => {
    const stub = createMapStub();
    const draw = createDraw(stub.map);
    const plugin: Plugin = { name: 'probe', onAdd: () => {}, onRemove: vi.fn() };
    draw.extensions.plugins.add(plugin);

    draw.destroy();
    expect(() => draw.destroy()).not.toThrow();
    expect(plugin.onRemove).toHaveBeenCalledTimes(1);
    expect(stub.isBoxZoomEnabled()).toBe(true);
  });

  it('ignores the calls made after destroy instead of throwing, and adds nothing to the map', () => {
    const stub = createMapStub();
    const draw = createDraw(stub.map);
    const lateInstall = vi.fn();
    draw.destroy();

    expect(() => {
      draw.setMode('select');
      draw.features.create({ type: 'Point', geometry: { type: 'Point', coordinates: [1, 1] } });
      draw.features.list();
      draw.setReadOnly(true);
      draw.setReadOnly(false);
      draw.setInteractionLocked(true);
      draw.options.update({ rendering: { renderScale: 2 } });
      draw.on('feature.created', () => {});
      draw.extensions.plugins.add({ name: 'late', onAdd: lateInstall });
      draw.extensions.snapProviders.add({ name: 'late', candidates: () => [] });
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

  it('emits dataset.added and dataset.removed, and the same events reach a plugin', () => {
    const stub = createMapStub();
    const draw = createDraw(stub.map);
    const log: string[] = [];
    draw.on('dataset.added', ({ dataset }) => {
      log.push(`add ${dataset.id} ${draw.datasets.get(dataset.id) ? 'got' : 'none'}`);
    });
    draw.on('dataset.removed', ({ datasetId }) => {
      log.push(`remove ${datasetId} ${draw.datasets.get(datasetId) ? 'got' : 'none'}`);
    });
    const pluginLog: string[] = [];
    draw.extensions.plugins.add({
      name: 'follower',
      onAdd: (ctx) => {
        ctx.on('dataset.added', ({ dataset }) => pluginLog.push(`add ${dataset.id}`));
        ctx.on('dataset.removed', ({ datasetId }) => pluginLog.push(`remove ${datasetId}`));
      },
    });

    draw.datasets.add({ id: 'parcels', rows: [] });
    draw.datasets.add({ id: 'roads', rows: [] });
    draw.datasets.remove('roads');
    draw.datasets.remove('parcels');

    expect(log).toEqual([
      'add parcels got',
      'add roads got',
      'remove roads none',
      'remove parcels none',
    ]);
    expect(pluginLog).toEqual(['add parcels', 'add roads', 'remove roads', 'remove parcels']);
  });

  it('emits dataset.reordered when a move changes the order, to the host and to a plugin', () => {
    const stub = createMapStub();
    const draw = createDraw(stub.map);
    draw.datasets.add({ id: 'parcels', rows: [] });
    draw.datasets.add({ id: 'roads', rows: [] });
    const orders: (readonly string[])[] = [];
    draw.on('dataset.reordered', ({ order }) => orders.push(order));
    const pluginOrders: (readonly string[])[] = [];
    draw.extensions.plugins.add({
      name: 'follower',
      onAdd: (ctx) => {
        ctx.on('dataset.reordered', ({ order }) => pluginOrders.push(order));
      },
    });

    draw.datasets.move('roads', { index: 0 });
    draw.datasets.move('roads', { index: 0 });

    expect(orders).toEqual([['roads', 'parcels']]);
    expect(pluginOrders).toEqual([['roads', 'parcels']]);
  });

  it('does not emit dataset.removed when the instance is destroyed', () => {
    const stub = createMapStub();
    const draw = createDraw(stub.map);
    draw.datasets.add({ id: 'parcels', rows: [] });
    const removed = vi.fn();
    draw.on('dataset.removed', removed);

    draw.destroy();

    expect(removed).not.toHaveBeenCalled();
  });
});
