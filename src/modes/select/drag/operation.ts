// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shape shared by the drag operations of select mode
 *
 * Each kind of drag is one operation, which SelectModeDragHandler decides, starts, and forwards
 * every frame to. A move, a rotation and a resize are shown by a sketch of this client (a
 * `SketchDrag`): the operation gives the edit of the pointer, the Store is not written while the
 * drag goes on, and the handler writes the sketch once let go. The other drags (vertex, midpoint,
 * radius, auxiliary handle) are a `DragOperation`: it computes the new values and writes them
 * through IntermediateWrites, which keeps what a commit or an abort needs.
 */

import type { DragNormalizedEvent } from '../../../dispatcher/types.js';
import { edgesOfVertex } from '../../../shared/utils/feature-segments.js';
import type { TransformEdit } from '../../../store/store.js';
import type { DragOperationType, DragTargets, Feature, VertexRef } from '../../../store/types.js';
import type { HandleHitResult } from '../../../view/ui/handle-test.js';
import type { EngineModeContext } from '../../handler.js';
import type { IntermediateWrites } from './intermediate-writes.js';

/** The Store a drag writes to */
export type DragStore = EngineModeContext['store'];

/**
 * The selection scope of the draw instance the drag belongs to (the bounding boxes of custom
 * types, the tile size of the map, and the auxiliary handle providers). Null before a drag starts
 */
export type DragScope = EngineModeContext['selectionScope'] | null;

/**
 * One running drag operation
 *
 * @internal
 */
export interface DragOperation {
  /** The kind of the operation (the value of DragState.operation) */
  readonly type: NonNullable<DragOperationType>;
  /** Apply one frame of the drag */
  update(event: DragNormalizedEvent, store: DragStore, writes: IntermediateWrites): void;
  /**
   * Called when the drag ends or is aborted (possibly more than once). Only operations that
   * hand the drag to someone else need it
   */
  finish?(event?: DragNormalizedEvent): void;
}

/**
 * One running drag shown by a sketch of this client, of the features selected or of the ones
 * selected in bulk alike
 *
 * @internal
 */
export interface SketchDrag {
  /** The kind of the operation (the value of DragState.operation) */
  readonly type: 'move' | 'rotate' | 'resize';
  /** The edit of a pointer that has not moved */
  readonly start: TransformEdit;
  /** The edit of the pointer of one frame of the drag */
  editAt(event: DragNormalizedEvent): TransformEdit;
  /** Called with each edit the sketch shows */
  shown?(edit: TransformEdit, store: DragStore): void;
}

/**
 * Whether the edit of a drag shown by a sketch moves nothing (the pointer is where it started):
 * such a drag writes nothing once let go
 *
 * @internal
 */
export function movesNothing(edit: TransformEdit): boolean {
  switch (edit.kind) {
    case 'translate':
      return edit.from[0] === edit.to[0] && edit.from[1] === edit.to[1];
    case 'rotate':
      return edit.angleDegrees === 0;
    default:
      return edit.eastFactor === 1 && edit.northFactor === 1 && edit.sizeFactor === 1;
  }
}

/**
 * The drag start position (the exact position before the 3-pixel movement)
 */
export function dragStartLngLat(event: DragNormalizedEvent): { lng: number; lat: number } {
  return event.dragStartLngLat ?? event.lngLat;
}

/**
 * What a drag grabbed by a handle hit on the selected features (or by a press on one of them,
 * a move) changes when it starts, as its drag state records it: the selected features moved,
 * resized or rotated, the vertex dragged with the edges it starts and ends, the edge a midpoint
 * is on, the circle whose radius is dragged, and the feature a handle of an extension is on (core
 * does not know what the handle changes, so the feature is taken as changed whole; a handle on no
 * feature changes nothing core knows of)
 *
 * The drag state and the snap of the start of the drag (before the drag state is set) both read
 * it, so that snapping leaves out the same from the start of the drag to its end. A midpoint is the
 * one drag that changes the feature as it starts: it adds a vertex in the edge it is on, and its
 * drag state then records the vertex and the two edges it splits the edge into
 * (`vertexDragTargets`), which leave out the same as the edge did.
 *
 * @param selectedIds The selected features, with group / layer selections resolved
 * @param store Where the feature of a vertex is read, for its edges
 */
export function dragTargetsOfHit(
  hit: HandleHitResult,
  selectedIds: readonly string[],
  store: Pick<DragStore, 'getFeature'>,
): DragTargets {
  switch (hit.type) {
    case 'move':
    case 'resize':
    case 'rotate':
      return { movingFeatureIds: [...selectedIds] };
    case 'vertex': {
      const feature = hit.featureId !== undefined ? store.getFeature(hit.featureId) : undefined;
      return feature && hit.vertexRef ? vertexDragTargets(feature, hit.vertexRef) : {};
    }
    case 'midpoint':
      return {
        activeFeatureId: hit.featureId,
        ...(hit.vertexRef && { activeEdges: [hit.vertexRef] }),
      };
    case 'radius':
      return { movingFeatureIds: hit.featureId !== undefined ? [hit.featureId] : [] };
    case 'auxiliary':
      return hit.featureId !== undefined ? { movingFeatureIds: [hit.featureId] } : {};
  }
}

/**
 * What a drag of a vertex of a feature changes: the vertex, and the edges it starts and ends
 */
export function vertexDragTargets(feature: Feature, vertex: VertexRef): DragTargets {
  return {
    activeFeatureId: feature.id,
    activeVertex: vertex,
    activeEdges: edgesOfVertex(feature, vertex),
  };
}

/**
 * What a drag of the features selected in bulk changes, as its drag state records it: their rows
 * (their IDs are not listed). Read as {@link dragTargetsOfHit} is
 */
export function bulkDragTargets(rows: { has(handle: number): boolean }): DragTargets {
  return { movingFeatureIds: [], movingRows: rows };
}
