// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SelectMode
 *
 * Select mode. Performs selection, moving, resizing, rotating, vertex editing and deletion of
 * features. Additional operations (text editing, etc.) are delegated through the interaction
 * hooks of plugins.
 *
 * The handling of each event is spread across a set of handlers:
 *   - click / dblclick      -> click-handler.ts
 *   - cursor control        -> cursor-handler.ts
 *   - drag operations       -> drag-handler.ts (SelectModeDragHandler)
 *   - box selection         -> box-selection.ts (queryFeaturesInBox)
 *   - keyboard              -> shortcut-handler.ts
 *   - hit testing helpers   -> hit-helpers.ts
 */

import type {
  DragNormalizedEvent,
  KeyNormalizedEvent,
  MouseNormalizedEvent,
} from '../../dispatcher/types.js';
import { rowsByLayerInOrder } from '../../feature-table/bulk-rows.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import { TableSelection } from '../../feature-table/selection.js';
import { DEFAULT_SELECTION_CONFIG, type SelectionUIConfig } from '../../shared/config/selection.js';
import { createCoordinateTransform } from '../../shared/math/index.js';
import { getDisplayFeatures } from '../../store/local-visibility.js';
import type { BoxSelection, Coordinate, Mode, Selection } from '../../store/types.js';
import { computeCombinedGeoBoundingBox, isPointInGeoBoundingBox } from '../../view/ui/bounds.js';
import type { HandleHitResult } from '../../view/ui/handle-test.js';
import {
  bulkFrame,
  hitTestBulkHandles,
  hitTestGlobalAuxiliaryHandles,
  hitTestHandles,
} from '../../view/ui/handle-test.js';
import {
  computeSelectionBoundingBox,
  getSelectedFeatureIds,
  getSelectedFeatures,
} from '../../view/ui/helper.js';
import type { EngineModeContext, EngineModeHandler, SnapInputKind } from '../handler.js';
import { queryFeaturesInBox } from './box-selection.js';
import { BulkNudge, queryRowsInBox } from './bulk.js';
import { handleSelectClick, handleSelectDoubleClick } from './click-handler.js';
import { updateCursorForSelection } from './cursor-handler.js';
import { SelectModeDragHandler } from './drag-handler.js';
import {
  getAdditionalResizeHandlesCallback,
  getAuxiliaryHandlesCallback,
  getGlobalAuxiliaryHandlesCallback,
} from './hit-helpers.js';
import {
  handleDeleteShortcut,
  handleEscapeShortcut,
  handleGroupShortcut,
  handleNudgeShortcut,
  handleUngroupShortcut,
} from './shortcut-handler.js';

/**
 * Whether the selection is a feature selection of exactly these IDs, in this order
 */
function selectsExactly(selection: Selection, ids: readonly string[]): boolean {
  if (ids.length === 0) return selection.type === null && selection.ids.length === 0;
  return (
    selection.type === 'feature' &&
    selection.ids.length === ids.length &&
    selection.ids.every((id, i) => id === ids[i])
  );
}

/** @internal */
export class SelectMode implements EngineModeHandler {
  readonly modeName: Mode = 'select';

  #context!: EngineModeContext;
  #dragHandler = new SelectModeDragHandler();
  /** The rows of a Store of rows marked as in the box being drawn */
  #boxMarked: TableSelection = TableSelection.empty;
  /** The moves of the arrow keys over features selected in bulk, waiting to be written */
  readonly #nudge = new BulkNudge();
  #config: SelectionUIConfig = DEFAULT_SELECTION_CONFIG;

  // ============================================================================
  // Lifecycle
  // ============================================================================

  onStart(context: EngineModeContext): void {
    this.#context = context;
    context.map.getCanvas().style.cursor = 'default';

    // If there are features awaiting editing, notify plugins and clear the editing state
    const editingIds = context.store.getEditingIds();
    if (editingIds.length > 0) {
      for (const id of editingIds) {
        const feature = context.store.getFeature(id);
        if (feature) {
          context.plugins?.notifyFeatureCreated(feature.id);
        }
      }
      context.store.endEditing([...editingIds]);
    }
  }

