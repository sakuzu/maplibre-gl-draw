// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The commits of this client sent to a storage of the first shape (`Backend`), one at a time in
 * their order, and how far each is saved
 *
 * - Each notification of the Store is read where it goes out (`CommitValues.readChange`): the
 *   notifications of one commit (the steps of a drag of features selected in bulk) tell the same
 *   commit, and are one commit for the storage. A commit is complete once no write over several
 *   tasks is under way, or once the next commit comes
 * - A complete commit is read to its end (many rows over several tasks), cut into batches no
 *   larger than `maxBatchBytes`, a few operations at a time, and its parts are sent in their order
 * - What `send` throws is a failure for a while: the same batch is sent again after a wait that
 *   grows, while the connection is `offline`, until `Backend.retry` says it is enough (then it is
 *   refused with `retryLimit`). An answer `refused` refuses the commit, the commits after it are
 *   sent on; `closed` stops the sending
 *
 * - A commit refused is taken out of the document here (`take-out.ts`), with the later commits
 *   not sent that name what it created (`dependsOnRefused`), in one transaction of the source
 *   `refused`. Each is kept as a refusal until it is dismissed or made again
 *
 * @internal
 */

import { DrawError } from '../../shared/draw-error.js';
import type { Refusal } from '../../shared/refusal.js';
import type { Store } from '../../store/store.js';
import { rowRenamesOf } from '../../store/table-memory.js';
import type { StoreChange } from '../../store/types.js';
import { toChange } from '../impl/events.js';
import type { StepWrite } from '../impl/history.js';
import type {
  CloseReason,
  Connection,
  RefuseReason,
  SaveGoal,
  SaveStage,
  SaveState,
} from '../status.js';
import type { Progress, SaveOptions } from '../write.js';
import type { Answer, Backend, BackendReport, Outbox, Task } from './backend.js';
import { type ChangeReading, CommitValues } from './commit-values.js';
import { KeptRecords } from './kept.js';
import { createObservable } from './observable.js';
import { batchesInSteps } from './parts.js';
import { followCommit, writeOperations } from './store-writes.js';
import { type CommitOperations, dependentsOf, takeOut } from './take-out.js';
import type { ValueBatch, ValueOperation } from './values.js';

/** The bytes of one `send` when the storage gives no limit */
const DEFAULT_MAX_BATCH_BYTES = 1 << 20;

/** The time of one step of the reading and the cutting of a commit, in a task of its own (ms) */
const STEP_MS = 8;

/** The statuses of an answer */
const ANSWERS: ReadonlySet<unknown> = new Set(['partial', 'accepted', 'refused', 'closed']);

/** The stages in their order */
const STAGES: readonly SaveStage[] = ['local', 'stored', 'accepted', 'durable'];

/** The wait before sending again by default: 1 s, doubled each try, 30 s at most */
function defaultRetryDelay(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** (attempt - 1));
}

/**
 * What a sender is made with
 *
 * @internal
 */
export interface SenderOptions {
  /** Called each time what `saving` or `connection` gives changes */
  readonly onChange: () => void;
  /** Takes the edits the storage left out of a commit it accepted */
  readonly onSkipped: (skipped: {
    readonly error: DrawError;
    readonly label: string | undefined;
    readonly commit: string;
    readonly count: number;
  }) => void;
  /** The most rows of a notification read where it goes out (more are read over several tasks) */
  readonly rowsReadAtOnce?: number;
  /** The wait before the try `attempt` (from 1) of a batch sent again (ms) */
  readonly retryDelay?: (attempt: number) => number;
  /**
   * Called once commits are taken out of the document, refused (their steps of undo go): with
   * what takes back each commit written again by the take-out as it is written now, by its ID
   * (null: one that changes nothing now)
   */
  readonly onTakenOut?: (
    commits: ReadonlySet<string>,
    written: ReadonlyMap<string, StepWrite | null>,
  ) => void;
  /** The commit whose step an undo or a redo took (see `History.originOf`) */
  readonly originOf?: (commit: string) => string | undefined;
  /** Called once features take the IDs the storage gave them, from the old to the new */
  readonly onReassigned?: (ids: ReadonlyMap<string, string>) => void;
  /** Takes what failed with nobody to throw to (a write of the outbox) */
  readonly onFailed?: (failed: {
    readonly error: DrawError;
    readonly label: string | undefined;
    readonly commit: string | null;
    readonly count: number;
  }) => void;
}

/**
 * A commit refused, kept until it is dismissed: its record, and what it did
 *
 * @internal
 */
export interface RefusedCommit {
  readonly refusal: Refusal;
  readonly operations: readonly ValueOperation[];
  /** The IDs of its batches the outbox keeps */
  readonly batchIds: readonly string[];
}

/**
 * What was received from the storage while commits of this client were not answered: put back in
 * their order when one of them is refused, so that what it wrote stays (see `take-out.ts`)
 *
 * @internal
 */
export interface Receipt {
  readonly seq: number;
  operations: ValueOperation[];
  inverse: ValueOperation[];
}

/** The most IDs a refusal lists */
const REFUSAL_IDS = 1000;

/** A save waiting for a commit to reach a stage */
interface Waiter {
  readonly until: SaveGoal;
  readonly resolve: () => void;
  readonly reject: (error: DrawError) => void;
}

/** A commit of this client, until it reaches the last stage */
interface Entry {
  /** Its place among the commits and what was received, in their order */
  readonly seq: number;
  readonly commit: string;
  readonly label: string | undefined;
  readonly writtenAtMilliseconds: number;
  /** The readings of its notifications, in their order */
  readonly readings: ChangeReading[];
  /** Whether a notification of it may still come */
  open: boolean;
  stage: SaveStage;
  readonly waiters: Waiter[];
  /** Its operations, once read to their end */
  operations: ValueOperation[] | null;
  /** What takes it back, once read to its end (see `CommitOperations`) */
  inverse: ValueOperation[];
  /** The IDs the storage gave features after it was made, to give its operations once read */
  renames?: ReadonlyMap<string, string>[];
  /** For an undo or a redo, the commit whose step it took */
  readonly origin?: string;
  /** Its batches, once cut (put in the outbox, when there is one) */
  batches: ValueBatch[] | null;
}

