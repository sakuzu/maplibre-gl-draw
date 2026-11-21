// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The state of this client: the mode, the selection, the vertex selection, the snapping
 * result, the stacking order and the terrain diagnostics
 */

import type { Position } from 'geojson';
import type { IdSet } from './model.js';

/** The names of the built-in modes. */
export const MODES = [
  'select',
  'drawPoint',
  'drawLine',
  'drawPolygon',
  'drawImage',
  'drawCircle',
  'drawFreehand',
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
  /**
   * The IDs of the selected items. A box selection lists the features it takes in stacking
   * order, from the back.
   */
  ids: IdSet;
}

/**
 * A vertex of a feature, as the part, the ring and the index within the ring.
 *
 * How a vertex is followed while its feature changes: this rule is the one the instance uses
 * wherever it keeps a vertex across changes (the vertices of a drag, the vertex selection, the
 * vertices `features.restore` takes back). A vertex is kept by its index. Every time the geometry
 * of its feature changes, each ring is compared before and after (the rings matched by their
 * part and ring numbers): the vertices equal from the start of the ring, and those equal from
 * its end, are found, and what lies between them is the span that changed.
 *
 * - A vertex before the span keeps its index.
 * - A vertex after the span moves its index by the difference of the lengths of the ring.
 * - A vertex inside the span cannot be followed when the length of the ring changed. When the
 *   ring keeps its length, it goes to the index where its position is now, when the span holds
 *   that position at one other index only (vertices were taken out and put in at once, or the
 *   ring was turned around); otherwise it keeps its index (the vertex was moved).
 *
 * The rings are matched by their numbers only while there are as many of them as before: when
 * the geometry has another type or another number of parts, no vertex of the feature can be
 * followed, and when a part has another number of rings, no vertex of that part can be (a ring
 * taken out would give its number to the next one). A vertex that a
 * drag of vertices cannot follow leaves the drag, as do the vertices of a feature that is
 * deleted or locked, and the drag goes on with the others (the other features of a drag of
 * shared vertices, say); it ends as cancelled (`drag.ended` with `cancelled: true`) only when
 * nothing is left in it, or when the document turns read-only. The vertex selection lets go of
 * the vertices it cannot follow; `features.restore` leaves them and counts them.
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
