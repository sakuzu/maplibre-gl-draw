// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Manager of the datasets
 *
 * It holds the addition and removal of the datasets and the reference point for the rendering
 * loop and the hit testing. It does not depend on the map itself and receives getting the
 * displayed range, subscribing to its changes and requesting a repaint as functions (so it can be
 * run from a test without a map).
 */

import type { ProjectionData } from 'maplibre-gl';
import type { FeatureStyleConfig } from '../shared/config/feature-style.js';
import type { BoundingBox, Coordinate, Feature } from '../shared/types/model.js';
import type { PixelRatioInput } from '../shared/utils/pixel-ratio.js';
import type { DisplayBatchTarget, DisplayHitTestFn } from './dataset.js';
import { DatasetImpl } from './dataset.js';
import type { TriangulationScheduler } from './triangulation.js';
import type { Dataset, DatasetOptions, DatasetOrder, DatasetPlacement } from './types.js';

/**
 * Default debounce time of the provider (ms)
 *
 * @internal
 */
export const DEFAULT_PROVIDER_DEBOUNCE_MS = 200;

/**
 * Dependencies of the manager
 *
 * @internal
 */
export interface DatasetManagerDeps {
  /** Returns the bbox of the displayed range (the same expanded viewport as the render loop) */
  getViewportBounds(): BoundingBox;
  /** The current zoom */
  getZoom(): number;
  /**
   * The shallowest effective zoom on screen (with the pitch correction; the same as getZoom when
   * omitted)
   *
   * Only the band of the collision thinning looks at it, because with a pitch the higher part of
   * the screen is farther away and only there the effective scale gets shallower
   * (`effectiveZoomForCamera` in `display/thinning.ts`).
   */
  getEffectiveZoom?(): number;
  /**
   * Subscribes to the changes of the displayed range (the equivalent of moveend)
   *
   * A change of the pitch (pitchend) is also routed here. When the effective zoom changes, the
   * band of the thinning has to follow it.
   *
   * @returns A function that cancels the subscription
   */
  onViewportChange(handler: () => void): () => void;
  /** Requests a repaint */
  requestRepaint(): void;
  /** Debounce time of the provider (ms). 200 by default */
  providerDebounceMs?: number;
  /**
   * Rendering pixel ratio (when omitted, `window.devicePixelRatio` is read every time)
   *
   * The `pixelRatioSource.resolve` of Context (an injected value, or window × the render scale)
   * is passed in. A number can also be passed directly.
   */
  pixelRatio?: PixelRatioInput;
  /**
   * The scheduler of the triangulation of huge polygons (the global one when omitted)
   *
   * The budget is one for the whole map, so the default is normally used as it is. It can be
   * injected so that a test can replace the clock and the launching of the slices.
   */
  triangulationScheduler?: TriangulationScheduler;
  /**
   * Default style of the features (the default of core when omitted)
   *
   * The collision thinning reads the default of a point to know "the size actually drawn".
   */
  featureStyle?: FeatureStyleConfig;
  /**
   * Called once a dataset has been added, when `get` and `list` already return it
   *
   * The source of the `dataset.add` event.
   */
  onDatasetAdd?(id: string): void;
  /**
   * Called once a dataset has been removed (by `remove` or by the `remove` of the dataset
   * itself), when `get` and `list` no longer return it
   *
   * The source of the `dataset.remove` event. `destroy` does not call it.
   */
  onDatasetRemove?(id: string): void;
  /**
   * Called when `move` changed the order of the datasets or the side of one, with the ids
   * in display order (from the back to the front, the same as `list`)
   *
   * The source of the `dataset.reorder` event. A move that leaves everything where it was
   * does not call it.
   */
  onDatasetsReorder?(order: string[]): void;
}

/**
 * Result of the hit testing
 *
 * feature is null for the case "it blocks, but it does not fire an event" (a dataset with
 * interactive: false). Even with null, the caller still "stops the scan there".
 *
 * @internal
 */
export interface DisplayHitResult {
  dataset: DatasetImpl;
  feature: Feature | null;
  /** The row of the feature (null together with feature) */
  row: number | null;
}

/**
 * Manager of the datasets
 *
 * @internal
 */
