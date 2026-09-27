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
import type { EventEmitter, EventMap } from '../../shared/utils/event-emitter.js';
import { isInteractionBlocked } from '../../store/lock.js';
import type { Feature } from '../../store/types.js';
import type { HandleHitResult } from '../../view/ui/handle-test.js';
import { getSelectedFeatureIds } from '../../view/ui/helper.js';
import type { BoundingBoxCoords } from '../../view/ui/selection-ui/index.js';
import type { ModeContext } from '../handler.js';
import { type AuxiliaryDrag, resolveAuxiliaryDrag } from './drag/auxiliary.js';
import { IntermediateWrites } from './drag/intermediate-writes.js';
import { startMoveDrag } from './drag/move.js';
import type { DragOperation, DragScope } from './drag/operation.js';
import { startRadiusDrag } from './drag/radius.js';
import { startResizeDrag, startRotateDrag } from './drag/transform.js';
import { startMidpointDrag, startVertexDrag } from './drag/vertex.js';

/** What a drag grabbed: the features, a vertex or a handle of the selection */
type DragKind = EventMap['drag.started']['kind'];

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
   * The features announced by drag:start, while drag:end has not been sent for them
   *
   * drag:end always follows, with the same IDs, whether the drag is committed or aborted, so a
   * plugin that opens a scope on drag:start always closes it.
   */
  private hookedFeatureIds: string[] | null = null;
  private hookPluginManager: ModeContext['pluginManager'] | null = null;
  /** What the announced drag grabbed, and the emitter its end is announced on */
  private announcedKind: DragKind | null = null;
  private announcer: EventEmitter | null = null;
  /**
   * The selection scope of the draw instance the current drag belongs to (the resize and
   * rotate strategies of custom types, and the auxiliary handle providers). Set by startDrag
   */
  private scope: DragScope = null;

  /**
   * Start a drag operation
   */
  startDrag(
    hitResult: HandleHitResult,
    event: DragNormalizedEvent,
    context: ModeContext,
    bbox: BoundingBoxCoords | null,
  ): void {
    const { store, pluginManager } = context;
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
      store.setDragState({ operation: 'auxiliary' });
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

    // Core attaches no meaning to auxiliary handles, so first ask the provider whether it
    // accepts the delegation. If it refuses, core starts nothing (dragPan is not stopped either
    // = the same as not having grabbed anything). Because the gates above have been passed,
    // this point is not reached while readOnly / interaction lock / feature lock is in effect.
    let auxiliaryDrag: AuxiliaryDrag | null = null;
    if (hitResult.type === 'auxiliary') {
      auxiliaryDrag = resolveAuxiliaryDrag(hitResult, event, this.scope);
      if (!auxiliaryDrag) return;
    }

    // Notify plugins that the drag has started. Auxiliary handles are excluded: core writes no
    // intermediate updates to the Store and the provider commits through its own transaction, so
    // putting them on the editing scope of drag:start / drag:end would
    // have the record of the commit transaction swallowed by that scope.
    if (hitResult.type !== 'auxiliary') {
      pluginManager?.runHook('drag:start', { featureIds: [...selectedIds] }, { source: 'local' });
      this.hookedFeatureIds = [...selectedIds];
      this.hookPluginManager = pluginManager ?? null;
      this.announce(hitResult.type, [...selectedIds], context.eventEmitter);
    }

    // Disable MapLibre's map dragging
    context.map.dragPan.disable();

    // Make sure no record from the previous drag remains (normally emptied by the reset in
    // endDrag)
    this.writes.discard(store);

    switch (hitResult.type) {
      case 'move':
        this.begin(startMoveDrag(event, [...selectedIds], store));
        // Record the features being moved. Snapping excludes them from its candidates (snapping
        // to itself pulls the cursor back, shifting by the grab offset and making it look like
        // it vibrates)
        store.setDragState({ operation: 'move', movingFeatureIds: [...selectedIds] });
        break;

      case 'resize':
        this.begin(
          startResizeDrag(
            event,
            hitResult.handle!,
            bbox,
            selectedFeatures,
            context.map,
            this.scope,
          ),
        );
        store.setDragState({ operation: 'resize' });
        break;

      case 'rotate':
        this.begin(startRotateDrag(event, bbox, selectedFeatures, store, this.scope));
        break;

      case 'vertex':
        this.begin(startVertexDrag(event, hitResult.featureId!, hitResult.vertexRef!, context));
        break;

      case 'midpoint':
        this.begin(startMidpointDrag(event, hitResult.featureId!, hitResult.vertexRef!, store));
        // For midpoint, the newly added vertex is afterIndex + 1 in the same part and same ring
        store.setDragState({
          operation: 'midpoint',
          activeVertex: {
            ...hitResult.vertexRef!,
            index: hitResult.vertexRef!.index + 1,
          },
          activeFeatureId: hitResult.featureId!,
        });
        break;

      case 'radius':
        this.begin(startRadiusDrag(hitResult.featureId!, store));
        store.setDragState({ operation: 'radius' });
        break;

      case 'auxiliary':
        // Delegation is already done above (we only get here when it was accepted)
        this.begin(auxiliaryDrag);
        store.setDragState({ operation: 'auxiliary' });
        break;
    }
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
  updateDrag(event: DragNormalizedEvent, context: ModeContext): void {
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
  endDrag(context: ModeContext, event?: DragNormalizedEvent): void {
    const { store, pluginManager } = context;
    const wasAuxiliary = this.operation?.type === 'auxiliary';

    // The drag always ends: whatever the delegate, the commit or a plugin throws, map dragging
    // is re-enabled and the drag state is cleared, so that the UI never stays stuck in a drag.
    try {
      // Tell a delegate that the drag has ended (for an auxiliary handle core has written
      // nothing to the Store)
      this.operation?.finish?.(event);

      // Commit the intermediate updates made during the drag in a single transaction before
      // notifying drag:end (plugins see the state after the commit). If no feature was touched,
      // do nothing.
      this.writes.commit(store);

      // Notify plugins that the drag has ended (paired with drag:start, with the same IDs even
      // when the selection changed during the drag; auxiliary handles are excluded)
      if (!wasAuxiliary) this.endDragHook(pluginManager, false);
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
  reset(store?: ModeContext['store']): void {
    // Even on an abort (mode switch / a change from outside), end is delivered to the delegate
    // exactly once. When coming through endDrag it has already been delivered, so nothing
    // happens here.
    this.operation?.finish?.();

    this.operation = null;
    this.writes.discard(store);
    store?.setFollowedVertices?.(null);
    // An aborted drag still closes what drag:start opened (after the features are restored)
    this.endDragHook(this.hookPluginManager ?? undefined, true);
  }

  /**
   * Sends the drag:end that pairs with the drag:start of the current drag, once
   */
  private endDragHook(pluginManager: ModeContext['pluginManager'], cancelled: boolean): void {
    const featureIds = this.hookedFeatureIds;
    const kind = this.announcedKind;
    const announcer = this.announcer;
    this.hookedFeatureIds = null;
    this.hookPluginManager = null;
    this.announcedKind = null;
    this.announcer = null;
    if (!featureIds) return;
    pluginManager?.runHook('drag:end', { featureIds }, { source: 'local' });
    if (kind) announcer?.emit('drag.ended', { kind, featureIds: [...featureIds], cancelled });
  }

  /**
   * Announces the start of a drag on the emitter of the instance; its end is announced with
   * the same IDs, committed or cancelled
   */
  private announce(
    type: HandleHitResult['type'],
    featureIds: string[],
    emitter: EventEmitter | undefined,
  ): void {
    const kind: DragKind =
      type === 'move' ? 'feature' : type === 'vertex' || type === 'midpoint' ? 'vertex' : 'handle';
    this.announcedKind = kind;
    this.announcer = emitter ?? null;
    emitter?.emit('drag.started', { kind, featureIds: [...featureIds] });
  }

  /**
   * Whether a drag operation is active
   */
  isActive(): boolean {
    return this.operation !== null;
  }
}
