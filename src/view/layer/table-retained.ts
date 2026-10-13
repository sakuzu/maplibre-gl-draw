// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The drawing of the layers held as rows of columns (`TableLayerRenderer`)
 *
 * A layer held as rows is drawn in the order of its rows: its row groups in their order, and
 * the GPU chunks of a group (`table-partition.ts`) in theirs. A chunk outside the view is
 * skipped, which keeps the order since a chunk is a run of the order. It is drawn one of two ways:
 *
 * - in one draw (`renderers/rows/`), on a flat map: a chunk holds rows of every kind, points,
 *   lines, dashed lines, polygons and the points an extension draws with pictures, and is drawn
 *   in one draw whatever kinds its rows are; it ends only where a row is drawn at once
 * - by kind, elsewhere (the terrain, the globe): a chunk is a run of rows of one kind, and
 *   polygons, solid lines and points are retained batches of the renderers of their kinds
 *   (`table-collect.ts`)
 *
 * In both, the rows that cannot be in a chunk (images, custom types, features with companions,
 * shapes that are not instanced, and by kind the dashed lines) are drawn at once, from features
 * made from the rows and kept up to a number.
 *
 * The chunks are built over the frames within a budget (`view/retained/chunk-scheduler.ts`),
 * and a chunk invalidated (a new rendering pixel ratio, a new style rule) keeps drawing until the
 * new one is built. When the drawing of a group changes (the terrain comes or goes), the group is
 * drawn with the chunks of the drawing it had until those of the new one are built in view.
 *
 * The state of the rows (hidden, moving) is not in the chunks: every row group has a texture of
 * one byte per row (`renderers/row-state.ts`), written from the copy of the state of the group
 * whenever it changes, and the programs read it. A chunk draws any range of its rows in one draw,
 * so it can be drawn in parts with something in between, at the cost of one more draw per cut.
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
import { resolveContentPixelRatio, resolvePixelRatio } from '../../shared/utils/pixel-ratio.js';
import type { FeatureCompanionRegistry } from '../feature-companion.js';
import type { GpuLedger } from '../gpu-ledger.js';
import {
  layerDrawFactors,
  NEUTRAL_DRAW_FACTORS,
  type RetainedDrawFactors,
} from '../renderers/draw-factors.js';
import { normalizeOrigin, ROW_LINE_STRIDE } from '../renderers/line/line-geometry.js';
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
import { type RowSpriteSource, RowsPalette } from '../renderers/rows/rows-format.js';
import type { RowsChunk as RowsGpuChunk, RowsRenderer } from '../renderers/rows/rows-renderer.js';
import {
  advanceChunkBuild,
  type ChunkBuildBudget,
  type ChunkSchedulerHost,
  createChunkBuildBudget,
  invalidateChunk,
  type RetainedChunkJob,
  type RetainedChunkState,
} from '../retained/chunk-scheduler.js';
import type { TerrainContext } from '../terrain/context.js';
import { isTerrainCameraMoving } from '../terrain/state.js';
import { drawImmediateFeatures, type StoreRetainedDrawDeps } from './store-retained-immediate.js';
import {
  collectRow,
  createLineRowArrays,
  linePartsOf,
  lineRowsMercatorLength,
  type PolygonRowPlan,
  planPolygonRow,
  pointInstancesOf,
  type RowPackContext,
  RowStyleSlots,
  RowsDraft,
  type RowsPackContext,
  RowsStyles,
  writeLineRow,
  writePointRow,
  writePolygonRow,
} from './table-collect.js';
import {
  classifyRow,
  type OrderedChunkRange,
  partitionRowGroup,
  type TableRunKind,
} from './table-partition.js';

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
  /** The kind of the chunk (`rows` for a chunk drawn in one draw) */
  readonly kind: TableRunKind;
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

/** A retained chunk of rows of one kind (the drawing by kind) */
interface RetainedRowsChunk extends RetainedChunkState<TableChunkBatch> {
  readonly type: 'retained';
  readonly range: OrderedChunkRange;
}

