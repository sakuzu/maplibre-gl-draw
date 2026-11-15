// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An instance on a Store with a storage of the first shape that refuses the commits a test names
 * and holds its answers while the test says so: what the tests of the take-out of refused commits
 * are made of
 */

import { createReferenceBackend } from '@sakuzu/maplibre-gl-draw-testing';
import type { Answer, Backend } from '../api/backend/backend.js';
import { readStoredDocument } from '../api/backend/kept.js';
import type { StoredDocument, ValueBatch } from '../api/backend/values.js';
import type { Draw } from '../api/draw.js';
import { createDrawOnEngine } from '../api/impl/create-draw.js';
import { createEngine } from '../api/impl/engine.js';
import { toEngineOptions } from '../api/impl/options.js';
import type { FeatureInput } from '../api/model.js';
import { MemoryStore } from '../store/memory.js';
import type { Store } from '../store/store.js';
import { createTableStore } from '../store/table-memory.js';
import { createMapStub } from '../test-utils.js';
import { storedOf } from './random-commits.js';

/** The two Stores: of objects, and of rows */
export const STORE_KINDS: ReadonlyArray<readonly [string, () => Store]> = [
  ['objects', () => new MemoryStore()],
  ['rows', () => createTableStore().store],
];

/** An instance on a Store with a storage, its batches sent again at once */
export function drawWith(store: Store, backend: Backend, rowsReadAtOnce?: number): Draw {
  const options = { store, backend, initDefaultLayer: false };
  const engine = createEngine(
    createMapStub().map,
    toEngineOptions(options, () => false),
    {
      deferDefaultMode: true,
    },
  );
  const made = createDrawOnEngine(engine, options, () => {}, {
    retryDelay: () => 0,
    ...(rowsReadAtOnce !== undefined && { rowsReadAtOnce }),
  });
  engine.enterDefaultMode();
  return made;
}

/** What a storage that refuses is made with */
export interface RefusingOptions {
  /** The most bytes of a batch (700 by default, so that commits come in parts) */
  readonly maxBatchBytes?: number;
  /** What the storage answers a batch it accepted, given the answer of the reference */
  readonly answer?: (batch: ValueBatch, answer: Answer) => Answer;
}

/**
 * The reference storage, refusing the batches `refuse` names, and holding the answers between
 * `hold` and `release`
 */
export function refusing(refuse: (batch: ValueBatch) => boolean, options: RefusingOptions = {}) {
  const reference = createReferenceBackend();
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  const sent: ValueBatch[] = [];
  const backend: Backend & { readonly document: StoredDocument } = {
    document: reference.document,
    maxBatchBytes: options.maxBatchBytes ?? 700,
    load: (task) => reference.load(task),
    async send(batch, task): Promise<Answer> {
      sent.push(batch);
      if (gate) await gate;
      if (refuse(batch)) return { status: 'refused', reason: 'rules', message: 'no' };
      const answer = await reference.send(batch, task);
      return options.answer ? options.answer(batch, answer) : answer;
    },
    abandon: (commit, task) => reference.abandon?.(commit, task) ?? Promise.resolve(),
  };
  return {
    backend,
    sent,
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      gate = null;
      open?.();
    },
  };
}

/** Until no commit is left to send */
export async function settled(d: Draw): Promise<void> {
  for (let i = 0; i < 4000; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (d.status.value.saving.unsaved === 0) return;
  }
  throw new Error(`Not saved: ${JSON.stringify(d.status.value.saving)}`);
}

/** A point of a layer */
export function point(
  id: string,
  layerId: string,
  properties: Record<string, unknown> = {},
): FeatureInput {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [1, 2] },
    properties: { 'maplibre-gl-draw:layerId': layerId, ...properties },
  };
}

/** What the storage shows, by the rules every client reads its document with */
export function shownOf(document: StoredDocument) {
  return storedOf(readStoredDocument(document).shown);
}
