// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SelectMode drag handler
 *
 * Decides which kind of drag a handle hit starts and delegates it. Each kind lives in drag/:
 *   - move                     -> drag/move.ts
 *   - resize / rotate          -> drag/transform.ts
 *   - vertex / midpoint        -> drag/vertex.ts
 *   - radius (Circle)          -> drag/radius.ts
 *   - auxiliary handle         -> drag/auxiliary.ts
 * A move, a rotation and a resize, of the features selected or of the ones selected in bulk, and a
 * drag of vertices or of a radius, are shown by a sketch of this client (`draw.sketches`): the
 * Store is not written while they go on, and the values the sketch gives over the features as they
 * are then are written once let go, through the writes of the Store (the rows selected in bulk in steps,
 * `bulk.ts`). A drag cancelled removes its sketch. A sketch that ends by itself (its features
 * deleted, locked, hidden or no longer selected, the document made read-only) stops the drag, which
 * writes nothing.
 * The record of the intermediate writes of the other drags, for the commit or the abort, is
 * drag/intermediate-writes.ts.
 */

import type { SketchEdit } from '../../api/sketches.js';
import type { DragNormalizedEvent } from '../../dispatcher/types.js';
import { TableSelection } from '../../feature-table/selection.js';
import type { HandleType } from '../../shared/config/constants.js';
import { DrawError } from '../../shared/draw-error.js';
import type { EngineSignals, EventEmitter } from '../../shared/utils/event-emitter.js';
import type { SketchController } from '../../sketches/sketch-controller.js';
import { isSelectionEdit } from '../../sketches/sketch-edits.js';
import { editableFeatures } from '../../store/lock.js';
import type { TransformEdit } from '../../store/store.js';
import type { Feature, SelectionBulk } from '../../store/types.js';
import type { HandleHitResult } from '../../view/ui/handle-test.js';
import { getSelectedFeatureIds } from '../../view/ui/helper.js';
import type { BoundingBoxCoords } from '../../view/ui/selection-ui/index.js';
import type { EngineModeContext } from '../handler.js';
import { writeBulkEdit } from './bulk.js';
import { type AuxiliaryDrag, resolveAuxiliaryDrag } from './drag/auxiliary.js';
import { IntermediateWrites } from './drag/intermediate-writes.js';
import { startMoveDrag } from './drag/move.js';
import {
  bulkDragTargets,
  type DragOperation,
  type DragScope,
  dragTargetsOfHit,
  type SketchDrag,
} from './drag/operation.js';
import { startRadiusDrag } from './drag/radius.js';
import { startResizeDrag, startRotateDrag } from './drag/transform.js';
import {
  markMidpointDrag,
  markVertexDrag,
  midpointDragOf,
  planVertexDrag,
  type VertexDragPlan,
  vertexDragOf,
} from './drag/vertex.js';

/** What a drag grabbed: the features, a vertex or a handle of the selection */
type DragKind = EngineSignals['drag.started']['kind'];

/** A drag shown by a sketch of this client */
interface ShownDrag {
  readonly drag: SketchDrag;
  /** The sketches of the instance */
  readonly sketches: SketchController;
  /** The ID of the sketch (null once it ended by itself: the drag does nothing until let go) */
  id: string | null;
}

/**
 * SelectModeDragHandler
 *
 * Responsible for starting, forwarding and ending the drag operations of select mode
 *
 * @internal
 */
export class SelectModeDragHandler {
  /** The running drag operation */
  private operation: DragOperation | null = null;
  /** The running drag shown by a sketch */
  private shown: ShownDrag | null = null;
  /** The intermediate writes of the running drag, committed or aborted when it ends */
  private readonly writes = new IntermediateWrites();
  /**
   * The features announced by drag.started, while drag.ended has not been sent for them
   *
   * drag.ended always follows, with the same IDs, whether the drag is committed or aborted, so
   * a listener that opens a scope on drag.started always closes it.
   */
  private announcedFeatureIds: string[] | null = null;
  /** The features selected in bulk announced by drag.started (their IDs are not listed) */
  private announcedBulk: SelectionBulk | undefined = undefined;
  /** What the announced drag grabbed, and the emitter its end is announced on */
  private announcedKind: DragKind | null = null;
  private announcer: EventEmitter | null = null;
  /**
   * The selection scope of the draw instance the current drag belongs to (the bounding boxes of
   * custom types, the tile size of the map, and the auxiliary handle providers). Set by startDrag
   */
  private scope: DragScope = null;

