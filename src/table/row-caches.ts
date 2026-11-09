// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The caches of the rows (`RowCache`): numbers the user of the tables makes of each row, kept
 * with the row blocks
 *
 * The user of the tables declares its caches: a name, the width of their numbers, how the numbers
 * of a row are made from what is read of it (`RowRead`, and the ring it draws), and how numbers
 * kept of a row are checked against it. The tables make the numbers of a row where the row is
 * built (the builder of the row blocks, in a Worker or on the main thread) and where it is written
 * in place, and copy them as they are where the row does not change: a merge and the next version
 * of a row block copy them, so the numbers of a row are made again only when it changes. Numbers
 * kept elsewhere (a cache of the file of a block) are checked with the function of their user
 * before they are copied.
 *
 * The numbers of the rows of a row block are kept in one column per cache (`RowCacheColumn`): a
 * run of the numbers of every row, and the rows whose numbers are wider than the width of the
 * cache in a run of their own.
 *
 * A pure module: it runs in a Worker as well.
 */

import type { RowRead } from './row-read-type.js';

/** The numbers of a row of a cache */
export type RowCacheNumbers = Uint16Array | Uint32Array;

/** The numbers of a row of no cache, or of a row that has none */
const NO_NUMBERS = new Uint16Array(0);

/**
 * A cache the user of the tables declares: numbers it makes of each row
 *
 * @internal
 */
export interface RowCache {
  /**
   * The name of the cache: what it holds and the version of how it is made (a change to how the
   * numbers are made is a new name)
   */
  readonly name: string;
  /**
   * The bits each number is kept in: 16, or 32. With 16, a row whose numbers are given as 32 bits
   * (a `Uint32Array`) or are not all below 65,536 keeps them in 32
   */
  readonly width: 16 | 32;
  /**
   * The numbers of a row (none: an empty array)
   *
   * @param row The row
   * @param ring The ring the row draws around its point (`RowRings`; null for none)
   */
  build(row: RowRead, ring: Float64Array | null): ArrayLike<number>;
  /**
   * Whether numbers kept of a row elsewhere (with a block read) are those of the row: numbers
   * that do not fit are made again
   *
   * @param row The row
   * @param ring The ring the row draws around its point (`RowRings`; null for none)
   * @param numbers The numbers kept of it
   */
  fits(row: RowRead, ring: Float64Array | null, numbers: ArrayLike<number>): boolean;
}

/**
 * The numbers of a cache of the rows of a row block
 *
 * The numbers of row `r` are `numbers[offsets[r]..offsets[r + 1]]`, unless they are wider than
 * the width of the cache: then they are in `wideNumbers`, at the place of the row in `wideRows`.
 *
 * @internal
 */
export interface RowCacheColumn {
  /** The name of the cache (`RowCache.name`) */
  readonly name: string;
  /** Where the numbers of each row start in `numbers` (rows + 1 values) */
  readonly offsets: Int32Array;
  /** The numbers of the rows, of the width of the cache */
  readonly numbers: RowCacheNumbers;
  /** The rows whose numbers are wider than the width of the cache, ascending */
  readonly wideRows: Int32Array;
  /** Where the numbers of each of `wideRows` start in `wideNumbers` (`wideRows` + 1 values) */
  readonly wideOffsets: Int32Array;
  /** The numbers of `wideRows` */
  readonly wideNumbers: Uint32Array;
}

/**
 * The numbers of a row in a column of a cache (an empty array for a row that has none)
 *
 * @internal
 */
export function cacheNumbersOf(column: RowCacheColumn, row: number): RowCacheNumbers {
  const start = column.offsets[row];
  const end = column.offsets[row + 1];
  if (end > start) return column.numbers.subarray(start, end);
  const wide = wideIndexOf(column.wideRows, row);
  if (wide < 0) return column.numbers.subarray(start, start);
  return column.wideNumbers.subarray(column.wideOffsets[wide], column.wideOffsets[wide + 1]);
}

/**
 * Whether a row holds numbers in a cache of its row block
 *
 * @internal
 */
export function holdsCacheNumbers(caches: readonly RowCacheColumn[], row: number): boolean {
  for (const column of caches) {
    if (column.offsets[row + 1] > column.offsets[row]) return true;
    if (wideIndexOf(column.wideRows, row) >= 0) return true;
  }
  return false;
}

