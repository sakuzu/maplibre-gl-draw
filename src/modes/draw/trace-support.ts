// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Trace support for the drawing modes
 *
 * A small set of helpers, used in common by the line and the polygon drawing modes, for
 * deriving a trace path from the snapping result of an input. A mode learns about snapping only
 * through `snapped` of the event it receives, so an input that was not snapped (`snap: false`
 * of a synthetic input) has no target and starts no trace.
 *
 * The path itself is the shortest path of a graph assembled from the nearby edges
 * (operations/trace-graph.ts). The feature ID and the dataset ID of the snap target are
 * used only to resolve the exact coordinates of the endpoints (a vertex reference, or the two
 * ends of an edge); whether the two points belong to the same feature does not matter.
 *
 * Everything the helpers read goes through a {@link TraceSource}, which `traceSourceOf` builds
 * over the context of a mode.
 */

import type { Geometry } from 'geojson';
import type { ModeContext } from '../../api/extension/context.js';
import type { DrawPointerEvent } from '../../api/extension/mode.js';
import type { Feature as PublicFeature } from '../../api/model.js';
import { resolveVertexCoordinates } from '../../operations/shared-vertex.js';
import type { TraceGraphEndpoint } from '../../operations/trace-graph.js';
import { buildTraceGraph, findTracePath } from '../../operations/trace-graph.js';
import { degreesPerPixel } from '../../snapping/geometry.js';
import { DEFAULT_SNAP_OPTIONS } from '../../snapping/types.js';
import { isLocallyHidden } from '../../store/local-visibility.js';
import type { BoundingBox, Coordinate, Feature, VertexRef } from '../../store/types.js';

/**
 * The margin of the extent over which the material of the graph is collected
 * (as a ratio of the bbox of the two endpoints)
 */
const TRACE_BBOX_MARGIN_RATIO = 0.2;

/**
 * An endpoint of a trace (the snap target of a single click)
 *
 * It has either vertex (snapped to a vertex) or segment (snapped to an edge). An endpoint that
 * has neither (a snap to a guide or to an intersection) cannot be traced.
 */
export interface TraceAnchorEndpoint {
  /** The coordinate decided by snapping (including a point in the middle of an edge) */
  coordinate: Coordinate;
  /** When snapped to a vertex, that vertex reference */
  vertex?: VertexRef;
  /** When snapped to an edge, the two ends of that edge */
  segment?: { start: Coordinate; end: Coordinate };
}

/**
 * The snap target that becomes the start point or the end point of a trace
 */
export interface TraceAnchor {
  /** The feature ID of the snap target */
  featureId: string;
  /** The dataset ID of the snap target (only for one from a dataset) */
  datasetId?: string;
  /** The geometric references and the coordinate of the snap target */
  endpoint: TraceAnchorEndpoint;
}

/**
 * What tracing reads: whether it is on, the snapping tolerance and the zoom, the geometry of a
 * snap target, and the features the graph is built from
 */
export interface TraceSource {
  /** Whether tracing is on */
  isEnabled(): boolean;
  /** The snapping tolerance, in pixels */
  tolerancePx(): number;
  /** The zoom of the map */
  zoom(): number;
  /** The geometry of the feature or the row a snap target names, or null */
  geometryOf(anchor: TraceAnchor): Geometry | null;
  /** The visible features of the document and the rows of the datasets within an extent */
  features(bbox: BoundingBox): Feature[];
}

