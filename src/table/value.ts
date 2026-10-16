// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The values of the attributes, and their JSON form
 *
 * A value is null, a boolean, a number (a float64: NaN, the infinities and -0 included), a
 * string, bytes, a big integer, a decimal, a date, a time, a date-time, a duration, a reference,
 * an array of values or an object of values by string keys. There is no `undefined`: a key that
 * has no value is absent, which is not the same as a key whose value is null.
 *
 * The JSON form writes the kinds that JSON has not as objects of one key (a tag): `$integer`,
 * `$decimal`, `$bytes`, `$date`, `$time`, `$datetime`, `$duration` and `$reference`, and the
 * numbers JSON cannot write (NaN, the infinities, -0, and an integer outside -(2^53 - 1) to
 * 2^53 - 1, whose digits would read as a big integer) as `$number`. An object whose one key is
 * one of these names or `$object` is wrapped as `{"$object": ...}`.
 *
 * A pure module: it depends on nothing outside `/table` and `/shared`, so it runs in a Worker as
 * well.
 */

import { DrawError } from '../shared/draw-error.js';
import { setOwnProperty } from '../shared/utils/own-property.js';
import {
  BigInteger,
  Bytes,
  CalendarDate,
  DateTime,
  Decimal,
  Duration,
  durationOfMembers,
  fromBase64,
  MAX_BIG_INTEGER,
  MIN_BIG_INTEGER,
  Reference,
  TimeOfDay,
  wellFormed,
} from './value-kinds.js';

/**
 * A value of an attribute: null, a boolean, a number, a string, one of the classes of the kinds
 * JSON has not, an array of values or an object of values
 */
export type Value =
  | null
  | boolean
  | number
  | string
  | Bytes
  | BigInteger
  | Decimal
  | CalendarDate
  | TimeOfDay
  | DateTime
  | Duration
  | Reference
  | readonly Value[]
  | { readonly [key: string]: Value };

/** The deepest nesting of arrays and objects a value may have (the outermost counts as 1) */
export const MAX_VALUE_DEPTH = 32;

function invalid(message: string): DrawError {
  return new DrawError('invalid-input', message);
}

/** Whether something is an instance of a class of a kind of value (a date, a reference, ...) */
export function isKindValue(v: object): boolean {
  return (
    v instanceof CalendarDate ||
    v instanceof DateTime ||
    v instanceof TimeOfDay ||
    v instanceof Duration ||
    v instanceof BigInteger ||
    v instanceof Decimal ||
    v instanceof Bytes ||
    v instanceof Reference
  );
}

