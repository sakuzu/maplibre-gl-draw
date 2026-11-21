// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Helpers shared by the tests. This file is not part of the build.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Geometry } from 'geojson';
import type { CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Draw } from './api/draw.js';
import { createDraw } from './api/draw.js';
import type { DocumentChange, DrawEvents } from './api/events.js';
import type { ModeFactory } from './api/extension/mode.js';
import type { ExtensionsCollections } from './api/extensions.js';
import { type BulkEdits, createBulkEdits } from './api/impl/bulk-edits.js';
import type { ModeServices } from './api/impl/contexts.js';
import { createModeContext, createScreenContext } from './api/impl/contexts.js';
import { createDrawOnEngine } from './api/impl/create-draw.js';
import { createDocumentAccess } from './api/impl/document-access.js';
import type { Engine } from './api/impl/engine.js';
import { createEngine } from './api/impl/engine.js';
import {
  FEATURE_FIELDS,
  featuresOfValues,
  geometryColumnOf,
  newRowFields,
  PROPERTY_FIELD,
  updatedRowFields,
} from './api/impl/feature-rows.js';
import { createFeatures } from './api/impl/features.js';
import { createGroups } from './api/impl/groups.js';
import { createHidden } from './api/impl/hidden.js';
import { bridgeMode, createInputRoute } from './api/impl/input.js';
import { createLayers } from './api/impl/layers.js';
import { checkDrawOptions, toEngineOptions } from './api/impl/options.js';
import { createSelection } from './api/impl/selection.js';
import type { ResourceDeps } from './api/impl/shared.js';
import { withLocksIgnored } from './api/impl/shared.js';
import type {
  DocumentGroup,
  DocumentLayer,
  FeatureFilter,
  Group,
  GroupFilter,
  IdSet,
  Layer,
  LayerFilter,
  Feature as PublicFeature,
} from './api/model.js';
import type { DrawOptions } from './api/options.js';
import type { Selection, VertexSelection } from './api/state.js';
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
import { createStore } from './store/built-in/create-store.js';
import { createOrderKeyBetween } from './store/built-in/order-keys.js';
import type {
  FeatureRowField,
  Store as RowStore,
  StoreChange as RowStoreChange,
  StoreGroup,
} from './store/built-in/types.js';
import type { InstanceDocument } from './store/document-access.js';
import type { ClientState } from './store/memory/ui-state.js';
import type { FileData, Metadata } from './store/types.js';
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
 * The layer over the Store an instance makes, over a built-in Store: for the tests that run the
 * resources, the modes or the parts of an instance without an instance
 *
 * @param client - The state of this client (a new one when left out)
 */
export function createTestDocument(client?: ClientState): InstanceDocument {
  return createDocumentAccess(createStore(), client);
}

/**
 * The layer over a built-in Store with the bulk edits an instance makes over them: for the tests
 * that run the bulk edits of the resources without an instance
 */
export function createTestEdits(): { store: InstanceDocument; rows: RowStore; edits: BulkEdits } {
  const rows = createStore();
  const store = createDocumentAccess(rows);
  return { store, rows, edits: createBulkEdits(store, rows) };
}

/**
 * What the bulk edits of `draw.features` are written with, over the bulk edits given: no
 * computation set and no feature type registered
 */
export function testFeatureBulk(edits: BulkEdits) {
  return {
    edits,
    extensions: {
      getTransformProvider: () => undefined,
      featureTypes: { get: () => undefined },
    } as unknown as Pick<ExtensionsCollections, 'getTransformProvider' | 'featureTypes'>,
    counts: undefined,
  };
}

/**
 * The dependencies of the resources of the draw instance over the layer over a Store, with IDs
 * `id-1`, `id-2` and so on, and the first layer as the active layer until another is set
 */
