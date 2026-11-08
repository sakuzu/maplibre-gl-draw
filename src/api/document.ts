// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.document`: the whole document, to load and to write out
 */

import type { FeatureCollection } from 'geojson';
import type { StoreView } from './extension/store.js';
import type { DrawDocument, LoadOptions, LoadResult, LoadSource } from './model.js';

/**
 * The whole document: features, layers, groups and metadata.
 */
export interface DocumentResource {
  /**
   * Reads a file, a JSON string, a document of the library or GeoJSON.
   *
   * `options.mode` decides whether the document is replaced or the features are added; it is
   * `replace` for a document of the library and `merge` for GeoJSON when it is left out.
   *
   * The source is read (and an image decoded) first; then every write is one transaction with
   * the source `load`, whatever the format: one `change` and one notification of the
   * Store, one step for a subscriber that records changes. A load that fails writes nothing.
   * The layer of `options.layer` and the group of `options.group` are created in that
   * transaction too.
   *
   * @returns What was read, or `null` when the document is read-only
   * @throws `DrawError` (the promise rejects; every failure is a `DrawError`) with the code
   *   `unsupported-format` when the source cannot be read (text that is not JSON, data that is
   *   neither a document of the library nor GeoJSON, an image file that cannot be decoded), or
   *   `invalid-input` when the document is not valid (a document of the library that breaks
   *   its format, an embedded image that is broken, an image without `coordinate`, `layer`
   *   with `layerId`, `layer` or `group` with a document of the library, an ID of `layer` or
   *   `group` the Store does not take), `not-found` for a `layerId` the document does not have,
   *   or `already-exists` for an ID of `layer` or `group` that is taken
   */
  load(source: LoadSource, options?: LoadOptions): Promise<LoadResult | null>;
  /**
   * Reads several sources and writes all of them in one transaction with the source `load`:
   * one `change` and one notification of the Store, so that an import of several
   * files is one step to undo and one change to send. Every source is read first, in order; the
   * writes then follow in the same order, each as `load` would write it, against the document
   * the earlier items left (a document of the library replaces what the earlier items wrote).
   * `document.loaded` arrives once per item, after the writes.
   *
   * An item may name with `layerId` a layer that an earlier item creates with `layer`, so the
   * items can fill one new layer and a group of it. A layer named by `layerId` that an earlier
   * item removed is replaced with the active layer. With `layer` and `group` in the options of
   * the items, an import of one layer per file and one group per folder is still one
   * transaction.
   *
   * @param items - The sources, each with the options `load` takes
   * @returns What was read from each item, in the order of the items, or `null` when the
   *   document is read-only
   * @throws `DrawError` (the promise rejects) as `load` does, for the first item that cannot
   *   be read (`not-found` for a `layerId` that neither the document nor an earlier item has);
   *   nothing is written then. `invalid-input` when `items` is not an array of objects
   *   with a `source`
   */
  loadMany(
    items: readonly { source: LoadSource; options?: LoadOptions }[],
  ): Promise<LoadResult[] | null>;
  /**
   * Shows another document in place of the document, for this client only, until `null` is
   * given: a past version of the document to look at, say, on the same map.
   *
   * The other document is a Store that holds its features as rows (`createTableStore` of
   * `@sakuzu/maplibre-gl-draw/kasane`, its rows added with `addRowBlocks`, which makes no feature
   * of them): its layers and groups are drawn from its rows in its stacking order, the datasets
   * of that order among them, read only. The rows added to it or written while it is shown are
   * drawn as they come.
   *
   * While it is shown, the document is not drawn, the pointer and the keys move the map only
   * (the mode is the select mode, and no mode or extension receives them), and the instance is
   * read-only (`isReadOnly()` is true, and `readOnly.changed` tells it): the writes of the
   * document through the instance return `null` or `false`. The changes the Store of the
   * instance takes from elsewhere (a transaction with the source `remote`) are still taken, and
   * drawn once the document is shown again. The selection and the shape being drawn
   * are kept and not drawn. The resources of the instance (`draw.features`, `draw.layers`)
   * still read the document; the other document is read from its own Store. Its memory counts
   * in `draw.memory`.
   *
   * @param store - The Store of the document to show, or `null` to show the document again
   * @throws `DrawError` with the code `invalid-input` when the Store does not hold its features
   *   as rows, or is the Store of the instance
   */
  setShown(store: StoreView | null): void;
  /** The document shown in place of the document (`setShown`), or `null`. */
  getShown(): StoreView | null;
  /** The whole document in the format of the library. */
  toJSON(): DrawDocument;
  /**
   * The whole document as GeoJSON. The values of the library are kept in `properties` under
   * the prefixed keys.
   */
  toGeoJSON(): FeatureCollection;
}
