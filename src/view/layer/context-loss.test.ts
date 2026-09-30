// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the loss and the restore of the WebGL context
 *
 * Every GL object dies with the context, so the engine must be able to drop its GPU resources
 * and create them again. Two shapes are covered:
 *
 * - maplibre 6.6 removes every custom layer when the context is lost (onRemove) and the host adds
 *   them back after the restore (onAdd). The overlay renderers registered once must survive this
 *   and receive onAdd again
 * - A layer that stays on the map through the loss follows the canvas events: the GPU side is
 *   dropped on `webglcontextlost` and created again on `webglcontextrestored`
 */

import type { CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineOverlayRenderer } from '../../extension/index.js';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../../shared/config/feature-style.js';
import { DEFAULT_RENDERING_CONFIG } from '../../shared/config/rendering.js';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import { MemoryStore } from '../../store/memory.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import { createFeatureCompanionRegistry } from '../feature-companion.js';
import { createSelectionScope } from '../ui/selection-scope.js';
import { createCustomLayer } from './custom-layer.js';

/** Counts of the GL objects created and deleted, and the loss flag */
interface GlStats {
  created: number;
  deleted: number;
  lost: boolean;
}

/**
 * A WebGL2 context that accepts every call
 *
 * Constants resolve to stable numbers, create* returns a fresh object, and the status queries
 * report success. While `lost` is set, create* returns null the way a lost context does.
 */
function createGlStub(): { gl: WebGL2RenderingContext; stats: GlStats } {
  const stats: GlStats = { created: 0, deleted: 0, lost: false };
  const constants = new Map<string, number>();
  const functions = new Map<string, (...args: unknown[]) => unknown>();

  const constantOf = (name: string): number => {
    let value = constants.get(name);
    if (value === undefined) {
      value = 0x1000 + constants.size;
      constants.set(name, value);
    }
    return value;
  };

  const functionOf = (name: string): ((...args: unknown[]) => unknown) => {
    const existing = functions.get(name);
    if (existing) return existing;
    let fn: (...args: unknown[]) => unknown;
    if (name.startsWith('create')) {
      fn = () => {
        if (stats.lost) return null;
        stats.created++;
        return { kind: name };
      };
    } else if (name.startsWith('delete')) {
      fn = () => {
        stats.deleted++;
      };
    } else if (name === 'isContextLost') {
      fn = () => stats.lost;
    } else if (name === 'getShaderParameter' || name === 'getProgramParameter') {
      fn = () => true;
    } else if (name === 'getShaderInfoLog' || name === 'getProgramInfoLog') {
      fn = () => '';
    } else if (name === 'getUniformLocation') {
      fn = () => ({});
    } else if (name === 'getAttribLocation' || name === 'getUniformBlockIndex') {
      fn = () => 0;
    } else if (name === 'checkFramebufferStatus') {
      fn = () => constantOf('FRAMEBUFFER_COMPLETE');
    } else if (name === 'getParameter') {
      fn = () => 4096;
    } else if (name === 'getExtension') {
      fn = () => null;
    } else if (name === 'getSupportedExtensions') {
      fn = () => [];
    } else {
      fn = () => undefined;
    }
    functions.set(name, fn);
    return fn;
  };

  const gl = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (/^[A-Z0-9_]+$/.test(prop)) return constantOf(prop);
        if (prop === 'canvas') return { width: 800, height: 600 };
        if (prop === 'drawingBufferWidth') return 800;
        if (prop === 'drawingBufferHeight') return 600;
        return functionOf(prop);
      },
    },
  ) as unknown as WebGL2RenderingContext;

  return { gl, stats };
}

/** The part of the maplibre Map the engine reads, with the canvas as an event target */
function createMapStub(): { map: MapLibreMap; canvas: EventTarget } {
  const canvas = Object.assign(new EventTarget(), {
    width: 800,
    height: 600,
    clientWidth: 800,
    clientHeight: 600,
  });
  const layers = new Map<string, unknown>();
  const map = {
    getCanvas: () => canvas,
    getLayer: (id: string) => layers.get(id),
    addLayer: (layer: { id: string }) => layers.set(layer.id, layer),
    removeLayer: (id: string) => layers.delete(id),
    triggerRepaint: vi.fn(),
    getCenter: () => ({ lng: 139.7, lat: 35.7 }),
    getZoom: () => 12,
    getBearing: () => 0,
    getPitch: () => 0,
    isMoving: () => false,
    isZooming: () => false,
    getTerrain: () => null,
    getBounds: () => ({
      getWest: () => 139.6,
      getEast: () => 139.8,
      getSouth: () => 35.6,
      getNorth: () => 35.8,
      getSouthWest: () => ({ lng: 139.6, lat: 35.6 }),
      getNorthEast: () => ({ lng: 139.8, lat: 35.8 }),
    }),
    project: () => ({ x: 0, y: 0 }),
    unproject: () => ({ lng: 0, lat: 0 }),
    transform: { tileSize: 512 },
  } as unknown as MapLibreMap;
  return { map, canvas };
}

