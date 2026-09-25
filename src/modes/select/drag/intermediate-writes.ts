// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The record of the writes a drag makes, for its commit or its abort
 */

import type { Feature } from '../../../store/types.js';
import type { DragStore } from './operation.js';

/**
 * Whether a feature still holds every field a drag wrote to it
 *
 * The values are plain data (coordinates and properties), so a structural comparison is
 * enough. It runs only when a drag is aborted.
 */
function holdsFields(feature: Feature, fields: Partial<Feature>): boolean {
  const source = feature as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (JSON.stringify(source[key]) !== JSON.stringify(value)) return false;
  }
  return true;
}

/**
 * The intermediate writes of one drag
 *
 * @internal
 */
export class IntermediateWrites {
  /**
   * The last update applied to each feature touched during the drag (feature ID -> last diff
   * written)
   *
   * Writes during a drag are issued as an intermediate state (isIntermediate), so the final
   * state is rewritten as committed using the values recorded here in commit. It holds the diff
   * as-is, including properties and not only coordinates, so scale / rotation from resize and
   * rotate and radiusMeters from a radius change can all be committed through the same container.
   */
  private readonly pending = new Map<string, Partial<Feature>>();
  /**
   * The value each touched field had before the drag first wrote it (feature ID -> fields)
   *
   * An aborted drag writes these back, so the feature returns to the shape it had when the
   * drag started, whether or not the Store applied the intermediate updates to the real data.
   */
  private readonly origins = new Map<string, Partial<Feature>>();
  /** Every field the drag has written so far, merged (feature ID -> fields) */
  private readonly written = new Map<string, Partial<Feature>>();

  /**
   * Write one intermediate update during the drag and record the last value for the commit
   *
   * During a drag, writes are issued as "an intermediate state partway through an editing
   * operation", and the final state is committed together by commit when the drag ends.
   * Deciding whether something is intermediate is core's responsibility; how that declaration
   * is handled (persisted as-is, or routed through a temporary sharing path) is left to the
   * Store implementation.
   */
  write(store: DragStore, id: string, updates: Partial<Feature>): void {
    this.recordOrigin(store, id, updates);
    store.updateFeature(id, updates, { isIntermediate: true });
    this.pending.set(id, updates);
    this.written.set(id, { ...this.written.get(id), ...updates });
  }

  /**
   * Remember the value of each field before the drag writes it for the first time
   */
  private recordOrigin(store: DragStore, id: string, updates: Partial<Feature>): void {
    const feature = store.getFeature(id);
    if (!feature) return;
    const origin = this.origins.get(id) ?? {};
    const target = origin as Record<string, unknown>;
    const source = feature as unknown as Record<string, unknown>;
    for (const key of Object.keys(updates)) {
      if (key in target) continue;
      target[key] = structuredClone(source[key]);
    }
    this.origins.set(id, origin);
  }

  /**
   * Abort the intermediate updates that never reached a commit, restoring the features
   *
   * On a reset that does not go through the end of the drag (a cancel, a mode switch during a
   * drag, or an external state change applied from outside), the intermediate state
   * ends without being committed. Each feature gets the fields it had when the drag started
   * written back as a last intermediate update, and the discard is then announced with
   * abortIntermediateUpdates. A store that applies intermediate updates to the real data
   * (MemoryStore) is back at the start by the restore; one that holds them apart drops them on
   * the discard. A feature that something else changed during the drag (a change from
   * outside) no longer holds what the drag wrote, and is left as it is. Once committed (after
   * commit) the record is empty, so nothing happens.
   */
  discard(store?: DragStore): void {
    if (this.pending.size === 0) {
      this.clearRecords();
      return;
    }
    if (store) {
      const ids = [...this.pending.keys()];
      store.transact(() => {
        for (const id of ids) {
          const origin = this.origins.get(id);
          const written = this.written.get(id);
          const feature = store.getFeature(id);
          if (!origin || !written || !feature || !holdsFields(feature, written)) continue;
          store.updateFeature(id, origin, { isIntermediate: true });
        }
      });
      store.abortIntermediateUpdates?.(ids);
    }
    this.pending.clear();
    this.clearRecords();
  }

  /**
   * Commit the intermediate updates made during the drag
   *
   * The last value of every feature that was touched (including features that followed along
   * through a shared vertex) is rewritten as a committed update (no options), gathered into a
   * single store.transact. Because it is notified as one StateChanges, a subscriber that records
   * changes can treat this batch as a single step with its existing mechanism.
   *
   * The committed value is simply the last diff that was recorded. That way it does not depend
   * on whether the intermediate updates during the drag were applied to the Store (some Store
   * implementations do not apply intermediate updates to the real data).
   *
   * Only the features that still exist are committed. A feature can disappear during a drag (a
   * deletion from outside, the public API, a plugin); its record is not committed but discarded like
   * an aborted drag, so the commit never updates a missing feature and never lands halfway.
   */
  commit(store: DragStore): void {
    if (this.pending.size === 0) return;

    const vanished: string[] = [];
    for (const id of this.pending.keys()) {
      if (!store.getFeature(id)) vanished.push(id);
    }
    if (vanished.length > 0) {
      store.abortIntermediateUpdates?.(vanished);
      for (const id of vanished) this.pending.delete(id);
    }

    if (this.pending.size > 0) {
      store.transact(() => {
        for (const [id, updates] of this.pending) {
          store.updateFeature(id, updates);
        }
      });
    }
    // A committed record is not a discard target (distinguished from the abort notification in
    // reset)
    this.pending.clear();
    this.clearRecords();
  }

  private clearRecords(): void {
    this.origins.clear();
    this.written.clear();
  }
}
