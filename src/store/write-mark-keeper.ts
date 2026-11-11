// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The write mark of a Store of rows, and its frames of writes (`WriteMarkKeeper`)
 *
 * A Store of rows has one number that only goes up, the write mark: it goes up once in each frame
 * of writes that writes values (one per outermost transaction; one per step of a transaction
 * written in steps; one per call of the writer of the tables made outside a transaction), however
 * many writes the frame makes, and not for a frame that writes no value (the state of the rows
 * only, the selection only). The keeper holds the number and gives it to the tables when it goes
 * up, before the first write of values of the frame (`setWriteMark` of their drawing side); the
 * writing side of the tables stamps it on the rows it writes (`write-marks.ts`).
 *
 * The tables know nothing of the frames: the keeper tells what keeps the features of the rows
 * (`FeatureCache`) whether a row of a mark may still be written again under it (`settled`: a row
 * written in the frame under way may), and which rows were stamped outside a frame that raised
 * the mark (their marks do not tell them from what they were before).
 */

import type { WriteFrames } from '../feature-table/feature-cache.js';
import type { RowGroup } from '../feature-table/row-table.js';
import type { RowHandle } from '../feature-table/types.js';
import type { WriteMarks } from '../feature-table/write-marks.js';

/** The problems the check of the marks keeps at most until they are read */
const PROBLEM_LIMIT = 20;

/**
 * What the keeper of the write mark reads of its tables
 *
 * @internal
 */
export interface WriteMarkTarget {
  readonly writeMarks: WriteMarks;
  /** Gives the tables the mark the rows written from now on are stamped with */
  setWriteMark(mark: number): void;
  /** Where the row of a handle is read (undefined for a handle of no row) */
  placeOf(handle: RowHandle): { readonly group: RowGroup; readonly row: number } | undefined;
  /** What keeps the features of the rows, told the frames of the marks */
  readonly featureCache: {
    /** Takes the frames: what forgets what is kept of a row stamped outside a frame that raised */
    followFrames(frames: WriteFrames): (handle: RowHandle) => void;
  };
}

/**
 * The write mark of a Store of rows, and its frames of writes
 *
 * @internal
 */
export class WriteMarkKeeper implements WriteFrames {
  #mark = 0;
  /** The depth of the frames under way */
  #depth = 0;
  /** Whether the mark went up in the frame under way */
  #raised = false;
  /** Whether the frame that raised the mark of now is under way */
  #open = false;
  /** What is told of a row stamped outside a frame that raised the mark */
  readonly #unframed: (handle: RowHandle) => void;
  /** Whether the frames are checked (`watch`) */
  #watched = false;
  /** The mark and the rows stamped when the frame under way began (while checked) */
  #frameMark = 0;
  #frameStamped = 0;
  /** The mark the problems were last read at */
  #readMark = 0;
  readonly #problems: string[] = [];

  constructor(private readonly target: WriteMarkTarget) {
    this.#unframed = target.featureCache.followFrames(this);
    // No frame is under way: a row stamped now is stamped outside one
    target.writeMarks.onStamp = this.#unframed;
  }

  /** The mark of the Store */
  get mark(): number {
    return this.#mark;
  }

  /**
   * Whether a row of a mark is not written again under it: the row was not written in the frame
   * under way (whose rows may be written again under its mark)
   */
  settled(mark: number): boolean {
    return !(this.#open && mark === this.target.writeMarks.mark);
  }

  /** Runs a frame of writes: one inside a frame under way is part of it */
  frame<T>(fn: () => T): T {
    if (this.#depth++ === 0) this.#begin();
    try {
      return fn();
    } finally {
      if (--this.#depth === 0) this.#end();
    }
  }

  /**
   * Runs a write of values of the tables: the mark goes up once in the frame under way, and a
   * write outside a frame is a frame of its own
   */
  write<T>(fn: () => T): T {
    if (this.#depth === 0) return this.frame(() => this.write(fn));
    if (!this.#raised) {
      this.#raised = true;
      this.#mark++;
      this.target.setWriteMark(this.#mark);
      // The rows stamped from now on to the end of the frame are stamped inside it
      this.#open = true;
      this.target.writeMarks.onStamp = null;
    }
    return fn();
  }

  /**
   * Checks each frame from now on: a frame that stamps rows raised the mark once, and the rows
   * it stamped have its mark where they are read, and so do their groups (`takeProblems`)
   */
  watch(): void {
    if (this.#watched) return;
    this.#watched = true;
    this.#readMark = this.#mark;
    this.target.writeMarks.readRows();
  }

  /**
   * The problems the frames checked found since the last read (see `watch`), and the ones of the
   * marks now: the tables have the mark of the Store, which did not go down
   */
  takeProblems(): string[] {
    const problems = this.#problems.splice(0);
    const tables = this.target.writeMarks.mark;
    if (tables !== this.#mark) {
      problems.push(`the Store is at the write mark ${this.#mark}, and its tables at ${tables}`);
    }
    if (this.#mark < this.#readMark) {
      problems.push(`the write mark went down from ${this.#readMark} to ${this.#mark}`);
    }
    this.#readMark = this.#mark;
    return problems;
  }

  #begin(): void {
    this.#raised = false;
    if (!this.#watched) return;
    this.#frameMark = this.#mark;
    this.#frameStamped = this.target.writeMarks.stamped;
  }

  #end(): void {
    if (this.#raised) {
      this.#open = false;
      this.target.writeMarks.onStamp = this.#unframed;
    }
    if (!this.#watched) return;
    const marks = this.target.writeMarks;
    const raised = this.#mark - this.#frameMark;
    const stamped = marks.stamped - this.#frameStamped;
    if (raised > 1 || raised < 0) this.#problem(`a frame moved the write mark by ${raised}`);
    if (stamped > 0 && raised !== 1) {
      this.#problem(`a frame stamped ${stamped} rows, and the write mark went up ${raised} times`);
    }
    if (raised !== 1) return;
    for (const handle of marks.stampedRows()) {
      if (this.#problems.length >= PROBLEM_LIMIT) return;
      const place = this.target.placeOf(handle);
      if (!place) continue;
      const mark = place.group.marks[place.row];
      if (mark !== this.#mark || place.group.mark !== this.#mark) {
        this.#problem(
          `the row ${handle} written in the frame of the write mark ${this.#mark} has the mark ${mark}, and its group ${place.group.mark}`,
        );
      }
    }
  }

  #problem(text: string): void {
    if (this.#problems.length < PROBLEM_LIMIT) this.#problems.push(text);
  }
}

/** The keepers by the reading side of the tables of their Store */
const KEEPERS = new WeakMap<object, WriteMarkKeeper>();

/**
 * Makes the keeper of the write mark of a Store of rows, found by its tables
 *
 * @internal
 */
export function createWriteMarkKeeper(tables: object, target: WriteMarkTarget): WriteMarkKeeper {
  const keeper = new WriteMarkKeeper(target);
  KEEPERS.set(tables, keeper);
  return keeper;
}

/**
 * The keeper of the write mark of the Store whose tables these are (undefined for tables without
 * one)
 *
 * @internal
 */
export function writeMarkKeeperOf(tables: object | undefined): WriteMarkKeeper | undefined {
  return tables ? KEEPERS.get(tables) : undefined;
}
