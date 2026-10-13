// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The state of this client: the mode, the selection, the vertex selection, the snapping
 * result, the stacking order and the terrain diagnostics
 */

import type { Position } from 'geojson';

/** The names of the built-in modes. */
export const MODES = [
  'select',
  'draw_point',
  'draw_line',
  'draw_polygon',
  'draw_image',
  'draw_circle',
  'draw_freehand',
] as const;

/**
 * The name of a mode: how the input is received. One of {@link MODES}, or the name of a mode
 * added with `draw.extensions.modes.add`.
 */
export type Mode = (typeof MODES)[number] | (string & {});

/** What the selection holds: features, groups or layers. */
export type SelectionType = 'feature' | 'group' | 'layer';

/** What this client has selected: the type and the IDs. The selection holds one type at a time. */
export interface Selection {
  /** The type of the selected items, or `null` when nothing is selected */
  type: SelectionType | null;
  /** The IDs of the selected items */
  ids: readonly string[];
}

/**
 * A vertex of a feature, as the part, the ring and the index within the ring.
 */
export interface VertexRef {
  /** The part of a Multi geometry; 0 when it is left out */
  part?: number;
  /** The ring of a polygon, 0 for the outer ring; 0 for lines and points */
  ring: number;
  /** The index of the vertex within the ring */
  index: number;
}

/** The selected vertices of one feature. */
export interface VertexSelection {
  /** The ID of the feature */
  featureId: string;
  /** The selected vertices */
  vertices: readonly VertexRef[];
}

/**
 * Where the pointer snapped to. When nothing was snapped to, `lngLat` is the position of the
 * pointer and `target` is absent.
 */
export interface SnapResult {
  /** The position after snapping */
  lngLat: Position;
  /** What was snapped to */
  target?: {
    /**
     * The kind of the target; a kind of its own that a snap provider gave its candidate is
     * kept as it is
     */
    kind: 'vertex' | 'edge' | 'intersection' | 'guide' | (string & {});
    /** The ID of the feature, for a target of the document */
    featureId?: string;
    /** The ID of the dataset, for a target of a dataset */
    datasetId?: string;
    /** A description to show */
    description?: string;
    /** The vertex, for a vertex target */
    vertex?: VertexRef;
    /** The segment, for an edge or a guide */
    segment?: { start: Position; end: Position };
  };
}

/**
 * How a mode wants the positions of its input snapped, as `ModeHandler.snapPreference` declares
 * it. It is read before every input is snapped, so a mode whose preference changes
 * while it draws declares it as a getter.
 */
export interface SnapPreference {
  /**
   * The feature to prefer when snapping candidates are at the same distance, such as the
   * boundary a trace started along; none when it is left out or `null`
   */
  prefer?: { featureId: string; datasetId?: string } | null;
  /**
   * The inputs whose position is not snapped, by the name of their receiver; every input is
   * snapped when it is left out. A stroke drawn by dragging leaves out `onDrag`, so that its
   * inner points follow the pointer while its ends still snap.
   */
  unsnapped?: readonly ('onClick' | 'onPointerMove' | 'onDragStart' | 'onDrag' | 'onDragEnd')[];
}

/**
 * One division of the stacking order: the map layer that draws one run of the layer order
 * between two entries that come from outside the document.
 */
export interface LayerStackEntry {
  /** The ID of the map layer that draws the run */
  readonly layerId: string;
  /** The index in the layer order where the run starts (inclusive) */
  readonly from: number;
  /** The index in the layer order where the run ends (exclusive) */
  readonly to: number;
}

/**
 * The GPU memory the drawing of the instance holds, for diagnostics: the buffers and the
 * textures its renderers allocated and have not deleted. It is a lower bound of what the page
 * uses on the GPU: the base map and the elevation data of maplibre are not in it.
 */
export interface GpuMemoryDiagnostics {
  /** The bytes of every buffer and texture */
  readonly bytes: number;
  /** The bytes of the buffers */
  readonly bufferBytes: number;
  /** The bytes of the textures */
  readonly textureBytes: number;
  /** The bytes per renderer (`points`, `lines`, `polygons`, `rows`, `row-state`) */
  readonly byRenderer: Readonly<Record<string, number>>;
}

/**
 * One range of rows of a layer held as rows of columns, drawn in one draw, as the record of
 * the draws gives it
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
 * The hooks of measurement of the drawing of the layers held as rows of columns. They are for
 * measuring and testing the drawing; their effects follow it and carry a weaker promise.
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
  /** Hides or shows rows by their handles, in this instance only */
  setRowsHidden(handles: ArrayLike<number>, hidden: boolean): void;
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
}

/**
 * What the writes of rows in place hold and did since the instance was made: the styles kept,
 * the values written in place, the bytes written to the GPU, how the rows written reached the
 * chunks that draw them, and the time of the last frame
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

/**
 * The state the terrain was drawn with, for diagnostics. Its fields follow the drawing and
 * carry a weaker promise than the rest of the API.
 */
export interface TerrainDiagnostics {
  /** The terrain state of the last drawing */
  readonly render: {
    /** Whether the terrain was on and its elevation data usable */
    readonly active: boolean;
    /** The Mercator rectangle the elevation data covers, `[x0, y0, 1 / width, 1 / height]` */
    readonly atlasRect: readonly [number, number, number, number];
    /** The size of the elevation data in texels, `[width, height]` */
    readonly atlasSize: readonly [number, number];
    /** The factor from meters to Mercator z at the latitude of the center of the screen */
    readonly elevationScale: number;
    /** The lift above the ground in meters */
    readonly liftMeters: number;
    /** The subdivision step in meters (0 means no subdivision) */
    readonly stepMeters: number;
    /** The grid spacing of the subdivision, in Mercator units */
    readonly stepGrid: number;
    /** The generation of the subdivision; it counts the changes of the step */
    readonly generation: number;
  };
  /** How the areas were laid on the terrain in the last drawing */
  readonly drape: {
    /** Whether the analytic drape was used */
    readonly used: boolean;
    /** Why it was not used */
    readonly reason: string;
    /** The number of features laid on the drape */
    readonly featureCount: number;
    /** The number of edges */
    readonly edgeCount: number;
    /** The number of tiles drawn */
    readonly tileCount: number;
    /** The largest number of runs in one cell */
    readonly maxRunsPerCell: number;
    /** The largest number of edges in one cell */
    readonly maxEdgesPerCell: number;
    /** The largest number of edges in one tile of the view */
    readonly maxTileEdges: number;
    /** The number of cells cut short for going over the budget */
    readonly truncatedCells: number;
    /** The number of tiles that could not be evaluated and were not drawn */
    readonly unfitTiles: number;
    /** The number of runs whose cell origin was inside the feature */
    readonly insideRuns: number;
    /** The number of features left off the drape */
    readonly excluded: number;
    /** The number of features drawn without the drape */
    readonly immediate: number;
  };
}
