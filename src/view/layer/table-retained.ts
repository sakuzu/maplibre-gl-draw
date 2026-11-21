// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The drawing of the layers from their rows (`TableLayerRenderer`), on every surface
 *
 * A layer is drawn in the order of its rows: its row groups in their order, and the GPU chunks of
 * a group (`table-partition.ts`) in theirs, with the rows of the parts of its delta at their places
 * among them. A chunk outside the view is skipped, which keeps the order since a chunk is a run of
 * the order. It is drawn one of two ways:
 *
 * - in one draw (`renderers/rows/`): a chunk holds rows of every kind (points, lines, dashed
 *   lines, polygons) and is drawn in one draw whatever kinds its rows are; it ends only where a
 *   row is drawn at once
 * - by kind, where the program of the drawing in one draw cannot be made: a chunk is a run of rows
 *   of one kind, a retained batch of the renderer of its kind (`table-kinds.ts`)
 *
 * In both, the rows that cannot be in a chunk (images, custom types, features with companions,
 * shapes that are not instanced, and by kind the dashed lines) are drawn at once, in their place,
 * from their features, the ones in view only.
 *
 * On the terrain and on the globe the chunks drawn in one draw are packed for the surface
 * (`RowsSurface` of `table-collect.ts`): their fills and outlines cut with the step of the surface,
 * their points with the elevations of the ground under them, their segments drawn in stations; the
 * dashed lines and the polygons with a dashed outline are drawn at once there, as the drawing by
 * kind draws them. Each chunk keeps what it was cut with and the fingerprint of the cut of each
 * row (`ChunkCut`). When the surface changes (the step of the terrain, its tiles, the cells of the
 * globe) or the elevations do, a chunk in view checks its rows again within the budget of the
 * frames, a slice at a time, packs again the rows whose fingerprint changed, and writes them into
 * their places once all of them are packed (it draws as it was until then); a row that does not
 * fit its place makes the chunk build again (drawn as it was until then). When the layers go onto
 * the terrain or the globe or leave them, every chunk is cut again, the chunks of the cut before
 * drawn until the new ones are built in view. In the band of the analytic drape the polygons and
 * the lines are on the drape and the other rows are drawn at once.
 *
 * The chunks are built over the frames within a budget (`view/retained/chunk-scheduler.ts`), and
 * a chunk invalidated keeps drawing until the new one is built. The next versions of the row
 * groups wait until their chunks in view are built (`GroupVersionReceiver`), so a group is drawn
 * from the chunks of its version from the frame the version is swapped in.
 *
 * The state of the rows (not drawn, selected, moving) is not in the chunks: every row group has a
 * texture of one byte per row (`renderers/row-state.ts`), made by the drawing from the state of
 * the copies of the rows and from the state of this client (what it hides, what it selects), and
 * written again when it changes. A row hidden or selected on this client writes the bytes of its
 * rows only; the chunks are never made again for it.
 *
 * A row written in place is written into the chunk that draws it (its coordinates, its style, or
 * the row packed again into its place); a row that does not fit its place is put into the delta of
 * its layer, and drawn from there.
 *
 * For tests and measurements it can record the ranges it draws in order (`recordDraws`) and counts
 * its work (`stats`).
 */

import type { ProjectionData } from 'maplibre-gl';
import type { FeatureTypeHandler, FrameDrawContext } from '../../extension/index.js';
import type { FeatureTypeRenderer } from '../../extension/renderers.js';
import type { BBox } from '../../geometry/types.js';
import type { PixelRatioInput } from '../../shared/utils/pixel-ratio.js';
import type {
  DeltaInsert,
  DeltaPart,
  DrawnRows,
  GroupVersion,
  GroupVersionReceiver,
  InPlaceRowWrite,
  RowGroup,
  RowGroupHandle,
  RowTable,
} from '../../store/built-in/drawn-rows.js';
import {
  ROW_WRITE_GEOMETRY,
  ROW_WRITE_STATE,
  ROW_WRITE_STYLE,
} from '../../store/built-in/drawn-rows.js';
import type { DocumentAccess } from '../../store/document-access.js';
import type { Feature, Layer, SelectionType, StoreChange } from '../../store/types.js';
import {
  drawFeatureCompanionsInFrame,
  type FeatureCompanionRegistry,
} from '../feature-companion.js';
import { getSurfaceTessellationStep } from '../globe-subdivision.js';
import type { GpuLedger } from '../gpu-ledger.js';
import { layerDrawFactors, type RetainedDrawFactors } from '../renderers/draw-factors.js';
import type { RetainedRendererSet } from '../renderers/retained.js';
import {
  createRowStateTexture,
  ROW_STATE_HIDDEN,
  ROW_STATE_SELECTED,
  type RowStateTexture,
  releaseRowStateTexture,
  uploadRowState,
} from '../renderers/row-state.js';
import { RowsPalette } from '../renderers/rows/rows-format.js';
import type { RowsChunk, RowsRenderer } from '../renderers/rows/rows-renderer.js';
import {
  advanceChunkBuild,
  type ChunkBuildBudget,
  type ChunkSchedulerFrame,
  type ChunkSchedulerHost,
  chunkClock,
  createChunkBuildBudget,
  invalidateChunk,
  type RetainedChunkJob,
  type RetainedChunkState,
} from '../retained/chunk-scheduler.js';
import { getAnchorElevationGeneration } from '../terrain/anchor.js';
import type { TerrainContext } from '../terrain/context.js';
import type { TessellationStep } from '../terrain/tessellation.js';
import {
  collectRow,
  ROWS_LAYOUT,
  RowCoordsDraft,
  RowStyleSlots,
  RowsDraft,
  type RowsPackContext,
  RowsStyles,
  type RowsSurface,
  resolveRowStyle,
  rowCreatedZoom,
  rowFillCells,
  rowSurfaceKey,
  surfaceFillStep,
} from './table-collect.js';
import { buildKindBatch, disposeKindBatch, drawKindBatch, type KindBatch } from './table-kinds.js';
import {
  classifyRow,
  customRendererOf,
  drawnRowBox,
  type OrderedChunkRange,
  partitionRowGroup,
  type TableRunKind,
} from './table-partition.js';

/**
 * The time the builds of the chunks may take in one frame (ms)
 *
 * The same as the budget of the chunks of a dataset.
 */
const TABLE_BUILD_BUDGET_MS = 12;

/**
 * The number of features made from rows that are kept for the rows drawn at once
 *
 * A feature is kept while its row does not change; above this number, the features of the rows
 * not drawn in the frame are let go. A first estimate, to be set from measured data.
 */
export const IMMEDIATE_CACHE_LIMIT = 50_000;

/** The rows packed between two looks at the clock */
const SLICE_ROWS = 512;

/** The rows a chunk checks against a new surface between two looks at the clock */
const RECUT_SLICE_ROWS = 64;

/** The whole world: the range drawn when the view is not known */
function world(): BBox {
  return [-540, -90, 540, 90];
}

/**
 * One range of rows drawn, as the record of the draws gives it
 *
 * @internal
 */
export interface TableDrawRecord {
  readonly layerId: string;
  /** The row group (a part of the delta when `delta` is true) */
  readonly group: RowGroupHandle;
  /** The place of the group in the order of its layer (-1 for a part of the delta) */
  readonly groupIndex: number;
  /** The kind of the chunk (`rows` for a chunk drawn in one draw) */
  readonly kind: TableRunKind;
  /** The first row drawn in its group */
  readonly from: number;
  /** The end of the rows drawn (exclusive) */
  readonly to: number;
  /** Whether the rows are rows of a part of the delta of the layer */
  readonly delta?: boolean;
}

/**
 * The work of the drawing, counted for the tests (the work of a frame follows what changed)
 *
 * @internal
 */
export interface TableWorkStats {
  /** The rows packed into chunks, or written into them in place */
  rowsPacked: number;
  /** The rows the drawing read to write the bytes of their state */
  stateRowsRead: number;
  /** The bytes of the state of rows that changed */
  stateRowsWritten: number;
  /** The textures of the state written */
  statesUploaded: number;
  /** The chunks built (or built again) */
  chunksBuilt: number;
  /** The features made from rows (for the rows drawn at once and the chunks drawn by kind) */
  featuresMade: number;
  /** The rows written in place since the drawing was made */
  rowsWrittenInPlace: number;
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
  readonly bounds: BBox | undefined;
}

/**
 * Draw target of the rows drawn at once (the same shape as the batch manager)
 *
 * @internal
 */
export interface TableImmediateTarget {
  beginFrame(projectionData: ProjectionData, zoom: number, layer?: Layer): void;
  processFeature(feature: Feature, isSelected: boolean): boolean;
  endFrame(): void;
}

/**
 * What a layer is drawn with
 *
 * @internal
 */
export interface TableDrawDeps {
  /** The renderers of the drawing by kind, and the resolution of the styles */
  readonly renderers: RetainedRendererSet;
  /** The renderer of the drawing in one draw */
  readonly rows: RowsRenderer;
  /** What draws the rows drawn at once */
  readonly batchManager: TableImmediateTarget;
  /** The renderers of the custom feature types */
  readonly customRenderers: Map<string, FeatureTypeHandler['renderer']>;
  /** The context given to a custom renderer */
  readonly customRendererContext: FrameDrawContext;
  /** The providers of companion drawing and companion hits */
  readonly companions: FeatureCompanionRegistry;
  /** The ids of the features in view (the rows drawn at once are drawn when theirs is) */
  readonly getVisibleIds?: () => ReadonlySet<string>;
  /** Re-establishes the blend state of our own drawing after an external renderer */
  readonly restoreBlendState?: () => void;
}

/**
 * What the drawing of the rows is made with
 *
 * @internal
 */
