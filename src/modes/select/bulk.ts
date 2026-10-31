// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The select mode over features selected in bulk (`Selection.bulk`, 11 of the design)
 *
 * - A box drawn over a Store of rows finds the rows in it on their columns: the rows whose extent
 *   is in the box are in it, the others are tested as the features they are, by the test of
 *   their type (the rows on the sides of the box only)
 * - A drag of the features selected in bulk moves, rotates or resizes their rows by the state of
 *   their rows: they are in one moving set, drawn moved by the edit of the drag (`translate`,
 *   `rotate`, `scale`), and written once on the CPU with the same edit when the drag is let go,
 *   in the same task the set is let go of (the drawing takes both in the same frame)
 * - The arrow keys move them by the same moving set, and the moves made while a key is held are
 *   written once, a moment after the last one (one step of the history), as one move
 */

import type { DragNormalizedEvent } from '../../dispatcher/types.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import type { RowGroup } from '../../feature-table/layer-table.js';
import { rowGeometry, rowProperties, rowType } from '../../feature-table/row-read.js';
import { BULK_MOVE_SET, STATE_UNHIT_MASK } from '../../feature-table/row-state.js';
import { TableSelection } from '../../feature-table/selection.js';
import { writeKindsInSlices } from '../../operations/bulk-sliced.js';
import {
  type BulkKinds,
  rowsByValues,
  transformBulkSelection,
  transformKinds,
} from '../../operations/bulk-transform.js';
import { rotateEditOf } from '../../operations/rotate.js';
import { type ScaleState, scaleEditOf, startScale } from '../../operations/scale.js';
import type { HandleType } from '../../shared/config/constants.js';
import { createCoordinateTransform } from '../../shared/math/index.js';
import type { BoundingBoxCoords } from '../../shared/types/selection-box.js';
import type { TransformEdit } from '../../store/store.js';
import type { BoxSelection, Feature } from '../../store/types.js';
import { ROW_FLAG_DELETED, ROW_FLAG_LOCKED } from '../../table/row-group-types.js';
import type { EngineModeContext } from '../handler.js';
import { boxRects, isFeatureInBox } from './box-selection.js';
import type { IntermediateWrites } from './drag/intermediate-writes.js';
import type { DragOperation, DragStore } from './drag/operation.js';
import { dragStartLngLat } from './drag/operation.js';

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
// The drags
// ============================================================================

/** What the drags of the features selected in bulk move: their rows, by their moving set */
abstract class BulkDrag implements DragOperation {
  abstract readonly type: 'move' | 'rotate' | 'resize';
  #ended = false;

  constructor(
    protected readonly context: EngineModeContext,
    protected readonly rows: TableSelection,
  ) {
    // A write of a drag let go before, still under way, is made first (its rows leave the moving
    // set it shares)
    context.store.finishSlicedWrite();
    const states = featureTablesInternals(context.store.tables)?.states;
    states?.setMoving(rows.handles, BULK_MOVE_SET);
    states?.setTranslation(BULK_MOVE_SET, 0, 0);
    states?.setTransform(BULK_MOVE_SET, null);
  }

  abstract update(event: DragNormalizedEvent, store: DragStore, writes: IntermediateWrites): void;

  /** The writes of the rows where the drag let them go (null: nothing to write) */
  protected abstract kinds(store: DragStore): BulkKinds | null;

  /**
   * Ends the drag. Committed, the rows are written where they are drawn, in steps
   * (`bulk-sliced.ts`): each row leaves the moving set in the task it is written in, and the
   * moving set is let go of with the last of them; then `done` is called. Not committed, the
   * moving set is let go of at once
   */
  end(store: DragStore, committed: boolean, done?: () => void): void {
    if (this.#ended) return;
    this.#ended = true;
    const states = featureTablesInternals(store.tables)?.states;
    const release = (): void => {
      states?.setMoving(this.rows.handles, 0);
      states?.setByValues(this.rows.handles, false);
      states?.setTranslation(BULK_MOVE_SET, 0, 0);
      states?.setTransform(BULK_MOVE_SET, null);
      this.context.map.triggerRepaint();
      done?.();
    };
    let kinds: BulkKinds | null = null;
    try {
      kinds = committed ? this.kinds(store) : null;
    } finally {
      if (!kinds) release();
    }
    if (!kinds) return;
    writeKindsInSlices(store, this.rows, kinds, {
      onWritten: (rows) => {
        states?.setMoving(Int32Array.from(rows), 0);
        this.context.map.triggerRepaint();
      },
      onDone: release,
    });
  }
}

/** Sets the edit the moving set of the features selected in bulk is drawn moved by */
function showEdit(context: EngineModeContext, edit: TransformEdit): void {
  featureTablesInternals(context.store.tables)?.states.setTransform(BULK_MOVE_SET, edit);
  context.map.triggerRepaint();
}

/**
 * The move of the features selected in bulk: their moving set is moved from the point the drag
 * started at to the pointer, and their rows are written by the same edit once let go
 *
 * @internal
 */
export class BulkMoveDrag extends BulkDrag {
  readonly type = 'move' as const;
  readonly #start: { lng: number; lat: number };
  #edit: TransformEdit | null = null;

  constructor(context: EngineModeContext, rows: TableSelection, event: DragNormalizedEvent) {
    super(context, rows);
    this.#start = dragStartLngLat(event);
  }

