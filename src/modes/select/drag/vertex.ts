// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vertex drags: move vertices, and insert a vertex by dragging a midpoint
 */

import type { DragNormalizedEvent } from '../../../dispatcher/types.js';
import { collectSharedVertexMoves } from '../../../operations/shared-vertex.js';
import type { VertexState } from '../../../operations/vertex.js';
import { addVertex, computeVertexMove, startVertexMove } from '../../../operations/vertex.js';
import { geometryFromCoordinates } from '../../../shared/utils/coordinates.js';
import { hasVertexRef } from '../../../shared/utils/vertex-ref.js';
import type { Coordinate, VertexRef } from '../../../store/types.js';
import type { EngineModeContext } from '../../handler.js';
import type { IntermediateWrites } from './intermediate-writes.js';
import type { DragOperation, DragStore } from './operation.js';
import { dragStartLngLat } from './operation.js';

/**
 * Whether the modifier key that temporarily disables shared-vertex following is held down
 *
 * The temporary-disable key is shared with snapping (options.snap.disableKey, 'alt' by default).
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

/**
 * Reflect a vertex move state into the Store (an intermediate update during the drag; the
 * spatial index follows the Store)
 */
function applyVertexMove(
  state: VertexState,
  lngLat: { lng: number; lat: number },
  store: DragStore,
  writes: IntermediateWrites,
): void {
  const feature = store.getFeature(state.featureId);
  if (!feature) return;

  const newCoords = computeVertexMove(state, lngLat, feature);
  writes.write(store, state.featureId, {
    geometry: geometryFromCoordinates(feature.type, newCoords),
  });
}

/**
 * A vertex move. A midpoint drag continues as a vertex move of the vertex it added, and is
 * handled the same way
 *
 * @internal
 */
export class VertexDrag implements DragOperation {
  constructor(
    readonly type: 'vertex' | 'midpoint',
    private readonly state: VertexState,
    /**
     * Vertex move states of the other features that follow along during a shared-vertex move
     *
     * Determined at the start of a vertex drag, only when options.topology.sharedVertexDrag is
     * enabled. It is not re-searched during the drag (to avoid interfering with other features
     * such as snapping).
     */
    private readonly followers: VertexState[] = [],
  ) {}

  update(event: DragNormalizedEvent, store: DragStore, writes: IntermediateWrites): void {
    const feature = store.getFeature(this.state.featureId);
    if (!feature) return;

    const newCoords = computeVertexMove(this.state, event.lngLat, feature);
    writes.write(store, this.state.featureId, {
      geometry: geometryFromCoordinates(feature.type, newCoords),
    });

    // Preview update for the features following along through a shared vertex. They are written
    // one at a time in the same manner as the main one (an intermediate updateFeature).
    // The commit is the single transaction at the end of the drag.
    for (const state of this.followers) {
      applyVertexMove(state, event.lngLat, store, writes);
    }
  }
}

/**
 * Start a vertex drag, and set the DragState and the followed vertices it draws from. Returns
 * null when the feature or the vertex is gone
 */
export function startVertexDrag(
  event: DragNormalizedEvent,
  featureId: string,
  vertexRef: VertexRef,
  context: EngineModeContext,
): VertexDrag | null {
  const { store, spatialIndex } = context;
  const feature = store.getFeature(featureId);
  if (!feature) return null;

  const startLngLat = dragStartLngLat(event);

  // Check the currently selected vertices
  const selectedVertices = store.getVertexSelection();
  let vertexRefsToMove: VertexRef[];

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
  let sharedVertexStates: VertexState[] = [];
  if (context.topology?.sharedVertexDrag && !isSharedVertexDragSuppressed(event, context)) {
    const shared = collectSharedVertexMoves({
      store,
      spatialIndex,
      feature,
      vertexRefs: vertexRefsToMove,
      startLngLat,
    });
    vertexRefsToMove = shared.mainRefs;
    sharedVertexStates = shared.followers;
  }

  const state = startVertexMove(feature, vertexRefsToMove, startLngLat);
  if (!state) return null;

  // Write the following vertices into the UI state so they are drawn in a style distinct from
  // the selected vertices. They are set back to null when the drag ends (endDrag / reset).
  store.setFollowedVertices?.(
    sharedVertexStates.map((followerState) => ({
      featureId: followerState.featureId,
      vertices: followerState.vertices,
    })),
  );

  // Set the DragState (activeVertex is the vertex the drag started from)
  store.setDragState({
    operation: 'vertex',
    activeVertex: vertexRef,
    activeFeatureId: featureId,
  });

  return new VertexDrag('vertex', state, sharedVertexStates);
}

/**
 * Start a midpoint drag: insert a vertex at the midpoint and continue as a move of that
 * vertex. Returns null when the feature is gone
 */
export function startMidpointDrag(
  event: DragNormalizedEvent,
  featureId: string,
  after: VertexRef,
  store: DragStore,
): VertexDrag | null {
  const feature = store.getFeature(featureId);
  if (!feature) return null;

  const startLngLat = dragStartLngLat(event);

  // Add the position of the midpoint as a new vertex
  const newCoord: Coordinate = [startLngLat.lng, startLngLat.lat];
  const newCoords = addVertex(feature, after, newCoord);

  store.updateFeature(featureId, { geometry: geometryFromCoordinates(feature.type, newCoords) });

  // The added vertex is afterIndex + 1 in the same part and same ring
  const newVertexRef: VertexRef = { ...after, index: after.index + 1 };

  // Continue as a move operation on the added vertex
  const updatedFeature = store.getFeature(featureId);
  if (!updatedFeature) return null;

  const state = startVertexMove(updatedFeature, [newVertexRef], startLngLat);
  if (!state) return null;

  return new VertexDrag('midpoint', state);
}
