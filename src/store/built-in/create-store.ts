// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The built-in Store: a plain object over a document of its own (`document.ts`), whose members
 * close over the document and never read `this`, so that it can be spread into a new object.
 *
 * @internal
 */

import { holdWorkCounts } from '../../shared/work-counts.js';
import { openDocument, type StoreDocument } from './document.js';
import { featureTablesOf } from './feature-tables.js';
import type { Store, StoreOptions } from './types.js';
import { storeWritesOf } from './writes.js';

/**
 * The built-in Store over a document: it reads and writes the document, tells the changes, and
 * holds the numbers of its work
 *
 * @internal
 */
export function storeOf(document: StoreDocument): Store {
  const store: Store = {
    tables: featureTablesOf(document),
    getLayer: (id) => document.layers.get(id),
    listLayers: () => Array.from(document.layers.values()),
    getLayerOrder: () => document.layerOrder,
    getGroup: (id) => document.groups.get(id),
    listGroups: () => Array.from(document.groups.values()),
    getFile: (id) => document.files.get(id),
    listFiles: () => Array.from(document.files.values()),
    getMetadata: () => document.metadata,
    ...storeWritesOf(document),
  };
  holdWorkCounts(store, document.counts);
  return store;
}

/**
 * Creates an empty Store in memory: the one an instance makes when it is given none. It holds the
 * rows in the tables of `@sakuzu/kasane`.
 *
 * It is a plain object whose members do not depend on `this`. To keep the document somewhere of
 * your own, spread it into a new object and replace the writes you take over; call the replaced
 * member of the built-in Store from yours so that it still holds the document (the instance draws
 * the rows from its tables). The instance then calls your members.
 *
 * It needs no map: a Store made and written without an instance can be read on its own, and
 * takes writes of any source while no instance uses it (see {@link Store}).
 *
 * @example A Store that does not take a title longer than 200 characters
 * ```ts
 * const base = createStore();
 * const store: Store = {
 *   ...base,
 *   setMetadata: (metadata) =>
 *     (metadata.title?.length ?? 0) > 200 ? false : base.setMetadata(metadata),
 * };
 * const draw = createDraw(map, { store });
 * ```
 */
export function createStore(options: StoreOptions = {}): Store {
  return storeOf(openDocument(options.spatialIndexing));
}
