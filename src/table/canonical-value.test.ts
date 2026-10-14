// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  appendCanonicalValue,
  CANONICAL_INTEGER,
  CANONICAL_MAX_DEPTH,
  CANONICAL_NUMBER,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from './canonical-value.js';
import { Utf8ColumnBuilder } from './utf8-column.js';

/**
 * The canonical form written the plain way (every string through TextEncoder, the keys sorted by
 * their bytes), which the encoder must give byte for byte
 */
function referenceBytes(value: unknown): number[] {
  const encoder = new TextEncoder();
  const out: number[] = [];
  const varUint = (n: number) => {
    let rest = n;
    while (rest > 0x7f) {
      out.push(0x80 | (rest % 0x80));
      rest = Math.floor(rest / 0x80);
    }
    out.push(rest);
  };
  const string = (text: string) => {
    const bytes = encoder.encode(text);
    varUint(bytes.length);
    out.push(...bytes);
  };
  const compare = (a: Uint8Array, b: Uint8Array) => {
    for (let k = 0; k < Math.min(a.length, b.length); k++) if (a[k] !== b[k]) return a[k] - b[k];
    return a.length - b.length;
  };
  const write = (item: unknown): void => {
    if (item === null) out.push(0);
    else if (item === false) out.push(1);
    else if (item === true) out.push(2);
    else if (typeof item === 'number') out.push(...encodeCanonicalValue(item));
    else if (typeof item === 'string') {
      out.push(5);
      string(item);
    } else if (Array.isArray(item)) {
      out.push(6);
      varUint(item.length);
      for (const inner of item) write(inner);
    } else {
      const entries = Object.entries(item as Record<string, unknown>)
        .filter(([, inner]) => inner !== undefined)
        .map(([key, inner]) => [encoder.encode(key), key, inner] as const)
        .sort((a, b) => compare(a[0], b[0]));
      out.push(7);
      varUint(entries.length);
      for (const [, key, inner] of entries) {
        string(key);
        write(inner);
      }
    }
  };
  write(value);
  return out;
}

