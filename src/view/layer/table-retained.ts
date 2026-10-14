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
import { type LayerTable, type RowGroup, widenBounds } from '../../feature-table/layer-table.js';
import { rowFeature, rowHasGeometry } from '../../feature-table/row-read.js';
import {
  MOVE_SETS,
  STATE_HIDDEN_MASK,
  STATE_MOVE_MASK,
  STATE_MOVE_SHIFT,
} from '../../feature-table/row-state.js';
import {
  type InPlaceRowWrite,
  ROW_WRITE_GEOMETRY,
  ROW_WRITE_STATE,
  ROW_WRITE_STYLE,
  type RowGroupHandle,
} from '../../feature-table/types.js';
import type { GroupVersion, GroupVersionReceiver } from '../../feature-table/versions.js';
import type { BoundingBox, Coordinate, Feature, Layer } from '../../shared/types/model.js';
import type { PixelRatioInput } from '../../shared/utils/pixel-ratio.js';
import { resolvePixelRatio } from '../../shared/utils/pixel-ratio.js';
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
  chunkClock,
  chunkOrigin,
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
  ROWS_LAYOUT,
  RowCoordsDraft,
  type RowPackContext,
  RowStyleSlots,
  RowsDraft,
  type RowsPackContext,
  RowsStyles,
  resolveRowStyle,
  rowCreatedZoom,
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
  /**
   * Whether the rows are rows of the delta of the layer (`group` is the handle of the delta and
   * `groupIndex` -1; `from` and `to` are rows of the delta)
   */
  readonly delta?: boolean;
}

/**
 * The rows of the delta drawn at a place of a group: before row `at` of the group, the rows
 * `[from, to)` of the delta
 */
interface DeltaInsert {
  readonly at: number;
  readonly from: number;
  readonly to: number;
}

/**
 * The time the frames may take cutting the drawn ranges for the rows of the delta: past this
 * number of cuts in a layer, the next versions of the groups with the most cuts are built first
 * (a first estimate, to be set from measured data)
 *
 * @internal
 */
export const SPLIT_BUDGET = 64;

/**
 * The coordinates a chunk of the rows of a delta holds at most: none, so the delta of a layer is
 * one chunk (whether to cut a large delta is decided from measured data; a number here cuts it
 * as the chunks of the groups are cut)
 *
 * @internal
 */
export const DELTA_CHUNK_VERTICES = Number.POSITIVE_INFINITY;

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
  /**
   * The time the chunks of the next versions of row groups may take to build in a frame while
   * the camera moves (0, the default: they are built once it is still, as every chunk is)
   */
  readonly versionBudgetWhileMovingMs?: number;
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
  /**
   * The chunks of the cut before (other ranges), drawn until the chunks of the new cut are built
   * in view (null when there are none)
   */
  retiring: C[] | null;
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
  /** The generation of the styles of the layer the styles of its rows were resolved with */
  styleGeneration: number;
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
  /**
   * Advances whenever the styles of the rows are to be resolved again (a new style rule, new
   * pictures): the groups resolve them again a group at a time, within the budget of the frames
   */
  styleGeneration: number;
  /** What the rows are packed with (made again with new slots) */
  context: RowPackContext | null;
  /** The styles of the drawing in one draw (made again with new slots or a new pixel ratio) */
  rowsStyles: RowsStyles | null;
  /** What the layer was drawn with last (the writes in place read it) */
  layer: Layer | null;
  deps: StoreRetainedDrawDeps | null;
  tables: FeatureTablesInternals | null;
  /** The rows of the delta of the layer as they are packed (null when there is none) */
  delta: GroupCache | null;
  /** Whether the rows of the delta are to be packed again (a write did not fit its place) */
  deltaStale: boolean;
  /** The view the layer was drawn in last (what a pending version waits for) */
  bounds: BoundingBox;
  /** The drawing the layer was drawn with last, and the frame */
  drawing: Drawing;
  drawnFrame: number;
}

/** A row written in place, waiting for the pass before the main one of the next frame */
interface PendingWrite {
  what: number;
  sameShape: boolean;
  from: number;
  to: number;
  keys: Set<string> | null;
}

/**
 * What the writes in place of the rows did since the drawing was made: how many rows were
 * written in place, of them how many by their coordinates or their style only, and how many
 * did not fit their places and made their chunk build again
 *
 * @internal
 */
