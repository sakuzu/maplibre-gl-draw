// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The write marks of the rows (`WriteMarks`, `WriteMarkKeeper`)
 *
 * A Store of rows has one number that only goes up, the write mark: it goes up once at the
 * beginning of each frame of writes that writes values (one per outermost transaction; one per
 * step of a transaction written in steps; one per call of the writer of the tables made outside
 * a transaction), however many writes the frame makes, and not for a frame that writes no value
 * (the state of the rows only, the selection only). The Store keeps the number
 * (`WriteMarkKeeper`) and gives it to its tables when it goes up; the tables stamp it, in their
 * one place that writes the values of rows, on every row they write and on the row group the row
 * is in (`WriteMarks`). A row group has the mark its rows last changed in: a row written, come in
 * or gone, its hidden column written, a row come into the delta or gone from the group to it. A
 * row group made outside a write (a next version, a group taken in) is a new object with the mark
 * of then.
 *
 * What is kept from the rows can keep the mark it was made at and be compared with the marks of
 * the rows and of their groups when it is used. A row written in the frame under way may be
 * written again under the same mark, so what is made of it then is not kept (`settled`), and a
 * row stamped outside a frame that raised the mark is told to what keeps it (`onUnframedStamp`).
 */

import { DrawError } from '../shared/draw-error.js';
import type { RowGroup } from './layer-table.js';
import type { RowHandle } from './types.js';

/** The highest mark a row holds (its marks are 32-bit) */
const MARK_LIMIT = 0xffff_ffff;

/** The problems the check of the marks keeps at most until they are read */
const PROBLEM_LIMIT = 20;

/**
 * The write mark of the tables and its stamping on the rows written
 *
 * @internal
 */
export class WriteMarks {
  #mark = 0;
  /** The rows stamped so far */
  #stamped = 0;
  /** The rows stamped under the mark of now, while the check of the marks reads them */
  #rows: RowHandle[] | null = null;
  /** Whether a keeper gives the marks by its frames (`byFrames`) */
  #framed = false;
  /** Whether the frame that raised the mark of now is under way */
  #open = false;
  /**
   * Called with a row stamped while no frame that raised the mark is under way: its mark does
   * not tell it from what it was before
   */
  onUnframedStamp: ((handle: RowHandle) => void) | null = null;

  /** The mark the rows written now are stamped with */
  get mark(): number {
    return this.#mark;
  }

  /** The number of rows stamped so far */
  get stamped(): number {
    return this.#stamped;
  }

  /**
   * Whether a row of a mark is not written again under it: the marks are given by frames, and the
   * row was not written in the frame under way (whose rows may be written again under its mark)
   */
  settled(mark: number): boolean {
    return this.#framed && !(this.#open && mark === this.#mark);
  }

  /** Tells that a keeper gives the marks by its frames (see `settled`) */
  byFrames(): void {
    this.#framed = true;
  }

  /** Tells that the frame that raised the mark of now ended */
  close(): void {
    this.#open = false;
  }

  /**
   * Sets the mark the rows written from now on are stamped with
   *
   * @throws DrawError (`invalid-state`) for a mark below the one before, or past what a row holds
   */
  set(mark: number): void {
    if (!Number.isInteger(mark) || mark < this.#mark || mark > MARK_LIMIT) {
      throw new DrawError(
        'invalid-state',
        `FeatureTables: the write mark ${mark} is not after the mark ${this.#mark}`,
      );
    }
    if (mark === this.#mark) return;
    this.#mark = mark;
    this.#open = true;
    if (this.#rows) this.#rows.length = 0;
  }

  /** Stamps the mark on a row written and on its group */
  stamp(group: RowGroup, row: number): void {
    group.marks[row] = this.#mark;
    group.mark = this.#mark;
    this.#stamped++;
    this.#rows?.push(group.data.handles[row]);
    if (this.#framed && !this.#open) this.onUnframedStamp?.(group.data.handles[row]);
  }

  /** Stamps the mark on a group whose rows changed without a row of it written (a row gone) */
  stampGroup(group: RowGroup): void {
    group.mark = this.#mark;
  }

  /** The rows stamped under the mark of now (only while they are read, `readRows`) */
  stampedRows(): readonly RowHandle[] {
    return this.#rows ?? [];
  }

  /** Keeps the rows stamped under the mark of now from now on (`stampedRows`) */
  readRows(): void {
    this.#rows ??= [];
  }
}

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
}

/**
 * The write mark of a Store of rows, and its frames of writes
 *
 * @internal
 */
export class WriteMarkKeeper {
  #mark = 0;
  /** The depth of the frames under way */
  #depth = 0;
  /** Whether the mark went up in the frame under way */
  #raised = false;
  /** Whether the frames are checked (`watch`) */
  #watched = false;
  /** The mark and the rows stamped when the frame under way began (while checked) */
  #frameMark = 0;
  #frameStamped = 0;
  /** The mark the problems were last read at */
  #readMark = 0;
  readonly #problems: string[] = [];

  constructor(private readonly target: WriteMarkTarget) {
    target.writeMarks.byFrames();
  }

  /** The mark of the Store */
  get mark(): number {
    return this.#mark;
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
    if (this.#raised) this.target.writeMarks.close();
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
