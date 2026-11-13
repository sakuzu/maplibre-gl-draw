// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hooks of measurement of the drawing of the layers held as rows of columns, for the tests
 * and the measurement pages of the library: not part of its API. They are read by the draw
 * instance (`tableDiagnosticsOf`), from this module.
 */

import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import { type TableDrapeOrder, TableDrapePainter } from '../../view/layer/table-drape.js';
import type { TableDrawRecord } from '../../view/layer/table-retained.js';
import type { Draw } from '../draw.js';
import type { Engine } from './engine.js';

/**
 * One range of rows of a layer held as rows of columns, drawn in one draw, as the record of
 * the draws gives it
 *
 * @internal
 */
export interface TableDrawnRange {
  /** The layer */
  readonly layerId: string;
  /** The handle of the row group */
  readonly group: number;
  /** The place of the row group in the order of its layer */
  readonly groupIndex: number;
  /**
   * How the rows are drawn: in one draw with rows of every kind (`rows`), from a retained batch
   * of their kind, or at once
   */
  readonly kind: 'rows' | 'polygon' | 'line' | 'point' | 'immediate';
  /** The first row of the range in its group */
  readonly from: number;
  /** The end of the range (exclusive) */
  readonly to: number;
  /**
   * Whether the rows are rows of the delta of the layer (the rows changed since their groups
   * were built, drawn at their places): `group` is the handle of the delta, `groupIndex` -1, and
   * `from` and `to` are rows of the delta
   */
  readonly delta?: boolean;
}

/**
 * The hooks of measurement of the drawing of the layers held as rows of columns
 *
 * @internal
 */
export interface TableDiagnostics {
  /**
   * Cuts the ranges drawn of every layer held as rows at `count` places spread over its rows in
   * view (0 for none): every cut draws a range in two draws, as something drawn between two rows
   * would
   */
  setArtificialCuts(count: number): void;
  /**
   * Records the ranges drawn from the next frame on, in the order they are drawn, into the
   * array it returns, until `stopRecording`
   */
  recordDraws(): readonly TableDrawnRange[];
  /** Stops the recording of the ranges drawn */
  stopRecording(): void;
  /**
   * Draws the layers held as rows with one renderer per kind of geometry and a chunk per run of
   * a kind (true), as on the terrain and the globe, even where they are drawn in one draw per
   * chunk with rows of every kind (false, the default): to compare the two
   */
  setDrawingByKind(byKind: boolean): void;
  /** Marks or unmarks rows as selected in bulk */
  setRowsMarked(handles: ArrayLike<number>, marked: boolean): void;
  /** Puts rows into a moving set (1 to 3), or takes them out of any (0) */
  setRowsMoving(handles: ArrayLike<number>, set: number): void;
  /** Sets the translation of a moving set (1 to 3), in degrees of longitude and latitude */
  setMoveTranslation(set: number, dLng: number, dLat: number): void;
  /** What the writes of rows in place hold and did, for the measurement of the edits */
  editStats(): TableEditStats;
  /**
   * Sets the time the chunks of the next versions of row groups may take to build in a frame
   * while the camera moves (0, the default: they are built once the camera is still), to
   * compare the two
   */
  setVersionBudgetWhileMoving(ms: number): void;
  /** The bytes the GPU holds per renderer (`points`, `lines`, `polygons`, `rows`, `rowState`) */
  gpuBytesByRenderer(): Readonly<Record<string, number>>;
  /** What the drape of the polygons and the lines of the rows did in the last frame */
  drape(): TableDrapeDiagnostics;
  /**
   * How the polygons and the lines of the rows keep their order on the terrain (`ground`, the
   * default; `each` and `each-near`, the references one row at a time on the drape of the rows)
   */
  setDrapeOrder(order: TableDrapeOrder): void;
}

/**
 * What the drape of the polygons and the lines of the layers held as rows did in the last frame
 * on the terrain
 *
 * @internal
 */
