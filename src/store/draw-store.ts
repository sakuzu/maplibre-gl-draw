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

import { coordinatesOf } from '../shared/utils/coordinates.js';
import { ChangeBus } from './memory/change-bus.js';
import { MemoryDrawingState } from './memory/ui-state.js';
import type { Store, StoreContract } from './store.js';
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

  constructor(contract: StoreContract) {
    this.#contract = contract;
    contract.subscribe((changes) => this.#receive(changes));
  }

  // ============================================================================
  // The document: reads
  // ============================================================================

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
    this.#drawing.setFollowedVertices(selections);
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
    }, 'local');
  }

  /**
   * Takes a notification of the contract into the notification of this Store, together with
   * the state of this client it changes (one notification with the contract's source when it
   * did not come from a transaction of this Store)
   */
  #receive(changes: StoreChange): void {
    this.#bus.transact(() => {
      this.#bus.merge(this.#normalizeChanges(withoutSource(changes)));
      for (const feature of changes.features?.deleted ?? []) this.#forget(feature.id);
      for (const group of changes.groups?.deleted ?? []) this.#forget(group.id);
      for (const layer of changes.layers?.deleted ?? []) this.#forget(layer.id);
      if (mayHide(changes)) this.#pruneInvisible();
      this.#pruneVertices(changes);
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

  /** Removes an id that no longer names anything from the state of this client */
  #forget(id: string): void {
    const contract = this.#contract;
    if (contract.getFeature(id) || contract.getGroup(id) || contract.getLayer(id)) return;
    const selection = contract.getSelection();
    if (selection.ids.includes(id)) {
      const ids = selection.ids.filter((selected) => selected !== id);
      contract.setSelection(ids.length === 0 ? null : selection.type, ids);
    }
    if (contract.getEditingIds().includes(id)) contract.endEditing([id]);
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
      const layerId = group ? groupLayerId(document, group) : undefined;
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

/** The layer of a group: the one of its members, or the layer that lists an empty group */
function groupLayerId(document: StoreContract, group: Group): string | undefined {
  for (const featureId of group.featureIds) {
    const feature = document.getFeature(featureId);
    if (feature) return feature.layerId;
  }
  return document.listLayers().find((layer) => layer.items.includes(group.id))?.id;
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