  /**
   * Start a drag operation
   *
   * @param pressedLocked Whether the press is on a locked feature of the selection, which moves
   *   nothing (the others are moved by a press on them, on the frame or on a handle)
   */
  startDrag(
    hitResult: HandleHitResult,
    event: DragNormalizedEvent,
    context: EngineModeContext,
    bbox: BoundingBoxCoords | null,
    pressedLocked = false,
  ): void {
    const { store } = context;
    this.scope = context.selectionScope;

    // Selection-independent auxiliary handles (getGlobalHandles) have no feature they sit on,
    // so they cannot pass the selection-bound gates (existence of a selection / bbox / feature
    // lock). Instead, the decision is made only from the map-wide suppressions (readOnly /
    // interaction lock). As with auxiliary handles on a selection, if delegation is refused
    // nothing is started (dragPan is not stopped either).
    if (hitResult.type === 'auxiliary' && hitResult.auxiliary?.global) {
      if (store.isReadOnly() || store.isInteractionLocked()) return;

      const globalDrag = resolveAuxiliaryDrag(hitResult, event, this.scope);
      if (!globalDrag) return;

      context.map.dragPan.disable();
      this.writes.discard(store);
      this.operation = globalDrag;
      store.setDragState({ operation: 'auxiliary', ...dragTargetsOfHit(hitResult, [], store) });
      return;
    }

    // Group / layer selections are also resolved to their member features (so that a group is
    // moved / resized / rotated as one).
    const selectedIds = getSelectedFeatureIds(store);
    const selectedFeatures = selectedIds
      .map((id) => store.getFeature(id))
      .filter((f): f is Feature => f !== undefined);

    if (selectedFeatures.length === 0 || !bbox) {
      return;
    }

    // Do not start a drag operation while editing interaction is suppressed
    // (selection is allowed, only operations are forbidden). There are 3 suppression conditions:
    //   - readOnly: writes are no-ops, so move/resize/rotate/vertex are not started
    //   - interaction lock: the all-feature operation suppression the application applies, for
    //     example in a read-only state
    //   - feature locked: the individual lock on that feature (itself / its group / its layer).
    //     A locked feature stays where it is and the others are dragged; nothing starts when all
    //     are locked, or when the press is on a locked one
    const moving = editableFeatures(selectedFeatures, store);
    if (moving.length === 0 || pressedLocked) {
      return;
    }
    const movingIds = moving.map((feature) => feature.id);

    // A vertex drag is planned first: a feature or a vertex that is gone starts nothing
    let vertexPlan: VertexDragPlan | null = null;
    if (hitResult.type === 'vertex') {
      vertexPlan = planVertexDrag(event, hitResult.featureId!, hitResult.vertexRef!, context);
      if (!vertexPlan) return;
    }

    // Core attaches no meaning to auxiliary handles, so first ask the provider whether it
    // accepts the delegation. If it refuses, core starts nothing (dragPan is not stopped either
    // = the same as not having grabbed anything). Because the gates above have been passed,
    // this point is not reached while readOnly / interaction lock / feature lock is in effect.
    let auxiliaryDrag: AuxiliaryDrag | null = null;
    if (hitResult.type === 'auxiliary') {
      auxiliaryDrag = resolveAuxiliaryDrag(hitResult, event, this.scope);
      if (!auxiliaryDrag) return;
    }

    // Announce that the drag has started. Auxiliary handles are excluded: core writes no
    // intermediate updates to the Store and the provider commits through its own transaction, so
    // putting them on the editing scope of drag.started / drag.ended would
    // have the record of the commit transaction swallowed by that scope.
    if (hitResult.type !== 'auxiliary') {
      this.announce(hitResult.type, movingIds, context.eventEmitter);
    }

    // Disable MapLibre's map dragging
    context.map.dragPan.disable();

    // Make sure no record from the previous drag remains (normally emptied by the reset in
    // endDrag)
    this.writes.discard(store);

    // What the drag changes, recorded in its drag state (here and below). Snapping excludes it
    // from its candidates (snapping to itself pulls the cursor back, shifting by the grab offset
    // and making it look like it vibrates); the start of the drag was snapped leaving out the
    // same (SelectMode.getDragTargets)
    const targets = dragTargetsOfHit(hitResult, movingIds, store);
    const target = { featureIds: movingIds };
    switch (hitResult.type) {
      case 'move':
        if (!this.beginSketch(context, startMoveDrag(event, target))) return;
        store.setDragState({ operation: 'move', ...targets });
        break;

      case 'resize': {
        const drag = startResizeDrag(event, hitResult.handle!, bbox, context.map, target);
        if (!this.beginSketch(context, drag)) return;
        store.setDragState({ operation: 'resize', ...targets });
        break;
      }

      case 'rotate': {
        const drag = startRotateDrag(
          event,
          bbox,
          selectedFeatures,
          moving,
          store,
          this.scope,
          target,
        );
        if (!this.beginSketch(context, drag)) return;
        store.setDragState({ operation: 'rotate', ...targets, rotateInfo: drag.rotateInfo });
        break;
      }

      case 'vertex':
        if (!this.beginSketch(context, vertexDragOf(vertexPlan!, context))) return;
        markVertexDrag(vertexPlan!, context, targets);
        break;

      case 'midpoint': {
        // The vertex dragged is the one it adds, after the one of the hit: its drag state records
        // it once the sketch shows it (the edge of the hit is split into the edges of the vertex)
        const featureId = hitResult.featureId!;
        const after = hitResult.vertexRef!;
        if (!this.beginSketch(context, midpointDragOf(event, featureId, after))) return;
        markMidpointDrag(context, featureId, after);
        break;
      }

      case 'radius':
        if (!this.beginSketch(context, startRadiusDrag(hitResult.featureId!, store))) return;
        store.setDragState({ operation: 'radius', ...targets });
        break;

      case 'auxiliary':
        // Delegation is already done above (we only get here when it was accepted)
        this.begin(auxiliaryDrag);
        store.setDragState({ operation: 'auxiliary', ...targets });
        break;
    }
  }