/**
 * The sending of the commits of a Store to a storage
 *
 * @internal
 */
export class Sender {
  readonly #store: Store;
  readonly #backend: Backend;
  readonly #options: SenderOptions;
  readonly #values: CommitValues;
  readonly #stages: readonly SaveStage[];
  readonly #controller = new AbortController();
  readonly #unsubscribe: () => void;
  /** The commits not at the last stage, in their order */
  readonly #entries: Entry[] = [];
  /** The commits refused, by their ID, with the error a save of them fails with */
  readonly #refused = new Map<string, DrawError>();
  /** The commit whose notifications may still come */
  #open: Entry | null = null;
  #watching = false;
  #running = false;
  #stopped = false;
  #closed: { readonly reason: CloseReason; readonly error: DrawError } | null = null;
  #connection: Connection;
  #saving: SaveState;
  #savedAt: number | null = null;
  #sending: Progress | null = null;
  /** Ends the wait before a batch is sent again */
  #wake: (() => void) | null = null;
  /** The commits refused, the oldest first, until they are dismissed */
  #refusals: RefusedCommit[] = [];
  readonly #refusalsValue = createObservable<readonly Refusal[]>(Object.freeze([]));
  #nextRefusal = 1;
  /** Where the commits not sent and the refusals are kept on the device */
  readonly #outbox: Outbox | undefined;
  /** The commits written here that are not sent (what the storage gave, opened from it) */
  readonly #ignored = new Set<string>();
  /** What was received while commits of this client were not answered, in their order */
  #receipts: Receipt[] = [];
  #seq = 0;
  /** What the storage told of the connection, of what this client may do and of a transfer */
  #reported: BackendReport['connection'] | null = null;
  #editable = true;
  #transfer: Progress | null = null;
  /** The connection as it is shown: what the sending says, else what the storage told */
  #shown: Connection;
  /** Whether sending waits (the document is closed or opening) */
  #paused = false;

  constructor(store: Store, backend: Backend, options: SenderOptions) {
    this.#store = store;
    this.#backend = backend;
    this.#options = options;
    this.#outbox = backend.outbox;
    this.#stages = stagesOf(backend);
    this.#values = new CommitValues(store);
    this.#connection = { state: 'online', sinceMilliseconds: Date.now() };
    this.#shown = this.#connection;
    this.#saving = this.#savingNow();
    this.#unsubscribe = store.subscribe((changes) => this.#follow(changes));
  }

  /** Whether the storage lets this client write (`BackendReport.editable`) */
  get editable(): boolean {
    return this.#editable;
  }

