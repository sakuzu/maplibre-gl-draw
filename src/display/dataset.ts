// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Implementation of a dataset
 *
 * It holds large numbers of features independently of the Store and feeds them to the existing
 * batched rendering (SDFPolygon / SDFLine / PointInstance). It does not go through the mechanisms
 * of editing, undo or events.
 *
 * This class is the thin surface that ties the parts of a dataset together and holds its
 * public API, its events and its contents (a `DisplaySource`: the rows, their chunks and their
 * spatial index; and the selection). The contents are read only through that contract, whatever
 * form they were given in (an array of features, or a columnar table). The work is done by the
 * parts:
 *
 * - `source.ts` (`FeatureArraySource`) and `columnar/source.ts` (`ColumnarSource`): the contents
 * - `chunk-set.ts`: the retained chunks (building, drawing and invalidation)
 * - `provider.ts` (`DisplayProviderLoader`): the loading and the updates through a provider
 * - `thinning.ts` (`CollisionThinningState`): the collision thinning
 * - `selection.ts`: the selection highlight and the hit testing
 * - `style.ts` (`DisplayFeatureStyler`): the rule colors and the base style
 *
 * In an environment where the retained-mode renderers are not available (a test without GL, for
 * example) it falls back to the immediate mode used before (narrowing one feature at a time with
 * the spatial index and feeding them to the batches). The hit testing path uses the spatial index
 * in retained mode as well.
 */

import type { ProjectionData } from 'maplibre-gl';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../shared/config/feature-style.js';
import type { BoundingBox, Coordinate, Feature, StyleRule } from '../shared/types/model.js';
import { sanitizeDrawFactors } from '../view/renderers/draw-factors.js';
import type { PointStyle } from '../view/renderers/point/point-shape.js';
import { TerrainContext } from '../view/terrain/context.js';
import { DisplayChunkSet } from './chunk-set.js';
import { ColumnarSource } from './columnar/source.js';
import type { DatasetColumnarInput, DatasetColumnarPrepared } from './columnar/types.js';
import { DisplayProviderLoader } from './provider.js';
import type { CollectOptions } from './retained.js';
import {
  type DisplayRowHit,
  drawSelectionHighlight,
  hitTestDisplayFeatures,
  sameFeatureIds,
} from './selection.js';
import { type DisplaySource, FeatureArraySource } from './source.js';
import { DisplayFeatureStyler } from './style.js';
import type {
  DatasetCollisionThinning,
  DatasetThinningStats,
  ResolvedCollisionThinning,
} from './thinning.js';
import { CollisionThinningState, pointMarkerRadiusPx } from './thinning.js';
import type {
  Dataset,
  DatasetBaseStyle,
  DatasetDeps,
  DatasetEventMap,
  DatasetFeatureInput,
  DatasetOptions,
  DatasetOrder,
  DatasetZoomScale,
  DisplayBatchTarget,
  DisplayHitTestFn,
} from './types.js';
import { normalizeDisplayFeature } from './types.js';

// The importers of these moved names keep their path (the definitions live in the parts)
export { needsRetessellation } from './chunk-set.js';
export type { DisplayBatchTarget, DisplayHitTestFn } from './types.js';

/**
 * Implementation of a dataset
 *
 * @internal
 */
export class DatasetImpl implements Dataset {
  readonly id: string;
  readonly interactive: boolean;

  /** The current side. It is rewritten by the reordering of the manager */
  private currentOrder: DatasetOrder;

  /** Whether it is shown. While it is false, neither rendering nor hit testing happens */
  private isVisible = true;

  /** The contents (the rows, their chunks and their spatial index) */
  private source: DisplaySource = new FeatureArraySource([]);
  private readonly styler: DisplayFeatureStyler;
  /** Zoom-dependent drawing factors (no factors when not set) */
  private zoomScale: DatasetZoomScale | null = null;

  /**
   * Whether the polygons and lines are handed to the analytic drape (decided per frame by the
   * rendering side)
   *
   * While they are handed over, the solid polygons and lines are not pushed onto the retained
   * batches. This is so that the same thing is not drawn twice and so that the whole cost of the
   * subdivision that matches the terrain mesh is skipped.
   */
  private drapedFills = false;
  /** The terrain used when the draw target provides none (inactive: draws flat) */
  private readonly flatTerrain = new TerrainContext();

