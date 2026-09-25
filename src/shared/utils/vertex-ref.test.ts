// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the vertex reference utilities
 *
 * part is optional, and when omitted it means 0. The vertex reference of a single geometry has
 * no part, so unless comparison treats undefined and 0 as the same, a mismatch such as "part 0
 * of a Multi was selected but it does not match the reference on the single geometry side"
 * occurs.
 */

import { describe, expect, it } from 'vitest';
import { getVertexPart, hasVertexRef, isSameVertexRef } from './vertex-ref.js';

describe('getVertexPart', () => {
  it('returns 0 when part is omitted', () => {
    expect(getVertexPart({ ring: 0, index: 3 })).toBe(0);
  });

  it('returns the value of part when there is one', () => {
    expect(getVertexPart({ part: 2, ring: 1, index: 3 })).toBe(2);
  });
});

describe('isSameVertexRef', () => {
  it('treats undefined and 0 of part as the same', () => {
    expect(isSameVertexRef({ ring: 0, index: 1 }, { part: 0, ring: 0, index: 1 })).toBe(true);
    expect(isSameVertexRef({ part: 0, ring: 0, index: 1 }, { ring: 0, index: 1 })).toBe(true);
  });

  it('regards it as a different vertex when part differs', () => {
    expect(isSameVertexRef({ ring: 0, index: 1 }, { part: 1, ring: 0, index: 1 })).toBe(false);
    expect(isSameVertexRef({ part: 1, ring: 0, index: 1 }, { part: 2, ring: 0, index: 1 })).toBe(
      false,
    );
  });

  it('the comparison of ring / index is as before', () => {
    expect(isSameVertexRef({ part: 1, ring: 1, index: 2 }, { part: 1, ring: 1, index: 2 })).toBe(
      true,
    );
    expect(isSameVertexRef({ part: 1, ring: 1, index: 2 }, { part: 1, ring: 2, index: 2 })).toBe(
      false,
    );
    expect(isSameVertexRef({ part: 1, ring: 1, index: 2 }, { part: 1, ring: 1, index: 3 })).toBe(
      false,
    );
  });
});

describe('hasVertexRef', () => {
  it('an element of part 0 can be found with a reference that omits part', () => {
    const refs = [
      { part: 0, ring: 0, index: 1 },
      { part: 1, ring: 0, index: 2 },
    ];
    expect(hasVertexRef(refs, { ring: 0, index: 1 })).toBe(true);
    expect(hasVertexRef(refs, { ring: 0, index: 2 })).toBe(false);
    expect(hasVertexRef(refs, { part: 1, ring: 0, index: 2 })).toBe(true);
  });
});
