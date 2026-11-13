// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Helpers shared by the tests. This file is not part of the build.
 */

import type { Page, RowCache, RowRings } from '@sakuzu/kasane';
import { createPageBuilder, type PageBuildOptions } from '@sakuzu/kasane';
import type { PageData, RowGroup, RowTable } from '@sakuzu/kasane/render';
import {
  createPageDataBuilder,
  type GeometryWrite,
  type RowWriteContext,
  refreshRowShape,
  writeRowGeometry,
} from '@sakuzu/kasane/render';
import type { CoordinateSystem, TabaneShape } from '@sakuzu/tabane';
import { utf8ColumnFromStrings } from '@sakuzu/tabane';
import type { Geometry } from 'geojson';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { expect, vi } from 'vitest';
import type { Draw } from './api/draw.js';
import type { DocumentChange } from './api/events.js';
import type { ModeFactory } from './api/extension/mode.js';
import type { ExtensionsCollections } from './api/extensions.js';
import { createAppliedStyles } from './api/impl/applied-style.js';
import type { ModeServices } from './api/impl/contexts.js';
import { createModeContext, createScreenContext } from './api/impl/contexts.js';
import { createEventHub } from './api/impl/events.js';
import { toFeature, toFeatureOrUndefined } from './api/impl/feature-shape.js';
import { createFeatures, prepareFeatureInput } from './api/impl/features.js';
import { createGroups } from './api/impl/groups.js';
import { bridgeMode, createInputRoute } from './api/impl/input.js';
import { createLayers } from './api/impl/layers.js';
import { createSelection } from './api/impl/selection.js';
import type { ResourceDeps } from './api/impl/shared.js';
import { withLocksIgnored } from './api/impl/shared.js';
import type {
  FeatureTables,
  FeatureTablesOptions,
  FeatureTablesWriter,
  RowField,
  RowValues,
} from './api/tables.js';
import type { DatasetRow } from './dataset/types.js';
import { normalizeDisplayFeature } from './dataset/types.js';
import type { InputRouter } from './dispatcher/input-router.js';
import type { KeyNormalizedEvent, ModifierKeys, MouseNormalizedEvent } from './dispatcher/types.js';
import { createFeatureTablesStore } from './feature-table/feature-row-tables.js';
import {
  type FeatureTablesInternals,
  featureTablesInternals,
} from './feature-table/feature-tables.js';
import { resolveMessages } from './messages.js';
import type { ModeManager } from './modes/manager.js';
import { DEFAULT_FEATURE_STYLE_CONFIG } from './shared/config/feature-style.js';
import { DEFAULT_BOX_SELECTION_STYLE_CONFIG } from './shared/config/rendering.js';
import { DEFAULT_SELECTION_CONFIG } from './shared/config/selection.js';
import {
  metersPerPixelInFrame,
  type ScreenScaleFrame,
  setScreenScaleFrame,
} from './shared/math/index.js';
import type { Feature } from './shared/types/model.js';
import { EventEmitterImpl } from './shared/utils/event-emitter.js';
import { AutoNameGenerator } from './shared/utils/name-generator.js';
import { RenderedShapes } from './sketches/rendered-shapes.js';
import { SketchController } from './sketches/sketch-controller.js';
import type { SnapResult } from './snapping/types.js';
import { MemoryStore } from './store/memory.js';
import type { Store } from './store/store.js';
import { createTableStore } from './store/table-memory.js';
import { circleRowRings } from './table/circle-rings.js';
import {
  type FeatureRowInput,
  rowInputOfFeature,
  shapeOfGeometry,
} from './table/feature-row-blocks.js';
import { GROUP_FLAG_HIDDEN, TYPE_COLUMN } from './table/feature-row-columns.js';
import { FEATURE_TABLE_COLUMNS } from './table/tabane/columns.js';
import { GpuResources } from './view/gpu.js';
import { GpuLedger } from './view/gpu-ledger.js';
import { FeatureDrawer } from './view/renderers/drawer.js';
import type { ImageRenderer } from './view/renderers/image.js';
import type { SDFLineRenderer } from './view/renderers/line/sdf-line.js';
import type { PointShapeRenderer } from './view/renderers/point/point-shape.js';
import { getStyleRuleChannel } from './view/style-rule.js';
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

