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

import type { IdSet } from '../api/model.js';
import type {
  FeatureRowField,
  FeatureTables,
  RowValues,
  StoreTransactOptions,
} from './built-in/types.js';
import type { ClientState } from './memory/ui-state.js';
import type {
  BoundingBox,
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

/**
 * The number of features the layer keeps made, one by one: a feature read again within the last
 * this many reads is not made again
 */
export const FEATURES_KEPT = 1_024;

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
 * Every write returns true when it was applied, and false when read-only or the Store refused it.
 */
export interface DocumentWrites {
  /** Creates a feature */
  createFeature(feature: Feature): boolean;
  /** Updates a feature */
  updateFeature(id: string, updates: Partial<Feature>, options?: UpdateFeatureOptions): boolean;
  /** Tells that intermediate states were given up (the values were written back already) */
  abortIntermediateUpdates?(ids: string[]): void;
  /**
   * Applies the edit being written in parts first to a feature, before a write of this client
   * reads the feature to write it, or to make the values it writes (the features a geometry
   * operation reads to make its result, say), so that the write starts from the values the edit
   * gives them. A caller that only reads does not call it.
   * It does nothing when the edit has reached the feature already, or no edit is being written.
   * Outside a transaction, what it writes is a transaction of its own, a part of the operation
   * of the edit; inside one, it is written in that transaction. A write that opens a
   * transaction and then reads the feature calls it before it opens the transaction
   */
  applyEditFirst?(id: string): void;
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
  /** Creates a group with no feature, at the front of its layer */
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
  /**
   * Runs fn and notifies every change it makes as a single StoreChange
   *
   * @param options - Given to the transaction of the Store as they are: the operation the
   *   transaction is a part of, when one operation is written in several transactions
   */
  transact<T>(fn: () => T, source?: UpdateSource, options?: StoreTransactOptions): T;
  /**
   * Runs fn as `transact` does, stopping at the first write the Store refuses (the writes after
   * it return false and write nothing); null once a write was refused
   */
  transactUntilRefused<T>(fn: () => T, source?: UpdateSource): T | null;
}

/** The state of this client, which the instance holds */
export interface ClientStateAccess {
  /** The state of this client the instance holds */
  readonly client: ClientState;
  /** Returns the current selection: its IDs are the same set until the selection changes */
  getSelection(): Selection;
  /** Replaces the selection (`null` and no ID clear it) */
  setSelection(type: SelectionType | null, ids: readonly string[] | IdSet): void;
  /**
   * The features of IDs as a set of their rows, in the order given, each once: an ID that names
   * no feature is left out, and a set of rows this layer made whose rows are all there is given
   * back as it is. The set keeps the IDs it was given whatever is deleted afterwards
   */
  featureSetOf(ids: Iterable<string> | IdSet): IdSet;
  /** The features of rows as a set of them, in the order given, each once */
  featureSetOfRows(refs: Int32Array): IdSet;
  /**
   * The set of features without those that cannot be seen (their own visible flag, that of their
   * group or their layer, or this client hiding one of them), read from the rows without the
   * features being made: the set itself when every one is seen
   */
  shownFeatureSetOf(ids: IdSet): IdSet;
  /**
   * The features of layers that can be seen, as a set of their rows: in the order of the layers
   * given, each in its order (the features of its groups at their place), read without the
   * features being made. The set is a copy of the rows the layers hold now
   */
  shownFeatureSetOfLayers(layerIds: readonly string[]): IdSet;
  /**
   * The references of the rows the features of a set are now, in the order of the set (a feature
   * deleted since the set was made is left out); not to be written
   */
  rowsOfFeatureSet(ids: IdSet): Int32Array;
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

/** The values of the rows of features read as arrays (see `DocumentPlaces.readFeatureValues`) */
export interface FeatureValuesRead {
  /**
   * The values, as `readValues` of the tables of the Store gives them: entry `k` of each field for
   * the `k`-th row read
   */
  readonly values: RowValues;
  /** The position among the IDs given of the ID of each row read, rising */
  readonly indices: Int32Array;
  /**
   * The position among the IDs given of the first ID not looked at, where a next read starts
   * (the number of the IDs once every one is looked at)
   */
  readonly end: number;
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
   * Whether the row of a reference is locked, read without the feature being made: a row there by
   * its own lock, that of its group and that of its layer; a deleted row that is kept by the lock
   * it was kept with, and those of the group and the layer it goes back to as they are now (its
   * layer read from its group, or `layerId` when its group is not there). False for a reference
   * that names no row
   *
   * @param layerId - The layer of the row, read when its group is not there
   */
  isRowLocked(ref: number, layerId?: string): boolean;
  /**
   * The values of fields of features, read from their rows as arrays, as the Store reads them
   * (one array per field, the geometries as one column), without the features being made: the
   * rows of the IDs from `start` on that are in the layer of the first of them that is a
   * feature, up to the first ID of a feature of another layer. An ID that is not a feature is
   * left out
   *
   * @param start - The position among `ids` of the first ID read (0 when left out)
   */
  readFeatureValues(
    ids: readonly string[],
    fields: readonly FeatureRowField[],
    start?: number,
  ): FeatureValuesRead;
  /**
   * Runs `fn` while the features made are kept beyond the number the layer keeps, and lets go
   * of those over it afterwards: for a caller that reads back the many features it wrote
   */
  holdFeatures<T>(fn: () => T): T;
  /**
   * The features of the IDs given in stacking order, from the back: what is read is the place of
   * each of them alone (an ID that is not a feature is left out)
   */
  sortInStackingOrder(ids: readonly string[]): string[];
  /**
   * The groups of the IDs given in stacking order, from the back: what is read is each of the
   * groups and the stacking order of the layers. The groups that stand in no layer of the
   * stacking order (a group with no feature, which is no item of its layer, or one of a layer off
   * the order) come after them, in the order given; an ID that is not a group is left out
   */
  sortGroupsInStackingOrder(ids: readonly string[]): string[];
  /**
   * Where an item is now: a feature in its group, or in its layer when it is in no group, and a
   * group in its layer, read from its key without the other items of the container being read.
   * Undefined for an ID that names neither, and for a group with no feature (no item of its
   * layer)
   */
  getItemPosition(id: string): ItemPosition | undefined;
  /** Counts the features that match */
  countFeatures(match?: FeatureMatch): number;
  /**
   * The features that match when it starts, in stacking order from the back, each made as the
   * iterator reaches it; a feature deleted meanwhile is skipped
   */
  iterateFeatures(match?: FeatureMatch): IterableIterator<Feature>;
  /**
   * Where an item (a feature or a group) was before the change being told, while it is told:
   * the layer or the group it was in, and its position there, from the back, counted as the
   * container was before the change. Undefined outside the telling of a change, and for an item
   * the change created. Counted for a change that moves items, while the changes are noted in
   * the words of the features: from the order now and what the change put in each container and
   * took out of it (the places before of the rows a change deleted are read only when it moves
   * items)
   */
  getItemPositionBefore(id: string): ItemPosition | undefined;
}

/** Where an item is (see `DocumentPlaces.getItemPosition`) */
export interface ItemPosition {
  /** The group or the layer the item is in */
  readonly containerId: string;
  /** Its position there, from the back */
  readonly index: number;
}

/**
 * Where a feature is created in its container (its group, or its layer when it is in no group):
 * just in front of an item of that container (a feature, or a group of the layer), at the key
 * of the order an item has in its own container (the copies of the features of a group, made in
 * a new group in the order of their originals), or at a key of the order given (a document read,
 * whose order of items decides the keys)
 */
export type CreatedPlace =
  | { readonly inFrontOf: string }
  | { readonly keyOf: string }
  | { readonly key: string };

/** The writes that move features and groups, and the replacements of the whole document */
export interface DocumentMoves {
  /**
   * Creates features, each as `createFeature` does, one after another in one transaction (the
   * rows of one layer that follow each other are written at once)
   */
  createFeatures(features: readonly Feature[]): boolean;
  /**
   * Creates features, each as `createFeature` does but at the place given (`places[i]` for
   * `features[i]`), one after another in one transaction; a place whose item is not in the
   * container of the feature puts the feature at the front
   */
  createFeaturesAt(features: readonly Feature[], places: readonly CreatedPlace[]): boolean;
  /**
   * Creates a group, as `createGroup` does with no feature, just in front of an item of its layer
   * (a feature in no group, or a group); at the front when the item is not in the layer
   */
  createGroupInFrontOf(group: Group, itemId: string): boolean;
  /**
   * Creates a group in its layer and puts features in it, in one transaction: the features go
   * in it in the order given, and they leave their groups (a group they leave empty is
   * deleted). The group stands where the frontmost of the features that stand in the layer
   * outside a group stood, and at the front of the layer when none does; with no feature, it is
   * created at the front of its layer, as `createGroup` creates it. An ID that is not a feature
   * is left out
   */
  createGroupWith(group: Group, featureIds: readonly string[]): boolean;
  /**
   * Writes values of rows of a layer as columns, as the Store writes them (`writeRows`): the
   * fields given (`parent` and `orderKey` included), the geometries, and the deletion (0 brings a
   * deleted row that is kept back, at its place, and any other value deletes the row). The rows
   * that are locked (themselves, their group or their layer; a deleted row by the lock it was
   * kept with) are left out unless `ignoreLocks` is given, and the edit being written in parts is
   * applied first to the others. A row whose group is not there goes into the layer, at its front.
   * The rows brought back are told as created. A new `parent` puts a row in another layer (that
   * of the parent, or of its group), as the Store writes it: the rows of one call are in one layer
   * and go into the layer given
   *
   * @param layerId - The layer the rows are written in: the one they are in, or the one their new
   *   `parent` puts them in (where a row whose group is not there goes, at its front)
   * @returns The rows written (none when the Store refused the write)
   */
  writeRowValues(
    layerId: string,
    values: RowValues,
    options?: { readonly ignoreLocks?: boolean },
  ): Int32Array;
  /**
   * Puts a group in a layer under a key: creates it with its values when it is not there (with no
   * feature), or moves it there with its features
   */
  placeGroup(group: Group, layerId: string, key: string): boolean;
  /**
   * Moves features, given in stacking order, to a layer, into a group or out of their group,
   * keeping their order, in one transaction
   */
  moveFeatures(ids: readonly string[], to: MoveDestination): boolean;
  /**
   * Moves groups, given in stacking order, to a layer at a position (the front when it is left
   * out), in one transaction
   */
  moveGroups(ids: readonly string[], layerId: string, index: number | undefined): boolean;
  /**
   * Calls the listener whenever the Store tells a change that replaces its whole document
   *
   * @returns The function that stops
   */
  onReset(listener: () => void): () => void;
}

/**
 * How the box of a feature is worked out, for the types whose box comes from more than their
 * positions (an Image, a Circle, a type that works out its own extent)
 */
export interface FeatureBoxes {
  /** Whether the features of a type have the box `boxOf` gives (the others, that of their positions) */
  gives(type: string): boolean;
  /** The box of a feature of a type that gives it */
  boxOf(feature: Feature): BoundingBox;
}

/** The reads of the features by the boxes they cover, from the spatial index of the Store */
export interface DocumentBoxes {
  /**
   * The IDs of the features whose box meets a box, in no particular order: the hidden features
   * included, the deleted ones not. The box of a feature is that of its positions, or the one the
   * boxes set give (`setFeatureBoxes`)
   */
  findFeatureIdsInBox(bounds: BoundingBox): string[];
  /**
   * Sets how the boxes of the features of some types are worked out, and makes the boxes again
   * (with the same boxes, it makes them again): null takes them back, so that every feature has
   * the box of its positions
   */
  setFeatureBoxes(boxes: FeatureBoxes | null): void;
  /**
   * The rows of the candidates of a box that can be selected, in stacking order from the back:
   * the features seen (as `shownFeatureSetOf` reads them) that are not locked (themselves, their
   * group or their layer), read without the features being made, each marked with whether the box
   * of its positions lies wholly inside one of the boxes
   *
   * @param candidateIds - The features the spatial index found (an ID that names none is left out)
   * @param boxes - The boxes of the selection (two for a box across the antimeridian)
   * @param decided - Whether a row of a type wholly inside a box is taken without its test: only
   *   such a row is marked
   */
  listSelectableRows(
    candidateIds: Iterable<string>,
    boxes: readonly BoundingBox[],
    decided: (type: string) => boolean,
  ): SelectableRows;
  /**
   * The features of the IDs given that are shown, in stacking order from the back, read without
   * the features being made: the features `listFeaturesInOrder` lists, in its order, without
   * those whose own visible flag, or that of their group or their layer, is off, and those this
   * client hides. The features of a layer off the stacking order are left out; locked ones are
   * not. An ID that names no feature is left out
   *
   * @param ids - The features asked about (the candidates the spatial index found, say)
   */
  listShownInOrder(ids: Iterable<string>): ShownInOrder;
  /**
   * Every feature of the type `Point` or `MultiPoint` that is shown (as `listShownInOrder` reads
   * them), in stacking order from the back, with its positions, read as columns without the
   * features being made
   */
  listShownPoints(): ShownPoints;
  /**
   * The largest radius (`pointRadius`) and the largest width of the outline (`pointStrokeWidth`)
   * the styles of the features of the type `Point` or `MultiPoint` name, each a finite number
   * (0 when none names one): no point names more. They are read from every row when first asked
   * for, raised by the rows written afterwards and never lowered (so they may be larger than what
   * the points name now), and read again after the whole document is replaced
   */
  largestPointMarker(): PointMarkerExtent;
}

/** The features shown, in stacking order (see `DocumentBoxes.listShownInOrder`) */
export interface ShownInOrder {
  /** Their IDs, in stacking order from the back */
  readonly ids: readonly string[];
  /** The layer of each, entry `k` for `ids[k]` */
  readonly layerIds: readonly string[];
}

/** The points shown, with their positions (see `DocumentBoxes.listShownPoints`) */
export interface ShownPoints {
  /** The type of each point, in stacking order from the back */
  readonly types: readonly string[];
  /**
   * Where the positions of each point start in `coordinates`, in positions: one more entry than
   * there are points, so those of point `k` are from `starts[k]` to `starts[k + 1]`
   */
  readonly starts: Int32Array;
  /** The longitude and the latitude of every position, in degrees, one pair after the other */
  readonly coordinates: Float64Array;
  /** The ID of point `k` */
  idOf(k: number): string;
}

/** The largest marker the points name (see `DocumentBoxes.largestPointMarker`) */
export interface PointMarkerExtent {
  /** The largest `pointRadius`, in CSS pixels */
  readonly radius: number;
  /** The largest `pointStrokeWidth`, in CSS pixels */
  readonly strokeWidth: number;
}

/** The rows a box can select (see `listSelectableRows`) */
export interface SelectableRows {
  /** The references of the rows, in stacking order from the back */
  readonly refs: Int32Array;
  /**
   * One entry per row: 1 when the box of its positions lies wholly inside a box and its type is
   * decided so, 0 otherwise
   */
  readonly inside: Uint8Array;
}

/** The rows of the document as the Store holds them */
export interface DocumentTables {
  /**
   * The tables of the Store (its `tables`): what reads the rows without making a feature per row
   * (the drawing) reads them from here
   */
  getTables(): FeatureTables;
}

/** What the operations written in parts read of the layer, and the call before a write */
export interface DocumentOperations {
  /**
   * The number of the operation of the transaction of the Store open now (undefined outside
   * one): what an operation started inside a transaction takes as its own
   */
  currentOperationId(): number | undefined;
  /**
   * The source of the transaction of the Store open now through the instance (undefined outside
   * one): the source the writes of the instance have in it, that of a transaction opened on the
   * Store directly when they fold into one
   */
  currentSource(): UpdateSource | undefined;
  /**
   * Sets the function called before a write of this client writes the row of a feature (a write
   * of its values, its deletion, or a move; not its creation), with the ID of the feature, or
   * takes it back (null). `applyEditFirst` calls the same function, before a write reads the
   * feature. Only one is set at a time; a change written to the Store directly does not call it
   */
  setBeforeFeatureWrite(before: ((id: string) => void) | null): void;
  /**
   * Lets go of what the layer keeps for the operations whose last part has not come (the parts
   * of an operation told so far, for its last part to be told even when it is empty)
   */
  releaseOpenOperations(): void;
  /**
   * Marks the layers being deleted (null takes the mark back): the writes of this client to them,
   * to their groups and to their features are refused, as the Store refuses a write (they return
   * false), whether they ignore the locks or not, except those `asLayerDeletion` runs
   */
  setLayersBeingDeleted(ids: ReadonlySet<string> | null): void;
  /** Runs `fn` as the writes of the deletion of the layers marked, which the mark does not refuse */
  asLayerDeletion<T>(fn: () => T): T;
  /** Whether a layer is marked as being deleted (see `setLayersBeingDeleted`) */
  isLayerBeingDeleted(id: string): boolean;
  /**
   * Notes that the transaction open writes whole geometries (a move, a rotation, a scaling): its
   * change carries the mark, so that what it wrote is taken back whole. With rows, only the
   * geometries of those rows are (the others it writes are taken back vertex by vertex).
   * Nothing outside a transaction
   */
  markWholeGeometry(rows?: Int32Array): void;
}

/**
 * The layer over the Store an instance makes: the four parts, the reads by position, the moves,
 * the reads by box, the tables and what the operations written in parts read of it
 */
export interface InstanceDocument
  extends DocumentAccess,
    DocumentPlaces,
    DocumentMoves,
    DocumentBoxes,
    DocumentTables,
    DocumentOperations {}
