// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The select mode over features selected in bulk (`Selection.bulk`, 11 of the design)
 *
 * - A box drawn over a Store of rows finds the rows in it on their columns: the rows whose extent
 *   is in the box are in it, the others are tested as the features they are, by the test of
 *   their type (the rows on the sides of the box only)
 * - A drag of the features selected in bulk moves, rotates or resizes their rows by the state of
 *   their rows: they are in one moving set, drawn moved by its translation or its transform, and
 *   written once on the CPU when the drag is let go, in the same task the set is let go of (the
 *   drawing takes both in the same frame)
 * - The arrow keys move them by the same moving set, and the moves made while a key is held are
 *   written once, a moment after the last one (one step of the history)
 */

import type { DragNormalizedEvent } from '../../dispatcher/types.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import type { RowGroup } from '../../feature-table/layer-table.js';
import { rowGeometry, rowProperties, rowType } from '../../feature-table/row-read.js';
import { STATE_UNHIT_MASK } from '../../feature-table/row-state.js';
import { TableSelection } from '../../feature-table/selection.js';
import {
  resizeBulkSelection,
  rotateBulkSelection,
  translateBulkSelection,
} from '../../operations/bulk-transform.js';
import { computeResizeFactors, startResize } from '../../operations/resize.js';
import { getRotationDelta, startRotation } from '../../operations/rotate.js';
import type { HandleType } from '../../shared/config/constants.js';
import { resizeTransform, rotationTransform } from '../../shared/math/plane-transform.js';
import type { BoundingBoxCoords } from '../../shared/types/selection-box.js';
import type { BoxSelection, Feature } from '../../store/types.js';
import { ROW_FLAG_DELETED, ROW_FLAG_LOCKED } from '../../table/row-group-types.js';
import type { EngineModeContext } from '../handler.js';
import { boxRects, isFeatureInBox } from './box-selection.js';
import type { IntermediateWrites } from './drag/intermediate-writes.js';
import type { DragOperation, DragStore } from './drag/operation.js';
import { dragStartLngLat } from './drag/operation.js';

/**
 * The moving set the features selected in bulk are dragged with (set 1 is the one of the rows
 * opened as features)
 *
 * @internal
 */
export const BULK_MOVE_SET = 2;

/**
 * The rows in a box drawn over a Store of rows, read on their columns: the rows that can be
 * seen and are not locked (nor their group or their layer), whose geometry meets the box by the
 * test of their type; narrowed by the plugins that narrow rows
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
  const rows = TableSelection.of([...found]);
  return narrowRows(rows, context);
}

/**
 * The rows the plugins keep (each plugin that narrows the rows of a selection, by layer); the
 * rows of a layer are kept as they are when no plugin narrows rows
 *
 * @internal
 */
export function narrowRows(rows: TableSelection, context: EngineModeContext): TableSelection {
  const plugins = context.plugins;
  const tables = context.store.tables;
  const internals = featureTablesInternals(tables);
  if (!plugins?.filterSelectionRows || !tables || !internals || rows.count === 0) return rows;
  const byLayer = new Map<string, number[]>();
  for (const handle of rows.handles) {
    const layerId = internals.placeOf(handle)?.layer.layerId;
    if (layerId === undefined) continue;
    let list = byLayer.get(layerId);
    if (!list) {
      list = [];
      byLayer.set(layerId, list);
    }
    list.push(handle);
  }
  const kept: number[] = [];
  for (const [layerId, handles] of byLayer) {
    const view = tables.get(layerId);
    if (!view) continue;
    kept.push(...plugins.filterSelectionRows(view, Int32Array.from(handles)));
  }
  return TableSelection.of(kept);
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
    const states = featureTablesInternals(context.store.tables)?.states;
    states?.setMoving(rows.handles, BULK_MOVE_SET);
    states?.setTranslation(BULK_MOVE_SET, 0, 0);
    states?.setTransform(BULK_MOVE_SET, null);
  }

  abstract update(event: DragNormalizedEvent, store: DragStore, writes: IntermediateWrites): void;

  /** Writes the rows where the drag let them go */
  protected abstract commit(store: DragStore): void;

  /**
   * Ends the drag: committed, the rows are written where they are drawn; then the moving set is
   * let go of, in the same task (the drawing takes both in its next frame)
   */
  end(store: DragStore, committed: boolean): void {
    if (this.#ended) return;
    this.#ended = true;
    try {
      if (committed) this.commit(store);
    } finally {
      const states = featureTablesInternals(store.tables)?.states;
      states?.setMoving(this.rows.handles, 0);
      states?.setTranslation(BULK_MOVE_SET, 0, 0);
      states?.setTransform(BULK_MOVE_SET, null);
      this.context.map.triggerRepaint();
    }
  }
}

