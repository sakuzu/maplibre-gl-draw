// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for draw.destroy() on a whole draw instance
 *
 * destroy releases everything createDraw acquired (the layers and the listeners on
 * the map, the listeners on the canvas, the timers, the registrations of the extension points,
 * the plugins) and gives back what it changed on the map (boxZoom, the focusability of the
 * canvas). A second destroy is ignored, and any other call after it throws
 * DrawError('invalid-state').
 *
 * The map is a stub that records what is added to it, so a leak shows up as a count that does
 * not go back to where it started. The events of the datasets, which need a
 * whole instance too, are tested on the same stub.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDraw } from './api/draw.js';
import type { Plugin } from './api/extension/plugin.js';
import { writesOf } from './test-support/writes.js';
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
    writesOf(draw).features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
    });
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

  it('throws invalid-state for the calls made after destroy, and adds nothing to the map', async () => {
    const stub = createMapStub();
    const draw = createDraw(stub.map);
    const lateInstall = vi.fn();
    draw.destroy();

    const calls: Array<() => unknown> = [
      () => draw.setMode('select'),
      () => draw.features.list(),
      () => draw.setReadOnly(true),
      () => draw.setInteractionLocked(true),
      () => draw.options.update({ rendering: { renderScale: 2 } }),
      () => draw.on('change', () => {}),
      () => draw.selection.subscribe(() => {}),
      () => draw.extensions.plugins.add({ name: 'late', onAdd: lateInstall }),
      () => draw.extensions.snapProviders.add({ name: 'late', candidates: () => [] }),
    ];
    const failed = expect.objectContaining({ name: 'DrawError', code: 'invalid-state' });
    for (const call of calls) {
      expect(call).toThrow(failed);
    }
    // A write returns a promise, which rejects with the error
    await expect(
      draw.write((tx) =>
        tx.features.create({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [1, 1] },
          properties: {},
        }),
      ),
    ).rejects.toThrow(failed);

    expect(lateInstall).not.toHaveBeenCalled();

    expect(stub.layers.size).toBe(0);
    expect(stub.mapListenerCount()).toBe(0);
    expect(stub.canvasListenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the instance after destroy', () => {
  /** Every method and getter of an object and of the plain objects in it, by path */
  function methodsOf(target: object, prefix = ''): Array<[string, () => unknown]> {
    const found: Array<[string, () => unknown]> = [];
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(target))) {
      const path = `${prefix}${key}`;
      const get = descriptor.get;
      if (get) {
        found.push([path, () => get.call(target)]);
        continue;
      }
      const value: unknown = descriptor.value;
      if (typeof value === 'function') found.push([path, value as () => unknown]);
      else if (typeof value === 'object' && value !== null) {
        found.push(...methodsOf(value, `${path}.`));
      }
    }
    return found;
  }

  it('throws invalid-state from every method of the instance and its collections', async () => {
    const plugin: Plugin = { name: 'p', onAdd: vi.fn(), onRemove: vi.fn() };
    const draw = createDraw(createMapStub().map);
    draw.extensions.plugins.add(plugin);
    draw.destroy();
    expect(plugin.onRemove).toHaveBeenCalledTimes(1);

    const methods = methodsOf(draw).filter(([path]) => path !== 'destroy');
    const namespaces = new Set(methods.map(([path]) => path.split('.').slice(0, -1).join('.')));
    // Every resource and collection is walked
    for (const namespace of [
      '',
      'features',
      'layers',
      'groups',
      'datasets',
      'hidden',
      'selection',
      'vertexSelection',
      'metadata',
      'options',
      'document',
      'debug',
      'extensions.plugins',
      'extensions.modes',
      'extensions.featureTypes',
      'extensions.overlays',
      'extensions.snapProviders',
      'extensions.handleProviders',
      'extensions.companionProviders',
    ]) {
      expect(namespaces).toContain(namespace);
    }

    for (const [path, method] of methods) {
      let failure: unknown = null;
      try {
        const result = method();
        if (result instanceof Promise) await result;
      } catch (error) {
        failure = error;
      }
      expect(failure, path).toMatchObject({ name: 'DrawError', code: 'invalid-state' });
    }
    // destroy itself stays callable and does nothing
    expect(() => draw.destroy()).not.toThrow();
    expect(plugin.onRemove).toHaveBeenCalledTimes(1);
  });

  it('lets a plugin read the instance while destroy removes it', () => {
    const draw = createDraw(createMapStub().map);
    let seen: number | null = null;
    let reader: { draw: typeof draw } | null = null;
    draw.extensions.plugins.add({
      name: 'reader',
      onAdd: (ctx) => {
        reader = ctx;
      },
      onRemove: () => {
        seen = reader?.draw.features.count() ?? null;
      },
    });
    draw.destroy();
    expect(seen).toBe(0);
  });
});

describe('the observable of the datasets of the instance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tells the datasets added and removed, to the host and to a plugin alike', () => {
    const stub = createMapStub();
    const draw = createDraw(stub.map);
    const ids = (list: readonly { id: string }[]) => list.map((dataset) => dataset.id).join(',');
    const log: string[] = [];
    draw.datasets.subscribe((list) => log.push(ids(list)));
    const pluginLog: string[] = [];
    draw.extensions.plugins.add({
      name: 'follower',
      onAdd: (ctx) => {
        ctx.draw.datasets.subscribe((list) => pluginLog.push(ids(list)));
      },
    });

    draw.datasets.add({ id: 'parcels', rows: [] });
    draw.datasets.add({ id: 'roads', rows: [] });
    draw.datasets.remove('roads');
    draw.datasets.remove('parcels');

    expect(log).toEqual(['', 'parcels', 'parcels,roads', 'parcels', '']);
    expect(pluginLog).toEqual(log);
  });

  it('tells a move that changes the order, and not one that does not', () => {
    const stub = createMapStub();
    const draw = createDraw(stub.map);
    draw.datasets.add({ id: 'parcels', rows: [] });
    draw.datasets.add({ id: 'roads', rows: [] });
    const orders: string[][] = [];
    draw.datasets.subscribe((list) => orders.push(list.map((dataset) => dataset.id)));

    draw.datasets.move('roads', { index: 0 });
    draw.datasets.move('roads', { index: 0 });

    expect(orders).toEqual([
      ['parcels', 'roads'],
      ['roads', 'parcels'],
    ]);
  });

  it('does not tell the datasets removed when the instance is destroyed', () => {
    const stub = createMapStub();
    const draw = createDraw(stub.map);
    draw.datasets.add({ id: 'parcels', rows: [] });
    const removed = vi.fn();
    draw.datasets.subscribe(removed);
    removed.mockClear();

    draw.destroy();

    expect(removed).not.toHaveBeenCalled();
  });
});
