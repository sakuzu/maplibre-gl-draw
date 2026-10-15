// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The format of the blocks of the trial of opening a map in steps: a segment of about 1,000 rows
 * of one layer written as columns, compressed on its own (zstd, outside this module), and the
 * file fetched, a run of segments of 1 to 4 MB.
 *
 * Nothing is rounded: a segment decodes to the same values, the coordinates to the same float64
 * bits. The columns of a segment:
 *
 * - The ids: runs of (client, serial), a client being a 64-bit number written as 16 hex digits.
 *   The rows of an import are one run, a few bytes for the segment
 * - The place: the layer, the key of the head of the run of the import, and the number of the
 *   first row (the rows follow it); no key per row
 * - The source of each row (client and number of its batch), as runs: one for an import
 * - The deleted flags: nothing when no row is deleted
 * - The geometry: its type and the counts of its parts per row, then the coordinates, one stream
 *   per dimension. When the coordinates of a row are integers once scaled by a power of ten
 *   (the scale of the segment) and read back to the same bits, they are written as the
 *   differences of those integers; otherwise as the XOR of each value with the one before
 *   (Gorilla). A geometry of another shape (a GeometryCollection, positions of other lengths) is
 *   written as a nested value
 * - The attributes and the style: a column per key, a tag per row (absent, null, false, true,
 *   integer, float, string, nested), the integers as differences, the floats by XOR, the strings
 *   and the nested values in a dictionary of the segment (a new string shares the bytes of the
 *   start of the one before)
 *
 * It depends on neither Node nor the browser: the script that makes the blocks, the Worker that
 * decodes them and the tests share it. Its modules import each other with their extensions, so
 * that Node runs the script as it is.
 */

import type { Geometry, Position } from 'geojson';

// === Bytes ===

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Writes bytes, growing as it goes */
export class ByteWriter {
  #buf = new Uint8Array(256);
  #len = 0;

  get length(): number {
    return this.#len;
  }

  #ensure(n: number): void {
    if (this.#len + n <= this.#buf.length) return;
    let size = this.#buf.length * 2;
    while (size < this.#len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.#buf.subarray(0, this.#len));
    this.#buf = next;
  }

  byte(b: number): void {
    this.#ensure(1);
    this.#buf[this.#len++] = b;
  }

  bytes(b: Uint8Array): void {
    this.#ensure(b.length);
    this.#buf.set(b, this.#len);
    this.#len += b.length;
  }

  /** An unsigned integer up to 2^53, 7 bits per byte */
  uvarint(n: number): void {
    this.#ensure(8);
    let v = n;
    while (v >= 128) {
      this.#buf[this.#len++] = (v % 128) | 128;
      v = Math.floor(v / 128);
    }
    this.#buf[this.#len++] = v;
  }

  /** A signed integer of at most 52 bits, zigzagged */
  svarint(n: number): void {
    this.uvarint(n < 0 ? -2 * n - 1 : 2 * n);
  }

  /** Bytes after their length */
  vbytes(b: Uint8Array): void {
    this.uvarint(b.length);
    this.bytes(b);
  }

  finish(): Uint8Array {
    return this.#buf.slice(0, this.#len);
  }
}

/** Reads what a {@link ByteWriter} wrote */
export class ByteReader {
  readonly buf: Uint8Array;
  pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  byte(): number {
    if (this.pos >= this.buf.length) throw new Error('the bytes ran out');
    return this.buf[this.pos++];
  }

  take(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.buf.length) throw new Error('the bytes ran out');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  uvarint(): number {
    let out = 0;
    let scale = 1;
    for (;;) {
      const b = this.byte();
      out += (b & 127) * scale;
      if (b < 128) return out;
      scale *= 128;
    }
  }

  svarint(): number {
    const z = this.uvarint();
    return z % 2 === 1 ? -(z + 1) / 2 : z / 2;
  }

  vbytes(): Uint8Array {
    return this.take(this.uvarint());
  }
}

// === Bits and the XOR of floats (Gorilla) ===

/** Writes bits, the highest first */
class BitWriter {
  readonly out: number[] = [];
  /** The free bits of the last byte */
  #free = 0;

