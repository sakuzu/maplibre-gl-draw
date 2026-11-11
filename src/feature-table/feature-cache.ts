// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The features made of rows, kept by the version of their rows (`FeatureCache`)
 *
 * A feature made of a row is kept by the handle of the row, with the write mark of the row and
 * the row group it was read in (`write-marks.ts`), and given again while the row has that mark
 * in that group: a write of the row stamps a later mark on it, and a row read in another group
 * (a next version, the delta made again, rows taken in) is made again. A small number is kept,
 * the one used longest ago going first; the features of the rows selected (`keepSelected`) are
 * kept besides while the rows are selected, so that the reads of a selection of more rows than
 * that number do not push each other out.
 *
 * - A row written in the frame of writes under way may be written again under the same mark: what
 *   is made of it then is not kept, and nothing kept is given for it
 * - A row stamped outside a frame that raised the mark has a mark that does not tell it from
 *   before: what is kept of it is forgotten. The keeper of the marks of the Store tells both
 *   (`followFrames`)
 * - Tables whose marks no keeper gives keep nothing (every write of theirs has the same mark)
 * - The reads of many rows one after the other (a page of a list, every feature in order) give
 *   what is kept and keep nothing more (`withoutKeeping`), so that they do not push out what the
 *   reads of one row at a time keep; the feature of a row selected is kept by them too
 * - The rows selected are found by their ids without the table of the ids (`selectedHandleOf`)
 *   while no id has got or lost a handle since they were found by it
 *
 * A feature given is shared by the reads of its row: it is not to be changed. While it is checked
 * (`watch`, the check `feature-cache` of `DrawOptions.debug.checks`), what is kept is frozen, and
 * compared with the feature its row makes when it is given again.
 */

import type { RowHandle } from '@sakuzu/kasane';
import type { RowGroup, RowPlace, WriteMarks } from '@sakuzu/kasane/engine';
import { ROW_FLAG_DELETED } from '@sakuzu/kasane/engine';
import type { Feature } from '../shared/types/model.js';
import { type RowReadContext, rowFeature } from './row-read.js';

/** No row selected */
const NO_ROWS: ReadonlySet<RowHandle> = new Set();

/** The most features kept */
const FEATURE_CACHE_LIMIT = 1024;

/** The problems the check keeps at most until they are read */
const PROBLEM_LIMIT = 20;

/**
 * The frames of writes the write marks of the rows are given by (the keeper of the marks of the
 * Store, `write-mark-keeper.ts`)
 *
 * @internal
 */
export interface WriteFrames {
  /**
   * Whether a row of a mark is not written again under it: the row was not written in the frame
   * under way (whose rows may be written again under its mark)
   */
  settled(mark: number): boolean;
}

/**
 * What the cache reads of its tables
 *
 * @internal
 */
export interface FeatureCacheHost {
  readonly writeMarks: WriteMarks;
  readonly readContext: RowReadContext;
  /** Where the row of a handle is read (undefined for a handle of no row) */
  placeOf(handle: RowHandle): RowPlace | undefined;
  /** A number that changes whenever an id gets a handle or loses it (`IdIndex.version`) */
  idsVersion(): number;
  /** A number that changes with every change of the rows drawn (`FeatureTablesInternals.revision`) */
  revision(): number;
}

/** A feature kept, the version of the row it was made of, and its place in the order of use */
interface Kept {
  readonly handle: RowHandle;
  readonly feature: Feature;
  /** The write mark of the row */
  readonly mark: number;
  /** The number of the row group it was read in (`#groupNumber`) */
  readonly group: number;
  /** The one used before it, and after it (none for the feature of a row selected) */
  older: Kept | null;
  newer: Kept | null;
  /** Whether its row is selected: then it is not in the order of use, nor counted in the limit */
  selected: boolean;
}

/**
 * The handle an id selected was found to have, and the version of the ids then; the feature kept
 * of its row last found to have the version of its row, and what the rows were then (the revision
 * of the rows drawn and the rows stamped: while they are the same, no row was written or placed
 * elsewhere since)
 */
interface FoundId {
  readonly handle: RowHandle;
  readonly version: number;
  kept: Kept | null;
  layerId: string;
  revision: number;
  stamped: number;
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
  /** The rows selected (`keepSelected`) */
  #selected: ReadonlySet<RowHandle> = NO_ROWS;
  /** The number of features kept of rows selected */
  #selectedKept = 0;
  /** The handles the ids of rows selected were found to have (`noteSelectedId`) */
  #selectedIds = new Map<string, FoundId>();
  /** What the rows were when the features of the ids selected were last found (`FoundId`) */
  #foundRevision = -1;
  #foundStamped = -1;
  /** Whether what is kept is checked (`watch`) */
  #watched = false;
  readonly #problems: string[] = [];
  /** The frames the marks are given by (none: nothing is kept) */
  #frames: WriteFrames | null = null;