/** A chunk of rows of every kind drawn in one draw */
interface OneDrawRowsChunk extends RetainedChunkState<RowsGpuChunk> {
  readonly type: 'rows';
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

/** A chunk of the drawing by kind */
type KindChunk = RetainedRowsChunk | ImmediateRowsChunk;
/** A chunk of the drawing in one draw */
type OneDrawChunk = OneDrawRowsChunk | ImmediateRowsChunk;
/** A chunk of either drawing */
type TableChunk = KindChunk | OneDrawRowsChunk;

/**
 * The two ways a layer held as rows is drawn: in one draw per chunk with rows of every kind
 * (`RowsRenderer`, on a flat map), or with one renderer per kind and a chunk per run of a kind
 */
type Drawing = 'one-draw' | 'by-kind';

/** The chunks of a group for one drawing, and the classification they were cut with */
interface GroupChunks<C> {
  chunks: C[];
  /** The generation of the classification of the layer they were cut with */
  generation: number;
}

/** What is kept for a row group */
interface GroupCache {
  readonly group: RowGroup;
  /** The chunks of the drawing by kind (null until it is used) */
  byKind: GroupChunks<KindChunk> | null;
  /** The chunks of the drawing in one draw (null until it is used) */
  oneDraw: GroupChunks<OneDrawChunk> | null;
  /** The rows drawn with the pictures of an extension, with their source (the one draw) */
  sprites: Map<number, RowSpriteSource>;
  texture: RowStateTexture | null;
  /** The version of the state the texture holds (-1 before the first upload) */
  uploadedVersion: number;
  /** What a draw of the rows of the group binds (made again with a new texture) */
  binding: RowStateBinding | null;
}

/** What is kept for a layer */
interface LayerCache {
  readonly groups: Map<RowGroupHandle, GroupCache>;
  /** What the classification of the rows was made with */
  slots: RowStyleSlots | null;
  rule: Layer['styleRule'];
  companionsGeneration: number;
  /** The revisions of the sources of pictures the classification read */
  spriteRevisions: string;
  /** Advances whenever the rows are to be classified again */
  generation: number;
  /** What the rows are packed with (made again with new slots) */
  context: RowPackContext | null;
  /** The styles of the drawing in one draw (made again with new slots or a new pixel ratio) */
  rowsStyles: RowsStyles | null;
}

/**
 * What the draws of a layer and of a group read: set once per layer and once per group, and
 * read by the hosts of the chunks, so that drawing a chunk makes no object
 */
interface DrawPass {
  layerId: string;
  frame: TableLayerFrame | null;
  factors: RetainedDrawFactors;
  renderers: RetainedRendererSet | null;
  context: RowPackContext | null;
  rowsStyles: RowsStyles | null;
  /** The size of the render target, read once per layer */
  viewport: [number, number];
  cutsOf: Map<TableChunk, number[]> | null;
  group: RowGroup | null;
  groupCache: GroupCache | null;
  groupIndex: number;
  binding: RowStateBinding | null;
  /** Whether the chunks advanced are drawn (false while the other drawing draws the group) */
  drawing: boolean;
}

/** The frame of the chunk scheduler, set once per layer */
interface SchedulerFrame {
  bounds: BoundingBox;
  zoom: number;
  settled: boolean;
  budget: ChunkBuildBudget;
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
  /** Whether the layers are drawn by kind even where they can be drawn in one draw */
  private byKind = false;
  /** Whether the uploads of the frame were written before its main pass */
  private prepared = false;
  private readonly translations = new Float32Array((MOVE_SETS + 1) * 2);
  private readonly scratch: { parts: number[] } = { parts: [] };
  /** The drawing chosen for each group of the layer being drawn */
  private readonly choices: Drawing[] = [];
  /** What the draws of the layer and the group being drawn read (set per layer and group) */
  private readonly pass: DrawPass = {
    layerId: '',
    frame: null,
    factors: NEUTRAL_DRAW_FACTORS,
    renderers: null,
    context: null,
    rowsStyles: null,
    viewport: [0, 0],
    cutsOf: null,
    group: null,
    groupCache: null,
    groupIndex: 0,
    binding: null,
    drawing: true,
  };
  /** The frame the chunks of the layer being drawn are built and drawn in (set per layer) */
  private readonly schedule: SchedulerFrame = {
    bounds: WORLD,
    zoom: 0,
    settled: true,
    budget: createChunkBuildBudget(0),
  };
  /** What the building of the chunks by kind asks of the layer and the group being drawn */
  private readonly host: ChunkSchedulerHost<RetainedRowsChunk, TableChunkBatch>;
  /** What the building of the chunks drawn in one draw asks of them */
  private readonly oneDrawHost: ChunkSchedulerHost<OneDrawRowsChunk, RowsGpuChunk>;

  constructor(private readonly options: TableLayerRendererOptions) {
    const pass = this.pass;
    this.host = {
      isStale: () => false,
      startJob: (state, origin) =>
        this.startJob(
          pass.group as RowGroup,
          state.range,
          normalizeOrigin(origin),
          pass.context as RowPackContext,
          pass.renderers as RetainedRendererSet,
        ),
      adoptJob: () => {},
      disposeBatches: (batches) => disposeBatch(batches, pass.renderers as RetainedRendererSet),
      draw: (state) => {
        if (pass.drawing) this.drawRetained(state);
        return true;
      },
    };
    this.oneDrawHost = {
      isStale: () => false,
      startJob: (state, origin) =>
        oneDrawJob(
          pass.group as RowGroup,
          state.range,
          normalizeOrigin(origin),
          this.packContext(pass.groupCache as GroupCache),
          (pass.renderers as RetainedRendererSet).rows as RowsRenderer,
        ),
      adoptJob: () => {},
      disposeBatches: (chunk) => pass.renderers?.rows?.disposeChunk(chunk),
      draw: (state) => {
        if (pass.drawing) this.drawOneDraw(state);
        return true;
      },
    };
  }

