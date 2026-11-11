// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The bits of the state of each handle: as many as declared, set under a mask, forgotten with the
 * handle; a mask beyond them is refused
 */

import { describe, expect, it } from 'vitest';
import { KasaneError } from '../table/kasane-error.js';
import { MOST_ROW_STATE_BITS, RowStates } from './row-state.js';

describe('RowStates', () => {
  it('sets the bits under a mask and gives the handles that changed', () => {
    const states = new RowStates(3);
    expect(Array.from(states.set(Int32Array.of(2, 90, -1, 2), 0b011, 0b001))).toEqual([2, 90]);
    expect(states.of(90)).toBe(0b001);
    expect(Array.from(states.set(Int32Array.of(2, 7), 0b110, 0b111))).toEqual([2, 7]);
    expect(states.of(2)).toBe(0b111);
    expect(states.of(7)).toBe(0b110);
    expect(Array.from(states.set(Int32Array.of(7), 0b100, 0b100))).toEqual([]);
    expect(states.find(0b001)).toEqual([2, 90]);
    expect(states.clear(2)).toBe(0b111);
    expect(states.of(2)).toBe(0);
    expect(states.of(1000)).toBe(0);
  });

  it('holds more than 8 bits of a handle', () => {
    const states = new RowStates(12);
    states.set(Int32Array.of(1), 0xfff, 0xa05);
    expect(states.of(1)).toBe(0xa05);
  });

  it('refuses a mask beyond the bits declared, and more bits than the copy holds', () => {
    const states = new RowStates(2);
    expect(() => states.set(Int32Array.of(1), 0b100, 0b100)).toThrow(KasaneError);
    expect(() => new RowStates(MOST_ROW_STATE_BITS + 1)).toThrow(KasaneError);
    expect(() => new RowStates(MOST_ROW_STATE_BITS)).not.toThrow();
  });
});
