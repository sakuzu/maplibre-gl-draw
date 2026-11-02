// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The drawing of the layers held as rows of columns (`TableLayerRenderer`)
 *
 * A layer held as rows is drawn in the order of its rows: its row groups in their order, and
 * the GPU chunks of a group (`table-partition.ts`) in theirs. A chunk outside the view is
 * skipped, which keeps the order since a chunk is a run of the order. It is drawn one of two ways:
 *
 * - in one draw (`renderers/rows/`), on a flat map, on the terrain and on the globe: a chunk
 *   holds rows of every kind, points, lines, dashed lines, polygons and the points an extension
 *   draws with pictures, and is drawn in one draw whatever kinds its rows are; it ends only where
 *   a row is drawn at once
 * - by kind, while the program of the drawing in one draw is not ready (and where it cannot be
 *   made): a chunk is a run of rows of one kind, and polygons, solid lines and points are
 *   retained batches of the renderers of their kinds (`table-collect.ts`)
 *
 * On the terrain and on the globe the chunks drawn in one draw hold their rows cut for the
 * surface (`table-surface.ts`): when the surface changes (a step of the mesh, the tiles of the
 * terrain, the cell of the globe) the rows of the chunks in view whose fingerprint changed are
 * packed again into their places a row at a time within the budget, the chunk drawn as it is
 * until then, and a chunk with a row that does not fit is built again. The points of a chunk take
 * the elevation of the ground under them from the heights of the chunk, written on the CPU with
 * the elevation the hit testing uses and read again under the tiles of the terrain that came or
 * went, within the budget.
 *
 * In both, the rows that cannot be in a chunk (images, custom types, features with companions,
 * shapes that are not instanced, and by kind the dashed lines) are drawn at once, from features
 * made from the rows and kept up to a number, the rows in view only, by the extent of what is
 * drawn of them (`table-extents.ts`): a chunk of them out of view is skipped, and the rows in view
 * of a chunk of many rows are found in an index of their extents.
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
 *
 * For the checks of what is drawn it can keep what it writes to the GPU (`keepCopies`: the
 * textures of the state here, the chunks and the palettes in the renderer of the rows) and
 * compare it with the rows: the rows written in place with the same rows packed afresh
 * (`checkWrites`), and everything it keeps with a drawing made again from the rows
 * (`checkRebuild`).
 */

import type { ProjectionData } from 'maplibre-gl';
import type { FeatureTypeRenderer } from '../../extension/renderers.js';
import type { FeatureTablesInternals } from '../../feature-table/feature-tables.js';
import {
  geometryAt,
  type LayerTable,
  type RowGroup,
  widenBounds,
} from '../../feature-table/layer-table.js';
import { rowFeatureToRead, rowHasGeometry, rowType } from '../../feature-table/row-read.js';
import {
  GPU_STATE_BULK,
  GPU_STATE_MOVE_SHIFT,
  MOVE_SETS,
  STATE_BULK,
  STATE_BY_VALUES,
  STATE_HIDDEN_MASK,
  STATE_MOVE_MASK,
  STATE_MOVE_SHIFT,
  STATE_UNIFORM,
  toGpuState,
} from '../../feature-table/row-state.js';
import {
  type InPlaceRowWrite,
  ROW_WRITE_GEOMETRY,
  ROW_WRITE_STATE,
  ROW_WRITE_STYLE,
  ROW_WRITE_VALUES,
  type RowGroupHandle,
} from '../../feature-table/types.js';
import type { GroupVersion, GroupVersionReceiver } from '../../feature-table/versions.js';
import {
  applyEnuEdit,
  type EnuEdit,
  inverseEnuEdit,
  moveEnuPosition,
} from '../../geometry/enu-transforms.js';
import type { SelectionUIConfig } from '../../shared/config/selection.js';
import type { ScreenScaleFrame } from '../../shared/math/screen-scale.js';
import type { BoundingBox, Feature, Layer } from '../../shared/types/model.js';
import type { PixelRatioInput } from '../../shared/utils/pixel-ratio.js';
import { resolvePixelRatio } from '../../shared/utils/pixel-ratio.js';
import {
  roleFieldsOf,
  type TransformFieldsRegistry,
  transformRolesOf,
  transformValuesOf,
} from '../../store/transform-roles.js';
import { buildPackedRTree, type PackedRTree, searchPackedRTree } from '../../table/packed-rtree.js';
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
import { drawnRowText, type RowsCopies } from '../renderers/rows/rows-copies.js';
import {
  ROWS_STYLE_FLOATS,
  type RowSpriteSource,
  type RowsChunkData,
  RowsPalette,
} from '../renderers/rows/rows-format.js';
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
import { anchorElevationMeters } from '../terrain/anchor.js';
import type { TerrainContext } from '../terrain/context.js';
import type { DrapeBounds } from '../terrain/drape/geometry.js';
import { isTerrainCameraMoving } from '../terrain/state.js';
import { type MercatorRect, mercatorX, mercatorY } from '../terrain/tessellation.js';
import type { BulkFramesRenderer, PointFrameExtent } from '../ui/bulk-frames.js';
import type { SelectionExtensionRegistry } from '../ui/selection-ui/index.js';
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
  type RowsSurface,
  resolveRowStyle,
  rowCreatedZoom,
  rowSurfaceKey,
  writeLineRow,
  writePointRow,
  writePolygonRow,
} from './table-collect.js';
import {
  rowsBox,
  TABLE_DRAPE_POINT_REACH_PX,
  TableDrape,
  type TableDrapeDebug,
  type TableDrapeFrame,
  type TableDrapeFrameInput,
  type TableDrapeLayer,
  TableDrapePainter,
  type TableDrapeRank,
  union,
} from './table-drape.js';
import { RowExtents, reachDegrees, widened } from './table-extents.js';
import {
  classifyRow,
  type OrderedChunkRange,
  partitionRowGroup,
  rendererTakesRow,
  rowHasCompanion,
  type TableRunKind,
} from './table-partition.js';
import { TableSurface } from './table-surface.js';

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

/** From how many rows a chunk drawn at once finds its rows in view in an index of their boxes */
const IMMEDIATE_INDEX_FROM = 64;

/** The vertices of polygons packed and written between two looks at the clock */
const SLICE_POLYGON_VERTICES = 2_000;

/** The whole world: the range drawn when the view is not known */
const WORLD: BoundingBox = { minX: -540, minY: -90, maxX: 540, maxY: 90 };
/** No region */
const NO_VIEWS: readonly BoundingBox[] = [];

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
  /** Whether it is the first copy of the world drawn in the frame (true when undefined) */
  readonly firstCopy?: boolean;
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
  /**
   * Whether what is written to the GPU is kept, for the checks of what is drawn (false by
   * default: nothing is kept)
   */
  readonly keepCopies?: boolean;
  /**
   * The fields the custom types of the instance declare, which a feature moved by its moving set
   * is rotated and scaled with (none when it is left out)
   */
  readonly transformFields?: () => TransformFieldsRegistry | null;
  /**
   * The footprints of the custom types of the instance, which the rows drawn at once are drawn in
   * view by (an Image alone has an extent of its own when it is left out)
   */
  readonly extensions?: SelectionExtensionRegistry;
  /**
   * The scale of the frame being drawn, which a footprint of the screen is laid on the ground
   * with (Web Mercator at the zoom of the frame when it is left out or gives none)
   */
  readonly screenScale?: () => ScreenScaleFrame | null;
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

/**
 * How the rows of a chunk drawn in one draw are cut for the surface: the generation of the
 * surface they were last cut or checked for, the fingerprint of the cut of each row
 * (`rowSurfaceKey`), and the row the check against a new surface goes on from
 */
interface ChunkCut {
  generation: number;
  /** The generation the check in progress is for */
  target: number;
  readonly keys: Int32Array;
  at: number;
}

/** A chunk of rows drawn at once */
interface ImmediateRowsChunk {
  readonly type: 'immediate';
  readonly range: OrderedChunkRange;
  /** The feature of each row (null for a row without one), filled over the frames */
  features: Array<Feature | null> | null;
  /** The rows filled so far */
  filled: number;
  /**
   * The union of the extents of its rows (`table-extents.ts`; the bboxes of their positions until
   * the extents are read, null when no row has one): it only widens as its rows are written, so a
   * row moved out of it is not culled with it
   */
  bounds: BoundingBox | null;
  /** How far a row of it reaches on the screen around its extent at most, in pixels */
  reachPx: number;
  /** The generation of the extents of the rows its bounds were made of (-1: not read yet) */
  extentsGeneration: number;
  /**
   * The extents of its rows in a spatial index, made when the chunk has many rows and the view
   * holds only a part of it (dropped when one of its rows is written)
   */
  index: PackedRTree | null;
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
  /** Whether a row is marked as selected in bulk, and the version of the state it was read at */
  bulkMarked: boolean;
  bulkMarkVersion: number;
  /** The generation of the surface the rows of a delta were packed for (-1 for a group) */
  surfaceGeneration: number;
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

/** A drawing made again from the rows of a layer, for the checks (its styles resolved afresh) */
interface FreshDrawing {
  /** The styles of the drawing in one draw, with a palette of their own */
  readonly styles: RowsStyles;
  /** What a row is packed with (its pictures given by `classify`) */
  readonly context: RowPackContext;
  /** The surface the rows are cut for */
  readonly surface: RowsSurface | null;
  /** The kind a row is drawn with in a drawing, and the source of its pictures */
  classify(
    group: RowGroup,
    row: number,
    oneDraw: boolean,
  ): { kind: TableRunKind | null; source: RowSpriteSource | undefined };
}

/** The runs of rows with points of a chunk, between the rows a drape draws (`pointRunsOf`) */
interface PointRuns {
  readonly key: string;
  readonly group: RowGroup;
  /** Per run: its first row, its end (exclusive) and its last row with points, in the chunk */
  readonly runs: Int32Array;
  /** The Mercator box of each run (minX, minY, maxX, maxY) */
  readonly boxes: Float64Array;
  /** How far the markers of each run reach on the screen beyond their positions (CSS px) */
  readonly reach: Float32Array;
  readonly count: number;
  /** The box of every run, and the farthest reach of them (null for no run) */
  readonly box: DrapeBounds | null;
  readonly maxReach: number;
}

/** The frame of the chunk scheduler, set once per layer */
interface SchedulerFrame {
  bounds: BoundingBox;
  zoom: number;
  /** The regions the view sees the rows moved from, for a chunk that holds rows moved (or none) */
  movedViews: readonly BoundingBox[];
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
  /** The surface the rows are cut for, decided once per frame */
  private readonly surfaces = new TableSurface();
  /** The drape of the polygons and the lines of the rows on the terrain (`table-drape.ts`) */
  readonly drape = new TableDrape();
  /** The drape of the frame (null when the rows are drawn by their chunks) */
  private drapeFrame: TableDrapeFrame | null = null;
  /** Draws a layer on the drape, in the order of its rows */
  private readonly painter = new TableDrapePainter();
  /** The runs of rows with points of each chunk drawn on the drape, for the breaks */
  private readonly pointRuns = new WeakMap<object, PointRuns>();
  /** The frame the surface was decided in */
  private surfaceFrame = -1;
  /** How the rows of each chunk drawn in one draw are cut */
  private readonly chunkCuts = new WeakMap<RowsGpuChunk, ChunkCut>();
  /** The generation of the elevations the heights of each chunk were written with */
  private readonly heightGenerations = new WeakMap<RowsGpuChunk, number>();
  /** Whether the uploads of the frame were written before its main pass */
  private prepared = false;
  private readonly translations = new Float32Array((MOVE_SETS + 1) * 2);
  /** The rotation or resize of each moving set (one array of the renderer, as the translations) */
  private readonly transforms: Array<EnuEdit | null> = new Array(MOVE_SETS + 1).fill(null);
  /**
   * The regions the view sees the rows of each moving set from, moved back by its translation and
   * its edit (null for a set that does not move), for the layer being drawn
   */
  private readonly setViews: Array<BoundingBox[] | null> = new Array(MOVE_SETS + 1).fill(null);
  /**
   * The rows the drawing at once looked at in the frame, and of them the rows in view it drew (for
   * the tests and the measurements: the work of a frame follows the rows in view)
   */
  readonly atOnceStats = { visited: 0, drawn: 0 };
  /** The extents of the rows drawn at once, read once per row and again once it is written */
  private readonly rowExtents: RowExtents;
  /** The scale of the frame of the layer being drawn (a footprint of the screen is laid with it) */
  private scaleFrame: ScreenScaleFrame = { zoom: 0, centerLatitude: 0, transition: 0 };
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
    movedViews: [],
    settled: true,
    budget: createChunkBuildBudget(0),
  };
  /** The regions the view sees the rows of the moving sets from (set per layer) */
  private readonly movedViews: BoundingBox[] = [];
  /** The moving sets the rows of a chunk are in (bit k: set k), by the version of its state */
  private readonly chunkMoves = new WeakMap<object, { version: number; sets: number }>();
  /** What the building of the chunks by kind asks of the layer and the group being drawn */
  private readonly host: ChunkSchedulerHost<RetainedRowsChunk, TableChunkBatch>;
  /** What the building of the chunks drawn in one draw asks of them */
  private readonly oneDrawHost: ChunkSchedulerHost<OneDrawRowsChunk, RowsGpuChunk>;
  /** The state each texture of the state was last written with (null when nothing is kept) */
  private readonly stateCopies: WeakMap<RowStateTexture, Uint8Array> | null;
  /** Writes a texture of the state (and keeps what it wrote, when that is kept) */
  private readonly uploadState: (
    gl: WebGL2RenderingContext,
    texture: RowStateTexture,
    state: Uint8Array,
  ) => void;