/** Whether an object is a plain object (of `Object.prototype` or of no prototype) */
function isPlain(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Whether something is a value: the kinds of {@link Value} only, strings and keys of well-formed
 * Unicode, arrays without holes, plain objects, no `undefined`, nested at most 32 deep
 */
export function isValue(value: unknown): value is Value {
  return valueAt(value, 0);
}

function valueAt(v: unknown, depth: number): boolean {
  if (v === null) return true;
  switch (typeof v) {
    case 'boolean':
    case 'number':
      return true;
    case 'string':
      return wellFormed(v);
    case 'object': {
      if (isKindValue(v)) return true;
      if (depth >= MAX_VALUE_DEPTH) return false;
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          if (!(i in v) || !valueAt(v[i], depth + 1)) return false;
        }
        return true;
      }
      if (!isPlain(v)) return false;
      for (const k of Object.keys(v)) {
        if (!wellFormed(k) || !valueAt((v as Record<string, unknown>)[k], depth + 1)) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

/** The largest integer a number holds exactly (2^53 - 1), as a bigint */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** A value of a class of a kind, as an instance of the class of this library */
function ownKindValue(v: object): Value {
  if (v instanceof CalendarDate) {
    return Object.getPrototypeOf(v) === CalendarDate.prototype ? v : new CalendarDate(v.days);
  }
  if (v instanceof DateTime) {
    return Object.getPrototypeOf(v) === DateTime.prototype
      ? v
      : new DateTime(v.seconds, v.nanoseconds, v.zone, v.offsetMinutes);
  }
  if (v instanceof TimeOfDay) {
    return Object.getPrototypeOf(v) === TimeOfDay.prototype ? v : new TimeOfDay(v.nanoseconds);
  }
  if (v instanceof Duration) {
    return Object.getPrototypeOf(v) === Duration.prototype
      ? v
      : new Duration(v.months, v.days, v.seconds, v.nanoseconds);
  }
  if (v instanceof BigInteger) {
    return Object.getPrototypeOf(v) === BigInteger.prototype ? v : new BigInteger(v.value);
  }
  if (v instanceof Decimal) {
    return Object.getPrototypeOf(v) === Decimal.prototype ? v : new Decimal(v.coefficient, v.scale);
  }
  if (v instanceof Bytes) {
    return Object.getPrototypeOf(v) === Bytes.prototype ? v : new Bytes(v.toUint8Array());
  }
  const r = v as Reference;
  return Object.getPrototypeOf(r) === Reference.prototype ? r : new Reference(r.id);
}

/**
 * A value given to the library, in the one form it holds: a bigint as a number (from -(2^53 - 1)
 * to 2^53 - 1) or a {@link BigInteger}, a `Uint8Array` as {@link Bytes} (a copy), a value of
 * another implementation of the same kinds as an instance of these classes, and a key whose
 * value is `undefined` left out of an object. The value itself when it is in that form already
 *
 * @param what - What the value is, for the message of the error
 * @throws DrawError (`invalid-input`) when it is not a value: a `Date` (a date-time is
 *   `DateTime.fromDate(date)`, a day `CalendarDate.of(year, month, day)`), a `Map`, a `Set`, an
 *   instance of another class, a typed array other than `Uint8Array`, a function, a symbol, a
 *   string with a lone surrogate, an array with a hole or an `undefined`, a value nested deeper
 *   than 32
 * @internal
 */
export function valueOfInput(value: unknown, what: string): Value {
  return inputAt(value, what, 0);
}

function inputAt(v: unknown, what: string, depth: number): Value {
  if (v === null) return null;
  switch (typeof v) {
    case 'boolean':
    case 'number':
      return v;
    case 'string':
      if (!wellFormed(v)) throw invalid(`${what} is a string with a lone surrogate`);
      return v;
    case 'bigint':
      if (v >= -MAX_SAFE && v <= MAX_SAFE) return Number(v);
      if (v < MIN_BIG_INTEGER || v > MAX_BIG_INTEGER) {
        throw invalid(`${what} is an integer outside -2^63 to 2^64 - 1`);
      }
      return new BigInteger(v);
    case 'object': {
      if (isKindValue(v)) return ownKindValue(v);
      if (v instanceof Uint8Array) return new Bytes(v);
      if (v instanceof Date) {
        throw invalid(
          `${what} is a Date: give a date-time as DateTime.fromDate(date), or a day as CalendarDate.of(year, month, day)`,
        );
      }
      if (depth >= MAX_VALUE_DEPTH) throw invalid(`${what} is nested deeper than 32`);
      if (Array.isArray(v)) {
        let out: Value[] | null = null;
        for (let i = 0; i < v.length; i++) {
          if (!(i in v) || v[i] === undefined) throw invalid(`${what} is an array with a hole`);
          const x = inputAt(v[i], what, depth + 1);
          if (x !== v[i]) {
            out ??= v.slice();
            out[i] = x;
          }
        }
        return out ?? (v as Value[]);
      }
      if (!isPlain(v)) {
        const name = (v as { constructor?: { name?: unknown } }).constructor?.name;
        throw invalid(`${what} is an instance of ${typeof name === 'string' ? name : 'a class'}`);
      }
      const o = v as Record<string, unknown>;
      let out: Record<string, Value> | null = null;
      const keys = Object.keys(o);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!wellFormed(k)) throw invalid(`${what} has a key with a lone surrogate`);
        const item = o[k];
        // A key whose value is undefined is absent
        const x = item === undefined ? undefined : inputAt(item, what, depth + 1);
        if (out === null && (x !== item || x === undefined)) {
          out = {};
          for (let j = 0; j < i; j++) setOwnProperty(out, keys[j], o[keys[j]]);
        }
        if (out !== null && x !== undefined) setOwnProperty(out, k, x);
      }
      return out ?? (o as Value);
    }
    default:
      throw invalid(`${what} is a ${typeof v}, not a value`);
  }
}

/** The order of two arrays of bytes */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * Whether two values are the same value: of the same kind and the same contents. NaN is the
 * same as NaN, 0 and -0 are not, a big integer is not the number of the same integer, a decimal
 * keeps its scale (1.10 is not 1.1), a date-time its zone and its offset, a reference is not the
 * string of its id, and the keys of an object are in any order
 */
export function sameValue(a: Value, b: Value): boolean {
  if (typeof a === 'number' || typeof b === 'number') return Object.is(a, b);
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a instanceof CalendarDate || b instanceof CalendarDate) {
    return a instanceof CalendarDate && b instanceof CalendarDate && a.days === b.days;
  }
  if (a instanceof DateTime || b instanceof DateTime) {
    return (
      a instanceof DateTime &&
      b instanceof DateTime &&
      a.seconds === b.seconds &&
      a.nanoseconds === b.nanoseconds &&
      a.zone === b.zone &&
      a.offsetMinutes === b.offsetMinutes
    );
  }
  if (a instanceof TimeOfDay || b instanceof TimeOfDay) {
    return a instanceof TimeOfDay && b instanceof TimeOfDay && a.nanoseconds === b.nanoseconds;
  }
  if (a instanceof Duration || b instanceof Duration) {
    return (
      a instanceof Duration &&
      b instanceof Duration &&
      a.months === b.months &&
      a.days === b.days &&
      a.seconds === b.seconds &&
      a.nanoseconds === b.nanoseconds
    );
  }
  if (a instanceof BigInteger || b instanceof BigInteger) {
    return a instanceof BigInteger && b instanceof BigInteger && a.value === b.value;
  }
  if (a instanceof Decimal || b instanceof Decimal) {
    return (
      a instanceof Decimal &&
      b instanceof Decimal &&
      a.coefficient === b.coefficient &&
      a.scale === b.scale
    );
  }
  if (a instanceof Bytes || b instanceof Bytes) {
    return (
      a instanceof Bytes &&
      b instanceof Bytes &&
      compareBytes(a.toUint8Array(), b.toUint8Array()) === 0
    );
  }
  if (a instanceof Reference || b instanceof Reference) {
    return a instanceof Reference && b instanceof Reference && a.id === b.id;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as readonly Value[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], bb[i])) return false;
    return true;
  }
  const ao = a as { readonly [key: string]: Value };
  const bo = b as { readonly [key: string]: Value };
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  for (const k of ak) {
    if (Object.getOwnPropertyDescriptor(bo, k) === undefined || !sameValue(ao[k], bo[k])) {
      return false;
    }
  }
  return true;
}

