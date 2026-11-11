// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The loads of `draw.document` as the resource made them before the writes moved to
 * `draw.write`: the internal part `draw.open` and `tx.import` read and write with
 */

import type { DocumentResource } from '../document.js';
import type { LoadOptions, LoadResult, LoadSource } from '../model.js';

/**
 * @internal
 */
export interface DocumentLoads extends DocumentResource {
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
   * The extension host is told of each item, after the writes.
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
}
