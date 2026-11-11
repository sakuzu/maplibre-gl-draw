// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.sketches`: the edits shown before they are written
 */

import type { Observable } from './events.js';
import type { FeatureEdit, StoredFeatureInput } from './model.js';

/**
 * An edit a sketch holds: an edit of features ({@link FeatureEdit}), or the shape of a feature
 * being drawn (`create`).
 *
 * `create` is a feature that is not in the document yet: it is drawn in the place `below` names
 * (just above that item of its layer or group; at the back for `null`, at the front where
 * `features.create` puts a new feature when it is left out) and written by `features.create` when
 * the sketch is committed. With `placedVertexCount` it is a shape being drawn: drawn with the look
 * of the option `previewStyle` in its layer, in place of the feature (the vertices up to
 * `placedVertexCount` placed and the line to them solid, the ones after it following the pointer
 * and dashed, `highlightedVertexIndex` the vertex shown as the one to close the shape on), with no
 * ID `draw.rendered` reads it by, and its geometry may have fewer positions than a feature (a line
 * of one, a ring of fewer than four), checked as a feature when it is committed. A drawing mode
 * shows the shape it draws so (`ModeContext.preview`).
 */
export type SketchEdit =
  | FeatureEdit
  | {
      kind: 'create';
      /** The feature as it will be created */
      feature: StoredFeatureInput;
      /**
       * The number of vertices placed so far, for a shape being drawn (left out: a feature drawn as
       * it will be created, every vertex placed)
       */
      placedVertexCount?: number;
      /** The vertex shown as the one to close the shape on */
      highlightedVertexIndex?: number;
      /**
       * The item of the layer or the group the feature goes just above (`null`: at the back; left
       * out: at the front)
       */
      below?: string | null;
    };

/**
 * Edits shown over the document before they are written: the features they edit are drawn as
 * the edits leave them, and the document does not change until the sketch is committed.
 */
export interface Sketch {
  /** The ID */
  readonly id: string;
  /** The edits, applied one after the other */
  readonly edits: readonly SketchEdit[];
  /**
   * Who makes it: `null` for this client, or the name of another one whose edits are shown here
   * (they are drawn under the ones of this client and cannot be committed here)
   */
  readonly owner: string | null;
}

/** What `sketches.add` takes. */
export interface SketchInput {
  /** The ID; one is generated when it is left out */
  id?: string;
  /** The edits */
  edits: readonly SketchEdit[];
  /** Who makes it (`null` for this client when left out) */
  owner?: string | null;
}

/** What `sketches.update` takes: only the keys given change. */
export interface SketchPatch {
  /** The edits, in place of the ones the sketch holds */
  edits?: readonly SketchEdit[];
}

/**
 * Why a sketch ended: what the instance tells inside when a sketch is no longer listed.
 *
 * - `committed`: it was written
 * - `cancelled`: it was removed without being written
 * - `deselected`: what it edits was no longer selected
 * - `deleted`: every feature it edits was deleted
 * - `locked`: every feature it edits was locked (itself, its group or its layer)
 * - `read-only`: the document became read-only
 * - `layer-unavailable`: every feature it edits was hidden or put into a layer that cannot be
 *   written, or the layer of the feature it draws cannot be written when it is committed
 * - `vertices-removed`: the vertices it edits are no longer there
 * - `withdrawn`: a sketch with an owner was taken off
 * - `document-replaced`: the whole document was replaced
 */
export type SketchEndReason =
  | 'committed'
  | 'cancelled'
  | 'deselected'
  | 'deleted'
  | 'locked'
  | 'read-only'
  | 'layer-unavailable'
  | 'vertices-removed'
  | 'withdrawn'
  | 'document-replaced';

