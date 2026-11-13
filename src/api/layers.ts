// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.layers`: the layers of the document
 */

import type { ItemListOptions, Layer, LayerFilter } from './model.js';

/**
 * The layers of the document, to read, with the stacking order and the active layer of this
 * client. They are written through the transaction of `draw.write` (`tx.layers`).
 */
export interface LayersCollection {
  /**
   * Gets a layer by ID.
   *
   * @returns The layer, or `undefined` when there is none with this ID
   */
  get(id: string): Layer | undefined;
  /**
   * Gets layers by ID, in the order of the IDs.
   *
   * @returns One entry per ID: the layer, or `undefined` when there is none with that ID
   */
  getMany(ids: readonly string[]): (Layer | undefined)[];
  /**
   * Lists the layers in stacking order, from the back.
   *
   * @param filter - Keeps only the layers that match every key given
   */
  list(filter?: LayerFilter): Layer[];
  /**
   * Counts the layers.
   *
   * @param filter - Counts only the layers that match every key given
   */
  count(filter?: LayerFilter): number;
  /** Whether a layer with this ID exists. */
  has(id: string): boolean;
  /**
   * Lists the IDs of the items of a layer, its features outside a group and its groups, in
   * stacking order from the back: the ones in a range of positions (see {@link ItemListOptions}).
   * A group stands at its place once; its features are read with `groups.listMembers`. It reads
   * a layer of objects (`Layer.items`) and a layer held as rows alike, without making features.
   *
   * @returns The IDs, as a new array (empty past the last item)
   * @throws `DrawError` with the code `notFound` when there is no layer with this ID, or
   *   `invalidInput` when the range is not of non-negative integers
   */
  listItems(id: string, options?: ItemListOptions): string[];
  /**
   * Counts the items of a layer: its features outside a group and its groups (the features of a
   * group are counted with `features.count({ groupId })`).
   *
   * @throws `DrawError` with the code `notFound` when there is no layer with this ID
   */
  countItems(id: string): number;
  /**
   * The stacking order: the IDs of every layer and of the other entries placed on it (the
   * datasets whose order is `layerOrder` and the entries the `isExternalEntry` option
   * recognizes), from the back. An entry that is no longer one of those is left out. Each of
   * them is put elsewhere with `tx.layers.place`.
   *
   * @returns A frozen array of IDs
   */
  getOrder(): readonly string[];
  /**
   * The layer that drawn features go into.
   *
   * @returns The active layer, or `null` when there is no layer
   */
  getActive(): Layer | null;
  /**
   * Changes the layer that drawn features go into.
   *
   * @returns True when it changed, false when the layer cannot take drawn features (a lock)
   * @throws `DrawError` with the code `notFound` when there is no layer with this ID
   */
  setActive(id: string): boolean;
}
