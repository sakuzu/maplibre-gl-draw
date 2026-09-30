// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Store: where the document and the state of this client are kept
 *
 * The built-in Store keeps them in memory. An application replaces it through the `store`
 * option of `createDraw`, for example to keep the document somewhere shared.
 */

import type { DocumentChange } from '../events.js';
import type { Feature, FileData, Group, Layer, Metadata } from '../model.js';
import type { Mode, Selection, SelectionType, VertexSelection } from '../state.js';

/**
 * Where a write came from, as it arrives in {@link DocumentChange.source} and in the `source` of
 * the events.
 *
 * - `local`: an operation of the user or a call of the API (the default)
 * - `silent`: a change that a subscriber recording changes leaves out, such as the selection a
 *   drawing mode clears as it is entered
 * - `load`: a load of any format (`document.load`, `document.loadMany`), with the replacement
 *   of `mode: 'replace'`, in one transaction
 * - `batch`: a bulk change of an application or an extension recorded as one step; the
 *   library does not write it
 * - `remote`: a change a replaced Store applies from outside the instance
 * - `import`: data an application or an extension loads by its own means
 *
 * Any other string can be used by an extension or a Store for the changes it applies itself.
 */
export type UpdateSource =
  | 'local'
  | 'silent'
  | 'load'
  | 'batch'
  | 'remote'
  | 'import'
  | (string & Record<never, never>);

/**
 * The read side of the Store: the document, the state of this client, and the subscription
 * to their changes.
 *
 * What it returns and notifies keeps these rules:
 *
 * - Returned objects are never changed afterwards. Callers treat what a getter returns or a
 *   notification carries as read-only, and the Store never changes such an object: a change
 *   stores a new object.
 * - The stacking order (`getLayerOrder()`) is part of the document. It may hold entries that
 *   are not layers (a dataset with `order: 'layer-order'`, a separator of the application),
 *   and its entries are distinct non-empty strings.
 * - One notification per outermost transaction: `subscribe` delivers one `DocumentChange`
 *   per outermost `transact` (or per write outside one), with its `source`. The transactions
 *   inside another fold into the outermost one.
 * - A replacement of the whole document is one `DocumentChange`. A load that replaces the
 *   document in one `transact` arrives as one change; a document the Store takes from
 *   elsewhere in one step arrives as one change with `reset: true`, which lists what was
 *   replaced.
 * - A write of the selection, the editing or the mode is notified with its category; a write
 *   of the vertex selection, read-only, the interaction lock or the hidden items may be
 *   notified with no category.
 * - A change applied from outside the instance is notified like a local one, with the source
 *   `'remote'`. The instance follows it: a deleted item leaves the selection, the editing and
 *   the hidden items through the writes of {@link Store}.
 * - An optional field (`Feature.groupId`, `Layer.metadata`, `Layer.styleRule`) may be given as
 *   `null`: null is accepted and read as `undefined`, so the instance and its API always hand
 *   out `undefined` for it.
 * - The state of this client (the selection, the editing, the selected vertices, the mode,
 *   read-only, the interaction lock and the hidden items) is not part of the document: it is
 *   not saved, and a change from outside the instance does not carry it.
 */
export interface StoreView {
  /** A feature by ID, or `undefined` */
  getFeature(id: string): Feature | undefined;
  /** Every feature, in no particular order */
  listFeatures(): Feature[];
  /** Every feature in stacking order, from the back */
  listFeaturesInOrder(): Feature[];
  /** A layer by ID, or `undefined` */
  getLayer(id: string): Layer | undefined;
  /** Every layer, in no particular order */
  listLayers(): Layer[];
  /** The stacking order, from the back: the layers and the entries from outside the document */
  getLayerOrder(): readonly string[];
  /** A group by ID, or `undefined` */
  getGroup(id: string): Group | undefined;
  /** Every group */
  listGroups(): Group[];
  /** An embedded file by ID, or `undefined` */
  getFile(id: string): FileData | undefined;
  /** Every embedded file */
  listFiles(): FileData[];
  /** The title and the description */
  getMetadata(): Metadata;
  /** The selection of this client */
  getSelection(): Selection;
  /** The IDs of the features being edited */
  getEditingIds(): readonly string[];
  /** The selected vertices, or `null` */
  getVertexSelection(): VertexSelection | null;
  /** The current mode */
  getMode(): Mode;
  /** Whether the document is read-only */
  isReadOnly(): boolean;
  /** Whether the interaction lock is on */
  isInteractionLocked(): boolean;
  /** Whether this client hides the item */
  isHidden(id: string): boolean;
  /** The IDs this client hides */
  listHidden(): ReadonlySet<string>;
  /**
   * Subscribes to the changes; one notification arrives per outermost transaction.
   *
   * @returns The function that unsubscribes
   */
  subscribe(listener: (changes: DocumentChange) => void): () => void;
  /**
   * Runs `fn` as one transaction, so that its writes arrive as one notification.
   *
   * @returns What `fn` returns
   */
  transact<T>(fn: () => T, source?: UpdateSource): T;
}

