// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the generation of ids (ULIDs with pooled randomness)
 */

import { decodeTime } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createId } from './id.js';

/** The form of a ULID: 26 characters of Crockford's Base32, the first at most 7 */
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

describe('createId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a ULID that carries the current time', () => {
    const before = Date.now();
    const id = createId();
    const after = Date.now();
    expect(id).toMatch(ULID_PATTERN);
    expect(decodeTime(id)).toBeGreaterThanOrEqual(before);
    expect(decodeTime(id)).toBeLessThanOrEqual(after);
  });

  it('ids of later milliseconds sort after earlier ones', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_700_000_000_000);
    const first = createId();
    now.mockReturnValue(1_700_000_000_001);
    const second = createId();
    expect(first < second).toBe(true);
  });

  it('many ids are distinct', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20_000; i++) ids.add(createId());
    expect(ids.size).toBe(20_000);
  });

  it('takes the randomness in batches rather than per character', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    for (let i = 0; i < 1_000; i++) createId();
    // 16 random characters per id: one call per character would be 16,000 calls
    expect(spy.mock.calls.length).toBeLessThan(100);
  });
});
