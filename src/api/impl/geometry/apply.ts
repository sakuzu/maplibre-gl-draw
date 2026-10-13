// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The common part of the geometry operations: placing a result where its input was
 *
 *   applyResult   creates one result, deletes the inputs and places it (outside a transaction)
 *   commitResult  wraps applyResult in one transaction and moves the selection
 */

import type { DrawPropertyName } from '../../../shared/properties.js';
import { setDrawProperty } from '../../../shared/properties.js';
import { geometryFromCoordinates } from '../../../shared/utils/coordinates.js';
import { itemNeighbors } from '../../../store/item-lists.js';
import type { Store } from '../../../store/store.js';
import type {
  Feature,
  FeatureCoordinates,
  FeatureType,
  ItemPlacement,
} from '../../../store/types.js';
import type { GeometryDeps } from './types.js';

/**
 * The parametric properties of Circle. They are not inherited by a result that has been
 * reduced to a polygon (because a Circle becomes a polygon of 64 segments and loses the
 * notion of a radius).
 */
const CIRCLE_ONLY_PROPERTIES: readonly DrawPropertyName[] = ['radiusMeters', 'radiusHandleAngle'];

/**
 * Decides the placement that puts the result at "the place where the input it inherits from
 * was": the items just below and above it among the ones that stay.
 *
 * When the input was a member of a group, the result is put into the same group. In an operation
 * where the input it inherits from remains (the buffer), the result is put just in front of that
 * input.
 */
function planPlacement(
  store: Store,
  anchor: Feature,
  removedIds: ReadonlySet<string>,
): ItemPlacement {
  const groupId = anchor.groupId && store.getGroup(anchor.groupId) ? anchor.groupId : undefined;
  const layerId = anchor.layerId;
  const around = itemNeighbors(store, layerId, groupId, anchor.id, removedIds);
  if (!around) return { layerId, groupId, above: null };
  // Just in front of the input when it stays, at its place when it is deleted
  if (!removedIds.has(anchor.id))
    return { layerId, groupId, below: anchor.id, above: around.above };
  return { layerId, groupId, below: around.below, above: around.above };
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
 * with several results, such as the buffer, is gathered into one StoreChange.
 */
export function applyResult(deps: GeometryDeps, params: CommitParams): string {
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

  // Put where the input was (a group the inputs left empty is gone then, and the result is in
  // the layer)
  const to =
    placement.groupId && !store.getGroup(placement.groupId)
      ? { layerId: placement.layerId, below: placement.below, above: placement.above }
      : placement;
  store.moveItem(result.id, to);
  return result.id;
}
