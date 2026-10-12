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
 */

import type { FeatureStyle } from '../shared/types/model.js';
import { decodeCanonicalValue, encodeCanonicalValue } from '../table/canonical-value.js';
import { hashByteRun } from '../table/utf8-column.js';

/**
 * The distinct styles of a document, numbered
 *
 * @internal
 */
export class StyleTable {
  /** The canonical bytes of each style */
  private readonly entries: Uint8Array[] = [];
  /** The style of each number, made once and frozen */
  private readonly styles: Array<FeatureStyle | undefined> = [];
  /** The numbers of the styles of each hash */
  private readonly buckets = new Map<number, number[]>();

  /** The number of distinct styles */
  get size(): number {
    return this.entries.length;
  }

  /**
   * The number of a style (the same number for the same contents)
   *
   * @throws when a value of the style cannot be held (a number that is not finite, a function)
   */
  intern(style: Readonly<FeatureStyle>): number {
    return this.internBytes(encodeCanonicalValue(style));
  }

  /**
   * The number of a style given as its canonical bytes `[start, end)` of an array
   */
  internBytes(bytes: Uint8Array, start = 0, end = bytes.length): number {
    const hash = hashByteRun(bytes, start, end);
    let bucket = this.buckets.get(hash);
    if (bucket) {
      for (const id of bucket) {
        if (sameRun(this.entries[id], bytes, start, end)) return id;
      }
    } else {
      bucket = [];
      this.buckets.set(hash, bucket);
    }
    const id = this.entries.length;
    this.entries.push(bytes.slice(start, end));
    this.styles.push(undefined);
    bucket.push(id);
    return id;
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
    if (!bytes) throw new Error(`StyleTable: no style ${id}`);
    const style = Object.freeze(decodeCanonicalValue(bytes) as FeatureStyle);
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
