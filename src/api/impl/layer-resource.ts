// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The writes and reads of `layers` as the resources made them before the writes moved to
 * `draw.write`: the internal part each write of a transaction is made with once it is committed
 */

import type { ItemListOptions, Layer, LayerFilter, LayerInput, LayerPatch } from '../model.js';

/**
 * @internal
 */
export interface LayerResource {
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
   * Creates a layer and returns it as it was stored.
   *
   * @returns The new layer, or `null` when the document is read-only
   * @throws `DrawError` with the code `invalidInput` when the input has the wrong shape or its
   *   ID is not one the Store takes (`Store.acceptsId`), or `alreadyExists` when its ID is taken
   */
  create(input: LayerInput): Layer | null;
  /**
   * Creates several layers in one transaction: all of them or none.
   *
   * @returns The new layers in the order of the inputs, or `null` when the document is
   *   read-only
   * @throws `DrawError` as {@link LayersCollection.create} does, for any of the inputs;
   *   nothing is created then
   */
  createMany(inputs: readonly LayerInput[]): Layer[] | null;
  /**
   * Changes the keys given in the patch and returns the layer after the change.
   *
   * @returns The changed layer, or `null` when the change is refused (read-only, a lock)
   * @throws `DrawError` with the code `notFound` when there is no layer with this ID, or
   *   `invalidInput` when the patch has the wrong shape
   */
  update(id: string, patch: LayerPatch): Layer | null;
  /**
   * Changes several layers in one transaction: all of them or none.
   *
   * @returns The changed layers in the order of the patches, or `null` when the change is
   *   refused
   * @throws `DrawError` as {@link LayersCollection.update} does, for any of the patches;
   *   nothing changes then
   */
  updateMany(patches: readonly { id: string; patch: LayerPatch }[]): Layer[] | null;
  /**
   * Deletes a layer with its features and groups.
   *
   * @returns True when it was deleted, false when the deletion is refused (read-only, a lock)
   * @throws `DrawError` with the code `notFound` when there is no layer with this ID
   */
  delete(id: string): boolean;
  /**
   * Deletes several layers in one transaction: all of them or none.
   *
   * @returns True when they were deleted, false when the deletion is refused
   * @throws `DrawError` with the code `notFound` when one of the IDs does not exist; nothing
   *   is deleted then
   */
  deleteMany(ids: readonly string[]): boolean;
  /**
   * Changes the stacking order.
   *
   * Besides the layers, the order may place the datasets whose order is `layerOrder` and the
   * entries the `isExternalEntry` option recognizes. An entry of the stacking order that is
   * not a layer and is left out of `order` keeps its position; the entries given fill the
   * other positions in the order given, and those new to the stacking order go to the front.
   *
   * @param order - The IDs of every layer, and of the other entries to place, from the back
   * @returns True when the order changed, false when the change is refused (read-only)
   * @throws `DrawError` with the code `invalidInput` when the IDs do not list every layer
   *   or list an ID twice, or `notFound` when one of them is not a layer, a `layerOrder`
   *   dataset or an entry the `isExternalEntry` option recognizes
   */
  reorder(order: readonly string[]): boolean;
  /**
   * The stacking order as {@link LayersCollection.reorder} takes it: the IDs of every layer and
   * of the other entries placed on it (the datasets whose order is `layerOrder` and the
   * entries the `isExternalEntry` option recognizes), from the back. An entry that is no longer
   * one of those is left out, so the array can be changed and given to `reorder` as it is.
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
  /** Whether an ID that is not a layer may stand in the stacking order (a dataset, an entry) */
  isStackEntry(id: string): boolean;
}