/** The names of the objects of the JSON form of values */
const JSON_TAGS = new Set([
  '$number',
  '$integer',
  '$decimal',
  '$bytes',
  '$date',
  '$time',
  '$datetime',
  '$duration',
  '$reference',
  '$object',
]);

/** The texts of the numbers JSON cannot write */
const NOT_FINITE = new Map<string, number>([
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['-0', -0],
]);

const BIG_INTEGER = /^-?[1-9]\d*$/;

/**
 * The JSON form of a value, a tree that `JSON.stringify` writes without losing anything: the
 * kinds JSON has not as their tags (`{"$date": "2026-10-16"}`), the numbers JSON cannot write as
 * `$number` (`{"$number": "NaN"}`), and an object whose one key is the name of a tag wrapped as
 * `{"$object": ...}`
 */
export function valueToJSON(value: Value): unknown {
  if (typeof value === 'number') {
    // A float64 integer outside the safe range: its digits would read as a big integer
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      return { $number: String(value) };
    }
    return Object.is(value, -0) ? { $number: '-0' } : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (isKindValue(value)) return (value as { toJSON(): unknown }).toJSON();
  if (Array.isArray(value)) return value.map((x: Value) => valueToJSON(x));
  const o = value as { readonly [key: string]: Value };
  const out: Record<string, unknown> = {};
  const keys = Object.keys(o);
  for (const k of keys) setOwnProperty(out, k, valueToJSON(o[k]));
  return keys.length === 1 && JSON_TAGS.has(keys[0]) ? { $object: out } : out;
}

/** The value of one tag of the JSON form, or undefined when the object is not one */
function tagValue(tag: string, x: unknown): Value | undefined {
  if (typeof x !== 'string') {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) return undefined;
    // The members of a duration of both signs
    if (tag === '$duration') return durationOfMembers(x as Record<string, unknown>);
    // A reference with members after its id, of a later version
    if (tag === '$reference') throw invalid('A reference with members is not read');
    return undefined;
  }
  switch (tag) {
    case '$number': {
      const known = NOT_FINITE.get(x);
      if (known !== undefined) return known;
      // One text per number: a float64 integer outside the safe range as ECMAScript writes it
      const n = Number(x);
      if (Number.isInteger(n) && !Number.isSafeInteger(n) && String(n) === x) return n;
      throw invalid(`Not the text of a number JSON cannot write: ${x}`);
    }
    case '$integer':
      if (!BIG_INTEGER.test(x)) throw invalid(`Not a big integer: ${x}`);
      return new BigInteger(BigInt(x));
    case '$decimal':
      return Decimal.parse(x);
    case '$bytes':
      return new Bytes(fromBase64(x));
    case '$date':
      return CalendarDate.parse(x);
    case '$time':
      return TimeOfDay.parse(x);
    case '$datetime':
      return DateTime.parse(x);
    case '$duration':
      return Duration.parse(x);
    case '$reference':
      return new Reference(x);
    default:
      return undefined;
  }
}