export function createResourceDeps(
  store: InstanceDocument,
): ResourceDeps & { emitter: EventEmitterImpl } {
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
  store: InstanceDocument;
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
    // What this client hides, which the modes read through the instance
    hidden: createHidden(deps),
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
    // The modes of the contract read the document through the instance, not through ctx.store
    exposedStore: store as unknown as RowStore,
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
// The rows of a Store, read and written from outside an instance
// ============================================================================

/** The key of the order of a row */
function rowKeyOf(store: RowStore, ref: number): string | undefined {
  return store.tables.readValues(Int32Array.of(ref), ['orderKey']).fields.get('orderKey')?.[0] as
    | string
    | undefined;
}

/** The IDs of the items of a layer, or of the features of a group, in their order from the back */
function orderOf(store: RowStore, container: string): string[] {
  const { tables } = store;
  const group = store.getGroup(container);
  if (group) {
    const view = tables.get(group.layerId);
    const ref = tables.findGroup(container);
    if (!view || ref === undefined) return [];
    const members = view.listGroupMembers(ref, 0, view.countGroupMembers(ref));
    return Array.from(members, (row) => tables.getRowId(row) ?? '');
  }
  const view = tables.get(container);
  if (!view || view.itemCount === 0) return [];
  const { kinds, refs } = view.listItemRefs(0, view.itemCount);
  return Array.from(refs, (ref, i) =>
    kinds[i] === 0 ? (tables.getRowId(ref) ?? '') : (tables.getGroupId(ref) ?? ''),
  );
}

/** The key of the order of an item of a layer (a row or a group), or of a feature of a group */
function itemKeyOf(store: RowStore, id: string): string | undefined {
  const group = store.getGroup(id);
  if (group) return group.orderKey;
  const ref = store.tables.getRowRef(id);
  return ref === undefined ? undefined : rowKeyOf(store, ref);
}

/** The key of a new item at a position of an order (the front when it is left out) */
function keyAt(store: RowStore, order: readonly string[], index = order.length): string {
  const below = index > 0 ? itemKeyOf(store, order[index - 1]) : undefined;
  const above = index < order.length ? itemKeyOf(store, order[index]) : undefined;
  return createOrderKeyBetween(below, above);
}

/** The layer and the group of the parent of a row */
function placeOfParent(store: RowStore, parent: unknown) {
  const id = String(parent);
  const group = store.getGroup(id);
  return group ? { layerId: group.layerId, groupId: id } : { layerId: id, groupId: undefined };
}

/** The feature of a row of a Store, read from its values (undefined for none) */
export function readRowFeature(store: RowStore, id: string): Feature | undefined {
  const ref = store.tables.getRowRef(id);
  if (ref === undefined) return undefined;
  const rows = Int32Array.of(ref);
  const fields: FeatureRowField[] = [
    ...FEATURE_FIELDS,
    ...store.listPropertyKeys(rows).map((key) => `${PROPERTY_FIELD}${key}` as FeatureRowField),
  ];
  const [feature] = featuresOfValues(store.tables.readValues(rows, fields), [id], (parent) =>
    placeOfParent(store, parent),
  );
  return feature;
}

/** Every feature of a Store, read from the rows of its layers in stacking order */
export function readRowFeatures(store: RowStore): Feature[] {
  const out: Feature[] = [];
  for (const layerId of store.getLayerOrder()) {
    const view = store.tables.get(layerId);
    if (!view) continue;
    for (const ref of view.listRowRefs(0, view.rowCount)) {
      const id = store.tables.getRowId(ref);
      const feature = id === undefined ? undefined : readRowFeature(store, id);
      if (feature) out.push(feature);
    }
  }
  return out;
}

/**
 * The writes of a change made outside an instance, in the words of the features, written to a
 * Store as rows: what an application that keeps the document elsewhere writes when a change
 * arrives. Each write is one write of the Store (in the transaction under way, or one of its own
 * with the source `'remote'`); a new feature, group or item goes to the front of its layer or its
 * group, as the published version put it.
 */
export function rowWrites(store: RowStore) {
  const { tables } = store;
  /** Writes the place of a row: its parent and its key */
  const place = (id: string, parent: string, orderKey: string): void => {
    const ref = tables.getRowRef(id);
    if (ref === undefined) return;
    store.writeRows({
      rows: Int32Array.of(ref),
      fields: new Map<FeatureRowField, unknown[]>([
        ['parent', [parent]],
        ['orderKey', [orderKey]],
      ]),
    });
  };
  return {
    createFeature(feature: Feature): boolean {
      const parent = feature.groupId ?? feature.layerId;
      return store.createRows({
        ids: [feature.id],
        fields: newRowFields(
          [feature],
          [{ parent, orderKey: keyAt(store, orderOf(store, parent)) }],
        ),
        geometry: geometryColumnOf([feature.geometry], 2),
      });
    },
    updateFeature(id: string, updates: Partial<Feature>): boolean {
      const previous = readRowFeature(store, id);
      if (!previous) return false;
      const updated = { ...previous, ...updates, id } as Feature;
      const { fields, geometry } = updatedRowFields(previous, updated, updates);
      const from = previous.groupId ?? previous.layerId;
      const to = updated.groupId ?? updated.layerId;
      if (from !== to) {
        fields.set('parent', [to]);
        fields.set('orderKey', [keyAt(store, orderOf(store, to))]);
      }
      if (fields.size === 0 && geometry === undefined) return true;
      const ref = tables.getRowRef(id) as number;
      return store.writeRows({
        rows: Int32Array.of(ref),
        fields,
        ...(geometry !== undefined && { geometry: geometryColumnOf([geometry], 2) }),
      });
    },
    deleteFeature(id: string): boolean {
      const ref = tables.getRowRef(id);
      if (ref === undefined) return false;
      return store.writeRows({
        rows: Int32Array.of(ref),
        fields: new Map(),
        deleted: Uint8Array.of(1),
      });
    },
    /** Creates features in one write, each at the front of its group or its layer, in order */
    createFeatures(features: readonly Feature[]): boolean {
      const fronts = new Map<string, string | undefined>();
      const places = features.map((feature) => {
        const parent = feature.groupId ?? feature.layerId;
        const below = fronts.has(parent)
          ? fronts.get(parent)
          : (() => {
              const order = orderOf(store, parent);
              return order.length > 0 ? itemKeyOf(store, order[order.length - 1]) : undefined;
            })();
        const orderKey = createOrderKeyBetween(below, undefined);
        fronts.set(parent, orderKey);
        return { parent, orderKey };
      });
      return store.createRows({
        ids: features.map((feature) => feature.id),
        fields: newRowFields(features, places),
        geometry: geometryColumnOf(
          features.map((feature) => feature.geometry),
          2,
        ),
      });
    },
    createLayer: (layer: Layer): boolean => store.createLayer(layer),
    updateLayer: (id: string, updates: Partial<Layer>): boolean => store.updateLayer(id, updates),
    deleteLayer: (id: string): boolean => store.deleteLayer(id),
    setLayerOrder: (order: string[]): boolean => store.setLayerOrder(order),
    /** Moves an item within its layer to a position, as the order without it counts */
    reorderInLayer(itemId: string, layerId: string, newIndex: number): boolean {
      const order = orderOf(store, layerId).filter((id) => id !== itemId);
      const key = keyAt(store, order, newIndex);
      if (store.getGroup(itemId)) return store.updateGroup(itemId, { orderKey: key });
      place(itemId, layerId, key);
      return true;
    },
    /** Moves a feature within its group to a position, as the order without it counts */
    reorderInGroup(featureId: string, groupId: string, newIndex: number): boolean {
      const order = orderOf(store, groupId).filter((id) => id !== featureId);
      place(featureId, groupId, keyAt(store, order, newIndex));
      return true;
    },
    /**
     * Creates a group with the features given in it, in that order: it takes the place of its
     * first feature in the layer (the front of the layer when that one is not an item of it)
     */
    createGroup(group: Omit<StoreGroup, 'orderKey'> & { featureIds: readonly string[] }): boolean {
      const { featureIds, ...rest } = group;
      const first = featureIds[0];
      const order = orderOf(store, group.layerId);
      const created = store.createGroup({
        ...rest,
        orderKey:
          first !== undefined && order.includes(first)
            ? (itemKeyOf(store, first) as string)
            : keyAt(store, order),
      });
      if (!created) return false;
      let below: string | undefined;
      for (const id of featureIds) {
        below = createOrderKeyBetween(below, undefined);
        place(id, group.id, below);
      }
      return true;
    },
    updateGroup: (id: string, updates: Partial<StoreGroup>): boolean =>
      store.updateGroup(id, updates),
    /** Deletes a group: its features take its place in its layer first */
    deleteGroup(id: string): boolean {
      const group = store.getGroup(id);
      if (!group) return false;
      const order = orderOf(store, group.layerId);
      const at = order.indexOf(id);
      const above = at + 1 < order.length ? itemKeyOf(store, order[at + 1]) : undefined;
      let below: string | undefined = group.orderKey;
      for (const member of orderOf(store, id)) {
        below = createOrderKeyBetween(below, above);
        place(member, group.layerId, below);
      }
      return store.deleteGroup(id);
    },
    createFile: (file: FileData): boolean => store.createFile(file),
    deleteFile: (id: string): boolean => store.deleteFile(id),
    setMetadata: (metadata: Partial<Metadata>): boolean => store.setMetadata(metadata),
  };
}

/** The writes of `rowWrites` */
export type RowWrites = ReturnType<typeof rowWrites>;

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
  firstPointerAfterChange: 'the first pointer event after a change of the document',
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
    changeLookups: counts.changeLookups - before.changeLookups,
  };
}

/** The amount a scene measured at the two sizes, and how much it grew */
export interface WorkComparison {
  small: number;
  large: number;
  /** large / small, with a small amount of zero taken as one */
  ratio: number;
}

/** How a comparison takes the amounts it is given */
export interface CompareOptions {
  /**
   * The amount is meant to be zero at both sizes. Without it, an amount that is zero at both
   * sizes throws: nothing counted it, so the comparison would check nothing.
   */
  zero?: boolean;
}

/**
 * Runs a scene at both sizes
 *
 * Throws when the amount is zero at both sizes, unless `options.zero` names it.
 *
 * @param scene Builds the scene for that number of features and returns the amount it
 *   measured (the building itself is not measured)
 */
export function compareWork(
  scene: (size: number) => number,
  options: CompareOptions = {},
): WorkComparison {
  const small = scene(WORK_SIZES.small);
  const large = scene(WORK_SIZES.large);
  if (small === 0 && large === 0 && !options.zero) {
    throw new Error(
      `nothing was counted at ${WORK_SIZES.small} or at ${WORK_SIZES.large} features: ` +
        'the comparison checks nothing (pass { zero: true } when no work is what is checked)',
    );
  }
  return { small, large, ratio: large / Math.max(small, 1) };
}

/**
 * Throws unless the amount of the scene grows less than twice from 1,000 to 10,000 features
 *
 * Ten times the features with work proportional to them gives ten times the amount; work
 * that does not depend on them gives about the same amount. An amount that is zero at both
 * sizes throws unless `options.zero` names it (see `compareWork`).
 *
 * @param what What was measured, for the message
 */
