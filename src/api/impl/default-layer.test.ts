// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the default layer: it is created only when the Store given holds no layer
 * (`initDefaultLayer`), so that a Store that holds a document is taken as it is
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { Store } from '../../store/built-in/types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { Layer } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
  vi.useRealTimers();
});

/** An instance over a Store */
function instanceOver(store: Store): Draw {
  vi.useFakeTimers();
  const engine = createEngine(createMapStub().map, { store }, { deferDefaultMode: true });
  const draw = createDrawOnEngine(engine, { store });
  engine.enterDefaultMode();
  draws.push(draw);
  return draw;
}

describe('the default layer', () => {
  it('is not created again over the document an instance before made', () => {
    const store = createStore();
    const first = instanceOver(store);
    first.features.create({ type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } });
    first.destroy();
    draws.splice(draws.indexOf(first), 1);
    const layers = store.listLayers().map((layer) => layer.id);
    expect(layers).toEqual(['default-layer']);
    let draw: Draw | undefined;
    expect(() => {
      draw = instanceOver(store);
    }).not.toThrow();
    expect(store.listLayers().map((layer) => layer.id)).toEqual(layers);
    expect(draw?.layers.getActive()?.id).toBe('default-layer');
    expect(draw?.features.count()).toBe(1);
  });

  it('is not created over a Store that holds a layer of another name', () => {
    const store = createStore();
    store.createLayer({
      id: 'mine',
      name: 'Mine',
      visible: true,
      locked: false,
      opacity: 1,
      styleRule: undefined,
      metadata: undefined,
    } as Layer);
    const draw = instanceOver(store);
    expect(store.listLayers().map((layer) => layer.id)).toEqual(['mine']);
    expect(draw.layers.list().map((layer) => layer.id)).toEqual(['mine']);
    expect(draw.layers.getActive()?.id).toBe('mine');
  });

  it('is created over an empty Store', () => {
    const store = createStore();
    const draw = instanceOver(store);
    expect(store.listLayers().map((layer) => layer.id)).toEqual(['default-layer']);
    expect(draw.layers.getActive()?.id).toBe('default-layer');
  });
});
