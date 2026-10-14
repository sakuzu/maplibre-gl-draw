// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A column of strings held as UTF-8 bytes (`Utf8Column`)
 *
 * The strings of a column (the ids of the rows, the keys of their order, the values of an
 * attribute) are held as one array of bytes and one array of offsets, the layout of the string
 * type of Arrow. A hundred thousand ids cost two typed arrays instead of a hundred thousand
 * strings of the engine, they make no garbage when a column is built again, and a Worker can
 * send them without a copy.
 *
 * The comparisons are on the bytes: the order of two strings is the order of their UTF-8 bytes
 * (not the order of their UTF-16 code units, which differs from it above U+E000 and on the
 * supplementary planes), and two strings are equal when their bytes are.
 *
 * A pure module: it depends on nothing, so it runs in a Worker as well.
 */

/**
 * A column of strings held as UTF-8 bytes
 *
 * Entry `i` is `bytes[offsets[i]]` up to `bytes[offsets[i + 1]]` (exclusive), so `offsets` has
 * one more value than the column has entries, and its values never decrease.
 *
 * @example A column of three strings: a, an empty one and 日本
 * ```ts
 * const column: Utf8Column = {
 *   offsets: new Int32Array([0, 1, 1, 7]),
 *   bytes: new Uint8Array([0x61, 0xe6, 0x97, 0xa5, 0xe6, 0x9c, 0xac]),
 * };
 * ```
 */