  constructor(private readonly options: TableLayerRendererOptions) {
    this.versionBudgetWhileMovingMs = options.versionBudgetWhileMovingMs ?? 0;
    this.rowExtents = new RowExtents(options.extensions);
    const stateCopies = options.keepCopies ? new WeakMap<RowStateTexture, Uint8Array>() : null;
    this.stateCopies = stateCopies;
    this.uploadState = stateCopies
      ? (gl, texture, state) => {
          uploadRowState(gl, texture, state);
          stateCopies.set(texture, state.slice(0, texture.rows));
        }
      : uploadRowState;
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
      startJob: (state, origin) => {
        // The chunk is cut for the surface of the frame the build starts in, and its points
        // get their elevations with it (written to the GPU with the chunk)
        const generation = this.surfaces.generation;
        const group = pass.group as RowGroup;
        return oneDrawJob(
          group,
          state.range,
          normalizeOrigin(origin),
          this.packContext(pass.groupCache as GroupCache),
          (pass.renderers as RetainedRendererSet).rows as RowsRenderer,
          (chunk, keys) => {
            this.chunkCuts.set(chunk, { generation, target: generation, keys, at: 0 });
            this.writeHeights(group, chunk, null);
          },
        );
      },
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
    return (
      this.pending || this.renderers?.rows?.hasPendingUploads === true || this.drape.hasPendingWork
    );
  }

  /**
   * The differences between what the drawing keeps of the rows and the rows as they are now
   * (none when they agree), read once a frame is drawn: the texture of the state of the rows of
   * each row group is written from the version of the state the group has, and the features kept
   * for the rows drawn at once are the rows as they read now
   *
   * @internal
   */
  checkCopies(): string[] {
    const problems: string[] = [];
    for (const [layerId, cache] of this.layers) {
      const groups = cache.delta
        ? [...cache.groups.values(), cache.delta]
        : [...cache.groups.values()];
      for (const groupCache of groups) {
        const group = groupCache.group;
        if (groupCache.texture && groupCache.uploadedVersion !== group.stateVersion) {
          problems.push(
            `the state of the rows of the row group ${group.handle} of the layer "${layerId}" is drawn from its version ${groupCache.uploadedVersion}, and the rows are at ${group.stateVersion}`,
          );
        }
        const tables = cache.tables;
        if (!tables) continue;
        const chunks = [
          ...(groupCache.byKind?.chunks ?? []),
          ...(groupCache.oneDraw?.chunks ?? []),
        ];
        for (const chunk of chunks) {
          if (chunk.type !== 'immediate' || !chunk.features) continue;
          for (let i = 0; i < chunk.filled; i++) {
            const kept = chunk.features[i];
            const row = chunk.range.from + i;
            if (!kept || row >= group.data.length) continue;
            const now = rowFeatureToRead(tables.readContext, layerId, group, row);
            if (featureText(kept) !== featureText(now)) {
              problems.push(
                `the feature kept for the row ${row} of the row group ${group.handle} of the layer "${layerId}" is ${featureText(kept)}, and the row reads ${featureText(now)}`,
              );
            }
          }
        }
      }
    }
    return problems;
  }

  /**
   * The differences between the rows written in place in the chunks drawn in one draw since the
   * last look, as the GPU holds them (the writes of their coordinates and of their styles, the
   * rows packed again into their places), and the same rows packed afresh from their columns as
   * a build of their chunk packs them, their styles resolved afresh (none when they agree, and
   * when nothing is kept of what is written to the GPU). Read once a frame is drawn: the rows of
   * a chunk the drawing is making again, or whose writes wait for the next frame, are read once
   * it is made
   *
   * @internal
   */
  checkWrites(): string[] {
    const copies = this.renderers?.rows?.copies;
    if (!copies) return [];
    const problems: string[] = [];
    for (const [layerId, cache] of this.layers) {
      const fresh = this.freshDrawingOf(layerId, cache);
      if (!fresh) continue;
      for (const groupCache of this.checkedGroups(layerId, cache)) {
        const held = groupCache.oneDraw;
        if (!this.isSettled(cache, groupCache, held)) continue;
        for (const chunk of (held as GroupChunks<OneDrawChunk>).chunks) {
          if (chunk.type !== 'rows' || !chunk.batches || !this.cutIsCurrent(chunk)) continue;
          const copy = settledCopy(chunk, copies);
          const written = copies.writtenOf(chunk.batches);
          if (!copy || !written || written.size === 0) continue;
          for (const local of written) {
            this.compareRow(layerId, cache, fresh, groupCache.group, copy, local, problems);
          }
          written.clear();
        }
      }
    }
    return problems;
  }

  /**
   * The differences between everything the drawing keeps of the rows and a drawing made again
   * from the rows as they are now, its styles resolved afresh (none when they agree, and when
   * nothing is kept of what is written to the GPU), read once a frame is drawn:
   *
   * - every row group of a layer drawn is drawn, and every row shown that has a geometry is in a
   *   chunk of each drawing its group has
   * - each row shown is drawn with the kind (in one draw, at once, by the renderer of its kind)
   *   and the pictures a drawing made again draws it with, and a row in a chunk drawn in one draw
   *   draws, as the GPU holds the chunk, what the row packed afresh draws (`drawnRowText`)
   * - the copy of the state of each row in its group draws as the state its rows make now does
   *   (hidden or shown, not why; selected in bulk; moved), the byte the GPU reads is made from
   *   it, and the texture of the state holds those bytes
   * - the texture of the values of the styles of a layer holds the values of the styles used
   *
   * What the drawing marked to be made again and is still making is passed over: a layer not
   * drawn in the last frame or with rows written since, a group whose styles or whose chunks are
   * being made again, a chunk being built, writes and values waiting for the next frame
   *
   * @internal
   */
  checkRebuild(): string[] {
    const copies = this.renderers?.rows?.copies;
    const stateCopies = this.stateCopies;
    if (!copies || !stateCopies) return [];
    const problems: string[] = [];
    for (const [layerId, cache] of this.layers) {
      const fresh = this.freshDrawingOf(layerId, cache);
      const tables = cache.tables;
      const table = tables?.layerTable(layerId);
      if (!fresh || !tables || !table) continue;
      for (let g = 0; g < table.groupCount; g++) {
        const group = table.groupAt(g);
        if (cache.groups.get(group.handle)?.group !== group) {
          problems.push(`the row group ${group.handle} of the layer "${layerId}" is not drawn`);
        }
      }
      for (const groupCache of this.checkedGroups(layerId, cache)) {
        if (problems.length >= CHECK_PROBLEMS) return problems;
        this.checkGroupState(layerId, groupCache, tables, stateCopies, problems);
        const delta = groupCache === cache.delta;
        for (const oneDraw of delta ? [true] : [true, false]) {
          const held = oneDraw ? groupCache.oneDraw : groupCache.byKind;
          if (this.isSettled(cache, groupCache, held)) {
            this.checkGroupChunks(layerId, cache, fresh, groupCache, oneDraw, copies, problems);
          }
        }
      }
      this.checkPalette(layerId, cache, copies, problems);
    }
    return problems;
  }

  /**
   * A drawing made again from the rows of a layer, for the checks: null for a layer not drawn in
   * the last frame, or with rows written in place since (they are written into its chunks with
   * the next frame)
   */
  private freshDrawingOf(layerId: string, cache: LayerCache): FreshDrawing | null {
    const { tables, layer, deps } = cache;
    const renderers = this.renderers;
    if (cache.drawnFrame !== this.frameCount || !tables || !layer || !deps || !renderers) {
      return null;
    }
    if (!cache.rowsStyles || !tables.layerTable(layerId)) return null;
    if ((this.written.get(layerId)?.size ?? 0) > 0) return null;
    const slots = new RowStyleSlots(renderers.styles, tables.styles, layer.styleRule);
    const pixelRatio = this.options.pixelRatio;
    const view = tables.view(layerId);
    return {
      styles: new RowsStyles(slots, new RowsPalette(), pixelRatio, tables.styles),
      context: { slots, strings: tables.strings, pixelRatio, terrain: this.options.terrain },
      surface: this.surfaces.surface,
      classify: (group, row, oneDraw) => {
        let source: RowSpriteSource | undefined;
        const kind = classifyRow(group, row, {
          slots,
          customTypes: deps.customRenderers,
          companions: deps.companions as FeatureCompanionRegistry,
          featureOf: (rows, r) => rowFeatureToRead(tables.readContext, layerId, rows, r),
          view,
          layer,
          oneDraw,
          transformFields: this.options.transformFields?.() ?? null,
          onSprite: (_r, found) => {
            source = found;
          },
        });
        return { kind, source };
      },
    };
  }

