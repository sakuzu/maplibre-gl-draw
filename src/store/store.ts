// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Store contracts
 *
 * All of the state lives in one place (Single Source of Truth), split along one line:
 *
 *   - DocumentStore: the document (features, layers, groups, the stacking order, files and
 *     metadata). It is the part a host may replace (`Options.store`) to keep the document
 *     elsewhere, and it knows nothing about the user interface.
 *   - UiState: the local state of this client (selection, editing, tentative geometry, box
 *     selection, drag, vertex selection, mode, read-only, interaction lock, local
 *     visibility). core owns it; it is never part of the document.
 *
 * Store joins the two for core: it reads and writes the document through the DocumentStore,
 * holds the UiState, gates the writes while read-only, keeps the UiState in step with
 * deletions, and delivers both kinds of change in one notification. StoreView is the part of
 * it the host sees (`draw.getStore()`): reads, subscription and transactions, no writes.
 */

import type {
  BoxSelection,
  DragState,
  Feature,
  FileData,
  Group,
  Layer,
  Metadata,
  Mode,
  Selection,
  SelectionType,
  StateChanges,
  TentativeState,
  UpdateFeatureOptions,
  UpdateSource,
  VertexSelection,
} from './types.js';

/**
 * The document: the part of the state a host may replace to keep it elsewhere
 *
 * The state of a draw instance is split along one line:
 *
 * | Type | What it is |
 * | --- | --- |
 * | `DocumentStore` | The document: features, layers, groups, the stacking order, files and metadata |
 * | {@link UiState} | The local state of this instance, never part of the document |
 * | {@link Store} | Both behind the read-only gate, for core and plugins |
 * | {@link StoreView} | Reads, `subscribe` and `transact`, from `draw.getStore()` |
 * | {@link MemoryStore} | The in-memory `Store`, the default |
 *
 * A host that keeps the document elsewhere (a database, for example) implements this
 * interface and passes it as the `store` option. Core keeps the
 * local state (the selection, the features being edited, the geometry being drawn, the box
 * selection, the drag, the vertex selection, the mode, read-only, the interaction lock and
 * local visibility) around it. An implementation keeps the following contract.
 *
 * Containment: every feature is listed in exactly one container, in `group.featureIds` of its
 * group when it has `groupId`, otherwise in `layer.order` of its layer. An implementation
 * keeps it on every mutation, so that no stored feature is left out of drawing, hit testing
 * and ordered export.
 *
 * The stacking order: `getLayerOrder()` is part of the document, saved and held with
 * the rest, and it holds more than layers. An application can place entries of its own in
 * it (the id of a dataset with `order: 'layer-order'`, a separator for
 * the `isExternalEntry` option); what such an entry means is the application's, and the
 * document only keeps its position. The entries are distinct non-empty strings: an
 * implementation drops any other value and keeps a repeated entry at its first position.
 * `createLayer` appends the new layer at the front unless the order already holds its id,
 * and `deleteLayer` takes that layer's id out. No other operation adds or removes entries;
 * an entry that is not a layer stays until the application sets an order without it, even
 * when what it names is gone. A layer that is not on the order is not drawn.
 *
 * Returned objects: callers treat every object and array a getter returns as read-only.
 * An implementation must not change an object after it has returned or notified it; a
 * change stores a new object instead (MemoryStore freezes what it returns, so a write
 * into it throws).
 *
 * Errors: a write with an argument that cannot apply (an id that does not exist, a
 * `layerId` or `groupId` that names nothing, a duplicate id) throws and stores nothing.
 * Read-only is not the document's concern: core gates the writes before they get here, and
 * changes applied from elsewhere never pass that gate. An implementation
 * that receives changes from elsewhere may ignore, instead of throwing, an update to an
 * id that such a change has already removed (the caller cannot know about the removal
 * yet); the notification then carries nothing for that id.
 *
 * Notifications: `subscribe` delivers the document categories of StateChanges (features,
 * layers, groups, layerReorder, groupReorder, metadata) with their source, and `transact`
 * groups the changes of a function into one notification. Any other category a notification
 * carries is ignored by core. A change applied from elsewhere is notified like a local one,
 * with the source `'remote'`, and core follows it: a deleted item leaves the selection, the
 * vertex selection ends when its feature changed, and the hooks of the plugins fire.
 *
 * @example
 * ```ts
 * // A document kept elsewhere: wrap it in a DocumentStore and hand it to the draw instance
 * const document: DocumentStore = createSyncedDocument(roomId);
 * const draw = createMapLibreGLDraw(map, { store: document });
 * ```
 */
