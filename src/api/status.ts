// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.status`: what an application shows of the instance, in one value: whether the document is
 * open, how far its commits are saved, the connection to the storage, the steps of undo, whether
 * it can be written now, and the failures nobody waits for
 */

import type { DrawError } from './errors.js';
import type { Progress } from './write.js';

/** What an application shows of the instance, in one value that changes over time */
export interface Status {
  readonly document: DocumentState;
  readonly saving: SaveState;
  readonly connection: Connection;
  readonly history: HistoryState;
  /** Whether the document can be written now: by the options, the storage and the document */
  readonly editable: boolean;
  /**
   * The failures nobody waits for, the newest first, 20 at most: the writes a commit left out
   * because what they named was gone, and the failures of what the user did
   */
  readonly problems: readonly Problem[];
}

/**
 * A failure nobody called for: a commit that left out writes whose targets were gone, a write of
 * the user refused. Its `id` grows, so that a page shows only those newer than the last it showed.
 */
export interface Problem {
  readonly id: number;
  /** `failed`: nothing was written. `skipped`: the commit was made, without some of its writes */
  readonly type: 'failed' | 'skipped';
  readonly error: DrawError;
  /** The `label` of the write */
  readonly label: string | undefined;
  /** The ID of the commit (`Write.id`), or `null` when nothing was written */
  readonly commit: string | null;
  /** How many writes or features it is about */
  readonly count: number;
  readonly atMilliseconds: number;
}

/** Whether the document is open */
export type DocumentState =
  | { readonly state: 'closed' }
  | {
      readonly state: 'opening';
      readonly progress: Progress | null;
      /** Whether the part of the document in view is all drawn */
      readonly viewReady: boolean;
    }
  | { readonly state: 'open' }
  | { readonly state: 'failed'; readonly error: DrawError };

/**
 * How far a commit is saved, in this order. A closed union.
 *
 * - `local`: written here
 * - `stored`: kept on this device, where it stays when the page is closed (a storage with an
 *   outbox only)
 * - `accepted`: taken by the storage
 * - `durable`: kept by the storage in a way that outlives its failure (a storage that says so only)
 */
export type SaveStage = 'local' | 'stored' | 'accepted' | 'durable';

/** A stage a save waits for */
export type SaveGoal = Exclude<SaveStage, 'local'>;

/** How far the commits are saved */
export interface SaveState {
  /** The stage of the commit the furthest behind */
  readonly stage: SaveStage;
  /** Every stage a commit goes through here: the one to read what to show */
  readonly stages: readonly SaveStage[];
  /** How many commits are not `accepted` yet */
  readonly unsaved: number;
  /** How many commits the storage refused */
  readonly refused: number;
  /** When a commit was last `accepted` (`null` before the first) */
  readonly savedAtMilliseconds: number | null;
  /** How far what is being sent is sent */
  readonly sending: Progress | null;
}

/**
 * The connection to the storage: what to show of it is read from this value alone. A closed
 * union.
 *
 * - `none`: there is no storage
 * - `catchingUp`: connected, receiving what was written elsewhere
 * - `offline`: cut off for a while, and trying again by itself
 * - `closed`: cut off, without trying again; `reason` says why
 */
export type Connection =
  | { readonly state: 'none' }
  | { readonly state: 'connecting'; readonly attempt: number }
  | { readonly state: 'catchingUp'; readonly progress: Progress }
  | { readonly state: 'online'; readonly sinceMilliseconds: number }
  | {
      readonly state: 'offline';
      /** Which try this is, from 1 */
      readonly attempt: number;
      readonly nextRetryAtMilliseconds: number;
      readonly error: DrawError;
    }
  | { readonly state: 'closed'; readonly reason: CloseReason; readonly error: DrawError };

/**
 * Why the connection was closed. A closed union.
 *
 * - `credential`: the credential ran out and cannot be renewed; signed in again, it goes on
 * - `permission`: the permission was taken away
 * - `documentDeleted`: the document is gone
 * - `version`: this version of the library cannot open the document
 * - `unavailable`: the storage is stopped
 * - `closedByClient`: closed by `draw.close`
 */
export type CloseReason =
  | 'credential'
  | 'permission'
  | 'documentDeleted'
  | 'version'
  | 'unavailable'
  | 'closedByClient';

/**
 * Why a storage refused a commit. An open union: a storage may give reasons of its own.
 *
 * - `retryLimit`: sent as many times as `Backend.retry` allows, without reaching the storage
 * - `outboxExpired`, `outboxFull`: the place of the device that keeps the commits not sent ran out
 *   of time or of room
 */
export type RefuseReason =
  | 'readOnly'
  | 'invalid'
  | 'rules'
  | 'limit'
  | 'documentDeleted'
  | 'dependsOnRefused'
  | 'retryLimit'
  | 'outboxExpired'
  | 'outboxFull'
  | (string & {});

/** The steps of undo of this client */
export interface HistoryState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** The `label` of the step an undo takes back */
  readonly undoLabel: string | undefined;
  /** The `label` of the step a redo makes again */
  readonly redoLabel: string | undefined;
}