  /**
   * Whether the rows of a chunk are cut for the surface of the frame (a chunk being cut again is
   * passed over by the checks)
   */
  private cutIsCurrent(chunk: OneDrawRowsChunk): boolean {
    const cut = chunk.batches ? this.chunkCuts.get(chunk.batches) : undefined;
    return !cut || cut.generation === this.surfaces.generation;
  }

  /** The groups of a layer the checks read: its row groups, and its delta when it is packed */
  private checkedGroups(layerId: string, cache: LayerCache): GroupCache[] {
    const groups = [...cache.groups.values()];
    const delta = cache.delta;
    const table = cache.tables?.layerTable(layerId);
    if (delta && !cache.deltaStale && delta.group === table?.delta.group) groups.push(delta);
    return groups;
  }

  /**
   * Whether the chunks of a group for a drawing are made for the styles and the classification
   * of its layer as they are (not being resolved, cut or replaced again)
   */
  private isSettled(
    cache: LayerCache,
    groupCache: GroupCache,
    held: GroupChunks<TableChunk> | null,
  ): boolean {
    return (
      held !== null &&
      groupCache.styleGeneration === cache.styleGeneration &&
      held.generation === cache.generation &&
      held.retiring === null
    );
  }

  /**
   * The copy of the state of each row of a group against the state its rows make now (what the
   * drawing reads of it), the byte the GPU reads against it, and the texture of the state against
   * those bytes
   */
  private checkGroupState(
    layerId: string,
    groupCache: GroupCache,
    tables: FeatureTablesInternals,
    stateCopies: WeakMap<RowStateTexture, Uint8Array>,
    problems: string[],
  ): void {
    const group = groupCache.group;
    const rows = group.data.length;
    const where = (row: number): string =>
      `the row ${row} of the row group ${group.handle} of the layer "${layerId}"`;
    for (let row = 0; row < rows && problems.length < CHECK_PROBLEMS; row++) {
      const state = group.state[row];
      const made = tables.rowStateOf(group, row);
      if (drawnState(state) !== drawnState(made)) {
        problems.push(`${where(row)} has the state ${state}, and its rows make ${made}`);
      } else if (group.gpuState[row] !== toGpuState(state)) {
        problems.push(
          `${where(row)} gives the GPU the state ${group.gpuState[row]}, and its state makes ${toGpuState(state)}`,
        );
      }
    }
    const texture = groupCache.texture;
    const uploaded = texture ? stateCopies.get(texture) : undefined;
    if (!texture || !uploaded || groupCache.uploadedVersion !== group.stateVersion) return;
    for (let row = 0; row < Math.min(rows, texture.rows); row++) {
      if (problems.length >= CHECK_PROBLEMS) return;
      if (uploaded[row] === group.gpuState[row]) continue;
      problems.push(
        `the texture of the state holds ${uploaded[row]} for ${where(row)}, and the row has ${group.gpuState[row]}`,
      );
    }
  }

  /**
   * The chunks of a group for a drawing against a drawing made again: the rows shown that have a
   * geometry are each in a chunk, drawn with the kind and the pictures a drawing made again
   * draws them with, and a row of a chunk drawn in one draw draws what the row packed afresh
   * draws
   */
  private checkGroupChunks(
    layerId: string,
    cache: LayerCache,
    fresh: FreshDrawing,
    groupCache: GroupCache,
    oneDraw: boolean,
    copies: RowsCopies,
    problems: string[],
  ): void {
    const group = groupCache.group;
    const held = (oneDraw ? groupCache.oneDraw : groupCache.byKind) as GroupChunks<TableChunk>;
    const rows = group.data.length;
    const shown = (row: number): boolean => (group.state[row] & STATE_HIDDEN_MASK) === 0;
    const where = (row: number): string =>
      `the row ${row} of the row group ${group.handle} of the layer "${layerId}"`;
    const covered = new Uint8Array(rows);
    for (const chunk of held.chunks) {
      if (problems.length >= CHECK_PROBLEMS) return;
      const { from, to } = chunk.range;
      covered.fill(1, from, to);
      const copy =
        chunk.type === 'rows' && this.cutIsCurrent(chunk) ? settledCopy(chunk, copies) : null;
      if (copy) {
        for (let local = 0; local < copy.rows; local++) {
          this.compareRow(layerId, cache, fresh, group, copy, local, problems);
        }
        continue;
      }
      // The kind the rows are drawn with (the rows of a chunk not built yet included)
      const drawnAs: TableRunKind = chunk.type === 'immediate' ? 'immediate' : chunk.range.kind;
      for (let row = from; row < to && problems.length < CHECK_PROBLEMS; row++) {
        if (!shown(row)) continue;
        const { kind } = fresh.classify(group, row, oneDraw);
        if (kind === null || kind === drawnAs) continue;
        problems.push(
          `${where(row)} is drawn ${kindText(drawnAs)}, and a drawing made again draws it ${kindText(kind)}`,
        );
      }
    }
    for (let row = 0; row < rows && problems.length < CHECK_PROBLEMS; row++) {
      if (covered[row] || !shown(row) || !rowHasGeometry(group, row)) continue;
      problems.push(
        `${where(row)} is in no chunk of the drawing ${oneDraw ? 'in one draw' : 'by kind'}, and a drawing made again draws it`,
      );
    }
  }

  /**
   * One row of a chunk drawn in one draw, as the GPU holds the chunk, against the row packed
   * afresh from its columns with its styles resolved afresh (a row hidden draws nothing and is
   * passed over)
   */
  private compareRow(
    layerId: string,
    cache: LayerCache,
    fresh: FreshDrawing,
    group: RowGroup,
    copy: RowsChunkData,
    local: number,
    problems: string[],
  ): void {
    if (problems.length >= CHECK_PROBLEMS) return;
    const row = copy.rowBase + local;
    if ((group.state[row] & STATE_HIDDEN_MASK) !== 0) return;
    const where = `the row ${row} of the row group ${group.handle} of the layer "${layerId}"`;
    if (copy.palette !== cache.rowsStyles?.palette) {
      problems.push(`${where} is drawn with the styles resolved before the ones of its layer`);
      return;
    }
    const { kind, source } = fresh.classify(group, row, true);
    if (kind !== null && kind !== 'rows') {
      problems.push(
        `${where} is drawn in one draw, and a drawing made again draws it ${kindText(kind)}`,
      );
      return;
    }
    if (source && source !== copy.sprites) {
      problems.push(`${where} is drawn without the pictures a drawing made again draws it with`);
      return;
    }
    const draft = new RowsDraft(1, row, undefined, null);
    collectRow(group, row, 0, draft, copy.origin, {
      ...fresh.context,
      rowsStyles: fresh.styles,
      surface: fresh.surface,
      spriteSourceOf: (r) => (r === row ? source : undefined),
    });
    const made = draft.finish(copy.origin, fresh.styles.palette, source ?? null);
    const drawn = drawnRowText(copy, local, copy.palette.values);
    const again = drawnRowText(made, 0, fresh.styles.palette.values);
    if (drawn === again) return;
    const [a, b] = firstDifference(drawn, again);
    problems.push(`${where} draws ${a}, and a drawing made again draws ${b}`);
  }

