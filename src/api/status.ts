// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.status`: what an application shows of the instance, in one value: whether the document is
 * open, how far its commits are saved, the connection to the storage, the steps of undo, whether
 * it can be written now, and the failures nobody waits for
 */

import type { Refusal } from '../shared/refusal.js';
import type { DrawError } from './errors.js';
import type { Observable } from './events.js';
import type { All, Progress, SaveOptions, TaskOptions, Write, WriteOptions } from './write.js';

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

export type { Refusal, RefuseReason } from '../shared/refusal.js';

/** The steps of undo of this client */
export interface HistoryState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** The `label` of the step an undo takes back */
  readonly undoLabel: string | undefined;
  /** The `label` of the step a redo makes again */
  readonly redoLabel: string | undefined;
}

/** The refusals a call is about: one by its ID, several, or every one (`{ all: true }`) */
export type RefusalTarget = string | readonly string[] | All;

/**
 * The commits the storage refused, the oldest first: each taken out of the document here, and
 * kept until it is dismissed
 */
export interface Refusals extends Observable<readonly Refusal[]> {
  /**
   * The edits refused, as GeoJSON: what they meant, made on the document as it is now. A feature
   * they deleted is not there, and its ID is in `maplibre-gl-draw:deletedIds` of the
   * FeatureCollection. It can be shown over the document (`draw.view.preview`) and brought back
   * into another layer (`tx.import`)
   *
   * @throws `DrawError` with the code `notFound` for an ID that names no refusal
   */
  export(target: RefusalTarget, options?: TaskOptions): Promise<Blob>;
  /**
   * Makes what the refusals meant again on the document as it is now, as one new commit of this
   * client however many are given, and drops their records. What they wrote that is gone now is
   * left out
   */
  retry(target: RefusalTarget, options?: WriteOptions): Write<void>;
  /** Drops what the refusals meant, and their records */
  dismiss(target: RefusalTarget, options?: TaskOptions): Promise<void>;
}

/** The storage of the document, as the application drives it */
export interface BackendResource {
  /**
   * Brings the commits made so far to the storage: settles once each reaches the stage `until`
   * (`accepted` by default), sending now a batch that waits to be sent again. Fails with
   * `refused` when one of them is refused, and with `invalidState` with no storage, or for a
   * stage `status.saving.stages` does not list
   */
  save(options?: SaveOptions): Promise<void>;
  /**
   * Connects again now: what waits to be sent again is sent now, and a connection closed (by
   * `credential`, once signed in again) is opened again
   */
  reconnect(options?: TaskOptions): Promise<void>;
  /** The commits the storage refused */
  readonly refusals: Refusals;
}