export interface DocumentStore {
  // Features
  /** Returns the feature with this ID, or undefined */
  getFeature(id: string): Feature | undefined;
  /** Every feature, in no particular order */
  listFeatures(): Feature[];
  /**
   * Creates a feature and lists it in its container
   *
   * Throws, storing nothing, when `layerId` names a layer that does not exist or `groupId`
   * names a group that does not exist.
   */
  createFeature(feature: Feature): void;
  /**
   * Updates a feature
   *
   * A change of `layerId` or `groupId` moves the feature from its old container to the new
   * one (appended at the end, unless the caller lists it itself within the same
   * transaction). A `layerId` that names a layer that does not exist throws.
   *
   * @param options An optional argument that conveys the nature of the update. Setting
   *   isIntermediate declares that this is "an intermediate state in the middle of an
   *   edit operation" (it is always overwritten by the committing update that follows).
   *   The application itself does not change depending on whether options is given.
   */
  updateFeature(id: string, updates: Partial<Feature>, options?: UpdateFeatureOptions): void;
  /**
   * Discards uncommitted intermediate states (optional to implement)
   *
   * Called from the mode side when an edit operation is interrupted before a sequence of
   * updates with isIntermediate reaches its commit (an updateFeature without options). A
   * store implementation that holds intermediate states separately instead of applying
   * them to the real data discards the intermediate state of the relevant feature here
   * and returns to the committed state. An implementation that applies them to the real
   * data as they are (MemoryStore) does not have to implement it: before calling it, the
   * mode writes the values the features had when the operation started back as a last
   * intermediate update, so the real data is already back at the start.
   */
  abortIntermediateUpdates?(ids: string[]): void;
  /**
   * Deletes a feature and removes it from its container
   *
   * A group whose last member leaves is deleted with it (an empty group is not kept).
   */
  deleteFeature(id: string): void;
  /**
   * Every feature in stacking order
   *
   * Iterates in layer order -> order within the layer -> featureIds order within the
   * group, whatever the visible flags say. A layer that is not on the stacking order is not
   * drawn, and its features are not listed. The head of the array is the backmost and the
   * end is the foreground.
   */
  listFeaturesInOrder(): Feature[];

  // Layers
  /** Returns the layer with this ID, or undefined */
  getLayer(id: string): Layer | undefined;
  /** Every layer, in no particular order */
  listLayers(): Layer[];
  /**
   * Creates a layer and appends it to the stacking order (as the frontmost entry), unless the
   * order already holds its id, which then keeps its position
   */
  createLayer(layer: Layer): void;
  /** Updates a layer (an `order` given here replaces the order of its items) */
  updateLayer(id: string, updates: Partial<Layer>): void;
  /**
   * Deletes a layer together with the features and groups it lists, and takes its id out of
   * the stacking order (the other entries stay)
   */
  deleteLayer(id: string): void;
  /** Gets the stacking order, layers and entries of the application (the end is the front) */
  getLayerOrder(): readonly string[];
  /**
   * Replaces the stacking order (the end is the front)
   *
   * The order is part of the document and may hold entries that are not layers (see the
   * stacking order in the description of this interface), so an implementation keeps every
   * non-empty string it is given, in the given order, and folds a repeated one to its first
   * position.
   */
  setLayerOrder(order: string[]): void;
  /** Changes the order of an item (a feature or a group) within a layer */
  reorderInLayer(itemId: string, layerId: string, newIndex: number): void;
  /** Changes the order of a feature within a group */
  reorderInGroup(featureId: string, groupId: string, newIndex: number): void;

  // Groups
  /** Returns the group with this ID, or undefined */
  getGroup(id: string): Group | undefined;
  /** Every group, in no particular order */
  listGroups(): Group[];
  /**
   * Creates a group and sets `groupId` on its existing members, which leave the order of
   * their layer. A group that no layer lists by the end of the operation takes the place of
   * its first member.
   */
  createGroup(group: Group): void;
  /** Updates a group (a `featureIds` given here replaces its members and their order) */
  updateGroup(id: string, updates: Partial<Group>): void;
  /**
   * Deletes a group and clears `groupId` on its members, which take the group's place in
   * the order of its layer.
   */
  deleteGroup(id: string): void;

  // Files (embedded data such as images)
  /** Stores a file (a duplicate ID throws) */
  createFile(file: FileData): void;
  /** Returns the file with this ID, or undefined */
  getFile(id: string): FileData | undefined;
  /** Every file */
  listFiles(): FileData[];
  /** Deletes a file (the features that refer to it are not changed) */
  deleteFile(id: string): void;

  // Metadata
  /** Returns the metadata of the document */
  getMetadata(): Metadata;
  /** Sets the metadata (merging; a key set to undefined is removed) */
  setMetadata(metadata: Partial<Metadata>): void;

