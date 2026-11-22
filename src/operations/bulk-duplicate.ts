// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The copies of any number of features (the bulk edit `features.duplicate`): what an edit writes
 * to each batch of its features
 *
 * - A copy has a new ID and the values of its original as they are (its name, its lock and its
 *   look included), and goes just in front of its original, in its layer and its group.
 * - When the target holds every feature of a group (told when the edit first comes to one of
 *   them), the copies of those features make a new group instead: it goes just in front of that
 *   group, with its values (its name, its lock and whether it is shown), and the copies take in
 *   it the order their originals have in theirs. When the target holds only some features of a
 *   group, their copies go into the group itself, each just in front of its original.
 * - The copies of a batch are created in one write of the layer; with a move, they are then
 *   moved as `translate` moves features. The IDs of the copies are kept for the counts of the
 *   edit. Nothing is selected.
 */

import type { CreatedPlace, InstanceDocument } from '../store/document-access.js';
import type { Feature } from '../store/types.js';
import type { BulkBatchWork } from './bulk-work.js';

/**
 * What the copies are made with
 *
 * @internal
 */
export interface DuplicateDeps {
  /** The layer over the Store, through which the features are read and the copies written */
  readonly layer: Pick<
    InstanceDocument,
    | 'getFeature'
    | 'getGroup'
    | 'countGroupFeatures'
    | 'listGroupFeatureIds'
    | 'createFeaturesAt'
    | 'createGroupInFrontOf'
  >;
  /** Generates the ID of a copy, or of a group of copies */
  readonly generateId: () => string;
  /** Whether a feature was in the target when the edit started */
  readonly targets: (id: string) => boolean;
  /** Moves the copies of a batch once they are written (the offset); none when left out */
  readonly move?: Pick<BulkBatchWork, 'writeFeatures'>;
}

/**
 * Makes the work of the copies of features
 *
 * @internal
 */
export function createDuplicateWork(deps: DuplicateDeps): BulkBatchWork {
  const { layer, generateId, targets, move } = deps;
  /** The IDs of the copies, in the order they were made */
  const created: string[] = [];
  /** The group of the copies of each group the target holds whole, or null for one held in part */
  const groupCopies = new Map<string, string | null>();

  /** The group the copies of the features of a group go in: a new one, or null for the group */
  const groupOfCopies = (groupId: string): string | null => {
    const known = groupCopies.get(groupId);
    if (known !== undefined) return known;
    const group = layer.getGroup(groupId);
    let copy: string | null = null;
    if (group) {
      const count = layer.countGroupFeatures(groupId);
      const members = layer.listGroupFeatureIds(groupId, 0, count);
      if (members.length > 0 && members.every(targets)) {
        const id = generateId();
        const made = layer.createGroupInFrontOf(
          {
            id,
            layerId: group.layerId,
            name: group.name,
            locked: group.locked,
            visible: group.visible,
          },
          groupId,
        );
        if (made) copy = id;
      }
    }
    groupCopies.set(groupId, copy);
    return copy;
  };

  return {
    writeFeatures(ids, changed) {
      const copies: Feature[] = [];
      const places: CreatedPlace[] = [];
      const at: number[] = [];
      for (let i = 0; i < ids.length; i++) {
        const original = layer.getFeature(ids[i]);
        if (!original) continue;
        let groupId = original.groupId;
        let place: CreatedPlace = { inFrontOf: original.id };
        if (groupId !== undefined) {
          const copyGroup = groupOfCopies(groupId);
          if (copyGroup !== null) {
            groupId = copyGroup;
            place = { keyOf: original.id };
          }
        }
        copies.push({
          id: generateId(),
          type: original.type,
          geometry: original.geometry,
          layerId: original.layerId,
          groupId,
          properties: original.properties,
          style: original.style,
          visible: original.visible,
          locked: original.locked,
        });
        places.push(place);
        at.push(i);
      }
      if (copies.length === 0) return;
      if (!layer.createFeaturesAt(copies, places)) return;
      const copyIds = copies.map((copy) => copy.id);
      for (const id of copyIds) created.push(id);
      for (const i of at) changed[i] = 1;
      move?.writeFeatures(copyIds, new Uint8Array(copyIds.length));
    },
    createdIds: () => created,
  };
}