export interface TableLayerRendererOptions {
  readonly gl: WebGL2RenderingContext;
  /** What the drawing reads of the rows of the built-in Store */
  readonly reader: DrawnRows;
  /** The layer over the Store: the features of the rows drawn at once, and this client */
  readonly store: DocumentAccess;
  /** Where the textures of the state of the rows are recorded */
  readonly ledger: GpuLedger;
  /** The rendering pixel ratio (read from window when omitted) */
  readonly pixelRatio?: PixelRatioInput;
  /** The time the builds may take in a frame ({@link TABLE_BUILD_BUDGET_MS} when omitted) */
  readonly buildBudgetMs?: number;
  /** Asks for another frame */
  readonly requestRepaint: () => void;
  /**
   * Whether the work is spread over the frames (when it is not, every build of a frame is done in
   * it; read at each frame)
   */
  readonly timeSlicing?: () => boolean;
  /** Told when the rows are drawn by kind because the program of the drawing in one draw failed */
  readonly drawnByKind?: () => void;
  /** The terrain state of the instance (its changes make the chunks drawn by kind again) */
  readonly terrain?: TerrainContext;
}

/** A chunk of rows of every kind drawn in one draw */
interface RowsChunkState extends RetainedChunkState<RowsChunk> {
  readonly type: 'rows';
  readonly range: OrderedChunkRange;
}

/** A chunk of rows of one kind (the drawing by kind) */
interface KindChunkState extends RetainedChunkState<KindBatch> {
  readonly type: 'retained';
  readonly range: OrderedChunkRange;
}

/**
 * What the rows of a chunk drawn in one draw were cut with on the terrain or the globe: the
 * surface, its generation and the generation of the elevations, the step of its fills, the
 * fingerprint of the cut of each row (`rowSurfaceKey`), and the check against a newer surface in
 * progress
 */
interface ChunkCut {
  readonly kind: TableLayerSurface['kind'];
  generation: number;
  anchor: number;
  step: TessellationStep | null;
  readonly keys: Int32Array;
  /** The longest segment of the run of lines of each line (`RowsDraft.spreadRuns`) */
  readonly runMeters: Float32Array;
  readonly runMercator: Float32Array;
  check: CutCheck | null;
}

/** A check of the rows of a chunk against a newer surface, a slice at a time */
interface CutCheck {
  readonly generation: number;
  readonly anchor: number;
  /** The cells of the fills counted so far (while `step` is undefined) */
  cells: number;
  /** The step of the fills on the new surface (undefined until the cells are counted) */
  step: TessellationStep | null | undefined;
  /** The next row (of the count of the cells, then of the check) */
  at: number;
  /** The rows packed again, written into their places once every row is checked */
  readonly patches: Array<{ local: number; key: number; draft: RowsDraft }>;
}

/** A chunk of rows drawn at once */
interface AtOnceChunk {
  readonly type: 'immediate';
  readonly range: OrderedChunkRange;
}

type TableChunk = RowsChunkState | KindChunkState | AtOnceChunk;

/**
 * The ways the rows are drawn: in one draw, by kind, or draped (on the terrain, in the band of the
 * analytic drape: the polygons and the lines are on the drape, the other rows drawn at once)
 */
type Drawing = 'one-draw' | 'by-kind' | 'draped';

/** The types of the rows the analytic drape draws, and the pictures it pastes on the ground */
const DRAPED_TYPES: ReadonlySet<string> = new Set([
  'Polygon',
  'MultiPolygon',
  'LineString',
  'MultiLineString',
  'Freehand',
  'Image',
]);

/**
 * The surface the layers are drawn on in a frame: a flat map (pitched or not), the terrain or the
 * globe, and whether the polygons and the lines are on the analytic drape
 *
 * @internal
 */
export interface TableLayerSurface {
  readonly kind: 'flat' | 'terrain' | 'globe';
  readonly draped: boolean;
}

/** What is kept for a row group (or a part of the delta) */
interface GroupCache {
  readonly group: RowGroup;
  /** The chunks of the drawing (null until it is used) */
  chunks: TableChunk[] | null;
  /** The drawing the chunks are of */
  drawing: Drawing | null;
  /** The surface the chunks were cut for */
  surfaceKind: TableLayerSurface['kind'];
  /** The generation of the classification of the layer the chunks were cut with */
  generation: number;
  /** The chunks of the cut before, drawn until the chunks of the new cut are built in view */
  retiring: TableChunk[] | null;
  /** The generation of the styles of the layer the styles of its rows were resolved with */
  styleGeneration: number;
  /** The byte of the state of each row, as the texture holds it once written */
  readonly bytes: Uint8Array;
  /** The version of the state of the copies the bytes were made from (-1 before) */
  stateVersion: number;
  /** The generation of the state of this client the bytes were made with */
  clientGeneration: number;
  /** Whether bytes changed since the texture was written */
  dirty: boolean;
  texture: RowStateTexture | null;
  /**
   * Whether its chunks in view have been built once: until then they are built in the frame,
   * whatever the budget, so that rows the frame before drew are drawn in it too
   */
  shown: boolean;
  /** The part of the delta it holds the rows of (null for a row group) */
  readonly part: DeltaPart | null;
  /** The rows of its part marked gone when its bytes were made */
  marks: number;
}

/** What is kept for a layer */
interface LayerCache {
  readonly layerId: string;
  readonly groups: Map<RowGroupHandle, GroupCache>;
  /** The parts of the delta of the layer, by their groups */
  readonly extras: Map<RowGroup, GroupCache>;
  slots: RowStyleSlots | null;
  resolver: RetainedRendererSet['styles'] | null;
  rule: Layer['styleRule'];
  companionsGeneration: number;
  /** Advances whenever the rows are to be classified again */
  generation: number;
  /** Advances whenever the styles of the rows are to be resolved again */
  styleGeneration: number;
  /** The styles of the drawing in one draw (made again with a new resolution of the styles) */
  rowsStyles: RowsStyles | null;
  layer: Layer | null;
  deps: TableDrawDeps | null;
  /** The view the layer was drawn in last */
  bounds: BBox;
  drawing: Drawing;
  /** The surface the rows are classified for */
  surfaceKind: TableLayerSurface['kind'];
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
 * What this client hides and selects: the ids of the features, groups and layers it hides, the
 * rows of the features it selects, and the ids of the groups and layers it selects
 */
interface ClientState {
  readonly hiddenFeatures: Set<string>;
  readonly hiddenGroups: Set<string>;
  readonly hiddenLayers: Set<string>;
  readonly selectedRows: SelectedRows;
  readonly selectedGroups: Set<string>;
  readonly selectedLayers: Set<string>;
}

function emptyClientState(selectedRows = new SelectedRows(new Int32Array(0))): ClientState {
  return {
    hiddenFeatures: new Set(),
    hiddenGroups: new Set(),
    hiddenLayers: new Set(),
    selectedRows,
    selectedGroups: new Set(),
    selectedLayers: new Set(),
  };
}

/** The rows of the features selected, by their references, with one bit per reference */
class SelectedRows {
  /** The references, as the layer over the Store gave them (not written) */
  readonly refs: Int32Array;
  readonly #bits: Uint32Array;
  readonly #least: number;

  constructor(refs: Int32Array) {
    this.refs = refs;
    let least = refs.length > 0 ? refs[0] : 0;
    let most = least;
    for (let i = 1; i < refs.length; i++) {
      if (refs[i] < least) least = refs[i];
      else if (refs[i] > most) most = refs[i];
    }
    this.#least = least;
    this.#bits = new Uint32Array(refs.length > 0 ? ((most - least) >>> 5) + 1 : 0);
    for (let i = 0; i < refs.length; i++) {
      const at = refs[i] - least;
      this.#bits[at >>> 5] |= 1 << (at & 31);
    }
  }

  /** The number of rows */
  get count(): number {
    return this.refs.length;
  }

