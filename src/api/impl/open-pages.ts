// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A document opened from pages of rows (`draw.open(pages)`, a storage whose `load` gives pages):
 * the features and the groups of the document are replaced, the layers stay, and the rows go into
 * the current layer, as `tx.import` puts them when it is given no layer. The pages are written as
 * they arrive, each at its place in the order of its keys; a row of a page whose ID a page before
 * gave takes its place (rows far apart first, then the pages that hold them)
 *
 * @internal
 */

import type { Page } from '@sakuzu/kasane';
import { type CommitInfo, runCommit } from '../../store/commit-scope.js';
import type { Store } from '../../store/store.js';
import { rowPagesOf } from '../../store/table-memory.js';
import { DrawError } from '../errors.js';
import type { OpenResult, Progress } from '../write.js';
import type { DocumentLoader } from './document.js';

/** The time of one step of the pages written in one task (ms) */
const STEP_MS = 8;

/** A document with no feature and no group: what the pages replace the document with first */
const EMPTY: { readonly type: 'FeatureCollection'; readonly features: readonly never[] } = {
  type: 'FeatureCollection',
  features: [],
};

/** Pages of rows, given in their order */
export type PageSource = Iterable<Page> | AsyncIterable<Page>;

/**
 * Whether a source is pages of rows: an iterable that is not a string, nor a stream of bytes
 *
 * @internal
 */
export function isPageSource(value: unknown): value is PageSource {
  if (typeof value !== 'object' || value === null) return false;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return false;
  if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) return false;
  const iterable = value as { [Symbol.iterator]?: unknown; [Symbol.asyncIterator]?: unknown };
  return (
    typeof iterable[Symbol.iterator] === 'function' ||
    typeof iterable[Symbol.asyncIterator] === 'function'
  );
}

/**
 * What a document opened from pages is written with
 *
 * @internal
 */
export interface PageOpening {
  readonly store: Store;
  readonly loader: DocumentLoader;
  /** The layer the rows go into */
  readonly layerId: () => string;
  /** Runs a write once no write over several tasks is under way (`queueCommit`) */
  readonly queue: <T>(make: () => T) => Promise<T>;
}

/**
 * Opens a document from pages
 *
 * @param internal.id - The ID of the commit (a new one when left out)
 * @param internal.fromStorage - Written as the storage gave it: taken even while read-only
 * @param internal.steps - Whether the pages are written as they arrive, each write its own
 *   transaction of the same commit (the reads give what arrived, `change` is held by the caller),
 *   or all of them in one transaction once every page arrived (a commit sent to a storage)
 */
export async function openPages(
  opening: PageOpening,
  pages: PageSource,
  options: { readonly signal?: AbortSignal; readonly onProgress?: (progress: Progress) => void },
  internal: { readonly id: string; readonly fromStorage?: boolean; readonly steps: boolean },
): Promise<OpenResult> {
  const { store, loader } = opening;
  const replace = rowPagesOf(store);
  if (!replace) {
    throw new DrawError(
      'invalidInput',
      'Pages of rows open in a Store that holds its features as rows (createTableStore)',
    );
  }
  const layerId = opening.layerId();
  if (!layerId || !store.getLayer(layerId)) {
    throw new DrawError('notFound', 'There is no current layer to put the rows of the pages in');
  }
  const fromStorage = internal.fromStorage === true;
  if (!fromStorage && store.isReadOnly()) {
    throw new DrawError('notEditable', 'The document is read-only');
  }
  const signal = options.signal;
  if (signal?.aborted) throw aborted(signal);
  const prepared = await loader.prepare(
    EMPTY as never,
    { mode: 'replace' },
    new Set(),
    new Set(),
    true,
  );
  if (!prepared) throw new DrawError('notEditable', 'The document is read-only');
  if (signal?.aborted) throw aborted(signal);
  const info: CommitInfo = { id: internal.id, label: undefined, undo: false };
  const commit = <T>(fn: () => T): T =>
    store.fromStorage(() => runCommit(store, info, 'open', fn)) as T;
  let features = 0;
  let rows = 0;
  const written = (change: ReturnType<typeof replace>): void => {
    for (const layer of change.layers.values()) features += layer.created.length;
  };
  const progress = (): void => options.onProgress?.({ phase: 'apply', done: rows, total: null });

  if (!internal.steps) {
    // Every page first, then one transaction: one commit, as a storage receives it
    const all: Page[] = [];
    for await (const page of pages) {
      checkPage(page);
      all.push(page);
      rows += page.length;
    }
    await opening.queue(() =>
      commit(() => {
        loader.writeAll([prepared], true);
        if (all.length > 0) written(replace(layerId, all));
      }),
    );
    progress();
    return { features, skipped: [] };
  }

  // The features and the groups replaced, then the pages as they arrive: once the first write is
  // made, the document is being opened, and the signal is not read any more
  await opening.queue(() => commit(() => loader.writeAll([prepared], true)));
  let batch: Page[] = [];
  let deadline = performance.now() + STEP_MS;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const taken = batch;
    batch = [];
    await opening.queue(() => commit(() => written(replace(layerId, taken))));
    progress();
  };
  const asyncIterator = (pages as AsyncIterable<Page>)[Symbol.asyncIterator];
  if (typeof asyncIterator === 'function') {
    // Each page as it arrives, the pages that arrived together in one write
    for await (const page of pages as AsyncIterable<Page>) {
      checkPage(page);
      batch.push(page);
      rows += page.length;
      await flush();
    }
  } else {
    for (const page of pages as Iterable<Page>) {
      checkPage(page);
      batch.push(page);
      rows += page.length;
      if (performance.now() < deadline) continue;
      await flush();
      await nextTask();
      deadline = performance.now() + STEP_MS;
    }
  }
  await flush();
  return { features, skipped: [] };
}

/** Refuses what is not a page of rows */
function checkPage(page: unknown): asserts page is Page {
  const of = page as Partial<Page> | null;
  if (
    typeof of !== 'object' ||
    of === null ||
    typeof of.length !== 'number' ||
    !(of.rows instanceof Int32Array)
  ) {
    throw new DrawError(
      'invalidInput',
      'A page of rows is built with createPageBuilder or read with toPage of /table',
    );
  }
}

function aborted(signal: AbortSignal): DrawError {
  return new DrawError('aborted', 'The opening was stopped by its signal', {
    cause: signal.reason,
  });
}

/** Settles in a later task */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
