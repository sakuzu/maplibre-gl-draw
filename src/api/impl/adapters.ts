// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The custom feature types and the providers of the extension contract, put into the
 * registries the engine reads
 *
 * The select mode, the hit testing, the snapping and the drawing of the engine look up their
 * own registries. Each extension of the contract is installed there as an adapter, so the
 * engine finds it in the same lookups as its built-in pieces. As the contract says, the handles
 * and the snapping candidates of a custom type are installed as a provider that applies only to
 * that type.
 */

import type { Geometry } from 'geojson';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type {
  BoxSelectionStrategy,
  BoxSelectionStrategyRegistry,
} from '../../dispatcher/hit-test/box-strategy.js';
import { toleranceDegrees } from '../../dispatcher/hit-test/local-frame.js';
import type { HitTestService } from '../../dispatcher/hit-test/service.js';
import type { HitTestStrategy } from '../../dispatcher/hit-test/strategies/index.js';
import {
  LineHitTestStrategy,
  MultiLineStringHitTestStrategy,
  MultiPointHitTestStrategy,
  MultiPolygonHitTestStrategy,
  PointHitTestStrategy,
  PolygonHitTestStrategy,
} from '../../dispatcher/hit-test/strategies/index.js';
import type { DragNormalizedEvent } from '../../dispatcher/types.js';
import { createCoordinateTransform } from '../../shared/math/index.js';
import type { SnapTargetsRegistry } from '../../snapping/custom-targets.js';
import type {
  SnapCandidate as EngineSnapCandidate,
  SnapProvider as EngineSnapProvider,
  SnapProviderContext,
  SnapTargetKind,
} from '../../snapping/types.js';
import { getBoundingBox } from '../../store/spatial/index.js';
import type { Store } from '../../store/store.js';
import type { TransformFieldsRegistry } from '../../store/transform-roles.js';
import type { BoundingBox, Coordinate, Feature as StoredFeature } from '../../store/types.js';
import type {
  FeatureCompanionProvider,
  FeatureCompanionRegistry,
} from '../../view/feature-companion.js';
import type { CustomLayerInterface } from '../../view/layer/index.js';
import type {
  AuxiliaryHandle,
  AuxiliaryHandleProvider,
  AuxiliaryHandleRegistry,
} from '../../view/ui/auxiliary-handles.js';
import type { SelectionExtensionRegistry } from '../../view/ui/selection-ui/extension-registry.js';
import { computeBoundingBox } from '../../view/ui/selection-ui/index.js';
import type { BoundingBoxCoords } from '../../view/ui/selection-ui/types.js';
import type { ScreenPoint } from '../events.js';
import type { HandleContext, PointContext, ScreenContext } from '../extension/context.js';
import type {
  FeatureTypeDefinition,
  Footprint,
  GroundFootprint,
  Handle,
  ScreenFootprint,
} from '../extension/feature-type.js';
import type {
  CompanionProvider,
  HandleProvider,
  Hit,
  SnapCandidate,
  SnapProvider,
} from '../extension/provider.js';
import type { Feature, FeaturePatch } from '../model.js';
import type { SelectionStyleOptions } from '../options.js';
import type { LayerTableView } from '../tables.js';
import { toPosition, toScreenPoint } from './contexts.js';
import { toPointerEvent } from './input.js';
import type { RenderAdapterDeps } from './render-context.js';
import { adaptFeatureRenderer, createCompanionDrawer } from './render-context.js';

/**
 * The registries and services of the engine the adapters are installed into
 *
 * @internal
 */