  /**
   * The revision that triggers rebuilding the index of the drape
   *
   * It advances only when the contents, the style, the thinning or the visibility changed. It
   * does not advance on a zoom or on the view (if it did, the index would be rebuilt on every
   * pan).
   */
  private contentRevision = 0;
  /**
   * Revision number of the style
   *
   * The footprint of the thinning is decided by the style (the rule, the base style, the zoom
   * factors), so the winners are picked again once it advances. It is part of the cache key.
   */
  private styleRevision = 0;

  /** The retained chunks */
  private readonly chunks: DisplayChunkSet;
  /** The collision thinning */
  private readonly thinning: CollisionThinningState;
  /** The loading through the provider (null without a provider) */
  private readonly loader: DisplayProviderLoader | null;

  private listeners = new Map<keyof DatasetEventMap, Set<(payload: never) => void>>();

  /** The features of the selected rows (in draw order; only the ids that exist are held) */
  private selected: Feature[] = [];

  private removed = false;
  private readonly deps: DatasetDeps;

  /** Predicate that picks out the points drawn by an external renderer (null when not injected) */
  private externalPointRender: ((feature: Feature) => boolean) | null;

  /**
   * Whether it is a point drawn by an external renderer (core does not draw it)
   *
   * The three paths (retained, immediate, selection) look only at this one. Scattering the test
   * across each path would produce a disagreement such as "the circle comes back only when it is
   * selected" the moment one of them is forgotten. The line that puts `MultiPoint` out of scope
   * is also closed in here (when one feature has several points far apart, the unit to delegate
   * to the external renderer is undefined; it is the same line as the collision thinning).
   */
  private readonly isExternallyRenderedPoint = (feature: Feature): boolean =>
    feature.type === 'Point' && this.externalPointRender?.(feature) === true;

  constructor(options: DatasetOptions, deps: DatasetDeps) {
    const given = [options.features, options.columnar, options.provider].filter(
      (input) => input !== undefined,
    );
    if (given.length > 1) {
      throw new Error(
        `Dataset "${options.id}": only one of features, columnar and provider can be given`,
      );
    }
    if (options.prepared && !options.columnar) {
      throw new Error(`Dataset "${options.id}": prepared is given without columnar`);
    }

    this.id = options.id;
    this.currentOrder = options.order ?? 'below-store';
    this.interactive = options.interactive ?? false;
    this.styler = new DisplayFeatureStyler(options.styleRule, options.baseStyle);
    this.zoomScale = options.zoomScale ?? null;
    this.externalPointRender = options.externalPointRender ?? null;
    this.deps = deps;

    this.chunks = new DisplayChunkSet({
      collector: (rows, collect) => this.source.collector(rows, this.collectContext(collect)),
      // Not passed when it is not injected (the path without a predicate is as before)
      externalPointFilter: () =>
        this.externalPointRender ? this.isExternallyRenderedPoint : undefined,
      drapedFills: () => this.drapedFills,
      requestRepaint: () => this.deps.requestRepaint(),
      onInvalidateAll: () => {
        this.contentRevision++;
      },
      pixelRatio: deps.pixelRatio,
      triangulationScheduler: deps.triangulationScheduler,
    });
    this.thinning = new CollisionThinningState(
      {
        rows: () => this.source,
        featuresGeneration: () => this.chunks.generation,
        styleRevision: () => this.styleRevision,
        footprintPx: (band, marginPx) => {
          const defaults = this.pointDefaults();
          const scale = sanitizeDrawFactors(this.zoomScale?.(band)).scale;
          const baseStyle = this.styler.base;
          return (styleRadius) =>
            pointMarkerRadiusPx(styleRadius, baseStyle, defaults, scale) + marginPx;
        },
        viewport: () => this.deps.getViewportState(),
      },
      options.collisionThinning,
    );
    this.loader = options.provider
      ? new DisplayProviderLoader(options.provider, {
          id: this.id,
          debounceMs: deps.providerDebounceMs,
          apply: (features) => {
            this.applySource(new FeatureArraySource(features));
            this.deps.requestRepaint();
          },
        })
      : null;

    if (options.features) {
      this.setFeatures(options.features);
    } else if (options.columnar) {
      this.setColumnar(options.columnar, options.prepared);
    }
  }

