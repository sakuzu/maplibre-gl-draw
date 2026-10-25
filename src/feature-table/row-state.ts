// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The state of the rows: why a row is hidden, whether it is marked as selected in bulk, which
 * moving set it belongs to
 *
 * The state that is not a value of the row (hidden by this client only, the bulk selection,
 * moving) is kept as sets of handles (`RowStateSets`), the one place it is written. Every row
 * group keeps a copy per row, made from those sets and from the values of its rows (shown,
 * deleted), with one bit per reason; the GPU gets one byte per row made from the copy, and
 * reads it by the number of the row (`toGpuState`).
 *
 * The copies are made from the sets, never the other way round, so a group built again or cut
 * in two makes its copy again from the same sets and the state stays with the rows.
 */

import { DrawError } from '../shared/draw-error.js';
import type { PlaneTransform } from '../shared/math/plane-transform.js';
import type { RowHandle } from './types.js';

// === The bits of the copy kept by a row group (16 bits per row) ===

/** Hidden by this client only */
export const STATE_HIDDEN_LOCAL = 1 << 0;
/** Not shown (the row's own value) */
export const STATE_HIDDEN_INVISIBLE = 1 << 1;
/** Deleted (kept for what still refers to it) */
export const STATE_HIDDEN_DELETED = 1 << 2;
/** Its group of features is not shown */
export const STATE_HIDDEN_GROUP = 1 << 3;
/** The row is drawn from the delta of its layer (a copy written since its group was built) */
export const STATE_HIDDEN_DELTA = 1 << 4;
/**
 * The row moved into this group from another, whose next version is not in yet: the row is
 * read and drawn where it is now (the delta) until then
 */
export const STATE_HIDDEN_WAIT = 1 << 5;
/**
 * A feature is drawn over the row in its place for this client only (`FeatureTables.showInPlace`):
 * the row is not drawn, and is still hit where it is
 */
export const STATE_HIDDEN_OVERLAY = 1 << 6;
/**
 * A draft of the feature of the row is drawn in its place (`draw.drafts`): the row is not drawn,
 * and is still hit where it is
 */
export const STATE_HIDDEN_DRAFT = 1 << 7;
/** The bits of every reason a row is hidden */
export const STATE_HIDDEN_MASK = 0xff;
/** The bits of the reasons a row is not hit (a row drawn over is hit where it is) */
export const STATE_UNHIT_MASK = STATE_HIDDEN_MASK & ~STATE_HIDDEN_OVERLAY & ~STATE_HIDDEN_DRAFT;
/** Marked as selected in bulk */
export const STATE_BULK = 1 << 8;
/** The first of the two bits of the moving set of the row (0 = not moving, 1 to 3) */
export const STATE_MOVE_SHIFT = 9;
/** The two bits of the moving set */
export const STATE_MOVE_MASK = 3 << STATE_MOVE_SHIFT;
/** Scaled by the same factor in x and y (a Circle, a row turned or scaled by its values) */
export const STATE_UNIFORM = 1 << 11;
/**
 * Turned and scaled by its values while it is dragged (its rotation, its scale), as the write of
 * the drag let go turns and scales it: an image, a type an extension resizes by its scale, a row
 * that has such a value
 */
export const STATE_BY_VALUES = 1 << 12;

// === The byte per row the GPU reads ===

/** The row is hidden */
export const GPU_STATE_HIDDEN = 1;
/** The first of the two bits of the moving set */
export const GPU_STATE_MOVE_SHIFT = 1;
/** Marked as selected in bulk */
export const GPU_STATE_BULK = 8;
/** Scaled by the same factor in x and y */
export const GPU_STATE_UNIFORM = 16;

/** The number of moving sets (1 to 3; 0 means not moving) */
export const MOVE_SETS = 3;

/**
 * The moving set the features selected in bulk are dragged with (set 1 is the one of the rows
 * opened as features moved as a whole)
 */
export const BULK_MOVE_SET = 2;

/**
 * The byte the GPU reads for the copy of the state of a row
 *
 * @internal
 */
export function toGpuState(state: number): number {
  return (
    ((state & STATE_HIDDEN_MASK) !== 0 ? GPU_STATE_HIDDEN : 0) |
    (((state & STATE_MOVE_MASK) >> STATE_MOVE_SHIFT) << GPU_STATE_MOVE_SHIFT) |
    ((state & STATE_BULK) !== 0 ? GPU_STATE_BULK : 0) |
    ((state & STATE_UNIFORM) !== 0 ? GPU_STATE_UNIFORM : 0)
  );
}

/** The bits of `RowStateSets` per handle */
const SET_HIDDEN = 1;
const SET_BULK = 2;
const SET_MOVE_SHIFT = 2;
const SET_MOVE_MASK = 3 << SET_MOVE_SHIFT;
const SET_OVERLAY = 16;
const SET_BY_VALUES = 32;
const SET_DRAFT = 64;

/**
 * The state of the rows kept as sets of handles
 *
 * A change calls `onChange` with the handles whose state changed, so the row groups holding
 * them make their copies again.
 *
 * @internal
 */
export class RowStateSets {
  private bits: Uint8Array = new Uint8Array(64);
  /** The handles marked as selected in bulk */
  private readonly bulk = new Set<RowHandle>();
  /** The translation of each moving set, `[dLng, dLat]` (set 0 is unused) */
  private readonly translations = new Float64Array((MOVE_SETS + 1) * 2);
  /** The rotation or resize of each moving set (null for none; set 0 is unused) */
  private readonly transforms: Array<PlaneTransform | null> = new Array(MOVE_SETS + 1).fill(null);
  private translationRevision = 0;

