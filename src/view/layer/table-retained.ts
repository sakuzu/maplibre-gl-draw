// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The drawing of the layers held as rows of columns (`TableLayerRenderer`)
 *
 * A layer held as rows is drawn in the order of its rows: its row groups in their order, and
 * the GPU chunks of a group (`table-partition.ts`) in theirs. A chunk is a run of rows of one
 * kind: polygons, lines and points are retained batches built from the columns
 * (`table-collect.ts`); the rows that cannot be retained (dashed lines, images, custom types,
 * features with companions, shapes that are not instanced) are drawn at once, from features made
 * from the rows and kept up to a number. A chunk outside the view is skipped, which keeps the
 * order since a chunk is a run of the order.
 *
 * The batches are built over the frames within a budget (`view/retained/chunk-scheduler.ts`),
 * and a chunk invalidated (a new rendering pixel ratio, a new style rule) keeps drawing its
 * batches until the new ones are built.
 *
 * The state of the rows (hidden, moving) is not in the batches: every row group has a texture
 * of one byte per row (`renderers/row-state.ts`), written from the copy of the state of the
 * group whenever it changes, and the variant of the programs reads it. A batch draws any range
 * of its rows in one draw, so a chunk can be drawn in parts with something in between, at the
 * cost of one more draw per cut.
 *
 * For tests and measurements it can record the ranges it draws in order (`recordDraws`) and cut
 * the ranges it draws at a number of places spread over the rows in view (`setArtificialCuts`).
 */

import type { ProjectionData } from 'maplibre-gl';
import type { FeatureTablesInternals } from '../../feature-table/feature-tables.js';
import type { LayerTable, RowGroup } from '../../feature-table/layer-table.js';
import { rowFeature } from '../../feature-table/row-read.js';
import {
  MOVE_SETS,
  STATE_HIDDEN_MASK,
  STATE_MOVE_MASK,
  STATE_MOVE_SHIFT,
} from '../../feature-table/row-state.js';
import type { RowGroupHandle } from '../../feature-table/types.js';
import type { BoundingBox, Coordinate, Feature, Layer } from '../../shared/types/model.js';
import type { PixelRatioInput } from '../../shared/utils/pixel-ratio.js';
import { resolvePixelRatio } from '../../shared/utils/pixel-ratio.js';
import type { FeatureCompanionRegistry } from '../feature-companion.js';
import type { GpuLedger } from '../gpu-ledger.js';
import { layerDrawFactors, type RetainedDrawFactors } from '../renderers/draw-factors.js';
import { ROW_LINE_STRIDE } from '../renderers/line/line-geometry.js';
import type { RetainedLineBatch } from '../renderers/line/line-types.js';
import { type RetainedPointBatch, ROW_POINT_STRIDE } from '../renderers/point/point-instance.js';
import { type RetainedPolygonBatch, ROW_POLYGON_STRIDE } from '../renderers/polygon/sdf-polygon.js';
import type { RetainedRendererSet } from '../renderers/retained.js';
import {
  createRowStateTexture,
  deleteRowStateTexture,
  type RowStateBinding,
  type RowStateTexture,
  uploadRowState,
} from '../renderers/row-state.js';
import {
  advanceChunkBuilds,
  type ChunkBuildBudget,
  type ChunkSchedulerHost,
  createChunkBuildBudget,
  invalidateChunk,
  type RetainedChunkJob,
  type RetainedChunkState,
} from '../retained/chunk-scheduler.js';
import type { TerrainContext } from '../terrain/context.js';
import { isTerrainCameraMoving } from '../terrain/state.js';
import type { RunKind } from './store-retained-classify.js';
import { drawImmediateFeatures, type StoreRetainedDrawDeps } from './store-retained-immediate.js';
import {
  createLineRowArrays,
  linePartsOf,
  lineRowsMercatorLength,
  type PolygonRowPlan,
  planPolygonRow,
  pointInstancesOf,
  type RowPackContext,
  RowStyleSlots,
  writeLineRow,
  writePointRow,
  writePolygonRow,
} from './table-collect.js';
import { classifyRow, type OrderedChunkRange, partitionRowGroup } from './table-partition.js';

/**
 * The time the builds of the batches of the rows may take in one frame (ms)
 *
 * The same as the budget of the chunks of a dataset. It is meant to be given by the one budget
 * of the frame shared by every build, once there is one.
 */
