// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.features`: the features of the document
 */

import type { BBox } from '../geometry/types.js';
import type {
  Feature,
  FeatureFilter,
  FeatureInput,
  FeatureListOptions,
  FeaturePatch,
  FeatureReadOptions,
  FeatureStyleResolved,
  FeatureValues,
  MoveTarget,
  RestoreToken,
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
   * @param options - `applySketches` reads it as the sketches edit it (`draw.sketches`), as it is drawn
   * @returns The feature, or `undefined` when there is none with this ID
   * @throws `DrawError` with the code `invalid-input` when the options have the wrong shape
   */
  get(id: string, options?: FeatureReadOptions): Feature | undefined;
  /**
   * Gets features by ID, in the order of the IDs.
   *
   * @param options - `applySketches` reads them as the sketches edit them (`draw.sketches`)
   * @returns One entry per ID: the feature, or `undefined` when there is none with that ID
   * @throws `DrawError` with the code `invalid-input` when the options have the wrong shape
   */
  getMany(ids: readonly string[], options?: FeatureReadOptions): (Feature | undefined)[];
  /**
   * Lists the features in stacking order, from the back.
   *
   * With `limit`, at most that many features are made, from the first or from the one after
   * `after`: the pages of a long list are read one after the other, each from the last feature of
   * the one before. A Store that holds its features as rows is listed only so: its features are
   * made when they are read, and it can hold more than can be made at once.
   *
   * @param filter - Keeps only the features that match every key given
   * @param options - The number of features made at most, and the feature read last
   * @returns The features, from the back (fewer than `limit` once the last page is read)
   * @throws `DrawError` with the code `invalid-state` when the Store holds its features as rows
   *   and no limit is given, `not-found` when there is no feature `after` (it was deleted
   *   meanwhile), or `invalid-input` when the filter or the options have the wrong shape
   *
   * @example Reading every feature, a page at a time
   * ```ts
   * let after: string | undefined;
   * for (;;) {
   *   const page = draw.features.list(undefined, { limit: 1000, after });
   *   page.forEach(read);
   *   if (page.length < 1000) break;
   *   after = page[page.length - 1].id;
   * }
   * ```
   */
  list(filter?: FeatureFilter, options?: FeatureListOptions): Feature[];
  /**
   * Counts the features, without making them. Over a Store that holds its features as rows, a
   * count by a layer, a group or both and nothing else reads the number the tables keep rather
   * than the rows, so `count({ groupId })` is the cheap count of the features of a group.
   *
   * @param filter - Counts only the features that match every key given
   */
  count(filter?: FeatureFilter): number;
  /**
   * The extent of the features, without making them, as `[west, south, east, north]` in
   * degrees: the extent the instance draws them in (the circle of a Circle, the image of an
   * Image at the zoom it was placed at). Over a Store that holds its features as rows, it is
   * read from the boxes of the rows the tables keep. Crossing the ±180 degree meridian is not
   * handled.
   *
   * @param filter - Reads only the features that match every key given
   * @returns The extent, or `null` when no feature matches (or none has a position)
   *
   * @example Fitting the map to a layer
   * ```ts
   * const box = draw.features.bbox({ layerId: 'buildings' });
   * if (box) map.fitBounds(box, { padding: 40 });
   * ```
   */
  bbox(filter?: FeatureFilter): BBox | null;
  /** Whether a feature with this ID exists. */
  has(id: string): boolean;
  /**
   * Whether the feature can be edited now: the document is not read-only, and neither the
   * feature nor its group nor its layer is locked. A refused edit returns `null` or `false`
   * for the same reasons.
   *
   * @throws `DrawError` with the code `not-found` when there is no feature with this ID
   */
  isEditable(id: string): boolean;
  /**
   * Creates a feature and returns it as it was stored.
   *
   * @returns The new feature, or `null` when the document is read-only
   * @throws `DrawError` with the code `invalid-input` when the input has the wrong shape,
   *   `already-exists` when its ID is taken, `not-found` when its layer or group does not
   *   exist, or `invalid-state` when the input names no layer and the document has no layer
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
   * @throws `DrawError` with the code `not-found` when there is no feature with this ID, or
   *   `invalid-input` when the patch has the wrong shape
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
   * @throws `DrawError` with the code `not-found` when there is no feature with this ID
   */
  delete(id: string): boolean;
  /**
   * Deletes several features in one transaction: all of them or none.
   *
   * @returns True when they were deleted, false when the deletion is refused
   * @throws `DrawError` with the code `not-found` when one of the IDs does not exist; nothing
   *   is deleted then
   */
  deleteMany(ids: readonly string[]): boolean;
  /**
   * Moves a feature to another layer, into a group or out of its group; `index` of the
   * target sets its position there.
   *
   * @returns True when it moved, false when the move is refused (read-only, a lock)
   * @throws `DrawError` with the code `not-found` when the feature or the target does not
   *   exist, or `invalid-state` when the target is a position by `index` in a layer held as rows
   *   (which takes the items around the place instead)
   */
  move(id: string, to: MoveTarget): boolean;
  /**
   * Moves several features in one transaction, keeping their order: all of them or none.
   *
   * @returns True when they moved, false when the move is refused
   * @throws `DrawError` as {@link FeaturesCollection.move} does; nothing moves then
   */
  moveMany(ids: readonly string[], to: MoveTarget): boolean;
  /**
   * Writes values of features back: what a write of this client left them
   * (`DocumentChange.previousValues`), or what this method returned, so that an undo puts the
   * features back as they were. It is for a Store that holds its features as rows: a feature is
   * written whether it is selected or not, a feature deleted whose rows are kept
   * (`DocumentChange.restoreToken`) comes back where it was, and the place of a feature in the
   * stacking order is written as the values give it.
   *
   * A lock of a feature, its group or its layer refuses the write, as it refuses an update: an
   * undo writes in a transaction that ignores the locks
   * (`draw.transact(fn, { ignoreLocks: true })`).
   *
   * @param values - The values to write back
   * @returns The values the features had before (written back, they redo the write), or `null`
   *   when the write is refused (read-only, a lock)
   * @throws `DrawError` with the code `invalid-state` when the Store does not hold its features
   *   as rows, `invalid-input` when the values are not values of features held as rows, or
   *   `not-found` when they name a feature that is no longer there (a deletion let go of)
   *
   * @example Undoing the last write of this client
   * ```ts
   * const steps: FeatureValues[] = [];
   * draw.on('document.changed', (change) => {
   *   if (change.source === 'local' && change.previousValues) steps.push(change.previousValues);
   * });
   * // Later
   * const last = steps.pop();
   * if (last) draw.transact(() => draw.features.restore(last), { ignoreLocks: true });
   * ```
   */
  restore(values: FeatureValues): FeatureValues | null;
  /**
   * Lets go of the features and the groups a deletion of this client kept
   * (`DocumentChange.restoreToken`), once nothing will write them back: the Store no longer keeps
   * them, and `restore` can no longer bring them back.
   *
   * @throws `DrawError` with the code `invalid-state` when the Store does not hold its features
   *   as rows, or `invalid-input` when the token is not one
   */
  releaseRestore(token: RestoreToken): void;
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
   * @throws `DrawError` with the code `not-found` when one of the IDs does not exist, or
   *   `invalid-input` when fewer than two areas are given or one of the features is not an
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
   * @throws `DrawError` with the code `not-found` when one of the IDs does not exist, or
   *   `invalid-input` when one of the features is not an area
   */
  difference(id: string, subtractIds: readonly string[]): Feature | null;
  /**
   * Keeps the part where areas overlap and returns it; the result replaces the features given.
   *
   * @returns The resulting feature, or `null` when the operation is refused (read-only, a lock)
   * @throws `DrawError` with the code `not-found` when one of the IDs does not exist, or
   *   `invalid-input` when fewer than two areas are given or one of the features is not an
   *   area
   */
  intersection(ids: readonly string[]): Feature | null;
  /**
   * Splits an area along a line and returns the features it made.
   *
   * @param id - The area to split
   * @param lineId - The line to split along
   * @returns The new features, or `null` when the operation is refused (read-only, a lock)
   * @throws `DrawError` with the code `not-found` when one of the IDs does not exist, or
   *   `invalid-input` when the features are not an area and a line
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
   * @throws `DrawError` with the code `not-found` when one of the IDs does not exist, or
   *   `invalid-input` when the distance is not a finite number
   */
  buffer(
    ids: readonly string[],
    options: { distanceMeters: number; segments?: number },
  ): Feature[] | null;
}