  /** Whether the row of a reference is selected */
  has(ref: number): boolean {
    const at = ref - this.#least;
    if (at < 0 || at >>> 5 >= this.#bits.length) return false;
    return (this.#bits[at >>> 5] & (1 << (at & 31))) !== 0;
  }
}

/**
 * The drawing of the layers from their rows
 *
 * @internal
 */
export class TableLayerRenderer {
  private readonly layers = new Map<string, LayerCache>();
  private readonly reader: DrawnRows;
  private readonly store: DocumentAccess;
  private budget: ChunkBuildBudget | null = null;
  private frameCount = 0;
  private pending = false;
  private prepared = false;
  /** Whether the rows are drawn by kind even where they can be drawn in one draw */
  private byKind = false;
  /** The surface of the frame */
  private surface: TableLayerSurface = { kind: 'flat', draped: false };
  /** The generations of the terrain the chunks were built for (-1 before the first frame) */
  private readonly terrainSeen = { render: -1, globe: -1, anchor: -1 };
  /** What the surface of the frame is, and the generation that advances when it changes */
  private surfaceKey = 'flat';
  private surfaceGeneration = 0;
  /** What the rows of the chunks drawn in one draw were cut with on the surface */
  private readonly cuts = new WeakMap<RowsChunk, ChunkCut>();
  private renderers: RetainedRendererSet | null = null;
  private rows: RowsRenderer | null = null;
  private record: TableDrawRecord[] | null = null;
  /** What this client hides and selects, as last read */
  private client: ClientState = emptyClientState();
  /** The selection as last read, and the rows of its features then (null for none) */
  private selectionRead: {
    readonly type: SelectionType | null;
    readonly ids: unknown;
    readonly rows: Int32Array | null;
  } | null = null;
  /** Advances whenever what this client hides or selects of a group or a layer changes */
  private clientGeneration = 0;
  /** Whether bytes of the state of rows were written since their textures were */
  private statesWritten = false;
  /** The rows written in place since the last pass before the main one, by layer and group */
  private readonly written = new Map<string, Map<RowGroupHandle, Map<number, PendingWrite>>>();
  /** What is kept for the groups of the next versions built, until they are swapped in */
  private readonly pendingCaches = new Map<GroupVersion, GroupCache[]>();
  /**
   * The features of the rows drawn at once, by their ids, with the frame each was drawn in last
   * (up to {@link IMMEDIATE_CACHE_LIMIT}): a feature goes when its row changes, and when the
   * number is reached, the ones not drawn in the frame go
   */
  private readonly atOnce = new Map<string, { feature: Feature; frame: number }>();
  /** The frame the features not drawn in it were let go in last */
  private atOnceTrimmed = -1;
  /**
   * The layers whose parts of the delta are to be packed or released: a part came or left, or the
   * rows are to be packed again (a new classification, new styles, a row written that did not fit)
   */
  private readonly deltaStale = new Set<string>();
  private readonly detach: Array<() => void> = [];
  /** The work counted for the tests */
  readonly stats: TableWorkStats = {
    rowsPacked: 0,
    stateRowsRead: 0,
    stateRowsWritten: 0,
    statesUploaded: 0,
    chunksBuilt: 0,
    featuresMade: 0,
    rowsWrittenInPlace: 0,
  };
  /** What the next versions of the row groups ask of the drawing */
  private readonly receiver: GroupVersionReceiver = {
    uploaded: (version) => this.versionUploaded(version),
    swapped: (version) => this.versionSwapped(version),
    dropped: (version) => this.versionDropped(version),
  };
  /** The layer and the group being drawn, for the hosts of the chunks */
  private readonly pass: {
    cache: LayerCache | null;
    groupCache: GroupCache | null;
    groupIndex: number;
    frame: TableLayerFrame | null;
    factors: RetainedDrawFactors;
    drawing: boolean;
  } = {
    cache: null,
    groupCache: null,
    groupIndex: 0,
    frame: null,
    factors: layerDrawFactors(undefined),
    drawing: true,
  };
  private readonly schedule: {
    bounds: BBox;
    zoom: number;
    settled: boolean;
    budget: ChunkBuildBudget;
  } = { bounds: world(), zoom: 0, settled: true, budget: createChunkBuildBudget(0) };
  private readonly rowsHost: ChunkSchedulerHost<RowsChunkState, RowsChunk>;
  private readonly kindHost: ChunkSchedulerHost<KindChunkState, KindBatch>;

  constructor(private readonly options: TableLayerRendererOptions) {
    this.reader = options.reader;
    this.store = options.store;
    const reader = this.reader;
    this.detach.push(reader.attachReceiver(this.receiver));
    this.detach.push(reader.onPendingWork(() => options.requestRepaint()));
    this.detach.push(reader.onRowsWritten((layerId, writes) => this.rowsWritten(layerId, writes)));
    this.detach.push(options.store.subscribe((change) => this.forgetAtOnce(change)));
    this.detach.push(
      reader.onDeltaChanged((layerId, change) => {
        // A part that came in is packed once, a part that left is released; a part whose rows
        // are marked gone writes the bytes of their state only (`uploadState`)
        if (change.addedParts.length > 0 || change.removedParts.length > 0) {
          this.deltaStale.add(layerId);
        }
        options.requestRepaint();
      }),
    );
    const pass = this.pass;
    this.rowsHost = {
      isStale: () => false,
      startJob: (state, origin) => {
        const cache = pass.cache as LayerCache;
        const groupCache = pass.groupCache as GroupCache;
        return this.rowsJob(cache, groupCache.group, state.range, origin);
      },
      adoptJob: () => {},
      disposeBatches: (chunk) => {
        this.dropCheck(chunk);
        this.rows?.disposeChunk(chunk);
      },
      draw: () => true,
    };
    this.kindHost = {
      isStale: () => false,
      startJob: (state, origin) => {
        const cache = pass.cache as LayerCache;
        const groupCache = pass.groupCache as GroupCache;
        return this.kindJob(cache, groupCache, state.range, origin);
      },
      adoptJob: () => {},
      disposeBatches: (batch) => {
        if (this.renderers) disposeKindBatch(batch, this.renderers);
      },
      draw: () => true,
    };
  }

  /** Whether the last frame left work for later frames */
  get hasPendingWork(): boolean {
    return this.pending || this.rows?.hasPendingUploads === true || this.reader.hasPendingWork;
  }

  /** Records every range drawn into an array, in order (null stops the recording) */
  recordDraws(record: TableDrawRecord[] | null): void {
    this.record = record;
  }

  /** Draws the rows by kind even where they can be drawn in one draw (for the tests) */
  setDrawingByKind(byKind: boolean): void {
    this.byKind = byKind;
  }

  /** Sets the surface the layers are drawn on in this frame */
  setSurface(surface: TableLayerSurface): void {
    this.surface = surface;
    const terrain = this.options.terrain;
    const key =
      surface.kind === 'flat' || !terrain
        ? surface.kind
        : `${surface.kind}|${terrain.renderState.generation}|${terrain.globeGeneration}`;
    if (key !== this.surfaceKey) {
      this.surfaceKey = key;
      this.surfaceGeneration++;
    }
  }

  /**
   * Starts a frame: the budget of the builds, the work of the tables in it, and what this client
   * hides and selects read again
   */
  beginFrame(): void {
    if (!this.prepared) this.prepareUploads();
    this.frameCount++;
    this.prepared = false;
    this.pending = false;
    this.budget = createChunkBuildBudget(
      this.options.timeSlicing?.() === false
        ? Number.POSITIVE_INFINITY
        : (this.options.buildBudgetMs ?? TABLE_BUILD_BUDGET_MS),
    );
    if (this.reader.advance(this.budget)) this.pending = true;
    this.followTerrain();
    this.readClientState();
    // What this client hides or selects now takes effect in this frame
    if (this.statesWritten) {
      this.statesWritten = false;
      this.uploadStates();
    }
  }

  /**
   * Ends a frame: what is kept of a layer that left the document is released, and another frame is
   * asked for when work is left
   */
  endFrame(): void {
    for (const [layerId, cache] of this.layers) {
      if (cache.drawnFrame === this.frameCount || this.store.getLayer(layerId)) continue;
      this.releaseLayer(cache);
      this.layers.delete(layerId);
    }
    if (this.hasPendingWork) this.options.requestRepaint();
  }

  /**
   * Writes what is queued to the GPU before the main pass of the frame: the writes in place, the
   * parts of the deltas, the state of the rows, the chunks built; then swaps in the next versions
   * whose chunks are built, and writes what that changed
   */
  prerender(): void {
    this.prepareUploads();
    this.prepared = true;
  }

  private prepareUploads(): void {
    this.applyWrites();
    this.packDeltas();
    this.uploadStates();
    this.rows?.flushUploads();
    this.reader.swap();
    this.applyWrites();
    this.packDeltas();
    this.uploadStates();
    this.rows?.flushUploads();
  }

  /**
   * Takes rows written in place: they are written into the chunks that draw them in the pass
   * before the main one of the next frame
   */
  private rowsWritten(layerId: string, writes: readonly InPlaceRowWrite[]): void {
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
   * Makes the chunks drawn by kind for the terrain or the globe again when what they were built
   * for changed: the step of the terrain, the subdivision of the globe, the elevations of the
   * anchors (the chunks drawn in one draw check their rows against it, `checkCut`)
   */
  private followTerrain(): void {
    const terrain = this.options.terrain;
    if (!terrain) return;
    const seen = this.terrainSeen;
    const render = terrain.renderState.generation;
    const globe = terrain.globeGeneration;
    const anchor = getAnchorElevationGeneration(terrain);
    const first = seen.render === -1;
    const changed = render !== seen.render || globe !== seen.globe || anchor !== seen.anchor;
    seen.render = render;
    seen.globe = globe;
    seen.anchor = anchor;
    if (!changed || first) return;
    for (const cache of this.layers.values()) {
      if (cache.drawing === 'by-kind') cache.slots = null;
    }
  }

  // === What this client hides and selects ===

  /**
   * Reads what this client hides and selects, and writes the bytes of the rows whose state it
   * changed: the rows of the features named only; every row of a layer, or of a group, named
   */
  private readClientState(): void {
    const store = this.store;
    let next = emptyClientState();
    for (const id of store.listHidden()) {
      if (store.getLayer(id)) next.hiddenLayers.add(id);
      else if (store.getGroup(id)) next.hiddenGroups.add(id);
      else next.hiddenFeatures.add(id);
    }
    const before = this.client;
    // The selection is read again only when it changed: the same set, whose rows are the same
    // array, selects the same rows (the rows of a feature selection are read without its IDs)
    const selection = store.getSelection();
    const rows = selection.type === 'feature' ? store.rowsOfFeatureSet(selection.ids) : null;
    const read = this.selectionRead;
    if (
      read !== null &&
      read.type === selection.type &&
      read.ids === selection.ids &&
      read.rows === rows
    ) {
      next = {
        ...next,
        selectedRows: before.selectedRows,
        selectedGroups: before.selectedGroups,
        selectedLayers: before.selectedLayers,
      };
    } else {
      this.selectionRead = { type: selection.type, ids: selection.ids, rows };
      if (rows) next = { ...next, selectedRows: new SelectedRows(rows) };
      const target =
        selection.type === 'group'
          ? next.selectedGroups
          : selection.type === 'layer'
            ? next.selectedLayers
            : null;
      if (target) for (const id of selection.ids.iterate()) target.add(id);
    }
    this.client = next;
    if (
      !sameSet(before.hiddenGroups, next.hiddenGroups) ||
      !sameSet(before.hiddenLayers, next.hiddenLayers) ||
      !sameSet(before.selectedGroups, next.selectedGroups) ||
      !sameSet(before.selectedLayers, next.selectedLayers)
    ) {
      // Every group's bytes are made again with the next upload
      this.clientGeneration++;
      this.statesWritten = true;
    }
    for (const id of changedIds(before.hiddenFeatures, next.hiddenFeatures)) this.writeRowOf(id);
    if (next.selectedRows !== before.selectedRows) {
      const { selectedRows: was } = before;
      const { selectedRows: now } = next;
      for (let i = 0; i < was.refs.length; i++) {
        if (!now.has(was.refs[i])) this.writeRowOfRef(was.refs[i]);
      }
      for (let i = 0; i < now.refs.length; i++) {
        if (!was.has(now.refs[i])) this.writeRowOfRef(now.refs[i]);
      }
    }
  }

  /** Writes the byte of the row of the feature of an id (in the group it is read from) */
  private writeRowOf(id: string): void {
    const ref = this.reader.refOfId(id);
    if (ref === undefined) return;
    this.writeRowOfRef(ref);
  }

  /** Writes the byte of the row of a reference (in the group it is read from) */
  private writeRowOfRef(ref: number): void {
    const place = this.reader.placeOf(ref);
    if (!place) return;
    const groupCache = this.cacheOfGroup(place.group);
    if (!groupCache || groupCache.stateVersion < 0) return;
    this.writeByte(groupCache, place.row);
  }

  /** The cache of a row group of a layer drawn (a group of its order, or a part of its delta) */
  private cacheOfGroup(group: RowGroup): GroupCache | undefined {
    for (const cache of this.layers.values()) {
      const found = cache.groups.get(group.handle) ?? cache.extras.get(group);
      if (found?.group === group) return found;
    }
    return undefined;
  }

  /** The byte of the state of a row, from the state of its copy and from this client */
  private byteOf(layerId: string, groupCache: GroupCache, row: number): number {
    const reader = this.reader;
    const client = this.client;
    const group = groupCache.group;
    this.stats.stateRowsRead++;
    let byte = 0;
    // A row of a part of the delta marked gone is read elsewhere now
    let hidden = reader.notDrawn(group, row) || groupCache.part?.gone[row] === 1;
    let selected = client.selectedLayers.has(layerId);
    const needsId =
      client.hiddenFeatures.size > 0 ||
      client.selectedRows.count > 0 ||
      client.hiddenGroups.size > 0 ||
      client.selectedGroups.size > 0;
    if (needsId && (!hidden || !selected)) {
      if (client.hiddenFeatures.size > 0 || client.selectedRows.count > 0) {
        const ref = reader.refOf(group, row);
        if (client.selectedRows.has(ref)) selected = true;
        if (client.hiddenFeatures.size > 0) {
          const id = reader.idOf(ref);
          if (id !== undefined && client.hiddenFeatures.has(id)) hidden = true;
        }
      }
      if (client.hiddenGroups.size > 0 || client.selectedGroups.size > 0) {
        const groupId = reader.groupIdOf(group, row);
        if (groupId !== undefined) {
          if (client.hiddenGroups.has(groupId)) hidden = true;
          if (client.selectedGroups.has(groupId)) selected = true;
        }
      }
    }
    if (hidden) byte |= ROW_STATE_HIDDEN;
    if (selected) byte |= ROW_STATE_SELECTED;
    return byte;
  }

  /** Writes the byte of one row of a group again */
  private writeByte(groupCache: GroupCache, row: number): void {
    const layerId = this.layerOf(groupCache);
    if (layerId === undefined || row >= groupCache.bytes.length) return;
    const byte = this.byteOf(layerId, groupCache, row);
    if (groupCache.bytes[row] === byte) return;
    groupCache.bytes[row] = byte;
    groupCache.dirty = true;
    this.statesWritten = true;
    this.stats.stateRowsWritten++;
    this.stateChanged(groupCache, row);
    this.options.requestRepaint();
  }

  /** The layer of a group cache */
  private layerOf(groupCache: GroupCache): string | undefined {
    for (const [layerId, cache] of this.layers) {
      if (cache.groups.get(groupCache.group.handle) === groupCache) return layerId;
      if (cache.extras.get(groupCache.group) === groupCache) return layerId;
    }
    return undefined;
  }

  /**
   * A byte of a row changed: a chunk drawn by kind holding it is built again (its batch leaves
   * its hidden rows out); a chunk drawn in one draw reads the byte as it is
   */
  private stateChanged(groupCache: GroupCache, row: number): void {
    if (groupCache.drawing !== 'by-kind' || !groupCache.chunks) return;
    for (const chunk of groupCache.chunks) {
      if (chunk.type !== 'retained' || row < chunk.range.from || row >= chunk.range.to) continue;
      this.invalidate(chunk, true);
    }
  }

  /**
   * Makes the bytes of the state of every row of a group again (its copies changed state, or what
   * this client hides or selects of a group or a layer changed)
   */
  private remakeBytes(layerId: string, groupCache: GroupCache): void {
    const group = groupCache.group;
    const n = groupCache.bytes.length;
    let changed = false;
    for (let row = 0; row < n; row++) {
      const byte = this.byteOf(layerId, groupCache, row);
      if (groupCache.bytes[row] === byte) continue;
      groupCache.bytes[row] = byte;
      this.stats.stateRowsWritten++;
      changed = true;
      if (groupCache.drawing === 'by-kind') this.stateChanged(groupCache, row);
    }
    groupCache.stateVersion = group.stateVersion;
    groupCache.clientGeneration = this.clientGeneration;
    groupCache.marks = groupCache.part?.goneCount ?? 0;
    if (changed) groupCache.dirty = true;
  }

  /**
   * Writes the textures of the state of the rows of every group whose state changed since they
   * were written (made for a group seen for the first time). Called in the pass before the main
   * one, so a state takes effect in the frame its texture is written
   */
  private uploadStates(): void {
    const gl = this.options.gl;
    for (const [layerId, cache] of this.layers) {
      for (const groupCache of [...cache.groups.values(), ...cache.extras.values()]) {
        this.uploadState(gl, layerId, groupCache);
      }
    }
    for (const [version, caches] of this.pendingCaches) {
      for (const groupCache of caches) this.uploadState(gl, version.table.tableId, groupCache);
    }
  }

  private uploadState(gl: WebGL2RenderingContext, layerId: string, groupCache: GroupCache): void {
    const group = groupCache.group;
    if (
      groupCache.stateVersion !== group.stateVersion ||
      groupCache.clientGeneration !== this.clientGeneration ||
      (groupCache.part !== null && groupCache.marks !== groupCache.part.goneCount)
    ) {
      const first = groupCache.stateVersion < 0;
      this.remakeBytes(layerId, groupCache);
      if (first) groupCache.dirty = true;
    }
    if (!groupCache.texture) {
      groupCache.texture = createRowStateTexture(gl, this.options.ledger, group.data.length);
      groupCache.dirty = true;
    }
    const texture = groupCache.texture;
    if (!texture || !groupCache.dirty) return;
    uploadRowState(gl, texture, groupCache.bytes);
    groupCache.dirty = false;
    this.stats.statesUploaded++;
  }

  // === The next versions of the row groups ===

  /**
   * Whether the chunks of a next version are built in view (a layer not drawn in the last frame
   * waits for nothing)
   */
  private versionUploaded(version: GroupVersion): boolean {
    const cache = this.layers.get(version.table.tableId);
    if (!cache || cache.drawnFrame < this.frameCount - 1) return true;
    const caches = this.pendingCaches.get(version);
    const groups = version.groups ?? [];
    if (!caches || caches.length !== groups.length) return false;
    for (const groupCache of caches) {
      if (!groupCache.chunks || groupCache.drawing !== cache.drawing) return false;
      if (groupCache.generation !== cache.generation) return false;
      if (!builtInView(groupCache.chunks, cache.bounds)) return false;
      if (!groupCache.texture || groupCache.dirty) return false;
    }
    return true;
  }

  /** A next version replaced its groups: its chunks are the ones of its groups from now */
  private versionSwapped(version: GroupVersion): void {
    const caches = this.pendingCaches.get(version) ?? [];
    this.pendingCaches.delete(version);
    const cache = this.layers.get(version.table.tableId);
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
      else if (groupCache) this.disposeGroup(groupCache);
    });
  }

  /** A next version was dropped: its chunks are released */
  private versionDropped(version: GroupVersion): void {
    for (const groupCache of this.pendingCaches.get(version) ?? []) this.disposeGroup(groupCache);
    this.pendingCaches.delete(version);
  }

  /**
   * Builds the chunks of the next versions of the groups of a layer that are built and wait,
   * without drawing them (within the budget)
   */
  private buildVersions(cache: LayerCache): void {
    const versions = this.reader.builtVersions(cache.layerId);
    if (versions.length === 0) return;
    const pass = this.pass;
    pass.drawing = false;
    for (const version of versions) {
      let caches = this.pendingCaches.get(version);
      if (!caches) {
        caches = (version.groups ?? []).map((group) => newGroupCache(group, cache.styleGeneration));
        this.pendingCaches.set(version, caches);
      }
      for (const groupCache of caches) {
        pass.groupCache = groupCache;
        pass.groupIndex = -1;
        this.chunksOf(cache, groupCache);
        this.buildChunks(groupCache);
      }
    }
    pass.drawing = true;
    this.pending = true;
  }

  // === Invalidation ===

  /**
   * Makes every chunk again (a new pixel ratio, a renderer of a custom type or a provider of
   * companions came or went): the chunks keep being drawn until the new ones are built
   */
  reclassify(): void {
    for (const cache of this.layers.values()) {
      cache.slots = null;
    }
  }

  /** Releases every GPU resource and what is kept of the layers */
  dispose(): void {
    for (const caches of this.pendingCaches.values()) {
      for (const groupCache of caches) this.disposeGroup(groupCache);
    }
    this.pendingCaches.clear();
    for (const cache of this.layers.values()) this.releaseLayer(cache);
    this.layers.clear();
    for (const detach of this.detach) detach();
    this.detach.length = 0;
    this.written.clear();
    this.atOnce.clear();
    this.renderers = null;
    this.rows = null;
  }

  private releaseLayer(cache: LayerCache): void {
    for (const groupCache of cache.groups.values()) this.disposeGroup(groupCache);
    for (const groupCache of cache.extras.values()) this.disposeGroup(groupCache);
    cache.groups.clear();
    cache.extras.clear();
    if (cache.rowsStyles) this.rows?.retirePalette(cache.rowsStyles.palette);
    cache.rowsStyles = null;
  }

  // === Drawing ===

  /**
   * Draws a layer from its rows, in the order of its rows
   *
   * @returns false when the layer cannot be drawn from its rows (nothing is drawn)
   */
  drawLayer(layerId: string, layer: Layer, frame: TableLayerFrame, deps: TableDrawDeps): boolean {
    const table = this.reader.table(layerId);
    this.renderers = deps.renderers;
    this.rows = deps.rows;
    const surface = this.surface;
    const oneDraw = deps.rows.ready && !this.byKind;
    const drawing: Drawing = surface.draped ? 'draped' : oneDraw ? 'one-draw' : 'by-kind';
    if (deps.rows.failed && !this.byKind) this.options.drawnByKind?.();
    const cache = this.layerCache(layerId, table, layer, deps, drawing);
    cache.bounds = frame.bounds ?? world();
    cache.drawnFrame = this.frameCount;
    // The parts of a layer seen for the first time, or to be packed again, are packed now
    if (this.deltaStale.has(layerId)) this.packDelta(layerId, cache);
    if (!table) return true;
    // A layer hidden, or hidden on this client, draws nothing
    if (layer.visible === false || this.client.hiddenLayers.has(layerId)) return true;

    const budget = this.budget ?? createChunkBuildBudget(TABLE_BUILD_BUDGET_MS);
    this.budget = budget;
    const pass = this.pass;
    pass.cache = cache;
    pass.frame = frame;
    pass.factors = layerDrawFactors(layer);
    pass.drawing = true;
    const schedule = this.schedule;
    schedule.bounds = frame.bounds ?? world();
    schedule.zoom = frame.zoom;
    schedule.settled = true;
    schedule.budget = budget;

    // The rows of the parts of the delta, by the place of the group they come before
    const inserts = new Map<number, DeltaInsert[]>();
    for (const insert of this.reader.deltaInserts(table)) {
      let list = inserts.get(insert.group);
      if (!list) {
        list = [];
        inserts.set(insert.group, list);
      }
      list.push(insert);
    }
    try {
      for (let g = 0; g < table.groupCount; g++) {
        const group = table.groupAt(g);
        const groupCache = cache.groups.get(group.handle);
        const list = inserts.get(g) ?? [];
        if (!groupCache) {
          for (const insert of list) this.drawInsert(cache, insert);
          continue;
        }
        pass.groupCache = groupCache;
        pass.groupIndex = g;
        this.drawGroup(cache, groupCache, list);
      }
      for (const insert of inserts.get(-1) ?? []) this.drawInsert(cache, insert);
      this.buildVersions(cache);
    } finally {
      pass.cache = null;
      pass.groupCache = null;
      pass.frame = null;
      pass.drawing = true;
    }
    return true;
  }

  /** The cache of a layer, its groups following the groups of its table */
  private layerCache(
    layerId: string,
    table: RowTable | undefined,
    layer: Layer,
    deps: TableDrawDeps,
    drawing: Drawing,
  ): LayerCache {
    let cache = this.layers.get(layerId);
    if (!cache) {
      cache = {
        layerId,
        groups: new Map(),
        extras: new Map(),
        slots: null,
        resolver: null,
        rule: undefined,
        companionsGeneration: -1,
        generation: 0,
        styleGeneration: 0,
        rowsStyles: null,
        layer: null,
        deps: null,
        bounds: world(),
        drawing,
        surfaceKind: this.surface.kind,
        drawnFrame: -1,
      };
      this.layers.set(layerId, cache);
      this.deltaStale.add(layerId);
    }
    cache.layer = layer;
    cache.deps = deps;
    const resolver = deps.renderers.styles;
    // What the classification reads: the resolution of the styles, the providers of companions;
    // a new style rule changes the colors (and the shapes it gives the points)
    if (
      cache.slots === null ||
      cache.resolver !== resolver ||
      cache.rule !== layer.styleRule ||
      cache.companionsGeneration !== deps.companions.generation()
    ) {
      cache.slots = new RowStyleSlots(resolver, this.reader, layer.styleRule);
      cache.resolver = resolver;
      cache.rule = layer.styleRule;
      cache.companionsGeneration = deps.companions.generation();
      cache.generation++;
      cache.styleGeneration++;
      this.deltaStale.add(layerId);
    }
    if (cache.drawing !== drawing) {
      cache.drawing = drawing;
      cache.generation++;
      this.deltaStale.add(layerId);
    }
    // Onto the terrain or the globe, or off them: the rows are classified and packed for it
    if (cache.surfaceKind !== this.surface.kind) {
      cache.surfaceKind = this.surface.kind;
      cache.generation++;
      this.deltaStale.add(layerId);
    }
    // The styles of the drawing in one draw: made again with a new resolution of the styles
    const rowsStyles = cache.rowsStyles;
    if (!rowsStyles || rowsStyles.slots.resolver !== resolver) {
      if (rowsStyles) deps.rows.retirePalette(rowsStyles.palette);
      cache.rowsStyles = new RowsStyles(
        cache.slots,
        new RowsPalette(),
        this.options.pixelRatio,
        this.reader,
      );
    } else {
      rowsStyles.slots = cache.slots;
      rowsStyles.setPixelRatio(this.options.pixelRatio);
    }
    // The groups that left the layer are released, the groups that came in are kept
    for (const [handle, groupCache] of cache.groups) {
      if (table?.group(handle) !== groupCache.group) {
        this.disposeGroup(groupCache);
        cache.groups.delete(handle);
      }
    }
    if (table) {
      for (let g = 0; g < table.groupCount; g++) {
        const group = table.groupAt(g);
        if (cache.groups.has(group.handle)) continue;
        cache.groups.set(group.handle, newGroupCache(group, cache.styleGeneration));
      }
    }
    return cache;
  }

  /**
   * The context the rows of a layer are packed with
   *
   * @param surface The surface they are packed for (none on a flat map)
   */
  private packContext(cache: LayerCache, surface: RowsSurface | null = null): RowsPackContext {
    return {
      rows: this.reader,
      slots: cache.slots as RowStyleSlots,
      rowsStyles: cache.rowsStyles as RowsStyles,
      surface,
    };
  }

  /** The surface the rows are packed for with a step of the fills */
  private surfaceOf(step: TessellationStep | null): RowsSurface | null {
    const terrain = this.options.terrain;
    return terrain ? { terrain, fill: step } : null;
  }

  /** The step of the fills of the surface of the frame (none on a flat map) */
  private baseFillStep(): TessellationStep | null {
    const terrain = this.options.terrain;
    if (!terrain || this.surface.kind === 'flat') return null;
    return getSurfaceTessellationStep(terrain, 'fill');
  }

  /**
   * Checks the rows of a chunk in view cut for an older surface, or older elevations, against the
   * ones of the frame, within the budget: the cells of its fills are counted for the step of the
   * new surface, then each row whose fingerprint changed is packed again; once every row is
   * checked, they are written into their places. A row that does not fit its place makes the chunk
   * build again; the chunk draws as it was until then
   */
  private checkCut(cache: LayerCache, groupCache: GroupCache, chunk: RowsChunkState): void {
    const gpu = chunk.batches;
    if (!gpu || chunk.job || chunk.stale) return;
    const cut = this.cuts.get(gpu);
    if (!cut || cut.kind !== this.surface.kind) return;
    const terrain = this.options.terrain as TerrainContext;
    const generation = this.surfaceGeneration;
    const anchor = getAnchorElevationGeneration(terrain);
    if (cut.generation === generation && cut.anchor === anchor) return;
    if (!meets(chunk.bounds, this.schedule.bounds)) return;
    const rowsStyles = cache.rowsStyles;
    const rows = this.rows;
    if (!rows || !rowsStyles || !cache.slots || gpu.data.palette !== rowsStyles.palette) return;
    const budget = this.schedule.budget;
    if (!budget.canStep()) {
      this.pending = true;
      return;
    }
    if (cut.check && (cut.check.generation !== generation || cut.check.anchor !== anchor)) {
      this.dropCheck(gpu);
    }
    cut.check ??= {
      generation,
      anchor,
      cells: 0,
      // The step stays when only the elevations changed
      step: cut.generation === generation ? cut.step : undefined,
      at: 0,
      patches: [],
    };
    const check = cut.check;
    const group = groupCache.group;
    const data = gpu.data;
    const done = budget.step((deadline) => {
      const base = this.baseFillStep();
      if (check.step === undefined) {
        // The cells of the fills of the chunk, for the coarsening of the step of the new surface
        const context = this.packContext(cache);
        while (check.at < data.rows) {
          if (base) check.cells += rowFillCells(group, data.rowBase + check.at, context, base);
          check.at++;
          if (check.at % RECUT_SLICE_ROWS === 0 && budget.now() >= deadline) return false;
        }
        check.step = base ? surfaceFillStep(terrain, base, check.cells) : null;
        check.at = 0;
      }
      const context = this.packContext(cache, this.surfaceOf(check.step));
      // The fingerprints of the polygons follow the surface, those of the points the elevations
      const polygons = cut.generation !== generation;
      const points = cut.anchor !== anchor;
      while (check.at < data.rows) {
        const local = check.at;
        const row = data.rowBase + local;
        const type = this.reader.hasGeometry(group, row) ? this.reader.typeOf(group, row) : '';
        const point = type === 'Point' || type === 'MultiPoint';
        const polygon = type === 'Polygon' || type === 'MultiPolygon' || type === 'Circle';
        if (!(point ? points : polygon && polygons)) {
          check.at++;
          if (check.at % RECUT_SLICE_ROWS === 0 && budget.now() >= deadline) return false;
          continue;
        }
        const key = rowSurfaceKey(group, row, context);
        if (key !== cut.keys[local]) {
          const draft = new RowsDraft(1, row, undefined, rowsStyles.palette);
          collectRow(group, row, 0, draft, data.origin, context);
          check.patches.push({ local, key, draft });
          this.stats.rowsPacked++;
        }
        check.at++;
        if (check.at % RECUT_SLICE_ROWS === 0 && budget.now() >= deadline) return false;
      }
      return true;
    });
    if (!done) {
      this.pending = true;
      return;
    }
    cut.check = null;
    for (let i = 0; i < check.patches.length; i++) {
      const { local, key, draft } = check.patches[i];
      if (rows.patchRows(gpu, local, draft.finish(data.origin, data.palette))) {
        cut.keys[local] = key;
        continue;
      }
      // A row that does not fit its place: the chunk builds again (drawn until then)
      for (let j = i; j < check.patches.length; j++) check.patches[j].draft.releaseStyles();
      this.invalidate(chunk, true);
      this.pending = true;
      return;
    }
    cut.generation = generation;
    cut.anchor = anchor;
    cut.step = check.step ?? null;
  }

  /** Drops the check of the rows of a chunk in progress (its rows packed again let go) */
  private dropCheck(gpu: RowsChunk): void {
    const cut = this.cuts.get(gpu);
    if (!cut?.check) return;
    for (const patch of cut.check.patches) patch.draft.releaseStyles();
    cut.check = null;
  }

  /**
   * The chunks of a group for the drawing of its layer, cut when the drawing first needs them and
   * cut again when the classification changed (the chunks of the cut before keep drawing until
   * the new ones are built in view)
   */
  private chunksOf(cache: LayerCache, groupCache: GroupCache): TableChunk[] {
    if (
      groupCache.chunks &&
      groupCache.generation === cache.generation &&
      groupCache.drawing === cache.drawing
    ) {
      return groupCache.chunks;
    }
    const held = groupCache.chunks;
    // A group cut before is cut again within the budget of the frames (it keeps drawing its
    // chunks until then); a group cut for the first time is cut now
    const budget = this.budget;
    if (held && budget && groupCache.drawing === cache.drawing) {
      if (!budget.canStep()) {
        this.pending = true;
        return held;
      }
      return budget.step(() => this.cutGroup(cache, groupCache));
    }
    return this.cutGroup(cache, groupCache);
  }

  /** Cuts the rows of a group into chunks for the drawing of its layer */
  private cutGroup(cache: LayerCache, groupCache: GroupCache): TableChunk[] {
    const group = groupCache.group;
    const oneDraw = cache.drawing === 'one-draw';
    const deps = cache.deps as TableDrawDeps;
    // Draped, every row is drawn at once (the ones the drape draws are passed over then)
    const draped = cache.drawing === 'draped';
    const ranges = partitionRowGroup(this.reader, group, (row) =>
      draped
        ? this.reader.hasGeometry(group, row)
          ? 'immediate'
          : null
        : classifyRow(group, row, {
            rows: this.reader,
            slots: cache.slots as RowStyleSlots,
            customTypes: deps.customRenderers,
            companions: deps.companions,
            featureOf: (g, r) => this.featureOfRow(g, r),
            layer: cache.layer ?? undefined,
            oneDraw,
            onSurface: cache.surfaceKind !== 'flat',
          }),
    );
    const chunks = ranges.flatMap((range) => makeChunk(range));
    const drawn = groupCache.chunks;
    // The chunks of the cut before keep drawing until the new ones are built in view, when they
    // are of the same drawing; those of the other drawing go now
    if (drawn && groupCache.drawing === cache.drawing) {
      if (groupCache.retiring)
        for (const chunk of groupCache.retiring) this.invalidate(chunk, false);
      groupCache.retiring = drawn;
    } else if (drawn) {
      for (const chunk of drawn) this.invalidate(chunk, false);
      if (groupCache.retiring)
        for (const chunk of groupCache.retiring) this.invalidate(chunk, false);
      groupCache.retiring = null;
    }
    groupCache.chunks = chunks;
    groupCache.drawing = cache.drawing;
    groupCache.surfaceKind = cache.surfaceKind;
    groupCache.generation = cache.generation;
    groupCache.styleGeneration = cache.styleGeneration;
    return chunks;
  }

  /** The feature of a row (for the rows drawn at once, and for the classification of some) */
  private featureOfRow(group: RowGroup, row: number): Feature | undefined {
    const id = this.reader.idOf(this.reader.refOf(group, row));
    if (id === undefined) return undefined;
    this.stats.featuresMade++;
    return this.store.getFeature(id);
  }

  /**
   * Builds the chunks of a group in view within the budget, without drawing them (whatever the
   * budget for a group of the order drawn for the first time)
   */
  private buildChunks(groupCache: GroupCache, first = false): void {
    const schedule = this.schedule;
    const budget = schedule.budget;
    if (first) schedule.budget = createChunkBuildBudget(Number.POSITIVE_INFINITY);
    try {
      for (const chunk of groupCache.chunks ?? []) this.advanceChunk(chunk);
    } finally {
      schedule.budget = budget;
    }
  }

  /** Builds a chunk in view (a step of its build, within the budget) */
  private advanceChunk(chunk: TableChunk): void {
    if (chunk.type === 'immediate') return;
    const pending =
      chunk.type === 'rows'
        ? advanceChunkBuild(chunk, this.schedule as ChunkSchedulerFrame, this.rowsHost)
        : advanceChunkBuild(chunk, this.schedule as ChunkSchedulerFrame, this.kindHost);
    if (pending) this.pending = true;
  }

  /**
   * Draws a group: its chunks in their order, with the rows of the parts of the delta drawn at
   * their places among its rows
   */
  private drawGroup(
    cache: LayerCache,
    groupCache: GroupCache,
    inserts: readonly DeltaInsert[],
  ): void {
    const chunks = this.chunksOf(cache, groupCache);
    // The chunks of the new cut are built; until they are built in view, the group draws the
    // chunks of the cut before
    this.buildChunks(groupCache, !groupCache.shown);
    // The chunks in view cut for an older surface check their rows against this one
    for (const chunk of chunks) {
      if (chunk.type === 'rows') this.checkCut(cache, groupCache, chunk);
    }
    if (builtInView(chunks, cache.bounds)) groupCache.shown = true;
    let drawn = chunks;
    const retiring = groupCache.retiring;
    if (retiring) {
      if (builtInView(chunks, cache.bounds)) {
        const kept = new Set(chunks);
        for (const chunk of retiring) if (!kept.has(chunk)) this.invalidate(chunk, false);
        groupCache.retiring = null;
      } else {
        drawn = retiring;
        this.pending = true;
      }
    }
    let next = 0;
    for (const chunk of drawn) {
      const { from, to } = chunk.range;
      while (next < inserts.length && inserts[next].at <= from) {
        this.drawInsert(cache, inserts[next++]);
      }
      let at = from;
      while (next < inserts.length && inserts[next].at < to) {
        const insert = inserts[next++];
        this.drawChunkRange(cache, groupCache, chunk, at, insert.at);
        at = insert.at;
        this.drawInsert(cache, insert);
      }
      this.drawChunkRange(cache, groupCache, chunk, at, to);
    }
    while (next < inserts.length) this.drawInsert(cache, inserts[next++]);
  }

  /** Draws the rows `[from, to)` of a chunk of a group */
  private drawChunkRange(
    cache: LayerCache,
    groupCache: GroupCache,
    chunk: TableChunk,
    from: number,
    to: number,
  ): void {
    if (to <= from) return;
    const frame = this.pass.frame as TableLayerFrame;
    if (chunk.type === 'immediate') {
      this.drawAtOnce(cache, groupCache, from, to);
      this.recordRange(cache, groupCache, 'immediate', from, to);
      return;
    }
    if (!meets(chunk.bounds, frame.bounds ?? world())) return;
    if (!chunk.batches) {
      this.pending = true;
      return;
    }
    // A group drawn for the first time, and a chunk built in this frame, are written now (in the
    // pass before the main one otherwise), so that what the frame before drew is drawn in it
    if (!groupCache.texture) this.uploadState(this.options.gl, cache.layerId, groupCache);
    if (chunk.type === 'rows' && !chunk.batches.uploaded) this.rows?.flushUploads();
    const texture = groupCache.texture;
    if (!texture || (chunk.type === 'rows' && !chunk.batches.uploaded)) {
      this.pending = true;
      return;
    }
    if (chunk.type === 'rows') {
      const base = chunk.range.from;
      (this.rows as RowsRenderer).drawRange(
        chunk.batches,
        from - base,
        to - base,
        frame.zoom,
        frame.projectionData,
        texture,
        this.pass.factors,
      );
    } else {
      drawKindBatch(
        chunk.batches,
        this.renderers as RetainedRendererSet,
        frame.zoom,
        frame.projectionData,
        this.pass.factors,
      );
    }
    this.recordRange(cache, groupCache, chunk.range.kind, from, to);
  }

  /** Draws rows read outside the row groups at their place */
  private drawInsert(cache: LayerCache, insert: DeltaInsert): void {
    const partCache = cache.extras.get(insert.rows);
    if (!partCache) {
      // Not packed yet (it is before the next frame): drawn at once
      this.pending = true;
      const part = newGroupCache(insert.rows, cache.styleGeneration);
      this.drawAtOnce(cache, part, insert.from, insert.to, true);
      return;
    }
    const pass = this.pass;
    const groupIndex = pass.groupIndex;
    const groupCache = pass.groupCache;
    pass.groupIndex = -1;
    pass.groupCache = partCache;
    try {
      for (const chunk of partCache.chunks ?? []) {
        const a = Math.max(insert.from, chunk.range.from);
        const b = Math.min(insert.to, chunk.range.to);
        if (b <= a) continue;
        if (chunk.type !== 'immediate' && !chunk.batches) {
          this.drawAtOnce(cache, partCache, a, b, true);
          this.recordRange(cache, partCache, 'immediate', a, b);
          continue;
        }
        this.drawChunkRange(cache, partCache, chunk, a, b);
      }
    } finally {
      pass.groupIndex = groupIndex;
      pass.groupCache = groupCache;
    }
  }

  /**
   * Draws rows of a group at once, from their features, the ones in view (by the ids of the
   * features in view)
   *
   * @param byCopy Whether the state of the rows is read from their copies (a part not packed)
   */
  private drawAtOnce(
    cache: LayerCache,
    groupCache: GroupCache,
    from: number,
    to: number,
    byCopy = false,
  ): void {
    const deps = cache.deps as TableDrawDeps;
    const frame = this.pass.frame as TableLayerFrame;
    const layer = cache.layer ?? undefined;
    const visible = frame.bounds !== undefined ? deps.getVisibleIds?.() : undefined;
    const { batchManager, customRenderers, customRendererContext } = deps;
    let begun = false;
    // Draped, the rows the drape draws are passed over
    const draped = cache.drawing === 'draped';
    for (let row = from; row < to; row++) {
      if (draped && DRAPED_TYPES.has(this.reader.typeOf(groupCache.group, row))) continue;
      const fresh = byCopy || groupCache.stateVersion < 0;
      const hidden = fresh
        ? (this.byteOf(cache.layerId, groupCache, row) & ROW_STATE_HIDDEN) !== 0
        : (groupCache.bytes[row] & ROW_STATE_HIDDEN) !== 0;
      if (hidden) continue;
      if (!this.reader.hasGeometry(groupCache.group, row)) continue;
      const id = this.reader.idOf(this.reader.refOf(groupCache.group, row));
      if (id === undefined || (visible && !visible.has(id))) continue;
      const feature = this.atOnceFeature(id);
      if (!feature) continue;
      if (!begun) {
        batchManager.beginFrame(frame.projectionData, frame.zoom, layer);
        begun = true;
      }
      drawFeatureCompanionsInFrame(
        deps.companions,
        feature,
        batchManager,
        frame.projectionData,
        frame.zoom,
        layer,
        customRendererContext,
        deps.restoreBlendState,
      );
      const renderer = customRendererOf(customRenderers, feature);
      if (renderer) {
        batchManager.endFrame();
        renderer.draw(feature, frame.projectionData, frame.zoom, customRendererContext);
        deps.restoreBlendState?.();
        batchManager.beginFrame(frame.projectionData, frame.zoom, layer);
      } else {
        batchManager.processFeature(feature, false);
      }
    }
    if (begun) batchManager.endFrame();
  }

  /**
   * The feature of a row drawn at once: the one kept while its row has not changed, else made
   * (and kept while there is room)
   */
  private atOnceFeature(id: string): Feature | undefined {
    const frame = this.frameCount;
    const kept = this.atOnce.get(id);
    if (kept) {
      kept.frame = frame;
      return kept.feature;
    }
    const feature = this.store.getFeature(id);
    this.stats.featuresMade++;
    if (!feature) return undefined;
    if (this.atOnce.size >= IMMEDIATE_CACHE_LIMIT && this.atOnceTrimmed !== frame) {
      // Full: the features not drawn in this frame go, once a frame
      this.atOnceTrimmed = frame;
      for (const [keptId, entry] of this.atOnce) {
        if (entry.frame !== frame) this.atOnce.delete(keptId);
      }
    }
    if (this.atOnce.size < IMMEDIATE_CACHE_LIMIT) this.atOnce.set(id, { feature, frame });
    return feature;
  }

  /** Lets go of the features kept of the rows a change of the document changed */
  private forgetAtOnce(change: StoreChange): void {
    if (this.atOnce.size === 0) return;
    if (change.reset) {
      this.atOnce.clear();
      return;
    }
    const features = change.features;
    if (!features) return;
    for (const feature of features.created ?? []) this.atOnce.delete(feature.id);
    for (const { id } of features.updated ?? []) this.atOnce.delete(id);
    for (const feature of features.deleted ?? []) this.atOnce.delete(feature.id);
  }

  /** Records a range drawn */
  private recordRange(
    cache: LayerCache,
    groupCache: GroupCache,
    kind: TableRunKind,
    from: number,
    to: number,
  ): void {
    if (!this.record) return;
    const delta = cache.extras.get(groupCache.group) === groupCache;
    this.record.push({
      layerId: cache.layerId,
      group: groupCache.group.handle,
      groupIndex: delta ? -1 : this.pass.groupIndex,
      kind,
      from,
      to,
      ...(delta && { delta: true }),
    });
  }

  // === The builds ===

  /** A build of a chunk drawn in one draw: the rows packed a slice at a time */
  private rowsJob(
    cache: LayerCache,
    group: RowGroup,
    range: OrderedChunkRange,
    origin: [number, number],
  ): RetainedChunkJob<RowsChunk> {
    const rows = this.rows as RowsRenderer;
    // On the terrain or the globe the rows are packed for the surface of the frame the build
    // starts in: its fills with the step of the surface coarsened for the cells of the chunk
    const kind = this.surface.kind;
    const terrain = this.options.terrain;
    const onSurface = kind !== 'flat' && terrain !== undefined;
    const generation = this.surfaceGeneration;
    const anchor = terrain ? getAnchorElevationGeneration(terrain) : -1;
    const base = onSurface ? this.baseFillStep() : null;
    let cells = 0;
    let counted = !base;
    let context = this.packContext(cache, onSurface ? this.surfaceOf(null) : null);
    const palette = context.rowsStyles.palette;
    const roundedOrigin: [number, number] = [Math.fround(origin[0]), Math.fround(origin[1])];
    const draft = new RowsDraft(range.to - range.from, range.from, range.vertices, palette);
    let at = range.from;
    let result: RowsChunk | null = null;
    let disposed = false;
    return {
      step: (deadline, now) => {
        while (!counted) {
          const end = Math.min(range.to, at + SLICE_ROWS);
          for (; at < end; at++)
            cells += rowFillCells(group, at, context, base as TessellationStep);
          if (at >= range.to) {
            counted = true;
            at = range.from;
            context = this.packContext(
              cache,
              this.surfaceOf(
                surfaceFillStep(terrain as TerrainContext, base as TessellationStep, cells),
              ),
            );
          } else if (now() >= deadline) {
            return false;
          }
        }
        do {
          const end = Math.min(range.to, at + SLICE_ROWS);
          // Counted as they are packed, in the frame they are packed in
          this.stats.rowsPacked += end - at;
          for (; at < end; at++)
            collectRow(group, at, at - range.from, draft, roundedOrigin, context);
        } while (at < range.to && now() < deadline);
        if (at < range.to) return false;
        this.stats.chunksBuilt++;
        if (onSurface) draft.spreadRuns();
        result = rows.createChunk(draft.finish(roundedOrigin, palette));
        if (onSurface) {
          this.cuts.set(result, {
            kind,
            generation,
            anchor,
            step: context.surface?.fill ?? null,
            keys: draft.keys,
            runMeters: draft.runMeters,
            runMercator: draft.runMercator,
            check: null,
          });
        }
        return true;
      },
      take: () => result,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (result) rows.disposeChunk(result);
        else draft.releaseStyles();
      },
    };
  }

