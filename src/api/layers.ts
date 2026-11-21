// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.layers`: the layers of the document
 */

import type { DocumentChange } from './events.js';
import type { EditCounts, EditOptions, FeaturesCollection } from './features.js';
import type { IndexRange, Layer, LayerFilter, LayerInput, LayerPatch } from './model.js';

/**
 * The layers of the document, with the standard methods of a collection, the stacking order
 * and the active layer.
 *
 * A wrong argument (an ID that does not exist, an input of the wrong shape) throws a
 * `DrawError` and changes nothing. A refusal because of the state (read-only, a lock) returns
 * `null` or `false` and changes nothing. A method whose name ends in `Many` runs in one
 * transaction: all of it happens or none of it does, except `deleteMany`, which is a bulk edit
 * as `delete` is.
 *
 * The change of a creation and that of a deletion of a layer always carry the change of the
 * stacking order (`layers.orderChanged` of {@link DocumentChange}), so that the position of a
 * layer deleted can be read from the change and given back to `create` as `index`.
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
   * Counts the items of a layer: the things that stand in its stacking order, that is its
   * groups (one item each, however many features they hold) and the features that are in no
   * group. The features in its groups are not counted: `features.count({ layerId })` counts
   * every feature of the layer.
   *
   * @throws `DrawError` with the code `notFound` when there is no layer with this ID
   */
  countItems(id: string): number;
  /**
   * The IDs of the items of a layer (its groups and the features that are in no group, as
   * `countItems` counts them) at a range of positions, from the back: an ID names a group or a
   * feature, and `groups.has` tells which. `features.move` and `groups.move` change the order.
   * A range that goes past the front ends there.
   *
   * The positions are those of the moment it is called: a write between two calls (an item
   * created, deleted or moved) shifts them, so reading a layer a range at a time with writes in
   * between can skip items or read them twice. `features.iterate` reads every feature of a
   * layer once, whatever is written meanwhile.
   *
   * @param range - The positions, 0 at the back: from `start`, up to `end` and without it
   * @returns The IDs, from the back
   * @throws `DrawError` with the code `notFound` when there is no layer with this ID,
   *   `invalidInput` when the range is not two integers from 0 with `start <= end`, or
   *   `tooManyItems` when it spans more than 10,000 positions
   */
  listItemIds(id: string, range: IndexRange): string[];
  /**
   * Creates a layer and returns it as it was stored.
   *
   * The ID of a layer this instance had and a change deleted is taken as it is, without
   * `acceptsId`: it is how a layer deleted is created again, before `features.restore` brings
   * its features back.
   *
   * @returns The new layer, or `null` when the document is read-only
   * @throws `DrawError` with the code `invalidInput` when the input has the wrong shape, or
   *   `alreadyExists` when its ID is taken
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
   * Deletes a layer with its features and groups: a bulk edit, in parts (see
   * {@link FeaturesCollection}), however many features it holds. Its features and groups are
   * deleted in parts, and the layer itself in the last part. From its first part on, the
   * layer takes no other write of this client, as if it were locked, also from a write that
   * ignores the locks: such a write returns `null` or `false`. A feature written into the
   * layer meanwhile from outside this instance is deleted in the last part too. The selection
   * of the layer (`selection.delete`) deletes it the same way.
   *
   * Its changes list the features in `features.deleted` and the layer in `layers.deleted`, and
   * the values before (for a subscriber that asks) keep the features, so that
   * `features.restore` brings them back once the layer is created again. When the edit stops
   * (read-only), the layer stays with the features not deleted yet.
   *
   * @param options - Where the writes come from, and whether they ignore the locks
   * @returns The counts of the edit (`changedCount` is the number of features deleted), or
   *   `null` when the deletion is refused: read-only, or the layer, one of its groups or one
   *   of its features is locked when the edit starts (nothing is deleted then; a feature
   *   locked while the edit writes stays, and the layer stays with it)
   */
  delete(id: string, options?: EditOptions): Promise<EditCounts | null>;
  /**
   * Deletes several layers as one bulk edit, each as `delete` deletes one.
   *
   * @param options - Where the writes come from, and whether they ignore the locks
   * @returns The counts of the edit, or `null` when the deletion is refused: none is deleted
   *   when one of them is refused
   * @throws `DrawError` (the promise rejects) with the code `invalidInput` when the IDs are
   *   not an array of strings; nothing is deleted then
   */
  deleteMany(ids: readonly string[], options?: EditOptions): Promise<EditCounts | null>;
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
}
