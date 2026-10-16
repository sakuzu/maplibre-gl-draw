// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The values of the attributes: their kinds, the one form the library holds them in, their
 * equality and their JSON form
 */

import { describe, expect, it } from 'vitest';
import {
  isValue,
  parseValueJSON,
  rewriteReferences,
  sameValue,
  stringifyValueJSON,
  type Value,
  valueFromJSON,
  valueOfInput,
  valueToJSON,
} from './value.js';
import {
  BigInteger,
  Bytes,
  CalendarDate,
  DateTime,
  Decimal,
  Duration,
  Reference,
  TimeOfDay,
} from './value-kinds.js';

describe('the kinds of values', () => {
  it('do not change once made, and write their JSON form', () => {
    const date = CalendarDate.of(2026, 10, 16);
    expect(Object.isFrozen(date)).toBe(true);
    expect([date.year, date.month, date.day]).toEqual([2026, 10, 16]);
    expect(JSON.stringify({ date })).toBe('{"date":{"$date":"2026-10-16"}}');
    const source = new Uint8Array([1, 2, 3]);
    const bytes = new Bytes(source);
    source[0] = 9;
    expect([...bytes.toUint8Array()]).toEqual([1, 2, 3]);
    expect(JSON.stringify(bytes)).toBe('{"$bytes":"AQID"}');
    expect(JSON.stringify(new BigInteger(2n ** 60n))).toBe('{"$integer":"1152921504606846976"}');
  });

  it('keep the range of a big integer, the scale of a decimal and the zone of a date-time', () => {
    expect(() => new BigInteger(5n)).toThrow();
    expect(() => new BigInteger(2n ** 64n)).toThrow();
    expect(Decimal.parse('1.10').toString()).toBe('1.10');
    expect(() => Decimal.parse('-0.0')).toThrow();
    const local = DateTime.parse('2026-10-16T09:30:00');
    expect(local.zone).toBe('local');
    expect(local.toString()).toBe('2026-10-16T09:30:00');
    expect(DateTime.parse('2026-10-16T09:30:00.500Z').toString()).toBe('2026-10-16T09:30:00.5Z');
    expect(DateTime.fromDate(new Date(Date.UTC(2026, 9, 16))).toString()).toBe(
      '2026-10-16T00:00:00Z',
    );
    expect(TimeOfDay.parse('09:30:00.000000001').nanosecond).toBe(1);
    expect(Duration.parse('PT90S').toString()).toBe('PT1M30S');
    expect(new Duration(1, -2, 3, 500_000_000).toJSON()).toEqual({
      $duration: { months: 1, days: -2, seconds: 3, nanoseconds: 500_000_000 },
    });
  });
});

describe('a value given to the library', () => {
  it('is held in one form', () => {
    expect(valueOfInput(5n, 'v')).toBe(5);
    expect(valueOfInput(2n ** 60n, 'v')).toBeInstanceOf(BigInteger);
    expect(valueOfInput(new Uint8Array([1]), 'v')).toBeInstanceOf(Bytes);
    const kept = { a: 1, b: [2, 'x'] };
    expect(valueOfInput(kept, 'v')).toBe(kept);
    expect(valueOfInput({ a: 1, b: undefined }, 'v')).toEqual({ a: 1 });
    expect(Object.keys(valueOfInput({ a: undefined, b: 2 }, 'v') as object)).toEqual(['b']);
  });

  it('refuses what is not a value', () => {
    expect(() => valueOfInput(new Date(0), 'v')).toThrow(/DateTime.fromDate/);
    expect(() => valueOfInput(new Map(), 'v')).toThrow(/Map/);
    expect(() => valueOfInput(new Float64Array(1), 'v')).toThrow();
    expect(() => valueOfInput('a\ud800', 'v')).toThrow(/lone surrogate/);
    expect(() => valueOfInput([1, undefined], 'v')).toThrow(/hole/);
    expect(() => valueOfInput(() => 1, 'v')).toThrow();
    expect(() => valueOfInput(2n ** 64n, 'v')).toThrow();
  });

  it('takes the classes of another implementation of the same kinds as its own', () => {
    // A class marked with the kind of a date-time, as another library writes its own
    class OtherDateTime {
      readonly seconds = 0;
      readonly nanoseconds = 5;
      readonly zone = 'utc';
      readonly offsetMinutes = 0;
    }
    Object.defineProperty(OtherDateTime.prototype, Symbol.for('kasane.value.kind'), {
      value: 'datetime',
    });
    const other = new OtherDateTime();
    expect(other instanceof DateTime).toBe(true);
    expect(isValue(other)).toBe(true);
    const own = valueOfInput({ at: other }, 'v') as { at: DateTime };
    expect(Object.getPrototypeOf(own.at)).toBe(DateTime.prototype);
    expect(sameValue(own.at, new DateTime(0, 5))).toBe(true);
  });
});