  /** A build of a chunk drawn by kind: the batch of the features of its rows drawn */
  private kindJob(
    cache: LayerCache,
    groupCache: GroupCache,
    range: OrderedChunkRange,
    origin: [number, number],
  ): RetainedChunkJob<KindBatch> {
    let result: KindBatch | null = null;
    return {
      step: () => {
        const features: Feature[] = [];
        for (let row = range.from; row < range.to; row++) {
          if ((groupCache.bytes[row] & ROW_STATE_HIDDEN) !== 0) continue;
          if (!this.reader.hasGeometry(groupCache.group, row)) continue;
          const feature = this.featureOfRow(groupCache.group, row);
          if (feature) features.push(feature);
        }
        this.stats.chunksBuilt++;
        result = buildKindBatch(
          range.kind,
          features,
          cache.layer ?? undefined,
          [Math.fround(origin[0]), Math.fround(origin[1])],
          this.renderers as RetainedRendererSet,
        );
        return true;
      },
      take: () => result,
      dispose: () => {
        if (result && this.renderers) disposeKindBatch(result, this.renderers);
      },
    };
  }

  /** Makes a chunk build again (with `keepDrawing`, drawn until the new one is built) */
  private invalidate(chunk: TableChunk, keepDrawing: boolean): void {
    if (chunk.type === 'immediate') return;
    if (chunk.type === 'rows') {
      invalidateChunk<RowsChunkState, RowsChunk>(chunk, this.rowsHost, keepDrawing);
      return;
    }
    invalidateChunk<KindChunkState, KindBatch>(chunk, this.kindHost, keepDrawing);
  }

