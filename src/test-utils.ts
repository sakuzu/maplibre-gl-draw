// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Helpers shared by the tests. This file is not part of the build.
 */

import type { Geometry } from 'geojson';
import type { CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { vi } from 'vitest';
import type { Draw } from './api/draw.js';
import type { ModeFactory } from './api/extension/mode.js';
import type { ExtensionsCollections } from './api/extensions.js';
import type { ModeServices } from './api/impl/contexts.js';
import { createModeContext, createScreenContext } from './api/impl/contexts.js';
import { createDrawOnEngine } from './api/impl/create-draw.js';
import type { Engine } from './api/impl/engine.js';
import { createEngine } from './api/impl/engine.js';
import { createFeatures } from './api/impl/features.js';
import { createGroups } from './api/impl/groups.js';
import { bridgeMode, createInputRoute } from './api/impl/input.js';
import { createLayers } from './api/impl/layers.js';
import { checkDrawOptions, toEngineOptions } from './api/impl/options.js';
import { createSelection } from './api/impl/selection.js';
import type { ResourceDeps } from './api/impl/shared.js';
import { withLocksIgnored } from './api/impl/shared.js';
import type { DrawOptions } from './api/options.js';
import type { DatasetRow } from './dataset/types.js';
import { normalizeDisplayFeature } from './dataset/types.js';
import type { InputRouter } from './dispatcher/input-router.js';
import type { KeyNormalizedEvent, ModifierKeys, MouseNormalizedEvent } from './dispatcher/types.js';
import type { ModeManager } from './modes/manager.js';
import { DEFAULT_BOX_SELECTION_STYLE_CONFIG } from './shared/config/rendering.js';
import { DEFAULT_SELECTION_CONFIG } from './shared/config/selection.js';
import type { Feature } from './shared/types/model.js';
import { EventEmitterImpl } from './shared/utils/event-emitter.js';
import { AutoNameGenerator } from './shared/utils/name-generator.js';
import { type WorkCounts, workCountsOf } from './shared/work-counts.js';
import type { SnapResult } from './snapping/types.js';
import { MemoryStore } from './store/memory.js';
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
    getStyleOptions: () => undefined,
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
    transact: <T>(fn: () => T, options?: { source?: string; ignoreLocks?: boolean }) => {
      const run = () => store.transact(fn, options?.source);
      return options?.ignoreLocks === true ? withLocksIgnored(store, run) : run();
    },
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
    pixelRatio: { resolve: () => 1, getScaleFactor: () => 1 },
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
    notifyDrawCommit: () => {},
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
        return bridgeMode(name, factory(handle.context), handle.dispose, handle.entering);
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

/** A position of a synthetic input: `[lng, lat]` or `{ lng, lat }` */
export type SyntheticLngLat = [number, number] | { lng: number; lat: number };

/** The modifier keys of a synthetic input; the ones left out are up */
export interface SyntheticModifiers {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/**
 * Synthetic input for the tests: normalized events handed to the input router of an engine,
 * as a real pointer and keyboard would produce them (the screen point comes from
 * `map.project`)
 */
export function createSyntheticInput(engine: {
  map: Pick<MapLibreMap, 'project'>;
  inputRouter: InputRouter;
}) {
  const { map, inputRouter } = engine;
  const toModifiers = (modifiers: SyntheticModifiers = {}): ModifierKeys => ({
    shift: modifiers.shift ?? false,
    ctrl: modifiers.ctrl ?? false,
    alt: modifiers.alt ?? false,
    meta: modifiers.meta ?? false,
  });
  const inert = (fields: Record<string, unknown>) => ({
    target: null,
    currentTarget: null,
    defaultPrevented: false,
    preventDefault(): void {},
    stopPropagation(): void {},
    stopImmediatePropagation(): void {},
    ...fields,
  });
  const mouse = (
    type: MouseNormalizedEvent['type'],
    lngLat: SyntheticLngLat,
    options: { modifiers?: SyntheticModifiers; snap?: boolean } = {},
  ): MouseNormalizedEvent => {
    const { lng, lat } = Array.isArray(lngLat) ? { lng: lngLat[0], lat: lngLat[1] } : lngLat;
    const projected = map.project([lng, lat]);
    const point = { x: projected.x, y: projected.y };
    const modifiers = toModifiers(options.modifiers);
    return {
      type,
      point,
      lngLat: { lng, lat },
      originalEvent: inert({
        type,
        button: 0,
        buttons: 0,
        clientX: point.x,
        clientY: point.y,
        shiftKey: modifiers.shift,
        ctrlKey: modifiers.ctrl,
        altKey: modifiers.alt,
        metaKey: modifiers.meta,
      }) as unknown as MouseEvent,
      modifiers,
      snap: options.snap ?? true,
    };
  };
  const codeOf = (key: string): string => {
    if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    if (key === ' ') return 'Space';
    return key;
  };
  return {
    /** A move to the position, then a click there */
    click(lngLat: SyntheticLngLat, options?: { modifiers?: SyntheticModifiers; snap?: boolean }) {
      inputRouter.dispatch(mouse('mousemove', lngLat, options));
      inputRouter.dispatch(mouse('click', lngLat, options));
    },
    /** A move to the position */
    move(lngLat: SyntheticLngLat, options?: { modifiers?: SyntheticModifiers; snap?: boolean }) {
      inputRouter.dispatch(mouse('mousemove', lngLat, options));
    },
    /** A key press */
    key(key: string, options: { modifiers?: SyntheticModifiers; code?: string } = {}) {
      const modifiers = toModifiers(options.modifiers);
      const code = options.code ?? codeOf(key);
      const event: KeyNormalizedEvent = {
        type: 'keydown',
        key,
        code,
        modifiers,
        originalEvent: inert({
          type: 'keydown',
          key,
          code,
          repeat: false,
          shiftKey: modifiers.shift,
          ctrlKey: modifiers.ctrl,
          altKey: modifiers.alt,
          metaKey: modifiers.meta,
        }) as unknown as KeyboardEvent,
      };
      inputRouter.dispatch(event);
    },
  };
}

// ============================================================================
// The work of a scene
//
// The tests bound an operation by the amount of work it does, not by the time it takes: the
// time varies from machine to machine, the amount does not. A test runs the same scene on
// 1,000 and on 10,000 features and compares what was counted: work that should not grow with
// the number of features must stay under twice as much (`expectNotProportional`). An operation
// that runs in parts is run on the fake clock, part by part, with a frame drawn between the
// parts (`runInParts`). The numbers are those of the Store of the instance
// (src/shared/work-counts.ts); the GL draw calls are counted by the GL the map is given
// (`createCountingGL`).
// ============================================================================

// The scenes

/**
 * The names of the scenes whose work is bounded, for the names of the tests
 *
 * A test of a scene is named after it, so that the scenes covered can be looked up.
 */
export const WORK_SCENES = {
  select: 'select',
  selectAll: 'select all',
  dragFrame: 'one frame of a drag',
  releasePart: 'one part of the write after the release',
  receiveChange: 'receive a change made outside the instance',
  writeBack: 'write back',
  deleteLayer: 'delete a layer',
  interleavedLayers: 'draw interleaved layers',
} as const;

/** The two numbers of features a scene is compared at */
export const WORK_SIZES = { small: 1_000, large: 10_000 } as const;

// ============================================================================
// The numbers
// ============================================================================

/** The numbers of a Store; throws for a Store that holds none */
export function countsOf(store: unknown): WorkCounts {
  const counts = workCountsOf(store);
  if (!counts) throw new Error('the Store holds no work counts');
  return counts;
}

/** What was added to the numbers while `fn` ran */
export function workDuring(counts: WorkCounts, fn: () => void): WorkCounts {
  const before = { ...counts };
  fn();
  return {
    rowsTouched: counts.rowsTouched - before.rowsTouched,
    objectsCreated: counts.objectsCreated - before.objectsCreated,
    rowsWritten: counts.rowsWritten - before.rowsWritten,
    notifications: counts.notifications - before.notifications,
  };
}

/** The amount a scene measured at the two sizes, and how much it grew */
export interface WorkComparison {
  small: number;
  large: number;
  /** large / small, with a small amount of zero taken as one */
  ratio: number;
}

/**
 * Runs a scene at both sizes
 *
 * @param scene Builds the scene for that number of features and returns the amount it
 *   measured (the building itself is not measured)
 */
export function compareWork(scene: (size: number) => number): WorkComparison {
  const small = scene(WORK_SIZES.small);
  const large = scene(WORK_SIZES.large);
  return { small, large, ratio: large / Math.max(small, 1) };
}

/**
 * Throws unless the amount of the scene grows less than twice from 1,000 to 10,000 features
 *
 * Ten times the features with work proportional to them gives ten times the amount; work
 * that does not depend on them gives about the same amount.
 *
 * @param what What was measured, for the message
 */
export function expectNotProportional(
  scene: (size: number) => number,
  what = 'the work',
): WorkComparison {
  const comparison = compareWork(scene);
  if (!(comparison.ratio < 2)) {
    throw new Error(
      `${what} grows with the number of features: ${comparison.small} at ` +
        `${WORK_SIZES.small}, ${comparison.large} at ${WORK_SIZES.large} ` +
        `(${comparison.ratio.toFixed(2)} times)`,
    );
  }
  return comparison;
}

// ============================================================================
// The operations that run in parts
// ============================================================================

/** The rows written by each part of an operation, and when the frames between them ran */
export interface PartsRun {
  /** The rows written by each part, in order */
  parts: number[];
  /** For each frame drawn between two parts, the rows written before it */
  frames: number[];
}

/**
 * Runs an operation on the fake clock, one part at a time
 *
 * A part is what runs from one timer of the fake clock to the next, promise callbacks
 * included: an operation that only awaits promises between its pieces runs as one part,
 * because the map cannot draw until it gives the task back. A frame timer of the harness runs
 * between the tasks, as the frames of a map do: it ends the part, draws the frame (`frame`) and
 * comes again a millisecond later, until the operation has finished. The rows each part wrote
 * are read from `counts.rowsWritten`.
 *
 * Needs `vi.useFakeTimers()`.
 *
 * @param run Starts the operation (its promise, when it returns one, is waited for)
 */
export async function runInParts(options: {
  counts: WorkCounts;
  run: () => unknown;
  frame?: () => void;
  /** At most this many parts are run (10,000 when omitted) */
  maxParts?: number;
}): Promise<PartsRun> {
  if (!vi.isFakeTimers()) throw new Error('runInParts needs the fake timers');
  const { counts, frame } = options;
  const maxParts = options.maxParts ?? 10_000;
  const parts: number[] = [];
  const frames: number[] = [];
  const state: { done: boolean; failed: boolean; error: unknown; drawing: boolean } = {
    done: false,
    failed: false,
    error: undefined,
    drawing: true,
  };
  let written = counts.rowsWritten;

  // Scheduled before the operation starts, so that it comes before the first timer of the
  // operation; each next one is scheduled after the timer the operation set in that part
  const frameTimer = (): void => {
    parts.push(counts.rowsWritten - written);
    written = counts.rowsWritten;
    if (state.done) {
      state.drawing = false;
      return;
    }
    frames.push(counts.rowsWritten);
    frame?.();
    setTimeout(frameTimer, 1);
  };
  setTimeout(frameTimer, 0);

  Promise.resolve()
    .then(() => options.run())
    .then(
      () => {
        state.done = true;
      },
      (error: unknown) => {
        state.failed = true;
        state.error = error;
        state.done = true;
      },
    );

  while (state.drawing) {
    if (parts.length >= maxParts) {
      throw new Error(`the operation did not finish in ${maxParts} parts`);
    }
    await vi.advanceTimersByTimeAsync(1);
  }
  if (state.failed) throw state.error;
  return { parts, frames };
}

/**
 * Throws unless every part wrote at most `limit` rows and a frame ran between every two parts
 */
export function expectPartsWithin(run: PartsRun, limit: number): void {
  const largest = Math.max(0, ...run.parts);
  if (largest > limit) {
    throw new Error(
      `a part wrote ${largest} rows, more than ${limit} (parts: ${run.parts.join(', ')})`,
    );
  }
  if (run.frames.length < run.parts.length - 1) {
    throw new Error('the map did not draw between every two parts');
  }
}

// ============================================================================
// The GL and the map
// ============================================================================

/** The GL calls that draw */
const DRAW_CALLS: ReadonlySet<string> = new Set([
  'drawArrays',
  'drawElements',
  'drawArraysInstanced',
  'drawElementsInstanced',
  'drawRangeElements',
]);

/** The value a call of the GL stub returns */
function resultOf(
  name: string,
  constantOf: (name: string) => number,
): (...args: unknown[]) => unknown {
  if (name.startsWith('create')) return () => ({ kind: name });
  switch (name) {
    case 'isContextLost':
      return () => false;
    case 'getShaderParameter':
    case 'getProgramParameter':
      return () => true;
    case 'getShaderInfoLog':
    case 'getProgramInfoLog':
      return () => '';
    case 'getUniformLocation':
      return () => ({});
    case 'getAttribLocation':
    case 'getUniformBlockIndex':
      return () => 0;
    case 'checkFramebufferStatus':
      return () => constantOf('FRAMEBUFFER_COMPLETE');
    case 'getParameter':
      return () => 4096;
    case 'getExtension':
      return () => null;
    case 'getSupportedExtensions':
      return () => [];
    default:
      return () => undefined;
  }
}

/**
 * A WebGL2 context that accepts every call and counts the calls by name
 *
 * Constants resolve to stable numbers, create* returns a fresh object and the status queries
 * report success. Each test makes its own, so two instances never share the counts. The draw
 * calls are counted here rather than where the library draws, so that every place that draws
 * (the renderers, the images, the terrain) is counted.
 */
export function createCountingGL() {
  const calls = new Map<string, number>();
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
    const result = resultOf(name, constantOf);
    const fn = (...args: unknown[]) => {
      calls.set(name, (calls.get(name) ?? 0) + 1);
      return result(...args);
    };
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
  const draws = (): number => {
    let sum = 0;
    for (const [name, count] of calls) if (DRAW_CALLS.has(name)) sum += count;
    return sum;
  };
  const total = (): number => {
    let sum = 0;
    for (const count of calls.values()) sum += count;
    return sum;
  };
  return {
    gl,
    /** The calls since the last reset, by name */
    calls,
    /** The number of draw calls since the last reset */
    draws,
    /** Every call since the last reset */
    total,
    /** The calls per draw call since the last reset (every call when nothing was drawn) */
    callsPerDraw: (): number => total() / Math.max(draws(), 1),
    /** Starts the counts again from zero */
    reset: (): void => {
      calls.clear();
    },
  };
}

/** A render input with identity matrices, as maplibre gives a custom layer for one frame */
export function renderInput(): CustomRenderMethodInput {
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
    shaderData: { variantName: 'mercator', vertexShaderPrelude: '', define: '' },
    defaultProjectionData: projectionData,
    getProjectionData: () => projectionData,
  } as unknown as CustomRenderMethodInput;
}

/** The members of a custom layer the map calls */
interface DrawnLayer {
  id: string;
  onAdd?: (map: unknown, gl: unknown) => void;
  onRemove?: (map: unknown, gl: unknown) => void;
  prerender?: (gl: unknown, input: CustomRenderMethodInput) => void;
  render?: (gl: unknown, input: CustomRenderMethodInput) => void;
}

/**
 * The map stub of src/test-utils.ts that draws on a GL
 *
 * A layer added to it receives `onAdd` with the GL, and `render()` draws one frame of every
 * layer, in the order they were added, as maplibre would.
 */
export function createDrawingMapStub(gl: WebGL2RenderingContext) {
  const stub = createMapStub();
  const map = stub.map as unknown as {
    addLayer: (layer: DrawnLayer) => unknown;
    removeLayer: (id: string) => unknown;
  };
  const added = new Map<string, DrawnLayer>();
  const addLayer = map.addLayer;
  Object.assign(map, {
    addLayer: (layer: DrawnLayer) => {
      addLayer(layer);
      added.set(layer.id, layer);
      layer.onAdd?.(map, gl);
      return map;
    },
    removeLayer: (id: string) => {
      // The stub removes the layer and calls its onRemove without a GL; give it this one
      const layer = added.get(id);
      added.delete(id);
      stub.layers.delete(id);
      layer?.onRemove?.(map, gl);
      return map;
    },
    // What a frame reads of the map
    getPixelRatio: () => 1,
    isMoving: () => false,
    isZooming: () => false,
    transform: { tileSize: 512 },
  });
  return {
    map: stub.map,
    canvas: stub.canvas,
    /** Draws one frame of every layer */
    render(input: CustomRenderMethodInput = renderInput()): void {
      for (const layer of [...added.values()]) layer.prerender?.(gl, input);
      for (const layer of [...added.values()]) layer.render?.(gl, input);
    },
  };
}

// ============================================================================
// An instance to count
// ============================================================================

/**
 * A draw instance over a Store of its own on a map stub that draws on a counting GL
 *
 * It is built as `createDraw` builds it (the engine is kept, for the synthetic input). Each
 * call makes a new Store, so the numbers of two instances never mix.
 */
export function createCountedInstance(options: DrawOptions = {}): {
  draw: Draw;
  engine: Engine;
  store: MemoryStore;
  counts: WorkCounts;
  gl: ReturnType<typeof createCountingGL>;
  map: ReturnType<typeof createDrawingMapStub>;
  input: ReturnType<typeof createSyntheticInput>;
} {
  const gl = createCountingGL();
  const map = createDrawingMapStub(gl.gl);
  const store = new MemoryStore();
  const drawOptions: DrawOptions = { ...options, store };
  checkDrawOptions(drawOptions);
  const engine = createEngine(
    map.map as MapLibreMap,
    toEngineOptions(drawOptions, () => false),
    {
      deferDefaultMode: true,
    },
  );
  const draw = createDrawOnEngine(engine, drawOptions);
  engine.enterDefaultMode();
  return {
    draw,
    engine,
    store,
    counts: countsOf(store),
    gl,
    map,
    input: createSyntheticInput(engine),
  };
}

/**
 * `count` points on a square grid from (-1, -1) to (1, 1), the area the map stub shows
 *
 * The map stub projects one degree to one hundred pixels.
 */
export function gridPoints(count: number) {
  const side = Math.ceil(Math.sqrt(count));
  const step = 2 / side;
  const inputs: { type: 'Point'; geometry: { type: 'Point'; coordinates: [number, number] } }[] =
    [];
  for (let i = 0; i < count; i++) {
    const coordinates: [number, number] = [
      -1 + (i % side) * step,
      -1 + Math.floor(i / side) * step,
    ];
    inputs.push({ type: 'Point', geometry: { type: 'Point', coordinates } });
  }
  return inputs;
}

/**
 * A synthetic drag of the pointer for the input router of an engine, as the normalizer gives
 * it: a press and the start of the drag, the moves, then the end and the release
 */
export function createSyntheticDrag(engine: Pick<Engine, 'map' | 'inputRouter'>) {
  const modifiers = { shift: false, ctrl: false, alt: false, meta: false };
  let start: { point: { x: number; y: number }; lngLat: { lng: number; lat: number } } | null =
    null;
  const at = (lngLat: [number, number]) => {
    const projected = engine.map.project(lngLat);
    return {
      point: { x: projected.x, y: projected.y },
      lngLat: { lng: lngLat[0], lat: lngLat[1] },
    };
  };
  const original = (type: string, point: { x: number; y: number }) =>
    ({
      type,
      button: 0,
      buttons: type === 'mouseup' || type === 'dragend' ? 0 : 1,
      clientX: point.x,
      clientY: point.y,
      target: null,
      preventDefault() {},
      stopPropagation() {},
    }) as unknown as MouseEvent;
  const mouse = (type: 'mousemove' | 'mousedown' | 'mouseup', lngLat: [number, number]) => {
    const { point, lngLat: ll } = at(lngLat);
    engine.inputRouter.dispatch({
      type,
      point,
      lngLat: ll,
      originalEvent: original(type, point),
      modifiers,
      snap: false,
    });
  };
  const drag = (type: 'dragstart' | 'dragmove' | 'dragend', lngLat: [number, number]) => {
    const { point, lngLat: ll } = at(lngLat);
    const from = start ?? { point, lngLat: ll };
    engine.inputRouter.dispatch({
      type,
      point,
      lngLat: ll,
      originalEvent: original(type, point),
      modifiers,
      dragStartPoint: from.point,
      dragStartLngLat: from.lngLat,
    });
  };
  return {
    /** A move to the position, a press there and the start of the drag */
    start(lngLat: [number, number]): void {
      mouse('mousemove', lngLat);
      mouse('mousedown', lngLat);
      start = at(lngLat);
      drag('dragstart', lngLat);
    },
    /** A move of the drag to the position */
    move(lngLat: [number, number]): void {
      drag('dragmove', lngLat);
    },
    /** The end of the drag and the release at the position */
    end(lngLat: [number, number]): void {
      drag('dragend', lngLat);
      mouse('mouseup', lngLat);
      start = null;
    },
  };
}
