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
import { stringifyValueJSON, type Value, valueFromJSON } from './value.js';

/** Values of the kinds of their own, by their JSON form, and their canonical bytes */
const KINDS: [string, unknown, string][] = [
  ['NaN', { $number: 'NaN' }, '047ff8000000000000'],
  ['the positive infinity', { $number: 'Infinity' }, '047ff0000000000000'],
  ['a date', { $date: '2026-10-16' }, '0886c402'],
  ['a date of a year before 0', { $date: '-000044-03-15' }, '08e5e459'],
  [
    'the same instant with an offset',
    { $datetime: '2026-10-16T09:30:00+09:00' },
    '0988c08bad0d00019c08',
  ],
  [
    'an instant with nanoseconds',
    { $datetime: '2026-10-16T00:30:00.123456789Z' },
    '0988c08bad0d959aef3a00',
  ],
  ['a local date-time', { $datetime: '2026-10-16T09:30:00' }, '0998ba8fad0d0002'],
  [
    'the first date-time',
    { $datetime: '-290308-12-21T19:59:05.224192Z' },
    '09f7eb82bdef980480ccf36a00',
  ],
  ['minus zero', { $number: '-0' }, '048000000000000000'],
  ['two to the 53rd, a big integer', { $integer: '9007199254740992' }, '0b8080808080808020'],
  ['the largest big integer', { $integer: '18446744073709551615' }, '0bbfffffffffffffffff03'],
  ['the smallest big integer', { $integer: '-9223372036854775808' }, '0bc0808080808080808002'],
  ['a decimal', { $decimal: '123.45' }, '0c02b9c001'],
  ['a decimal with a zero of its scale', { $decimal: '1.10' }, '0c02ae01'],
  ['a negative decimal below 1', { $decimal: '-0.05' }, '0c0245'],
  [
    'the largest decimal',
    { $decimal: '0.9999999999999999999999999999999999999999999999999999999999999999999999999999' },
    '0c4cbfffffffffffffffffffffd0b2dcf8a5ebddcb97a599f4abe992bbd0b6c5cc91ceb2dee102',
  ],
  ['the empty bytes', { $bytes: '' }, '0a00'],
  ['bytes', { $bytes: 'AAEC/w==' }, '0a04000102ff'],
  ['a time with a fraction', { $time: '09:30:00.5' }, '0d80aa9de5aee307'],
  ['the last nanosecond of a day', { $time: '23:59:59.999999999' }, '0dffffbb8ac9d213'],
  ['a duration', { $duration: 'P1M2DT3.5S' }, '0e0102038094ebdc03'],
  ['a negative duration below a second', { $duration: '-PT0.000000001S' }, '0e00000041'],
  [
    'a duration of both signs',
    { $duration: { months: 1, days: -2, seconds: 3, nanoseconds: 500000000 } },
    '0e0142038094ebdc03',
  ],
  ['a reference', { $reference: '1AAAAAAAAAAAA-1A' }, '0f10314141414141414141414141412d314100'],
  [
    'references nested',
    { target: { featureId: { $reference: '1AAAAAAAAAAAA-1A' } }, ids: [{ $reference: 'a' }] },
    '07020369647306010f016100067461726765740701096665617475726549640f10314141414141414141414141412d314100',
  ],
];

function hexOf(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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
    expect(() => encodeCanonicalValue(() => 1)).toThrow();
    expect(() => encodeCanonicalValue(new Date(0))).toThrow(/class/);
    expect(() => encodeCanonicalValue({ a: new Map() })).toThrow(/class/);
    expect(() => encodeCanonicalValue(new Float32Array(1))).toThrow(/class/);
    expect(() => encodeCanonicalValue('a\ud800')).toThrow(/lone surrogate/);
    expect(() => encodeCanonicalValue({ '\udc00': 1 })).toThrow(/lone surrogate/);
    expect(() => encodeCanonicalValue(2n ** 64n)).toThrow();
  });

  it('writes the values of every kind as their bytes, and reads them back', () => {
    for (const [name, json, hex] of KINDS) {
      const value = valueFromJSON(json);
      const bytes = encodeCanonicalValue(value);
      expect(hexOf(bytes), name).toBe(hex);
      expect(JSON.parse(stringifyValueJSON(decodeCanonicalValue(bytes) as Value)), name).toEqual(
        json,
      );
    }
  });

  it('writes a bigint as the number or the big integer it is, and a Uint8Array as bytes', () => {
    expect(hexOf(encodeCanonicalValue(5n))).toBe(hexOf(encodeCanonicalValue(5)));
    expect(hexOf(encodeCanonicalValue(2n ** 53n))).toBe('0b8080808080808020');
    expect(hexOf(encodeCanonicalValue(new Uint8Array([0, 1, 2, 255])))).toBe('0a04000102ff');
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
      long,
      `${long}日本`,
      { '\ue000': 1, '🗾': 2, '｡': 3, a: 4, [long]: 7 },
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
    expect(() => appendCanonicalValue({ a: new Date(0) }, builder)).toThrow();
    appendCanonicalValue('c', builder);
    const column = builder.finish();
    expect(column.offsets.length).toBe(3);
    expect(decodeCanonicalValue(column.bytes, column.offsets[0], column.offsets[1])).toEqual({
      a: [1, 'b'],
    });
    expect(decodeCanonicalValue(column.bytes, column.offsets[1], column.offsets[2])).toBe('c');
  });
});
