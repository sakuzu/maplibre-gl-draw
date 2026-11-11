// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hit testing with the unified z traversal
 *
 * What receives a click is the single frontmost thing among those that are visible. It
 * does not matter whether that is a feature of the Store (an editing target) or a
 * dataset (data). The shape that occludes is exactly what is seen (a
 * polygon occludes with its fill, holes let clicks through, and a line occludes with its
 * line width plus the tolerance radius); nothing is transparent to clicks.
 *
 * The traversal goes from the front in the following order.
 *
 * 1. The datasets on the above-store side (from the front side)
 * 2. The stacking order (`store.getLayerOrder()`) from the end = from the front. When an
 *    entry is a layer, the features of that layer are tested from the front, and when it
 *    is a dataset with order: 'layer-order', that dataset is tested. An ID that is
 *    neither is skipped
 * 3. The datasets on the below-store side (from the front side)
 *
 * The test uses only test() (a boolean) of each strategy, and distance() is not used to
 * arbitrate between entries. Visibility is decided by visible / the local hidden state /
 * the visible flag of the layer and the group, and the result of the viewport thinning is
 * not used (thinning in the rendering is an optimization and takes no part in the
 * semantics of the test).
 *
 * A dataset with interactive: false also occludes hits. In that case feature is null
 * and neither click nor hover is fired.
 *
 * A layer the Store holds as rows of columns (`store.tables`) is tested on its rows
 * (`feature-table/hit-test.ts`), read in place: a row hit is returned as it is, as a row
 * (`kind: 'row'`), and no feature of the Store is made for it. A caller that needs the feature of
 * the row it hits (a click selects it, a drag moves it) asks for it (`asFeature`): the feature of
 * the row is made then, as the Store gives it (`kind: 'store'`, kept by the version of the row).
 *
 * When the features of a layer are examined, the companions of a feature
 * (view/feature-companion) are asked right after the test of the feature itself fails and
 * before moving on to the next (one step further back) feature. A companion is drawn one z
 * below its feature, so the order in which things are seen matches the order in which they
 * can be grabbed. The rows of a layer held as rows are examined in the same order, from the
 * front: each row itself, then its companions, asked only of the rows the drawing gives
 * companions, which are kept by the layer (`companion-rows.ts`), so a hit does not cost the rows
 * of the layer. When no provider at all is registered, this detour never happens.
 */

import type { RowGroup, RowTable } from '@sakuzu/kasane/engine';
import type { DisplayHitTestFn } from '../../dataset/dataset.js';
import type { DatasetManager } from '../../dataset/manager.js';
import type { Dataset } from '../../dataset/types.js';
import { STATE_UNHIT_MASK } from '../../feature-table/feature-row-states.js';
import type { FeatureTablesInternals } from '../../feature-table/feature-tables.js';
import {
  hitTestLayerTable,
  type TableRowHit,
  type TableScreenHit,
} from '../../feature-table/hit-test.js';
import { rowFeatureToRead } from '../../feature-table/row-read.js';
import type { LngLat, ScreenPoint } from '../../shared/math/index.js';
import { wrapLongitude } from '../../shared/math/longitude.js';
import { RenderedShapes } from '../../sketches/rendered-shapes.js';
import type { Store } from '../../store/store.js';
import type { Coordinate, Feature, FeatureStyle, FeatureType, Layer } from '../../store/types.js';
import { isGroupLocked, ROW_FLAG_LOCKED } from '../../table/feature-row-columns.js';
import type {
  CompanionHitContext,
  FeatureCompanionHitResult,
  FeatureCompanionRegistry,
} from '../../view/feature-companion.js';
import { hitTestFeatureCompanions } from '../../view/feature-companion.js';
import { getStyleRuleChannel } from '../../view/style-rule.js';
import { companionRowsInFront, companionRowsOf } from './companion-rows.js';
import { clickCopies } from './local-frame.js';
import type { HitTestService, UnprojectFunction } from './service.js';
import { DEFAULT_HIT_TEST_OPTIONS } from './strategies/base.js';
import { createVisibilityLookup, type VisibilityLookup } from './visibility-lookup.js';

