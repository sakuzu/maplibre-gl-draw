// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows being dragged, as what follows them reads them (11.3 of the design)
 *
 * Rows dragged in bulk are not written while they are dragged: they are drawn moved by the state
 * of their rows (a moving set: a translation, after a rotation or a resize). What is drawn with a
 * row by an extension (a label, the head of an arrow, the text of a note, the direction of a
 * point) reads here whether its row is dragged and where, to be drawn moved the same way.
 */

import type { Position } from 'geojson';
import type { FeatureTables, RowHandle } from '../api/tables.js';
import { transformPosition } from '../shared/math/plane-transform.js';
import { drawPropertyKey } from '../shared/properties.js';
import { featureTablesInternals } from './feature-tables.js';
import { rowType, rowValue } from './row-read.js';
import { MOVE_SETS, STATE_MOVE_MASK, STATE_MOVE_SHIFT } from './row-state.js';

/** The key of the scale of a row (a row that has one keeps its shape when it is resized) */
const SCALE_KEY = drawPropertyKey('scale');

/**
 * The rows being dragged and how they are moved, while they are drawn moved and not written yet
 *
 * @experimental
 */
export interface DraggedRows {
  /** Whether the row of a handle is being dragged */
  has(handle: RowHandle): boolean;
  /**
   * A position of a row, where the row is drawn now: moved as it is while it is dragged (the
   * values after `x` and `y` kept), as it is otherwise
   */
  position(handle: RowHandle, position: Position): Position;
  /** The angle added to the rotation of a row dragged that has one, in degrees (0 otherwise) */
  rotation(handle: RowHandle): number;
  /** The factor of the scale and the radius of a row dragged that has one (1 otherwise) */
  scale(handle: RowHandle): number;
}

/**
 * The rows being dragged of tables (null when no row is: nothing is drawn moved)
 *
 * @param tables - The tables of a Store that holds its features as rows (`StoreView.tables`)
 * @returns What reads them, or null
 * @experimental
 */
export function draggedRowsOf(tables: FeatureTables | undefined): DraggedRows | null {
  const internals = featureTablesInternals(tables);
  if (!internals) return null;
  const states = internals.states;
  let moving = false;
  for (let set = 1; set <= MOVE_SETS; set++) {
    const [dx, dy] = states.translation(set);
    if (dx !== 0 || dy !== 0 || states.transform(set)) moving = true;
  }
  if (!moving) return null;
  const setOf = (handle: RowHandle): number =>
    (states.stateOf(handle) & STATE_MOVE_MASK) >> STATE_MOVE_SHIFT;
  return {
    has: (handle) => setOf(handle) > 0,
    position(handle, position) {
      const set = setOf(handle);
      if (set === 0) return position;
      const transform = states.transform(set);
      let moved: number[] = [...position];
      if (transform) {
        // A Circle and a row with a scale keep their shape, as the rows drawn at once are drawn
        const place = internals.placeOf(handle);
        const keepsShape = place
          ? rowType(place.group.data, place.row) === 'Circle' ||
            rowValue(place.group, place.row, SCALE_KEY) !== undefined
          : false;
        moved = transformPosition(transform, moved, keepsShape);
      }
      const [dx, dy] = states.translation(set);
      return [moved[0] + dx, moved[1] + dy, ...moved.slice(2)];
    },
    rotation: (handle) => states.transform(setOf(handle))?.rotationDeg ?? 0,
    scale: (handle) => states.transform(setOf(handle))?.scale ?? 1,
  };
}