  /** Whether the last frame left a build unfinished */
  get hasPendingWork(): boolean {
    return this.pending || this.renderers?.rows?.hasPendingUploads === true;
  }

  /**
   * Writes what the drawing in one draw queued to the GPU (the chunks built, the values of the
   * styles, the writes in place). Called before the main pass of the frame
   */
  prerender(): void {
    this.renderers?.rows?.flushUploads();
    this.prepared = true;
  }

  /**
   * Starts a frame: the budget of the builds of the frame, and the batches made again when the
   * rendering pixel ratio changed (they keep being drawn until then)
   */
  beginFrame(): void {
    // A frame that had no pass before its main one writes what was queued now
    if (!this.prepared) this.renderers?.rows?.flushUploads();
    this.prepared = false;
    this.budget = createChunkBuildBudget(this.options.buildBudgetMs ?? TABLE_BUILD_BUDGET_MS);
    this.pending = false;
    const dpr = resolvePixelRatio(this.options.pixelRatio);
    if (this.builtPixelRatio !== null && this.builtPixelRatio !== dpr) this.invalidateAll(true);
    this.builtPixelRatio = dpr;
  }

  /**
   * Takes in the row groups waiting in the tables, first in the budget of the frame (another
   * frame is asked for when groups are left)
   */
  advanceTables(tables: FeatureTablesInternals): void {
    if (!tables.hasPendingAdoption) return;
    const budget = this.budget ?? createChunkBuildBudget(TABLE_BUILD_BUDGET_MS);
    this.budget = budget;
    if (tables.advanceAdoption(budget)) this.pending = true;
  }

  /** Ends a frame: another one is asked for when a build is left */
  endFrame(): void {
    if (this.hasPendingWork) this.options.requestRepaint();
  }