/**
 * The scale of a frame on which a pixel spans on the ground, at every latitude, what a pixel north
 * of a plane of the tests does: such a plane maps the degrees linearly, `pixelsPerDegree` pixels a
 * degree of longitude and of latitude (the sizes of the selection UI in pixels are laid on the
 * ground with it, so on such a plane they keep their pixels near the equator)
 */
export function planeScaleFrame(pixelsPerDegree: number): ScreenScaleFrame {
  return { zoom: Math.log2((pixelsPerDegree * 360) / 512), centerLatitude: 0, transition: 1 };
}

/** The meters of a pixel of a plane of the tests ({@link planeScaleFrame}) */
export function planeMetersPerPixel(pixelsPerDegree: number): (lngLat: [number, number]) => number {
  const frame = planeScaleFrame(pixelsPerDegree);
  return (lngLat) => metersPerPixelInFrame(frame, lngLat[1]);
}

/** The categories of a notification of the Store that belong to the document */
const DOCUMENT_CHANGE_KEYS = [
  'features',
  'rows',
  'previousValues',
  'layers',
  'groups',
  'order',
  'metadata',
  'files',
  'reset',
] as const;

/**
 * Calls a listener with each notification of the Store of an instance that changed the document,
 * as the Store gives it (the instance tells the same commits as `change`)
 *
 * @returns The function that stops
 */
export function onDocumentChange(
  draw: Pick<Draw, 'getStore'>,
  listener: (change: DocumentChange) => void,
): () => void {
  return draw.getStore().subscribe((change) => {
    if (DOCUMENT_CHANGE_KEYS.some((key) => change[key] !== undefined)) listener(change);
  });
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

  // The stub draws no frame: the scale of its plane stands for the frame drawn last
  setScreenScaleFrame(map as unknown as MapLibreMap, planeScaleFrame(100));

  return {
    map: map as unknown as MapLibreMap,
    canvas,
    layers,
    /** Hands an event to the listeners of the canvas, as the browser would */
    fireCanvas: (type: string, event: unknown) => {
      for (const fn of [...(canvasListeners.get(type) ?? [])]) fn(event);
    },
    mapListenerCount: () => count(mapListeners),
    canvasListenerCount: () => count(canvasListeners),
    isBoxZoomEnabled: () => boxZoomEnabled,
  };
}

/**
 * The sketches of an instance, for a test of a mode without an engine, read by the shapes given
 */
