// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The classes of the kinds of values that JSON has not: big integers, decimals, bytes, dates,
 * times, date-times, durations and references
 *
 * Each class makes values that do not change once made (they are frozen), and gives its JSON
 * form from `toJSON()` (the tags of `value.ts`), so that `JSON.stringify` of a feature never
 * throws.
 *
 * Every class is marked with the name of its kind under the symbol `Symbol.for('value.kind')`,
 * and its `instanceof` reads that mark: the values of another implementation of the same kinds,
 * with the same members and the same mark, are taken as values of these classes.
 *
 * - A big integer is an integer outside -(2^53 - 1) to 2^53 - 1, from -2^63 to 2^64 - 1. An
 *   integer inside that range is a number, never a big integer
 * - A decimal is a coefficient (an integer of at most 76 digits) and a scale (0 to 76): 1.10 and
 *   1.1 are two values
 * - A date is a day of the proleptic Gregorian calendar, without a time or a zone: the number of
 *   days since 1970-01-01. Its text is `YYYY-MM-DD` (a year outside 0000 to 9999 is written
 *   with a sign and at least 6 digits: `-000044-03-15`)
 * - A time is a time of a day, without a date or a zone: the nanoseconds since midnight. Its
 *   text is `HH:MM:SS`, then `.` and the digits of the nanoseconds without the zeros at their end
 *   when they are not 0
 * - A date-time is a date and a time: the seconds since 1970-01-01T00:00:00 (rounded down) and
 *   the nanoseconds within the second, local (the time of a wall clock, not an instant), UTC, or
 *   with the offset from UTC in minutes of its source. Its text is the date, `T`, the time, then
 *   nothing, `Z` or `+HH:MM` / `-HH:MM`
 * - A duration is months, days, seconds and the nanoseconds within the second. Its text is the
 *   duration of ISO 8601 (`P1M2DT3.5S`)
 * - A reference names a record of the document (a feature, a group, a layer) by its id
 *
 * A pure module: it depends on nothing outside `/table` and `/shared`, so it runs in a Worker as
 * well.
 */

import { DrawError } from '../shared/draw-error.js';

function invalid(message: string): DrawError {
  return new DrawError('invalid-input', message);
}

/** The symbol whose property names the kind of the class of a value */
export const VALUE_KIND: unique symbol = Symbol.for('value.kind') as typeof VALUE_KIND;

/** Marks the class of a kind of value with the name of its kind */
export function markKind(cls: { prototype: object }, kind: string): void {
  Object.defineProperty(cls.prototype, VALUE_KIND, { value: kind });
}

/** Whether something is an instance of a class marked with a kind */
export function hasKind(v: unknown, kind: string): boolean {
  return (
    typeof v === 'object' && v !== null && (v as { [VALUE_KIND]?: unknown })[VALUE_KIND] === kind
  );
}

/** The names of the kinds of the classes of values */
export type ValueKindName =
  | 'integer'
  | 'decimal'
  | 'bytes'
  | 'date'
  | 'time'
  | 'datetime'
  | 'duration'
  | 'reference';

const KIND_NAMES: ReadonlySet<unknown> = new Set<ValueKindName>([
  'integer',
  'decimal',
  'bytes',
  'date',
  'time',
  'datetime',
  'duration',
  'reference',
]);

/**
 * The kind of an object that is an instance of a class of a kind of value (one read of its mark,
 * where `instanceof` asks each class in turn), or undefined
 */
export function kindOf(v: object): ValueKindName | undefined {
  const kind = (v as { [VALUE_KIND]?: unknown })[VALUE_KIND];
  return kind !== undefined && KIND_NAMES.has(kind) ? (kind as ValueKindName) : undefined;
}

/** The largest integer a number holds exactly (2^53 - 1), as a bigint */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
/** The smallest big integer (-2^63) */
export const MIN_BIG_INTEGER = -(2n ** 63n);
/** The largest big integer (2^64 - 1) */
export const MAX_BIG_INTEGER = 2n ** 64n - 1n;