  /** Takes what the storage tells (`BackendContext.report`) */
  report(report: BackendReport): void {
    if (this.#stopped) return;
    if (report.connection !== undefined) this.#reported = report.connection;
    if (report.editable !== undefined) this.#editable = report.editable !== false;
    if (report.transfer !== undefined) this.#transfer = report.transfer;
    this.#changed();
  }

  /** A commit written here that is not sent: the document the storage gave, opened from it */
  ignore(commit: string): void {
    this.#ignored.add(commit);
  }

  /** Stops sending until `resume` (while the document opens) */
  pause(): void {
    this.#paused = true;
  }

  /** Sends on what waits */
  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    if (!this.#running) setTimeout(() => void this.#run(), 0);
  }

  /** The commits not accepted yet */
  get unsent(): number {
    let count = 0;
    for (const entry of this.#entries) if (!reached(entry.stage, 'accepted')) count++;
    return count;
  }

  /** Whether the outbox keeps the commits not sent and the refusals */
  get keeps(): boolean {
    return this.#outbox !== undefined;
  }

  /** Whether the outbox holds every commit not sent now (each reached `stored`) */
  get kept(): boolean {
    if (!this.#outbox) return false;
    return this.#entries.every((one) => reached(one.stage, 'stored'));
  }

  /** Settles once every commit made so far is accepted or refused (fails with the signal) */
  waitAccepted(signal: AbortSignal | undefined): Promise<void> {
    const commits = this.#entries
      .filter((one) => !reached(one.stage, 'accepted'))
      .map((one) => one.commit);
    return Promise.all(
      commits.map((commit) =>
        this.save(commit, { until: 'accepted', signal }).catch((error: unknown) => {
          if (error instanceof DrawError && error.code === 'refused') return;
          throw error;
        }),
      ),
    ).then(() => undefined);
  }

  /** Reads every commit made so far to its end */
  async readAll(): Promise<void> {
    this.#store.finishSlicedWrite();
    this.#closeOpen();
    for (const entry of [...this.#entries]) {
      if (this.#stopped) return;
      if (entry.operations === null) await this.#read(entry);
    }
  }

  /**
   * Writes again the commits not accepted, as they were, over the document the storage gave in
   * place of the one they were made on (`write` writes their operations, in a transaction told
   * with the ID of the commit): what takes each back is read again
   */
  writeAgain(write: (commit: string, label: string | undefined, write: () => void) => void): void {
    const values = this.#values;
    for (const entry of this.#entries) {
      if (reached(entry.stage, 'accepted') || !entry.operations) continue;
      const operations = entry.operations;
      this.ignore(entry.commit);
      write(entry.commit, entry.label, () => {
        const before = values.namedBefore(operations);
        writeOperations(this.#store, values, operations);
        entry.inverse = values.inverseSince(before);
      });
    }
    this.#receipts = [];
  }

  /** How far the commits are saved */
  get saving(): SaveState {
    return this.#saving;
  }

  /** The connection to the storage */
  get connection(): Connection {
    return this.#shown;
  }

  /** The stages a commit goes through */
  get stages(): readonly SaveStage[] {
    return this.#stages;
  }

  /** What reads the commits of the Store as operations, and the document as it is now */
  get values(): CommitValues {
    return this.#values;
  }

  /** The records of the commits refused, the oldest first */
  get refusals(): {
    readonly value: readonly Refusal[];
    subscribe(listener: (value: readonly Refusal[]) => void): () => void;
  } {
    return this.#refusalsValue;
  }

  /** The commits refused a target names, the oldest first (`notFound` for an unknown ID) */
  refused(target: string | readonly string[] | { readonly all: true }): RefusedCommit[] {
    if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
      if ((target as { all?: unknown }).all !== true) {
        throw new DrawError('invalidInput', 'A target of refusals is an ID, IDs or { all: true }');
      }
      return [...this.#refusals];
    }
    const ids = typeof target === 'string' ? [target] : (target as readonly string[]);
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw new DrawError('invalidInput', 'A target of refusals is an ID, IDs or { all: true }');
    }
    const byId = new Map(this.#refusals.map((one) => [one.refusal.id, one]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new DrawError('notFound', `No refusal has the ID ${missing[0]}`, { ids: missing });
    }
    const wanted = new Set(ids);
    return this.#refusals.filter((one) => wanted.has(one.refusal.id));
  }

  /** Drops the records of refusals (and what the outbox keeps of them) */
  dismiss(refusals: readonly RefusedCommit[]): void {
    if (refusals.length === 0) return;
    const gone = new Set(refusals);
    this.#refusals = this.#refusals.filter((one) => !gone.has(one));
    this.#refusalsValue.set(Object.freeze(this.#refusals.map((one) => one.refusal)));
    for (const one of refusals) {
      this.#unkeep([one.refusal.id, ...one.batchIds], one.refusal.label, one.refusal.commit);
    }
    this.#changed();
  }

  /**
   * Brings a commit to a stage the storage tells (`BackendContext.advance`): `stored`, or
   * `durable` after it was accepted. A stage it reached already, or one it does not go through,
   * changes nothing
   */
  advance(commit: string, stage: SaveStage): void {
    if (this.#stopped || !this.#stages.includes(stage)) return;
    const entry = this.#entries.find((one) => one.commit === commit);
    if (!entry || reached(entry.stage, stage)) return;
    // Accepted once the answer comes: the storage tells the stages after it
    if (stage === 'accepted' || (stage === 'durable' && !reached(entry.stage, 'accepted'))) return;
    this.#reach(entry, stage);
  }

  // ==========================================================================
  // What is received
  // ==========================================================================

  /**
   * Notes what is received now, while a commit of this client is not answered: the caller writes
   * its operations and what takes them back into it (null when every commit is answered)
   */
  receipt(): Receipt | null {
    if (!this.#entries.some((one) => !reached(one.stage, 'accepted'))) return null;
    const receipt: Receipt = { seq: ++this.#seq, operations: [], inverse: [] };
    this.#receipts.push(receipt);
    return receipt;
  }

  /** Drops what was received before every commit not answered */
  #pruneReceipts(): void {
    if (this.#receipts.length === 0) return;
    let first = Number.POSITIVE_INFINITY;
    for (const entry of this.#entries) {
      if (!reached(entry.stage, 'accepted')) first = Math.min(first, entry.seq);
    }
    this.#receipts = this.#receipts.filter((one) => one.seq > first);
  }

  // ==========================================================================
  // The outbox
  // ==========================================================================

  /**
   * Takes what the outbox kept (once the document is opened): the commits not sent, written again
   * here, not sent again by this write (`write` writes their operations, in a transaction told
   * with the ID of the commit), and the refusals with what their commits did. A commit whose parts
   * are not all there was never stored: it is dropped
   */
  restore(
    batches: readonly ValueBatch[],
    refusals: readonly Refusal[],
    write: (commit: string, label: string | undefined, write: () => void) => void,
  ): void {
    const byCommit = new Map<string, ValueBatch[]>();
    for (const batch of batches) {
      let parts = byCommit.get(batch.commit);
      if (!parts) {
        parts = [];
        byCommit.set(batch.commit, parts);
      }
      parts.push(batch);
    }
    const refused = new Map(refusals.map((refusal) => [refusal.commit, refusal]));
    const incomplete: string[] = [];
    for (const [commit, parts] of byCommit) {
      const ordered = [...parts].sort((a, b) => a.part.index - b.part.index);
      const whole =
        ordered.length === ordered[0].part.count &&
        ordered.every((batch, i) => batch.part.index === i);
      if (!whole) {
        incomplete.push(...ordered.map((batch) => batch.id));
        continue;
      }
      const operations = ordered.flatMap((batch) => batch.operations);
      const refusal = refused.get(commit);
      if (refusal) {
        this.#refusals.push({ refusal, operations, batchIds: ordered.map((batch) => batch.id) });
        refused.delete(commit);
        continue;
      }
      const first = ordered[0];
      const entry: Entry = {
        seq: ++this.#seq,
        commit,
        label: first.label,
        writtenAtMilliseconds: first.writtenAtMilliseconds,
        readings: [],
        open: false,
        stage: 'stored',
        waiters: [],
        operations,
        inverse: [],
        batches: ordered,
      };
      // Written here again on the document the storage gave, as the storage applies them
      this.ignore(commit);
      write(commit, first.label, () => {
        const values = this.#values;
        const before = values.namedBefore(operations);
        writeOperations(this.#store, values, operations);
        entry.inverse = values.inverseSince(before);
      });
      this.#entries.push(entry);
    }
    // A refusal whose batches are gone keeps its record
    for (const refusal of refused.values()) {
      this.#refusals.push({ refusal, operations: [], batchIds: [] });
    }
    for (const one of this.#refusals) {
      const n = Number(/^refusal-(\d+)$/.exec(one.refusal.id)?.[1] ?? 0);
      if (n >= this.#nextRefusal) this.#nextRefusal = n + 1;
    }
    this.#refusalsValue.set(Object.freeze(this.#refusals.map((one) => one.refusal)));
    if (incomplete.length > 0) this.#unkeep(incomplete, undefined, null);
    this.#changed();
    if (!this.#running) setTimeout(() => void this.#run(), 0);
  }

  /**
   * Reads, cuts and puts in the outbox every commit complete (they reach `stored`): what closing
   * with `keep` waits for
   */
  async storeAll(): Promise<void> {
    this.#store.finishSlicedWrite();
    this.#closeOpen();
    for (const entry of [...this.#entries]) {
      if (this.#stopped) return;
      if (!entry.batches && !reached(entry.stage, 'accepted')) await this.#prepare(entry);
    }
  }

  /**
   * Drops the commits not sent and the refusals: their parts received are let go of
   * (`Backend.abandon`), and the outbox keeps nothing of them
   */
  async discard(): Promise<void> {
    this.#store.finishSlicedWrite();
    this.#closeOpen();
    const unsent = this.#entries.filter((one) => !reached(one.stage, 'accepted'));
    for (const entry of unsent) {
      if (this.#backend.abandon) {
        try {
          await this.#backend.abandon(entry.commit, this.#task());
        } catch {
          // Nothing of the commit is applied before its last part
        }
      }
      for (const reading of entry.readings) reading.release();
      this.#unkeep(
        (entry.batches ?? []).map((batch) => batch.id),
        entry.label,
        entry.commit,
      );
      this.#forget(entry);
    }
    this.dismiss([...this.#refusals]);
  }

  /** Deletes batches and refusals from the outbox; a failure is a problem nobody waits for */
  #unkeep(ids: readonly string[], label: string | undefined, commit: string | null): void {
    const outbox = this.#outbox;
    if (!outbox || ids.length === 0) return;
    void (async () => {
      for (const id of ids) {
        try {
          await outbox.delete(id);
        } catch (error) {
          this.#options.onFailed?.({ error: failureOf(error), label, commit, count: 1 });
        }
      }
    })();
  }

  /**
   * Settles once every commit made so far reaches a stage (see `BackendResource.save`): fails with
   * `refused` while a refusal is kept, or when one of them is refused
   */
  saveAll(options: SaveOptions | undefined): Promise<void> {
    const kept = this.#refusals[this.#refusals.length - 1];
    if (kept) {
      const error = this.#refused.get(kept.refusal.commit);
      if (error) return Promise.reject(error);
    }
    const commits = this.#entries.map((entry) => entry.commit);
    if (commits.length === 0) return this.save('', options);
    return Promise.all(commits.map((commit) => this.save(commit, options))).then(() => undefined);
  }

  /**
   * Sends now what waits to be sent again, and opens again a connection the storage closed (for
   * `credential`, once signed in again): the commits not sent are sent on
   */
  reconnect(): void {
    if (this.#stopped) return;
    if (this.#closed) {
      this.#closed = null;
      this.#connection = { state: 'online', sinceMilliseconds: Date.now() };
      this.#changed();
      if (!this.#running) setTimeout(() => void this.#run(), 0);
      return;
    }
    this.#wake?.();
  }

  /** Settles once a commit reaches a stage (see `Write.save`) */
  save(commit: string, options: SaveOptions | undefined): Promise<void> {
    const until = (options?.until ?? 'accepted') as SaveStage;
    if (!STAGES.includes(until) || until === 'local') {
      return Promise.reject(new DrawError('invalidInput', 'until must be a stage to wait for'));
    }
    if (!this.#stages.includes(until)) {
      return Promise.reject(
        new DrawError('invalidState', `A commit does not go through the stage ${until} here`),
      );
    }
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(abortedSave());
    if (this.#stopped) return Promise.reject(removed());
    const refused = this.#refused.get(commit);
    if (refused) return Promise.reject(refused);
    const entry = this.#entries.find((one) => one.commit === commit);
    // Not followed: it changed nothing of the document, or it reached the last stage
    if (!entry || reached(entry.stage, until)) return Promise.resolve();
    if (this.#closed) return Promise.reject(this.#closed.error);
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        until: until as SaveGoal,
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      const onAbort = (): void => {
        const at = entry.waiters.indexOf(waiter);
        if (at >= 0) entry.waiters.splice(at, 1);
        reject(abortedSave());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.waiters.push(waiter);
      // A batch waiting to be sent again is sent now
      this.#wake?.();
    });
  }

  /** Stops: nothing more is read nor sent, and the saves waiting fail */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#unsubscribe();
    this.#controller.abort();
    this.#wake?.();
    for (const entry of this.#entries) {
      for (const reading of entry.readings) reading.release();
      for (const waiter of entry.waiters.splice(0)) waiter.reject(removed());
    }
  }

  // ==========================================================================
  // The commits
  // ==========================================================================

  /** Reads a notification of the Store, as part of the commit it tells */
  #follow(changes: StoreChange): void {
    if (this.#stopped) return;
    // A notification from elsewhere, or of the take-out of refused commits, is read for the places
    // only: it is not sent
    const commit = this.#ignored.size > 0 ? toChange(changes, this.#store)?.commit : undefined;
    const ignored = commit !== undefined && this.#ignored.has(commit);
    const remote = changes.source === 'remote' || changes.source === 'refused' || ignored;
    const reading = this.#values.readChange(changes, this.#options.rowsReadAtOnce, !remote);
    if (reading === null) {
      // The whole document replaced: nothing of it is sent
      this.#closeOpen();
      return;
    }
    const change = remote ? null : toChange(changes, this.#store);
    if (!change) {
      reading.release();
      return;
    }
    let entry = this.#open;
    if (!entry || entry.commit !== change.commit) {
      this.#closeOpen();
      // A notification of a commit complete but not read yet joins it
      const unread = this.#entries.find(
        (one) => one.commit === change.commit && one.stage === 'local' && one.readings.length > 0,
      );
      if (unread) {
        unread.readings.push(reading);
        return;
      }
      const taken = change.source === 'undo' || change.source === 'redo';
      entry = {
        seq: ++this.#seq,
        commit: change.commit,
        ...(taken && { origin: this.#options.originOf?.(change.commit) }),
        label: change.label,
        writtenAtMilliseconds: Date.now(),
        readings: [],
        open: true,
        stage: 'local',
        waiters: [],
        operations: null,
        inverse: [],
        batches: null,
      };
      this.#entries.push(entry);
      this.#open = entry;
      this.#changed();
    }
    entry.readings.push(reading);
    this.#watchOpen();
  }

  /** Completes the open commit once no write over several tasks is under way */
  #watchOpen(): void {
    if (this.#watching) return;
    this.#watching = true;
    const look = (): void => {
      if (this.#stopped || this.#open === null) {
        this.#watching = false;
        return;
      }
      if (this.#store.slicedWritePending) {
        setTimeout(look, 0);
        return;
      }
      this.#watching = false;
      this.#closeOpen();
    };
    queueMicrotask(look);
  }

  /** Completes the open commit: no notification of it comes after */
  #closeOpen(): void {
    const entry = this.#open;
    if (!entry) return;
    entry.open = false;
    this.#open = null;
    // Read and sent from a later task: not in the task of the commit
    if (!this.#running) setTimeout(() => void this.#run(), 0);
  }

  /**
   * Sends the complete commits, one at a time in their order. With an outbox, every complete
   * commit is first read, cut and put in it (`stored`), sent or not
   */
  async #run(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (;;) {
        if (this.#stopped) return;
        const entry = this.#entries.find((one) => !reached(one.stage, 'accepted'));
        if (!entry || entry.open) return;
        if (this.#outbox) {
          for (const one of [...this.#entries]) {
            if (one.open || this.#stopped) break;
            if (!one.batches && !reached(one.stage, 'accepted')) await this.#prepare(one);
          }
        } else if (!entry.batches) {
          await this.#prepare(entry);
        }
        if (this.#stopped || this.#closed || this.#paused) return;
        // Refused meanwhile (a commit it depends on), or taken by another run
        if (!this.#entries.includes(entry) || reached(entry.stage, 'accepted')) continue;
        const batches = entry.batches ?? [];
        if (batches.length === 0) {
          // Nothing of the document to save
          this.#reach(entry, this.#stages[this.#stages.length - 1]);
          continue;
        }
        await this.#send(entry, batches);
      }
    } finally {
      this.#running = false;
    }
  }

  /** Reads and cuts a commit, and puts its batches in the outbox (then it is `stored`) */
  async #prepare(entry: Entry): Promise<void> {
    const operations = entry.operations ?? (await this.#read(entry));
    if (this.#stopped || entry.batches) return;
    const batches = operations.length === 0 ? [] : await this.#cut(entry, operations);
    if (this.#stopped || entry.batches) return;
    entry.batches = batches;
    const outbox = this.#outbox;
    if (!outbox || batches.length === 0) return;
    try {
      for (const batch of batches) await outbox.put(batch);
    } catch (error) {
      // Not kept on the device: it is sent all the same
      this.#options.onFailed?.({
        error: failureOf(error),
        label: entry.label,
        commit: entry.commit,
        count: 1,
      });
      return;
    }
    if (this.#stopped || !this.#entries.includes(entry)) return;
    if (!reached(entry.stage, 'stored')) this.#reach(entry, 'stored');
  }

  /**
   * The operations of a commit, its notifications read to their end, a step a task; what takes it
   * back is read with them (the inverse of its last notification first)
   */
  async #read(entry: Entry): Promise<ValueOperation[]> {
    const operations: ValueOperation[] = [];
    const inverses: ValueOperation[][] = [];
    for (const reading of entry.readings) {
      while (!reading.step(performance.now() + STEP_MS)) {
        await nextTask();
        if (this.#stopped) return [];
      }
      for (const operation of reading.operations()) operations.push(operation);
      inverses.push(reading.inverse());
      reading.release();
    }
    entry.readings.length = 0;
    entry.operations = operations;
    entry.inverse = inverses.reverse().flat();
    for (const ids of entry.renames ?? []) this.#renameEntry(entry, ids);
    entry.renames = undefined;
    this.#followKept(entry);
    return entry.operations;
  }

  /**
   * Shows what the storage shows once it applies a commit read, should something be kept (see
   * `kept.ts`), in a transaction from elsewhere: the features it made whose IDs the storage keeps
   * are not deleted by taking it back
   */
  #followKept(entry: Entry): void {
    if (this.#values.kept.empty || !entry.operations) return;
    const operations = entry.operations;
    const kept = this.#store.transact(
      () => followCommit(this.#store, this.#values, operations),
      'remote',
    );
    if (kept.size === 0) return;
    entry.inverse = entry.inverse.flatMap((operation) => {
      if (operation.type !== 'delete' || operation.kind !== 'feature') return [operation];
      const ids = operation.ids.filter((id) => !kept.has(id));
      return ids.length > 0 ? [{ ...operation, ids }] : [];
    });
  }

  /** The batches of a commit, cut a step a task */
  async #cut(entry: Entry, operations: readonly ValueOperation[]): Promise<ValueBatch[]> {
    const cutting = batchesInSteps(
      {
        commit: entry.commit,
        label: entry.label,
        writtenAtMilliseconds: entry.writtenAtMilliseconds,
      },
      operations,
      this.#backend.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES,
    );
    let deadline = performance.now() + STEP_MS;
    let next = cutting.next();
    while (!next.done) {
      if (performance.now() >= deadline) {
        await nextTask();
        deadline = performance.now() + STEP_MS;
      }
      next = cutting.next();
    }
    return next.value;
  }

  /** Sends the parts of a commit in their order, each again until it is answered */
  async #send(entry: Entry, batches: readonly ValueBatch[]): Promise<void> {
    const retry = this.#backend.retry;
    let attempt = 0;
    for (let index = 0; index < batches.length; ) {
      const batch = batches[index];
      const last = index === batches.length - 1;
      let answer: Answer;
      try {
        answer = await this.#backend.send(batch, this.#task());
        if (!ANSWERS.has((answer as { status?: unknown } | undefined)?.status)) {
          throw new DrawError('invalidState', 'The storage gave an answer of no known status');
        }
        if (answer.status === 'partial' && last) {
          throw new DrawError('invalidState', 'The storage answered partial to the last part');
        }
      } catch (thrown) {
        this.#setSending(null);
        if (this.#stopped) return;
        attempt++;
        const error = failureOf(thrown);
        const aged =
          retry?.maxAgeMilliseconds !== undefined &&
          Date.now() - entry.writtenAtMilliseconds >= retry.maxAgeMilliseconds;
        if ((retry?.maxAttempts !== undefined && attempt >= retry.maxAttempts) || aged) {
          await this.#refuse(entry, index > 0, 'retryLimit', error.message, true);
          return;
        }
        const delay = (this.#options.retryDelay ?? defaultRetryDelay)(attempt);
        this.#connection = {
          state: 'offline',
          attempt,
          nextRetryAtMilliseconds: Date.now() + delay,
          error,
        };
        this.#changed();
        await this.#wait(delay);
        if (this.#stopped) return;
        continue;
      }
      this.#setSending(null);
      if (this.#stopped) return;
      this.#online();
      attempt = 0;
      switch (answer.status) {
        case 'partial':
          index++;
          break;
        case 'accepted':
          if (!last) {
            index++;
            break;
          }
          for (const skipped of answer.skipped ?? []) {
            this.#options.onSkipped({
              error: new DrawError('refused', `The storage left out edits: ${skipped.reason}`, {
                ids: skipped.ids,
              }),
              label: entry.label,
              commit: entry.commit,
              count: skipped.ids.length,
            });
          }
          this.#savedAt = Date.now();
          this.#unkeep(
            batches.map((one) => one.id),
            entry.label,
            entry.commit,
          );
          if (answer.reassigned) this.#reassign(answer.reassigned);
          this.#reach(
            entry,
            answer.durable === true && this.#stages.includes('durable') ? 'durable' : 'accepted',
          );
          return;
        case 'refused':
          await this.#refuse(entry, index > 0, answer.reason, answer.message, answer.retryable);
          return;
        case 'closed':
          this.#close(answer.reason, answer.message);
          return;
      }
    }
  }

  /** The task given to a call of the storage */
  #task(): Task {
    return {
      signal: this.#controller.signal,
      onProgress: (progress) => this.#setSending(progress),
    };
  }

  /** Waits before a batch is sent again (less when a save asks for it, or once stopped) */
  #wait(milliseconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, milliseconds);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.#wake = () => {
        this.#wake = null;
        done();
      };
    }).finally(() => {
      this.#wake = null;
    });
  }

  /** A commit brought to a stage: the saves waiting for it settle */
  #reach(entry: Entry, stage: SaveStage): void {
    entry.stage = stage;
    if (reached(stage, 'accepted')) this.#pruneReceipts();
    for (let i = entry.waiters.length - 1; i >= 0; i--) {
      const waiter = entry.waiters[i];
      if (!reached(stage, waiter.until)) continue;
      entry.waiters.splice(i, 1);
      waiter.resolve();
    }
    if (stage === this.#stages[this.#stages.length - 1]) this.#forget(entry);
    this.#changed();
  }

  /**
   * A commit refused: it is taken out of the document with the later commits that depend on it,
   * the saves waiting for them fail, and the commits after it are sent on
   */
  async #refuse(
    entry: Entry,
    partly: boolean,
    reason: RefuseReason,
    message: string | undefined,
    retryable: boolean | undefined,
  ): Promise<void> {
    if (partly && this.#backend.abandon) {
      try {
        await this.#backend.abandon(entry.commit, this.#task());
      } catch {
        // Nothing of the commit is applied before its last part: the parts kept do no harm
      }
    }
    if (this.#stopped) return;
    // The later commits, read to their end: those that name what it created go with it
    this.#store.finishSlicedWrite();
    for (;;) {
      this.#closeOpen();
      const unread = this.#entries.find((one) => one !== entry && one.operations === null);
      if (!unread) break;
      await this.#read(unread);
      if (this.#stopped) return;
    }
    const later = this.#entries.filter((one) => one !== entry && !reached(one.stage, 'accepted'));
    const dependents = dependentsOf(entry as CommitOperations, later as CommitOperations[]).map(
      (i) => later[i],
    );
    const refused = [entry, ...dependents];
    // What was received after it is taken back and written again with the later commits
    const receipts = this.#receipts.filter((one) => one.seq > entry.seq);
    const commits = [...later, ...receipts].sort((a, b) => a.seq - b.seq);
    const { failed, written } = this.#store.transact(
      () =>
        takeOut(
          this.#store,
          this.#values,
          [entry, ...commits] as CommitOperations[],
          new Set<CommitOperations>(refused as CommitOperations[]),
        ),
      'refused',
    );
    if (failed.length > 0) {
      this.#options.onSkipped({
        error: new DrawError(
          'invalidState',
          `The take-out of the refused commit left out ${failed.length} writes the Store refused`,
          { cause: failed[0] },
        ),
        label: entry.label,
        commit: entry.commit,
        count: failed.length,
      });
    }
    const now = Date.now();
    for (const one of refused) {
      const first = one === entry;
      const refusal = this.#record(
        one,
        first ? reason : 'dependsOnRefused',
        first ? message : undefined,
        first && retryable === true,
        now,
      );
      const error = new DrawError(
        'refused',
        (first ? message : undefined) ??
          `The storage refused the commit ${one.commit}: ${refusal.reason}`,
        { refusal },
      );
      this.#refused.set(one.commit, error);
      this.#forget(one);
      for (const waiter of one.waiters.splice(0)) waiter.reject(error);
      this.#refusals.push({
        refusal,
        operations: one.operations ?? [],
        batchIds: (one.batches ?? []).map((batch) => batch.id),
      });
      one.inverse = [];
      if (this.#outbox) void this.#keep(one, refusal);
    }
    this.#refusalsValue.set(Object.freeze(this.#refusals.map((one) => one.refusal)));
    const steps = new Map<string, StepWrite | null>();
    for (const one of written) {
      if (one.commit === undefined) continue;
      steps.set(one.commit, one.inverse.length > 0 ? this.#stepWrite(one.inverse) : null);
    }
    this.#options.onTakenOut?.(new Set(refused.map((one) => one.commit)), steps);
    this.#changed();
  }

  /**
   * What writes operations that take a commit back, as a step of undo: a commit of this client
   * (as a retry), whose items take keys of their own, and whose writes under a container not there
   * are left out, not kept as the storage would keep them
   */
  #stepWrite(operations: readonly ValueOperation[]): StepWrite {
    return {
      write: () => {
        writeOperations(this.#store, this.#values, operations, false, new KeptRecords());
      },
      renamed: (ids) => this.#stepWrite(renamedOperations(operations, ids)),
    };
  }

  /**
   * Gives features the IDs the storage gave them (`Answer.accepted.reassigned`): the rows keep
   * their references (`changeIds`), the features of objects are created again under their new IDs
   * where they are and deleted under the old. What this client holds of them, the steps of undo,
   * the commits not sent and the refusals go on with them, those deleted here before the answer
   * came included (only the Store has nothing to write of them)
   */
  #reassign(given: Readonly<Record<string, string>>): void {
    const store = this.#store;
    const pairs = new Map<string, string>();
    const taken = new Set<string>();
    for (const [from, to] of Object.entries(given)) {
      if (typeof to !== 'string' || from === to || taken.has(to)) continue;
      // An ID a feature here has already is given to none
      if (store.getFeature(to)) continue;
      pairs.set(from, to);
      taken.add(to);
    }
    if (pairs.size === 0) return;
    // What is kept of them goes on under their new IDs
    const kept = this.#values.kept;
    const placements = new Map(
      [...pairs].map(([from, to]) => [to, kept.placements.get(from)] as const),
    );
    const there = new Map([...pairs].filter(([from]) => store.getFeature(from) !== undefined));
    if (there.size > 0) {
      const values = this.#values;
      const renameRows = rowRenamesOf(store);
      store.reassign(there, (follow) => {
        if (renameRows) {
          renameRows([...there]);
          follow();
          return;
        }
        const created: ValueOperation[] = [];
        for (const [from, to] of there) {
          const record = values.recordOf('feature', from);
          if (record) created.push({ type: 'create', kind: 'feature', id: to, record });
        }
        writeOperations(store, values, created);
        follow();
        writeOperations(store, values, [
          { type: 'delete', kind: 'feature', ids: [...there.keys()] },
        ]);
      });
    }
    kept.rename(pairs);
    for (const [to, keys] of placements) if (keys) kept.placements.set(to, keys);
    this.#values.followIds(pairs);
    for (const entry of this.#entries) {
      if (entry.operations === null) entry.renames = [...(entry.renames ?? []), pairs];
      else this.#renameEntry(entry, pairs);
    }
    this.#refusals = this.#refusals.map((one) => ({
      refusal: one.refusal,
      operations: renamedOperations(one.operations, pairs),
      batchIds: one.batchIds,
    }));
    this.#options.onReassigned?.(pairs);
  }

  /** The operations of a commit with the features named by the IDs given them */
  #renameEntry(entry: Entry, ids: ReadonlyMap<string, string>): void {
    if (entry.operations) entry.operations = renamedOperations(entry.operations, ids);
    entry.inverse = renamedOperations(entry.inverse, ids);
    // Cut again with the new IDs, before it is sent (the batches of the same IDs put again)
    const before = entry.batches;
    if (!before || before.length === 0 || reached(entry.stage, 'accepted')) return;
    const cutting = batchesInSteps(
      {
        commit: entry.commit,
        label: entry.label,
        writtenAtMilliseconds: entry.writtenAtMilliseconds,
      },
      entry.operations ?? [],
      this.#backend.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES,
    );
    let next = cutting.next();
    while (!next.done) next = cutting.next();
    entry.batches = next.value;
    const outbox = this.#outbox;
    if (!outbox) return;
    const now = new Set(entry.batches.map((batch) => batch.id));
    const batches = entry.batches;
    void (async () => {
      try {
        for (const batch of batches) await outbox.put(batch);
      } catch (error) {
        this.#options.onFailed?.({
          error: failureOf(error),
          label: entry.label,
          commit: entry.commit,
          count: 1,
        });
      }
    })();
    this.#unkeep(
      before.map((batch) => batch.id).filter((id) => !now.has(id)),
      entry.label,
      entry.commit,
    );
  }

  /**
   * Keeps a refusal in the outbox, with the batches of its commit (put now when they were not):
   * a later `draw.open()` gives it back, with what the commit did
   */
  async #keep(entry: Entry, refusal: Refusal): Promise<void> {
    const outbox = this.#outbox;
    if (!outbox) return;
    try {
      if (!entry.batches) {
        const batches = await this.#cut(entry, entry.operations ?? []);
        for (const batch of batches) await outbox.put(batch);
        const kept = this.#refusals.find((one) => one.refusal === refusal);
        if (kept) {
          const at = this.#refusals.indexOf(kept);
          this.#refusals[at] = { ...kept, batchIds: batches.map((batch) => batch.id) };
        }
      }
      await outbox.keep(refusal);
    } catch (error) {
      this.#options.onFailed?.({
        error: failureOf(error),
        label: entry.label,
        commit: entry.commit,
        count: 1,
      });
    }
  }

  /** The record of a commit refused */
  #record(
    entry: Entry,
    reason: RefuseReason,
    message: string | undefined,
    retryable: boolean,
    refusedAt: number,
  ): Refusal {
    const ids = new Set<string>();
    for (const operation of entry.operations ?? []) {
      if (operation.type === 'create') ids.add(operation.id);
      else if (operation.kind !== 'document' && operation.kind !== 'file') {
        for (const id of operation.ids) ids.add(id);
      }
    }
    const list = [...ids];
    return Object.freeze({
      id: `refusal-${this.#nextRefusal++}`,
      commit: entry.commit,
      ids: Object.freeze(list.slice(0, REFUSAL_IDS)),
      count: list.length,
      label: entry.label,
      reason,
      message,
      retryable,
      writtenAtMilliseconds: entry.writtenAtMilliseconds,
      refusedAtMilliseconds: refusedAt,
    });
  }

  /** The connection closed by the storage: nothing more is sent, the saves waiting fail */
  #close(reason: CloseReason, message: string | undefined): void {
    const error = new DrawError(
      reason === 'credential' || reason === 'permission' ? reason : 'network',
      message ?? `The storage closed the connection: ${reason}`,
    );
    this.#closed = { reason, error };
    this.#connection = { state: 'closed', reason, error };
    for (const entry of this.#entries) {
      for (const waiter of entry.waiters.splice(0)) waiter.reject(error);
    }
    this.#changed();
  }

  /** Online again once the storage answers */
  #online(): void {
    if (this.#connection.state === 'online') return;
    this.#connection = { state: 'online', sinceMilliseconds: Date.now() };
    this.#changed();
  }

  #forget(entry: Entry): void {
    const at = this.#entries.indexOf(entry);
    if (at >= 0) this.#entries.splice(at, 1);
    this.#pruneReceipts();
  }

  #setSending(progress: Progress | null): void {
    if (this.#sending === progress) return;
    this.#sending = progress;
    this.#changed();
  }

  // ==========================================================================
  // The state
  // ==========================================================================

  #changed(): void {
    const saving = this.#savingNow();
    if (!sameSaving(saving, this.#saving)) this.#saving = saving;
    // What the sending says comes first (sent again, closed by an answer); then what the storage
    // told
    const sending = this.#connection;
    this.#shown = sending.state !== 'online' || !this.#reported ? sending : this.#reported;
    this.#options.onChange();
  }

  #savingNow(): SaveState {
    let stage = this.#stages[this.#stages.length - 1];
    let unsaved = 0;
    for (const entry of this.#entries) {
      if (STAGES.indexOf(entry.stage) < STAGES.indexOf(stage)) stage = entry.stage;
      if (!reached(entry.stage, 'accepted')) unsaved++;
    }
    return {
      stage,
      stages: this.#stages,
      unsaved,
      refused: this.#refusals.length,
      savedAtMilliseconds: this.#savedAt,
      sending: this.#transfer ?? this.#sending,
    };
  }
}

