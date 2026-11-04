// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The drape of the layers held as rows (`TableDrape`)
 *
 * On the terrain, in the band of the analytic drape (`DrapePlanner`: zoomed in past
 * `TERRAIN_ANALYTIC_MIN_ZOOM`, or few enough edges), the polygons and the lines of the layers held
 * as rows paint the pixels of the ground: a drape of their own, made of partitions
 * (`terrain/drape/partitioned.ts`), apart from the drape of the other elements, so the rows never
 * make the datasets fall out of theirs.
 *
 * - A partition is a row group of a layer (its rows, with the rows of the delta of the layer
 *   placed among them), and a partition after the last group of a layer for the rows of the
 *   delta placed after it. The partitions are in the order of the layers and of the groups
 * - An element is a copy of a row: the copy of a row of a group is numbered from the handle of
 *   the row (a number given when the row first comes in and given back when no version keeps
 *   it, kept when the row moves to another group or the group to its next version), the copy
 *   of a row of the delta has its copy number in the delta (`DeltaRows.copyOf`). The texels of a
 *   copy (its style, its place in the order, its state) are read by its number
 *   (`DrapeCopyIndex`, `DrapeCopyTables`)
 * - A write of a row bins again its partition in the tiles its box touches, before and after;
 *   a write of its color, or a change of its state (hidden, shown), writes its texels. A next
 *   version of a group keeps the partition of the group, writes the places of its copies and
 *   bins again only the tiles of the rows that came from the delta or were dropped
 *
 * The rows the drape does not draw (points, pictures, the rows drawn at once) are drawn where
 * they are in the order: a run of them that an element after it covers in some tile is a break,
 * where the drape is painted up to it in the tiles it meets before it is drawn
 * (`TableDrapePainter`); a run no element after it covers waits and is drawn with the next break
 * or at the end of the layer, after the drape painted under it (what is drawn later does not
 * meet it, so nothing changes).
 */

import type { CustomRenderMethodInput, ProjectionData } from 'maplibre-gl';
import type { FeatureTablesInternals } from '../../feature-table/feature-tables.js';
import { geometryAt, type LayerTable, type RowGroup } from '../../feature-table/layer-table.js';
import { rowNumber, rowType } from '../../feature-table/row-read.js';
import {
  BULK_MOVE_SET,
  GPU_STATE_MOVE_SHIFT,
  MOVE_SETS,
  STATE_BULK,
  STATE_HIDDEN_DELTA,
  STATE_HIDDEN_MASK,
  STATE_HIDDEN_WAIT,
} from '../../feature-table/row-state.js';
import type { RowHandle } from '../../feature-table/types.js';
import type { GroupVersion } from '../../feature-table/versions.js';
import { generateCirclePolygon } from '../../geometry/circle.js';
import { type EnuEdit, inverseEnuEdit, moveEnuPosition } from '../../geometry/enu-transforms.js';
import { drawPropertyKey } from '../../shared/properties.js';
import type { Coordinate } from '../../store/types.js';
import type { GpuLedger } from '../gpu-ledger.js';
import { dashCoefficientsOf } from '../renderers/line/dash.js';
import { rowsVariantOf } from '../renderers/rows/rows-shader.js';
import type { ShaderData } from '../shaders/helpers.js';
import {
  getRenderableTerrainTiles,
  getTerrainDepth,
  getTerrainMeshSize,
  getTerrainTileData,
  type TerrainDepth,
} from '../terrain/detect.js';
import {
  DRAPE_POSITION_SLOTS,
  type DrapeColor,
  type DrapeDash,
  type DrapePartitionElement,
  type DrapeTile,
  drapeCopyRef,
  drapePosition,
} from '../terrain/drape/binning.js';
import {
  type DrapeBounds,
  type DrapeGeometry,
  drapeGeometryOf,
  drapeMercatorX,
  drapeMercatorY,
} from '../terrain/drape/geometry.js';
import {
  DRAPE_GROUND_BLOCK_TEXELS,
  DRAPE_GROUND_BLOCKS,
  DRAPE_GROUND_COARSE_BLOCKS,
} from '../terrain/drape/ground-depth.js';
import {
  DRAPE_STATE_HIDDEN,
  DrapeCopyTables,
  type DrapePartitionSource,
  PartitionedDrapeIndex,
} from '../terrain/drape/partitioned.js';
import { canDrape } from '../terrain/drape/pass.js';
import {
  DRAPE_MAX_MOVING,
  DRAPE_MOVING_TILES,
  type DrapeLight,
  type DrapeMovingDraw,
  type DrapeRankRange,
  DrapeRenderer,
} from '../terrain/drape/renderer.js';
import { circumferenceAtLatitude, tileCenterLatitude } from '../terrain/metrics.js';
import {
  DRAPE_WIDE_EDGE_BUDGET,
  type DrapePlanTile,
  type DrapeTileDrawEntry,
  drapeTileDrawsOf,
  type MapTerrain,
  TERRAIN_ANALYTIC_MIN_ZOOM,
} from './drape-planner.js';
import type { RowStyleSlots } from './table-collect.js';
import { rowCreatedZoom } from './table-collect.js';
import type { TableRunKind } from './table-partition.js';

/** The range of the copies of the rows of the groups */
export const TABLE_DRAPE_MAIN = 0;
/** The range of the copies of the rows of the deltas */
export const TABLE_DRAPE_DELTA = 1;
/** The range of the copies of the rows of the moving partitions */
export const TABLE_DRAPE_MOVING = 3;

/** The copies of the range of the moving partitions each moving set may number */
const MOVING_COPIES = 2 ** 19;

/** The time the index of the tiles may take in a frame (ms), as the drape of the other elements */
const TABLE_DRAPE_BUDGET_MS = 8;

/**
 * The reach of the marker of a point beyond its position on the screen (CSS px), for the breaks
 * of the order: a run of points is drawn after the drape painted under it, and before what is
 * painted over it within this reach (a first value, wider than the markers drawn)
 */
export const TABLE_DRAPE_POINT_REACH_PX = 48;

/** The key of the radius of a Circle */
const RADIUS_KEY = drawPropertyKey('radiusMeters');

/** The bits of the state of a row whose copy in its group is not the row (it is read elsewhere) */
const STATE_ELSEWHERE = STATE_HIDDEN_DELTA | STATE_HIDDEN_WAIT;

/** How a row is drawn on the drape */
const KIND_UNKNOWN = 0;
const KIND_POLYGON = 1;
const KIND_LINE = 2;
/** Drawn in the chunks of the rows, not by the drape (a point, a picture) */
const KIND_CHUNK = 3;
/** Drawn at once */
const KIND_AT_ONCE = 4;
/** Not drawn (no geometry) */
const KIND_NONE = 5;

/**
 * Rounds the zoom of the margins of the index to a step (pushed to the safe side), as the drape
 * of the other elements does
 */
const marginZoom = (zoom: number): number => Math.round(zoom) + 0.5;

/** The rows of a delta placed before row `at` of a group: rows `[from, to)` of the delta */
export interface TableDrapeInsert {
  readonly at: number;
  readonly from: number;
  readonly to: number;
}

/** A layer held as rows, as the drape reads it */
export interface TableDrapeLayer {
  readonly layerId: string;
  readonly table: LayerTable;
  readonly slots: RowStyleSlots;
  readonly strings: Parameters<RowStyleSlots['ruleColorOf']>[2];
  /** Changes when the rows are to be sorted again or their styles resolved again */
  readonly generation: string;
  /** How a row is drawn by the drawing in one draw (`classifyRow`) */
  readonly classify: (group: RowGroup, row: number) => TableRunKind | null;
  /** The rows of the delta placed among the groups, by the place of a group (-1: after them) */
  readonly inserts: ReadonlyMap<number, readonly TableDrapeInsert[]>;
}

/** The frame of the drape of the rows: what its draws read */
export interface TableDrapeFrame {
  readonly renderer: DrapeRenderer;
  readonly light: DrapeLight;
  readonly zoom: number;
  readonly dpr: number;
  /** The tiles drawn, with their boxes (Mercator) and the pixels of a tile unit on the screen */
  readonly tiles: readonly TableDrapeTile[];
  /** Puts the GL state of the drape, and back to the one of the layers */
  readonly enter: () => void;
  readonly leave: () => void;
  /** The drape these draws are of */
  readonly drape: TableDrape;
  /** The moving partitions drawn, for the breaks of the order */
  readonly moving: readonly TableDrapeMovingCover[];
  /**
   * The depth of the terrain maplibre draws, the ground seen at each pixel is read back from (the
   * polygons and the lines read it in the order of the rows; null for the references of the
   * measures)
   */
  readonly ground: TerrainDepth | null;
  /**
   * Whether the frame is in the drape band. Out of it, a frame is planned only for the rows
   * still packed for the ground while they are cut again for the terrain (zoomed out of the
   * band), which read the ground until they are
   */
  readonly inBand: boolean;
}

/** A tile of the frame of the drape of the rows */
export interface TableDrapeTile {
  readonly entry: DrapeTileDrawEntry;
  readonly tile: DrapeTile;
  readonly box: DrapeBounds;
  /** The physical pixels a unit of the tile spans on the screen at least */
  readonly pixels: number;
  /** The moving partitions the tile reads (null for none) */
  readonly moving: DrapeMovingDraw | null;
  /**
   * The most runs a pixel of the tile reads (those of its cell and of the cells of the moving
   * partitions it reads): the most elements a pixel can have after a point
   */
  readonly depth: number;
  /** The range of the elevations of the ground of the tile (meters) */
  readonly elevation: readonly [number, number];
  /**
   * The planes of the elevations of the ground of the blocks of the tile, `DRAPE_GROUND_BLOCKS`
   * on a side, row by row from its north west corner, then of its coarser blocks: a + b u + c v
   * in units of the tile and how far the ground is from it at most (meters, 4 numbers a block;
   * null when its DEM is not read)
   */
  readonly blocks: Float32Array | null;
}

/** A moving partition drawn in a frame: where its elements are drawn, and their highest key */
export interface TableDrapeMovingCover {
  /** The Mercator box its elements are drawn in, moved */
  readonly box: DrapeBounds;
  readonly maxKey: number;
}

/** A rank of the order of the drape: (the place of the partition, the slot, the order at it) */
export type TableDrapeRank = [number, number, number];