/**
 * What the frontmost hit at a screen position is: a feature of the Store, a
 * dataset, or something that accompanies a feature.
 *
 * - store: a feature of the Store. It is a target of selection and editing as before
 * - dataset: a dataset. When feature is null it means "it occludes, but
 *   it does not fire an event" (interactive: false)
 * - companion: something that accompanies a feature (view/feature-companion). It was hit
 *   right after the test of the feature itself failed, and the click is received by the
 *   provider (the selection state does not change)
 * - row: a row of a layer held as rows of columns. Nothing is made of it for the hit: the
 *   feature it was tested as is dropped after the hit is read
 */
export type TopHit =
  | { kind: 'store'; feature: Feature }
  | {
      kind: 'row';
      /** The layer of the row */
      layerId: string;
      /** The id of the row */
      id: string;
      /** The handle of the row */
      handle: number;
      /** Whether the row, its group or its layer is locked */
      locked: boolean;
      /** The distance of the hit from the point, in screen px (measured when asked) */
      distancePx(): number;
    }
  | {
      kind: 'dataset';
      dataset: Dataset;
      feature: Feature | null;
      /** The row of the feature in the dataset (null together with feature) */
      row: number | null;
    }
  | { kind: 'companion'; companion: FeatureCompanionHitResult };

/**
 * The options of a {@link HitTestTopmost} call.
 */
export interface TopmostHitTestOptions {
  /**
   * Whether a row held as columns that is hit is returned as the feature the Store makes of it
   * (`kind: 'store'`): only where the feature is needed (a click, a double click, a press that
   * drags). Without it a row is returned as a row, and nothing is made of it
   */
  asFeature?: boolean;
}

/**
 * Returns the single frontmost hit at a screen position, across the Store, the
 * datasets and the feature companions, in the same order as they are drawn.
 *
 * The position is in CSS px relative to the map container. It returns `null` when nothing is
 * hit.
 */
export type HitTestTopmost = (point: ScreenPoint, options?: TopmostHitTestOptions) => TopHit | null;

/**
 * The dependencies of the unified z traversal
 *
 * @internal
 */
export interface TopmostHitTestDeps {
  store: Store;
  /** The shapes as they are seen, which name what a hit reads (of the Store alone when omitted) */
  shapes?: RenderedShapes;
  /** The candidate narrowing and the precise test on the Store side */
  hitTestService: HitTestService;
  /** From screen coordinates to geographic coordinates */
  unproject: UnprojectFunction;
  /**
   * Converts the click tolerance (in pixels) into degrees of longitude at the click latitude,
   * independent of the bearing (toleranceDegrees in local-frame.ts)
   */
  toleranceLngLat(point: ScreenPoint): number;
  /** The datasets (when omitted, only the Store is traversed) */
  datasets?: DatasetManager;
  /**
   * Geographic coordinates -> screen px (passed to the context of the companion hits)
   *
   * When omitted, the companion hit (feature companion) test is not performed, because a
   * companion decides a hit by its appearance in screen px, so without a projection there
   * is no way to test it.
   */
  project?(lngLat: Coordinate): ScreenPoint;
  /** The current zoom level (passed to the context of the companion hits; when omitted the
   * companion hits are not performed) */
  getZoom?(): number;
  /** The click tolerance (in screen px; passed to the context of the companion hits) */
  clickTolerancePx?: number;
  /**
   * The providers of the companion rendering and the companion hits (those of this draw
   * instance)
   *
   * When omitted, the companion hit test is not performed.
   */
  companions?: FeatureCompanionRegistry;
  /**
   * How far the marker of a point of a style reaches from it (screen px), for the rows held as
   * columns: a point is hit anywhere on its marker. Only the click tolerance when omitted
   */
  pointMarkerReachPx?(style: FeatureStyle | undefined): number;
  /**
   * The anchor projection of the points (terrain aware), for the rows held as columns: their
   * points are drawn without a depth test, so they are hit where they are drawn on the screen,
   * as the points of the Store are (`AnchorScreenProjector` of the HitTestService). When
   * omitted, or while it answers null (no terrain), they are hit at the coordinate of the click
   */
  anchors?: TopmostAnchorProjector;
}

/**
 * The anchor projection the rows held as columns are hit with on the screen
 *
 * @internal
 */