  /**
   * Draws a layer held as rows, in the order of its rows
   *
   * On a flat map, where the renderer of the drawing in one draw is there and its program is
   * ready, every chunk of rows is drawn in one draw; elsewhere (the terrain, the globe) the rows
   * are drawn with the renderers of their kinds. A group whose chunks of one drawing are not
   * built yet in view is drawn with the chunks of the other while they are, so nothing goes
   * missing when the drawing changes, and the chunks of the other drawing are released once
   * those of the drawing used are built.
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
    const rows = renderers.rows ?? null;
    const terrain = this.options.terrain;
    const flat = !terrain.renderState.active && terrain.globeGrids === null;
    const oneDrawUsable = rows !== null && flat && rows.ready;
    // The program compiles: frames are asked for until it is ready
    if (rows !== null && flat && !oneDrawUsable && rows.compiling) this.pending = true;
    const byKindUsable = canDrawRows(renderers);
    let drawing: Drawing;
    if (oneDrawUsable && !this.byKind) drawing = 'one-draw';
    else if (byKindUsable) drawing = 'by-kind';
    else if (oneDrawUsable) drawing = 'one-draw';
    else return;
    const usable = (d: Drawing): boolean => (d === 'one-draw' ? oneDrawUsable : byKindUsable);
    const other: Drawing = drawing === 'one-draw' ? 'by-kind' : 'one-draw';

    this.renderers = renderers;
    const budget = this.budget ?? createChunkBuildBudget(TABLE_BUILD_BUDGET_MS);
    this.budget = budget;

    const cache = this.layerCache(tables, table, layer, renderers, deps);
    const slots = cache.slots as RowStyleSlots;
    if (
      !cache.context ||
      cache.context.slots !== slots ||
      cache.context.strings !== tables.strings
    ) {
      cache.context = {
        slots,
        strings: tables.strings,
        pixelRatio: this.options.pixelRatio,
        terrain: this.options.terrain,
      };
    }
    if (rows) this.ensureRowsStyles(cache, rows);
    this.translations[0] = 0;
    this.translations[1] = 0;
    for (let k = 1; k <= MOVE_SETS; k++) {
      const [dLng, dLat] = tables.states.translation(k);
      this.translations[k * 2] = dLng;
      this.translations[k * 2 + 1] = dLat;
    }

    const bounds = frame.bounds ?? WORLD;
    const settled = !isTerrainCameraMoving(this.options.terrain);

    // The drawing of each group: the one of the layer, or the other while its chunks in view
    // are not built and those of the other are. Once its chunks in view are built, the chunks
    // of the other drawing are released
    const choices = this.choices;
    choices.length = 0;
    for (let g = 0; g < table.groupCount; g++) {
      const groupCache = cache.groups.get(table.groupAt(g).handle);
      if (!groupCache) {
        choices.push(drawing);
        continue;
      }
      const own = this.chunksOf(cache, groupCache, drawing, tables, table, layer, deps);
      const theirs = drawing === 'one-draw' ? groupCache.byKind : groupCache.oneDraw;
      const ownBuilt = builtInView(own, bounds);
      if (!ownBuilt && theirs && usable(other) && builtInView(theirs.chunks, bounds)) {
        choices.push(other);
      } else {
        choices.push(drawing);
        if (ownBuilt && theirs) this.releaseChunks(groupCache, other);
      }
    }

    const pass = this.pass;
    pass.layerId = table.layerId;
    pass.frame = frame;
    pass.factors = layerDrawFactors(layer);
    pass.renderers = renderers;
    pass.context = cache.context;
    pass.rowsStyles = cache.rowsStyles;
    pass.viewport = renderers.viewport();
    pass.cutsOf = this.cuts > 0 ? this.placeCuts(table, cache, bounds) : null;
    pass.drawing = true;
    const schedule = this.schedule;
    schedule.bounds = bounds;
    schedule.zoom = frame.zoom;
    schedule.settled = settled;
    schedule.budget = budget;

    // The chunks of the layer are drawn as one run of retained draws (draw-run.ts), forgotten
    // before the rows drawn at once and ended with the layer
    const run = renderers.run;
    run?.begin();
    try {
      for (let g = 0; g < table.groupCount; g++) {
        const group = table.groupAt(g);
        const groupCache = cache.groups.get(group.handle);
        if (!groupCache) continue;
        const binding = this.stateBinding(groupCache);
        if (!binding) continue;
        pass.group = group;
        pass.groupCache = groupCache;
        pass.groupIndex = g;
        pass.binding = binding;

        const choice = choices[g];
        if (choice !== drawing) {
          // The chunks of the drawing are built without being drawn, and the group is drawn
          // with the chunks of the other drawing, as they are
          pass.drawing = false;
          this.advance(tables, layer, frame, deps, settled, drawing);
          pass.drawing = true;
          this.drawBuilt(tables, layer, frame, deps, settled, choice, bounds);
        } else {
          this.advance(tables, layer, frame, deps, settled, drawing);
        }
      }
    } finally {
      run?.end();
      // Nothing of the layer is held past its drawing
      pass.frame = null;
      pass.renderers = null;
      pass.context = null;
      pass.rowsStyles = null;
      pass.group = null;
      pass.groupCache = null;
      pass.binding = null;
      pass.cutsOf = null;
      pass.drawing = true;
    }
  }

  /**
   * Makes every batch again: with `keepDrawing` the batches keep being drawn until the new ones
   * are built, without it they are released at once
   */
  invalidateAll(keepDrawing = true): void {
    for (const cache of this.layers.values()) {
      for (const groupCache of cache.groups.values()) {
        for (const chunk of allChunks(groupCache)) this.invalidateChunk(chunk, keepDrawing);
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
    for (const cache of this.layers.values()) {
      for (const groupCache of cache.groups.values()) this.disposeGroup(groupCache);
      if (cache.rowsStyles) this.renderers?.rows?.retirePalette(cache.rowsStyles.palette);
    }
    this.layers.clear();
    this.cachedFeatures = 0;
    this.renderers = null;
  }

  /**
   * Writes rows of a group in place in the chunks drawn in one draw: they are packed again from
   * their columns and their coordinates and styles written over the ones of their chunk, which
   * reach the GPU before the next frame is drawn
   *
   * @param fromRow The first row written, in its group
   * @param toRow The end of the rows written (exclusive)
   * @returns false when the rows cannot be written in place: their instances changed (another
   *   kind, other coordinates, another number of them), their chunk is being built or drawn by
   *   kind, or they are drawn at once. Nothing is written then, and the rows have to be built
   *   again
   */
  patchRows(layerId: string, group: RowGroupHandle, fromRow: number, toRow: number): boolean {
    const cache = this.layers.get(layerId);
    const groupCache = cache?.groups.get(group);
    const rows = this.renderers?.rows;
    if (!cache || !groupCache || !rows || !cache.context || !cache.rowsStyles) return false;
    const chunks = groupCache.oneDraw?.chunks;
    if (!chunks) return false;
    for (const chunk of chunks) {
      const from = Math.max(fromRow, chunk.range.from);
      const to = Math.min(toRow, chunk.range.to);
      if (from >= to) continue;
      if (chunk.type !== 'rows' || chunk.job) return false;
      const gpu = chunk.batches;
      // A chunk not built yet is built from the columns as they are
      if (!gpu) continue;
      if (chunk.stale || gpu.data.palette !== cache.rowsStyles.palette) return false;
      const draft = new RowsDraft(to - from, from);
      const context = this.packContext(groupCache, cache);
      for (let row = from; row < to; row++) {
        collectRow(groupCache.group, row, row - from, draft, gpu.data.origin, context);
      }
      const patch = draft.finish(gpu.data.origin, gpu.data.palette, gpu.data.sprites);
      if (!rows.patchRows(gpu, from - chunk.range.from, patch)) return false;
    }
    return true;
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

  /**
   * Draws the layers by kind even where they can be drawn in one draw (true), or in one draw
   * where they can (false, the default), to compare the two
   */
  setDrawingByKind(byKind: boolean): void {
    this.byKind = byKind;
  }

  // === The caches ===

  /** The cache of a layer, classified again when what its classification read changed */
  private layerCache(
    tables: FeatureTablesInternals,
    table: LayerTable,
    layer: Layer,
    renderers: RetainedRendererSet,
    deps: StoreRetainedDrawDeps,
  ): LayerCache {
    let cache = this.layers.get(table.layerId);
    if (!cache) {
      cache = {
        groups: new Map(),
        slots: null,
        rule: undefined,
        companionsGeneration: -1,
        spriteRevisions: '',
        generation: 0,
        context: null,
        rowsStyles: null,
      };
      this.layers.set(table.layerId, cache);
    }
    const companions = deps.companions;
    const spriteRevisions = spriteRevisionsOf(deps.customRenderers);
    const classificationChanged =
      cache.slots === null ||
      cache.slots.resolver !== renderers.styles ||
      cache.rule !== layer.styleRule ||
      cache.companionsGeneration !== companions.generation() ||
      cache.spriteRevisions !== spriteRevisions;
    if (classificationChanged) {
      cache.slots = new RowStyleSlots(renderers.styles, tables.styles, layer.styleRule);
      cache.rule = layer.styleRule;
      cache.companionsGeneration = companions.generation();
      cache.spriteRevisions = spriteRevisions;
      cache.generation++;
    }

    // The groups that left the layer are released
    for (const [handle, groupCache] of cache.groups) {
      if (table.group(handle) !== groupCache.group) {
        this.disposeGroup(groupCache);
        cache.groups.delete(handle);
      }
    }
    // The groups that came in are kept (their chunks are cut when a drawing first needs them)
    for (let g = 0; g < table.groupCount; g++) {
      const group = table.groupAt(g);
      if (cache.groups.has(group.handle)) continue;
      cache.groups.set(group.handle, {
        group,
        byKind: null,
        oneDraw: null,
        sprites: new Map(),
        texture: null,
        uploadedVersion: -1,
        binding: null,
      });
    }
    return cache;
  }

  /**
   * The styles of the drawing in one draw of a layer, made again with new slots or a new pixel
   * ratio (the chunks built with the old ones keep them until they are built again)
   */
  private ensureRowsStyles(cache: LayerCache, rows: RowsRenderer): void {
    const slots = cache.slots as RowStyleSlots;
    const current = cache.rowsStyles;
    const pixelRatio = this.options.pixelRatio;
    if (
      current &&
      current.slots === slots &&
      current.screenRatio === resolvePixelRatio(pixelRatio) &&
      current.contentRatio === resolveContentPixelRatio(pixelRatio)
    ) {
      return;
    }
    if (current) rows.retirePalette(current.palette);
    cache.rowsStyles = new RowsStyles(slots, new RowsPalette(), pixelRatio);
  }

  /**
   * The chunks of a group for a drawing, cut when the drawing first needs them and cut again
   * when the classification changed (a chunk that keeps its rows and its kind keeps drawing until
   * it is built again)
   */
  private chunksOf(
    cache: LayerCache,
    groupCache: GroupCache,
    drawing: Drawing,
    tables: FeatureTablesInternals,
    table: LayerTable,
    layer: Layer,
    deps: StoreRetainedDrawDeps,
  ): TableChunk[] {
    const held = drawing === 'one-draw' ? groupCache.oneDraw : groupCache.byKind;
    if (held && held.generation === cache.generation) return held.chunks;
    const group = groupCache.group;
    const oneDraw = drawing === 'one-draw';
    const sprites = new Map<number, RowSpriteSource>();
    const ranges = partitionRowGroup(
      group,
      (row) =>
        classifyRow(group, row, {
          slots: cache.slots as RowStyleSlots,
          customTypes: deps.customRenderers,
          companions: deps.companions as FeatureCompanionRegistry,
          featureOf: (rows, r) => rowFeature(tables.readContext, table.layerId, rows, r),
          layer,
          oneDraw,
          onSprite: (r, source) => sprites.set(r, source),
        }),
      undefined,
      oneDraw ? (row) => sprites.get(row) : undefined,
    );
    if (oneDraw) {
      groupCache.sprites = sprites;
      const chunks = held
        ? (this.reuseChunks(held.chunks, ranges) as OneDrawChunk[])
        : (ranges.flatMap((range) => this.makeChunk(range)) as OneDrawChunk[]);
      groupCache.oneDraw = { chunks, generation: cache.generation };
      return chunks;
    }
    const chunks = held
      ? (this.reuseChunks(held.chunks, ranges) as KindChunk[])
      : (ranges.flatMap((range) => this.makeChunk(range)) as KindChunk[]);
    groupCache.byKind = { chunks, generation: cache.generation };
    return chunks;
  }

  /** The chunks of new ranges: a chunk of the same rows and kind is kept (and built again) */
  private reuseChunks(old: TableChunk[], ranges: OrderedChunkRange[]): TableChunk[] {
    const same =
      old.length === ranges.length &&
      old.every(
        (chunk, i) =>
          chunk.range.kind === ranges[i].kind &&
          chunk.range.from === ranges[i].from &&
          chunk.range.to === ranges[i].to,
      );
    if (same) {
      for (const chunk of old) this.invalidateChunk(chunk, true);
      return old;
    }
    for (const chunk of old) this.invalidateChunk(chunk, false);
    return ranges.flatMap((range) => this.makeChunk(range));
  }

  /** A chunk for a range of rows (none for a range without a bbox) */
  private makeChunk(range: OrderedChunkRange): TableChunk[] {
    if (range.kind === 'immediate') {
      return [{ type: 'immediate', range, features: null, filled: 0 }];
    }
    if (!range.bounds) return [];
    const state = {
      range,
      bounds: range.bounds,
      batches: null,
      job: null,
      origin: null,
      jobOrigin: null,
      viewOrigin: null,
      stale: false,
    };
    return [
      range.kind === 'rows'
        ? ({ type: 'rows', ...state } as OneDrawRowsChunk)
        : ({ type: 'retained', ...state } as RetainedRowsChunk),
    ];
  }

  private invalidateChunk(chunk: TableChunk, keepDrawing: boolean): void {
    if (chunk.type === 'immediate') {
      this.cachedFeatures -= chunk.filled;
      chunk.features = null;
      chunk.filled = 0;
      return;
    }
    const renderers = this.renderers;
    if (chunk.type === 'rows') {
      const rows = renderers?.rows;
      if (!rows) {
        chunk.job = null;
        chunk.batches = null;
        return;
      }
      invalidateChunk<OneDrawRowsChunk, RowsGpuChunk>(
        chunk,
        { disposeBatches: (gpu) => rows.disposeChunk(gpu) },
        keepDrawing,
      );
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

  /** Releases the chunks of a group for a drawing */
  private releaseChunks(groupCache: GroupCache, drawing: Drawing): void {
    const held = drawing === 'one-draw' ? groupCache.oneDraw : groupCache.byKind;
    if (!held) return;
    for (const chunk of held.chunks) this.invalidateChunk(chunk, false);
    if (drawing === 'one-draw') groupCache.oneDraw = null;
    else groupCache.byKind = null;
  }

  private disposeGroup(groupCache: GroupCache): void {
    this.releaseChunks(groupCache, 'by-kind');
    this.releaseChunks(groupCache, 'one-draw');
    if (groupCache.texture) {
      deleteRowStateTexture(this.options.gl, groupCache.texture, this.options.ledger);
      groupCache.texture = null;
      groupCache.binding = null;
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
    // The binding is kept with the group (the translations are the one array of the renderer)
    if (groupCache.binding?.texture !== texture) {
      groupCache.binding = { texture, translations: this.translations };
    }
    return groupCache.binding;
  }

  /** What the rows of a group are packed with for the drawing in one draw */
  private packContext(groupCache: GroupCache, cache?: LayerCache): RowsPackContext {
    const pass = this.pass;
    const context = (cache?.context ?? pass.context) as RowPackContext;
    const rowsStyles = (cache?.rowsStyles ?? pass.rowsStyles) as RowsStyles;
    const sprites = groupCache.sprites;
    return {
      ...context,
      rowsStyles,
      spriteSourceOf: (row) => sprites.get(row),
    };
  }

  // === The builds ===

  /** Starts the build of the batch of a retained chunk of one kind */
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

  /**
   * Builds and draws the chunks of the group being drawn for a drawing, in their order (the
   * rows drawn at once among them; nothing is drawn while the pass does not draw)
   */
  private advance(
    tables: FeatureTablesInternals,
    layer: Layer,
    frame: TableLayerFrame,
    deps: StoreRetainedDrawDeps,
    settled: boolean,
    drawing: Drawing,
  ): void {
    const pass = this.pass;
    const groupCache = pass.groupCache as GroupCache;
    const held = drawing === 'one-draw' ? groupCache.oneDraw : groupCache.byKind;
    if (!held) return;
    const run = (pass.renderers as RetainedRendererSet).run;
    for (const chunk of held.chunks) {
      if (chunk.type === 'immediate') {
        if (!pass.drawing) continue;
        // What draws the rows at once may change any of the state of the run
        run?.forget();
        this.drawImmediate(tables, layer, chunk, frame, deps, settled);
        continue;
      }
      const pending =
        chunk.type === 'rows'
          ? advanceChunkBuild(chunk, this.schedule, this.oneDrawHost)
          : advanceChunkBuild(chunk, this.schedule, this.host);
      if (pending) this.pending = true;
    }
  }

  /** Draws the chunks of the group being drawn for a drawing as they are built, in view */
  private drawBuilt(
    tables: FeatureTablesInternals,
    layer: Layer,
    frame: TableLayerFrame,
    deps: StoreRetainedDrawDeps,
    settled: boolean,
    drawing: Drawing,
    bounds: BoundingBox,
  ): void {
    const pass = this.pass;
    const groupCache = pass.groupCache as GroupCache;
    const held = drawing === 'one-draw' ? groupCache.oneDraw : groupCache.byKind;
    if (!held) return;
    const run = (pass.renderers as RetainedRendererSet).run;
    for (const chunk of held.chunks) {
      if (chunk.type === 'immediate') {
        run?.forget();
        this.drawImmediate(tables, layer, chunk, frame, deps, settled);
      } else if (chunk.batches && meets(chunk.bounds, bounds)) {
        if (chunk.type === 'rows') this.drawOneDraw(chunk);
        else this.drawRetained(chunk);
      }
    }
  }

  /** Draws a retained chunk of the group being drawn, in ranges cut at the places given */
  private drawRetained(state: RetainedRowsChunk): void {
    if (!state.batches?.batch) return;
    this.drawCut(state, (from, to) => this.drawRange(state, from, to));
  }

  /** Draws a chunk drawn in one draw of the group being drawn, in ranges cut at the places given */
  private drawOneDraw(state: OneDrawRowsChunk): void {
    if (!state.batches) return;
    this.drawCut(state, (from, to) => this.drawOneDrawRange(state, from, to));
  }

  /** Draws the rows of a chunk in ranges cut at the places the pass gives for it */
  private drawCut(state: TableChunk, draw: (from: number, to: number) => void): void {
    const rows = state.range.to - state.range.from;
    const cuts = this.pass.cutsOf?.get(state);
    let from = 0;
    if (cuts) {
      for (const cut of cuts) {
        if (cut <= from) continue;
        draw(from, cut);
        from = cut;
      }
    }
    if (rows > from) draw(from, rows);
  }

  /** Draws the rows `[from, to)` of a chunk drawn in one draw of the group being drawn */
  private drawOneDrawRange(state: OneDrawRowsChunk, from: number, to: number): void {
    const pass = this.pass;
    const { projectionData, zoom } = pass.frame as TableLayerFrame;
    (pass.renderers as RetainedRendererSet).rows?.drawRange(
      state.batches as RowsGpuChunk,
      from,
      to,
      zoom,
      projectionData,
      pass.binding as RowStateBinding,
      pass.factors,
    );
    this.recordRange('rows', state.range.from + from, state.range.from + to);
  }

  /** Draws the rows `[from, to)` of a retained chunk of the group being drawn */
  private drawRange(state: RetainedRowsChunk, from: number, to: number): void {
    const pass = this.pass;
    const batches = state.batches as TableChunkBatch;
    const renderers = pass.renderers as RetainedRendererSet;
    const { projectionData, zoom } = pass.frame as TableLayerFrame;
    const binding = pass.binding as RowStateBinding;
    switch (batches.kind) {
      case 'point':
        renderers.point.drawRetainedRange?.(
          batches.batch as RetainedPointBatch,
          from,
          to,
          zoom,
          projectionData,
          binding,
          pass.factors,
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
          pass.factors,
        );
        break;
      case 'polygon':
        renderers.polygon.drawRetainedRange?.(
          batches.batch as RetainedPolygonBatch,
          from,
          to,
          zoom,
          projectionData,
          pass.viewport,
          binding,
          pass.factors,
        );
        break;
    }
    this.recordRange(state.range.kind, state.range.from + from, state.range.from + to);
  }

  /** Records a range drawn of the group being drawn */
  private recordRange(kind: TableRunKind, from: number, to: number): void {
    const pass = this.pass;
    this.record?.push({
      layerId: pass.layerId,
      group: (pass.group as RowGroup).handle,
      groupIndex: pass.groupIndex,
      kind,
      from,
      to,
    });
  }

  /** Draws a chunk of rows at once, from the features of its rows */
  private drawImmediate(
    tables: FeatureTablesInternals,
    layer: Layer,
    chunk: ImmediateRowsChunk,
    frame: TableLayerFrame,
    deps: StoreRetainedDrawDeps,
    settled: boolean,
  ): void {
    const pass = this.pass;
    const layerId = pass.layerId;
    const group = pass.group as RowGroup;
    const { from, to } = chunk.range;
    const count = to - from;
    // The features of the rows are made over the frames, within the budget, while they fit
    const limit = this.options.immediateCacheLimit ?? IMMEDIATE_CACHE_LIMIT;
    if (settled && chunk.filled < count && this.cachedFeatures + count - chunk.filled <= limit) {
      chunk.features ??= new Array(count).fill(null);
      const budget = this.budget as ChunkBuildBudget;
      const features = chunk.features;
      while (chunk.filled < count && budget.canStep()) {
        budget.step(() => {
          const end = Math.min(count, chunk.filled + SLICE_ROWS);
          for (let i = chunk.filled; i < end; i++) {
            const row = from + i;
            features[i] =
              group.data.geometry.types[row] < 0
                ? null
                : rowFeature(tables.readContext, layerId, group, row);
          }
          this.cachedFeatures += end - chunk.filled;
          chunk.filled = end;
        });
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
    this.recordRange('immediate', from, to);
  }

  /**
   * The places the drawn ranges of a layer are cut at: `cuts` places spread evenly over the
   * places between two rows of the retained chunks in view of the drawing chosen for each group,
   * as rows of each chunk (a cut is never at the start of a chunk, so every cut is one more draw)
   */
  private placeCuts(
    table: LayerTable,
    cache: LayerCache,
    bounds: BoundingBox,
  ): Map<TableChunk, number[]> {
    const visible: TableChunk[] = [];
    let interior = 0;
    for (let g = 0; g < table.groupCount; g++) {
      const groupCache = cache.groups.get(table.groupAt(g).handle);
      if (!groupCache) continue;
      const held = this.choices[g] === 'one-draw' ? groupCache.oneDraw : groupCache.byKind;
      if (!held) continue;
      for (const chunk of held.chunks) {
        if (chunk.type === 'immediate' || !chunk.batches) continue;
        if (chunk.type === 'retained' && !chunk.batches.batch) continue;
        if (!meets(chunk.bounds, bounds)) continue;
        visible.push(chunk);
        interior += chunk.range.to - chunk.range.from - 1;
      }
    }
    const out = new Map<TableChunk, number[]>();
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

/** Every chunk of a group, of both drawings */
function* allChunks(groupCache: GroupCache): Generator<TableChunk> {
  if (groupCache.byKind) yield* groupCache.byKind.chunks;
  if (groupCache.oneDraw) yield* groupCache.oneDraw.chunks;
}

/**
 * Whether every chunk of a drawing that meets the view has its batches (the rows drawn at once
 * need none)
 */
function builtInView(chunks: readonly TableChunk[], bounds: BoundingBox): boolean {
  for (const chunk of chunks) {
    if (chunk.type === 'immediate') continue;
    if (!chunk.batches && meets(chunk.bounds, bounds)) return false;
  }
  return true;
}

/**
 * The revisions of the sources of pictures of the custom types (the rows are classified again
 * when one changes)
 */
function spriteRevisionsOf(customTypes: ReadonlyMap<string, unknown>): string {
  let out = '';
  for (const [type, renderer] of customTypes) {
    const source = (renderer as { rowSprites?: RowSpriteSource }).rowSprites;
    if (source) out += `${type}\u0000${source.revision}\u0000`;
  }
  return out;
}

/**
 * Builds a chunk drawn in one draw: its rows are packed a slice at a time, then the chunk is
 * made and waits for the pass before the main one of a later frame to write it to the GPU (it is
 * drawn from the frame after that)
 */
function oneDrawJob(
  group: RowGroup,
  range: OrderedChunkRange,
  origin: [number, number],
  context: RowsPackContext,
  rows: RowsRenderer,
): RetainedChunkJob<RowsGpuChunk> {
  const count = range.to - range.from;
  const draft = new RowsDraft(count, range.from, range.vertices);
  // The pictures of the chunk come from one source (`partitionRowGroup`)
  let sprites: RowSpriteSource | null = null;
  for (let row = range.from; row < range.to && !sprites; row++) {
    sprites = context.spriteSourceOf(row) ?? null;
  }
  const palette = context.rowsStyles.palette;
  let next = 0;
  let chunk: RowsGpuChunk | null = null;
  let done = false;
  return {
    step(deadline, now) {
      if (!chunk) {
        while (next < count) {
          const end = Math.min(count, next + SLICE_ROWS);
          for (; next < end; next++) {
            collectRow(group, range.from + next, next, draft, origin, context);
          }
          if (now() >= deadline) break;
        }
        if (next < count) return false;
        chunk = rows.createChunk(draft.finish(origin, palette, sprites));
        return false;
      }
      done = chunk.uploaded;
      return done;
    },
    take: () => (done ? chunk : null),
    dispose: () => {
      if (chunk) rows.disposeChunk(chunk);
      chunk = null;
      done = false;
    },
  };
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
