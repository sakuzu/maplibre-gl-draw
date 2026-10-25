// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Move drag: moves the selected features from the point the drag started at to the pointer, by
 * the edit `translate` as the Store computes it
 */

import type { DragNormalizedEvent } from '../../../dispatcher/types.js';
import {
  type TransformStart,
  transformedUpdates,
  transformStartOf,
  transformsOf,
} from '../../../operations/transform-features.js';
import type { IntermediateWrites } from './intermediate-writes.js';
import type { DragOperation, DragStore } from './operation.js';
import { dragStartLngLat } from './operation.js';

/**
 * State of a move operation
 */
export interface MoveState {
  /** Coordinate at the start of the drag */
  startLngLat: { lng: number; lat: number };
  /** IDs of the features being dragged */
  featureIds: string[];
  /** The values of the features at the start */
  starts: Map<string, TransformStart>;
}

/** @internal */
export class MoveDrag implements DragOperation {
  readonly type = 'move' as const;

  constructor(private readonly state: MoveState) {}

  update(event: DragNormalizedEvent, store: DragStore, writes: IntermediateWrites): void {
    const { startLngLat } = this.state;
    const transforms = transformsOf(store);
    const edit = {
      kind: 'translate' as const,
      from: [startLngLat.lng, startLngLat.lat],
      to: [event.lngLat.lng, event.lngLat.lat],
    };

    for (const id of this.state.featureIds) {
      const feature = store.getFeature(id);
      const start = this.state.starts.get(id);
      if (feature && start) {
        const updates = transformedUpdates(transforms, edit, start, feature);
        if (updates) writes.write(store, id, updates);
      }
    }
  }
}

/**
 * Start a move drag of the given features
 */
export function startMoveDrag(
  event: DragNormalizedEvent,
  featureIds: string[],
  store: DragStore,
): MoveDrag {
  const starts = new Map<string, TransformStart>();

  for (const id of featureIds) {
    const feature = store.getFeature(id);
    if (feature) starts.set(id, transformStartOf(feature));
  }

  return new MoveDrag({
    startLngLat: dragStartLngLat(event),
    featureIds: [...featureIds],
    starts,
  });
}
