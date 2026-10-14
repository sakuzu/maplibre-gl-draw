// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DrawStore
 *
 * The Store core works with: a {@link StoreContract} (the in-memory one, or one the host gave)
 * and the state only the drawing reads, behind one gate. It reaches the contract only through
 * the members of the public `Store`.
 *
 *   - Read-only is enforced here, at the write methods of the document. A refused write
 *     returns false and touches nothing. Changes applied to the contract from elsewhere are not
 *     stopped by it.
 *   - The notifications of the contract are forwarded into the ChangeBus of this Store, so a
 *     listener gets one StoreChange per transaction with every kind of change.
 *   - What the contract returns and notifies is read in the shape of the public types: an
 *     optional field it gives as `null` (`Feature.groupId`, `Layer.metadata`,
 *     `Layer.styleRule`) is read as `undefined`. The normalized object is kept per object of
 *     the contract, so the same object of the contract always reads as the same object here.
 *   - Deletions reach the state of this client: the id of a deleted feature, group or layer
 *     leaves the selection, the features being edited and the locally hidden set, whatever
 *     deleted it, through the writes of the contract.
 *   - The selection holds only what can be seen: a change that hides a selected item (its own
 *     visible flag, the one of its group or layer, or local hiding) takes it out of the
 *     selection, and the vertex selection ends when its feature is deleted or its coordinates
 *     change other than by a drag. This is the only place that keeps these invariants; the
 *     modes and the public API rely on it.
 */

import type { FeatureTables, LocalRowWrite, RowPatch } from '../api/tables.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import {
  tableGroupMemberCount,
  tableGroupMemberIds,
  tableLayerFeatureCount,
  tableLayerFeatureIds,
} from '../feature-table/item-ids.js';
import { coordinatesOf } from '../shared/utils/coordinates.js';
import { ChangeBus } from './memory/change-bus.js';
import { MemoryDrawingState } from './memory/ui-state.js';
import { moveItemsByLists } from './move-items.js';
import type { Store, StoreContract } from './store.js';
import type {
  BoxSelection,
  DragState,
  Feature,
  FeatureType,
  FileData,
  Group,
  ItemPlacement,
  Layer,
  Metadata,
  Mode,
  RowValuesSnapshot,
  Selection,
  SelectionType,
  StoreChange,
  TentativeState,
  UpdateFeatureOptions,
  UpdateSource,
  VertexSelection,
} from './types.js';

/**
 * The most features of rows held at once for the selection, the editing and the drag (a
 * selection of more is refused for now)
 *
 * @internal
 */
export const HOLD_LIMIT = 2000;

/**
 * The owner of the rows held for the selection, the editing, the vertices selected and the
 * vertices that follow a drag
 *
 * @internal
 */
export const SELECTION_OWNER = 'core:selection';

/**
 * The owner of the rows the selection let go of, held a moment longer (a quick click elsewhere
 * and back does not make them features again)
 *
 * @internal
 */
export const RELEASED_OWNER = 'core:released';

/**
 * How long the rows the selection let go of stay held (ms)
 *
 * @internal
 */
export const RELEASE_DELAY_MS = 100;

/**
 * Returns the Store for a store option: a Store of core is used as it is, a Store of the host
 * gets the drawing state and the read-only gate of core around it
 *
 * @internal
 */
export function toStore(store: StoreContract | Store): Store {
  return store instanceof DrawStore ? store : new DrawStore(store);
}

/**
 * The Store of core over a {@link StoreContract}
 *
 * @internal
 */
export class DrawStore implements Store {
  readonly #contract: StoreContract;
  readonly #bus = new ChangeBus();
  readonly #drawing = new MemoryDrawingState(this.#bus);
  /** The normalized copy of each object of the contract that gave `null` for an optional field */
  readonly #normalized = new WeakMap<object, object>();
  /** The ids of the rows held for the selection, as last held */
  #heldIds = new Set<string>();
  /**
   * Whether what the rows held for the selection are read from may have changed since they were
   * last held (the selection, the editing, the vertices selected, the vertices that follow a drag,
   * the members of a group or a layer selected): a write of the document that changes none of it
   * (a feature moved in the middle of a drag) does not read them again
   */
  #heldStale = true;
  /** The type of the selection the rows held were read from (current while they are not stale) */
  #heldSelectionType: SelectionType | null = null;
  /** The rows the selection let go of, held a moment longer */
  readonly #released = new Set<string>();
  #releaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(contract: StoreContract) {
    this.#contract = contract;
    contract.subscribe((changes) => this.#receive(changes));
  }

