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
 * A commit refused stays in the document here; taking it out of the document is the work of
 * the refusals.
 *
 * @internal
 */

import { DrawError } from '../../shared/draw-error.js';
import type { Store } from '../../store/store.js';
import type { StoreChange } from '../../store/types.js';
import { toChange } from '../impl/events.js';
import type {
  CloseReason,
  Connection,
  RefuseReason,
  SaveGoal,
  SaveStage,
  SaveState,
} from '../status.js';
import type { Progress, SaveOptions } from '../write.js';
import type { Answer, Backend, Task } from './backend.js';
import { type ChangeReading, CommitValues } from './commit-values.js';
import { batchesInSteps } from './parts.js';
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
}

/** A save waiting for a commit to reach a stage */
interface Waiter {
  readonly until: SaveGoal;
  readonly resolve: () => void;
  readonly reject: (error: DrawError) => void;
}

/** A commit of this client, until it reaches the last stage */
interface Entry {
  readonly commit: string;
  readonly label: string | undefined;
  readonly writtenAtMilliseconds: number;
  /** The readings of its notifications, in their order */
  readonly readings: ChangeReading[];
  /** Whether a notification of it may still come */
  open: boolean;
  stage: SaveStage;
  readonly waiters: Waiter[];
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

  constructor(store: Store, backend: Backend, options: SenderOptions) {
    this.#store = store;
    this.#backend = backend;
    this.#options = options;
    this.#stages = stagesOf(backend);
    this.#values = new CommitValues(store);
    this.#connection = { state: 'online', sinceMilliseconds: Date.now() };
    this.#saving = this.#savingNow();
    this.#unsubscribe = store.subscribe((changes) => this.#follow(changes));
  }

  /** How far the commits are saved */
  get saving(): SaveState {
    return this.#saving;
  }

  /** The connection to the storage */
  get connection(): Connection {
    return this.#connection;
  }

  /** The stages a commit goes through */
  get stages(): readonly SaveStage[] {
    return this.#stages;
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
    const remote = changes.source === 'remote';
    // A notification from elsewhere is read for the places only: it is not sent back
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
      entry = {
        commit: change.commit,
        label: change.label,
        writtenAtMilliseconds: Date.now(),
        readings: [],
        open: true,
        stage: 'local',
        waiters: [],
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

  /** Sends the complete commits, one at a time in their order */
  async #run(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (;;) {
        if (this.#stopped || this.#closed) return;
        const entry = this.#entries.find((one) => one.stage === 'local');
        if (!entry || entry.open) return;
        const operations = await this.#read(entry);
        if (this.#stopped) return;
        if (operations.length === 0) {
          // Nothing of the document to save
          this.#reach(entry, this.#stages[this.#stages.length - 1]);
          continue;
        }
        const batches = await this.#cut(entry, operations);
        if (this.#stopped) return;
        await this.#send(entry, batches);
      }
    } finally {
      this.#running = false;
    }
  }

  /** The operations of a commit, its notifications read to their end, a step a task */
  async #read(entry: Entry): Promise<ValueOperation[]> {
    const operations: ValueOperation[] = [];
    for (const reading of entry.readings) {
      while (!reading.step(performance.now() + STEP_MS)) {
        await nextTask();
        if (this.#stopped) return [];
      }
      for (const operation of reading.operations()) operations.push(operation);
      reading.release();
    }
    entry.readings.length = 0;
    return operations;
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
          await this.#refuse(entry, index > 0, 'retryLimit', error.message);
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
          this.#reach(
            entry,
            answer.durable === true && this.#stages.includes('durable') ? 'durable' : 'accepted',
          );
          return;
        case 'refused':
          await this.#refuse(entry, index > 0, answer.reason, answer.message);
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
    for (let i = entry.waiters.length - 1; i >= 0; i--) {
      const waiter = entry.waiters[i];
      if (!reached(stage, waiter.until)) continue;
      entry.waiters.splice(i, 1);
      waiter.resolve();
    }
    if (stage === this.#stages[this.#stages.length - 1]) this.#forget(entry);
    this.#changed();
  }

  /** A commit refused: the saves waiting for it fail, and the commits after it are sent on */
  async #refuse(
    entry: Entry,
    partly: boolean,
    reason: RefuseReason,
    message: string | undefined,
  ): Promise<void> {
    if (partly && this.#backend.abandon) {
      try {
        await this.#backend.abandon(entry.commit, this.#task());
      } catch {
        // Nothing of the commit is applied before its last part: the parts kept do no harm
      }
    }
    const error = new DrawError(
      'refused',
      message ?? `The storage refused the commit ${entry.commit}: ${reason}`,
    );
    this.#refused.set(entry.commit, error);
    this.#forget(entry);
    for (const waiter of entry.waiters.splice(0)) waiter.reject(error);
    this.#changed();
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
      refused: this.#refused.size,
      savedAtMilliseconds: this.#savedAt,
      sending: this.#sending,
    };
  }
}

/** The stages a commit goes through with a storage: `local` and `accepted`, and those it gives */
function stagesOf(backend: Backend): readonly SaveStage[] {
  const given = new Set<SaveStage>(['local', 'accepted', ...(backend.stages ?? [])]);
  // A storage of the first shape has no outbox yet: nothing is kept on the device
  given.delete('stored');
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