  private disposeGroup(groupCache: GroupCache): void {
    for (const chunk of groupCache.chunks ?? []) this.invalidate(chunk, false);
    for (const chunk of groupCache.retiring ?? []) this.invalidate(chunk, false);
    groupCache.chunks = null;
    groupCache.retiring = null;
    if (groupCache.texture) {
      releaseRowStateTexture(this.options.gl, this.options.ledger, groupCache.texture);
      groupCache.texture = null;
    }
  }

  // === The rows read outside the row groups ===

  /** The cache of a group of rows read outside the row groups, by the handle of its group */
  private extraOf(cache: LayerCache, handle: RowGroupHandle): GroupCache | undefined {
    if (handle < 0) return undefined;
    for (const extra of cache.extras.values()) if (extra.group.handle === handle) return extra;
    return undefined;
  }

  /**
   * Packs the parts of the delta that came in since the last pass, of every layer drawn (whole: a
   * part is small), before the main pass, so they are on the GPU in the frame the copies in their
   * groups are hidden; releases the parts that left. A part is packed once, when it comes in, and
   * again only when the rows of its layer are to be packed again
   */
  private packDeltas(): void {
    if (this.deltaStale.size === 0) return;
    for (const layerId of [...this.deltaStale]) {
      const cache = this.layers.get(layerId);
      if (!cache) {
        this.deltaStale.delete(layerId);
        continue;
      }
      this.packDelta(layerId, cache);
    }
  }