/** An element of the drape for a copy of a row */
class RowDrapeElement implements DrapePartitionElement {
  readonly source = 0;
  readonly selectionKey = '';

  constructor(
    readonly ref: number,
    readonly position: number,
    readonly kind: 0 | 1,
    readonly bounds: DrapeBounds,
    readonly fill: DrapeColor,
    readonly stroke: DrapeColor,
    readonly strokeWidthPx: number,
    readonly widthZoom: number,
    readonly dash: DrapeDash | null,
    private readonly paths: () => Coordinate[][],
    /** The element whose geometry it draws (a moving copy draws the one of its row) */
    private readonly of: RowDrapeElement | null = null,
  ) {}

  geometry(): DrapeGeometry {
    if (this.of) return this.of.geometry();
    return drapeGeometryOf(this, this.paths(), this.kind === 0);
  }
}

/** A partition: a row group of a layer, or the rows of its delta after its last group */
interface PartitionState extends DrapePartitionSource {
  readonly id: number;
  readonly layerId: string;
  /** The group (null for the partition after the last group) */
  group: RowGroup | null;
  /** What it was made with */
  generation: string;
  mark: number;
  stateVersion: number;
  deltaGroup: RowGroup | null;
  deltaStateVersion: number;
  insertsKey: string;
  elements: RowDrapeElement[];
  bounds: DrapeBounds | null;
  /** The edges and the coordinates of its elements */
  edgeCount: number;
  vertexCount: number;
  /** The rows of its group written since it was made (made again whatever else changed) */
  readonly written: Set<number>;
  /** The rows of the delta placed in it written since it was made */
  readonly deltaWritten: Set<number>;
  /** The element of the copy of each row of its group (-1 for none) */
  byRow: Int32Array;
  /** Advances whenever its elements are made again */
  version: number;
  /** Whether it was handed to the next version of its group (its copies keep their bins) */
  adopted: boolean;
}

/** A row of a moving partition: the copy of the row in its group and its copy in the partition */
interface MovingMember {
  readonly main: RowDrapeElement;
  readonly part: PartitionState;
  readonly moving: RowDrapeElement;
  /** Whether the row is in the moving set (false: selected, waiting for a drag) */
  inSet: boolean;
}

/**
 * A moving partition: the rows of a moving set (or, for the set of the features selected in
 * bulk, the rows selected before they are dragged), indexed where they were taken from on tiles
 * one step coarser than the tiles drawn
 */
interface MovingSet {
  readonly set: number;
  readonly index: PartitionedDrapeIndex;
  members: MovingMember[];
  /** What the rows are (a sum of their copies, their number) */
  key: string;
  bounds: DrapeBounds | null;
  maxKey: number;
  /** Whether its index holds the tiles the view needs */
  ready: boolean;
  /** The motion the set was drawn with last (kept for the rows let go until they are drawn) */
  translation: [number, number];
  transform: EnuEdit | null;
  /** The rows let go of: drawn by their copies here until their partitions are binned again */
  readonly releasing: Set<MovingMember>;
}

/** The ratios a width in CSS px is resolved with */
interface WidthRatios {
  /** For widths fixed on the screen (the rendering scale included) */
  readonly fixed: number;
  /** For widths that follow the zoom */
  readonly content: number;
}

/**
 * The copy numbers of the rows of the groups, from their handles (`DrapeCopyIndex`): given when
 * a row first comes in, given back when no version keeps it, used again once no tile still names
 * it (`release`)
 */
export class DrapeCopyIndex {
  private readonly copies = new Map<RowHandle, number>();
  private readonly free: number[] = [];
  private readonly waiting: number[] = [];
  private next = 0;

  /** The copy of a handle (given now when it has none) */
  copyOf(handle: RowHandle): number {
    let copy = this.copies.get(handle);
    if (copy === undefined) {
      copy = this.free.pop() ?? this.next++;
      this.copies.set(handle, copy);
    }
    return copy;
  }

  /** The copy of a handle, -1 for none */
  peek(handle: RowHandle): number {
    return this.copies.get(handle) ?? -1;
  }

  /** Gives the copy of a handle back: it waits until no tile still names it */
  drop(handle: RowHandle): number {
    const copy = this.copies.get(handle);
    if (copy === undefined) return -1;
    this.copies.delete(handle);
    this.waiting.push(copy);
    return copy;
  }

  /** The copies given back may be given again (no tile names them any more) */
  release(): void {
    while (this.waiting.length > 0) this.free.push(this.waiting.pop() as number);
  }

  /** The numbers given so far (the highest one plus one) */
  get range(): number {
    return this.next;
  }

  /** The handles that have a copy */
  get size(): number {
    return this.copies.size;
  }

  clear(): void {
    this.copies.clear();
    this.free.length = 0;
    this.waiting.length = 0;
    this.next = 0;
  }
}

/** What preparing the drape of the rows for a frame needs */
export interface TableDrapeFrameInput {
  readonly gl: WebGL2RenderingContext;
  readonly mapTerrain: MapTerrain;
  readonly shaderData: ShaderData;
  readonly getProjectionData: CustomRenderMethodInput['getProjectionData'];
  readonly zoom: number;
  readonly rawZoom: number;
  readonly dpr: number;
  readonly contentDpr: number;
  readonly light: DrapeLight;
  /** Whether many rows are being dragged (the band is not changed until they are let go) */
  readonly dragging: boolean;
  /**
   * Whether the polygons and the lines are drawn flat in this frame (the wide band of the
   * terrain): they are then drawn without the terrain whatever they are packed for
   */
  readonly flattened: boolean;
  readonly timeSlicing: boolean;
  readonly enter: () => void;
  readonly leave: () => void;
  readonly requestRepaint: () => void;
}

/** The diagnostic values of the drape of the rows of the last frame */
export interface TableDrapeDebug {
  used: boolean;
  reason: string;
  partitions: number;
  elements: number;
  tiles: number;
  built: number;
  rebinned: number;
  unfitTiles: number;
  truncatedCells: number;
}

/**
 * The drape of the layers held as rows
 *
 * @internal
 */
export class TableDrape {
  readonly index = new PartitionedDrapeIndex();
  readonly copies = new DrapeCopyTables();
  readonly mainCopies = new DrapeCopyIndex();
  private renderer: DrapeRenderer | null = null;
  /** The partitions by layer and by group handle (-1: after the last group) */
  private readonly partitions = new Map<string, Map<number, PartitionState>>();
  private readonly freeIds: number[] = [];
  private nextId = 0;
  /** The copies of the deltas in use by layer (the others are cleared) */
  private readonly deltaCopies = new Map<string, Set<number>>();
  /** The partition of each group of the next versions swapped in, from the one they replace */
  private readonly adopted = new Map<RowGroup, PartitionState>();
  private ratios: WidthRatios = { fixed: 1, content: 1 };
  /** The layers drawn, in their order, and the range of the order of each */
  private readonly layerRanges = new Map<string, { from: number; to: number }>();
  /** The decision of the last frame, kept while many rows are dragged */
  private usedLast = false;
  /** Whether the last frame left tiles to build */
  private pendingWork = false;
  /** The tables the partitions are of */
  private tables: FeatureTablesInternals | null = null;

  /**
   * @param ledger Where the GPU memory of the drape is recorded (nothing is recorded when
   *   omitted)
   */
  constructor(private readonly ledger?: GpuLedger) {}

  /** Whether the last frame left tiles to build (the next frames build them) */
  get hasPendingWork(): boolean {
    return this.pendingWork;
  }
  readonly debug: TableDrapeDebug = {
    used: false,
    reason: 'terrain-off',
    partitions: 0,
    elements: 0,
    tiles: 0,
    built: 0,
    rebinned: 0,
    unfitTiles: 0,
    truncatedCells: 0,
  };

  /**
   * The rows of a group (or of the delta of a layer) written in place: the partitions that hold
   * them are made again with them
   */
  rowsWritten(layerId: string, group: RowGroup, rows: Iterable<number>): void {
    const byGroup = this.partitions.get(layerId);
    if (!byGroup) return;
    if (group.delta) {
      const list = [...rows];
      for (const part of byGroup.values()) {
        if (part.deltaGroup !== group) continue;
        for (const row of list) part.deltaWritten.add(row);
      }
      return;
    }
    const part = byGroup.get(group.handle);
    if (!part) return;
    for (const row of rows) part.written.add(row);
  }

  /**
   * A next version of row groups replaced its groups: a group replaced by one group keeps its
   * partition (its copies are numbered from the handles of the rows, so the bins stay); the
   * copies of the rows dropped are given back
   */
  versionSwapped(version: GroupVersion): void {
    const layerId = version.layer.layerId;
    const groups = version.groups ?? [];
    const byGroup = this.partitions.get(layerId);
    if (byGroup && version.replaces.length === 1 && groups.length === 1) {
      const part = byGroup.get((version.replaces[0] as RowGroup).handle);
      if (part) {
        byGroup.delete(part.group?.handle ?? -1);
        part.adopted = true;
        this.adopted.set(groups[0] as RowGroup, part);
      }
    }
    for (const handle of version.dropped) {
      const copy = this.mainCopies.drop(handle);
      if (copy >= 0) this.copies.clear(TABLE_DRAPE_MAIN, copy);
    }
  }

  /** The range of ranks of a layer, `[from, to)` (null when it has no partition) */
  layerRange(layerId: string): DrapeRankRange | null {
    const range = this.layerRanges.get(layerId);
    if (!range) return null;
    return { from: [range.from, 0, 0], to: [range.to, 0, 0] };
  }

  /** The rank of row `row` of a group of a layer (null when the group has no partition) */
  rankOfRow(layerId: string, group: RowGroup, row: number): TableDrapeRank | null {
    const part = this.partitions.get(layerId)?.get(group.handle);
    if (!part) return null;
    return [this.index.orderIndexOf(part.id), 2 * row + 1, 0];
  }

  /**
   * The rank of row `row` of the delta of a layer, placed before row `at` of group `g` (-1 for
   * after the last group) as the `k`-th row of its place
   */
  rankOfInsert(layerId: string, groupHandle: number, at: number, k: number): TableDrapeRank | null {
    const part = this.partitions.get(layerId)?.get(groupHandle);
    if (!part) return null;
    return [this.index.orderIndexOf(part.id), 2 * at, k];
  }