  /**
   * Subscribes to changes
   *
   * @returns The unsubscribe function
   */
  subscribe(listener: (changes: StateChanges) => void): () => void;
  /**
   * Runs fn and notifies its changes together as a single StateChanges
   *
   * Not atomic: when fn throws, the writes made before the throw stay applied, they are
   * notified, and the exception is rethrown.
   *
   * @param source The source of the operation (for history management in a plugin and for
   *   synchronization in an external store)
   */
  transact<T>(fn: () => T, source?: UpdateSource): T;
}

/**
 * The local state of this instance: never part of the document, owned by core
 *
 * Core keeps it for every draw instance, whatever {@link DocumentStore} holds the document.
 * The host reads it through {@link StoreView} and changes it through the methods of the draw
 * instance (`setMode`, `setSelection`, `setReadOnly` and so on).
 */
export interface UiState {
  // Selection
  /** Returns the current selection */
  getSelection(): Selection;
  /** Replaces the selection (`null` and an empty array clear it) */
  setSelection(type: SelectionType | null, ids: string[]): void;

  // Editing (the features being edited)
  /** The IDs of the features being edited (their vertex handles are shown) */
  getEditingIds(): readonly string[];
  /** Marks features as being edited */
  startEditing(ids: string[]): void;
  /** Ends the editing of features */
  endEditing(ids: string[]): void;

  // Tentative (the temporary geometry while drawing)
  /** The geometry being drawn, or null when nothing is being drawn */
  getTentative(): TentativeState | null;
  /** Sets or clears the geometry being drawn */
  setTentative(state: TentativeState | null): void;

  // Box selection
  /** The box selection in progress, or null */
  getBoxSelection(): BoxSelection | null;
  /** Sets or clears the box selection in progress */
  setBoxSelection(box: BoxSelection | null): void;

  // Drag
  /** The drag in progress, or null */
  getDragState(): DragState | null;
  /** Sets or clears the drag in progress */
  setDragState(state: DragState | null): void;

  // Vertex selection
  /** The selected vertices, or null when no vertex is selected */
  getVertexSelection(): VertexSelection | null;
  /** Sets or clears the selected vertices */
  setSelectedVertices(selection: VertexSelection | null): void;

  /**
   * Gets the vertices that follow along when shared vertices move together (null except
   * during a drag). Unlike the selected vertices they span several features.
   */
  getFollowedVertices(): VertexSelection[] | null;
  /** Sets the vertices that follow along (back to null when the drag ends) */
  setFollowedVertices(selections: VertexSelection[] | null): void;

  // Mode
  /** The current mode */
  getMode(): Mode;
  /** Records the current mode (the mode manager calls it; the host calls `draw.setMode`) */
  setMode(mode: Mode): void;

  /**
   * Read-only. While it is on, every write to the document through the Store is refused
   * (the write methods return false). It does not stop the other local state.
   */
  isReadOnly(): boolean;
  /** Turns read-only on or off */
  setReadOnly(value: boolean): void;

  /**
   * The interaction lock, orthogonal to read-only. It does not gate any write; it only stops
   * the start of the editing interactions that begin from user input (drag move / resize /
   * rotate / vertex editing / the delete shortcut / starting a drawing mode).
   */
  isInteractionLocked(): boolean;
  /** Turns the interaction lock on or off */
  setInteractionLock(value: boolean): void;

  /** Local visibility: the ids (feature / group / layer) hidden on this client only */
  isHidden(id: string): boolean;
  /** Every ID hidden on this client only */
  listHidden(): ReadonlySet<string>;
  /** Hides or shows a feature, a group or a layer on this client only */
  setLocallyHidden(id: string, hidden: boolean): void;
}

/**
 * The view of the Store a host gets from `draw.getStore()`: reads, subscription and
 * transactions
 *
 * Writes go through the methods of the draw instance (or, in a plugin, the PluginContext),
 * so a host cannot reach past the checks those methods make. `transact` groups the writes
 * made through them into one notification.
 *
 * @example
 * ```ts
 * const store = draw.getStore();
 * const unsubscribe = store.subscribe((changes) => {
 *   if (changes.features) saveLater(store.listFeatures());
 * });
 * // Two writes, one notification
 * store.transact(() => {
 *   draw.updateFeature(a, { visible: false });
 *   draw.updateFeature(b, { visible: false });
 * });
 * ```
 */
export interface StoreView {
  // The document
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