export function expectNotProportional(
  scene: (size: number) => number,
  what = 'the work',
  options: CompareOptions = {},
): WorkComparison {
  const comparison = compareWork(scene, options);
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
// The Store that counts
// ============================================================================

/**
 * The methods of the tables of a Store that read rows: the values of the rows given, one row,
 * or the row found by its id (counted when one is found)
 */
const ROW_READS: ReadonlyMap<string, 'refs' | 'one' | 'found'> = new Map([
  ['readValues', 'refs'],
  ['getRowProperty', 'one'],
  ['getRowStyle', 'one'],
  ['getRowRef', 'found'],
  ['findRow', 'found'],
]);

/** The methods of a Store that write rows: the new rows given, or the rows given */
const ROW_WRITES: ReadonlyMap<string, 'ids' | 'rows'> = new Map([
  ['createRows', 'ids'],
  ['writeRows', 'rows'],
]);

/** What was read and written through a Store */
export interface StoreWork {
  /** The calls of each method of the Store and of its tables, by name */
  calls: Map<string, number>;
  /** The rows whose values were read through the tables of the Store */
  featuresRead: number;
  /** The rows the Store was given to write */
  featuresWritten: number;
}

/**
 * Wraps a Store of rows so that what goes through it is counted, whatever the marks of the
 * library count
 *
 * Every method called on the wrapper, or on its tables and the views of their layers, is counted
 * by its name, with the rows it reads (the values of `readValues` of the tables, a row found by
 * its id with `getRowRef` and `findRow` when one is found, and `getRowProperty` and `getRowStyle`
 * of a layer) and the rows it is given to write (`createRows` and `writeRows`). The method runs on the Store itself, so what the Store calls on itself is not
 * counted: only what its user asked for. Everything else (the fields, the numbers of the marks)
 * reads through to the Store, so the wrapper stands for it wherever the Store is given.
 *
 * Each call makes its own numbers, so two instances never share them.
 */
export function createCountingStore<S extends object>(
  target: S,
): { store: S; work: StoreWork; reset(): void } {
  const work: StoreWork = { calls: new Map(), featuresRead: 0, featuresWritten: 0 };
  const counted = new WeakMap<object, object>();
  /** A wrapper of an object whose methods are counted, and whose objects given back are too */
  const wrapped = <T extends object>(object: T): T => {
    const known = counted.get(object);
    if (known) return known as T;
    const methods = new Map<string, (...args: unknown[]) => unknown>();
    const proxy = new Proxy(object, {
      get(t, prop) {
        const value: unknown = Reflect.get(t, prop, t);
        if (typeof prop !== 'string') return value;
        if (typeof value !== 'function') {
          return prop === 'tables' && typeof value === 'object' && value !== null
            ? wrapped(value)
            : value;
        }
        let method = methods.get(prop);
        if (!method) {
          method = (...args: unknown[]): unknown => {
            work.calls.set(prop, (work.calls.get(prop) ?? 0) + 1);
            const write = ROW_WRITES.get(prop);
            const given = args[0] as { ids?: readonly unknown[]; rows?: ArrayLike<number> };
            if (write === 'ids') work.featuresWritten += given?.ids?.length ?? 0;
            else if (write === 'rows') work.featuresWritten += given?.rows?.length ?? 0;
            const read = ROW_READS.get(prop);
            if (read === 'refs') work.featuresRead += (args[0] as ArrayLike<number>).length;
            else if (read === 'one') work.featuresRead += 1;
            const result = (value as (...a: unknown[]) => unknown).apply(t, args);
            if (read === 'found' && result !== undefined) work.featuresRead += 1;
            // The view of a layer the tables give back is counted as well
            return prop === 'get' && typeof result === 'object' && result !== null
              ? wrapped(result)
              : result;
          };
          methods.set(prop, method);
        }
        return method;
      },
    });
    counted.set(object, proxy);
    return proxy;
  };
  return {
    store: wrapped(target),
    work,
    /** Starts the numbers again from zero */
    reset(): void {
      work.calls.clear();
      work.featuresRead = 0;
      work.featuresWritten = 0;
    },
  };
}

/** The features read and written through a counting Store while `fn` ran */
export function storeWorkDuring(
  work: StoreWork,
  fn: () => void,
): { featuresRead: number; featuresWritten: number; calls: number } {
  const before = {
    featuresRead: work.featuresRead,
    featuresWritten: work.featuresWritten,
    calls: [...work.calls.values()].reduce((sum, n) => sum + n, 0),
  };
  fn();
  return {
    featuresRead: work.featuresRead - before.featuresRead,
    featuresWritten: work.featuresWritten - before.featuresWritten,
    calls: [...work.calls.values()].reduce((sum, n) => sum + n, 0) - before.calls,
  };
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
 * It is built as `createDraw` builds it (the engine is kept, for the synthetic input), with the
 * Store wrapped by `createCountingStore` (`storeWork`). Each call makes a new Store, so the
 * numbers of two instances never mix.
 */
export function createCountedInstance(options: DrawOptions = {}): {
  draw: Draw;
  engine: Engine;
  store: RowStore;
  counts: WorkCounts;
  storeWork: StoreWork;
  gl: ReturnType<typeof createCountingGL>;
  map: ReturnType<typeof createDrawingMapStub>;
  input: ReturnType<typeof createSyntheticInput>;
} {
  const gl = createCountingGL();
  const map = createDrawingMapStub(gl.gl);
  const store = createStore();
  // The instance is given the counting wrapper; `store` stays the Store itself, for the writes
  // a test makes from outside the instance
  const counting = createCountingStore(store);
  const drawOptions: DrawOptions = { ...options, store: counting.store };
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
    storeWork: counting.work,
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

// ============================================================================
// The table of what the instance does
//
// Before the Store under the instance is replaced, what the instance does is written down once,
// scene by scene, in src/parity/records/ (one JSON line per row: a scene and one thing read after
// it). A run compares every row with its record, so a rework of the internals that keeps what the
// instance does keeps every row. The results are read in one place, `readParity`: a rework that
// renames a public member or changes the type it hands out changes the lines of the reader that
// read it, never the records. A row whose result a decided change of the public API changes
// carries a mark in src/parity/marks.json, with the number of the change and the value after it.
//
// The scenes use the public API only: `createDraw` on a map stub that delivers the input as
// maplibre does (`createParityMap`), the `store` option with a Store of the application
// (`createApplicationStore`), and plugins.
// ============================================================================

/** A map stub that delivers the pointer and the keyboard as maplibre does */
export interface ParityMap {
  map: MapLibreMap;
  /** A move of the pointer, with no button down */
  move(lngLat: [number, number], modifiers?: SyntheticModifiers): void;
  /** A press, a release and the click maplibre fires after them, at one place */
  click(lngLat: [number, number], modifiers?: SyntheticModifiers): void;
  /** Two clicks and the double click maplibre fires after them */
  dblclick(lngLat: [number, number]): void;
  /** A press of the left button (after a move there) */
  press(lngLat: [number, number], modifiers?: SyntheticModifiers): void;
  /** A move with the left button down */
  pull(lngLat: [number, number], modifiers?: SyntheticModifiers): void;
  /** A release of the left button */
  release(lngLat: [number, number], modifiers?: SyntheticModifiers): void;
  /** A press, moves in steps with the button down, and a release */
  drag(
    from: [number, number],
    to: [number, number],
    options?: { steps?: number; modifiers?: SyntheticModifiers },
  ): void;
  /** A key pressed and let go on the canvas */
  key(key: string, modifiers?: SyntheticModifiers): void;
  /** Draws one frame of the layers on the counting GL (a map made with `drawing` only) */
  render(): void;
}

/**
 * The map stub of `createMapStub` around a center (100 px to the degree), with the input of a
 * real map: the listeners the instance adds to the map and to its canvas receive the events a
 * real map gives them. With `drawing`, it is the stub of `createDrawingMapStub` on a counting GL,
 * whose layers draw a frame with `render()`.
 */
export function createParityMap(
  options: { center?: [number, number]; drawing?: boolean } = {},
): ParityMap {
  const drawing = options.drawing ? createDrawingMapStub(createCountingGL().gl) : null;
  const stub = drawing ?? createMapStub();
  const [cx, cy] = options.center ?? [0, 0];
  const mapListeners = new Map<string, Set<Listener>>();
  const canvasListeners = new Map<string, Set<Listener>>();
  const add = (to: Map<string, Set<Listener>>, type: string, fn: Listener) => {
    if (!to.has(type)) to.set(type, new Set());
    to.get(type)?.add(fn);
  };
  const map = stub.map as unknown as Record<string, unknown>;
  const on = map.on as (type: string, fn: Listener) => unknown;
  const off = map.off as (type: string, fn: Listener) => unknown;
  const project = (lngLat: { lng: number; lat: number } | [number, number]) => {
    const [lng, lat] = Array.isArray(lngLat) ? lngLat : [lngLat.lng, lngLat.lat];
    return { x: (lng - cx) * 100 + 400, y: 300 - (lat - cy) * 100 };
  };
  Object.assign(map, {
    on: (type: string, fn: Listener) => {
      add(mapListeners, type, fn);
      on(type, fn);
      return map;
    },
    off: (type: string, fn: Listener) => {
      mapListeners.get(type)?.delete(fn);
      off(type, fn);
      return map;
    },
    project,
    unproject: (p: [number, number] | { x: number; y: number }) => {
      const [x, y] = Array.isArray(p) ? p : [p.x, p.y];
      return { lng: (x - 400) / 100 + cx, lat: (300 - y) / 100 + cy };
    },
    getCenter: () => ({ lng: cx, lat: cy }),
    getBounds: () => ({
      getWest: () => cx - 4,
      getEast: () => cx + 4,
      getSouth: () => cy - 3,
      getNorth: () => cy + 3,
      getSouthWest: () => ({ lng: cx - 4, lat: cy - 3 }),
      getNorthEast: () => ({ lng: cx + 4, lat: cy + 3 }),
    }),
  });
  const canvas = stub.canvas as unknown as Record<string, unknown>;
  const addEventListener = canvas.addEventListener as (type: string, fn: Listener) => void;
  const removeEventListener = canvas.removeEventListener as (type: string, fn: Listener) => void;
  Object.assign(canvas, {
    addEventListener: (type: string, fn: Listener) => {
      add(canvasListeners, type, fn);
      addEventListener(type, fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      canvasListeners.get(type)?.delete(fn);
      removeEventListener(type, fn);
    },
  });

  const fire = (
    type: string,
    lngLat: [number, number],
    buttons: number,
    modifiers: SyntheticModifiers = {},
  ) => {
    const point = project(lngLat);
    const originalEvent = {
      type,
      button: 0,
      buttons,
      clientX: point.x,
      clientY: point.y,
      target: stub.canvas,
      shiftKey: modifiers.shift ?? false,
      ctrlKey: modifiers.ctrl ?? false,
      altKey: modifiers.alt ?? false,
      metaKey: modifiers.meta ?? false,
      sourceCapabilities: { firesTouchEvents: false },
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
      stopImmediatePropagation() {},
    };
    const event = {
      type,
      point,
      lngLat: { lng: lngLat[0], lat: lngLat[1] },
      originalEvent,
      preventDefault() {},
    };
    for (const fn of [...(mapListeners.get(type) ?? [])]) fn(event);
  };
  const keyEvent = (type: string, key: string, modifiers: SyntheticModifiers = {}) => {
    const code = /^[a-zA-Z]$/.test(key)
      ? `Key${key.toUpperCase()}`
      : /^[0-9]$/.test(key)
        ? `Digit${key}`
        : key;
    const event = {
      type,
      key,
      code,
      repeat: false,
      target: stub.canvas,
      shiftKey: modifiers.shift ?? false,
      ctrlKey: modifiers.ctrl ?? false,
      altKey: modifiers.alt ?? false,
      metaKey: modifiers.meta ?? false,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
    };
    for (const fn of [...(canvasListeners.get(type) ?? [])]) fn(event);
  };

  const parity: ParityMap = {
    map: stub.map,
    move: (lngLat, modifiers) => fire('mousemove', lngLat, 0, modifiers),
    click: (lngLat, modifiers) => {
      fire('mousemove', lngLat, 0, modifiers);
      fire('mousedown', lngLat, 1, modifiers);
      fire('mouseup', lngLat, 0, modifiers);
      fire('click', lngLat, 0, modifiers);
    },
    dblclick: (lngLat) => {
      parity.click(lngLat);
      parity.click(lngLat);
      fire('dblclick', lngLat, 0);
    },
    press: (lngLat, modifiers) => {
      fire('mousemove', lngLat, 0, modifiers);
      fire('mousedown', lngLat, 1, modifiers);
    },
    pull: (lngLat, modifiers) => fire('mousemove', lngLat, 1, modifiers),
    release: (lngLat, modifiers) => fire('mouseup', lngLat, 0, modifiers),
    drag: (from, to, { steps = 4, modifiers } = {}) => {
      parity.press(from, modifiers);
      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        parity.pull([from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f], modifiers);
      }
      parity.release(to, modifiers);
    },
    key: (key, modifiers) => {
      keyEvent('keydown', key, modifiers);
      keyEvent('keyup', key, modifiers);
    },
    render: () => {
      if (!drawing) throw new Error('the map stub was made without drawing');
      drawing.render();
    },
  };
  return parity;
}

/**
 * The members of the state of this client the Store of the published version had, which the
 * scenes call on the Store of the application. The Store no longer holds that state: the
 * instance does, so each one is read and written through the instance given the Store.
 */
export interface ParityClientMembers {
  getEditingIds(): readonly string[];
  setSelection(type: Selection['type'], ids: string[]): void;
  startEditing(ids: string[]): void;
  endEditing(ids: string[]): void;
  setSelectedVertices(selection: VertexSelection | null): void;
  setMode(mode: string): void;
  setReadOnly(value: boolean): void;
  setInteractionLock(value: boolean): void;
  setLocallyHidden(id: string, hidden: boolean): void;
}

/** Each member of the state of this client, read and written through the instance */
const PARITY_CLIENT_MEMBERS: {
  [K in keyof ParityClientMembers]: (draw: Draw) => ParityClientMembers[K];
} = {
  getEditingIds: (draw) => () => draw.editingFeatures.get().toArray(),
  setSelection: (draw) => (type, ids) => {
    if (type === null || ids.length === 0) draw.selection.clear();
    else draw.selection.set(type, ids);
  },
  // A feature that is not in the document cannot be marked (the published version kept it)
  startEditing: (draw) => (ids) =>
    draw.editingFeatures.add(ids.filter((id) => draw.features.has(id))),
  endEditing: (draw) => (ids) => draw.editingFeatures.remove(ids),
  setSelectedVertices: (draw) => (selection) => {
    if (selection) draw.vertexSelection.set(selection.featureId, selection.vertices);
    else draw.vertexSelection.clear();
  },
  setMode: (draw) => (mode) => {
    draw.setMode(mode);
  },
  setReadOnly: (draw) => (value) => draw.setReadOnly(value),
  setInteractionLock: (draw) => (value) => draw.setInteractionLocked(value),
  setLocallyHidden: (draw) => (id, hidden) => {
    if (hidden) draw.hidden.add(id);
    else draw.hidden.remove(id);
  },
};

/** The instance each Store of a scene (and the view of it a scene reads) belongs to */
const parityDraws = new WeakMap<object, Draw>();

/** The instance a Store of a scene belongs to */
function drawOfParityStore(store: unknown): Draw {
  const draw = parityDraws.get(store as object);
  if (!draw) throw new Error('the Store belongs to no instance of the scene');
  return draw;
}

/**
 * A Store of the application, kept in memory: the built-in Store spread into an object of its
 * own, as an application that keeps the document elsewhere makes it
 *
 * `store` is given to `createDraw`; `scene` is the same Store for the scene, which writes to it
 * from outside the instance as an application does when a change arrives: the writes of
 * `rowWrites`, in the words of the features, written as rows, its transactions and its
 * subscription. It also calls the members of the state of this client through it
 * (`ParityClientMembers`, read and written through the instance). What the scene calls on
 * `scene` are the uses of the row.
 *
 * The Store has no member that numbers the automatic names or that is told when a drag is given
 * up (3.0 has none), so the instance calls nothing on it besides the members of the Store:
 * `calls` stays empty, whatever the options of the scene.
 */
export interface ApplicationStore {
  store: RowStore;
  scene: RowWrites &
    Pick<RowStore, 'transact' | 'subscribe'> &
    ParityClientMembers & { readonly tables: RowStore['tables'] };
  calls: string[];
}

/**
 * Makes a Store of the application
 *
 * @param _options What the Store of the published version gave the instance besides the
 *   document (the largest number of the automatic names, the call when a drag is given up): the
 *   Store of 3.0 has no place for them, so they are not used
 */
export function createApplicationStore(
  _options: { nameNumbers?: Record<string, number>; abort?: boolean } = {},
): ApplicationStore {
  const base = createStore();
  const store: RowStore = { ...base };
  const scene: Record<string, unknown> = {};
  const noted =
    (name: string, fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      useParity(`Store.${name}`);
      return fn(...args);
    };
  for (const [name, fn] of Object.entries(rowWrites(store))) {
    scene[name] = noted(name, fn as (...args: unknown[]) => unknown);
  }
  scene.transact = noted('transact', (fn, source, options) =>
    store.transact(fn as () => unknown, source as string, options as undefined),
  );
  scene.subscribe = noted('subscribe', (listener, options) =>
    store.subscribe(listener as (change: RowStoreChange) => void, options as undefined),
  );
  scene.tables = store.tables;
  const client = PARITY_CLIENT_MEMBERS as Record<string, (draw: Draw) => unknown>;
  for (const name of Object.keys(client)) {
    scene[name] = noted(name, (...args) =>
      (client[name](drawOfParityStore(app)) as (...a: unknown[]) => unknown)(...args),
    );
  }
  const app: ApplicationStore = {
    store,
    scene: scene as unknown as ApplicationStore['scene'],
    calls: [],
  };
  return app;
}

/** The same Store for the scene: what it calls on it are the uses of the row */
export function parityStoreView<S extends object>(store: S): S {
  const view = new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof key !== 'string' || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        useParity(`Store.${key}`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const draw = parityDraws.get(store);
  if (draw) parityDraws.set(view, draw);
  return view;
}

/** The public resources of the instance whose methods the rows use, by field */
const PARITY_RESOURCES: Readonly<Record<string, string>> = {
  features: 'FeaturesCollection',
  layers: 'LayersCollection',
  groups: 'GroupsCollection',
  hidden: 'HiddenCollection',
  selection: 'SelectionResource',
  vertexSelection: 'VertexSelectionResource',
  metadata: 'MetadataResource',
  document: 'DocumentResource',
};

/** The uses of the row being run, and whether the reader is reading the state around it */
const parityUses: { current: Set<string> | null; quiet: number } = { current: null, quiet: 0 };

/** Notes a use of a public member by the row being run */
function useParity(name: string): void {
  if (parityUses.quiet === 0) parityUses.current?.add(name);
}

/** The instance as the scene sees it: the methods it calls on its resources are its uses */
function recordingDraw(draw: Draw): Draw {
  const resources = new Map<string, unknown>();
  return new Proxy(draw, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof key !== 'string') return value;
      const resource = PARITY_RESOURCES[key];
      if (resource && value && typeof value === 'object') {
        if (!resources.has(key)) {
          resources.set(
            key,
            new Proxy(value, {
              get(r, method) {
                const member = Reflect.get(r, method, r) as unknown;
                if (typeof method !== 'string' || typeof member !== 'function') return member;
                return (...args: unknown[]) => {
                  useParity(`${resource}.${method}`);
                  return (member as (...a: unknown[]) => unknown).apply(r, args);
                };
              },
            }),
          );
        }
        return resources.get(key);
      }
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        useParity(`Draw.${key}`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** An event of the instance as it arrived */
export type ParityEvent = { [K in keyof DrawEvents]: [K, DrawEvents[K]] }[keyof DrawEvents];

/** A scene's instance: the instance as the scene sees it, its map and the events it gave */
export interface ParityInstance {
  /** The instance; what the scene calls on it are the uses of the row */
  draw: Draw;
  map: ParityMap;
  /** The events since the scene started its action, in the order they arrived */
  log: ParityEvent[];
  /** The Store of the application under the instance, when the scene gave one */
  app?: ApplicationStore;
}

/** The instances of the scene being run, destroyed after it */
const parityInstances: Draw[] = [];

/**
 * Makes the instance of a scene on a map stub, with IDs `id1`, `id2` and so on
 *
 * @param options.center The center of the map stub (0, 0 when left out)
 * @param options.drawing Whether the map stub draws on a counting GL (`map.render()`)
 * @param options.app A Store of the application to give the instance
 */
export function createParityInstance(
  options: DrawOptions & {
    center?: [number, number];
    drawing?: boolean;
    app?: ApplicationStore;
  } = {},
): ParityInstance {
  const { center, drawing, app, ...drawOptions } = options;
  const map = createParityMap({ center, drawing });
  let n = 0;
  const draw = createDraw(map.map, {
    generateId: () => `id${++n}`,
    ...drawOptions,
    ...(app ? { store: app.store } : {}),
  });
  parityInstances.push(draw);
  parityDraws.set(draw.getStore(), draw);
  if (app) parityDraws.set(app, draw);
  const log: ParityEvent[] = [];
  for (const name of PARITY_EVENT_NAMES) {
    draw.on(name, (payload) => log.push([name, payload] as ParityEvent));
  }
  return { draw: recordingDraw(draw), map, log, app };
}

/** Runs the timers the instance has set (deferred work and notifications) */
export function settleParity(): void {
  vi.advanceTimersByTime(1000);
}

/** A thrown error as a record: its name and its code */
function thrownRecord(error: unknown): unknown {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { $throws: error.name, ...(code !== undefined ? { code } : {}) };
  }
  return { $throws: String(error) };
}

/**
 * Waits for a promise on the fake clock: the clock goes on while it waits, so that an edit
 * written in parts, a part in a task of its own, comes to its end
 */
async function settled<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let tick = 0; !done && tick < 100_000; tick++) await vi.advanceTimersByTimeAsync(1);
  return promise;
}

/**
 * What a scene's action did, read after it: what it returned (or threw), the document, the
 * state of this client, the events other than `document.changed`, the `document.changed`
 * notifications and the order of every event
 */
export async function observeParity(
  t: ParityInstance,
  act: () => unknown,
): Promise<Record<string, unknown>> {
  settleParity();
  t.log.length = 0;
  let returned: unknown;
  try {
    const value = act();
    returned = readParity(t.draw, 'value', value instanceof Promise ? await settled(value) : value);
  } catch (error) {
    returned = thrownRecord(error);
  }
  settleParity();
  return {
    returned,
    document: readParity(t.draw, 'document'),
    client: readParity(t.draw, 'client'),
    events: readParity(t.log, 'events'),
    changes: readParity(t.log, 'changes'),
    order: readParity(t.log, 'order'),
  };
}

/** What a call returned, or the error it threw, as a record */
export function attemptParity(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (error) {
    return thrownRecord(error);
  }
}

const readFeature = (f: PublicFeature) => ({
  id: f.id,
  type: f.type,
  geometry: f.geometry,
  layerId: f.layerId,
  groupId: f.groupId,
  properties: f.properties,
  style: f.style,
  visible: f.visible,
  locked: f.locked,
});
/**
 * The items of a layer the reader reads with it: those a layer of a document holds
 * (`DocumentLayer`), or, given the instance, the items of the layer as `layers.listItemIds` reads
 * them now; none for a layer handed out in an event (it carries none)
 */
const itemsOfLayer = (l: Layer, draw?: Draw): string[] | undefined => {
  if (Object.prototype.propertyIsEnumerable.call(l, 'items')) {
    return [...(l as DocumentLayer).items];
  }
  if (!draw) return undefined;
  return parityQuiet(() =>
    draw.layers.has(l.id)
      ? draw.layers.listItemIds(l.id, { start: 0, end: draw.layers.countItems(l.id) })
      : undefined,
  );
};
/** The features of a group the reader reads with it, as `itemsOfLayer` reads the items */
const featuresOfGroup = (g: Group, draw?: Draw): string[] | undefined => {
  if (Object.prototype.propertyIsEnumerable.call(g, 'featureIds')) {
    return [...(g as DocumentGroup).featureIds];
  }
  if (!draw) return undefined;
  return parityQuiet(() =>
    draw.groups.has(g.id)
      ? draw.groups.listFeatureIds(g.id, { start: 0, end: draw.groups.countFeatures(g.id) })
      : undefined,
  );
};
const readLayer = (l: Layer, draw?: Draw) => ({
  id: l.id,
  name: l.name,
  visible: l.visible,
  locked: l.locked,
  opacity: l.opacity,
  items: itemsOfLayer(l, draw),
  styleRule: l.styleRule,
  metadata: l.metadata,
});
const readGroup = (g: Group, draw?: Draw) => ({
  id: g.id,
  layerId: g.layerId,
  name: g.name,
  featureIds: featuresOfGroup(g, draw),
  visible: g.visible,
  locked: g.locked,
});
const readSelection = (s: Selection) => ({ type: s.type, ids: s.ids.toArray() });
const maybe =
  <T, R>(read: (v: T) => R) =>
  (v: T | undefined | null) =>
    v === undefined || v === null ? v : read(v);
/** The reader of a layer or a group read with the instance, which reads its items */
const withDraw =
  <T, R>(read: (v: T, draw?: Draw) => R, draw: Draw) =>
  (v: T) =>
    read(v, draw);

/** How each event is read: every event of the instance, by name */
const PARITY_EVENT_READS: { [K in keyof DrawEvents]-?: (p: DrawEvents[K]) => unknown } = {
  'feature.created': (p) => ({ feature: readFeature(p.feature), source: p.source }),
  'feature.updated': (p) => ({
    feature: readFeature(p.feature),
    previous: readFeature(p.previous),
    source: p.source,
    intermediate: p.intermediate,
  }),
  'feature.deleted': (p) => ({ feature: readFeature(p.feature), source: p.source }),
  'feature.moved': (p) => ({
    feature: readFeature(p.feature),
    from: p.from,
    to: p.to,
    source: p.source,
  }),
  'layer.created': (p) => ({ layer: readLayer(p.layer), source: p.source }),
  'layer.updated': (p) => ({
    layer: readLayer(p.layer),
    previous: readLayer(p.previous),
    source: p.source,
  }),
  'layer.deleted': (p) => ({ layer: readLayer(p.layer), source: p.source }),
  'layer.reordered': (p) => ({ order: [...p.order], previous: [...p.previous], source: p.source }),
  'group.created': (p) => ({ group: readGroup(p.group), source: p.source }),
  'group.updated': (p) => ({
    group: readGroup(p.group),
    previous: readGroup(p.previous),
    source: p.source,
  }),
  'group.moved': (p) => ({ group: readGroup(p.group), from: p.from, to: p.to, source: p.source }),
  'group.deleted': (p) => ({ group: readGroup(p.group), source: p.source }),
  'metadata.updated': (p) => ({ metadata: p.metadata, previous: p.previous, source: p.source }),
  'document.changed': (p) => readChange(p),
  'document.loaded': (p) => ({ result: p.result, source: p.source }),
  'selection.changed': (p) => ({
    selection: readSelection(p.selection),
    previous: readSelection(p.previous),
  }),
  'vertexSelection.changed': (p) => ({ selection: p.selection, previous: p.previous }),
  'drag.started': (p) => ({ kind: p.kind, featureIds: [...p.featureIds] }),
  'drag.ended': (p) => ({ kind: p.kind, featureIds: [...p.featureIds], cancelled: p.cancelled }),
  'mode.changed': (p) => ({ mode: p.mode, previous: p.previous }),
  'hidden.changed': (p) => ({ ids: p.ids.toArray() }),
  'editingFeatures.changed': (p) => ({ ids: p.ids.toArray() }),
  'readOnly.changed': (p) => ({ readOnly: p.readOnly }),
  'interactionLock.changed': (p) => ({ locked: p.locked }),
  'options.changed': (p) => ({ options: p.options, previous: p.previous }),
  'snap.changed': (p) => ({ result: p.result }),
  'preview.changed': (p) => ({
    feature: p.feature,
    confirmedVertices: p.confirmedVertices,
    highlightVertex: p.highlightVertex,
  }),
  'map.clicked': (p) => ({ lngLat: p.lngLat, point: p.point, hit: p.hit }),
  'dataset.clicked': (p) => ({
    datasetId: p.datasetId,
    rowIndex: p.rowIndex,
    row: p.row,
    lngLat: p.lngLat,
    point: p.point,
  }),
  'dataset.added': (p) => ({ datasetId: p.dataset.id }),
  'dataset.removed': (p) => ({ datasetId: p.datasetId }),
  'dataset.reordered': (p) => ({ order: [...p.order], previous: [...p.previous] }),
  'image.requested': (p) => ({ lngLat: p.lngLat, zoom: p.zoom, layerId: p.layerId }),
  'layerStack.changed': (p) => ({ entries: p.entries }),
  'image.failed': (p) => ({
    error: { name: p.error.name, code: p.error.code },
    source: p.source,
    featureId: p.featureId,
  }),
};

/**
 * The events of 3.0 that the published version did not have: the table is what the published
 * version did, so the scenes do not record them
 */
const PARITY_EVENTS_AFTER: ReadonlySet<string> = new Set(['editingFeatures.changed']);

/** The names of every event of the instance the table records */
export const PARITY_EVENT_NAMES = (Object.keys(PARITY_EVENT_READS) as (keyof DrawEvents)[]).filter(
  (name) => !PARITY_EVENTS_AFTER.has(name),
);

/** A `document.changed` notification, field by field: the sets of IDs as arrays */
function readChange(p: DocumentChange) {
  const ids = (set: IdSet) => [...set.iterate()];
  const layers = p.layers && {
    created: p.layers.created?.map((l) => readLayer(l)),
    updated: p.layers.updated?.map((u) => ({
      id: u.id,
      layer: readLayer(u.layer),
      previous: readLayer(u.previous),
    })),
    deleted: p.layers.deleted?.map((l) => readLayer(l)),
    orderChanged: p.layers.orderChanged,
  };
  const groups = p.groups && {
    created: p.groups.created?.map((g) => readGroup(g)),
    updated: p.groups.updated?.map((u) => ({
      id: u.id,
      group: readGroup(u.group),
      previous: readGroup(u.previous),
    })),
    deleted: p.groups.deleted?.map((g) => readGroup(g)),
    moved: p.groups.moved?.map((m) => ({
      id: m.id,
      group: readGroup(m.group),
      from: m.from,
      to: m.to,
    })),
  };
  return {
    source: p.source,
    operationId: p.operationId,
    hasMoreParts: p.hasMoreParts,
    stopped: p.stopped,
    reset: p.reset,
    features: {
      created: ids(p.features.created),
      updated: ids(p.features.updated),
      deleted: ids(p.features.deleted),
      moved: ids(p.features.moved),
    },
    layers,
    groups,
    metadata: p.metadata,
    files: p.files,
  };
}

/**
 * A change a Store told, read while it is told (the ids of the rows it deleted are let go of
 * after it): its fields, with the rows of each layer by their ids
 */
export function readStoreChange(store: RowStore, change: RowStoreChange): unknown {
  const ids = (refs: Int32Array) => Array.from(refs, (ref) => store.tables.getRowId(ref));
  return {
    source: change.source,
    operationId: change.operationId,
    hasMoreParts: change.hasMoreParts,
    stopped: change.stopped,
    reset: change.reset,
    rows: change.rows && {
      layers: [...change.rows.layers].map(([layerId, rows]) => ({
        layerId,
        created: ids(rows.created),
        updated: ids(rows.updated),
        deleted: ids(rows.deleted),
        fields: [...rows.fields].sort(),
      })),
    },
    layers: change.layers && {
      created: change.layers.created?.map((l) => readLayer(l)),
      updated: change.layers.updated?.map((u) => ({
        id: u.id,
        layer: readLayer(u.layer),
        previous: readLayer(u.previous),
      })),
      deleted: change.layers.deleted?.map((l) => readLayer(l)),
      orderChanged: change.layers.orderChanged,
    },
    groups: change.groups && {
      created: change.groups.created?.map((g) => readGroup(g)),
      updated: change.groups.updated?.map((u) => ({
        id: u.id,
        group: readGroup(u.group),
        previous: readGroup(u.previous),
      })),
      deleted: change.groups.deleted?.map((g) => readGroup(g)),
    },
    metadata: change.metadata,
    files: change.files,
  };
}

/** What the reader reads: the state around a row, one public member, a value, or the events */
export type ParityView =
  | 'document'
  | 'client'
  | 'value'
  | 'events'
  | 'changes'
  | 'order'
  | 'storeChanges'
  | `features.${'get' | 'getMany' | 'list' | 'listSize' | 'count' | 'has' | 'isEditable' | 'getAppliedStyle'}`
  | `layers.${'get' | 'getMany' | 'list' | 'count' | 'has' | 'getOrder' | 'getActive'}`
  | `groups.${'get' | 'getMany' | 'list' | 'listSize' | 'count' | 'has'}`
  | `hidden.${'get' | 'list' | 'count' | 'has'}`
  | `selection.${'get' | 'features' | 'featuresSize'}`
  | 'vertexSelection.get'
  | 'metadata.get'
  | `document.${'toJSON' | 'toGeoJSON'}`
  | 'mode'
  | 'readOnly'
  | 'interactionLocked'
  | `store.${
      | 'getFeature'
      | 'listFeatures'
      | 'listFeaturesInOrder'
      | 'getLayer'
      | 'listLayers'
      | 'getLayerOrder'
      | 'getGroup'
      | 'listGroups'
      | 'getFile'
      | 'listFiles'
      | 'getMetadata'
      | 'getSelection'
      | 'getEditingIds'
      | 'getVertexSelection'
      | 'getMode'
      | 'isReadOnly'
      | 'isInteractionLocked'
      | 'isHidden'
      | 'listHidden'}`;

/** A long list as a record: its length and its first and last IDs */
const sizeOf = (items: readonly { id: string }[]) => ({
  length: items.length,
  first: items[0]?.id,
  last: items[items.length - 1]?.id,
});

/**
 * The reader: the one place that reads the public API for the table
 *
 * `target` is the instance (`ParityInstance.draw`), a Store (for the views `store.*`), or the
 * events of a scene (for `events`, `changes` and `order`). What it returns is plain data,
 * written to the records as JSON (`parityRecord`). A thrown error is read as `{ $throws, code }`.
 */
export function readParity(target: unknown, view: ParityView, ...args: unknown[]): unknown {
  const draw = target as Draw;
  const store = target as RowStore;
  const log = target as ParityEvent[];
  const [a] = args;
  const read = (fn: () => unknown) => attemptParity(fn);
  const quiet = (fn: () => unknown) => {
    parityUses.quiet += 1;
    try {
      return read(fn);
    } finally {
      parityUses.quiet -= 1;
    }
  };
  switch (view) {
    case 'document':
      return quiet(() => ({
        order: [...draw.layers.getOrder()],
        active: draw.layers.getActive()?.id ?? null,
        layers: draw.layers.list().map(withDraw(readLayer, draw)),
        groups: draw.groups.list().map(withDraw(readGroup, draw)),
        features: draw.features.list().map(readFeature),
        metadata: draw.metadata.get(),
      }));
    case 'client':
      return quiet(() => ({
        mode: draw.getMode(),
        readOnly: draw.isReadOnly(),
        interactionLocked: draw.isInteractionLocked(),
        selection: readSelection(draw.selection.get()),
        vertexSelection: draw.vertexSelection.get(),
        hidden: draw.hidden.list().toArray(),
      }));
    case 'value':
      return a;
    case 'events':
      return log
        .filter(([name]) => name !== 'document.changed')
        .map(([name, payload]) => [
          name,
          (PARITY_EVENT_READS[name] as (p: unknown) => unknown)(payload),
        ]);
    case 'changes':
      return log
        .filter(([name]) => name === 'document.changed')
        .map(([, payload]) => readChange(payload as DocumentChange));
    case 'order':
      return log.map(([name]) => name);
    case 'storeChanges':
      // Read while each change was told (`readStoreChange`)
      return target;
    case 'features.get':
      return read(() => maybe(readFeature)(draw.features.get(a as string)));
    case 'features.getMany':
      return read(() => draw.features.getMany(a as string[]).map(maybe(readFeature)));
    case 'features.list':
      return read(() => draw.features.list(a as FeatureFilter).map(readFeature));
    case 'features.listSize':
      return read(() => sizeOf(draw.features.list(a as FeatureFilter)));
    case 'features.count':
      return read(() => draw.features.count(a as FeatureFilter));
    case 'features.has':
      return read(() => draw.features.has(a as string));
    case 'features.isEditable':
      return read(() => draw.features.isEditable(a as string));
    case 'features.getAppliedStyle':
      return read(() => draw.features.getAppliedStyle(a as string));
    case 'layers.get':
      return read(() => maybe(withDraw(readLayer, draw))(draw.layers.get(a as string)));
    case 'layers.getMany':
      return read(() => draw.layers.getMany(a as string[]).map(maybe(withDraw(readLayer, draw))));
    case 'layers.list':
      return read(() => draw.layers.list(a as LayerFilter).map(withDraw(readLayer, draw)));
    case 'layers.count':
      return read(() => draw.layers.count(a as LayerFilter));
    case 'layers.has':
      return read(() => draw.layers.has(a as string));
    case 'layers.getOrder':
      return read(() => [...draw.layers.getOrder()]);
    case 'layers.getActive':
      return read(() => maybe(withDraw(readLayer, draw))(draw.layers.getActive()));
    case 'groups.get':
      return read(() => maybe(withDraw(readGroup, draw))(draw.groups.get(a as string)));
    case 'groups.getMany':
      return read(() => draw.groups.getMany(a as string[]).map(maybe(withDraw(readGroup, draw))));
    case 'groups.list':
      return read(() => draw.groups.list(a as GroupFilter).map(withDraw(readGroup, draw)));
    case 'groups.listSize':
      return read(() => sizeOf(draw.groups.list(a as GroupFilter)));
    case 'groups.count':
      return read(() => draw.groups.count(a as GroupFilter));
    case 'groups.has':
      return read(() => draw.groups.has(a as string));
    case 'hidden.get':
      return read(() => draw.hidden.get(a as string));
    case 'hidden.list':
      return read(() => draw.hidden.list().toArray());
    case 'hidden.count':
      return read(() => draw.hidden.count());
    case 'hidden.has':
      return read(() => draw.hidden.has(a as string));
    case 'selection.get':
      return read(() => readSelection(draw.selection.get()));
    case 'selection.features':
      return read(() => draw.selection.features().map(readFeature));
    case 'selection.featuresSize':
      return read(() => sizeOf(draw.selection.features()));
    case 'vertexSelection.get':
      return read(() => draw.vertexSelection.get());
    case 'metadata.get':
      return read(() => draw.metadata.get());
    case 'document.toJSON':
      return read(() => {
        const doc = draw.document.toJSON();
        return {
          ...doc,
          layers: doc.layers?.map((l) => readLayer(l)),
          groups: doc.groups?.map((g) => readGroup(g)),
          features: doc.features.map(readFeature),
        };
      });
    case 'document.toGeoJSON':
      return read(() => draw.document.toGeoJSON());
    case 'mode':
      return read(() => draw.getMode());
    case 'readOnly':
      return read(() => draw.isReadOnly());
    case 'interactionLocked':
      return read(() => draw.isInteractionLocked());
    // The Store has no feature: one is read through the instance, many from the tables
    case 'store.getFeature':
      return read(() => maybe(readFeature)(drawOfParityStore(target).features.get(a as string)));
    case 'store.listFeatures':
    case 'store.listFeaturesInOrder':
      return read(() => readRowFeatures(store).map((f) => readFeature(f as PublicFeature)));
    // The items of a layer and the features of a group are read through the instance
    case 'store.getLayer':
      return read(() =>
        maybe(withDraw(readLayer, drawOfParityStore(target)))(store.getLayer(a as string)),
      );
    case 'store.listLayers':
      return read(() => store.listLayers().map(withDraw(readLayer, drawOfParityStore(target))));
    case 'store.getLayerOrder':
      return read(() => [...store.getLayerOrder()]);
    case 'store.getGroup':
      return read(() =>
        maybe(withDraw(readGroup, drawOfParityStore(target)))(store.getGroup(a as string)),
      );
    case 'store.listGroups':
      return read(() => store.listGroups().map(withDraw(readGroup, drawOfParityStore(target))));
    case 'store.getFile':
      return read(() => store.getFile(a as string));
    case 'store.listFiles':
      return read(() => store.listFiles());
    case 'store.getMetadata':
      return read(() => store.getMetadata());
    // The state of this client is the instance's: read through the instance of the Store
    case 'store.getSelection':
      return read(() => readSelection(drawOfParityStore(target).selection.get()));
    case 'store.getEditingIds':
      return read(() => drawOfParityStore(target).editingFeatures.get().toArray());
    case 'store.getVertexSelection':
      return read(() => drawOfParityStore(target).vertexSelection.get());
    case 'store.getMode':
      return read(() => drawOfParityStore(target).getMode());
    case 'store.isReadOnly':
      return read(() => drawOfParityStore(target).isReadOnly());
    case 'store.isInteractionLocked':
      return read(() => drawOfParityStore(target).isInteractionLocked());
    case 'store.isHidden':
      return read(() => drawOfParityStore(target).hidden.has(a as string));
    case 'store.listHidden':
      return read(() => drawOfParityStore(target).hidden.list().toArray());
  }
}

/** The value marking `undefined` in a record (JSON has none) */
const UNDEFINED_RECORD = '$undefined';

/**
 * A value as it is written to a record: plain JSON, with `undefined` as `"$undefined"` where it
 * is a value of its own (a result, an entry of an array) and left out where it is a field,
 * numbers that are not whole to 12 significant digits, and a set or a map as its entries
 */
export function parityRecord(value: unknown): unknown {
  if (value === undefined) return UNDEFINED_RECORD;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `$${value}`;
    if (value === 0) return 0;
    return Number.isInteger(value) ? value : Number(value.toPrecision(12));
  }
  if (typeof value === 'function') return '$function';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map((v) => parityRecord(v));
  if (value instanceof Set) return { $set: [...value].map((v) => parityRecord(v)) };
  if (value instanceof Map) {
    return { $map: [...value].map(([k, v]) => [parityRecord(k), parityRecord(v)]) };
  }
  if (ArrayBuffer.isView(value)) return { $bytes: value.byteLength };
  if (value instanceof Error) return thrownRecord(value);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = parityRecord(v);
  }
  return out;
}

/** One line of a record file: a row and its value, or a scene and the public members it used */
type RecordLine = { row: string; value: unknown } | { scene: string; uses: string[] };

/** The records of an axis of the table, as they were written (empty when there are none) */
export async function readParityRecords(axis: string): Promise<{
  rows: Map<string, unknown>;
  scenes: Map<string, string[]>;
}> {
  const file = new URL(`./parity/records/${axis}.jsonl`, import.meta.url);
  const rows = new Map<string, unknown>();
  const scenes = new Map<string, string[]>();
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { rows, scenes };
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as RecordLine;
    if ('row' in entry) rows.set(entry.row, entry.value);
    else scenes.set(entry.scene, entry.uses);
  }
  return { rows, scenes };
}

