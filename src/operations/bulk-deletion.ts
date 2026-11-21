// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The deletions of any number of features, of layers and of what is selected (the bulk edits
 * `features.deleteMany`, `layers.delete`, `layers.deleteMany` and `selection.delete`, and the
 * Delete key)
 *
 * - The features are deleted through the layer, one after another, in the parts of the edit: a
 *   group whose last feature goes is deleted with it (the layer does it), and an embedded file
 *   stays (nothing deletes it). What is deleted leaves the selection, the editing and the items
 *   this client hides when the last part of the edit is told (the layer does it at once).
 * - A layer is deleted in the last part, once its features are; from the first part on it takes
 *   no other write of this client (the layer refuses them). A deletion of layers is refused at
 *   its start when one of them, one of their groups or one of their features is locked (unless
 *   it ignores the locks); a feature locked while it writes stays, and its layer stays with it.
 *   A feature written to the Store directly into the layer meanwhile is deleted with the layer.
 * - The deletion of what is selected looks at the locks whatever the transaction it is started
 *   in says: what is locked stays, a selected layer that holds a lock is left out (its features
 *   counted as locked), the document keeps one layer, and once something is deleted nothing is
 *   selected.
 */

import type { EditCounts, EditOptions, FeatureTarget } from '../api/features.js';
import type { InstanceDocument } from '../store/document-access.js';
import type { BulkBatchWork, BulkEditStarter } from './bulk-work.js';

/**
 * Deletes features through the layer; `deleted` hears of each one deleted
 *
 * @internal
 */
function deletionWork(
  layer: InstanceDocument,
  deleted: () => void = () => {},
): Pick<BulkBatchWork, 'writeFeatures'> {
  return {
    writeFeatures(ids, changed) {
      for (let i = 0; i < ids.length; i++) {
        if (layer.deleteFeature(ids[i])) {
          changed[i] = 1;
          deleted();
        }
      }
    },
  };
}

/**
 * Whether a layer, one of its groups or one of its features is locked (read from the rows,
 * without the features being made)
 *
 * @internal
 */
export function layerHoldsLock(layer: InstanceDocument, layerId: string): boolean {
  if (layer.getLayer(layerId)?.locked === true) return true;
  if (layer.listGroups().some((group) => group.layerId === layerId && group.locked)) return true;
  return layer.countFeatures({ layerId, locked: true }) > 0;
}

/**
 * Starts the deletion of the features of a target (`features.deleteMany`)
 *
 * @internal
 */
export function startFeatureDeletion(
  edits: BulkEditStarter,
  target: FeatureTarget,
  options: EditOptions | undefined,
): Promise<EditCounts | null> {
  return edits.start(target, options, deletionWork(edits.layer));
}

/**
 * The work of the deletion of layers: their features in the parts, and in the last part each
 * layer that holds no lock (unless the locks are ignored), with what was written into it from
 * outside the instance meanwhile
 *
 * @param after - Called in the last part once the layers are deleted (stopped false), or in the
 *   part that stops the edit (stopped true), with whether anything was deleted
 */
function layerDeletionWork(
  layer: InstanceDocument,
  layerIds: readonly string[],
  ignoreLocks: boolean,
  after: (stopped: boolean, deletedAny: boolean) => void = () => {},
): BulkBatchWork {
  let deletedAny = false;
  /** Whether the Store refused the deletion of a layer in the last part */
  let refused = false;
  const features = deletionWork(layer, () => {
    deletedAny = true;
  });
  return {
    appliesFirst: false,
    deletesLayers: layerIds,
    writeFeatures: features.writeFeatures,
    end(stopped) {
      let more = 0;
      if (!stopped) {
        for (const layerId of layerIds) {
          if (!layer.getLayer(layerId)) continue;
          if (!ignoreLocks && layerHoldsLock(layer, layerId)) continue;
          const left = layer.countFeatures({ layerId });
          if (layer.deleteLayer(layerId)) {
            more += left;
            deletedAny = true;
          } else {
            // Refused by the Store: the layer stays, as when the edit stops
            refused = true;
          }
        }
      }
      after(stopped, deletedAny);
      return more;
    },
    // A layer the Store refused to delete: the edit stopped, or wrote nothing when it had deleted
    // nothing before
    outcome: () => (refused ? (deletedAny ? 'stopped' : 'refused') : undefined),
  };
}

