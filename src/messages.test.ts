// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the messages table: the English default and the partial override
 */

import { describe, expect, it } from 'vitest';
import { MESSAGES_EN, resolveMessages } from './messages.js';

describe('MESSAGES_EN', () => {
  it('is English and cannot be rewritten', () => {
    expect(MESSAGES_EN.legendAll).toBe('All');
    expect(MESSAGES_EN.legendOther).toBe('Other');
    expect(MESSAGES_EN.legendBelow('10')).toBe('Below 10');
    expect(MESSAGES_EN.legendAtLeast('20')).toBe('20 or more');
    expect(MESSAGES_EN.legendRange('10', '20')).toBe('10 to below 20');
    expect(MESSAGES_EN.snapIntersection).toBe('Intersection');
    expect(Object.isFrozen(MESSAGES_EN)).toBe(true);
  });
});

describe('resolveMessages', () => {
  it('returns the English default when nothing is given', () => {
    expect(resolveMessages()).toEqual(MESSAGES_EN);
  });

  it('replaces the given entries and keeps the others', () => {
    const below = (upper: string) => `${upper} 未満`;
    const table = resolveMessages({ legendOther: 'その他', legendBelow: below });

    expect(table.legendOther).toBe('その他');
    expect(table.legendBelow).toBe(below);
    expect(table.legendAll).toBe('All');
    expect(table.snapNorth).toBe('North');
  });

  it('ignores undefined entries and keys the table does not know', () => {
    const table = resolveMessages({
      legendAll: undefined,
      unknown: 'x',
    } as unknown as Parameters<typeof resolveMessages>[0]);

    expect(table.legendAll).toBe('All');
    expect('unknown' in table).toBe(false);
  });

  it('returns a new object each time (no table is shared between instances)', () => {
    expect(resolveMessages()).not.toBe(resolveMessages());
    expect(resolveMessages()).not.toBe(MESSAGES_EN);
  });
});
