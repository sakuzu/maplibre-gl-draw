// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.features`: the features of the document
 */

import type { Rotation, Scaling, Translation } from '../shared/types/model.js';
import type { UpdateSource } from './extension/store.js';
import type {
  Feature,
  FeatureFilter,
  FeatureInput,
  FeaturePatch,
  FeatureStyleResolved,
  FeatureValues,
  IdSet,
  MoveTarget,
} from './model.js';

/**
 * The features of the document, with the standard methods of a collection, the verbs that
 * combine and split them, and the bulk edits.
 *
 * A wrong argument (an ID that does not exist, an input of the wrong shape) throws a
 * `DrawError` and changes nothing. A refusal because of the state (read-only, a lock) returns
 * `null` or `false` and changes nothing.
 *
 * Two kinds of writes:
 *
 * - The writes of a few features (`create`, `createMany`, `update`, `updateMany`, `delete`,
 *   `move`, `moveMany` and the geometry operations) are done when the method returns: reading
 *   the instance then gives the new state. A method among them whose name ends in `Many` runs
 *   in one transaction: all of it happens or none of it does.
 * - The bulk edits (`translate`, `rotate`, `scale`, `deleteMany`, `updateAll`, `duplicate` and
 *   `restore`, `layers.delete` and `layers.deleteMany`, `selection.delete`, and
 *   `document.load` and `document.loadMany`) take any number of features. Each is one
 *   operation, with one `operationId`: it writes in parts, each short enough to keep the map
 *   responsive (within 100 ms, the work of the listeners of its change included) and drawn as
 *   soon as it is written, and each part arrives as a `document.changed` with that
 *   `operationId`. Every change of the operation but the last has `hasMoreParts: true`; the
 *   last one always arrives, also when the operation stops before it has written everything
 *   (`stopped: true`). The promise resolves with {@link EditCounts} once the last change has
 *   arrived.
 *
 * What a bulk edit does with the features of its target that are not there, or change while it
 * writes, is the same for every bulk edit, and written here only:
 *
 * - An ID of the target that names nothing when the edit starts is left out and counted
 *   (`EditCounts.missingCount`); the edit goes on with the others. Only a target of the wrong
 *   shape (an ID that is not a string) is refused, and then nothing is written.
 * - A feature deleted while the edit writes, before the edit reaches it, is left out of the
 *   parts written after; nothing writes it again.
 * - A feature that is locked, or is in a locked group or layer, stays as it is and is counted
 *   (`EditCounts.lockedCount`), and the others change; so does one locked while the edit writes.
 * - The edit stops before it has written everything only when the document turns read-only or
 *   the instance is destroyed (`stopped: true`). The parts written stay.
 *
 * The bulk edits of this client are written one at a time, in the order they were started: an
 * edit started while another is being written waits until the last change of that one has
 * arrived, and then writes its own parts (a move and a turn give another result in another
 * order, so the edits are never mixed feature by feature). A write of a few features of this
 * client (a click, a key, `update` and the other methods above) does not wait: when it touches
 * features that the edit being written has not reached yet, the edit is first applied to those
 * features only, as a part of it (inside a transaction that is already open, as a part of that
 * transaction), and then the write is made. The order of the edits is kept so,
 * and the work is that of the features touched. A change written to the Store directly from
 * outside the instance is applied at once, and may arrive between two parts; a later part reads
 * the values the features have then.
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
   * An Image created without its size on the map is given one as `document.load` gives the
   * image it places: `maplibre-gl-draw:createdZoom` left out is the zoom of the map now (the
   * zoom a load places an image at), so the image is shown at its size in pixels at that zoom,
   * and `maplibre-gl-draw:scale` left out is 1. An extension that places an image needs no
   * rule of its own for it. The size of the image in pixels (`maplibre-gl-draw:imageWidth` and
   * `imageHeight`) is given by the caller and cannot be left out, whether the document holds
   * the file or not.
   *
   * @returns The new feature, or `null` when the document is read-only
   * @throws `DrawError` with the code `invalidInput` when the input has the wrong shape or
   *   `acceptsId` does not take its ID or an Image has no size in pixels, `alreadyExists`
   *   when its ID is taken, `notFound` when
   *   its layer or group does not exist, or `invalidState` when the input names no layer and
   *   the document has no layer to put it in
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
   * Changes several features in one transaction, each with its own patch: all of them or none.
   *
   * @returns The changed features in the order of the patches, or `null` when the change is
   *   refused
   * @throws `DrawError` as {@link FeaturesCollection.update} does, for any of the patches;
   *   nothing changes then
   */
  updateMany(patches: readonly { id: string; patch: FeaturePatch }[]): Feature[] | null;
  /**
   * Writes the same patch to all the features of the target, as `update` writes it to one: a
   * bulk edit, in parts (see {@link FeaturesCollection}). A feature for which the patch changes
   * nothing is not counted as changed. As with `update`, a patch of `locked` and `visible`
   * alone is written to the locked features too.
   *
   * @param target - The features
   * @param patch - The keys to change, the same for every feature
   * @param options - Where the writes come from, and whether they ignore the locks
   * @returns The counts of the edit, or `null` when it is refused (read-only, or every feature
   *   is locked)
   * @throws `DrawError` (the promise rejects) with the code `invalidInput` when the target or
   *   the patch has the wrong shape; nothing changes then
   */
  updateAll(
    target: FeatureTarget,
    patch: FeaturePatch,
    options?: EditOptions,
  ): Promise<EditCounts | null>;
  /**
   * Deletes a feature.
   *
   * @returns True when it was deleted, false when the deletion is refused (read-only, a lock)
   * @throws `DrawError` with the code `notFound` when there is no feature with this ID
   */
  delete(id: string): boolean;
  /**
   * Deletes every feature of the target: a bulk edit, in parts (see
   * {@link FeaturesCollection}). A group whose last feature goes is deleted with it. The
   * selection, the editing and the items this client hides let go of the features deleted.
   *
   * @param target - The features
   * @param options - Where the writes come from, and whether they ignore the locks
   * @returns The counts of the edit, or `null` when it is refused (read-only, or every feature
   *   is locked)
   * @throws `DrawError` (the promise rejects) with the code `invalidInput` when the target has
   *   the wrong shape; nothing is deleted then
   */
  deleteMany(target: FeatureTarget, options?: EditOptions): Promise<EditCounts | null>;
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
  /**
   * Moves features as a move from one point to another moves them, the same for every
   * feature: a bulk edit, in parts (see {@link FeaturesCollection}).
   *
   * The built-in interactions write with this method: a drag of the selection calls it once,
   * when the pointer is let go of, on the features the drag moves then (`featureIds` of
   * `drag.ended`: those deleted or taken out of the drag meanwhile are not among them; the
   * drag itself writes nothing, see `drag.changed`), and a move with the arrow keys calls it
   * for every key, on `{ selection: true }`. The positions are computed by the provider set
   * with `draw.extensions.setTransformProvider`, or by the built-in computation (see
   * {@link Translation}).
   *
   * @param target - The features to move; none gives counts of 0
   * @param translation - The point the features move from and the point they move to
   * @param options - Where the writes come from, and whether they ignore the locks
   * @returns The counts of the edit, or `null` when the move is refused (read-only, or every
   *   feature is locked)
   * @throws `DrawError` (the promise rejects) with the code `invalidInput` when the target has
   *   the wrong shape, a position is not finite or has a latitude outside -90 to 90, or the
   *   provider does not compute the move; nothing moves then
   */
  translate(
    target: FeatureTarget,
    translation: Translation,
    options?: EditOptions,
  ): Promise<EditCounts | null>;
  /**
   * Turns features around a center by an angle, counterclockwise seen from above: a bulk
   * edit, in parts (see {@link FeaturesCollection}).
   *
   * The built-in interactions write with this method: a drag of the rotate handle of the
   * selection calls it once, when the pointer is let go of, on the features the drag changes
   * then (`featureIds` of `drag.ended`). The positions, and the fields of
   * rotation and direction of the features that have them (see
   * {@link FeatureTypeDefinition.transformFields}), are computed by the provider set with
   * `draw.extensions.setTransformProvider`, or by the built-in computation.
   *
   * An edit that turns a single feature of a `Point` geometry with a field of rotation turns it
   * about its position (see {@link TransformFields.rotationDegreesKey}): the instance puts that
   * position in `center` before the computation is called, so that a provider needs not know
   * how many features the edit has.
   *
   * @param target - The features to turn; none gives counts of 0
   * @param rotation - The center, as `[longitude, latitude]` in degrees, and the angle
   * @param options - Where the writes come from, and whether they ignore the locks
   * @returns The counts of the edit, or `null` when the rotation is refused (read-only, or
   *   every feature is locked)
   * @throws `DrawError` (the promise rejects) with the code `invalidInput` when the target has
   *   the wrong shape, the center or the angle is not finite, the center has a latitude outside
   *   -90 to 90, or the provider does not compute the rotation; nothing turns then
   */
  rotate(
    target: FeatureTarget,
    rotation: Rotation,
    options?: EditOptions,
  ): Promise<EditCounts | null>;
  /**
   * Scales features from a center, by a factor along the east and one along the north: a bulk
   * edit, in parts (see {@link FeaturesCollection}).
   *
   * The built-in interactions write with this method: a drag of a resize handle of the
   * selection calls it once, when the pointer is let go of, on the features the drag changes
   * then (`featureIds` of `drag.ended`). The positions, and the field of
   * size of the features that have one (see {@link FeatureTypeDefinition.transformFields}),
   * are computed by the provider set with `draw.extensions.setTransformProvider`, or by the
   * built-in computation.
   *
   * @param target - The features to scale; none gives counts of 0
   * @param scaling - The center, as `[longitude, latitude]` in degrees, and the factors
   * @param options - Where the writes come from, and whether they ignore the locks
   * @returns The counts of the edit, or `null` when the change is refused (read-only, or every
   *   feature is locked)
   * @throws `DrawError` (the promise rejects) with the code `invalidInput` when the target has
   *   the wrong shape, the center is not finite or has a latitude outside -90 to 90, a factor
   *   is not a finite number above 0, or the provider does not compute the scaling; nothing
   *   changes then
   */
  scale(target: FeatureTarget, scaling: Scaling, options?: EditOptions): Promise<EditCounts | null>;
  /**
   * Copies every feature of the target: a bulk edit, in parts (see
   * {@link FeaturesCollection}). Each copy gets a new ID (`generateId`) and the values of its
   * original as they are, its name included, and goes just in front of the original, in its
   * layer and its group. When the target holds every feature of a group, the copies of those
   * features make a new group instead, just in front of that group, with the values of the
   * group (its name, its lock); when the target holds only some features of a group, their
   * copies go into the group itself. With `offset`, the copies are moved as `translate` moves
   * features. The copies can be read by their IDs in `EditCounts.createdIds`, and are not
   * selected.
   *
   * A locked feature is copied too: the copy is a new feature, and has the lock of its
   * original.
   *
   * @param target - The features to copy
   * @param options - Where the writes come from, and the move of the copies
   * @returns The counts of the edit, or `null` when it is refused (read-only)
   * @throws `DrawError` (the promise rejects) with the code `invalidInput` when the target has
   *   the wrong shape; nothing is copied then
   */
  duplicate(target: FeatureTarget, options?: DuplicateOptions): Promise<EditCounts | null>;
  /**
   * Writes back the values features had before a change, as the changes of a subscriber that
   * asked for them carry them (`previousValues` of {@link DocumentChange}, see
   * `draw.document.subscribe`): a bulk edit, in parts (see {@link FeaturesCollection}). The
   * features take back what the change did, and only that, onto what they are now:
   *
   * - The geometry is taken back vertex by vertex, as the values keep it (see
   *   {@link FeatureValues}): a vertex the change moved goes back to where it was, a vertex it
   *   added is deleted, and a vertex it deleted comes back; the other vertices, such as those
   *   another edit moved since, stay as they are. The vertices are followed from the change to
   *   now as {@link VertexRef} says; one that cannot be followed is left as it is and counted
   *   (`EditCounts.skippedVertexCount`). A change that changed the whole geometry (a move, a
   *   rotation, a scaling, an edit that changed the type of the geometry, the number of its
   *   parts or the number of the rings of a part) takes the whole geometry back. A geometry
   *   given whole (`features.update`) with the same type, parts and rings is compared with
   *   the one before vertex by vertex, as any other edit.
   * - Any other value (an attribute, a key of the look, a flag, the place) is written back key
   *   by key: a key the change did not write keeps what it has now.
   * - A feature the change deleted comes back where it was, in its layer and its group, while
   *   the values keep it ({@link FeaturesCollection.releaseValues}). (Deleting features does
   *   not delete the embedded files they name, so there is no file to bring back with them.) A
   *   feature whose group is not there goes into the layer of the group. A feature the change
   *   created is deleted.
   * - The groups, which hold the features, are written back with them: a group the change
   *   deleted comes back where it was, a group it created is deleted, a group it moved goes
   *   back to where it was, and a group whose values it changed (its name, its visibility,
   *   its lock) takes them back.
   *
   * The values of several changes are written back from the last to the first, so the values
   * of the changes of one bulk edit, given in the order they arrived, take the whole edit back.
   * The features that come back are told as created (`ChangedIds.created`, and
   * `feature.created` on the main entry).
   *
   * The layers are not written back here: the change carries their values before as objects
   * (`layers` of {@link DocumentChange}), and the caller writes them back with `draw.layers`
   * (a layer created again, its values, the stacking order). A layer the change deleted is
   * created again by the caller first, with `layers.create` and the `index` it had in the
   * stacking order (`layers.orderChanged.previous` of the change). The metadata, which is
   * neither a feature, a group nor a layer, is not written back here either: the caller
   * writes it back with `draw.metadata` (`metadata.previous` of the change).
   *
   * It is an edit of the document like any other: read-only refuses it, and a lock of a
   * feature, its group or its layer leaves the feature as it is unless `ignoreLocks` is given,
   * as writing back what an edit of the user did needs. Its own changes carry, for a subscriber
   * that asks, the values the features had before it, which written back make the change
   * again.
   *
   * @param values - The values, in the order their changes arrived
   * @param options - Where the writes come from (`'local'` when left out; an extension that
   *   writes back the edits of the user names its own source), whether they ignore the
   *   locks, and the keys of the attributes it leaves as they are
   * @returns The counts of the edit, or `null` when it is refused (read-only, or every feature
   *   is locked)
   * Values are used up by what is written back of them. A `restore` that stopped
   * (`stopped: true`) leaves the rest of its values: given to `restore` again, the same values
   * write the rest that was not written (the `restore` goes on from where it stopped). Values
   * written back whole are used up: given to `restore` again, they make it reject with
   * `invalidInput`. A `restore` refused (`null`) writes nothing and uses nothing. The changes
   * of a `restore` carry, for a subscriber that asks, the values that take back what it wrote
   * (only that, for one that stopped): to make the change again, give those.
   *
   * @throws `DrawError` (the promise rejects) with the code `invalidInput` when a value is not
   *   one this instance gave to this subscriber, was let go of, or was written back whole, or
   *   `notFound` when it names a layer that is not there; nothing is written then
   */
  restore(values: readonly FeatureValues[], options?: RestoreOptions): Promise<EditCounts | null>;
  /**
   * Lets go of what values of features keep: the features and groups a change deleted,
   * kept so that `restore` can bring them back. Every subscriber that asks for the values
   * before gets values of its own for each change, and a deleted feature is kept until all the
   * values that keep it are let go of; it then goes for good, and its ID may be used again.
   *
   * A subscriber that asks for the values before calls it for every value it no longer needs,
   * also when it unsubscribes: unsubscribing lets go of nothing. Values let go of are no longer
   * written back: given to `restore`, they make it reject with `invalidInput`. Letting go of
   * values that a stopped `restore` left lets go of the rest it did not write too. Values let
   * go of while a `restore` writes them are let go of once that `restore` has ended. Values let go of
   * twice, or that keep nothing, are left as they are.
   */
  releaseValues(values: readonly FeatureValues[]): void;
}