  /** Draw order (the current side) */
  get order(): DatasetOrder {
    return this.currentOrder;
  }

  /** Whether it is shown */
  get visible(): boolean {
    return this.isVisible;
  }

  /** Whether it has a provider */
  get hasProvider(): boolean {
    return this.loader !== null;
  }

  /**
   * Whether it needs to know about the changes of the displayed range (moveend)
   *
   * The uses are calling the provider and following the zoom band of the collision thinning.
   */
  get needsViewportUpdates(): boolean {
    return this.loader !== null || this.thinning.enabled;
  }

  /** Whether it has been removed */
  get isRemoved(): boolean {
    return this.removed;
  }

  // === Public API ===

  setVisible(visible: boolean): void {
    if (this.isVisible === visible) return;
    this.isVisible = visible;
    this.contentRevision++;
    // The retained batches are not discarded, so showing it again draws at once without a rebuild
    this.emit('change', { reason: 'visibility' });
    this.deps.requestRepaint();
  }

  setFeatures(features: DatasetFeatureInput[]): void {
    this.applySource(new FeatureArraySource(features.map(normalizeDisplayFeature)));
    this.deps.requestRepaint();
  }

  setColumnar(input: DatasetColumnarInput, prepared?: DatasetColumnarPrepared): void {
    this.applySource(new ColumnarSource(input, prepared));
    this.deps.requestRepaint();
  }

  setStyleRule(rule: StyleRule | undefined): void {
    this.styler.setRule(rule);
    // The colors change, so the retained batches of every chunk are rebuilt
    this.restyle();
  }

  setBaseStyle(style: DatasetBaseStyle | undefined): void {
    this.styler.setBase(style);
    // The appearance changes, so the retained batches of every chunk are rebuilt
    this.restyle();
  }

  setExternalPointRender(predicate: ((feature: Feature) => boolean) | undefined): void {
    this.externalPointRender = predicate ?? null;
    // "Which points are not drawn" is baked into the retained batches, so as much is discarded as
    // in setStyleRule / setBaseStyle. Without discarding it, the picture of the external renderer
    // would be laid over the old circles that remain (or the points would stay gone even after
    // the predicate is removed)
    this.styler.clear();
    this.restyle();
  }

  setZoomScale(zoomScale: DatasetZoomScale | null): void {
    // The factors are only multiplied in at draw time, so the retained batches are untouched
    this.zoomScale = zoomScale;
    // The footprint of the thinning does change with the factors, so it is rebuilt if the winners
    // change
    if (this.markStyleChanged()) {
      this.chunks.invalidateAll();
      this.emit('change', { reason: 'thinning' });
    }
    this.deps.requestRepaint();
  }

  getZoomScale(): DatasetZoomScale | null {
    return this.zoomScale;
  }

  getBaseStyle(): DatasetBaseStyle | undefined {
    return this.styler.base;
  }

  getFeatures(): Feature[] {
    return this.source.features();
  }

  setSelectedIds(ids: string[]): void {
    // Keep the draw order and drop the ids that do not exist
    const rows = ids.length === 0 ? [] : this.source.rowsOfIds(new Set(ids));
    const next = rows.map((row) => this.source.featureAt(row));
    if (sameFeatureIds(this.selected, next)) return;

    this.selected = next;
    this.emit('change', { reason: 'selection' });
    this.deps.requestRepaint();
  }

  getSelectedIds(): string[] {
    return this.selected.map((feature) => feature.id);
  }

  setCollisionThinning(options: DatasetCollisionThinning | null): void {
    const result = this.thinning.setOptions(options);
    if (!result) return;

    // The retained batches are rebuilt only when what is drawn changed
    if (result.drawnChanged) this.thinningChanged();
    // Whether moveend has to be subscribed to may have changed
    this.deps.onViewportSubscriptionChange?.();
  }

  getCollisionThinning(): ResolvedCollisionThinning | null {
    return this.thinning.options;
  }

  getVisibleFeatureIds(): ReadonlySet<string> | null {
    return this.thinning.drawable;
  }

  getThinningStats(): DatasetThinningStats {
    return this.thinning.stats(this.source.length);
  }