  // ============================================================================
  // The document: reads
  // ============================================================================

  /** The features of the layers the contract holds as rows of columns */
  get tables(): FeatureTables | undefined {
    return this.#contract.tables;
  }

  getFeature(id: string): Feature | undefined {
    const feature = this.#contract.getFeature(id);
    return feature && this.#feature(feature);
  }
  listFeatures(): Feature[] {
    return this.#features(this.#contract.listFeatures());
  }
  listFeaturesInOrder(): Feature[] {
    return this.#features(this.#contract.listFeaturesInOrder());
  }
  getLayer(id: string): Layer | undefined {
    const layer = this.#contract.getLayer(id);
    return layer && this.#layer(layer);
  }
  listLayers(): Layer[] {
    const layers = this.#contract.listLayers();
    return layers.some(hasNullLayerField) ? layers.map((layer) => this.#layer(layer)) : layers;
  }
  getLayerOrder(): readonly string[] {
    return this.#contract.getLayerOrder();
  }
  getGroup(id: string): Group | undefined {
    return this.#contract.getGroup(id);
  }
  listGroups(): Group[] {
    return this.#contract.listGroups();
  }
  getFile(id: string): FileData | undefined {
    return this.#contract.getFile(id);
  }
  listFiles(): FileData[] {
    return this.#contract.listFiles();
  }
  getMetadata(): Metadata {
    return this.#contract.getMetadata();
  }

  // ============================================================================
  // The document: writes (gated by read-only)
  // ============================================================================

  createFeature(feature: Feature): boolean {
    return this.#write(() => this.#contract.createFeature(feature));
  }
  updateFeature(id: string, updates: Partial<Feature>, options?: UpdateFeatureOptions): boolean {
    return this.#write(() => this.#contract.updateFeature(id, updates, options));
  }
  abortIntermediateUpdates(ids: string[]): void {
    this.#contract.abortIntermediateUpdates?.(ids);
  }
  deleteFeature(id: string): boolean {
    return this.#write(() => {
      const deleted = this.#contract.deleteFeature(id);
      // At once, so that the rest of a transaction already sees the selection without it
      if (deleted) this.#forget(id);
      return deleted;
    });
  }

  createLayer(layer: Layer): boolean {
    return this.#write(() => this.#contract.createLayer(layer));
  }
  updateLayer(id: string, updates: Partial<Layer>): boolean {
    return this.#write(() => this.#contract.updateLayer(id, updates));
  }
  deleteLayer(id: string): boolean {
    return this.#write(() => this.#contract.deleteLayer(id));
  }
  setLayerOrder(order: string[]): boolean {
    return this.#write(() => this.#contract.setLayerOrder(order));
  }
  reorderInLayer(itemId: string, layerId: string, newIndex: number): boolean {
    return this.#write(() => this.#contract.reorderInLayer(itemId, layerId, newIndex));
  }
  reorderInGroup(featureId: string, groupId: string, newIndex: number): boolean {
    return this.#write(() => this.#contract.reorderInGroup(featureId, groupId, newIndex));
  }
  moveItem(itemId: string, to: ItemPlacement): boolean {
    return this.moveItems([itemId], to);
  }
  moveItems(itemIds: readonly string[], to: ItemPlacement): boolean {
    return this.#write(() => {
      const contract = this.#contract;
      if (contract.moveItems) return contract.moveItems(itemIds, to);
      // A Store of objects that does not put items in a place: its lists are written
      moveItemsByLists(contract, itemIds, to);
      return true;
    });
  }
  applyLocal(write: LocalRowWrite): boolean {
    const contract = this.#contract;
    if (!contract.tables || !contract.applyLocal) {
      throw new Error('The Store does not hold its features as rows: it writes no rows');
    }
    return this.#write(() => (contract.applyLocal as (w: LocalRowWrite) => boolean)(write));
  }
  applyRows(patch: RowPatch): RowValuesSnapshot | null {
    const tables = this.#contract.tables;
    if (!tables || !this.#contract.applyLocal) {
      throw new Error('The Store does not hold its features as rows: it writes no rows');
    }
    if (this.#contract.isReadOnly()) return null;
    const before = tables.snapshot(patch);
    return this.applyLocal({ patch, before }) ? before : null;
  }

  createGroup(group: Group): boolean {
    return this.#write(() => this.#contract.createGroup(group));
  }
  updateGroup(id: string, updates: Partial<Group>): boolean {
    return this.#write(() => this.#contract.updateGroup(id, updates));
  }
  deleteGroup(id: string): boolean {
    return this.#write(() => this.#contract.deleteGroup(id));
  }

  createFile(file: FileData): boolean {
    return this.#write(() => this.#contract.createFile(file));
  }
  deleteFile(id: string): boolean {
    return this.#write(() => this.#contract.deleteFile(id));
  }

  setMetadata(metadata: Partial<Metadata>): boolean {
    return this.#write(() => this.#contract.setMetadata(metadata));
  }

  // ============================================================================
  // The numbers of generated names (optional members of the contract)
  // ============================================================================

  getMaxNameNumber(type: FeatureType | 'Layer' | 'Group'): number | undefined {
    return this.#contract.getMaxNameNumber?.(type);
  }
  recordNameNumber(type: FeatureType | 'Layer' | 'Group', number: number): void {
    this.#contract.recordNameNumber?.(type, number);
  }

  // ============================================================================
  // The state of this client (kept by the contract)
  // ============================================================================

  getSelection(): Selection {
    return this.#contract.getSelection();
  }
  setSelection(type: SelectionType | null, ids: string[]): void {
    // The features of rows held for a selection are counted: more than the limit is refused
    const count = this.#heldCount(type, ids);
    if (count > HOLD_LIMIT) {
      console.warn(
        `A selection of ${count} features held as rows is refused: at most ${HOLD_LIMIT} are selected at once`,
      );
      return;
    }
    this.#local(() => this.#contract.setSelection(type, ids));
  }

  getEditingIds(): readonly string[] {
    return this.#contract.getEditingIds();
  }
  startEditing(ids: string[]): void {
    this.#local(() => this.#contract.startEditing(ids));
  }
  endEditing(ids: string[]): void {
    this.#local(() => this.#contract.endEditing(ids));
  }

  getVertexSelection(): VertexSelection | null {
    return this.#contract.getVertexSelection();
  }
  setSelectedVertices(selection: VertexSelection | null): void {
    this.#local(() => this.#contract.setSelectedVertices(selection), true);
  }

  getMode(): Mode {
    return this.#contract.getMode();
  }
  setMode(mode: Mode): void {
    this.#local(() => this.#contract.setMode(mode));
  }

  isReadOnly(): boolean {
    return this.#contract.isReadOnly();
  }
  setReadOnly(value: boolean): void {
    if (this.#contract.isReadOnly() === value) return;
    this.#local(() => this.#contract.setReadOnly(value), true);
  }

  isInteractionLocked(): boolean {
    return this.#contract.isInteractionLocked();
  }
  setInteractionLock(value: boolean): void {
    if (this.#contract.isInteractionLocked() === value) return;
    this.#local(() => this.#contract.setInteractionLock(value), true);
  }

  isHidden(id: string): boolean {
    return this.#contract.isHidden(id);
  }
  listHidden(): ReadonlySet<string> {
    return this.#contract.listHidden();
  }
  setLocallyHidden(id: string, hidden: boolean): void {
    if (this.#contract.isHidden(id) === hidden) return;
    this.#local(() => {
      this.#contract.setLocallyHidden(id, hidden);
      if (hidden) this.#pruneInvisible();
    }, true);
  }

  // ============================================================================
  // The state only the drawing reads (kept here)
  // ============================================================================

  getTentative(): TentativeState | null {
    return this.#drawing.getTentative();
  }
  setTentative(state: TentativeState | null): void {
    this.#drawing.setTentative(state);
  }

  getBoxSelection(): BoxSelection | null {
    return this.#drawing.getBoxSelection();
  }
  setBoxSelection(box: BoxSelection | null): void {
    this.#drawing.setBoxSelection(box);
  }

  getDragState(): DragState | null {
    return this.#drawing.getDragState();
  }
  setDragState(state: DragState | null): void {
    this.#drawing.setDragState(state);
  }

  getFollowedVertices(): VertexSelection[] | null {
    return this.#drawing.getFollowedVertices();
  }
  setFollowedVertices(selections: VertexSelection[] | null): void {
    this.#bus.transact(() => {
      this.#drawing.setFollowedVertices(selections);
      this.#heldStale = true;
      this.#syncHeld();
    }, 'local');
  }

  // ============================================================================
  // Subscription and transactions
  // ============================================================================

  subscribe(listener: (changes: StoreChange) => void): () => void {
    return this.#bus.subscribe(listener);
  }

  transact<T>(fn: () => T, source: UpdateSource = 'local'): T {
    return this.#bus.transact(() => this.#contract.transact(fn, source), source);
  }

  // ============================================================================
  // Private
  // ============================================================================

  /** Runs one document write unless read-only; what the contract returned */
  #write(fn: () => boolean): boolean {
    if (this.#contract.isReadOnly()) return false;
    return this.transact(fn);
  }

  /**
   * Runs a write of the state of this client as one notification of this Store. `redraw` marks
   * the notification for a state the categories do not describe (the vertex selection,
   * read-only, the interaction lock, local visibility), in case the contract notifies it with no
   * category or not at all.
   */
  #local(fn: () => void, redraw = false): void {
    this.#bus.transact(() => {
      fn();
      if (redraw) this.#bus.merge({ uiStateChanged: true });
      this.#heldStale = true;
      this.#syncHeld();
    }, 'local');
  }

  /**
   * The number of features of rows a selection holds (0 for a Store without rows)
   */
  #heldCount(type: SelectionType | null, ids: readonly string[]): number {
    const tables = this.#contract.tables;
    if (!tables) return 0;
    if (type === 'group') {
      let count = 0;
      for (const id of ids) {
        const group = this.#contract.getGroup(id);
        if (group) count += tableGroupMemberCount(tables, group);
      }
      return count;
    }
    if (type === 'layer') {
      let count = 0;
      for (const id of ids) count += tableLayerFeatureCount(tables, id);
      return count;
    }
    return ids.length;
  }

  /**
   * Holds as features the rows selected (the members of the groups and the layers selected), being
   * edited, whose vertices are selected, and whose vertices follow a drag, before the notification
   * of the change goes out (a Store without rows has nothing to hold)
   */
  #syncHeld(): void {
    const tables = this.#contract.tables;
    const holder = featureTablesInternals(tables);
    if (!tables || !holder || !this.#heldStale) return;
    this.#heldStale = false;
    const ids = new Set<string>();
    const selection = this.#contract.getSelection();
    this.#heldSelectionType = selection.type;
    if (selection.type === 'feature') {
      for (const id of selection.ids) ids.add(id);
    } else if (selection.type === 'group') {
      for (const id of selection.ids) {
        const group = this.#contract.getGroup(id);
        if (group) for (const member of tableGroupMemberIds(tables, group)) ids.add(member);
      }
    } else if (selection.type === 'layer') {
      for (const id of selection.ids) {
        for (const member of tableLayerFeatureIds(tables, id)) ids.add(member);
      }
    }
    for (const id of this.#contract.getEditingIds()) ids.add(id);
    const vertices = this.#contract.getVertexSelection();
    if (vertices) ids.add(vertices.featureId);
    for (const followed of this.#drawing.getFollowedVertices() ?? []) ids.add(followed.featureId);
    const before = this.#heldIds;
    if (ids.size === before.size && [...ids].every((id) => before.has(id))) return;
    this.#heldIds = ids;
    // What the selection lets go of stays held a moment (unless it is named again meanwhile)
    const releasedBefore = [...this.#released];
    let released = false;
    for (const id of before) {
      if (ids.has(id) || this.#released.has(id)) continue;
      this.#released.add(id);
      released = true;
    }
    for (const id of ids) {
      if (this.#released.delete(id)) released = true;
    }
    // A row passing from one owner to the other is named by one of them all the while
    if (released) holder.hold(RELEASED_OWNER, [...new Set([...releasedBefore, ...this.#released])]);
    holder.hold(SELECTION_OWNER, [...ids]);
    if (!released) return;
    holder.hold(RELEASED_OWNER, [...this.#released]);
    if (this.#releaseTimer !== null) clearTimeout(this.#releaseTimer);
    this.#releaseTimer = setTimeout(() => {
      this.#releaseTimer = null;
      this.#released.clear();
      holder.hold(RELEASED_OWNER, []);
    }, RELEASE_DELAY_MS);
  }

  /**
   * Takes a notification of the contract into the notification of this Store, together with
   * the state of this client it changes (one notification with the contract's source when it
   * did not come from a transaction of this Store)
   */
  #receive(changes: StoreChange): void {
    this.#bus.transact(() => {
      if (this.#contract.tables && this.#changesHeld(changes)) this.#heldStale = true;
      this.#bus.merge(this.#normalizeChanges(withoutSource(changes)));
      for (const feature of changes.features?.deleted ?? []) this.#forget(feature.id);
      for (const group of changes.groups?.deleted ?? []) this.#forget(group.id);
      for (const layer of changes.layers?.deleted ?? []) this.#forget(layer.id);
      if (mayHide(changes)) this.#pruneInvisible();
      this.#pruneVertices(changes);
      this.#syncHeld();
    }, changes.source ?? 'local');
  }

  // ============================================================================
  // Reading the contract in the shape of the public types
  // ============================================================================

  /** The feature with `groupId: null` read as `undefined` (the same object when it has none) */
  #feature(feature: Feature): Feature {
    if (!hasNullFeatureField(feature)) return feature;
    const known = this.#normalized.get(feature) as Feature | undefined;
    if (known) return known;
    const normalized: Feature = { ...feature, groupId: undefined };
    this.#normalized.set(feature, normalized);
    return normalized;
  }

  #features(features: Feature[]): Feature[] {
    return features.some(hasNullFeatureField)
      ? features.map((feature) => this.#feature(feature))
      : features;
  }

  /** The layer with `metadata` and `styleRule` of `null` read as `undefined` */
  #layer(layer: Layer): Layer {
    if (!hasNullLayerField(layer)) return layer;
    const known = this.#normalized.get(layer) as Layer | undefined;
    if (known) return known;
    const normalized: Layer = {
      ...layer,
      metadata: layer.metadata ?? undefined,
      styleRule: layer.styleRule ?? undefined,
    };
    this.#normalized.set(layer, normalized);
    return normalized;
  }

  /** A notification of the contract with its features and layers read like the getters */
  #normalizeChanges(changes: StoreChange): StoreChange {
    const { features, layers } = changes;
    const normalized: StoreChange = { ...changes };
    if (features) {
      normalized.features = {
        ...features,
        ...(features.created && { created: features.created.map((f) => this.#feature(f)) }),
        ...(features.updated && {
          updated: features.updated.map((entry) => ({
            ...entry,
            feature: this.#feature(entry.feature),
            previous: this.#feature(entry.previous),
          })),
        }),
        ...(features.deleted && { deleted: features.deleted.map((f) => this.#feature(f)) }),
      };
    }
    if (layers) {
      normalized.layers = {
        ...layers,
        ...(layers.created && { created: layers.created.map((l) => this.#layer(l)) }),
        ...(layers.updated && {
          updated: layers.updated.map((entry) => ({
            ...entry,
            layer: this.#layer(entry.layer),
            previous: this.#layer(entry.previous),
          })),
        }),
        ...(layers.deleted && { deleted: layers.deleted.map((l) => this.#layer(l)) }),
      };
    }
    return normalized;
  }

  /**
   * Whether a notification of the contract may change the rows held for the selection: a change
   * of the state of this client (the selection, the editing, the vertices), a deletion or a
   * reset, and for a group or a layer selected, a change of what is in a group or a layer
   */
  #changesHeld(changes: StoreChange): boolean {
    if (changes.selection || changes.editing || changes.uiStateChanged || changes.reset) {
      return true;
    }
    if (changes.features?.deleted?.length) return true;
    if (changes.groups?.deleted?.length || changes.layers?.deleted?.length) return true;
    if (mayHide(changes)) return true;
    // A change of the selection marks them stale above, so the type they were read from is the
    // type of the selection now (reading the selection copies its ids)
    const type = this.#heldSelectionType;
    if (type !== 'group' && type !== 'layer') return false;
    if (changes.features?.created?.length || changes.groups || changes.layers) return true;
    for (const rows of changes.rows?.layers.values() ?? []) {
      if (rows.created.length > 0 || rows.deleted.length > 0) return true;
      if (rows.fields.has('groupId') || rows.fields.has('layerId')) return true;
    }
    return false;
  }

  /** Removes an id that no longer names anything from the state of this client */
  #forget(id: string): void {
    const contract = this.#contract;
    if (contract.getFeature(id) || contract.getGroup(id) || contract.getLayer(id)) return;
    const selection = contract.getSelection();
    if (selection.ids.includes(id)) {
      this.#heldStale = true;
      const ids = selection.ids.filter((selected) => selected !== id);
      contract.setSelection(ids.length === 0 ? null : selection.type, ids);
    }
    if (contract.getEditingIds().includes(id)) {
      this.#heldStale = true;
      contract.endEditing([id]);
    }
    if (contract.isHidden(id)) {
      contract.setLocallyHidden(id, false);
      this.#bus.merge({ uiStateChanged: true });
    }
  }

  /**
   * Takes out of the selection what cannot be seen (see isShown); a hidden item never keeps
   * its handles, its vertex hits or its place in a Delete
   */
  #pruneInvisible(): void {
    const selection = this.#contract.getSelection();
    const type = selection.type;
    if (type === null || selection.ids.length === 0) return;
    const shown = createShownLookup(this.#contract);
    const kept = selection.ids.filter((id) => shown(type, id));
    if (kept.length !== selection.ids.length) {
      this.#heldStale = true;
      this.#contract.setSelection(kept.length > 0 ? type : null, kept);
    }
  }

  /**
   * Ends the vertex selection when its feature is gone or its coordinates changed other than
   * by a local drag (a change from elsewhere, an edit through the API): the indices it holds
   * would name other vertices
   */
  #pruneVertices(changes: StoreChange): void {
    const vertices = this.#contract.getVertexSelection();
    if (!vertices) return;
    const featureId = vertices.featureId;
    if (!this.#contract.getFeature(featureId)) {
      this.#endVertexSelection();
      return;
    }
    const local = changes.source !== 'remote';
    for (const entry of changes.features?.updated ?? []) {
      if (entry.id !== featureId) continue;
      // The frames and the commit of a local drag keep the vertices being dragged selected
      if (local && (entry.isIntermediate || this.#drawing.getDragState() !== null)) continue;
      if (sameCoordinates(coordinatesOf(entry.feature), coordinatesOf(entry.previous))) continue;
      this.#endVertexSelection();
      return;
    }
  }

  /** Clears the vertex selection, marking the notification for the drawing */
  #endVertexSelection(): void {
    this.#heldStale = true;
    this.#contract.setSelectedVertices(null);
    this.#bus.merge({ uiStateChanged: true });
  }
}

/**
 * Whether a notification can hide something that was visible: a change of the visible flag
 * of a feature, or of its place (a feature moved into a hidden layer or group), and any
 * update of a group or a layer
 */
function mayHide(changes: StoreChange): boolean {
  if (changes.layers?.updated?.length || changes.groups?.updated?.length) return true;
  for (const { feature, previous } of changes.features?.updated ?? []) {
    if (feature.visible !== previous.visible) return true;
    if (feature.layerId !== previous.layerId || feature.groupId !== previous.groupId) return true;
  }
  return false;
}

/**
 * Whether a selected item can be seen: it exists, its own visible flag and the ones of its
 * group and layer are on, and neither it nor its group nor its layer is hidden locally.
 * Each layer and group is looked up once per call site (a document can take time to read a
 * layer).
 */
function createShownLookup(document: StoreContract): (type: SelectionType, id: string) => boolean {
  const ui = document;
  const layers = new Map<string, boolean>();
  const groups = new Map<string, boolean>();

  const layerShown = (id: string): boolean => {
    let shown = layers.get(id);
    if (shown === undefined) {
      const layer = document.getLayer(id);
      shown = layer?.visible === true && !ui.isHidden(id);
      layers.set(id, shown);
    }
    return shown;
  };

  const groupShown = (id: string): boolean => {
    let shown = groups.get(id);
    if (shown === undefined) {
      const group = document.getGroup(id);
      const layerId = group?.layerId;
      shown =
        group?.visible === true &&
        !ui.isHidden(id) &&
        (layerId === undefined || layerShown(layerId));
      groups.set(id, shown);
    }
    return shown;
  };

  return (type, id) => {
    if (type === 'layer') return layerShown(id);
    if (type === 'group') return groupShown(id);
    const feature = document.getFeature(id);
    if (!feature?.visible || ui.isHidden(id)) return false;
    if (feature.groupId && !groupShown(feature.groupId)) return false;
    return layerShown(feature.layerId);
  };
}

/** Whether two coordinate values are equal, position by position */
function sameCoordinates(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sameCoordinates(a[i], b[i])) return false;
  }
  return true;
}

/** Whether a feature of the contract gives `null` for an optional field */
function hasNullFeatureField(feature: Feature): boolean {
  return (feature.groupId as unknown) === null;
}

/** Whether a layer of the contract gives `null` for an optional field */
function hasNullLayerField(layer: Layer): boolean {
  return (layer.metadata as unknown) === null || (layer.styleRule as unknown) === null;
}

/** A notification of the contract without its source (the transaction here carries it) */
function withoutSource(changes: StoreChange): StoreChange {
  const { source: _source, ...rest } = changes;
  return rest;
}