/**
 * The value of its JSON form ({@link valueToJSON}). Applied to any JSON, it changes only those
 * forms; a value of a kind in the tree (a big integer read by {@link parseValueJSON}) stays as
 * it is
 *
 * @throws DrawError (`invalid-input`) when a tag holds a text that is not one of its kind (a date
 *   that is not a day, a big integer that is a number), or the tree holds what is not JSON
 */
export function valueFromJSON(json: unknown): Value {
  return fromJSONAt(json, 0);
}

function fromJSONAt(j: unknown, depth: number): Value {
  if (j === null || typeof j !== 'object') {
    if (j === undefined || typeof j === 'function' || typeof j === 'symbol') {
      throw invalid(`A ${typeof j} is not JSON`);
    }
    return valueOfInput(j, 'A value of JSON');
  }
  if (isKindValue(j)) return ownKindValue(j);
  if (depth >= MAX_VALUE_DEPTH) throw invalid('A value nested deeper than 32');
  if (Array.isArray(j)) return j.map((x) => fromJSONAt(x, depth + 1));
  const o = j as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1) {
    const x = o[keys[0]];
    if (keys[0] === '$object' && x !== null && typeof x === 'object' && !Array.isArray(x)) {
      const inner: Record<string, Value> = {};
      for (const k of Object.keys(x)) {
        setOwnProperty(inner, k, fromJSONAt((x as Record<string, unknown>)[k], depth + 1));
      }
      return inner;
    }
    const v = tagValue(keys[0], x);
    if (v !== undefined) return v;
  }
  const out: Record<string, Value> = {};
  for (const k of keys) setOwnProperty(out, k, fromJSONAt(o[k], depth + 1));
  return out;
}

/**
 * Reads the text of JSON into a tree of JSON, keeping an integer written without a fraction or an
 * exponent outside -(2^53 - 1) to 2^53 - 1 as it is written: a {@link BigInteger} from -2^63 to
 * 2^64 - 1, beyond that a {@link Decimal} of the scale 0. Every other number is a float64, and an
 * object key `__proto__` is an own key, as `JSON.parse` reads them
 *
 * @throws DrawError (`invalid-input`) when the text is not JSON
 * @internal
 */
export function parseJSONKeepingIntegers(text: string): unknown {
  // Without a run of 16 digits, no integer is outside the safe range: JSON.parse reads it
  if (!/\d{16}/.test(text)) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error));
    }
  }
  return new JsonReader(text).document();
}

