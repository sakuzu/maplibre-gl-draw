// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The table of the styles of the rows (`StyleTable`)
 *
 * The rows do not hold their styles: a row holds the number of its style in this table, and
 * every row whose style has the same contents has the same number. A map holds few distinct
 * styles (the rows a file brings share one; the ones drawn by hand use a handful of colors), so
 * a row costs 4 bytes for its style, and the values drawn from a style are worked out once per
 * number rather than once per row.
 *
 * Two styles are the same when their canonical bytes are (`canonical-value.ts`): the order of
 * their keys does not count, and a key an extension adds is part of the contents like any
 * other.
 *
 * The table counts the rows that use each number (`retain`, `release`): a color changed again
 * and again would otherwise leave a number behind for every color on the way. A number no row
 * uses any more is taken back and given to the next new style, with a new epoch, so what is kept
 * by number elsewhere (the resolution of the styles by the drawing) can tell a number given
 * again from the one it kept (`epochOf`). A reader that keeps a style past its rows keeps the
 * style itself (`get`), not its number.
 */

import { decodeCanonicalValue, encodeCanonicalValue, hashByteRun } from '@sakuzu/tabane';
import type { FeatureStyle } from '../shared/types/model.js';
import { KasaneError, kasaneErrorOf } from '../table/kasane-error.js';

/**
 * The distinct styles of a document, numbered
 *
 * @internal
 */
export class StyleTable {
  /** The canonical bytes of each style (null for a number taken back) */
  private readonly entries: Array<Uint8Array | null> = [];
  /** The hash of the bytes of each style */
  private readonly hashes: number[] = [];
  /** The style of each number, made once and frozen */
  private readonly styles: Array<FeatureStyle | undefined> = [];
  /** The numbers of the styles of each hash */
  private readonly buckets = new Map<number, number[]>();
  /** The rows that use each number */
  private uses = new Int32Array(16);
  /** The times each number was given again */
  private epochs = new Uint32Array(16);
  /** The numbers taken back, to be given again */
  private readonly free: number[] = [];
  /** The number of times a number was given to a style (new or given again) */
  private given = 0;

  /** Changes every time a number is given to a style: what is kept by the styles held is read again */
  get revision(): number {
    return this.given;
  }

  /** The number of distinct styles held */
  get size(): number {
    return this.entries.length - this.free.length;
  }

  /** The numbers given so far, held or taken back (the size of a table indexed by number) */
  get capacity(): number {
    return this.entries.length;
  }

  /**
   * The number of a style (the same number for the same contents)
   *
   * @throws when a value of the style cannot be held (a number that is not finite, a function)
   */
  intern(style: Readonly<FeatureStyle>): number {
    let bytes: Uint8Array;
    try {
      bytes = encodeCanonicalValue(style);
    } catch (error) {
      throw kasaneErrorOf(error);
    }
    return this.internBytes(bytes);
  }

  /**
   * The number of a style given as its canonical bytes `[start, end)` of an array
   */
  internBytes(bytes: Uint8Array, start = 0, end = bytes.length): number {
    const hash = hashByteRun(bytes, start, end);
    let bucket = this.buckets.get(hash);
    if (bucket) {
      for (const id of bucket) {
        if (sameRun(this.entries[id] as Uint8Array, bytes, start, end)) return id;
      }
    } else {
      bucket = [];
      this.buckets.set(hash, bucket);
    }
    const reused = this.free.pop();
    const id = reused ?? this.entries.length;
    if (reused === undefined) {
      this.entries.push(null);
      this.hashes.push(0);
      this.styles.push(undefined);
      this.reserve(id + 1);
    } else {
      this.epochs[id]++;
    }
    this.given++;
    this.entries[id] = bytes.slice(start, end);
    this.hashes[id] = hash;
    this.styles[id] = undefined;
    this.uses[id] = 0;
    bucket.push(id);
    return id;
  }

  /** Whether a number holds a style */
  has(id: number): boolean {
    return this.entries[id] != null;
  }

  /** The times a number was given again (a number kept with its epoch is the same style) */
  epochOf(id: number): number {
    return this.epochs[id] ?? 0;
  }

  /** The rows that use a number */
  usesOf(id: number): number {
    return this.uses[id] ?? 0;
  }

  /** Counts `count` more rows that use a number */
  retain(id: number, count = 1): void {
    if (!this.entries[id]) throw new KasaneError('not-found', `StyleTable: no style ${id}`);
    this.uses[id] += count;
  }

  /**
   * Counts `count` rows less that use a number; a number no row uses any more is taken back
   * (given again to the next new style)
   */
  release(id: number, count = 1): void {
    if (!this.entries[id]) return;
    this.uses[id] -= count;
    if (this.uses[id] > 0) return;
    this.uses[id] = 0;
    const bucket = this.buckets.get(this.hashes[id]);
    if (bucket) {
      const at = bucket.indexOf(id);
      if (at >= 0) bucket.splice(at, 1);
      if (bucket.length === 0) this.buckets.delete(this.hashes[id]);
    }
    this.entries[id] = null;
    this.styles[id] = undefined;
    this.free.push(id);
  }

  private reserve(n: number): void {
    if (n <= this.uses.length) return;
    let size = this.uses.length * 2;
    while (size < n) size *= 2;
    const uses = new Int32Array(size);
    uses.set(this.uses);
    this.uses = uses;
    const epochs = new Uint32Array(size);
    epochs.set(this.epochs);
    this.epochs = epochs;
  }

  /**
   * The style of a number: the same frozen object every time
   *
   * @throws when the number was never given
   */
  get(id: number): FeatureStyle {
    const cached = this.styles[id];
    if (cached) return cached;
    const bytes = this.entries[id];
    if (!bytes) throw new KasaneError('not-found', `StyleTable: no style ${id}`);
    let decoded: unknown;
    try {
      decoded = decodeCanonicalValue(bytes);
    } catch (error) {
      throw kasaneErrorOf(error);
    }
    const style = Object.freeze(decoded as FeatureStyle);
    this.styles[id] = style;
    return style;
  }
}

/** Whether a stored entry holds the bytes `[start, end)` of an array */
function sameRun(entry: Uint8Array, bytes: Uint8Array, start: number, end: number): boolean {
  if (entry.length !== end - start) return false;
  for (let k = 0; k < entry.length; k++) {
    if (entry[k] !== bytes[start + k]) return false;
  }
  return true;
}
