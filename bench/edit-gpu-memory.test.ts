// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The scene of the editing benchmark that reads what the drawing holds on the GPU finds the
// ledger on a map that lists its layers as maplibre does (`npx vitest run --root bench`)

import type * as maplibregl from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { gpuMemoryOf, recordCustomLayers } from './edit-scenes';

/** What the ledger of the drawing tells */
const HELD = { bytes: 10, rowBytes: 4, outsideRowBytes: 6, objects: 2, byPart: { points: 4 } };

/**
 * A map that keeps its layers as maplibre does: `getLayer` finds a custom layer by its id (its
 * `implementation` is the layer given to `addLayer`), and `getStyle` leaves the custom layers out
 * of the layers it lists (maplibre's `Style._serializeByIds` skips them)
 */
function maplibreLikeMap() {
  const layers = new Map<string, { type: string; implementation?: unknown }>();
  const map = {
    addLayer(layer: { id: string; type: string }) {
      layers.set(
        layer.id,
        layer.type === 'custom' ? { type: 'custom', implementation: layer } : layer,
      );
      return map;
    },
    getLayer: (id: string) => layers.get(id),
    getStyle: () => ({
      version: 8,
      sources: {},
      layers: [...layers]
        .filter(([, layer]) => layer.type !== 'custom')
        .map(([id, layer]) => ({ id, type: layer.type })),
    }),
  };
  map.addLayer({ id: 'bg', type: 'background' });
  return map;
}

/** The custom layer a drawing adds, holding its ledger */
function drawingLayer(id: string) {
  return { id, type: 'custom', getGpuLedger: () => ({ snapshot: () => HELD }) };
}

describe('the scene that reads what the drawing holds on the GPU', () => {
  it('finds the ledger in a custom layer of the drawing, which getStyle does not list', () => {
    const map = maplibreLikeMap();
    // The page keeps the ids before the drawing adds its layers
    const ids = recordCustomLayers(map as unknown as maplibregl.Map);
    map.addLayer({ id: 'other', type: 'custom' });
    map.addLayer(drawingLayer('drawing-0'));
    map.addLayer({ id: 'line', type: 'line' });
    expect(map.getStyle().layers.map((layer) => layer.id)).toEqual(['bg', 'line']);
    expect([...ids]).toEqual(['other', 'drawing-0']);
    expect(gpuMemoryOf(map as unknown as maplibregl.Map, ids)).toEqual(HELD);
  });

  it('tells there is no ledger when no layer of a drawing was added', () => {
    const map = maplibreLikeMap();
    const ids = recordCustomLayers(map as unknown as maplibregl.Map);
    map.addLayer({ id: 'other', type: 'custom' });
    expect(gpuMemoryOf(map as unknown as maplibregl.Map, ids)).toBeNull();
  });
});
