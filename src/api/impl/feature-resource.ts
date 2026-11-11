// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The writes and reads of `features` as the resources made them before the writes moved to
 * `draw.write`: the internal part each write of a transaction is made with once it is committed
 */

import type { BBox } from '../../geometry/types.js';
import type {
  FeatureFilter,
  FeatureListOptions,
  FeatureStyleResolved,
  FeatureValues,
  MoveTarget,
  RestoreToken,
  StoredFeature,
  StoredFeatureInput,
  StoredFeaturePatch,
} from '../model.js';

/**
 * @internal
 */
export interface FeatureResource {
  /**
   * Gets a feature by ID, as the document holds it. A feature as it is drawn, with the sketches
   * applied over it, is `draw.rendered.get`.
   *
   * @returns The feature, or `undefined` when there is none with this ID
   */
  get(id: string): StoredFeature | undefined;
  /**
   * Gets features by ID, in the order of the IDs, as the document holds them.
   *
   * @returns One entry per ID: the feature, or `undefined` when there is none with that ID
   */
  getMany(ids: readonly string[]): (StoredFeature | undefined)[];
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
  list(filter?: FeatureFilter, options?: FeatureListOptions): StoredFeature[];
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
   * @throws `DrawError` with the code `invalid-input` when the input has the wrong shape or its
   *   ID is not one the Store takes (`Store.acceptsId`), `already-exists` when its ID is taken,
   *   `not-found` when its layer or group does not exist, or `invalid-state` when the input
   *   names no layer and the document has no layer to put it in
   */
  create(input: StoredFeatureInput): StoredFeature | null;
  /**
   * Creates several features in one transaction: all of them or none.
   *
   * @returns The new features in the order of the inputs, or `null` when the document is
   *   read-only
   * @throws `DrawError` as {@link FeaturesCollection.create} does, for any of the inputs;
   *   nothing is created then
   */
  createMany(inputs: readonly StoredFeatureInput[]): StoredFeature[] | null;
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
  update(id: string, patch: StoredFeaturePatch): StoredFeature | null;
  /**
   * Changes several features in one transaction: all of them or none.
   *
   * @returns The changed features in the order of the patches, or `null` when the change is
   *   refused
   * @throws `DrawError` as {@link FeaturesCollection.update} does, for any of the patches;
   *   nothing changes then
   */
  updateMany(patches: readonly { id: string; patch: StoredFeaturePatch }[]): StoredFeature[] | null;
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
   * draw.getStore().subscribe((change) => {
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
   * The look of a feature of the document, as its values are: the default, the layer rule and
   * the style of the feature put on top of each other. The default is the look the custom type of
   * the feature declares (`FeatureTypeDefinition.defaultStyle`) over the defaults of the `style`
   * option for its geometry. The sketches are not applied: a feature being edited has the look of
   * its values written. The renderer of a custom type reads the look of the feature it draws,
   * the sketches applied, from its render context (`RenderContext.appliedStyle`).
   *
   * The colors of the `style` option, of the look a type declares and of the style of the
   * feature are the strings they were given, alpha included; the color of a layer rule is
   * `#rrggbb`, as {@link evaluateStyleRule} gives it, and a built-in default is `#rrggbb`.
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
  union(ids: readonly string[]): StoredFeature | null;
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
  difference(id: string, subtractIds: readonly string[]): StoredFeature | null;
  /**
   * Keeps the part where areas overlap and returns it; the result replaces the features given.
   *
   * @returns The resulting feature, or `null` when the operation is refused (read-only, a lock)
   * @throws `DrawError` with the code `not-found` when one of the IDs does not exist, or
   *   `invalid-input` when fewer than two areas are given or one of the features is not an
   *   area
   */
  intersection(ids: readonly string[]): StoredFeature | null;
  /**
   * Splits an area along a line and returns the features it made.
   *
   * @param id - The area to split
   * @param lineId - The line to split along
   * @returns The new features, or `null` when the operation is refused (read-only, a lock)
   * @throws `DrawError` with the code `not-found` when one of the IDs does not exist, or
   *   `invalid-input` when the features are not an area and a line
   */
  split(id: string, lineId: string): StoredFeature[] | null;
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
  ): StoredFeature[] | null;
  /**
   * Writes the results of an operation on features, each with the ID given, in the place of its
   * anchor (the inputs it names deleted): what a transaction computed when the operation was
   * called. A result whose anchor is gone is left out.
   *
   * @returns False when every result was left out
   */
  writeResults(results: readonly WrittenResult[]): boolean;
}

/**
 * A result of an operation on features, computed: written in the place of its anchor
 *
 * @internal
 */
export interface WrittenResult {
  readonly id: string;
  readonly anchor: StoredFeature;
  readonly removedIds: string[];
  readonly geometry: { type: import('../model.js').FeatureType; coordinates: unknown };
  readonly properties?: StoredFeature['properties'];
}