/** An overlay renderer that records its lifecycle */
function createOverlaySpy(): EngineOverlayRenderer & { log: string[] } {
  const log: string[] = [];
  return {
    name: 'spy',
    order: 'overlay',
    log,
    onAdd: () => {
      log.push('add');
    },
    draw: () => {
      log.push('draw');
    },
    onRemove: () => {
      log.push('remove');
    },
  };
}

/** A render input with identity matrices (enough to run one frame of an empty Store) */
function renderInput(): CustomRenderMethodInput {
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const projectionData = {
    mainMatrix: identity,
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 0],
    projectionTransition: 0,
    fallbackMatrix: identity,
  };
  return {
    farZ: 1,
    nearZ: 0,
    fov: 0.6,
    modelViewProjectionMatrix: identity,
    projectionMatrix: identity,
    shaderData: {
      variantName: 'mercator',
      vertexShaderPrelude: '',
      define: '',
    },
    defaultProjectionData: projectionData,
    getProjectionData: () => projectionData,
  } as unknown as CustomRenderMethodInput;
}

function setup() {
  const { gl, stats } = createGlStub();
  const { map, canvas } = createMapStub();
  const store = new MemoryStore();
  const layer = createCustomLayer({
    map,
    store,
    spatialIndex: new RBushSpatialIndex(),
    featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
    selectionConfig: DEFAULT_SELECTION_CONFIG,
    renderingConfig: DEFAULT_RENDERING_CONFIG,
    featureCompanions: createFeatureCompanionRegistry(),
    selectionScope: createSelectionScope(),
  });
  return { gl, stats, map, canvas, layer };
}

describe('WebGL context loss and restore', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the overlay renderers when maplibre removes the layer and adds it back', () => {
    const { gl, map, layer } = setup();
    const before = createOverlaySpy();
    layer.addOverlay(before);

    layer.onAdd?.(map, gl);
    const after = createOverlaySpy();
    layer.addOverlay(after);

    // maplibre 6.6 on a context loss: the style is destroyed and every layer gets onRemove
    layer.onRemove?.(map, gl);
    // The host adds the layer again once the style is restored
    layer.onAdd?.(map, gl);

    expect(before.log).toEqual(['add', 'remove', 'add']);
    expect(after.log).toEqual(['add', 'remove', 'add']);
  });

  it('drops the GPU resources on the loss and creates them again on the restore', () => {
    const { gl, stats, map, canvas, layer } = setup();
    const overlay = createOverlaySpy();
    layer.addOverlay(overlay);
    layer.onAdd?.(map, gl);
    const createdAtAdd = stats.created;
    expect(createdAtAdd).toBeGreaterThan(0);

    stats.lost = true;
    canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(stats.deleted).toBeGreaterThan(0);
    expect(overlay.log).toEqual(['add', 'remove']);

    // A frame requested while the context is lost draws nothing and does not throw
    expect(() => layer.render(gl, renderInput())).not.toThrow();
    expect(overlay.log).toEqual(['add', 'remove']);

    stats.lost = false;
    const createdBeforeRestore = stats.created;
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(stats.created - createdBeforeRestore).toBe(createdAtAdd);
    expect(overlay.log).toEqual(['add', 'remove', 'add']);
    expect(map.triggerRepaint).toHaveBeenCalled();

    // The restored engine draws a frame again
    expect(() => layer.render(gl, renderInput())).not.toThrow();
    expect(overlay.log[overlay.log.length - 1]).toBe('draw');
  });

  it('does not build on a lost context and builds once the context comes back', () => {
    const { gl, stats, map, canvas, layer } = setup();
    stats.lost = true;
    layer.onAdd?.(map, gl);
    expect(stats.created).toBe(0);
    expect(() => layer.render(gl, renderInput())).not.toThrow();

    stats.lost = false;
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(stats.created).toBeGreaterThan(0);
  });

  it('stops following the canvas once the layer is removed', () => {
    const { gl, stats, map, canvas, layer } = setup();
    layer.onAdd?.(map, gl);
    layer.onRemove?.(map, gl);
    const created = stats.created;
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(stats.created).toBe(created);
  });
});

describe('the lifetime of the GPU resources', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('removing the layer deletes every GL object it created', () => {
    const { gl, stats, map, layer } = setup();
    layer.onAdd?.(map, gl);
    layer.render(gl, renderInput());
    layer.onRemove?.(map, gl);

    expect(stats.created).toBeGreaterThan(0);
    expect(stats.deleted).toBe(stats.created);
  });

  it('adding and removing the layer again does not accumulate GL objects', () => {
    const { gl, stats, map, layer } = setup();
    for (let i = 0; i < 3; i++) {
      layer.onAdd?.(map, gl);
      layer.render(gl, renderInput());
      layer.onRemove?.(map, gl);
    }
    expect(stats.created - stats.deleted).toBe(0);
  });
});
