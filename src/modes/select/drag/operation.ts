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
import type { DragOperationType, Feature } from '../../../store/types.js';
import { getSelectedFeatureIds } from '../../../view/ui/helper.js';
import type { EngineModeContext } from '../../handler.js';
import type { IntermediateWrites } from './intermediate-writes.js';

/** The Store a drag writes to */
export type DragStore = EngineModeContext['store'];

/**
 * The selection scope of the draw instance the drag belongs to (the resize and rotate
 * strategies of custom types, and the auxiliary handle providers). Null before a drag starts
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
