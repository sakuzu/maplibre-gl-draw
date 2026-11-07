// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Auxiliary handle drag: delegated to the extension implementation that provides the handle. The
 * patches it gives are shown by a sketch of this client (`PatchDrag`) and written once let go
 */

import type { SketchEdit } from '../../../api/sketches.js';
import type { DragNormalizedEvent } from '../../../dispatcher/types.js';
import type { FeaturePatch } from '../../../store/store.js';
import type {
  AuxiliaryHandleHit,
  AuxiliaryHandleProvider,
} from '../../../view/ui/auxiliary-handles.js';
import type { HandleHitResult } from '../../../view/ui/handle-test.js';
import type { DragScope, DragStore, SketchDrag } from './operation.js';

/**
 * Drag state for an auxiliary handle (provided by an extension implementation)
 *
 * Holds the grabbed handle and the provider it is delegated to. The meaning of the coordinates
 * lives on the provider side, so core merely forwards move / end.
 */
export interface AuxiliaryState {
  provider: AuxiliaryHandleProvider;
  hit: AuxiliaryHandleHit;
  /** The last drag event forwarded (for cleanup on paths where dragend is not delivered) */
  lastEvent: DragNormalizedEvent;
}

/** @internal */
export class AuxiliaryDrag {
  private state: AuxiliaryState | null;
  /** The feature the handle sits on (null for a handle of no feature) */
  readonly featureId: string | null;

  constructor(state: AuxiliaryState) {
    this.state = state;
    this.featureId = state.hit.global ? null : state.hit.featureId;
  }

  /** Forwards a move of the pointer: the patch it gives, if any */
  update(event: DragNormalizedEvent): FeaturePatch | null {
    if (!this.state) return null;

    this.state.lastEvent = event;
    return this.state.provider.onHandleDragMove(event) ?? null;
  }

  /** Tells the provider that the drag is let go: the last patch, if any */
  release(event?: DragNormalizedEvent): FeaturePatch | null {
    if (!this.state) return null;

    const { provider, lastEvent } = this.state;
    return provider.onHandleDragRelease?.(event ?? lastEvent) ?? null;
  }

  /**
   * Tell the delegate that the auxiliary handle drag has ended, let go or cut short
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

/** A patch with the fields of a later one: the keys of its `properties` and `style` one by one */
function mergedPatch(patch: FeaturePatch, later: FeaturePatch): FeaturePatch {
  return {
    ...patch,
    ...later,
    ...(patch.properties &&
      later.properties && { properties: { ...patch.properties, ...later.properties } }),
    ...(patch.style && later.style && { style: { ...patch.style, ...later.style } }),
  };
}

/**
 * The patches of a drag of an auxiliary handle, shown by a sketch of this client: the patch of each
 * move over the ones before it
 *
 * @internal
 */
export class PatchDrag implements SketchDrag {
  readonly type = 'auxiliary' as const;
  readonly selected: readonly string[];
  #patch: FeaturePatch;

  constructor(
    private readonly featureId: string,
    patch: FeaturePatch,
  ) {
    this.#patch = patch;
    this.selected = [featureId];
  }

  get start(): readonly SketchEdit[] {
    return this.editsAt();
  }

  /** Takes the patch of one more move */
  add(patch: FeaturePatch): void {
    this.#patch = mergedPatch(this.#patch, patch);
  }

  editsAt(): readonly SketchEdit[] {
    return [{ kind: 'set', featureId: this.featureId, patch: this.#patch }];
  }

  /** Whether the patches give the feature what it has: nothing is written then */
  movesNothing(_edits: readonly SketchEdit[], store: DragStore): boolean {
    const feature = store.getFeature(this.featureId);
    if (!feature) return true;
    const { properties, style, ...fields } = this.#patch;
    return (
      holds(feature, fields) &&
      holds(feature.properties, properties ?? {}) &&
      holds(feature.style as object, style ?? {})
    );
  }
}

/** Whether an object holds the values of the keys of another */
function holds(object: object, values: object): boolean {
  const held = object as Record<string, unknown>;
  return Object.entries(values).every(
    ([key, value]) => JSON.stringify(held[key]) === JSON.stringify(value),
  );
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
