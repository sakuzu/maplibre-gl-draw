// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The storage of the documents (`DrawOptions.backend`): what a storage gives the instance, and
 * what it answers
 */

import type { CloseReason, RefuseReason, SaveStage } from '../status.js';
import type { ImportSource, Progress } from '../write.js';
import type { ValueBatch } from './values.js';

/** What a storage of either shape has */
export interface BackendBase {
  /** Reads the document. A failure is thrown as a `DrawError` */
  load(task: Task): Promise<ImportSource>;
  /**
   * The stages a commit goes through with this storage, besides `local` and `accepted`, which it
   * always goes through: `durable` when the storage tells it
   */
  readonly stages?: readonly SaveStage[];
  /** The most bytes of one `send`: a larger commit is cut into parts. 1 MiB when left out */
  readonly maxBatchBytes?: number;
}

/**
 * The first shape of a storage: it receives the commits as JSON and answers each. It needs
 * `load` and `send` only; the document itself is held by the library, the storage is what is
 * plugged in.
 *
 * The edits are values only: a move or a turn arrives as the values after it.
 */
export interface Backend extends BackendBase {
  readonly instructions?: undefined;
  /**
   * Sends one commit. The instance calls it for one commit at a time, in the order of the commits.
   *
   * A large commit arrives cut into parts, in their order. Nothing of it is applied until every
   * part is there: a part before the last is answered `{ status: 'partial' }`, and the answer to
   * the last part is the answer to the commit. The same `Batch.id` is never applied twice.
   *
   * What it throws is a failure for a while: the same `Batch.id` is sent again later. What should
   * not be sent again is answered `refused` or `closed`. As a rule, a 4xx is `refused`, a 5xx and
   * a cut connection are thrown.
   */
  send(batch: ValueBatch, task: Task): Promise<Answer>;
  /**
   * Lets go of the parts of a commit received so far: called when the commit was refused before
   * its last part. Nothing of a commit is applied before its last part, so it may be left out.
   */
  abandon?(commit: string, task: Task): Promise<void>;
  /**
   * How long a commit is sent again: past it, the commit is refused with `retryLimit`. No limit
   * when left out, for an application whose connection may be cut for long; one that would rather
   * stop after failures gives one.
   */
  readonly retry?: { readonly maxAttempts?: number; readonly maxAgeMilliseconds?: number };
}

/** What a call to a storage is given */
export interface Task {
  /** Aborted when the instance no longer waits for the answer (it is removed) */
  readonly signal: AbortSignal;
  /** Tells how far it is; `send` tells the bytes sent */
  readonly onProgress: (progress: Progress) => void;
}

/**
 * The answer of a storage. A refusal is for a whole commit. A closed union.
 *
 * - `partial`: a part before the last was received; nothing is applied yet
 * - `accepted`: received; with `durable` true, kept in a way that outlives a failure
 * - `refused`: this commit is not taken; the commits after it are sent on
 * - `closed`: nothing more can be sent
 */
export type Answer =
  | { readonly status: 'partial' }
  | {
      readonly status: 'accepted';
      readonly durable?: boolean;
      /** The edits the storage left out: in `status.problems` as `skipped` */
      readonly skipped?: readonly { readonly ids: readonly string[]; readonly reason: string }[];
      /** The IDs the storage gave, from the ID here to the ID of the storage */
      readonly reassigned?: Readonly<Record<string, string>>;
    }
  | {
      readonly status: 'refused';
      readonly reason: RefuseReason;
      readonly message?: string;
      readonly retryable?: boolean;
    }
  | { readonly status: 'closed'; readonly reason: CloseReason; readonly message?: string };
