// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The document of an instance opened from its storage, and closed: `draw.open()` reads it from the
 * storage (`Backend.load`), connects the storage (`Backend.connect`) and sends on what its outbox
 * kept; `draw.close` and `draw.remove` say what becomes of the commits not sent. What a storage
 * writes to the instance goes through `BackendContext`: what it received from elsewhere, written
 * over several tasks while the reads give the document before it and `change` is told once
 *
 * @internal
 */

import { DrawError } from '../../shared/draw-error.js';
import { createId } from '../../shared/utils/id.js';
import { runCommit, withCommit } from '../../store/commit-scope.js';
import type { Store } from '../../store/store.js';
import type { DrawReader } from '../draw.js';
import type { History } from '../impl/history.js';
import { NATIVE_VERSION } from '../impl/import-export/constants.js';
import type { ProblemInput } from '../impl/status.js';
import { WRITE_SOURCE_NO_UNDO, type Writer } from '../impl/write.js';
import type { DrawDocument } from '../model.js';
import type { Connection, DocumentState, SaveStage } from '../status.js';
import type {
  CloseOptions,
  CloseResult,
  ImportSource,
  OpenOptions,
  OpenResult,
  OpenSource,
  Progress,
  TaskOptions,
} from '../write.js';
import type { Backend, BackendContext, BackendReport, Received, Task } from './backend.js';
import type { Sender } from './sender.js';
import { writeOperations } from './store-writes.js';
import type { ValueOperation } from './values.js';

/** The time of one step of a receipt written over several tasks (ms) */
const STEP_MS = 8;

/**
 * How much is written at once in a step of a receipt, counted in what the operations name (one a
 * creation, the IDs of the others): more than the rows put in a place whose moves a Store of rows
 * tells one at a time (`ORDER_ITEM_LIMIT`), which reads the items of the layer around each write,
 * so that a large receipt is not as many reads of the layer
 */
const STEP_WEIGHT = 1024;

/** The most IDs of one operation written at once (a larger one is cut) */
const STEP_IDS = 1024;

const OPEN: DocumentState = Object.freeze({ state: 'open' });
const CLOSED: DocumentState = Object.freeze({ state: 'closed' });

/** A document with nothing in it: what is left once the document is closed */
const EMPTY: DrawDocument = { version: NATIVE_VERSION, layerOrder: [], features: [] };

/** The keys of the options of `draw.open` (an object with only them is no source) */
const OPEN_OPTION_KEYS: ReadonlySet<string> = new Set(['signal', 'onProgress', 'unsent']);

/**
 * Whether what `draw.open` is given first is its options (no source): nothing, or a plain object
 * with only the keys of the options
 *
 * @internal
 */
export function isOpenOptions(value: unknown): value is OpenOptions | undefined {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.keys(value).every((key) => OPEN_OPTION_KEYS.has(key));
}

/**
 * What the document of an instance is made with
 *
 * @internal
 */
export interface SessionDeps {
  readonly store: Store;
  readonly backend: Backend | undefined;
  readonly writer: Writer;
  readonly history: History;
  /** The instance, as a storage reads it */
  readonly draw: () => DrawReader;
  /** Makes what sends the commits to the storage (again, once the document is closed) */
  readonly makeSender: (backend: Backend) => Sender;
  /** Tells that the state changed */
  readonly changed: () => void;
  /** Keeps a problem nobody waits for */
  readonly problem: (problem: ProblemInput) => void;
}

/**
 * The document of an instance and its storage: opened, closed, and written by the storage
 *
 * @internal
 */
export class DocumentSession {
  readonly #deps: SessionDeps;
  #sender: Sender | null;
  #document: DocumentState = OPEN;
  /** Settles once the document under way is open (or failed to) */
  #opening: Promise<void> | null = null;
  /** Settles once the document read from the storage is written (what a receipt waits for) */
  #written: Promise<void> | null = null;
  /** What cuts the connection of the storage */
  #disconnect: (() => void) | null = null;
  #closedConnection: Connection | null = null;
  #removed = false;
  /** Aborts what the storage is asked for (the instance removed) */
  readonly #controller = new AbortController();
  readonly context: BackendContext;

