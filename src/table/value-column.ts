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

import { DrawError } from '../shared/draw-error.js';
import { appendCanonicalValue, decodeCanonicalValue } from './canonical-value.js';
import {
  compareByteRuns,
  hashByteRun,
  type Utf8Column,
  Utf8ColumnBuilder,
  utf8String,
} from './utf8-column.js';

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
 * The strings read are kept, keyed by the dictionary and the index, in two generations of half
 * the limit each: a string read goes to the current one, and when it is full, it becomes the old
 * one and the strings of the old one before are dropped together. A string read again from the
 * old one goes back to the current one. Dropping costs the same however many strings are kept
 * (a map that drops its oldest entry one at a time walks the entries it dropped before), so
 * reading the name of every row of a large layer, more of them than the limit, stays linear.
 *
 * @internal
 */
export class ValueStringCache {
  /** The strings read since the generation began */
  private current = new Map<number, string>();
  /** The strings of the generation before */
  private old = new Map<number, string>();
  private readonly serials = new WeakMap<Utf8Column, number>();
  private nextSerial = 1;
  /** The number of strings of a generation */
  private readonly half: number;

  /** @param limit The number of strings kept */
  constructor(readonly limit = 50_000) {
    this.half = Math.max(1, Math.floor(limit / 2));
  }

  /** The number of strings kept */
  get size(): number {
    return this.current.size + this.old.size;
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
    const hit = this.current.get(key);
    if (hit !== undefined) return hit;
    const value = this.old.get(key) ?? utf8String(values, index);
    if (this.current.size >= this.half) {
      this.old = this.current;
      this.current = new Map();
    }
    this.current.set(key, value);
    return value;
  }

  /** Drops every string kept */
  clear(): void {
    this.current.clear();
    this.old.clear();
  }
}

/**
 * Builds the column of one key over the rows of a group
 *
 * The strings and the nested values are written as bytes as they are set (a nested value as its
 * canonical bytes), and an entry of another column is copied as its bytes ({@link copy}), so a
 * column built again from columns (the next version of a group) decodes no value. `finish`
 * keeps each value once by a table of the hashes of its bytes, unless most of them differ.
 *
 * @internal
 */