/**
 * The features a bulk edit acts on (`features.translate`, `deleteMany`, `updateAll` and the
 * others):
 *
 * - an array of IDs, or an {@link IdSet} (the selection, the features of a load, of a change)
 * - `{ selection: true }`: the features selected in this client when the edit starts, or the
 *   features of the groups and layers selected
 * - `{ layerIds }`: every feature of the layers, with those of their groups, without an array
 *   of their IDs (one layer is a list of one). The same form names the features of layers in
 *   `selection.set` and in a sketch
 *
 * The target is read once, when the edit starts: a feature created afterwards is not part of
 * it. What happens to an ID that names nothing, and to a feature deleted or locked meanwhile,
 * is written in {@link FeaturesCollection}.
 */
export type FeatureTarget =
  | readonly string[]
  | IdSet
  | {
      /** Always true: the features selected in this client when the edit starts */
      readonly selection: true;
    }
  | {
      readonly layerIds: readonly string[];
    };

/** The options of a bulk edit. */
export interface EditOptions {
  /**
   * Where the writes come from (an {@link UpdateSource}, not a source of data of the map), as
   * the changes carry it; `'local'` when left out, or the source
   * of the `draw.transact` the edit is started in. Inside a `draw.transact`, a source other than
   * that of the transaction throws `DrawError` with the code `invalidState`
   */
  source?: UpdateSource;
  /**
   * Whether the writes ignore the locks of the features, groups and layers, as writing back the
   * values a change had before needs; read-only still refuses them. False when left out, or
   * that of the `draw.transact` the edit is started in.
   */
  ignoreLocks?: boolean;
}