const TABLE_BUILD_BUDGET_MS = 12;

/**
 * The number of features made from rows that are kept for the chunks drawn at once
 *
 * Above it, the rows of a chunk are made into features when they are drawn, the ones in view
 * only. A first estimate, to be set from measured data.
 */
export const IMMEDIATE_CACHE_LIMIT = 50_000;

/** The rows packed between two looks at the clock */
const SLICE_ROWS = 512;

/** The vertices of polygons packed and written between two looks at the clock */
const SLICE_POLYGON_VERTICES = 2_000;

/** The whole world: the range drawn when the view is not known */
const WORLD: BoundingBox = { minX: -540, minY: -90, maxX: 540, maxY: 90 };

/**
 * One range of rows drawn, as the record of the draws gives it
 *
 * @internal
 */
export interface TableDrawRecord {
  readonly layerId: string;
  /** The row group */
  readonly group: RowGroupHandle;
  /** The place of the group in the order of its layer */
  readonly groupIndex: number;
  /** The kind of the chunk */
  readonly kind: RunKind;
  /** The first row drawn in its group */
  readonly from: number;
  /** The end of the rows drawn (exclusive) */
  readonly to: number;
}

/**
 * The frame a layer is drawn in
 *
 * @internal
 */
export interface TableLayerFrame {
  readonly projectionData: ProjectionData;
  readonly zoom: number;
  /** The range to draw, on one copy of the world (everything when undefined) */
  readonly bounds: BoundingBox | undefined;
}

/**
 * What the drawing of the layers held as rows is made with
 *
 * @internal
 */
export interface TableLayerRendererOptions {
  readonly gl: WebGL2RenderingContext;
  /** The terrain state of the draw instance (the camera moving, the elevations of points) */
  readonly terrain: TerrainContext;
  /** Where the textures of the state of the rows are recorded */
  readonly ledger?: GpuLedger;
  /** The rendering pixel ratio (read from window when omitted) */
  readonly pixelRatio?: PixelRatioInput;
  /** The time the builds may take in a frame ({@link TABLE_BUILD_BUDGET_MS} when omitted) */
  readonly buildBudgetMs?: number;
  /** The features made from rows that are kept ({@link IMMEDIATE_CACHE_LIMIT} when omitted) */
  readonly immediateCacheLimit?: number;
  /** Asks for another frame */
  readonly requestRepaint: () => void;
}

/** The batches of a retained chunk of rows */
type TableChunkBatch =
  | { readonly kind: 'point'; readonly batch: RetainedPointBatch | null }
  | { readonly kind: 'line'; readonly batch: RetainedLineBatch | null }
  | { readonly kind: 'polygon'; readonly batch: RetainedPolygonBatch | null };

/** A retained chunk of rows */
interface RetainedRowsChunk extends RetainedChunkState<TableChunkBatch> {
  readonly type: 'retained';
  readonly range: OrderedChunkRange;
}

/** A chunk of rows drawn at once */
interface ImmediateRowsChunk {
  readonly type: 'immediate';
  readonly range: OrderedChunkRange;
  /** The feature of each row (null for a row without one), filled over the frames */
  features: Array<Feature | null> | null;
  /** The rows filled so far */
  filled: number;
}

type RowsChunk = RetainedRowsChunk | ImmediateRowsChunk;

/** What is kept for a row group */
interface GroupCache {
  readonly group: RowGroup;
  chunks: RowsChunk[];
  texture: RowStateTexture | null;
  /** The version of the state the texture holds (-1 before the first upload) */
  uploadedVersion: number;
}

/** What is kept for a layer */
interface LayerCache {
  readonly groups: Map<RowGroupHandle, GroupCache>;
  /** What the classification of the rows was made with */
  slots: RowStyleSlots | null;
  rule: Layer['styleRule'];
  companionsGeneration: number;
}

/**
 * The drawing of the layers held as rows of columns
 *
 * @internal
 */
export class TableLayerRenderer {
  private readonly layers = new Map<string, LayerCache>();
  private renderers: RetainedRendererSet | null = null;
  private budget: ChunkBuildBudget | null = null;
  private pending = false;
  private cachedFeatures = 0;
  private builtPixelRatio: number | null = null;
  private cuts = 0;
  private record: TableDrawRecord[] | null = null;
  private readonly translations = new Float32Array((MOVE_SETS + 1) * 2);
  private readonly scratch: { parts: number[] } = { parts: [] };

