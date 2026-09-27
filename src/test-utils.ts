// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Helpers shared by the tests. This file is not part of the build.
 */

import type { Geometry } from 'geojson';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { vi } from 'vitest';
import type { Draw } from './api/v2/draw.js';
import type { ModeFactory } from './api/v2/extension/mode.js';
import type { ExtensionsCollections } from './api/v2/extensions.js';
import type { ModeServices } from './api/v2/impl/contexts.js';
import { createModeContext, createScreenContext } from './api/v2/impl/contexts.js';
import { createFeatures } from './api/v2/impl/features.js';
import { createGroups } from './api/v2/impl/groups.js';
import { bridgeMode, createInputRoute } from './api/v2/impl/input.js';
import { createLayers } from './api/v2/impl/layers.js';
import { createSelection } from './api/v2/impl/selection.js';
import type { ResourceDeps } from './api/v2/impl/shared.js';
import type { DatasetRow } from './dataset/types.js';
import { normalizeDisplayFeature } from './dataset/types.js';
import type { ModeManager } from './modes/manager.js';
import { DEFAULT_FEATURE_STYLE_CONFIG } from './shared/config/feature-style.js';
import { DEFAULT_BOX_SELECTION_STYLE_CONFIG } from './shared/config/rendering.js';
import { DEFAULT_SELECTION_CONFIG } from './shared/config/selection.js';
import type { Feature } from './shared/types/model.js';
import { EventEmitterImpl } from './shared/utils/event-emitter.js';
import { AutoNameGenerator } from './shared/utils/name-generator.js';
import type { SnapResult } from './snapping/types.js';
import type { Store } from './store/store.js';
import type { TerrainContext } from './view/terrain/context.js';
import { createSelectionExtensionRegistry } from './view/ui/selection-ui/extension-registry.js';

/**
 * Scales a time limit of a test that runs a browser
 *
 * The browser tests render on software WebGL, which is several times slower on a CI runner
 * than on a development machine. The CI workflow sets `BROWSER_TEST_TIMEOUT_SCALE`; without it
 * the limit is used as written.
 */
export function browserTimeout(ms: number): number {
  const scale = Number(process.env.BROWSER_TEST_TIMEOUT_SCALE ?? '1');
  return Number.isFinite(scale) && scale > 0 ? ms * scale : ms;
}

/** The shape the tests describe a dataset row in: that of a feature of the Store */
export interface TestRowInput {
  id?: string;
  type: string;
  coordinates: unknown;
  properties?: Record<string, unknown>;
  style?: DatasetRow['style'];
  /** `false` gives a row without a geometry */
  visible?: boolean;
}

/**
 * A dataset row (a GeoJSON feature) from the shape of a feature of the Store
 *
 * A row with `visible: false` gets a null geometry: a row without a geometry is how a dataset
 * holds a row that is neither drawn nor hit.
 */
export function toRow(input: TestRowInput): DatasetRow {
  const row: DatasetRow = {
    type: 'Feature',
    geometry:
      input.visible === false
        ? null
        : ({ type: input.type, coordinates: input.coordinates } as Geometry),
    properties: input.properties ?? {},
  };
  if (input.id !== undefined) row.id = input.id;
  if (input.style !== undefined) row.style = input.style;
  return row;
}

/** {@link toRow} over an array */
export function toRows(inputs: readonly TestRowInput[]): DatasetRow[] {
  return inputs.map(toRow);
}

/** The feature a dataset holds for a row given in the shape of a feature of the Store */
export function displayFeature(input: TestRowInput): Feature {
  return normalizeDisplayFeature(toRow(input), 0);
}

type Listener = (...args: unknown[]) => void;

interface StubLayer {
  id: string;
  onRemove?: (map: unknown, gl: unknown) => void;
}