  constructor(private readonly host: FeatureCacheHost) {}

  /**
   * Takes the frames the marks of the rows are given by, from when they are given by them: what
   * forgets what is kept of a row stamped outside a frame that raised the mark (its mark is the
   * one it had before)
   */
  followFrames(frames: WriteFrames): (handle: RowHandle) => void {
    this.#frames = frames;
    return (handle) => this.#forget(handle);
  }

  /** Whether a row of a mark is not written again under it (never, without frames) */
  #settled(mark: number): boolean {
    return this.#frames?.settled(mark) === true;
  }

  /** The number of features kept */
  get size(): number {
    return this.#kept.size;
  }

  /**
   * Keeps the features of the rows selected while they are selected, besides the number kept of
   * the others: the ones not kept are made now (a feature of a row no longer selected goes into
   * the order of use, as used last)
   *
   * @param handles The rows selected (none for no row)
   * @param ids The id of each of them, when it is known (each is found by it from now on)
   */
  keepSelected(handles: readonly RowHandle[] | null, ids?: readonly string[]): void {
    const before = this.#selected;
    const foundBefore = this.#selectedIds;
    // The same rows, found by the same ids: what their ids find is read again when rows were
    // written or placed elsewhere since it was read
    if (
      handles &&
      handles.length === before.size &&
      handles.every((handle) => before.has(handle)) &&
      (!ids || ids.every((id, i) => foundBefore.get(id)?.handle === handles[i]))
    ) {
      const revision = this.host.revision();
      const stamped = this.host.writeMarks.stamped;
      if (ids && (this.#foundRevision !== revision || this.#foundStamped !== stamped)) {
        for (const id of ids) this.selectedFeatureOf(id);
        this.#foundRevision = revision;
        this.#foundStamped = stamped;
      }
      return;
    }
    const selected = handles ? new Set(handles) : NO_ROWS;
    if (selected.size === 0 && before.size === 0) return;
    this.#selected = selected;
    this.#selectedIds = new Map();
    const version = this.host.idsVersion();
    // An id found before for a row still selected is kept, with the feature found for it
    const byHandle = new Map<RowHandle, FoundId>();
    if (handles && ids) {
      handles.forEach((handle, i) => {
        const old = foundBefore.get(ids[i]);
        const found =
          old && old.handle === handle && old.version === version ? old : foundId(handle, version);
        this.#selectedIds.set(ids[i], found);
        byHandle.set(handle, found);
      });
    } else {
      for (const [id, found] of foundBefore) {
        if (selected.has(found.handle)) this.#selectedIds.set(id, found);
      }
    }
    for (const handle of before) {
      const kept = this.#kept.get(handle);
      if (!kept?.selected || selected.has(handle)) continue;
      kept.selected = false;
      this.#selectedKept--;
      this.#append(kept);
    }
    const revision = this.host.revision();
    const stamped = this.host.writeMarks.stamped;
    for (const handle of selected) {
      const kept = this.#kept.get(handle);
      // Kept for the selection before: read again when it is read
      if (kept?.selected) continue;
      if (kept) {
        this.#unlink(kept);
        kept.selected = true;
        this.#selectedKept++;
      }
      // Made now unless kept as its row is: the reads of the selection that follow give it (a row
      // deleted, or of a layer whose coordinates were raised, is not made a feature)
      const place = this.host.placeOf(handle);
      if (!place || (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0) continue;
      const layerId = place.table.tableId;
      if (this.host.readContext.dimensionsOf(layerId) !== 'xy') continue;
      this.featureOf(layerId, place.group, place.row);
      // What its id finds from now on, while no row is written or placed elsewhere
      const found = byHandle.get(handle);
      const made = this.#kept.get(handle);
      if (!found || !made) continue;
      found.kept = made;
      found.layerId = layerId;
      found.revision = revision;
      found.stamped = stamped;
    }
    this.#foundRevision = revision;
    this.#foundStamped = stamped;
    this.#trim();
  }

  /**
   * The handle an id of a row selected was found to have, while no id has got or lost a handle
   * since (undefined otherwise: the id is looked up in the table of the ids then)
   */
  selectedHandleOf(id: string): RowHandle | undefined {
    if (this.#selectedIds.size === 0) return undefined;
    const found = this.#selectedIds.get(id);
    return found && found.version === this.host.idsVersion() ? found.handle : undefined;
  }

  /**
   * The feature kept of a row selected, found by its id (`selectedHandleOf`), while its row has
   * the version it was made of: undefined otherwise, the row is read as any other then
   */
  selectedFeatureOf(id: string): Feature | undefined {
    if (this.#selectedIds.size === 0) return undefined;
    const found = this.#selectedIds.get(id);
    if (!found || found.version !== this.host.idsVersion() || this.#watched) return undefined;
    const kept = this.#kept.get(found.handle);
    if (!kept) return undefined;
    const revision = this.host.revision();
    const stamped = this.host.writeMarks.stamped;
    const context = this.host.readContext;
    // No row written or placed elsewhere since it was found to have the version of its row
    if (found.kept === kept && found.revision === revision && found.stamped === stamped) {
      return context.dimensionsOf(found.layerId) === 'xy' ? kept.feature : undefined;
    }
    const place = this.host.placeOf(found.handle);
    if (!place) return undefined;
    const { group, row } = place;
    const layerId = place.table.tableId;
    if (
      group.marks[row] !== kept.mark ||
      (group.data.flags[row] & ROW_FLAG_DELETED) !== 0 ||
      this.#groupNumbers.get(group) !== kept.group ||
      !this.#settled(kept.mark) ||
      context.dimensionsOf(layerId) !== 'xy'
    ) {
      return undefined;
    }
    found.kept = kept;
    found.layerId = layerId;
    found.revision = revision;
    found.stamped = stamped;
    return kept.feature;
  }

  /** Notes the handle an id was found to have in the table of the ids, when its row is selected */
  noteSelectedId(id: string, handle: RowHandle): void {
    if (this.#selected.size === 0 || !this.#selected.has(handle)) return;
    this.#selectedIds.set(id, foundId(handle, this.host.idsVersion()));
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
    if (!this.#settled(mark)) {
      this.#forget(handle);
      return rowFeature(context, layerId, group, row);
    }
    const number = this.#groupNumber(group);
    const kept = this.#kept.get(handle);
    if (kept && kept.mark === mark && kept.group === number) {
      if (this.#watched) this.#check(kept, layerId, group, row);
      if (this.#passing === 0 && !kept.selected && kept !== this.#newest) {
        this.#unlink(kept);
        this.#append(kept);
      }
      return kept.feature;
    }
    if (kept) this.#forget(handle);
    const feature = rowFeature(context, layerId, group, row);
    const selected = this.#selected.has(handle);
    if (this.#passing > 0 && !selected) return feature;
    if (this.#watched) deepFreeze(feature);
    const entry: Kept = {
      handle,
      feature,
      mark,
      group: number,
      older: null,
      newer: null,
      selected,
    };
    this.#kept.set(handle, entry);
    if (selected) {
      this.#selectedKept++;
      return feature;
    }
    this.#append(entry);
    this.#trim();
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

  /**
   * Forgets every feature kept, the ones found for the ids of the rows selected included (the rows
   * selected stay selected: their features are kept again once their rows are read)
   */
  clear(): void {
    this.#kept.clear();
    this.#oldest = null;
    this.#newest = null;
    this.#selectedKept = 0;
    for (const found of this.#selectedIds.values()) {
      found.kept = null;
      found.revision = -1;
      found.stamped = -1;
    }
    this.#foundRevision = -1;
    this.#foundStamped = -1;
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
      if (!place) continue;
      const { group, row } = place;
      if (group.marks[row] !== kept.mark || this.#groupNumbers.get(group) !== kept.group) continue;
      if (this.host.readContext.dimensionsOf(place.table.tableId) !== 'xy') continue;
      const now = rowFeature(this.host.readContext, place.table.tableId, group, row);
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
    if (kept.selected) this.#selectedKept--;
    else this.#unlink(kept);
  }

  /** Forgets the ones used longest ago past the number kept of the rows not selected */
  #trim(): void {
    while (this.#kept.size - this.#selectedKept > FEATURE_CACHE_LIMIT) {
      this.#forget((this.#oldest as Kept).handle);
    }
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

/** An id found to have a handle, with no feature found for it yet */
function foundId(handle: RowHandle, version: number): FoundId {
  return { handle, version, kept: null, layerId: '', revision: -1, stamped: -1 };
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