export class ValueColumnBuilder {
  private readonly tags: Uint8Array;
  private numbers: Float64Array | null = null;
  /** The entry in `texts` of the string or the nested value of each row that has one */
  private textOf: Int32Array | null = null;
  /** The bytes of the strings and the nested values, in the order they were set */
  private texts: Utf8ColumnBuilder | null = null;
  /** The number of rows that hold the key */
  private present = 0;
  /** The number of rows that hold a string or a nested value */
  private textRows = 0;
  /** The last row given a string or a nested value */
  private lastTextRow = -1;
  /** Whether the entries of `texts` are those of the rows, one each, in the order of the rows */
  private textsInOrder = true;

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
    if (value === null) {
      this.setTag(row, VALUE_NULL);
    } else if (value === false) {
      this.setTag(row, VALUE_FALSE);
    } else if (value === true) {
      this.setTag(row, VALUE_TRUE);
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value))
        throw new DrawError('invalid-input', `ValueColumn: ${value} is not a value`);
      this.setNumber(row, value);
    } else if (typeof value === 'string') {
      this.textsFor(row, VALUE_STRING).add(value);
    } else {
      // Written in full before the row is marked, so a value refused leaves the row as it was
      const texts = this.texts ?? this.startTexts();
      const before = texts.length;
      appendCanonicalValue(value, texts);
      this.markText(row, VALUE_NESTED, before);
    }
  }

  /**
   * Sets the value of a row to entry `entry` of another column, copying its bytes as they are
   * (`VALUE_ABSENT` leaves the row absent)
   */
  copy(row: number, column: ValueColumn, entry: number): void {
    const tag = column.tags[entry];
    switch (tag) {
      case VALUE_ABSENT:
        return;
      case VALUE_NUMBER:
        this.setNumber(row, (column.numbers as Float64Array)[entry]);
        return;
      case VALUE_STRING:
      case VALUE_NESTED: {
        const values = column.values as Utf8Column;
        const ref = (column.refs as Int32Array)[entry];
        this.textsFor(row, tag).addBytes(
          values.bytes,
          values.offsets[ref],
          values.offsets[ref + 1],
        );
        return;
      }
      default:
        this.setTag(row, tag);
    }
  }

  /**
   * The column, dense or sparse by the share of rows that hold the key
   *
   * The strings and the nested values are kept once each unless most of them differ (a name or
   * an address per row), where looking them up would cost more than it saves.
   */
  finish(): ValueColumn {
    const length = this.length;
    const dense = length > 0 && this.present / length >= DENSE_MIN_SHARE;
    const count = dense ? length : this.present;
    const rows = dense ? null : new Int32Array(count);
    const tags = new Uint8Array(count);
    const numbers = this.numbers ? new Float64Array(count) : null;
    const refs = this.textRows > 0 ? new Int32Array(count) : null;
    // The bytes of the values (none when every value set was given another value since)
    const texts = this.textRows > 0 ? this.texts : null;
    const textOf = this.textOf;
    // The first row of the same value of each row of a string or a nested value (null: none
    // shared)
    const firstOf = texts && textOf ? this.sharedRows(texts, textOf) : null;
    // The column of the values: the bytes as they were set when none is shared and they are in
    // the order of the rows, or built again
    const asSet = firstOf === null && this.textsInOrder;
    const values = texts && !asSet ? new Utf8ColumnBuilder(this.textRows) : null;
    const tagsIn = this.tags;

    let entry = 0;
    for (let row = 0; row < length; row++) {
      const tag = tagsIn[row];
      if (!dense && tag === VALUE_ABSENT) continue;
      if (rows) rows[entry] = row;
      tags[entry] = tag;
      if (tag === VALUE_NUMBER && numbers) numbers[entry] = (this.numbers as Float64Array)[row];
      if ((tag === VALUE_STRING || tag === VALUE_NESTED) && refs && texts && textOf) {
        const text = textOf[row];
        if (asSet) {
          refs[entry] = text;
        } else {
          const first = firstOf ? firstOf[row] : row;
          if (first !== row) {
            // The entry of the first row of the value (written over by its index below)
            refs[entry] = (firstOf as Int32Array)[first];
          } else {
            const index = (values as Utf8ColumnBuilder).length;
            refs[entry] = index;
            (values as Utf8ColumnBuilder).addBytes(
              texts.bytesAdded,
              texts.entryStart(text),
              texts.entryEnd(text),
            );
            // The first row of a value now names its index, for the rows after it (a row is
            // never the first row of another row before it)
            if (firstOf) firstOf[row] = index;
          }
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
      values: texts ? (asSet ? texts.finish() : (values as Utf8ColumnBuilder).finish()) : null,
    };
  }

  /**
   * The first row of the same value (the same kind and bytes) of each row of a string or a
   * nested value, by an open-addressing table of the hashes of the bytes, or null when more than
   * half of the values differ (none is kept once)
   */
  private sharedRows(texts: Utf8ColumnBuilder, textOf: Int32Array): Int32Array | null {
    const total = this.textRows;
    const limit = total / 2;
    let size = 1;
    while (size < total * 2) size <<= 1;
    const mask = size - 1;
    // The row of each slot plus one (0: empty)
    const table = new Int32Array(size);
    const firstOf = new Int32Array(this.length);
    const bytes = texts.bytesAdded;
    const tags = this.tags;
    let distinct = 0;
    for (let row = 0; row < this.length; row++) {
      const tag = tags[row];
      if (tag !== VALUE_STRING && tag !== VALUE_NESTED) continue;
      const text = textOf[row];
      const start = texts.entryStart(text);
      const end = texts.entryEnd(text);
      let slot = (hashByteRun(bytes, start, end) ^ tag) & mask;
      for (;;) {
        const held = table[slot];
        if (held === 0) {
          table[slot] = row + 1;
          firstOf[row] = row;
          if (++distinct > limit) return null;
          break;
        }
        const other = held - 1;
        const otherText = textOf[other];
        if (
          tags[other] === tag &&
          compareByteRuns(
            bytes,
            texts.entryStart(otherText),
            texts.entryEnd(otherText),
            bytes,
            start,
            end,
          ) === 0
        ) {
          firstOf[row] = other;
          break;
        }
        slot = (slot + 1) & mask;
      }
    }
    return firstOf;
  }

  /** Sets a kind with no contents (null, false, true) */
  private setTag(row: number, tag: number): void {
    this.clearRow(row);
    this.tags[row] = tag;
  }

  private setNumber(row: number, value: number): void {
    this.clearRow(row);
    this.numbers ??= new Float64Array(this.length);
    this.numbers[row] = value;
    this.tags[row] = VALUE_NUMBER;
  }

  /** The bytes to add the string or the nested value of a row to, the row marked as its */
  private textsFor(row: number, tag: number): Utf8ColumnBuilder {
    const texts = this.texts ?? this.startTexts();
    this.markText(row, tag, texts.length);
    return texts;
  }

  private startTexts(): Utf8ColumnBuilder {
    const texts = new Utf8ColumnBuilder(Math.min(this.length, TEXTS_START_ENTRIES));
    this.texts = texts;
    this.textOf = new Int32Array(this.length);
    return texts;
  }

  /** Marks a row as holding entry `text` of `texts` */
  private markText(row: number, tag: number, text: number): void {
    this.clearRow(row);
    (this.textOf as Int32Array)[row] = text;
    this.tags[row] = tag;
    this.textRows++;
    if (row <= this.lastTextRow || text !== this.textRows - 1) this.textsInOrder = false;
    this.lastTextRow = row;
  }

  /** Forgets the value a row was given before, counting it as holding the key */
  private clearRow(row: number): void {
    const tag = this.tags[row];
    if (tag === VALUE_ABSENT) {
      this.present++;
    } else if (tag === VALUE_STRING || tag === VALUE_NESTED) {
      // Its bytes stay in `texts`, which are no longer one entry per row
      this.textRows--;
      this.textsInOrder = false;
    }
  }
}

/** The entries `texts` of a builder starts with (it grows by doubling) */
const TEXTS_START_ENTRIES = 64;