/**
 * Starts the deletion of layers (`layers.delete` and `layers.deleteMany`): refused at once
 * when one of them holds a lock, unless the locks are ignored
 *
 * @throws `DrawError` with the code `invalidInput` when the IDs are not an array of strings
 * @internal
 */
export function startLayerDeletion(
  edits: BulkEditStarter,
  ids: readonly string[],
  options: EditOptions | undefined,
): Promise<EditCounts | null> {
  const { layer } = edits;
  const target = { layerIds: ids };
  // The layers there when it starts; the others are counted as IDs that name nothing
  const present = (): string[] =>
    [...new Set(ids)].filter((id) => typeof id === 'string' && layer.getLayer(id) !== undefined);
  return edits.start(
    target,
    options,
    (_started, read) => layerDeletionWork(layer, present(), read.ignoreLocks),
    {
      refuses: (ignoreLocks) =>
        !ignoreLocks && present().some((layerId) => layerHoldsLock(layer, layerId)),
    },
  );
}

/**
 * Starts the deletion of what is selected (`selection.delete`, and the Delete key once it has
 * found no vertex selected)
 *
 * @returns The counts of the edit, or null at once when nothing is selected, the document is
 *   read-only, the interaction lock is on, or everything selected is locked
 * @internal
 */
export function startSelectionDeletion(edits: BulkEditStarter): Promise<EditCounts | null> {
  const { layer } = edits;
  if (layer.isReadOnly() || layer.isInteractionLocked()) return Promise.resolve(null);
  const selection = layer.getSelection();
  if (selection.type === null || selection.ids.length === 0) return Promise.resolve(null);
  // The locks are looked at, whatever the transaction it is started in ignores
  const options: EditOptions = { ignoreLocks: false };
  /** Once something is deleted, nothing is selected */
  const clearSelection = (deletedAny: boolean): void => {
    if (deletedAny) layer.setSelection(null, []);
  };

  if (selection.type === 'feature') {
    let deletedAny = false;
    const features = deletionWork(layer, () => {
      deletedAny = true;
    });
    return edits.start({ selection: true }, options, {
      writeFeatures: features.writeFeatures,
      end() {
        clearSelection(deletedAny);
        return 0;
      },
    });
  }

  if (selection.type === 'group') {
    const groupIds = [...new Set(selection.ids)];
    const groupLocked = (groupId: string): boolean => {
      const group = layer.getGroup(groupId);
      return group === undefined || group.locked || layer.getLayer(group.layerId)?.locked === true;
    };
    const unlocked = groupIds.filter((groupId) => !groupLocked(groupId));
    if (unlocked.length === 0) return Promise.resolve(null);
    let deletedAny = false;
    const features = deletionWork(layer, () => {
      deletedAny = true;
    });
    return edits.start({ selection: true }, options, {
      writeFeatures: features.writeFeatures,
      end(stopped) {
        if (!stopped) {
          // A group selected with no feature in it goes too (one that keeps locked ones stays)
          for (const groupId of unlocked) {
            if (!layer.getGroup(groupId) || groupLocked(groupId)) continue;
            if (layer.countGroupFeatures(groupId) > 0) continue;
            if (layer.deleteGroup(groupId)) deletedAny = true;
          }
        }
        clearSelection(deletedAny);
        return 0;
      },
    });
  }

  // Layers: those that hold a lock are left out, and the document keeps one layer
  const layerIds = [...new Set(selection.ids)].filter((id) => layer.getLayer(id) !== undefined);
  const withLock = layerIds.filter((layerId) => layerHoldsLock(layer, layerId));
  const unlocked = layerIds.filter((layerId) => !withLock.includes(layerId));
  const deletable = unlocked.slice(0, Math.max(0, layer.listLayers().length - 1));
  if (deletable.length === 0) return Promise.resolve(null);
  let lockedBefore = 0;
  for (const layerId of withLock) lockedBefore += layer.countFeatures({ layerId });
  return edits.start(
    { layerIds: deletable },
    options,
    layerDeletionWork(layer, deletable, false, (_stopped, deletedAny) =>
      clearSelection(deletedAny),
    ),
    { lockedBefore },
  );
}
