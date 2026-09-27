// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Store: where the document and the state of this client are kept
 *
 * The built-in Store keeps them in memory. An application replaces it through the `store`
 * option of `createDraw`, for example to keep the document somewhere shared.
 */

import type { Feature, FileData, Group, Layer, Metadata } from '../model.js';
import type { Mode, Selection, SelectionType, VertexSelection } from '../state.js';

/**
 * Where a write came from, as it arrives in {@link StateChanges.source} and in the `source` of
 * the events.
 *
 * - `local`: an operation of the user or a call of the API (the default)
 * - `silent`: a change that a subscriber recording changes leaves out, such as replacing the
 *   whole document on load
 * - `batch`: a bulk change recorded as one step, such as loading GeoJSON
 * - `remote`: a change a replaced Store applies from outside the instance
 * - `import`: data an application or an extension loads by its own means
 *
 * Any other string can be used by an extension or a Store for the changes it applies itself.
 */
export type UpdateSource =
  | 'local'
  | 'silent'
  | 'batch'
  | 'remote'
  | 'import'
  | (string & Record<never, never>);

/**
 * Everything one transaction changed, as the Store delivers it to its subscribers. Each
 * category is present only when the transaction changed it.
 */
// TODO(api-2): confirm the shape (carried over; 8.11 says it has the shape of DocumentChange, and the categories of the drawing state in progress are left out)
export interface StateChanges {
  /** Where the writes came from */
  source?: UpdateSource;
  /** The features created, updated and deleted */
  features?: {
    created?: Feature[];
    updated?: Array<{
      id: string;
      feature: Feature;
      previous: Feature;
      /** True while a drag or a drawing is in progress; a final update always follows */
      isIntermediate?: boolean;
    }>;
    deleted?: Feature[];
  };
  /** The layers created, updated and deleted, and the change of their stacking order */
  layers?: {
    created?: Layer[];
    updated?: Array<{ id: string; layer: Layer; previous: Layer }>;
    deleted?: Layer[];
    orderChanged?: { order: string[]; previous: string[] };
  };
  /** The groups created, updated and deleted */
  groups?: {
    created?: Group[];
    updated?: Array<{ id: string; group: Group; previous: Group }>;
    deleted?: Group[];
  };
  /** The new order of the items of a layer */
  layerReorder?: { layerId: string; order: string[]; previous: string[] };
  /** The new order of the features of a group */
  groupReorder?: { groupId: string; featureIds: string[]; previous: string[] };
  /** The new selection and the one before it */
  selection?: {
    type: SelectionType | null;
    ids: string[];
    previousType: SelectionType | null;
    previousIds: string[];
  };
  /** The IDs of the features whose editing started and ended */
  editing?: { started?: string[]; ended?: string[] };
  /** The new mode and the one before it */
  mode?: { mode: Mode; previous: Mode };
  /** The new metadata and the one before it */
  metadata?: { metadata: Metadata; previous: Metadata };
}

/**
 * The read side of the Store: the document, the state of this client, and the subscription
 * to their changes.
 */
// TODO(api-2): confirm the members (carried over; the getters of the drawing state in progress, the box selection and the drag are left out because their types are internal)
export interface StoreView {
  /** A feature by ID, or `undefined` */
  getFeature(id: string): Feature | undefined;
  /** Every feature, in no particular order */
  getAllFeatures(): Feature[];
  /** Every feature in stacking order, from the back */
  getOrderedFeatures(): Feature[];
  /** A layer by ID, or `undefined` */
  getLayer(id: string): Layer | undefined;
  /** Every layer, in no particular order */
  getAllLayers(): Layer[];
  /** The stacking order, from the back: the layers and the entries from outside the document */
  getLayerOrder(): readonly string[];
  /** A group by ID, or `undefined` */
  getGroup(id: string): Group | undefined;
  /** Every group */
  getAllGroups(): Group[];
  /** An embedded file by ID, or `undefined` */
  getFile(id: string): FileData | undefined;
  /** Every embedded file */
  getAllFiles(): FileData[];
  /** The title and the description */
  getMetadata(): Metadata;
  /** The selection of this client */
  getSelection(): Selection;
  /** The IDs of the features being edited */
  getEditingIds(): readonly string[];
  /** The selected vertices, or `null` */
  getSelectedVertices(): VertexSelection | null;
  /** The current mode */
  getMode(): Mode;
  /** Whether the document is read-only */
  isReadOnly(): boolean;
  /** Whether the interaction lock is on */
  isInteractionLocked(): boolean;
  /** Whether this client hides the item */
  isLocallyHidden(id: string): boolean;
  /** The IDs this client hides */
  getLocallyHidden(): ReadonlySet<string>;
  /**
   * Subscribes to the changes; one notification arrives per outermost transaction.
   *
   * @returns The function that unsubscribes
   */
  subscribe(listener: (changes: StateChanges) => void): () => void;
  /**
   * Runs `fn` as one transaction, so that its writes arrive as one notification.
   *
   * @returns What `fn` returns
   */
  transact<T>(fn: () => T, source?: UpdateSource): T;
}

/**
 * The Store with its writes: what the `store` option of `createDraw` takes. Each write returns
 * false when it is refused and changes nothing.
 */
// TODO(api-2): confirm the members (carried over; the writes of the drawing state in progress, the box selection, the drag and the followed vertices are left out because their types are internal)
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