  /**
   * Whether the drape draws a row (a polygon or a line drawn in one draw, as the row was sorted
   * last; false for a group not sorted yet)
   */
  drapesRow(group: RowGroup, row: number): boolean {
    const kind = this.kinds.get(group)?.kinds[row];
    return kind === KIND_POLYGON || kind === KIND_LINE;
  }

  /** What the rows of a group were last sorted with ('' for a group not sorted) */
  kindsGeneration(group: RowGroup): string {
    const held = this.kinds.get(group);
    return held ? `${held.generation}:${held.version}` : '';
  }

  /** The key a rank compares as (`PartitionedDrapeIndex.rankKey`) */
  keyOf(rank: TableDrapeRank): number {
    return rank[0] * 2 ** 34 + rank[1] * DRAPE_POSITION_SLOTS + rank[2];
  }

  /**
   * Plans the drape of the rows for a frame on the terrain
   *
   * In the band (zoomed in past `TERRAIN_ANALYTIC_MIN_ZOOM`, or few enough edges, as the drape of
   * the other elements decides it), the polygons and the lines of the rows read the ground seen
   * at each pixel (`TableDrapePainter.order` 'ground'), read back from the depth of the terrain
   * maplibre draws: the frame holds it and the tiles of the terrain drawn. Where that depth
   * cannot be taken (`getTerrainDepth`), and while maplibre draws the globe, no frame is planned,
   * and the rows are drawn as out of the band. For the references of the tests ('each',
   * 'each-near'), they are painted on the drape of the rows, binned into the tiles here.
   *
   * @param keepGround Whether a frame is wanted out of the band too: rows packed for the ground
   *   are still drawn (they read it until they are cut again for the terrain, unless the frame
   *   draws the polygons and the lines flat)
   * @returns The frame (null when the rows are drawn by their chunks as they are cut)
   */
  planFrame(
    tables: FeatureTablesInternals | null,
    layers: readonly TableDrapeLayer[],
    input: TableDrapeFrameInput,
    keepGround = false,
  ): TableDrapeFrame | null {
    const debug = this.debug;
    debug.built = 0;
    debug.rebinned = 0;
    if (tables && tables !== this.tables) {
      // Another document: nothing of the one before is kept
      if (this.tables) this.clear();
      this.tables = tables;
    }
    if (!input.mapTerrain || !tables) {
      this.usedLast = false;
      this.pendingWork = false;
      debug.used = false;
      debug.reason = 'terrain-off';
      return null;
    }
    this.sync(layers, { fixed: input.dpr, content: input.contentDpr });
    debug.partitions = this.index.partitionCount;
    let elements = 0;
    let edges = 0;
    let vertices = 0;
    for (const byGroup of this.partitions.values()) {
      for (const part of byGroup.values()) {
        elements += part.elements.length;
        edges += part.edgeCount;
        vertices += part.vertexCount;
      }
    }
    debug.elements = elements;
    const ground = TableDrapePainter.order === 'ground';
    // The band, as the drape of the other elements decides it; while many rows are dragged it
    // stays as it was when they were taken
    const band = input.rawZoom > TERRAIN_ANALYTIC_MIN_ZOOM || edges <= DRAPE_WIDE_EDGE_BUDGET;
    let inBand = elements > 0 && (input.dragging ? this.usedLast : band);
    let reason = elements === 0 ? 'no-drapeable-rows' : 'wide-zoom';
    if (inBand && !canDrape({ vertexCount: vertices })) {
      inBand = false;
      reason = 'vertex-budget';
    }
    // Out of the band, the rows packed for the ground read it until they are cut again for the
    // terrain; where the polygons and the lines are drawn flat, they are drawn so at once
    if (!inBand && !(ground && keepGround && !input.flattened)) return this.unused(reason);
    // While maplibre draws the globe (the globe alone and the transition) the ground is not read
    // back: the rows are drawn as out of the band (maplibre-coupling.md, item 31)
    if (ground && rowsVariantOf(input.shaderData) === 'globe') return this.unused('ground-globe');

    const tiles = getRenderableTerrainTiles(input.mapTerrain);
    if (tiles.length === 0) return this.unused('no-dem-tiles');
    // The depth of the terrain the ground is read back from: where it cannot be taken, the rows
    // are drawn as out of the band
    const groundDepth = ground
      ? getTerrainDepth(
          input.mapTerrain,
          tiles[0] as (typeof tiles)[number],
          input.gl.drawingBufferWidth,
          input.gl.drawingBufferHeight,
        )
      : null;
    if (ground && !groundDepth) return this.unused('ground-depth');
    const drapeTiles: DrapeTile[] = tiles.map((t) => ({ x: t.x, y: t.y, z: t.z }));
    let moving: ActiveMoving[] = [];
    if (!ground) {
      const budget = input.timeSlicing ? TABLE_DRAPE_BUDGET_MS : Number.POSITIVE_INFINITY;
      const prepared = this.index.prepare(drapeTiles, budget, marginZoom(input.zoom));
      debug.built = prepared.built;
      debug.rebinned = prepared.rebinned;
      debug.unfitTiles = prepared.unfitTiles;
      debug.truncatedCells = prepared.truncatedCells;
      this.pendingWork = prepared.pending;
      if (prepared.pending) input.requestRepaint();
      else this.mainCopies.release();
      if (prepared.overflow || prepared.unfitTiles > 0) return this.unused('cell-overflow');
      if (!this.usedLast && !prepared.complete) return this.unused('building');
      // The moving partitions: their rows taken in, their indices built for the view
      moving = this.updateMoving(tables, drapeTiles, input, prepared.complete);
    } else {
      this.pendingWork = false;
    }

    this.renderer ??= new DrapeRenderer(input.gl, true).useLedger(this.ledger);
    const meshSize = getTerrainMeshSize(input.mapTerrain);
    if (!this.renderer.ensure(input.shaderData, meshSize)) {
      return this.unused(this.renderer.lastError || 'ensure-failed');
    }
    if (!ground && !this.renderer.uploadRows(this.index.storage, this.copies)) {
      return this.unused('texture-limit');
    }
    const planTiles: DrapePlanTile[] = [];
    const tileOf = new Map<unknown, DrapeTile>();
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i] as (typeof tiles)[number];
      // The ground reads no index: its tiles are those of the terrain drawn
      const entry = ground ? null : this.index.entryOf(tile);
      if (!ground && (!entry || entry.unfit)) continue;
      if (!getTerrainTileData(input.mapTerrain, tile)) continue;
      const groundMeters =
        circumferenceAtLatitude(tileCenterLatitude(tile.y, tile.z)) / 2 ** tile.z;
      planTiles.push({
        tile,
        cellOffset: entry?.cellOffset ?? 0,
        grid: entry?.grid ?? 1,
        groundMeters,
      });
      tileOf.set(tile.tileID, drapeTiles[i] as DrapeTile);
    }
    const draws = drapeTileDrawsOf(input.mapTerrain, planTiles, meshSize, input.getProjectionData);
    const width = input.gl.drawingBufferWidth;
    const height = input.gl.drawingBufferHeight;
    const frameTiles: TableDrapeTile[] = [];
    for (const entry of draws) {
      const tile = tileOf.get(entry.draw.tileID) as DrapeTile;
      const size = 1 / 2 ** tile.z;
      frameTiles.push({
        entry,
        tile,
        box: {
          minX: tile.x * size,
          minY: tile.y * size,
          maxX: (tile.x + 1) * size,
          maxY: (tile.y + 1) * size,
        },
        pixels: tilePixels(entry.projection, width, height),
        moving: ground ? null : this.movingDrawOf(tile, moving),
        depth: ground ? 0 : this.index.maxRunsPerCellOf(tile) + this.movingDepthOf(tile, moving),
        elevation: elevationRangeOf(input.mapTerrain, entry.draw.tileID),
        blocks: ground ? elevationBlocksOf(input.mapTerrain, entry.draw.tileID) : null,
      });
    }
    this.usedLast = inBand;
    debug.used = inBand;
    debug.reason = inBand ? 'ok' : reason;
    debug.tiles = frameTiles.length;
    return {
      renderer: this.renderer,
      light: input.light,
      zoom: input.zoom,
      dpr: input.dpr,
      tiles: frameTiles,
      enter: input.enter,
      leave: input.leave,
      drape: this,
      moving: moving.map((m) => ({ box: m.box, maxKey: m.set.maxKey })),
      ground: groundDepth,
      inBand,
    };
  }

  // === The moving partitions ===

  /** The moving partitions, by moving set (1 to 3) */
  private readonly movingSets = new Map<number, MovingSet>();
  /** The copies of the rows of the groups hidden because their moving copies draw them */
  private readonly movedAway = new Set<number>();
  /** The states of the groups the rows of the moving sets were read at */
  private movingStateKey = '';

  /**
   * Takes in the rows of the moving sets and builds the indices of the moving partitions for the
   * tiles of the view
   *
   * A partition is made when its rows change: for the set of the features selected in bulk,
   * from the rows selected as soon as they are, so that a drag starts with its index built. Its
   * rows are hidden in their partitions and drawn by their moving copies once its index holds
   * the tiles the view needs (until then they are drawn where they were). A row let go of stays
   * drawn by its moving copy, with the motion the set had, until the tiles of its partition are
   * binned again where it was written.
   *
   * @param settled Whether the tiles of the view of the partitions are built and up to date
   * @returns The partitions drawn in this frame, with their motions
   */
  private updateMoving(
    tables: FeatureTablesInternals,
    tiles: readonly DrapeTile[],
    input: TableDrapeFrameInput,
    settled: boolean,
  ): ActiveMoving[] {
    this.readMovingRows();
    const active: ActiveMoving[] = [];
    for (const moving of this.movingSets.values()) {
      if (moving.members.length === 0) continue;
      let inSet = false;
      for (const member of moving.members) if (member.inSet) inSet = true;
      if (inSet) {
        const [dLng, dLat] = tables.states.translation(moving.set);
        moving.translation = [dLng, dLat];
        moving.transform = tables.states.transform(moving.set);
      }
      // The rows let go of are drawn by their partitions again once those are binned
      if (settled && moving.releasing.size > 0) moving.releasing.clear();
      const shown = inSet || moving.releasing.size > 0;
      // The tiles of the index: one step coarser than each tile of the view, where the rows are
      // taken from (the view moved back by the motion)
      const motion = shown ? this.motionOf(moving) : IDENTITY_MOTION;
      const coarse = coarseTilesOf(tiles, motion, moving.bounds);
      const prepared = moving.index.prepare(
        coarse,
        input.timeSlicing ? TABLE_DRAPE_BUDGET_MS : Number.POSITIVE_INFINITY,
        marginZoom(input.zoom),
      );
      if (prepared.pending) {
        this.pendingWork = true;
        input.requestRepaint();
      }
      if (prepared.complete && !prepared.overflow) moving.ready = true;
      const drawn = shown && moving.ready;
      this.showMoving(moving, drawn);
      if (drawn) active.push({ set: moving, motion, box: movedBox(moving.bounds, motion) });
      if (active.length >= DRAPE_MAX_MOVING) break;
    }
    return active;
  }

  /**
   * Reads the rows of the moving sets from the states of the groups (again only when a state
   * changed), and makes the moving partitions whose rows changed
   */
  private readMovingRows(): void {
    let key = '';
    for (const byGroup of this.partitions.values()) {
      for (const part of byGroup.values()) {
        if (part.group) key += `${part.id}:${part.group.handle}:${part.group.stateVersion},`;
      }
    }
    if (key === this.movingStateKey) return;
    this.movingStateKey = key;
    const rows = new Map<number, MovingMember[]>();
    const selected: MovingMember[] = [];
    for (const byGroup of this.partitions.values()) {
      for (const part of byGroup.values()) {
        const group = part.group;
        if (!group) continue;
        for (let row = 0; row < group.data.length; row++) {
          const at = part.byRow[row] as number;
          if (at < 0) continue;
          const set = ((group.gpuState[row] as number) >> GPU_STATE_MOVE_SHIFT) & 3;
          const bulk = ((group.state[row] as number) & STATE_BULK) !== 0;
          if (set === 0 && !bulk) continue;
          const member = {
            main: part.elements[at] as RowDrapeElement,
            part,
            moving: part.elements[at] as RowDrapeElement,
            inSet: set !== 0,
          };
          if (set !== 0) {
            let list = rows.get(set);
            if (!list) {
              list = [];
              rows.set(set, list);
            }
            list.push(member);
          } else {
            selected.push(member);
          }
        }
      }
    }
    // The rows selected in bulk are the partition of their set before they are dragged
    if (!rows.has(BULK_MOVE_SET) && selected.length > 0) rows.set(BULK_MOVE_SET, selected);
    for (let set = 1; set <= MOVE_SETS; set++) {
      this.setMovingRows(set, rows.get(set) ?? []);
    }
  }

  /** Puts the rows of a moving set: its partition is made again when they are other rows */
  private setMovingRows(set: number, members: MovingMember[]): void {
    let moving = this.movingSets.get(set);
    let sum = 0;
    let versions = 0;
    const counted = new Set<PartitionState>();
    for (const member of members) {
      sum += member.main.ref;
      if (counted.has(member.part)) continue;
      counted.add(member.part);
      versions += member.part.id * 65_536 + member.part.version;
    }
    const key = `${members.length}:${sum}:${versions}`;
    // The same rows, or rows still moved or let go of: the partition is kept (made again once
    // they are drawn by their partitions), and the rows let go of are drawn by their moving
    // copies until they are binned there
    const busy =
      moving !== undefined &&
      (moving.releasing.size > 0 || moving.members.some((member) => member.inSet));
    if (moving && (moving.key === key || (busy && sameRows(moving.members, members)))) {
      // The same rows: the ones let go of are drawn by their moving copies until they are binned
      const inSet = new Map<number, boolean>();
      for (const member of members) inSet.set(member.main.ref, member.inSet);
      for (const member of moving.members) {
        const now = inSet.get(member.main.ref) ?? false;
        if (member.inSet && !now) moving.releasing.add(member);
        if (now) moving.releasing.delete(member);
        member.inSet = now;
      }
      return;
    }
    if (!moving) {
      moving = {
        set,
        index: new PartitionedDrapeIndex(this.index),
        members: [],
        key: '',
        bounds: null,
        maxKey: Number.NEGATIVE_INFINITY,
        ready: false,
        translation: [0, 0],
        transform: null,
        releasing: new Set(),
      };
      this.movingSets.set(set, moving);
    }
    // Other rows: the copies of the rows before are given back, and a new partition is made
    this.showMoving(moving, false);
    for (const member of moving.members) {
      const copy = member.moving.ref - TABLE_DRAPE_MOVING * 2 ** 21;
      this.copies.clear(TABLE_DRAPE_MOVING, copy);
    }
    moving.releasing.clear();
    moving.key = key;
    moving.ready = false;
    const base = (set - 1) * MOVING_COPIES;
    const elements: RowDrapeElement[] = [];
    let bounds: DrapeBounds | null = null;
    let maxKey = Number.NEGATIVE_INFINITY;
    moving.members = members.slice(0, MOVING_COPIES).map((member, i) => {
      const main = member.main;
      const ref = drapeCopyRef(TABLE_DRAPE_MOVING, base + i);
      // The geometry is the one of the copy of the row in its group
      const copy = new RowDrapeElement(
        ref,
        main.position,
        main.kind,
        main.bounds,
        main.fill,
        main.stroke,
        main.strokeWidthPx,
        main.widthZoom,
        main.dash,
        NO_PATHS,
        main,
      );
      this.copies.setStyle(TABLE_DRAPE_MOVING, base + i, main);
      // Ranked where the row is: it is merged with the partitions at its place in the order
      this.copies.setRank(
        TABLE_DRAPE_MOVING,
        base + i,
        member.part.id,
        main.position,
        DRAPE_STATE_HIDDEN,
      );
      elements.push(copy);
      bounds = union(bounds, main.bounds);
      maxKey = Math.max(maxKey, this.index.rankKey(member.part.id, main.position));
      return { ...member, moving: copy };
    });
    moving.bounds = bounds;
    moving.maxKey = maxKey;
    const source: DrapePartitionSource = { id: 0, elements, bounds };
    moving.index.removePartition(0);
    moving.index.setPartition(source, null);
    moving.index.setOrder(elements.length > 0 ? [0] : []);
  }

  /**
   * Shows the rows of a moving partition by their moving copies (their copies in their groups
   * hidden), or by their copies in their groups
   */
  private showMoving(moving: MovingSet, drawn: boolean): void {
    for (const member of moving.members) {
      const visible = drawn && (member.inSet || moving.releasing.has(member));
      const movingCopy = member.moving.ref - TABLE_DRAPE_MOVING * 2 ** 21;
      this.copies.setState(TABLE_DRAPE_MOVING, movingCopy, visible ? 0 : DRAPE_STATE_HIDDEN);
      const main = member.main.ref;
      if (visible === this.movedAway.has(main)) continue;
      if (visible) this.movedAway.add(main);
      else this.movedAway.delete(main);
      this.writeState(member.part, member.main);
    }
  }

  /** The motion of a moving set: its translation and its transform */
  private motionOf(moving: MovingSet): Motion {
    return { translation: moving.translation, transform: moving.transform };
  }

  /** What a tile drawn reads of the moving partitions (null for none) */
  private movingDrawOf(tile: DrapeTile, active: readonly ActiveMoving[]): DrapeMovingDraw | null {
    if (active.length === 0) return null;
    const xf = new Float32Array(DRAPE_MAX_MOVING * 9);
    const back = new Float32Array(DRAPE_MAX_MOVING * 4);
    const tiles = new Float32Array(DRAPE_MAX_MOVING * DRAPE_MOVING_TILES * 4);
    let count = 0;
    const coarseZ = Math.max(0, tile.z - 1);
    for (const { set, motion } of active) {
      const fit = tileMotionFit(tile, coarseZ, motion);
      if (!fit) continue;
      xf.set(fit.xf, count * 9);
      back.set(fit.back, count * 4);
      let t = 0;
      for (const coarse of fit.tiles) {
        if (t >= DRAPE_MOVING_TILES) break;
        const entry = set.index.entryOf(coarse);
        if (!entry || entry.unfit) continue;
        tiles.set(
          [coarse.x, coarse.y, entry.grid, entry.cellOffset],
          (count * DRAPE_MOVING_TILES + t) * 4,
        );
        t++;
      }
      count++;
    }
    return count > 0 ? { count, xf, back, tiles, tileZ: coarseZ } : null;
  }

  /** The most runs a pixel of a tile reads in the cells of the moving partitions it reads */
  private movingDepthOf(tile: DrapeTile, active: readonly ActiveMoving[]): number {
    let depth = 0;
    const coarseZ = Math.max(0, tile.z - 1);
    for (const { set, motion } of active) {
      const fit = tileMotionFit(tile, coarseZ, motion);
      if (!fit) continue;
      let most = 0;
      for (const coarse of fit.tiles) most = Math.max(most, set.index.maxRunsPerCellOf(coarse));
      depth += most;
    }
    return depth;
  }

  /** Drops the GPU side (the next frame writes everything again) */
  releaseGpu(): void {
    this.renderer?.dispose();
    this.renderer = null;
    this.index.clearTiles();
  }

  /** Forgets everything (the tables changed) */
  clear(): void {
    for (const byGroup of this.partitions.values()) {
      for (const part of byGroup.values()) this.index.removePartition(part.id);
    }
    this.partitions.clear();
    this.adopted.clear();
    this.deltaCopies.clear();
    this.mainCopies.clear();
    this.freeIds.length = 0;
    this.nextId = 0;
    this.layerRanges.clear();
    this.index.clearTiles();
  }

  private unused(reason: string): null {
    this.usedLast = false;
    if (reason !== 'building') this.pendingWork = false;
    this.debug.used = false;
    this.debug.reason = reason;
    this.debug.tiles = 0;
    return null;
  }

  // === Taking in the layers ===

  /** Takes in what changed in the layers, and puts the partitions in their order */
  private sync(layers: readonly TableDrapeLayer[], ratios: WidthRatios): void {
    const ratiosChanged =
      ratios.fixed !== this.ratios.fixed || ratios.content !== this.ratios.content;
    this.ratios = ratios;
    const seen = new Set<string>();
    const order: number[] = [];
    this.layerRanges.clear();
    this.claimed.clear();
    for (const layer of layers) {
      seen.add(layer.layerId);
      const from = order.length;
      this.syncLayer(layer, ratiosChanged, order);
      if (order.length > from) this.layerRanges.set(layer.layerId, { from, to: order.length });
    }
    for (const [layerId, byGroup] of this.partitions) {
      if (seen.has(layerId)) continue;
      for (const part of byGroup.values()) this.dropPartition(part);
      this.partitions.delete(layerId);
      this.clearDeltaCopies(layerId, new Set());
    }
    for (const part of this.adopted.values()) {
      if (!this.claimed.has(part)) this.dropPartition(part);
    }
    this.adopted.clear();
    this.claimed.clear();
    if (this.index.setOrder(order)) {
      order.forEach((id, i) => {
        this.copies.setOrder(id, i);
      });
    }
  }

  private syncLayer(layer: TableDrapeLayer, ratiosChanged: boolean, order: number[]): void {
    const { table, layerId } = layer;
    let byGroup = this.partitions.get(layerId);
    if (!byGroup) {
      byGroup = new Map();
      this.partitions.set(layerId, byGroup);
    }
    const kept = new Map<number, PartitionState>();
    const delta = table.delta.group;
    const usedDelta = new Set<number>();
    for (let g = 0; g <= table.groupCount; g++) {
      const group = g < table.groupCount ? table.groupAt(g) : null;
      const handle = group?.handle ?? -1;
      const inserts = layer.inserts.get(group ? g : -1) ?? NO_INSERTS;
      if (!group && inserts.length === 0) continue;
      let part = byGroup.get(handle) ?? (group ? this.adopted.get(group) : undefined);
      if (!part) part = this.newPartition(layerId);
      kept.set(handle, part);
      const insertsKey = insertsKeyOf(inserts);
      const stale =
        ratiosChanged ||
        part.group !== group ||
        part.generation !== layer.generation ||
        part.mark !== (group?.mark ?? -1) ||
        part.deltaGroup !== (inserts.length > 0 ? delta : null) ||
        part.insertsKey !== insertsKey ||
        part.written.size > 0 ||
        part.deltaWritten.size > 0;
      if (stale) this.makePartition(part, layer, group, inserts, delta);
      else if (
        part.stateVersion !== (group?.stateVersion ?? -1) ||
        (part.deltaGroup !== null && part.deltaStateVersion !== part.deltaGroup.stateVersion)
      ) {
        this.writeStates(part);
      }
      if (part.deltaGroup) {
        for (const element of part.elements) {
          if (Math.floor(element.ref / 2 ** 21) === TABLE_DRAPE_DELTA) {
            usedDelta.add(element.ref - TABLE_DRAPE_DELTA * 2 ** 21);
          }
        }
      }
      if (part.elements.length > 0) order.push(part.id);
    }
    for (const [handle, part] of byGroup) {
      if (!kept.has(handle)) this.dropPartition(part);
    }
    for (const part of kept.values()) this.claimed.add(part);
    this.partitions.set(layerId, kept);
    this.clearDeltaCopies(layerId, usedDelta);
  }

  /** The partitions the layers of the frame hold (an adopted one not held is dropped) */
  private readonly claimed = new Set<PartitionState>();

  /** Clears the copies of the delta of a layer no partition uses any more */
  private clearDeltaCopies(layerId: string, used: Set<number>): void {
    const before = this.deltaCopies.get(layerId);
    if (before) {
      for (const copy of before) {
        if (!used.has(copy)) this.copies.clear(TABLE_DRAPE_DELTA, copy);
      }
    }
    if (used.size > 0) this.deltaCopies.set(layerId, used);
    else this.deltaCopies.delete(layerId);
  }

  private newPartition(layerId: string): PartitionState {
    const id = this.freeIds.pop() ?? this.nextId++;
    return {
      id,
      layerId,
      group: null,
      generation: '',
      mark: -2,
      stateVersion: -2,
      deltaGroup: null,
      deltaStateVersion: -2,
      insertsKey: '',
      elements: [],
      bounds: null,
      edgeCount: 0,
      vertexCount: 0,
      written: new Set(),
      deltaWritten: new Set(),
      byRow: new Int32Array(0),
      version: 0,
      adopted: false,
    };
  }

  private dropPartition(part: PartitionState): void {
    this.index.removePartition(part.id);
    this.freeIds.push(part.id);
  }

  /**
   * Makes the elements of a partition again, and bins it again in the tiles of what changed:
   * the copies new, gone or changed in their boxes, their kinds or their widths, and the rows
   * written. The texels of every copy are written (its style, its place, its state)
   */
  private makePartition(
    part: PartitionState,
    layer: TableDrapeLayer,
    group: RowGroup | null,
    inserts: readonly TableDrapeInsert[],
    delta: RowGroup | null,
  ): void {
    const before = new Map<number, RowDrapeElement>();
    const beforeIndex = new Map<number, number>();
    part.elements.forEach((element, i) => {
      before.set(element.ref, element);
      beforeIndex.set(element.ref, i);
    });
    const written = part.written;
    const deltaWritten = part.deltaWritten;
    const writtenRefs = new Set<number>();
    const elements: RowDrapeElement[] = [];
    let edgeCount = 0;
    let vertexCount = 0;
    const kinds = this.kindsOf(layer, group, written);
    const deltaKinds =
      inserts.length > 0 && delta ? this.kindsOf(layer, delta, deltaWritten) : null;
    const byRow = new Int32Array(group?.data.length ?? 0).fill(-1);
    const pushDelta = (insert: TableDrapeInsert): void => {
      if (!delta || !deltaKinds) return;
      for (let d = insert.from; d < insert.to; d++) {
        const kind = deltaKinds[d] as number;
        if (kind !== KIND_POLYGON && kind !== KIND_LINE) continue;
        const copy = layer.table.delta.copyOf(delta.data.handles[d] as number);
        if (copy < 0) continue;
        const ref = drapeCopyRef(TABLE_DRAPE_DELTA, copy);
        const element = this.elementOf(
          layer,
          delta,
          d,
          kind,
          ref,
          drapePosition(2 * insert.at, d - insert.from),
        );
        if (!element) continue;
        elements.push(element.element);
        edgeCount += element.edges;
        vertexCount += element.vertices;
        if (deltaWritten.has(d)) writtenRefs.add(ref);
      }
    };
    let next = 0;
    const rows = group?.data.length ?? 0;
    for (let row = 0; row < rows; row++) {
      while (next < inserts.length && (inserts[next] as TableDrapeInsert).at <= row) {
        pushDelta(inserts[next++] as TableDrapeInsert);
      }
      const g = group as RowGroup;
      if (((g.state[row] as number) & STATE_ELSEWHERE) !== 0) continue;
      const kind = kinds[row] as number;
      if (kind !== KIND_POLYGON && kind !== KIND_LINE) continue;
      const ref = drapeCopyRef(
        TABLE_DRAPE_MAIN,
        this.mainCopies.copyOf(g.data.handles[row] as number),
      );
      const element = this.elementOf(layer, g, row, kind, ref, drapePosition(2 * row + 1));
      if (!element) continue;
      byRow[row] = elements.length;
      elements.push(element.element);
      edgeCount += element.edges;
      vertexCount += element.vertices;
      if (written.has(row)) writtenRefs.add(ref);
    }
    while (next < inserts.length) pushDelta(inserts[next++] as TableDrapeInsert);

    // What changed: the boxes of the copies new, gone, written or changed in their shape
    const changed: DrapeBounds[] = [];
    let bounds: DrapeBounds | null = null;
    let lastBefore = -1;
    let outOfOrder = false;
    for (const element of elements) {
      bounds = union(bounds, element.bounds);
      const old = before.get(element.ref);
      if (old) {
        before.delete(element.ref);
        // An element whose place among the others changed is binned again where it is
        const oldIndex = beforeIndex.get(element.ref) as number;
        outOfOrder = oldIndex < lastBefore;
        lastBefore = oldIndex;
      }
      if (!old || writtenRefs.has(element.ref) || !sameShape(old, element) || outOfOrder) {
        changed.push(element.bounds);
        if (old && !sameBounds(old.bounds, element.bounds)) changed.push(old.bounds);
      }
      this.writeCopy(part, element);
    }
    for (const old of before.values()) changed.push(old.bounds);
    // A partition new, or of another group than its own or its next version (another document),
    // is binned whole: the copies of the rows tell nothing of their geometry there
    const first =
      (part.group === null && part.elements.length === 0) ||
      (part.group !== null && group !== null && part.group !== group && !part.adopted);
    part.adopted = false;
    part.elements = elements;
    part.bounds = bounds;
    part.edgeCount = edgeCount;
    part.vertexCount = vertexCount;
    part.group = group;
    part.generation = layer.generation;
    part.mark = group?.mark ?? -1;
    part.stateVersion = group?.stateVersion ?? -1;
    part.deltaGroup = inserts.length > 0 ? delta : null;
    part.deltaStateVersion = part.deltaGroup?.stateVersion ?? -1;
    part.insertsKey = insertsKeyOf(inserts);
    part.byRow = byRow;
    part.version++;
    written.clear();
    deltaWritten.clear();
    this.index.setPartition(part, first ? null : merged(changed));
  }

  /** Writes the states of the copies of a partition (hidden, shown) */
  private writeStates(part: PartitionState): void {
    for (const element of part.elements) this.writeState(part, element);
    part.stateVersion = part.group?.stateVersion ?? -1;
    part.deltaStateVersion = part.deltaGroup?.stateVersion ?? -1;
  }

  /** Writes the texels of a copy: its style, its place and its state */
  private writeCopy(part: PartitionState, element: RowDrapeElement): void {
    const range = Math.floor(element.ref / 2 ** 21);
    const copy = element.ref - range * 2 ** 21;
    this.copies.setStyle(range, copy, element);
    this.copies.setRank(range, copy, part.id, element.position, this.stateOf(part, element));
  }

  private writeState(part: PartitionState, element: RowDrapeElement): void {
    const range = Math.floor(element.ref / 2 ** 21);
    const copy = element.ref - range * 2 ** 21;
    this.copies.setState(range, copy, this.stateOf(part, element));
  }

  /** The state of a copy: hidden when its row is hidden */
  private stateOf(_part: PartitionState, element: RowDrapeElement): number {
    const source = this.rowOf.get(element);
    if (!source) return 0;
    if (this.movedAway.has(element.ref)) return DRAPE_STATE_HIDDEN;
    const state = source.group.state[source.row] as number;
    return (state & STATE_HIDDEN_MASK & ~STATE_ELSEWHERE) !== 0 ? DRAPE_STATE_HIDDEN : 0;
  }

  /** The row each element was made from */
  private readonly rowOf = new WeakMap<RowDrapeElement, { group: RowGroup; row: number }>();

  /** How each row of a group is drawn, kept for the group (sorted again for the rows written) */
  private readonly kinds = new WeakMap<
    RowGroup,
    { generation: string; version: number; kinds: Uint8Array }
  >();

  private kindsOf(
    layer: TableDrapeLayer,
    group: RowGroup | null,
    written: ReadonlySet<number> | null,
  ): Uint8Array {
    if (!group) return EMPTY_KINDS;
    let held = this.kinds.get(group);
    if (!held || held.generation !== layer.generation || held.kinds.length !== group.data.length) {
      held = { generation: layer.generation, version: 0, kinds: new Uint8Array(group.data.length) };
      this.kinds.set(group, held);
    }
    const kinds = held.kinds;
    if (written && written.size > 0) {
      for (const row of written) kinds[row] = KIND_UNKNOWN;
      held.version++;
    }
    for (let row = 0; row < kinds.length; row++) {
      if (kinds[row] === KIND_UNKNOWN) kinds[row] = kindOfRow(layer, group, row);
    }
    return kinds;
  }

  /** Makes the element of a copy of a row (null when it draws nothing) */
  private elementOf(
    layer: TableDrapeLayer,
    group: RowGroup,
    row: number,
    kind: number,
    ref: number,
    position: number,
  ): { element: RowDrapeElement; edges: number; vertices: number } | null {
    const geometry = geometryAt(group, row);
    if (!geometry) return null;
    const type = rowType(group.data, row);
    const style = group.data.styles[row] as number;
    const ruleColor = layer.slots.ruleColorOf(group, row, layer.strings);
    const createdZoom = rowCreatedZoom(group, row);
    const ratios = this.ratios;
    const widthOf = (width: number): { px: number; zoom: number; ratio: number } =>
      createdZoom !== undefined && Number.isFinite(createdZoom)
        ? { px: width * ratios.content, zoom: createdZoom, ratio: ratios.content }
        : { px: width * ratios.fixed, zoom: -1, ratio: ratios.fixed };
    const dashOf = (lineStyle: 'solid' | 'dashed' | 'dotted', ratio: number): DrapeDash | null => {
      const coefficients = dashCoefficientsOf(lineStyle);
      return coefficients && ratio > 0 ? { ...coefficients, pixelRatio: ratio } : null;
    };

    let paths: () => Coordinate[][];
    let bounds: DrapeBounds | null;
    let vertices = 0;
    let edges = 0;
    const { reader, at } = geometry;
    if (kind === KIND_POLYGON) {
      const slot = layer.slots.polygon(style, type, ruleColor);
      if (!slot.hasStroke && (slot.fillColor[3] as number) <= 0) return null;
      if (type === 'Circle' && reader.type === 'Point') {
        const radius = rowNumber(group, row, RADIUS_KEY);
        if (!radius || radius <= 0) return null;
        const ring = generateCirclePolygon(reader.position(at), radius);
        if (ring.length < 3) return null;
        paths = () => [openRing(ring)];
        bounds = boundsOfRing(ring);
        vertices = ring.length;
      } else {
        paths = () => polygonRingsOf(reader.coordinatesOf(at), reader.type);
        bounds = rowBox(group, row);
        vertices = vertexCountOf(reader, at);
      }
      edges = vertices;
      const width = widthOf(slot.strokeWidth);
      const dashed = slot.hasStroke && slot.lineStyle !== 'solid';
      const element = new RowDrapeElement(
        ref,
        position,
        0,
        bounds as DrapeBounds,
        [slot.fillColor[0], slot.fillColor[1], slot.fillColor[2], slot.fillColor[3]],
        dashed
          ? [slot.dashedColor[0], slot.dashedColor[1], slot.dashedColor[2], slot.dashedColor[3]]
          : [slot.strokeColor[0], slot.strokeColor[1], slot.strokeColor[2], slot.strokeColor[3]],
        slot.hasStroke ? width.px : 0,
        width.zoom,
        dashed ? dashOf(slot.lineStyle, width.ratio) : null,
        paths,
      );
      if (!bounds) return null;
      this.rowOf.set(element, { group, row });
      return { element, edges, vertices };
    }
    const slot = layer.slots.line(style, type, ruleColor);
    const stroke = slot.stroke;
    if (stroke.opacity <= 0 || stroke.width <= 0) return null;
    bounds = rowBox(group, row);
    if (!bounds) return null;
    vertices = vertexCountOf(reader, at);
    edges = Math.max(0, vertices - 1);
    const width = widthOf(stroke.width);
    const element = new RowDrapeElement(
      ref,
      position,
      1,
      bounds,
      [0, 0, 0, 0],
      [slot.color[0], slot.color[1], slot.color[2], slot.color[3]],
      width.px,
      width.zoom,
      dashOf(stroke.lineStyle, width.ratio),
      () => linePathsOf(reader.coordinatesOf(at), reader.type),
    );
    this.rowOf.set(element, { group, row });
    return { element, edges, vertices };
  }
}