  constructor(private readonly options: TableLayerRendererOptions) {}

  /** Whether the last frame left a build unfinished */
  get hasPendingWork(): boolean {
    return this.pending;
  }

  /**
   * Starts a frame: the budget of the builds of the frame, and the batches made again when the
   * rendering pixel ratio changed (they keep being drawn until then)
   */
  beginFrame(): void {
    this.budget = createChunkBuildBudget(this.options.buildBudgetMs ?? TABLE_BUILD_BUDGET_MS);
    this.pending = false;
    const dpr = resolvePixelRatio(this.options.pixelRatio);
    if (this.builtPixelRatio !== null && this.builtPixelRatio !== dpr) this.invalidateAll(true);
    this.builtPixelRatio = dpr;
  }

  /** Ends a frame: another one is asked for when a build is left */
  endFrame(): void {
    if (this.pending) this.options.requestRepaint();
  }

  /**
   * Draws a layer held as rows, in the order of its rows
   *
   * @param tables The tables the layer is in
   * @param table The rows of the layer
   */
  drawLayer(
    tables: FeatureTablesInternals,
    table: LayerTable,
    layer: Layer,
    frame: TableLayerFrame,
    deps: StoreRetainedDrawDeps,
  ): void {
    const renderers = deps.renderers;
    if (!canDrawRows(renderers)) return;
    this.renderers = renderers;
    const budget = this.budget ?? createChunkBuildBudget(TABLE_BUILD_BUDGET_MS);
    this.budget = budget;

    const cache = this.layerCache(tables, table, layer, renderers, deps);
    const slots = cache.slots as RowStyleSlots;
    const context: RowPackContext = {
      slots,
      strings: tables.strings,
      pixelRatio: this.options.pixelRatio,
      terrain: this.options.terrain,
    };
    for (let k = 0; k <= MOVE_SETS; k++) {
      const [dLng, dLat] = k === 0 ? [0, 0] : tables.states.translation(k);
      this.translations[k * 2] = dLng;
      this.translations[k * 2 + 1] = dLat;
    }

    const bounds = frame.bounds ?? WORLD;
    const settled = !isTerrainCameraMoving(this.options.terrain);
    const factors = layerDrawFactors(layer);
    const cutsOf = this.cuts > 0 ? this.placeCuts(table, cache, bounds) : null;

    for (let g = 0; g < table.groupCount; g++) {
      const group = table.groupAt(g);
      const groupCache = cache.groups.get(group.handle);
      if (!groupCache) continue;
      const binding = this.stateBinding(groupCache);
      if (!binding) continue;

      const host: ChunkSchedulerHost<RetainedRowsChunk, TableChunkBatch> = {
        isStale: () => false,
        startJob: (state, origin) => this.startJob(group, state.range, origin, context, renderers),
        adoptJob: () => {},
        disposeBatches: (batches) => disposeBatch(batches, renderers),
        draw: (state) => {
          this.drawRetained(
            table.layerId,
            group,
            g,
            state,
            binding,
            frame,
            factors,
            renderers,
            cutsOf?.get(state) ?? null,
          );
          return true;
        },
      };

      for (const chunk of groupCache.chunks) {
        if (chunk.type === 'immediate') {
          this.drawImmediate(tables, table.layerId, layer, group, g, chunk, frame, deps, settled);
          continue;
        }
        const left = advanceChunkBuilds(
          [chunk],
          { bounds, zoom: frame.zoom, settled, budget },
          host,
        );
        if (left) this.pending = true;
      }
    }
  }

  /**
   * Makes every batch again: with `keepDrawing` the batches keep being drawn until the new ones
   * are built, without it they are released at once
   */
  invalidateAll(keepDrawing = true): void {
    const renderers = this.renderers;
    for (const cache of this.layers.values()) {
      for (const groupCache of cache.groups.values()) {
        for (const chunk of groupCache.chunks) this.invalidateChunk(chunk, renderers, keepDrawing);
      }
      if (!keepDrawing) cache.slots = null;
    }
  }

  /**
   * Classifies the rows again on the next draw (a custom type or a provider of companions came
   * or went): a chunk that keeps its rows and its kind keeps drawing until it is built again
   */
  reclassify(): void {
    for (const cache of this.layers.values()) cache.slots = null;
  }