  /** The lowest `n` bits of `v` (n at most 32) */
  write(v: number, n: number): void {
    let left = n;
    while (left > 0) {
      if (this.#free === 0) {
        this.out.push(0);
        this.#free = 8;
      }
      const take = Math.min(left, this.#free);
      const chunk = (v >>> (left - take)) & ((1 << take) - 1);
      this.out[this.out.length - 1] |= chunk << (this.#free - take);
      this.#free -= take;
      left -= take;
    }
  }

  /** The lowest `n` bits of the 64-bit number `hi`:`lo` */
  write64(hi: number, lo: number, n: number): void {
    if (n > 32) {
      this.write(hi, n - 32);
      this.write(lo, 32);
    } else {
      this.write(lo, n);
    }
  }
}

/** Reads what a {@link BitWriter} wrote */
class BitReader {
  readonly #buf: Uint8Array;
  #pos = 0;

  constructor(buf: Uint8Array) {
    this.#buf = buf;
  }

  /** `n` bits (at most 32) */
  read(n: number): number {
    let v = 0;
    let left = n;
    while (left > 0) {
      const i = this.#pos >>> 3;
      if (i >= this.#buf.length) throw new Error('the bits ran out');
      const off = this.#pos & 7;
      const avail = 8 - off;
      const take = Math.min(left, avail);
      const b = (this.#buf[i] >>> (avail - take)) & ((1 << take) - 1);
      v = v * (1 << take) + b;
      this.#pos += take;
      left -= take;
    }
    return v >>> 0;
  }
}

const f64 = new DataView(new ArrayBuffer(8));

function ctz32(x: number): number {
  return 31 - Math.clz32(x & -x);
}

/** Writes float64 values as the XOR of each with the one before */
export class XorWriter {
  readonly #bits = new BitWriter();
  #hi = 0;
  #lo = 0;
  #lead = -1;
  #trail = 0;
  count = 0;

  put(value: number): void {
    f64.setFloat64(0, value, true);
    const lo = f64.getUint32(0, true);
    const hi = f64.getUint32(4, true);
    const xh = (hi ^ this.#hi) >>> 0;
    const xl = (lo ^ this.#lo) >>> 0;
    this.#hi = hi;
    this.#lo = lo;
    this.count++;
    if (xh === 0 && xl === 0) {
      this.#bits.write(0, 1);
      return;
    }
    let lead = xh !== 0 ? Math.clz32(xh) : 32 + Math.clz32(xl);
    const trail = xl !== 0 ? ctz32(xl) : 32 + ctz32(xh);
    if (lead > 31) lead = 31;
    if (this.#lead >= 0 && lead >= this.#lead && trail >= this.#trail) {
      this.#bits.write(0b10, 2);
      const [sh, sl] = shiftRight(xh, xl, this.#trail);
      this.#bits.write64(sh, sl, 64 - this.#lead - this.#trail);
      return;
    }
    const sig = 64 - lead - trail;
    this.#bits.write(0b11, 2);
    this.#bits.write(lead, 5);
    this.#bits.write(sig - 1, 6);
    const [sh, sl] = shiftRight(xh, xl, trail);
    this.#bits.write64(sh, sl, sig);
    this.#lead = lead;
    this.#trail = trail;
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.#bits.out);
  }
}

/** Reads what a {@link XorWriter} wrote */
export class XorReader {
  readonly #bits: BitReader;
  #hi = 0;
  #lo = 0;
  #lead = -1;
  #trail = 0;

  constructor(buf: Uint8Array) {
    this.#bits = new BitReader(buf);
  }

  get(): number {
    if (this.#bits.read(1) === 1) {
      let xh: number;
      let xl: number;
      if (this.#bits.read(1) === 0) {
        if (this.#lead < 0) throw new Error('an XOR without a window');
        [xh, xl] = this.#read64(64 - this.#lead - this.#trail);
        [xh, xl] = shiftLeft(xh, xl, this.#trail);
      } else {
        const lead = this.#bits.read(5);
        const sig = this.#bits.read(6) + 1;
        const trail = 64 - lead - sig;
        [xh, xl] = this.#read64(sig);
        [xh, xl] = shiftLeft(xh, xl, trail);
        this.#lead = lead;
        this.#trail = trail;
      }
      this.#hi = (this.#hi ^ xh) >>> 0;
      this.#lo = (this.#lo ^ xl) >>> 0;
    }
    f64.setUint32(0, this.#lo, true);
    f64.setUint32(4, this.#hi, true);
    return f64.getFloat64(0, true);
  }

  #read64(n: number): [number, number] {
    if (n > 32) {
      const hi = this.#bits.read(n - 32);
      return [hi, this.#bits.read(32)];
    }
    return [0, this.#bits.read(n)];
  }
}

function shiftRight(hi: number, lo: number, n: number): [number, number] {
  if (n === 0) return [hi, lo];
  if (n >= 32) return [0, hi >>> (n - 32)];
  return [hi >>> n, ((lo >>> n) | (hi << (32 - n))) >>> 0];
}

function shiftLeft(hi: number, lo: number, n: number): [number, number] {
  if (n === 0) return [hi, lo];
  if (n >= 32) return [(lo << (n - 32)) >>> 0, 0];
  return [((hi << n) | (lo >>> (32 - n))) >>> 0, (lo << n) >>> 0];
}

// === Nested values ===

const T_NULL = 0;
const T_FALSE = 1;
const T_TRUE = 2;
const T_INT = 3;
const T_FLOAT = 4;
const T_STRING = 5;
const T_NESTED = 6;
const T_ABSENT = 7;
const T_ARRAY = 8;
const T_OBJECT = 9;

/**
 * The largest integer written as one (their differences and the zigzag stay below 2^53); a larger
 * one, -0 and the fractions are written as floats
 */
const MAX_INT = 2 ** 49;

function isInt(v: number): boolean {
  return Number.isInteger(v) && Math.abs(v) <= MAX_INT && !Object.is(v, -0);
}

/** A key of a map for bytes (one character per byte) */
function bytesKey(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 4096) {
    s += String.fromCharCode(...b.subarray(i, i + 4096));
  }
  return s;
}

/** Writes a nested value (an array or an object of JSON values), its numbers as their bits */
export function writeNested(w: ByteWriter, v: unknown): void {
  if (v === null) {
    w.byte(T_NULL);
  } else if (v === false) {
    w.byte(T_FALSE);
  } else if (v === true) {
    w.byte(T_TRUE);
  } else if (typeof v === 'number') {
    if (isInt(v)) {
      w.byte(T_INT);
      w.svarint(v);
    } else {
      w.byte(T_FLOAT);
      f64.setFloat64(0, v, true);
      w.bytes(new Uint8Array(f64.buffer.slice(0)));
    }
  } else if (typeof v === 'string') {
    w.byte(T_STRING);
    w.vbytes(encoder.encode(v));
  } else if (Array.isArray(v)) {
    w.byte(T_ARRAY);
    w.uvarint(v.length);
    for (const item of v) writeNested(w, item);
  } else if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    w.byte(T_OBJECT);
    w.uvarint(entries.length);
    for (const [key, item] of entries) {
      w.vbytes(encoder.encode(key));
      writeNested(w, item);
    }
  } else {
    throw new Error(`a value of the type ${typeof v} cannot be written`);
  }
}

/** Reads a value {@link writeNested} wrote */
export function readNested(r: ByteReader): unknown {
  const t = r.byte();
  switch (t) {
    case T_NULL:
      return null;
    case T_FALSE:
      return false;
    case T_TRUE:
      return true;
    case T_INT:
      return r.svarint();
    case T_FLOAT: {
      const b = r.take(8);
      for (let i = 0; i < 8; i++) f64.setUint8(i, b[i]);
      return f64.getFloat64(0, true);
    }
    case T_STRING:
      return decoder.decode(r.vbytes());
    case T_ARRAY: {
      const n = r.uvarint();
      const out: unknown[] = new Array(n);
      for (let i = 0; i < n; i++) out[i] = readNested(r);
      return out;
    }
    case T_OBJECT: {
      const n = r.uvarint();
      const out: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        const key = decoder.decode(r.vbytes());
        out[key] = readNested(r);
      }
      return out;
    }
  }
  throw new Error(`a nested value of the tag ${t}`);
}

// === Columns of values ===

/** Writes the column of one key of the attributes (or of the style) */
class ValueColumnWriter {
  readonly tags: number[] = [];
  readonly ints = new ByteWriter();
  readonly floats = new XorWriter();
  readonly refs = new ByteWriter();
  readonly literals = new ByteWriter();
  readonly nested = new ByteWriter();
  #prevInt = 0;
  readonly #strings = new Map<string, number>();
  #prevLiteral = new Uint8Array(0);
  readonly #nestedDict = new Map<string, number>();

  absent(): void {
    this.tags.push(T_ABSENT);
  }

  put(v: unknown): void {
    if (v === null) {
      this.tags.push(T_NULL);
    } else if (v === false) {
      this.tags.push(T_FALSE);
    } else if (v === true) {
      this.tags.push(T_TRUE);
    } else if (typeof v === 'number') {
      if (isInt(v)) {
        this.tags.push(T_INT);
        this.ints.svarint(v - this.#prevInt);
        this.#prevInt = v;
      } else {
        this.tags.push(T_FLOAT);
        this.floats.put(v);
      }
    } else if (typeof v === 'string') {
      this.tags.push(T_STRING);
      this.#putString(v);
    } else if (typeof v === 'object') {
      this.tags.push(T_NESTED);
      const w = new ByteWriter();
      writeNested(w, v);
      const bytes = w.finish();
      const key = bytesKey(bytes);
      const known = this.#nestedDict.get(key);
      if (known !== undefined) {
        this.nested.uvarint(known);
      } else {
        const n = this.#nestedDict.size;
        this.#nestedDict.set(key, n);
        this.nested.uvarint(n);
        this.nested.vbytes(bytes);
      }
    } else {
      throw new Error(`a value of the type ${typeof v} cannot be written`);
    }
  }

  #putString(s: string): void {
    const known = this.#strings.get(s);
    if (known !== undefined) {
      this.refs.uvarint(known);
      return;
    }
    const n = this.#strings.size;
    this.#strings.set(s, n);
    this.refs.uvarint(n);
    const bytes = encoder.encode(s);
    const prev = this.#prevLiteral;
    let p = 0;
    while (p < bytes.length && p < prev.length && bytes[p] === prev[p]) p++;
    this.literals.uvarint(p);
    this.literals.vbytes(bytes.subarray(p));
    this.#prevLiteral = bytes;
  }

  write(w: ByteWriter): void {
    w.vbytes(Uint8Array.from(this.tags));
    w.vbytes(this.ints.finish());
    w.vbytes(this.floats.bytes());
    w.vbytes(this.refs.finish());
    w.vbytes(this.literals.finish());
    w.vbytes(this.nested.finish());
  }
}

/** Reads the column {@link ValueColumnWriter} wrote */
class ValueColumnReader {
  readonly #tags: Uint8Array;
  readonly #ints: ByteReader;
  readonly #floats: XorReader;
  readonly #refs: ByteReader;
  readonly #literals: ByteReader;
  readonly #nested: ByteReader;
  #at = 0;
  #prevInt = 0;
  readonly #strings: string[] = [];
  #prevLiteral = new Uint8Array(0);
  readonly #nestedDict: Uint8Array[] = [];

  constructor(r: ByteReader) {
    this.#tags = r.vbytes();
    this.#ints = new ByteReader(r.vbytes());
    this.#floats = new XorReader(r.vbytes());
    this.#refs = new ByteReader(r.vbytes());
    this.#literals = new ByteReader(r.vbytes());
    this.#nested = new ByteReader(r.vbytes());
  }

  /** The value of the next row (undefined when the row does not hold the key) */
  next(): unknown {
    const t = this.#tags[this.#at++];
    switch (t) {
      case T_ABSENT:
        return undefined;
      case T_NULL:
        return null;
      case T_FALSE:
        return false;
      case T_TRUE:
        return true;
      case T_INT:
        this.#prevInt += this.#ints.svarint();
        return this.#prevInt;
      case T_FLOAT:
        return this.#floats.get();
      case T_STRING: {
        const i = this.#refs.uvarint();
        if (i < this.#strings.length) return this.#strings[i];
        const p = this.#literals.uvarint();
        const suffix = this.#literals.vbytes();
        const bytes = new Uint8Array(p + suffix.length);
        bytes.set(this.#prevLiteral.subarray(0, p));
        bytes.set(suffix, p);
        this.#prevLiteral = bytes;
        const s = decoder.decode(bytes);
        this.#strings.push(s);
        return s;
      }
      case T_NESTED: {
        const i = this.#nested.uvarint();
        let bytes = this.#nestedDict[i];
        if (!bytes) {
          bytes = this.#nested.vbytes();
          this.#nestedDict.push(bytes);
        }
        // Each row gets a value of its own
        return readNested(new ByteReader(bytes));
      }
    }
    throw new Error(`a value of the tag ${t}`);
  }
}

/** Writes the columns of a set of keys (the attributes, or the style) of the rows */
function writeValueColumns(w: ByteWriter, rows: readonly Readonly<Record<string, unknown>>[]) {
  const columns = new Map<string, ValueColumnWriter>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.has(key)) columns.set(key, new ValueColumnWriter());
    }
  }
  for (const row of rows) {
    for (const [key, column] of columns) {
      const v = row[key];
      if (v === undefined) column.absent();
      else column.put(v);
    }
  }
  w.uvarint(columns.size);
  for (const [key, column] of columns) {
    w.vbytes(encoder.encode(key));
    column.write(w);
  }
}

function readValueColumns(r: ByteReader, rows: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = new Array(rows);
  for (let i = 0; i < rows; i++) out[i] = {};
  const n = r.uvarint();
  for (let c = 0; c < n; c++) {
    const key = decoder.decode(r.vbytes());
    const column = new ValueColumnReader(r);
    for (let i = 0; i < rows; i++) {
      const v = column.next();
      if (v !== undefined) out[i][key] = v;
    }
  }
  return out;
}

// === Geometry ===

const GEOMETRY_TYPES = [
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
] as const;
/** The levels of arrays around the positions of each type (a Point is one position) */
const GEOMETRY_DEPTH = [0, 1, 2, 1, 2, 3];

const G_NULL = 0;
const G_COLUMNS = 1;
const G_NESTED = 2;

const POW10: number[] = [];
for (let d = 0; d <= 22; d++) POW10.push(10 ** d);
/** The most decimal digits tried (180 x 10^13 is below 2^53) */
const MAX_DECIMALS = 13;

/** The integer of `v` at `d` decimal digits, when it reads back to the same bits (null if not) */
function decimalAt(v: number, d: number): number | null {
  const k = Math.round(v * POW10[d]);
  // -0 is not an integer of the differences (it would read back as 0)
  if (!Number.isInteger(k) || Math.abs(k) > 2 ** 51 || Object.is(k, -0)) return null;
  const back = k / POW10[d];
  return Object.is(back, v) ? k : null;
}

/** The fewest decimal digits `v` reads back with (-1 for none) */
function fewestDecimals(v: number): number {
  for (let d = 0; d <= MAX_DECIMALS; d++) if (decimalAt(v, d) !== null) return d;
  return -1;
}

interface FlatGeometry {
  readonly type: number;
  readonly counts: number[];
  /** The values of the positions, `dims` per position */
  readonly values: number[];
}

/**
 * The type, the counts of the parts and the values of a geometry written as columns: one of the
 * six types with only `type` and `coordinates`, every position of `dims` numbers (null otherwise)
 */
function flatGeometry(g: Geometry, dims: number): FlatGeometry | null {
  const keys = Object.keys(g);
  if (keys.length !== 2 || !keys.includes('type') || !keys.includes('coordinates')) return null;
  const type = GEOMETRY_TYPES.indexOf(g.type as (typeof GEOMETRY_TYPES)[number]);
  if (type < 0) return null;
  const counts: number[] = [];
  const values: number[] = [];
  const walk = (v: unknown, depth: number): boolean => {
    if (!Array.isArray(v)) return false;
    if (depth === 0) {
      if (v.length !== dims) return false;
      for (const x of v) {
        if (typeof x !== 'number') return false;
        values.push(x);
      }
      return true;
    }
    if (v.length === 0) return false;
    counts.push(v.length);
    for (const item of v) if (!walk(item, depth - 1)) return false;
    return true;
  };
  return walk((g as { coordinates: unknown }).coordinates, GEOMETRY_DEPTH[type])
    ? { type, counts, values }
    : null;
}

/** The length of the first position of a geometry (2 when it has none) */
function dimsOf(g: Geometry | null): number {
  let v: unknown = (g as { coordinates?: unknown } | null)?.coordinates;
  while (Array.isArray(v) && Array.isArray(v[0])) v = v[0];
  return Array.isArray(v) && v.length >= 2 && v.length <= 4 ? v.length : 2;
}

// === Segments ===

/** The id of an item: the client that made it and its serial among the items of that client */
export interface ItemId {
  /** 64 bits, as 16 lowercase hex digits */
  readonly client: string;
  readonly serial: number;
}

/** Where the rows of a segment are: a run of an import in a layer */
export interface SegmentPlace {
  /** The id of the layer */
  readonly layer: string;
  /** The key of the head of the run (the rows follow it by their numbers) */
  readonly head: string;
  /** The number of the first row of the segment in the run */
  readonly firstRow: number;
}

/** The source of a row: the client and the number of the batch that wrote it */
export interface RowSource {
  readonly client: string;
  readonly batch: number;
}

/** The rows of a segment */
export interface SegmentRows {
  readonly ids: readonly ItemId[];
  readonly place: SegmentPlace;
  readonly sources: readonly RowSource[];
  readonly deleted: readonly boolean[];
  readonly geometries: readonly (Geometry | null)[];
  readonly properties: readonly Readonly<Record<string, unknown>>[];
  readonly styles: readonly Readonly<Record<string, unknown>>[];
}

/** The bytes of the parts of a segment before it is compressed */
export interface SegmentParts {
  readonly ids: number;
  readonly place: number;
  readonly geometry: number;
  readonly properties: number;
  readonly style: number;
}

const SEGMENT_VERSION = 1;

function clientBytes(client: string): Uint8Array {
  if (!/^[0-9a-f]{16}$/.test(client)) throw new Error(`a client of 16 hex digits: ${client}`);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number.parseInt(client.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function clientOf(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Encodes the rows of a segment (not compressed) */
export function encodeSegment(rows: SegmentRows): { bytes: Uint8Array; parts: SegmentParts } {
  const n = rows.ids.length;
  if (
    rows.sources.length !== n ||
    rows.deleted.length !== n ||
    rows.geometries.length !== n ||
    rows.properties.length !== n ||
    rows.styles.length !== n
  ) {
    throw new Error('every column of a segment has one entry per row');
  }
  const w = new ByteWriter();
  w.byte(SEGMENT_VERSION);
  w.uvarint(n);
  // The clients of the ids and of the sources
  const clients = new Map<string, number>();
  const clientIndex = (c: string): number => {
    let i = clients.get(c);
    if (i === undefined) {
      i = clients.size;
      clients.set(c, i);
    }
    return i;
  };
  const idRuns = new ByteWriter();
  let runs = 0;
  for (let i = 0; i < n; ) {
    const start = rows.ids[i];
    let len = 1;
    while (
      i + len < n &&
      rows.ids[i + len].client === start.client &&
      rows.ids[i + len].serial === start.serial + len
    ) {
      len++;
    }
    idRuns.uvarint(clientIndex(start.client));
    idRuns.uvarint(start.serial);
    idRuns.uvarint(len);
    runs++;
    i += len;
  }
  const sourceRuns = new ByteWriter();
  let sourceRunCount = 0;
  for (let i = 0; i < n; ) {
    const s = rows.sources[i];
    let len = 1;
    while (
      i + len < n &&
      rows.sources[i + len].client === s.client &&
      rows.sources[i + len].batch === s.batch
    ) {
      len++;
    }
    sourceRuns.uvarint(clientIndex(s.client));
    sourceRuns.uvarint(s.batch);
    sourceRuns.uvarint(len);
    sourceRunCount++;
    i += len;
  }
  const start = w.length;
  w.uvarint(clients.size);
  for (const c of clients.keys()) w.bytes(clientBytes(c));
  w.uvarint(runs);
  w.bytes(idRuns.finish());
  w.uvarint(sourceRunCount);
  w.bytes(sourceRuns.finish());
  const idsBytes = w.length - start;

  const p0 = w.length;
  w.vbytes(encoder.encode(rows.place.layer));
  w.vbytes(encoder.encode(rows.place.head));
  w.uvarint(rows.place.firstRow);
  if (rows.deleted.some((d) => d)) {
    w.byte(1);
    w.bytes(Uint8Array.from(rows.deleted, (d) => (d ? 1 : 0)));
  } else {
    w.byte(0);
  }
  const placeBytes = w.length - p0;

  const g0 = w.length;
  writeGeometries(w, rows.geometries);
  const geometryBytes = w.length - g0;
  const a0 = w.length;
  writeValueColumns(w, rows.properties);
  const propertyBytes = w.length - a0;
  const s0 = w.length;
  writeValueColumns(w, rows.styles);
  const styleBytes = w.length - s0;
  return {
    bytes: w.finish(),
    parts: {
      ids: idsBytes,
      place: placeBytes,
      geometry: geometryBytes,
      properties: propertyBytes,
      style: styleBytes,
    },
  };
}

function writeGeometries(w: ByteWriter, geometries: readonly (Geometry | null)[]): void {
  const dims = dimsOf(geometries.find((g) => g !== null) ?? null);
  const flats = geometries.map((g) => (g === null ? null : flatGeometry(g, dims)));
  // The scale of the segment: the most decimal digits a row of integers needs
  let scale = -1;
  const rowScale = flats.map((flat) => {
    if (!flat) return -1;
    let d = 0;
    for (const v of flat.values) {
      const fewest = fewestDecimals(v);
      if (fewest < 0) return -1;
      if (fewest > d) d = fewest;
    }
    return d;
  });
  for (const d of rowScale) if (d > scale) scale = d;
  const tags: number[] = [];
  const types: number[] = [];
  const counts = new ByteWriter();
  const modes: number[] = [];
  const decimals = Array.from({ length: dims }, () => new ByteWriter());
  const xors = Array.from({ length: dims }, () => new XorWriter());
  const previous = new Array<number>(dims).fill(0);
  const nested = new ByteWriter();
  geometries.forEach((g, i) => {
    const flat = flats[i];
    if (g === null) {
      tags.push(G_NULL);
      return;
    }
    if (!flat) {
      tags.push(G_NESTED);
      const nw = new ByteWriter();
      writeNested(nw, g);
      nested.vbytes(nw.finish());
      return;
    }
    tags.push(G_COLUMNS);
    types.push(flat.type);
    for (const c of flat.counts) counts.uvarint(c);
    let ints: number[] | null = null;
    if (scale >= 0 && rowScale[i] >= 0) {
      ints = [];
      for (const v of flat.values) {
        const k = decimalAt(v, scale);
        if (k === null) {
          ints = null;
          break;
        }
        ints.push(k);
      }
    }
    if (ints) {
      modes.push(1);
      for (let j = 0; j < ints.length; j++) {
        const dim = j % dims;
        decimals[dim].svarint(ints[j] - previous[dim]);
        previous[dim] = ints[j];
      }
    } else {
      modes.push(0);
      for (let j = 0; j < flat.values.length; j++) xors[j % dims].put(flat.values[j]);
    }
  });
  w.uvarint(dims);
  w.svarint(scale);
  w.vbytes(Uint8Array.from(tags));
  w.vbytes(Uint8Array.from(types));
  w.vbytes(counts.finish());
  w.vbytes(Uint8Array.from(modes));
  for (const d of decimals) w.vbytes(d.finish());
  for (const x of xors) w.vbytes(x.bytes());
  w.vbytes(nested.finish());
}

function readGeometries(r: ByteReader, rows: number): (Geometry | null)[] {
  const dims = r.uvarint();
  const scale = r.svarint();
  const tags = r.vbytes();
  const types = r.vbytes();
  const counts = new ByteReader(r.vbytes());
  const modes = r.vbytes();
  const decimals = Array.from({ length: dims }, () => new ByteReader(r.vbytes()));
  const xors = Array.from({ length: dims }, () => new XorReader(r.vbytes()));
  const nested = new ByteReader(r.vbytes());
  const previous = new Array<number>(dims).fill(0);
  const divisor = scale >= 0 ? POW10[scale] : 1;
  const out: (Geometry | null)[] = new Array(rows);
  let at = 0;
  for (let i = 0; i < rows; i++) {
    const tag = tags[i];
    if (tag === G_NULL) {
      out[i] = null;
      continue;
    }
    if (tag === G_NESTED) {
      out[i] = readNested(new ByteReader(nested.vbytes())) as Geometry;
      continue;
    }
    const type = types[at];
    const useDecimals = modes[at] === 1;
    at++;
    const position = (): Position => {
      const p: number[] = new Array(dims);
      for (let d = 0; d < dims; d++) {
        if (useDecimals) {
          previous[d] += decimals[d].svarint();
          p[d] = previous[d] / divisor;
        } else {
          p[d] = xors[d].get();
        }
      }
      return p;
    };
    const walk = (depth: number): unknown => {
      if (depth === 0) return position();
      const n = counts.uvarint();
      const items: unknown[] = new Array(n);
      for (let j = 0; j < n; j++) items[j] = walk(depth - 1);
      return items;
    };
    out[i] = {
      type: GEOMETRY_TYPES[type],
      coordinates: walk(GEOMETRY_DEPTH[type]),
    } as Geometry;
  }
  return out;
}

/** Decodes a segment {@link encodeSegment} encoded */
export function decodeSegment(bytes: Uint8Array): SegmentRows {
  const r = new ByteReader(bytes);
  const version = r.byte();
  if (version !== SEGMENT_VERSION) throw new Error(`a segment of the version ${version}`);
  const n = r.uvarint();
  const clientCount = r.uvarint();
  const clients: string[] = [];
  for (let i = 0; i < clientCount; i++) clients.push(clientOf(r.take(8)));
  const ids: ItemId[] = [];
  const idRuns = r.uvarint();
  for (let k = 0; k < idRuns; k++) {
    const client = clients[r.uvarint()];
    const serial = r.uvarint();
    const len = r.uvarint();
    for (let j = 0; j < len; j++) ids.push({ client, serial: serial + j });
  }
  const sources: RowSource[] = [];
  const sourceRuns = r.uvarint();
  for (let k = 0; k < sourceRuns; k++) {
    const source = { client: clients[r.uvarint()], batch: r.uvarint() };
    const len = r.uvarint();
    for (let j = 0; j < len; j++) sources.push(source);
  }
  if (ids.length !== n || sources.length !== n) throw new Error('the runs do not cover the rows');
  const layer = decoder.decode(r.vbytes());
  const head = decoder.decode(r.vbytes());
  const firstRow = r.uvarint();
  const deleted: boolean[] =
    r.byte() === 1 ? Array.from(r.take(n), (b) => b === 1) : new Array<boolean>(n).fill(false);
  const geometries = readGeometries(r, n);
  const properties = readValueColumns(r, n);
  const styles = readValueColumns(r, n);
  if (!r.done) throw new Error('bytes are left after the segment');
  return {
    ids,
    place: { layer, head, firstRow },
    sources,
    deleted,
    geometries,
    properties,
    styles,
  };
}

// === Files ===

const FILE_MAGIC = [0x53, 0x30, 0x42, 0x01];

/** A segment in a file: its rows and its compressed bytes */
export interface PackedSegment {
  readonly rows: number;
  readonly bytes: Uint8Array;
}

/** Puts compressed segments in one file: a header of their rows and lengths, then the bytes */
export function packFile(segments: readonly PackedSegment[]): Uint8Array {
  const w = new ByteWriter();
  w.bytes(Uint8Array.from(FILE_MAGIC));
  w.uvarint(segments.length);
  for (const s of segments) {
    w.uvarint(s.rows);
    w.uvarint(s.bytes.length);
  }
  for (const s of segments) w.bytes(s.bytes);
  return w.finish();
}

/** The compressed segments of a file {@link packFile} made */
export function unpackFile(file: Uint8Array): PackedSegment[] {
  const r = new ByteReader(file);
  const magic = r.take(4);
  if (FILE_MAGIC.some((b, i) => magic[i] !== b)) throw new Error('not a file of segments');
  const n = r.uvarint();
  const heads: { rows: number; length: number }[] = [];
  for (let i = 0; i < n; i++) heads.push({ rows: r.uvarint(), length: r.uvarint() });
  const out = heads.map((h) => ({ rows: h.rows, bytes: r.take(h.length) }));
  if (!r.done) throw new Error('bytes are left after the segments');
  return out;
}

// === Comparing ===

/** Whether two values are the same, numbers by their bits (-0 is not 0) and objects by their keys */
export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') return Object.is(a, b);
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => sameValue(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  const other = new Set(Object.keys(bo));
  if (keys.length !== other.size) return false;
  return keys.every((k) => other.has(k) && sameValue(ao[k], bo[k]));
}
