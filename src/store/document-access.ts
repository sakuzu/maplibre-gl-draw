// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The layer over the Store: what the parts of an instance ask of the Store
 *
 * The parts of an instance (the resources of the draw instance, the modes, the operations, the
 * hit testing, the snapping, the spatial index and the drawing) read and write the document, the
 * state of this client and the drawing state through one object of this type, which the instance
 * makes over its Store. Only that object and the Store itself call the members of the Store, so
 * what lies under the layer can change without the parts above it changing.
 *
 * The members have the names and the shapes of those of the Store of core (`Store` of
 * `store.ts`, where each is described). The type is made of four parts, so that a part can ask
 * only for what it needs.
 */

import type { ClientState } from './memory/ui-state.js';
import type {
  BoxSelection,
  DragState,
  Feature,
  FeatureType,
  FileData,
  Group,
  Layer,
  Metadata,
  Mode,
  Selection,
  SelectionType,
  StoreChange,
  TentativeState,
  UpdateFeatureOptions,
  UpdateSource,
  VertexSelection,
} from './types.js';

/** The reads of the document */
export interface DocumentReads {
  /** Returns the feature with this ID, or undefined */
  getFeature(id: string): Feature | undefined;
  /** Every feature, in no particular order */
  listFeatures(): Feature[];
  /** Every feature in stacking order, back to front, whatever the visible flags say */
  listFeaturesInOrder(): Feature[];
  /** Returns the layer with this ID, or undefined */
  getLayer(id: string): Layer | undefined;
  /** Every layer, in no particular order */
  listLayers(): Layer[];
  /** The stacking order of the layers, back to front */
  getLayerOrder(): readonly string[];
  /** Returns the group with this ID, or undefined */
  getGroup(id: string): Group | undefined;
  /** Every group, in no particular order */
  listGroups(): Group[];
  /** Returns the file with this ID, or undefined */
  getFile(id: string): FileData | undefined;
  /** Every file */
  listFiles(): FileData[];
  /** Returns the metadata of the document */
  getMetadata(): Metadata;
}

/**
 * The writes of the document, with the transactions and the subscription to the changes
 *
 * Every write returns true when it was applied and false when read-only refused it.
 */
export interface DocumentWrites {
  /** Creates a feature */
  createFeature(feature: Feature): boolean;
  /** Updates a feature */
  updateFeature(id: string, updates: Partial<Feature>, options?: UpdateFeatureOptions): boolean;
  /** Tells that intermediate states were given up (the values were written back already) */
  abortIntermediateUpdates?(ids: string[]): void;
  /** Deletes a feature */
  deleteFeature(id: string): boolean;
  /** Creates a layer */
  createLayer(layer: Layer): boolean;
  /** Updates a layer */
  updateLayer(id: string, updates: Partial<Layer>): boolean;
  /** Deletes a layer with its content */
  deleteLayer(id: string): boolean;
  /** Sets the stacking order of the layers */
  setLayerOrder(order: string[]): boolean;
  /** Moves an item within a layer */
  reorderInLayer(itemId: string, layerId: string, newIndex: number): boolean;
  /** Moves a feature within a group */
  reorderInGroup(featureId: string, groupId: string, newIndex: number): boolean;
  /** Creates a group */
  createGroup(group: Group): boolean;
  /** Updates a group */
  updateGroup(id: string, updates: Partial<Group>): boolean;
  /** Deletes a group, keeping its members */
  deleteGroup(id: string): boolean;
  /** Stores a file */
  createFile(file: FileData): boolean;
  /** Deletes a file */
  deleteFile(id: string): boolean;
  /** Sets the metadata, merging */
  setMetadata(metadata: Partial<Metadata>): boolean;
  /**
   * Subscribes to the changes of the document and of the local state
   *
   * @returns The unsubscribe function
   */
  subscribe(listener: (changes: StoreChange) => void): () => void;
  /** Runs fn and notifies every change it makes as a single StoreChange */
  transact<T>(fn: () => T, source?: UpdateSource): T;
}

/** The state of this client, which the instance holds */
export interface ClientStateAccess {
  /** The state of this client the instance holds */
  readonly client: ClientState;
  /** Returns the current selection */
  getSelection(): Selection;
  /** Replaces the selection (`null` and an empty array clear it) */
  setSelection(type: SelectionType | null, ids: string[]): void;
  /** The IDs of the features being edited */
  getEditingIds(): readonly string[];
  /** Marks features as being edited */
  startEditing(ids: string[]): void;
  /** Ends the editing of features */
  endEditing(ids: string[]): void;
  /** The selected vertices, or null when no vertex is selected */
  getVertexSelection(): VertexSelection | null;
  /** Sets or clears the selected vertices */
  setSelectedVertices(selection: VertexSelection | null): void;
  /** The current mode */
  getMode(): Mode;
  /** Records the current mode */
  setMode(mode: Mode): void;
  /** Whether the instance is read-only */
  isReadOnly(): boolean;
  /** Turns read-only on or off */
  setReadOnly(value: boolean): void;
  /** Whether the interaction lock is on */
  isInteractionLocked(): boolean;
  /** Turns the interaction lock on or off */
  setInteractionLock(value: boolean): void;
  /** Whether this feature, group or layer is hidden on this client only */
  isHidden(id: string): boolean;
  /** Every ID hidden on this client only */
  listHidden(): ReadonlySet<string>;
  /** Hides or shows a feature, a group or a layer on this client only */
  setLocallyHidden(id: string, hidden: boolean): void;
}

