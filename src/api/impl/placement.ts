// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a move goes, and the writes that move features and groups there
 *
 * A move is one transaction of the layer over the Store. The features and groups keep their
 * stacking order among themselves, and `index` is their position within the destination once
 * they have left it.
 */

import type { DocumentAccess, InstanceDocument } from '../../store/document-access.js';
import type { Feature, Group, Layer } from '../../store/types.js';
import type { MoveTarget } from '../model.js';
import {
  groupLocked,
  invalidInput,
  isRecord,
  layerLocked,
  notFound,
  optionalIndex,
  requireId,
} from './shared.js';

/**
 * A resolved move target
 *
 * - `layer`: the layer, as items of their own
 * - `group`: into the group
 * - `ungroup`: out of their group, staying in their layer
 *
 * @internal
 */
export type ResolvedTarget =
  | { kind: 'layer'; layer: Layer; index: number | undefined; locked: boolean }
  | { kind: 'group'; group: Group; index: number | undefined; locked: boolean }
  | { kind: 'ungroup'; index: number | undefined; locked: false };

/**
 * Checks a move target and looks up what it names
 *
 * @throws DrawError `invalidInput` for a target of the wrong shape, `notFound` for a layer
 *   or a group that does not exist
 * @internal
 */
export function resolveMoveTarget(store: DocumentAccess, to: MoveTarget): ResolvedTarget {
  if (!isRecord(to)) throw invalidInput('The target must be an object');
  const hasLayer = 'layerId' in to;
  const hasGroup = 'groupId' in to;
  if (hasLayer === hasGroup) {
    throw invalidInput('The target must have either layerId or groupId');
  }
  const index = optionalIndex(to.index);
  if (hasLayer) {
    const layerId = requireId(to.layerId, 'layerId');
    const layer = store.getLayer(layerId);
    if (!layer) throw notFound('layer', layerId);
    return { kind: 'layer', layer, index, locked: layerLocked(store, layer) };
  }
  if (to.groupId === null) return { kind: 'ungroup', index, locked: false };
  const groupId = requireId(to.groupId, 'groupId');
  const group = store.getGroup(groupId);
  if (!group) throw notFound('group', groupId);
  return { kind: 'group', group, index, locked: groupLocked(store, group) };
}

/**
 * Moves features to a target, in one transaction
 *
 * @param features The features, in stacking order
 * @returns False when the Store refused one of the writes
 * @internal
 */
export function moveFeatures(
  store: InstanceDocument,
  features: Feature[],
  target: ResolvedTarget,
): boolean {
  const ids = features.map((feature) => feature.id);
  if (target.kind === 'layer') {
    return store.moveFeatures(ids, {
      kind: 'layer',
      layerId: target.layer.id,
      index: target.index,
    });
  }
  if (target.kind === 'group') {
    return store.moveFeatures(ids, {
      kind: 'group',
      groupId: target.group.id,
      index: target.index,
    });
  }
  return store.moveFeatures(ids, { kind: 'ungroup', index: target.index });
}

/**
 * Moves groups to a layer, in one transaction
 *
 * @param groups The groups, in stacking order
 * @returns False when the Store refused one of the writes
 * @internal
 */
export function moveGroups(
  store: InstanceDocument,
  groups: Group[],
  layer: Layer,
  index?: number,
): boolean {
  return store.moveGroups(
    groups.map((group) => group.id),
    layer.id,
    index,
  );
}
