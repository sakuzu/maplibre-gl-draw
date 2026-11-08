// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Store: where the document and the state of this client are kept
 *
 * The built-in Store keeps them in memory. An application replaces it through the `store`
 * option of `createDraw`, for example to keep the document somewhere shared.
 */

import type { Geometry } from 'geojson';
import type { DocumentChange } from '../events.js';
import type {
  EditResult,
  Feature,
  FeatureEdit,
  FeatureType,
  FileData,
  Group,
  ItemPlacement,
  Layer,
  Metadata,
} from '../model.js';
import type {
  Mode,
  Selection,
  SelectionType,
  VertexId,
  VertexRef,
  VertexSelection,
} from '../state.js';
import type { FeatureTables, RowWrite } from '../tables.js';

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
 * An edit that moves, rotates or scales features, without the features it names: what
 * {@link GeometryTransforms} computes. Its points are `[longitude, latitude]`, two numbers.
 */
export type TransformEdit =
  | Omit<Extract<FeatureEdit, { kind: 'translate' }>, 'target'>
  | Omit<Extract<FeatureEdit, { kind: 'rotate' }>, 'target'>
  | Omit<Extract<FeatureEdit, { kind: 'scale' }>, 'target'>;

/**
 * The values of one feature an edit that moves, rotates or scales features changes
 * ({@link GeometryTransforms.apply}): its geometry, and the fields its type changes with it.
 *
 * A key of a field is there only when the type of the feature has that field (a custom type has
 * the ones it declares, {@link TransformFields}): its value is the one the feature has, or `null`
 * when the feature has none yet. An edit starts a field of `null`
 * from 0 for `angleDegrees` and from 1 for `size`, and leaves `bearingDegrees` at `null`.
 */
export interface TransformValues {
  /** The GeoJSON geometry */
  readonly geometry: Geometry;
  /**
   * The rotation, in degrees counterclockwise: a rotation adds its angle, within [0, 360)
   * (the rotation of an image)
   */
  readonly angleDegrees?: number | null;
  /**
   * A direction, in degrees clockwise from the north: a rotation takes its angle away, within
   * [0, 360)
   */
  readonly bearingDegrees?: number | null;
  /** A size: a scaling multiplies it by `sizeFactor` (the scale of an image, the radius of a circle) */
  readonly size?: number | null;
  /**
   * Whether a scaling moves the positions by `sizeFactor` along both the east and the north in
   * place of `eastFactor` and `northFactor`, so that the feature keeps its shape (an image, a
   * circle)
   */
  readonly uniformScale?: boolean;
}

/**
 * The fields of the features of a custom type that the edits that move, rotate and scale features
 * change with their geometry, as the type declares them (`FeatureTypeDefinition.transformFields`):
 * the keys of `properties` that hold them. A Store gives its computation their values as the
 * fields of {@link TransformValues}: the value under `angleDegreesKey` as `angleDegrees`, the
 * value under `scaleKey` as `size`, and `uniformScale` as it is. A custom type has no
 * `bearingDegrees`.
 *
 * For example, a type of signboards whose features keep their rotation under `boardAngle` and
 * the factor of their size under `boardScale`, and keep their shape when they are scaled, declares
 * `{ angleDegreesKey: 'boardAngle', scaleKey: 'boardScale', uniformScale: true }`. The resize and
 * the rotation then write those keys as the edits compute them, and a Store reads them to give
 * its computation the values of a feature.
 */
export interface TransformFields {
  /**
   * The key of `properties` that holds the rotation of a feature, in degrees counterclockwise
   * (`TransformValues.angleDegrees`). A rotation adds its angle to it, within [0, 360); a feature
   * without the key starts from 0.
   */
  readonly angleDegreesKey?: string;
  /**
   * The key of `properties` that holds the factor of the size of a feature
   * (`TransformValues.size`). A scaling multiplies it by `sizeFactor`; a feature without the key
   * starts from 1.
   */
  readonly scaleKey?: string;
  /**
   * Whether a scaling moves the positions of a feature by `sizeFactor` along both the east and
   * the north, so that it keeps its shape (`TransformValues.uniformScale`); false when it is left
   * out.
   */
  readonly uniformScale?: boolean;
}

/**
 * How a Store computes the edits that move, rotate and scale features
 * ({@link Store.transforms}).
 */