/** The place of a row in an ascending list of rows (-1 when it is not there) */
function wideIndexOf(rows: Int32Array, row: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid] === row) return mid;
    if (rows[mid] < row) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Whether numbers of a row are to be kept wider than the width of their cache
 *
 * @internal
 */
export function isWide(width: 16 | 32, numbers: ArrayLike<number>, from = 0, to = numbers.length) {
  if (width === 32) return false;
  if (numbers instanceof Uint32Array) return true;
  for (let k = from; k < to; k++) if (numbers[k] >= 65_536) return true;
  return false;
}

/**
 * Writes the numbers of a cache of the rows of a row block, a row at a time in the order of the
 * rows
 *
 * @internal
 */
export class RowCacheWriter {
  private readonly offsets: Int32Array;
  private numbers: number[] = [];
  private readonly wideRows: number[] = [];
  private readonly wideOffsets: number[] = [0];
  private readonly wideNumbers: number[] = [];

  /**
   * @param name The name of the cache
   * @param width The width of its numbers
   * @param rows The number of rows of the row block
   */
  constructor(
    private readonly name: string,
    private readonly width: 16 | 32,
    rows: number,
  ) {
    this.offsets = new Int32Array(rows + 1);
  }

  /** A row without numbers */
  skip(row: number): void {
    this.offsets[row + 1] = this.numbers.length;
  }

  /**
   * The numbers of a row, `numbers[from..to]`
   *
   * @param wide Whether they are kept wider than the width of the cache (when omitted: when they
   *   are given as 32 bits or do not fit it, `isWide`)
   */
  put(
    row: number,
    numbers: ArrayLike<number>,
    from = 0,
    to = numbers.length,
    wide = isWide(this.width, numbers, from, to),
  ): void {
    if (wide && this.width === 16) {
      if (to > from) {
        this.wideRows.push(row);
        for (let k = from; k < to; k++) this.wideNumbers.push(numbers[k]);
        this.wideOffsets.push(this.wideNumbers.length);
      }
    } else {
      for (let k = from; k < to; k++) this.numbers.push(numbers[k]);
    }
    this.offsets[row + 1] = this.numbers.length;
  }

  finish(): RowCacheColumn {
    return {
      name: this.name,
      offsets: this.offsets,
      numbers: this.width === 16 ? Uint16Array.from(this.numbers) : Uint32Array.from(this.numbers),
      wideRows: Int32Array.from(this.wideRows),
      wideOffsets: Int32Array.from(this.wideOffsets),
      wideNumbers: Uint32Array.from(this.wideNumbers),
    };
  }
}

/**
 * The columns of the caches of the rows of a row block made of each row, in the order of the
 * caches declared
 *
 * @param caches The caches declared
 * @param rows The number of rows
 * @param readOf What is read of row `r` and the ring it draws (null for a row that has no numbers:
 *   a row without a shape)
 * @internal
 */
export function buildCacheColumns(
  caches: readonly RowCache[],
  rows: number,
  readOf: (r: number) => { read: RowRead; ring: Float64Array | null } | null,
): RowCacheColumn[] {
  if (caches.length === 0) return [];
  const writers = caches.map((cache) => new RowCacheWriter(cache.name, cache.width, rows));
  for (let r = 0; r < rows; r++) {
    const read = readOf(r);
    for (let c = 0; c < caches.length; c++) {
      if (read) writers[c].put(r, caches[c].build(read.read, read.ring));
      else writers[c].skip(r);
    }
  }
  return writers.map((writer) => writer.finish());
}

/**
 * The columns of a row block in the order of the caches declared, by their names; null when they
 * are already in that order
 *
 * @param missing Makes the column of a cache the row block does not hold
 * @internal
 */
export function cacheColumnsIn(
  columns: readonly RowCacheColumn[],
  caches: readonly RowCache[],
  missing: (cache: RowCache) => RowCacheColumn,
): RowCacheColumn[] | null {
  if (
    columns.length === caches.length &&
    columns.every((column, c) => column.name === caches[c].name)
  ) {
    return null;
  }
  return caches.map(
    (cache) => columns.find((column) => column.name === cache.name) ?? missing(cache),
  );
}

/**
 * The numbers of a row of no cache
 *
 * @internal
 */
export function noCacheNumbers(): RowCacheNumbers {
  return NO_NUMBERS;
}
