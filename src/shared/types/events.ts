// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The payloads of the public events that are defined by the areas above shared/
 *
 * The EventEmitter (shared/utils/event-emitter.ts) types every event, so the payloads it
 * carries sit here, below every layer. The defining areas re-export them.
 */

import type { Coordinate, Feature, VertexRef } from './model.js';

/**
 * Payload of draw.map.click (an event exposed on the instance)
 *
 * This exists to emit the normalized click of select mode as a single stream, as-is,
 * regardless of whether anything was hit or of what was hit. The coordinates are the
 * ones from before snapping (the raw normalized event). It is meant for read-only
 * subscription and has no effect at all on the selection behavior of the mode.
 */
export interface MapClickEventPayload {
  /** Map coordinates [lng, lat] */
  lngLat: Coordinate;
  /** Screen coordinates */
  point: { x: number; y: number };
}

/**
 * Payload of draw.dataset.click (a public instance event)
 *
 * It reports in one event how a click in the select mode was resolved by the interception of the
 * datasets. When a feature of an interactive dataset is hit, datasetId and
 * feature are filled in; when nothing at all was hit (including a block by a non-interactive
 * dataset) both are null. It does not fire for a click that hit a feature of the Store (that
 * is the domain of selection.change on the selection side of the Store). The host can treat this
 * null as "a click on empty space = clearing the data selection".
 */
export interface DatasetClickEventPayload {
  /** Id of the dataset that was hit. null when there was no hit */
  datasetId: string | null;
  /** The feature that was hit. null when there was no hit */
  feature: Feature | null;
  /**
   * The row of the feature in its dataset (its index in the rows given to the
   * dataset, or its row in a table). null when there was no hit
   */
  row: number | null;
  /** Map coordinate [lng, lat] */
  lngLat: Coordinate;
}

/**
 * A geographic coordinate (the same shape as the lngLat of a normalized event)
 */
export interface SnapLngLat {
  /** The longitude in degrees */
  lng: number;
  /** The latitude in degrees */
  lat: number;
}

/**
 * The kind of a snapping target
 *
 * The priority order is vertex > intersection > edge > guide, and ties are decided by
 * distance.
 */
export type SnapTargetKind = 'vertex' | 'edge' | 'intersection' | 'guide';

/**
 * A segment to snap to (an edge or a guide)
 */
export interface SnapTargetSegment {
  /** The start point of the segment */
  start: Coordinate;
  /** The end point of the segment */
  end: Coordinate;
  /** For a real edge, the vertex reference of the start point */
  startRef?: VertexRef;
  /** For a real edge, the vertex reference of the end point */
  endRef?: VertexRef;
}

/**
 * Information about a snapping target
 *
 * The geometric references of the target (vertex / segment) are read by tracing and
 * by the rendering of the guide line.
 */
export interface SnapTarget {
  /** The kind of the target */
  kind: SnapTargetKind;
  /** The feature ID of the target (only for candidates originating from the Store) */
  featureId?: string;
  /**
   * The dataset ID of the target (only for candidates originating from a
   * dataset)
   */
  datasetId?: string;
  /** A description for display (read by the status bar and the like) */
  description?: string;
  /** When the target is a vertex, its vertex reference */
  vertex?: VertexRef;
  /** When the target is an edge or a guide, its segment */
  segment?: SnapTargetSegment;
}

/**
 * The result of snapping
 *
 * When nothing was snapped to, the input coordinate goes into lngLat as it is and no
 * target is attached.
 */
export interface SnapResult {
  /** The coordinate after snapping (the input as it is when nothing was snapped to) */
  lngLat: SnapLngLat;
  /** The snapping target (absent when nothing was snapped to) */
  target?: SnapTarget;
}

/**
 * One frame of the stacking order: the maplibre layer that draws one run of the layer order
 * between two external entries
 *
 * When the `isExternalEntry` option marks entries of the layer order as external, the draw
 * instance draws each run between them in a maplibre custom layer of its own, so the host can
 * place its own maplibre layers between the frames. `getRenderSlots()` lists the frames, and
 * the `draw.renderslots.change` event announces a change of them.
 */
export interface RenderSlot {
  /** The maplibre layer ID of the custom layer that draws this run */
  readonly layerId: string;
  /** The index in the layer order where the run starts (inclusive) */
  readonly from: number;
  /** The index in the layer order where the run ends (exclusive) */
  readonly to: number;
}