export interface AdapterDeps extends RenderAdapterDeps {
  readonly map: MapLibreMap;
  readonly store: Store;
  readonly screen: ScreenContext;
  /** The click tolerance of the instance, in pixels */
  readonly clickTolerancePx: number;
  readonly hitTestService: HitTestService;
  readonly boxSelectionRegistry: BoxSelectionStrategyRegistry;
  readonly selectionExtensions: SelectionExtensionRegistry;
  readonly auxiliaryHandles: AuxiliaryHandleRegistry;
  readonly featureCompanions: FeatureCompanionRegistry;
  readonly snapTargets: SnapTargetsRegistry;
  readonly customLayer: CustomLayerInterface;
  /** The spatial index of the instance, which takes the extent of a custom type */
  readonly spatialIndex: {
    setCustomBoundingBoxCalculator(
      type: string,
      calculator: (feature: StoredFeature, tileSize: number) => BoundingBox,
    ): () => void;
  };
  /** Registers a provider of snapping candidates with the snapping of the instance */
  registerSnapProvider(provider: EngineSnapProvider): () => void;
  /** Applies a patch of a handle drag to a feature; `final` is false while the drag goes on */
  applyPatch(featureId: string, patch: FeaturePatch, final: boolean): void;
  /** The selection box of a feature as it is drawn (`draw.rendered.getSelectionBox`) */
  selectionBoxOf(featureId: string): Footprint | null;
  /** The look of the selection as it is now */
  selectionStyle(): Required<SelectionStyleOptions>;
  /** The fields the custom types of the instance declare, by type */
  readonly transformFields: TransformFieldsRegistry;
}

// ============================================================================
// Screen and map
// ============================================================================

/** The pixels per degree of longitude around a point, measured on the screen */
function degreesPerPixel(map: MapLibreMap, point: { x: number; y: number }): number {
  const view = createCoordinateTransform(map);
  return toleranceDegrees((p) => view.unproject(p), point, 1) || 1;
}

/**
 * What a hit test leaves out: the features this client drags as a whole (none when it drags
 * none)
 */
function hitExclusion(store: Pick<Store, 'getDragState'>): Pick<PointContext, 'excludeIds'> {
  const moving = store.getDragState()?.movingFeatureIds;
  return moving && moving.length > 0 ? { excludeIds: new Set(moving) } : {};
}

/** What a hit test of the contract receives, for a position and a tolerance in degrees */
function hitContextAt(
  deps: AdapterDeps,
  coordinate: Coordinate,
  toleranceLngLat: number,
): { ctx: PointContext; degPerPx: number } {
  const at = createCoordinateTransform(deps.map).project(coordinate);
  const degPerPx = degreesPerPixel(deps.map, at);
  return {
    ctx: {
      point: toScreenPoint(at),
      lngLat: [coordinate[0], coordinate[1]],
      tolerancePx: toleranceLngLat / degPerPx,
      screen: deps.screen,
      ...hitExclusion(deps.store),
    },
    degPerPx,
  };
}

// ============================================================================
// Custom feature types
// ============================================================================

/** The hit testing of the engine for each kind of GeoJSON geometry */
function geometryStrategy(kind: Geometry['type']): HitTestStrategy | null {
  switch (kind) {
    case 'Point':
      return new PointHitTestStrategy();
    case 'LineString':
      return new LineHitTestStrategy();
    case 'Polygon':
      return new PolygonHitTestStrategy();
    case 'MultiPoint':
      return new MultiPointHitTestStrategy();
    case 'MultiLineString':
      return new MultiLineStringHitTestStrategy();
    case 'MultiPolygon':
      return new MultiPolygonHitTestStrategy();
    default:
      return null;
  }
}

/** The hit testing of a custom type, in the terms of the engine (degrees) */
function hitTestStrategyOf(definition: FeatureTypeDefinition, deps: AdapterDeps): HitTestStrategy {
  const { type } = definition;
  const own = definition.hitTest?.bind(definition);
  if (!own) {
    const byGeometry = geometryStrategy(definition.geometry);
    return {
      geometryType: type,
      test: (feature, coordinate, tolerance) =>
        byGeometry?.test(feature, coordinate, tolerance) ?? false,
      distance: (feature, coordinate) =>
        byGeometry?.distance(feature, coordinate) ?? Number.POSITIVE_INFINITY,
      ...(byGeometry?.testDistance && {
        testDistance: (feature: StoredFeature, coordinate: Coordinate, tolerance: number) =>
          byGeometry.testDistance?.(feature, coordinate, tolerance) ?? null,
      }),
    };
  }
  const testDistance = (
    feature: StoredFeature,
    coordinate: Coordinate,
    toleranceLngLat: number,
  ): number | null => {
    const { ctx, degPerPx } = hitContextAt(deps, coordinate, toleranceLngLat);
    const hit = own(feature as Feature, ctx);
    return hit ? Math.max(0, hit.distancePx) * degPerPx : null;
  };
  return {
    geometryType: type,
    test: (feature, coordinate, tolerance) => testDistance(feature, coordinate, tolerance) !== null,
    distance: (feature, coordinate) =>
      testDistance(feature, coordinate, Number.MAX_SAFE_INTEGER) ?? Number.POSITIVE_INFINITY,
    testDistance,
  };
}

