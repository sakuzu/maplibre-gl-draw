// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the derivation of the writable layer
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from './memory.js';
import type { Layer } from './types.js';
import { isWritableLayer, resolveWritableLayerId } from './writable-layer.js';

function layer(id: string, overrides: Partial<Layer> = {}): Layer {
  return { id, name: id, visible: true, locked: false, opacity: 1, order: [], ...overrides };
}

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
});

describe('isWritableLayer', () => {
  it('accepts a layer that exists, is unlocked and is visible', () => {
    store.createLayer(layer('a'));
    expect(isWritableLayer(store.getLayer('a'), store)).toBe(true);
  });

  it('rejects a missing, locked, hidden or locally hidden layer', () => {
    store.createLayer(layer('locked', { locked: true }));
    store.createLayer(layer('hidden', { visible: false }));
    store.createLayer(layer('local'));
    store.setLocallyHidden('local', true);

    expect(isWritableLayer(store.getLayer('missing'), store)).toBe(false);
    expect(isWritableLayer(store.getLayer('locked'), store)).toBe(false);
    expect(isWritableLayer(store.getLayer('hidden'), store)).toBe(false);
    expect(isWritableLayer(store.getLayer('local'), store)).toBe(false);
  });
});

describe('resolveWritableLayerId', () => {
  it('prefers the given layer when it can be written', () => {
    store.createLayer(layer('a'));
    store.createLayer(layer('b'));
    expect(resolveWritableLayerId(store, 'b')).toBe('b');
  });

  it('falls back to the first writable layer', () => {
    store.createLayer(layer('a', { locked: true }));
    store.createLayer(layer('b'));
    store.createLayer(layer('c'));
    store.setLocallyHidden('b', true);
    expect(resolveWritableLayerId(store, 'a')).toBe('c');
  });

  it('is an empty string when no layer can be written', () => {
    expect(resolveWritableLayerId(store, 'a')).toBe('');
    store.createLayer(layer('a', { visible: false }));
    expect(resolveWritableLayerId(store, 'a')).toBe('');
  });

  it('comes back to the preferred layer once it is shown again', () => {
    store.createLayer(layer('a'));
    store.createLayer(layer('b'));
    store.setLocallyHidden('a', true);
    expect(resolveWritableLayerId(store, 'a')).toBe('b');
    store.setLocallyHidden('a', false);
    expect(resolveWritableLayerId(store, 'a')).toBe('a');
  });
});
