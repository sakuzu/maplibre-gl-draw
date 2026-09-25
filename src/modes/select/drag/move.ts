// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Move drag: translates the selected features by the pointer offset
 */

import type { DragNormalizedEvent } from '../../../dispatcher/types.js';
import { mapCoordinatesDeep } from '../../../shared/utils/coordinates.js';
import type { FeatureCoordinates } from '../../../store/types.js';
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
  /** Feature coordinates at the start */
  initialCoordinates: Map<string, FeatureCoordinates>;
}

/**
 * Translate coordinates
 *
 * Because it uses a shared traversal that does not depend on nesting depth, Multi geometries
 * (MultiPolygon nests 4 levels deep) can be moved as-is.
 */
function translateCoordinates(
  coords: FeatureCoordinates,
  dx: number,
  dy: number,
): FeatureCoordinates {
  return mapCoordinatesDeep(coords, (coord) => [coord[0] + dx, coord[1] + dy]);
}

/** @internal */
export class MoveDrag implements DragOperation {
  readonly type = 'move' as const;

  constructor(private readonly state: MoveState) {}

  update(event: DragNormalizedEvent, store: DragStore, writes: IntermediateWrites): void {
    const dx = event.lngLat.lng - this.state.startLngLat.lng;
    const dy = event.lngLat.lat - this.state.startLngLat.lat;

    for (const id of this.state.featureIds) {
      const feature = store.getFeature(id);
      const initialCoords = this.state.initialCoordinates.get(id);
      if (feature && initialCoords) {
        const newCoords = translateCoordinates(initialCoords, dx, dy);
        writes.write(store, id, { coordinates: newCoords });
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
  const initialCoordinates = new Map<string, FeatureCoordinates>();

  for (const id of featureIds) {
    const feature = store.getFeature(id);
    if (feature) {
      initialCoordinates.set(id, JSON.parse(JSON.stringify(feature.coordinates)));
    }
  }

  return new MoveDrag({
    startLngLat: dragStartLngLat(event),
    featureIds: [...featureIds],
    initialCoordinates,
  });
}
