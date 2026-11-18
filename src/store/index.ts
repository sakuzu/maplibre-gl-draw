// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Store of a draw instance, for an application that keeps the document somewhere of its own,
 * and for writing into the document a change made outside the instance.
 *
 * The instance keeps its document in a Store: the features, held as rows of columns, and the
 * layers, the groups, the stacking order, the embedded files and the metadata. `createStore` makes
 * the built-in one, which holds the rows in the tables of `@sakuzu/kasane`; an application gives
 * its own in the `store` option of `createDraw`, and reaches the one an instance uses with
 * `draw.getStore()`, as an extension does with `ctx.store`.
 *
 * Come here to:
 *
 * - keep the document somewhere of your own, by wrapping the built-in Store and taking over some
 *   of its writes ({@link createStore})
 * - write into the document a change made outside the instance, such as one your application
 *   read from elsewhere, so that it shows on a client that only views the document as well
 *   (source `'remote'`), many rows at a time and without a feature per row
 * - open a large document from pages of rows built in a Worker ({@link createRowPageBuilder}),
 *   with the source `'remote'` as well
 *
 * The edits of the user do not come here: `draw.features` writes them, checking read-only and the
 * locks, and so does `draw.features.restore`, which writes back the values a change had before.
 * Most applications never import from here: the main entry is enough.
 *
 * ```ts
 * import { createDraw } from '@sakuzu/maplibre-gl-draw';
 * import { createStore } from '@sakuzu/maplibre-gl-draw/store';
 *
 * const base = createStore();
 * const store = { ...base, setMetadata: (m) => (m.title === '' ? false : base.setMetadata(m)) };
 * const draw = createDraw(map, { store });
 * store.subscribe((change) => console.log(change.source, change.rows?.layers.size));
 * ```
 *
 * @module maplibre-gl-draw/store
 */

// biome-ignore-all assist/source/organizeImports: the exports are grouped by section

// The Store
export { createStore } from './built-in/create-store.js';
export type {
  LayerRowOptions,
  RowSpatialIndexing,
  Store,
  StoreGroup,
  StoreOptions,
  StoreTransactOptions,
  StoreView,
} from './built-in/types.js';

// The rows and the tables
export { GEOMETRY_TYPES } from './built-in/types.js';
export { createOrderKeyBetween } from './built-in/order-keys.js';
export { validateRowValues } from './built-in/validate.js';
export type {
  FeatureRowField,
  FeatureTables,
  GeometryColumn,
  ItemRefs,
  LayerTableView,
  NewRows,
  RowCursor,
  RowRef,
  RowValues,
  TableScanOptions,
} from './built-in/types.js';

// The changes
export type {
  DeletedRowsToken,
  LayerRowsChange,
  RowsChange,
  StoreChange,
  SubscribeOptions,
} from './built-in/types.js';
