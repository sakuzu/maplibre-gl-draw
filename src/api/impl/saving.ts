// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `Write.save`: the promise of a write, with the way to follow its commit to the storage
 */

import { DrawError } from '../errors.js';
import type { SaveOptions, Write, WriteResult } from '../write.js';

/**
 * What brings the commits of a Store to its storage
 *
 * @internal
 */
export interface CommitSaver {
  /** Settles once the commit reaches the stage asked for (see `Write.save`) */
  save(commit: string, options: SaveOptions | undefined): Promise<void>;
}

/** The storage of each Store of an instance that has one */
const SAVERS = new WeakMap<object, CommitSaver>();

/**
 * Sets what brings the commits of a Store to its storage (`null` for none)
 *
 * @internal
 */
export function setCommitSaver(store: object, saver: CommitSaver | null): void {
  if (saver) SAVERS.set(store, saver);
  else SAVERS.delete(store);
}

/**
 * The write of a commit: `done` with its ID, its result and `save`. A write that fails saves
 * nothing: `save` fails as it does
 *
 * @param store - The Store the commit is made in (`null` for a write that failed at once)
 * @internal
 */
export function writeOf<T>(
  store: object | null,
  id: string,
  result: Promise<WriteResult<T>>,
): Write<T> {
  const done = result.then(({ value }) => value);
  const save = (options?: SaveOptions): Promise<void> =>
    result.then(() => {
      const saver = store ? SAVERS.get(store) : undefined;
      if (!saver) throw new DrawError('invalidState', 'There is no storage to save the commit to');
      return saver.save(id, options);
    });
  return Object.assign(done, { id, result, save });
}
