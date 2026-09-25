// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for PluginContext
 *
 * Pins down that batch is wrapped in store.transact and that several writes
 * merge into a single StateChanges notification (= a single unit for a subscriber that
 * groups changes into steps).
 */

import { describe, expect, it } from 'vitest';
import type { MapLibreGLDraw } from '../maplibre-gl-draw.js';
import type { ModeManager } from '../modes/manager.js';
import { EventEmitterImpl } from '../shared/utils/event-emitter.js';
import { MemoryStore } from '../store/memory.js';
import { StoreSpatialIndex } from '../store/spatial/index.js';
import { setAnchorFrame } from '../view/terrain/anchor.js';
import { TerrainContext } from '../view/terrain/context.js';
import type { TerrainLike } from '../view/terrain/detect.js';
import { createSelectionExtensionRegistry } from '../view/ui/selection-ui/index.js';
import { createPluginContext } from './plugin-context.js';

function createContext(
  terrain = new TerrainContext(),
  selectionExtensions = createSelectionExtensionRegistry(),
) {
  const store = new MemoryStore();
  const layerId = 'layer-1';
  store.createLayer({
    id: layerId,
    name: 'Layer 1',
    visible: true,
    locked: false,
    opacity: 1,
    order: [],
  });
  const ctx = createPluginContext({
    store,
    eventEmitter: new EventEmitterImpl(),
    spatialIndex: new StoreSpatialIndex(store),
    getActiveLayerId: () => layerId,
    findLayerForItem: () => layerId,
    findGroupForFeature: () => undefined,
    getModeManager: () => ({}) as unknown as ModeManager,
    getDraw: () => ({}) as unknown as MapLibreGLDraw,
    terrain,
    selectionExtensions,
  });
  return { store, ctx, layerId };
}

describe('PluginContext.batch', () => {
  it('merges several writes inside batch into one StateChanges notification', () => {
    const { store, ctx } = createContext();
    const id = ctx.addFeatures([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [0, 0] },
        properties: {},
      },
    ])[0];

    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    ctx.batch(() => {
      ctx.updateFeature(id, { properties: { a: 1 } });
      ctx.addFeatures([
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [1, 1] },
          properties: {},
        },
      ]);
      ctx.updateFeature(id, { properties: { b: 2 } });
    });

    expect(notifications).toBe(1);
    expect(ctx.getFeature(id)?.properties).toMatchObject({ a: 1, b: 2 });
  });

  it('notifies writes outside batch individually as before', () => {
    const { store, ctx } = createContext();
    const id = ctx.addFeatures([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [0, 0] },
        properties: {},
      },
    ])[0];

    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    ctx.updateFeature(id, { properties: { a: 1 } });
    ctx.updateFeature(id, { properties: { b: 2 } });

    expect(notifications).toBe(2);
  });
});

describe('PluginContext mutations', () => {
  it('carries the given source on the Store notification', () => {
    const { store, ctx } = createContext();
    const sources: unknown[] = [];
    store.subscribe((changes) => sources.push(changes.source));

    const [id] = ctx.addFeatures(
      [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }],
      'remote',
    );
    ctx.updateFeature(id, { properties: { a: 1 } }, 'remote');
    ctx.deleteFeatures([id]);

    expect(sources).toEqual(['remote', 'remote', 'local']);
  });
});

describe('PluginContext while read-only', () => {
  it('addFeatures returns an empty list and adds nothing', () => {
    const { store, ctx } = createContext();
    store.setReadOnly(true);
    const ids = ctx.addFeatures([
      {
        type: 'Feature',
        id: 'f1',
        geometry: { type: 'Point', coordinates: [0, 0] },
        properties: {},
      },
    ]);
    expect(ids).toEqual([]);
    expect(store.getFeature('f1')).toBeUndefined();
  });

  it('addFeatures returns the IDs when writable', () => {
    const { ctx } = createContext();
    const ids = ctx.addFeatures([
      {
        type: 'Feature',
        id: 'f1',
        geometry: { type: 'Point', coordinates: [0, 0] },
        properties: {},
      },
    ]);
    expect(ids).toEqual(['f1']);
  });
});

describe('PluginContext.setLayerItemOrder', () => {
  function withTwoLayers() {
    const context = createContext();
    const { store, layerId } = context;
    store.createLayer({
      id: 'layer-2',
      name: 'Layer 2',
      visible: true,
      locked: false,
      opacity: 1,
      order: [],
    });
    for (const [id, lid] of [
      ['a', layerId],
      ['b', layerId],
      ['c', 'layer-2'],
      ['d', 'layer-2'],
    ] as const) {
      store.createFeature({
        id,
        type: 'Point',
        coordinates: [0, 0],
        layerId: lid,
        properties: {},
        locked: false,
        visible: true,
      });
    }
    return context;
  }

  it('replaces the item order of the named layer, not of the active layer', () => {
    const { store, ctx, layerId } = withTwoLayers();
    ctx.setLayerItemOrder('layer-2', ['d', 'c']);
    expect(store.getLayer('layer-2')?.order).toEqual(['d', 'c']);
    expect(store.getLayer(layerId)?.order).toEqual(['a', 'b']);
  });

  it('carries the given source', () => {
    const { store, ctx } = withTwoLayers();
    const sources: unknown[] = [];
    store.subscribe((changes) => sources.push(changes.source));
    ctx.setLayerItemOrder('layer-2', ['d', 'c'], 'remote');
    expect(sources).toEqual(['remote']);
  });

  it('does nothing for a layer that does not exist', () => {
    const { store, ctx } = withTwoLayers();
    const notified: unknown[] = [];
    store.subscribe((changes) => notified.push(changes));
    expect(() => ctx.setLayerItemOrder('missing', ['a'])).not.toThrow();
    expect(notified).toEqual([]);
  });
});