  /** Releases every GPU resource (the batches are built again on the next draw) */
  dispose(renderers?: RetainedRendererSet): void {
    if (renderers) this.renderers = renderers;
    const r = this.renderers;
    for (const cache of this.layers.values()) {
      for (const groupCache of cache.groups.values()) this.disposeGroup(groupCache, r);
    }
    this.layers.clear();
    this.cachedFeatures = 0;
    this.renderers = null;
  }

  // === Hooks of tests and measurements ===

  /**
   * Cuts the ranges drawn of every layer at `count` places spread over its rows in view (0 for
   * none): every cut draws a range in two draws
   */
  setArtificialCuts(count: number): void {
    this.cuts = Math.max(0, Math.floor(count));
  }

  /**
   * Records every range drawn into an array, in order (null stops the recording)
   */
  recordDraws(record: TableDrawRecord[] | null): void {
    this.record = record;
  }

  // === The caches ===

  /** The cache of a layer, made again where its groups or its classification changed */
  private layerCache(
    tables: FeatureTablesInternals,
    table: LayerTable,
    layer: Layer,
    renderers: RetainedRendererSet,
    deps: StoreRetainedDrawDeps,
  ): LayerCache {
    let cache = this.layers.get(table.layerId);
    if (!cache) {
      cache = { groups: new Map(), slots: null, rule: undefined, companionsGeneration: -1 };
      this.layers.set(table.layerId, cache);
    }
    const companions = deps.companions;
    const classificationChanged =
      cache.slots === null ||
      cache.slots.resolver !== renderers.styles ||
      cache.rule !== layer.styleRule ||
      cache.companionsGeneration !== companions.generation();
    if (classificationChanged) {
      cache.slots = new RowStyleSlots(renderers.styles, tables.styles, layer.styleRule);
      cache.rule = layer.styleRule;
      cache.companionsGeneration = companions.generation();
    }
    const slots = cache.slots as RowStyleSlots;

    // The groups that left the layer are released
    for (const [handle, groupCache] of cache.groups) {
      if (table.group(handle) !== groupCache.group) {
        this.disposeGroup(groupCache, this.renderers);
        cache.groups.delete(handle);
      }
    }
    // The groups that came in are cut into chunks; with a new classification every group is cut
    // again, and a chunk that keeps its rows and its kind keeps drawing until it is built again
    for (let g = 0; g < table.groupCount; g++) {
      const group = table.groupAt(g);
      const existing = cache.groups.get(group.handle);
      if (existing && !classificationChanged) continue;
      const ranges = partitionRowGroup(group, (row) =>
        classifyRow(group, row, {
          slots,
          customTypes: deps.customRenderers,
          companions: companions as FeatureCompanionRegistry,
          featureOf: (rows, r) => rowFeature(tables.readContext, table.layerId, rows, r),
          layer,
        }),
      );
      if (existing) {
        existing.chunks = this.reuseChunks(existing.chunks, ranges);
      } else {
        cache.groups.set(group.handle, {
          group,
          chunks: ranges.flatMap((range) => this.makeChunk(range)),
          texture: null,
          uploadedVersion: -1,
        });
      }
    }
    return cache;
  }

  /** The chunks of new ranges: a chunk of the same rows and kind is kept (and built again) */
  private reuseChunks(old: RowsChunk[], ranges: OrderedChunkRange[]): RowsChunk[] {
    const same =
      old.length === ranges.length &&
      old.every(
        (chunk, i) =>
          chunk.range.kind === ranges[i].kind &&
          chunk.range.from === ranges[i].from &&
          chunk.range.to === ranges[i].to,
      );
    if (same) {
      for (const chunk of old) this.invalidateChunk(chunk, this.renderers, true);
      return old;
    }
    for (const chunk of old) this.invalidateChunk(chunk, this.renderers, false);
    return ranges.flatMap((range) => this.makeChunk(range));
  }

  /** A chunk for a range of rows (none for a range without a bbox) */
  private makeChunk(range: OrderedChunkRange): RowsChunk[] {
    if (range.kind === 'immediate') {
      return [{ type: 'immediate', range, features: null, filled: 0 }];
    }
    if (!range.bounds) return [];
    return [
      {
        type: 'retained',
        range,
        bounds: range.bounds,
        batches: null,
        job: null,
        origin: null,
        jobOrigin: null,
        viewOrigin: null,
        stale: false,
      },
    ];
  }