  constructor(deps: SessionDeps) {
    this.#deps = deps;
    this.#sender = deps.backend ? deps.makeSender(deps.backend) : null;
    this.context = this.#makeContext();
  }

  /** What sends the commits to the storage (null without one) */
  get sender(): Sender | null {
    return this.#sender;
  }

  get document(): DocumentState {
    return this.#document;
  }

  /** The connection: closed by this client once the document is closed */
  connection(fallback: Connection): Connection {
    if (!this.#deps.backend) return fallback;
    return this.#closedConnection ?? this.#sender?.connection ?? fallback;
  }

  /** Whether the document can be written for the state of the document and the storage */
  get editable(): boolean {
    return this.#document.state === 'open' && (this.#sender?.editable ?? true);
  }

  /** What a write waits for (the document opening), or fails with (the document closed) */
  gate(): Promise<void> | null {
    if (this.#opening) return this.#opening.then(() => this.#gateAfter() ?? undefined);
    return this.#gateAfter();
  }

  #gateAfter(): Promise<void> | null {
    if (this.#document.state === 'closed') {
      return Promise.reject(new DrawError('invalidState', 'The document is closed'));
    }
    return null;
  }

  // ==========================================================================
  // Opening
  // ==========================================================================

  /** `draw.open`: from a source, or from the storage */
  open(first: OpenSource | OpenOptions | undefined, second?: OpenOptions): Promise<OpenResult> {
    if (isOpenOptions(first)) return this.#openFromStorage(first);
    return this.#openSource(first as OpenSource, second);
  }

  /** Replaces the document with a source, once the commits not sent are seen to */
  async #openSource(source: OpenSource, options: OpenOptions | undefined): Promise<OpenResult> {
    if (this.#opening) throw opening();
    const sender = this.#sender;
    if (sender) await this.#settleUnsent(sender, options);
    const { writer, history } = this.#deps;
    const result = await writer.open(source, options);
    history.clear();
    if (this.#document.state !== 'open') {
      this.#document = OPEN;
      this.#closedConnection = null;
      this.#deps.changed();
    }
    return result;
  }

  /** What `unsent` says of the commits not sent and the refusals, when a source replaces them */
  async #settleUnsent(sender: Sender, options: OpenOptions | undefined): Promise<void> {
    if (sender.unsent === 0 && sender.refusals.value.length === 0) return;
    switch (options?.unsent) {
      case undefined:
        throw new DrawError(
          'unsentWrites',
          'Commits are not sent or refusals not dismissed: say what becomes of them (unsent)',
        );
      case 'wait':
        await this.#waitAccepted(sender, options);
        return;
      case 'keep': {
        if (!sender.keeps) {
          throw new DrawError('invalidState', 'The storage has no outbox to keep them in');
        }
        // Kept on the device, sent on by the next opening from the storage
        await sender.storeAll();
        this.#replaceSender(sender);
        return;
      }
      case 'discard':
        await sender.discard();
        return;
      default:
        throw new DrawError('invalidInput', 'unsent must be wait, keep or discard');
    }
  }