export function createSketches(store: Store, shapes?: RenderedShapes): SketchController {
  let next = 0;
  const sketches = new SketchController({
    store,
    generateId: () => `sketch-${next++}`,
    getActiveLayerId: () => '',
    prepareFeature: () => {
      throw new Error('a mode tested here creates no feature by a sketch');
    },
  });
  sketches.attach();
  shapes?.useSketches(sketches);
  return sketches;
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
    appliedStyle: createAppliedStyles({
      getLayer: (id) => store.getLayer(id),
      getStyleOptions: () => undefined,
      styleRuleChannelOf: (type: string) => getStyleRuleChannel(type),
    }).of,
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
  let nextSketch = 0;
  const sketches = new SketchController({
    store,
    generateId: () => `sketch-${nextSketch++}`,
    getActiveLayerId: () => store.listLayers()[0]?.id ?? '',
    prepareFeature: (input, id, layerId, partial) =>
      prepareFeatureInput(store, input, id, layerId, partial),
  });
  sketches.attach();
  const shapes = new RenderedShapes(store);
  shapes.useSketches(sketches);
  const collections = {} as ExtensionsCollections;
  const features = createFeatures(deps);
  const groups = createGroups(deps);
  // The members of the draw instance the modes use; the rest is not needed without an engine
  const draw = {
    // Read in the public shape, as the instance reads them
    features: {
      ...features,
      get: (id: string) => toFeatureOrUndefined(features.get(id)),
      getMany: (ids: readonly string[]) => features.getMany(ids).map(toFeatureOrUndefined),
      list: (...args: Parameters<typeof features.list>) => features.list(...args).map(toFeature),
    },
    groups,
    layers: createLayers(deps),
    selection: createSelection(deps, { features, groups }, createEventHub()),
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
    messages: resolveMessages(),
    selectionExtensions: createSelectionExtensionRegistry(),
    spatialIndex: { invalidate: () => {}, invalidateType: () => {}, invalidateAll: () => {} },
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
    sketches,
    generateId: deps.generateId,
    notifyDrawCommit: () => {},
    drawingCommit: { current: null },
    scaleWithZoom: options.scaleWithZoom ?? false,
    selectionStyle: DEFAULT_SELECTION_CONFIG,
    boxSelectionStyle: DEFAULT_BOX_SELECTION_STYLE_CONFIG,
  };
  const screen = createScreenContext({
    map,
    pixelRatio: services.pixelRatio,
  });
  return {
    draw,
    /** The sketches the modes show the shape they draw by */
    sketches,
    /** The shapes as they are seen: the shape a mode draws is `shapes.drawing()` */
    shapes,
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

// === The rows held as columns ===

/** A drawer built from stubs: the style resolution touches neither GL nor the map */
export function createTestDrawer(featureStyle = DEFAULT_FEATURE_STYLE_CONFIG): FeatureDrawer {
  const gl = {
    createBuffer: (): object => ({}),
    createVertexArray: (): object => ({}),
    bindBuffer: (): void => {},
    bindVertexArray: (): void => {},
    enableVertexAttribArray: (): void => {},
    vertexAttribPointer: (): void => {},
  } as unknown as WebGL2RenderingContext;
  return new FeatureDrawer({
    ledger: new GpuLedger(),
    gl,
    map: {} as never,
    sdfLineRenderer: {} as SDFLineRenderer,
    pointShapeRenderer: {} as PointShapeRenderer,
    imageRenderer: {} as ImageRenderer,
    featureStyle,
  });
}

/** The key of the order of the `i`-th row (they sort in the order of `i`) */
export function orderKey(i: number): string {
  return `k${String(i).padStart(6, '0')}`;
}

/**
 * The builder of the pages of the tables, adding rows of features given as the library gives
 * them (`rowInputOfFeature`)
 */
export function featureRowDataBuilder(options: PageBuildOptions): {
  readonly length: number;
  addRow(row: FeatureRowInput): void;
  finish(): PageData[];
} {
  const builder = createPageDataBuilder(options);
  return {
    get length() {
      return builder.length;
    },
    addRow: (row) => builder.add(rowInputOfFeature(row)),
    finish: () => builder.build(),
  };
}

/** The builder of the pages of the tables as `featureRowDataBuilder`, with its pages */
export function featureRowBuilder(options: PageBuildOptions): {
  readonly length: number;
  addRow(row: FeatureRowInput): void;
  finish(): Page[];
} {
  const builder = createPageBuilder(options);
  return {
    get length() {
      return builder.length;
    },
    addRow: (row) => builder.add(rowInputOfFeature(row)),
    finish: () => builder.build(),
  };
}

/**
 * Writes the GeoJSON geometry of a feature in place over a row of the tables of features (as the
 * tables write a shape, `writeRowGeometry`)
 */
export function writeFeatureGeometry(
  table: RowTable,
  group: RowGroup,
  row: number,
  geometry: Geometry,
  system: CoordinateSystem,
  rings: RowRings | null = null,
  caches: readonly RowCache[] = [],
): GeometryWrite {
  return writeRowGeometry(
    table,
    group,
    row,
    shapeOfGeometry(geometry) as TabaneShape,
    featureWriteContext(system, rings, caches),
  );
}

/**
 * Works out again what follows from the shape of a row of the tables of features (as the tables
 * do, `refreshRowShape`)
 */
export function refreshFeatureShape(
  table: RowTable,
  group: RowGroup,
  row: number,
  system: CoordinateSystem,
  rings: RowRings | null = null,
  caches: readonly RowCache[] = [],
): { sameTriangles: boolean; ring: number } {
  return refreshRowShape(table, group, row, featureWriteContext(system, rings, caches));
}

/** What a write in place reads of the tables of features */
function featureWriteContext(
  system: CoordinateSystem,
  rings: RowRings | null,
  caches: readonly RowCache[],
): RowWriteContext {
  return { coordinates: system, rings, caches, shapeName: 'geometry', typeAt: TYPE_COLUMN };
}

/** A feature as a row */
export function rowOfFeature(feature: Feature, key: string): FeatureRowInput {
  return {
    id: feature.id,
    type: feature.type,
    geometry: feature.geometry,
    key,
    style: feature.style as Record<string, unknown>,
    properties: feature.properties,
    hidden: feature.visible === false,
    locked: feature.locked,
  };
}

/**
 * The internals of tables made by core (the rows, the sketches drawn over rows)
 *
 * @throws when the tables were not made by core
 */
export function internalsOf(tables: FeatureTables | undefined): FeatureTablesInternals {
  const internals = featureTablesInternals(tables);
  if (!internals) throw new Error('the tables were not made by core');
  return internals;
}

/**
 * Tables holding the features in one layer, in the order given
 *
 * @param targetRows The largest number of rows of a row group
 */
export function tablesOfFeatures(
  layerId: string,
  features: readonly Feature[],
  targetRows?: number,
  options?: FeatureTablesOptions,
): {
  internals: FeatureTablesInternals;
  table: RowTable;
  tables: FeatureTables;
  writer: FeatureTablesWriter;
} {
  const { tables, writer } = createFeatureTablesStore(options);
  const builder = featureRowDataBuilder({
    columns: FEATURE_TABLE_COLUMNS,
    targetRows,
    dimensions: options?.dimensionsOf?.(layerId),
    rings: circleRowRings,
  });
  features.forEach((feature, i) => {
    builder.addRow(rowOfFeature(feature, orderKey(i)));
  });
  writer.addPages(layerId, builder.finish());
  const internals = featureTablesInternals(tables) as FeatureTablesInternals;
  internals.addQueuedPages();
  return { internals, table: internals.rowTable(layerId) as RowTable, tables, writer };
}

/** A feature of the tests */
export function feature(
  id: string,
  type: Feature['type'],
  coordinates: unknown,
  extra: Partial<Feature> = {},
): Feature {
  const geometryTypes = [
    'Point',
    'MultiPoint',
    'LineString',
    'MultiLineString',
    'Polygon',
    'MultiPolygon',
  ];
  // A Circle, an Image and a custom type hold a Point; a Freehand a LineString
  const geometryType = geometryTypes.includes(type)
    ? type
    : type === 'Freehand'
      ? 'LineString'
      : 'Point';
  return {
    id,
    type,
    geometry: { type: geometryType, coordinates } as Feature['geometry'],
    layerId: 'layer',
    groupId: undefined,
    properties: {},
    style: {},
    locked: false,
    visible: true,
    ...extra,
  };
}

/**
 * A random number generator with a seed (mulberry32): the same seed gives the same numbers, so
 * a test of properties over random inputs is the same run every time
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A texture as {@link memoryGL} holds it */
export interface MemoryTexture {
  readonly width: number;
  readonly height: number;
  /** The values per texel */
  readonly channels: number;
  readonly data: Float32Array;
}

/**
 * A WebGL2 context that keeps what is written to its buffers and its float textures, to read
 * back what the GPU holds (no drawing). Its constants are the lengths of their names, so
 * `RG32F`, `RGBA32F` and `R8UI` are told apart by the size of a texel; the calls are recorded
 */
export function memoryGL() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const buffers = new Map<object, Float32Array>();
  const textures = new Map<object, MemoryTexture>();
  let next = 1;
  let buffer: object | null = null;
  let texture: object | null = null;
  const channelsOf = (internalFormat: number): number =>
    internalFormat === 'RG32F'.length ? 2 : internalFormat === 'RGBA32F'.length ? 4 : 1;
  const target: Record<string, unknown> = {
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
  };
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    bindBuffer: (_target, object) => {
      buffer = object as object | null;
    },
    bufferData: (_target, data) => {
      if (buffer && data instanceof Float32Array) buffers.set(buffer, data.slice());
    },
    bufferSubData: (_target, offset, data) => {
      const held = buffer ? buffers.get(buffer) : undefined;
      if (held && data instanceof Float32Array) held.set(data, (offset as number) / 4);
    },
    bindTexture: (_target, object) => {
      texture = object as object | null;
    },
    texStorage2D: (_target, _levels, internalFormat, width, height) => {
      if (!texture) return;
      const channels = channelsOf(internalFormat as number);
      textures.set(texture, {
        width: width as number,
        height: height as number,
        channels,
        data: new Float32Array((width as number) * (height as number) * channels),
      });
    },
    texSubImage2D: (_target, _level, x, y, width, height, _format, _type, data) => {
      const held = texture ? textures.get(texture) : undefined;
      if (!held || !ArrayBuffer.isView(data)) return;
      const values = data as unknown as ArrayLike<number>;
      const w = width as number;
      for (let row = 0; row < (height as number); row++) {
        for (let col = 0; col < w; col++) {
          for (let k = 0; k < held.channels; k++) {
            held.data[
              (((y as number) + row) * held.width + (x as number) + col) * held.channels + k
            ] = values[(row * w + col) * held.channels + k];
          }
        }
      }
    },
  };
  const gl = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      if (/^[A-Z_0-9]+$/.test(prop)) return prop.length;
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
        if (prop.startsWith('create')) return { id: next++ };
        const handler = handlers[prop];
        if (handler) return handler(...args);
        if (prop === 'getExtension') return null;
        if (prop === 'getProgramParameter') return true;
        if (prop === 'getUniformLocation') return { name: args[1] };
        if (prop === 'getParameter') return 4;
        return undefined;
      };
    },
  }) as unknown as WebGL2RenderingContext;
  return { gl, calls, buffers, textures };
}