  /**
   * Start a drag of the features selected in bulk: a move by a press on one of them, a rotation
   * or a resize by a handle of their frame. Nothing starts without rows to drag
   *
   * @param bbox The frame of their extent (without its margin)
   * @param rows The rows the drag moves (`movableBulkRows`; none on a press on a locked one)
   * @returns Whether the drag started
   */
  startBulkDrag(
    hitResult: HandleHitResult,
    event: DragNormalizedEvent,
    context: EngineModeContext,
    bbox: BoundingBoxCoords,
    rows: TableSelection,
  ): boolean {
    const { store } = context;
    this.scope = context.selectionScope;
    const bulk = store.getSelection().bulk;
    if (!bulk || rows.count === 0) return false;
    if (hitResult.type !== 'move' && hitResult.type !== 'rotate' && hitResult.type !== 'resize') {
      return false;
    }
    if (hitResult.type === 'resize' && !hitResult.handle) return false;
    this.announce(hitResult.type, [], context.eventEmitter, bulk);
    context.map.dragPan.disable();
    this.writes.discard(store);
    const target = { selection: true } as const;
    const targets = bulkDragTargets(rows);
    if (hitResult.type === 'move') {
      if (!this.beginSketch(context, startMoveDrag(event, target))) return false;
      store.setDragState({ operation: 'move', ...targets });
    } else if (hitResult.type === 'rotate') {
      const drag = startRotateDrag(event, bbox, [], [], store, this.scope, target);
      if (!this.beginSketch(context, drag)) return false;
      store.setDragState({ operation: 'rotate', ...targets, rotateInfo: drag.rotateInfo });
    } else {
      const drag = startResizeDrag(
        event,
        hitResult.handle as HandleType,
        bbox,
        context.map,
        target,
      );
      if (!this.beginSketch(context, drag)) return false;
      store.setDragState({ operation: 'resize', ...targets });
    }
    return true;
  }

