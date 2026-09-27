// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The state of this client: the mode, the selection, the vertex selection, the snapping
 * result, the stacking order and the terrain diagnostics
 */

import type { Position } from 'geojson';

/** The names of the built-in modes. */
// TODO(api-2): confirm the names (carried over, as the design does not rename them)
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
// TODO(api-2): confirm the fields of target (carried over; the target type is not a symbol of the entry)
export interface SnapResult {
  /** The position after snapping */
  lngLat: Position;
  /** What was snapped to */
  target?: {
    /** The kind of the target */
    kind: 'vertex' | 'edge' | 'intersection' | 'guide';
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
 * One division of the stacking order: the map layer that draws one run of the layer order
 * between two entries that are not layers of the document.
 */
export interface RenderSlot {
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
// TODO(api-2): confirm the fields (the previous nested types are not symbols of the entry)
export interface TerrainDiagnostics {
  /** The terrain state of the last drawing */
  readonly render: Readonly<Record<string, unknown>>;
  /** How the features were laid on the terrain in the last drawing */
  readonly drape: Readonly<Record<string, unknown>>;
}