  private invalidateChunk(
    chunk: RowsChunk,
    renderers: RetainedRendererSet | null,
    keepDrawing: boolean,
  ): void {
    if (chunk.type === 'immediate') {
      this.cachedFeatures -= chunk.filled;
      chunk.features = null;
      chunk.filled = 0;
      return;
    }
    if (!renderers) {
      chunk.job = null;
      chunk.batches = null;
      return;
    }
    invalidateChunk<RetainedRowsChunk, TableChunkBatch>(
      chunk,
      { disposeBatches: (batches) => disposeBatch(batches, renderers) },
      keepDrawing,
    );
  }

  private disposeGroup(groupCache: GroupCache, renderers: RetainedRendererSet | null): void {
    for (const chunk of groupCache.chunks) this.invalidateChunk(chunk, renderers, false);
    groupCache.chunks = [];
    if (groupCache.texture) {
      deleteRowStateTexture(this.options.gl, groupCache.texture, this.options.ledger);
      groupCache.texture = null;
    }
  }

  /** The texture of the state of the rows of a group, written when the state changed */
  private stateBinding(groupCache: GroupCache): RowStateBinding | null {
    const group = groupCache.group;
    if (!groupCache.texture) {
      groupCache.texture = createRowStateTexture(
        this.options.gl,
        group.data.length,
        this.options.ledger,
      );
      groupCache.uploadedVersion = -1;
    }
    const texture = groupCache.texture;
    if (!texture) return null;
    if (groupCache.uploadedVersion !== group.stateVersion) {
      uploadRowState(this.options.gl, texture, group.gpuState);
      groupCache.uploadedVersion = group.stateVersion;
    }
    return { texture, translations: this.translations };
  }

  // === The builds ===

  /** Starts the build of the batch of a retained chunk */
  private startJob(
    group: RowGroup,
    range: OrderedChunkRange,
    origin: [number, number],
    context: RowPackContext,
    renderers: RetainedRendererSet,
  ): RetainedChunkJob<TableChunkBatch> {
    switch (range.kind) {
      case 'point':
        return pointJob(group, range, origin, context, renderers);
      case 'line':
        return lineJob(group, range, origin, context, renderers, this.scratch.parts);
      default:
        return polygonJob(group, range, origin, context, renderers);
    }
  }

  // === The draws ===

  /** Draws a retained chunk, in ranges cut at the places given */
  private drawRetained(
    layerId: string,
    group: RowGroup,
    groupIndex: number,
    state: RetainedRowsChunk,
    binding: RowStateBinding,
    frame: TableLayerFrame,
    factors: RetainedDrawFactors,
    renderers: RetainedRendererSet,
    cuts: readonly number[] | null,
  ): void {
    const batches = state.batches;
    if (!batches?.batch) return;
    const rows = state.range.to - state.range.from;
    let from = 0;
    const draw = (to: number): void => {
      if (to <= from) return;
      const { projectionData, zoom } = frame;
      switch (batches.kind) {
        case 'point':
          renderers.point.drawRetainedRange?.(
            batches.batch as RetainedPointBatch,
            from,
            to,
            zoom,
            projectionData,
            binding,
            factors,
          );
          break;
        case 'line':
          renderers.line.drawRetainedRange?.(
            batches.batch as RetainedLineBatch,
            from,
            to,
            zoom,
            projectionData,
            binding,
            factors,
          );
          break;
        case 'polygon':
          renderers.polygon.drawRetainedRange?.(
            batches.batch as RetainedPolygonBatch,
            from,
            to,
            zoom,
            projectionData,
            renderers.viewport(),
            binding,
            factors,
          );
          break;
      }
      this.record?.push({
        layerId,
        group: group.handle,
        groupIndex,
        kind: state.range.kind,
        from: state.range.from + from,
        to: state.range.from + to,
      });
      from = to;
    };
    if (cuts) for (const cut of cuts) draw(cut);
    draw(rows);
  }

