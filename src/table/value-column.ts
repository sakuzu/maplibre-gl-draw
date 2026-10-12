// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A column of values of one attribute (`ValueColumn`)
 *
 * The attributes of the rows have no fixed type: one row holds a number under a key, the next a
 * string, a third nothing at all. A column holds them in typed arrays: the kind of each value
 * (absent, null, false, true, a number, a string, a nested value), the numbers, and the strings
 * and nested values in a dictionary of bytes that the rows refer to by index. A string is held
 * as its UTF-8 bytes and a nested value (an array or an object) as its canonical bytes
 * (`canonical-value.ts`); both become values of the engine only when they are read.
 *
 * A column has one of two forms, chosen for each key when the rows are built:
 *
 * - dense: one entry per row. Used when most rows hold the key
 * - sparse: one entry per row that holds the key, with the numbers of those rows. Data with many
 *   keys of which each row holds a few (a few hundred keys, a handful per row) would otherwise
 *   take an entry of every key on every row
 *
 * Absent (the row does not hold the key) and null (the row holds the key with the value null)
 * are different kinds, so a row reads back exactly as it was given.
 *
 * A pure module: it depends on nothing outside `/table`, so it runs in a Worker as well.
 */

import { decodeCanonicalValue, encodeCanonicalValue } from './canonical-value.js';
import { type Utf8Column, Utf8ColumnBuilder, utf8String } from './utf8-column.js';

/** The row does not hold the key */
export const VALUE_ABSENT = 0;
/** The value is null */
export const VALUE_NULL = 1;
/** The value is false */
export const VALUE_FALSE = 2;
/** The value is true */
export const VALUE_TRUE = 3;
/** The value is a number (in `numbers`) */
export const VALUE_NUMBER = 4;
/** The value is a string (its UTF-8 in `values`, at the index in `refs`) */
export const VALUE_STRING = 5;
/** The value is an array or an object (its canonical bytes in `values`, at the index in `refs`) */
export const VALUE_NESTED = 6;

/**
 * The lowest share of rows holding a key for which its column is dense
 *
 * A dense entry costs every row 1 byte of kind plus 8 bytes of a number or 4 of an index; a
 * sparse entry costs only the rows that hold the key, 4 more bytes each for the number of the
 * row. The share where they cross depends on the kinds of the values; this is the first
 * estimate, to be set from measured data.
 *
 * @internal
 */
export const DENSE_MIN_SHARE = 0.5;

/**
 * The column of the values of one attribute over the rows of a group
 *
 * The value of row `r`: in the dense form entry `r`; in the sparse form the entry `i` where
 * `rows[i] === r`, or absent when no entry names the row. An entry is `tags[i]`, with
 * `numbers[i]` for a number and `values` entry `refs[i]` for a string or a nested value.
 */
export interface ValueColumn {
  /** Whether every row has an entry (`dense`) or only the rows that hold the key (`sparse`) */
  readonly form: 'dense' | 'sparse';
  /** The number of rows of the group */
  readonly length: number;
  /** The rows of the entries, ascending (the sparse form; null for the dense form) */
  readonly rows: Int32Array | null;
  /** The kind of each entry (`VALUE_ABSENT` to `VALUE_NESTED`) */
  readonly tags: Uint8Array;
  /** The number of each entry of the kind `VALUE_NUMBER` (null when no entry is a number) */
  readonly numbers: Float64Array | null;
  /** The index in `values` of each string or nested entry (null when there is none) */
  readonly refs: Int32Array | null;
  /** The bytes of the strings and the nested values (null when there is none) */
  readonly values: Utf8Column | null;
}

/**
 * The attribute columns of a group: one {@link ValueColumn} per key
 */
export interface PropertyColumns {
  /** The keys, in the order of `columns` */
  readonly keys: readonly string[];
  /** The column of each key */
  readonly columns: readonly ValueColumn[];
}

/**
 * The entry of a row in a column, or -1 when the row has none (absent)
 *
 * @internal
 */