  onStop(): void {
    const { store, map, plugins } = this.#context;

    plugins?.finishPluginInteraction();
    this.#dragHandler.reset(store);
    this.#nudge.flush();

    this.#markBox(TableSelection.empty);
    if (store.getBoxSelection()) store.setBoxSelection(null);
    if (store.getVertexSelection()) store.setSelectedVertices(null);
    if (!map.dragPan.isEnabled()) map.dragPan.enable();

    // Clear the selection when switching modes (not notified as a change)
    store.transact(() => {
      store.setSelection(null, []);
    }, 'silent');
  }

  /**
   * Snapping applies only while a vertex or a feature is dragged: a click or a hover in
   * select is not snapped (and draws no indicator). A mode of the contract that wants the
   * snapped position of a point asks `snap` of its ModeContext.
   */
  isSnapEnabledFor(inputType: SnapInputKind): boolean {
    return inputType === 'dragstart' || inputType === 'dragmove' || inputType === 'dragend';
  }

  /**
   * Called after a state change from the outside (a change applied from outside the mode).
   * Resets the mode's internal state to keep it consistent.
   */
  onExternalStateChange(): void {
    const { store } = this.#context;
    this.#dragHandler.reset(store);

    // The selection and the vertex selection follow the change by themselves (the Store
    // drops what was deleted or hidden and the vertices whose coordinates changed)
    if (store.getDragState()) store.setDragState(null);
    this.#nudge.cancel();
    this.#markBox(TableSelection.empty);
    if (store.getBoxSelection()) store.setBoxSelection(null);
  }

  // ============================================================================
  // Mouse: down / up
  // ============================================================================