  /** A sender in place of one that stops (what it kept stays in the outbox) */
  #replaceSender(sender: Sender): void {
    sender.stop();
    const backend = this.#deps.backend as Backend;
    this.#sender = this.#deps.makeSender(backend);
    this.#deps.changed();
  }

  /** Reads the document from the storage, connects it, and sends on what the outbox kept */
  async #openFromStorage(options: OpenOptions | undefined): Promise<OpenResult> {
    const backend = this.#deps.backend;
    if (!backend)
      throw new DrawError('invalidState', 'There is no storage to open the document from');
    if (this.#opening) throw opening();
    if (options?.unsent !== undefined && !['wait', 'keep', 'discard'].includes(options.unsent)) {
      throw new DrawError('invalidInput', 'unsent must be wait, keep or discard');
    }
    const signal = options?.signal;
    if (signal?.aborted) throw aborted();
    let open!: () => void;
    let written!: () => void;
    this.#opening = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.#written = new Promise<void>((resolve) => {
      written = resolve;
    });
    // A document closed is opened by a new sender: the one before stopped
    if (this.#document.state === 'closed' || !this.#sender) {
      this.#sender = this.#deps.makeSender(backend);
    }
    const sender = this.#sender;
    sender.pause();
    this.#setDocument({ state: 'opening', progress: null, viewReady: false });
    try {
      const task = this.#task(signal, (progress) => {
        options?.onProgress?.(progress);
        if (this.#document.state === 'opening') {
          this.#setDocument({ state: 'opening', progress, viewReady: false });
        }
      });
      const source = await backend.load(task);
      if (signal?.aborted || this.#removed) throw aborted();
      const outbox = backend.outbox;
      // Read once the document is written: a sender that holds nothing yet takes it
      const fresh = sender.unsent === 0 && sender.refusals.value.length === 0;
      const kept =
        outbox && fresh
          ? { batches: await outbox.list(task), refusals: await outbox.refusals(task) }
          : null;
      if (signal?.aborted || this.#removed) throw aborted();
      this.#disconnectNow();
      const result = await this.#replaceWith(sender, source, signal);
      if (kept) sender.restore(kept.batches, kept.refusals, this.#writeKept);
      written();
      this.#closedConnection = null;
      if (backend.connect) {
        sender.report({ connection: { state: 'connecting', attempt: 1 } });
        this.#disconnect = await backend.connect(
          this.context,
          this.#task(undefined, () => {}),
        );
      }
      if (this.#removed) throw aborted();
      this.#setDocument(OPEN);
      sender.resume();
      return result;
    } catch (thrown) {
      const error =
        thrown instanceof DrawError
          ? thrown
          : new DrawError('network', `The document could not be read: ${String(thrown)}`, {
              cause: thrown,
            });
      if (!this.#removed) {
        this.#setDocument({ state: 'failed', error });
        sender.resume();
      }
      throw error;
    } finally {
      written();
      open();
      this.#opening = null;
      this.#written = null;
    }
  }

  /**
   * Replaces the document with what the storage gave (not sent): the steps of undo dropped, what
   * was kept aside dropped, and the commits of this client not accepted written again over it
   */
  async #replaceWith(
    sender: Sender,
    source: ImportSource,
    signal: AbortSignal | undefined,
  ): Promise<OpenResult> {
    const { writer, history } = this.#deps;
    await sender.readAll();
    const id = createId();
    sender.ignore(id);
    const result = await writer.open(source, { signal }, { id, fromStorage: true });
    history.clear();
    sender.values.kept.clear();
    sender.writeAgain(this.#writeKept);
    return result;
  }

  /** Writes a commit of this client again, as it was (not sent again, no step of undo) */
  readonly #writeKept = (commit: string, label: string | undefined, write: () => void): void => {
    const store = this.#deps.store;
    store.fromStorage(() =>
      runCommit(store, { id: commit, label, undo: false }, WRITE_SOURCE_NO_UNDO, write),
    );
  };

  // ==========================================================================
  // Closing
  // ==========================================================================

  /** `draw.close` */
  async close(options: CloseOptions | undefined): Promise<CloseResult> {
    const unsentMode = options?.unsent ?? 'wait';
    if (!['wait', 'keep', 'discard'].includes(unsentMode)) {
      throw new DrawError('invalidInput', 'unsent must be wait, keep or discard');
    }
    const signal = options?.signal;
    if (signal?.aborted) throw aborted();
    if (this.#opening) await this.#opening;
    if (this.#document.state === 'closed') return { unsent: 0, refused: 0, kept: true };
    const sender = this.#sender;
    let result: CloseResult = { unsent: 0, refused: 0, kept: true };
    if (sender) {
      if (unsentMode === 'keep' && !sender.keeps) {
        throw new DrawError('invalidState', 'The storage has no outbox to keep the commits in');
      }
      if (unsentMode === 'wait') await this.#waitAccepted(sender, options);
      if (signal?.aborted) throw aborted();
      const unsent = sender.unsent;
      const refused = sender.refusals.value.length;
      if (unsentMode === 'keep') {
        await sender.storeAll();
        result = { unsent, refused, kept: true };
      } else if (unsentMode === 'discard') {
        await sender.discard();
        result = { unsent, refused, kept: unsent + refused === 0 };
      } else {
        result = { unsent, refused, kept: refused === 0 || sender.keeps };
      }
      // What the outbox is asked to keep and to let go of is written before the next opening reads it
      await sender.outboxWritten();
      sender.stop();
    }
    this.#disconnectNow();
    // The document emptied, as nothing of it is open
    const { writer, history } = this.#deps;
    await writer.open(EMPTY, undefined, { id: createId(), fromStorage: true });
    history.clear();
    this.#closedConnection = Object.freeze({
      state: 'closed',
      reason: 'closedByClient',
      error: new DrawError('invalidState', 'The document was closed'),
    }) as Connection;
    this.#setDocument(CLOSED);
    return result;
  }

  /** `draw.remove`: what is lost of the commits not sent, before the instance is destroyed */
  remove(): CloseResult {
    const sender = this.#sender;
    if (!sender) return { unsent: 0, refused: 0, kept: true };
    const unsent = sender.unsent;
    const refused = sender.refusals.value.length;
    return { unsent, refused, kept: unsent + refused === 0 || sender.kept };
  }

  /** Lets go of everything (the instance is destroyed) */
  stop(): void {
    this.#removed = true;
    this.#controller.abort();
    this.#disconnectNow();
    this.#sender?.stop();
  }

  /** Settles once every commit not sent is accepted (or refused) */
  async #waitAccepted(sender: Sender, options: TaskOptions | undefined): Promise<void> {
    try {
      await sender.waitAccepted(options?.signal);
    } catch (error) {
      if (error instanceof DrawError && error.code === 'aborted') throw error;
      // A commit refused stays a refusal
    }
  }

  #disconnectNow(): void {
    const disconnect = this.#disconnect;
    this.#disconnect = null;
    if (!disconnect) return;
    try {
      disconnect();
    } catch (error) {
      this.#deps.problem({
        type: 'failed',
        error: asDrawError(error),
        label: undefined,
        commit: null,
        count: 1,
      });
    }
  }

  #setDocument(state: DocumentState): void {
    this.#document = state;
    this.#deps.changed();
  }

  /** A task for the storage: stopped by its signal, or once the instance is removed */
  #task(signal: AbortSignal | undefined, onProgress: (progress: Progress) => void): Task {
    return {
      signal: signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal,
      onProgress,
    };
  }

  // ==========================================================================
  // What the storage writes
  // ==========================================================================

  #makeContext(): BackendContext {
    const deps = this.#deps;
    return {
      get draw() {
        return deps.draw();
      },
      receive: (result, options) => this.#receive(result, options),
      replace: (source, options) => this.#replace(source, options),
      advance: (commit: string, stage: SaveStage) => this.#sender?.advance(commit, stage),
      report: (report: BackendReport) => this.#sender?.report(report),
      key: (id: string) => {
        const values = this.#sender?.values;
        if (!values) return undefined;
        return (
          values.placeOf('feature', id)?.key ??
          values.placeOf('group', id)?.key ??
          values.placeOf('layer', id)?.key
        );
      },
    };
  }

  /**
   * Writes what the storage decided, in its order, over several tasks: the reads give the document
   * before it until it is written, and its change is told once, with the commit and the label
   * given
   */
  async #receive(result: Received, options: TaskOptions | undefined): Promise<void> {
    if (
      typeof result !== 'object' ||
      result === null ||
      !Array.isArray((result as { operations?: unknown }).operations)
    ) {
      throw new DrawError('invalidInput', 'What is received has operations');
    }
    if (options?.signal?.aborted) throw aborted();
    if (this.#written) await this.#written;
    const sender = this.#sender;
    if (!sender || this.#removed || this.#document.state === 'closed') {
      throw new DrawError('invalidState', 'The document is not open');
    }
    const { store } = this.#deps;
    const values = sender.values;
    const operations = cutOperations(result.operations);
    // While a commit of this client is not answered, what takes it back is kept with it
    const receipt = sender.receipt();
    const inverses: ValueOperation[][] = [];
    const info = { id: result.commit ?? createId(), label: result.label, undo: false };
    let at = 0;
    let failed = 0;
    await new Promise<void>((resolve, reject) => {
      store.writeInSteps(
        'remote',
        (deadline) => {
          // The notification goes out in a task of its own after a step that wrote: its readers (the
          // change, the names made) take long for many features
          if (at >= operations.length) return true;
          while (at < operations.length) {
            let end = at;
            let weight = 0;
            while (end < operations.length && weight < STEP_WEIGHT) {
              weight += weightOf(operations[end]);
              end++;
            }
            const part = operations.slice(at, end);
            at = end;
            const before = receipt ? values.namedBefore(part) : null;
            failed += writeOperations(store, values, part).failed.length;
            if (receipt && before) {
              for (const operation of part) receipt.operations.push(operation);
              inverses.push(values.inverseSince(before));
            }
            if (performance.now() >= deadline) break;
          }
          if (receipt) receipt.inverse = [...inverses].reverse().flat();
          // A step given no time (another write finishes it) ends now
          return at >= operations.length && deadline === Number.POSITIVE_INFINITY;
        },
        {
          budgetMs: STEP_MS,
          snapshot: true,
          around: (fn) => withCommit(store, info, fn),
          onEnd: (error) => (error === undefined ? resolve() : reject(error)),
        },
      );
    });
    if (failed > 0) {
      this.#deps.problem({
        type: 'skipped',
        error: new DrawError('invalidState', `The Store refused ${failed} writes received`),
        label: result.label,
        commit: info.id,
        count: failed,
      });
    }
  }

  /** Replaces the whole document with what the storage holds */
  async #replace(source: ImportSource, options: TaskOptions | undefined): Promise<void> {
    if (options?.signal?.aborted) throw aborted();
    if (this.#written) await this.#written;
    const sender = this.#sender;
    if (!sender || this.#removed || this.#document.state === 'closed') {
      throw new DrawError('invalidState', 'The document is not open');
    }
    await this.#replaceWith(sender, source, options?.signal);
  }
}