export interface TopmostAnchorProjector {
  /**
   * Where the anchor of a position is drawn on the screen, with the elevation it is drawn at
   * (null when it is not usable, or behind the camera)
   */
  project(lng: number, lat: number): ScreenPoint | null;
  /**
   * The boxes that hold every position whose anchor is drawn within `reachPx` of a point of the
   * screen (`AnchorProjector.searchBoxes`); null when the projection is not usable
   */
  searchBoxes(point: ScreenPoint, reachPx: number, near: LngLat): number[] | null;
}

/**
 * Creates the hit tester of the unified z traversal
 *
 * @internal
 */
export function createTopmostHitTester(deps: TopmostHitTestDeps): HitTestTopmost {
  const { store, hitTestService, unproject, toleranceLngLat, datasets } = deps;
  const shapes = deps.shapes ?? new RenderedShapes(store);

  const test: DisplayHitTestFn = (feature, coordinate, tolerance) =>
    hitTestService.hitTestFeature(feature, coordinate, tolerance);

  /**
   * Builds the context of the companion hits (null unless the configuration can perform
   * the test)
   *
   * It is not built when no provider at all is registered, so the conventional traversal
   * changes neither in cost nor in path.
   */
  const companionContext = (point: ScreenPoint): CompanionHitContext | null => {
    if (!deps.companions?.any()) return null;

    const project = deps.project;
    const getZoom = deps.getZoom;
    if (!project || !getZoom) return null;

    return {
      point,
      project,
      unproject: (p: ScreenPoint): LngLat => {
        const { lng, lat } = unproject(p);
        return { lng, lat };
      },
      zoom: getZoom(),
      tolerancePx: deps.clickTolerancePx ?? DEFAULT_HIT_TEST_OPTIONS.clickTolerance,
    };
  };

  /**
   * Asks for a hit on the companions of one feature (a feature that is not visible is not
   * asked)
   */
  const companionOf = (
    feature: Feature,
    context: CompanionHitContext | null,
    visible: VisibilityLookup,
  ): TopHit | null => {
    if (!context) return null;
    if (!visible(feature)) return null;

    const companions = deps.companions;
    if (!companions) return null;
    const companion = hitTestFeatureCompanions(companions, feature, context);
    return companion ? { kind: 'companion', companion } : null;
  };

  /**
   * The rows a hit leaves out besides their state: the rows of a group hidden by this client, and
   * what the drag of this client edits (undefined when it leaves out none)
   */
  const rowsLeftOut = (
    tables: FeatureTablesInternals,
  ): ((group: RowGroup, row: number) => boolean) | undefined => {
    const hidden = store.listHidden();
    const dragged = shapes.hitRowsLeftOut();
    if (hidden.size === 0 && !dragged) return undefined;
    return (group, row) => {
      if (dragged?.(group.data.handles[row] as number)) return true;
      if (hidden.size === 0) return false;
      const groupHandle = group.data.groups[row];
      const groupId = groupHandle >= 0 ? tables.groups.idOf(groupHandle) : undefined;
      return groupId !== undefined && hidden.has(groupId);
    };
  };

  /**
   * The frontmost row of a layer held as rows hit at the click, with the copy of the click it
   * was hit at (null when none is)
   */
  const frontRowOf = (
    tables: FeatureTablesInternals,
    table: RowTable,
    copies: readonly Coordinate[],
    tolerance: number,
    skip: ((group: RowGroup, row: number) => boolean) | undefined,
    onScreen: TableScreenHit | undefined,
  ): { hit: TableRowHit; coordinate: Coordinate } | null => {
    // A point is hit anywhere on its marker: the candidates are looked for as far as the
    // largest marker of the styles of the rows reaches
    const degreesPerPixel = 360 / (512 * 2 ** (deps.getZoom?.() ?? 0));
    const toleranceOf = (type: FeatureType, style: FeatureStyle): number =>
      getStyleRuleChannel(type) === 'point' && deps.pointMarkerReachPx
        ? Math.max(tolerance, deps.pointMarkerReachPx(style) * degreesPerPixel)
        : tolerance;
    // A type that registered an extra reach (a picture around a point) is looked for as far, its
    // pixels measured as the features are (from the tolerance of the click)
    const extraReach = hitTestService.maxCandidateReachPx?.() ?? 0;
    const clickPx = deps.clickTolerancePx ?? DEFAULT_HIT_TEST_OPTIONS.clickTolerance;
    const pixel = clickPx > 0 ? tolerance / clickPx : degreesPerPixel;
    const reach = Math.max(
      tolerance,
      maxMarkerReach(tables, deps) * degreesPerPixel,
      tolerance + extraReach * pixel,
    );
    for (const coordinate of copies) {
      const hit = hitTestLayerTable(tables, table, {
        coordinate,
        reach,
        toleranceOf,
        testShape: (type, shape, at, within) =>
          hitTestService.hitTestShape?.(type, shape, at, within) ?? null,
        test,
        // A row of a group hidden by this client is not hit
        skip,
        onScreen,
      });
      if (hit) return { hit, coordinate };
    }
    return null;
  };

  /**
   * How the points of the rows are hit on the screen at a click (undefined where they are hit at
   * the coordinate: without the anchor projection, or without terrain)
   */
  const screenHitOf = (
    tables: FeatureTablesInternals,
    point: ScreenPoint,
    near: LngLat,
  ): TableScreenHit | undefined => {
    const anchors = deps.anchors;
    if (!anchors) return undefined;
    const clickPx = deps.clickTolerancePx ?? DEFAULT_HIT_TEST_OPTIONS.clickTolerance;
    const markerReach = deps.pointMarkerReachPx;
    // As far as at the coordinate: the tolerance of the click, or the marker where it is larger
    const reachPx = (style: FeatureStyle): number =>
      markerReach ? Math.max(clickPx, markerReach(style)) : clickPx;
    const boxes = anchors.searchBoxes(point, Math.max(clickPx, maxMarkerReach(tables, deps)), near);
    if (!boxes) return undefined;
    return {
      boxes: storedCopiesOfBoxes(boxes),
      distancePx: (lng, lat) => {
        const at = anchors.project(lng, lat);
        return at ? Math.hypot(at.x - point.x, at.y - point.y) : null;
      },
      reachPx,
    };
  };

  /**
   * What a row hit is: a row, or the feature the Store makes of it (when `asFeature`)
   */
  const rowHitOf = (
    tables: FeatureTablesInternals,
    table: RowTable,
    layer: Layer,
    found: { hit: TableRowHit; coordinate: Coordinate },
    point: ScreenPoint,
    asFeature: boolean,
  ): TopHit => {
    const { hit, coordinate } = found;
    const data = hit.group.data;
    const handle = data.handles[hit.row];
    const id = tables.ids.idOf(handle) as string;
    if (asFeature) {
      const feature = tables.featureCache.featureOf(table.tableId, hit.group, hit.row);
      return { kind: 'store', feature };
    }
    const groupHandle = data.groups[hit.row];
    const locked =
      (data.flags[hit.row] & ROW_FLAG_LOCKED) !== 0 ||
      (groupHandle >= 0 && isGroupLocked(tables.groups, groupHandle)) ||
      layer.locked === true;
    const distancePx = (): number => {
      // A point hit on the screen is measured there
      if (hit.screenDistancePx !== undefined) return hit.screenDistancePx;
      const distance = hit.shape
        ? (hitTestService.distanceOfShape?.(hit.type, hit.shape, coordinate, hit.tolerance) ?? 0)
        : (hitTestService.hitTestAll(point, unproject, [hit.feature as Feature])[0]?.distance ?? 0);
      const onePixel = Math.abs(
        unproject({ x: point.x + 1, y: point.y }).lng - unproject(point).lng,
      );
      return onePixel > 0 ? distance / onePixel : 0;
    };
    return { kind: 'row', layerId: table.tableId, id, handle, locked, distancePx };
  };

  /**
   * The frontmost hit among the rows of a layer held as rows and their companions (null when
   * none is, or when the layer is hidden)
   *
   * The rows are examined from the front as the features of a layer are: each row itself, then
   * its companions. Only the rows hit can be hit themselves, so the frontmost row hit is found
   * first, and the rows with companions in front of it are asked for their companions, from the
   * front, before it. The rows with companions are kept by the layer (`companionRowsOf`), so a
   * hit costs them and not the rows of the layer; their feature is made to read, as the drawing
   * makes it, only when they are asked. Without a provider of companions, only the frontmost row
   * hit is looked for.
   */
  const rowsOf = (
    tables: FeatureTablesInternals,
    table: RowTable,
    point: ScreenPoint,
    copies: readonly Coordinate[],
    tolerance: number,
    asFeature: boolean,
    context: CompanionHitContext | null,
    visible: VisibilityLookup,
    onScreen: TableScreenHit | undefined,
  ): TopHit | null => {
    const layer = store.getLayer(table.tableId);
    if (!layer || layer.visible === false || store.isHidden(table.tableId)) return null;
    const skip = rowsLeftOut(tables);
    const front = frontRowOf(tables, table, copies, tolerance, skip, onScreen);
    const rowHit = (): TopHit | null =>
      front ? rowHitOf(tables, table, layer, front, point, asFeature) : null;
    const companions = deps.companions;
    if (!context || !companions) return rowHit();

    const withCompanions = companionRowsOf(tables, table, companions);
    if (withCompanions.rows.length === 0) return rowHit();
    const inFront = front
      ? companionRowsInFront(table, withCompanions, front.hit.group, front.hit.row)
      : withCompanions;
    for (let i = inFront.rows.length - 1; i >= 0; i--) {
      const group = inFront.groups[i];
      const row = inFront.rows[i];
      // A row that is not hit has no companion hit either
      if ((group.state[row] & STATE_UNHIT_MASK) !== 0 || skip?.(group, row)) continue;
      const feature = rowFeatureToRead(tables.readContext, table.tableId, group, row);
      const companionHit = companionOf(feature, context, visible);
      if (companionHit) return companionHit;
    }
    return rowHit();
  };

  return (point, options) => {
    const orderedFeatures = shapes.hitFeatures();
    const companion = companionContext(point);
    // Within one hit test, the visibility of a layer or a group is looked up only once per
    // container.
    const visible = createVisibilityLookup(store);
    const tables = shapes.hitRows();

    // On a map with no dataset at all (none is visible) and no layer held as rows, the cost is
    // kept the same as the conventional path. The spatial index is queried only once as well.
    if (!datasets?.hasAny() && !tables) {
      if (!companion) {
        const hit = hitTestService.hitTest(point, unproject, orderedFeatures);
        return hit ? { kind: 'store', feature: hit.feature } : null;
      }

      // A companion sits one z below the feature itself, so the features are examined one
      // at a time from the front in the order "the feature itself -> its companions". The
      // spatial index is queried only once.
      const storeHits = new Set(
        hitTestService.hitTestAll(point, unproject, orderedFeatures).map((r) => r.feature.id),
      );
      for (let i = orderedFeatures.length - 1; i >= 0; i--) {
        const feature = orderedFeatures[i];
        if (storeHits.has(feature.id)) return { kind: 'store', feature };

        const companionHit = companionOf(feature, companion, visible);
        if (companionHit) return companionHit;
      }
      return null;
    }

    const lngLat = unproject(point);
    const tolerance = toleranceLngLat(point);
    // The click on each copy of the world it can reach (the stored copy first; local-frame.ts)
    const copies = clickCopies([lngLat.lng, lngLat.lat], tolerance);
    const onCopies = <T>(hitOn: (coordinate: Coordinate) => T | null): T | null => {
      for (const copy of copies) {
        const hit = hitOn(copy);
        if (hit) return hit;
      }
      return null;
    };

    // 1. The above-store side
    const above = onCopies(
      (copy) => datasets?.hitTestSide('above-store', copy, tolerance, test) ?? null,
    );
    if (above) return toTopHit(above);

    // 2. The stacking order from the front. One hit test per frame is enough on the Store
    //    side, so it is performed only once, at the moment a layer entry is first met.
    let storeHits: Set<string> | undefined;
    let byLayer: Map<string, Feature[]> | undefined;
    // How the points of the rows are hit on the screen, worked out at the first layer of rows
    let onScreen: TableScreenHit | undefined | null = null;
    const layerOrder = store.getLayerOrder();

    for (let i = layerOrder.length - 1; i >= 0; i--) {
      const entryId = layerOrder[i];

      // A layer held as rows is tested on its rows: each row itself, then its companions
      const table = tables?.rowTable(entryId);
      if (tables && table) {
        if (onScreen === null) onScreen = screenHitOf(tables, point, lngLat);
        const hit = rowsOf(
          tables,
          table,
          point,
          copies,
          tolerance,
          options?.asFeature === true,
          companion,
          visible,
          onScreen,
        );
        if (hit) return hit;
        continue;
      }

      if (store.getLayer(entryId) !== undefined) {
        if (!storeHits) {
          storeHits = new Set(
            hitTestService
              .hitTestAll(point, unproject, orderedFeatures)
              .map((result) => result.feature.id),
          );
          byLayer = groupByLayer(orderedFeatures);
        }
        // Even when not a single feature itself was hit, a companion can still be hit
        if (storeHits.size === 0 && !companion) continue;

        const features = byLayer?.get(entryId);
        if (!features) continue;
        for (let j = features.length - 1; j >= 0; j--) {
          const feature = features[j];
          if (storeHits.has(feature.id)) return { kind: 'store', feature };

          const companionHit = companionOf(feature, companion, visible);
          if (companionHit) return companionHit;
        }
        continue;
      }

      const entry = onCopies(
        (copy) => datasets?.hitTestEntry(entryId, copy, tolerance, test) ?? null,
      );
      if (entry) return toTopHit(entry);
    }

    // 3. The below-store side
    const below = onCopies(
      (copy) => datasets?.hitTestSide('below-store', copy, tolerance, test) ?? null,
    );
    return below ? toTopHit(below) : null;
  };
}

