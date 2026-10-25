// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.drafts`: the edits shown before they are written
 */

import type { FeatureEdit, FeatureInput } from './model.js';

/**
 * An edit a draft holds: an edit of features ({@link FeatureEdit}), or the shape of a feature
 * being drawn (`create`).
 *
 * `create` is a feature that is not in the document yet: it is drawn in the place `below` names
 * (just above that item of its layer or group; at the back for `null`) and written by
 * `features.create` when the draft is committed. `placedVertexCount` is the number of vertices
 * placed so far, the ones after it following the pointer, and `highlightedVertexIndex` the
 * vertex shown as the one to close the shape on.
 */
export type DraftEdit =
  | FeatureEdit
  | {
      kind: 'create';
      /** The feature as it will be created */
      feature: FeatureInput;
      /** The number of vertices placed so far */
      placedVertexCount: number;
      /** The vertex shown as the one to close the shape on */
      highlightedVertexIndex?: number;
      /** The item of the layer or the group the feature goes just above (`null`: at the back) */
      below: string | null;
    };

/**
 * Edits shown over the document before they are written: the features they edit are drawn as
 * the edits leave them, and the document does not change until the draft is committed.
 */
export interface Draft {
  /** The ID */
  readonly id: string;
  /** The edits, applied one after the other */
  readonly edits: readonly DraftEdit[];
  /**
   * Who makes it: `null` for this client, or the name of another one whose edits are shown here
   * (they are drawn under the ones of this client and cannot be committed here)
   */
  readonly owner: string | null;
}

/** What `drafts.add` takes. */
export interface DraftInput {
  /** The ID; one is generated when it is left out */
  id?: string;
  /** The edits */
  edits: readonly DraftEdit[];
  /** Who makes it (`null` for this client when left out) */
  owner?: string | null;
}

/** What `drafts.update` takes: only the keys given change. */
export interface DraftPatch {
  /** The edits, in place of the ones the draft holds */
  edits?: readonly DraftEdit[];
}

/**
 * Why a draft ended (`draft.removed`).
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
 * - `withdrawn`: a draft with an owner was taken off
 * - `document-replaced`: the whole document was replaced
 */
export type DraftEndReason =
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
 * The drafts: edits drawn over the document before they are written, with the standard methods
 * of a collection that things are added to and removed from, and the verb that writes them.
 *
 * A draft of this client (`owner` left out or `null`) edits only features it can write: the
 * document is not read-only, and neither the feature nor its group nor its layer is locked,
 * hidden or in a layer that cannot be written (`features.isEditable` reads most of it). When
 * the features of a draft are written, the draft is shown over what they wrote; a
 * feature of it that is deleted, locked, hidden or put into a layer that cannot be written is
 * left out, and the draft ends once none is left (`draft.removed`). A second draft of this client
 * of a feature commits the first one.
 *
 * A wrong argument (an ID that does not exist, an edit of the wrong shape) throws a `DrawError`
 * and changes nothing. A refusal because of the state (read-only, a lock) returns `null` or
 * `false` and changes nothing. A method whose name ends in `Many` does all of it or none of it.
 */
export interface DraftsCollection {
  /**
   * Gets a draft by ID.
   *
   * @returns The draft, or `undefined` when there is none with this ID
   */
  get(id: string): Draft | undefined;
  /** Lists the drafts, in the order they are drawn: the ones with an owner first. */
  list(): Draft[];
  /** Counts the drafts. */
  count(): number;
  /** Whether a draft with this ID exists. */
  has(id: string): boolean;
  /**
   * Adds a draft and returns it.
   *
   * @returns The draft, or `null` when a draft of this client is refused (read-only, a lock, a
   *   feature hidden or a layer that cannot be written)
   * @throws `DrawError` with the code `invalid-input` when the input has the wrong shape or an
   *   edit cannot apply, `already-exists` when its ID is taken, or `not-found` when an edit names
   *   a feature, a layer or a group that does not exist
   */
  add(input: DraftInput): Draft | null;
  /**
   * Adds several drafts, all of them or none, and returns them.
   *
   * @returns The drafts in the order of the inputs, or `null` when one is refused
   * @throws `DrawError` as {@link DraftsCollection.add} does, for any of the inputs; nothing is
   *   added then
   */
  addMany(inputs: readonly DraftInput[]): Draft[] | null;
  /**
   * Changes the keys given in the patch and returns the draft after the change.
   *
   * @returns The changed draft, or `null` when the change of a draft of this client is refused
   *   for the reasons `add` refuses
   * @throws `DrawError` with the code `not-found` when there is no draft with this ID, or as
   *   {@link DraftsCollection.add} does for the edits
   */
  update(id: string, patch: DraftPatch): Draft | null;
  /**
   * Changes several drafts, all of them or none.
   *
   * @returns The changed drafts in the order of the patches, or `null` when one is refused
   * @throws `DrawError` as {@link DraftsCollection.update} does; nothing changes then
   */
  updateMany(patches: readonly { id: string; patch: DraftPatch }[]): Draft[] | null;
  /**
   * Removes a draft without writing it (`draft.removed` with the reason `cancelled`, or
   * `withdrawn` for a draft with an owner).
   *
   * @returns True when it was removed
   * @throws `DrawError` with the code `not-found` when there is no draft with this ID
   */
  remove(id: string): boolean;
  /**
   * Removes several drafts, all of them or none.
   *
   * @returns True when they were removed
   * @throws `DrawError` with the code `not-found` when one of the IDs does not exist; nothing is
   *   removed then
   */
  removeMany(ids: readonly string[]): boolean;
  /**
   * Writes a draft of this client in one transaction and removes it (`draft.removed` with the
   * reason `committed`).
   *
   * @returns True when it was written, false when it is a draft with an owner or the write
   *   is refused (read-only)
   * @throws `DrawError` with the code `not-found` when there is no draft with this ID
   */
  commit(id: string): boolean;
  /**
   * Writes several drafts of this client in one transaction, all of them or none.
   *
   * @returns True when they were written, false when one is a draft with an owner or the
   *   write is refused
   * @throws `DrawError` with the code `not-found` when one of the IDs does not exist; nothing is
   *   written then
   */
  commitMany(ids: readonly string[]): boolean;
}