/**
 * A row of the reference of the tests of the rows held as columns: what a row is, as a plain
 * object
 */
export interface ReferenceRow {
  readonly id: string;
  layerId: string;
  type: string;
  geometry: Geometry;
  order: string;
  /** The id of its group of features (undefined outside a group) */
  groupId: string | undefined;
  member: string;
  style: Record<string, unknown>;
  properties: Record<string, unknown>;
  visible: boolean;
  locked: boolean;
  deleted: boolean;
}

/**
 * The reference the rows held as columns are compared with: every row as a plain object, put in
 * the order of its layer by sorting (no groups of rows, no delta, nothing written in place)
 */
export class ReferenceRows {
  readonly rows = new Map<string, ReferenceRow>();
  /** The groups of features: their keys, their layers and whether they are shown */
  readonly groups = new Map<string, { order: string; layerId: string; visible: boolean }>();

  /** The rows of a layer in its order (the deleted ones included) */
  inOrder(layerId: string): ReferenceRow[] {
    const itemKey = (row: ReferenceRow): string =>
      row.groupId !== undefined ? (this.groups.get(row.groupId)?.order ?? '') : row.order;
    const itemId = (row: ReferenceRow): string => row.groupId ?? row.id;
    const compare = (a: string, b: string): number => compareBytes(a, b);
    return [...this.rows.values()]
      .filter((row) => row.layerId === layerId)
      .sort(
        (a, b) =>
          compare(itemKey(a), itemKey(b)) ||
          compare(itemId(a), itemId(b)) ||
          (a.groupId !== undefined || b.groupId !== undefined ? compare(a.member, b.member) : 0) ||
          compare(a.id, b.id),
      );
  }

