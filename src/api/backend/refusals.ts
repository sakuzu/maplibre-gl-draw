// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.backend`: the storage as the application drives it. Saving every commit, connecting again,
 * and the commits the storage refused: taken out of the document, kept until they are dismissed,
 * given out as GeoJSON (`export`) and made again as a new commit (`retry`)
 *
 * @internal
 */

import { DrawError } from '../../shared/draw-error.js';
import type { Refusal } from '../../shared/refusal.js';
import { createId } from '../../shared/utils/id.js';
import { runCommit } from '../../store/commit-scope.js';
import type { Store } from '../../store/store.js';
import { writeOf } from '../impl/saving.js';
import { queueCommit } from '../impl/write.js';
import type { BackendResource, Refusals, RefusalTarget } from '../status.js';
import type { SaveOptions, TaskOptions, Write, WriteOptions } from '../write.js';
import { KeptRecords } from './kept.js';
import { createObservable } from './observable.js';
import type { RefusedCommit, Sender } from './sender.js';
import { writeOperations } from './store-writes.js';
import { applyOperations, createStoredDocument } from './values.js';

const DELETED_IDS = 'maplibre-gl-draw:deletedIds';

/**
 * Creates `draw.backend`
 *
 * @param sender - What sends the commits to the storage (`null` without one)
 * @internal
 */
export function createBackendResource(deps: {
  readonly store: Store;
  readonly sender: () => Sender | null;
}): BackendResource {
  const { store } = deps;
  const none = createObservable<readonly Refusal[]>(Object.freeze([]));
  const aborted = (options: TaskOptions | undefined): DrawError | null =>
    options?.signal?.aborted ? new DrawError('aborted', 'Stopped by its signal') : null;
  /** The commits refused a target names (none without a storage, `notFound` for an ID) */
  const refusedOf = (target: RefusalTarget): RefusedCommit[] => {
    const sender = deps.sender();
    if (sender) return sender.refused(target);
    const ids = typeof target === 'string' ? [target] : Array.isArray(target) ? target : [];
    if (ids.length > 0) throw new DrawError('notFound', `No refusal has the ID ${ids[0]}`, { ids });
    return [];
  };
  const refusals: Refusals = {
    get value() {
      return (deps.sender()?.refusals ?? none).value;
    },
    subscribe(listener) {
      return (deps.sender()?.refusals ?? none).subscribe(listener);
    },
    async export(target, options) {
      const stopped = aborted(options);
      if (stopped) throw stopped;
      return exportOf(refusedOf(target), deps.sender());
    },
    retry(target, options) {
      return retryOf(store, deps.sender(), () => refusedOf(target), options);
    },
    async dismiss(target, options) {
      const stopped = aborted(options);
      if (stopped) throw stopped;
      const refused = refusedOf(target);
      deps.sender()?.dismiss(refused);
    },
  };
  return {
    save(options?: SaveOptions) {
      const sender = deps.sender();
      if (!sender) {
        return Promise.reject(new DrawError('invalidState', 'There is no storage to save to'));
      }
      const stopped = aborted(options);
      if (stopped) return Promise.reject(stopped);
      return sender.saveAll(options);
    },
    async reconnect(options?: TaskOptions) {
      const sender = deps.sender();
      if (!sender) throw new DrawError('invalidState', 'There is no storage to connect to');
      const stopped = aborted(options);
      if (stopped) throw stopped;
      sender.reconnect();
    },
    refusals,
  };
}

/**
 * The edits of refused commits as GeoJSON: what they meant, made on the document as it is now
 * (from the oldest). A feature they deleted is left out, its ID listed in
 * `maplibre-gl-draw:deletedIds`
 */
function exportOf(refused: readonly RefusedCommit[], sender: Sender | null): Blob {
  const document = createStoredDocument();
  const touched: string[] = [];
  const seen = new Set<string>();
  const deleted = new Set<string>();
  if (sender) {
    const values = sender.values;
    for (const { operations } of refused) {
      for (const operation of operations) {
        const ids =
          operation.type === 'create'
            ? [operation.id]
            : operation.kind === 'document'
              ? []
              : operation.ids;
        for (const id of ids) {
          if (operation.kind === 'layer' && !document.layers.has(id)) {
            const record = values.recordOf('layer', id);
            if (record) document.layers.set(id, record);
          } else if (operation.kind === 'group' && !document.groups.has(id)) {
            const record = values.recordOf('group', id);
            if (record) document.groups.set(id, record);
          } else if (operation.kind === 'feature' && !seen.has(id)) {
            seen.add(id);
            touched.push(id);
            const record = values.recordOf('feature', id);
            if (record) document.features.set(id, record);
          }
          // The parents the features are put in, as they are now
          if (operation.type === 'place' && operation.parentId !== null) {
            const parent = operation.parentId;
            const layer = values.recordOf('layer', parent);
            if (layer && !document.layers.has(parent)) document.layers.set(parent, layer);
            const group = values.recordOf('group', parent);
            if (group && !document.groups.has(parent)) {
              document.groups.set(parent, group);
              const its = values.recordOf('layer', group.layerId);
              if (its && !document.layers.has(group.layerId)) {
                document.layers.set(group.layerId, its);
              }
            }
          }
        }
      }
    }
    for (const { operations } of refused) {
      for (const operation of operations) {
        if (operation.type === 'delete' && operation.kind === 'feature') {
          for (const id of operation.ids) deleted.add(id);
        } else if (operation.type === 'create' && operation.kind === 'feature') {
          deleted.delete(operation.id);
        }
      }
      applyOperations(document, operations);
    }
  }
  const features = touched.flatMap((id) => {
    const record = document.features.get(id);
    if (!record) return [];
    return [{ type: 'Feature', id, geometry: record.geometry, properties: record.properties }];
  });
  const collection = {
    type: 'FeatureCollection',
    features,
    [DELETED_IDS]: [...deleted],
  };
  return new Blob([JSON.stringify(collection)], { type: 'application/geo+json' });
}

/**
 * Makes the edits of refused commits again on the document as it is now, as one new commit of this
 * client (from the oldest), and drops their records once it is made. What they wrote that is gone
 * now is left out; the items of objects take keys of their own where the keys of the edits put them
 */
function retryOf(
  store: Store,
  sender: Sender | null,
  refusedOf: () => RefusedCommit[],
  options: WriteOptions | undefined,
): Write<void> {
  const id = createId();
  const result = (async () => {
    if (options?.signal?.aborted)
      throw new DrawError('aborted', 'The retry was stopped by its signal');
    const refused = refusedOf();
    if (store.isReadOnly()) throw new DrawError('notEditable', 'The document is read-only');
    return queueCommit(store, () => {
      if (sender && refused.length > 0) {
        const values = sender.values;
        runCommit(
          store,
          { id, label: options?.label, undo: options?.undo ?? true },
          'local',
          () => {
            // A commit of this client: what it cannot show (under a container not there) is left
            // out, not kept as the storage would keep it
            const none = new KeptRecords();
            for (const { operations } of refused) {
              writeOperations(store, values, operations, false, none);
            }
          },
        );
        sender.dismiss(refused);
      }
      return { value: undefined, skipped: 0 };
    });
  })();
  return writeOf(store, id, result);
}