/**
 * A strategy of an override that takes only some features of its type: the others are tested
 * by the built-in strategy of the type
 */
function narrowStrategy(
  own: HitTestStrategy,
  builtIn: HitTestStrategy | undefined,
  applies: (feature: StoredFeature) => boolean,
): HitTestStrategy {
  /** Tests and measures in one pass with a strategy, as the service does */
  const testDistanceWith = (
    strategy: HitTestStrategy | undefined,
    feature: StoredFeature,
    coordinate: Coordinate,
    tolerance: number,
  ): number | null => {
    if (!strategy) return null;
    if (strategy.testDistance) return strategy.testDistance(feature, coordinate, tolerance);
    return strategy.test(feature, coordinate, tolerance)
      ? strategy.distance(feature, coordinate)
      : null;
  };
  return {
    geometryType: own.geometryType,
    test: (feature, coordinate, tolerance) =>
      applies(feature)
        ? own.test(feature, coordinate, tolerance)
        : (builtIn?.test(feature, coordinate, tolerance) ?? false),
    distance: (feature, coordinate) =>
      applies(feature)
        ? own.distance(feature, coordinate)
        : (builtIn?.distance(feature, coordinate) ?? Number.POSITIVE_INFINITY),
    testDistance: (feature, coordinate, tolerance) =>
      testDistanceWith(applies(feature) ? own : builtIn, feature, coordinate, tolerance),
    // The features the built-in type keeps reach as far as it draws them (a point marker)
    reachPx: (feature) =>
      (applies(feature) ? own.reachPx?.(feature) : builtIn?.reachPx?.(feature)) ?? 0,
  };
}

/** The box selection of a custom type, in the terms of the engine */
function boxSelectionOf(
  definition: FeatureTypeDefinition,
  deps: AdapterDeps,
): BoxSelectionStrategy | null {
  const own = definition.boxSelect?.bind(definition);
  if (!own) {
    const byGeometry = deps.boxSelectionRegistry.get(definition.geometry);
    return byGeometry
      ? {
          featureType: definition.type,
          intersects: (feature, rect) => byGeometry.intersects(feature, rect),
        }
      : null;
  }
  return {
    featureType: definition.type,
    intersects(feature, rect) {
      const view = createCoordinateTransform(deps.map);
      const corners = [view.project([rect.minX, rect.minY]), view.project([rect.maxX, rect.maxY])];
      const min: ScreenPoint = [
        Math.min(corners[0].x, corners[1].x),
        Math.min(corners[0].y, corners[1].y),
      ];
      const max: ScreenPoint = [
        Math.max(corners[0].x, corners[1].x),
        Math.max(corners[0].y, corners[1].y),
      ];
      const center: Coordinate = [(rect.minX + rect.maxX) / 2, (rect.minY + rect.maxY) / 2];
      const { ctx } = hitContextAt(deps, center, 0);
      return own(feature as Feature, { min, max }, { ...ctx, tolerancePx: 0 });
    },
  };
}

/** Whether a value is a position with finite coordinates */
function isPosition(value: unknown): value is GeoJSON.Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

