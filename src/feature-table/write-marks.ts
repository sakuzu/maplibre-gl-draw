// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The write marks of the rows (`WriteMarks`)
 *
 * The one that holds the tables keeps a number that only goes up, the write mark, and gives it to
 * the tables (`setWriteMark` of their drawing side) before it writes values; the tables know
 * nothing of when it goes up. The writing side of the tables stamps the mark given last, in its
 * one place that writes the values of rows, on every row it writes and on the row group the row
 * is in. A row group has the mark its rows last changed in: a row written, come in or gone, its
 * hidden column written, a row come into the delta or gone from the group to it. A row group made
 * outside a write (a next version, a group taken in) is a new object with the mark of then.
 *
 * What is kept from the rows can keep the mark it was made at and be compared with the marks of
 * the rows and of their groups when it is used. Whoever needs to know of each row stamped (what
 * keeps something of the rows, a check) listens to the stamps (`onStamp`).
 */

import { KasaneError } from '../table/kasane-error.js';
import type { RowGroup } from './row-table.js';
import type { RowHandle } from './types.js';

/** The highest mark a row holds (its marks are 32-bit) */
const MARK_LIMIT = 0xffff_ffff;

/**
 * The write mark of the tables and its stamping on the rows written
 *
 * @internal
 */
export class WriteMarks {
  #mark = 0;
  /** The rows stamped so far */
  #stamped = 0;
  /** The rows stamped under the mark of now, while they are read (`readRows`) */
  #rows: RowHandle[] | null = null;
  /** Called with each row stamped */
  onStamp: ((handle: RowHandle) => void) | null = null;

  /** The mark the rows written now are stamped with */
  get mark(): number {
    return this.#mark;
  }

  /** The number of rows stamped so far */
  get stamped(): number {
    return this.#stamped;
  }

  /**
   * Sets the mark the rows written from now on are stamped with
   *
   * @throws KasaneError (`invalid-state`) for a mark below the one before, or past what a row holds
   */
  set(mark: number): void {
    if (!Number.isInteger(mark) || mark < this.#mark || mark > MARK_LIMIT) {
      throw new KasaneError(
        'invalid-state',
        `FeatureTables: the write mark ${mark} is not after the mark ${this.#mark}`,
      );
    }
    if (mark === this.#mark) return;
    this.#mark = mark;
    if (this.#rows) this.#rows.length = 0;
  }

  /** Stamps the mark on a row written and on its group */
  stamp(group: RowGroup, row: number): void {
    group.marks[row] = this.#mark;
    group.mark = this.#mark;
    this.#stamped++;
    this.#rows?.push(group.data.handles[row]);
    this.onStamp?.(group.data.handles[row]);
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
