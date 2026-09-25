// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Trace support for the drawing modes
 *
 * A small set of helpers, used in common by draw_line / draw_polygon, for deriving a trace
 * path from a snapping result. A mode does not hold a SnapService and learns about snapping
 * only through `getSnapResult()` of ModeContext (a port that does no more than read the most
 * recent snapping result).
 *
 * InputRouter passes the coordinates of click / mousemove through snapping before delivering
 * them to the mode, so at the time of onClick / onMouseMove the most recent readable result is
 * the result corresponding to the event that was just delivered. However, there are also
 * events delivered without going through snapping, such as `snap: false` of a synthetic input,
 * so the result is taken only after confirming that its coordinates match the coordinates of
 * the event (if they do not match, it is regarded as a stale result and ignored).
 *
 * The path itself is the shortest path of a graph assembled from the nearby edges
 * (operations/trace-graph.ts). The feature ID and the dataset ID of the snap target are
 * used only to resolve the exact coordinates of the endpoints (a vertex reference or the
 * references to both ends of an edge); whether the two points belong to the same feature does
 * not matter.
 */

import type { MouseNormalizedEvent } from '../../dispatcher/types.js';
import { resolveVertexCoordinates } from '../../operations/shared-vertex.js';
import type { TraceGraphEndpoint } from '../../operations/trace-graph.js';
import { buildTraceGraph, findTracePath } from '../../operations/trace-graph.js';
import { degreesPerPixel } from '../../snapping/geometry.js';
import { isSnapVisible } from '../../snapping/providers/shared.js';
import { DEFAULT_SNAP_OPTIONS } from '../../snapping/types.js';
import type { BoundingBox, Coordinate, Feature, VertexRef } from '../../store/types.js';
import type { ModeContext } from '../handler.js';

/**
 * The margin of the extent over which the material of the graph is collected
 * (as a ratio of the bbox of the two endpoints)
 */
const TRACE_BBOX_MARGIN_RATIO = 0.2;

/**
 * The vertex references of both ends of an edge, for when the snap was to that edge
 */
export interface TraceAnchorSegment {
  /** The vertex reference of the start point of the edge */
  startRef: VertexRef;
  /** The vertex reference of the end point of the edge */
  endRef: VertexRef;
}

/**
 * An endpoint of a trace (the snap target of a single click)
 *
 * It has either vertex (snapped to a vertex) or segment (snapped to an edge). An endpoint that
 * has neither (a snap to a guide or to an intersection without references) cannot be traced.
 */