/** Whether a value is a size in pixels: a finite number of 0 or more */
function isSizePx(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * A footprint a type gave, when it is one: null for nothing to draw, undefined for anything
 * else, which gives the footprint of the geometry
 */
function validFootprint(value: unknown): Footprint | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object' || value === undefined) return undefined;
  const shape = value as Partial<GroundFootprint> & Partial<ScreenFootprint>;
  if (shape.kind === 'ground') {
    const corners = shape.corners;
    return corners &&
      [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft].every(isPosition)
      ? (shape as GroundFootprint)
      : undefined;
  }
  if (shape.kind === 'screen') {
    return isPosition(shape.position) && isSizePx(shape.halfWidthPx) && isSizePx(shape.halfHeightPx)
      ? (shape as ScreenFootprint)
      : undefined;
  }
  return undefined;
}

/** A selection box with no area at one coordinate */
function degenerateBox(c: Coordinate): BoundingBoxCoords {
  return { topLeft: c, topRight: c, bottomRight: c, bottomLeft: c, center: c };
}

/**
 * A handle of the contract as a handle of the engine, or null for one that is not one (another
 * kind, or a custom one whose size is not a finite number of 0 or more)
 */
function toEngineHandle(handle: Handle): AuxiliaryHandle | null {
  if (handle === null || typeof handle !== 'object') return null;
  const position: Coordinate = [handle.position[0], handle.position[1]];
  const cursor = handle.cursor !== undefined && { cursor: handle.cursor };
  if (handle.kind === 'scale') return { kind: 'scale', id: handle.id, position, ...cursor };
  if (handle.kind === 'custom' && Number.isFinite(handle.sizePx) && handle.sizePx >= 0) {
    return { kind: 'custom', id: handle.id, position, sizePx: handle.sizePx, ...cursor };
  }
  return null;
}

/** The handles of the contract that are handles, as the engine takes them */
function toEngineHandles(handles: readonly Handle[]): AuxiliaryHandle[] {
  const out: AuxiliaryHandle[] = [];
  for (const handle of handles) {
    const engine = toEngineHandle(handle);
    if (engine) out.push(engine);
  }
  return out;
}

/**
 * The context the handles of a feature are placed with: its selection box and the look of the
 * selection are read when they are asked for
 */
function handleContextOf(
  featureId: string,
  deps: Pick<AdapterDeps, 'screen' | 'selectionBoxOf' | 'selectionStyle'>,
): HandleContext {
  return {
    screen: deps.screen,
    get selectionBox() {
      return deps.selectionBoxOf(featureId);
    },
    get selectionStyle() {
      return deps.selectionStyle();
    },
  };
}

/**
 * Installs a custom feature type into the engine
 *
 * @param overriding - The definition overrides the built-in type of its name: the built-in
 *   hit test and box selection stay when it has none of its own, and only the built-in
 *   `Point` keeps the frame of a point
 * @returns The function that uninstalls it
 * @internal
 */