  /**
   * Makes a drag shown by a sketch the running one, its sketch added with the edit of a pointer
   * that has not moved. A sketch refused (what it edits cannot be written) starts nothing: what
   * was announced ends cancelled
   *
   * @returns Whether the drag started
   */
  private beginSketch(context: EngineModeContext, drag: SketchDrag | null): boolean {
    const { store, sketches } = context;
    // A write of a drag let go before, still under way, is made first (its rows leave the moving
    // set it shares, which is let go of with the last of them: the rows enter it still)
    store.finishSlicedWrite();
    const sketch = drag && addSketch(sketches, drag.start);
    if (!drag || !sketch) {
      context.map.dragPan.enable();
      this.announceEnd(true);
      return false;
    }
    sketches.setDragged(sketch, drag.selected);
    this.shown = { drag, sketches, id: sketch };
    return true;
  }

  /**
   * Make a started operation the running one. An operation that could not start (its feature
   * or vertex is gone) leaves the handler as it was
   */
  private begin(operation: DragOperation | null): void {
    if (operation) this.operation = operation;
  }

  /**
   * Update during a drag
   * Note: re-rendering is triggered automatically by RenderCoordinator subscribing to Store
   * changes
   */
  updateDrag(event: DragNormalizedEvent, context: EngineModeContext): void {
    const { store } = context;
    const shown = this.shown;
    if (shown) {
      if (!this.sketchGoesOn()) return;
      const edits = shown.drag.editsAt(event);
      if (shown.sketches.setDragEdits(shown.id as string, edits)) shown.drag.shown?.(edits, store);
      return;
    }
    // One frame of a drag is one change: the updates of every feature it moves reach the
    // subscribers in a single notification
    store.transact(() => this.operation?.update(event, store, this.writes));
  }

  /**
   * Whether the sketch of the drag running goes on. One that ended by itself stops the drag: its
   * end is announced as cancelled, and it does nothing until it is let go
   */
  private sketchGoesOn(): boolean {
    const shown = this.shown;
    if (shown?.id == null) return false;
    if (shown.sketches.has(shown.id)) return true;
    shown.id = null;
    this.announceEnd(true);
    return false;
  }

  /**
   * End the drag operation
   *
   * @param event The drag end event (passed to the auxiliary handle's delegate. When omitted,
   *   the last move / start event that was forwarded is used)
   */
  endDrag(context: EngineModeContext, event?: DragNormalizedEvent): void {
    const { store } = context;
    const wasAuxiliary = this.operation?.type === 'auxiliary';

    // The drag always ends: whatever the delegate, the commit or a plugin throws, map dragging
    // is re-enabled and the drag state is cleared, so that the UI never stays stuck in a drag.
    try {
      // Tell a delegate that the drag has ended (for an auxiliary handle core has written
      // nothing to the Store)
      this.operation?.finish?.(event);
      // Commit the intermediate updates made during the drag in a single transaction before
      // announcing drag.ended (listeners see the state after the commit). If no feature was
      // touched, do nothing.
      this.writes.commit(store);

      // The sketch of the drag is written now (the features selected in bulk in steps over
      // several tasks): the end of the drag is announced once it is written (paired with
      // drag.started, with the same IDs even when the selection changed during the drag;
      // auxiliary handles are excluded)
      const goesOn = this.sketchGoesOn();
      const announce = wasAuxiliary ? null : this.takeEndAnnouncement(false);
      if (goesOn) this.writeSketch(context, () => announce?.());
      else announce?.();
    } finally {
      // Re-enable MapLibre's map dragging
      context.map.dragPan.enable();
      // Clear the drag state
      store.setDragState(null);
      this.reset(store);
    }
  }