/** The options of `features.restore`. */
export interface RestoreOptions extends EditOptions {
  /**
   * Keys of `properties` the restore does not write back: on the features that are there,
   * these keys keep what they have now, for a caller that takes them back itself (a text it
   * puts back onto what was typed since, say). A feature that comes back still comes back
   * with every key it had. The values before of these keys are used up with the rest. None
   * when left out.
   */
  exceptProperties?: readonly string[];
}

/** The options of `features.duplicate`. */
export interface DuplicateOptions extends EditOptions {
  /**
   * How far the copies are moved from their originals, given as two points as `translate` takes
   * it (a {@link Translation}, in degrees); they stand on their originals when it is left out
   */
  offset?: Translation;
}

/**
 * What a bulk edit did (`features.translate`, `deleteMany`, `updateAll`, `duplicate`,
 * `restore`, `layers.delete`, `document.load` and the others): the counts of the features,
 * never the features themselves.
 */
export interface EditCounts {
  /** The number of the operation, as its changes carry it (`DocumentChange.operationId`) */
  operationId: number;
  /** The number of features the edit changed (created, for a copy or a load): never a locked one */
  changedCount: number;
  /**
   * The number of features that stayed as they were because they, their group or their layer
   * are locked, when the edit started or while it wrote
   */
  lockedCount: number;
  /**
   * The number of IDs of the target that named nothing when the edit started, and were left
   * out (see {@link FeaturesCollection})
   */
  missingCount: number;
  /**
   * True when the edit stopped before it had written everything: the document turned
   * read-only, or the instance was destroyed. The parts written stay.
   */
  stopped: boolean;
  /** The features the edit created (the copies of `duplicate`, the features of a load) */
  createdIds?: IdSet;
  /**
   * For `features.restore`: the number of vertices it left as they are, because the edits
   * made since changed their rings so that they could not be followed from the change to now
   * (see {@link VertexRef}), and left as they are
   */
  skippedVertexCount?: number;
}