  /** The rows of a layer and its groups, as the items of the layer are read */
  items(layerId: string): Array<{ kind: 'row' | 'group'; id: string }> {
    const out: Array<{ kind: 'row' | 'group'; id: string }> = [];
    let last: string | undefined;
    for (const row of this.inOrder(layerId)) {
      if (row.deleted) continue;
      if (row.groupId === undefined) {
        out.push({ kind: 'row', id: row.id });
        last = undefined;
      } else if (row.groupId !== last) {
        out.push({ kind: 'group', id: row.groupId });
        last = row.groupId;
      }
    }
    return out;
  }
}

/** The order of two strings by their UTF-8 bytes */
function compareBytes(a: string, b: string): number {
  const encoder = new TextEncoder();
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/**
 * Expects the tables to read as the reference: the rows of every layer in their order (by
 * `scan` and `listRowHandles`), the items and the members of the groups in their order, and the
 * values of every row
 *
 * @param groupHandleOf The handle of a group of features by its id
 */
export function expectTablesMatch(
  tables: FeatureTables,
  reference: ReferenceRows,
  layerIds: readonly string[],
  groupHandleOf: (id: string) => number,
): void {
  const idsOf = (handles: ArrayLike<number>): string[] =>
    Array.from(handles, (handle) => tables.getRowId(handle) as string);
  for (const layerId of layerIds) {
    const rows = reference.inOrder(layerId);
    const view = tables.get(layerId);
    if (!view) {
      expect(rows).toEqual([]);
      continue;
    }
    // Every row, the deleted ones included until the next version of their group leaves them out
    // (nothing keeps them)
    const internals = featureTablesInternals(tables);
    const present = rows.filter((row) => {
      if (!row.deleted) return true;
      const handle = internals?.ids.handleOf(row.id) ?? -1;
      return handle >= 0 && internals?.placeOf(handle) !== undefined;
    });
    expect(idsOf(view.listRowHandles(0, 1_000_000))).toEqual(present.map((row) => row.id));
    expect(view.rowCountWithDeleted).toBe(present.length);
    expect(view.rowCount).toBe(rows.filter((row) => !row.deleted).length);
    // The rows that are not deleted, a batch at a time
    const scanned: number[] = [];
    const cursor = tables.scan({ layerIds: [layerId], batchSize: 7 });
    for (let batch = cursor.next(); batch; batch = cursor.next()) scanned.push(...batch);
    const live = rows.filter((row) => !row.deleted);
    expect(idsOf(scanned)).toEqual(live.map((row) => row.id));
    // The items and the members of the groups
    const items = view.listItems(0, 1_000_000);
    const expected = reference.items(layerId);
    expect(
      Array.from(items.kinds, (kind, i) =>
        kind === 0
          ? { kind: 'row', id: tables.getRowId(items.handles[i]) }
          : { kind: 'group', id: items.handles[i] },
      ),
    ).toEqual(
      expected.map((item) =>
        item.kind === 'row' ? item : { kind: 'group', id: groupHandleOf(item.id) },
      ),
    );
    for (const item of expected) {
      if (item.kind !== 'group') continue;
      const members = live.filter((row) => row.groupId === item.id).map((row) => row.id);
      expect(idsOf(view.listGroupMembers(groupHandleOf(item.id), 0, 1_000_000))).toEqual(members);
    }
    // The values of every row (of a layer of z or m, read as they are written back: a row of it
    // is not a feature)
    const dims = internals?.readContext.dimensionsOf(layerId) ?? 'xy';
    for (const row of live) {
      const handle = tables.getRowRef(row.id);
      expect(handle).toBeDefined();
      if (dims !== 'xy') {
        expect(() => view.getRow(handle as number)).toThrow(/is not a feature/);
        const fields = ['type', 'geometry', 'style', 'hidden', 'locked', 'parent'];
        const snapshot = tables.readValues(
          rowPatch([handle as number], Object.fromEntries(fields.map((field) => [field, [0]]))),
        );
        const value = (field: string) => snapshot.fields.get(field as RowField)?.[0];
        expect(value('type')).toBe(row.type);
        expect(value('geometry')).toEqual(row.geometry);
        expect(value('style')).toEqual(row.style);
        expect(value('hidden')).toBe(!row.visible);
        expect(value('locked')).toBe(row.locked);
        expect(value('parent')).toBe(row.groupId ?? layerId);
        for (const [key, expected] of Object.entries(row.properties)) {
          expect(view.getRowValue(handle as number, key)).toEqual(expected);
        }
        continue;
      }
      const feature = view.getRow(handle as number);
      expect(feature?.type).toBe(row.type);
      expect(feature?.geometry).toEqual(row.geometry);
      expect(feature?.style).toEqual(row.style);
      expect(feature?.properties).toEqual(row.properties);
      expect(feature?.visible).toBe(row.visible);
      expect(feature?.locked).toBe(row.locked);
      expect(feature?.groupId).toBe(row.groupId);
      expect(feature?.layerId).toBe(layerId);
    }
  }
}

/** A patch of rows */
export function rowPatch(
  handles: number[],
  fields: Record<string, unknown[]>,
  deleted?: number[],
): RowValues {
  return {
    handles: Int32Array.from(handles),
    fields: new Map(Object.entries(fields) as Array<[RowField, unknown[]]>),
    deleted: deleted ? Uint8Array.from(deleted) : undefined,
  };
}

/** The key of the order of a number (they sort as the numbers do) */
export function referenceKey(n: number): string {
  return `k${String(Math.floor(n)).padStart(7, '0')}`;
}

/** Tables of the rows of a reference, in row groups of `targetRows` */
export function tablesOfReference(
  reference: ReferenceRows,
  layerIds: readonly string[],
  targetRows = 8,
  options: FeatureTablesOptions = {},
) {
  const { tables, writer } = createFeatureTablesStore(options);
  const internals = featureTablesInternals(tables);
  if (!internals) throw new Error('no internals');
  const groupHandles = new Map<string, number>();
  for (const [id, group] of reference.groups) {
    const handle = groupHandles.size + 100;
    groupHandles.set(id, handle);
    internals.groups.set(handle, {
      id,
      order: group.order,
      tableId: group.layerId,
      flags: group.visible ? 0 : GROUP_FLAG_HIDDEN,
    });
  }
  const groupKeys = [...reference.groups].map(([id, group]) => ({
    group: groupHandles.get(id) as number,
    id,
    key: group.order,
  }));
  for (const layerId of layerIds) {
    const builder = createPageDataBuilder({
      columns: FEATURE_TABLE_COLUMNS,
      groups: groupKeys,
      targetRows,
      dimensions: options.dimensionsOf?.(layerId),
      rings: circleRowRings,
    });
    for (const row of reference.rows.values()) {
      if (row.layerId !== layerId) continue;
      builder.add(
        rowInputOfFeature({
          id: row.id,
          type: row.type,
          geometry: row.geometry,
          key: row.groupId !== undefined ? row.member : row.order,
          group: row.groupId !== undefined ? groupHandles.get(row.groupId) : undefined,
          style: row.style,
          properties: row.properties,
          hidden: !row.visible,
          locked: row.locked,
          deleted: row.deleted,
        }),
      );
    }
    if (builder.length > 0) writer.addPages(layerId, builder.build());
  }
  internals.addQueuedPages();
  const groupHandleOf = (id: string): number => groupHandles.get(id) as number;
  return { tables, writer, internals, groupHandleOf };
}

/** A geometry at random of a type (a point, a line, a polygon) */
export function randomRowGeometry(random: () => number, type: string): Geometry {
  const x = random() * 10;
  const y = random() * 10;
  if (type === 'Point') return { type: 'Point', coordinates: [x, y] };
  if (type === 'LineString') {
    const n = 2 + Math.floor(random() * 4);
    return {
      type: 'LineString',
      coordinates: Array.from({ length: n }, (_, k) => [x + k * 0.1, y + random() * 0.1]),
    };
  }
  const n = 3 + Math.floor(random() * 4);
  const ring = Array.from({ length: n }, (_, k) => {
    const a = (k / n) * Math.PI * 2;
    return [x + Math.cos(a), y + Math.sin(a)];
  });
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

const REFERENCE_TYPES = ['Point', 'LineString', 'Polygon'];

/** A geometry at random of a type, as the tests of the rows make them */
export type RandomGeometry = (random: () => number, type: string) => Geometry;

/** A row of the reference at random */
export function randomReferenceRow(
  random: () => number,
  id: string,
  layerId: string,
  geometryOf: RandomGeometry = randomRowGeometry,
): ReferenceRow {
  const type = REFERENCE_TYPES[Math.floor(random() * REFERENCE_TYPES.length)];
  return {
    id,
    layerId,
    type,
    geometry: geometryOf(random, type),
    order: referenceKey(random() * 1e6),
    groupId: undefined,
    member: '',
    style: { strokeColor: '#ff0000' },
    properties: { n: Math.floor(random() * 100) },
    visible: true,
    locked: false,
    deleted: false,
  };
}

/** A reference of `count` rows over layers, with two groups of features in the first layer */
export function randomReference(
  random: () => number,
  count: number,
  layerIds: readonly string[],
  geometryOf: RandomGeometry = randomRowGeometry,
): ReferenceRows {
  const reference = new ReferenceRows();
  reference.groups.set('ga', { order: referenceKey(250_000), layerId: layerIds[0], visible: true });
  reference.groups.set('gb', { order: referenceKey(750_000), layerId: layerIds[0], visible: true });
  for (let i = 0; i < count; i++) {
    const row = randomReferenceRow(random, `r${i}`, layerIds[i % layerIds.length], geometryOf);
    if (row.layerId === layerIds[0] && i % 7 === 0) {
      row.groupId = i % 2 === 0 ? 'ga' : 'gb';
      row.member = referenceKey(random() * 1e6);
    }
    reference.rows.set(row.id, row);
  }
  return reference;
}

/**
 * Writes of every kind at random, to the tables and to the reference alike: the geometry, the
 * style, an attribute, the key, the layer, the group of features, a new row, a deletion, shown,
 * and a row put into the delta as it is
 */
export function randomRowWrites(
  random: () => number,
  setup: {
    readonly tables: FeatureTables;
    readonly writer: FeatureTablesWriter;
    readonly internals: FeatureTablesInternals;
    readonly reference: ReferenceRows;
    readonly layerIds: readonly string[];
    /** The geometries written (`randomRowGeometry` when omitted) */
    readonly geometryOf?: RandomGeometry;
  },
) {
  const { tables, writer, internals, reference, layerIds } = setup;
  const geometryOf = setup.geometryOf ?? randomRowGeometry;
  let created = 0;
  const step = (n: number): void => {
    const ids = [...reference.rows.values()].filter((row) => !row.deleted).map((row) => row.id);
    if (ids.length === 0) return;
    const id = ids[Math.floor(random() * ids.length)];
    const row = reference.rows.get(id) as ReferenceRow;
    const handle = tables.getRowRef(id) as number;
    const pick = random();
    if (pick < 0.15) {
      const geometry = geometryOf(random, row.type);
      writer.writeRows(rowPatch([handle], { geometry: [geometry] }));
      row.geometry = geometry;
    } else if (pick < 0.25) {
      const style = {
        strokeColor: `#${Math.floor(random() * 0xffffff)
          .toString(16)
          .padStart(6, '0')}`,
      };
      writer.writeRows(rowPatch([handle], { style: [style] }));
      row.style = style;
    } else if (pick < 0.35) {
      const value = random() < 0.3 ? undefined : `v${n}`;
      writer.writeRows(rowPatch([handle], { 'properties:name': [value] }));
      if (value === undefined) delete row.properties.name;
      else row.properties = { ...row.properties, name: value };
    } else if (pick < 0.5) {
      // The key of a member orders it among the members of its group
      const key = referenceKey(random() * 1e6);
      writer.writeRows(rowPatch([handle], { key: [key] }));
      if (row.groupId !== undefined) row.member = key;
      else row.order = key;
    } else if (pick < 0.6) {
      const layerId = layerIds[Math.floor(random() * layerIds.length)];
      const order = referenceKey(random() * 1e6);
      writer.writeRows(
        rowPatch([handle], {
          parent: [layerId],
          key: [order],
        }),
      );
      Object.assign(row, { layerId, order, groupId: undefined, member: '' });
    } else if (pick < 0.68 && row.layerId === layerIds[0]) {
      const groupId = random() < 0.5 ? 'ga' : 'gb';
      const member = referenceKey(random() * 1e6);
      writer.writeRows(rowPatch([handle], { parent: [groupId], key: [member] }));
      Object.assign(row, { groupId, member });
    } else if (pick < 0.78) {
      const fresh = `n${created++}`;
      const [freshHandle] = writer.allocateHandles(utf8ColumnFromStrings([fresh]));
      const next = randomReferenceRow(
        random,
        fresh,
        layerIds[Math.floor(random() * layerIds.length)],
        geometryOf,
      );
      writer.writeRows(
        rowPatch([freshHandle], {
          type: [next.type],
          parent: [next.layerId],
          geometry: [next.geometry],
          key: [next.order],
          style: [next.style],
          'properties:n': [next.properties.n],
        }),
      );
      reference.rows.set(fresh, next);
    } else if (pick < 0.85) {
      writer.writeRows(rowPatch([handle], {}, [1]));
      row.deleted = true;
    } else if (pick < 0.92) {
      internals.toDelta([handle]);
    } else {
      writer.writeRows(rowPatch([handle], { hidden: [row.visible] }));
      row.visible = !row.visible;
    }
  };
  return { step };
}

/**
 * The kinds of Store the tests of the modes run on: the Store of objects, and the Store of rows
 * (`createTableStore`), which behave the same to a mode
 */
export const STORE_KINDS: ReadonlyArray<readonly [string, () => Store]> = [
  ['a Store of objects', () => new MemoryStore()],
  ['a Store of rows', () => createTableStore().store],
];

/**
 * What a part allocates with on a stub of a context, with a ledger of its own
 */
export function gpuOf(gl: WebGL2RenderingContext, ledger = new GpuLedger()): GpuResources {
  return new GpuResources({ gl, ledger, owner: 'test' });
}