  constructor(private readonly onChange: (handles: Int32Array) => void) {}

  /** Changes with every change of a translation or a transform (the GPU writes its uniforms again) */
  get revision(): number {
    return this.translationRevision;
  }

  /** The bits of the state of a handle, as the copy of a group holds them */
  stateOf(handle: RowHandle): number {
    const bits = handle >= 0 && handle < this.bits.length ? this.bits[handle] : 0;
    return (
      ((bits & SET_HIDDEN) !== 0 ? STATE_HIDDEN_LOCAL : 0) |
      ((bits & SET_OVERLAY) !== 0 ? STATE_HIDDEN_OVERLAY : 0) |
      ((bits & SET_DRAFT) !== 0 ? STATE_HIDDEN_DRAFT : 0) |
      ((bits & SET_BULK) !== 0 ? STATE_BULK : 0) |
      ((bits & SET_BY_VALUES) !== 0 ? STATE_BY_VALUES | STATE_UNIFORM : 0) |
      (((bits & SET_MOVE_MASK) >> SET_MOVE_SHIFT) << STATE_MOVE_SHIFT)
    );
  }

  /** Hides or shows rows in this client only */
  setHidden(handles: Int32Array, hidden: boolean): void {
    this.update(handles, (bits) => (hidden ? bits | SET_HIDDEN : bits & ~SET_HIDDEN));
  }

  /** Marks or unmarks rows as drawn over by a feature in their place, for this client only */
  setOverlaid(handles: Int32Array, overlaid: boolean): void {
    this.update(handles, (bits) => (overlaid ? bits | SET_OVERLAY : bits & ~SET_OVERLAY));
  }

  /** Marks or unmarks rows as drawn over by a draft of their features, for this client only */
  setDrafted(handles: Int32Array, drafted: boolean): void {
    this.update(handles, (bits) => (drafted ? bits | SET_DRAFT : bits & ~SET_DRAFT));
  }

  /** Marks or unmarks rows as selected in bulk */
  setBulk(handles: Int32Array, marked: boolean): void {
    for (const handle of handles) {
      if (handle < 0) continue;
      if (marked) this.bulk.add(handle);
      else this.bulk.delete(handle);
    }
    this.update(handles, (bits) => (marked ? bits | SET_BULK : bits & ~SET_BULK));
  }

  /** The handles marked as selected in bulk */
  bulkHandles(): ReadonlySet<RowHandle> {
    return this.bulk;
  }

  /**
   * Puts rows into a moving set (1 to 3), or takes them out of any (0)
   *
   * @throws when the set is not 0 to 3
   */
  setMoving(handles: Int32Array, set: number): void {
    if (!Number.isInteger(set) || set < 0 || set > MOVE_SETS) {
      throw new DrawError('invalid-input', `RowStateSets: no moving set ${set}`);
    }
    this.update(handles, (bits) => (bits & ~SET_MOVE_MASK) | (set << SET_MOVE_SHIFT));
  }

  /**
   * Marks or unmarks rows as turned and scaled by their values while they are dragged (the write
   * of the drag decides which)
   */
  setByValues(handles: Int32Array, marked: boolean): void {
    this.update(handles, (bits) => (marked ? bits | SET_BY_VALUES : bits & ~SET_BY_VALUES));
  }

  /** Forgets the state of a handle (given again to another row) */
  clear(handle: RowHandle): void {
    this.bulk.delete(handle);
    if (handle >= 0 && handle < this.bits.length) this.bits[handle] = 0;
  }

  /** The translation of a moving set, `[dLng, dLat]` in degrees */
  translation(set: number): [number, number] {
    return [this.translations[set * 2], this.translations[set * 2 + 1]];
  }

  /** Sets the translation of a moving set (degrees of longitude and latitude) */
  setTranslation(set: number, dLng: number, dLat: number): void {
    if (!Number.isInteger(set) || set < 1 || set > MOVE_SETS) {
      throw new DrawError('invalid-input', `RowStateSets: no moving set ${set}`);
    }
    this.translations[set * 2] = dLng;
    this.translations[set * 2 + 1] = dLat;
    this.translationRevision++;
  }

  /**
   * The rotation or resize of a moving set, applied before its translation (null for none)
   */
  transform(set: number): PlaneTransform | null {
    return this.transforms[set] ?? null;
  }

  /**
   * Sets the rotation or resize of a moving set (null: it only translates)
   *
   * @throws when the set is not 1 to 3
   */
  setTransform(set: number, transform: PlaneTransform | null): void {
    if (!Number.isInteger(set) || set < 1 || set > MOVE_SETS) {
      throw new DrawError('invalid-input', `RowStateSets: no moving set ${set}`);
    }
    this.transforms[set] = transform;
    this.translationRevision++;
  }

  /** Applies a change of bits to every handle and reports the ones that changed */
  private update(handles: Int32Array, change: (bits: number) => number): void {
    let max = -1;
    for (const handle of handles) if (handle > max) max = handle;
    this.reserve(max + 1);
    const changed: number[] = [];
    for (const handle of handles) {
      if (handle < 0) continue;
      const next = change(this.bits[handle]);
      if (next === this.bits[handle]) continue;
      this.bits[handle] = next;
      changed.push(handle);
    }
    if (changed.length > 0) this.onChange(Int32Array.from(changed));
  }

  private reserve(n: number): void {
    if (n <= this.bits.length) return;
    let size = this.bits.length * 2;
    while (size < n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bits);
    this.bits = next;
  }
}
