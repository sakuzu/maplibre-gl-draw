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
 * The record of the intermediate writes, for the commit or the abort, is drag/intermediate-writes.ts.
 */

import type { DragNormalizedEvent } from '../../dispatcher/types.js';
import { bulkSelectionLocked } from '../../operations/bulk-selection.js';
import type { HandleType } from '../../shared/config/constants.js';
import type { EngineSignals, EventEmitter } from '../../shared/utils/event-emitter.js';
import { isInteractionBlocked } from '../../store/lock.js';
import type { Feature, SelectionBulk } from '../../store/types.js';
import type { HandleHitResult } from '../../view/ui/handle-test.js';
import { getSelectedFeatureIds } from '../../view/ui/helper.js';
import type { BoundingBoxCoords } from '../../view/ui/selection-ui/index.js';
import type { EngineModeContext } from '../handler.js';
import { BulkMoveDrag, BulkResizeDrag, BulkRotateDrag } from './bulk.js';
import { type AuxiliaryDrag, resolveAuxiliaryDrag } from './drag/auxiliary.js';
import { IntermediateWrites } from './drag/intermediate-writes.js';
import { startMoveDrag } from './drag/move.js';
import {
  bulkDragTargets,
  type DragOperation,
  type DragScope,
  dragTargetsOfHit,
} from './drag/operation.js';
import { startRadiusDrag } from './drag/radius.js';
import { startResizeDrag, startRotateDrag } from './drag/transform.js';
import {
  planVertexDrag,
  startMidpointDrag,
  startVertexDrag,
  type VertexDragPlan,
} from './drag/vertex.js';

/** What a drag grabbed: the features, a vertex or a handle of the selection */
type DragKind = EngineSignals['drag.started']['kind'];

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
   */
  startDrag(
    hitResult: HandleHitResult,
    event: DragNormalizedEvent,
    context: EngineModeContext,
    bbox: BoundingBoxCoords | null,
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
      store.setDragState({ operation: 'auxiliary', ...dragTargetsOfHit(hitResult, []) });
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
    //   - feature locked: the individual lock on that feature (itself / its group / its layer)
    if (selectedFeatures.some((f) => isInteractionBlocked(f, store))) {
      return;
    }

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
      this.announce(hitResult.type, [...selectedIds], context.eventEmitter);
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
    const targets = dragTargetsOfHit(hitResult, selectedIds);
    switch (hitResult.type) {
      case 'move':
        this.begin(startMoveDrag(event, [...selectedIds], store));
        store.setDragState({ operation: 'move', ...targets });
        break;

      case 'resize':
        this.begin(startResizeDrag(event, hitResult.handle!, bbox, selectedFeatures, context.map));
        store.setDragState({ operation: 'resize', ...targets });
        break;

      case 'rotate':
        this.begin(startRotateDrag(event, bbox, selectedFeatures, store, this.scope, targets));
        break;

      case 'vertex':
        this.begin(startVertexDrag(vertexPlan!, context, targets));
        break;

      case 'midpoint':
        // The vertex dragged is the one it adds, after the one of the hit
        this.begin(startMidpointDrag(event, hitResult.featureId!, hitResult.vertexRef!, store));
        store.setDragState({ operation: 'midpoint', ...targets });
        break;

      case 'radius':
        this.begin(startRadiusDrag(hitResult.featureId!, store));
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
   * or a resize by a handle of their frame. Nothing starts while the selection cannot be edited
   * (read-only, the interaction lock, a feature locked)
   *
   * @param bbox The frame of their extent (without its margin)
   * @returns Whether the drag started
   */
  startBulkDrag(
    hitResult: HandleHitResult,
    event: DragNormalizedEvent,
    context: EngineModeContext,
    bbox: BoundingBoxCoords,
  ): boolean {
    const { store } = context;
    this.scope = context.selectionScope;
    const rows = store.getSelectedRows();
    const bulk = store.getSelection().bulk;
    if (!rows || !bulk) return false;
    if (store.isReadOnly() || store.isInteractionLocked() || bulkSelectionLocked(store)) {
      return false;
    }
    if (hitResult.type !== 'move' && hitResult.type !== 'rotate' && hitResult.type !== 'resize') {
      return false;
    }
    if (hitResult.type === 'resize' && !hitResult.handle) return false;
    this.announce(hitResult.type, [], context.eventEmitter, bulk);
    context.map.dragPan.disable();
    this.writes.discard(store);
    if (hitResult.type === 'move') {
      this.begin(new BulkMoveDrag(context, rows, event));
      store.setDragState({ operation: 'move', ...bulkDragTargets(rows) });
    } else if (hitResult.type === 'rotate') {
      this.begin(new BulkRotateDrag(context, rows, event, bbox));
    } else {
      this.begin(new BulkResizeDrag(context, rows, event, hitResult.handle as HandleType, bbox));
    }
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
    // One frame of a drag is one change: the updates of every feature it moves reach the
    // subscribers in a single notification
    store.transact(() => this.operation?.update(event, store, this.writes));
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

      // An operation that writes once at its end writes now (the drags of features selected in
      // bulk, in steps over several tasks): the end of the drag is announced once it has
      // written (paired with drag.started, with the same IDs even when the selection changed
      // during the drag; auxiliary handles are excluded)
      const announce = wasAuxiliary ? null : this.takeEndAnnouncement(false);
      if (this.operation?.end) this.operation.end(store, true, () => announce?.());
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
    // An operation that writes at its end and has not ended writes nothing
    if (store) this.operation?.end?.(store, false);

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
    return this.operation !== null;
  }
}