export function valueEntryOf(column: ValueColumn, row: number): number {
  const rows = column.rows;
  if (rows === null) return row >= 0 && row < column.length ? row : -1;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = rows[mid];
    if (at === row) return mid;
    if (at < row) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * The kind of the value of a row (`VALUE_ABSENT` when the row does not hold the key)
 *
 * @internal
 */
export function valueKindOf(column: ValueColumn, row: number): number {
  const entry = valueEntryOf(column, row);
  return entry < 0 ? VALUE_ABSENT : column.tags[entry];
}

/**
 * The number of a row, or undefined when its value is not a number
 *
 * @internal
 */
export function readNumberValue(column: ValueColumn, row: number): number | undefined {
  const entry = valueEntryOf(column, row);
  if (entry < 0 || column.tags[entry] !== VALUE_NUMBER) return undefined;
  return (column.numbers as Float64Array)[entry];
}

/**
 * Reads the value of a row
 *
 * @param strings Where the strings read are kept (each read decodes them again when omitted)
 * @returns The value, or undefined when the row does not hold the key
 * @internal
 */
export function readValue(column: ValueColumn, row: number, strings?: ValueStringCache): unknown {
  const entry = valueEntryOf(column, row);
  if (entry < 0) return undefined;
  switch (column.tags[entry]) {
    case VALUE_NULL:
      return null;
    case VALUE_FALSE:
      return false;
    case VALUE_TRUE:
      return true;
    case VALUE_NUMBER:
      return (column.numbers as Float64Array)[entry];
    case VALUE_STRING: {
      const values = column.values as Utf8Column;
      const ref = (column.refs as Int32Array)[entry];
      return strings ? strings.read(values, ref) : utf8String(values, ref);
    }
    case VALUE_NESTED: {
      const values = column.values as Utf8Column;
      const ref = (column.refs as Int32Array)[entry];
      return decodeCanonicalValue(values.bytes, values.offsets[ref], values.offsets[ref + 1]);
    }
    default:
      return undefined;
  }
}

/**
 * The strings read from the columns, kept up to a number
 *
 * A column holds its strings as bytes, and a reader that asks for the same strings again and
 * again (the names of the rows a label draws, frame after frame) would decode them every time.
 * The strings read are kept, keyed by the dictionary and the index, and the least recently read
 * ones are dropped once there are more than the limit, so reading the name of every row once
 * does not keep a string per row.
 *
 * @internal
 */
export class ValueStringCache {
  private readonly entries = new Map<number, string>();
  private readonly serials = new WeakMap<Utf8Column, number>();
  private nextSerial = 1;

  /** @param limit The number of strings kept */
  constructor(readonly limit = 50_000) {}

  /** The number of strings kept */
  get size(): number {
    return this.entries.size;
  }

  /** The string of entry `index` of a dictionary */
  read(values: Utf8Column, index: number): string {
    let serial = this.serials.get(values);
    if (serial === undefined) {
      serial = this.nextSerial++;
      this.serials.set(values, serial);
    }
    // The index of an entry is below 2^24 (a group has at most a few thousand rows)
    const key = serial * 0x1000000 + index;
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      // The most recently read goes to the end (a Map keeps the order of insertion)
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const value = utf8String(values, index);
    this.entries.set(key, value);
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as number;
      this.entries.delete(oldest);
    }
    return value;
  }

  /** Drops every string kept */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * Builds the column of one key over the rows of a group
 *
 * @internal
 */
export class ValueColumnBuilder {
  private readonly tags: Uint8Array;
  private numbers: Float64Array | null = null;
  /** The string, or the canonical bytes of the nested value, of each row that has one */
  private readonly texts = new Map<number, string | Uint8Array>();
  private present = 0;

  /** @param length The number of rows of the group */
  constructor(readonly length: number) {
    this.tags = new Uint8Array(length);
  }

  /**
   * Sets the value of a row (`undefined` leaves it absent)
   *
   * @throws when the value is not one of the kinds of the canonical form (a nested value is
   *   checked when it is written)
   */
  set(row: number, value: unknown): void {
    if (value === undefined) return;
    if (this.tags[row] === VALUE_ABSENT) this.present++;
    this.texts.delete(row);
    if (value === null) {
      this.tags[row] = VALUE_NULL;
    } else if (value === false) {
      this.tags[row] = VALUE_FALSE;
    } else if (value === true) {
      this.tags[row] = VALUE_TRUE;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`ValueColumn: ${value} is not a value`);
      this.numbers ??= new Float64Array(this.length);
      this.numbers[row] = value;
      this.tags[row] = VALUE_NUMBER;
    } else if (typeof value === 'string') {
      this.texts.set(row, value);
      this.tags[row] = VALUE_STRING;
    } else {
      this.texts.set(row, encodeCanonicalValue(value));
      this.tags[row] = VALUE_NESTED;
    }
  }

  /**
   * The column, dense or sparse by the share of rows that hold the key
   *
   * The strings are kept once each unless most of them differ (a name or an address per row),
   * where looking them up would cost more than it saves.
   */
  finish(): ValueColumn {
    const length = this.length;
    const dense = length > 0 && this.present / length >= DENSE_MIN_SHARE;
    const count = dense ? length : this.present;
    const rows = dense ? null : new Int32Array(count);
    const tags = new Uint8Array(count);
    const numbers = this.numbers ? new Float64Array(count) : null;
    const refs = this.texts.size > 0 ? new Int32Array(count) : null;

    // Whether the strings are kept once each
    const distinct = new Set<string>();
    for (const text of this.texts.values()) {
      if (typeof text === 'string') distinct.add(text);
    }
    const share = distinct.size <= this.texts.size / 2;
    const values = this.texts.size > 0 ? new Utf8ColumnBuilder(this.texts.size) : null;
    const known = new Map<string, number>();

    let entry = 0;
    for (let row = 0; row < length; row++) {
      const tag = this.tags[row];
      if (!dense && tag === VALUE_ABSENT) continue;
      if (rows) rows[entry] = row;
      tags[entry] = tag;
      if (tag === VALUE_NUMBER && numbers) numbers[entry] = (this.numbers as Float64Array)[row];
      if ((tag === VALUE_STRING || tag === VALUE_NESTED) && refs && values) {
        const text = this.texts.get(row) as string | Uint8Array;
        if (typeof text === 'string') {
          const seen = share ? known.get(text) : undefined;
          if (seen !== undefined) {
            refs[entry] = seen;
          } else {
            refs[entry] = values.length;
            if (share) known.set(text, values.length);
            values.add(text);
          }
        } else {
          refs[entry] = values.length;
          values.addBytes(text);
        }
      }
      entry++;
    }

    return {
      form: dense ? 'dense' : 'sparse',
      length,
      rows,
      tags,
      numbers,
      refs,
      values: values ? values.finish() : null,
    };
  }
}
