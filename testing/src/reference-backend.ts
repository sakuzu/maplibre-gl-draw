// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The reference storage: a storage of the first shape that keeps the document in memory
 */

import {
  type Answer,
  applyOperations,
  type Backend,
  createPartCollector,
  createStoredDocument,
  type StoredDocument,
  type ValueBatch,
} from '@sakuzu/maplibre-gl-draw/extend';

/**
 * A storage of the first shape that keeps the document in memory: the ground of the tests of a
 * storage and of the examples. It holds what a storage has to:
 *
 * - The parts of a commit are applied once every part is there (`createPartCollector`), in the
 *   one way the operations apply (`applyOperations`)
 * - A batch whose `Batch.id` it applied is not applied again: a batch sent again is answered as
 *   the first time
 * - `abandon` lets go of the parts of a commit received so far
 *
 * `load` gives the document as GeoJSON, its features with their records.
 */
export function createReferenceBackend(): Backend & { readonly document: StoredDocument } {
  const document = createStoredDocument();
  const collector = createPartCollector();
  // The batches of the commits applied, by their ID: a batch sent again is not applied again
  const applied = new Set<string>();
  // The batches of the commits not complete, by commit
  const received = new Map<string, Set<string>>();
  return {
    document,
    async load() {
      return {
        type: 'FeatureCollection',
        features: [...document.features].map(([id, record]) => ({
          type: 'Feature',
          id,
          geometry: record.geometry,
          properties: record.properties,
        })),
      };
    },
    async send(batch: ValueBatch): Promise<Answer> {
      const last = batch.part.index === batch.part.count - 1;
      if (applied.has(batch.id)) return last ? { status: 'accepted' } : { status: 'partial' };
      const operations = collector.add(batch);
      if (operations === null) {
        const ids = received.get(batch.commit) ?? new Set<string>();
        received.set(batch.commit, ids);
        ids.add(batch.id);
        return { status: 'partial' };
      }
      applyOperations(document, operations);
      for (const id of received.get(batch.commit) ?? []) applied.add(id);
      received.delete(batch.commit);
      applied.add(batch.id);
      return { status: 'accepted' };
    },
    async abandon(commit: string) {
      collector.abandon(commit);
      received.delete(commit);
    },
  };
}
