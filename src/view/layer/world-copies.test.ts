// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for drawing the copies of the world across the antimeridian
 *
 * The features are stored with longitudes in [-180, 180]. A view across the antimeridian draws
 * the features stored on the other side of the line as a second copy, moved by 360 degrees
 * through a virtual camera: the center moves by -360 (so the offsets the CPU computes come out
 * next to the camera) and the matrix by +360 (so the two cancel). A view away from the line
 * draws one copy, exactly as before.
 *
 * A custom feature renderer records what it is asked to draw: the center and the matrix of the
 * copy it is drawn on.
 */

import type { CustomRenderMethodInput, Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { LngLatBounds } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HitTestStrategy } from '../../dispatcher/hit-test/strategies/base.js';
import type { CustomFeatureHandler, CustomRendererDrawContext } from '../../extension/index.js';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../../shared/config/feature-style.js';
import { DEFAULT_RENDERING_CONFIG } from '../../shared/config/rendering.js';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import { coordinatesOf, geometryFromCoordinates } from '../../shared/utils/coordinates.js';
import { MemoryStore } from '../../store/memory.js';
import { StoreSpatialIndex } from '../../store/spatial/store-spatial-index.js';
import type { Feature } from '../../store/types.js';
import { createFeatureCompanionRegistry } from '../feature-companion.js';
import { createSelectionScope } from '../ui/selection-scope.js';
import { createCustomLayer } from './custom-layer.js';

/** The calls of the selection UI: which features, on which copy (the x translation) */
const selectionDraws: Array<{ ids: string[]; matrixX: number }> = [];

vi.mock('../ui/selection-ui-drawer.js', () => ({
  renderSelectionUI: (features: Feature[], _zoom: number, projectionData: ProjectionData) => {
    selectionDraws.push({
      ids: features.map((f) => f.id),
      matrixX: (projectionData.mainMatrix as ArrayLike<number>)[12],
    });
  },
  renderFollowedVertices: () => {},
}));

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

