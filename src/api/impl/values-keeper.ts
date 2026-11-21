// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the values of features before a change keep (`FeatureValues`): the rows the change
 * deleted, held by the token the layer gave with the change, until every subscriber that was
 * given values of the change has let go of them (`features.releaseValues`)
 *
 * The values of one change are held once for every subscriber (`SharedValues`), each subscriber
 * with an object of its own over them: the rows go once each of those objects has been let go
 * of. Letting go of an object twice, or of values that keep nothing, does nothing. The keeper
 * belongs to one instance; nothing is kept at the level of the module.
 */

import { type SharedValues, sharedValuesOf } from './feature-values.js';

/**
 * The keeper of what the values of the changes of one instance keep
 *
 * @internal
 */
export interface ValuesKeeper {
  /**
   * Keeps what the values of a change keep (the rows it deleted) until every object of the
   * subscribers over them has been let go of
   *
   * @param release - Lets go of the rows (see `ChangeSummary.claimDeletedRows`)
   */
  keep(shared: SharedValues, release: () => void): void;
  /** Lets go of values (an object let go of before, or one that keeps nothing, is passed over) */
  release(values: readonly unknown[]): void;
  /**
   * Lets go of what the values of a change keep when every object over them was let go of
   * already, or none was given (called once they have been given to every subscriber)
   */
  settle(shared: SharedValues): void;
  /** Whether values were let go of (by the subscriber they were given to) */
  isReleased(values: unknown): boolean;
}

/**
 * Makes the keeper of the values of the changes of an instance
 *
 * @internal
 */
export function createValuesKeeper(): ValuesKeeper {
  /** The values held once that keep rows, with how many of their objects were let go of */
  const kept = new Map<SharedValues, { readonly release: () => void; released: number }>();
  /** The objects of the subscribers let go of */
  const released = new WeakSet<object>();
  return {
    keep(shared, release) {
      kept.set(shared, { release, released: 0 });
    },
    release(values) {
      for (const value of values) {
        const shared = sharedValuesOf(value);
        if (!shared || released.has(value as object)) continue;
        released.add(value as object);
        const entry = kept.get(shared);
        if (!entry) continue;
        entry.released += 1;
        if (entry.released >= shared.holders) {
          kept.delete(shared);
          entry.release();
        }
      }
    },
    settle(shared) {
      const entry = kept.get(shared);
      if (entry && entry.released >= shared.holders) {
        kept.delete(shared);
        entry.release();
      }
    },
    isReleased: (values) => typeof values === 'object' && values !== null && released.has(values),
  };
}
