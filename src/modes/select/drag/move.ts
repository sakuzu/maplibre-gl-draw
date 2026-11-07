// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Move drag: moves the selected features from the point the drag started at to the pointer, by
 * the edit `translate` of the sketch of the drag
 */

import type { SketchEdit } from '../../../api/sketches.js';
import type { DragNormalizedEvent } from '../../../dispatcher/types.js';
import type { TransformEdit } from '../../../store/store.js';
import type { DragTarget, SketchDrag } from './operation.js';
import {
  dragStartLngLat,
  selectedOfTarget,
  transformEdits,
  transformMovesNothing,
} from './operation.js';

/** @internal */
export class MoveDrag implements SketchDrag {
  readonly type = 'move' as const;
  readonly start: readonly SketchEdit[];
  readonly selected: readonly string[];

  constructor(
    private readonly from: { lng: number; lat: number },
    private readonly target: DragTarget,
  ) {
    this.start = transformEdits(this.#edit(from), target);
    this.selected = selectedOfTarget(target);
  }

  editsAt(event: DragNormalizedEvent): readonly SketchEdit[] {
    return transformEdits(this.#edit(event.lngLat), this.target);
  }

  movesNothing(edits: readonly SketchEdit[]): boolean {
    return transformMovesNothing(edits[0] as TransformEdit);
  }

  /** The move from the point the drag started at to a point */
  #edit(to: { lng: number; lat: number }): TransformEdit {
    return { kind: 'translate', from: [this.from.lng, this.from.lat], to: [to.lng, to.lat] };
  }
}

/**
 * Start a move drag
 */
export function startMoveDrag(event: DragNormalizedEvent, target: DragTarget): MoveDrag {
  return new MoveDrag(dragStartLngLat(event), target);
}