export interface TableWriteStats {
  /** The rows written in place in a chunk drawn in one draw */
  inPlace: number;
  /** Of them, the rows written by the positions of their coordinates only */
  coordsOnly: number;
  /** Of them, the rows written by their style only */
  styleOnly: number;
  /** The rows that did not fit their places (they went to the delta of their layer) */
  rebuilt: number;
  /** The rows whose chunk was being built (the build starts again) */
  restarted: number;
  /** The rows classified otherwise (they went to the delta of their layer) */
  reclassified: number;
  /** The cuts of the drawn ranges for the rows of the deltas in the last frame */
  cuts: number;
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
  /** The rows of the delta to draw at places of the group being drawn, in order */
  inserts: readonly DeltaInsert[] | null;
  /** The next of them to draw */
  insertAt: number;
  /** The rows of the delta of the layer being drawn, as they are packed (null: not packed) */
  delta: GroupCache | null;
  /** The rows of the delta of the layer being drawn */
  deltaGroup: RowGroup | null;
  /** What the rows drawn at once of the layer being drawn are drawn with */
  layer: Layer | null;
  deps: StoreRetainedDrawDeps | null;
  tables: FeatureTablesInternals | null;
  settled: boolean;
  /** Whether the layer is drawn in one draw (the rows of the delta in one draw too) */
  oneDraw: boolean;
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
  /** The frames begun */
  private frameCount = 0;
  /** The time the chunks of the next versions may take to build while the camera moves */
  private versionBudgetWhileMovingMs: number;
  /** The tables the drawing waits the next versions of the row groups of (and the detach) */
  private readonly attached = new Map<FeatureTablesInternals, () => void>();
  /** What is kept for the groups of the next versions built, until they are swapped in */
  private readonly pendingCaches = new Map<GroupVersion, GroupCache[]>();
  /** What the next versions of the row groups ask of the drawing */
  private readonly receiver: GroupVersionReceiver = {
    uploaded: (version) => this.versionUploaded(version),
    swapped: (version) => this.versionSwapped(version),
    dropped: (version) => this.versionDropped(version),
  };
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
  /** The time of the last pass before the main one, and of the drawing of the frames (ms) */
  private prerenderMs = 0;
  private drawMs = 0;
  private lastDrawMs = 0;
  /** The rows written in place since the last pass before the main one, by layer and group */
  private readonly written = new Map<string, Map<RowGroupHandle, Map<number, PendingWrite>>>();
  /** What the writes in place did */
  readonly writeStats: TableWriteStats = {
    inPlace: 0,
    coordsOnly: 0,
    styleOnly: 0,
    rebuilt: 0,
    restarted: 0,
    reclassified: 0,
    cuts: 0,
  };
  private readonly scratch: { parts: number[]; coords: Float32Array } = {
    parts: [],
    coords: new Float32Array(2),
  };
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
    inserts: null,
    insertAt: 0,
    delta: null,
    deltaGroup: null,
    layer: null,
    deps: null,
    tables: null,
    settled: true,
    oneDraw: false,
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
    this.versionBudgetWhileMovingMs = options.versionBudgetWhileMovingMs ?? 0;
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
    const start = chunkClock();
    this.prepareUploads();
    this.prepared = true;
    this.prerenderMs = chunkClock() - start;
  }

  /**
   * Writes everything queued to the GPU, then swaps in the next versions of the row groups whose
   * GPU side is up, and writes what the swaps changed (the rows of the deltas they took, the
   * values written in place since they started, the state of their rows): in one pass, so a
   * version is drawn from the frame its groups are replaced in
   */
  private prepareUploads(): void {
    this.applyWrites();
    this.packDeltas();
    this.uploadStates();
    this.renderers?.rows?.flushUploads();
    if (this.attached.size === 0) return;
    for (const tables of this.attached.keys()) tables.swapVersions();
    this.applyWrites();
    this.packDeltas();
    this.uploadStates();
    this.renderers?.rows?.flushUploads();
  }

  /** What the writes in place did, the styles the drawing holds and the time of the last frame */
  editStats(): {
    resolvedStyles: number;
    uploadedBytes: number;
    writes: Readonly<TableWriteStats>;
    prerenderMs: number;
    drawMs: number;
  } {
    let resolvedStyles = 0;
    for (const cache of this.layers.values()) resolvedStyles += cache.rowsStyles?.size ?? 0;
    return {
      resolvedStyles,
      uploadedBytes: this.renderers?.rows?.uploadedBytes ?? 0,
      writes: { ...this.writeStats },
      prerenderMs: this.prerenderMs,
      drawMs: this.lastDrawMs,
    };
  }

  /**
   * Takes rows written in place: they are written into the chunks that draw them in the pass
   * before the main one of the next frame (`prerender`), all of a frame at once
   *
   * @param layerId The layer of the rows
   */
  rowsWritten(layerId: string, writes: readonly InPlaceRowWrite[]): void {
    if (writes.length === 0) return;
    let groups = this.written.get(layerId);
    if (!groups) {
      groups = new Map();
      this.written.set(layerId, groups);
    }
    for (const write of writes) {
      let rows = groups.get(write.group);
      if (!rows) {
        rows = new Map();
        groups.set(write.group, rows);
      }
      const held = rows.get(write.row);
      if (!held) {
        rows.set(write.row, {
          what: write.what,
          sameShape: write.sameShape,
          from: write.from,
          to: write.to,
          keys: write.keys.length > 0 ? new Set(write.keys) : null,
        });
        continue;
      }
      if ((write.what & ROW_WRITE_GEOMETRY) !== 0) {
        if ((held.what & ROW_WRITE_GEOMETRY) !== 0) {
          held.sameShape &&= write.sameShape;
          if (write.to > write.from) {
            held.from = held.to > held.from ? Math.min(held.from, write.from) : write.from;
            held.to = Math.max(held.to, write.to);
          }
        } else {
          held.sameShape = write.sameShape;
          held.from = write.from;
          held.to = write.to;
        }
      }
      held.what |= write.what;
      if (write.keys.length > 0) {
        held.keys ??= new Set();
        for (const key of write.keys) held.keys.add(key);
      }
    }
    this.options.requestRepaint();
  }

  /**
   * Starts a frame: the budget of the builds of the frame, and the batches made again when the
   * rendering pixel ratio changed (they keep being drawn until then)
   */
  beginFrame(): void {
    // A frame that had no pass before its main one writes what was queued now
    if (!this.prepared) this.prepareUploads();
    this.frameCount++;
    this.prepared = false;
    this.lastDrawMs = this.drawMs;
    this.drawMs = 0;
    this.budget = createChunkBuildBudget(this.options.buildBudgetMs ?? TABLE_BUILD_BUDGET_MS);
    this.pending = false;
    // A new pixel ratio: the batches by kind hold their widths and are built again (drawn until
    // then); the chunks drawn in one draw keep theirs, the values of their styles are written
    // again (`ensureRowsStyles`)
    const dpr = resolvePixelRatio(this.options.pixelRatio);
    if (this.builtPixelRatio !== null && this.builtPixelRatio !== dpr) this.invalidateByKind();
    this.builtPixelRatio = dpr;
  }

  /**
   * Takes in the row groups waiting in the tables, first in the budget of the frame (another
   * frame is asked for when groups are left)
   */
  advanceTables(tables: FeatureTablesInternals): void {
    // The next versions of the row groups wait for the chunks of the drawing
    if (!this.attached.has(tables)) this.attached.set(tables, tables.attachReceiver(this.receiver));
    if (!tables.hasPendingWork) return;
    const budget = this.budget ?? createChunkBuildBudget(TABLE_BUILD_BUDGET_MS);
    this.budget = budget;
    if (tables.hasQueuedBlocks && tables.advanceQueuedBlocks(budget)) this.pending = true;
    tables.advanceVersions(budget);
    if (tables.hasPendingWork) this.pending = true;
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
    if (rows) this.ensureRowsStyles(cache, rows, tables);
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

    // The rows of the delta, at their places among the groups (drawn as they are packed, or at
    // once while they are not)
    cache.bounds = bounds;
    cache.drawing = drawing;
    cache.drawnFrame = this.frameCount;
    const inserts = this.deltaInserts(table);
    const pass = this.pass;
    pass.delta = cache.delta?.group === table.delta.group && !cache.deltaStale ? cache.delta : null;
    pass.deltaGroup = table.delta.group;
    pass.oneDraw = drawing === 'one-draw';
    pass.layer = layer;
    pass.deps = deps;
    pass.tables = tables;
    pass.settled = settled;
    this.writeStats.cuts = 0;
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

    // The chunks of the layer are drawn as one run of retained draws (draw-run.ts), ended
    // around the rows drawn at once and with the layer
    const run = renderers.run;
    const started = chunkClock();
    run?.begin();
    try {
      for (let g = 0; g < table.groupCount; g++) {
        const group = table.groupAt(g);
        const groupCache = cache.groups.get(group.handle);
        pass.inserts = inserts.get(g) ?? null;
        pass.insertAt = 0;
        if (!groupCache) {
          this.drawInserts(Number.MAX_SAFE_INTEGER);
          continue;
        }
        // The chunks of a group whose state is not written yet are built, not drawn (the rows
        // drawn at once read their state as it is)
        pass.group = group;
        pass.groupCache = groupCache;
        pass.groupIndex = g;
        pass.binding = groupCache.binding;

        // The styles of the rows are resolved again a group at a time, within the budget (the
        // group keeps drawing the styles it has until then)
        if (groupCache.styleGeneration !== cache.styleGeneration) {
          if (budget.canStep()) budget.step(() => this.restyleGroup(cache, groupCache));
          else this.pending = true;
        }

        const choice = choices[g];
        const own = drawing === 'one-draw' ? groupCache.oneDraw : groupCache.byKind;
        if (choice !== drawing) {
          // The chunks of the drawing are built without being drawn, and the group is drawn
          // with the chunks of the other drawing, as they are
          pass.drawing = false;
          this.advance(tables, settled, drawing);
          pass.drawing = true;
          const theirs = choice === 'one-draw' ? groupCache.oneDraw : groupCache.byKind;
          if (theirs) {
            this.drawBuilt(tables, settled, theirs.retiring ?? theirs.chunks, bounds);
          }
        } else if (own?.retiring && !builtInView(own.chunks, bounds)) {
          // Cut again: the chunks of the new cut are built without being drawn, and the group is
          // drawn with the chunks of the cut before until they are built in view
          pass.drawing = false;
          this.advance(tables, settled, drawing);
          pass.drawing = true;
          this.drawBuilt(tables, settled, own.retiring, bounds);
          this.pending = true;
        } else {
          if (own?.retiring) this.retire(own);
          this.advance(tables, settled, drawing);
        }
        // The rows of the delta after the last chunk of the group
        this.drawInserts(Number.MAX_SAFE_INTEGER);
      }
      // The rows of the delta of a layer without groups, or after its last one
      pass.inserts = inserts.get(-1) ?? null;
      pass.insertAt = 0;
      this.drawInserts(Number.MAX_SAFE_INTEGER);
      // The chunks of the next versions of the groups, built without being drawn
      pass.inserts = null;
      this.advanceVersions(cache, tables, table, layer, deps, drawing, settled);
    } finally {
      run?.end();
      this.drawMs += chunkClock() - started;
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
      pass.inserts = null;
      pass.delta = null;
      pass.deltaGroup = null;
      pass.layer = null;
      pass.deps = null;
      pass.tables = null;
    }
    // Too many cuts: the next versions of the groups with the most go first
    if (this.writeStats.cuts > SPLIT_BUDGET) {
      const counts = [...inserts]
        .filter(([g]) => g >= 0)
        .map(([g, list]) => [table.groupAt(g).handle, list.length] as const)
        .sort((a, b) => b[1] - a[1]);
      tables.urgeVersions(counts.map(([handle]) => handle));
    }
  }

  // === The next versions of the row groups ===

  /**
   * Builds the chunks of the next versions of the groups of a layer that are built and wait for
   * their GPU side, without drawing them (within the budget, once the camera is still unless the
   * drawing is given a budget for them while it moves)
   */
  private advanceVersions(
    cache: LayerCache,
    tables: FeatureTablesInternals,
    table: LayerTable,
    layer: Layer,
    deps: StoreRetainedDrawDeps,
    drawing: Drawing,
    settled: boolean,
  ): void {
    const versions = tables.builtVersions(table.layerId);
    if (versions.length === 0) return;
    const pass = this.pass;
    const schedule = this.schedule;
    const moving = this.versionBudgetWhileMovingMs;
    if (!settled && moving > 0) {
      schedule.settled = true;
      schedule.budget = createChunkBuildBudget(moving);
    }
    pass.drawing = false;
    for (const version of versions) {
      let caches = this.pendingCaches.get(version);
      if (!caches) {
        caches = (version.groups ?? []).map((group) => newGroupCache(group, cache.styleGeneration));
        this.pendingCaches.set(version, caches);
      }
      for (const groupCache of caches) {
        pass.group = groupCache.group;
        pass.groupCache = groupCache;
        pass.groupIndex = -1;
        if (groupCache.styleGeneration !== cache.styleGeneration) {
          this.restyleGroup(cache, groupCache);
        }
        this.chunksOf(cache, groupCache, drawing, tables, table, layer, deps);
        this.advance(tables, settled, drawing);
      }
    }
    pass.drawing = true;
    schedule.settled = settled;
    schedule.budget = this.budget as ChunkBuildBudget;
  }

  /**
   * Whether the GPU side of a next version is up: every chunk of the drawing of its layer that
   * meets the view is built (a layer not drawn last frame waits for nothing)
   */
  private versionUploaded(version: GroupVersion): boolean {
    const cache = this.layers.get(version.layer.layerId);
    if (!cache || cache.drawnFrame < this.frameCount - 1) return true;
    const caches = this.pendingCaches.get(version);
    const groups = version.groups ?? [];
    if (!caches || caches.length !== groups.length) return false;
    for (const groupCache of caches) {
      const held = cache.drawing === 'one-draw' ? groupCache.oneDraw : groupCache.byKind;
      if (!held || held.generation !== cache.generation) return false;
      if (!builtInView(held.chunks, cache.bounds)) return false;
    }
    return true;
  }

  /** A next version replaced its groups: its chunks are the ones of its groups from now */
  private versionSwapped(version: GroupVersion): void {
    const caches = this.pendingCaches.get(version) ?? [];
    this.pendingCaches.delete(version);
    const cache = this.layers.get(version.layer.layerId);
    if (!cache) {
      for (const groupCache of caches) this.disposeGroup(groupCache);
      return;
    }
    for (const old of version.replaces) {
      const groupCache = cache.groups.get(old.handle);
      if (groupCache?.group !== old) continue;
      this.disposeGroup(groupCache);
      cache.groups.delete(old.handle);
    }
    const groups = version.groups ?? [];
    groups.forEach((group, i) => {
      const groupCache = caches[i];
      if (groupCache?.group === group) cache.groups.set(group.handle, groupCache);
    });
  }

  /** A next version was dropped: its chunks are released */
  private versionDropped(version: GroupVersion): void {
    for (const groupCache of this.pendingCaches.get(version) ?? []) this.disposeGroup(groupCache);
    this.pendingCaches.delete(version);
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
      // The rows of the delta are packed again before the next frame
      cache.deltaStale = true;
      if (!keepDrawing) cache.slots = null;
    }
  }

  /** Makes the batches by kind again (they keep being drawn until the new ones are built) */
  private invalidateByKind(): void {
    for (const cache of this.layers.values()) {
      for (const groupCache of cache.groups.values()) {
        for (const chunk of allChunks(groupCache)) {
          if (chunk.type === 'retained') this.invalidateChunk(chunk, true);
        }
      }
    }
  }

  /**
   * Resolves the styles of the rows of a group again (a new style rule, new pictures): in one
   * draw, a row whose style changed within the layout of its instances is written by its style,
   * another packed again into its place (a row that does not fit makes its chunk build again,
   * drawn until then), and a chunk being built builds again; the batches by kind are built again
   */
  private restyleGroup(cache: LayerCache, groupCache: GroupCache): void {
    groupCache.styleGeneration = cache.styleGeneration;
    if (groupCache.byKind) {
      for (const chunk of groupCache.byKind.chunks) {
        if (chunk.type === 'retained') this.invalidateChunk(chunk, true);
      }
    }
    const rows = this.renderers?.rows;
    const rowsStyles = cache.rowsStyles;
    if (!groupCache.oneDraw || !rows || !rowsStyles || !cache.context) return;
    const context = this.packContext(groupCache, cache);
    const group = groupCache.group;
    for (const chunk of groupCache.oneDraw.chunks) {
      if (chunk.type !== 'rows') continue;
      if (chunk.job) {
        this.invalidateChunk(chunk, true);
        continue;
      }
      const gpu = chunk.batches;
      if (!gpu) continue;
      if (gpu.data.palette !== rowsStyles.palette) {
        this.invalidateChunk(chunk, true);
        continue;
      }
      for (let local = 0; local < gpu.data.rows; local++) {
        const row = chunk.range.from + local;
        const held = gpu.data.rowStyle[local];
        const style = resolveRowStyle(group, row, context);
        if (style === held) continue;
        if (style >= 0 && held >= 0 && rowsStyles.layoutOf(style) === rowsStyles.layoutOf(held)) {
          rowsStyles.palette.retain(style);
          rows.patchRowStyle(gpu, local, style, styleCreatedZoom(group, row, rowsStyles, style));
          continue;
        }
        const draft = new RowsDraft(1, row, undefined, rowsStyles.palette);
        collectRow(group, row, 0, draft, gpu.data.origin, context);
        const patch = draft.finish(gpu.data.origin, gpu.data.palette, gpu.data.sprites);
        if (!rows.patchRows(gpu, local, patch)) {
          draft.releaseStyles();
          this.invalidateChunk(chunk, true);
          break;
        }
      }
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
    for (const detach of this.attached.values()) detach();
    this.attached.clear();
    for (const caches of this.pendingCaches.values()) {
      for (const groupCache of caches) this.disposeGroup(groupCache);
    }
    this.pendingCaches.clear();
    for (const cache of this.layers.values()) {
      for (const groupCache of cache.groups.values()) this.disposeGroup(groupCache);
      if (cache.delta) this.disposeGroup(cache.delta);
      cache.delta = null;
      if (cache.rowsStyles) this.renderers?.rows?.retirePalette(cache.rowsStyles.palette);
    }
    this.layers.clear();
    this.cachedFeatures = 0;
    this.renderers = null;
  }

  // === The writes in place ===

  /**
   * Writes the rows written in place since the last pass into the chunks that draw them: a row
   * that keeps its shape by its coordinates only, a row whose style changed within the layout of
   * its instances by its style only, another row packed again into its place in its chunk when it
   * fits. A row that does not fit its place, or is classified otherwise, goes to the delta of its
   * layer (a row of the delta makes the delta be packed again), and a row of a chunk being built
   * makes the build start again from its columns
   */
  private applyWrites(): void {
    if (this.written.size === 0) return;
    for (const [layerId, groups] of this.written) {
      const cache = this.layers.get(layerId);
      if (!cache) continue;
      const delta = cache.tables?.layerTable(layerId)?.delta;
      const away: number[] = [];
      for (const [handle, rows] of groups) {
        const ofDelta = delta?.handle === handle;
        const groupCache = ofDelta
          ? cache.delta?.group === delta.group
            ? cache.delta
            : null
          : cache.groups.get(handle);
        if (!groupCache) continue;
        for (const [row, write] of rows) {
          if (this.applyWrite(cache, groupCache, row, write)) continue;
          if (ofDelta) cache.deltaStale = true;
          else away.push(groupCache.group.data.handles[row]);
        }
      }
      if (away.length > 0) cache.tables?.toDelta(away);
    }
    this.written.clear();
  }

  /**
   * Writes one row written in place into the chunks that draw it
   *
   * @returns false when the row cannot be written there (it does not fit its place, or it is
   *   classified otherwise)
   */
  private applyWrite(
    cache: LayerCache,
    groupCache: GroupCache,
    row: number,
    write: PendingWrite,
  ): boolean {
    const group = groupCache.group;
    const drawn = this.writeIsDrawn(cache, write);
    // What the classification of a row reads (its type, its style, and what an extension reads
    // of its feature) may have changed with any write but of its state
    const classified = (write.what & ~ROW_WRITE_STATE) !== 0;
    const stats = this.writeStats;
    let oneDrawChunk: OneDrawRowsChunk | null = null;
    for (const [held, oneDraw] of [
      [groupCache.byKind, false],
      [groupCache.oneDraw, true],
    ] as const) {
      const chunk = held?.chunks.find((c) => row >= c.range.from && row < c.range.to);
      if (!held || !chunk) continue;
      if (classified && !this.classifiedAs(cache, groupCache, row, chunk.range.kind, oneDraw)) {
        // Another kind of run (drawn at once, by another kind, with other pictures): the row is
        // drawn from the delta (J13 of the design)
        stats.reclassified++;
        return false;
      }
      if (chunk.type === 'immediate') {
        if (chunk.features && row - chunk.range.from < chunk.filled && cache.tables) {
          // The feature kept for the row is made again from its columns
          chunk.features[row - chunk.range.from] = rowHasGeometry(group, row)
            ? rowFeature(cache.tables.readContext, cache.layer?.id ?? '', group, row)
            : null;
        }
      } else if (chunk.type === 'retained') {
        // The batches by kind hold their rows: built again (drawn until then)
        if (drawn) this.invalidateChunk(chunk, true);
      } else {
        oneDrawChunk = chunk;
      }
    }
    const chunk = oneDrawChunk;
    if (!drawn || !chunk) return true;
    if ((write.what & ROW_WRITE_GEOMETRY) !== 0) {
      // The extent of the chunk only widens, so a row moved out of it is not culled with it
      const b = group.data.rowBounds;
      const at = row * 4;
      if (!Number.isNaN(b[at])) {
        chunk.bounds = widenBounds(chunk.bounds, b[at], b[at + 1], b[at + 2], b[at + 3]);
      }
    }
    if (chunk.job) {
      // Being built: the build starts again from the columns as written
      this.invalidateChunk(chunk, true);
      stats.restarted++;
      return true;
    }
    const gpu = chunk.batches;
    const rows = this.renderers?.rows;
    const rowsStyles = cache.rowsStyles;
    if (!gpu || !rows || !rowsStyles || !cache.context) return true;
    if (gpu.data.palette !== rowsStyles.palette) {
      // Built with the styles before: built again with the new ones (drawn until then)
      this.invalidateChunk(chunk, true);
      return true;
    }
    const context = this.packContext(groupCache, cache);
    const local = row - chunk.range.from;
    const held = gpu.data.rowStyle[local];
    const styleWritten =
      (write.what & ROW_WRITE_STYLE) !== 0 || this.ruleKeyWritten(cache, write.keys);

    // The positions only: the row keeps its shape and its style, and is not dashed
    if (
      (write.what & ROW_WRITE_GEOMETRY) !== 0 &&
      write.sameShape &&
      !styleWritten &&
      (rowsStyles.layoutOf(held) & ROWS_LAYOUT.dashed) === 0
    ) {
      if (write.to > write.from) {
        const firstCoord = gpu.data.coordFirst[local];
        const coords = this.scratch.coords;
        const draft = new RowCoordsDraft(write.from, write.to, (n, x, y) => {
          coords[0] = x;
          coords[1] = y;
          rows.patchCoords(gpu, firstCoord + n, coords, 1);
        });
        collectRow(group, row, 0, draft, gpu.data.origin, context);
      }
      stats.inPlace++;
      stats.coordsOnly++;
      return true;
    }

    // The style only: a style of the same layout of instances
    if ((write.what & ROW_WRITE_GEOMETRY) === 0) {
      const style = resolveRowStyle(group, row, context);
      if (style === held) return true;
      if (style >= 0 && held >= 0 && rowsStyles.layoutOf(style) === rowsStyles.layoutOf(held)) {
        rowsStyles.palette.retain(style);
        rows.patchRowStyle(gpu, local, style, styleCreatedZoom(group, row, rowsStyles, style));
        stats.inPlace++;
        stats.styleOnly++;
        return true;
      }
    }

    // The row packed again into its place, when it fits
    const draft = new RowsDraft(1, row, undefined, rowsStyles.palette);
    collectRow(group, row, 0, draft, gpu.data.origin, context);
    if (
      rows.patchRows(gpu, local, draft.finish(gpu.data.origin, gpu.data.palette, gpu.data.sprites))
    ) {
      stats.inPlace++;
      return true;
    }
    // It does not fit its place: drawn from the delta
    draft.releaseStyles();
    stats.rebuilt++;
    return false;
  }

  /** Whether a write changes what is drawn of a row (its geometry, its style, its rule color) */
  private writeIsDrawn(cache: LayerCache, write: PendingWrite): boolean {
    if ((write.what & (ROW_WRITE_GEOMETRY | ROW_WRITE_STYLE)) !== 0) return true;
    return this.ruleKeyWritten(cache, write.keys);
  }

  /** Whether an attribute the style rule of the layer reads is among the keys written */
  private ruleKeyWritten(cache: LayerCache, keys: ReadonlySet<string> | null): boolean {
    const rule = cache.layer?.styleRule;
    if (!keys || !rule || rule.kind === 'single') return false;
    return keys.has(rule.property);
  }

  /**
   * Whether a row is classified as its chunk was cut: the kind of its run (and in one draw the
   * source of its pictures) as it is now. A write that changes it cannot be written in place
   * (J13 of the design)
   */
  private classifiedAs(
    cache: LayerCache,
    groupCache: GroupCache,
    row: number,
    kind: TableRunKind,
    oneDraw: boolean,
  ): boolean {
    const tables = cache.tables;
    const deps = cache.deps;
    const layer = cache.layer;
    if (!tables || !deps || !layer || !cache.slots) return false;
    let source: RowSpriteSource | undefined;
    const now = classifyRow(groupCache.group, row, {
      slots: cache.slots,
      customTypes: deps.customRenderers,
      companions: deps.companions as FeatureCompanionRegistry,
      featureOf: (rows, r) => rowFeature(tables.readContext, layer.id, rows, r),
      layer,
      oneDraw,
      onSprite: (_r, found) => {
        source = found;
      },
    });
    // A row without a geometry joins the run it is in
    if (now !== null && now !== kind) return false;
    return !oneDraw || kind !== 'rows' || source === groupCache.sprites.get(row);
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
   * Sets the time the chunks of the next versions of row groups may take to build in a frame
   * while the camera moves (0: they are built once it is still)
   */
  setVersionBudgetWhileMoving(ms: number): void {
    this.versionBudgetWhileMovingMs = Math.max(0, ms);
  }

  /** The chunks the rows of the delta of a layer are packed in (for the tests) */
  deltaChunks(layerId: string): RowsGpuChunk[] {
    const chunks = this.layers.get(layerId)?.delta?.oneDraw?.chunks ?? [];
    return chunks.flatMap((chunk) =>
      chunk.type === 'rows' && chunk.batches ? [chunk.batches] : [],
    );
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
        styleGeneration: 0,
        context: null,
        rowsStyles: null,
        layer: null,
        deps: null,
        tables: null,
        delta: null,
        deltaStale: false,
        bounds: WORLD,
        drawing: 'one-draw',
        drawnFrame: -1,
      };
      this.layers.set(table.layerId, cache);
    }
    cache.layer = layer;
    cache.deps = deps;
    cache.tables = tables;
    const companions = deps.companions;
    const spriteRevisions = spriteRevisionsOf(deps.customRenderers);
    // What the classification reads: the resolution of the styles, the providers of companions,
    // the pictures of the custom types. A new style rule only changes the colors, so the rows
    // keep their classification and only their styles are resolved again
    const reclassified =
      cache.slots === null ||
      cache.slots.resolver !== renderers.styles ||
      cache.companionsGeneration !== companions.generation() ||
      cache.spriteRevisions !== spriteRevisions;
    const restyled =
      cache.slots === null ||
      cache.slots.resolver !== renderers.styles ||
      cache.rule !== layer.styleRule ||
      cache.spriteRevisions !== spriteRevisions;
    if (restyled) {
      cache.slots = new RowStyleSlots(renderers.styles, tables.styles, layer.styleRule);
      cache.rule = layer.styleRule;
      cache.styleGeneration++;
    }
    if (reclassified) {
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
      // Its chunks are built with the styles as they are resolved now
      cache.groups.set(group.handle, newGroupCache(group, cache.styleGeneration));
    }
    return cache;
  }

  /**
   * The styles of the drawing in one draw of a layer: kept with their numbers for a new style
   * rule (the rows resolve their styles again, `restyleGroup`) and for a new pixel ratio (their
   * values are written again), made again only with a new resolution of the styles (the chunks
   * built with the old ones keep them until they are built again)
   */
  private ensureRowsStyles(
    cache: LayerCache,
    rows: RowsRenderer,
    tables: FeatureTablesInternals,
  ): void {
    const slots = cache.slots as RowStyleSlots;
    const current = cache.rowsStyles;
    const pixelRatio = this.options.pixelRatio;
    if (current && current.slots.resolver === slots.resolver) {
      current.slots = slots;
      current.setPixelRatio(pixelRatio);
      return;
    }
    if (current) rows.retirePalette(current.palette);
    cache.rowsStyles = new RowsStyles(slots, new RowsPalette(), pixelRatio, tables.styles);
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
    // A group cut before is cut again within the budget of the frames (it keeps drawing its
    // chunks until then); a group cut for the first time is cut now
    const budget = this.budget;
    if (held && budget) {
      if (!budget.canStep()) {
        this.pending = true;
        return held.chunks;
      }
      return budget.step(() =>
        this.cutGroup(cache, groupCache, drawing, tables, table, layer, deps, held),
      );
    }
    return this.cutGroup(cache, groupCache, drawing, tables, table, layer, deps, held);
  }

  /** Cuts the rows of a group into chunks for a drawing (see `chunksOf`) */
  private cutGroup(
    cache: LayerCache,
    groupCache: GroupCache,
    drawing: Drawing,
    tables: FeatureTablesInternals,
    table: LayerTable,
    layer: Layer,
    deps: StoreRetainedDrawDeps,
    held: GroupChunks<TableChunk> | null,
  ): TableChunk[] {
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
    if (oneDraw) groupCache.sprites = sprites;
    const next: GroupChunks<TableChunk> = held
      ? this.reuseChunks(held, ranges, oneDraw)
      : { chunks: ranges.flatMap((range) => this.makeChunk(range)), generation: 0, retiring: null };
    next.generation = cache.generation;
    if (oneDraw) groupCache.oneDraw = next as GroupChunks<OneDrawChunk>;
    else groupCache.byKind = next as GroupChunks<KindChunk>;
    return next.chunks;
  }

  /**
   * The chunks of new ranges. A chunk of the same rows and kind is kept: as it is in one draw
   * (its rows resolve their styles again when the styles changed), built again by kind (the
   * batches by kind hold their styles). When the ranges changed, the chunks of the cut before
   * keep being drawn until the new ones are built in view (`retiring`)
   */
  private reuseChunks(
    held: GroupChunks<TableChunk>,
    ranges: OrderedChunkRange[],
    oneDraw: boolean,
  ): GroupChunks<TableChunk> {
    // The chunks drawn now: the cut before when one is still being replaced
    const drawn = held.retiring ?? held.chunks;
    const byRange = new Map<string, TableChunk>();
    for (const chunk of [...held.chunks, ...drawn]) byRange.set(rangeKey(chunk.range), chunk);
    const chunks = ranges.flatMap((range) => {
      const kept = byRange.get(rangeKey(range));
      if (!kept) return this.makeChunk(range);
      if (!oneDraw) this.invalidateChunk(kept, true);
      return [kept];
    });
    // The chunks of the last cut not kept are released (they were never drawn)
    const kept = new Set(chunks);
    for (const chunk of held.chunks) {
      if (!kept.has(chunk) && !drawn.includes(chunk)) this.invalidateChunk(chunk, false);
    }
    const same = chunks.length === drawn.length && chunks.every((chunk, i) => chunk === drawn[i]);
    if (same) return { chunks, generation: held.generation, retiring: null };
    return { chunks, generation: held.generation, retiring: drawn };
  }

  /**
   * Releases the chunks of the cut before of a group once the chunks of the new cut are built in
   * view (the ones the new cut kept stay)
   */
  private retire(held: GroupChunks<TableChunk>): void {
    const retiring = held.retiring;
    if (!retiring) return;
    const kept = new Set(held.chunks);
    for (const chunk of retiring) if (!kept.has(chunk)) this.invalidateChunk(chunk, false);
    held.retiring = null;
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
    for (const chunk of new Set([...held.chunks, ...(held.retiring ?? [])])) {
      this.invalidateChunk(chunk, false);
    }
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

  /**
   * Writes the textures of the state of the rows of every group whose state changed since they
   * were written (made for a group seen for the first time). Called in the pass before the main
   * one, with the chunks and the writes in place, so a state takes effect in the frame its texture
   * is written, as a chunk is drawn from the frame it is written
   */
  private uploadStates(): void {
    for (const cache of this.layers.values()) {
      const caches = cache.delta ? [...cache.groups.values(), cache.delta] : cache.groups.values();
      for (const groupCache of caches) {
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
        if (!texture) continue;
        if (groupCache.uploadedVersion !== group.stateVersion) {
          uploadRowState(this.options.gl, texture, group.gpuState);
          groupCache.uploadedVersion = group.stateVersion;
        }
        // The binding is kept with the group (the translations are the one array of the renderer)
        if (groupCache.binding?.texture !== texture) {
          groupCache.binding = { texture, translations: this.translations };
        }
      }
    }
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
  private advance(tables: FeatureTablesInternals, settled: boolean, drawing: Drawing): void {
    const pass = this.pass;
    const groupCache = pass.groupCache as GroupCache;
    const held = drawing === 'one-draw' ? groupCache.oneDraw : groupCache.byKind;
    if (!held) return;
    for (const chunk of held.chunks) {
      // The rows of the delta before the chunk
      this.drawInserts(chunk.range.from);
      if (chunk.type === 'immediate') {
        if (!pass.drawing) continue;
        this.drawImmediate(tables, chunk, settled);
        continue;
      }
      const pending =
        chunk.type === 'rows'
          ? advanceChunkBuild(chunk, this.schedule, this.oneDrawHost)
          : advanceChunkBuild(chunk, this.schedule, this.host);
      if (pending) this.pending = true;
      // The rows of the delta within the chunk, when it was not drawn
      this.drawInserts(chunk.range.to - 1);
    }
  }

  /** Draws the chunks of the group being drawn for a drawing as they are built, in view */
  private drawBuilt(
    tables: FeatureTablesInternals,
    settled: boolean,
    chunks: readonly TableChunk[],
    bounds: BoundingBox,
  ): void {
    for (const chunk of chunks) {
      this.drawInserts(chunk.range.from);
      if (chunk.type === 'immediate') {
        this.drawImmediate(tables, chunk, settled);
      } else if (chunk.batches && meets(chunk.bounds, bounds)) {
        if (chunk.type === 'rows') this.drawOneDraw(chunk);
        else this.drawRetained(chunk);
      }
      this.drawInserts(chunk.range.to - 1);
    }
  }

  /** Draws a retained chunk of the group being drawn, in ranges cut at the places given */
  private drawRetained(state: RetainedRowsChunk): void {
    if (!state.batches?.batch || !this.pass.binding) return;
    this.drawCut(state, (from, to) => this.drawRange(state, from, to));
  }

  /** Draws a chunk drawn in one draw of the group being drawn, in ranges cut at the places given */
  private drawOneDraw(state: OneDrawRowsChunk): void {
    if (!state.batches || !this.pass.binding) return;
    this.drawCut(state, (from, to) => this.drawOneDrawRange(state, from, to));
  }

  /**
   * Draws the rows of a chunk in ranges cut at the places the pass gives for it, and at the
   * places of the rows of the delta within it (drawn in between)
   */
  private drawCut(state: TableChunk, draw: (from: number, to: number) => void): void {
    const base = state.range.from;
    const rows = state.range.to - base;
    const cuts = this.pass.cutsOf?.get(state);
    let from = 0;
    let c = 0;
    for (;;) {
      const cut = cuts && c < cuts.length ? cuts[c] : rows;
      const insert = this.nextInsert();
      const at = insert !== null && insert < base + rows ? insert - base : rows;
      const next = Math.min(cut, at);
      if (next >= rows) break;
      if (next > from) {
        draw(from, next);
        from = next;
      }
      if (next === at) this.drawInserts(base + at);
      else c++;
    }
    if (rows > from) draw(from, rows);
  }

  /** The row of the group before which the next rows of the delta are drawn (null for none) */
  private nextInsert(): number | null {
    const pass = this.pass;
    const inserts = pass.inserts;
    return inserts && pass.insertAt < inserts.length ? inserts[pass.insertAt].at : null;
  }

  /** Draws the rows of the delta placed before rows of the group up to `row` (included) */
  private drawInserts(row: number): void {
    const pass = this.pass;
    const inserts = pass.inserts;
    if (!inserts || !pass.drawing) return;
    while (pass.insertAt < inserts.length && inserts[pass.insertAt].at <= row) {
      const insert = inserts[pass.insertAt++];
      this.drawDeltaRange(insert.from, insert.to);
    }
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
    chunk: ImmediateRowsChunk,
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
            features[i] = rowHasGeometry(group, row)
              ? rowFeature(tables.readContext, layerId, group, row)
              : null;
          }
          this.cachedFeatures += end - chunk.filled;
          chunk.filled = end;
        });
      }
    }
    if (chunk.filled < count && settled && this.cachedFeatures + count - chunk.filled <= limit) {
      this.pending = true;
    }

    // Drawn in parts at the places of the rows of the delta within the chunk
    let part = from;
    for (let at = this.nextInsert(); ; at = this.nextInsert()) {
      const end = at !== null && at > part && at < to ? at : to;
      this.drawAtOnce(group, part, end, (i) =>
        chunk.features && i - from < chunk.filled ? chunk.features[i - from] : null,
      );
      this.recordRange('immediate', part, end);
      if (end >= to) break;
      this.drawInserts(end);
      part = end;
    }
  }

  /**
   * Draws rows of a group at once, from their features (the ones kept, or made for the rows in
   * view), outside the run of the retained draws: what draws them may change any of the state of
   * the run, and some of it draws without the run
   *
   * @param kept The feature kept for a row (null when none is)
   */
  private drawAtOnce(
    group: RowGroup,
    from: number,
    to: number,
    kept: (row: number) => Feature | null,
  ): void {
    const pass = this.pass;
    const frame = pass.frame as TableLayerFrame;
    const tables = pass.tables as FeatureTablesInternals;
    const bounds = frame.bounds ?? WORLD;
    const rowBounds = group.data.rowBounds;
    const features: Feature[] = [];
    for (let row = from; row < to; row++) {
      const state = group.state[row];
      if ((state & STATE_HIDDEN_MASK) !== 0) continue;
      let feature = kept(row);
      if (!feature) {
        // A row not kept is made when it is in view
        if (!rowHasGeometry(group, row) || !rowInView(rowBounds, row, bounds)) continue;
        feature = rowFeature(tables.readContext, pass.layerId, group, row);
      }
      const set = (state & STATE_MOVE_MASK) >> STATE_MOVE_SHIFT;
      features.push(set > 0 ? translated(feature, this.translations, set) : feature);
    }
    if (features.length === 0) return;
    const run = (pass.renderers as RetainedRendererSet).run;
    run?.end();
    drawImmediateFeatures(
      features,
      pass.layer as Layer,
      frame.projectionData,
      frame.zoom,
      pass.deps as StoreRetainedDrawDeps,
    );
    run?.begin();
  }

  // === The rows of the delta ===

  /**
   * The places of the rows of the delta of a layer among its groups: by the place of a group in
   * the order (-1 for the rows after every group), the rows of the delta to draw before each row
   * of the group, consecutive rows at the same place in one range
   */
  private deltaInserts(table: LayerTable): Map<number, DeltaInsert[]> {
    const out = new Map<number, DeltaInsert[]>();
    const delta = table.delta.group;
    if (!delta) return out;
    const places = table.deltaPlaces();
    let k = 0;
    while (k < delta.data.length) {
      const g = places.groups[k];
      const at = places.cuts[k];
      let end = k + 1;
      while (end < delta.data.length && places.groups[end] === g && places.cuts[end] === at) end++;
      let list = out.get(g);
      if (!list) {
        list = [];
        out.set(g, list);
      }
      list.push({ at, from: k, to: end });
      k = end;
    }
    return out;
  }

  /**
   * Draws the rows `[from, to)` of the delta of the layer being drawn: in one draw from the
   * chunks they are packed in, when the layer is drawn in one draw and they are on the GPU; at
   * once from their features otherwise
   */
  private drawDeltaRange(from: number, to: number): void {
    const pass = this.pass;
    const group = pass.deltaGroup;
    if (!group || to <= from) return;
    const cache = pass.delta;
    const record = (kind: TableRunKind, a: number, b: number): void => {
      this.record?.push({
        layerId: pass.layerId,
        group: cache?.group.handle ?? -1,
        groupIndex: -1,
        kind,
        from: a,
        to: b,
        delta: true,
      });
    };
    this.writeStats.cuts++;
    const chunks = pass.oneDraw && cache?.binding ? cache.oneDraw?.chunks : undefined;
    if (!chunks) {
      this.drawAtOnce(group, from, to, () => null);
      record('immediate', from, to);
      return;
    }
    const rows = (pass.renderers as RetainedRendererSet).rows;
    const { projectionData, zoom } = pass.frame as TableLayerFrame;
    let next = from;
    for (const chunk of chunks) {
      const a = Math.max(next, chunk.range.from);
      const b = Math.min(to, chunk.range.to);
      if (b <= a) continue;
      const gpu = chunk.type === 'rows' ? chunk.batches : null;
      if (gpu?.uploaded && rows) {
        rows.drawRange(
          gpu,
          a - chunk.range.from,
          b - chunk.range.from,
          zoom,
          projectionData,
          (cache as GroupCache).binding as RowStateBinding,
          pass.factors,
        );
        record('rows', a, b);
      } else {
        this.drawAtOnce(group, a, b, () => null);
        record('immediate', a, b);
      }
      next = b;
    }
  }

  /**
   * Packs the rows of the delta of every layer whose rows came in, left or were made again, or
   * whose packing is stale (a write that did not fit, new styles): before the main pass, so they
   * are on the GPU in the frame the copies in their groups are hidden. The rows the drawing in
   * one draw cannot draw are drawn at once
   */
  private packDeltas(): void {
    const rows = this.renderers?.rows ?? null;
    for (const [layerId, cache] of this.layers) {
      const table = cache.tables?.layerTable(layerId);
      if (!table) continue;
      const group = table.delta.group;
      const held = cache.delta;
      const palette = cache.rowsStyles?.palette;
      const current =
        held !== null &&
        held.group === group &&
        !cache.deltaStale &&
        held.styleGeneration === cache.styleGeneration &&
        held.oneDraw?.generation === cache.generation &&
        held.oneDraw.chunks.every((c) => c.type !== 'rows' || c.batches?.data.palette === palette);
      if (current) continue;
      if (held) this.disposeGroup(held);
      cache.delta = null;
      cache.deltaStale = false;
      if (!group) continue;
      const deltaCache = newGroupCache(group, cache.styleGeneration);
      cache.delta = deltaCache;
      const { tables, slots, layer, deps } = cache;
      if (!rows || !tables || !slots || !layer || !deps || !cache.context || !cache.rowsStyles) {
        continue;
      }
      const sprites = new Map<number, RowSpriteSource>();
      const ranges = partitionRowGroup(
        group,
        (row) =>
          classifyRow(group, row, {
            slots,
            customTypes: deps.customRenderers,
            companions: deps.companions as FeatureCompanionRegistry,
            featureOf: (r, k) => rowFeature(tables.readContext, layerId, r, k),
            layer,
            oneDraw: true,
            onSprite: (r, source) => sprites.set(r, source),
          }),
        DELTA_CHUNK_VERTICES,
        (row) => sprites.get(row),
      );
      deltaCache.sprites = sprites;
      const chunks = ranges.flatMap((range) => this.makeChunk(range)) as OneDrawChunk[];
      deltaCache.oneDraw = { chunks, generation: cache.generation, retiring: null };
      const context = this.packContext(deltaCache, cache);
      for (const chunk of chunks) {
        if (chunk.type !== 'rows') continue;
        const origin = normalizeOrigin(chunkOrigin(chunk));
        chunk.batches = packRowsChunk(group, chunk.range, origin, context, rows);
        chunk.origin = origin;
      }
    }
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

/**
 * The created zoom a row writes with its style (none for a point or a picture, whose size is
 * fixed on screen)
 */
function styleCreatedZoom(
  group: RowGroup,
  row: number,
  styles: RowsStyles,
  style: number,
): number | undefined {
  const kind = styles.layoutOf(style) & 7;
  if (kind === ROWS_LAYOUT.point || kind === ROWS_LAYOUT.sprite) return undefined;
  return rowCreatedZoom(group, row);
}

/** The key of a range of rows (its kind and its rows) */
function rangeKey(range: OrderedChunkRange): string {
  return `${range.kind}:${range.from}:${range.to}`;
}

/** Every chunk of a group, of both drawings */
function* allChunks(groupCache: GroupCache): Generator<TableChunk> {
  for (const held of [groupCache.byKind, groupCache.oneDraw]) {
    if (!held) continue;
    yield* held.chunks;
    // The chunks of the cut before not in the new one
    if (held.retiring) {
      const kept = new Set<TableChunk>(held.chunks);
      for (const chunk of held.retiring) if (!kept.has(chunk)) yield chunk;
    }
  }
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
  const palette = context.rowsStyles.palette;
  const draft = new RowsDraft(count, range.from, range.vertices, palette);
  // The pictures of the chunk come from one source (`partitionRowGroup`)
  let sprites: RowSpriteSource | null = null;
  for (let row = range.from; row < range.to && !sprites; row++) {
    sprites = context.spriteSourceOf(row) ?? null;
  }
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
      // The chunk counts the styles of its rows once it is made; the draft until then
      if (chunk) rows.disposeChunk(chunk);
      else draft.releaseStyles();
      chunk = null;
      done = false;
    },
  };
}

/** What is kept for a row group, before its chunks are cut */
function newGroupCache(group: RowGroup, styleGeneration: number): GroupCache {
  return {
    group,
    byKind: null,
    oneDraw: null,
    sprites: new Map(),
    texture: null,
    uploadedVersion: -1,
    binding: null,
    styleGeneration,
  };
}

/**
 * Packs a chunk drawn in one draw at once (the rows of a delta, small and written to the GPU in
 * the pass before the main one of the frame they are packed in)
 */
function packRowsChunk(
  group: RowGroup,
  range: OrderedChunkRange,
  origin: [number, number],
  context: RowsPackContext,
  rows: RowsRenderer,
): RowsGpuChunk {
  const count = range.to - range.from;
  const palette = context.rowsStyles.palette;
  const draft = new RowsDraft(count, range.from, range.vertices, palette);
  // The pictures of the chunk come from one source (`partitionRowGroup`)
  let sprites: RowSpriteSource | null = null;
  for (let row = range.from; row < range.to && !sprites; row++) {
    sprites = context.spriteSourceOf(row) ?? null;
  }
  for (let i = 0; i < count; i++) collectRow(group, range.from + i, i, draft, origin, context);
  return rows.createChunk(draft.finish(origin, palette, sprites));
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