  /** Draws a chunk of rows at once, from the features of its rows */
  private drawImmediate(
    tables: FeatureTablesInternals,
    layerId: string,
    layer: Layer,
    group: RowGroup,
    groupIndex: number,
    chunk: ImmediateRowsChunk,
    frame: TableLayerFrame,
    deps: StoreRetainedDrawDeps,
    settled: boolean,
  ): void {
    const { from, to } = chunk.range;
    const count = to - from;
    // The features of the rows are made over the frames, within the budget, while they fit
    const limit = this.options.immediateCacheLimit ?? IMMEDIATE_CACHE_LIMIT;
    if (settled && chunk.filled < count && this.cachedFeatures + count - chunk.filled <= limit) {
      chunk.features ??= new Array(count).fill(null);
      const budget = this.budget as ChunkBuildBudget;
      while (chunk.filled < count && budget.canStep()) {
        budget.stepped();
        const end = Math.min(count, chunk.filled + SLICE_ROWS);
        for (let i = chunk.filled; i < end; i++) {
          const row = from + i;
          chunk.features[i] =
            group.data.geometry.types[row] < 0
              ? null
              : rowFeature(tables.readContext, layerId, group, row);
        }
        this.cachedFeatures += end - chunk.filled;
        chunk.filled = end;
      }
    }
    if (chunk.filled < count && settled && this.cachedFeatures + count - chunk.filled <= limit) {
      this.pending = true;
    }

    const bounds = frame.bounds ?? WORLD;
    const rowBounds = group.data.rowBounds;
    const features: Feature[] = [];
    for (let i = 0; i < count; i++) {
      const row = from + i;
      const state = group.state[row];
      if ((state & STATE_HIDDEN_MASK) !== 0) continue;
      let feature = chunk.features && i < chunk.filled ? chunk.features[i] : null;
      if (!feature) {
        // A row not kept is made when it is in view
        if (group.data.geometry.types[row] < 0 || !rowInView(rowBounds, row, bounds)) continue;
        feature = rowFeature(tables.readContext, layerId, group, row);
      }
      const set = (state & STATE_MOVE_MASK) >> STATE_MOVE_SHIFT;
      features.push(set > 0 ? translated(feature, this.translations, set) : feature);
    }
    if (features.length > 0) {
      drawImmediateFeatures(features, layer, frame.projectionData, frame.zoom, deps);
    }
    this.record?.push({ layerId, group: group.handle, groupIndex, kind: 'immediate', from, to });
  }

  /**
   * The places the drawn ranges of a layer are cut at: `cuts` places spread evenly over the
   * places between two rows of the retained chunks in view, as rows of each chunk (a cut is
   * never at the start of a chunk, so every cut is one more draw)
   */
  private placeCuts(
    table: LayerTable,
    cache: LayerCache,
    bounds: BoundingBox,
  ): Map<RetainedRowsChunk, number[]> {
    const visible: RetainedRowsChunk[] = [];
    let interior = 0;
    for (let g = 0; g < table.groupCount; g++) {
      const groupCache = cache.groups.get(table.groupAt(g).handle);
      if (!groupCache) continue;
      for (const chunk of groupCache.chunks) {
        if (chunk.type !== 'retained' || !chunk.batches?.batch) continue;
        if (!meets(chunk.bounds, bounds)) continue;
        visible.push(chunk);
        interior += chunk.range.to - chunk.range.from - 1;
      }
    }
    const out = new Map<RetainedRowsChunk, number[]>();
    const n = Math.min(this.cuts, interior);
    let chunkIndex = 0;
    let before = 0;
    for (let i = 1; i <= n; i++) {
      // The i-th of n places spread over the interior places: with more places than cuts the
      // steps are at least one place, so no two cuts are at the same place
      const at = n === interior ? i - 1 : Math.floor((i * interior) / (n + 1));
      while (chunkIndex < visible.length) {
        const size = visible[chunkIndex].range.to - visible[chunkIndex].range.from - 1;
        if (at < before + size) break;
        before += size;
        chunkIndex++;
      }
      const chunk = visible[chunkIndex];
      if (!chunk) break;
      let list = out.get(chunk);
      if (!list) {
        list = [];
        out.set(chunk, list);
      }
      list.push(at - before + 1);
    }
    return out;
  }
}

/** Whether the renderers can build and draw batches of rows */
function canDrawRows(renderers: RetainedRendererSet): boolean {
  return (
    typeof renderers.point.buildRetainedRows === 'function' &&
    typeof renderers.point.drawRetainedRange === 'function' &&
    typeof renderers.line.buildRetainedRows === 'function' &&
    typeof renderers.line.drawRetainedRange === 'function' &&
    typeof renderers.polygon.createRetainedRows === 'function' &&
    typeof renderers.polygon.writeRetainedRows === 'function' &&
    typeof renderers.polygon.drawRetainedRange === 'function'
  );
}

