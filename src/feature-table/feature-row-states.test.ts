// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The state of the rows of the library written to the tables: the rows marked as selected in bulk
 * are listed as they are marked and unmarked, and a handle forgotten leaves the list; a moving set
 * moves its rows while one is in it, and is let go of once the last leaves it
 */

import { describe, expect, it } from 'vitest';
import {
  FEATURE_ROW_STATE_BITS,
  RowStateSets,
  STATE_BULK,
  STATE_MOVE_MASK,
} from './feature-row-states.js';
import { GroupTable } from './group-table.js';
import { RowStates } from './row-state.js';

const TURN = { kind: 'rotate' as const, center: [139, 35], angleDegrees: 15 };

/** The state of the rows over bits of handles of their own, with the handles that changed */
function statesOf(changed: number[][] = []): {
  states: RowStateSets;
  forget: (handle: number) => void;
} {
  const rowStates = new RowStates(FEATURE_ROW_STATE_BITS);
  const states = new RowStateSets({
    rowStates,
    groups: new GroupTable(),
    setRowStates: (handles, mask, bits) => {
      const handlesChanged = rowStates.set(handles, mask, bits);
      if (handlesChanged.length > 0) changed.push([...handlesChanged]);
    },
    setGroupStates: () => {},
  });
  return { states, forget: (handle) => states.forgotten(handle, rowStates.clear(handle)) };
}

describe('RowStateSets', () => {
  it('lists the rows marked as selected in bulk', () => {
    const changed: number[][] = [];
    const { states, forget } = statesOf(changed);
    states.setBulk(Int32Array.of(3, 70, -1), true);
    expect([...states.bulkHandles()].sort((a, b) => a - b)).toEqual([3, 70]);
    expect(states.stateOf(70) & STATE_BULK).toBe(STATE_BULK);
    states.setBulk(Int32Array.of(3), false);
    expect([...states.bulkHandles()]).toEqual([70]);
    forget(70);
    expect(states.bulkHandles().size).toBe(0);
    expect(states.stateOf(70)).toBe(0);
    expect(changed).toEqual([[3, 70], [3]]);
  });

  it('lets a moving set go once the last of its rows leaves it, however it leaves', () => {
    const { states, forget } = statesOf();
    const moving = (set: number) => [states.translation(set), states.transform(set)];

    // Out of every set
    states.setMoving(Int32Array.of(1, 2), 1);
    states.setTranslation(1, 0.5, -0.25);
    states.setTransform(1, TURN);
    states.setMoving(Int32Array.of(1), 0);
    expect(moving(1)).toEqual([[0.5, -0.25], TURN]);
    states.setMoving(Int32Array.of(2), 0);
    expect(moving(1)).toEqual([[0, 0], null]);

    // Into another set
    states.setMoving(Int32Array.of(3), 2);
    states.setTranslation(2, 1, 1);
    states.setMoving(Int32Array.of(3), 3);
    expect(moving(2)).toEqual([[0, 0], null]);

    // Forgotten
    states.setTranslation(3, 2, 2);
    forget(3);
    expect(moving(3)).toEqual([[0, 0], null]);
  });

  it('counts a row given twice into a moving set once', () => {
    const { states } = statesOf();
    states.setMoving(Int32Array.of(4, 4, 5), 1);
    expect(states.movingCount(1)).toBe(2);
    expect(states.movingHandles()).toEqual([4, 5]);
    expect(states.stateOf(4) & STATE_MOVE_MASK).not.toBe(0);
    states.setMoving(Int32Array.of(5, 4, 5), 0);
    expect(states.movingCount(1)).toBe(0);
  });
});
