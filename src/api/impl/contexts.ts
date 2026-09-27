// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The contexts of the extensions: what every extension works through, and what a mode adds
 *
 * Each context is a narrow object over the services of the engine. Nothing of the engine is
 * handed out: the contexts convert between the shapes of the contract (`[x, y]` points,
 * `[lng, lat]` positions, CSS colors) and the internal ones.
 */

import type { BBox, Position } from 'geojson';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { TopHit } from '../../dispatcher/hit-test/topmost.js';
import type { ModeManager } from '../../modes/manager.js';
import { formatColor } from '../../shared/color.js';
import type { BoxSelectionStyleConfig } from '../../shared/config/rendering.js';
import type { SelectionUIConfig } from '../../shared/config/selection.js';
import { DRAW_PROPERTY_KEYS, getDrawProperty } from '../../shared/properties.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import type { AutoNameGenerator } from '../../shared/utils/name-generator.js';
import type { PixelRatioProvider } from '../../shared/utils/pixel-ratio.js';
import type { SnapResult as StoredSnapResult } from '../../snapping/types.js';
import type { StoreSpatialIndex } from '../../store/spatial/store-spatial-index.js';
import type { Store } from '../../store/store.js';
import type { Feature as StoredFeature, TentativeState } from '../../store/types.js';
import { isWritableLayer } from '../../store/writable-layer.js';
import {
  anchorElevationMeters,
  getAnchorElevationGeneration,
  projectAnchor,
} from '../../view/terrain/anchor.js';
import type { TerrainContext } from '../../view/terrain/context.js';
import { anchorGhostOpacity } from '../../view/terrain/occlusion.js';
import type { SelectionExtensionRegistry } from '../../view/ui/selection-ui/extension-registry.js';
import { computeBoundingBox } from '../../view/ui/selection-ui/index.js';
import type { DatasetRow } from '../datasets.js';
import type { Draw } from '../draw.js';
import type { DrawEvents, ScreenPoint } from '../events.js';
import type {
  ExtensionContext,
  ModeContext,
  NameGenerator,
  ScreenContext,
  TerrainAnchors,
} from '../extension/context.js';
import type { Hit } from '../extension/provider.js';
import type { ExtensionsCollections } from '../extensions.js';
import type { Feature, FeatureInput, Layer } from '../model.js';
import type { SelectionStyleOptions } from '../options.js';
import type { SnapResult } from '../state.js';
import { mergeOptions } from './options.js';

// ============================================================================
// Conversions
// ============================================================================

/**
 * A point on the screen as the contract gives it
 *
 * @internal
 */
export function toScreenPoint(point: { x: number; y: number }): ScreenPoint {
  return [point.x, point.y];
}

/**
 * A position as the contract gives it
 *
 * @internal
 */
export function toPosition(lngLat: { lng: number; lat: number }): Position {
  return [lngLat.lng, lngLat.lat];
}

/**
 * A snapping result of the engine in the shape of the contract
 *
 * @internal
 */
export function toSnapResult(result: StoredSnapResult | null, fallback: Position): SnapResult {
  if (!result) return { lngLat: fallback };
  const out: SnapResult = { lngLat: toPosition(result.lngLat) };
  const target = result.target;
  if (target) {
    out.target = { kind: target.kind };
    if (target.featureId !== undefined) out.target.featureId = target.featureId;
    if (target.datasetId !== undefined) out.target.datasetId = target.datasetId;
    if (target.description !== undefined) out.target.description = target.description;
    if (target.vertex !== undefined) out.target.vertex = target.vertex;
    if (target.segment !== undefined) {
      out.target.segment = { start: target.segment.start, end: target.segment.end };
    }
  }
  return out;
}

/** A value of an RGBA color from 0 to 1, as the internal styles hold them */
function isRgba(value: unknown): value is [number, number, number, number] {
  return Array.isArray(value) && value.length === 4 && value.every((v) => typeof v === 'number');
}

