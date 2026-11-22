// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of freezing a table at every level
 */

import { describe, expect, it } from 'vitest';
import { deepFreeze } from './deep-freeze.js';

describe('deepFreeze', () => {
  it('returns the same table, frozen at every depth', () => {
    const table = { line: { width: 2, dash: [4, 2] }, names: ['a', 'b'] };
    const frozen = deepFreeze(table);

    expect(frozen).toBe(table);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.line)).toBe(true);
    expect(Object.isFrozen(frozen.line.dash)).toBe(true);
    expect(Object.isFrozen(frozen.names)).toBe(true);
  });

  it('throws on a write into a nested field, and the table keeps its values', () => {
    const table = deepFreeze({ line: { width: 2, dash: [4, 2] } });

    expect(() => {
      table.line.width = 5;
    }).toThrow(TypeError);
    expect(() => {
      table.line.dash.push(1);
    }).toThrow(TypeError);
    expect(() => {
      (table as { extra?: number }).extra = 1;
    }).toThrow(TypeError);
    expect(table).toEqual({ line: { width: 2, dash: [4, 2] } });
  });

  it('leaves the functions, the primitives and the typed arrays as they are', () => {
    const check = () => true;
    const vertices = new Float32Array([0, 1]);
    const table = deepFreeze({ check, vertices, name: 'a', size: 1 });

    expect(table.check).toBe(check);
    expect(Object.isFrozen(check)).toBe(false);
    expect(table.vertices).toBe(vertices);
    expect(Object.isFrozen(table)).toBe(true);
  });

  it('throws on a Set and on a Map, which would still take entries', () => {
    expect(() => deepFreeze({ kinds: new Set(['a']) })).toThrow(TypeError);
    expect(() => deepFreeze(new Map([['a', 1]]))).toThrow(TypeError);
  });

  it('freezes a table that reaches itself without going round forever', () => {
    const table: { self?: unknown; value: number } = { value: 1 };
    table.self = table;

    expect(Object.isFrozen(deepFreeze(table))).toBe(true);
  });
});