  refreshThinning(zoom?: number): void {
    if (!this.thinning.enabled || this.removed) return;
    if (this.thinning.refresh(zoom)) this.thinningChanged();
  }

  invalidateProviderCache(): void {
    if (!this.loader || this.removed) return;

    const { bounds, zoom } = this.deps.getViewportState();
    this.loader.invalidate(bounds, zoom);
  }

  on<K extends keyof DatasetEventMap>(
    event: K,
    handler: (payload: DatasetEventMap[K]) => void,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => this.off(event, handler);
  }

  off<K extends keyof DatasetEventMap>(
    event: K,
    handler: (payload: DatasetEventMap[K]) => void,
  ): void {
    this.listeners.get(event)?.delete(handler as (payload: never) => void);
  }

  remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.dispose();
    this.deps.onRemove(this.id);
    this.deps.requestRepaint();
  }

  // === Internal API (called from the manager) ===

  /**
   * Rewrites the side (the path of the reordering)
   *
   * Only where it is drawn changes, so neither the retained batches, nor the visibility, nor the
   * state of the provider is touched. The repaint is requested by the manager.
   */
  setOrder(order: DatasetOrder): void {
    this.currentOrder = order;
  }

  /**
   * Fires an event
   *
   * click / hover are called only when interactive. change is called regardless of interactive
   * when the contents, the style or the visibility changed.
   */
  emit<K extends keyof DatasetEventMap>(event: K, payload: DatasetEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;

    // An exception in one handler is isolated so that it does not drag in the others or the
    // rendering path
    for (const handler of [...set]) {
      try {
        (handler as (p: DatasetEventMap[K]) => void)(payload);
      } catch (error) {
        console.error(`Error in Dataset "${this.id}" listener for "${event}":`, error);
      }
    }
  }

  // === Hand-off with the analytic drape ===

  /**
   * The revision that triggers rebuilding the index of the drape
   *
   * It advances only when the contents, the style, the thinning or the visibility changed.
   */
  get drapeRevision(): number {
    return this.contentRevision;
  }

  /**
   * The features handed to the analytic drape (with the thinning and the rule colors applied, in
   * draw order)
   *
   * They are not narrowed by the view. Narrowing them would change the order of the elements
   * whenever the view moves and force the tile index to be rebuilt (the narrowing is done with
   * the bounding box of each tile; `view/terrain/drape/binning.ts`).
   */
  drapeFeatures(): Feature[] {
    if (!this.isVisible) return [];
    this.ensureThinning(this.deps.getZoom());
    // The drape draws polygons and lines; a table of points has nothing for it (and its rows are
    // not built into features for nothing)
    if (this.source instanceof ColumnarSource) {
      const type = this.source.table.type;
      if (type === 'Point' || type === 'MultiPoint') return [];
    }
    // Without thinning every row is drawn (the features of a table are built once and kept)
    if (!this.thinning.active) return this.styler.prepareAll(this.source.features());
    const drawn: Feature[] = [];
    for (let row = 0; row < this.source.length; row++) {
      if (this.source.hasGeometry(row) && this.thinning.isDrawnRow(row)) {
        drawn.push(this.source.featureAt(row));
      }
    }
    return this.styler.prepareAll(drawn);
  }

  /**
   * Reports whether the polygons and lines are handed to the analytic drape (decided per frame by
   * the rendering side)
   *
   * A chunk whose way of handing over changed is re-baked the next time things settle. The
   * previous version keeps being drawn until then, so the picture never disappears at the switch.
   */
  setDrapedFills(draped: boolean): void {
    this.drapedFills = draped;
  }

  /**
   * Zoom-dependent drawing factors (passed to the uniforms of the analytic drape)
   *
   * They are the same values that the retained batch path passes to `drawChunkBatches`.
   */
  drapeFactors(zoom: number): { scale: number; opacity: number } {
    return sanitizeDrawFactors(this.zoomScale?.(zoom));
  }

  /**
   * Returns the features inside the viewport in draw order (with the rule colors and the base
   * style applied)
   */
  collectVisible(bounds: BoundingBox): Feature[] {
    return this.styler.prepareAll(this.featuresOf(this.source.index.search(bounds)));
  }

  /**
   * Whether the most recent draw left a chunk unbuilt
   *
   * It turns false at the first frame that leaves nothing unbuilt (a measurement reads it to know
   * when everything in view is drawn).
   */
  get hasPendingBuild(): boolean {
    return this.chunks.hasPendingBuild;
  }

  /**
   * Draws the chunks that intersect the viewport
   *
   * In retained mode it only draws the retained batches of the chunks that intersect (building
   * them the first time when necessary; `DisplayChunkSet.draw`). In an environment where the
   * retained-mode renderers are not available, features are narrowed one at a time with the
   * spatial index and fed to the batches, as before.
   *
   * Nothing happens while it is hidden. The retained batches are kept, so showing it again takes
   * effect without a build in between.
   *
   * The zoom-dependent factors are evaluated once per frame and the same values are passed to
   * every batch of that frame. At a zoom where the opacity becomes 0, the drawing itself is
   * skipped.
   */
  draw(
    target: DisplayBatchTarget,
    projectionData: ProjectionData,
    zoom: number,
    bounds: BoundingBox,
  ): void {
    if (!this.isVisible) return;

    const factors = sanitizeDrawFactors(this.zoomScale?.(zoom));
    // Completely transparent means there is nothing to draw (the immediate path is skipped too)
    if (factors.opacity <= 0) return;

    this.ensureThinning(zoom);

    // The terrain state of the draw instance this dataset is drawn into
    const terrain = target.getTerrain?.() ?? this.flatTerrain;
    const renderers = target.getRetainedRenderers?.();
    if (renderers) {
      this.chunks.draw({ target, renderers, terrain, projectionData, zoom, bounds, factors });
    } else {
      this.drawImmediate(target, projectionData, zoom, bounds);
    }

    drawSelectionHighlight({
      target,
      projectionData,
      zoom,
      bounds,
      selected: this.selected,
      styles: this.chunks.retainedRenderers?.styles,
      terrain,
      datasetId: this.id,
      drapedFills: this.drapedFills,
      prepare: (feature) => this.styler.prepareIfStyled(feature),
      isExternalPoint: this.isExternallyRenderedPoint,
    });
  }

  /**
   * Returns the frontmost hit (`hitTestDisplayFeatures`)
   *
   * While it is hidden it always misses (what is not visible cannot be grabbed).
   */
  hitTest(coordinate: Coordinate, toleranceLngLat: number, test: DisplayHitTestFn): Feature | null {
    return this.hitTestRow(coordinate, toleranceLngLat, test)?.feature ?? null;
  }

  /**
   * Returns the frontmost hit with its row (`hitTestDisplayFeatures`)
   *
   * The feature carries the rule colors and the base style. While it is hidden it always misses.
   */
  hitTestRow(
    coordinate: Coordinate,
    toleranceLngLat: number,
    test: DisplayHitTestFn,
  ): DisplayRowHit | null {
    if (!this.isVisible) return null;

    // The hit radius of a point changes with the zoom, so it is computed from the current zoom on
    // every test
    const zoom = this.deps.getZoom();
    const source = this.source;
    const hit = hitTestDisplayFeatures({
      coordinate,
      toleranceLngLat,
      test,
      zoom,
      scale: sanitizeDrawFactors(this.zoomScale?.(zoom)).scale,
      baseStyle: this.styler.base,
      pointDefaults: this.pointDefaults(),
      maxStylePointRadius: source.maxStylePointRadius,
      search: (bounds) => source.index.search(bounds),
      featureAt: (row) => source.featureAt(row),
      isDrawn: (row) => this.thinning.isDrawnRow(row),
    });
    return hit ? { feature: this.styler.prepareIfStyled(hit.feature), row: hit.row } : null;
  }

  /**
   * Schedules the call of the provider according to the changes of the displayed range
   *
   * The range is handled through a key rounded to a zoom stage plus tile coordinates. Nothing
   * happens when it equals the key already applied; when it is in the cache it is applied at
   * once; otherwise the call is debounced. While a fetch is in flight, the previous result keeps
   * being shown.
   */
  scheduleProviderUpdate(bounds: BoundingBox, zoom: number): void {
    if (!this.loader || this.removed) return;
    this.loader.schedule(bounds, zoom);
  }

  /**
   * Releases the resources (timers, index, subscriptions)
   *
   * After it is disposed, a response in flight is not applied either (the path called directly
   * from the destroy of the manager is treated the same way).
   */
  dispose(): void {
    this.removed = true;
    this.loader?.dispose();
    this.chunks.dispose();
    this.source = new FeatureArraySource([]);
    this.selected = [];
    this.thinning.clear();
    this.styler.clear();
    this.listeners.clear();
  }

  /**
   * Releases only the GPU resources of retained mode
   *
   * It is called when the rendering layer is disposed (onRemove). The dataset itself stays
   * alive and the chunks are built again on the next draw once the layer is recreated.
   */
  disposeRetained(): void {
    this.chunks.releaseRetained();
  }

  // === Internals ===

  /**
   * Default style of a point (the default of core when not injected)
   */
  private pointDefaults(): PointStyle {
    return this.deps.pointStyle ?? DEFAULT_FEATURE_STYLE_CONFIG.point.point;
  }

  /**
   * Draws in immediate mode (the path for an environment without the retained-mode renderers)
   *
   * The frame of the batch is started without passing a layer. The rules have already been
   * evaluated here, so the rule evaluation of the rendering side (FeatureDrawer) is not used.
   */
  private drawImmediate(
    target: DisplayBatchTarget,
    projectionData: ProjectionData,
    zoom: number,
    bounds: BoundingBox,
  ): void {
    const rows = this.source.index.search(bounds).filter((row) => this.thinning.isDrawnRow(row));
    let visible = this.styler.prepareAll(this.featuresOf(rows));
    // A point drawn by an external renderer is not drawn by core (without a predicate it passes
    // straight through)
    if (this.externalPointRender) {
      visible = visible.filter((feature) => !this.isExternallyRenderedPoint(feature));
    }
    if (visible.length === 0) return;

    target.beginFrame(projectionData, zoom);
    for (const feature of visible) {
      target.processFeature(feature, false);
    }
    target.endFrame();
  }

  /**
   * Applies new contents (the chunks, the index and the caches come with them)
   *
   * The only triggers for rebuilding the retained batches are this path (setFeatures,
   * setColumnar and applying a provider result) and setStyleRule / setBaseStyle.
   */
  private applySource(source: DisplaySource): void {
    this.source = source;
    this.styler.clear();

    // An id that disappeared in the replacement is dropped from the selection (an id that
    // remained points at the row of the new contents)
    if (this.selected.length > 0) {
      const selectedIds = new Set(this.selected.map((feature) => feature.id));
      this.selected = source.rowsOfIds(selectedIds).map((row) => source.featureAt(row));
    }

    this.chunks.replace(source.chunks);

    // The winners are picked again together with the replacement (it is done before emit so that
    // a host receiving change does not read the old set)
    this.thinning.onFeaturesReplaced();

    this.emit('change', { reason: 'features' });
  }

  /** The features of rows (without the rule colors) */
  private featuresOf(rows: readonly number[]): Feature[] {
    const features: Feature[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) features[i] = this.source.featureAt(rows[i]);
    return features;
  }

  /** What the source needs to collect the rows of a chunk */
  private collectContext(options: CollectOptions) {
    return {
      ...options,
      styler: this.styler,
      isDrawn: (row: number) => this.thinning.isDrawnRow(row),
      styleKey: this.styleRevision,
    };
  }

  /** The appearance changed: pick the winners again, rebuild every chunk and tell the listeners */
  private restyle(): void {
    this.markStyleChanged();
    this.chunks.invalidateAll();
    this.emit('change', { reason: 'style' });
    this.deps.requestRepaint();
  }

  /**
   * Records that the style changed and picks the winners again when necessary
   *
   * @returns Whether what is drawn actually changed
   */
  private markStyleChanged(): boolean {
    this.styleRevision++;
    return this.thinning.onStyleChanged();
  }

  /** What is drawn changed through the thinning: rebuild, tell the listeners and repaint */
  private thinningChanged(): void {
    this.chunks.invalidateAll();
    this.emit('change', { reason: 'thinning' });
    this.deps.requestRepaint();
  }

  /** Prepares the set of winners right before drawing (`CollisionThinningState.ensure`) */
  private ensureThinning(zoom: number): void {
    if (this.thinning.ensure(zoom)) this.chunks.invalidateAll();
  }
}
