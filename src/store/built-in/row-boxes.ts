// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The boxes of the rows of the types whose box comes from more than their positions (an Image, a
 * Circle, a type that works out its own extent), as the instance gives them to the built-in Store
 *
 * The tables of a built-in Store are made with boxes given (`rowBoxes` of `@sakuzu/kasane`) that
 * ask what is set here: while nothing is set, no type gives its box, and every row has the box
 * of its positions (a Store no instance uses). The instance sets how the boxes are worked out
 * (`setRowBoxes`, an internal hook, not on any entry of the package) through the tables of its
 * Store, as it waits for the changes to be told (`onChangeTold`): a Store of the application
 * that spreads a built-in Store hands out the same tables, and so the same boxes.
 *
 * Each time the boxes are set, and when they are taken back, the tables make the boxes of the
 * rows again at the next read of a range, and the rows drawn are told to have changed
 * (`LayerTableView.getDrawnRowsRevision`).
 *
 * @internal
 */

import type { RowBoxes } from '@sakuzu/kasane';
import { DrawError } from '../../shared/errors.js';
import type { RowRef } from './types.js';

/**
 * How the boxes of the rows of some types are worked out, by the references of the rows
 *
 * @internal
 */
export interface GivenRowBoxes {
  /** Whether the rows of a type have the box `boxOf` gives (the others, that of their positions) */
  gives(type: string): boolean;
  /**
   * The box of a row of a type that gives it, written to `out` as `[minX, minY, maxX, maxY]`:
   * false for a row without one (it meets no range)
   */
  boxOf(row: RowRef, out: Float64Array): boolean;
}

/**
 * The boxes set for the tables of one document, and what makes the boxes of the rows again
 *
 * @internal
 */
export interface RowBoxesSlot {
  /** The boxes set, or null while nothing is set */
  given: GivenRowBoxes | null;
  /** Changes each time the boxes are set or taken back (what was read of them is read again) */
  epoch: number;
  /** Makes the boxes of the rows again at the next read of a range (once the tables are made) */
  refresh: (() => void) | null;
}

/**
 * An empty slot: no box set
 *
 * @internal
 */
export function createRowBoxesSlot(): RowBoxesSlot {
  return { given: null, epoch: 0, refresh: null };
}

/**
 * The boxes the tables are made with: what the slot holds when they read them
 *
 * @internal
 */
export function rowBoxesOfSlot(slot: RowBoxesSlot): RowBoxes {
  return {
    gives: (type) => slot.given?.gives(type) === true,
    boxOf: (row, out) => slot.given?.boxOf(row.row, out) === true,
  };
}

/** The field of the tables of a built-in Store that holds its slot of the boxes */
const ROW_BOXES = Symbol('row boxes');

/**
 * Gives the tables of a built-in Store its slot of the boxes, once, when it is made
 *
 * The field is not enumerable, so the tables read, copy and serialize as before.
 *
 * @internal
 */
export function holdRowBoxes(tables: object, slot: RowBoxesSlot): void {
  Object.defineProperty(tables, ROW_BOXES, { value: slot });
}

/**
 * Sets how the built-in Store whose tables these are works out the boxes of the rows of the types
 * that give theirs, and makes the boxes of its rows again (with the same boxes, it makes them
 * again). The rows of the other types keep the box of their positions.
 *
 * @returns The function that takes these boxes back (nothing happens once others are set): every
 *   row has the box of its positions again
 * @throws DrawError `invalidInput` for tables that are not those of a built-in Store, or boxes
 *   without their two functions
 * @internal
 */
export function setRowBoxes(tables: unknown, boxes: GivenRowBoxes): () => void {
  const slot =
    typeof tables === 'object' && tables !== null
      ? (tables as { [ROW_BOXES]?: RowBoxesSlot })[ROW_BOXES]
      : undefined;
  if (!slot) {
    throw new DrawError('invalidInput', 'the tables are not those of a Store made by createStore');
  }
  if (
    typeof boxes !== 'object' ||
    boxes === null ||
    typeof boxes.gives !== 'function' ||
    typeof boxes.boxOf !== 'function'
  ) {
    throw new DrawError('invalidInput', 'setRowBoxes: the boxes have no gives and boxOf');
  }
  slot.given = boxes;
  slot.epoch++;
  slot.refresh?.();
  return () => {
    if (slot.given !== boxes) return;
    slot.given = null;
    slot.epoch++;
    slot.refresh?.();
  };
}
