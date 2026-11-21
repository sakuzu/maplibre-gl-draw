// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a bulk edit does to its features (the work the bulk edits of an instance write in parts),
 * and the member of the bulk edits that starts one
 *
 * The bulk edits themselves belong to the instance (`api/impl/bulk-edits.ts`); the operations and
 * the modes, which sit below it, start them through the shape written here.
 */

import type { EditCounts, EditOptions, FeatureTarget } from '../api/features.js';
import type { InstanceDocument } from '../store/document-access.js';

/**
 * What every work may do besides writing its features
 *
 * @internal
 */
export interface BulkWorkHooks {
  /**
   * Called once, when the edit is about to write to its features for the first time (its first
   * part, or a write of this client that touches one of its features first): the edits started
   * before it have ended then. What it throws ends the edit, whose promise rejects with it, and
   * nothing of the edit is written
   */
  prepare?(): void;
  /**
   * Called in the transaction of the last part of the edit, once the target is written (stopped
   * false), or in the one of the part that stops it (stopped true); not when the instance is
   * destroyed
   *
   * @returns The number of features it changed besides those of the target (added to
   *   `changedCount`)
   */
  end?(stopped: boolean): number | undefined;
  /**
   * How the edit ended, read once its last part is written (not when it stopped): `stopped` when
   * the Store refused a write of that part after the edit had written something (the edit then
   * resolves as one that stopped, the parts written staying), `refused` when it refused a write
   * before anything was written (the edit resolves with null, as read-only gives); undefined
   * when it wrote everything
   */
  outcome?(): 'stopped' | 'refused' | undefined;
  /** The IDs of the features the edit created, read when its promise resolves */
  createdIds?(): readonly string[];
  /**
   * False when the edit is not applied first to a feature a write of this client touches (a
   * deletion of layers: the layers refuse the writes instead)
   */
  readonly appliesFirst?: boolean;
  /**
   * The layers the edit deletes: from its first part on, they refuse the other writes of this
   * client, until the edit ends
   */
  readonly deletesLayers?: readonly string[];
}

/**
 * A work that writes the edit to one feature at a time
 *
 * @internal
 */
export interface BulkFeatureWork extends BulkWorkHooks {
  /**
   * Writes the edit to one feature through the layer, in the transaction open (a part of the
   * edit, or the transaction of a write that touches the feature first)
   *
   * @returns True when it changed the feature
   */
  writeFeature(id: string): boolean;
}

/**
 * A work that writes the edit to several features at a time
 *
 * @internal
 */
export interface BulkBatchWork extends BulkWorkHooks {
  /**
   * Writes the edit to features through the layer, in the transaction open (a part of the edit,
   * or the transaction of a write that touches one of them first)
   *
   * @param ids - The features, each once, none of them locked (unless the edit ignores the
   *   locks) nor deleted when the batch was made
   * @param changed - One entry per ID, 0 when given: set to 1 for each feature it changed
   */
  writeFeatures(ids: readonly string[], changed: Uint8Array): void;
}

/**
 * What one bulk edit does to the features of its target
 *
 * @internal
 */
export type BulkWork = BulkFeatureWork | BulkBatchWork;

/**
 * What the work of an edit is made from, once the target is read and the number of the
 * operation is taken
 *
 * @internal
 */
export interface BulkWorkStart {
  /** The number of the operation of the edit, the same in every part of it */
  readonly operationId: number;
  /**
   * The features of the target when the edit starts: an ID given again and an ID that names
   * nothing left out, a locked feature counted
   */
  readonly featureCount: number;
  /** The ID of the feature, when the target has one feature only */
  readonly onlyId: string | undefined;
}

/**
 * What the work of an edit may read of the edit and of its target, once it starts
 *
 * @internal
 */
export interface BulkWorkTarget {
  /** Whether the writes of the edit ignore the locks */
  readonly ignoreLocks: boolean;
  /** Whether a feature was in the target when the edit started (and is there still) */
  targets(id: string): boolean;
  /** The types of the features of the target, read from their rows (no feature is made) */
  targetTypes(): ReadonlySet<string>;
}

/**
 * Makes the work of an edit once it starts
 *
 * @throws What it throws is thrown by the start of the edit, and the edit does not start
 * @internal
 */
export type BulkWorkFactory = (start: BulkWorkStart, target: BulkWorkTarget) => BulkWork;

/**
 * How an edit is started besides its target, its options and its work
 *
 * @internal
 */
export interface BulkStartOptions {
  /**
   * Asked once the document is known not to be read-only: true refuses the edit, which then
   * resolves with null at once and writes nothing
   *
   * @param ignoreLocks - Whether the edit ignores the locks
   */
  refuses?(ignoreLocks: boolean): boolean;
  /**
   * True when the edit writes to every feature of its target, the locked ones too, whatever its
   * options say: nothing is counted as locked, and a target of locked features is not refused
   */
  readonly writesLocked?: boolean;
  /** The features counted as locked before the edit starts (those it leaves out of its target) */
  readonly lockedBefore?: number;
}

/**
 * The bulk edits of an instance, as the operations and the modes start them
 *
 * @internal
 */
export interface BulkEditStarter {
  /** The layer over the Store the edits write through */
  readonly layer: InstanceDocument;
  /**
   * Starts a bulk edit
   *
   * @returns A promise of what the edit did, once its last change has arrived; null at once when
   *   the document is read-only, every feature of the target is locked, or the edit refuses
   * @throws `DrawError` with the code `invalidInput` for a target or options of the wrong shape,
   *   or `invalidState` for a second edit started in the same `draw.transact`, or a source other
   *   than that of the `draw.transact` it is started in; what the function that makes the work
   *   throws
   */
  start(
    target: FeatureTarget,
    options: EditOptions | undefined,
    work: BulkWork | BulkWorkFactory,
    startOptions?: BulkStartOptions,
  ): Promise<EditCounts | null>;
}