/** Operations with the features named by the IDs given them, from the old to the new */
function renamedOperations(
  operations: readonly ValueOperation[],
  ids: ReadonlyMap<string, string>,
): ValueOperation[] {
  const renamed = (id: string): string => ids.get(id) ?? id;
  return operations.map((operation) => {
    if (operation.kind !== 'feature') return operation;
    if (operation.type === 'create') return { ...operation, id: renamed(operation.id) };
    return { ...operation, ids: operation.ids.map(renamed) } as ValueOperation;
  });
}

/**
 * The stages a commit goes through with a storage: `local` and `accepted`, `stored` with an outbox,
 * and `durable` when it gives it
 */
function stagesOf(backend: Backend): readonly SaveStage[] {
  const given = new Set<SaveStage>(['local', 'accepted', ...(backend.stages ?? [])]);
  // Kept on the device only with an outbox
  if (backend.outbox) given.add('stored');
  else given.delete('stored');
  return Object.freeze(STAGES.filter((stage) => given.has(stage)));
}

/** Whether a stage is at least another */
function reached(stage: SaveStage, until: SaveStage): boolean {
  return STAGES.indexOf(stage) >= STAGES.indexOf(until);
}

function sameSaving(a: SaveState, b: SaveState): boolean {
  return (
    a.stage === b.stage &&
    a.unsaved === b.unsaved &&
    a.refused === b.refused &&
    a.savedAtMilliseconds === b.savedAtMilliseconds &&
    a.sending === b.sending
  );
}

/** What `send` threw, as a failure of the network unless it is one of the library */
function failureOf(thrown: unknown): DrawError {
  if (thrown instanceof DrawError) return thrown;
  return new DrawError('network', `The storage could not be reached: ${String(thrown)}`, {
    cause: thrown,
  });
}

function abortedSave(): DrawError {
  return new DrawError('aborted', 'The save was stopped by its signal');
}

function removed(): DrawError {
  return new DrawError('invalidState', 'The instance was removed');
}

/** Settles in a later task */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