  /** Packs the parts of the delta of a layer that are not packed as its rows are now */
  private packDelta(layerId: string, cache: LayerCache): void {
    // What the rows are packed with is there once the layer has been drawn
    const packable = cache.deps !== null && cache.slots !== null && cache.rowsStyles !== null;
    const table = this.reader.table(layerId);
    const parts = table ? this.reader.deltaParts(table) : [];
    const alive = new Set<RowGroup>();
    for (const part of parts) {
      const group = part.group;
      alive.add(group);
      const held = cache.extras.get(group);
      if (
        held?.chunks &&
        held.generation === cache.generation &&
        held.drawing === cache.drawing &&
        held.styleGeneration === cache.styleGeneration
      ) {
        continue;
      }
      if (!packable) continue;
      if (held) this.disposeGroup(held);
      const partCache = newGroupCache(group, cache.styleGeneration, part);
      cache.extras.set(group, partCache);
      this.packPart(cache, partCache);
    }
    for (const [group, partCache] of cache.extras) {
      if (alive.has(group)) continue;
      this.disposeGroup(partCache);
      cache.extras.delete(group);
    }
    if (packable) this.deltaStale.delete(layerId);
  }

  /** Packs every chunk of a part of the delta at once */
  private packPart(cache: LayerCache, partCache: GroupCache): void {
    const chunks = this.cutGroup(cache, partCache);
    const pass = this.pass;
    const before = { cache: pass.cache, groupCache: pass.groupCache };
    pass.cache = cache;
    pass.groupCache = partCache;
    try {
      for (const chunk of chunks) {
        if (chunk.type === 'immediate' || !chunk.bounds) continue;
        const origin = chunkOriginOf(chunk.bounds);
        const job =
          chunk.type === 'rows'
            ? this.rowsJob(cache, partCache.group, chunk.range, origin)
            : this.kindJob(cache, partCache, chunk.range, origin);
        job.step(Number.POSITIVE_INFINITY, chunkClock);
        const built = job.take();
        if (!built) continue;
        (chunk as RetainedChunkState<RowsChunk | KindBatch>).batches = built;
        chunk.origin = origin;
      }
    } finally {
      pass.cache = before.cache;
      pass.groupCache = before.groupCache;
    }
  }