export function installFeatureType(
  definition: FeatureTypeDefinition,
  deps: AdapterDeps,
  overriding = false,
): () => void {
  const { type } = definition;
  const cancels: Array<() => void> = [];
  const add = (cancel: (() => void) | undefined): void => {
    if (cancel) cancels.push(cancel);
  };
  const uninstall = (): void => {
    for (let i = cancels.length - 1; i >= 0; i--) cancels[i]();
  };

  // An override can take only some features of the type; the others keep the built-in type
  const appliesTo = overriding ? definition.appliesTo?.bind(definition) : undefined;
  const applies = (feature: StoredFeature): boolean => appliesTo?.(feature as Feature) !== false;
  // The same answer, from a row of a layer held as rows (read with appliesTo only)
  const rows = definition.rows;
  const appliesToRow = appliesTo && rows ? rows.appliesTo.bind(rows) : undefined;

  try {
    const renderer = adaptFeatureRenderer(type, definition.renderer, deps);
    add(
      deps.customLayer.registerFeatureRenderer(
        type,
        appliesTo
          ? {
              ...renderer,
              appliesTo: applies,
              ...(appliesToRow && {
                appliesToRow: (view, handle) => appliesToRow(view, handle) !== false,
              }),
            }
          : renderer,
      ),
    );
    if (!overriding || definition.hitTest) {
      const own = hitTestStrategyOf(definition, deps);
      const builtIn = appliesTo ? deps.hitTestService.getStrategy?.(type) : undefined;
      add(
        deps.hitTestService.registerStrategy?.(
          appliesTo ? narrowStrategy(own, builtIn, applies) : own,
        ),
      );
    }
    const box = !overriding || definition.boxSelect ? boxSelectionOf(definition, deps) : null;
    if (box) {
      const builtIn = appliesTo ? deps.boxSelectionRegistry.get(type) : undefined;
      add(
        deps.boxSelectionRegistry.register(
          appliesTo
            ? {
                featureType: box.featureType,
                intersects: (feature, rect) =>
                  applies(feature)
                    ? box.intersects(feature, rect)
                    : (builtIn?.intersects(feature, rect) ?? false),
              }
            : box,
        ),
      );
    }

    const footprint = definition.footprint?.bind(definition);
    if (footprint) {
      /** The footprint the type gives a feature it takes, when it is one */
      const footprintOf = (feature: StoredFeature): Footprint | null | undefined =>
        applies(feature) ? validFootprint(footprint(feature as Feature, deps.screen)) : undefined;
      // The selection box on the map: the corners of a footprint laid on the map, or the
      // position of one of the screen (a box without area, which is drawn on the screen around
      // it); the box of the geometry for a feature the type does not take or gives none of
      add(
        deps.selectionExtensions.registerBoundingBox(type, (feature) => {
          const shape = footprintOf(feature);
          if (shape === null) return null;
          if (shape === undefined) return computeBoundingBox(feature);
          if (shape.kind === 'screen') return degenerateBox([shape.position[0], shape.position[1]]);
          const { topLeft, topRight, bottomRight, bottomLeft } = shape.corners;
          const corners = [topLeft, topRight, bottomRight, bottomLeft];
          return {
            topLeft: [topLeft[0], topLeft[1]],
            topRight: [topRight[0], topRight[1]],
            bottomRight: [bottomRight[0], bottomRight[1]],
            bottomLeft: [bottomLeft[0], bottomLeft[1]],
            center: [
              corners.reduce((sum, corner) => sum + corner[0], 0) / 4,
              corners.reduce((sum, corner) => sum + corner[1], 0) / 4,
            ],
          };
        }),
      );
      // The size on the screen of a footprint of the screen
      add(
        deps.selectionExtensions.registerPointFrameExtent(type, (feature) => {
          const shape = footprintOf(feature);
          return shape?.kind === 'screen'
            ? { halfWidth: shape.halfWidthPx, halfHeight: shape.halfHeightPx }
            : null;
        }),
      );
    }

    // The fields its resize and rotation write, for a custom type (an override keeps the fields of
    // the built-in type)
    if (!overriding) add(deps.transformFields.register(type, definition.transformFields ?? {}));

    const handles = definition.handles?.bind(definition);
    if (handles) {
      const onHandleDrag = definition.onHandleDrag?.bind(definition);
      const onHandleDragStart = definition.onHandleDragStart?.bind(definition);
      const onHandleDragEnd = definition.onHandleDragEnd?.bind(definition);
      add(
        deps.auxiliaryHandles.register(
          adaptHandleProvider(
            {
              name: `\u0000type:${type}`,
              handles: (feature, ctx) =>
                feature.type === type && applies(feature as unknown as StoredFeature)
                  ? handles(feature, ctx)
                  : [],
              onDrag: (feature, handle, event) =>
                feature && onHandleDrag ? onHandleDrag(feature, handle, event) : null,
              ...(onHandleDragStart && {
                onDragStart: (feature, handle, event) =>
                  feature !== null && onHandleDragStart(feature, handle, event) !== false,
              }),
              ...(onHandleDragEnd && {
                onDragEnd: (feature, handle, event) => onHandleDragEnd(feature, handle, event),
              }),
            },
            deps,
          ),
        ),
      );
    }

    const snapCandidates = definition.snapCandidates?.bind(definition);
    if (snapCandidates) {
      add(
        deps.snapTargets.register(
          type,
          (feature, ctx) =>
            snapCandidates(feature as Feature, toSnapContext(ctx, deps.screen)).map((candidate) =>
              toEngineCandidate(candidate, feature.id),
            ),
          appliesTo && applies,
        ),
      );
    }

    const bbox = definition.bbox?.bind(definition);
    if (bbox) {
      // The spatial index measures the features of the type by the extent it gives
      add(
        deps.spatialIndex.setCustomBoundingBoxCalculator(type, (feature, tileSize) => {
          if (!applies(feature)) return getBoundingBox(feature, tileSize);
          const extent = bbox(feature as Feature);
          if (
            Array.isArray(extent) &&
            extent.length === 4 &&
            extent.every((value) => Number.isFinite(value)) &&
            extent[0] <= extent[2] &&
            extent[1] <= extent[3]
          ) {
            return { minX: extent[0], minY: extent[1], maxX: extent[2], maxY: extent[3] };
          }
          return getBoundingBox(feature, tileSize);
        }),
      );
    }

    if (definition.hitPaddingPx !== undefined) {
      add(deps.hitTestService.registerCandidateReach?.(type, definition.hitPaddingPx));
    }
  } catch (error) {
    uninstall();
    throw error;
  }

  // What the Store already holds of the type is measured and drawn again
  deps.map.triggerRepaint();
  return uninstall;
}

