// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The state of the rows of the features: what the bits of the copy of the state of a row mean to
 * the library, the moving sets, and the byte the GPU reads
 *
 * The tables keep a copy of 16 bits per row (`row-state.ts`) and give the bits no meaning but
 * their own three (deleted, read from the delta, waiting for a next version). The library gives
 * the others theirs:
 *
 * - Six bits of each handle (`FEATURE_ROW_STATE_BITS`): hidden on this client, drawn over by a
 *   sketch, marked as selected in bulk, the two bits of the moving set, turned and scaled by its
 *   values while it is dragged. They are written through `RowStateSets`, the one place they are
 *   written
 * - One bit of each group: the group is hidden on this client
 * - Three bits from values: the row is not shown (`hidden`), its group is not shown, and it is
 *   scaled by the same factor in x and y (the type `Circle`)
 *
 * The GPU gets one byte per row made from the copy (`toGpuState`), and reads it by the number of
 * the row.
 */

import type { EnuEdit } from '../geometry/enu-transforms.js';
import { DrawError } from '../shared/draw-error.js';
import type { GroupTable } from './group-table.js';
import {
  type RowStates,
  STATE_DELETED,
  STATE_DELTA,
  STATE_WAIT,
  type ValueStates,
} from './row-state.js';
import type { GroupHandle, RowHandle } from './types.js';

// === The bits of each handle (the lowest of the copy) ===

/** Hidden by this client only */
export const STATE_HIDDEN_LOCAL = 1 << 0;
/**
 * A sketch of the feature of the row is drawn in its place (`draw.sketches`): the row is not drawn,
 * and is still hit where it is
 */
export const STATE_HIDDEN_SKETCH = 1 << 1;
/** Marked as selected in bulk */
export const STATE_BULK = 1 << 2;
/** The first of the two bits of the moving set of the row (0 = not moving, 1 to 3) */
export const STATE_MOVE_SHIFT = 3;
/** The two bits of the moving set */
export const STATE_MOVE_MASK = 3 << STATE_MOVE_SHIFT;
/**
 * Turned and scaled by its values while it is dragged (its rotation, its scale), as the write of
 * the drag let go turns and scales it: a row whose type gives it the field the edit changes
 * (`store/transform-roles.ts`)
 */
export const STATE_BY_VALUES = 1 << 5;
/** The number of bits of each handle */
export const FEATURE_ROW_STATE_BITS = 6;

// === The bit of each group ===

/** Its group of features is hidden by this client only */
export const STATE_HIDDEN_GROUP_LOCAL = 1 << 6;

// === The bits from values ===

/** Not shown (the row's own value) */
export const STATE_HIDDEN_INVISIBLE = 1 << 7;
/** Its group of features is not shown */
export const STATE_HIDDEN_GROUP = 1 << 8;
/** Scaled by the same factor in x and y (a Circle) */
export const STATE_UNIFORM = 1 << 9;

/**
 * The bits of the library from values (`valueStates`): the `hidden` flag of a row, the `hidden`
 * flag of its group, and the type `Circle`
 */
export const FEATURE_VALUE_STATES: ValueStates = Object.freeze({
  rowFlags: Object.freeze([Object.freeze({ column: 'hidden', states: STATE_HIDDEN_INVISIBLE })]),
  groupFlags: Object.freeze([Object.freeze({ column: 'hidden', states: STATE_HIDDEN_GROUP })]),
  wholeValues: Object.freeze([
    Object.freeze({ column: 'type', values: Object.freeze(['Circle']), states: STATE_UNIFORM }),
  ]),
});

// === The bits of the tables ===

/** Deleted (kept for what still refers to it) */
export const STATE_HIDDEN_DELETED = STATE_DELETED;
/** The row is drawn from the delta of its layer (a copy written since its group was built) */
export const STATE_HIDDEN_DELTA = STATE_DELTA;
/**
 * The row moved into this group from another, whose next version is not in yet: the row is
 * read and drawn where it is now (the delta) until then
 */
export const STATE_HIDDEN_WAIT = STATE_WAIT;

/** The bits of every reason a row is hidden */
export const STATE_HIDDEN_MASK =
  STATE_HIDDEN_LOCAL |
  STATE_HIDDEN_SKETCH |
  STATE_HIDDEN_GROUP_LOCAL |
  STATE_HIDDEN_INVISIBLE |
  STATE_HIDDEN_GROUP |
  STATE_HIDDEN_DELETED |
  STATE_HIDDEN_DELTA |
  STATE_HIDDEN_WAIT;
/** The bits of the reasons a row is not hit (a row drawn over is hit where it is) */
export const STATE_UNHIT_MASK = STATE_HIDDEN_MASK & ~STATE_HIDDEN_SKETCH;
/**
 * The bits of the library that leave a row out of the rows drawn (`hiddenStates`; the tables
 * leave out the rows deleted and read elsewhere themselves): a row a sketch is drawn over is
 * drawn, by its sketch
 */
