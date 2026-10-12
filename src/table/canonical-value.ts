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
 * A pure module: it depends on nothing, so it runs in a Worker as well.
 */

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

  string(value: string): void {
    const utf8 = encoder.encode(value);
    this.varUint(utf8.length);
    this.reserve(utf8.length);
    this.bytes.set(utf8, this.size);
    this.size += utf8.length;
  }

  take(): Uint8Array {
    return this.bytes.slice(0, this.size);
  }
}

/**
 * Writes a value in the canonical form
 *
 * @throws when the value is not one of the kinds of the form (`undefined`, a function, a
 *   symbol, a bigint, NaN, an infinity), or when it is nested deeper than
 *   {@link CANONICAL_MAX_DEPTH}
 * @internal
 */
export function encodeCanonicalValue(value: unknown): Uint8Array {
  const writer = new ByteWriter();
  writeValue(writer, value, 0);
  return writer.take();
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
      const entries: Array<[Uint8Array, string, unknown]> = [];
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (item === undefined) continue;
        entries.push([encoder.encode(key), key, item]);
      }
      entries.sort((a, b) => compareBytes(a[0], b[0]));
      writer.byte(CANONICAL_OBJECT);
      writer.varUint(entries.length);
      for (const [, key, item] of entries) {
        writer.string(key);
        writeValue(writer, item, depth + 1);
      }
      return;
    }
    default:
      throw new Error(`Canonical value: a ${typeof value} is not a value`);
  }
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
