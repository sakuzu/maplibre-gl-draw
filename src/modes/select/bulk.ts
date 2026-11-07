// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The select mode over features selected in bulk (`Selection.bulk`)
 *
 * - A box drawn over a Store of rows finds the rows in it on their columns: the rows whose extent
 *   is in the box are in it, the others are tested as the features they are, by the test of
 *   their type (the rows on the sides of the box only)
 * - A drag of the features selected in bulk is shown by a sketch of `{ selection: true }`, which
 *   draws their rows moved by a moving set (`sketches/sketch-motion.ts`), and written once on the
 *   CPU with the same edit when the drag is let go, in the same task the set is let go of (the
 *   drawing takes both in the same frame)
 * - The arrow keys move them by the same moving set, and the moves made while a key is held are
 *   written once, a moment after the last one (one step of the history), as one move
 * - A locked feature stays where it is: its row is not in the moving set, and the others move
 */

import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import type { RowGroup } from '../../feature-table/layer-table.js';
import { rowGeometry, rowProperties, rowType } from '../../feature-table/row-read.js';
import { BULK_MOVE_SET, STATE_UNHIT_MASK } from '../../feature-table/row-state.js';
import { TableSelection } from '../../feature-table/selection.js';
import { movableBulkRows } from '../../operations/bulk-selection.js';
import { writeKindsInSlices } from '../../operations/bulk-sliced.js';
import {
  type BulkKinds,
  transformBulkSelection,
  transformKinds,
} from '../../operations/bulk-transform.js';
import type { TransformEdit } from '../../store/store.js';
import type { BoxSelection, Feature } from '../../store/types.js';
import { ROW_FLAG_DELETED, ROW_FLAG_LOCKED } from '../../table/row-group-types.js';
import type { EngineModeContext } from '../handler.js';
import { boxRects, isFeatureInBox } from './box-selection.js';

export { BULK_MOVE_SET };

/**
 * The rows in a box drawn over a Store of rows, read on their columns: the rows that can be
 * seen and are not locked (nor their group or their layer), whose geometry meets the box by the
 * test of their type
 *
 * A row whose extent is inside the box is in it without being made a feature (the test of a
 * point, a line, an area or a circle is met then); a row on a side of the box is made the
 * feature it is, without being opened, and tested as the features are.
 *
 * @internal
 */
export function queryRowsInBox(box: BoxSelection, context: EngineModeContext): TableSelection {
  const { store, boxSelectionRegistry } = context;
  const tables = store.tables;
  const internals = featureTablesInternals(tables);
  if (!tables || !internals) return TableSelection.empty;
  const found = new Set<number>();
  const layers = new Map<string, boolean>();
  const layerOpen = (layerId: string): boolean => {
    let open = layers.get(layerId);
    if (open === undefined) {
      const layer = store.getLayer(layerId);
      open = layer?.visible === true && !layer.locked && !store.isHidden(layerId);
      layers.set(layerId, open);
    }
    return open;
  };
  for (const rect of boxRects(box.startPoint, box.endPoint)) {
    const cursor = tables.scan({
      bbox: [rect.minX, rect.minY, rect.maxX, rect.maxY],
      order: 'any',
    });
    for (let batch = cursor.next(); batch; batch = cursor.next()) {
      for (const handle of batch) {
        if (found.has(handle)) continue;
        const place = internals.placeOf(handle);
        if (!place) continue;
        const { group, row } = place;
        const data = group.data;
        const flags = data.flags[row];
        if ((flags & (ROW_FLAG_DELETED | ROW_FLAG_LOCKED)) !== 0) continue;
        if ((group.state[row] & STATE_UNHIT_MASK) !== 0) continue;
        if (!layerOpen(place.layer.layerId)) continue;
        const featureGroup = data.groups[row];
        if (featureGroup >= 0) {
          if (
            !internals.groups.isVisible(featureGroup) ||
            internals.groups.isLocked(featureGroup)
          ) {
            continue;
          }
          const groupId = internals.groups.idOf(featureGroup);
          if (groupId !== undefined && store.isHidden(groupId)) continue;
        }
        const type = rowType(data, row);
        const b = data.rowBounds;
        const at = row * 4;
        const inside =
          b[at] >= rect.minX &&
          b[at + 2] <= rect.maxX &&
          b[at + 1] >= rect.minY &&
          b[at + 3] <= rect.maxY;
        if (inside && boxSelectionRegistry.get(type)?.insideMeetsTest === true) {
          found.add(handle);
          continue;
        }
        const feature = rowAsFeature(
          internals.ids.idOf(handle) as string,
          place.layer.layerId,
          group,
          row,
        );
        if (feature && isFeatureInBox(feature, rect, boxSelectionRegistry)) found.add(handle);
      }
    }
  }
  return TableSelection.of([...found]);
}

/**
 * A row as the feature it is, to test it as features are tested (null for a row without a
 * geometry); the values of its positions after `x` and `y` are kept
 */