export class DatasetManager {
  /** Index by id. The order is held by ordered */
  private datasets = new Map<string, DatasetImpl>();
  /**
   * The datasets in display order (from the back to the front)
   *
   * They are ordered as the below-store group, the layer-order group and the above-store group.
   * Within each side, the later in the array, the more in front. The rendering, the hit testing
   * and the listing all look only at this single sequence.
   *
   * Only the layer-order group is an exception: the order of this array does not decide their
   * stacking order (the truth of the order is the stacking order of the Store,
   * `getLayerOrder()`, alone).
   */
  private ordered: DatasetImpl[] = [];
  private deps: DatasetManagerDeps;
  private unsubscribeViewport: (() => void) | null = null;
  private providerDebounceMs: number;
  /** Set by destroy: nothing can be added afterwards (it would never be disposed) */
  private destroyed = false;

  constructor(deps: DatasetManagerDeps) {
    this.deps = deps;
    this.providerDebounceMs = deps.providerDebounceMs ?? DEFAULT_PROVIDER_DEBOUNCE_MS;
  }

  /**
   * Adds a dataset
   *
   * @throws after destroy (the dataset, its provider and its timers would never be
   *   released)
   */
  add(options: DatasetOptions): Dataset {
    if (this.destroyed) {
      throw new Error('Cannot add a dataset to a destroyed draw instance');
    }
    if (this.datasets.has(options.id)) {
      throw new Error(`Dataset "${options.id}" already exists`);
    }

    const dataset = new DatasetImpl(options, {
      requestRepaint: () => this.deps.requestRepaint(),
      providerDebounceMs: this.providerDebounceMs,
      pixelRatio: this.deps.pixelRatio,
      triangulationScheduler: this.deps.triangulationScheduler,
      pointStyle: this.deps.featureStyle?.point.point,
      onViewportSubscriptionChange: () => this.syncViewportSubscription(),
      getZoom: () => this.deps.getZoom(),
      getViewportState: () => {
        const zoom = this.deps.getZoom();
        return {
          bounds: this.deps.getViewportBounds(),
          zoom,
          effectiveZoom: this.deps.getEffectiveZoom?.() ?? zoom,
        };
      },
      onRemove: (id) => {
        this.datasets.delete(id);
        const at = this.ordered.findIndex((c) => c.id === id);
        if (at >= 0) this.ordered.splice(at, 1);
        this.syncViewportSubscription();
        this.deps.onDatasetRemove?.(id);
      },
    });

    this.datasets.set(options.id, dataset);
    // What is added goes to the front of its own side
    this.ordered.splice(this.sideEnd(dataset.order), 0, dataset);
    this.syncViewportSubscription();

    if (dataset.hasProvider) {
      // The first time is fetched through the same path as a change of the displayed range (the
      // debounce)
      dataset.scheduleProviderUpdate(this.deps.getViewportBounds(), this.deps.getZoom());
    }
    this.deps.requestRepaint();
    this.deps.onDatasetAdd?.(options.id);

    return dataset;
  }

  /**
   * Gets a dataset
   */
  get(id: string): Dataset | undefined {
    return this.datasets.get(id);
  }

  /**
   * Gets the internal implementation of a dataset
   *
   * It is used by the internal paths (the interception of the hit testing) that perform
   * operations not exposed on the public interface, such as firing an event.
   */
  getInternal(id: string): DatasetImpl | undefined {
    return this.datasets.get(id);
  }

  /**
   * Removes a dataset
   *
   * Even with order 'layer-order', the stacking order of the Store is not touched (the manager
   * does not know the Store). Taking the id off the order is the responsibility of the caller.
   * Even if it stays on the order, an id without a dataset is skipped by both the rendering
   * and the hit testing.
   *
   * @returns true when it was removed (false when it does not exist)
   */
  remove(id: string): boolean {
    const dataset = this.datasets.get(id);
    if (!dataset) return false;
    dataset.remove();
    return true;
  }

  /**
   * Reorders a dataset
   *
   * The side (in front of or behind the Store, or taking part in the stacking order) and the
   * position within that side can be changed. Only the order is moved; the visibility, the
   * retained batches held and the state of the provider are not touched at all (no GPU resource
   * is rebuilt).
   *
   * When it is moved to 'layer-order', the stacking order is decided by the stacking order of
   * the Store alone (index takes no part in it). Putting the id on the order is the
   * responsibility of the caller.
   *
   * @returns true when it was moved (false for an id that does not exist)
   */
  move(id: string, placement: DatasetPlacement): boolean {
    const dataset = this.datasets.get(id);
    if (!dataset) return false;

    const from = dataset.order;
    const to = placement.order ?? from;

    // Take it out of its current position first, then decide its position within the destination
    const at = this.ordered.indexOf(dataset);
    if (at >= 0) this.ordered.splice(at, 1);

    const start = this.sideStart(to);
    const length = this.sideEnd(to) - start;
    const index =
      placement.index === undefined ? (to === from ? at - start : length) : placement.index;

    const moved = start + clamp(index, 0, length);
    dataset.setOrder(to);
    this.ordered.splice(moved, 0, dataset);
    if (to === from && moved === at) return true;

    this.deps.requestRepaint();
    this.deps.onDatasetsReorder?.(this.ordered.map((c) => c.id));

    return true;
  }

