// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Store as the reads of the instance read it (`draw.features`, `draw.layers`, `draw.groups`):
 * the document committed
 *
 * A commit too long for one task is written over several tasks, and told once after its last step.
 * Until then, the reads of the instance read the document before it (the snapshot of the Store,
 * `read-snapshot.ts`), as they do before the write is awaited, without finishing it. What this
 * client does (its modes, its drawing, its writes) reads the Store itself, which finishes the
 * write first.
 */

import { type DocumentSnapshot, readThroughSnapshot } from '../../store/read-snapshot.js';
import type { Store } from '../../store/store.js';

/** The reads of the document a snapshot answers in place of the Store */
const SNAPSHOT_READS = [
  'getFeature',
  'getLayer',
  'listLayers',
  'getLayerOrder',
  'getGroup',
  'listGroups',
  'getMetadata',
] as const;

/**
 * The Store as the reads of the instance read it: the document before the write over several tasks
 * under way, when there is one (every other member is the Store's). A transaction reads it through
 * its own snapshot (`snapshotOf`): the document it began on

 *
 * @internal
 */
export function publishedStore(
  store: Store,
  snapshotOf: () => DocumentSnapshot | undefined = () => store.readSnapshot(),
): Store {
  const reads: Record<string, (...args: never[]) => unknown> = {};
  for (const key of SNAPSHOT_READS) {
    reads[key] = (...args: never[]) => {
      const snapshot = snapshotOf();
      const from = (snapshot ?? store) as unknown as Record<string, (...a: never[]) => unknown>;
      return from[key](...args);
    };
  }
  reads.getFeatureLayerId = (id: never) => {
    const snapshot = snapshotOf();
    return snapshot
      ? snapshot.getFeature(id as unknown as string)?.layerId
      : store.getFeatureLayerId(id);
  };
  const published = new Proxy(store, {
    get(target, key) {
      if (typeof key === 'string' && key in reads) return reads[key];
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  readThroughSnapshot(published, snapshotOf);
  return published;
}