/** No paths (an element that draws the geometry of another) */
const NO_PATHS = (): Coordinate[][] => [];

/** No rows of a delta placed at a group */
const NO_INSERTS: readonly TableDrapeInsert[] = [];
const EMPTY_KINDS = new Uint8Array(0);

/** How a row is drawn on the drape */
function kindOfRow(layer: TableDrapeLayer, group: RowGroup, row: number): number {
  const geometry = geometryAt(group, row);
  if (!geometry) return KIND_NONE;
  const kind = layer.classify(group, row);
  if (kind === null) return KIND_NONE;
  if (kind !== 'rows') return KIND_AT_ONCE;
  const type = rowType(group.data, row);
  const readerType = geometry.reader.type;
  if (type === 'Circle' && readerType === 'Point') return KIND_POLYGON;
  if (readerType === 'Polygon' || readerType === 'MultiPolygon') return KIND_POLYGON;
  if (readerType === 'LineString' || readerType === 'MultiLineString') return KIND_LINE;
  return KIND_CHUNK;
}

/** The key of the rows of a delta placed at a group */
function insertsKeyOf(inserts: readonly TableDrapeInsert[]): string {
  if (inserts.length === 0) return '';
  let key = '';
  for (const insert of inserts) key += `${insert.at}:${insert.from}:${insert.to},`;
  return key;
}