export interface GeometryTransforms {
  /**
   * Whether the Store takes the values of an edit (its points, its angle, its factors). An edit
   * it does not take makes `applyEdits` throw `invalid-input`, storing nothing.
   */
  accepts(edit: TransformEdit): boolean;
  /**
   * The values of one feature with an edit applied: its geometry and its fields, in the same
   * shape as they are given (a field given is given back). An edit that does nothing (a move to
   * the same point, a rotation by 0, a scaling whose factors are all 1) gives the values back as
   * they are.
   */
  apply(edit: TransformEdit, values: TransformValues): TransformValues;
}

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
 * - A Store that holds its features as rows (`tables`) notifies the rows written as `rows`
 *   (with the values they had before, for the writes of this client: `previousValues`),
 *   whether they are selected or not; a row is in a notification once. `listFeatures` and
 *   `listFeaturesInOrder` throw: the rows are read from the tables.
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
  /**
   * The features of the layers the Store holds as rows of columns, when it holds them so
   * ({@link kasane!createFeatureTables | createFeatureTables}). The instance draws and hit tests such a layer from its rows,
   * and makes a feature of a row only when one is asked for. Undefined for a Store that holds
   * its features as objects. Its type is in `@sakuzu/maplibre-gl-draw/kasane`
   *
   * @experimental
   */
  readonly tables?: FeatureTables;
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
 * - The moves are notified: every item (a feature or a group) a write puts in another place of
 *   the stacking order, within its layer or group or into another one, created or deleted, is in
 *   the `order` of the notification, with where it was and where it is
 *   ({@link DocumentChange.order}). The instance tells the items it put in another place as
 *   `placed` of `change` from it, and tells no move the Store leaves out.
 * - The stacking order: `createLayer` adds the new layer at the front unless the order
 *   already holds it, `deleteLayer` takes it out, and no other write adds or removes entries.
 * - Writes return whether they were applied: a write of the document returns true when it
 *   changed the Store, and false when it was refused, changing nothing (`applyEdits` returns
 *   what it applied, and `null` when it was refused). A write whose argument cannot apply (an
 *   ID that names nothing) may throw instead, storing nothing.
 * - Read-only refusals: the instance does not call the writes of the document while
 *   `isReadOnly()` is true, and a Store may refuse them then (and for reasons of its own) by
 *   returning false (`null` for `applyEdits`). The interaction lock does not stop any write.
 *   The writes of the state of this client return nothing: the instance takes them as applied.
 */