/** The internal look of the selection with its colors written as CSS colors */
function withCssColors(value: unknown): unknown {
  if (isRgba(value)) return formatColor(value);
  if (Array.isArray(value)) return value.map(withCssColors);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, withCssColors(v)]));
  }
  return value;
}

/**
 * The look of the selection in the shape of the contract: what the options give, over the
 * look the engine resolved from the defaults
 *
 * @param config - The look of the selection the engine draws with
 * @param box - The look of the box selection the engine draws with
 * @param given - The look of the selection the options give
 * @internal
 */
export function toSelectionStyle(
  config: SelectionUIConfig,
  box: BoxSelectionStyleConfig,
  given: SelectionStyleOptions | undefined,
): Required<SelectionStyleOptions> {
  const resolved = {
    ...(withCssColors(config) as object),
    boxSelection: {
      fillColor: formatColor([box.fillColor[0], box.fillColor[1], box.fillColor[2], 1]),
      fillOpacity: box.fillColor[3],
      strokeColor: formatColor(box.strokeColor),
      strokeWidth: box.strokeWidth,
    },
  };
  return mergeOptions(resolved, (given ?? {}) as object) as Required<SelectionStyleOptions>;
}

/**
 * A row of a dataset in the shape of the contract: a GeoJSON Feature
 *
 * @internal
 */
export function toDatasetRow(feature: StoredFeature): DatasetRow {
  return {
    type: 'Feature',
    id: feature.id,
    geometry: feature.geometry,
    properties: { ...feature.properties },
  };
}

/**
 * The shape being drawn, as the engine keeps it, for a feature input of the contract
 *
 * @internal
 */
export function toTentative(
  input: FeatureInput,
  layerId: string,
  pendingFeatureId: string | undefined,
): TentativeState {
  const state: TentativeState = {
    type: input.type,
    coordinates: coordinatesOf(input) as TentativeState['coordinates'],
    layerId,
  };
  if (pendingFeatureId !== undefined) state.pendingFeatureId = pendingFeatureId;
  const properties = input.properties ?? {};
  const radius = properties[DRAW_PROPERTY_KEYS.radiusMeters];
  const angle = properties[DRAW_PROPERTY_KEYS.radiusHandleAngle];
  if (typeof radius === 'number') state.radiusMeters = radius;
  if (typeof angle === 'number') state.radiusHandleAngle = angle;
  return state;
}

// ============================================================================
// The pieces every context has
// ============================================================================

/**
 * The services of the engine that the contexts are built over
 *
 * @internal
 */
export interface ContextServices {
  readonly map: MapLibreMap;
  readonly store: Store;
  /** The terrain state of the instance */
  readonly terrain: TerrainContext;
  /** The pixel ratio the drawing uses */
  readonly pixelRatio: PixelRatioProvider;
  readonly autoNameGenerator: AutoNameGenerator;
  /** The selection extents of the custom types */
  readonly selectionExtensions: SelectionExtensionRegistry;
  /** The spatial index, for the invalidation of features */
  readonly spatialIndex: Pick<StoreSpatialIndex, 'invalidate' | 'invalidateType'>;
  readonly modeManager: ModeManager;
  /** The public API the contexts hand out */
  getDraw(): Draw;
  /** The same collections as `draw.extensions`, as the context of a plugin gives them */
  readonly collections: ExtensionsCollections;
}

/**
 * The terrain anchors over the terrain state of an instance
 *
 * @internal
 */
export function createTerrainAnchors(terrain: TerrainContext): TerrainAnchors {
  return {
    project(lngLat) {
      const point = projectAnchor(terrain, lngLat[0], lngLat[1]);
      return point ? [point.x, point.y] : null;
    },
    elevation: (lngLat) => anchorElevationMeters(terrain, lngLat[0], lngLat[1]),
    ghostOpacity: (lngLat) => anchorGhostOpacity(terrain, lngLat[0], lngLat[1]),
    generation: () => getAnchorElevationGeneration(terrain),
  };
}