/**
 * The Store with its writes: what the `store` option of `createDraw` takes.
 *
 * The instance reads and writes the document and the state of this client only through these
 * methods, subscribes to it and groups its writes with `transact`. The shape being drawn, the
 * box selection and the drag stay in the instance. A Store keeps the rules of
 * {@link StoreView} and these:
 *
 * - Unique IDs: the IDs of features and groups are unique together (both are listed in
 *   `Layer.items`), the IDs of layers are unique, and so are the IDs of files. A write that
 *   would take an ID in use does not apply.
 * - `Layer.items` is consistent: every feature is listed in exactly one container, in
 *   `Group.featureIds` of its group when it has `groupId`, otherwise in `Layer.items` of its
 *   layer, and every group is listed in `Layer.items` of one layer. The writes keep it so: a
 *   new feature or group is listed, a deleted one is taken out, a change of `layerId` or
 *   `groupId` moves the feature, and a group whose last member leaves is deleted.
 * - `Group.layerId` is maintained by the Store: it is always the layer whose `items` list the
 *   group.
 * - The stacking order: `createLayer` adds the new layer at the front unless the order
 *   already holds it, `deleteLayer` takes it out, and no other write adds or removes entries.
 * - Writes return whether they were applied: a write of the document returns true when it
 *   changed the Store, and false when it was refused, changing nothing. A write whose
 *   argument cannot apply (an ID that names nothing) may throw instead, storing nothing.
 * - Read-only refusals: the instance does not call the writes of the document while
 *   `isReadOnly()` is true, and a Store may refuse them then (and for reasons of its own) by
 *   returning false. The interaction lock does not stop any write. The writes of the state of
 *   this client return nothing: the instance takes them as applied.
 */
export interface Store extends StoreView {
  /** Creates a feature. */
  createFeature(feature: Feature): boolean;
  /** Changes the fields given of a feature; `isIntermediate` marks an edit in progress. */
  updateFeature(
    id: string,
    updates: Partial<Feature>,
    options?: { isIntermediate?: boolean },
  ): boolean;
  /** Drops the intermediate updates of these features that were not followed by a final one. */
  abortIntermediateUpdates?(ids: string[]): void;
  /** Deletes a feature. */
  deleteFeature(id: string): boolean;
  /** Creates a layer. */
  createLayer(layer: Layer): boolean;
  /** Changes the fields given of a layer. */
  updateLayer(id: string, updates: Partial<Layer>): boolean;
  /** Deletes a layer. */
  deleteLayer(id: string): boolean;
  /** Replaces the stacking order. */
  setLayerOrder(order: string[]): boolean;
  /** Moves an item to a position within a layer. */
  reorderInLayer(itemId: string, layerId: string, newIndex: number): boolean;
  /** Moves a feature to a position within a group. */
  reorderInGroup(featureId: string, groupId: string, newIndex: number): boolean;
  /** Creates a group. */
  createGroup(group: Group): boolean;
  /** Changes the fields given of a group. */
  updateGroup(id: string, updates: Partial<Group>): boolean;
  /** Deletes a group. */
  deleteGroup(id: string): boolean;
  /** Adds an embedded file. */
  createFile(file: FileData): boolean;
  /** Deletes an embedded file. */
  deleteFile(id: string): boolean;
  /** Changes the fields given of the metadata. */
  setMetadata(metadata: Partial<Metadata>): boolean;
  /** Replaces the selection of this client. */
  setSelection(type: SelectionType | null, ids: string[]): void;
  /** Marks features as being edited. */
  startEditing(ids: string[]): void;
  /** Marks features as no longer being edited. */
  endEditing(ids: string[]): void;
  /** Replaces the selected vertices. */
  setSelectedVertices(selection: VertexSelection | null): void;
  /** Replaces the mode. */
  setMode(mode: Mode): void;
  /** Turns read-only on or off. */
  setReadOnly(value: boolean): void;
  /** Turns the interaction lock on or off. */
  setInteractionLock(value: boolean): void;
  /** Hides or shows an item in this client. */
  setLocallyHidden(id: string, hidden: boolean): void;
}
