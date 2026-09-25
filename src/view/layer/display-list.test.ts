// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the display list of the immediate path
 */

import { describe, expect, it } from 'vitest';
import type { DisplayStore } from '../../store/local-visibility.js';
import type { Feature, StateChanges } from '../../store/types.js';
import { DisplayListCache } from './display-list.js';

function feature(id: string): Feature {
  return { id, type: 'Point', coordinates: [0, 0], layerId: 'l', visible: true } as Feature;
}

function createStore(count: number) {
  const features = Array.from({ length: count }, (_, i) => feature(`f${i}`));
  const hidden = new Set<string>();
  let reads = 0;
  const store: DisplayStore = {
    getOrderedFeatures: () => {
      reads++;
      return [...features];
    },
    isLocallyHidden: (id) => hidden.has(id),
  };
  return { store, features, hidden, reads: () => reads };
}

describe('DisplayListCache', () => {
  it('puts the ids in view in draw order, whichever way it takes them', () => {
    const { store } = createStore(100);
    const cache = new DisplayListCache(store);
    const few = new Set(['f70', 'f3', 'f41']);
    const many = new Set(Array.from({ length: 60 }, (_, i) => `f${99 - i}`));

    expect(cache.inOrder(few).map((f) => f.id)).toEqual(['f3', 'f41', 'f70']);
    const expected = cache.features().filter((f) => many.has(f.id));
    expect(cache.inOrder(many)).toEqual(expected);
  });

  it('skips ids that are not displayed (locally hidden or unknown)', () => {
    const { store, hidden } = createStore(10);
    hidden.add('f2');
    const cache = new DisplayListCache(store);

    expect(cache.inOrder(new Set(['f2', 'f5', 'nope'])).map((f) => f.id)).toEqual(['f5']);
  });

  it('reads the Store once until a change that can alter the list', () => {
    const s = createStore(10);
    const cache = new DisplayListCache(s.store);
    cache.inOrder(new Set(['f1']));
    cache.inOrder(new Set(['f2']));
    cache.applyChanges({ selection: {} } as unknown as StateChanges);
    cache.inOrder(new Set(['f3']));
    expect(s.reads()).toBe(1);

    s.hidden.add('f3');
    cache.applyChanges({ uiStateChanged: true });
    expect(cache.inOrder(new Set(['f3']))).toEqual([]);
    expect(s.reads()).toBe(2);

    s.features.reverse();
    cache.applyChanges({ layerReorder: {} } as unknown as StateChanges);
    expect(cache.inOrder(new Set(['f0', 'f9'])).map((f) => f.id)).toEqual(['f9', 'f0']);
  });
});