/** A map looking at `center` with a view `halfWidth` degrees to each side (unwrapped) */
function createMapStub(center: number, halfWidth: number): MapLibreMap {
  const canvas = Object.assign(new EventTarget(), {
    width: 800,
    height: 600,
    clientWidth: 800,
    clientHeight: 600,
  });
  const layers = new Map<string, unknown>();
  return {
    getCanvas: () => canvas,
    getLayer: (id: string) => layers.get(id),
    addLayer: (layer: { id: string }) => layers.set(layer.id, layer),
    removeLayer: (id: string) => layers.delete(id),
    triggerRepaint: vi.fn(),
    getCenter: () => ({ lng: center, lat: 0 }),
    getZoom: () => 14,
    getBearing: () => 0,
    getPitch: () => 0,
    isMoving: () => false,
    isZooming: () => false,
    getTerrain: () => null,
    getBounds: () => new LngLatBounds([center - halfWidth, -0.1], [center + halfWidth, 0.1]),
    project: () => ({ x: 0, y: 0 }),
    unproject: () => ({ lng: 0, lat: 0 }),
    transform: { tileSize: 512 },
  } as unknown as MapLibreMap;
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

/** One draw of a probe: which feature, on which center, with which matrix */
interface ProbeDraw {
  id: string;
  centerLng: number;
  matrixX: number;
}

function probe(id: string, lng: number): Feature {
  return {
    id,
    type: 'Probe',
    geometry: geometryFromCoordinates('Probe', [lng, 0]),
    layerId: 'l1',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

function setup(center: number, halfWidth: number, lngs: Record<string, number>) {
  const { gl } = createGlStub();
  const map = createMapStub(center, halfWidth);
  const store = new MemoryStore();
  store.createLayer({
    id: 'l1',
    name: 'l1',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  });
  for (const [id, lng] of Object.entries(lngs)) store.createFeature(probe(id, lng));

  const draws: ProbeDraw[] = [];
  const handler = {
    type: 'Probe',
    renderer: {
      onAdd: () => {},
      onRemove: () => {},
      draw: (
        feature: { id: string },
        projectionData: ProjectionData,
        _zoom: number,
        context: CustomRendererDrawContext,
      ) => {
        draws.push({
          id: feature.id,
          centerLng: context.centerLngLat[0],
          matrixX: (projectionData.mainMatrix as ArrayLike<number>)[12],
        });
      },
    },
    hitTest: { featureType: 'Probe' } as unknown as HitTestStrategy,
  } as unknown as CustomFeatureHandler;

  const spatialIndex = new StoreSpatialIndex(store);
  spatialIndex.setCustomBoundingBoxCalculator('Probe', (feature) => {
    const [lng, lat] = coordinatesOf(feature) as [number, number];
    return { minX: lng, minY: lat, maxX: lng, maxY: lat };
  });
  const layer = createCustomLayer({
    map,
    store,
    spatialIndex,
    featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
    selectionConfig: DEFAULT_SELECTION_CONFIG,
    renderingConfig: DEFAULT_RENDERING_CONFIG,
    customFeatureHandlers: [handler],
    featureCompanions: createFeatureCompanionRegistry(),
    selectionScope: createSelectionScope(),
  });
  layer.onAdd?.(map, gl);
  return { gl, layer, draws, store };
}

describe('drawing the copies of the world across the antimeridian', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    selectionDraws.length = 0;
  });

  it('draws the features at 179.9 and -179.9 next to each other', () => {
    const { gl, layer, draws } = setup(179.95, 0.1, { east: 179.9, west: -179.9 });
    layer.render(gl, renderInput());

    // Each feature is drawn once, on the copy the view shows it on
    expect(draws.map((d) => d.id).sort()).toEqual(['east', 'west']);
    const east = draws.find((d) => d.id === 'east');
    const west = draws.find((d) => d.id === 'west');

    // The stored copy: the real camera and the matrix as maplibre gave it
    expect(east?.centerLng).toBeCloseTo(179.95);
    expect(east?.matrixX).toBe(0);
    // The copy east of the line: the center moved by -360 and the matrix by +360 (one turn is
    // 1 in Mercator units, times the x scale of the identity matrix)
    expect(west?.centerLng).toBeCloseTo(179.95 - 360);
    expect(west?.matrixX).toBeCloseTo(1);

    // The offsets the CPU computes against each center put both next to the camera
    expect(179.9 - (east?.centerLng ?? 0)).toBeCloseTo(-0.05);
    expect(-179.9 - (west?.centerLng ?? 0)).toBeCloseTo(0.15);
  });

  it('draws one copy when the view does not cross the antimeridian', () => {
    const { gl, layer, draws } = setup(139.7, 0.1, { a: 139.65, b: 139.75, far: -179.9 });
    layer.render(gl, renderInput());

    expect(draws.map((d) => d.id).sort()).toEqual(['a', 'b']);
    for (const draw of draws) {
      expect(draw.centerLng).toBeCloseTo(139.7);
      expect(draw.matrixX).toBe(0);
    }
  });

  it('draws the selection UI of a feature on the copy it is drawn on', () => {
    const { gl, layer, store } = setup(179.95, 0.1, { east: 179.9, west: -179.9 });
    store.setSelection('feature', ['east', 'west']);
    layer.render(gl, renderInput());

    // One call per copy, each with the selected features of that copy
    expect(selectionDraws).toHaveLength(2);
    const stored = selectionDraws.find((d) => d.matrixX === 0);
    const moved = selectionDraws.find((d) => d.matrixX !== 0);
    expect(stored?.ids).toEqual(['east']);
    expect(moved?.ids).toEqual(['west']);
    expect(moved?.matrixX).toBeCloseTo(1);
  });

  it('draws the selection UI once away from the antimeridian', () => {
    const { gl, layer, store } = setup(139.7, 0.1, { a: 139.65 });
    store.setSelection('feature', ['a']);
    layer.render(gl, renderInput());

    expect(selectionDraws).toEqual([{ ids: ['a'], matrixX: 0 }]);
  });
});