  /** The values of the styles used of a layer, as its texture holds them, against the palette */
  private checkPalette(
    layerId: string,
    cache: LayerCache,
    copies: RowsCopies,
    problems: string[],
  ): void {
    const palette = cache.rowsStyles?.palette;
    const uploaded = palette ? copies.paletteOf(palette) : undefined;
    // Values written since the last upload reach the texture with the next frame
    if (!palette || !uploaded || palette.dirty.size > 0) return;
    for (let style = 0; style < palette.count && problems.length < CHECK_PROBLEMS; style++) {
      if (palette.usesOf(style) <= 0) continue;
      const at = style * ROWS_STYLE_FLOATS;
      const held = Array.from(palette.values.subarray(at, at + ROWS_STYLE_FLOATS));
      const onGpu = Array.from(uploaded.subarray(at, at + ROWS_STYLE_FLOATS));
      if (held.every((value, i) => Object.is(value, onGpu[i]))) continue;
      problems.push(
        `the style ${style} of the layer "${layerId}" is drawn with ${JSON.stringify(onGpu)}, and its values are ${JSON.stringify(held)}`,
      );
    }
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
    // The drape makes the partitions of the rows written again with them
    const table = this.layers.get(layerId)?.tables?.layerTable(layerId);
    if (table) {
      for (const write of writes) {
        const group =
          write.group === table.delta.handle ? table.delta.group : table.group(write.group);
        if (group) this.drape.rowsWritten(layerId, group, [write.row]);
        // Its extent is read again (its footprint may follow any of what was written)
        if (group && (write.what & ~ROW_WRITE_STATE) !== 0)
          this.rowExtents.forget(group, write.row);
      }
    }
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
    this.atOnceStats.visited = 0;
    this.atOnceStats.drawn = 0;
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
   * Prepares the drape of the polygons and the lines of the layers held as rows for a frame on
   * the terrain (`table-drape.ts`): the layers drawn in the last frame, in their order
   *
   * @returns The drape of the frame (null when the rows are drawn by their chunks)
   */
  planDrape(
    tables: FeatureTablesInternals | null,
    layerOrder: readonly string[],
    input: TableDrapeFrameInput,
  ): TableDrapeFrame | null {
    const layers: TableDrapeLayer[] = [];
    if (tables) {
      for (const layerId of layerOrder) {
        const cache = this.layers.get(layerId);
        const table = tables.layerTable(layerId);
        const { slots, layer, deps } = cache ?? {};
        if (!cache || !table || !slots || !layer || !deps || cache.tables !== tables) continue;
        // A layer not drawn in the last frame is not on the drape
        if (cache.drawnFrame < this.frameCount - 1) continue;
        const view = tables.view(layerId);
        const companions = deps.companions as FeatureCompanionRegistry;
        const transformFields = this.options.transformFields?.() ?? null;
        layers.push({
          layerId,
          table,
          slots,
          strings: tables.strings,
          generation: `${cache.generation}:${cache.styleGeneration}`,
          classify: (group, row) =>
            classifyRow(group, row, {
              slots,
              customTypes: deps.customRenderers,
              companions,
              featureOf: (rows, r) => rowFeatureToRead(tables.readContext, layerId, rows, r),
              view,
              layer,
              oneDraw: true,
              transformFields,
              onSprite: () => {},
            }),
          inserts: this.deltaInserts(table),
        });
      }
    }
    this.drapeFrame = this.drape.planFrame(tables, layers, input);
    this.drapeDraws = this.drapeFrameDraws;
    this.drapeBreaks = this.drapeFrameBreaks;
    this.drapePointDraws = this.drapeFramePointDraws;
    this.drapeSteps = this.drapeFrameSteps;
    this.drapeDeepest = this.drapeFrameDeepest;
    this.drapeFrameSteps = 0;
    this.drapeFrameDeepest = 0;
    this.drapeFrameDraws = 0;
    this.drapeFrameBreaks = 0;
    this.drapeFramePointDraws = 0;
    return this.drapeFrame;
  }

  /** What the drape of the rows did in the last frame (for the measurements) */
  drapeDiagnostics(): TableDrapeDebug & {
    binCount: number;
    draws: number;
    breaks: number;
    pointDraws: number;
    splitBytes: number;
    steps: number;
    deepest: number;
  } {
    return {
      ...this.drape.debug,
      binCount: this.drape.index.binCount,
      draws: this.drapeDraws,
      breaks: this.drapeBreaks,
      pointDraws: this.drapePointDraws,
      splitBytes: this.drape.splitBytes,
      steps: this.drapeSteps,
      deepest: this.drapeDeepest,
    };
  }

  /** The draws of the drape of the rows and the breaks among them, in the last frame */
  private drapeDraws = 0;
  private drapeBreaks = 0;
  private drapeFrameDraws = 0;
  private drapeFrameBreaks = 0;
  private drapePointDraws = 0;
  private drapeFramePointDraws = 0;
  private drapeSteps = 0;
  private drapeDeepest = 0;
  private drapeFrameSteps = 0;
  private drapeFrameDeepest = 0;

  /**
   * Draws a layer held as rows, in the order of its rows
   *
   * Where the renderer of the drawing in one draw is there and its program is ready, every chunk
   * of rows is drawn in one draw, on a flat map, on the terrain and on the globe; until then the
   * rows are drawn with the renderers of their kinds. A group whose chunks of one drawing are not
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
    const oneDrawUsable = rows?.ready === true;
    // The program compiles: frames are asked for until it is ready
    if (rows !== null && !oneDrawUsable && rows.compiling) this.pending = true;
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
      this.transforms[k] = tables.states.transform(k);
    }

    const bounds = frame.bounds ?? WORLD;
    setViewsOf(this.translations, this.transforms, bounds, this.setViews);
    this.scaleFrame = this.options.screenScale?.() ?? {
      zoom: frame.zoom,
      centerLatitude: 0,
      transition: 0,
    };
    const settled = !isTerrainCameraMoving(this.options.terrain);
    // The surface the rows are cut for, once per frame
    if (this.surfaceFrame !== this.frameCount) {
      this.surfaceFrame = this.frameCount;
      this.surfaces.update(this.options.terrain, bounds, {
        forEachFill: (view, visit) => this.forEachFill(view, visit),
      });
    }

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
    movedViewsOf(this.transforms, bounds, this.movedViews);
    schedule.movedViews = NO_VIEWS;
    schedule.settled = settled;
    schedule.budget = budget;

    // The chunks of the layer are drawn as one run of retained draws (draw-run.ts), ended
    // around the rows drawn at once and with the layer
    const run = renderers.run;
    const started = chunkClock();
    run?.begin();
    // On the drape, the chunks draw their points alone, between the parts of the drape
    const drapeFrame = drawing === 'one-draw' ? this.drapeFrame : null;
    this.painter.begin(
      drapeFrame && {
        ...drapeFrame,
        enter: () => {
          run?.end();
          drapeFrame.enter();
        },
        leave: () => {
          drapeFrame.leave();
          run?.begin();
        },
      },
      table.layerId,
      pass.factors.opacity,
      // The drape is painted once, with the first copy of the world drawn
      frame.firstCopy !== false,
      // The points are drawn among the drape by their keys once their program is ready
      drapeFrame !== null && (renderers.rows?.keyedReady ?? false),
    );
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
      pass.group = null;
      this.drawInserts(Number.MAX_SAFE_INTEGER);
      // The drape is painted to the end of the layer, and what waits is drawn over it
      this.painter.end();
      this.drapeFrameDraws += this.painter.draws;
      this.drapeFrameBreaks += this.painter.breaks;
      this.drapeFramePointDraws += this.painter.pointDraws;
      this.drapeFrameSteps = Math.max(this.drapeFrameSteps, this.painter.steps);
      this.drapeFrameDeepest = Math.max(this.drapeFrameDeepest, this.painter.deepest);
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
    this.drape.versionSwapped(version);
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
        draft.leavesRoom = false;
        collectRow(group, row, 0, draft, gpu.data.origin, context);
        const patch = draft.finish(gpu.data.origin, gpu.data.palette, gpu.data.sprites);
        if (!rows.patchRows(gpu, local, patch)) {
          draft.releaseStyles();
          this.invalidateChunk(chunk, true);
          break;
        }
        this.rowPacked(group, gpu, local);
      }
    }
  }

  /**
   * Classifies the rows again on the next draw (a custom type or a provider of companions came
   * or went): a chunk that keeps its rows and its kind keeps drawing until it is built again
   */
  reclassify(): void {
    for (const cache of this.layers.values()) cache.slots = null;
    // A custom type came or went, and with it a footprint
    this.rowExtents.clear();
  }

  /** Releases every GPU resource (the batches are built again on the next draw) */
  dispose(renderers?: RetainedRendererSet): void {
    this.drape.releaseGpu();
    this.drapeFrame = null;
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
    // of its feature) may have changed
    const classified = this.writeClassifies(cache, group, row, write);
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
        // drawn from the delta
        stats.reclassified++;
        return false;
      }
      if (chunk.type === 'immediate') {
        if (chunk.features && row - chunk.range.from < chunk.filled && cache.tables) {
          // The feature kept for the row is made again from its columns
          chunk.features[row - chunk.range.from] = rowHasGeometry(group, row)
            ? rowFeatureToRead(cache.tables.readContext, cache.layer?.id ?? '', group, row)
            : null;
        }
        if ((write.what & ~ROW_WRITE_STATE) !== 0) {
          // The extent of the chunk widens by the one of the row as written, and its rows are
          // found in view by their extents as written
          if (chunk.extentsGeneration === this.rowExtents.generation && cache.tables) {
            const tables = cache.tables;
            const local = row - chunk.range.from;
            const extents = this.rowExtents.read(group, row, () =>
              chunk.features && local < chunk.filled && chunk.features[local]
                ? chunk.features[local]
                : rowFeatureToRead(tables.readContext, cache.layer?.id ?? '', group, row),
            );
            const b = extents.boxes;
            const at = row * 4;
            if (!Number.isNaN(b[at])) {
              chunk.bounds = widenBounds(chunk.bounds, b[at], b[at + 1], b[at + 2], b[at + 3]);
            }
            chunk.reachPx = Math.max(chunk.reachPx, extents.reachPx[row]);
          } else if ((write.what & ROW_WRITE_GEOMETRY) !== 0) {
            const b = group.data.rowBounds;
            const at = row * 4;
            if (!Number.isNaN(b[at])) {
              chunk.bounds = widenBounds(chunk.bounds, b[at], b[at + 1], b[at + 2], b[at + 3]);
            }
          }
          chunk.index = null;
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

    // The positions only: the row keeps its shape and its style, and is not dashed; on a surface
    // that cuts the rows, a point (the cut of a line or a polygon follows its positions)
    const layout = rowsStyles.layoutOf(held);
    const kind = layout & 7;
    const pointLike = kind === ROWS_LAYOUT.point || kind === ROWS_LAYOUT.sprite;
    if (
      (write.what & ROW_WRITE_GEOMETRY) !== 0 &&
      write.sameShape &&
      !styleWritten &&
      (layout & ROWS_LAYOUT.dashed) === 0 &&
      (this.surfaces.surface === null || pointLike)
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
        // The points stand where the hit testing finds them
        this.writeRowHeights(group, gpu, local);
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
    draft.leavesRoom = false;
    collectRow(group, row, 0, draft, gpu.data.origin, context);
    if (
      rows.patchRows(gpu, local, draft.finish(gpu.data.origin, gpu.data.palette, gpu.data.sprites))
    ) {
      this.rowPacked(group, gpu, local);
      stats.inPlace++;
      return true;
    }
    // It does not fit its place: drawn from the delta
    draft.releaseStyles();
    stats.rebuilt++;
    return false;
  }

  /**
   * Whether a write may change the classification of its row: a write of its geometry or its
   * style, or of attributes an extension may classify it by (a renderer of its type that may
   * refuse some of its features, a provider of companions that reads a key written or does not
   * tell the keys it reads). A write of its state only, or of attributes no extension reads,
   * changes nothing of it
   */
  private writeClassifies(
    cache: LayerCache,
    group: RowGroup,
    row: number,
    write: PendingWrite,
  ): boolean {
    if ((write.what & ~(ROW_WRITE_STATE | ROW_WRITE_VALUES)) !== 0) return true;
    if ((write.what & ROW_WRITE_VALUES) === 0) return false;
    const deps = cache.deps;
    if (!deps) return true;
    const renderer = deps.customRenderers.get(rowType(group.data, row)) as
      | Pick<FeatureTypeRenderer, 'appliesTo'>
      | undefined;
    if (renderer?.appliesTo) return true;
    const companions = deps.companions as FeatureCompanionRegistry;
    if (!companions.any()) return false;
    return write.keys === null || companions.readsKeys(write.keys);
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
   *
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
      featureOf: (rows, r) => rowFeatureToRead(tables.readContext, layer.id, rows, r),
      view: tables.view(layer.id),
      layer,
      oneDraw,
      transformFields: this.options.transformFields?.() ?? null,
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
    const view = tables.view(table.layerId);
    const transformFields = this.options.transformFields?.() ?? null;
    const ranges = partitionRowGroup(
      group,
      (row) =>
        classifyRow(group, row, {
          slots: cache.slots as RowStyleSlots,
          customTypes: deps.customRenderers,
          companions: deps.companions as FeatureCompanionRegistry,
          featureOf: (rows, r) => rowFeatureToRead(tables.readContext, table.layerId, rows, r),
          view,
          layer,
          oneDraw,
          transformFields,
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
      if (kept.type === 'immediate') {
        // The rows in view are found by their extents as they are now
        kept.bounds = range.bounds;
        kept.extentsGeneration = -1;
        kept.index = null;
      }
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
      return [
        {
          type: 'immediate',
          range,
          features: null,
          filled: 0,
          bounds: range.bounds,
          reachPx: 0,
          extentsGeneration: -1,
          index: null,
        },
      ];
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
   * Draws the frames of the rows marked as selected in bulk, of every layer, one draw per row
   * group holding one (the groups whose textures of the state are written)
   *
   * @param revision Changes with every change of the rows (the extents are read again)
   */
  drawBulkFrames(
    renderer: BulkFramesRenderer,
    projectionData: ProjectionData,
    config: SelectionUIConfig,
    revision: number,
    pointExtent: PointFrameExtent,
  ): void {
    const drawn = new Set<number>();
    for (const cache of this.layers.values()) {
      const caches = cache.delta ? [...cache.groups.values(), cache.delta] : cache.groups.values();
      for (const groupCache of caches) {
        const binding = groupCache.binding;
        if (!binding || !holdsBulkMark(groupCache)) continue;
        drawn.add(groupCache.group.handle);
        renderer.drawGroup(
          groupCache.group,
          binding,
          revision,
          projectionData,
          config,
          pointExtent,
        );
      }
    }
    renderer.retain(drawn);
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
          this.uploadState(this.options.gl, texture, group.gpuState);
          groupCache.uploadedVersion = group.stateVersion;
        }
        // The binding is kept with the group (the translations and the transforms are the arrays
        // of the renderer)
        if (groupCache.binding?.texture !== texture) {
          groupCache.binding = {
            texture,
            translations: this.translations,
            transforms: this.transforms,
          };
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
      surface: this.surfaces.surface,
      spriteSourceOf: (row) => sprites.get(row),
    };
  }

  /**
   * Visits the extents of the polygon rows of every layer drawn whose group meets a view (the
   * coarsening of the fills, decided when the step of the surface changes)
   */
  private forEachFill(
    view: BoundingBox,
    visit: (minX: number, minY: number, maxX: number, maxY: number) => void,
  ): void {
    for (const cache of this.layers.values()) {
      for (const groupCache of cache.groups.values()) {
        const groupBounds = groupCache.group.bounds;
        if (groupBounds && !meets(groupBounds, view)) continue;
        const data = groupCache.group.data;
        const b = data.rowBounds;
        for (let row = 0; row < data.length; row++) {
          const at = row * 4;
          if (Number.isNaN(b[at])) continue;
          const type = rowType(data, row);
          if (type !== 'Polygon' && type !== 'MultiPolygon' && type !== 'Circle') continue;
          visit(b[at], b[at + 1], b[at + 2], b[at + 3]);
        }
      }
    }
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
      // A chunk that holds rows moved by an edit is built around where the view sees them from
      this.schedule.movedViews =
        this.movedViews.length > 0 && this.holdsMovedRows(chunk, pass.group as RowGroup)
          ? this.movedViews
          : NO_VIEWS;
      if (chunk.type === 'rows' && chunk.batches && !chunk.job) {
        // Cut again for the surface, and the elevations of its points read again. On the drape
        // the polygons and the lines are not drawn from the chunk: they are cut again once the
        // layer leaves it (drawn as they are until then), and the points keep their elevations
        if (!this.painter.active) this.cutForSurface(chunk);
        if (chunk.batches) this.updateHeights(chunk);
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

  /**
   * Cuts the rows of a chunk of the group being drawn again for the surface of the frame, once
   * the camera is still and the chunk is in view, within the budget: each row whose fingerprint
   * changed is packed again into its place, a row at a time (the chunk draws its rows as they are
   * until then). A row that does not fit its place makes the chunk build again (drawn until then)
   */
  private cutForSurface(chunk: OneDrawRowsChunk): void {
    const gpu = chunk.batches as RowsGpuChunk;
    const cut = this.chunkCuts.get(gpu);
    const generation = this.surfaces.generation;
    if (!cut || cut.generation === generation) return;
    const pass = this.pass;
    const schedule = this.schedule;
    const rows = pass.renderers?.rows;
    const groupCache = pass.groupCache;
    if (!rows || !groupCache || !meets(chunk.bounds, schedule.bounds)) return;
    const context = this.packContext(groupCache);
    // A chunk of the styles before is built again with the new ones
    if (gpu.data.palette !== context.rowsStyles.palette) return;
    if (!schedule.settled || !schedule.budget.canStep()) {
      this.pending = true;
      return;
    }
    if (cut.target !== generation) {
      cut.target = generation;
      cut.at = 0;
    }
    const group = groupCache.group;
    const surface = this.surfaces.surface;
    const budget = schedule.budget;
    const data = gpu.data;
    const result = budget.step((deadline): 'done' | 'more' | 'rebuild' => {
      while (cut.at < data.rows) {
        const local = cut.at;
        const row = data.rowBase + local;
        const key = rowSurfaceKey(group, row, surface);
        if (key !== cut.keys[local]) {
          const draft = new RowsDraft(1, row, undefined, context.rowsStyles.palette);
          draft.leavesRoom = false;
          collectRow(group, row, 0, draft, data.origin, context);
          if (!rows.patchRows(gpu, local, draft.finish(data.origin, data.palette, data.sprites))) {
            draft.releaseStyles();
            return 'rebuild';
          }
          cut.keys[local] = key;
        }
        cut.at++;
        if ((cut.at & 63) === 0 && budget.now() >= deadline) return 'more';
      }
      return 'done';
    });
    if (result === 'rebuild') {
      // The next version of the chunk takes its places again
      this.invalidateChunk(chunk, true);
      this.pending = true;
    } else if (result === 'done') {
      cut.generation = generation;
      cut.at = 0;
    } else {
      this.pending = true;
    }
  }

  /**
   * Reads the elevations of the points of a chunk of the group being drawn again while the
   * terrain is drawn, when the tiles of the terrain changed since they were read: those of the
   * rows under the tiles that came or went, within the budget
   */
  private updateHeights(chunk: OneDrawRowsChunk): void {
    const terrain = this.options.terrain;
    const gpu = chunk.batches as RowsGpuChunk;
    if (!terrain.renderState.active || gpu.data.pointCount === 0) return;
    const generation = terrain.elevationGeneration;
    const written = this.heightGenerations.get(gpu) ?? -1;
    if (written === generation) return;
    const group = this.pass.group;
    const budget = this.schedule.budget;
    if (!group || !meets(chunk.bounds, this.schedule.bounds)) return;
    if (!budget.canStep()) {
      this.pending = true;
      return;
    }
    const regions =
      written < 0 || !gpu.heightValues ? null : this.surfaces.elevationChangesSince(written);
    if (regions && !boundsMeetRegions(chunk.bounds, regions)) {
      this.heightGenerations.set(gpu, generation);
      return;
    }
    budget.step(() => this.writeHeights(group, gpu, regions));
  }

  /**
   * Writes the elevations of the points of the rows of a chunk under regions (of every point for
   * null), with the elevation the hit testing projects them with, and queues the whole array
   */
  private writeHeights(
    group: RowGroup,
    gpu: RowsGpuChunk,
    regions: readonly MercatorRect[] | null,
  ): void {
    const terrain = this.options.terrain;
    const rows = this.renderers?.rows;
    const data = gpu.data;
    if (!rows || !terrain.renderState.active || data.pointCount === 0) return;
    const values = gpu.heightValues ?? new Float32Array(data.coordCount);
    const whole = regions === null || !gpu.heightValues;
    const bounds = group.data.rowBounds;
    for (let local = 0; local < data.rows; local++) {
      if (data.pointFirst[local + 1] === data.pointFirst[local]) continue;
      const row = data.rowBase + local;
      if (!whole && !rowMeetsRegions(bounds, row, regions as readonly MercatorRect[])) continue;
      writeRowHeights(group, row, values, data.coordFirst[local], terrain);
    }
    rows.setHeights(gpu, values);
    this.heightGenerations.set(gpu, terrain.elevationGeneration);
  }

  /**
   * What follows a row packed again into its place in a chunk: its fingerprint of the cut is the
   * one of the surface it was packed for, and its points get their elevations
   */
  private rowPacked(group: RowGroup, gpu: RowsGpuChunk, local: number): void {
    const cut = this.chunkCuts.get(gpu);
    if (cut)
      cut.keys[local] = rowSurfaceKey(group, gpu.data.rowBase + local, this.surfaces.surface);
    this.writeRowHeights(group, gpu, local);
  }

  /** Writes the elevations of the points of one row of a chunk again (a row written in place) */
  private writeRowHeights(group: RowGroup, gpu: RowsGpuChunk, local: number): void {
    const terrain = this.options.terrain;
    const rows = this.renderers?.rows;
    const data = gpu.data;
    if (!rows || !gpu.heightValues || data.pointFirst[local + 1] === data.pointFirst[local]) return;
    writeRowHeights(group, data.rowBase + local, gpu.heightValues, data.coordFirst[local], terrain);
    rows.setHeights(gpu, gpu.heightValues);
  }

  /**
   * Whether a chunk holds rows of a moving set that an edit moves (the sets of its rows read once
   * per version of the state of its group)
   */
  private holdsMovedRows(chunk: TableChunk, group: RowGroup): boolean {
    const sets = this.movingSetsOf(chunk, group);
    for (let set = 1; set <= MOVE_SETS; set++) {
      if ((sets & (1 << set)) !== 0 && this.transforms[set]) return true;
    }
    return false;
  }

  /**
   * The moving sets the rows of a chunk are in, as bits by set (read once per version of the
   * state of its group)
   */
  private movingSetsOf(chunk: TableChunk, group: RowGroup): number {
    let known = this.chunkMoves.get(chunk);
    if (!known || known.version !== group.stateVersion) {
      const state = group.gpuState;
      let sets = 0;
      for (let row = chunk.range.from; row < chunk.range.to; row++) {
        sets |= 1 << (((state[row] as number) >> GPU_STATE_MOVE_SHIFT) & 3);
      }
      known = { version: group.stateVersion, sets };
      this.chunkMoves.set(chunk, known);
    }
    return known.sets;
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
      this.drawDeltaRange(insert.from, insert.to, insert);
    }
  }

  /** Draws the rows `[from, to)` of a chunk drawn in one draw of the group being drawn */
  private drawOneDrawRange(state: OneDrawRowsChunk, from: number, to: number): void {
    const pass = this.pass;
    const { projectionData, zoom } = pass.frame as TableLayerFrame;
    if (this.painter.active) {
      // On the drape the chunk draws its points alone, at their places among the parts of the
      // drape
      const group = pass.group as RowGroup;
      const layerId = pass.layerId;
      this.drawPointsOnDrape(
        state.batches as RowsGpuChunk,
        group,
        state.range.from,
        from,
        to,
        (row) => this.drape.rankOfRow(layerId, group, row),
        2,
      );
      this.recordRange('rows', state.range.from + from, state.range.from + to);
      return;
    }
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

  /**
   * Draws the points of rows `[from, to)` of a chunk drawn in one draw on the drape: each run of
   * rows with points between two rows the drape draws is a run of the painter (drawn after the
   * drape painted under it, and before what is painted over it)
   *
   * @param base The row of the group the chunk starts at
   * @param rankOf The rank of a row of the group in the order of the drape
   * @param slotStep How the slot of the rank goes with the row: 2 for the rows of a group (row
   *   `r` at `2r + 1`), 0 for rows of a delta placed at one place (one slot, in their order there)
   */
  private drawPointsOnDrape(
    gpu: RowsGpuChunk,
    group: RowGroup,
    base: number,
    from: number,
    to: number,
    rankOf: (row: number) => TableDrapeRank | null,
    slotStep: 0 | 2,
  ): void {
    const pass = this.pass;
    const rows = (pass.renderers as RetainedRendererSet).rows;
    if (!rows || !gpu.uploaded) return;
    const runs = this.pointRunsOf(
      gpu,
      group,
      base,
      pass.groupCache?.group === group ? pass.groupCache : pass.delta,
    );
    if (runs.count === 0) return;
    const { projectionData, zoom } = pass.frame as TableLayerFrame;
    const binding = pass.binding as RowStateBinding;
    const factors = pass.factors;
    const draw = (a: number, b: number): void =>
      rows.drawPointsRange(gpu, a, b, zoom, projectionData, binding, factors);
    const pointFirst = gpu.data.pointFirst;
    // Split by the keys of the points: the rows given whole, in one draw. The rows of a delta
    // placed at one place share a slot with the elements placed there, so their keys do not tell
    // their order: they are drawn run by run, each a break
    if (this.painter.splits && slotStep === 2) {
      const first = rankOf(base + from);
      if (
        !first ||
        !runs.box ||
        to <= from ||
        (pointFirst[to] as number) <= (pointFirst[from] as number)
      ) {
        if (!first && to > from) draw(from, to);
        return;
      }
      const add = first[1] - slotStep * (base + from);
      this.painter.run(first, first, runs.box, runs.maxReach, gpu, from, to, draw, {
        place: first[0],
        mul: slotStep,
        add,
        lastSlot: add + slotStep * (base + to - 1),
        draw: (a, b, key, floor) =>
          rows.drawPointKeysRange(gpu, a, b, zoom, projectionData, binding, factors, key, floor),
        drawSegment: (a, b, key, segment) =>
          rows.drawPointSegmentRange(
            gpu,
            a,
            b,
            zoom,
            projectionData,
            binding,
            factors,
            key,
            segment,
          ),
        eachRun: (from, to, each) => {
          for (let i = 0; i < runs.count; i++) {
            const a = Math.max(runs.runs[i * 3] as number, from);
            const b = Math.min(runs.runs[i * 3 + 1] as number, to);
            if (b <= a || (pointFirst[b] as number) <= (pointFirst[a] as number)) continue;
            const last = Math.min(runs.runs[i * 3 + 2] as number, b - 1);
            const firstRank = rankOf(base + a);
            const lastRank = rankOf(base + last);
            const at = i * 4;
            each(
              a,
              b,
              firstRank,
              lastRank,
              {
                minX: runs.boxes[at] as number,
                minY: runs.boxes[at + 1] as number,
                maxX: runs.boxes[at + 2] as number,
                maxY: runs.boxes[at + 3] as number,
              },
              runs.reach[i] as number,
            );
          }
        },
      });
      return;
    }
    for (let i = 0; i < runs.count; i++) {
      const a = Math.max(runs.runs[i * 3] as number, from);
      const b = Math.min(runs.runs[i * 3 + 1] as number, to);
      if (b <= a || (pointFirst[b] as number) <= (pointFirst[a] as number)) continue;
      const last = Math.min(runs.runs[i * 3 + 2] as number, b - 1);
      const first = rankOf(base + a);
      const lastRank = rankOf(base + last);
      if (!first || !lastRank) {
        draw(a, b);
        continue;
      }
      const at = i * 4;
      this.painter.run(
        first,
        lastRank,
        {
          minX: runs.boxes[at] as number,
          minY: runs.boxes[at + 1] as number,
          maxX: runs.boxes[at + 2] as number,
          maxY: runs.boxes[at + 3] as number,
        },
        runs.reach[i] as number,
        gpu,
        a,
        b,
        draw,
      );
    }
  }

  /**
   * The runs of rows with points of a chunk, between the rows the drape draws, with their boxes:
   * kept for the chunk while its rows and their kinds do not change
   */
  private pointRunsOf(
    gpu: RowsGpuChunk,
    group: RowGroup,
    base: number,
    groupCache: GroupCache | null,
  ): PointRuns {
    const key = `${group.mark}|${this.drape.kindsGeneration(group)}`;
    const held = this.pointRuns.get(gpu);
    if (held && held.key === key && held.group === group) return held;
    const data = gpu.data;
    const context = this.pass.context;
    const runs: number[] = [];
    const boxes: number[] = [];
    const reaches: number[] = [];
    let start = -1;
    let last = -1;
    let reach = 0;
    const close = (end: number): void => {
      if (start < 0) return;
      const box = rowsBox(group, base + start, base + end);
      if (box) {
        runs.push(start, end, last);
        boxes.push(box.minX, box.minY, box.maxX, box.maxY);
        reaches.push(reach);
      }
      start = -1;
      reach = 0;
    };
    for (let r = 0; r < data.rows; r++) {
      const row = base + r;
      if (this.drape.drapesRow(group, row)) {
        close(r);
        continue;
      }
      if ((data.pointFirst[r + 1] as number) > (data.pointFirst[r] as number)) {
        if (start < 0) start = r;
        last = r;
        // How far the marker reaches on the screen: its radius and its outline, or a picture
        let rowReach = TABLE_DRAPE_POINT_REACH_PX;
        if (context && !groupCache?.sprites.has(row)) {
          const slot = context.slots.point(
            group.data.styles[row] as number,
            rowType(group.data, row),
            context.slots.ruleColorOf(group, row, context.strings),
          );
          rowReach = (slot.packed[8] as number) + (slot.packed[9] as number) + 1;
        }
        reach = Math.max(reach, rowReach);
      }
    }
    close(data.rows);
    let box: DrapeBounds | null = null;
    let maxReach = 0;
    for (let i = 0; i < boxes.length; i += 4) {
      box = union(box, {
        minX: boxes[i] as number,
        minY: boxes[i + 1] as number,
        maxX: boxes[i + 2] as number,
        maxY: boxes[i + 3] as number,
      });
      maxReach = Math.max(maxReach, reaches[i / 4] as number);
    }
    const out: PointRuns = {
      key,
      group,
      runs: Int32Array.from(runs),
      boxes: Float64Array.from(boxes),
      reach: Float32Array.from(reaches),
      count: runs.length / 3,
      box,
      maxReach,
    };
    this.pointRuns.set(gpu, out);
    return out;
  }

  /** Draws the rows `[from, to)` of a retained chunk of the group being drawn */
  private drawRange(state: RetainedRowsChunk, from: number, to: number): void {
    const pass = this.pass;
    const batches = state.batches as TableChunkBatch;
    const renderers = pass.renderers as RetainedRendererSet;
    const { projectionData, zoom } = pass.frame as TableLayerFrame;
    const binding = pass.binding as RowStateBinding;
    if (this.painter.active) {
      // On the drape the polygons and the lines are the drape's, and a chunk of points is a run
      // of the painter
      if (batches.kind === 'point') {
        const group = pass.group as RowGroup;
        const base = state.range.from;
        const first = this.drape.rankOfRow(pass.layerId, group, base + from);
        const last = this.drape.rankOfRow(pass.layerId, group, base + to - 1);
        const box = rowsBox(group, base + from, base + to);
        const draw = (a: number, b: number): void =>
          renderers.point.drawRetainedRange?.(
            batches.batch as RetainedPointBatch,
            a,
            b,
            projectionData,
            binding,
            pass.factors,
          );
        if (first && last && box) {
          this.painter.run(first, last, box, TABLE_DRAPE_POINT_REACH_PX, state, from, to, draw);
        } else {
          draw(from, to);
        }
      }
      this.recordRange(state.range.kind, state.range.from + from, state.range.from + to);
      return;
    }
    switch (batches.kind) {
      case 'point':
        renderers.point.drawRetainedRange?.(
          batches.batch as RetainedPointBatch,
          from,
          to,
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
            // A row an extension draws from the rows needs no feature
            features[i] =
              rowHasGeometry(group, row) && !this.rowsDrawerOf(group, row, null)
                ? rowFeatureToRead(tables.readContext, layerId, group, row)
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

    // A chunk out of view draws nothing (the rows of the delta within it are drawn)
    const shown = this.immediateInView(chunk, group);
    const kept = (i: number): Feature | null =>
      chunk.features && i - from < chunk.filled ? chunk.features[i - from] : null;
    // Drawn in parts at the places of the rows of the delta within the chunk
    let part = from;
    for (let at = this.nextInsert(); ; at = this.nextInsert()) {
      const end = at !== null && at > part && at < to ? at : to;
      if (shown) {
        const rows = this.rowsInView(chunk, group, part, end);
        // On the drape, a break: what is drawn at once comes after the drape painted under it
        if (this.painter.active && (rows === null || rows.length > 0)) {
          const rank = this.drape.rankOfRow(layerId, group, part);
          const box = rows === null ? rowsBox(group, part, end) : boxOfRows(group, rows);
          if (rank) this.painter.breakAt(rank, box, TABLE_DRAPE_POINT_REACH_PX);
        }
        this.drawAtOnce(group, part, end, kept, rows);
        this.recordRange('immediate', part, end);
      }
      if (end >= to) break;
      this.drawInserts(end);
      part = end;
    }
  }

  /**
   * Whether a chunk drawn at once of the group being drawn meets the view: its extent, or for the
   * rows of a moving set in it, the extent the view sees them from
   */
  private immediateInView(chunk: ImmediateRowsChunk, group: RowGroup): boolean {
    const bounds = (this.pass.frame as TableLayerFrame).bounds ?? WORLD;
    if (bounds === WORLD) return chunk.bounds !== null;
    const box = this.chunkExtent(chunk, group);
    if (!box) return false;
    if (meets(box, bounds)) return true;
    const sets = this.movingSetsOf(chunk, group);
    for (let set = 1; set <= MOVE_SETS; set++) {
      if ((sets & (1 << set)) === 0) continue;
      for (const view of this.setViews[set] ?? NO_VIEWS) if (meets(box, view)) return true;
    }
    return false;
  }

  /**
   * The extent of a chunk drawn at once of the group being drawn: the union of the extents of its
   * rows (read once, from the features of the rows of a type with an extent of its own), widened by
   * how far they reach on the screen in the frame
   */
  private chunkExtent(chunk: ImmediateRowsChunk, group: RowGroup): BoundingBox | null {
    const extents = this.rowExtents;
    if (chunk.extentsGeneration !== extents.generation) {
      const { from, to } = chunk.range;
      const pass = this.pass;
      const tables = pass.tables as FeatureTablesInternals;
      const read = extents.readRange(group, from, to, (row) => {
        const kept =
          chunk.features && row - from < chunk.filled ? chunk.features[row - from] : null;
        return kept ?? rowFeatureToRead(tables.readContext, pass.layerId, group, row);
      });
      let box: BoundingBox | null = null;
      let reach = 0;
      for (let row = from; row < to; row++) {
        const at = row * 4;
        const b = read.boxes;
        if (!Number.isNaN(b[at])) box = widenBounds(box, b[at], b[at + 1], b[at + 2], b[at + 3]);
        if (read.reachPx[row] > reach) reach = read.reachPx[row];
      }
      chunk.bounds = box;
      chunk.reachPx = reach;
      chunk.extentsGeneration = extents.generation;
      chunk.index = null;
    }
    const box = chunk.bounds;
    if (!box || chunk.reachPx === 0) return box;
    const [lng, lat] = reachDegrees(chunk.reachPx, box.minY, box.maxY, this.scaleFrame);
    return widened(box, lng, lat);
  }

  /**
   * The rows `[from, to)` of a chunk drawn at once that may be in view, in their order, found by
   * their extents in the index of the chunk: for a chunk of many rows that the view does not hold
   * whole (null otherwise, when the rows of the range are walked)
   */
  private rowsInView(
    chunk: ImmediateRowsChunk,
    group: RowGroup,
    from: number,
    to: number,
  ): number[] | null {
    const bounds = (this.pass.frame as TableLayerFrame).bounds ?? WORLD;
    const { range } = chunk;
    if (bounds === WORLD || range.to - range.from < IMMEDIATE_INDEX_FROM) return null;
    const box = this.chunkExtent(chunk, group);
    if (!box) return null;
    // The moving sets of its rows that move
    let sets = 0;
    const of = this.movingSetsOf(chunk, group);
    for (let set = 1; set <= MOVE_SETS; set++) {
      if ((of & (1 << set)) !== 0 && this.setViews[set]) sets |= 1 << set;
    }
    const held =
      box.minX >= bounds.minX &&
      box.maxX <= bounds.maxX &&
      box.minY >= bounds.minY &&
      box.maxY <= bounds.maxY;
    if (held && sets === 0) return null;
    // The extents of its rows (read with the extent of the chunk)
    const extents = this.rowExtents.of(group);
    chunk.index ??= buildPackedRTree(extents.boxes.subarray(range.from * 4, range.to * 4));
    // The view widened by how far a row of the chunk reaches on the screen
    const [lng, lat] = reachDegrees(chunk.reachPx, box.minY, box.maxY, this.scaleFrame);
    const found: number[] = [];
    const search = (view: BoundingBox): void => {
      const reached = widened(view, lng, lat);
      searchPackedRTree(
        chunk.index as PackedRTree,
        reached.minX,
        reached.minY,
        reached.maxX,
        reached.maxY,
        found,
      );
    };
    search(bounds);
    for (let set = 1; set <= MOVE_SETS; set++) {
      if ((sets & (1 << set)) === 0) continue;
      for (const view of this.setViews[set] ?? NO_VIEWS) search(view);
    }
    found.sort((a, b) => a - b);
    const out: number[] = [];
    let last = -1;
    for (const local of found) {
      const row = range.from + local;
      if (row === last || row < from || row >= to) continue;
      out.push(row);
      last = row;
    }
    return out;
  }

  /**
   * Draws rows of a group at once, from their features (the ones kept, or made for the rows in
   * view), outside the run of the retained draws: what draws them may change any of the state of
   * the run, and some of it draws without the run
   *
   * @param kept The feature kept for a row (null when none is)
   * @param candidates The rows of `[from, to)` that may be in view, in their order (every row of
   *   it when omitted)
   */
  private drawAtOnce(
    group: RowGroup,
    from: number,
    to: number,
    kept: (row: number) => Feature | null,
    candidates?: readonly number[] | null,
  ): void {
    const pass = this.pass;
    const frame = pass.frame as TableLayerFrame;
    const tables = pass.tables as FeatureTablesInternals;
    const bounds = frame.bounds ?? WORLD;
    const deps = pass.deps as StoreRetainedDrawDeps;
    const stats = this.atOnceStats;
    const features: Feature[] = [];
    // The rows an extension draws from the rows, consecutive ones of one renderer at a time
    let drawer: FeatureTypeRenderer | null = null;
    const handles: number[] = [];
    let ended = false;
    const end = (): void => {
      if (ended) return;
      (pass.renderers as RetainedRendererSet).run?.end();
      ended = true;
    };
    const drawFeatures = (): void => {
      if (features.length === 0) return;
      end();
      drawImmediateFeatures(features, pass.layer as Layer, frame.projectionData, frame.zoom, deps);
      features.length = 0;
    };
    const drawRows = (): void => {
      const view = tables.view(pass.layerId);
      if (!drawer || handles.length === 0 || !view) return;
      end();
      drawer.drawRows?.(
        view,
        Int32Array.from(handles),
        frame.projectionData,
        frame.zoom,
        deps.customRendererContext,
      );
      deps.restoreBlendState?.();
      handles.length = 0;
    };
    const count = candidates ? candidates.length : to - from;
    for (let k = 0; k < count; k++) {
      const row = candidates ? (candidates[k] as number) : from + k;
      stats.visited++;
      const state = group.state[row];
      if ((state & STATE_HIDDEN_MASK) !== 0) continue;
      // A row out of view is not drawn, nor its companion: by its extent, and for a row of a
      // moving set, where the view sees it from
      if (!rowHasGeometry(group, row)) continue;
      const set = (state & STATE_MOVE_MASK) >> STATE_MOVE_SHIFT;
      let feature = kept(row);
      if (bounds !== WORLD) {
        const featureOf = (): Feature => {
          feature ??= rowFeatureToRead(tables.readContext, pass.layerId, group, row);
          return feature;
        };
        if (!this.rowShown(group, row, set, bounds, featureOf)) continue;
      }
      stats.drawn++;
      const rows = this.rowsDrawerOf(group, row, feature);
      if (rows) {
        // The features before are drawn first, and the rows of another renderer
        drawFeatures();
        if (rows !== drawer) drawRows();
        drawer = rows;
        handles.push(group.data.handles[row]);
        continue;
      }
      // A row not kept is made when it is in view
      feature ??= rowFeatureToRead(tables.readContext, pass.layerId, group, row);
      drawRows();
      drawer = null;
      features.push(
        set > 0
          ? movedFeature(
              feature,
              this.translations,
              this.transforms[set],
              set,
              this.options.transformFields?.() ?? null,
            )
          : feature,
      );
    }
    drawFeatures();
    drawRows();
    if (ended) (pass.renderers as RetainedRendererSet).run?.begin();
  }

  /**
   * Whether a row is in view: its extent (`table-extents.ts`) widened by how far it reaches on the
   * screen in the frame, or for a row of a moving set that moves, that extent where the view sees
   * the set from
   *
   * @param set The moving set of the row (0 for none)
   * @param featureOf The feature of the row (made only to read its extent the first time)
   */
  private rowShown(
    group: RowGroup,
    row: number,
    set: number,
    bounds: BoundingBox,
    featureOf: () => Feature,
  ): boolean {
    const extents = this.rowExtents.read(group, row, featureOf);
    const boxes = extents.boxes;
    const reach = extents.reachPx[row];
    let lng = 0;
    let lat = 0;
    if (reach > 0)
      [lng, lat] = reachDegrees(reach, boxes[row * 4 + 1], boxes[row * 4 + 3], this.scaleFrame);
    const views = set > 0 ? this.setViews[set] : null;
    if (!views) return extentInView(boxes, row, bounds, lng, lat);
    for (const view of views) if (extentInView(boxes, row, view, lng, lat)) return true;
    return false;
  }

  /**
   * The renderer that draws a row at once from the rows (`drawRows`): the one of its type, when
   * it takes the row and the row has no companion (null otherwise, and when no renderer draws
   * from the rows)
   *
   * @param kept The feature kept for the row (read by an extension that answers from a feature)
   */
  private rowsDrawerOf(
    group: RowGroup,
    row: number,
    kept: Feature | null,
  ): FeatureTypeRenderer | null {
    const pass = this.pass;
    const deps = pass.deps;
    const tables = pass.tables;
    if (!deps || !tables || !anyRowsDrawer(deps.customRenderers)) return null;
    const renderer = deps.customRenderers.get(rowType(group.data, row)) as
      | FeatureTypeRenderer
      | undefined;
    if (!renderer?.drawRows) return null;
    let feature = kept;
    const featureOf = (): Feature => {
      feature ??= rowFeatureToRead(tables.readContext, pass.layerId, group, row);
      return feature;
    };
    const view = tables.view(pass.layerId);
    if (!rendererTakesRow(renderer, view, group, row, featureOf)) return null;
    if (rowHasCompanion(deps.companions, view, group, row, featureOf)) return null;
    return renderer;
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
  private drawDeltaRange(from: number, to: number, insert?: DeltaInsert): void {
    const pass = this.pass;
    const group = pass.deltaGroup;
    if (!group || to <= from) return;
    // On the drape, the rank of a row of the delta is its place before a row of the group
    const groupHandle = pass.group?.handle ?? -1;
    const layerId = pass.layerId;
    const rankOf = (row: number): TableDrapeRank | null =>
      insert ? this.drape.rankOfInsert(layerId, groupHandle, insert.at, row - insert.from) : null;
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
    const breakAt = (a: number, b: number): void => {
      const rank = this.painter.active ? rankOf(a) : null;
      if (rank) this.painter.breakAt(rank, rowsBox(group, a, b), TABLE_DRAPE_POINT_REACH_PX);
    };
    if (!chunks) {
      breakAt(from, to);
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
      if (gpu?.uploaded && rows && this.painter.active) {
        const binding = pass.binding;
        pass.binding = (cache as GroupCache).binding;
        this.drawPointsOnDrape(
          gpu,
          group,
          chunk.range.from,
          a - chunk.range.from,
          b - chunk.range.from,
          rankOf,
          0,
        );
        pass.binding = binding;
        record('rows', a, b);
      } else if (gpu?.uploaded && rows) {
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
        breakAt(a, b);
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
        held.surfaceGeneration === this.surfaces.generation &&
        held.oneDraw?.generation === cache.generation &&
        held.oneDraw.chunks.every((c) => c.type !== 'rows' || c.batches?.data.palette === palette);
      if (current) {
        // The elevations of its points follow the tiles of the terrain (a delta is small: read
        // whole)
        for (const chunk of held.oneDraw?.chunks ?? []) {
          const gpu = chunk.type === 'rows' ? chunk.batches : null;
          const generation = this.options.terrain.elevationGeneration;
          if (gpu && this.heightGenerations.get(gpu) !== generation) {
            this.writeHeights(held.group, gpu, null);
          }
        }
        continue;
      }
      if (held) this.disposeGroup(held);
      cache.delta = null;
      cache.deltaStale = false;
      if (!group) continue;
      const deltaCache = newGroupCache(group, cache.styleGeneration);
      deltaCache.surfaceGeneration = this.surfaces.generation;
      cache.delta = deltaCache;
      const { tables, slots, layer, deps } = cache;
      if (!rows || !tables || !slots || !layer || !deps || !cache.context || !cache.rowsStyles) {
        continue;
      }
      const sprites = new Map<number, RowSpriteSource>();
      const view = tables.view(layerId);
      const transformFields = this.options.transformFields?.() ?? null;
      const ranges = partitionRowGroup(
        group,
        (row) =>
          classifyRow(group, row, {
            slots,
            customTypes: deps.customRenderers,
            companions: deps.companions as FeatureCompanionRegistry,
            featureOf: (r, k) => rowFeatureToRead(tables.readContext, layerId, r, k),
            view,
            layer,
            oneDraw: true,
            transformFields,
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
        this.writeHeights(group, chunk.batches, null);
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
  onPacked: (chunk: RowsGpuChunk, keys: Int32Array) => void,
): RetainedChunkJob<RowsGpuChunk> {
  const count = range.to - range.from;
  const palette = context.rowsStyles.palette;
  const draft = new RowsDraft(count, range.from, range.vertices, palette);
  // The fingerprint of the cut of each row for the surface it is packed for
  const keys = new Int32Array(count);
  const surface = context.surface ?? null;
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
            keys[next] = rowSurfaceKey(group, range.from + next, surface);
          }
          if (now() >= deadline) break;
        }
        if (next < count) return false;
        chunk = rows.createChunk(draft.finish(origin, palette, sprites));
        onPacked(chunk, keys);
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
    bulkMarked: false,
    bulkMarkVersion: -1,
    surfaceGeneration: -1,
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

/** Whether the extent of a row, widened by degrees of longitude and latitude, meets a box */
function extentInView(
  boxes: Float64Array,
  row: number,
  bounds: BoundingBox,
  lng: number,
  lat: number,
): boolean {
  const at = row * 4;
  return (
    boxes[at] - lng <= bounds.maxX &&
    boxes[at + 2] + lng >= bounds.minX &&
    boxes[at + 1] - lat <= bounds.maxY &&
    boxes[at + 3] + lat >= bounds.minY
  );
}

/** Whether a row of a group is marked as selected in bulk (read once per version of its state) */
function holdsBulkMark(groupCache: GroupCache): boolean {
  const group = groupCache.group;
  if (groupCache.bulkMarkVersion !== group.stateVersion) {
    groupCache.bulkMarkVersion = group.stateVersion;
    groupCache.bulkMarked = group.gpuState.some((state) => (state & GPU_STATE_BULK) !== 0);
  }
  return groupCache.bulkMarked;
}

/** Whether a renderer of a custom type draws rows from the rows (`drawRows`) */
function anyRowsDrawer(renderers: ReadonlyMap<string, unknown>): boolean {
  for (const renderer of renderers.values()) {
    if ((renderer as FeatureTypeRenderer).drawRows) return true;
  }
  return false;
}

/**
 * The regions the view sees the rows of each moving set from (into `out`, by set): the view moved
 * back by the translation of the set, then by its edit as `movedViewsOf` moves it back; null for a
 * set that does not move, and for every set when the view is the whole world
 */
function setViewsOf(
  translations: Float32Array,
  transforms: ReadonlyArray<EnuEdit | null>,
  view: BoundingBox,
  out: Array<BoundingBox[] | null>,
): void {
  for (let set = 1; set <= MOVE_SETS; set++) {
    const dLng = translations[set * 2];
    const dLat = translations[set * 2 + 1];
    const edit = transforms[set] ?? null;
    if (view === WORLD || (dLng === 0 && dLat === 0 && !edit)) {
      out[set] = null;
      continue;
    }
    const shifted: BoundingBox = {
      minX: view.minX - dLng,
      minY: view.minY - dLat,
      maxX: view.maxX - dLng,
      maxY: view.maxY - dLat,
    };
    const views: BoundingBox[] = [];
    if (edit) movedBackViews(edit, shifted, views);
    else views.push(shifted);
    out[set] = views;
  }
}

/**
 * The regions the view sees the rows of the moving sets from: the view moved back by the edit of
 * each set (for a scaling, by its factors and by its size), as the extents of its corners, the
 * middles of its sides and its center (into `out`)
 */
function movedViewsOf(
  transforms: ReadonlyArray<EnuEdit | null>,
  view: BoundingBox,
  out: BoundingBox[],
): void {
  out.length = 0;
  if (view === WORLD) return;
  for (const edit of transforms) {
    if (edit) movedBackViews(edit, view, out);
  }
}

/** The regions a view is seen from before an edit (appended to `out`), as `movedViewsOf` */
function movedBackViews(edit: EnuEdit, view: BoundingBox, out: BoundingBox[]): void {
  const back = inverseEnuEdit(edit);
  for (const uniform of edit.kind === 'scale' ? [false, true] : [false]) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const fx of [0, 0.5, 1]) {
      for (const fy of [0, 0.5, 1]) {
        const x = view.minX + (view.maxX - view.minX) * fx;
        const y = Math.max(-90, Math.min(90, view.minY + (view.maxY - view.minY) * fy));
        const p = moveEnuPosition(back, [x, y], uniform);
        minX = Math.min(minX, p[0] as number);
        minY = Math.min(minY, p[1] as number);
        maxX = Math.max(maxX, p[0] as number);
        maxY = Math.max(maxY, p[1] as number);
      }
    }
    if (minX <= maxX && minY <= maxY) out.push({ minX, minY, maxX, maxY });
  }
}

/**
 * The Mercator box of some rows of a group, for the breaks of the drape (null for none)
 *
 * @param rows The rows, in their order
 */
function boxOfRows(group: RowGroup, rows: readonly number[]): DrapeBounds | null {
  let out: DrapeBounds | null = null;
  for (const row of rows) {
    const box = rowsBox(group, row, row + 1);
    if (!box) continue;
    out = out
      ? {
          minX: Math.min(out.minX, box.minX),
          minY: Math.min(out.minY, box.minY),
          maxX: Math.max(out.maxX, box.maxX),
          maxY: Math.max(out.maxY, box.maxY),
        }
      : box;
  }
  return out;
}

/**
 * A feature moved by its moving set (the rows drawn at once): moved, rotated or scaled by the edit
 * of the set as the drag let go writes it, its rotation, scale and radius with it, then translated
 */
function movedFeature(
  feature: Feature,
  translations: Float32Array,
  transform: EnuEdit | null,
  set: number,
  declared: TransformFieldsRegistry | null,
): Feature {
  const dLng = translations[set * 2];
  const dLat = translations[set * 2 + 1];
  if (dLng === 0 && dLat === 0 && !transform) return feature;
  let moved = feature;
  if (transform) {
    // Moved as the write of the drag let go moves it: the computation of the library over its
    // geometry and the fields of its roles (a rotation, a scale, the radius of a Circle)
    const properties = (feature.properties ?? {}) as Record<string, unknown>;
    const read = (key: string): unknown => (key in properties ? properties[key] : undefined);
    const roles = transformRolesOf(feature.type, (key) => read(key) !== undefined, declared);
    const before = transformValuesOf(feature.geometry, roles, read);
    const after = applyEnuEdit(transform, before);
    const fields = roleFieldsOf(roles, before, after);
    moved = {
      ...feature,
      geometry: after.geometry as Feature['geometry'],
      ...(fields.length > 0 && {
        properties: { ...feature.properties, ...Object.fromEntries(fields) },
      }),
    };
  }
  if (dLng === 0 && dLat === 0) return moved;
  const shift = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    if (typeof value[0] === 'number') {
      return [(value[0] as number) + dLng, (value[1] as number) + dLat, ...value.slice(2)];
    }
    return value.map(shift);
  };
  const geometry = moved.geometry as { type: string; coordinates?: unknown };
  return {
    ...moved,
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

/** What a feature draws, as text to compare (its id, its kind, its place and every value) */
function featureText(feature: Feature): string {
  return JSON.stringify([
    feature.id,
    feature.type,
    feature.groupId ?? null,
    feature.visible,
    feature.locked,
    feature.geometry,
    feature.style,
    feature.properties,
  ]);
}

/** The problems a check of the drawing gives at most (the rest are not read) */
const CHECK_PROBLEMS = 20;

/**
 * The arrays of a chunk drawn in one draw as the GPU holds them, when the chunk is drawn as it is
 * built (null while it is being built, marked to be built again, not on the GPU yet, or with
 * writes waiting for the next frame; and when nothing is kept)
 */
function settledCopy(chunk: OneDrawRowsChunk, copies: RowsCopies): RowsChunkData | null {
  const gpu = chunk.batches;
  if (!gpu || chunk.job || chunk.stale || !gpu.uploaded || gpu.disposed) return null;
  const writes = gpu.writes;
  if (
    writes &&
    writes.instances.size + writes.points.size + writes.coords.size + writes.rowStyles.size > 0
  ) {
    return null;
  }
  return copies.copyOf(gpu) ?? null;
}

/**
 * What the drawing reads of the state of a row: whether it is hidden (not why), whether it is
 * marked as selected in bulk, its moving set and how it is moved
 */
function drawnState(state: number): number {
  return (
    ((state & STATE_HIDDEN_MASK) !== 0 ? 1 : 0) |
    (state & (STATE_BULK | STATE_MOVE_MASK | STATE_UNIFORM | STATE_BY_VALUES))
  );
}

/** How a kind of run draws its rows, for the problems */
function kindText(kind: TableRunKind): string {
  switch (kind) {
    case 'rows':
      return 'in one draw';
    case 'immediate':
      return 'at once';
    default:
      return `by kind (${kind})`;
  }
}

/** The parts of two texts from a little before their first difference */
function firstDifference(a: string, b: string): [string, string] {
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  const from = Math.max(0, at - 40);
  const part = (text: string): string =>
    `${from > 0 ? '...' : ''}${text.slice(from, from + 160)}${text.length > from + 160 ? '...' : ''}`;
  return [part(a), part(b)];
}

/**
 * Writes the elevations of the points of a row (meters, the elevation the hit testing projects
 * them with) at the coordinates they are packed at, from `first`
 */
function writeRowHeights(
  group: RowGroup,
  row: number,
  values: Float32Array,
  first: number,
  terrain: TerrainContext,
): void {
  const geometry = geometryAt(group, row);
  if (!geometry) return;
  const { reader, at } = geometry;
  if (reader.type !== 'Point' && reader.type !== 'MultiPoint') return;
  const coords = reader.coords;
  const stride = reader.stride;
  const start = reader.vertexStart(at);
  const end = reader.vertexStart(at + 1);
  for (let v = start; v < end && first + v - start < values.length; v++) {
    values[first + v - start] = anchorElevationMeters(
      terrain,
      coords[v * stride],
      coords[v * stride + 1],
    );
  }
}

/** Whether a box in degrees meets one of the regions (Mercator) */
function boundsMeetRegions(bounds: BoundingBox, regions: readonly MercatorRect[]): boolean {
  return boxMeetsRegions(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY, regions);
}

/** Whether the extent of a row meets one of the regions (Mercator) */
function rowMeetsRegions(
  rowBounds: Float64Array,
  row: number,
  regions: readonly MercatorRect[],
): boolean {
  const at = row * 4;
  if (Number.isNaN(rowBounds[at])) return false;
  return boxMeetsRegions(
    rowBounds[at],
    rowBounds[at + 1],
    rowBounds[at + 2],
    rowBounds[at + 3],
    regions,
  );
}

function boxMeetsRegions(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  regions: readonly MercatorRect[],
): boolean {
  // Mercator y decreases as the latitude increases
  const x0 = mercatorX(minX);
  const x1 = mercatorX(maxX);
  const y0 = mercatorY(maxY);
  const y1 = mercatorY(minY);
  for (const region of regions) {
    if (x0 <= region.x1 && x1 >= region.x0 && y0 <= region.y1 && y1 >= region.y0) return true;
  }
  return false;
}
