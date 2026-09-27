// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the writable layer rule and the options of the Context
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import type { Layer } from '../store/types.js';
import { createContext } from './context.js';

function layer(id: string, overrides: Partial<Layer> = {}): Layer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
    ...overrides,
  };
}

const map = {} as unknown as MapLibreMap;

/** Creates a context with the drawing modes the tests enter (the draw instance registers them) */
function createTestContext(options: Parameters<typeof createContext>[1] = {}) {
  const context = createContext(map, options);
  context.modeManager.registerMode('draw_point', () => ({
    modeName: 'draw_point',
    writesFeatures: true,
  }));
  context.modeManager.registerMode('draw_polygon', () => ({
    modeName: 'draw_polygon',
    writesFeatures: true,
  }));
  return context;
}

describe('Context.getWritableLayerId', () => {
  it('is empty while there is no layer, and a drawing mode is not entered', () => {
    const context = createTestContext({ initDefaultLayer: false });
    expect(context.getWritableLayerId()).toBe('');

    context.modeManager.setMode('draw_polygon');
    expect(context.modeManager.getMode()).toBe('select');
  });

  it('lets a drawing mode be entered once the application creates a layer', () => {
    const context = createTestContext({ initDefaultLayer: false });
    context.store.createLayer(layer('l1'));
    expect(context.getWritableLayerId()).toBe('l1');

    context.modeManager.setMode('draw_polygon');
    expect(context.modeManager.getMode()).toBe('draw_polygon');
  });

  it('falls back to the first writable layer without changing the active layer', () => {
    const context = createTestContext({ initDefaultLayer: false });
    context.store.createLayer(layer('a'));
    context.store.createLayer(layer('b'));
    context.setActiveLayerId('b');

    context.store.updateLayer('b', { locked: true });
    expect(context.getWritableLayerId()).toBe('a');
    expect(context.getActiveLayerId()).toBe('b');

    context.store.updateLayer('b', { locked: false });
    expect(context.getWritableLayerId()).toBe('b');
  });

  it('skips a locally hidden layer', () => {
    const context = createTestContext({ initDefaultLayer: false });
    context.store.createLayer(layer('a'));
    context.store.setLocallyHidden('a', true);
    expect(context.getWritableLayerId()).toBe('');

    context.modeManager.setMode('draw_point');
    expect(context.modeManager.getMode()).toBe('select');
  });

  it('uses the default layer when it is created', () => {
    const context = createTestContext();
    expect(context.getWritableLayerId()).toBe('default-layer');
  });
});

describe('Context.options.scaleWithZoom', () => {
  it('lets line widths follow the zoom by default', () => {
    expect(createContext(map).options.scaleWithZoom).toBe(true);
  });

  it('keeps line widths the same on the screen when it is false', () => {
    expect(createContext(map, { scaleWithZoom: false }).options.scaleWithZoom).toBe(false);
  });
});
