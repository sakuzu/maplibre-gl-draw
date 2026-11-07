// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Move drag: moves the selected features from the point the drag started at to the pointer, by
 * the edit `translate` of the sketch of the drag
 */

import type { DragNormalizedEvent } from '../../../dispatcher/types.js';
import type { TransformEdit } from '../../../store/store.js';
import type { SketchDrag } from './operation.js';
import { dragStartLngLat } from './operation.js';

/** @internal */
export class MoveDrag implements SketchDrag {
  readonly type = 'move' as const;
  readonly start: TransformEdit;

  constructor(private readonly from: { lng: number; lat: number }) {
    this.start = this.#edit(from);
  }

  editAt(event: DragNormalizedEvent): TransformEdit {
    return this.#edit(event.lngLat);
  }

  /** The move from the point the drag started at to a point */
  #edit(to: { lng: number; lat: number }): TransformEdit {
    return { kind: 'translate', from: [this.from.lng, this.from.lat], to: [to.lng, to.lat] };
  }
}

/**
 * Start a move drag
 */
export function startMoveDrag(event: DragNormalizedEvent): MoveDrag {
  return new MoveDrag(dragStartLngLat(event));
}
