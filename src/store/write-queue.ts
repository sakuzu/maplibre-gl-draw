// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The queue of the writes of this client made over several tasks
 *
 * A write of many rows takes longer than a frame, so some are written in steps, a later task each:
 * the write of a drag of features selected in bulk once let go (`operations/bulk-sliced.ts`) and a
 * restore of many rows (`row-steps.ts`). Every write of this client goes after the ones before it,
 * in the order they were made; this queue keeps them in that order and is the one place the Store
 * of core asks before it writes.
 *
 * - The writes of the document of this client are made in the task they are asked in (the public
 *   writes return once made), so a write comes after the ones queued by having them finished
 *   first, in their order (`finish`): a write is only queued once the ones before are written,
 *   and the queue holds one write at most
 * - A write whose notification is held until its last rows (a restore) is finished by what reads
 *   or writes the state of this client as well, as the selection reads its rows
 *   (`finishHeld`); a write that tells each step (a drag) is not
 * - The steps of a write in the queue are its own (`runStep`): what they write does not finish it
 * - A write from elsewhere does not come after the queue: it is not asked here
 *
 * Each write makes its own steps and leaves the queue once its last rows are written (`remove`).
 */

/**
 * A write of many rows made over several tasks, which can be made whole at once
 *
 * @internal
 */
export interface QueuedWrite {
  /** Writes the rest now (in this task); it leaves the queue */
  finish(): void;
  /**
   * Whether its notification is held until its last rows are written: what reads or writes the
   * state of this client finishes it too
   */
  readonly holdsNotification?: boolean;
}

/**
 * The writes of this client made over several tasks, in the order they were made
 *
 * @internal
 */
export class WriteQueue {
  readonly #writes: QueuedWrite[] = [];
  /** The depth of the steps of the writes being made (their writes do not finish them) */
  #steps = 0;

  /** Whether a write is in the queue */
  get pending(): boolean {
    return this.#writes.length > 0;
  }

  /** Whether a write whose notification is held is in the queue */
  get holding(): boolean {
    return this.#writes.some((write) => write.holdsNotification === true);
  }

  /** Whether the write is in the queue */
  has(write: QueuedWrite): boolean {
    return this.#writes.includes(write);
  }

  /** Puts a write at the end of the queue, the ones before it finished first */
  add(write: QueuedWrite): void {
    this.finish();
    this.#writes.push(write);
  }

  /** Takes a write out of the queue (once its last rows are written); false when it was not there */
  remove(write: QueuedWrite): boolean {
    const at = this.#writes.indexOf(write);
    if (at < 0) return false;
    this.#writes.splice(at, 1);
    return true;
  }

  /** Writes the rest of the writes in the queue now, in their order (nothing within a step) */
  finish(): void {
    this.#finishUpTo(this.#writes.length);
  }

  /**
   * Writes the rest of the writes in the queue whose notification is held now, with the ones
   * before them, in their order (nothing within a step)
   */
  finishHeld(): void {
    let last = -1;
    this.#writes.forEach((write, i) => {
      if (write.holdsNotification === true) last = i;
    });
    this.#finishUpTo(last + 1);
  }

  /** Runs a step of a write of the queue: what it writes does not finish the queue */
  runStep<T>(fn: () => T): T {
    this.#steps++;
    try {
      return fn();
    } finally {
      this.#steps--;
    }
  }

  /** Finishes the first `count` writes of the queue, the first first */
  #finishUpTo(count: number): void {
    if (this.#steps > 0) return;
    const writes = this.#writes.slice(0, count);
    for (const write of writes) {
      // A write finished meanwhile (by the one before it) is left as it is
      if (this.#writes.includes(write)) write.finish();
    }
  }
}