  // The local state
  /** Returns the current selection */
  getSelection(): Selection;
  /** The IDs of the features being edited (their vertex handles are shown) */
  getEditingIds(): readonly string[];
  /** The geometry being drawn, or null when nothing is being drawn */
  getTentative(): TentativeState | null;
  /** The box selection in progress, or null */
  getBoxSelection(): BoxSelection | null;
  /** The drag in progress, or null */
  getDragState(): DragState | null;
  /** The selected vertices, or null when no vertex is selected */
  getVertexSelection(): VertexSelection | null;
  /**
   * The vertices that follow along when shared vertices move together (null except during a
   * drag)
   */
  getFollowedVertices(): VertexSelection[] | null;
  /** The current mode */
  getMode(): Mode;
  /** Whether the Store is read-only */
  isReadOnly(): boolean;
  /** Whether the interaction lock is on */
  isInteractionLocked(): boolean;
  /** Whether this feature, group or layer is hidden on this client only */
  isHidden(id: string): boolean;
  /** Every ID hidden on this client only */
  listHidden(): ReadonlySet<string>;

  /**
   * Subscribes to the changes of the document and of the local state
   *
   * One notification per outermost transaction (or per write outside one). A listener
   * that throws is reported with console.error and does not stop the listeners after it.
   *
   * @returns The unsubscribe function
   */
  subscribe(listener: (changes: StateChanges) => void): () => void;
  /**
   * Runs fn and notifies every change it makes as a single StateChanges
   *
   * Not atomic: when fn throws, the writes made before the throw stay applied, they are
   * notified, and the exception is rethrown.
   *
   * @param source The source carried by the notification ('local' when omitted; the source
   *   of the outermost transaction applies)
   */
  transact<T>(fn: () => T, source?: UpdateSource): T;
}

/**
 * The Store core works with: the document and the local state behind one gate
 *
 * Every document write returns true when it was applied and false when it was refused
 * because the Store is read-only (it never throws for that). An argument that cannot apply
 * throws, as in DocumentStore. When a feature, group or layer is deleted (by a write here or
 * by a change applied to the document from elsewhere), its id leaves the selection, the
 * features being edited and the locally hidden set in the same notification. A change that
 * hides a selected item (its visible flag, the one of its group or layer, or local hiding)
 * takes it out of the selection, and the vertex selection ends when its feature is deleted
 * or its coordinates change other than by a drag. One notification carries the changes of the
 * document and of the local state of one transaction.
 *
 * A plugin reaches it with `getStore()` of {@link PluginContext}; the host gets the read-only
 * {@link StoreView}. The write methods behave as those of {@link DocumentStore}.
 */
export interface Store extends StoreView, UiState {
  /** Creates a feature (see {@link DocumentStore.createFeature}) */
  createFeature(feature: Feature): boolean;
  /** Updates a feature (see {@link DocumentStore.updateFeature}) */
  updateFeature(id: string, updates: Partial<Feature>, options?: UpdateFeatureOptions): boolean;
  /** Discards uncommitted intermediate states (see DocumentStore) */
  abortIntermediateUpdates?(ids: string[]): void;
  /** Deletes a feature (see {@link DocumentStore.deleteFeature}) */
  deleteFeature(id: string): boolean;

  /** Creates a layer (see {@link DocumentStore.createLayer}) */
  createLayer(layer: Layer): boolean;
  /** Updates a layer (see {@link DocumentStore.updateLayer}) */
  updateLayer(id: string, updates: Partial<Layer>): boolean;
  /** Deletes a layer with its content (see {@link DocumentStore.deleteLayer}) */
  deleteLayer(id: string): boolean;
  /** Sets the stacking order of the layers (see {@link DocumentStore.setLayerOrder}) */
  setLayerOrder(order: string[]): boolean;
  /** Moves an item within a layer (see {@link DocumentStore.reorderInLayer}) */
  reorderInLayer(itemId: string, layerId: string, newIndex: number): boolean;
  /** Moves a feature within a group (see {@link DocumentStore.reorderInGroup}) */
  reorderInGroup(featureId: string, groupId: string, newIndex: number): boolean;

  /** Creates a group (see {@link DocumentStore.createGroup}) */
  createGroup(group: Group): boolean;
  /** Updates a group (see {@link DocumentStore.updateGroup}) */
  updateGroup(id: string, updates: Partial<Group>): boolean;
  /** Deletes a group, keeping its members (see {@link DocumentStore.deleteGroup}) */
  deleteGroup(id: string): boolean;

  /** Stores a file (see {@link DocumentStore.createFile}) */
  createFile(file: FileData): boolean;
  /** Deletes a file (see {@link DocumentStore.deleteFile}) */
  deleteFile(id: string): boolean;

  /** Sets the metadata, merging (see {@link DocumentStore.setMetadata}) */
  setMetadata(metadata: Partial<Metadata>): boolean;
}
