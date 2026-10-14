// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The canonical bytes of a value
 *
 * A value of an attribute or a style (null, a boolean, a number, a string, an array or an
 * object with string keys) is written as one byte of its kind followed by its contents, in one
 * canonical form: the same value always gives the same bytes. Two styles are therefore the
 * same when their bytes are, which is how the table of styles shares one entry between every
 * row that looks alike, and a nested value (an array or an object) is held in a column as these
 * bytes and turned back into a value only when it is read.
 *
 * The form:
 *
 * | Byte | Kind | Contents |
 * | --- | --- | --- |
 * | 0 | null | none |
 * | 1 | false | none |
 * | 2 | true | none |
 * | 3 | integer | a signed variable-length integer |
 * | 4 | number | 8 bytes of a float64, big-endian |
 * | 5 | string | the number of bytes (unsigned variable-length) and the UTF-8 |
 * | 6 | array | the number of values (unsigned variable-length) and the values |
 * | 7 | object | the number of keys (unsigned variable-length) and the key (as a string) and the value of each |
 *
 * - A number is an integer when `Number.isSafeInteger` holds and it is not `-0`; any other
 *   finite number is a float64. NaN and the infinities are not values
 * - The keys of an object are ordered by their UTF-8 bytes; a key whose value is `undefined` is
 *   left out (as if it were not there)
 * - The unsigned variable-length integer puts 7 bits per byte, the lowest first, with 0x80 on
 *   every byte but the last. The signed one puts the sign in 0x40 of the first byte with the 6
 *   lowest bits, then 7 bits per byte. Both are written in the fewest bytes
 *
 * A pure module: it depends on nothing outside `/table`, so it runs in a Worker as well.
 */

import { utf8LengthOf, writeUtf8 } from './utf8-column.js';

/** The kinds of the canonical form */
export const CANONICAL_NULL = 0;
export const CANONICAL_FALSE = 1;
export const CANONICAL_TRUE = 2;
export const CANONICAL_INTEGER = 3;
export const CANONICAL_NUMBER = 4;
export const CANONICAL_STRING = 5;
export const CANONICAL_ARRAY = 6;
export const CANONICAL_OBJECT = 7;

/** The deepest nesting of arrays and objects a value may have */
export const CANONICAL_MAX_DEPTH = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** A growing array of bytes */
class ByteWriter {
  bytes = new Uint8Array(64);
  size = 0;
  private readonly view8 = new DataView(new ArrayBuffer(8));

  reserve(extra: number): void {
    const needed = this.size + extra;
    if (needed <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < needed) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.size));
    this.bytes = next;
  }

  byte(value: number): void {
    this.reserve(1);
    this.bytes[this.size++] = value;
  }

  varUint(value: number): void {
    let rest = value;
    while (rest > 0x7f) {
      this.byte(0x80 | (rest % 0x80));
      rest = Math.floor(rest / 0x80);
    }
    this.byte(rest);
  }

  varInt(value: number): void {
    const negative = value < 0;
    let rest = negative ? -value : value;
    const first = rest % 0x40;
    rest = Math.floor(rest / 0x40);
    this.byte((rest > 0 ? 0x80 : 0) | (negative ? 0x40 : 0) | first);
    while (rest > 0) {
      const next = Math.floor(rest / 0x80);
      this.byte((next > 0 ? 0x80 : 0) | (rest % 0x80));
      rest = next;
    }
  }

  float64(value: number): void {
    this.view8.setFloat64(0, value, false);
    this.reserve(8);
    for (let k = 0; k < 8; k++) this.bytes[this.size + k] = this.view8.getUint8(k);
    this.size += 8;
  }

  /**
   * The number of bytes and the UTF-8 of a string. An ASCII string (most keys and values) is
   * written as it is read, with no array of its own; any other is measured, then encoded in
   * place
   */
  string(value: string): void {
    const n = value.length;
    const head = n < 0x80 ? 1 : varUintLength(n);
    this.reserve(head + n * 3);
    const bytes = this.bytes;
    const start = this.size + head;
    let k = 0;
    for (; k < n; k++) {
      const unit = value.charCodeAt(k);
      if (unit >= 0x80) break;
      bytes[start + k] = unit;
    }
    if (k === n) {
      this.varUint(n);
      this.size += n;
      return;
    }
    const length = utf8LengthOf(value);
    this.varUint(length);
    this.reserve(length);
    this.size += writeUtf8(value, this.bytes, this.size);
  }
}