function rowAsFeature(id: string, layerId: string, group: RowGroup, row: number): Feature | null {
  const geometry = rowGeometry(group, row);
  if (!geometry) return null;
  const data = group.data;
  return {
    id,
    type: rowType(data, row),
    geometry: geometry as Feature['geometry'],
    layerId,
    groupId: undefined,
    properties: rowProperties(group, row),
    style: {},
    visible: true,
    locked: false,
  };
}

// ============================================================================
// The write of a drag
// ============================================================================

/**
 * Writes a drag of features selected in bulk let go, by the edit its sketch shows them moved by, in
 * steps (`bulk-sliced.ts`): the rows stay in their moving set, each leaves it in the task it is
 * written in, and the moving set is let go of with the last of them (`RowStateSets`); then `done`
 * is called
 *
 * @param rows The rows, in their moving set
 * @internal
 */
export function writeBulkEdit(
  context: EngineModeContext,
  rows: TableSelection,
  edit: TransformEdit,
  done: () => void,
): void {
  const { store, map } = context;
  const states = featureTablesInternals(store.tables)?.states;
  const release = (): void => {
    states?.setMoving(rows.handles, 0);
    states?.setByValues(rows.handles, false);
    map.triggerRepaint();
    done();
  };
  let kinds: BulkKinds | null = null;
  try {
    kinds = transformKinds(store, edit, rows);
  } finally {
    if (!kinds) release();
  }
  if (!kinds) return;
  writeKindsInSlices(store, rows, kinds, {
    onWritten: (written) => {
      states?.setMoving(Int32Array.from(written), 0);
      map.triggerRepaint();
    },
    onDone: release,
  });
}

// ============================================================================
// The arrow keys
// ============================================================================

/** How long after the last arrow key the moves are written (ms) */
export const BULK_NUDGE_COMMIT_MS = 300;

/**
 * The moves of the arrow keys over features selected in bulk: shown by their moving set while the
 * keys are pressed, and written once, `BULK_NUDGE_COMMIT_MS` after the last press (the presses of
 * a key held are one step of the history)
 *
 * The presses make one move (`translate`): from the center of the frame of the features when the
 * first key is pressed, to where the presses took it.
 *
 * @internal
 */
export class BulkNudge {
  #rows: TableSelection | null = null;
  #from: [number, number] = [0, 0];
  #to: [number, number] = [0, 0];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #context: EngineModeContext | null = null;

  /** Whether moves are waiting to be written */
  get active(): boolean {
    return this.#rows !== null;
  }

  /**
   * Adds the move of a press of a key; the moves are written a moment after the last one
   *
   * @param center The center of the frame of the features (where the first press starts from)
   * @param step Where a press takes a point: given the point the presses took the center to so far
   * @returns false when nothing is selected in bulk or the selection cannot be moved
   */
  add(
    context: EngineModeContext,
    center: readonly [number, number],
    step: (from: readonly [number, number]) => [number, number],
  ): boolean {
    const rows = movableBulkRows(context.store);
    const states = featureTablesInternals(context.store.tables)?.states;
    if (rows.count === 0 || !states) return false;
    if (this.#rows && !this.#rows.equals(rows)) this.flush();
    if (!this.#rows) {
      // A write of a drag let go before, still under way, is made first (it shares the set)
      context.store.finishSlicedWrite();
      // A sketch moves them now
      if (states.movingCount(BULK_MOVE_SET) > 0) return false;
      this.#rows = rows;
      this.#context = context;
      this.#from = [center[0], center[1]];
      this.#to = [center[0], center[1]];
      states.setMoving(rows.handles, BULK_MOVE_SET);
    }
    this.#to = step(this.#to);
    states.setTransform(BULK_MOVE_SET, this.#edit());
    context.map.triggerRepaint();
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, BULK_NUDGE_COMMIT_MS);
    return true;
  }

  /** The move shown so far */
  #edit(): TransformEdit {
    return { kind: 'translate', from: [...this.#from], to: [...this.#to] };
  }

  /** Writes the moves waiting now (one change), and takes the rows out of the moving set */
  flush(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const rows = this.#rows;
    const context = this.#context;
    this.#rows = null;
    this.#context = null;
    if (!rows || !context) return;
    const store = context.store;
    try {
      if (this.#from[0] !== this.#to[0] || this.#from[1] !== this.#to[1]) {
        transformBulkSelection(store, this.#edit(), rows);
      }
    } finally {
      featureTablesInternals(store.tables)?.states.setMoving(rows.handles, 0);
      context.map.triggerRepaint();
    }
  }

  /** Drops the moves waiting, unwritten (the rows go back where they are) */
  cancel(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const rows = this.#rows;
    const context = this.#context;
    this.#rows = null;
    this.#context = null;
    if (!rows || !context) return;
    featureTablesInternals(context.store.tables)?.states.setMoving(rows.handles, 0);
    context.map.triggerRepaint();
  }
}