  /**
   * The list of datasets in display order (from the back to the front)
   *
   * They are returned as the below-store group, the layer-order group and the above-store group.
   * The actual stacking order of a layer-order dataset is decided by the stacking order of the
   * Store, so it does not match the order of this list.
   */
  list(): Dataset[] {
    return [...this.ordered];
  }

  /**
   * The internal implementations of the datasets in display order (from the back to the front)
   *
   * The element supply of the analytic drape uses it. The truth of the stacking order is the
   * stacking order of the Store, so this list exists to pass on "the classification into sides"
   * and "the order within the same side".
   */
  listInternal(): DatasetImpl[] {
    return [...this.ordered];
  }

  /**
   * Reports the datasets that hand their polygons and lines to the analytic drape
   *
   * A dataset that handed them over does not push solid polygons and lines onto its retained
   * batch (so that the same thing is not drawn twice). Passing null makes every dataset draw
   * them itself as before.
   */
  setDrapedDatasets(ids: ReadonlySet<string> | null): void {
    for (const dataset of this.datasets.values()) {
      dataset.setDrapedFills(ids?.has(dataset.id) === true);
    }
  }

  /**
   * Whether there is at least one dataset (the hidden ones are not counted)
   *
   * The interception of the hit testing and the unified z scan only work while this is true. It
   * is the short circuit that keeps a map without datasets from paying a cost on every
   * mousemove.
   */
  hasAny(): boolean {
    for (const dataset of this.datasets.values()) {
      if (dataset.visible) return true;
    }
    return false;
  }

  /**
   * Draws the datasets of the given side in display order (from the back to the front)
   *
   * The 'layer-order' side is not drawn on this path (it is drawn from `drawOne` at its position
   * within the stacking order).
   *
   * @param bounds The bbox of the expanded viewport that the rendering loop computed once.
   *   When omitted it is looked up from deps at the point it becomes necessary
   */
  draw(
    order: DatasetOrder,
    target: DisplayBatchTarget,
    projectionData: ProjectionData,
    zoom: number,
    bounds?: BoundingBox,
  ): void {
    if (this.ordered.length === 0) return;

    let resolved: BoundingBox | undefined = bounds;
    for (let i = this.sideStart(order); i < this.sideEnd(order); i++) {
      if (resolved === undefined) resolved = this.deps.getViewportBounds();
      this.ordered[i].draw(target, projectionData, zoom, resolved);
    }
  }

  /**
   * Draws a dataset as one entry of the stacking order
   *
   * Only a dataset whose order is 'layer-order' is drawn. Nothing happens for an id that does
   * not exist or for a dataset on another side (the rendering loop skips that entry).
   *
   * @returns true when it was a drawing target
   */
  drawOne(
    id: string,
    target: DisplayBatchTarget,
    projectionData: ProjectionData,
    zoom: number,
    bounds?: BoundingBox,
  ): boolean {
    const dataset = this.datasets.get(id);
    if (dataset?.order !== 'layer-order') return false;

    dataset.draw(target, projectionData, zoom, bounds ?? this.deps.getViewportBounds());
    return true;
  }