/** The number of bytes of an unsigned variable-length integer */
function varUintLength(value: number): number {
  let length = 1;
  let rest = value;
  while (rest > 0x7f) {
    rest = Math.floor(rest / 0x80);
    length++;
  }
  return length;
}

/** The writer the values are written with, used again from one value to the next */
let scratch: ByteWriter | null = new ByteWriter();

/**
 * Writes a value in the canonical form into a writer used again from one value to the next
 *
 * A writer in use (a value written while another is, from a getter of an object) gets a new one.
 */
function writeCanonical<T>(value: unknown, take: (bytes: Uint8Array, size: number) => T): T {
  const writer = scratch ?? new ByteWriter();
  scratch = null;
  writer.size = 0;
  try {
    writeValue(writer, value, 0);
    return take(writer.bytes, writer.size);
  } finally {
    // A writer grown past a large value is not kept
    if (writer.bytes.length <= SCRATCH_KEPT_BYTES) scratch = writer;
    else scratch ??= new ByteWriter();
  }
}

/** The largest writer kept from one value to the next */
const SCRATCH_KEPT_BYTES = 1 << 16;

/**
 * Writes a value in the canonical form
 *
 * @throws when the value is not one of the kinds of the form (`undefined`, a function, a
 *   symbol, a bigint, NaN, an infinity), or when it is nested deeper than
 *   {@link CANONICAL_MAX_DEPTH}
 * @internal
 */
export function encodeCanonicalValue(value: unknown): Uint8Array {
  return writeCanonical(value, (bytes, size) => bytes.slice(0, size));
}

/**
 * What {@link appendCanonicalValue} adds the bytes of a value to
 *
 * @internal
 */
export interface CanonicalByteSink {
  /** Adds the bytes `[start, end)` of an array as one entry */
  addBytes(source: Uint8Array, start: number, end: number): void;
}

/**
 * Writes a value in the canonical form and adds its bytes to a column as they are being built,
 * with no array of their own
 *
 * The value is written in full before anything is added, so a value refused adds nothing.
 *
 * @throws as {@link encodeCanonicalValue}
 * @internal
 */
export function appendCanonicalValue(value: unknown, sink: CanonicalByteSink): void {
  writeCanonical(value, (bytes, size) => sink.addBytes(bytes, 0, size));
}

function writeValue(writer: ByteWriter, value: unknown, depth: number): void {
  if (value === null) {
    writer.byte(CANONICAL_NULL);
    return;
  }
  switch (typeof value) {
    case 'boolean':
      writer.byte(value ? CANONICAL_TRUE : CANONICAL_FALSE);
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`Canonical value: ${value} is not a value`);
      if (Number.isSafeInteger(value) && !Object.is(value, -0)) {
        writer.byte(CANONICAL_INTEGER);
        writer.varInt(value);
      } else {
        writer.byte(CANONICAL_NUMBER);
        writer.float64(value);
      }
      return;
    case 'string':
      writer.byte(CANONICAL_STRING);
      writer.string(value);
      return;
    case 'object': {
      if (depth >= CANONICAL_MAX_DEPTH) {
        throw new Error(`Canonical value: nested deeper than ${CANONICAL_MAX_DEPTH}`);
      }
      if (Array.isArray(value)) {
        writer.byte(CANONICAL_ARRAY);
        writer.varUint(value.length);
        for (const item of value) writeValue(writer, item, depth + 1);
        return;
      }
      const record = value as Record<string, unknown>;
      const keys: string[] = [];
      const items: unknown[] = [];
      let plain = true;
      for (const key of Object.keys(record)) {
        const item = record[key];
        if (item === undefined) continue;
        keys.push(key);
        items.push(item);
        if (plain && !belowSurrogates(key)) plain = false;
      }
      const order = keyOrder(keys, plain);
      writer.byte(CANONICAL_OBJECT);
      writer.varUint(keys.length);
      for (let i = 0; i < order.length; i++) {
        const at = order[i];
        writer.string(keys[at]);
        writeValue(writer, items[at], depth + 1);
      }
      return;
    }
    default:
      throw new Error(`Canonical value: a ${typeof value} is not a value`);
  }
}

/** The most keys of an object put in order by an insertion sort */
const INSERTION_SORT_KEYS = 24;

/** Whether every UTF-16 unit of a string is below the surrogates (U+D800) */
function belowSurrogates(value: string): boolean {
  for (let k = 0; k < value.length; k++) {
    if (value.charCodeAt(k) >= 0xd800) return false;
  }
  return true;
}