  /**
   * Writes the sketch of a drag let go, and ends it with the write: the values it gives over the
   * features as they are now, in one transaction (the vertices it edits as a write of those
   * vertices), or the rows selected in bulk in steps. A sketch that moves nothing, or whose edits
   * give a feature what it cannot have, is removed, nothing written. `done` is called once it is
   * written
   */
  private writeSketch(context: EngineModeContext, done: () => void): void {
    const { store } = context;
    const { drag, sketches, id } = this.shown as ShownDrag & { id: string };
    (this.shown as ShownDrag).id = null;
    const edits = sketches.get(id)?.edits;
    if (!edits || drag.movesNothing(edits)) {
      sketches.remove(id);
      done();
      return;
    }
    const [edit] = edits;
    if (isSelectionEdit(edit)) {
      // The end of the drag is announced after the end of the sketch, written at once or not
      let committing = true;
      let written = false;
      sketches.commitWith(
        id,
        (rows) => {
          writeBulkEdit(context, rows ?? TableSelection.empty, edit as TransformEdit, () => {
            if (committing) written = true;
            else done();
          });
        },
        true,
      );
      committing = false;
      if (written) done();
      return;
    }
    let updates: ReturnType<SketchController['updatesOf']>;
    try {
      updates = sketches.updatesOf(id);
    } catch (error) {
      if (!(error instanceof DrawError) || error.code !== 'invalid-input') throw error;
      sketches.remove(id);
      done();
      return;
    }
    sketches.commitWith(id, () =>
      store.transact(() => {
        for (const update of updates) store.updateFeature(update.id, update.updates);
      }),
    );
    done();
  }

  /**
   * Reset the state
   *
   * @param store When passed, the highlight of the following vertices (UI state) is cleared as
   *   well. The cleanup is the same whether the drag was committed or aborted.
   */
  reset(store?: EngineModeContext['store']): void {
    // Even on an abort (mode switch / a change from outside), end is delivered to the delegate
    // exactly once. When coming through endDrag it has already been delivered, so nothing
    // happens here.
    this.operation?.finish?.();
    // The sketch of a drag that did not end is removed, nothing written
    const shown = this.shown;
    if (shown) {
      if (shown.id !== null && shown.sketches.has(shown.id)) shown.sketches.remove(shown.id);
      shown.sketches.setDragged(null);
    }

    this.shown = null;
    this.operation = null;
    this.writes.discard(store);
    store?.setFollowedVertices?.(null);
    // An aborted drag still closes what drag.started opened (after the features are restored)
    this.announceEnd(true);
  }

  /**
   * Sends the drag.ended that pairs with the drag.started of the current drag, once
   */
  private announceEnd(cancelled: boolean): void {
    this.takeEndAnnouncement(cancelled)?.();
  }

  /**
   * Takes the drag.ended that pairs with the drag.started of the current drag, to send later
   * (null when there is none to send)
   */
  private takeEndAnnouncement(cancelled: boolean): (() => void) | null {
    const featureIds = this.announcedFeatureIds;
    const kind = this.announcedKind;
    const announcer = this.announcer;
    const bulk = this.announcedBulk;
    this.announcedFeatureIds = null;
    this.announcedKind = null;
    this.announcer = null;
    this.announcedBulk = undefined;
    if (!featureIds || !kind) return null;
    return () =>
      announcer?.emit('drag.ended', {
        kind,
        featureIds: [...featureIds],
        ...(bulk && { bulk }),
        cancelled,
      });
  }

  /**
   * Announces the start of a drag on the emitter of the instance; its end is announced with
   * the same IDs, committed or cancelled
   */
  private announce(
    type: HandleHitResult['type'],
    featureIds: string[],
    emitter: EventEmitter | undefined,
    bulk?: SelectionBulk,
  ): void {
    const kind: DragKind =
      type === 'move' ? 'feature' : type === 'vertex' || type === 'midpoint' ? 'vertex' : 'handle';
    this.announcedFeatureIds = [...featureIds];
    this.announcedKind = kind;
    this.announcer = emitter ?? null;
    this.announcedBulk = bulk;
    emitter?.emit('drag.started', { kind, featureIds: [...featureIds], ...(bulk && { bulk }) });
  }

  /**
   * Whether a drag operation is active
   */
  isActive(): boolean {
    return this.operation !== null || this.shown !== null;
  }
}

/**
 * Adds the sketch of a drag, of the edits of a pointer that has not moved
 *
 * @returns Its ID, or null when it is refused (what it edits cannot be written, or cannot take the
 *   edit)
 */
function addSketch(sketches: SketchController, edits: readonly SketchEdit[]): string | null {
  try {
    return sketches.add({ edits })?.id ?? null;
  } catch (error) {
    if (!(error instanceof DrawError) || error.code !== 'invalid-input') throw error;
    return null;
  }
}