export interface TableDrapeDiagnostics {
  /** Whether the rows were draped, and why not when they were not */
  readonly used: boolean;
  readonly reason: string;
  /** The partitions (row groups) and the elements (copies of rows) of the drape */
  readonly partitions: number;
  readonly elements: number;
  /** The tiles drawn */
  readonly tiles: number;
  /** The tiles built from nothing and the partitions binned again in tiles, in the frame */
  readonly built: number;
  readonly rebinned: number;
  /** The partitions binned into tiles since the instance was made */
  readonly binCount: number;
  readonly unfitTiles: number;
  readonly truncatedCells: number;
  /** The draws of the drape in the frame, and the breaks of the order among them (references) */
  readonly draws: number;
  readonly breaks: number;
  /** The draws of the points drawn among the drape in the frame (references) */
  readonly pointDraws: number;
}

/**
 * What the writes of rows in place hold and did since the instance was made: the styles kept,
 * the values written in place, the bytes written to the GPU, how the rows written reached the
 * chunks that draw them, and the time of the last frame
 *
 * @internal
 */
export interface TableEditStats {
  /** The distinct styles of the rows (the table of styles of the tables) */
  readonly styles: number;
  /** The resolved styles the drawing holds, over every layer */
  readonly resolvedStyles: number;
  /** The bytes the values written in place hold, not folded into their row groups yet */
  readonly overrideBytes: number;
  /** The row groups whose values written in place are past their limit */
  readonly groupsDue: number;
  /** The rows moved since their row groups were built */
  readonly movedRows: number;
  /** The bytes the drawing of the rows wrote to the GPU (chunks, writes in place, styles) */
  readonly uploadedBytes: number;
  /** The rows written in place into the chunks that draw them */
  readonly inPlace: number;
  /** Of them, the rows written by the positions of their coordinates only */
  readonly coordsOnly: number;
  /** Of them, the rows written by their style only */
  readonly styleOnly: number;
  /** The rows that did not fit their places: they went to the delta of their layer */
  readonly rebuilt: number;
  /** The rows of a chunk being built: its build started again */
  readonly restarted: number;
  /** The rows classified otherwise: they went to the delta of their layer */
  readonly reclassified: number;
  /** The rows held by the deltas of every layer (changed since their row groups were built) */
  readonly deltaRows: number;
  /** The cuts of the drawn ranges for the rows of the deltas in the last frame */
  readonly cuts: number;
  /** The next versions of row groups swapped in so far */
  readonly versionsSwapped: number;
  /** The next versions built and waiting for their chunks */
  readonly versionsPending: number;
  /** The most next versions held at once so far */
  readonly versionsMostPending: number;
  /** The time the last merge of a next version on the main thread took, in ms */
  readonly lastMergeMs: number;
  /** The time of the last pass before the main one (the writes and the uploads), in ms */
  readonly prerenderMs: number;
  /** The time the layers held as rows took to draw in the last frame, in ms */
  readonly drawMs: number;
}

/** The hooks of each draw instance */
const DIAGNOSTICS = new WeakMap<Draw, TableDiagnostics>();

/**
 * Gives a draw instance its hooks of measurement, over its engine
 *
 * @internal
 */
export function attachTableDiagnostics(
  draw: Draw,
  engine: Pick<Engine, 'customLayer' | 'context' | 'map'>,
): void {
  DIAGNOSTICS.set(draw, createTableDiagnostics(engine));
}

/**
 * The hooks of measurement of a draw instance
 *
 * @throws when the instance was not made by `createDraw`
 * @internal
 */
export function tableDiagnosticsOf(draw: Draw): TableDiagnostics {
  const diagnostics = DIAGNOSTICS.get(draw);
  if (!diagnostics) throw new Error('the draw instance was not made by createDraw');
  return diagnostics;
}