describe('PluginContext.invalidateFeatures', () => {
  it('re-measures the features of the type with their bounding box calculator', () => {
    const store = new MemoryStore();
    store.createLayer({ id: 'l', name: 'l', visible: true, locked: false, opacity: 1, order: [] });
    const spatialIndex = new StoreSpatialIndex(store);
    const ctx = createPluginContext({
      store,
      eventEmitter: new EventEmitterImpl(),
      spatialIndex,
      getActiveLayerId: () => 'l',
      findLayerForItem: () => 'l',
      findGroupForFeature: () => undefined,
      getModeManager: () => ({}) as unknown as ModeManager,
      getDraw: () => ({}) as unknown as MapLibreGLDraw,
      terrain: new TerrainContext(),
      selectionExtensions: createSelectionExtensionRegistry(),
    });
    // The extent depends on something outside the Store (a font that arrives later)
    let size = 0;
    spatialIndex.setCustomBoundingBoxCalculator('Point', (feature) => {
      const [lng, lat] = feature.coordinates as [number, number];
      return { minX: lng - size, minY: lat - size, maxX: lng + size, maxY: lat + size };
    });
    const [id] = ctx.addFeatures([
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
    ]);
    expect(spatialIndex.findNear([0.5, 0.5], 0)).toEqual([]);

    size = 1;
    ctx.invalidateFeatures('Point');

    expect(spatialIndex.findNear([0.5, 0.5], 0)).toEqual([id]);
  });
});

describe('the terrain anchors and selection extents of PluginContext', () => {
  /** A terrain stand-in that only returns a fixed elevation */
  function terrainOf(elevation: number): TerrainLike {
    return {
      getTerrainData: () => null,
      getElevationForLngLatZoom: () => elevation,
      tileManager: { getRenderableTiles: () => [] },
    } as unknown as TerrainLike;
  }

  function frame(context: TerrainContext, elevation: number): void {
    setAnchorFrame(context, {
      terrain: terrainOf(elevation),
      zoom: 14,
      elevationScale: 1e-3,
      mainMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 4, 1, 0, 0, 0, 0, 1],
      offsetUniforms: {
        centerLngLat: [0, 0],
        centerLngLat64: [0, 0],
        centerMercator: [0.5, 0.5],
        projectionCenter: [0, 0, 0, 1],
        unitsPerDegree: [1, 1, 1],
        unitsPerDegree2: [0, 0, 0],
      },
      width: 800,
      height: 600,
    });
  }

  it('reads the terrain of its own draw instance, not of the instance drawn last', () => {
    const editorTerrain = new TerrainContext();
    const previewTerrain = new TerrainContext();
    const { ctx: editor } = createContext(editorTerrain);
    const { ctx: preview } = createContext(previewTerrain);

    frame(editorTerrain, 1000);
    // The preview draws after the editor, on flat ground
    frame(previewTerrain, 0);

    expect(editor.anchorElevationMeters(0, 0)).toBe(1000);
    expect(preview.anchorElevationMeters(0, 0)).toBe(0);
    expect(editor.projectAnchor(0, 0)?.y).toBeLessThan(preview.projectAnchor(0, 0)?.y ?? 0);
  });

  it('returns null from projectAnchor before any frame of its instance was drawn', () => {
    const { ctx } = createContext();
    expect(ctx.projectAnchor(0, 0)).toBeNull();
    expect(ctx.anchorElevationMeters(0, 0)).toBe(0);
  });

  it('computes the selection extent with the custom types of its own instance', () => {
    const extensions = createSelectionExtensionRegistry();
    extensions.registerBoundingBox('Card', () => ({
      topLeft: [-1, 1],
      topRight: [1, 1],
      bottomRight: [1, -1],
      bottomLeft: [-1, -1],
      center: [0, 0],
    }));
    const { ctx } = createContext(new TerrainContext(), extensions);
    const { ctx: other } = createContext();
    const card = {
      id: 'c1',
      type: 'Card',
      coordinates: [5, 5] as [number, number],
      layerId: 'layer-1',
      properties: {},
      locked: false,
      visible: true,
    };

    expect(ctx.computeBoundingBox(card)?.topLeft).toEqual([-1, 1]);
    // The other instance has no registration for the type, so it measures the coordinates
    expect(other.computeBoundingBox(card)?.topLeft).toEqual([5, 5]);
  });
});

describe('PluginContext.getStore / on', () => {
  it('gives the Store of the instance, behind the read-only gate', () => {
    const { store, ctx, layerId } = createContext();
    expect(ctx.getStore()).toBe(store);

    store.setReadOnly(true);
    const feature = {
      id: 'f1',
      type: 'Point',
      coordinates: [0, 0] as [number, number],
      layerId,
      properties: {},
      locked: false,
      visible: true,
    };
    expect(ctx.getStore().createFeature(feature)).toBe(false);
    expect(store.getFeature('f1')).toBeUndefined();
  });

  it('returns the function that unsubscribes the handler', () => {
    const { ctx } = createContext();
    const received: string[] = [];
    const off = ctx.on('snap.change', () => received.push('snap'));

    ctx.emit('snap.change', { snapped: false } as never);
    off();
    ctx.emit('snap.change', { snapped: false } as never);

    expect(received).toEqual(['snap']);
  });
});