/**
 * The automatic names over the name generator of an instance
 *
 * @internal
 */
export function createNameGenerator(generator: AutoNameGenerator): NameGenerator {
  return {
    next(type) {
      if (type === 'Layer') return generator.generateLayerName();
      if (type === 'Group') return generator.generateGroupName();
      return generator.generateName(type);
    },
  };
}

/**
 * The conversion between the map and the screen of an instance
 *
 * @internal
 */
export function createScreenContext(
  services: Pick<ContextServices, 'map' | 'pixelRatio' | 'selectionExtensions'>,
  boundsOf?: (feature: Feature) => { min: ScreenPoint; max: ScreenPoint } | null | undefined,
): ScreenContext {
  const { map } = services;
  const project = (lngLat: Position): ScreenPoint =>
    toScreenPoint(map.project([lngLat[0], lngLat[1]]));
  return {
    project,
    unproject: (point) => toPosition(map.unproject(point)),
    bounds(feature) {
      const own = boundsOf?.(feature);
      if (own !== undefined) return own;
      const box = computeBoundingBox(feature as StoredFeature, services.selectionExtensions);
      if (!box) return null;
      const corners = [box.topLeft, box.topRight, box.bottomRight, box.bottomLeft].map(project);
      return {
        min: [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1]))],
        max: [Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))],
      };
    },
    get zoom() {
      return map.getZoom();
    },
    get pixelRatio() {
      return services.pixelRatio.resolve();
    },
  };
}

/**
 * The subscriptions of one extension, ended together when the extension goes away
 *
 * @internal
 */
export interface Subscriptions {
  /** Keeps an unsubscribe function; returns one that also forgets it */
  track(unsubscribe: () => void): () => void;
  /** Ends every subscription */
  endAll(): void;
}

/** @internal */
export function createSubscriptions(): Subscriptions {
  const all = new Set<() => void>();
  return {
    track(unsubscribe) {
      let done = false;
      const end = () => {
        if (done) return;
        done = true;
        all.delete(end);
        unsubscribe();
      };
      all.add(end);
      return end;
    },
    endAll() {
      for (const end of [...all]) end();
    },
  };
}

/**
 * Builds the part every context of an extension has
 *
 * @param subscriptions - Where the subscriptions of the extension are kept
 * @internal
 */
export function createExtensionContext(
  services: ContextServices,
  screen: ScreenContext,
  subscriptions: Subscriptions,
): ExtensionContext {
  const { store, modeManager, spatialIndex, map } = services;
  const listeners = new Map<unknown, Map<string, () => void>>();
  const forget = (event: string, listener: unknown): void => {
    const byEvent = listeners.get(listener);
    byEvent?.delete(event);
    if (byEvent?.size === 0) listeners.delete(listener);
  };
  const subscribe = <K extends keyof DrawEvents>(
    event: K,
    listener: (payload: DrawEvents[K]) => void,
    once: boolean,
  ): (() => void) => {
    const draw = services.getDraw();
    const wrapped = once
      ? (payload: DrawEvents[K]) => {
          end();
          listener(payload);
        }
      : listener;
    const end = subscriptions.track(() => {
      forget(event, listener);
      draw.off(event, wrapped);
    });
    draw.on(event, wrapped);
    let byEvent = listeners.get(listener);
    if (!byEvent) {
      byEvent = new Map();
      listeners.set(listener, byEvent);
    }
    byEvent.get(event)?.();
    byEvent.set(event, end);
    return end;
  };
  return {
    get draw() {
      return services.getDraw();
    },
    store: services.store,
    on: (event, listener) => subscribe(event, listener, false),
    off(event, listener) {
      listeners.get(listener)?.get(event)?.();
    },
    once: (event, listener) => subscribe(event, listener, true),
    terrain: createTerrainAnchors(services.terrain),
    names: createNameGenerator(services.autoNameGenerator),
    screen,
    invalidate(filter) {
      if (filter?.type !== undefined) spatialIndex.invalidateType(filter.type);
      if (filter?.ids !== undefined) spatialIndex.invalidate(filter.ids);
      if (filter?.type === undefined && filter?.ids === undefined) {
        spatialIndex.invalidate(store.listFeatures().map((feature) => feature.id));
      }
      map.triggerRepaint();
    },
    drawing: {
      undoVertex: () => modeManager.undoVertex(),
      redoVertex: () => modeManager.redoVertex(),
      isDrawing: () => store.getTentative() !== null,
    },
  };
}