/** Whether two elements bin alike (their boxes, kinds and widths) */
function sameShape(a: RowDrapeElement, b: RowDrapeElement): boolean {
  return (
    a.kind === b.kind &&
    a.strokeWidthPx === b.strokeWidthPx &&
    a.widthZoom === b.widthZoom &&
    (a.dash === null) === (b.dash === null) &&
    a.position === b.position &&
    sameBounds(a.bounds, b.bounds)
  );
}

function sameBounds(a: DrapeBounds, b: DrapeBounds): boolean {
  return a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY;
}

/**
 * The box of two boxes (the second alone for no first)
 *
 * @internal
 */
export function union(a: DrapeBounds | null, b: DrapeBounds): DrapeBounds {
  if (!a) return b;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/**
 * The boxes of what changed, merged when there are many (the tiles they meet are binned again;
 * a list of thousands of boxes is checked against every tile kept)
 */
function merged(boxes: DrapeBounds[]): DrapeBounds[] {
  if (boxes.length <= 64) return boxes;
  let all: DrapeBounds | null = null;
  for (const box of boxes) all = union(all, box);
  return all ? [all] : [];
}

/** The Mercator box of a row (null for a row without positions) */
function rowBox(group: RowGroup, row: number): DrapeBounds | null {
  const b = group.data.rowBounds;
  const at = row * 4;
  const minLng = b[at] as number;
  if (Number.isNaN(minLng)) return null;
  return {
    minX: drapeMercatorX(minLng),
    // Mercator y decreases as the latitude increases
    minY: drapeMercatorY(b[at + 3] as number),
    maxX: drapeMercatorX(b[at + 2] as number),
    maxY: drapeMercatorY(b[at + 1] as number),
  };
}

function boundsOfRing(ring: readonly Coordinate[]): DrapeBounds {
  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return {
    minX: drapeMercatorX(minLng),
    minY: drapeMercatorY(maxLat),
    maxX: drapeMercatorX(maxLng),
    maxY: drapeMercatorY(minLat),
  };
}

/** The coordinates of a row (its vertices) */
function vertexCountOf(
  reader: { readonly offsets: readonly Int32Array[]; vertexStart(row: number): number },
  at: number,
): number {
  return reader.vertexStart(at + 1) - reader.vertexStart(at);
}

/** A ring with its closing point dropped */
function openRing(ring: readonly Coordinate[]): Coordinate[] {
  const first = ring[0] as Coordinate;
  const last = ring[ring.length - 1] as Coordinate;
  return first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring.slice();
}

/** The rings of a polygon row, each with its closing point dropped */
function polygonRingsOf(coordinates: unknown, type: string): Coordinate[][] {
  const polygons =
    type === 'Polygon'
      ? [coordinates as Coordinate[][]]
      : type === 'MultiPolygon'
        ? (coordinates as Coordinate[][][])
        : [];
  const out: Coordinate[][] = [];
  for (const polygon of polygons) {
    for (const ring of polygon) if (ring.length >= 3) out.push(openRing(ring));
  }
  return out;
}

/** The paths of a line row */
function linePathsOf(coordinates: unknown, type: string): Coordinate[][] {
  const paths =
    type === 'LineString'
      ? [coordinates as Coordinate[]]
      : type === 'MultiLineString'
        ? (coordinates as Coordinate[][])
        : [];
  return paths.filter((path) => path.length >= 2);
}

/**
 * The physical pixels a unit of a tile spans on the screen at least (the shortest of the sides
 * of the tile as its matrix projects them; 0 when a corner is behind the camera)
 */
function tilePixels(projection: ProjectionData, width: number, height: number): number {
  const m = projection.mainMatrix as unknown as ArrayLike<number>;
  const extent = 8192;
  const corner = (x: number, y: number): [number, number] | null => {
    const w = (m[3] as number) * x + (m[7] as number) * y + (m[15] as number);
    if (!(w > 0)) return null;
    const cx = (m[0] as number) * x + (m[4] as number) * y + (m[12] as number);
    const cy = (m[1] as number) * x + (m[5] as number) * y + (m[13] as number);
    return [((cx / w + 1) / 2) * width, ((1 - cy / w) / 2) * height];
  };
  const a = corner(0, 0);
  const b = corner(extent, 0);
  const c = corner(0, extent);
  const d = corner(extent, extent);
  if (!a || !b || !c || !d) return 0;
  const side = (p: [number, number], q: [number, number]): number =>
    Math.hypot(p[0] - q[0], p[1] - q[1]);
  return Math.min(side(a, b), side(a, c), side(b, d), side(c, d));
}

// === Drawing the order ===

/** A run of rows the drape does not draw, waiting to be drawn */
interface PendingDraw {
  readonly target: object;
  from: number;
  to: number;
  readonly draw: (from: number, to: number) => void;
}

/**
 * How the order of a layer held as rows is kept on the terrain, in the drape band
 *
 * - ground: the polygons and the lines read the ground seen at each pixel, read back from the
 *   depth of the terrain maplibre draws, and are drawn with the points in the order of the rows,
 *   in one draw a chunk (terrain/drape/ground-depth.ts)
 * - each: the polygons and the lines are on the drape of the rows, and every run of points is a
 *   break, the drape painted up to it in every tile (one row at a time, wherever its markers
 *   are on the screen: the reference of the tests)
 * - each-near: as each, the drape painted up to a break in the tiles it meets (a reference
 *   faster to draw, but for the markers over the ground of a tile far from them)
 *
 * @internal
 */
export type TableDrapeOrder = 'ground' | 'each' | 'each-near';

/**
 * Draws a layer held as rows on its drape in the order of its rows, for the references of the
 * tests (`each`, `each-near`): the drape is painted tile by tile up to each run of what the
 * drape does not draw, which is drawn next
 *
 * @internal
 */
export class TableDrapePainter {
  /**
   * How the order is kept (the ground, unless a test asks for a reference through its hooks,
   * `setDrapeOrder`)
   */
  static order: TableDrapeOrder = 'ground';

  private frame: TableDrapeFrame | null = null;
  private opacity = 1;
  private layerFrom: TableDrapeRank = [0, 0, 0];
  private layerTo: TableDrapeRank = [0, 0, 0];
  /** The rank each tile is painted up to (3 numbers per tile), and its key */
  private cursors = new Float64Array(0);
  private cursorKeys = new Float64Array(0);
  private readonly pending: PendingDraw[] = [];
  /** The box of what waits (Mercator; null for nothing) */
  private pendingBox: DrapeBounds | null = null;
  /** Whether the drape is painted in every tile up to a break (each) or in those it meets */
  private everyTile = true;
  /** The draws of the drape of the last layer, and the breaks (for the tests) */
  draws = 0;
  breaks = 0;
  /** The draws of the points of the last layer (for the measures) */
  pointDraws = 0;

  /** Whether the drape is painted (false on a copy of the world after the first) */
  private paints = true;

  /**
   * Starts a layer (false when the drape does not draw it)
   *
   * @param paints Whether the drape is painted: a copy of the world after the first draws only
   *   what the drape does not (the drape is drawn per tile once, on every copy)
   */
  begin(frame: TableDrapeFrame | null, layerId: string, opacity: number, paints = true): boolean {
    this.paints = paints;
    this.frame = null;
    this.pending.length = 0;
    this.pendingBox = null;
    this.draws = 0;
    this.breaks = 0;
    this.pointDraws = 0;
    if (!frame) return false;
    const range = frame.drape.layerRange(layerId);
    if (!range) return false;
    this.frame = frame;
    this.opacity = opacity;
    this.layerFrom = [range.from[0], range.from[1], range.from[2]];
    this.layerTo = [range.to[0], range.to[1], range.to[2]];
    this.everyTile = TableDrapePainter.order !== 'each-near';
    const n = frame.tiles.length;
    if (this.cursors.length < n * 3) {
      this.cursors = new Float64Array(n * 3);
      this.cursorKeys = new Float64Array(n);
    }
    const key = frame.drape.keyOf(this.layerFrom);
    for (let t = 0; t < n; t++) {
      this.cursors.set(this.layerFrom, t * 3);
      this.cursorKeys[t] = key;
    }
    return true;
  }

  /** Whether a layer is being drawn on the drape */
  get active(): boolean {
    return this.frame !== null;
  }

  /**
   * A run of rows the drape does not draw, ranked from `first`, within a Mercator box: a break,
   * drawn after the drape painted under it and before the drape painted over it
   *
   * @param target What draws it
   * @param reachPx The reach of what is drawn beyond the box on the screen (CSS px)
   */
  run(
    first: TableDrapeRank,
    box: DrapeBounds,
    reachPx: number,
    target: object,
    from: number,
    to: number,
    draw: (from: number, to: number) => void,
  ): void {
    const frame = this.frame;
    if (!frame || !this.paints) {
      draw(from, to);
      return;
    }
    this.pending.push({ target, from, to, draw });
    this.pendingBox = this.everyTile ? null : union(this.pendingBox, box);
    this.flush(first, reachPx);
  }

  /**
   * A break for what is drawn at once (ranked `rank`, within a Mercator box, null for anywhere):
   * the drape is painted up to it where it meets the box, and what waits is drawn; the caller
   * draws it next
   */
  breakAt(rank: TableDrapeRank, box: DrapeBounds | null, reachPx: number): void {
    if (!this.frame) return;
    this.pendingBox =
      box && this.pendingBox && !this.everyTile ? union(this.pendingBox, box) : null;
    this.flush(rank, reachPx);
  }

  /** Ends the layer: the drape is painted to its end, and what waits is drawn over it */
  end(): void {
    const frame = this.frame;
    if (!frame) return;
    this.paint(this.layerTo, null, 0);
    this.drawPending();
    this.frame = null;
  }

  /** Paints the drape up to a rank where what waits meets it, and draws what waits */
  private flush(rank: TableDrapeRank, reachPx: number): void {
    this.breaks++;
    this.paint(rank, this.pendingBox, reachPx);
    this.drawPending();
  }

  private drawPending(): void {
    for (const item of this.pending) {
      item.draw(item.from, item.to);
      this.pointDraws++;
    }
    this.pending.length = 0;
    this.pendingBox = null;
  }

  /** Paints the drape up to a rank, in the tiles a box meets (every tile for null) */
  private paint(rank: TableDrapeRank, box: DrapeBounds | null, reachPx: number): void {
    if (!this.paints) return;
    const frame = this.frame as TableDrapeFrame;
    const key = frame.drape.keyOf(rank);
    let entered = false;
    for (let t = 0; t < frame.tiles.length; t++) {
      if ((this.cursorKeys[t] as number) >= key) continue;
      const tile = frame.tiles[t] as TableDrapeTile;
      if (box && !reach(box, tile, reachPx * frame.dpr)) continue;
      if (!entered) {
        frame.enter();
        entered = true;
      }
      this.paintTile(t, rank);
      this.cursors.set(rank, t * 3);
      this.cursorKeys[t] = key;
    }
    if (entered) frame.leave();
  }

  /** Paints a tile from its cursor up to a rank */
  private paintTile(t: number, rank: TableDrapeRank): void {
    const frame = this.frame as TableDrapeFrame;
    const tile = frame.tiles[t] as TableDrapeTile;
    const from = this.cursors.subarray(t * 3, t * 3 + 3);
    frame.renderer.drawRowsTile(
      tile.entry.draw,
      tile.entry.projection,
      frame.light,
      frame.zoom,
      frame.dpr,
      this.opacity,
      { from: [from[0] as number, from[1] as number, from[2] as number], to: rank },
      tile.moving,
    );
    this.draws++;
  }
}

/**
 * The range of the elevations of the ground of a tile drawn (meters), as maplibre keeps it for its
 * DEM tile; a wide one when it does not
 */
function elevationRangeOf(terrain: unknown, tileID: unknown): readonly [number, number] {
  const range = (
    terrain as {
      getMinMaxElevation?(id: unknown): {
        minElevation: number | null;
        maxElevation: number | null;
      };
    }
  ).getMinMaxElevation?.(tileID);
  if (!range || range.minElevation === null || range.maxElevation === null) return [-500, 9000];
  return [range.minElevation, range.maxElevation];
}

/** The ranges of the blocks of the tiles, by the DEM they are read from and the tile */
const blocksByDem = new WeakMap<object, Map<string, Float32Array>>();

interface DemLike {
  readonly dim: number;
  get(x: number, y: number): number;
}

/**
 * The planes of the elevations of the ground of the blocks of a tile drawn (meters, as the DEM
 * gives them): fitted to the texels of the DEM its mesh reads in each block (the mesh
 * samples the DEM between four texels, and its cells may reach out of the block), with how far
 * they are from it at most. The mesh interpolates the texels, and a plane interpolated is the
 * plane, so no elevation of its ground in a block is further from the plane of the block. Read
 * once for a tile and its DEM
 */
function elevationBlocksOf(terrain: unknown, tileID: unknown): Float32Array | null {
  const holder = terrain as {
    tileManager?: { getSourceTile(id: unknown, fallback: boolean): unknown };
    sourceCache?: { getSourceTile(id: unknown, fallback: boolean): unknown };
  };
  const manager = holder.tileManager ?? holder.sourceCache;
  const source = manager?.getSourceTile(tileID, true) as
    | { dem?: DemLike; tileID?: { canonical: { x: number; y: number; z: number } } }
    | undefined;
  const dem = source?.dem;
  const from = source?.tileID?.canonical;
  const to = (tileID as { canonical?: { x: number; y: number; z: number } }).canonical;
  if (!dem || !from || !to || to.z < from.z) return null;
  let byTile = blocksByDem.get(dem);
  if (!byTile) {
    byTile = new Map();
    blocksByDem.set(dem, byTile);
  }
  const key = `${to.z}/${to.x}/${to.y}`;
  const kept = byTile.get(key);
  if (kept) return kept;
  const scale = 2 ** (to.z - from.z);
  const fx = to.x / scale - from.x;
  const fy = to.y / scale - from.y;
  const dim = dem.dim;
  const out = new Float32Array(DRAPE_GROUND_BLOCK_TEXELS * 4);
  // A position of the mesh in a block reads the texels around it (its cell of the mesh may reach
  // out of the block)
  const cell = 1 / getTerrainMeshSize(terrain as Parameters<typeof getTerrainMeshSize>[0]) / scale;
  // The plane of the elevations of the texels a part of the tile reads, in units of the tile
  // (a + b u + c v), and how far they are from it at most
  const fitBlock = (u0: number, v0: number, u1: number, v1: number, at: number): void => {
    const y0 = Math.max(-1, Math.floor((fy + v0 / scale - cell) * dim - 0.5));
    const y1 = Math.min(dim, Math.floor((fy + v1 / scale + cell) * dim - 0.5) + 1);
    const x0 = Math.max(-1, Math.floor((fx + u0 / scale - cell) * dim - 0.5));
    const x1 = Math.min(dim, Math.floor((fx + u1 / scale + cell) * dim - 0.5) + 1);
    const uOf = (x: number): number => ((x + 0.5) / dim - fx) * scale;
    const vOf = (y: number): number => ((y + 0.5) / dim - fy) * scale;
    let count = 0;
    let su = 0;
    let sv = 0;
    let sh = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        su += uOf(x);
        sv += vOf(y);
        sh += dem.get(x, y);
        count++;
      }
    }
    const mu = su / count;
    const mv = sv / count;
    const mh = sh / count;
    let suu = 0;
    let svv = 0;
    let suv = 0;
    let suh = 0;
    let svh = 0;
    for (let y = y0; y <= y1; y++) {
      const dv = vOf(y) - mv;
      for (let x = x0; x <= x1; x++) {
        const du = uOf(x) - mu;
        const dh = dem.get(x, y) - mh;
        suu += du * du;
        svv += dv * dv;
        suv += du * dv;
        suh += du * dh;
        svh += dv * dh;
      }
    }
    const det = suu * svv - suv * suv;
    let b = 0;
    let c = 0;
    if (det > 1e-30) {
      b = (suh * svv - svh * suv) / det;
      c = (svh * suu - suh * suv) / det;
    }
    const a = mh - b * mu - c * mv;
    let reach = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const off = Math.abs(dem.get(x, y) - (a + b * uOf(x) + c * vOf(y)));
        if (off > reach) reach = off;
      }
    }
    out[at * 4] = a;
    out[at * 4 + 1] = b;
    out[at * 4 + 2] = c;
    // The rounding of the plane to 32-bit floats, over the tile
    out[at * 4 + 3] = reach + 1e-6 * (Math.abs(a) + Math.abs(b) + Math.abs(c));
  };
  const n = DRAPE_GROUND_BLOCKS;
  for (let by = 0; by < n; by++) {
    for (let bx = 0; bx < n; bx++)
      fitBlock(bx / n, by / n, (bx + 1) / n, (by + 1) / n, by * n + bx);
  }
  const m = DRAPE_GROUND_COARSE_BLOCKS;
  for (let cy = 0; cy < m; cy++) {
    for (let cx = 0; cx < m; cx++) {
      fitBlock(cx / m, cy / m, (cx + 1) / m, (cy + 1) / m, n * n + cy * m + cx);
    }
  }
  byTile.set(key, out);
  return out;
}