/**
 * An integer outside -(2^53 - 1) to 2^53 - 1, from -2^63 to 2^64 - 1: an integer a number cannot
 * hold exactly. An integer inside that range is a number, never a big integer
 */
export class BigInteger {
  /** The integer */
  readonly value: bigint;

  /**
   * @param value - The integer
   * @throws DrawError (`invalid-input`) when it is not a bigint, is from -(2^53 - 1) to
   *   2^53 - 1 (a number) or is outside -2^63 to 2^64 - 1
   */
  constructor(value: bigint) {
    if (typeof value !== 'bigint') throw invalid(`not a bigint: ${String(value)}`);
    if (value >= -MAX_SAFE && value <= MAX_SAFE) {
      throw invalid(`${value} is a number, not a big integer`);
    }
    if (value < MIN_BIG_INTEGER || value > MAX_BIG_INTEGER) {
      throw invalid(`${value} is outside -2^63 to 2^64 - 1`);
    }
    this.value = value;
    Object.freeze(this);
  }

  static [Symbol.hasInstance](v: unknown): boolean {
    return hasKind(v, 'integer');
  }

  /** Its digits in base 10 */
  toString(): string {
    return this.value.toString();
  }

  /** The JSON form of the value */
  toJSON(): { $integer: string } {
    return { $integer: this.toString() };
  }
}
markKind(BigInteger, 'integer');

/** The largest scale of a decimal */
export const MAX_DECIMAL_SCALE = 76;
/** The first coefficient a decimal cannot have (10^76) */
const DECIMAL_LIMIT = 10n ** 76n;

const DECIMAL = /^(-)?(0|[1-9]\d*)(?:\.(\d+))?$/;

/**
 * A number of base 10 with a scale: the coefficient (an integer of at most 76 digits) and the
 * scale (the digits after the point, 0 to 76). 1.10 (110, 2) and 1.1 (11, 1) are two values
 */
export class Decimal {
  /** The coefficient: the digits as an integer */
  readonly coefficient: bigint;
  /** The scale: the number of the digits after the point */
  readonly scale: number;

  /**
   * @param coefficient - The digits as an integer, at most 76 of them
   * @param scale - The number of the digits after the point, 0 to 76
   * @throws DrawError (`invalid-input`) when one of them is out of its range
   */
  constructor(coefficient: bigint, scale: number) {
    if (typeof coefficient !== 'bigint') throw invalid(`not a bigint: ${String(coefficient)}`);
    if (coefficient <= -DECIMAL_LIMIT || coefficient >= DECIMAL_LIMIT) {
      throw invalid('a coefficient of more than 76 digits');
    }
    if (!Number.isInteger(scale) || scale < 0 || scale > MAX_DECIMAL_SCALE) {
      throw invalid(`not a scale: ${scale}`);
    }
    this.coefficient = coefficient;
    this.scale = scale;
    Object.freeze(this);
  }

  static [Symbol.hasInstance](v: unknown): boolean {
    return hasKind(v, 'decimal');
  }

  /**
   * A decimal from its text: digits with `-` when negative and `.` before the digits of the
   * scale (`123.45`, `-0.50`, `100`), without an exponent
   */
  static parse(text: string): Decimal {
    const m = DECIMAL.exec(text);
    if (!m) throw invalid(`not a decimal: ${text}`);
    const fraction = m[3] ?? '';
    const magnitude = BigInt(m[2] + fraction);
    if (m[1] && magnitude === 0n) throw invalid(`the decimal -0: ${text}`);
    return new Decimal(m[1] ? -magnitude : magnitude, fraction.length);
  }