// ============================================================================
// The context of a mode
// ============================================================================

/**
 * The services a mode context adds to the common ones
 *
 * @internal
 */
export interface ModeServices extends ContextServices {
  /** The frontmost hit at a point, with a tolerance in pixels (the click tolerance when omitted) */
  hitTestTopmost(point: { x: number; y: number }, tolerancePx?: number): TopHit | null;
  /** The distance in pixels from a point to a feature of the document that was hit there */
  distanceToFeaturePx(feature: StoredFeature, point: { x: number; y: number }): number;
  /** Snaps a point on the screen as the current mode would, and reports the result */
  snapPoint(point: { x: number; y: number }): StoredSnapResult;
  /** The rows of the datasets to trace along within an extent */
  listTraceRows(bbox: BBox): Array<{ datasetId: string; rowIndex: number; feature: StoredFeature }>;
  /** The writable layer, or an empty string when no layer can be written */
  getWritableLayerId(): string;
  /** Generates the ID of a new feature */
  generateId(): string;
  /** Tells the plugins that a drawing mode created a feature (`interaction.onDrawCommit`) */
  notifyDrawCommit(feature: Feature): void;
  /** Whether new features follow the zoom with their widths */
  readonly scaleWithZoom: boolean;
  /** The resolved look of the selection */
  readonly selectionStyle: SelectionUIConfig;
  /** The resolved look of the box selection */
  readonly boxSelectionStyle: BoxSelectionStyleConfig;
}

/**
 * A topmost hit of the engine in the shape of the contract
 *
 * @internal
 */
export function toHit(
  top: TopHit | null,
  distanceToFeaturePx: (feature: StoredFeature) => number,
): Hit | null {
  if (!top) return null;
  switch (top.kind) {
    case 'store':
      return {
        kind: 'feature',
        id: top.feature.id,
        featureId: top.feature.id,
        distancePx: distanceToFeaturePx(top.feature),
      };
    case 'dataset':
      if (!top.feature) return null;
      return {
        kind: 'dataset',
        id: top.feature.id,
        datasetId: top.dataset.id,
        distancePx: 0,
      };
    case 'companion': {
      const own = (top.companion.hit as { contractHit?: Hit }).contractHit;
      return (
        own ?? {
          kind: 'companion',
          id: top.companion.hit.id,
          featureId: top.companion.featureId,
          distancePx: 0,
        }
      );
    }
  }
}

/**
 * The context of one mode, with what ends it
 *
 * @internal
 */
export interface ModeContextHandle {
  readonly context: ModeContext;
  /**
   * Runs the entering of the mode: a cursor it sets meanwhile becomes the cursor of the mode,
   * which `cursor.reset` goes back to
   */
  entering(run: () => void): void;
  /** Ends the subscriptions of the mode and takes back the cursor it set */
  dispose(): void;
}

/**
 * Builds the context of a mode: the common part, and the hit testing, the snapping, the
 * committing of features by the rules of the built-in modes, the preview and the cursor
 *
 * @internal
 */