/**
 * A Mercator box widened by a reach on the screen in a tile, clipped to the tile (null when it
 * does not meet the tile)
 */
function reach(box: DrapeBounds, tile: TableDrapeTile, reachPx: number): DrapeBounds | null {
  const size = tile.box.maxX - tile.box.minX;
  // A tile seen edge on, or across the camera, is reached whole
  const margin = tile.pixels > 1 ? (reachPx / tile.pixels) * size : size;
  const minX = Math.max(box.minX - margin, tile.box.minX);
  const maxX = Math.min(box.maxX + margin, tile.box.maxX);
  const minY = Math.max(box.minY - margin, tile.box.minY);
  const maxY = Math.min(box.maxY + margin, tile.box.maxY);
  if (minX > maxX || minY > maxY) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * The Mercator box of rows `[from, to)` of a group with positions (null for none)
 *
 * @internal
 */
export function rowsBox(group: RowGroup, from: number, to: number): DrapeBounds | null {
  let out: DrapeBounds | null = null;
  for (let row = from; row < to; row++) {
    const box = rowBox(group, row);
    if (box) out = union(out, box);
  }
  return out;
}

// === The motions of the moving partitions ===

/** How a moving set moves its rows: its translation, then its transform */
interface Motion {
  readonly translation: readonly [number, number];
  readonly transform: EnuEdit | null;
}

/** A moving partition drawn in a frame */
interface ActiveMoving {
  readonly set: MovingSet;
  readonly motion: Motion;
  /** The Mercator box its rows are drawn in, moved */
  readonly box: DrapeBounds;
}

const IDENTITY_MOTION: Motion = { translation: [0, 0], transform: null };

/** A Mercator position moved back to where a motion took it from */
function movedBack(motion: Motion, x: number, y: number): [number, number] {
  let lng = x * 360 - 180;
  let lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
  lng -= motion.translation[0];
  lat -= motion.translation[1];
  if (motion.transform) {
    const back = moveEnuPosition(inverseEnuEdit(motion.transform), [lng, lat], false);
    lng = back[0] as number;
    lat = back[1] as number;
  }
  return [drapeMercatorX(lng), drapeMercatorY(lat)];
}

/** A Mercator position moved by a motion */
function movedOn(motion: Motion, x: number, y: number): [number, number] {
  let lng = x * 360 - 180;
  let lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
  if (motion.transform) {
    const on = moveEnuPosition(motion.transform, [lng, lat], false);
    lng = on[0] as number;
    lat = on[1] as number;
  }
  lng += motion.translation[0];
  lat += motion.translation[1];
  return [drapeMercatorX(lng), drapeMercatorY(lat)];
}

/** The Mercator box of a box moved by a motion (its corners and its middle) */
function movedBox(bounds: DrapeBounds | null, motion: Motion): DrapeBounds {
  if (!bounds) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let out: DrapeBounds | null = null;
  const xs = [bounds.minX, (bounds.minX + bounds.maxX) / 2, bounds.maxX];
  const ys = [bounds.minY, (bounds.minY + bounds.maxY) / 2, bounds.maxY];
  for (const x of xs) {
    for (const y of ys) {
      const [mx, my] = movedOn(motion, x, y);
      out = union(out, { minX: mx, minY: my, maxX: mx, maxY: my });
    }
  }
  return out as DrapeBounds;
}

/**
 * The map from the position in a tile drawn back to the position in the tiles of zoom `coarseZ`
 * (in units of those tiles), as an affine map fitted over the tile in float64 (its linear part
 * from the differences across the tile), its inverse linear part, and the tiles it reaches
 */
function tileMotionFit(
  tile: DrapeTile,
  coarseZ: number,
  motion: Motion,
): { xf: number[]; back: number[]; tiles: DrapeTile[] } | null {
  const size = 1 / 2 ** tile.z;
  const scale = 2 ** coarseZ;
  const at = (u: number, v: number): [number, number] => {
    const [x, y] = movedBack(motion, (tile.x + u) * size, (tile.y + v) * size);
    return [x * scale, y * scale];
  };
  const c = at(0.5, 0.5);
  const ex0 = at(0, 0.5);
  const ex1 = at(1, 0.5);
  const ey0 = at(0.5, 0);
  const ey1 = at(0.5, 1);
  const a = ex1[0] - ex0[0];
  const b = ex1[1] - ex0[1];
  const d = ey1[0] - ey0[0];
  const e = ey1[1] - ey0[1];
  const det = a * e - b * d;
  if (!(Math.abs(det) > 0) || !Number.isFinite(det)) return null;
  // Column major: q = A p + t, with A = [[a, d], [b, e]]
  const tx = c[0] - (a * 0.5 + d * 0.5);
  const ty = c[1] - (b * 0.5 + e * 0.5);
  const xf = [a, b, 0, d, e, 0, tx, ty, 1];
  const back = [e / det, -b / det, -d / det, a / det];
  // The tiles the corners of the tile reach, moved back
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [u, v] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    const q = [a * u + d * v + tx, b * u + e * v + ty];
    minX = Math.min(minX, q[0] as number);
    maxX = Math.max(maxX, q[0] as number);
    minY = Math.min(minY, q[1] as number);
    maxY = Math.max(maxY, q[1] as number);
  }
  const tiles: DrapeTile[] = [];
  const limit = 2 ** coarseZ;
  for (let y = Math.floor(minY); y <= Math.floor(maxY); y++) {
    for (let x = Math.floor(minX); x <= Math.floor(maxX); x++) {
      if (y < 0 || y >= limit) continue;
      tiles.push({ x: ((x % limit) + limit) % limit, y, z: coarseZ });
    }
  }
  return { xf, back, tiles };
}