/** The integer of the digits of a JSON number outside the safe range, as a value */
function integerOfDigits(digits: string): Value {
  const n = BigInt(digits);
  if (n >= -MAX_SAFE && n <= MAX_SAFE) return Number(n);
  if (n >= MIN_BIG_INTEGER && n <= MAX_BIG_INTEGER) return new BigInteger(n);
  return new Decimal(n, 0);
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** A reader of the text of JSON that keeps the integers outside the safe range */
class JsonReader {
  at = 0;

  constructor(readonly text: string) {}

  document(): unknown {
    const v = this.value(0);
    this.space();
    if (this.at !== this.text.length) this.fail('text left over');
    return v;
  }

  fail(what: string): never {
    throw invalid(`Not JSON at ${this.at}: ${what}`);
  }

  space(): void {
    const t = this.text;
    while (this.at < t.length) {
      const c = t.charCodeAt(this.at);
      if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) return;
      this.at++;
    }
  }

  value(depth: number): unknown {
    if (depth > 512) this.fail('nested too deep');
    this.space();
    const t = this.text;
    const c = t[this.at];
    if (c === '{') {
      this.at++;
      const out: Record<string, unknown> = {};
      this.space();
      if (t[this.at] === '}') {
        this.at++;
        return out;
      }
      for (;;) {
        this.space();
        if (t[this.at] !== '"') this.fail('a key');
        const key = this.string();
        this.space();
        if (t[this.at] !== ':') this.fail('a colon');
        this.at++;
        setOwnProperty(out, key, this.value(depth + 1));
        this.space();
        if (t[this.at] === ',') {
          this.at++;
          continue;
        }
        if (t[this.at] === '}') {
          this.at++;
          return out;
        }
        this.fail('a comma or the end of an object');
      }
    }
    if (c === '[') {
      this.at++;
      const out: unknown[] = [];
      this.space();
      if (t[this.at] === ']') {
        this.at++;
        return out;
      }
      for (;;) {
        out.push(this.value(depth + 1));
        this.space();
        if (t[this.at] === ',') {
          this.at++;
          continue;
        }
        if (t[this.at] === ']') {
          this.at++;
          return out;
        }
        this.fail('a comma or the end of an array');
      }
    }
    if (c === '"') return this.string();
    if (t.startsWith('true', this.at)) {
      this.at += 4;
      return true;
    }
    if (t.startsWith('false', this.at)) {
      this.at += 5;
      return false;
    }
    if (t.startsWith('null', this.at)) {
      this.at += 4;
      return null;
    }
    NUMBER.lastIndex = this.at;
    const m = NUMBER.exec(t);
    if (!m) this.fail('a value');
    this.at += m[0].length;
    const text = m[0];
    if (/^-?\d+$/.test(text) && text.replace('-', '').length >= 16) return integerOfDigits(text);
    return Number(text);
  }

  string(): string {
    const t = this.text;
    this.at++;
    let out = '';
    for (;;) {
      // The characters up to a quote, a backslash or a control character
      let end = this.at;
      while (end < t.length) {
        const code = t.charCodeAt(end);
        if (code === 0x22 || code === 0x5c || code < 0x20) break;
        end++;
      }
      out += t.slice(this.at, end);
      this.at = end;
      const c = t[this.at];
      if (c === '"') {
        this.at++;
        return out;
      }
      if (c !== '\\') this.fail('the end of a string');
      const e = t[this.at + 1];
      this.at += 2;
      switch (e) {
        case '"':
        case '\\':
        case '/':
          out += e;
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'u': {
          const hex = t.slice(this.at, this.at + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('an escape');
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.at += 4;
          break;
        }
        default:
          this.fail('an escape');
      }
    }
  }
}

/**
 * Reads a value from the text of its JSON form ({@link stringifyValueJSON}): the tags, and an
 * integer outside -(2^53 - 1) to 2^53 - 1 written without a fraction or an exponent as a
 * {@link BigInteger} (beyond 64 bits, a {@link Decimal} of the scale 0) rather than a rounded
 * number
 *
 * @throws DrawError (`invalid-input`) when the text is not JSON, or not the JSON form of a value
 */
export function parseValueJSON(text: string): Value {
  return valueFromJSON(parseJSONKeepingIntegers(text));
}

/**
 * The text of the JSON form of a value. Unlike `JSON.stringify` of a value, which writes NaN and
 * the infinities as null and -0 as 0, it loses nothing: {@link parseValueJSON} reads it back as
 * the same value
 */
export function stringifyValueJSON(value: Value): string {
  return JSON.stringify(valueToJSON(value));
}

/**
 * A value with its references rewritten by a map of ids, at any depth: a reference to an id of
 * the map names the new id, any other reference stays as it is. The value itself when it has no
 * reference to rewrite
 *
 * Use it where records take new ids (a copy pasted, a document read again), so that the
 * references between the copies name the copies.
 *
 * @param value - The value
 * @param ids - The new id of each id, by the id before
 */
export function rewriteReferences(value: Value, ids: Readonly<Record<string, string>>): Value {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Reference) {
    const to = Object.getOwnPropertyDescriptor(ids, value.id)?.value as string | undefined;
    return to === undefined ? value : new Reference(to);
  }
  if (isKindValue(value)) return value;
  if (Array.isArray(value)) {
    let out: Value[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const x = rewriteReferences(value[i], ids);
      if (x !== value[i]) {
        out ??= value.slice();
        out[i] = x;
      }
    }
    return out ?? value;
  }
  const o = value as { readonly [key: string]: Value };
  let out: Record<string, Value> | null = null;
  for (const k of Object.keys(o)) {
    const x = rewriteReferences(o[k], ids);
    if (x !== o[k]) {
      if (out === null) {
        out = {};
        for (const j of Object.keys(o)) setOwnProperty(out, j, o[j]);
      }
      setOwnProperty(out, k, x);
    }
  }
  return out ?? value;
}
