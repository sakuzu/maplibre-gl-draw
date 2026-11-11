// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The state of the rows: what the user of the tables keeps of a row that is not a value of it,
 * and the copy of it every row block keeps
 *
 * Every row block keeps a copy of 16 bits per row, made from four sources:
 *
 * - The bits of the tables, the three highest: the row is deleted (`STATE_DELETED`), it is read
 *   from the delta of its table (`STATE_DELTA`), or from where it is until the next version of the
 *   row block it moved into is in (`STATE_WAIT`)
 * - The bits of each handle, the lowest ones: as many as the user declares (`rowStateBits`; up
 *   to 8 of them take one byte per handle), set with `setRowStates(handles, mask, bits)` and kept
 *   here (`RowStates`), the one place they are written
 * - The bits of each group, set with `setGroupStates(groups, mask, bits)` and kept by the table of
 *   the groups: the members of a group take them
 * - The bits the user declares from the values of the rows and of their groups
 *
 * The user gives every bit but those of the tables its meaning, and declares the bits that leave
 * a row out of the rows drawn (`hiddenStates`). The copies are made from the sources, never the
 * other way round, so a row block built again or cut in two makes its copy again from the same
 * sources and the state stays with the rows.
 */

import { KasaneError } from '../table/kasane-error.js';
import type { RowHandle } from './types.js';

/** The row is deleted (kept for what still refers to it) */
export const STATE_DELETED = 1 << 13;
/** The row is read from the delta of its table (a copy written since its row block was built) */
export const STATE_DELTA = 1 << 14;
/**
 * The row moved into this row block from another, whose next version is not in yet: the row is
 * read where it is now until then
 */
export const STATE_WAIT = 1 << 15;
/** The bits of a row whose copy in its row block is not the row (it is read elsewhere) */
export const STATE_ELSEWHERE = STATE_DELTA | STATE_WAIT;
/** The bits of the tables */
export const TABLE_STATES = STATE_DELETED | STATE_ELSEWHERE;
/** The bits of the copy the user gives a meaning to: the 13 below those of the tables */
export const USER_STATES = STATE_DELETED - 1;
/** The most bits of each handle the user can declare */
export const MOST_ROW_STATE_BITS = 13;

/**
 * Checks the bits a user declares or writes: bits of the user, among the bits given
 *
 * @throws `KasaneError` with the code `invalid-input` when one is not
 * @internal
 */
export function checkStateBits(what: string, mask: number, among: number): void {
  if (!Number.isInteger(mask) || mask < 0 || (mask & ~among) !== 0) {
    throw new KasaneError('invalid-input', `RowStates: ${what} ${mask} are not bits of the user`);
  }
}

/**
 * The bits of the state of each handle, as many as the user declares
 *
 * @internal
 */
export class RowStates {
  private bits: Uint8Array | Uint16Array;
  /** The bits of each handle, as the copies hold them: the lowest `rowStateBits` */
  readonly mask: number;

  /**
   * @param rowStateBits - The number of bits of each handle (0 to 13)
   * @throws `KasaneError` with the code `invalid-input` for another number
   */
  constructor(rowStateBits: number) {
    if (!Number.isInteger(rowStateBits) || rowStateBits < 0 || rowStateBits > MOST_ROW_STATE_BITS) {
      throw new KasaneError(
        'invalid-input',
        `RowStates: ${rowStateBits} bits of each handle are not 0 to ${MOST_ROW_STATE_BITS}`,
      );
    }
    this.mask = (1 << rowStateBits) - 1;
    this.bits = rowStateBits <= 8 ? new Uint8Array(64) : new Uint16Array(64);
  }

  /** The bits of a handle (0 for a handle never given any) */
  of(handle: RowHandle): number {
    return handle >= 0 && handle < this.bits.length ? this.bits[handle] : 0;
  }

  /**
   * Sets the bits under a mask of handles (negative ones left out)
   *
   * @returns The handles whose bits changed, each once
   * @throws `KasaneError` with the code `invalid-input` when the mask holds a bit that is not one
   * of a handle
   */
  set(handles: Int32Array, mask: number, bits: number): Int32Array {
    checkStateBits('the bits', mask, this.mask);
    let max = -1;
    for (const handle of handles) if (handle > max) max = handle;
    this.reserve(max + 1);
    const keep = ~mask;
    const put = bits & mask;
    const changed: number[] = [];
    for (const handle of handles) {
      if (handle < 0) continue;
      const before = this.bits[handle];
      const next = (before & keep) | put;
      if (next === before) continue;
      this.bits[handle] = next;
      changed.push(handle);
    }
    return Int32Array.from(changed);
  }

  /**
   * Forgets the bits of a handle (given again to another row)
   *
   * @returns The bits it had
   */
  clear(handle: RowHandle): number {
    if (handle < 0 || handle >= this.bits.length) return 0;
    const before = this.bits[handle];
    this.bits[handle] = 0;
    return before;
  }

  /** The handles that have a bit under a mask, in the order of the handles */
  find(mask: number): RowHandle[] {
    const handles: RowHandle[] = [];
    for (let handle = 0; handle < this.bits.length; handle++) {
      if ((this.bits[handle] & mask) !== 0) handles.push(handle);
    }
    return handles;
  }

  private reserve(n: number): void {
    if (n <= this.bits.length) return;
    let size = this.bits.length * 2;
    while (size < n) size *= 2;
    const next = this.bits instanceof Uint8Array ? new Uint8Array(size) : new Uint16Array(size);
    next.set(this.bits);
    this.bits = next;
  }
}
