// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The state of the rows kept as sets of handles: the rows marked as selected in bulk are listed
 * as they are marked and unmarked, and a handle forgotten leaves the list
 */

import { describe, expect, it } from 'vitest';
import { RowStateSets, STATE_BULK } from './row-state.js';

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
});