  /** Its text, with the zeros of its scale (`1.10`) */
  toString(): string {
    const negative = this.coefficient < 0n;
    let digits = (negative ? -this.coefficient : this.coefficient).toString();
    if (this.scale > 0) {
      digits = digits.padStart(this.scale + 1, '0');
      const at = digits.length - this.scale;
      digits = `${digits.slice(0, at)}.${digits.slice(at)}`;
    }
    return negative ? `-${digits}` : digits;
  }

  /** The JSON form of the value */
  toJSON(): { $decimal: string } {
    return { $decimal: this.toString() };
  }
}
markKind(Decimal, 'decimal');

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_INDEX = new Map([...BASE64].map((c, i) => [c, i]));

/** The base64 of bytes (RFC 4648, with the padding) */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64[a >> 2] + BASE64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? BASE64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? BASE64[c & 63] : '=';
  }
  return out;
}

/** The bytes of a base64 (RFC 4648, with the padding); any other form is refused */
export function fromBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0) throw invalid('a base64 whose length is not a multiple of 4');
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let at = 0;
  for (let i = 0; i < text.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const c = text[i + k];
      const last = i + 4 === text.length;
      const v = c === '=' && last && k >= 4 - pad ? 0 : BASE64_INDEX.get(c);
      if (v === undefined) throw invalid(`not a base64: ${text}`);
      n = n * 64 + v;
    }
    const three = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    for (const b of three) if (at < out.length) out[at++] = b;
  }
  // One text per bytes: the bits after the last byte are 0
  if (toBase64(out) !== text) throw invalid(`not the base64 of its bytes: ${text}`);
  return out;
}

/** Any run of bytes, as a value: it does not change once made */
export class Bytes {
  readonly #bytes: Uint8Array;

  /**
   * @param bytes - The bytes, copied
   * @throws DrawError (`invalid-input`) when they are not a Uint8Array
   */
  constructor(bytes: Uint8Array) {
    if (!(bytes instanceof Uint8Array)) throw invalid('not a Uint8Array');
    this.#bytes = bytes.slice();
    Object.freeze(this);
  }

  static [Symbol.hasInstance](v: unknown): boolean {
    return hasKind(v, 'bytes');
  }

  /** A copy of the bytes */
  toUint8Array(): Uint8Array {
    return this.#bytes.slice();
  }

  /** The base64 of the bytes (RFC 4648, with the padding) */
  toString(): string {
    return toBase64(this.#bytes);
  }

  /** The JSON form of the value */
  toJSON(): { $bytes: string } {
    return { $bytes: this.toString() };
  }
}
markKind(Bytes, 'bytes');

/** Whether a string is well-formed Unicode (no lone surrogate) */
export function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * A value that names a record of the document by its id. It stays a value when the record is
 * deleted or not there; a reference is not the string of its id
 */
export class Reference {
  /** The id of the record */
  readonly id: string;

  /**
   * @param id - The id of the record
   * @throws DrawError (`invalid-input`) when it is not a string of one or more characters of
   *   well-formed Unicode
   */
  constructor(id: string) {
    if (typeof id !== 'string' || id.length === 0 || !wellFormed(id)) {
      throw invalid(`not the id of a reference: ${String(id)}`);
    }
    this.id = id;
    Object.freeze(this);
  }

  static [Symbol.hasInstance](v: unknown): boolean {
    return hasKind(v, 'reference');
  }

  /** The id */
  toString(): string {
    return this.id;
  }