export const FEATURE_HIDDEN_STATES =
  STATE_HIDDEN_LOCAL | STATE_HIDDEN_GROUP_LOCAL | STATE_HIDDEN_INVISIBLE | STATE_HIDDEN_GROUP;

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
 * The moving set the features selected in bulk are moved with, by a sketch of this client or by
 * the arrow keys
 */
export const BULK_MOVE_SET = 2;

/** The moving set of the rows of the features a sketch of this client names */
export const SKETCH_MOVE_SET = 3;

/**
 * The byte the GPU reads for the copy of the state of a row: a row turned and scaled by its
 * values keeps its shape as a Circle does
 *
 * @internal
 */
export function toGpuState(state: number): number {
  return (
    ((state & STATE_HIDDEN_MASK) !== 0 ? GPU_STATE_HIDDEN : 0) |
    (((state & STATE_MOVE_MASK) >> STATE_MOVE_SHIFT) << GPU_STATE_MOVE_SHIFT) |
    ((state & STATE_BULK) !== 0 ? GPU_STATE_BULK : 0) |
    ((state & (STATE_UNIFORM | STATE_BY_VALUES)) !== 0 ? GPU_STATE_UNIFORM : 0)
  );
}

/**
 * What the state of the rows of the library is written to: the writer of the tables, and where
 * the tables keep the bits of the handles and of the groups
 *
 * @internal
 */
export interface RowStateTables {
  /** Sets the bits under a mask of handles (`TablesWriter.setRowStates`) */
  setRowStates(handles: Int32Array, mask: number, bits: number): void;
  /** Sets the bits under a mask of groups (`TablesWriter.setGroupStates`) */
  setGroupStates(groups: Int32Array, mask: number, bits: number): void;
  /** The bits of the handles */
  readonly rowStates: RowStates;
  /** The groups, with their bits */
  readonly groups: GroupTable;
}

/**
 * The state of the rows of the library, written to the tables
 *
 * A moving set moves its rows by its translation and its transform while one row is in it. Once
 * the last of its rows leaves it (taken out of every set, put into another, or forgotten), it is
 * let go of: no translation and no transform. Whatever moves rows by a set (a drag of features
 * selected in bulk, the arrow keys, a move of many rows of a sketch) takes it so, empty and still, and
 * leaves it so with its rows, on one path, whether the move is written or put back.
 *
 * A group hidden on this client is hidden by its id: the rows of the group of the id are hidden
 * while it is, the group created again included (`groupsWritten`).
 *
 * @internal
 */
export class RowStateSets {
  /** The handles marked as selected in bulk */
  private readonly bulk = new Set<RowHandle>();
  /** The translation of each moving set, `[dLng, dLat]` (set 0 is unused) */
  private readonly translations = new Float64Array((MOVE_SETS + 1) * 2);
  /** The edit that moves, rotates or scales each moving set (null for none; set 0 is unused) */
  private readonly transforms: Array<EnuEdit | null> = new Array(MOVE_SETS + 1).fill(null);
  private translationRevision = 0;
  private membersRevision = 0;
  /** The number of rows in each moving set (set 0 is unused) */
  private readonly members = new Int32Array(MOVE_SETS + 1);
  /** The handles counted once by `setMoving` (cleared after) */
  private counted = new Uint8Array(64);
  /** The ids of the groups of features hidden on this client */
  private readonly hiddenGroupIds = new Set<string>();

  constructor(private readonly tables: RowStateTables) {}

  /** Changes with every change of a translation or a transform (the GPU writes its uniforms again) */
  get revision(): number {
    return this.translationRevision;
  }

  /** Changes with every row put into a moving set or taken out of one */
  get movingRevision(): number {
    return this.membersRevision;
  }

  /** The number of rows in a moving set */
  movingCount(set: number): number {
    return this.members[set] ?? 0;
  }

  /** The rows in a moving set, walked once for each change of them */
  movingHandles(): RowHandle[] {
    if (this.members.every((count) => count === 0)) return [];
    return this.tables.rowStates.find(STATE_MOVE_MASK);
  }

  /** The bits of the state of a handle, as the copy of a group holds them */
  stateOf(handle: RowHandle): number {
    return this.tables.rowStates.of(handle);
  }

  /** Hides or shows rows in this client only */
  setHidden(handles: Int32Array, hidden: boolean): void {
    this.tables.setRowStates(handles, STATE_HIDDEN_LOCAL, hidden ? STATE_HIDDEN_LOCAL : 0);
  }

  /** Marks or unmarks rows as drawn over by a sketch of their features, for this client only */
  setSketched(handles: Int32Array, sketched: boolean): void {
    this.tables.setRowStates(handles, STATE_HIDDEN_SKETCH, sketched ? STATE_HIDDEN_SKETCH : 0);
  }

