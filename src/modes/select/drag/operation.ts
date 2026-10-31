// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shape shared by the drag operations of select mode
 *
 * Each kind of drag (move, resize, rotate, vertex, midpoint, radius, auxiliary handle) is one
 * DragOperation. SelectModeDragHandler decides which kind a drag is, starts it, and forwards
 * every frame to it. The operation computes the new values and writes them through
 * IntermediateWrites, which keeps what a commit or an abort needs.
 */

import type { DragNormalizedEvent } from '../../../dispatcher/types.js';
import type { DragOperationType, DragTargets, Feature } from '../../../store/types.js';
import type { HandleHitResult } from '../../../view/ui/handle-test.js';
import { getSelectedFeatureIds } from '../../../view/ui/helper.js';
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
  /**
   * Called once when the drag ends: committed (let go) or not (cancelled, aborted). Only the
   * operations that write once at the end need it (the drags of features selected in bulk).
   * `done` is called once what the end writes is written, possibly in a later task (the drag's
   * end is announced then)
   */
  end?(store: DragStore, committed: boolean, done?: () => void): void;
}

/**
 * The drag start position (the exact position before the 3-pixel movement)
 */
export function dragStartLngLat(event: DragNormalizedEvent): { lng: number; lat: number } {
  return event.dragStartLngLat ?? event.lngLat;
}

/**
 * The selected features, with group / layer selections resolved to their member features
 * (so that a group is moved / resized / rotated as one)
 */
export function selectedFeaturesOf(store: DragStore): Feature[] {
  return getSelectedFeatureIds(store)
    .map((id) => store.getFeature(id))
    .filter((f): f is Feature => f !== undefined);
}

/**
 * What a drag grabbed by a handle hit on the selected features (or by a press on one of them,
 * a move) changes, as its drag state records it: the selected features moved, resized or
 * rotated, the vertex dragged (for a midpoint, the vertex it adds after the one of the hit), the
 * circle whose radius is dragged, and the feature a handle of an extension is on (core does not
 * know what the handle changes, so the feature is taken as changed whole; a handle on no feature
 * changes nothing core knows of)
 *
 * The drag state and the snap of the start of the drag (before the drag state is set) both read
 * it, so that snapping leaves out the same from the start of the drag to its end. A midpoint adds
 * its vertex only once the drag starts: at its start the index names the vertex after the edge the
 * midpoint is on, which is left out with its edges, that edge among them.
 *
 * @param selectedIds The selected features, with group / layer selections resolved
 */
export function dragTargetsOfHit(
  hit: HandleHitResult,
  selectedIds: readonly string[],
): DragTargets {
  switch (hit.type) {
    case 'move':
    case 'resize':
    case 'rotate':
      return { movingFeatureIds: [...selectedIds] };
    case 'vertex':
      return { activeFeatureId: hit.featureId, activeVertex: hit.vertexRef };
    case 'midpoint':
      return {
        activeFeatureId: hit.featureId,
        activeVertex: hit.vertexRef && { ...hit.vertexRef, index: hit.vertexRef.index + 1 },
      };
    case 'radius':
      return { movingFeatureIds: hit.featureId !== undefined ? [hit.featureId] : [] };
    case 'auxiliary':
      return hit.featureId !== undefined ? { movingFeatureIds: [hit.featureId] } : {};
  }
}

/**
 * What a drag of the features selected in bulk changes, as its drag state records it: their rows
 * (their IDs are not listed). Read as {@link dragTargetsOfHit} is
 */
export function bulkDragTargets(rows: { has(handle: number): boolean }): DragTargets {
  return { movingFeatureIds: [], movingRows: rows };
}