  /** The JSON form of the value */
  toJSON(): { $reference: string } {
    return { $reference: this.id };
  }
}
markKind(Reference, 'reference');

/** The largest offset from UTC, in minutes (23:59) */
export const MAX_OFFSET = 1439;

/** The first and the last day of a date (the days of a 32-bit signed integer) */
const MIN_DAYS = -(2 ** 31);
const MAX_DAYS = 2 ** 31 - 1;
/** The nanoseconds of a second, and of a day */
const SECOND_NANOSECONDS = 1_000_000_000;
const DAY_NANOSECONDS = 86_400 * SECOND_NANOSECONDS;
/**
 * The seconds of the first and the last date-time: the instant in microseconds is a 64-bit
 * signed integer, from -9,223,372,036,854,775,808 to 9,223,372,036,854,775,807
 */
const MIN_SECONDS = -9_223_372_036_855;
const MIN_SECONDS_NANOSECONDS = 224_192_000;
const MAX_SECONDS = 9_223_372_036_854;
const MAX_SECONDS_NANOSECONDS = 775_807_999;
/** The range of the months and the days of a duration (32-bit signed integers) */
const MIN_INT32 = -(2 ** 31);
const MAX_INT32 = 2 ** 31 - 1;

/** The days since 1970-01-01 of a day of the proleptic Gregorian calendar */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The day of the proleptic Gregorian calendar of a number of days since 1970-01-01 */
export function civilFromDays(days: number): { y: number; m: number; d: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function yearText(y: number): string {
  if (y >= 0 && y <= 9999) return pad(y, 4);
  return (y < 0 ? '-' : '+') + pad(Math.abs(y), 6);
}

/** The digits of nanoseconds after a point, without the zeros at their end ('' for 0) */
function fractionText(nanoseconds: number): string {
  if (nanoseconds === 0) return '';
  return `.${pad(nanoseconds, 9).replace(/0+$/, '')}`;
}

/** The nanoseconds of the digits of a fraction (1 to 9 of them) */
function fractionNanoseconds(digits: string | undefined): number {
  return digits ? Number(digits.padEnd(9, '0')) : 0;
}

const DATE = /^([+-]\d{6,}|\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/;
const DATE_TIME =
  /^([+-]\d{6,}|\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/;
const DURATION =
  /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d{1,9}))?S)?)?$/;

function parseDay(ys: string, ms: string, ds: string): number {
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  if (ys[0] === '-' && y === 0) throw invalid('the year -0');
  if (m < 1 || m > 12 || d < 1) throw invalid(`no day ${ys}-${ms}-${ds}`);
  const days = daysFromCivil(y, m, d);
  const back = civilFromDays(days);
  if (back.m !== m || back.d !== d) throw invalid(`no day ${ys}-${ms}-${ds}`);
  return days;
}

function timeNanoseconds(hs: string, ms: string, ss: string, fraction: string | undefined): number {
  const [h, m, s] = [Number(hs), Number(ms), Number(ss)];
  if (h > 23 || m > 59 || s > 59) throw invalid(`not a time: ${hs}:${ms}:${ss}`);
  return (h * 3600 + m * 60 + s) * SECOND_NANOSECONDS + fractionNanoseconds(fraction);
}