/** A stub of the maplibre Map that records its listeners and layers */
export function createMapStub(options: { boxZoomEnabled?: boolean } = {}) {
  const mapListeners = new Map<string, Set<Listener>>();
  const canvasListeners = new Map<string, Set<Listener>>();
  const layers = new Map<string, StubLayer>();
  let boxZoomEnabled = options.boxZoomEnabled ?? true;

  const canvas = {
    tabIndex: -1,
    style: { outline: '' } as Record<string, string>,
    addEventListener: (type: string, fn: Listener) => {
      if (!canvasListeners.has(type)) canvasListeners.set(type, new Set());
      canvasListeners.get(type)?.add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      canvasListeners.get(type)?.delete(fn);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    focus: () => {},
    clientWidth: 800,
    clientHeight: 600,
    width: 800,
    height: 600,
  };

  const map = {
    style: { _loaded: true },
    on: (type: string, fn: Listener) => {
      if (!mapListeners.has(type)) mapListeners.set(type, new Set());
      mapListeners.get(type)?.add(fn);
      return map;
    },
    off: (type: string, fn: Listener) => {
      mapListeners.get(type)?.delete(fn);
      return map;
    },
    once: () => map,
    getCanvas: () => canvas,
    getCanvasContainer: () => canvas,
    getContainer: () => canvas,
    getLayer: (id: string) => layers.get(id),
    addLayer: (layer: StubLayer) => {
      layers.set(layer.id, layer);
      return map;
    },
    removeLayer: (id: string) => {
      const layer = layers.get(id);
      layers.delete(id);
      layer?.onRemove?.(map, null);
      return map;
    },
    getStyle: () => ({ layers: [...layers.values()].map((l) => ({ id: l.id })) }),
    triggerRepaint: vi.fn(),
    getZoom: () => 10,
    getPitch: () => 0,
    getBearing: () => 0,
    getCenter: () => ({ lng: 0, lat: 0 }),
    getBounds: () => ({
      getWest: () => -1,
      getEast: () => 1,
      getSouth: () => -1,
      getNorth: () => 1,
      getSouthWest: () => ({ lng: -1, lat: -1 }),
      getNorthEast: () => ({ lng: 1, lat: 1 }),
    }),
    project: (lngLat: { lng: number; lat: number } | [number, number]) => {
      const [lng, lat] = Array.isArray(lngLat) ? lngLat : [lngLat.lng, lngLat.lat];
      return { x: lng * 100 + 400, y: 300 - lat * 100 };
    },
    unproject: (p: [number, number] | { x: number; y: number }) => {
      const [x, y] = Array.isArray(p) ? p : [p.x, p.y];
      return { lng: (x - 400) / 100, lat: (300 - y) / 100 };
    },
    getTerrain: () => null,
    boxZoom: {
      isEnabled: () => boxZoomEnabled,
      enable: () => {
        boxZoomEnabled = true;
      },
      disable: () => {
        boxZoomEnabled = false;
      },
    },
    dragPan: { isEnabled: () => true, enable: () => {}, disable: () => {} },
    doubleClickZoom: { isEnabled: () => true, enable: () => {}, disable: () => {} },
  };

  const count = (listeners: Map<string, Set<Listener>>) =>
    [...listeners.values()].reduce((sum, set) => sum + set.size, 0);

  return {
    map: map as unknown as MapLibreMap,
    canvas,
    layers,
    mapListenerCount: () => count(mapListeners),
    canvasListenerCount: () => count(canvasListeners),
    isBoxZoomEnabled: () => boxZoomEnabled,
  };
}

/**
 * The dependencies of the resources of the draw instance over a Store, with IDs `id-1`,
 * `id-2` and so on, and the first layer as the active layer until another is set
 */
export function createResourceDeps(store: Store): ResourceDeps & { emitter: EventEmitterImpl } {
  let seq = 0;
  let active = '';
  const emitter = new EventEmitterImpl();
  return {
    store,
    generateId: () => `id-${++seq}`,
    autoNameGenerator: new AutoNameGenerator(store),
    getActiveLayerId: () => (store.getLayer(active) ? active : (store.listLayers()[0]?.id ?? '')),
    setActiveLayerId: (id) => {
      if (store.getLayer(id)) active = id;
    },
    featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
    eventEmitter: emitter,
    emitter,
  };
}

/**
 * Runs modes written to the extension contract in a mode manager without an engine: each mode
 * gets a `ModeContext` over the Store and the map given, and `route` is the input route to
 * pass to an input router
 */
export function createModeHarness(options: {
  store: Store;
  map: MapLibreMap;
  /** The mode manager the modes run in (a context only needs its setMode) */
  modeManager: ModeManager;
  /** The writable layer (the first layer of the Store when omitted) */
  getWritableLayerId?: () => string;
  /** Whether new features get their created zoom */
  scaleWithZoom?: boolean;
  /** The automatic names of new features */
  autoName?: boolean;
  /** Whether tracing is on (on when omitted) */
  tracing?: boolean;
  /** The result of `ctx.snap` */
  snapPoint?: (point: { x: number; y: number }) => SnapResult;
}) {
  const { store, map, modeManager } = options;
  const deps = createResourceDeps(store);
  const autoNameGenerator = new AutoNameGenerator(store, options.autoName !== false);
  const collections = {} as ExtensionsCollections;
  const features = createFeatures(deps);
  const groups = createGroups(deps);
  // The members of the draw instance the modes use; the rest is not needed without an engine
  const draw = {
    features,
    groups,
    layers: createLayers(deps),
    selection: createSelection(deps, { features, groups }),
    extensions: collections,
    getMap: () => map,
    getStore: () => store,
    getMode: () => modeManager.getMode(),
    setMode: (mode: string) => modeManager.setMode(mode),
    transact: <T>(fn: () => T, options?: { source?: string }) =>
      store.transact(fn, options?.source),
    options: {
      get: () => ({
        tracing: { enabled: options.tracing !== false },
        snapping: { tolerancePx: 10, datasets: true },
      }),
      update: () => {},
    },
  } as unknown as Draw;
  const services: ModeServices = {
    map,
    store,
    terrain: {} as TerrainContext,
    pixelRatio: { resolve: () => 1, getRenderScale: () => 1 },
    autoNameGenerator,
    selectionExtensions: createSelectionExtensionRegistry(),
    spatialIndex: { invalidate: () => {}, invalidateType: () => {} },
    modeManager,
    getDraw: () => draw,
    collections,
    hitTestTopmost: () => null,
    distanceToFeaturePx: () => 0,
    snapPoint: options.snapPoint ?? ((point) => ({ lngLat: map.unproject([point.x, point.y]) })),
    listTraceRows: () => [],
    getWritableLayerId:
      options.getWritableLayerId ??
      (() => store.listLayers().find((l) => l.visible && !l.locked)?.id ?? ''),
    generateId: deps.generateId,
    scaleWithZoom: options.scaleWithZoom ?? false,
    selectionStyle: DEFAULT_SELECTION_CONFIG,
    boxSelectionStyle: DEFAULT_BOX_SELECTION_STYLE_CONFIG,
  };
  const screen = createScreenContext({
    map,
    pixelRatio: services.pixelRatio,
    selectionExtensions: services.selectionExtensions,
  });
  return {
    draw,
    route: createInputRoute(() => []),
    /** A new context of a mode */
    modeContext: () => createModeContext(services, screen).context,
    /** Registers a mode of the contract with the mode manager */
    register(name: string, factory: ModeFactory): () => void {
      return modeManager.registerMode(name, () => {
        const handle = createModeContext(services, screen);
        return bridgeMode(name, factory(handle.context), handle.dispose);
      });
    },
  };
}

/**
 * A pointer input as a mode of the extension contract receives it, snapped to where it is
 *
 * @param point - The point on the screen; `[lng * 1000, lat * 1000]` when omitted
 */
export function pointerInput(lng: number, lat: number, point?: [number, number]) {
  return {
    point: point ?? ([lng * 1000, lat * 1000] as [number, number]),
    lngLat: [lng, lat],
    snapped: { lngLat: [lng, lat] },
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    pointerType: 'mouse' as const,
    original: {} as PointerEvent,
  };
}

/** A key input as a mode of the extension contract receives it */
export function keyInput(key: string) {
  return {
    key,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    original: {} as KeyboardEvent,
  };
}
