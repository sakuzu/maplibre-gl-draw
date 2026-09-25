// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Auxiliary handle drag: delegated to the extension implementation that provides the handle
 */

import type { DragNormalizedEvent } from '../../../dispatcher/types.js';
import type {
  AuxiliaryHandleHit,
  AuxiliaryHandleProvider,
} from '../../../view/ui/auxiliary-handles.js';
import type { HandleHitResult } from '../../../view/ui/handle-test.js';
import type { DragOperation, DragScope } from './operation.js';

/**
 * Drag state for an auxiliary handle (provided by an extension implementation)
 *
 * Holds the grabbed handle and the provider it is delegated to. The meaning of the coordinates
 * lives on the provider side, so core merely forwards move / end and writes nothing to the Store.
 */
export interface AuxiliaryState {
  provider: AuxiliaryHandleProvider;
  hit: AuxiliaryHandleHit;
  /** The last drag event forwarded (for cleanup on paths where dragend is not delivered) */
  lastEvent: DragNormalizedEvent;
}

/** @internal */
export class AuxiliaryDrag implements DragOperation {
  readonly type = 'auxiliary' as const;
  private state: AuxiliaryState | null;

  constructor(state: AuxiliaryState) {
    this.state = state;
  }

  update(event: DragNormalizedEvent): void {
    if (!this.state) return;

    this.state.lastEvent = event;
    this.state.provider.onHandleDragMove(event);
  }

  /**
   * Tell the delegate that the auxiliary handle drag has ended
   *
   * On paths where no end event is delivered (when the mode side does not have an event), the
   * last event that was forwarded is used instead. The delegate always receives end exactly once.
   */
  finish(event?: DragNormalizedEvent): void {
    if (!this.state) return;

    const { provider, lastEvent } = this.state;
    this.state = null;
    provider.onHandleDragEnd(event ?? lastEvent);
  }
}

/**
 * Check whether an auxiliary handle drag can be delegated to a provider
 *
 * When no provider is found, or when onHandleDragStart returns false, null is returned and the
 * caller does not start a drag (it falls through to the normal handling).
 */
export function resolveAuxiliaryDrag(
  hitResult: HandleHitResult,
  event: DragNormalizedEvent,
  scope: DragScope,
): AuxiliaryDrag | null {
  const hit = hitResult.auxiliary;
  if (!hit) return null;

  const provider = scope?.auxiliaryHandles.get(hit.providerId);
  if (!provider) return null;
  if (!provider.onHandleDragStart(hit, event)) return null;

  return new AuxiliaryDrag({ provider, hit, lastEvent: event });
}