/**
 * The sketches: edits drawn over the document before they are written, with the standard methods
 * of a collection that things are added to and removed from, and the verb that writes them.
 *
 * A sketch of this client (`owner` left out or `null`) edits only features it can write: the
 * document is not read-only, and neither the feature nor its group nor its layer is locked,
 * hidden or in a layer that cannot be written (`features.isEditable` reads most of it). When
 * the features of a sketch are written, the sketch is shown over what they wrote; a
 * feature of it that is deleted, locked, hidden or put into a layer that cannot be written is
 * left out, and the sketch ends once none is left (it is no longer listed). A second sketch of this client
 * of a feature commits the first one.
 *
 * A wrong argument (an ID that does not exist, an edit of the wrong shape) throws a `DrawError`
 * and changes nothing. A refusal because of the state (read-only, a lock) returns `null` or
 * `false` and changes nothing. A method whose name ends in `Many` does all of it or none of it.
 */
export interface SketchesCollection extends Observable<readonly Sketch[]> {
  /**
   * Gets a sketch by ID.
   *
   * @returns The sketch, or `undefined` when there is none with this ID
   */
  get(id: string): Sketch | undefined;
  /** Lists the sketches, in the order they are drawn: the ones with an owner first. */
  list(): Sketch[];
  /** Counts the sketches. */
  count(): number;
  /** Whether a sketch with this ID exists. */
  has(id: string): boolean;
  /**
   * Adds a sketch and returns it.
   *
   * @returns The sketch, or `null` when a sketch of this client is refused (read-only, a lock, a
   *   feature hidden or a layer that cannot be written)
   * @throws `DrawError` with the code `invalid-input` when the input has the wrong shape, an
   *   edit cannot apply or a feature it creates has an ID the Store does not take
   *   (`Store.acceptsId`), `already-exists` when its ID is taken, or `not-found` when an edit
   *   names a feature, a layer or a group that does not exist
   */
  add(input: SketchInput): Sketch | null;
  /**
   * Adds several sketches, all of them or none, and returns them.
   *
   * @returns The sketches in the order of the inputs, or `null` when one is refused
   * @throws `DrawError` as {@link SketchesCollection.add} does, for any of the inputs; nothing is
   *   added then
   */
  addMany(inputs: readonly SketchInput[]): Sketch[] | null;
  /**
   * Changes the keys given in the patch and returns the sketch after the change.
   *
   * @returns The changed sketch, or `null` when the change of a sketch of this client is refused
   *   for the reasons `add` refuses
   * @throws `DrawError` with the code `not-found` when there is no sketch with this ID, or as
   *   {@link SketchesCollection.add} does for the edits
   */
  update(id: string, patch: SketchPatch): Sketch | null;
  /**
   * Changes several sketches, all of them or none.
   *
   * @returns The changed sketches in the order of the patches, or `null` when one is refused
   * @throws `DrawError` as {@link SketchesCollection.update} does; nothing changes then
   */
  updateMany(patches: readonly { id: string; patch: SketchPatch }[]): Sketch[] | null;
  /**
   * Removes a sketch without writing it (it ends `cancelled`, or `withdrawn` for a sketch with an
   * owner, and is no longer listed).
   *
   * @returns True when it was removed
   * @throws `DrawError` with the code `not-found` when there is no sketch with this ID
   */
  remove(id: string): boolean;
  /**
   * Removes several sketches, all of them or none.
   *
   * @returns True when they were removed
   * @throws `DrawError` with the code `not-found` when one of the IDs does not exist; nothing is
   *   removed then
   */
  removeMany(ids: readonly string[]): boolean;
  /**
   * Writes a sketch of this client in one transaction and removes it (it ends `committed`, and is
   * no longer listed).
   *
   * @returns True when it was written, false when it is a sketch with an owner or the write
   *   is refused (read-only)
   * @throws `DrawError` with the code `not-found` when there is no sketch with this ID, or
   *   `invalid-input` when a shape being drawn it creates is not yet a feature (a line of one
   *   position, a ring of fewer than four)
   */
  commit(id: string): boolean;
  /**
   * Writes several sketches of this client in one transaction, all of them or none.
   *
   * @returns True when they were written, false when one is a sketch with an owner or the
   *   write is refused
   * @throws `DrawError` with the code `not-found` when one of the IDs does not exist; nothing is
   *   written then
   */
  commitMany(ids: readonly string[]): boolean;
}
