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
