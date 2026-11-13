// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vertex drags: move vertices, and insert a vertex by dragging a midpoint. Both are shown by a
 * sketch of this client: the edits of its vertices name the vertices, and what is written once let
 * go is those vertices over the feature as it is then
 */

import type { SketchEdit } from '../../../api/sketches.js';
import type { DragNormalizedEvent } from '../../../dispatcher/types.js';
import { collectSharedVertexMoves } from '../../../operations/shared-vertex.js';
import type { VertexState } from '../../../operations/vertex.js';
import { startVertexMove } from '../../../operations/vertex.js';
import { getVertexPart, hasVertexRef } from '../../../shared/utils/vertex-ref.js';
import type {
  Coordinate,
  DragTargets,
  FeatureCoordinates,
  VertexRef,
} from '../../../store/types.js';
import type { EngineModeContext } from '../../handler.js';
import { dragStartLngLat, type SketchDrag, vertexDragTargets } from './operation.js';

/**
 * Whether the modifier key that temporarily disables shared-vertex following is held down
 *
 * The temporary-disable key is shared with snapping (`snapping.disableKey` of the options, 'alt' by default).
 * Holding it down when starting a drag escapes to a solitary move for that one drag only.
 *
 * The decision looks only at the normalized modifier keys of the drag start event (core does not
 * deal with raw DOM events). Pressing or releasing the key mid-drag does not change the set.
 * When disableKey is 'none', no modifier-key-based temporary disabling is performed.
 */
function isSharedVertexDragSuppressed(
  event: DragNormalizedEvent,
  context: EngineModeContext,
): boolean {
  const disableKey = context.snapOptions?.disableKey ?? 'alt';
  if (disableKey === 'none') return false;
  return event.modifiers?.[disableKey] === true;
}

/** Where a vertex of coordinates is */
function positionOf(kind: string, coordinates: FeatureCoordinates, ref: VertexRef): Coordinate {
  const part = getVertexPart(ref);
  switch (kind) {
    case 'Point':
      return coordinates as Coordinate;
    case 'LineString':
      return (coordinates as Coordinate[])[ref.index];
    case 'MultiPoint':
      return (coordinates as Coordinate[])[part];
    case 'Polygon':
      return (coordinates as Coordinate[][])[ref.ring][ref.index];
    case 'MultiLineString':
      return (coordinates as Coordinate[][])[part][ref.index];
    default:
      return (coordinates as Coordinate[][][])[part][ref.ring][ref.index];
  }
}

/** The vertices one edit of a drag moves, and where each of them was when the drag started */
interface MovedVertices {
  readonly featureId: string;
  readonly vertices: readonly VertexRef[];
  readonly from: readonly Coordinate[];
}

/** The vertices a state moves */
function movedVerticesOf(state: VertexState, kind: string): MovedVertices {
  return {
    featureId: state.featureId,
    vertices: state.vertices,
    from: state.vertices.map((ref) => positionOf(kind, state.initialCoordinates, ref)),
  };
}

/**
 * A move of vertices: the vertices of the feature grabbed, and the ones of the features that
 * follow along through a shared vertex, by the edits `vertexMove` of the sketch of the drag. Each
 * edit names the vertices it moves and where they go, so a vertex another writer moves meanwhile
 * stays where it put it
 *
 * @internal
 */
export class VertexDrag implements SketchDrag {
  readonly type = 'vertex' as const;
  readonly start: readonly SketchEdit[];
  readonly selected: readonly string[];
  readonly #moved: readonly MovedVertices[];

  constructor(
    private readonly startLngLat: { lng: number; lat: number },
    moved: readonly MovedVertices[],
  ) {
    this.#moved = moved;
    this.selected = [moved[0].featureId];
    this.start = this.#editsBy(0, 0);
  }

  editsAt(event: DragNormalizedEvent): readonly SketchEdit[] {
    const { lngLat } = event;
    return this.#editsBy(lngLat.lng - this.startLngLat.lng, lngLat.lat - this.startLngLat.lat);
  }

  movesNothing(edits: readonly SketchEdit[]): boolean {
    return edits.every((edit, i) => {
      if (edit.kind !== 'vertexMove') return false;
      const from = (this.start[i] as typeof edit | undefined)?.positions;
      return edit.positions.every(
        (position, k) => position[0] === from?.[k]?.[0] && position[1] === from?.[k]?.[1],
      );
    });
  }

  /** The edits that move the vertices by a distance in degrees */
  #editsBy(dx: number, dy: number): readonly SketchEdit[] {
    return this.#moved.map(({ featureId, vertices, from }) => ({
      kind: 'vertexMove',
      featureId,
      vertices,
      positions: from.map((position): Coordinate => [position[0] + dx, position[1] + dy]),
    }));
  }
}

/**
 * A drag of a midpoint: a vertex inserted after the one of the hit, which follows the pointer, by
 * the edit `vertexInsert` of the sketch of the drag
 *
 * @internal
 */
export class MidpointDrag implements SketchDrag {
  readonly type = 'midpoint' as const;
  readonly start: readonly SketchEdit[];
  readonly selected: readonly string[];

  constructor(
    private readonly featureId: string,
    private readonly after: VertexRef,
    from: { lng: number; lat: number },
  ) {
    this.selected = [featureId];
    this.start = this.#editsAt(from);
  }