/**
 * The move of the features selected in bulk: their moving set is translated by the offset of
 * the pointer, and their rows are written by it once let go
 *
 * @internal
 */
export class BulkMoveDrag extends BulkDrag {
  readonly type = 'move' as const;
  readonly #start: { lng: number; lat: number };
  #dx = 0;
  #dy = 0;

  constructor(context: EngineModeContext, rows: TableSelection, event: DragNormalizedEvent) {
    super(context, rows);
    this.#start = dragStartLngLat(event);
  }

  update(event: DragNormalizedEvent): void {
    this.#dx = event.lngLat.lng - this.#start.lng;
    this.#dy = event.lngLat.lat - this.#start.lat;
    featureTablesInternals(this.context.store.tables)?.states.setTranslation(
      BULK_MOVE_SET,
      this.#dx,
      this.#dy,
    );
    this.context.map.triggerRepaint();
  }

  protected commit(store: DragStore): void {
    if (this.#dx === 0 && this.#dy === 0) return;
    translateBulkSelection(store, this.#dx, this.#dy, this.rows);
  }
}

/**
 * The rotation of the features selected in bulk around the center of their frame: their moving
 * set is turned by the angle of the pointer, and their rows are written by it once let go
 *
 * @internal
 */
export class BulkRotateDrag extends BulkDrag {
  readonly type = 'rotate' as const;
  readonly #state: ReturnType<typeof startRotation>;
  #angle = 0;

  constructor(
    context: EngineModeContext,
    rows: TableSelection,
    event: DragNormalizedEvent,
    bbox: BoundingBoxCoords,
  ) {
    super(context, rows);
    this.#state = startRotation(
      dragStartLngLat(event),
      bbox,
      [],
      context.selectionScope.extensions,
    );
    context.store.setDragState({
      operation: 'rotate',
      rotateInfo: {
        initialBbox: {
          topLeft: bbox.topLeft,
          topRight: bbox.topRight,
          bottomRight: bbox.bottomRight,
          bottomLeft: bbox.bottomLeft,
          center: bbox.center,
        },
        currentAngle: 0,
      },
    });
  }

  update(event: DragNormalizedEvent, store: DragStore): void {
    this.#angle = getRotationDelta(this.#state, event.lngLat);
    const center = this.#state.center as [number, number];
    featureTablesInternals(store.tables)?.states.setTransform(
      BULK_MOVE_SET,
      rotationTransform(center, this.#angle),
    );
    const dragState = store.getDragState();
    if (dragState?.rotateInfo) {
      store.setDragState({
        ...dragState,
        rotateInfo: { ...dragState.rotateInfo, currentAngle: this.#angle },
      });
    }
    this.context.map.triggerRepaint();
  }

  protected commit(store: DragStore): void {
    if (this.#angle === 0) return;
    rotateBulkSelection(
      store,
      this.#state.center as [number, number],
      this.#angle,
      this.context.selectionScope.extensions,
      this.rows,
    );
  }
}

/**
 * The resize of the features selected in bulk from a handle of their frame: their moving set is
 * scaled by the factors of the pointer, and their rows are written by them once let go
 *
 * @internal
 */
export class BulkResizeDrag extends BulkDrag {
  readonly type = 'resize' as const;
  readonly #state: ReturnType<typeof startResize>;
  readonly #handle: HandleType;
  readonly #bbox: BoundingBoxCoords;
  #current: { lng: number; lat: number } | null = null;

  constructor(
    context: EngineModeContext,
    rows: TableSelection,
    event: DragNormalizedEvent,
    handle: HandleType,
    bbox: BoundingBoxCoords,
  ) {
    super(context, rows);
    this.#handle = handle;
    this.#bbox = bbox;
    this.#state = startResize(
      handle,
      dragStartLngLat(event),
      bbox,
      [],
      context.selectionScope.extensions,
      minAxisExtentOf(context),
    );
    context.store.setDragState({ operation: 'resize' });
  }

  update(event: DragNormalizedEvent, store: DragStore): void {
    this.#current = { lng: event.lngLat.lng, lat: event.lngLat.lat };
    const { anchor, scaleX, scaleY, uniformScale } = computeResizeFactors(
      this.#state,
      this.#current,
    );
    featureTablesInternals(store.tables)?.states.setTransform(
      BULK_MOVE_SET,
      resizeTransform(anchor, scaleX, scaleY, uniformScale),
    );
    this.context.map.triggerRepaint();
  }

  protected commit(store: DragStore): void {
    if (!this.#current) return;
    resizeBulkSelection(
      store,
      {
        handle: this.#handle,
        bbox: this.#bbox,
        startLngLat: this.#state.startLngLat,
        currentLngLat: this.#current,
        minAxisExtent: this.#state.minAxisExtent,
      },
      this.context.selectionScope.extensions,
      this.rows,
    );
  }
}

/**
 * The extent below which a frame is not stretched along an axis: 1 pixel at the zoom, in Web
 * Mercator world units (as the resize drag of features takes it)
 */
function minAxisExtentOf(context: EngineModeContext): number {
  const zoom = context.map.getZoom?.();
  const tileSize = context.selectionScope.extensions.getTileSize() ?? 512;
  return Number.isFinite(zoom) ? 1 / (tileSize * 2 ** (zoom as number)) : 0;
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
 * @internal
 */
export class BulkNudge {
  #rows: TableSelection | null = null;
  #dx = 0;
  #dy = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #context: EngineModeContext | null = null;

  /** Whether moves are waiting to be written */
  get active(): boolean {
    return this.#rows !== null;
  }

  /**
   * Adds a move of a press of a key (degrees); the moves are written a moment after the last one
   *
   * @returns false when nothing is selected in bulk or the selection cannot be moved
   */
  add(context: EngineModeContext, dx: number, dy: number): boolean {
    const rows = context.store.getSelectedRows();
    const states = featureTablesInternals(context.store.tables)?.states;
    if (!rows || !states) return false;
    if (this.#rows && !this.#rows.equals(rows)) this.flush();
    if (!this.#rows) {
      this.#rows = rows;
      this.#context = context;
      this.#dx = 0;
      this.#dy = 0;
      states.setMoving(rows.handles, BULK_MOVE_SET);
      states.setTransform(BULK_MOVE_SET, null);
    }
    this.#dx += dx;
    this.#dy += dy;
    states.setTranslation(BULK_MOVE_SET, this.#dx, this.#dy);
    context.map.triggerRepaint();
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, BULK_NUDGE_COMMIT_MS);
    return true;
  }

  /** The translation shown so far */
  get offset(): [number, number] {
    return [this.#dx, this.#dy];
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
      if (this.#dx !== 0 || this.#dy !== 0) {
        translateBulkSelection(store, this.#dx, this.#dy, rows);
      }
    } finally {
      const states = featureTablesInternals(store.tables)?.states;
      states?.setMoving(rows.handles, 0);
      states?.setTranslation(BULK_MOVE_SET, 0, 0);
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
    states?.setTranslation(BULK_MOVE_SET, 0, 0);
    context.map.triggerRepaint();
  }
}
