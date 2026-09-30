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
import type { SnapTargetsRegistry } from '../../snapping/custom-targets.js';
import type {
  SnapCandidate as EngineSnapCandidate,
  SnapProvider as EngineSnapProvider,
  SnapProviderContext,
  SnapTargetKind,
} from '../../snapping/types.js';
import { getBoundingBox } from '../../store/spatial/index.js';
import type { Store } from '../../store/store.js';
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
import type { HitTestContext, ScreenContext, SnapContext } from '../extension/context.js';
import type { FeatureTypeDefinition, Handle } from '../extension/feature-type.js';
import type {
  CompanionProvider,
  HandleProvider,
  Hit,
  SnapCandidate,
  SnapProvider,
} from '../extension/provider.js';
import type { Feature, FeaturePatch } from '../model.js';
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
}

// ============================================================================
// Screen and map
// ============================================================================

/** The pixels per degree of longitude around a point, measured on the screen */
function degreesPerPixel(map: MapLibreMap, point: { x: number; y: number }): number {
  return toleranceDegrees((p) => map.unproject([p.x, p.y]), point, 1) || 1;
}

/** What a hit test of the contract receives, for a position and a tolerance in degrees */
function hitContextAt(
  deps: AdapterDeps,
  coordinate: Coordinate,
  toleranceLngLat: number,
): { ctx: HitTestContext; degPerPx: number } {
  const at = deps.map.project([coordinate[0], coordinate[1]]);
  const degPerPx = degreesPerPixel(deps.map, at);
  return {
    ctx: {
      point: toScreenPoint(at),
      lngLat: [coordinate[0], coordinate[1]],
      tolerancePx: toleranceLngLat / degPerPx,
      screen: deps.screen,
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
      const corners = [
        deps.map.project([rect.minX, rect.minY]),
        deps.map.project([rect.maxX, rect.maxY]),
      ];
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

/** Whether a value is a point on the screen with finite coordinates */
function isScreenPoint(value: unknown): value is ScreenPoint {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

/** A selection box with no area at one coordinate */
function degenerateBox(c: Coordinate): BoundingBoxCoords {
  return { topLeft: c, topRight: c, bottomRight: c, bottomLeft: c, center: c };
}

/** A handle of the contract as a handle of the engine */
function toEngineHandle(handle: Handle): AuxiliaryHandle {
  return {
    id: handle.id,
    position: [handle.position[0], handle.position[1]],
    ...(handle.cursor !== undefined && { cursor: handle.cursor }),
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

  try {
    const renderer = adaptFeatureRenderer(type, definition.renderer, deps);
    add(
      deps.customLayer.registerFeatureRenderer(
        type,
        appliesTo ? { ...renderer, appliesTo: applies } : renderer,
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

    const bounds = definition.bounds?.bind(definition);
    const outline = definition.outline?.bind(definition);
    /** The four corners of the outline of a feature, or null when it gives none */
    const cornersOf = (feature: StoredFeature): ScreenPoint[] | null => {
      if (!applies(feature)) return null;
      const corners = outline?.(feature as Feature, deps.screen);
      return Array.isArray(corners) && corners.length === 4 && corners.every(isScreenPoint)
        ? corners
        : null;
    };
    // A circle and an image have a frame with area; a point and a custom point type do not
    const pointFrame = overriding ? type === 'Point' : definition.geometry === 'Point';
    if (pointFrame) {
      if (bounds) {
        // A point keeps its point frame; the extent gives its size
        add(
          deps.selectionExtensions.registerPointFrameExtent(type, (feature) => {
            if (!applies(feature)) return null;
            const box = bounds(feature as Feature, deps.screen);
            if (!box) return null;
            const center = deps.screen.project((feature.geometry as GeoJSON.Point).coordinates);
            return {
              halfWidth: Math.max(center[0] - box.min[0], box.max[0] - center[0]),
              halfHeight: Math.max(center[1] - box.min[1], box.max[1] - center[1]),
            };
          }),
        );
      }
      if (outline) {
        // The frame of a point follows the outline, and the point keeps no resize handles
        add(
          deps.selectionExtensions.registerPointFrameOutline(
            type,
            (feature) => cornersOf(feature)?.map(([x, y]) => ({ x, y })) ?? null,
          ),
        );
      }
    } else if (bounds || outline) {
      const at = (x: number, y: number): Coordinate => {
        const p = deps.screen.unproject([x, y]);
        return [p[0], p[1]];
      };
      add(
        deps.selectionExtensions.registerBoundingBox(type, (feature) => {
          if (!applies(feature)) return computeBoundingBox(feature) ?? degenerateBox(at(0, 0));
          const corners = cornersOf(feature);
          if (corners) {
            // The frame and its handles follow the outline, turned as the shape is
            const [topLeft, topRight, bottomRight, bottomLeft] = corners.map(([x, y]) => at(x, y));
            const middle = at(
              corners.reduce((sum, corner) => sum + corner[0], 0) / 4,
              corners.reduce((sum, corner) => sum + corner[1], 0) / 4,
            );
            return { topLeft, topRight, bottomRight, bottomLeft, center: middle };
          }
          if (!bounds) return computeBoundingBox(feature) ?? degenerateBox(at(0, 0));
          const box = bounds(feature as Feature, deps.screen);
          if (!box) return degenerateBox(at(0, 0));
          return {
            topLeft: at(box.min[0], box.min[1]),
            topRight: at(box.max[0], box.min[1]),
            bottomRight: at(box.max[0], box.max[1]),
            bottomLeft: at(box.min[0], box.max[1]),
            center: at((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2),
          };
        }),
      );
    }

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
              handles: (feature, screen) =>
                feature.type === type && applies(feature as unknown as StoredFeature)
                  ? handles(feature, screen)
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

/** What a provider of snapping candidates of the contract receives */
function toSnapContext(ctx: SnapProviderContext, screen: ScreenContext): SnapContext {
  const excludeIds = new Set<string>(ctx.excludeFeatureIds ?? []);
  if (ctx.excludeFeatureId !== undefined) excludeIds.add(ctx.excludeFeatureId);
  return {
    point: toScreenPoint(ctx.point),
    lngLat: toPosition(ctx.lngLat),
    tolerancePx: ctx.tolerancePx,
    screen,
    excludeIds,
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
  deps: Pick<AdapterDeps, 'store' | 'screen' | 'applyPatch'>,
): AuxiliaryHandleProvider {
  let active: { featureId: string; handle: Handle } | null = null;
  const handlesOf = (featureId: string, global: boolean | undefined): Handle[] => {
    if (global) return provider.globalHandles?.(deps.screen) ?? [];
    const feature = deps.store.getFeature(featureId);
    return feature ? provider.handles(feature as Feature, deps.screen) : [];
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
    getHandles: (feature) => provider.handles(feature as Feature, deps.screen).map(toEngineHandle),
    ...(provider.globalHandles && {
      getGlobalHandles: () => provider.globalHandles?.(deps.screen).map(toEngineHandle) ?? [],
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
    draw(feature, projectionData, zoom, context) {
      drawCompanion(draw, feature, projectionData, zoom, context);
    },
    hitTest(feature, point, context) {
      const hit = provider.hitTest(feature as Feature, {
        point: toScreenPoint(point),
        lngLat: toPosition(context.unproject(point)),
        tolerancePx: context.tolerancePx,
        screen: deps.screen,
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
