// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The storage of the documents (`DrawOptions.backend`): what a storage gives the instance, and
 * what it answers
 */

import type { Refusal } from '../../shared/refusal.js';
import type { DrawReader } from '../draw.js';
import type { CloseReason, Connection, RefuseReason, SaveStage } from '../status.js';
import type { ImportSource, Progress, TaskOptions } from '../write.js';
import type { Batch, ValueBatch, ValueOperation } from './values.js';

/** What a storage of either shape has */
export interface BackendBase {
  /** Reads the document: `draw.open()` calls it. A failure is thrown as a `DrawError` */
  load(task: Task): Promise<ImportSource>;
  /**
   * Given by a storage that receives the edits of other clients, or tells later that a commit is
   * kept: called once the document it read is open, with what it writes to the instance through
   *
   * @returns What cuts the connection: called when the document is closed
   */
  connect?(context: BackendContext, task: Task): Promise<() => void>;
  /**
   * The stages a commit goes through with this storage, besides `local` and `accepted`, which it
   * always goes through: `stored` with an `outbox`, `durable` when the storage tells it
   */
  readonly stages?: readonly SaveStage[];
  /**
   * Where the commits not sent and the refusals are kept on the device: they stay when the
   * document is closed, and the next `draw.open()` sends the commits on
   */
  readonly outbox?: Outbox;
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

/**
 * What a storage writes to the instance through (`BackendBase.connect`)
 */
export interface BackendContext {
  /** The reads of the document and of the state, as the application reads them */
  readonly draw: DrawReader;
  /**
   * Writes to the document here what the storage decided: the commits of other clients, and what
   * makes a commit of this client as the storage made it. It is written in their order, as they
   * are: what decides between writes is the storage's. However large, it does not stop the page:
   * until it is written, the reads give the document before it, and `change` is told once
   */
  receive(result: Received, options?: TaskOptions): Promise<void>;
  /** Replaces the whole document with what the storage holds (the steps of undo are dropped) */
  replace(source: ImportSource, options?: TaskOptions): Promise<void>;
  /** Brings a commit to a stage: `stored`, or `durable` told after it was accepted */
  advance(commit: string, stage: SaveStage): void;
  /** Tells the connection, whether this client may write, and how far a transfer is */
  report(report: BackendReport): void;
  /** The key of the order of a feature, a group or a layer among the items of its parent */
  key(id: string): string | undefined;
}

/** What a storage tells of the connection and of what this client may do */
export interface BackendReport {
  readonly connection?: Exclude<Connection, { readonly state: 'none' }>;
  /** False while this client may not write the document */
  readonly editable?: boolean;
  /** How far what is sent or received is (null once it is done) */
  readonly transfer?: Progress | null;
}

/**
 * What a storage decided, written to the document here: a commit of another client, or what makes
 * a commit of this client as the storage made it
 */
export interface Received {
  /** The commit of this client it is the result of */
  readonly commit?: string;
  readonly source?: 'remote' | 'undo' | 'redo';
  readonly label?: string;
  readonly operations: readonly ValueOperation[];
}

/**
 * Where the commits not sent and the refusals are kept on the device, through a closing and an
 * opening of the document. The batches of a commit are put once it is read, and deleted once the
 * storage accepts it; the batches of a commit refused stay with its refusal, until it is dismissed
 * or made again
 */
export interface Outbox {
  put(batch: Batch, options?: TaskOptions): Promise<void>;
  /** Deletes a batch, or a refusal, by its ID */
  delete(id: string, options?: TaskOptions): Promise<void>;
  /** The batches kept, in the order they were put */
  list(options?: TaskOptions): Promise<readonly Batch[]>;
  /** Keeps a refusal */
  keep(refusal: Refusal, options?: TaskOptions): Promise<void>;
  /** The refusals kept, in the order they were kept */
  refusals(options?: TaskOptions): Promise<readonly Refusal[]>;
}