  // === The writes in place ===

  /**
   * Writes the rows written in place since the last pass into the chunks that draw them: a row
   * that keeps its shape by its coordinates only, a row whose style changed within the layout of
   * its instances by its style only, another row packed again into its place in its chunk when it
   * fits. A row that does not fit its place is put into the delta of its layer; a row of a part
   * of the delta makes the part be packed again
   */
  private applyWrites(): void {
    if (this.written.size === 0) return;
    for (const [layerId, groups] of this.written) {
      const cache = this.layers.get(layerId);
      if (!cache) continue;
      const away: number[] = [];
      for (const [handle, rows] of groups) {
        const part = this.extraOf(cache, handle);
        const groupCache = part ?? cache.groups.get(handle);
        if (!groupCache) continue;
        for (const [row, write] of rows) {
          this.stats.rowsWrittenInPlace++;
          if ((write.what & ROW_WRITE_STATE) !== 0 && groupCache.stateVersion >= 0) {
            this.writeByte(groupCache, row);
          }
          if (this.applyWrite(cache, groupCache, row, write)) continue;
          if (part) {
            // Packed again before the next frame
            cache.extras.delete(part.group);
            this.disposeGroup(part);
            this.deltaStale.add(layerId);
            break;
          }
          away.push(this.reader.refOf(groupCache.group, row));
        }
      }
      if (away.length > 0) this.reader.toDelta(away);
    }
    this.written.clear();
  }