/** The reach of the largest marker among the styles of the rows (screen px), by table */
const MARKER_REACH = new WeakMap<FeatureTablesInternals, { revision: number; reach: number }>();

/**
 * The reach of the largest marker of the points of the rows (screen px): the largest reach of
 * the styles the table holds (a number taken back holds none), kept until a number is given to a
 * style again
 */
function maxMarkerReach(
  tables: FeatureTablesInternals,
  deps: Pick<TopmostHitTestDeps, 'pointMarkerReachPx'>,
): number {
  const reachOf = deps.pointMarkerReachPx;
  if (!reachOf) return 0;
  const styles = tables.styles;
  const known = MARKER_REACH.get(tables);
  if (known && known.revision === styles.revision) return known.reach;
  let reach = 0;
  for (let id = 0; id < styles.capacity; id++) {
    if (styles.has(id)) reach = Math.max(reach, reachOf(styles.get(id)));
  }
  MARKER_REACH.set(tables, { revision: styles.revision, reach });
  return reach;
}

/**
 * Boxes on the copy of the world drawn, brought onto the copies the rows are stored on
 * (longitudes in [-180, 180]): each box moved by whole turns until its middle is in that range,
 * and given again on the neighbouring copy where it runs past ±180 (as `clickCopies` does with a
 * click)
 */