  editsAt(event: DragNormalizedEvent): readonly SketchEdit[] {
    return this.#editsAt(event.lngLat);
  }

  /** A vertex is added wherever it is let go */
  movesNothing(): boolean {
    return false;
  }

  #editsAt(lngLat: { lng: number; lat: number }): readonly SketchEdit[] {
    const position: Coordinate = [lngLat.lng, lngLat.lat];
    return [{ kind: 'vertexInsert', featureId: this.featureId, after: this.after, position }];
  }
}

/**
 * What a vertex drag would move: the vertices of the feature grabbed, and the vertices of the
 * features that follow along through a shared vertex
 *
 * @internal
 */
export interface VertexDragPlan {
  /** The vertex grabbed */
  readonly vertexRef: VertexRef;
  /** The move of the vertices of the feature grabbed */
  readonly state: VertexState;
  /** The moves of the vertices of the features that follow along */
  readonly followers: VertexState[];
}

/**
 * Plans a vertex drag: the selected vertices when the one grabbed is one of them (the one grabbed
 * alone otherwise), and the vertices that follow along through a shared vertex. Returns null when
 * the feature or the vertex is gone
 *
 * @internal
 */
export function planVertexDrag(
  event: DragNormalizedEvent,
  featureId: string,
  vertexRef: VertexRef,
  context: EngineModeContext,
): VertexDragPlan | null {
  const { store, spatialIndex } = context;
  const feature = store.getFeature(featureId);
  if (!feature) return null;

  const startLngLat = dragStartLngLat(event);

  // Check the currently selected vertices
  const selectedVertices = store.getVertexSelection();
  let vertexRefsToMove: readonly VertexRef[];

  if (
    selectedVertices &&
    selectedVertices.featureId === featureId &&
    hasVertexRef(selectedVertices.vertices, vertexRef)
  ) {
    // If the vertex being dragged is one of the selected vertices, move every selected vertex
    // (a multiple selection spanning rings and parts can be moved as-is too)
    vertexRefsToMove = selectedVertices.vertices;
  } else {
    // Otherwise move only the vertex being dragged
    vertexRefsToMove = [vertexRef];
  }

  // Simultaneous movement of shared vertices (options.topology.sharedVertexDrag).
  // The following set is determined at the start and is not re-searched afterwards.
  // If the temporary-disable modifier key (the same key as for snapping) is held down, no set
  // is built.
  let followers: VertexState[] = [];
  if (context.topology?.sharedVertexDrag && !isSharedVertexDragSuppressed(event, context)) {
    const shared = collectSharedVertexMoves({
      store,
      spatialIndex,
      feature,
      vertexRefs: vertexRefsToMove,
      startLngLat,
    });
    vertexRefsToMove = shared.mainRefs;
    followers = shared.followers;
  }

  const state = startVertexMove(feature, vertexRefsToMove, startLngLat);
  if (!state) return null;
  return { vertexRef, state, followers };
}

/**
 * Makes the drag of a plan
 *
 * @internal
 */
export function vertexDragOf(plan: VertexDragPlan, context: EngineModeContext): VertexDrag {
  const { store } = context;
  const { state, followers } = plan;
  const moved = [state, ...followers].flatMap((vertexState) => {
    const feature = store.getFeature(vertexState.featureId);
    return feature ? [movedVerticesOf(vertexState, feature.type)] : [];
  });
  return new VertexDrag(state.startLngLat, moved);
}

/**
 * Sets the DragState and the followed vertices a planned vertex drag draws from, once it started
 *
 * @param targets The vertex the drag started from, as its drag state records it (snapping leaves
 *   it out)
 */
export function markVertexDrag(
  plan: VertexDragPlan,
  context: EngineModeContext,
  targets: DragTargets,
): void {
  const { store } = context;

  // Write the following vertices into the UI state so they are drawn in a style distinct from
  // the selected vertices. They are set back to null when the drag ends (endDrag / reset).
  store.setFollowedVertices?.(
    plan.followers.map((followerState) => ({
      featureId: followerState.featureId,
      vertices: followerState.vertices,
    })),
  );

  // Set the DragState (activeVertex is the vertex the drag started from)
  store.setDragState({ operation: 'vertex', ...targets });
}

/**
 * Makes the drag of a midpoint: a vertex is inserted at the midpoint and follows the pointer
 *
 * @internal
 */
export function midpointDragOf(
  event: DragNormalizedEvent,
  featureId: string,
  after: VertexRef,
): MidpointDrag {
  return new MidpointDrag(featureId, after, dragStartLngLat(event));
}

/**
 * Sets the DragState a drag of a midpoint draws from, once it started: the vertex added, with the
 * two edges it splits the edge into, in the feature as the sketch shows it
 */
export function markMidpointDrag(
  context: EngineModeContext,
  featureId: string,
  after: VertexRef,
): void {
  const feature = context.sketches.appliedFeature(featureId);
  if (!feature) return;
  // The added vertex is afterIndex + 1 in the same part and same ring
  const added: VertexRef = { ...after, index: after.index + 1 };
  context.store.setDragState({ operation: 'midpoint', ...vertexDragTargets(feature, added) });
}