  update(event: DragNormalizedEvent): void {
    this.#edit = {
      kind: 'translate',
      from: [this.#start.lng, this.#start.lat],
      to: [event.lngLat.lng, event.lngLat.lat],
    };
    showEdit(this.context, this.#edit);
  }

  protected kinds(store: DragStore): BulkKinds | null {
    const edit = this.#edit;
    if (edit?.kind !== 'translate') return null;
    if (edit.from[0] === edit.to[0] && edit.from[1] === edit.to[1]) return null;
    return transformKinds(store, edit, this.rows);
  }
}

/**
 * The rotation of the features selected in bulk around the center of their frame: their moving
 * set is turned by the angle of the pointer, and their rows are written by the same edit once
 * let go
 *
 * @internal
 */
export class BulkRotateDrag extends BulkDrag {
  readonly type = 'rotate' as const;
  readonly #center: [number, number];
  readonly #start: { lng: number; lat: number };
  #edit: TransformEdit | null = null;

  constructor(
    context: EngineModeContext,
    rows: TableSelection,
    event: DragNormalizedEvent,
    bbox: BoundingBoxCoords,
  ) {
    super(context, rows);
    // The rows turned by their rotation are drawn so, as they are written once let go
    featureTablesInternals(context.store.tables)?.states.setByValues(
      rowsByValues(context.store, rows, 'rotate'),
      true,
    );
    this.#center = [bbox.center[0], bbox.center[1]];
    this.#start = dragStartLngLat(event);
    context.store.setDragState({
      operation: 'rotate',
      movingFeatureIds: [],
      movingRows: rows,
      rotateInfo: {
        initialBbox: {
          topLeft: bbox.topLeft,
          topRight: bbox.topRight,
          bottomRight: bbox.bottomRight,
          bottomLeft: bbox.bottomLeft,
          center: bbox.center,
        },
        currentAngle: 0,
        center: this.#center,
      },
    });
  }

  update(event: DragNormalizedEvent, store: DragStore): void {
    const edit = rotateEditOf(this.#center, this.#start, event.lngLat);
    this.#edit = edit;
    showEdit(this.context, edit);
    const dragState = store.getDragState();
    if (dragState?.rotateInfo) {
      store.setDragState({
        ...dragState,
        rotateInfo: { ...dragState.rotateInfo, currentAngle: (edit.angleDegrees * Math.PI) / 180 },
      });
    }
  }

  protected kinds(store: DragStore): BulkKinds | null {
    const edit = this.#edit;
    if (edit?.kind !== 'rotate' || edit.angleDegrees === 0) return null;
    return transformKinds(store, edit, this.rows);
  }
}

/**
 * The resize of the features selected in bulk from a handle of their frame: their moving set is
 * scaled by the factors of the pointer, and their rows are written by the same edit once let go
 *
 * @internal
 */
export class BulkResizeDrag extends BulkDrag {
  readonly type = 'resize' as const;
  readonly #state: ScaleState;
  #edit: TransformEdit | null = null;

  constructor(
    context: EngineModeContext,
    rows: TableSelection,
    event: DragNormalizedEvent,
    handle: HandleType,
    bbox: BoundingBoxCoords,
  ) {
    super(context, rows);
    // The rows that keep their shape are drawn so, as they are written once let go
    featureTablesInternals(context.store.tables)?.states.setByValues(
      rowsByValues(context.store, rows, 'scale'),
      true,
    );
    // A frame thinner than a pixel along an axis is not stretched along it, as the resize drag
    // of features takes it
    const transform = createCoordinateTransform(context.map);
    this.#state = startScale(handle, dragStartLngLat(event), bbox, (lngLat) =>
      transform.metersPerPixel(lngLat),
    );
    context.store.setDragState({ operation: 'resize', movingFeatureIds: [], movingRows: rows });
  }

  update(event: DragNormalizedEvent): void {
    this.#edit = scaleEditOf(this.#state, event.lngLat);
    showEdit(this.context, this.#edit);
  }

  protected kinds(store: DragStore): BulkKinds | null {
    if (!this.#edit) return null;
    return transformKinds(store, this.#edit, this.rows);
  }
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
    const rows = context.store.getSelectedRows();
    const states = featureTablesInternals(context.store.tables)?.states;
    if (!rows || !states) return false;
    if (this.#rows && !this.#rows.equals(rows)) this.flush();
    if (!this.#rows) {
      // A write of a drag let go before, still under way, is made first (it shares the set)
      context.store.finishSlicedWrite();
      this.#rows = rows;
      this.#context = context;
      this.#from = [center[0], center[1]];
      this.#to = [center[0], center[1]];
      states.setMoving(rows.handles, BULK_MOVE_SET);
      states.setTranslation(BULK_MOVE_SET, 0, 0);
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

  /** Writes the moves waiting now (one change), and lets the moving set go */
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
      const states = featureTablesInternals(store.tables)?.states;
      states?.setMoving(rows.handles, 0);
      states?.setTransform(BULK_MOVE_SET, null);
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
    const states = featureTablesInternals(context.store.tables)?.states;
    states?.setMoving(rows.handles, 0);
    states?.setTransform(BULK_MOVE_SET, null);
    context.map.triggerRepaint();
  }
}
