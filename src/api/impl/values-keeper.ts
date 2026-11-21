// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the values of features before a change keep (`FeatureValues`): the rows the change
 * deleted, held by the token the layer gave with the change, until every subscriber that was
 * given values of the change has let go of them (`features.releaseValues`), and the geometries
 * the change changed vertex by vertex, followed along every change since
 *
 * The values of one change are held once for every subscriber (`SharedValues`), each subscriber
 * with an object of its own over them: the rows go once each of those objects has been let go
 * of. Letting go of an object twice, or of values that keep nothing, does nothing. Values given
 * to `features.restore` are held until it ends: letting go of them meanwhile takes effect then.
 * The keeper belongs to one instance; nothing is kept at the level of the module.
 */

import { compareRings, followVertexDiff } from '../../shared/utils/vertex-changes.js';
import type { FeatureTables } from '../../store/built-in/types.js';
import type { IdSet } from '../model.js';
import { geometryOfRow, ownGeometry, type SharedValues, sharedValuesOf } from './feature-values.js';

/**
 * The keeper of what the values of the changes of one instance keep
 *
 * @internal
 */
export interface ValuesKeeper {
  /**
   * Takes the values of a change made by this instance: they are its own, and the geometries they
   * write back vertex by vertex are followed along the changes since, until every object over
   * them has been let go of
   */
  adopt(shared: SharedValues): void;
  /** Whether values held once were made by this instance */
  owns(shared: SharedValues): boolean;
  /**
   * Keeps what the values of a change keep (the rows it deleted) until every object of the
   * subscribers over them has been let go of
   *
   * @param release - Lets go of the rows (see `ChangeSummary.claimDeletedRows`)
   */
  keep(shared: SharedValues, release: () => void): void;
  /**
   * Lets go of values (an object let go of before, or one that keeps nothing, is passed over);
   * values a `restore` holds are let go of once it has ended
   */
  release(values: readonly unknown[]): void;
  /**
   * Lets go of what the values of a change keep when every object over them was let go of
   * already, or none was given (called once they have been given to every subscriber)
   */
  settle(shared: SharedValues): void;
  /** Whether values were let go of (by the subscriber they were given to) */
  isReleased(values: unknown): boolean;
  /** Holds values while a `restore` writes them: a release meanwhile waits for `unhold` */
  hold(values: readonly unknown[]): void;
  /** Ends a hold of `hold`, and lets go of the values let go of meanwhile */
  unhold(values: readonly unknown[]): void;
  /** Whether geometries are followed (the changes are then read in the words of the features) */
  following(): boolean;
  /**
   * Follows the geometries written back vertex by vertex along a change: those of the rows it
   * updated, or of every row followed when it replaced the whole document (`updated` null)
   */
  follow(updated: IdSet | null, tables: FeatureTables): void;
}

/** One row followed: the values that follow it, with its slot in each */
interface Follower {
  readonly shared: SharedValues;
  readonly slot: number;
}

/**
 * Makes the keeper of the values of the changes of an instance
 *
 * @internal
 */
export function createValuesKeeper(): ValuesKeeper {
  /** The values made by this instance */
  const own = new WeakSet<SharedValues>();
  /** The values held once that keep rows, with how to let go of them */
  const kept = new Map<SharedValues, () => void>();
  /** How many objects of the values held once were let go of */
  const releasedCount = new Map<SharedValues, number>();
  /** The objects of the subscribers let go of */
  const released = new WeakSet<object>();
  /** The objects a `restore` holds, with how many hold them */
  const holds = new Map<object, number>();
  /** The objects let go of while a `restore` held them */
  const waiting = new Set<object>();
  /** The rows followed, by their references */
  const followed = new Map<number, Follower[]>();
  /** The values that follow rows */
  const following = new Set<SharedValues>();

  /** Stops following the rows of values */
  const stopFollowing = (shared: SharedValues): void => {
    if (!following.delete(shared)) return;
    for (const slot of shared.tracked.keys()) {
      const rows = shared.rowsOf(slot);
      const at = rows.rows[slot - rows.start];
      const list = followed.get(at);
      if (!list) continue;
      const left = list.filter((entry) => entry.shared !== shared);
      if (left.length === 0) followed.delete(at);
      else followed.set(at, left);
    }
  };

  /** Ends the values once every object over them was let go of */
  const endIfLetGo = (shared: SharedValues): void => {
    if ((releasedCount.get(shared) ?? 0) < shared.holders) return;
    releasedCount.delete(shared);
    stopFollowing(shared);
    const release = kept.get(shared);
    if (release) {
      kept.delete(shared);
      release();
    }
  };

  /** Lets go of one object over values held once, now */
  const letGo = (shared: SharedValues): void => {
    releasedCount.set(shared, (releasedCount.get(shared) ?? 0) + 1);
    endIfLetGo(shared);
  };

  return {
    adopt(shared) {
      own.add(shared);
      if (shared.tracked.size === 0) return;
      following.add(shared);
      for (const slot of shared.tracked.keys()) {
        const rows = shared.rowsOf(slot);
        const ref = rows.rows[slot - rows.start];
        const list = followed.get(ref);
        if (list) list.push({ shared, slot });
        else followed.set(ref, [{ shared, slot }]);
      }
    },
    owns: (shared) => own.has(shared),
    keep(shared, release) {
      kept.set(shared, release);
    },
    release(values) {
      for (const value of values) {
        const shared = sharedValuesOf(value);
        if (!shared || released.has(value as object)) continue;
        released.add(value as object);
        if (holds.has(value as object)) {
          waiting.add(value as object);
          continue;
        }
        letGo(shared);
      }
    },
    settle(shared) {
      endIfLetGo(shared);
    },
    isReleased: (values) => typeof values === 'object' && values !== null && released.has(values),
    hold(values) {
      for (const value of values) {
        if (typeof value !== 'object' || value === null) continue;
        holds.set(value, (holds.get(value) ?? 0) + 1);
      }
    },
    unhold(values) {
      for (const value of values) {
        if (typeof value !== 'object' || value === null) continue;
        const count = (holds.get(value) ?? 1) - 1;
        if (count > 0) {
          holds.set(value, count);
          continue;
        }
        holds.delete(value);
        const shared = sharedValuesOf(value);
        if (shared && waiting.delete(value)) letGo(shared);
      }
    },
    following: () => followed.size > 0,
    follow(updated, tables) {
      if (followed.size === 0) return;
      const refs: number[] = [];
      if (updated === null || updated.count() >= followed.size) {
        for (const ref of followed.keys()) {
          const id = tables.getRowId(ref);
          if (id !== undefined && (updated === null || updated.has(id))) refs.push(ref);
        }
      } else {
        for (const id of updated.iterate()) {
          const ref = tables.getRowRef(id);
          if (ref !== undefined && followed.has(ref)) refs.push(ref);
        }
      }
      for (const ref of refs) {
        const id = tables.getRowId(ref);
        const geometry = tables.readValues(Int32Array.of(ref), ['geometry']).geometry;
        if (id === undefined || tables.getRowRef(id) !== ref || !geometry) continue;
        if (geometry.types[0] === 255) continue;
        const now = geometryOfRow(geometry, 0);
        const last = ownGeometry(now);
        for (const { shared, slot } of followed.get(ref) ?? []) {
          // A reference that names another row now is not followed
          if (shared.ids[slot] !== id) continue;
          const tracked = shared.tracked.get(slot);
          if (!tracked) continue;
          tracked.diff = followVertexDiff(tracked.diff, compareRings(tracked.last, now));
          tracked.last = last;
        }
      }
    },
  };
}