/** The state only the drawing reads: the geometry being drawn, the box, the drag, the followers */
export interface DrawingStateAccess {
  /** The geometry being drawn, or null when nothing is being drawn */
  getTentative(): TentativeState | null;
  /** Sets or clears the geometry being drawn */
  setTentative(state: TentativeState | null): void;
  /** The box selection in progress, or null */
  getBoxSelection(): BoxSelection | null;
  /** Sets or clears the box selection in progress */
  setBoxSelection(box: BoxSelection | null): void;
  /** The drag in progress, or null */
  getDragState(): DragState | null;
  /** Sets or clears the drag in progress */
  setDragState(state: DragState | null): void;
  /** The vertices that follow along when shared vertices move together (null except in a drag) */
  getFollowedVertices(): VertexSelection[] | null;
  /** Sets the vertices that follow along (back to null when the drag ends) */
  setFollowedVertices(selections: VertexSelection[] | null): void;
}

/** The layer over the Store, as one object: the four parts together */
export interface DocumentAccess
  extends DocumentReads,
    DocumentWrites,
    ClientStateAccess,
    DrawingStateAccess {}

/** Where a feature is, and its flags */
export interface FeaturePlace {
  readonly id: string;
  readonly layerId: string;
  readonly groupId: string | undefined;
  readonly visible: boolean;
  readonly locked: boolean;
}

/** What a read of the features keeps: every key given must match */
export interface FeatureMatch {
  /** Only the features in this layer */
  readonly layerId?: string;
  /** Only the features in this group */
  readonly groupId?: string;
  /** Only the features of this type */
  readonly type?: FeatureType;
  /** Only the features whose own visible flag is this */
  readonly visible?: boolean;
  /** Only the features that are shown (their own flag, their group's and their layer's) or not */
  readonly shown?: boolean;
  /** Only the locked or the unlocked features */
  readonly locked?: boolean;
  /** Only the features with one of these IDs */
  readonly ids?: ReadonlySet<string>;
}

/**
 * Where features move: a layer, a group, or out of their group into their layer; `index` is the
 * position within it once they have left it, from the back (the front when it is left out)
 */
export type MoveDestination =
  | { readonly kind: 'layer'; readonly layerId: string; readonly index?: number }
  | { readonly kind: 'group'; readonly groupId: string; readonly index?: number }
  | { readonly kind: 'ungroup'; readonly index?: number };

/**
 * The reads of the document by position, which read what they return without a feature or an
 * ID per item of the document
 */
export interface DocumentPlaces {
  /** The number of items of a layer: its groups and the features in no group (0 for none) */
  countItems(layerId: string): number;
  /** The IDs of the items of a layer at the positions `[start, end)`, from the back */
  listItemIds(layerId: string, start: number, end: number): string[];
  /** The number of the features of a group (0 for none) */
  countGroupFeatures(groupId: string): number;
  /** The IDs of the features of a group at the positions `[start, end)`, from the back */
  listGroupFeatureIds(groupId: string, start: number, end: number): string[];
  /** Whether a feature with this ID exists, told without the feature being made */
  hasFeature(id: string): boolean;
  /** One attribute of a feature, read without the feature being made (undefined for none) */
  getFeatureProperty(id: string, key: string): unknown;
  /**
   * Where a feature is and its flags, read from its row without the feature being made
   * (undefined for none)
   */
  getFeaturePlace(id: string): FeaturePlace | undefined;
  /**
   * Runs `fn` while the features made are kept beyond the number the layer keeps, and lets go
   * of those over it afterwards: for a caller that reads back the many features it wrote
   */
  holdFeatures<T>(fn: () => T): T;
  /** Counts the features that match */
  countFeatures(match?: FeatureMatch): number;
  /**
   * The features that match when it starts, in stacking order from the back, each made as the
   * iterator reaches it; a feature deleted meanwhile is skipped
   */
  iterateFeatures(match?: FeatureMatch): IterableIterator<Feature>;
  /**
   * The IDs of the items of a layer or the features of a group as they were before the change
   * being told, while it is told: kept only while `watchMoves` answers true when the change
   * starts (undefined otherwise)
   */
  getOrderBefore(containerId: string): readonly string[] | undefined;
  /** Sets the question whether the orders before a change are kept (see `getOrderBefore`) */
  watchMoves(watching: () => boolean): void;
}

/** The writes that move features and groups, and the replacements of the whole document */
export interface DocumentMoves {
  /**
   * Creates features, each as `createFeature` does, one after another in one transaction (the
   * rows of one layer that follow each other are written at once)
   */
  createFeatures(features: readonly Feature[]): boolean;
  /**
   * Moves features, given in stacking order, to a layer, into a group or out of their group,
   * keeping their order, in one transaction
   */
  moveFeatures(ids: readonly string[], to: MoveDestination): void;
  /**
   * Moves groups, given in stacking order, to a layer at a position (the front when it is left
   * out), in one transaction
   */
  moveGroups(ids: readonly string[], layerId: string, index: number | undefined): void;
  /**
   * Calls the listener whenever the Store tells a change that replaces its whole document
   *
   * @returns The function that stops
   */
  onReset(listener: () => void): () => void;
}

/** The layer over the Store an instance makes: the four parts, the reads by position and the moves */
export interface InstanceDocument extends DocumentAccess, DocumentPlaces, DocumentMoves {}