  /**
   * Disable dragPan when a handle or a feature is hit on mouse down.
   * @returns true when there was a hit (the event is consumed)
   */
  onMouseDown(event: MouseNormalizedEvent): boolean {
    const { plugins, map, store } = this.#context;

    // During a plugin interaction: consume clicks inside the container
    if (plugins?.isPluginInteracting()) {
      const container = plugins.getPluginInteractionContainer();
      if (container) {
        const target = event.originalEvent.target as HTMLElement;
        if (container.contains(target)) return true;
      }
    }

    // Shift+drag = start of a box selection: return false to avoid stopPropagation
    if (event.modifiers.shift) {
      map.dragPan.disable();
      return false;
    }

    // While the interaction lock is on, dragPan is not disabled even on a
    // handle / feature hit, and the drag is passed straight through to the map pan. While
    // locked, moving / resizing / rotating / vertex editing are forbidden (drag-handler does not
    // start them because of isInteractionBlocked), so this prevents the defect where dragging
    // from on top of a feature kills the pan alone. Returning true here would make InputRouter
    // call preventDefault and stop MapLibre's pan along with it, so false is always returned to
    // let the event pass through. Selection by click is handled separately by
    // onClick, so it is unaffected. Shift box selection is already handled above.
    if (store.isInteractionLocked()) return false;

    // The moves of the arrow keys waiting are written before anything else is grabbed
    this.#nudge.flush();

    const orderedFeatures = getDisplayFeatures(store);
    const selectedFeatures = getSelectedFeatures(store);
    const transform = createCoordinateTransform(map);

    // Features selected in bulk: the handles of their frame and its inside
    const bulk = store.getSelection().bulk;
    if (
      bulk &&
      hitTestBulkHandles(
        event.point,
        bulk,
        transform,
        this.#config,
        map.getZoom(),
        this.#context.selectionScope,
      )
    ) {
      map.dragPan.disable();
      return true;
    }

    // Test against the handles of the selected features / inside their bbox
    if (selectedFeatures.length > 0) {
      const bbox = computeSelectionBoundingBox(
        selectedFeatures,
        this.#context.selectionScope.extensions,
      );

      if (bbox) {
        const zoom = map.getZoom();
        const getAdditionalHandles = getAdditionalResizeHandlesCallback(
          selectedFeatures,
          this.#context.selectionScope,
        );
        const getAuxiliaryHandles = getAuxiliaryHandlesCallback(
          selectedFeatures,
          this.#context.selectionScope,
        );
        const handleHit = hitTestHandles(
          event.point,
          selectedFeatures,
          transform,
          this.#config,
          zoom,
          this.#context.selectionScope,
          getAdditionalHandles,
          getAuxiliaryHandles,
        );
        if (handleHit) {
          map.dragPan.disable();
          return true;
        }
      }

      const geoBbox = computeCombinedGeoBoundingBox(
        selectedFeatures,
        transform,
        this.#config,
        this.#context.selectionScope.extensions,
      );
      if (geoBbox) {
        const geoLngLat = transform.unproject(event.point);
        const geoPoint: Coordinate = [geoLngLat.lng, geoLngLat.lat];
        if (isPointInGeoBoundingBox(geoPoint, geoBbox)) {
          map.dragPan.disable();
          return true;
        }
      }
    }

    // Selection-independent auxiliary handles (an extension implementation's focus, etc.). They
    // appear even when the selection is empty, so they are taken after the selection handle test
    // and before the feature hit test. They cannot be grabbed while readOnly (this prevents
    // dragPan alone from dying even though no drag starts).
    if (!store.isReadOnly()) {
      const globalHit = hitTestGlobalAuxiliaryHandles(
        event.point,
        transform,
        this.#config,
        map.getZoom(),
        getGlobalAuxiliaryHandlesCallback(this.#context.selectionScope),
      );
      if (globalHit) {
        map.dragPan.disable();
        return true;
      }
    }

    // Feature hit test (unified z traversal)
    // Nothing is grabbed when a dataset is in the foreground. dragPan is also
    // left alive so that the map can be panned even from on top of the data. A row held as
    // columns stops the pan as a feature does, locked or not (nothing is made of it here)
    const top = this.#context.hitTestTopmost(event.point, { orderedFeatures });
    if (top?.kind === 'store' || top?.kind === 'row') {
      map.dragPan.disable();
      return true;
    }
    return false;
  }

  onMouseUp(): void {
    if (!this.#dragHandler.isActive()) {
      this.#context.map.dragPan.enable();
    }
  }

  // ============================================================================
  // Click / DoubleClick
  // ============================================================================

  onClick(event: MouseNormalizedEvent): void {
    if (this.#dragHandler.isActive()) return;
    handleSelectClick(event, this.#context, this.#config);
  }

  onDoubleClick(event: MouseNormalizedEvent): void {
    handleSelectDoubleClick(event, this.#context);
  }

  // ============================================================================
  // Drag
  // ============================================================================

  onDragStart(event: DragNormalizedEvent): void {
    if (this.#context.plugins?.isPluginInteracting()) return;

    const { store, map } = this.#context;
    this.#nudge.flush();
    const selection = store.getSelection();
    // Group / layer selections are also resolved to their members (so dragging the selection box
    // moves a group as one). Features selected in bulk are not listed (their rows are dragged)
    const selectedIds = getSelectedFeatureIds(store);
    const transform = createCoordinateTransform(map);
    const dragStartPoint = event.dragStartPoint ?? event.point;

    // Shift+drag = box selection
    if (event.modifiers.shift) {
      const geoLngLat = map.unproject([dragStartPoint.x, dragStartPoint.y]);
      const startPoint: Coordinate = [geoLngLat.lng, geoLngLat.lat];
      store.setBoxSelection({
        startPoint,
        endPoint: startPoint,
        previousSelection: [...selectedIds],
        // Features selected in bulk are put back from the selection itself on a cancel, and are
        // let go of while the box marks its rows (the marks are the box's)
        ...(selection.bulk && { previous: selection }),
      });
      if (selection.bulk) store.setSelection(null, []);
      map.dragPan.disable();
      map.triggerRepaint();
      return;
    }

    // While the interaction lock is on, the drag is passed straight through to
    // the map pan. Neither the selection is changed nor a drag operation started (paired with
    // onMouseDown not disabling dragPan; starting a move selection here would select a feature
    // during a pan). Shift box selection is already handled above, so it is preserved.
    if (store.isInteractionLocked()) return;

    // Features selected in bulk: a handle of their frame, or a press on one of them, drags them
    // all (the selection is not narrowed to the one pressed)
    if (selection.bulk && this.#dragBulk(event, dragStartPoint, transform)) return;

    // A handle hit on the selected features -> start the corresponding drag operation
    if (selectedIds.length > 0) {
      const selectedFeatures = getSelectedFeatures(store);
      if (selectedFeatures.length > 0) {
        const bbox = computeSelectionBoundingBox(
          selectedFeatures,
          this.#context.selectionScope.extensions,
        );
        if (bbox) {
          const zoom = map.getZoom();
          const getAdditionalHandles = getAdditionalResizeHandlesCallback(
            selectedFeatures,
            this.#context.selectionScope,
          );
          const getAuxiliaryHandles = getAuxiliaryHandlesCallback(
            selectedFeatures,
            this.#context.selectionScope,
          );
          const handleHit = hitTestHandles(
            dragStartPoint,
            selectedFeatures,
            transform,
            this.#config,
            zoom,
            this.#context.selectionScope,
            getAdditionalHandles,
            getAuxiliaryHandles,
          );
          if (handleHit) {
            this.#dragHandler.startDrag(handleHit, event, this.#context, bbox);
            return;
          }
        }
      }
    }

    // Selection-independent auxiliary handles (an extension implementation's focus, etc.). When
    // no selection handle was hit, they are taken before grabbing a feature. Whether delegation
    // is accepted and the readOnly test are decided by drag-handler.
    const globalHit = hitTestGlobalAuxiliaryHandles(
      dragStartPoint,
      transform,
      this.#config,
      map.getZoom(),
      getGlobalAuxiliaryHandlesCallback(this.#context.selectionScope),
    );
    if (globalHit) {
      this.#dragHandler.startDrag(globalHit, event, this.#context, null);
      return;
    }

    // When no handle was hit: select the feature -> move operation
    // When a dataset is in the foreground, nothing is grabbed and no drag is
    // started (dragPan is alive, so it becomes a map pan).
    const orderedFeatures = getDisplayFeatures(store);
    // A row held as columns is made a feature to drag it
    const top = this.#context.hitTestTopmost(dragStartPoint, { orderedFeatures, hold: true });
    if (top?.kind !== 'store') return;
    const hitFeatureId = top.feature.id;

    if (!selectedIds.includes(hitFeatureId)) {
      const filtered = this.#context.plugins?.filterSelectionCandidates([hitFeatureId]) ?? [
        hitFeatureId,
      ];
      if (filtered.length === 0) return;
      store.setSelection('feature', filtered);
    }

    const newSelectedFeatures = getSelectedFeatures(store);
    const bbox = computeSelectionBoundingBox(
      newSelectedFeatures,
      this.#context.selectionScope.extensions,
    );
    const moveHit: HandleHitResult = { type: 'move' };
    this.#dragHandler.startDrag(moveHit, event, this.#context, bbox);
  }

  onDragMove(event: DragNormalizedEvent): void {
    const { store, map, plugins } = this.#context;
    const boxSelection = store.getBoxSelection();

    // Update the box selection
    if (boxSelection) {
      const geoLngLat = map.unproject([event.point.x, event.point.y]);
      const endPoint: Coordinate = [geoLngLat.lng, geoLngLat.lat];
      const updatedBoxSelection: BoxSelection = { ...boxSelection, endPoint };
      store.setBoxSelection(updatedBoxSelection);

      // A Store of rows marks the rows in the box instead of selecting them while the box is
      // drawn: they are held as features, or selected in bulk, only when it is let go
      if (store.tables) {
        this.#markBox(queryRowsInBox(updatedBoxSelection, this.#context));
        return;
      }

      // Live selection preview (a frame that selects the same features changes nothing)
      const hitIds = queryFeaturesInBox(updatedBoxSelection, this.#context);
      const filtered =
        hitIds.length > 0 ? (plugins?.filterSelectionCandidates(hitIds) ?? hitIds) : hitIds;
      if (!selectsExactly(store.getSelection(), filtered)) {
        if (filtered.length === 0) {
          store.setSelection(null, []);
        } else {
          store.setSelection('feature', filtered);
        }
      }
      return;
    }

    if (this.#dragHandler.isActive()) {
      this.#dragHandler.updateDrag(event, this.#context);
    }
  }

  /**
   * Marks the rows of a Store of rows in the box being drawn (and unmarks the ones no longer in
   * it): they show as selected without being held as features
   */
  #markBox(rows: TableSelection): void {
    const { store } = this.#context;
    const states = featureTablesInternals(store.tables)?.states;
    if (!states || !store.tables) return;
    const before = this.#boxMarked;
    if (before.equals(rows)) return;
    const dropped = before.handles.filter((handle) => !rows.has(handle));
    const added = rows.handles.filter((handle) => !before.has(handle));
    if (dropped.length > 0) states.setBulk(dropped, false);
    if (added.length > 0) states.setBulk(added, true);
    this.#boxMarked = rows;
    this.#context.map.triggerRepaint();
  }

  /**
   * Starts a drag of the features selected in bulk: by a handle of their frame, or by a press on
   * one of them (taken whether the drag starts or not: the selection is not narrowed to it)
   *
   * @returns Whether the press was on their handles or on one of them
   */
  #dragBulk(
    event: DragNormalizedEvent,
    point: { x: number; y: number },
    transform: ReturnType<typeof createCoordinateTransform>,
  ): boolean {
    const { store, map } = this.#context;
    const bulk = store.getSelection().bulk;
    const rows = store.getSelectedRows();
    if (!bulk?.bounds || !rows) return false;
    const frame = bulkFrame(bulk.bounds);
    const hit = hitTestBulkHandles(
      point,
      bulk,
      transform,
      this.#config,
      map.getZoom(),
      this.#context.selectionScope,
    );
    if (hit && hit.type !== 'move') {
      this.#dragHandler.startBulkDrag(hit, event, this.#context, frame);
      return true;
    }
    // A press on one of them (not made a feature)
    const top = this.#context.hitTestTopmost(point, { orderedFeatures: getDisplayFeatures(store) });
    const handle =
      top?.kind === 'row'
        ? top.handle
        : top?.kind === 'store'
          ? store.tables?.findRow(top.feature.id)
          : undefined;
    if (handle === undefined || !rows.has(handle)) return false;
    this.#dragHandler.startBulkDrag({ type: 'move' }, event, this.#context, frame);
    return true;
  }

  onDragEnd(event: DragNormalizedEvent): void {
    const { store, map, plugins } = this.#context;
    const boxSelection = store.getBoxSelection();

    // Commit the box selection
    if (boxSelection) {
      this.#markBox(TableSelection.empty);
      const internals = featureTablesInternals(store.tables);
      if (internals) {
        // A Store of rows: more rows than are opened at once are selected in bulk
        const rows = queryRowsInBox(boxSelection, this.#context);
        if (rows.count > store.holdLimit) {
          store.selectRows(rows);
        } else {
          const ids: string[] = [];
          for (const handles of rowsByLayerInOrder(internals, rows).values()) {
            for (const handle of handles) ids.push(internals.ids.idOf(handle) as string);
          }
          const filtered = ids.length > 0 ? (plugins?.filterSelectionCandidates(ids) ?? ids) : ids;
          store.setSelection(filtered.length > 0 ? 'feature' : null, filtered);
        }
      } else {
        const hitIds = queryFeaturesInBox(boxSelection, this.#context);
        const filtered =
          hitIds.length > 0 ? (plugins?.filterSelectionCandidates(hitIds) ?? hitIds) : hitIds;
        if (filtered.length === 0) {
          store.setSelection(null, []);
        } else {
          store.setSelection('feature', filtered);
        }
      }
      store.setBoxSelection(null);
      map.dragPan.enable();
      return;
    }

    if (this.#dragHandler.isActive()) {
      this.#dragHandler.endDrag(this.#context, event);
    }
  }

  /**
   * The press ended without a release (a second finger, or the browser cancelled the touch)
   *
   * Nothing is committed: a box selection returns to the selection it started from, a drag
   * operation is abandoned, and the pan goes back to MapLibre (which also covers a press that
   * disabled it in onMouseDown and never became a drag).
   */
  onDragCancel(): void {
    const { store, map } = this.#context;

    const boxSelection = store.getBoxSelection();
    if (boxSelection) {
      this.#markBox(TableSelection.empty);
      if (boxSelection.previous) {
        store.restoreSelection(boxSelection.previous);
      } else if (boxSelection.previousSelection.length === 0) {
        store.setSelection(null, []);
      } else {
        store.setSelection('feature', [...boxSelection.previousSelection]);
      }
      store.setBoxSelection(null);
    }

    if (this.#dragHandler.isActive()) {
      this.#dragHandler.reset(store);
    }
    if (store.getDragState()) store.setDragState(null);
    if (!map.dragPan.isEnabled()) map.dragPan.enable();
  }

  // ============================================================================
  // Keyboard / MouseMove
  // ============================================================================

  onKeyDown(event: KeyNormalizedEvent): void {
    const { plugins, store } = this.#context;

    // Skip destructive key operations during a plugin interaction
    if (plugins?.isPluginInteracting()) {
      if (event.key === 'Escape') {
        plugins.cancelPluginInteraction();
      }
      return;
    }

    // Escape during a drag cancels the drag (the InputNormalizer already turns a real
    // Escape into dragcancel; this covers synthetic input)
    if (event.key === 'Escape' && (this.#dragHandler.isActive() || store.getBoxSelection())) {
      this.onDragCancel();
      return;
    }

    // Arrow keys: move the selection by a few pixels. A used key is not also a map pan
    if (handleNudgeShortcut(this.#context, event.key, event.modifiers, this.#nudge)) {
      event.originalEvent.preventDefault();
      return;
    }
    // Another key: the moves of the arrow keys waiting are written first
    this.#nudge.flush();

    const isMetaOrCtrl = event.modifiers.meta || event.modifiers.ctrl;

    // Cmd+G / Ctrl+G: group
    if (event.key.toLowerCase() === 'g' && isMetaOrCtrl && !event.modifiers.shift) {
      event.originalEvent.preventDefault();
      handleGroupShortcut(this.#context);
      return;
    }
    // Shift+Cmd+G / Shift+Ctrl+G: ungroup
    if (event.key.toLowerCase() === 'g' && isMetaOrCtrl && event.modifiers.shift) {
      event.originalEvent.preventDefault();
      handleUngroupShortcut(this.#context);
      return;
    }
    // Delete / Backspace: delete the selection
    if (event.key === 'Delete' || event.key === 'Backspace') {
      handleDeleteShortcut(this.#context);
      return;
    }
    // Escape: cancel the box selection / clear the selection
    if (event.key === 'Escape') {
      handleEscapeShortcut(this.#context);
    }
  }

  onMouseMove(event: MouseNormalizedEvent): void {
    if (this.#dragHandler.isActive() || this.#context.plugins?.isPluginInteracting()) {
      return;
    }
    updateCursorForSelection(event, this.#context, this.#config);
  }
}
