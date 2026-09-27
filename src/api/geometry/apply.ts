// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The common part of the geometry operations: placing a result where its input was, and
 * announcing what an operation did
 *
 *   applyResult   creates one result, deletes the inputs and places it (outside a transaction)
 *   commitResult  wraps applyResult in one transaction and moves the selection
 *   emitApplied   emits draw.geometry.applied
 */

import type { DrawPropertyName } from '../../shared/properties.js';
import { setDrawProperty } from '../../shared/properties.js';
import { geometryFromCoordinates } from '../../shared/utils/coordinates.js';
import type { EventEmitter, GeometryAppliedPayload } from '../../shared/utils/event-emitter.js';
import type { Store } from '../../store/store.js';
import type { Feature, FeatureCoordinates, FeatureType } from '../../store/types.js';
import type { GeometryApiDeps } from './types.js';

/**
 * The parametric properties of Circle. They are not inherited by a result that has been
 * reduced to a polygon (because a Circle becomes a polygon of 64 segments and loses the
 * notion of a radius).
 */
const CIRCLE_ONLY_PROPERTIES: readonly DrawPropertyName[] = ['radiusMeters', 'radiusHandleAngle'];

/** Where the result feature is placed (the layer / group, and the z position within it). */
interface ResultPlacement {
  layerId: string;
  groupId?: string;
  /** The insertion position in the order after the inputs have been removed */
  index: number;
}

/**
 * Decides the placement that puts the result at "the place where the input it inherits from
 * was".
 *
 * When the input was a member of a group, the result is put into the same group. The position
 * is the position that the input it inherits from occupied in the order after the inputs have
 * been removed. In an operation where the input it inherits from remains (the buffer), the
 * result is put just in front of that input.
 */
function planPlacement(
  store: Store,
  anchor: Feature,
  removedIds: ReadonlySet<string>,
): ResultPlacement {
  const group = anchor.groupId ? store.getGroup(anchor.groupId) : undefined;
  const container = group ? group.featureIds : (store.getLayer(anchor.layerId)?.items ?? []);
  const anchorIndex = container.indexOf(anchor.id);
  const precedingIds = anchorIndex < 0 ? container : container.slice(0, anchorIndex);
  const precedingCount = precedingIds.filter((id) => !removedIds.has(id)).length;

  return {
    layerId: anchor.layerId,
    groupId: group?.id,
    // One further back when the input it inherits from remains (= just in front of it).
    // When it is deleted, that place is used as is.
    index: removedIds.has(anchor.id) ? precedingCount : precedingCount + 1,
  };
}

/**
 * Moves the result that createFeature stacked at the tail (the frontmost) to the z position of
 * its placement.
 */
function moveToPlacement(store: Store, resultId: string, placement: ResultPlacement): void {
  if (placement.groupId) {
    const group = store.getGroup(placement.groupId);
    if (!group) return;
    const featureIds = group.featureIds.filter((id) => id !== resultId);
    featureIds.splice(placement.index, 0, resultId);
    store.updateGroup(placement.groupId, { featureIds });
    return;
  }

  const layer = store.getLayer(placement.layerId);
  if (!layer) return;
  const order = layer.items.filter((id) => id !== resultId);
  order.splice(placement.index, 0, resultId);
  store.updateLayer(placement.layerId, { items: order });
}

/**
 * Inherits the style and the properties from the input it inherits from.
 */
function inheritProperties(anchor: Feature): Record<string, unknown> {
  const properties = { ...anchor.properties };
  for (const name of CIRCLE_ONLY_PROPERTIES) {
    setDrawProperty(properties, name, undefined);
  }
  return properties;
}

export interface CommitParams {
  /**
   * The input whose style, properties and placement are inherited (in a boolean operation, the
   * frontmost in z order)
   */
  anchor: Feature;
  /**
   * The IDs of the inputs to delete. Left empty in an operation that keeps the inputs, such as
   * the buffer
   */
  removedIds: string[];
  geometry: { type: FeatureType; coordinates: FeatureCoordinates };
  /**
   * The properties of the result. When omitted, they are inherited from the anchor with the
   * Circle-specific properties removed.
   * It is given explicitly only when the result stays a Circle (the Circle special case of the
   * buffer).
   */
  properties?: Record<string, unknown>;
}

/**
 * Creates one result feature, deletes the inputs and places it.
 *
 * It does not open a transaction. Because the caller wraps it in store.transact, even a case
 * with several results, such as the buffer, is gathered into one StateChanges.
 */
export function applyResult(deps: GeometryApiDeps, params: CommitParams): string {
  const { store, generateFeatureId } = deps;
  const { anchor, removedIds, geometry } = params;

  const placement = planPlacement(store, anchor, new Set(removedIds));
  const result: Feature = {
    id: generateFeatureId(),
    type: geometry.type,
    geometry: geometryFromCoordinates(geometry.type, geometry.coordinates),
    layerId: placement.layerId,
    groupId: placement.groupId,
    properties: params.properties ?? inheritProperties(anchor),
    style: { ...anchor.style },
    locked: false,
    visible: true,
  };

  // Create the result first, then delete the inputs. In the reverse order, a group made up of
  // the inputs alone would be removed by "the automatic deletion of empty groups", and the
  // place to put the result would be lost.
  store.createFeature(result);

  for (const id of removedIds) {
    if (!store.getFeature(id)) continue;
    store.deleteFeature(id);
  }

  moveToPlacement(store, result.id, placement);
  return result.id;
}

/**
 * Creates the result feature and deletes the inputs in one transaction, and moves the
 * selection to the result.
 *
 * A subscriber receives it as one StateChanges, which is what makes it one step for anything
 * that records changes.
 */
export function commitResult(deps: GeometryApiDeps, params: CommitParams): string {
  const { store } = deps;
  return store.transact(() => {
    const resultId = applyResult(deps, params);
    store.setSelection('feature', [resultId]);
    return resultId;
  });
}

/** Emits draw.geometry.applied. */
export function emitApplied(eventEmitter: EventEmitter, payload: GeometryAppliedPayload): void {
  eventEmitter.emit('geometry.applied', payload);
}
