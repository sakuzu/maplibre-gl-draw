// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A stream of float64 values written as the XOR of each with the one before (Gorilla)
 *
 * The 64 bits of each value (its IEEE 754 bits as an integer) are XORed with the bits of the
 * value before it (0 before the first). The bits are written highest first into bytes, the last
 * byte padded with 0 bits:
 *
 * - `0`: the XOR is 0 (the same bits as the value before)
 * - `10`: the meaningful bits of the XOR fit the window of the last `11`: the
 *   `64 - lead - trail` bits of that window
 * - `11`: a new window: `lead` in 5 bits (the number of leading 0 bits, at most 31), the number
 *   of meaningful bits minus 1 in 6 bits, then those bits (`64 - lead - trail` of them, where
 *   `trail` is the number of trailing 0 bits)
 *
 * `10` is written when there was a window before and the XOR has at least its leading and at
 * least its trailing 0 bits; otherwise `11`. Every value reads back to the same bits.
 *
 * A pure module: it depends on nothing outside `/table`, so it runs in a Worker as well.
 */

import { formatError } from './bytes.js';

const f64 = new DataView(new ArrayBuffer(8));

function ctz32(x: number): number {
  return 31 - Math.clz32(x & -x);
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

/**
 * Writes float64 values as the XOR of each with the one before
 *
 * @internal
 */
export class XorSink {
  private out = new Uint8Array(64);
  private bytes = 0;
  /** The free bits of the last byte */
  private free = 0;
  private hi = 0;
  private lo = 0;
  private lead = -1;
  private trail = 0;

  /** The lowest `n` bits of `v` (n at most 32) */
  private write(v: number, n: number): void {
    let left = n;
    while (left > 0) {
      if (this.free === 0) {
        if (this.bytes === this.out.length) {
          const next = new Uint8Array(this.out.length * 2);
          next.set(this.out);
          this.out = next;
        }
        this.out[this.bytes++] = 0;
        this.free = 8;
      }
      const take = Math.min(left, this.free);
      const chunk = (v >>> (left - take)) & ((1 << take) - 1);
      this.out[this.bytes - 1] |= chunk << (this.free - take);
      this.free -= take;
      left -= take;
    }
  }

  private write64(hi: number, lo: number, n: number): void {
    if (n > 32) {
      this.write(hi, n - 32);
      this.write(lo, 32);
    } else {
      this.write(lo, n);
    }
  }

  put(value: number): void {
    f64.setFloat64(0, value, true);
    const lo = f64.getUint32(0, true);
    const hi = f64.getUint32(4, true);
    const xh = (hi ^ this.hi) >>> 0;
    const xl = (lo ^ this.lo) >>> 0;
    this.hi = hi;
    this.lo = lo;
    if (xh === 0 && xl === 0) {
      this.write(0, 1);
      return;
    }
    let lead = xh !== 0 ? Math.clz32(xh) : 32 + Math.clz32(xl);
    const trail = xl !== 0 ? ctz32(xl) : 32 + ctz32(xh);
    if (lead > 31) lead = 31;
    if (this.lead >= 0 && lead >= this.lead && trail >= this.trail) {
      this.write(0b10, 2);
      const [sh, sl] = shiftRight(xh, xl, this.trail);
      this.write64(sh, sl, 64 - this.lead - this.trail);
      return;
    }
    const sig = 64 - lead - trail;
    this.write(0b11, 2);
    this.write(lead, 5);
    this.write(sig - 1, 6);
    const [sh, sl] = shiftRight(xh, xl, trail);
    this.write64(sh, sl, sig);
    this.lead = lead;
    this.trail = trail;
  }

  /** The bytes written */
  finish(): Uint8Array {
    return this.out.slice(0, this.bytes);
  }
}

/**
 * Reads what a {@link XorSink} wrote
 *
 * @internal
 */
export class XorSource {
  private readonly buf: Uint8Array;
  private readonly start: number;
  private readonly end: number;
  /** The position in bits from `start` */
  private pos = 0;
  private hi = 0;
  private lo = 0;
  private lead = -1;
  private trail = 0;

  constructor(buf: Uint8Array, start = 0, end = buf.length) {
    this.buf = buf;
    this.start = start;
    this.end = end;
  }

  /** `n` bits (at most 32) */
  private read(n: number): number {
    let v = 0;
    let left = n;
    while (left > 0) {
      const i = this.start + (this.pos >>> 3);
      if (i >= this.end) throw formatError('a stream of floats ends early');
      const off = this.pos & 7;
      const avail = 8 - off;
      const take = Math.min(left, avail);
      const b = (this.buf[i] >>> (avail - take)) & ((1 << take) - 1);
      v = v * (1 << take) + b;
      this.pos += take;
      left -= take;
    }
    return v >>> 0;
  }

  private read64(n: number): [number, number] {
    if (n > 32) {
      const hi = this.read(n - 32);
      return [hi, this.read(32)];
    }
    return [0, this.read(n)];
  }

  /** The next value */
  get(): number {
    if (this.read(1) === 1) {
      let xh: number;
      let xl: number;
      if (this.read(1) === 0) {
        if (this.lead < 0) throw formatError('a float in a window before any window');
        [xh, xl] = this.read64(64 - this.lead - this.trail);
        [xh, xl] = shiftLeft(xh, xl, this.trail);
      } else {
        const lead = this.read(5);
        const sig = this.read(6) + 1;
        const trail = 64 - lead - sig;
        if (trail < 0) throw formatError('a window of a float past its 64 bits');
        [xh, xl] = this.read64(sig);
        [xh, xl] = shiftLeft(xh, xl, trail);
        this.lead = lead;
        this.trail = trail;
      }
      this.hi = (this.hi ^ xh) >>> 0;
      this.lo = (this.lo ^ xl) >>> 0;
    }
    f64.setUint32(0, this.lo, true);
    f64.setUint32(4, this.hi, true);
    return f64.getFloat64(0, true);
  }

  /** Whether every byte was read but the padding of the last (0 bits) */
  finished(): boolean {
    const used = (this.pos + 7) >>> 3;
    if (this.start + used !== this.end) return false;
    const off = this.pos & 7;
    if (off === 0) return true;
    return (this.buf[this.end - 1] & ((1 << (8 - off)) - 1)) === 0;
  }
}
