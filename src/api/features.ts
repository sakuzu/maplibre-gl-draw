// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.features`: the features of the document
 */

import type {
  Feature,
  FeatureFilter,
  FeatureInput,
  FeaturePatch,
  FeatureStyleResolved,
  MoveTarget,
} from './model.js';

/**
 * The features of the document, with the standard methods of a collection and the verbs
 * that move, combine and split them.
 *
 * A wrong argument (an ID that does not exist, an input of the wrong shape) throws a
 * `DrawError` and changes nothing. A refusal because of the state (read-only, a lock) returns
 * `null` or `false` and changes nothing. A method whose name ends in `Many` runs in one
 * transaction: all of it happens or none of it does.
 */
export interface FeaturesCollection {
  /**
   * Gets a feature by ID.
   *
   * @returns The feature, or `undefined` when there is none with this ID
   */
  get(id: string): Feature | undefined;
  /**
   * Gets features by ID, in the order of the IDs.
   *
   * @returns One entry per ID: the feature, or `undefined` when there is none with that ID
   */
  getMany(ids: readonly string[]): (Feature | undefined)[];
  /**
   * Reads one attribute of a feature (a key of its `properties`) without the feature being
   * made: what a hook that narrows many candidates reads (`Plugin.interaction.filterSelection`
   * over a box of 100,000 features), so that it makes no feature per candidate.
   *
   * @param id - The feature
   * @param key - The key of `properties`
   * @returns The value, or `undefined` when the feature does not hold the key
   * @throws `DrawError` with the code `notFound` when there is no feature with this ID
   */
  getProperty(id: string, key: string): unknown;
  /**
   * Lists the features in stacking order, from the back.
   *
   * @param filter - Keeps only the features that match every key given
   * @throws `DrawError` with the code `tooManyItems` when more than 10,000 features match; the
   *   list is never cut short. {@link FeaturesCollection.iterate} reads any number of them
   */
  list(filter?: FeatureFilter): Feature[];
  /**
   * Reads the features in stacking order, from the back, one at a time, for any number of
   * them: each feature is made as the iterator reaches it, as it is then, and is not kept by
   * the instance afterwards.
   *
   * It reads the features that match when it starts, in the order they had then. A write to
   * the document while it is under way does not stop it: a feature deleted before the
   * iterator reaches it is skipped, and a feature created after it started is not read.
   *
   * @param filter - Keeps only the features that match every key given
   * @returns An iterator of the features
   */
  iterate(filter?: FeatureFilter): IterableIterator<Feature>;
  /**
   * Counts the features.
   *
   * @param filter - Counts only the features that match every key given
   */
  count(filter?: FeatureFilter): number;
  /** Whether a feature with this ID exists. */
  has(id: string): boolean;
  /**
   * Whether the feature can be edited now: the document is not read-only, and neither the
   * feature nor its group nor its layer is locked. A refused edit returns `null` or `false`
   * for the same reasons.
   *
   * @throws `DrawError` with the code `notFound` when there is no feature with this ID
   */
  isEditable(id: string): boolean;
  /**
   * Creates a feature and returns it as it was stored.
   *
   * @returns The new feature, or `null` when the document is read-only
   * @throws `DrawError` with the code `invalidInput` when the input has the wrong shape,
   *   `alreadyExists` when its ID is taken, `notFound` when its layer or group does not
   *   exist, or `invalidState` when the input names no layer and the document has no layer
   *   to put it in
   */
  create(input: FeatureInput): Feature | null;
  /**
   * Creates several features in one transaction: all of them or none.
   *
   * @returns The new features in the order of the inputs, or `null` when the document is
   *   read-only
   * @throws `DrawError` as {@link FeaturesCollection.create} does, for any of the inputs;
   *   nothing is created then
   */
  createMany(inputs: readonly FeatureInput[]): Feature[] | null;
  /**
   * Changes the keys given in the patch and returns the feature after the change.
   *
   * `properties` and `style` are merged key by key, and a key given as `undefined` is
   * removed.
   *
   * @returns The changed feature, or `null` when the change is refused (read-only, a lock)
   * @throws `DrawError` with the code `notFound` when there is no feature with this ID, or
   *   `invalidInput` when the patch has the wrong shape
   */
  update(id: string, patch: FeaturePatch): Feature | null;
  /**
   * Changes several features in one transaction: all of them or none.
   *
   * @returns The changed features in the order of the patches, or `null` when the change is
   *   refused
   * @throws `DrawError` as {@link FeaturesCollection.update} does, for any of the patches;
   *   nothing changes then
   */
  updateMany(patches: readonly { id: string; patch: FeaturePatch }[]): Feature[] | null;
  /**
   * Deletes a feature.
   *
   * @returns True when it was deleted, false when the deletion is refused (read-only, a lock)
   * @throws `DrawError` with the code `notFound` when there is no feature with this ID
   */
  delete(id: string): boolean;
  /**
   * Deletes several features in one transaction: all of them or none.
   *
   * @returns True when they were deleted, false when the deletion is refused
   * @throws `DrawError` with the code `notFound` when one of the IDs does not exist; nothing
   *   is deleted then
   */
  deleteMany(ids: readonly string[]): boolean;
  /**
   * Moves a feature to another layer, into a group or out of its group; `index` of the
   * target sets its position there.
   *
   * @returns True when it moved, false when the move is refused (read-only, a lock)
   * @throws `DrawError` with the code `notFound` when the feature or the target does not
   *   exist
   */
  move(id: string, to: MoveTarget): boolean;
  /**
   * Moves several features in one transaction, keeping their order: all of them or none.
   *
   * @returns True when they moved, false when the move is refused
   * @throws `DrawError` with the code `notFound` when one of the features or the target does
   *   not exist; nothing moves then
   */
  moveMany(ids: readonly string[], to: MoveTarget): boolean;
  /**
   * The look a feature is drawn with: the default, the layer rule and the style of the
   * feature put on top of each other.
   *
   * The colors of the `style` option and of the style of the feature are the strings they
   * were given, alpha included; the color of a layer rule is `#rrggbb`, as
   * {@link evaluateStyleRule} gives it, and a default is `#rrggbb`.
   *
   * @returns The look, or `undefined` when there is no feature with this ID
   */
  getAppliedStyle(id: string): FeatureStyleResolved | undefined;
  /**
   * Joins areas into one feature and returns it; the result replaces the features given.
   *
   * @returns The new feature, or `null` when the operation is refused (read-only, a lock)
   * @throws `DrawError` with the code `notFound` when one of the IDs does not exist, or
   *   `invalidInput` when fewer than two areas are given or one of the features is not an
   *   area
   */
  union(ids: readonly string[]): Feature | null;
  /**
   * Subtracts other areas from an area and returns the result; the result replaces the area
   * subtracted from, and the areas subtracted stay.
   *
   * @param id - The area to subtract from
   * @param subtractIds - The areas to subtract
   * @returns The resulting feature, or `null` when the operation is refused (read-only, a lock)
   * @throws `DrawError` with the code `notFound` when one of the IDs does not exist, or
   *   `invalidInput` when one of the features is not an area
   */
  difference(id: string, subtractIds: readonly string[]): Feature | null;
  /**
   * Keeps the part where areas overlap and returns it; the result replaces the features given.
   *
   * @returns The resulting feature, or `null` when the operation is refused (read-only, a lock)
   * @throws `DrawError` with the code `notFound` when one of the IDs does not exist, or
   *   `invalidInput` when fewer than two areas are given or one of the features is not an
   *   area
   */
  intersection(ids: readonly string[]): Feature | null;
  /**
   * Splits an area along a line and returns the features it made.
   *
   * @param id - The area to split
   * @param lineId - The line to split along
   * @returns The new features, or `null` when the operation is refused (read-only, a lock)
   * @throws `DrawError` with the code `notFound` when one of the IDs does not exist, or
   *   `invalidInput` when the features are not an area and a line
   */
  split(id: string, lineId: string): Feature[] | null;
  /**
   * Creates the areas around features.
   *
   * @param ids - The features to surround
   * @param options - `distanceMeters` is the distance of the outline from the features, and
   *   `segments` the number of segments of a full circle, as in the buffer of the geometry
   *   entry
   * @returns The new features, or `null` when the operation is refused (read-only, a lock)
   * @throws `DrawError` with the code `notFound` when one of the IDs does not exist, or
   *   `invalidInput` when the distance is not a finite number
   */
  buffer(
    ids: readonly string[],
    options: { distanceMeters: number; segments?: number },
  ): Feature[] | null;
}