/**
 * The tiles of the index of a moving partition a view needs: for each tile of the view, the
 * tiles one step coarser its corners reach moved back by the motion, those its rows touch
 */
function coarseTilesOf(
  tiles: readonly DrapeTile[],
  motion: Motion,
  bounds: DrapeBounds | null,
): DrapeTile[] {
  if (!bounds) return [];
  const out = new Map<string, DrapeTile>();
  for (const tile of tiles) {
    const coarseZ = Math.max(0, tile.z - 1);
    const fit = tileMotionFit(tile, coarseZ, motion);
    if (!fit) continue;
    const size = 1 / 2 ** coarseZ;
    for (const coarse of fit.tiles) {
      const box = {
        minX: coarse.x * size,
        minY: coarse.y * size,
        maxX: (coarse.x + 1) * size,
        maxY: (coarse.y + 1) * size,
      };
      if (box.maxX < bounds.minX || box.minX > bounds.maxX) continue;
      if (box.maxY < bounds.minY || box.minY > bounds.maxY) continue;
      out.set(`${coarse.z}/${coarse.x}/${coarse.y}`, coarse);
    }
  }
  return [...out.values()];
}

/** Whether two lists of rows of moving partitions hold the same rows */
function sameRows(a: readonly MovingMember[], b: readonly MovingMember[]): boolean {
  if (a.length !== b.length) return false;
  const refs = new Set<number>();
  for (const member of a) refs.add(member.main.ref);
  for (const member of b) if (!refs.has(member.main.ref)) return false;
  return true;
}
