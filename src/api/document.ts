// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.document`: the whole document, to load and to write out
 */

import type { FeatureCollection } from 'geojson';
import type { StoreView } from './extension/store.js';
import type { DrawDocument } from './model.js';

/**
 * The whole document: features, layers, groups and metadata. A document is opened with
 * `draw.open`, and added to with `tx.import`.
 */
export interface DocumentResource {
  /** The title (empty when there is none) */
  readonly title: string;
  /** The description (empty when there is none) */
  readonly description: string;
  /**
   * The values an application or an extension keeps on the document, each under a key of its own
   * prefix (`app:key`); written with `tx.document.update`
   */
  readonly metadata: { readonly [key: `${string}:${string}`]: unknown };
  /**
   * Shows another document in place of the document, for this client only, until `null` is
   * given: a past version of the document to look at, say, on the same map.
   *
   * The other document is a Store that holds its features as rows (`createTableStore` of
   * `@sakuzu/maplibre-gl-draw/kasane`, its rows added with `addPages`, which makes no feature
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
   * @throws `DrawError` with the code `invalidInput` when the Store does not hold its features
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