/** The axes of the table, each a file of scenes in src/parity/ and a record file */
export const PARITY_AXES = [
  'reads',
  'writes',
  'selection',
  'hits',
  'snapping',
  'drag',
  'events',
  'client',
  'extension',
] as const;

/**
 * The scenes of one axis of the table
 *
 * `scene(name, fn)` is one test: `fn` runs the scene and returns what it read, by the name of
 * what was read (each pair of the scene and a name is a row). With `PARITY_RECORD=1` the run
 * writes the records of the axis (done once, on the published version); otherwise every row is
 * compared with its record. `end()` adds the test that every recorded scene still has its test.
 * Each scene runs on the fake clock, from 2026-01-01, and its instances are destroyed after it.
 */
export function parityTable(axis: (typeof PARITY_AXES)[number]) {
  const recording = process.env.PARITY_RECORD === '1';
  const file = new URL(`./parity/records/${axis}.jsonl`, import.meta.url);
  let recorded: Awaited<ReturnType<typeof readParityRecords>> = {
    rows: new Map(),
    scenes: new Map(),
  };
  const lines: string[] = [];
  const names = new Set<string>();

  beforeAll(async () => {
    recorded = await readParityRecords(axis);
  });

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') });
  });
  afterEach(() => {
    for (const draw of parityInstances.splice(0)) draw.destroy();
    vi.useRealTimers();
  });

  return {
    scene(name: string, fn: () => Record<string, unknown> | Promise<Record<string, unknown>>) {
      if (names.has(name)) throw new Error(`two scenes are named ${name}`);
      names.add(name);
      it(name, async () => {
        parityUses.current = new Set();
        let views: Record<string, unknown>;
        try {
          views = await fn();
        } finally {
          settleParity();
        }
        const uses = [...parityUses.current].sort();
        parityUses.current = null;
        const rows = Object.entries(views).map(([view, value]) => ({
          row: `${name} | ${view}`,
          value: JSON.parse(JSON.stringify(parityRecord(value))) as unknown,
        }));
        if (recording) {
          lines.push(JSON.stringify({ scene: name, uses }));
          for (const r of rows) lines.push(JSON.stringify(r));
          return;
        }
        const recordedViews = [...recorded.rows.keys()].filter((r) => r.startsWith(`${name} | `));
        expect(
          rows.map((r) => r.row),
          `the rows of the scene ${name}`,
        ).toEqual(recordedViews);
        for (const r of rows) expect(r.value, r.row).toEqual(recorded.rows.get(r.row));
      });
    },
    end() {
      if (recording) {
        afterAll(async () => {
          await mkdir(new URL('./parity/records/', import.meta.url), { recursive: true });
          await writeFile(file, `${lines.join('\n')}\n`);
        });
        return;
      }
      it('every recorded scene of the axis has its test', () => {
        expect([...names].sort()).toEqual([...recorded.scenes.keys()].sort());
      });
    },
  };
}

