// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The bytes of the Tabane format: variable-length integers, strings and runs of bytes
 *
 * - An unsigned integer (`uint`) puts 7 bits per byte, the lowest first, with 0x80 on every byte
 *   but the last, in the fewest bytes
 * - A signed integer (`int`) puts the sign in 0x40 of the first byte with the 6 lowest bits of
 *   the magnitude, 0x80 on every byte but the last, then 7 bits per byte, in the fewest bytes
 *   (the signed integer of the canonical bytes of a value, `canonical-value.ts`)
 * - Both are at most 2^53 - 1 in magnitude
 * - A string is its number of bytes (`uint`) and its UTF-8; a run of bytes is its number of
 *   bytes and the bytes
 *
 * A reader refuses what a writer never writes: an integer not in its fewest bytes or above 2^53
 * - 1, UTF-8 that is not well formed, bytes that end early.
 *
 * A pure module: it depends on nothing outside `/table`, so it runs in a Worker as well.
 */

import { DrawError } from '../../shared/draw-error.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** The largest integer the format writes */
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * The error of bytes that are not of the format
 *
 * @internal
 */
export function formatError(message: string): DrawError {
  return new DrawError('unsupported-format', `Tabane: ${message}`);
}

/**
 * Writes bytes, growing as it goes
 *
 * @internal
 */
export class ByteSink {
  private buf: Uint8Array;
  private size = 0;
  private readonly view = new DataView(new ArrayBuffer(8));

  constructor(expected = 256) {
    this.buf = new Uint8Array(Math.max(16, expected));
  }

  /** The number of bytes written */
  get length(): number {
    return this.size;
  }

  private reserve(extra: number): void {
    const needed = this.size + extra;
    if (needed <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < needed) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.size));
    this.buf = next;
  }

  byte(b: number): void {
    this.reserve(1);
    this.buf[this.size++] = b;
  }

  bytes(b: Uint8Array): void {
    this.reserve(b.length);
    this.buf.set(b, this.size);
    this.size += b.length;
  }

  /** An unsigned integer of at most 2^53 - 1 */
  uint(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0) throw formatError(`${n} is not an unsigned integer`);
    this.reserve(8);
    let rest = n;
    while (rest > 0x7f) {
      this.buf[this.size++] = 0x80 | (rest % 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.buf[this.size++] = rest;
  }

  /** A signed integer of at most 2^53 - 1 in magnitude */
  int(n: number): void {
    if (!Number.isSafeInteger(n)) throw formatError(`${n} is not an integer`);
    this.reserve(9);
    const negative = n < 0;
    let rest = negative ? -n : n;
    const first = rest % 0x40;
    rest = Math.floor(rest / 0x40);
    this.buf[this.size++] = (rest > 0 ? 0x80 : 0) | (negative ? 0x40 : 0) | first;
    while (rest > 0) {
      const next = Math.floor(rest / 0x80);
      this.buf[this.size++] = (next > 0 ? 0x80 : 0) | (rest % 0x80);
      rest = next;
    }
  }

  /** A string: its number of bytes and its UTF-8 */
  string(s: string): void {
    this.run(encoder.encode(s));
  }

  /** A run of bytes: its number of bytes and the bytes */
  run(b: Uint8Array): void {
    this.uint(b.length);
    this.bytes(b);
  }

  /** 8 bytes of a float64, big-endian */
  float64(v: number): void {
    this.view.setFloat64(0, v, false);
    this.reserve(8);
    for (let k = 0; k < 8; k++) this.buf[this.size++] = this.view.getUint8(k);
  }

  /** The bytes written */
  finish(): Uint8Array {
    return this.buf.slice(0, this.size);
  }
}

/**
 * Reads what a {@link ByteSink} wrote
 *
 * @internal
 */
export class ByteSource {
  readonly buf: Uint8Array;
  pos: number;
  readonly end: number;

  constructor(buf: Uint8Array, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  byte(): number {
    if (this.pos >= this.end) throw formatError('the bytes end early');
    return this.buf[this.pos++];
  }

  take(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.end) throw formatError('the bytes end early');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  uint(): number {
    let out = 0;
    let scale = 1;
    for (let k = 0; ; k++) {
      const b = this.byte();
      out += (b & 0x7f) * scale;
      if (b < 0x80) {
        if (k > 0 && b === 0) throw formatError('an integer not in its fewest bytes');
        if (out > MAX_SAFE) throw formatError('an integer above 2^53 - 1');
        return out;
      }
      if (k >= 7) throw formatError('an integer above 2^53 - 1');
      scale *= 0x80;
    }
  }

  int(): number {
    const first = this.byte();
    const negative = (first & 0x40) !== 0;
    let out = first & 0x3f;
    if (first & 0x80) {
      let scale = 0x40;
      for (let k = 0; ; k++) {
        const b = this.byte();
        out += (b & 0x7f) * scale;
        if (b < 0x80) {
          if (b === 0) throw formatError('an integer not in its fewest bytes');
          break;
        }
        if (k >= 7) throw formatError('an integer above 2^53 - 1');
        scale *= 0x80;
      }
    }
    if (out > MAX_SAFE) throw formatError('an integer above 2^53 - 1');
    if (negative && out === 0) throw formatError('the integer -0');
    return negative ? -out : out;
  }

  /** A count of things of at least `each` bytes each, checked against the bytes left */
  count(each = 1): number {
    const n = this.uint();
    if (n * each > this.end - this.pos) throw formatError('a count larger than the bytes left');
    return n;
  }

  string(): string {
    const b = this.take(this.uint());
    try {
      return decoder.decode(b);
    } catch {
      throw formatError('a string that is not UTF-8');
    }
  }

  run(): Uint8Array {
    return this.take(this.uint());
  }

  float64(): number {
    const b = this.take(8);
    return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, false);
  }
}

/**
 * The UTF-8 of a string
 *
 * @internal
 */
export function utf8Of(s: string): Uint8Array {
  return encoder.encode(s);
}

/**
 * Compares two runs of bytes (the order of their UTF-8 for strings)
 *
 * @internal
 */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let k = 0; k < n; k++) if (a[k] !== b[k]) return a[k] - b[k];
  return a.length - b.length;
}