/** A feature of the document or a row, in the shape the graph is built from */
function graphFeature(id: string, geometry: Geometry, type: string = geometry.type): Feature {
  return {
    id,
    type,
    geometry,
    layerId: '',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

/**
 * The trace source over the context of a mode: the options of the instance, the features of
 * the document by extent and the rows of the datasets to trace along
 */
export function traceSourceOf(ctx: ModeContext): TraceSource {
  const { draw, store } = ctx;
  const shown = (feature: PublicFeature): boolean => {
    if (!feature.visible) return false;
    if (!store.getLayer(feature.layerId)?.visible) return false;
    if (feature.groupId && store.getGroup(feature.groupId)?.visible === false) return false;
    return !isLocallyHidden(feature as Feature, store);
  };
  return {
    isEnabled: () => draw.options.get().tracing?.enabled !== false,
    tolerancePx: () => draw.options.get().snapping?.tolerancePx ?? DEFAULT_SNAP_OPTIONS.tolerancePx,
    zoom: () => ctx.screen.zoom,
    geometryOf(anchor) {
      if (anchor.datasetId === undefined) {
        return draw.features.get(anchor.featureId)?.geometry ?? null;
      }
      const dataset = draw.datasets.get(anchor.datasetId);
      const index = dataset?.findRow(anchor.featureId);
      if (!dataset || index === null || index === undefined) return null;
      return dataset.getRow(index)?.geometry ?? null;
    },
    features(bbox) {
      const extent: [number, number, number, number] = [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY];
      const features = draw.features
        .list({ bbox: extent })
        .filter(shown)
        .map((feature) => feature as Feature);
      for (const { row } of ctx.listTraceRows(extent)) {
        if (row.geometry) features.push(graphFeature(String(row.id), row.geometry));
      }
      return features;
    },
  };
}

/**
 * Reads the snap target of an input as an endpoint of a trace
 *
 * Returns null for snaps that cannot be used for tracing (a guide, an intersection, an
 * external candidate without a feature ID), when nothing was snapped, and when tracing is off.
 */
export function readTraceAnchor(source: TraceSource, event: DrawPointerEvent): TraceAnchor | null {
  if (!source.isEnabled()) return null;

  const target = event.snapped.target;
  if (!target || target.featureId === undefined) return null;

  const coordinate: Coordinate = [event.snapped.lngLat[0], event.snapped.lngLat[1]];
  const anchor = (endpoint: TraceAnchorEndpoint): TraceAnchor => ({
    featureId: target.featureId as string,
    ...(target.datasetId !== undefined && { datasetId: target.datasetId }),
    endpoint,
  });

  if (target.vertex) return anchor({ coordinate, vertex: target.vertex });
  if (target.kind === 'edge' && target.segment) {
    const { start, end } = target.segment;
    return anchor({
      coordinate,
      segment: { start: [start[0], start[1]], end: [end[0], end[1]] },
    });
  }
  return null;
}

/**
 * Turns the snap target into an endpoint of the graph (resolves a vertex reference into the
 * coordinate the feature holds)
 */
function toGraphEndpoint(source: TraceSource, anchor: TraceAnchor): TraceGraphEndpoint | null {
  const { coordinate, vertex, segment } = anchor.endpoint;
  const geometry = source.geometryOf(anchor);
  if (!geometry) return null;

  if (vertex) {
    const resolved = resolveVertexCoordinates(graphFeature(anchor.featureId, geometry), [
      vertex,
    ])[0];
    return { coordinate, node: resolved ?? coordinate };
  }
  if (!segment) return null;
  return { coordinate, segment };
}

/**
 * The extent over which the material of the graph is collected
 *
 * The bbox of the two endpoints is expanded by 20 percent of its size plus the snapping
 * tolerance.
 */
function traceBounds(source: TraceSource, from: Coordinate, to: Coordinate): BoundingBox {
  const minX = Math.min(from[0], to[0]);
  const maxX = Math.max(from[0], to[0]);
  const minY = Math.min(from[1], to[1]);
  const maxY = Math.max(from[1], to[1]);

  const tolerancePx = source.tolerancePx();
  const perPixel = degreesPerPixel((minY + maxY) / 2, source.zoom());
  const marginX = (maxX - minX) * TRACE_BBOX_MARGIN_RATIO + perPixel.lng * tolerancePx;
  const marginY = (maxY - minY) * TRACE_BBOX_MARGIN_RATIO + perPixel.lat * tolerancePx;

  return {
    minX: minX - marginX,
    minY: minY - marginY,
    maxX: maxX + marginX,
    maxY: maxY + marginY,
  };
}

/**
 * Derives the path between the previous confirmed click and the current snap target
 *
 * Returns the shortest path of the graph assembled from the nearby edges, as the sequence of
 * vertices to insert in between. Vertices whose coordinates match are folded into a single
 * node, so edges of different features also form a path as long as they are connected by a
 * shared vertex. Returns null when the two ends are not connected or when an endpoint cannot
 * be resolved (the caller then treats it as a straight line).
 */
export function computeTracePath(
  source: TraceSource,
  from: TraceAnchor | null,
  to: TraceAnchor | null,
): Coordinate[] | null {
  if (!from || !to) return null;

  const fromEndpoint = toGraphEndpoint(source, from);
  const toEndpoint = toGraphEndpoint(source, to);
  if (!fromEndpoint || !toEndpoint) return null;

  const bbox = traceBounds(source, fromEndpoint.coordinate, toEndpoint.coordinate);
  return findTracePath(buildTraceGraph(source.features(bbox), bbox), fromEndpoint, toEndpoint);
}