/** Runs `fn` without noting its calls as uses of the row (the building of a scene) */
export function parityQuiet<T>(fn: () => T): T {
  parityUses.quiet += 1;
  try {
    return fn();
  } finally {
    parityUses.quiet -= 1;
  }
}

/** A square ring from (x, y), `size` degrees wide */
export function parityRing(x: number, y: number, size: number): [number, number][] {
  return [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ];
}

/**
 * The document most scenes start from, written through the public API
 *
 * - Layer `la` holds one feature of each type (`pt`, `ln`, `pg`, `hole` (a polygon with a hole),
 *   `mpt`, `mln`, `mpg`, `cir`, `fh`, `img`), a hidden one (`hid`), a locked one (`lck`), and the
 *   group `g1` of `ga` and `gb`
 * - Layer `lb` (half opaque, with a style rule) holds `pb` and `pb2`
 * - Layer `lc` is locked and holds `pc`; layer `ld` is hidden and holds `pd`
 * - `loc` is in `la` and hidden by this client; the metadata has a title
 *
 * The map shows (-4, -3) to (4, 3) around (0, 0), 100 px to the degree.
 */
export function fillParityDocument(t: ParityInstance): void {
  parityQuiet(() => {
    const { draw } = t;
    draw.layers.create({ id: 'la', name: 'A' });
    draw.layers.create({
      id: 'lb',
      name: 'B',
      opacity: 0.5,
      styleRule: {
        kind: 'categorical',
        property: 'kind',
        map: { x: '#ff0000' },
        other: '#00ff00',
      },
    });
    draw.layers.create({ id: 'lc', name: 'C' });
    draw.layers.create({ id: 'ld', name: 'D', visible: false });
    draw.layers.setActive('la');
    const inA = (input: FeatureInputLike) => draw.features.create({ layerId: 'la', ...input });
    inA({
      id: 'pt',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [-3, 2] },
      style: { pointColor: '#123456', pointShape: 'square' },
      properties: { name: 'the point', n: 1 },
    });
    inA({
      id: 'ln',
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-2, 2],
          [-1, 2],
          [-1, 2.5],
        ],
      },
      style: { strokeColor: '#ff0000', strokeWidth: 4, lineStyle: 'dashed' },
    });
    inA({
      id: 'pg',
      type: 'Polygon',
      geometry: { type: 'Polygon', coordinates: [parityRing(-3, 0, 1)] },
      style: { fillColor: '#00ff00', fillOpacity: 0.4 },
    });
    inA({
      id: 'hole',
      type: 'Polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [parityRing(0, 0, 2), parityRing(0.5, 0.5, 1).reverse()],
      },
    });
    inA({
      id: 'mpt',
      type: 'MultiPoint',
      geometry: {
        type: 'MultiPoint',
        coordinates: [
          [3, 2],
          [3.5, 2.5],
        ],
      },
    });
    inA({
      id: 'mln',
      type: 'MultiLineString',
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [-3.5, -1],
            [-2.5, -1],
          ],
          [
            [-3.5, -1.5],
            [-2.5, -1.5],
          ],
        ],
      },
    });
    inA({
      id: 'mpg',
      type: 'MultiPolygon',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [[parityRing(-1.5, -1, 0.5)], [parityRing(-0.75, -1, 0.5)]],
      },
    });
    inA({
      id: 'cir',
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [-3, -2.5] },
      properties: { 'maplibre-gl-draw:radiusMeters': 20_000 },
    });
    inA({
      id: 'fh',
      type: 'Freehand',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-1.5, -2],
          [-1.2, -2.2],
          [-0.9, -2],
          [-0.6, -2.3],
        ],
      },
    });
    inA({
      id: 'img',
      type: 'Image',
      geometry: { type: 'Point', coordinates: [2.5, -2] },
      properties: {
        'maplibre-gl-draw:imageFileId': 'file-1',
        'maplibre-gl-draw:imageWidth': 100,
        'maplibre-gl-draw:imageHeight': 50,
        'maplibre-gl-draw:createdZoom': 10,
      },
    });
    inA({
      id: 'hid',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 2.5] },
      visible: false,
    });
    inA({
      id: 'lck',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [2, 2.5] },
      locked: true,
    });
    inA({ id: 'ga', type: 'Point', geometry: { type: 'Point', coordinates: [3, -1] } });
    inA({ id: 'gb', type: 'Point', geometry: { type: 'Point', coordinates: [3.5, -1] } });
    draw.groups.create({ id: 'g1', name: 'G', featureIds: ['ga', 'gb'] });
    inA({ id: 'loc', type: 'Point', geometry: { type: 'Point', coordinates: [0, 2.5] } });
    draw.hidden.add('loc');
    draw.features.create({
      id: 'pb',
      layerId: 'lb',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, -2.5] },
      properties: { kind: 'x' },
    });
    draw.features.create({
      id: 'pb2',
      layerId: 'lb',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1.5, -2.5] },
      properties: { kind: 'y' },
    });
    draw.features.create({
      id: 'pc',
      layerId: 'lc',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [-0.5, 1.5] },
    });
    draw.layers.update('lc', { locked: true });
    draw.features.create({
      id: 'pd',
      layerId: 'ld',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [-1.5, 1.5] },
    });
    draw.metadata.update({ title: 'The document' });
  });
}

/** What `fillParityDocument` gives `features.create` */
type FeatureInputLike = Parameters<Draw['features']['create']>[0];