// ============================================================================
// Providers
// ============================================================================

/** The kinds of snapping target the engine knows */
const ENGINE_KINDS: ReadonlySet<string> = new Set<SnapTargetKind>([
  'vertex',
  'edge',
  'intersection',
  'guide',
]);

/**
 * What a provider of snapping candidates of the contract receives: what the snapping leaves out
 * (the features moved as a whole, the one being drawn), absent when it leaves out none
 */
function toSnapContext(ctx: SnapProviderContext, screen: ScreenContext): PointContext {
  const excludeIds = new Set<string>(ctx.excludeFeatureIds ?? []);
  if (ctx.excludeFeatureId !== undefined) excludeIds.add(ctx.excludeFeatureId);
  return {
    point: toScreenPoint(ctx.point),
    lngLat: toPosition(ctx.lngLat),
    tolerancePx: ctx.tolerancePx,
    screen,
    ...(excludeIds.size > 0 && { excludeIds }),
  };
}

/** A snapping candidate of the contract as a candidate of the engine (a point) */
function toEngineCandidate(candidate: SnapCandidate, featureId?: string): EngineSnapCandidate {
  const own = !ENGINE_KINDS.has(candidate.kind);
  return {
    kind: own ? 'vertex' : (candidate.kind as SnapTargetKind),
    ...(own && { ownKind: candidate.kind }),
    coordinate: [candidate.position[0], candidate.position[1]],
    ...(featureId !== undefined && { featureId }),
    ...(candidate.source !== undefined && { description: candidate.source }),
    ...(candidate.priority !== undefined && { priority: candidate.priority }),
  };
}

/**
 * A provider of snapping candidates of the contract as one of the engine
 *
 * @internal
 */
export function adaptSnapProvider(
  provider: SnapProvider,
  screen: ScreenContext,
): EngineSnapProvider {
  return {
    name: provider.name,
    candidates: (_bbox, ctx) =>
      provider
        .candidates(toSnapContext(ctx, screen))
        .map((candidate) => toEngineCandidate(candidate)),
  };
}

/**
 * A provider of handles of the contract as a provider of auxiliary handles of the engine
 *
 * The drag of a handle asks `onDragStart` first, which can refuse it, then calls `onDrag` for
 * every move and applies its patch as an intermediate update; the patch of the end of the drag
 * is applied as the final one, and `onDragEnd` follows it.
 *
 * @internal
 */