export interface Utf8Column {
  /** Where each entry starts in `bytes`, and where the last one ends (entries + 1 values) */
  readonly offsets: Int32Array;
  /** The UTF-8 bytes of every entry, entry after entry */
  readonly bytes: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** An empty column */
export function emptyUtf8Column(): Utf8Column {
  return { offsets: new Int32Array(1), bytes: new Uint8Array(0) };
}

/**
 * The number of entries of a column
 *
 * @internal
 */
export function utf8ColumnLength(column: Utf8Column): number {
  return Math.max(0, column.offsets.length - 1);
}

/**
 * The column of a list of strings
 *
 * @internal
 */
export function utf8ColumnFromStrings(values: readonly string[]): Utf8Column {
  const builder = new Utf8ColumnBuilder(values.length);
  for (const value of values) builder.add(value);
  return builder.finish();
}

/**
 * Entry `index` of a column as a string
 *
 * It decodes the bytes every time it is called; a caller that reads the same entry often keeps
 * the string itself.
 *
 * @internal
 */
export function utf8String(column: Utf8Column, index: number): string {
  const start = column.offsets[index];
  const end = column.offsets[index + 1];
  if (end <= start) return '';
  return decoder.decode(column.bytes.subarray(start, end));
}

/**
 * Compares two runs of bytes in the order of their bytes (a shorter run that is a prefix of
 * the other comes first)
 *
 * @returns A negative number, 0 or a positive number
 * @internal
 */
export function compareByteRuns(
  a: Uint8Array,
  aStart: number,
  aEnd: number,
  b: Uint8Array,
  bStart: number,
  bEnd: number,
): number {
  const aLength = aEnd - aStart;
  const bLength = bEnd - bStart;
  const n = aLength < bLength ? aLength : bLength;
  for (let k = 0; k < n; k++) {
    const d = a[aStart + k] - b[bStart + k];
    if (d !== 0) return d;
  }
  return aLength - bLength;
}

/**
 * Compares entry `i` of `a` with entry `j` of `b` in the order of their UTF-8 bytes
 *
 * @returns A negative number, 0 or a positive number
 * @internal
 */
export function compareUtf8(a: Utf8Column, i: number, b: Utf8Column, j: number): number {
  return compareByteRuns(
    a.bytes,
    a.offsets[i],
    a.offsets[i + 1],
    b.bytes,
    b.offsets[j],
    b.offsets[j + 1],
  );
}

/**
 * Whether entry `i` of `a` and entry `j` of `b` hold the same bytes
 *
 * @internal
 */
export function equalUtf8(a: Utf8Column, i: number, b: Utf8Column, j: number): boolean {
  const aStart = a.offsets[i];
  const length = a.offsets[i + 1] - aStart;
  const bStart = b.offsets[j];
  if (b.offsets[j + 1] - bStart !== length) return false;
  const aBytes = a.bytes;
  const bBytes = b.bytes;
  for (let k = 0; k < length; k++) {
    if (aBytes[aStart + k] !== bBytes[bStart + k]) return false;
  }
  return true;
}

/** The offset basis of the 32 bit FNV-1a hash */
const FNV_OFFSET = 0x811c9dc5;
/** The prime of the 32 bit FNV-1a hash */
const FNV_PRIME = 0x01000193;

/**
 * The 32 bit FNV-1a hash of a run of bytes (an unsigned integer)
 *
 * @internal
 */
export function hashByteRun(bytes: Uint8Array, start: number, end: number): number {
  let hash = FNV_OFFSET;
  for (let k = start; k < end; k++) {
    hash ^= bytes[k];
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * The hash of entry `index` of a column (the one a table of ids is keyed by)
 *
 * @internal
 */
export function hashUtf8(column: Utf8Column, index: number): number {
  return hashByteRun(column.bytes, column.offsets[index], column.offsets[index + 1]);
}

/**
 * The hash of every entry of a column
 *
 * A Worker computes it while it builds the rows, so the main thread only looks the ids up.
 *
 * @internal
 */
export function hashUtf8Column(column: Utf8Column): Uint32Array {
  const n = utf8ColumnLength(column);
  const hashes = new Uint32Array(n);
  for (let i = 0; i < n; i++) hashes[i] = hashUtf8(column, i);
  return hashes;
}

/**
 * The hash of a string, the same as {@link hashUtf8} gives for its bytes
 *
 * @internal
 */
export function hashString(value: string): number {
  const bytes = encoder.encode(value);
  return hashByteRun(bytes, 0, bytes.length);
}

/**
 * Writes the UTF-8 bytes of a string into an array, which must hold three bytes per UTF-16 unit
 * of the string (what one unit encodes to at most)
 *
 * @returns The number of bytes written
 * @internal
 */
export function encodeUtf8Into(value: string, target: Uint8Array): number {
  return encoder.encodeInto(value, target).written;
}

/**
 * The number of UTF-8 bytes of a string (what `TextEncoder` writes: a lone surrogate takes the
 * 3 bytes of U+FFFD)
 *
 * @internal
 */
export function utf8LengthOf(value: string): number {
  const n = value.length;
  let length = 0;
  for (let k = 0; k < n; k++) {
    const unit = value.charCodeAt(k);
    if (unit < 0x80) length += 1;
    else if (unit < 0x800) length += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && k + 1 < n) {
      const next = value.charCodeAt(k + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        k++;
      } else {
        length += 3;
      }
    } else length += 3;
  }
  return length;
}

/**
 * Writes the UTF-8 bytes of a string at `at` of an array, which must have room for three bytes
 * per UTF-16 unit of the string
 *
 * An ASCII string is written unit by unit: most strings of the data are short and ASCII (ids,
 * keys, codes), and `TextEncoder.encodeInto` costs a view of the array and a call into the
 * engine each time.
 *
 * @returns The number of bytes written
 * @internal
 */
export function writeUtf8(value: string, target: Uint8Array, at: number): number {
  const n = value.length;
  let k = 0;
  for (; k < n; k++) {
    const unit = value.charCodeAt(k);
    if (unit >= 0x80) break;
    target[at + k] = unit;
  }
  if (k === n) return n;
  return encoder.encodeInto(value, target.subarray(at)).written;
}

/**
 * Whether entry `i` of a column holds the bytes `bytes[0, length)`
 *
 * @internal
 */
export function equalUtf8Bytes(
  column: Utf8Column,
  i: number,
  bytes: Uint8Array,
  length: number,
): boolean {
  const start = column.offsets[i];
  if (column.offsets[i + 1] - start !== length) return false;
  const own = column.bytes;
  for (let k = 0; k < length; k++) {
    if (own[start + k] !== bytes[k]) return false;
  }
  return true;
}

/**
 * The UTF-8 bytes of a string
 *
 * @internal
 */
export function utf8Bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

/**
 * Builds a column entry after entry
 *
 * The arrays grow by doubling, and `finish` hands out arrays of the exact length.
 *
 * @internal
 */
export class Utf8ColumnBuilder {
  private offsets: Int32Array;
  private bytes: Uint8Array;
  private count = 0;
  private size = 0;

  /** @param expected The number of entries expected (the arrays start at that size) */
  constructor(expected = 16) {
    this.offsets = new Int32Array(Math.max(2, expected + 1));
    this.bytes = new Uint8Array(Math.max(16, expected * 8));
  }

  /** The number of entries added */
  get length(): number {
    return this.count;
  }

  /** Adds a string */
  add(value: string): void {
    // A UTF-8 string takes at most 3 bytes per UTF-16 code unit
    this.reserveBytes(value.length * 3);
    this.size += writeUtf8(value, this.bytes, this.size);
    this.push();
  }

  /** Adds the bytes `[start, end)` of an array as they are */
  addBytes(source: Uint8Array, start = 0, end = source.length): void {
    this.reserveBytes(end - start);
    this.bytes.set(source.subarray(start, end), this.size);
    this.size += end - start;
    this.push();
  }

  /** Where entry `index` added starts in {@link bytesAdded} */
  entryStart(index: number): number {
    return this.offsets[index];
  }

  /** Where entry `index` added ends in {@link bytesAdded} */
  entryEnd(index: number): number {
    return this.offsets[index + 1];
  }

  /** The array the bytes of the entries are added to (it changes when it grows) */
  get bytesAdded(): Uint8Array {
    return this.bytes;
  }

  /** Adds entry `index` of another column */
  addEntry(column: Utf8Column, index: number): void {
    this.addBytes(column.bytes, column.offsets[index], column.offsets[index + 1]);
  }

  /** The column of the entries added (the builder is not used afterwards) */
  finish(): Utf8Column {
    return {
      offsets: this.offsets.slice(0, this.count + 1),
      bytes: this.bytes.slice(0, this.size),
    };
  }

  private push(): void {
    this.count++;
    if (this.count + 1 > this.offsets.length) {
      const next = new Int32Array(this.offsets.length * 2);
      next.set(this.offsets);
      this.offsets = next;
    }
    this.offsets[this.count] = this.size;
  }

  private reserveBytes(extra: number): void {
    const needed = this.size + extra;
    if (needed <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < needed) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.size));
    this.bytes = next;
  }
}
