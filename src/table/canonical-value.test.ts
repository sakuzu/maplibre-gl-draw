// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  CANONICAL_INTEGER,
  CANONICAL_MAX_DEPTH,
  CANONICAL_NUMBER,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from './canonical-value.js';

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
});