export interface TraceAnchorEndpoint {
  /** The coordinate decided by snapping (including a point in the middle of an edge) */
  coordinate: Coordinate;
  /** When snapped to a vertex, that vertex reference */
  vertex?: VertexRef;
  /** When snapped to an edge, the vertex references of both ends of that edge */
  segment?: TraceAnchorSegment;
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
 * Whether tracing is enabled (if there is no configuration, it is regarded as enabled)
 */
export function isTraceEnabled(context: ModeContext): boolean {
  return context.trace?.enabled !== false;
}

/**
 * Reads the snap target of the event that was just delivered as an endpoint of a trace
 *
 * Returns null for snaps that cannot be used for tracing (a guide, an intersection without
 * vertex references, an external candidate without a feature ID) and when nothing was snapped.
 */
export function readTraceAnchor(
  context: ModeContext,
  event: MouseNormalizedEvent,
): TraceAnchor | null {
  if (!isTraceEnabled(context)) return null;

  const result = context.getSnapResult?.();
  const target = result?.target;
  if (!result || !target || target.featureId === undefined) return null;

  // For an event delivered without going through snapping (such as snap: false of a synthetic
  // input), the most recent result belongs to a different coordinate, so it is not used
  if (result.lngLat.lng !== event.lngLat.lng || result.lngLat.lat !== event.lngLat.lat) {
    return null;
  }

  const coordinate: Coordinate = [result.lngLat.lng, result.lngLat.lat];

  if (target.vertex) {
    return {
      featureId: target.featureId,
      datasetId: target.datasetId,
      endpoint: { coordinate, vertex: target.vertex },
    };
  }

  const segment = target.segment;
  if (segment?.startRef && segment.endRef) {
    return {
      featureId: target.featureId,
      datasetId: target.datasetId,
      endpoint: {
        coordinate,
        segment: { startRef: segment.startRef, endRef: segment.endRef },
      },
    };
  }

  return null;
}

/**
 * Looks up the feature of the snap target
 *
 * Where it is resolved from depends on its origin. One from the Store is looked up with
 * store.getFeature, one from a dataset with getDatasetFeature.
 */
function anchorFeature(context: ModeContext, anchor: TraceAnchor): Feature | null {
  if (anchor.datasetId === undefined) {
    return context.store.getFeature(anchor.featureId) ?? null;
  }
  return context.getDatasetFeature?.(anchor.datasetId, anchor.featureId) ?? null;
}

/**
 * Turns the snap target into an endpoint of the graph (resolves the vertex references into
 * actual coordinates)
 */
function toGraphEndpoint(context: ModeContext, anchor: TraceAnchor): TraceGraphEndpoint | null {
  const { coordinate, vertex, segment } = anchor.endpoint;
  const feature = anchorFeature(context, anchor);

  if (vertex) {
    // For a snap to a vertex the snapped coordinate is the vertex itself, but if the feature
    // can be looked up, that one is taken as authoritative
    const resolved = feature ? resolveVertexCoordinates(feature, [vertex])[0] : undefined;
    return { coordinate, node: resolved ?? coordinate };
  }

  if (!segment || !feature) return null;

  const start = resolveVertexCoordinates(feature, [segment.startRef])[0];
  const end = resolveVertexCoordinates(feature, [segment.endRef])[0];
  if (!start || !end) return null;

  return { coordinate, segment: { start, end } };
}

/**
 * The extent over which the material of the graph is collected
 *
 * The bbox of the two endpoints is expanded by 20 percent of its size plus the snapping
 * tolerance.
 */
function traceBounds(context: ModeContext, from: Coordinate, to: Coordinate): BoundingBox {
  const minX = Math.min(from[0], to[0]);
  const maxX = Math.max(from[0], to[0]);
  const minY = Math.min(from[1], to[1]);
  const maxY = Math.max(from[1], to[1]);

  const tolerancePx = context.snapOptions?.tolerancePx ?? DEFAULT_SNAP_OPTIONS.tolerancePx;
  const perPixel = degreesPerPixel((minY + maxY) / 2, context.map.getZoom());
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
 * Collects the features that become the material of the graph
 *
 * The same scope as the targets of snapping, that is, the visible features of the Store and,
 * when snapping to data is enabled, the visible features of the datasets.
 */
function collectTraceFeatures(context: ModeContext, bbox: BoundingBox): Feature[] {
  const lng = (bbox.minX + bbox.maxX) / 2;
  const lat = (bbox.minY + bbox.maxY) / 2;
  // findNear looks up with a square extent, so the larger of the two radii is used
  const radius = Math.max(bbox.maxX - lng, bbox.maxY - lat);

  const features: Feature[] = [];
  const seen = new Set<string>();
  for (const id of context.spatialIndex.findNear([lng, lat], radius)) {
    if (seen.has(id)) continue;
    seen.add(id);

    const feature = context.store.getFeature(id);
    if (!feature) continue;
    if (!isSnapVisible(feature, context.store)) continue;

    features.push(feature);
  }

  const display = context.getDatasetTraceFeatures?.(bbox);
  if (display) features.push(...display);

  return features;
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
  context: ModeContext,
  from: TraceAnchor | null,
  to: TraceAnchor | null,
): Coordinate[] | null {
  if (!from || !to) return null;

  const fromEndpoint = toGraphEndpoint(context, from);
  const toEndpoint = toGraphEndpoint(context, to);
  if (!fromEndpoint || !toEndpoint) return null;

  const bbox = traceBounds(context, fromEndpoint.coordinate, toEndpoint.coordinate);
  const features = collectTraceFeatures(context, bbox);

  return findTracePath(buildTraceGraph(features, bbox), fromEndpoint, toEndpoint);
}
