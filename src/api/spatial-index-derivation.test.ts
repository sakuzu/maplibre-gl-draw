// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the spatial index as a value derived from the Store
 *
 * The index is kept in step with the Store by one subscriber, so every write path (the
 * public API, the drawing modes, import, a replaced Store) reaches it in the same way, and
 * a write the Store refuses (read-only) leaves no trace in the index.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { drawLineMode } from '../modes/draw/line.js';
import { createModeHarness, keyInput, pointerInput } from '../test-utils.js';
import { createContext } from './context.js';
import { createFeatureApi } from './feature-api.js';
import { createImportExportAPI } from './import-export/index.js';

const canvas = { style: { cursor: '' } };
const map = {
  getCanvas: () => canvas,
  getZoom: () => 10,
  getCenter: () => ({ lng: 0, lat: 0 }),
  project: (c: [number, number]) => ({ x: c[0] * 1000, y: c[1] * 1000 }),
  dragPan: { enable: () => {}, disable: () => {} },
} as unknown as MapLibreMap;

describe('the spatial index derived from the Store', () => {
  it('stays empty when GeoJSON is loaded while read-only', async () => {
    const context = createContext(map);
    const io = createImportExportAPI(context);
    context.store.setReadOnly(true);

    await io.load({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: {} },
      ],
    });

    expect(context.store.listFeatures()).toHaveLength(0);
    expect(context.spatialIndex.findNear([1, 1], 0.001)).toEqual([]);
  });

  it('keeps the existing features when the native format is loaded while read-only', async () => {
    const context = createContext(map);
    const io = createImportExportAPI(context);
    const api = createFeatureApi({
      store: context.store,
      generateFeatureId: context.generateFeatureId,
      getActiveLayerId: context.getActiveLayerId,
    });
    api.addFeature({ id: 'kept', type: 'Point', geometry: { type: 'Point', coordinates: [2, 2] } });
    context.store.setReadOnly(true);

    await io.load({
      version: '3.0.0',
      layers: [
        { id: 'default-layer', name: 'L', visible: true, locked: false, opacity: 1, items: [] },
      ],
      layerOrder: ['default-layer'],
      groups: [],
      features: [],
    });

    expect(context.store.getFeature('kept')).toBeDefined();
    expect(context.spatialIndex.findNear([2, 2], 0.001)).toEqual(['kept']);
  });

  it('does not index a line that is finished while read-only', () => {
    const context = createContext(map);
    context.store.setReadOnly(true);
    const harness = createModeHarness({
      store: context.store,
      map,
      modeManager: context.modeManager,
      getWritableLayerId: context.getWritableLayerId,
    });
    const mode = drawLineMode(harness.modeContext());
    mode.onEnter?.();

    mode.onClick?.(pointerInput(0, 0));
    mode.onClick?.(pointerInput(1, 1));
    mode.onKeyDown?.(keyInput('Enter'));

    expect(context.store.listFeatures()).toEqual([]);
    expect(context.spatialIndex.findNear([0.5, 0.5], 0.001)).toEqual([]);
  });

  it('re-indexes a Circle whose radius changes through its properties', () => {
    const context = createContext(map);
    const api = createFeatureApi({
      store: context.store,
      generateFeatureId: context.generateFeatureId,
      getActiveLayerId: context.getActiveLayerId,
    });
    api.addFeature({
      id: 'c1',
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { 'maplibre-gl-draw:radiusMeters': 100 },
    });
    expect(context.spatialIndex.findNear([0.5, 0], 0.001)).toEqual([]);

    api.updateFeature('c1', { properties: { 'maplibre-gl-draw:radiusMeters': 100_000 } });

    expect(context.spatialIndex.findNear([0.5, 0], 0.001)).toEqual(['c1']);
  });
});