  /** Marks or unmarks rows as selected in bulk */
  setBulk(handles: Int32Array, marked: boolean): void {
    for (const handle of handles) {
      if (handle < 0) continue;
      if (marked) this.bulk.add(handle);
      else this.bulk.delete(handle);
    }
    this.tables.setRowStates(handles, STATE_BULK, marked ? STATE_BULK : 0);
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
    // The rows counted out of their sets and into this one, each once
    let max = -1;
    for (const handle of handles) if (handle > max) max = handle;
    this.reserveCounted(max + 1);
    const rowStates = this.tables.rowStates;
    let left = 0;
    for (const handle of handles) {
      if (handle < 0 || this.counted[handle] !== 0) continue;
      this.counted[handle] = 1;
      left |= this.leave((rowStates.of(handle) & STATE_MOVE_MASK) >> STATE_MOVE_SHIFT, set);
    }
    for (const handle of handles) if (handle >= 0) this.counted[handle] = 0;
    this.tables.setRowStates(handles, STATE_MOVE_MASK, set << STATE_MOVE_SHIFT);
    this.letGoIfEmpty(left);
  }

  /**
   * Marks or unmarks rows as turned and scaled by their values while they are dragged (the write
   * of the drag decides which)
   */
  setByValues(handles: Int32Array, marked: boolean): void {
    this.tables.setRowStates(handles, STATE_BY_VALUES, marked ? STATE_BY_VALUES : 0);
  }

  /**
   * Hides or shows the rows of a group of features on this client only, as the features of a
   * group hidden on this client are: the rows that are in the group by the id, now and while it
   * is hidden, are not drawn and not hit
   */
  setGroupHidden(groupId: string, hidden: boolean): void {
    if (this.hiddenGroupIds.has(groupId) === hidden) return;
    if (hidden) this.hiddenGroupIds.add(groupId);
    else this.hiddenGroupIds.delete(groupId);
    const group = this.tables.groups.handleOfId(groupId);
    if (group < 0) return;
    this.tables.setGroupStates(
      Int32Array.of(group),
      STATE_HIDDEN_GROUP_LOCAL,
      hidden ? STATE_HIDDEN_GROUP_LOCAL : 0,
    );
  }

  /**
   * Hides the groups of a write of groups whose ids are hidden on this client and that are not
   * hidden yet (a group created again)
   *
   * @param groups - The groups written
   */
  groupsWritten(groups: Int32Array): void {
    if (this.hiddenGroupIds.size === 0) return;
    const table = this.tables.groups;
    const hide: GroupHandle[] = [];
    for (const group of groups) {
      const id = table.idOf(group);
      if (id === undefined || !this.hiddenGroupIds.has(id)) continue;
      if ((table.statesOf(group) & STATE_HIDDEN_GROUP_LOCAL) === 0) hide.push(group);
    }
    if (hide.length === 0) return;
    this.tables.setGroupStates(
      Int32Array.from(hide),
      STATE_HIDDEN_GROUP_LOCAL,
      STATE_HIDDEN_GROUP_LOCAL,
    );
  }

  /**
   * Forgets what is kept of a handle the tables give again to another row, with the bits it had
   * (the tables have forgotten them)
   */
  forgotten(handle: RowHandle, bits: number): void {
    this.bulk.delete(handle);
    const from = (bits & STATE_MOVE_MASK) >> STATE_MOVE_SHIFT;
    this.letGoIfEmpty(this.leave(from, 0));
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
   * The edit that moves, rotates or scales a moving set, applied before its translation (null for
   * none)
   */
  transform(set: number): EnuEdit | null {
    return this.transforms[set] ?? null;
  }

  /**
   * Sets the edit that moves, rotates or scales a moving set (null: it only translates); its rows
   * are drawn as the edit moves them (`view/renderers/row-motion.ts`)
   *
   * @throws when the set is not 1 to 3
   */
  setTransform(set: number, transform: EnuEdit | null): void {
    if (!Number.isInteger(set) || set < 1 || set > MOVE_SETS) {
      throw new DrawError('invalid-input', `RowStateSets: no moving set ${set}`);
    }
    this.transforms[set] = transform;
    this.translationRevision++;
  }

  /**
   * Counts a row out of a moving set and into another
   *
   * @returns The set it left, as a bit (0 when it stays in its set)
   */
  private leave(from: number, to: number): number {
    if (from === to) return 0;
    this.membersRevision++;
    if (to > 0) this.members[to]++;
    if (from === 0) return 0;
    this.members[from]--;
    return 1 << from;
  }

  /** Lets go of the moving sets rows left that no row is in any more */
  private letGoIfEmpty(left: number): void {
    for (let set = 1; set <= MOVE_SETS; set++) {
      if ((left & (1 << set)) === 0 || this.members[set] > 0) continue;
      this.translations[set * 2] = 0;
      this.translations[set * 2 + 1] = 0;
      this.transforms[set] = null;
      this.translationRevision++;
    }
  }

  private reserveCounted(n: number): void {
    if (n <= this.counted.length) return;
    let size = this.counted.length * 2;
    while (size < n) size *= 2;
    this.counted = new Uint8Array(size);
  }
}
