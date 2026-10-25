// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The features made of rows, kept by the version of their rows (`FeatureCache`)
 *
 * A feature made of a row is kept by the handle of the row, with the write mark of the row and
 * the row group it was read in (`write-marks.ts`), and given again while the row has that mark
 * in that group: a write of the row stamps a later mark on it, and a row read in another group
 * (a next version, the delta made again, rows taken in) is made again. A small number is kept,
 * the one used longest ago going first.
 *
 * - A row written in the frame of writes under way may be written again under the same mark: what
 *   is made of it then is not kept, and nothing kept is given for it
 * - A row stamped outside a frame that raised the mark (`WriteMarks.onUnframedStamp`) has a mark
 *   that does not tell it from before: what is kept of it is forgotten
 * - A row held as a feature is not kept: it has its own feature
 * - Tables whose marks no keeper gives keep nothing (every write of theirs has the same mark)
 * - The reads of many rows one after the other (a page of a list, every feature in order) give
 *   what is kept and keep nothing more (`withoutKeeping`), so that they do not push out what the
 *   reads of one row at a time keep
 *
 * A feature given is shared by the reads of its row: it is not to be changed. While it is checked
 * (`watch`, the check `feature-cache` of `DrawOptions.debug.checks`), what is kept is frozen, and
 * compared with the feature its row makes when it is given again.
 */

import type { Feature } from '../shared/types/model.js';
import type { RowPlace } from './feature-tables.js';
import type { RowGroup } from './layer-table.js';
import { type RowReadContext, rowFeature } from './row-read.js';
import type { RowHandle } from './types.js';
import type { WriteMarks } from './write-marks.js';

/** The most features kept */
const FEATURE_CACHE_LIMIT = 1024;

/** The problems the check keeps at most until they are read */
const PROBLEM_LIMIT = 20;

/**
 * What the cache reads of its tables
 *
 * @internal
 */
export interface FeatureCacheHost {
  readonly writeMarks: WriteMarks;
  readonly readContext: RowReadContext;
  /** Whether the row of a handle is held as a feature */
  isHeld(handle: RowHandle): boolean;
  /** Where the row of a handle is read (undefined for a handle of no row) */
  placeOf(handle: RowHandle): RowPlace | undefined;
}

/** A feature kept, the version of the row it was made of, and its place in the order of use */
interface Kept {
  readonly handle: RowHandle;
  readonly feature: Feature;
  /** The write mark of the row */
  readonly mark: number;
  /** The number of the row group it was read in (`#groupNumber`) */
  readonly group: number;
  /** The one used before it, and after it */
  older: Kept | null;
  newer: Kept | null;
}

/**
 * The features made of the rows of tables, kept by the versions of their rows
 *
 * @internal
 */
export class FeatureCache {
  /** The features kept by the handles of their rows */
  readonly #kept = new Map<RowHandle, Kept>();
  /**
   * The one used longest ago and the one used last: the order of use is a list of its own, since
   * a Map taking out and putting back a key on every read costs more than making the feature
   */
  #oldest: Kept | null = null;
  #newest: Kept | null = null;
  /** The numbers of the row groups read, which a feature kept names (not their objects) */
  readonly #groupNumbers = new WeakMap<RowGroup, number>();
  #nextGroup = 0;
  /** The depth of the reads that keep nothing (`withoutKeeping`) */
  #passing = 0;
  /** Whether what is kept is checked (`watch`) */
  #watched = false;
  readonly #problems: string[] = [];

  constructor(private readonly host: FeatureCacheHost) {
    // A row stamped outside a frame that raised the mark has the mark it had before
    host.writeMarks.onUnframedStamp = (handle) => this.#forget(handle);
  }

  /** The number of features kept */
  get size(): number {
    return this.#kept.size;
  }