/** Releases the batch of a retained chunk */
function disposeBatch(batches: TableChunkBatch, renderers: RetainedRendererSet): void {
  if (!batches.batch) return;
  switch (batches.kind) {
    case 'point':
      renderers.point.disposeRetained(batches.batch);
      break;
    case 'line':
      renderers.line.disposeRetainedBatch(batches.batch);
      break;
    case 'polygon':
      renderers.polygon.disposeRetained(batches.batch);
      break;
  }
}

/** Whether two boxes meet */
function meets(a: BoundingBox, b: BoundingBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Whether the bbox of a row meets a box */
function rowInView(rowBounds: Float64Array, row: number, bounds: BoundingBox): boolean {
  const at = row * 4;
  return (
    rowBounds[at] <= bounds.maxX &&
    rowBounds[at + 2] >= bounds.minX &&
    rowBounds[at + 1] <= bounds.maxY &&
    rowBounds[at + 3] >= bounds.minY
  );
}

/** A feature moved by the translation of its moving set (the rows drawn at once) */
function translated(feature: Feature, translations: Float32Array, set: number): Feature {
  const dLng = translations[set * 2];
  const dLat = translations[set * 2 + 1];
  if (dLng === 0 && dLat === 0) return feature;
  const shift = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    if (typeof value[0] === 'number') {
      const position = value as Coordinate;
      return [position[0] + dLng, position[1] + dLat, ...position.slice(2)];
    }
    return value.map(shift);
  };
  const geometry = feature.geometry as { type: string; coordinates?: unknown };
  return {
    ...feature,
    geometry: { ...geometry, coordinates: shift(geometry.coordinates) } as Feature['geometry'],
  };
}

// === The builds of the batches ===

/** The row of each instance (or index) of a range, as `rowFirst` of a batch */
function newRowFirst(range: OrderedChunkRange): Int32Array {
  return new Int32Array(range.to - range.from + 1);
}

/** Builds the batch of a chunk of points: the instances of the rows, then the batch */
function pointJob(
  group: RowGroup,
  range: OrderedChunkRange,
  origin: [number, number],
  context: RowPackContext,
  renderers: RetainedRendererSet,
): RetainedChunkJob<TableChunkBatch> {
  const rows = range.to - range.from;
  const rowFirst = newRowFirst(range);
  for (let i = 0; i < rows; i++) {
    rowFirst[i + 1] = rowFirst[i] + pointInstancesOf(group, range.from + i);
  }
  const instances = new Float32Array(rowFirst[rows] * ROW_POINT_STRIDE);
  let next = 0;
  let result: TableChunkBatch | null = null;
  return {
    step(deadline, now) {
      while (next < rows) {
        const end = Math.min(rows, next + SLICE_ROWS);
        for (; next < end; next++) {
          writePointRow(group, range.from + next, instances, rowFirst[next], origin, context);
        }
        if (now() >= deadline) break;
      }
      if (next < rows) return false;
      const batch =
        rowFirst[rows] > 0
          ? (renderers.point.buildRetainedRows?.(instances, rowFirst[rows], origin, rowFirst) ??
            null)
          : null;
      result = { kind: 'point', batch };
      return true;
    },
    take: () => result,
    dispose: () => {
      if (result) disposeBatch(result, renderers);
      result = null;
    },
  };
}

