// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The state of the rows kept as sets of handles: the rows marked as selected in bulk are listed
 * as they are marked and unmarked, and a handle forgotten leaves the list; a moving set moves its
 * rows while one is in it, and is let go of once the last leaves it
 */

import { describe, expect, it } from 'vitest';
import { RowStateSets, STATE_BULK } from './row-state.js';

const TURN = { kind: 'rotate' as const, center: [139, 35], angleDegrees: 15 };

describe('RowStateSets', () => {
  it('lists the rows marked as selected in bulk', () => {
    const changed: number[][] = [];
    const states = new RowStateSets((handles) => changed.push([...handles]));
    states.setBulk(Int32Array.of(3, 70, -1), true);
    expect([...states.bulkHandles()].sort((a, b) => a - b)).toEqual([3, 70]);
    expect(states.stateOf(70) & STATE_BULK).toBe(STATE_BULK);
    states.setBulk(Int32Array.of(3), false);
    expect([...states.bulkHandles()]).toEqual([70]);
    states.clear(70);
    expect(states.bulkHandles().size).toBe(0);
    expect(states.stateOf(70)).toBe(0);
    expect(changed).toEqual([[3, 70], [3]]);
  });

  it('lets a moving set go once the last of its rows leaves it, however it leaves', () => {
    const states = new RowStateSets(() => {});
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
    states.clear(3);
    expect(moving(3)).toEqual([[0, 0], null]);
  });
});