function timeText(secondsOfDay: number, nanoseconds: number): string {
  const h = Math.floor(secondsOfDay / 3600);
  const m = Math.floor((secondsOfDay % 3600) / 60);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(secondsOfDay % 60, 2)}${fractionText(nanoseconds)}`;
}

/** A day of the calendar, without a time or a zone */
export class CalendarDate {
  /** The days since 1970-01-01 */
  readonly days: number;

  /**
   * @param days - The days since 1970-01-01, from -2^31 to 2^31 - 1
   * @throws DrawError (`invalid-input`) when it is not such an integer
   */
  constructor(days: number) {
    if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
      throw invalid(`not a day: ${days}`);
    }
    this.days = days;
    Object.freeze(this);
  }

  static [Symbol.hasInstance](v: unknown): boolean {
    return hasKind(v, 'date');
  }

  /** The date of a year, a month (1 to 12) and a day of the month (1 to 31) */
  static of(year: number, month: number, day: number): CalendarDate {
    if (
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      !Number.isInteger(day) ||
      month < 1 ||
      month > 12 ||
      day < 1
    ) {
      throw invalid(`no day ${year}-${month}-${day}`);
    }
    const days = daysFromCivil(year, month, day);
    const back = civilFromDays(days);
    if (back.m !== month || back.d !== day) throw invalid(`no day ${year}-${month}-${day}`);
    return new CalendarDate(days);
  }

  /** A date from its text `YYYY-MM-DD` */
  static parse(text: string): CalendarDate {
    const m = DATE.exec(text);
    if (!m) throw invalid(`not a date: ${text}`);
    return new CalendarDate(parseDay(m[1], m[2], m[3]));
  }

  /** The year */
  get year(): number {
    return civilFromDays(this.days).y;
  }

  /** The month, 1 to 12 */
  get month(): number {
    return civilFromDays(this.days).m;
  }

  /** The day of the month, 1 to 31 */
  get day(): number {
    return civilFromDays(this.days).d;
  }

  /** Its text `YYYY-MM-DD` */
  toString(): string {
    const { y, m, d } = civilFromDays(this.days);
    return `${yearText(y)}-${pad(m, 2)}-${pad(d, 2)}`;
  }

  /** The JSON form of the value */
  toJSON(): { $date: string } {
    return { $date: this.toString() };
  }
}
markKind(CalendarDate, 'date');

/** A time of a day, without a date or a zone */
export class TimeOfDay {
  /** The nanoseconds since midnight */
  readonly nanoseconds: number;

  /**
   * @param nanoseconds - The nanoseconds since midnight, 0 to 86,399,999,999,999
   * @throws DrawError (`invalid-input`) when it is not such an integer
   */
  constructor(nanoseconds: number) {
    if (!Number.isInteger(nanoseconds) || nanoseconds < 0 || nanoseconds >= DAY_NANOSECONDS) {
      throw invalid(`not a time: ${nanoseconds}`);
    }
    this.nanoseconds = nanoseconds;
    Object.freeze(this);
  }

  static [Symbol.hasInstance](v: unknown): boolean {
    return hasKind(v, 'time');
  }

  /** A time from its text `HH:MM:SS`, with 1 to 9 digits of a fraction */
  static parse(text: string): TimeOfDay {
    const m = TIME.exec(text);
    if (!m) throw invalid(`not a time: ${text}`);
    return new TimeOfDay(timeNanoseconds(m[1], m[2], m[3], m[4]));
  }

  /** The hour, 0 to 23 */
  get hour(): number {
    return Math.floor(this.nanoseconds / (3600 * SECOND_NANOSECONDS));
  }

  /** The minute, 0 to 59 */
  get minute(): number {
    return Math.floor(this.nanoseconds / (60 * SECOND_NANOSECONDS)) % 60;
  }

  /** The second, 0 to 59 */
  get second(): number {
    return Math.floor(this.nanoseconds / SECOND_NANOSECONDS) % 60;
  }

  /** The nanoseconds within the second, 0 to 999,999,999 */
  get nanosecond(): number {
    return this.nanoseconds % SECOND_NANOSECONDS;
  }

  /** Its text `HH:MM:SS`, with the digits of the nanoseconds when they are not 0 */
  toString(): string {
    return timeText(Math.floor(this.nanoseconds / SECOND_NANOSECONDS), this.nanosecond);
  }

  /** The JSON form of the value */
  toJSON(): { $time: string } {
    return { $time: this.toString() };
  }
}
markKind(TimeOfDay, 'time');

/**
 * The zone of a date-time: `local` (the time of a wall clock, not an instant), `utc` (an instant)
 * or `offset` (an instant with the offset from UTC of its source)
 */
export type DateTimeZone = 'local' | 'utc' | 'offset';

/** A date and a time, local, UTC or with an offset */
export class DateTime {
  /**
   * The seconds since 1970-01-01T00:00:00, rounded down: of UTC for an instant, of the wall clock
   * for a local date-time
   */
  readonly seconds: number;
  /** The nanoseconds within the second, 0 to 999,999,999 */
  readonly nanoseconds: number;
  /** The zone */
  readonly zone: DateTimeZone;
  /** The offset from UTC in minutes, -1439 to 1439, of the zone `offset` (0 for the others) */
  readonly offsetMinutes: number;

  /**
   * @param seconds - The seconds since 1970-01-01T00:00:00, rounded down
   * @param nanoseconds - The nanoseconds within the second, 0 to 999,999,999
   * @param zone - The zone (`utc` when omitted)
   * @param offsetMinutes - The offset from UTC in minutes, of the zone `offset` only
   * @throws DrawError (`invalid-input`) when one of them is out of its range, or the instant
   *   in microseconds is not a 64-bit signed integer
   */
  constructor(seconds: number, nanoseconds = 0, zone: DateTimeZone = 'utc', offsetMinutes = 0) {
    if (!Number.isInteger(seconds)) throw invalid(`not seconds: ${seconds}`);
    if (!Number.isInteger(nanoseconds) || nanoseconds < 0 || nanoseconds >= SECOND_NANOSECONDS) {
      throw invalid(`not nanoseconds of a second: ${nanoseconds}`);
    }
    if (
      seconds < MIN_SECONDS ||
      (seconds === MIN_SECONDS && nanoseconds < MIN_SECONDS_NANOSECONDS) ||
      seconds > MAX_SECONDS ||
      (seconds === MAX_SECONDS && nanoseconds > MAX_SECONDS_NANOSECONDS)
    ) {
      throw invalid(`a date-time out of its range: ${seconds}`);
    }
    if (zone !== 'local' && zone !== 'utc' && zone !== 'offset') {
      throw invalid(`not a zone: ${String(zone)}`);
    }
    if (zone === 'offset') {
      if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > MAX_OFFSET) {
        throw invalid(`not an offset: ${offsetMinutes}`);
      }
    } else if (offsetMinutes !== 0) {
      throw invalid(`an offset of a date-time of the zone ${zone}`);
    }
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
    this.zone = zone;
    // -0 and 0 are one offset
    this.offsetMinutes = offsetMinutes === 0 ? 0 : offsetMinutes;
    Object.freeze(this);
  }

  static [Symbol.hasInstance](v: unknown): boolean {
    return hasKind(v, 'datetime');
  }

  /**
   * A date-time from its text: `YYYY-MM-DDTHH:MM:SS` with 1 to 9 digits of a fraction, then
   * nothing (local), `Z` (UTC) or `+HH:MM` / `-HH:MM` (an offset)
   */
  static parse(text: string): DateTime {
    const m = DATE_TIME.exec(text);
    if (!m) throw invalid(`not a date-time: ${text}`);
    const days = parseDay(m[1], m[2], m[3]);
    const nanosecondsOfDay = timeNanoseconds(m[4], m[5], m[6], m[7]);
    const local = days * 86400 + Math.floor(nanosecondsOfDay / SECOND_NANOSECONDS);
    const nanoseconds = nanosecondsOfDay % SECOND_NANOSECONDS;
    if (m[8] === undefined) return new DateTime(local, nanoseconds, 'local');
    if (m[8] === 'Z') return new DateTime(local, nanoseconds, 'utc');
    const sign = m[8][0] === '-' ? -1 : 1;
    const oh = Number(m[8].slice(1, 3));
    const om = Number(m[8].slice(4, 6));
    if (om > 59) throw invalid(`not an offset: ${text}`);
    const offset = sign * (oh * 60 + om);
    return new DateTime(local - offset * 60, nanoseconds, 'offset', offset);
  }

  /** The UTC date-time of the instant of a `Date` */
  static fromDate(date: Date): DateTime {
    if (!(date instanceof Date)) throw invalid('not a Date');
    const time = date.getTime();
    if (Number.isNaN(time)) throw invalid('a Date that is not a time');
    const seconds = Math.floor(time / 1000);
    return new DateTime(seconds, (time - seconds * 1000) * 1_000_000, 'utc');
  }

  /**
   * The `Date` of the date-time, cut to the millisecond (the nanoseconds below a millisecond are
   * dropped). A local date-time gives the `Date` whose UTC fields are its wall clock
   */
  toDate(): Date {
    return new Date(this.seconds * 1000 + Math.floor(this.nanoseconds / 1_000_000));
  }

  /** Its text: the date and the time of its zone, then nothing, `Z` or the offset */
  toString(): string {
    const local = this.seconds + this.offsetMinutes * 60;
    const days = Math.floor(local / 86400);
    const { y, m, d } = civilFromDays(days);
    const time = timeText(local - days * 86400, this.nanoseconds);
    let zone = '';
    if (this.zone === 'utc') zone = 'Z';
    else if (this.zone === 'offset') {
      const a = Math.abs(this.offsetMinutes);
      zone = `${this.offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(a / 60), 2)}:${pad(a % 60, 2)}`;
    }
    return `${yearText(y)}-${pad(m, 2)}-${pad(d, 2)}T${time}${zone}`;
  }

  /** The JSON form of the value */
  toJSON(): { $datetime: string } {
    return { $datetime: this.toString() };
  }
}
markKind(DateTime, 'datetime');

/** The members of a duration */
interface DurationMembers {
  months: number;
  days: number;
  seconds: number;
  nanoseconds: number;
}

/**
 * A length of time: months, days, seconds and the nanoseconds within the second, each signed.
 * Months and days are kept apart from the seconds, since their length depends on the calendar
 */
export class Duration {
  /** The months, from -2^31 to 2^31 - 1 */
  readonly months: number;
  /** The days, from -2^31 to 2^31 - 1 */
  readonly days: number;
  /** The seconds, from -(2^53 - 1) to 2^53 - 1 */
  readonly seconds: number;
  /** The nanoseconds within the second, -999,999,999 to 999,999,999, of the sign of the seconds */
  readonly nanoseconds: number;

  /**
   * @throws DrawError (`invalid-input`) when one of them is out of its range, or the seconds
   *   and the nanoseconds have two signs
   */
  constructor(months: number, days: number, seconds: number, nanoseconds = 0) {
    for (const [name, v] of [
      ['months', months],
      ['days', days],
    ] as const) {
      if (!Number.isInteger(v) || v < MIN_INT32 || v > MAX_INT32) {
        throw invalid(`not ${name} of a duration: ${v}`);
      }
    }
    if (!Number.isSafeInteger(seconds)) throw invalid(`not seconds of a duration: ${seconds}`);
    if (!Number.isInteger(nanoseconds) || Math.abs(nanoseconds) >= SECOND_NANOSECONDS) {
      throw invalid(`not nanoseconds of a duration: ${nanoseconds}`);
    }
    if ((seconds > 0 && nanoseconds < 0) || (seconds < 0 && nanoseconds > 0)) {
      throw invalid('the seconds and the nanoseconds of a duration of two signs');
    }
    // -0 and 0 are one number of each
    this.months = months === 0 ? 0 : months;
    this.days = days === 0 ? 0 : days;
    this.seconds = seconds === 0 ? 0 : seconds;
    this.nanoseconds = nanoseconds === 0 ? 0 : nanoseconds;
    Object.freeze(this);
  }

  static [Symbol.hasInstance](v: unknown): boolean {
    return hasKind(v, 'duration');
  }

  /**
   * A duration from its text of ISO 8601: `P`, then years, months and days, and after `T` hours,
   * minutes and seconds (the seconds with 1 to 9 digits of a fraction), `-` before `P` for a
   * negative one (`P1Y2M3DT4H5M6.5S`, `-P1D`)
   */
  static parse(text: string): Duration {
    const m = DURATION.exec(text);
    if (!m || text.endsWith('P') || text.endsWith('T') || text === '-P') {
      throw invalid(`not a duration: ${text}`);
    }
    const n = (s: string | undefined): number => (s === undefined ? 0 : Number(s));
    const months = n(m[2]) * 12 + n(m[3]);
    const days = n(m[4]);
    const seconds = n(m[5]) * 3600 + n(m[6]) * 60 + n(m[7]);
    const nanoseconds = fractionNanoseconds(m[8]);
    if (!Number.isSafeInteger(months) || !Number.isSafeInteger(seconds)) {
      throw invalid(`a duration out of its range: ${text}`);
    }
    const sign = (v: number): number => (m[1] && v !== 0 ? -v : v);
    return new Duration(sign(months), sign(days), sign(seconds), sign(nanoseconds));
  }

  /**
   * Its text of ISO 8601 (`P1M2DT3.5S`, `-P1D`, `PT0S`). A duration with members of both signs
   * has no text in ISO 8601: its text then gives each part its own sign (`P1M-2D`), which
   * {@link Duration.parse} does not read
   */
  toString(): string {
    const negative =
      this.months <= 0 &&
      this.days <= 0 &&
      this.seconds <= 0 &&
      this.nanoseconds <= 0 &&
      (this.months < 0 || this.days < 0 || this.seconds < 0 || this.nanoseconds < 0);
    if (negative) {
      return `-${durationText(-this.months, -this.days, -this.seconds, -this.nanoseconds)}`;
    }
    return durationText(this.months, this.days, this.seconds, this.nanoseconds);
  }

  /** The JSON form of the value: its text, or its members when they have both signs */
  toJSON(): {
    $duration: string | { months: number; days: number; seconds: number; nanoseconds: number };
  } {
    if (mixedSigns(this)) {
      return {
        $duration: {
          months: this.months,
          days: this.days,
          seconds: this.seconds,
          nanoseconds: this.nanoseconds,
        },
      };
    }
    return { $duration: this.toString() };
  }
}
markKind(Duration, 'duration');

/** Whether the members of a duration have both signs (it has no text in ISO 8601) */
export function mixedSigns(d: DurationMembers): boolean {
  const all = [d.months, d.days, d.seconds + (d.nanoseconds !== 0 ? Math.sign(d.nanoseconds) : 0)];
  return all.some((v) => v > 0) && all.some((v) => v < 0);
}

function durationText(months: number, days: number, seconds: number, nanoseconds: number): string {
  const part = (v: number, unit: string): string => (v === 0 ? '' : `${v}${unit}`);
  const years = Math.trunc(months / 12);
  let date = part(years, 'Y') + part(months - years * 12, 'M') + part(days, 'D');
  const hours = Math.trunc(seconds / 3600);
  const minutes = Math.trunc((seconds - hours * 3600) / 60);
  const rest = seconds - hours * 3600 - minutes * 60;
  let time = part(hours, 'H') + part(minutes, 'M');
  if (rest !== 0 || nanoseconds !== 0) {
    const sign = rest < 0 || nanoseconds < 0 ? '-' : '';
    time += `${sign}${Math.abs(rest)}${fractionText(Math.abs(nanoseconds))}S`;
  }
  if (date === '' && time === '') return 'PT0S';
  if (time !== '') date += `T${time}`;
  return `P${date}`;
}

/** The members of the JSON form of a duration with both signs, read */
export function durationOfMembers(o: Readonly<Record<string, unknown>>): Duration {
  const keys = Object.keys(o).sort();
  if (keys.join(',') !== 'days,months,nanoseconds,seconds') {
    throw invalid('not the members of a duration');
  }
  const n = (k: string): number => {
    const v = o[k];
    if (typeof v !== 'number') throw invalid(`not the ${k} of a duration`);
    return v;
  };
  return new Duration(n('months'), n('days'), n('seconds'), n('nanoseconds'));
}