/** Builds the batch of a chunk of lines: the coordinates and the instances, then the batch */
function lineJob(
  group: RowGroup,
  range: OrderedChunkRange,
  origin: [number, number],
  context: RowPackContext,
  renderers: RetainedRendererSet,
  parts: number[],
): RetainedChunkJob<TableChunkBatch> {
  const rows = range.to - range.from;
  let coords = 0;
  let instances = 0;
  for (let i = 0; i < rows; i++) {
    parts.length = 0;
    linePartsOf(group, range.from + i, parts);
    for (let k = 0; k < parts.length; k += 2) {
      coords += parts[k + 1] - parts[k];
      instances += parts[k + 1] - parts[k] - 1;
    }
  }
  const arrays = createLineRowArrays(coords, instances);
  const rowFirst = newRowFirst(range);
  let next = 0;
  let result: TableChunkBatch | null = null;
  return {
    step(deadline, now) {
      while (next < rows) {
        const end = Math.min(rows, next + SLICE_ROWS);
        for (; next < end; next++) {
          writeLineRow(group, range.from + next, arrays, origin, context, parts);
          rowFirst[next + 1] = arrays.instanceCount;
        }
        if (now() >= deadline) break;
      }
      if (next < rows) return false;
      const batch =
        arrays.instanceCount > 0
          ? (renderers.line.buildRetainedRows?.(
              {
                texData: arrays.texData,
                texSize: arrays.texSize,
                instanceData: arrays.instanceData.subarray(
                  0,
                  arrays.instanceCount * ROW_LINE_STRIDE,
                ),
                instanceCount: arrays.instanceCount,
                maxSegmentMeters: arrays.maxSegmentMeters,
                maxSegmentMercator: lineRowsMercatorLength(arrays, context.pixelRatio),
              },
              origin,
              rowFirst,
            ) ?? null)
          : null;
      result = { kind: 'line', batch };
      return true;
    },
    take: () => result,
    dispose: () => {
      if (result) disposeBatch(result, renderers);
      result = null;
    },
  };
}

/**
 * Builds the batch of a chunk of polygons: the rows are planned and counted, one buffer of the
 * size of the chunk is made, and the rows are written into it a slice at a time
 */
function polygonJob(
  group: RowGroup,
  range: OrderedChunkRange,
  origin: [number, number],
  context: RowPackContext,
  renderers: RetainedRendererSet,
): RetainedChunkJob<TableChunkBatch> {
  const rows = range.to - range.from;
  const plans: Array<PolygonRowPlan | null> = new Array(rows);
  const rowFirst = newRowFirst(range);
  const vertexFirst = new Int32Array(rows + 1);
  let planned = 0;
  let next = 0;
  let batch: RetainedPolygonBatch | null = null;
  let done = false;
  let result: TableChunkBatch | null = null;
  return {
    step(deadline, now) {
      // 1. Plan and count every row (the size of the buffer)
      while (planned < rows) {
        const end = Math.min(rows, planned + SLICE_ROWS);
        for (; planned < end; planned++) {
          const plan = planPolygonRow(group, range.from + planned, context);
          plans[planned] = plan;
          rowFirst[planned + 1] = rowFirst[planned] + (plan?.indexCount ?? 0);
          vertexFirst[planned + 1] = vertexFirst[planned] + (plan?.vertexCount ?? 0);
        }
        if (now() >= deadline) return false;
      }
      if (!batch && !done) {
        batch =
          renderers.polygon.createRetainedRows?.(
            vertexFirst[rows],
            rowFirst[rows],
            origin,
            rowFirst,
          ) ?? null;
        if (!batch) done = true;
      }
      // 2. Write the rows a slice at a time
      while (batch && next < rows) {
        const first = next;
        let vertices = 0;
        while (next < rows && (next === first || vertices < SLICE_POLYGON_VERTICES)) {
          vertices += vertexFirst[next + 1] - vertexFirst[next];
          next++;
        }
        const vertexData = new Float32Array(
          (vertexFirst[next] - vertexFirst[first]) * ROW_POLYGON_STRIDE,
        );
        const indexData = new Uint32Array(rowFirst[next] - rowFirst[first]);
        for (let i = first; i < next; i++) {
          const plan = plans[i];
          if (!plan) continue;
          writePolygonRow(
            plan,
            range.from + i,
            vertexData,
            vertexFirst[i] - vertexFirst[first],
            indexData,
            rowFirst[i] - rowFirst[first],
            vertexFirst[i],
            origin,
            context.pixelRatio,
          );
          plans[i] = null;
        }
        renderers.polygon.writeRetainedRows?.(
          batch,
          vertexData,
          vertexFirst[first],
          indexData,
          rowFirst[first],
        );
        if (now() >= deadline) break;
      }
      if (batch && next < rows) return false;
      result = { kind: 'polygon', batch };
      return true;
    },
    take: () => result,
    dispose: () => {
      if (result) disposeBatch(result, renderers);
      else if (batch) renderers.polygon.disposeRetained(batch);
      result = null;
      batch = null;
    },
  };
}
