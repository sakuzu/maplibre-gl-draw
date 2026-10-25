// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows being dragged, as what follows them reads them (11.3 of the design)
 *
 * Rows dragged in bulk are not written while they are dragged: they are drawn moved by the state
 * of their rows (a moving set: the edit that moves, rotates or scales them, then a translation).
 * What is drawn with a row by an extension (a label, the head of an arrow, the text of a note,
 * the direction of a point) reads here whether its row is dragged and where, to be drawn moved
 * the same way: a position is moved by the computation the rows are written with once let go
 * (the one of the library, in float64).
 */

import type { Position } from 'geojson';
import type { FeatureTables, RowHandle } from '../api/tables.js';
import { moveEnuPosition } from '../geometry/enu-transforms.js';
import { featureTablesInternals } from './feature-tables.js';
import { rowType } from './row-read.js';
import { MOVE_SETS, STATE_BY_VALUES, STATE_MOVE_MASK, STATE_MOVE_SHIFT } from './row-state.js';

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
  /**
   * The angle a row dragged that turns by its rotation (an image, a row that has a rotation) is
   * turned by, in degrees counterclockwise (0 otherwise): its rotation once written is the one it
   * has plus this angle, within [0, 360)
   */
  rotation(handle: RowHandle): number;
  /**
   * The factor of the scale of a row dragged that keeps its shape (an image, a row that has a
   * scale), and of the radius of a Circle (1 otherwise)
   */
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
  const byValues = (handle: RowHandle): boolean => (states.stateOf(handle) & STATE_BY_VALUES) !== 0;
  const keepsShape = (handle: RowHandle): boolean => {
    if (byValues(handle)) return true;
    const place = internals.placeOf(handle);
    return place ? rowType(place.group.data, place.row) === 'Circle' : false;
  };
  return {
    has: (handle) => setOf(handle) > 0,
    position(handle, position) {
      const set = setOf(handle);
      if (set === 0) return position;
      const edit = states.transform(set);
      // A Circle and a row turned or scaled by its values keep their shape
      const moved = edit ? moveEnuPosition(edit, position, keepsShape(handle)) : [...position];
      const [dx, dy] = states.translation(set);
      return [(moved[0] as number) + dx, (moved[1] as number) + dy, ...moved.slice(2)];
    },
    rotation(handle) {
      if (!byValues(handle)) return 0;
      const edit = states.transform(setOf(handle));
      return edit?.kind === 'rotate' ? edit.angleDegrees : 0;
    },
    scale(handle) {
      if (!keepsShape(handle)) return 1;
      const edit = states.transform(setOf(handle));
      return edit?.kind === 'scale' ? edit.sizeFactor : 1;
    },
  };
}
