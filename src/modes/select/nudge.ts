// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The moves of the arrow keys (`Nudge`): shown by a sketch of this client while the keys are
 * pressed, and written once
 *
 * The presses make one move (`translate`) of the features selected, or of the ones selected in
 * bulk: from the center of their frame when the first key is pressed, to where the presses took
 * it. The sketch shows it, and the Store is not written while the keys are pressed (the rows of a
 * Store of rows are drawn moved by a moving set, whatever their number). It is written once, in
 * one transaction (one step of the history), `NUDGE_COMMIT_MS` after the last press, when the
 * page is hidden (`pagehide`), when the selection changes, and before anything else the mode does
 * (another key, a press, a drag, the mode left). A sketch that ends by itself (its features
 * deleted, locked or hidden, the document made read-only) writes nothing, and a change of the
 * state from outside drops the moves, unwritten.
 */

import type { SketchEdit } from '../../api/sketches.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import type { TableSelection } from '../../feature-table/selection.js';
import { movableBulkRows } from '../../operations/bulk-selection.js';
import { transformBulkSelection } from '../../operations/bulk-transform.js';
import { DrawError } from '../../shared/draw-error.js';
import type { SketchController } from '../../sketches/sketch-controller.js';
import type { TransformEdit } from '../../store/store.js';
import type { EngineModeContext } from '../handler.js';
import type { DragTarget } from './drag/operation.js';

/** How long after the last arrow key the moves are written (ms) */
export const NUDGE_COMMIT_MS = 300;

/** The moves of the arrow keys under way */
interface Moving {
  readonly context: EngineModeContext;
  readonly sketches: SketchController;
  /** The ID of the sketch that shows them */
  readonly id: string;
  readonly target: DragTarget;
  /** The rows selected in bulk they move (null for the features listed) */
  readonly rows: TableSelection | null;
  readonly from: [number, number];
  to: [number, number];
}

/**
 * The moves of the arrow keys
 *
 * @internal
 */
export class Nudge {
  #moving: Moving | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #onPageHide = (): void => this.flush();

  /** Whether moves are waiting to be written */
  get active(): boolean {
    return this.#moving !== null;
  }

  /**
   * Adds the move of a press of a key; the moves are written a moment after the last one
   *
   * @param featureIds The features selected the press moves (the ones not locked), or null for the
   *   ones selected in bulk
   * @param center The center of the frame of the features (where the first press starts from)
   * @param step Where a press takes a point: given the point the presses took the center to so far
   * @returns false when nothing can be moved
   */
  add(
    context: EngineModeContext,
    featureIds: readonly string[] | null,
    center: readonly [number, number],
    step: (from: readonly [number, number]) => [number, number],
  ): boolean {
    const rows = featureIds === null ? movableBulkRows(context.store) : null;
    if (rows?.count === 0 || featureIds?.length === 0) return false;
    let moving = this.#moving;
    if (moving && !sameTargets(moving, featureIds, rows)) {
      this.flush();
      moving = null;
    }
    if (moving && !moving.sketches.has(moving.id)) {
      // Its sketch ended by itself: nothing is written, and the presses start again
      this.#stop();
      moving = null;
    }
    if (!moving) {
      moving = this.#start(context, featureIds, rows, center);
      if (!moving) return false;
    }
    const to = step(moving.to);
    const edit = editOf(moving.target, moving.from, to);
    if (!moving.sketches.setDragEdits(moving.id, [edit])) return true;
    moving.to = to;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, NUDGE_COMMIT_MS);
    return true;
  }

  /** Writes the moves waiting now (one change) */
  flush(): void {
    const moving = this.#moving;
    this.#stop();
    if (!moving) return;
    const { context, sketches, id } = moving;
    if (!sketches.has(id)) return;
    const edit = transformOf(editOf(moving.target, moving.from, moving.to));
    if (moving.from[0] === moving.to[0] && moving.from[1] === moving.to[1]) {
      sketches.remove(id);
      return;
    }
    const { store, map } = context;
    if (moving.rows) {
      const rows = moving.rows;
      sketches.commitWith(
        id,
        (kept) => {
          const states = featureTablesInternals(store.tables)?.states;
          try {
            transformBulkSelection(store, edit, rows);
          } finally {
            for (const held of kept ? [rows, kept] : [rows]) {
              states?.setMoving(held.handles, 0);
              states?.setByValues(held.handles, false);
            }
            map.triggerRepaint();
          }
        },
        true,
      );
      return;
    }
    let updates: ReturnType<SketchController['updatesOf']>;
    try {
      updates = sketches.updatesOf(id);
    } catch (error) {
      if (!(error instanceof DrawError) || error.code !== 'invalid-input') throw error;
      sketches.remove(id);
      return;
    }
    sketches.commitWith(id, () =>
      store.transact(() => {
        for (const update of updates) store.updateFeature(update.id, update.updates);
      }),
    );
  }

  /** Drops the moves waiting, unwritten (the features are drawn where they are) */
  cancel(): void {
    const moving = this.#moving;
    this.#stop();
    if (moving?.sketches.has(moving.id)) moving.sketches.remove(moving.id);
  }

  /** Starts the moves: the sketch that shows them, of a pointer that has not moved */
  #start(
    context: EngineModeContext,
    featureIds: readonly string[] | null,
    rows: TableSelection | null,
    center: readonly [number, number],
  ): Moving | null {
    const { store, sketches } = context;
    // A write of a drag let go before, still under way, is made first (it shares the set)
    store.finishSlicedWrite();
    const target: DragTarget =
      featureIds === null ? { selection: true } : { featureIds: [...featureIds] };
    const from: [number, number] = [center[0], center[1]];
    let id: string | null;
    try {
      id = sketches.add({ edits: [editOf(target, from, from)] })?.id ?? null;
    } catch (error) {
      if (!(error instanceof DrawError) || error.code !== 'invalid-input') throw error;
      id = null;
    }
    if (id === null) return null;
    const moving: Moving = { context, sketches, id, target, rows, from, to: [...from] };
    this.#moving = moving;
    sketches.setNudged(id, () => this.flush());
    globalThis.addEventListener?.('pagehide', this.#onPageHide);
    return moving;
  }

  /** Forgets the moves under way: the timer, the hook of the selection and the one of the page */
  #stop(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const moving = this.#moving;
    this.#moving = null;
    if (!moving) return;
    moving.sketches.setNudged(null);
    globalThis.removeEventListener?.('pagehide', this.#onPageHide);
  }
}

/** Whether the presses move the same features as the moves under way */
function sameTargets(
  moving: Moving,
  featureIds: readonly string[] | null,
  rows: TableSelection | null,
): boolean {
  if (moving.rows || rows) return moving.rows !== null && rows !== null && moving.rows.equals(rows);
  const before = (moving.target as { featureIds: readonly string[] }).featureIds;
  const ids = featureIds as readonly string[];
  return before.length === ids.length && before.every((id, i) => id === ids[i]);
}

/** The edit of the sketch: the move from the center to where the presses took it */
function editOf(
  target: DragTarget,
  from: readonly [number, number],
  to: readonly [number, number],
): SketchEdit {
  return { kind: 'translate', target, from: [...from], to: [...to] } as SketchEdit;
}

/** The move of an edit of the sketch, without the features it names */
function transformOf(edit: SketchEdit): TransformEdit {
  const { target: _target, ...transform } = edit as Extract<SketchEdit, { kind: 'translate' }>;
  return transform as TransformEdit;
}