/** The hooks of measurement over an engine */
function createTableDiagnostics(
  engine: Pick<Engine, 'customLayer' | 'context' | 'map'>,
): TableDiagnostics {
  const { customLayer } = engine;
  const store = engine.context.store;
  /** The state sets of the rows of the Store, when it holds rows */
  const states = () => featureTablesInternals(store.tables)?.states;
  const repaint = (): void => {
    engine.map.triggerRepaint?.();
  };
  return {
    gpuBytesByRenderer() {
      return { ...customLayer.getGpuMemory().byOwner };
    },
    setArtificialCuts(count) {
      customLayer.getTableRenderer()?.setArtificialCuts(count);
      repaint();
    },
    recordDraws() {
      const record: TableDrawRecord[] = [];
      customLayer.getTableRenderer()?.recordDraws(record);
      repaint();
      return record as readonly TableDrawnRange[];
    },
    stopRecording() {
      customLayer.getTableRenderer()?.recordDraws(null);
    },
    setDrawingByKind(byKind) {
      customLayer.getTableRenderer()?.setDrawingByKind(byKind);
      repaint();
    },
    setRowsMarked(handles, marked) {
      states()?.setBulk(Int32Array.from(handles), marked);
      repaint();
    },
    setRowsMoving(handles, set) {
      states()?.setMoving(Int32Array.from(handles), set);
      repaint();
    },
    setMoveTranslation(set, dLng, dLat) {
      states()?.setTranslation(set, dLng, dLat);
      repaint();
    },
    editStats(): TableEditStats {
      const internals = featureTablesInternals(store.tables);
      const renderer = customLayer.getTableRenderer();
      const drawing = renderer?.editStats();
      const versions = internals?.versionStats();
      return Object.freeze({
        styles: internals?.styles.size ?? 0,
        resolvedStyles: drawing?.resolvedStyles ?? 0,
        overrideBytes: internals?.overrideBytes() ?? 0,
        groupsDue: internals?.groupsDue.size ?? 0,
        movedRows: internals?.movedRowCount() ?? 0,
        uploadedBytes: drawing?.uploadedBytes ?? 0,
        inPlace: drawing?.writes.inPlace ?? 0,
        coordsOnly: drawing?.writes.coordsOnly ?? 0,
        styleOnly: drawing?.writes.styleOnly ?? 0,
        rebuilt: drawing?.writes.rebuilt ?? 0,
        restarted: drawing?.writes.restarted ?? 0,
        reclassified: drawing?.writes.reclassified ?? 0,
        deltaRows: internals?.deltaRowCount() ?? 0,
        cuts: drawing?.writes.cuts ?? 0,
        versionsSwapped: versions?.swapped ?? 0,
        versionsPending: versions?.pending ?? 0,
        versionsMostPending: versions?.mostPending ?? 0,
        lastMergeMs: versions?.lastMergeMs ?? 0,
        prerenderMs: drawing?.prerenderMs ?? 0,
        drawMs: drawing?.drawMs ?? 0,
      });
    },
    setVersionBudgetWhileMoving(ms) {
      customLayer.getTableRenderer()?.setVersionBudgetWhileMoving(ms);
    },
    drape(): TableDrapeDiagnostics {
      const renderer = customLayer.getTableRenderer();
      const drape = renderer?.drapeDiagnostics();
      return Object.freeze({
        used: drape?.used ?? false,
        reason: drape?.reason ?? 'none',
        partitions: drape?.partitions ?? 0,
        elements: drape?.elements ?? 0,
        tiles: drape?.tiles ?? 0,
        built: drape?.built ?? 0,
        rebinned: drape?.rebinned ?? 0,
        binCount: drape?.binCount ?? 0,
        unfitTiles: drape?.unfitTiles ?? 0,
        truncatedCells: drape?.truncatedCells ?? 0,
        draws: drape?.draws ?? 0,
        breaks: drape?.breaks ?? 0,
        pointDraws: drape?.pointDraws ?? 0,
      });
    },
    setDrapeOrder(order) {
      TableDrapePainter.order = order;
      engine.map.triggerRepaint?.();
    },
  };
}