  /**
   * Writes one row written in place into the chunk that draws it
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
    const drawn =
      (write.what & (ROW_WRITE_GEOMETRY | ROW_WRITE_STYLE)) !== 0 ||
      this.ruleKeyWritten(cache, write.keys);
    const chunk = groupCache.chunks?.find((c) => row >= c.range.from && row < c.range.to);
    if (!chunk) return true;
    // Draped, every row is drawn at once from its feature as it is now
    if (groupCache.drawing === 'draped') return true;
    // The classification of the row may have changed (its type, its style, what an extension reads)
    if (drawn || this.extensionReads(cache, write)) {
      const deps = cache.deps;
      const slots = cache.slots;
      if (deps && slots) {
        const now = classifyRow(group, row, {
          rows: this.reader,
          slots,
          customTypes: deps.customRenderers,
          companions: deps.companions,
          featureOf: (g, r) => this.featureOfRow(g, r),
          layer: cache.layer ?? undefined,
          oneDraw: groupCache.drawing === 'one-draw',
          onSurface: groupCache.surfaceKind !== 'flat',
        });
        if (now !== null && now !== chunk.range.kind) return false;
      }
    }
    if ((write.what & ROW_WRITE_GEOMETRY) !== 0 && chunk.type !== 'immediate') {
      // The extent of the chunk only widens, so a row moved out of it is not culled with it
      const b = new Float64Array(4);
      if (drawnRowBox(this.reader, group, row, b)) {
        chunk.bounds = [
          Math.min(chunk.bounds[0], b[0]),
          Math.min(chunk.bounds[1], b[1]),
          Math.max(chunk.bounds[2], b[2]),
          Math.max(chunk.bounds[3], b[3]),
        ];
      }
    }
    if (chunk.type === 'immediate') return true;
    if (chunk.type === 'retained') {
      // The batches by kind hold their rows: built again (drawn until then)
      if (drawn) this.invalidate(chunk, true);
      return true;
    }
    if (!drawn) return true;
    if (chunk.job) {
      // Being built: the build starts again from the columns as written
      this.invalidate(chunk, true);
      return true;
    }
    const gpu = chunk.batches;
    const rows = this.rows;
    const rowsStyles = cache.rowsStyles;
    if (!gpu || !rows || !rowsStyles || !cache.slots) return true;
    if (gpu.data.palette !== rowsStyles.palette) {
      this.invalidate(chunk, true);
      return true;
    }
    // A row of a chunk cut for the surface is packed with what the chunk was cut with; a check
    // in progress starts again from the rows as written
    const cut = this.cuts.get(gpu);
    if (cut) this.dropCheck(gpu);
    const context = this.packContext(cache, cut ? this.surfaceOf(cut.step) : null);
    const local = row - chunk.range.from;
    const held = gpu.data.rowStyle[local];
    const styleWritten =
      (write.what & ROW_WRITE_STYLE) !== 0 || this.ruleKeyWritten(cache, write.keys);
    const layout = rowsStyles.layoutOf(held);
    const kind = layout & 7;
    this.stats.rowsPacked++;
    // The positions only: a point or a solid line that keeps its shape and its style (not on the
    // surface, where a point carries its elevation and a line its longest segment)
    if (
      !cut &&
      (write.what & ROW_WRITE_GEOMETRY) !== 0 &&
      write.sameShape &&
      !styleWritten &&
      (layout & ROWS_LAYOUT.dashed) === 0 &&
      (kind === ROWS_LAYOUT.point || kind === ROWS_LAYOUT.line)
    ) {
      if (write.to > write.from) {
        const firstCoord = gpu.data.coordFirst[local];
        const coords = new Float32Array(2);
        const draft = new RowCoordsDraft(write.from, write.to, (n, x, y) => {
          coords[0] = x;
          coords[1] = y;
          rows.patchCoords(gpu, firstCoord + n, coords, 1);
        });
        collectRow(group, row, 0, draft, gpu.data.origin, context);
      }
      return true;
    }
    // The style only: a style of the same layout of instances
    if ((write.what & ROW_WRITE_GEOMETRY) === 0) {
      const style = resolveRowStyle(group, row, context);
      if (style === held) return true;
      if (style >= 0 && held >= 0 && rowsStyles.layoutOf(style) === rowsStyles.layoutOf(held)) {
        rowsStyles.palette.retain(style);
        rows.patchRowStyle(gpu, local, style, styleCreatedZoom(group, row, rowsStyles, style));
        return true;
      }
    }
    // The row packed again into its place, when it fits
    const draft = new RowsDraft(1, row, undefined, rowsStyles.palette);
    collectRow(group, row, 0, draft, gpu.data.origin, context);
    if (cut && draft.runKinds[0] === 1) {
      // A line drawn in the stations of its run: a line longer than its run makes the chunk build
      // again, as a batch of lines builds again with the line
      const meters = cut.runMeters[local];
      const mercator = cut.runMercator[local];
      if (draft.runMeters[0] > meters || draft.runMercator[0] > mercator) {
        draft.releaseStyles();
        this.invalidate(chunk, true);
        return true;
      }
      draft.writeRun(0, meters, mercator);
    }
    if (rows.patchRows(gpu, local, draft.finish(gpu.data.origin, gpu.data.palette))) {
      if (cut) cut.keys[local] = draft.keys[0];
      return true;
    }
    draft.releaseStyles();
    return false;
  }

  /** Whether an attribute the style rule of the layer reads is among the keys written */
  private ruleKeyWritten(cache: LayerCache, keys: ReadonlySet<string> | null): boolean {
    const rule = cache.layer?.styleRule;
    if (!keys || !rule || rule.kind === 'single') return false;
    return keys.has(rule.property);
  }

  /**
   * Whether a write of attributes may change what an extension makes of the row: a renderer of its
   * type that may refuse some of its features, a provider of companions
   */
  private extensionReads(cache: LayerCache, write: PendingWrite): boolean {
    if ((write.what & ~ROW_WRITE_STATE) === 0) return false;
    const deps = cache.deps;
    if (!deps) return false;
    if (deps.companions.any()) return true;
    for (const renderer of deps.customRenderers.values()) {
      if ((renderer as Pick<FeatureTypeRenderer, 'appliesTo'>).appliesTo) return true;
    }
    return false;
  }
}

/** A chunk for a range of rows (none for a range of a chunk without a box) */
function makeChunk(range: OrderedChunkRange): TableChunk[] {
  if (range.kind === 'immediate') return [{ type: 'immediate', range }];
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
      ? ({ type: 'rows', ...state } as RowsChunkState)
      : ({ type: 'retained', ...state } as KindChunkState),
  ];
}

function newGroupCache(
  group: RowGroup,
  styleGeneration: number,
  part: DeltaPart | null = null,
): GroupCache {
  return {
    group,
    chunks: null,
    drawing: null,
    surfaceKind: 'flat',
    generation: -1,
    retiring: null,
    styleGeneration,
    bytes: new Uint8Array(group.data.length),
    stateVersion: -1,
    clientGeneration: -1,
    dirty: true,
    texture: null,
    shown: false,
    part,
    marks: 0,
  };
}

/** Whether every chunk of a group that meets the view is built */
function builtInView(chunks: readonly TableChunk[], bounds: BBox): boolean {
  for (const chunk of chunks) {
    if (chunk.type === 'immediate') continue;
    if (meets(chunk.bounds, bounds) && (!chunk.batches || chunk.stale)) return false;
  }
  return true;
}

/** Whether two boxes meet */
function meets(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** The origin of a chunk built at once: the center of its extent */
function chunkOriginOf(bounds: BBox): [number, number] {
  return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
}

/**
 * The created zoom a row writes with its style (none for a point, whose size is fixed on screen)
 */
function styleCreatedZoom(
  group: RowGroup,
  row: number,
  styles: RowsStyles,
  style: number,
): number | undefined {
  const kind = styles.layoutOf(style) & 7;
  return kind === ROWS_LAYOUT.point ? undefined : rowCreatedZoom(group, row);
}

/** Whether two sets hold the same values */
function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** The values of one set or the other but not both */
function changedIds(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const value of a) if (!b.has(value)) out.push(value);
  for (const value of b) if (!a.has(value)) out.push(value);
  return out;
}