export function createModeContext(
  services: ModeServices,
  screen: ScreenContext,
): ModeContextHandle {
  const { store, map } = services;
  const subscriptions = createSubscriptions();
  const base = createExtensionContext(services, screen, subscriptions);
  /** The ID the shape being drawn will have once it is committed */
  let pendingId: string | null = null;
  /** The cursor the mode set while it was entered, which `cursor.reset` goes back to */
  let modeCursor = '';
  let entering = false;
  /** Whether the mode has set a cursor, which is taken back when it is left */
  let cursorSet = false;

  const clearPreview = (): void => {
    pendingId = null;
    if (store.getTentative() !== null) store.setTentative(null);
  };

  const context: ModeContext = {
    get draw() {
      return services.getDraw();
    },
    store: base.store,
    on: base.on,
    off: base.off,
    once: base.once,
    terrain: base.terrain,
    names: base.names,
    screen: base.screen,
    invalidate: base.invalidate,
    drawing: base.drawing,
    setMode: (mode) => services.modeManager.setMode(mode),
    hitTest(point, options) {
      const at = { x: point[0], y: point[1] };
      return toHit(services.hitTestTopmost(at, options?.tolerancePx), (feature) =>
        services.distanceToFeaturePx(feature, at),
      );
    },
    snap(point) {
      const result = services.snapPoint({ x: point[0], y: point[1] });
      return toSnapResult(result, toPosition(result.lngLat));
    },
    commitFeature(input) {
      if (store.isReadOnly() || store.isInteractionLocked()) return null;
      const layerId = input.layerId ?? services.getWritableLayerId();
      if (layerId === '' || !isWritableLayer(store.getLayer(layerId), store)) {
        // The layer went away, or was locked or hidden, while drawing: the drawing is dropped
        clearPreview();
        services.modeManager.setMode('select');
        return null;
      }
      const properties: Record<string, unknown> = { ...(input.properties ?? {}) };
      if (properties.name === undefined) {
        const name = services.autoNameGenerator.generateName(input.type);
        if (name !== undefined) properties.name = name;
      }
      if (
        services.scaleWithZoom &&
        getDrawProperty({ properties } as StoredFeature, 'createdZoom') === undefined
      ) {
        properties[DRAW_PROPERTY_KEYS.createdZoom] = map.getZoom();
      }
      const id = input.id ?? pendingId ?? undefined;
      const feature = store.transact(() => {
        const created = services.getDraw().features.create({
          ...input,
          ...(id !== undefined && { id }),
          layerId,
          properties: properties as FeatureInput['properties'],
        });
        clearPreview();
        return created;
      });
      if (feature) services.notifyDrawCommit(feature);
      return feature;
    },
    preview: {
      set(feature, options) {
        if (feature.id !== undefined) pendingId = feature.id;
        pendingId ??= services.generateId();
        const layerId = feature.layerId ?? services.getWritableLayerId();
        const state = toTentative(feature, layerId, pendingId);
        if (options?.confirmedVertices !== undefined) {
          state.confirmedCount = options.confirmedVertices;
        }
        if (options?.highlightVertex !== undefined) {
          state.highlightedVertexIndex = options.highlightVertex;
        }
        store.setTentative(state);
      },
      clear: clearPreview,
    },
    cursor: {
      set(cursor) {
        if (entering) modeCursor = cursor;
        cursorSet = true;
        map.getCanvas().style.cursor = cursor;
      },
      reset() {
        map.getCanvas().style.cursor = modeCursor;
      },
    },
    get selectionStyle() {
      return toSelectionStyle(
        services.selectionStyle,
        services.boxSelectionStyle,
        services.getDraw().options.get().selectionStyle,
      );
    },
    listTraceRows: (bbox) =>
      services
        .listTraceRows(bbox)
        .filter((entry) => entry.rowIndex >= 0)
        .map(({ datasetId, rowIndex, feature }) => ({
          datasetId,
          rowIndex,
          row: toDatasetRow(feature),
        })),
    writableLayer() {
      const id = services.getWritableLayerId();
      return id === '' ? null : ((store.getLayer(id) as Layer | undefined) ?? null);
    },
  };

  return {
    context,
    entering(run) {
      entering = true;
      try {
        run();
      } finally {
        entering = false;
      }
    },
    dispose() {
      subscriptions.endAll();
      if (cursorSet) map.getCanvas().style.cursor = '';
      cursorSet = false;
    },
  };
}