describe('the equality of values', () => {
  it('tells the kinds apart', () => {
    expect(sameValue(Number.NaN, Number.NaN)).toBe(true);
    expect(sameValue(0, -0)).toBe(false);
    expect(sameValue(new BigInteger(2n ** 60n), 2 ** 60)).toBe(false);
    expect(sameValue(Decimal.parse('1.10'), Decimal.parse('1.1'))).toBe(false);
    expect(
      sameValue(DateTime.parse('2026-10-16T09:30:00'), DateTime.parse('2026-10-16T09:30:00Z')),
    ).toBe(false);
    expect(sameValue(new Reference('a'), 'a')).toBe(false);
    expect(sameValue(CalendarDate.parse('2026-10-16'), '2026-10-16')).toBe(false);
    expect(sameValue({ a: 1, b: [new Reference('x')] }, { b: [new Reference('x')], a: 1 })).toBe(
      true,
    );
  });
});

describe('the JSON form of values', () => {
  const value: Value = {
    code: '01101',
    osm: new BigInteger(12345678901234567890n),
    area: Decimal.parse('1234.50'),
    opened: CalendarDate.parse('1998-04-01'),
    updated: DateTime.parse('2026-10-16T09:30:00+09:00'),
    depth: Number.NaN,
    zero: -0,
    big: 2 ** 60,
    target: { featureId: new Reference('1AAAAAAAAAAAA-1A') },
    tagged: { $date: 'not a date' },
  };

  it('reads back as the same value, losing nothing', () => {
    const text = stringifyValueJSON(value);
    expect(JSON.parse(text).tagged).toEqual({ $object: { $date: 'not a date' } });
    expect(JSON.parse(text).big).toEqual({ $number: '1152921504606847000' });
    expect(sameValue(parseValueJSON(text), value)).toBe(true);
    expect(sameValue(valueFromJSON(valueToJSON(value)), value)).toBe(true);
  });

  it('keeps an integer of JSON outside the range of a number as it is written', () => {
    expect(parseValueJSON('{"id": 12345678901234567890}')).toEqual({
      id: new BigInteger(12345678901234567890n),
    });
    const beyond = parseValueJSON('[123456789012345678901234567890]') as Value[];
    expect(sameValue(beyond[0], new Decimal(123456789012345678901234567890n, 0))).toBe(true);
    expect(parseValueJSON('[9007199254740991, 1.5e300, "\\u00e9"]')).toEqual([
      9007199254740991,
      1.5e300,
      'é',
    ]);
    expect(Object.keys(parseValueJSON('{"__proto__": 12345678901234567890}') as object)).toEqual([
      '__proto__',
    ]);
    expect(() => parseValueJSON('{"a": 12345678901234567890')).toThrow();
  });

  it('refuses a tag whose text is not one of its kind', () => {
    expect(() => valueFromJSON({ $integer: '1' })).toThrow();
    expect(() => valueFromJSON({ $date: '2026-02-30' })).toThrow();
    expect(() => valueFromJSON({ $number: '5' })).toThrow();
    expect(() => valueFromJSON({ $reference: { id: 'a', element: 'b' } })).toThrow();
  });
});

describe('references rewritten', () => {
  it('name the new ids, at any depth, and leave the others', () => {
    const v = { target: { featureId: new Reference('a') }, other: [new Reference('c')], n: 1 };
    const out = rewriteReferences(v, { a: 'b' }) as typeof v;
    expect(out.target.featureId.id).toBe('b');
    expect(out.other).toBe(v.other);
    expect(rewriteReferences('a', { a: 'b' })).toBe('a');
    expect(rewriteReferences(v.other, { a: 'b' })).toBe(v.other);
  });
});