function storedCopiesOfBoxes(boxes: readonly number[]): number[] {
  const out: number[] = [];
  for (let at = 0; at + 3 < boxes.length; at += 4) {
    const middle = (boxes[at] + boxes[at + 2]) / 2;
    const shift = wrapLongitude(middle) - middle;
    const minX = boxes[at] + shift;
    const maxX = boxes[at + 2] + shift;
    const minY = boxes[at + 1];
    const maxY = boxes[at + 3];
    out.push(minX, minY, maxX, maxY);
    if (maxX > 180) out.push(minX - 360, minY, maxX - 360, maxY);
    if (minX < -180) out.push(minX + 360, minY, maxX + 360, maxY);
  }
  return out;
}

/**
 * Converts a dataset hit into a TopHit
 */
function toTopHit(hit: { dataset: Dataset; feature: Feature | null; row: number | null }): TopHit {
  return { kind: 'dataset', dataset: hit.dataset, feature: hit.feature, row: hit.row };
}

/**
 * Splits the features in display order per layer (the order is preserved)
 */
function groupByLayer(orderedFeatures: Feature[]): Map<string, Feature[]> {
  const byLayer = new Map<string, Feature[]>();
  for (const feature of orderedFeatures) {
    const features = byLayer.get(feature.layerId);
    if (features) features.push(feature);
    else byLayer.set(feature.layerId, [feature]);
  }
  return byLayer;
}