/** How much an operation names: one a creation, the IDs of the others */
function weightOf(operation: ValueOperation): number {
  if (operation.type === 'create' || operation.kind === 'document') return 1;
  return Math.max(1, operation.ids.length);
}

/** Operations with no more IDs each than a step writes at once */
function cutOperations(operations: readonly ValueOperation[]): ValueOperation[] {
  const out: ValueOperation[] = [];
  for (const operation of operations) {
    if (operation.type === 'create' || operation.kind === 'document' || operation.kind === 'file') {
      out.push(operation);
      continue;
    }
    const ids = operation.ids;
    if (ids.length <= STEP_IDS) {
      out.push(operation);
      continue;
    }
    for (let from = 0; from < ids.length; from += STEP_IDS) {
      const part = ids.slice(from, from + STEP_IDS);
      if (operation.type === 'place') {
        out.push({ ...operation, ids: part, keys: operation.keys.slice(from, from + STEP_IDS) });
      } else {
        out.push({ ...operation, ids: part } as ValueOperation);
      }
    }
  }
  return out;
}

function aborted(): DrawError {
  return new DrawError('aborted', 'Stopped by its signal');
}

function opening(): DrawError {
  return new DrawError('invalidState', 'The document is being opened');
}

function asDrawError(error: unknown): DrawError {
  return error instanceof DrawError
    ? error
    : new DrawError('invalidState', String(error), { cause: error });
}
