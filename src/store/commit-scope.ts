// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The commit being made in a Store: what tells it to whoever reads its notification (the `change`
 * of the instance, its undo, what a storage receives)
 *
 * A commit of `draw.write`, an undo and a redo are made with what tells them. A write made over
 * several tasks is one commit too: a drag of features selected in bulk once let go is written a
 * transaction a step (`operations/bulk-sliced.ts`), each step made in the commit of the drag, and a
 * restore of many rows (an undo) lets its notification go once its last rows are written, in the
 * commit it was made in.
 */

import type { Store } from './store.js';

/**
 * What tells a commit
 *
 * @internal
 */
export interface CommitInfo {
  readonly id: string;
  readonly label: string | undefined;
  /** Whether it is a step of undo */
  readonly undo: boolean;
}

const COMMITS = new WeakMap<object, CommitInfo>();

/**
 * The commit being made in the Store, while its transaction runs and its notification goes out
 * (undefined for a write made otherwise: a write from elsewhere, a write of the host)
 *
 * @internal
 */
export function commitOf(store: object): CommitInfo | undefined {
  return COMMITS.get(store);
}

/**
 * Runs `fn` with the commit told as the one being made in the Store
 *
 * @internal
 */
export function withCommit<T>(store: object, info: CommitInfo, fn: () => T): T {
  const outer = COMMITS.get(store);
  COMMITS.set(store, info);
  try {
    return fn();
  } finally {
    if (outer) COMMITS.set(store, outer);
    else COMMITS.delete(store);
  }
}

/**
 * Makes a commit in the Store, with what tells it, in one transaction of the Store
 *
 * @internal
 */
export function runCommit<T>(store: Store, info: CommitInfo, source: string, fn: () => T): T {
  return withCommit(store, info, () => store.transact(fn, source));
}
