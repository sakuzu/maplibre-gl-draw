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
import type { BBox } from '../../geometry/types.js';
import { createCoordinateTransform } from '../../shared/math/index.js';
import type { RenderedShapes } from '../../sketches/rendered-shapes.js';
import type { SnapTargetsRegistry } from '../../snapping/custom-targets.js';
import type {
  SnapCandidate as EngineSnapCandidate,
  SnapProvider as EngineSnapProvider,
  SnapProviderContext,
  SnapTargetKind,
} from '../../snapping/types.js';
import { getBoundingBox } from '../../store/spatial/index.js';
import type { Store, FeaturePatch as StorePatch } from '../../store/store.js';
import type { TransformFieldsRegistry } from '../../store/transform-roles.js';
import type { Coordinate, Feature as StoredFeature } from '../../store/types.js';
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
import type {
  FootprintContext,
  HandleContext,
  PointContext,
  ScreenContext,
} from '../extension/context.js';
import type {
  CustomHandle,
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
import type { Feature } from '../model.js';
import type { SelectionStyleOptions } from '../options.js';
import type { LayerTableView } from '../tables.js';
import type { AppliedStyles } from './applied-style.js';
import { toPosition, toScreenPoint } from './contexts.js';
import {
  featureForExtension,
  featureForExtensionOrNull,
  readFeatureFields,
  storedPatchOf,
} from './feature-shape.js';
import { toPointerEvent } from './input.js';
import type { RenderAdapterDeps } from './render-context.js';
import {
  adaptFeatureRender,
  createCompanionDrawer,
  createFrameContexts,
} from './render-context.js';

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
      calculator: (feature: StoredFeature, tileSize: number) => BBox,
    ): () => void;
  };
  /** Registers a provider of snapping candidates with the snapping of the instance */
  registerSnapProvider(provider: EngineSnapProvider): () => void;
  /** The shapes as they are seen */
  readonly shapes: RenderedShapes;
  /** The selection box of a feature as it is drawn (`draw.rendered.getSelectionBox`) */
  selectionBoxOf(featureId: string): Footprint | null;
  /** The look of the selection as it is now */
  selectionStyle(): Required<SelectionStyleOptions>;
  /** The fields the custom types of the instance declare, by type */
  readonly transformFields: TransformFieldsRegistry;
  /** The looks of the features, which take the look a custom type declares */
  readonly appliedStyles: Pick<AppliedStyles, 'registerType'>;
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
function hitExclusion(
  shapes: Pick<RenderedShapes, 'draggedIds'>,
): Pick<PointContext, 'excludeIds'> {
  const moving = shapes.draggedIds();
  return moving.length > 0 ? { excludeIds: new Set(moving) } : {};
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
      ...hitExclusion(deps.shapes),
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
    const hit = own(featureForExtension(feature), ctx);
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
      const corners = [view.project([rect[0], rect[1]]), view.project([rect[2], rect[3]])];
      const min: ScreenPoint = [
        Math.min(corners[0].x, corners[1].x),
        Math.min(corners[0].y, corners[1].y),
      ];
      const max: ScreenPoint = [
        Math.max(corners[0].x, corners[1].x),
        Math.max(corners[0].y, corners[1].y),
      ];
      const center: Coordinate = [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2];
      const { ctx } = hitContextAt(deps, center, 0);
      return own(featureForExtension(feature), { min, max }, { ...ctx, tolerancePx: 0 });
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
 * Whether a handle of the contract is one the engine takes: a resize handle, or a custom one whose
 * size is a finite number above 0
 */
function isHandle(handle: Handle): boolean {
  if (handle === null || typeof handle !== 'object') return false;
  if (handle.kind === 'resize') return true;
  return handle.kind === 'custom' && Number.isFinite(handle.sizePx) && handle.sizePx > 0;
}

/**
 * Leaves out the handles the engine does not take, with a warning in the console once for each
 * reason of each extension (`warned` keeps the reasons told)
 */
function takenHandles(handles: readonly Handle[], label: string, warned: Set<string>): Handle[] {
  if (handles.every(isHandle)) return handles as Handle[];
  const out: Handle[] = [];
  for (const handle of handles) {
    if (isHandle(handle)) {
      out.push(handle);
      continue;
    }
    const kind = (handle as { kind?: unknown } | null)?.kind;
    const reason =
      kind === 'custom'
        ? 'a custom handle whose sizePx is not a finite number above 0'
        : `a handle of the kind ${JSON.stringify(kind)} (a handle is of the kind 'resize' or 'custom')`;
    if (warned.has(reason)) continue;
    warned.add(reason);
    console.warn(`The ${label} gave ${reason}, which is left out`);
  }
  return out;
}

/** A handle of the contract the engine takes as a handle of the engine */
function toEngineHandle(handle: Handle): AuxiliaryHandle {
  const position: Coordinate = [handle.position[0], handle.position[1]];
  const cursor = handle.cursor !== undefined && { cursor: handle.cursor };
  return handle.kind === 'resize'
    ? { kind: 'resize', id: handle.id, position, ...cursor }
    : { kind: 'custom', id: handle.id, position, sizePx: handle.sizePx, ...cursor };
}

/** A custom handle of the engine as a handle of the contract, for its drawing */
function toCustomHandle(handle: AuxiliaryHandle): CustomHandle | null {
  if (handle.kind !== 'custom') return null;
  return {
    kind: 'custom',
    id: handle.id,
    position: [handle.position[0], handle.position[1]],
    sizePx: handle.sizePx,
    ...(handle.cursor !== undefined && { cursor: handle.cursor }),
  };
}

/**
 * The context the handles of a feature are placed with: its selection box (none for the handles
 * of no feature, `featureId` null) and the look of the selection are read when they are asked for
 */
function handleContextOf(
  featureId: string | null,
  deps: Pick<AdapterDeps, 'screen' | 'selectionBoxOf' | 'selectionStyle'>,
): HandleContext {
  return {
    screen: deps.screen,
    get selectionBox() {
      return featureId === null ? null : deps.selectionBoxOf(featureId);
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
  const applies = (feature: StoredFeature): boolean =>
    appliesTo?.(featureForExtension(feature)) !== false;
  // The same answer, from a row of a layer held as rows (read with appliesTo only)
  const rows = definition.rows;
  const appliesToRow = appliesTo && rows ? rows.appliesTo.bind(rows) : undefined;

  try {
    const render = definition.render?.bind(definition);
    const renderer = {
      ...adaptFeatureRender(type, render, deps),
      // The pictures of the points drawn with the rows, as the definition gives them
      ...(definition.rows?.sprites && { rowSprites: definition.rows.sprites }),
    };
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
      const footprintContext: FootprintContext = Object.freeze({ screen: deps.screen });
      let warnedFootprint = false;
      /** The footprint the type gives a feature it takes, when it is one */
      const footprintOf = (feature: StoredFeature): Footprint | null | undefined => {
        if (!applies(feature)) return undefined;
        const valid = validFootprint(footprint(featureForExtension(feature), footprintContext));
        if (valid === undefined && !warnedFootprint) {
          warnedFootprint = true;
          console.warn(
            `The feature type ${JSON.stringify(type)} gave a footprint that is not one (four ` +
              'finite corners laid on the map, or a position and sizes of 0 or more on the ' +
              'screen), so the footprint of its geometry is used',
          );
        }
        return valid;
      };
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
    // The look it declares, for a custom type (an override keeps the defaults of the built-in
    // type)
    if (!overriding) {
      add(deps.appliedStyles.registerType(type, { style: definition.defaultStyle }));
    }

    const handles = definition.handles?.bind(definition);
    if (handles) {
      const onHandleDrag = definition.onHandleDrag?.bind(definition);
      const onHandleDragStart = definition.onHandleDragStart?.bind(definition);
      const onHandleDragEnd = definition.onHandleDragEnd?.bind(definition);
      const drawHandles = definition.drawHandles?.bind(definition);
      add(
        deps.auxiliaryHandles.register(
          adaptHandleProvider(
            {
              name: `\u0000type:${type}`,
              handles: (feature, ctx) =>
                readFeatureFields(feature).featureType === type && appliesTo?.(feature) !== false
                  ? handles(feature, ctx)
                  : [],
              onHandleDrag: (feature, handle, event) =>
                feature && onHandleDrag ? onHandleDrag(feature, handle, event) : null,
              ...(onHandleDragStart && {
                onHandleDragStart: (feature, handle, event) =>
                  feature !== null && onHandleDragStart(feature, handle, event) !== false,
              }),
              ...(onHandleDragEnd && {
                onHandleDragEnd: (feature, handle, event) =>
                  onHandleDragEnd(feature, handle, event),
              }),
              ...(drawHandles && {
                drawHandles: (feature, shown, ctx) => {
                  if (feature) drawHandles(feature, shown, ctx);
                },
              }),
            },
            deps,
            `feature type ${JSON.stringify(type)}`,
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
            snapCandidates(featureForExtension(feature), toSnapContext(ctx, deps.screen)).map(
              (candidate) => toEngineCandidate(candidate, feature.id),
            ),
          appliesTo && applies,
        ),
      );
    }

    const bbox = definition.bbox?.bind(definition);
    if (bbox) {
      let warnedBBox = false;
      // The spatial index measures the features of the type by the extent it gives
      add(
        deps.spatialIndex.setCustomBoundingBoxCalculator(type, (feature, tileSize) => {
          if (!applies(feature)) return getBoundingBox(feature, tileSize);
          const extent = bbox(featureForExtension(feature));
          if (
            Array.isArray(extent) &&
            extent.length === 4 &&
            extent.every((value) => Number.isFinite(value)) &&
            extent[0] <= extent[2] &&
            extent[1] <= extent[3]
          ) {
            return extent;
          }
          if (!warnedBBox) {
            warnedBBox = true;
            console.warn(
              `The feature type ${JSON.stringify(type)} gave a bbox that is not one (four finite ` +
                'numbers from the west and south to the east and north), so the extent of its ' +
                'geometry is used',
            );
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
 * The drag of a handle asks `onHandleDragStart` first, which can refuse it, then calls
 * `onHandleDrag` for every move and gives the engine its patch, which shows it; the patch of the end
 * of the drag is written with them, and `onHandleDragEnd` follows it.
 *
 * @internal
 */
export function adaptHandleProvider(
  provider: HandleProvider,
  deps: Pick<
    AdapterDeps,
    | 'store'
    | 'screen'
    | 'shapes'
    | 'selectionBoxOf'
    | 'selectionStyle'
    | 'customLayer'
    | 'surface'
    | 'appliedStyle'
  >,
  label = `handle provider ${JSON.stringify(provider.name)}`,
): AuxiliaryHandleProvider {
  let active: { featureId: string; handle: Handle } | null = null;
  /** The reasons of the handles left out that were told in the console */
  const warned = new Set<string>();
  /** The handles of a feature (null: the handles of no feature) the engine takes */
  const handlesOf = (feature: Feature | null): Handle[] => {
    const ctx = handleContextOf(feature?.id ?? null, deps);
    const given = feature ? provider.handles(feature, ctx) : (provider.globalHandles?.(ctx) ?? []);
    return takenHandles(given, label, warned);
  };
  /**
   * The patch of a position of the pointer, asked with the feature the patches before it leave,
   * as the Store takes it: the keys of the library in `properties` become its fields. A patch the
   * library cannot take is left out, and told in the console once.
   */
  const drag = (event: DragNormalizedEvent): StorePatch | null => {
    if (!active) return null;
    const feature = active.featureId ? deps.shapes.get(active.featureId) : undefined;
    const patch = provider.onHandleDrag(
      featureForExtensionOrNull(feature),
      active.handle,
      toPointerEvent(event),
    );
    if (!feature || deps.store.isReadOnly() || patch === null) return null;
    try {
      return storedPatchOf(patch, feature);
    } catch (error) {
      const reason = `a patch the library cannot take (${(error as Error).message})`;
      if (!warned.has(reason)) {
        warned.add(reason);
        console.warn(`The ${label} gave ${reason}, which is left out`);
      }
      return null;
    }
  };
  const contextOf = createFrameContexts(deps, () => deps.customLayer.getGL());
  const draw = provider.drawHandles?.bind(provider);
  return {
    id: provider.name,
    getHandles: (feature) => handlesOf(featureForExtension(feature)).map(toEngineHandle),
    ...(provider.globalHandles && {
      getGlobalHandles: () => handlesOf(null).map(toEngineHandle),
    }),
    ...(draw && {
      drawHandles(feature, handles, projectionData, zoom, frame) {
        const shown = handles.flatMap((handle) => toCustomHandle(handle) ?? []);
        const ctx = contextOf(frame, projectionData, zoom);
        if (shown.length === 0 || !ctx) return;
        draw(featureForExtensionOrNull(feature), shown, ctx);
      },
    }),
    onHandleDragStart(hit, event) {
      const feature = hit.global ? null : deps.store.getFeature(hit.featureId);
      if (feature === undefined) return false;
      const handle = handlesOf(featureForExtensionOrNull(feature)).find(
        (h) => h.id === hit.handleId,
      );
      if (!handle) return false;
      if (provider.onHandleDragStart) {
        const accepted = provider.onHandleDragStart(
          featureForExtensionOrNull(feature),
          handle,
          toPointerEvent(event),
        );
        if (accepted === false) return false;
      }
      active = { featureId: hit.featureId, handle };
      return true;
    },
    onHandleDragMove: drag,
    onHandleDragRelease: drag,
    onHandleDragEnd(event) {
      const ended = active;
      active = null;
      if (ended && provider.onHandleDragEnd) {
        const feature = ended.featureId ? deps.store.getFeature(ended.featureId) : undefined;
        provider.onHandleDragEnd(
          featureForExtensionOrNull(feature),
          ended.handle,
          toPointerEvent(event),
        );
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
    has: (feature) => provider.has(featureForExtension(feature)),
    // The same answer, from a row of a layer held as rows
    ...(provider.rows && {
      hasRow: (view: LayerTableView, handle: number) => provider.rows?.has(view, handle) === true,
    }),
    // The keys the answers read, as they are when it is added
    ...(provider.rows?.classifyKeys && { classifyKeys: [...provider.rows.classifyKeys] }),
    draw(feature, projectionData, zoom, context) {
      drawCompanion(draw, feature, projectionData, zoom, context);
    },
    hitTest(feature, point, context) {
      const hit = provider.hitTest(featureForExtension(feature), {
        point: toScreenPoint(point),
        lngLat: toPosition(context.unproject(point)),
        tolerancePx: context.tolerancePx,
        screen: deps.screen,
        ...hitExclusion(deps.shapes),
      });
      if (!hit) return null;
      // The hit the library gives out, filled in from what the provider answered
      const contractHit: Hit = {
        kind: 'companion',
        id: hit.id,
        featureId: feature.id,
        distancePx: hit.distancePx,
      };
      return { id: hit.id, contractHit } as { id: string; contractHit: Hit };
    },
    onCompanionClick(featureId, hit, event?: unknown) {
      const feature = deps.store.getFeature(featureId);
      const own = (hit as { contractHit?: Hit }).contractHit;
      if (!feature || !own || !provider.onClick || !event) return false;
      const handled = provider.onClick(
        featureForExtension(feature),
        own,
        toPointerEvent(event as DragNormalizedEvent),
      );
      return handled === true;
    },
  };
}