export function adaptHandleProvider(
  provider: HandleProvider,
  deps: Pick<AdapterDeps, 'store' | 'screen' | 'applyPatch' | 'selectionBoxOf' | 'selectionStyle'>,
): AuxiliaryHandleProvider {
  let active: { featureId: string; handle: Handle } | null = null;
  /** The handles of a feature, of the contract, that the engine takes */
  const featureHandles = (feature: Feature): Handle[] =>
    provider
      .handles(feature, handleContextOf(feature.id, deps))
      .filter((handle) => toEngineHandle(handle) !== null);
  const handlesOf = (featureId: string, global: boolean | undefined): Handle[] => {
    if (global) {
      return (provider.globalHandles?.(deps.screen) ?? []).filter(
        (handle) => toEngineHandle(handle) !== null,
      );
    }
    const feature = deps.store.getFeature(featureId);
    return feature ? featureHandles(feature as Feature) : [];
  };
  const drag = (event: DragNormalizedEvent, final: boolean): void => {
    if (!active) return;
    const feature = active.featureId ? deps.store.getFeature(active.featureId) : undefined;
    const patch = provider.onDrag(
      (feature as Feature | undefined) ?? null,
      active.handle,
      toPointerEvent(event),
    );
    if (patch && feature) deps.applyPatch(feature.id, patch, final);
  };
  return {
    id: provider.name,
    getHandles: (feature) =>
      toEngineHandles(provider.handles(feature as Feature, handleContextOf(feature.id, deps))),
    ...(provider.globalHandles && {
      getGlobalHandles: () => toEngineHandles(provider.globalHandles?.(deps.screen) ?? []),
    }),
    onHandleDragStart(hit, event) {
      const handle = handlesOf(hit.featureId, hit.global).find((h) => h.id === hit.handleId);
      if (!handle) return false;
      if (provider.onDragStart) {
        const feature = hit.featureId ? deps.store.getFeature(hit.featureId) : undefined;
        const accepted = provider.onDragStart(
          (feature as Feature | undefined) ?? null,
          handle,
          toPointerEvent(event),
        );
        if (accepted === false) return false;
      }
      active = { featureId: hit.featureId, handle };
      return true;
    },
    onHandleDragMove(event) {
      drag(event, false);
    },
    onHandleDragEnd(event) {
      const ended = active;
      try {
        drag(event, true);
      } finally {
        active = null;
        if (ended && provider.onDragEnd) {
          const feature = ended.featureId ? deps.store.getFeature(ended.featureId) : undefined;
          provider.onDragEnd(
            (feature as Feature | undefined) ?? null,
            ended.handle,
            toPointerEvent(event),
          );
        }
      }
    },
  };
}

/**
 * A provider of companions of the contract as one of the engine
 *
 * The hit the provider returns is kept with the hit of the engine, so that `onClick` and the
 * hit testing of a mode get it back as it was.
 *
 * @internal
 */
export function adaptCompanionProvider(
  provider: CompanionProvider,
  deps: AdapterDeps,
): FeatureCompanionProvider {
  const drawCompanion = createCompanionDrawer(deps, () => deps.customLayer.getGL());
  const draw = provider.draw.bind(provider);
  return {
    id: provider.name,
    has: (feature) => provider.has(feature as Feature),
    // The same answer, from a row of a layer held as rows
    ...(provider.rows && {
      hasRow: (view: LayerTableView, handle: number) => provider.rows?.has(view, handle) === true,
    }),
    draw(feature, projectionData, zoom, context) {
      drawCompanion(draw, feature, projectionData, zoom, context);
    },
    hitTest(feature, point, context) {
      const hit = provider.hitTest(feature as Feature, {
        point: toScreenPoint(point),
        lngLat: toPosition(context.unproject(point)),
        tolerancePx: context.tolerancePx,
        screen: deps.screen,
        ...hitExclusion(deps.store),
      });
      return hit ? ({ id: hit.id, contractHit: hit } as { id: string; contractHit: Hit }) : null;
    },
    onCompanionClick(featureId, hit, event?: unknown) {
      const feature = deps.store.getFeature(featureId);
      const own = (hit as { contractHit?: Hit }).contractHit;
      if (!feature || !own || !provider.onClick || !event) return false;
      const handled = provider.onClick(
        feature as Feature,
        own,
        toPointerEvent(event as DragNormalizedEvent),
      );
      return handled === true;
    },
  };
}