describe('the canonical form of a value', () => {
  it('reads back every kind of value', () => {
    const values: unknown[] = [
      null,
      true,
      false,
      0,
      -1,
      63,
      64,
      -64,
      -65,
      2 ** 40,
      Number.MAX_SAFE_INTEGER,
      -Number.MAX_SAFE_INTEGER,
      1.5,
      -0.25,
      2 ** 60,
      '',
      'abc',
      '日本語🗾',
      [],
      [1, 'a', null, [true]],
      {},
      { b: 1, a: { c: [1, 2] } },
    ];
    for (const value of values) {
      expect(decodeCanonicalValue(encodeCanonicalValue(value))).toEqual(value);
    }
  });

  it('gives the same bytes whatever the order of the keys', () => {
    const a = encodeCanonicalValue({ strokeColor: '#ff0000', fillColor: '#00ff00', z: [1] });
    const b = encodeCanonicalValue({ z: [1], fillColor: '#00ff00', strokeColor: '#ff0000' });
    expect([...a]).toEqual([...b]);
  });

  it('leaves out a key whose value is undefined', () => {
    expect([...encodeCanonicalValue({ a: 1, b: undefined })]).toEqual([
      ...encodeCanonicalValue({ a: 1 }),
    ]);
  });

  it('orders the keys by their UTF-8 bytes', () => {
    const decoded = decodeCanonicalValue(encodeCanonicalValue({ '🗾': 1, '｡': 2, a: 3 }));
    expect(Object.keys(decoded as object)).toEqual(['a', '｡', '🗾']);
  });

  it('writes a safe integer as an integer and anything else as a float64', () => {
    expect(encodeCanonicalValue(5)[0]).toBe(CANONICAL_INTEGER);
    expect(encodeCanonicalValue(-0)[0]).toBe(CANONICAL_NUMBER);
    expect(Object.is(decodeCanonicalValue(encodeCanonicalValue(-0)), -0)).toBe(true);
    expect(encodeCanonicalValue(2 ** 53)[0]).toBe(CANONICAL_NUMBER);
    expect(encodeCanonicalValue(0.1)[0]).toBe(CANONICAL_NUMBER);
  });

  it('writes the integers in the fewest bytes', () => {
    // 6 bits in the first byte, then 7 bits per byte
    expect(encodeCanonicalValue(63).length).toBe(2);
    expect(encodeCanonicalValue(64).length).toBe(3);
    expect([...encodeCanonicalValue(-1)]).toEqual([CANONICAL_INTEGER, 0x41]);
    expect([...encodeCanonicalValue(64)]).toEqual([CANONICAL_INTEGER, 0x80, 0x01]);
  });

  it('refuses what is not a value', () => {
    expect(() => encodeCanonicalValue(undefined)).toThrow();
    expect(() => encodeCanonicalValue(Number.NaN)).toThrow();
    expect(() => encodeCanonicalValue(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => encodeCanonicalValue(() => 1)).toThrow();
  });

  it('refuses a value nested deeper than the limit, and takes one exactly at it', () => {
    const nest = (depth: number): unknown => {
      let value: unknown = 1;
      for (let i = 0; i < depth; i++) value = [value];
      return value;
    };
    expect(decodeCanonicalValue(encodeCanonicalValue(nest(CANONICAL_MAX_DEPTH)))).toEqual(
      nest(CANONICAL_MAX_DEPTH),
    );
    expect(() => encodeCanonicalValue(nest(CANONICAL_MAX_DEPTH + 1))).toThrow();
  });

  it('refuses bytes that are cut short or have bytes left over', () => {
    const bytes = encodeCanonicalValue({ a: 'text' });
    expect(() => decodeCanonicalValue(bytes.subarray(0, bytes.length - 1))).toThrow();
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);
    expect(() => decodeCanonicalValue(longer)).toThrow();
  });

  it('keeps a key named __proto__ as an own key', () => {
    const value = JSON.parse('{"__proto__": {"x": 1}}');
    const decoded = decodeCanonicalValue(encodeCanonicalValue(value)) as Record<string, unknown>;
    expect(Object.keys(decoded)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });

  it('reads a value inside a larger array of bytes', () => {
    const value = encodeCanonicalValue(['a', 2]);
    const bytes = new Uint8Array(value.length + 4);
    bytes.set(value, 2);
    expect(decodeCanonicalValue(bytes, 2, 2 + value.length)).toEqual(['a', 2]);
  });

  it('writes every string and key as TextEncoder does, and orders the keys by those bytes', () => {
    const long = 'x'.repeat(300);
    const values: unknown[] = [
      'a🗾b',
      '\ud800',
      'a\udc00b',
      long,
      `${long}日本`,
      { '\ue000': 1, '🗾': 2, '｡': 3, a: 4, '\ud800': 5, '\udc00': 6, [long]: 7 },
      { zeta: 1, alpha: [{ beta: 'é', alpha: null }], gamma: { b: 2, a: 1 } },
      // More keys than are put in order one by one
      Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${(i * 7) % 40}`, i])),
      Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`${'🗾'.repeat(i % 3)}${i}`, i])),
    ];
    for (const value of values) {
      expect([...encodeCanonicalValue(value)]).toEqual(referenceBytes(value));
    }
  });

  it('writes a value read from a getter while another is written', () => {
    const inner = { b: [1, 'x'] };
    const outer = {
      get a() {
        // A value written while the outer one is
        return [...encodeCanonicalValue(inner)];
      },
      c: 'z',
    };
    expect([...encodeCanonicalValue(outer)]).toEqual(
      referenceBytes({ a: referenceBytes(inner), c: 'z' }),
    );
    expect([...encodeCanonicalValue(inner)]).toEqual(referenceBytes(inner));
  });

  it('adds the bytes of a value to a column, and nothing for a value refused', () => {
    const builder = new Utf8ColumnBuilder(1);
    appendCanonicalValue({ a: [1, 'b'] }, builder);
    expect(() => appendCanonicalValue({ a: Number.NaN }, builder)).toThrow();
    appendCanonicalValue('c', builder);
    const column = builder.finish();
    expect(column.offsets.length).toBe(3);
    expect(decodeCanonicalValue(column.bytes, column.offsets[0], column.offsets[1])).toEqual({
      a: [1, 'b'],
    });
    expect(decodeCanonicalValue(column.bytes, column.offsets[1], column.offsets[2])).toBe('c');
  });
});