  /**
   * The feature of a row not deleted: the one kept for it while its row has the version it was
   * made of, made and kept otherwise (see the module)
   *
   * @throws when the coordinates of the layer are not `xy` (see `rowFeature`)
   */
  featureOf(layerId: string, group: RowGroup, row: number): Feature {
    const context = this.host.readContext;
    // A layer whose coordinates were raised is not made a feature, kept or not
    if (context.dimensionsOf(layerId) !== 'xy') return rowFeature(context, layerId, group, row);
    const handle = group.data.handles[row];
    const mark = group.marks[row];
    if (!this.host.writeMarks.settled(mark) || this.host.isHeld(handle)) {
      this.#forget(handle);
      return rowFeature(context, layerId, group, row);
    }
    const number = this.#groupNumber(group);
    const kept = this.#kept.get(handle);
    if (kept && kept.mark === mark && kept.group === number) {
      if (this.#watched) this.#check(kept, layerId, group, row);
      if (this.#passing === 0 && kept !== this.#newest) {
        this.#unlink(kept);
        this.#append(kept);
      }
      return kept.feature;
    }
    if (kept) this.#forget(handle);
    const feature = rowFeature(context, layerId, group, row);
    if (this.#passing > 0) return feature;
    if (this.#watched) deepFreeze(feature);
    const entry: Kept = { handle, feature, mark, group: number, older: null, newer: null };
    this.#kept.set(handle, entry);
    this.#append(entry);
    if (this.#kept.size > FEATURE_CACHE_LIMIT) this.#forget((this.#oldest as Kept).handle);
    return feature;
  }

  /**
   * Runs reads of many rows one after the other: they give what is kept, and keep nothing more
   */
  withoutKeeping<T>(read: () => T): T {
    this.#passing++;
    try {
      return read();
    } finally {
      this.#passing--;
    }
  }

  /** Forgets every feature kept */
  clear(): void {
    this.#kept.clear();
    this.#oldest = null;
    this.#newest = null;
  }

  /**
   * Checks what is kept from now on: a feature kept is frozen, and a feature given again has the
   * mark of its row and is the feature its row makes now (`takeProblems`)
   */
  watch(): void {
    if (this.#watched) return;
    this.#watched = true;
    for (const kept of this.#kept.values()) deepFreeze(kept.feature);
  }

  /**
   * The problems the features given again had since the last read (see `watch`), and the ones of
   * the features kept now: each one whose row has the version it was made of is the feature the
   * row makes now
   */
  takeProblems(): string[] {
    const problems = this.#problems.splice(0);
    for (const [handle, kept] of this.#kept) {
      if (problems.length >= PROBLEM_LIMIT) break;
      const place = this.host.placeOf(handle);
      if (!place || this.host.isHeld(handle)) continue;
      const { group, row } = place;
      if (group.marks[row] !== kept.mark || this.#groupNumbers.get(group) !== kept.group) continue;
      if (this.host.readContext.dimensionsOf(place.layer.layerId) !== 'xy') continue;
      const now = rowFeature(this.host.readContext, place.layer.layerId, group, row);
      if (!sameValue(kept.feature, now)) {
        problems.push(
          `the feature kept for the row ${handle} of the write mark ${kept.mark} is not the one its row makes now`,
        );
      }
    }
    return problems;
  }

  #check(kept: Kept, layerId: string, group: RowGroup, row: number): void {
    if (this.#problems.length >= PROBLEM_LIMIT) return;
    const handle = group.data.handles[row];
    // The row is read where its handle is read now, with the mark kept
    const place = this.host.placeOf(handle);
    const now = place ? place.group.marks[place.row] : undefined;
    if (now !== kept.mark) {
      this.#problems.push(
        `the feature kept for the row ${handle} has the write mark ${kept.mark}, and its row ${now ?? 'none'}`,
      );
      return;
    }
    if (!sameValue(kept.feature, rowFeature(this.host.readContext, layerId, group, row))) {
      this.#problems.push(
        `the feature kept for the row ${handle} of the write mark ${kept.mark} is not the one its row makes now`,
      );
    }
  }

  /** Forgets the feature kept of a row */
  #forget(handle: RowHandle): void {
    const kept = this.#kept.get(handle);
    if (!kept) return;
    this.#kept.delete(handle);
    this.#unlink(kept);
  }

  #unlink(kept: Kept): void {
    if (kept.older) kept.older.newer = kept.newer;
    else this.#oldest = kept.newer;
    if (kept.newer) kept.newer.older = kept.older;
    else this.#newest = kept.older;
    kept.older = null;
    kept.newer = null;
  }

  #append(kept: Kept): void {
    kept.older = this.#newest;
    if (this.#newest) this.#newest.newer = kept;
    else this.#oldest = kept;
    this.#newest = kept;
  }

  #groupNumber(group: RowGroup): number {
    let number = this.#groupNumbers.get(group);
    if (number === undefined) {
      number = this.#nextGroup++;
      this.#groupNumbers.set(group, number);
    }
    return number;
  }
}

/**
 * Freezes the arrays and the plain objects of a value made of a row, and what they hold (one
 * already frozen, a style of the table of styles, is left as it is, and so are other objects)
 */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
}

/** Whether two values made of rows are the same: arrays and objects by their items */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!(key in b)) return false;
    if (!sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}