/**
 * The places of the keys of an object in the order of their UTF-8 bytes
 *
 * Below the surrogates the order of the UTF-16 units is the order of the code points, which is
 * the order of the UTF-8 bytes, so the keys are compared as they are; a key at or above them (a
 * surrogate orders below U+E000 in UTF-16 and above it in UTF-8, and a lone one is written as
 * U+FFFD) is compared by its bytes. Keys of the same bytes keep the order they were given.
 */
function keyOrder(keys: readonly string[], plain: boolean): number[] {
  const n = keys.length;
  const order: number[] = new Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  if (n < 2) return order;
  if (plain && n <= INSERTION_SORT_KEYS) {
    // An insertion sort: an object has a few keys, often in the order already
    for (let i = 1; i < n; i++) {
      const key = keys[i];
      let j = i - 1;
      while (j >= 0 && keys[order[j]] > key) {
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = i;
    }
    return order;
  }
  if (plain) {
    order.sort((a, b) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : a - b));
    return order;
  }
  const bytes = keys.map((key) => encoder.encode(key));
  order.sort((a, b) => compareBytes(bytes[a], bytes[b]) || a - b);
  return order;
}

/** The order of two arrays of bytes */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let k = 0; k < n; k++) {
    if (a[k] !== b[k]) return a[k] - b[k];
  }
  return a.length - b.length;
}

/** Reads the canonical form */
class ByteReader {
  private readonly view: DataView;

  constructor(
    readonly bytes: Uint8Array,
    public at: number,
    readonly end: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  byte(): number {
    if (this.at >= this.end) throw new Error('Canonical value: the bytes end too early');
    return this.bytes[this.at++];
  }

  varUint(): number {
    let value = 0;
    let scale = 1;
    for (;;) {
      const b = this.byte();
      value += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) return value;
      scale *= 0x80;
    }
  }

  varInt(): number {
    const first = this.byte();
    const negative = (first & 0x40) !== 0;
    let value = first & 0x3f;
    let scale = 0x40;
    let more = (first & 0x80) !== 0;
    while (more) {
      const b = this.byte();
      value += (b & 0x7f) * scale;
      scale *= 0x80;
      more = (b & 0x80) !== 0;
    }
    return negative ? -value : value;
  }

  float64(): number {
    if (this.at + 8 > this.end) throw new Error('Canonical value: the bytes end too early');
    const value = this.view.getFloat64(this.at, false);
    this.at += 8;
    return value;
  }

  string(): string {
    const length = this.varUint();
    if (this.at + length > this.end) throw new Error('Canonical value: the bytes end too early');
    const value = decoder.decode(this.bytes.subarray(this.at, this.at + length));
    this.at += length;
    return value;
  }
}

/**
 * Reads a value written by {@link encodeCanonicalValue}
 *
 * @param start Where the value starts in `bytes`
 * @param end Where it ends (the end of `bytes` when omitted); the value must use every byte
 * @throws when the bytes are not one value of the form
 * @internal
 */
export function decodeCanonicalValue(bytes: Uint8Array, start = 0, end = bytes.length): unknown {
  const reader = new ByteReader(bytes, start, end);
  const value = readValue(reader, 0);
  if (reader.at !== end) throw new Error('Canonical value: bytes are left over');
  return value;
}

function readValue(reader: ByteReader, depth: number): unknown {
  const kind = reader.byte();
  switch (kind) {
    case CANONICAL_NULL:
      return null;
    case CANONICAL_FALSE:
      return false;
    case CANONICAL_TRUE:
      return true;
    case CANONICAL_INTEGER:
      return reader.varInt();
    case CANONICAL_NUMBER:
      return reader.float64();
    case CANONICAL_STRING:
      return reader.string();
    case CANONICAL_ARRAY: {
      if (depth >= CANONICAL_MAX_DEPTH) throw new Error('Canonical value: nested too deep');
      const count = reader.varUint();
      const out: unknown[] = new Array(count);
      for (let i = 0; i < count; i++) out[i] = readValue(reader, depth + 1);
      return out;
    }
    case CANONICAL_OBJECT: {
      if (depth >= CANONICAL_MAX_DEPTH) throw new Error('Canonical value: nested too deep');
      const count = reader.varUint();
      const out: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) {
        const key = reader.string();
        const item = readValue(reader, depth + 1);
        // A key named `__proto__` is an own property, as it was in the value written
        if (key === '__proto__') {
          Object.defineProperty(out, key, {
            value: item,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        } else {
          out[key] = item;
        }
      }
      return out;
    }
    default:
      throw new Error(`Canonical value: unknown kind ${kind}`);
  }
}