export interface Store extends StoreView {
  /** Creates a feature. */
  createFeature(feature: Feature): boolean;
  /**
   * Creates features, one after the other in the order given, as `createFeature` creates each
   * (all of them or none: it throws before creating any when one cannot be created). A Store
   * that holds its features as rows has it, and writes the features of a layer to its tables at
   * once, so that many features cost their own rows, not the rows of their layer once per feature.
   * A Store without it is given the features one at a time.
   */
  createFeatures?(features: readonly Feature[]): boolean;
  /** Changes the fields given of a feature. */
  updateFeature(id: string, updates: Partial<Feature>): boolean;
  /**
   * Applies edits of features, one after the other in the order given, as one transaction:
   * every edit applies over the feature as the edits before it leave it, and the edits apply all
   * of them or none.
   *
   * An edit of a feature that is not there (deleted, or never created) is left out and counted in
   * the result; the other edits apply. A Store that gives its vertices no IDs takes the vertices
   * of the edits by their places ({@link VertexRef}) only.
   *
   * The edits that move, rotate and scale features name their features by their IDs
   * (`{ featureIds }`): each feature that is not there is left out and counted. The instance
   * makes `{ selection: true }` the IDs of the features selected before it calls the Store. They
   * are computed by {@link Store.transforms}, or by the computation of the library when the Store
   * has none, over the geometry of each feature and the fields of its type: for a custom type,
   * the ones it declares ({@link TransformFields}, read with
   * `draw.extensions.featureTypes.get(type)`).
   *
   * @returns What was applied, or `null` when the Store refuses the edits, changing nothing
   *   (read-only, or a reason of its own)
   * @throws DrawError `invalid-input`, storing nothing, when an edit cannot apply: an edit or a
   *   patch of the wrong shape, a vertex the feature does not have, positions that do not match
   *   the vertices, an insert with both or neither of `after` and `before`, a deletion that
   *   leaves a line or a ring with too few positions, a target of `{ selection: true }`, or an
   *   edit whose values the computation does not take (`accepts`)
   */
  applyEdits(edits: readonly FeatureEdit[]): EditResult | null;
  /**
   * How the Store computes the edits that move, rotate and scale features (`applyEdits`).
   * Optional: without it, the library computes them on the WGS 84 ellipsoid, in the east, north
   * and up axes of the point the edit names. A Store gives its own to compute them as the
   * document it keeps them in does, so that what the instance shows of an edit and what the
   * Store writes are computed alike.
   */
  readonly transforms?: GeometryTransforms;
  /**
   * The IDs of vertices of a feature, given by their places: the ID of each, in the same order.
   * Optional, for a Store that gives its vertices IDs ({@link VertexId}), which stay the vertex's
   * while other vertices are added before it and deleted. The instance asks only for the vertices
   * it edits (a sketch of them), and gives the IDs back to `findVertices` and to `applyEdits`.
   */
  getVertexIds?(featureId: string, vertices: readonly VertexRef[]): readonly VertexId[];
  /**
   * The places of vertices of a feature, given by their IDs: the place of each in the geometry of
   * now, in the same order, or `null` for a vertex that is no longer there (or a feature that is
   * not there). Optional, with `getVertexIds`: the instance reads where the vertices of a sketch are
   * after the feature was written.
   */
  findVertices?(featureId: string, ids: readonly VertexId[]): (VertexRef | null)[];
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
  /**
   * Puts an item (a feature, or a group of features) in a place: in a layer, or in a group, just
   * above an item and below another (see {@link ItemPlacement}). Optional for a Store that holds
   * its features as objects (the instance writes the items of the layers and the groups then);
   * a Store that holds its features as rows has it.
   */
  moveItem?(itemId: string, to: ItemPlacement): boolean;
  /**
   * Puts items in a place, one after the other in the order given (see {@link Store.moveItem}).
   * A Store that holds its features as rows makes the keys of their order at once, so that many
   * items put in one place keep short keys. A group a feature leaves empty is deleted.
   */
  moveItems?(itemIds: readonly string[], to: ItemPlacement): boolean;
  /**
   * Writes rows held as columns for this client (the operations of the instance on many rows at
   * once, and what undoes them): makes the keys of the order of the rows put in a place and the
   * handles of the new rows, writes the rows (`FeatureTablesWriter.apply`), and notifies them with
   * the values they had before. A Store that holds its features as rows has it. Its type is in
   * `@sakuzu/maplibre-gl-draw/kasane`
   *
   * @experimental
   */
  applyRows?(write: RowWrite): boolean;
  /** Creates a group. */
  createGroup(group: Group): boolean;
  /**
   * Creates groups, one after the other in the order given, as `groups.create` puts each: at
   * the place of the frontmost of its features that is an item of its layer (at the front when
   * none is), its features joining it in their order (all of them or none: it throws before
   * creating any when one cannot be created). A Store that holds its features as rows has it,
   * and writes the groups and the features that join them at once. A Store without it is given
   * the groups one at a time (`createGroup`, then `moveItems` to the place).
   */
  createGroups?(groups: readonly Group[]): boolean;
  /** Changes the fields given of a group. */
  updateGroup(id: string, updates: Partial<Group>): boolean;
  /** Deletes a group. */
  deleteGroup(id: string): boolean;
  /**
   * Deletes groups, as `deleteGroup` deletes each: the features of each take its place, in their
   * order. A Store that holds its features as rows has it, and writes the features of a layer at
   * once. A Store without it is given the groups one at a time.
   */
  deleteGroups?(ids: readonly string[]): boolean;
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
  /**
   * The largest number of a generated name ("Point 7") the Store knows to be used for this
   * type: a feature type, `'Layer'` or `'Group'`. Optional.
   *
   * The instance numbers the names of new features, layers and groups from the names it can
   * read through `listFeatures`, `listLayers` and `listGroups`. A Store that holds only part
   * of the document can implement this method to give the numbers used in the part it does
   * not hold, so that they are not used again: the next number is the one after the larger
   * of the two. Return `undefined` when the Store knows nothing more than what it lists.
   */
  getMaxNameNumber?(type: FeatureType | 'Layer' | 'Group'): number | undefined;
  /**
   * Tells the Store the number of a name the instance has just generated for this type: a
   * feature type, `'Layer'` or `'Group'`. Optional.
   *
   * It is called once per generated name, as the name is generated; the name may still not be
   * written (a refused write leaves its number unused, as a deletion does). A Store that
   * implements {@link Store.getMaxNameNumber} can use it to keep what that method returns up
   * to date.
   */
  recordNameNumber?(type: FeatureType | 'Layer' | 'Group', number: number): void;
  /**
   * Whether the Store takes a feature, a group or a layer with this id. Optional: a Store
   * without it takes every id.
   *
   * A Store whose ids are made by its host (the ids of a writer of a shared document) takes the
   * ids of that form only. A load gives a feature, a group or a layer whose id the Store does
   * not take a new id (`generateId` of the instance), as it does to an id that is taken, and
   * the references to it name the new one. A feature, a group or a layer created with an id
   * given (`features.create`, `features.createMany`, `groups.create`, `layers.create`, a
   * sketch that creates a feature, and the new layer and group of a load) is checked before
   * anything is written: an id the Store does not take throws a `DrawError` with the code
   * `invalid-input`, and nothing is written. So a Store that takes the id of something deleted,
   * to bring it back, answers true for it.
   *
   * It is given the id alone, not whether it is the id of a feature, a group or a layer: a Store
   * takes or refuses an id by its form. It is not asked of the ids `generateId` makes, which the
   * Store is given with: give the instance a `generateId` whose ids the Store takes. Nor is it asked of a group a Store of rows
   * brings back (`groups.restore`), which keeps its id.
   */
  acceptsId?(id: string): boolean;
}