  /**
   * Returns the frontmost hit of the given side
   *
   * It looks through the side from the back (the front) onwards. A hidden dataset is skipped,
   * but a dataset that is not interactive is not skipped (everything visible blocks). A
   * dataset that cannot fire an event is returned with feature set to null.
   */
  hitTestSide(
    order: DatasetOrder,
    coordinate: Coordinate,
    toleranceLngLat: number,
    test: DisplayHitTestFn,
  ): DisplayHitResult | null {
    for (let i = this.sideEnd(order) - 1; i >= this.sideStart(order); i--) {
      const hit = this.hitTestDataset(this.ordered[i], coordinate, toleranceLngLat, test);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Returns the hit as one entry of the stacking order
   *
   * Only a dataset whose order is 'layer-order' is a target (an id that does not exist and a
   * dataset on another side give null).
   */
  hitTestEntry(
    id: string,
    coordinate: Coordinate,
    toleranceLngLat: number,
    test: DisplayHitTestFn,
  ): DisplayHitResult | null {
    const dataset = this.datasets.get(id);
    if (dataset?.order !== 'layer-order') return null;
    return this.hitTestDataset(dataset, coordinate, toleranceLngLat, test);
  }

  /**
   * Decides the hit of a single dataset
   */
  private hitTestDataset(
    dataset: DatasetImpl,
    coordinate: Coordinate,
    toleranceLngLat: number,
    test: DisplayHitTestFn,
  ): DisplayHitResult | null {
    if (!dataset.visible) return null;
    const hit = dataset.hitTestRow(coordinate, toleranceLngLat, test);
    if (!hit) return null;
    // It blocks even when it is not interactive, but it cannot fire an event, so this is null
    return dataset.interactive
      ? { dataset, feature: hit.feature, row: hit.row }
      : { dataset, feature: null, row: null };
  }

  /**
   * The index of the start of a side (the range within the display order)
   */
  private sideStart(order: DatasetOrder): number {
    if (order === 'below-store') return 0;
    const counts = this.sideCounts();
    return order === 'layer-order' ? counts.below : counts.below + counts.layerOrder;
  }

  /**
   * The index just past the end of a side
   */
  private sideEnd(order: DatasetOrder): number {
    if (order === 'above-store') return this.ordered.length;
    const counts = this.sideCounts();
    return order === 'below-store' ? counts.below : counts.below + counts.layerOrder;
  }

  /**
   * The number of datasets of the first 2 sides (used to compute the boundaries of the sides)
   */
  private sideCounts(): { below: number; layerOrder: number } {
    let below = 0;
    let layerOrder = 0;
    for (const dataset of this.ordered) {
      if (dataset.order === 'below-store') below++;
      else if (dataset.order === 'layer-order') layerOrder++;
    }
    return { below, layerOrder };
  }

  /**
   * Releases the retained-mode GPU resources of every dataset
   *
   * It is called when the rendering layer is disposed (the onRemove of CustomLayer). The
   * datasets themselves remain, so they are built again on the next draw once the layer is
   * recreated.
   */
  disposeRetained(): void {
    for (const dataset of this.datasets.values()) {
      dataset.disposeRetained();
    }
  }

  /**
   * Disposes every dataset
   */
  destroy(): void {
    this.destroyed = true;
    for (const dataset of [...this.datasets.values()]) {
      dataset.dispose();
    }
    this.datasets.clear();
    this.ordered = [];
    this.syncViewportSubscription();
  }

  /**
   * Rewires the subscription to the changes of the displayed range to whether any dataset
   * needs them
   *
   * The ones that need them are the datasets that have a provider and the datasets with
   * the collision thinning enabled (to follow the zoom band).
   */
  private syncViewportSubscription(): void {
    let needed = false;
    for (const dataset of this.datasets.values()) {
      if (dataset.needsViewportUpdates) {
        needed = true;
        break;
      }
    }

    if (needed && !this.unsubscribeViewport) {
      this.unsubscribeViewport = this.deps.onViewportChange(() => this.handleViewportChange());
    } else if (!needed && this.unsubscribeViewport) {
      this.unsubscribeViewport();
      this.unsubscribeViewport = null;
    }
  }

  /**
   * Schedules the call of the provider when the displayed range changed, and makes the band of
   * the thinning follow it
   *
   * While the camera moves, each dataset follows the band as it draws. This is the last check at
   * the end of the gesture (moveend / pitchend). The band is decided by the effective zoom (with
   * the pitch correction), so `refreshThinning` is called without an argument and the dataset
   * side takes it from the state of the viewport.
   */
  private handleViewportChange(): void {
    const bounds = this.deps.getViewportBounds();
    const zoom = this.deps.getZoom();
    for (const dataset of this.datasets.values()) {
      if (dataset.hasProvider) {
        dataset.scheduleProviderUpdate(bounds, zoom);
      }
      dataset.refreshThinning();
    }
  }
}

/**
 * Clamps a value into a range
 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * Creates a manager
 *
 * @internal
 */
export function createDatasetManager(deps: DatasetManagerDeps): DatasetManager {
  return new DatasetManager(deps);
}
