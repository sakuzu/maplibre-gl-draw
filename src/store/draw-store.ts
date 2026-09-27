// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DrawStore
 *
 * The Store core works with: a DocumentStore (the in-memory one, or one the host gave) and
 * the local UiState of this client behind one gate.
 *
 *   - Read-only is enforced here, at the write methods, and nowhere else. A refused write
 *     returns false and touches nothing. The DocumentStore never sees the gate, so changes
 *     applied to the document from elsewhere are not stopped by it.
 *   - The notifications of the document are forwarded into the ChangeBus of the local state,
 *     so a listener gets one StateChanges per transaction with both kinds of change.
 *   - Deletions reach the local state: the id of a deleted feature, group or layer leaves the
 *     selection, the features being edited and the locally hidden set, whatever deleted it.
 *   - The selection holds only what can be seen: a change that hides a selected item (its own
 *     visible flag, the one of its group or layer, or local hiding) takes it out of the
 *     selection, and the vertex selection ends when its feature is deleted or its coordinates
 *     change other than by a drag. This is the only place that keeps these invariants; the
 *     modes and the public API rely on it.
 */

import { coordinatesOf } from '../shared/utils/coordinates.js';
import { ChangeBus } from './memory/change-bus.js';
import { MemoryUiState } from './memory/ui-state.js';
import type { DocumentStore, Store } from './store.js';
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
 * Returns the Store for a store option: a Store is used as it is, a DocumentStore gets the
 * local state and the read-only gate of core around it
 *
 * @internal
 */
export function toStore(store: DocumentStore | Store): Store {
  return store instanceof DrawStore ? store : new DrawStore(store);
}

/**
 * The Store of core over a DocumentStore
 *
 * @internal
 */
export class DrawStore implements Store {
  readonly #document: DocumentStore;
  readonly #bus = new ChangeBus();
  readonly #ui = new MemoryUiState(this.#bus);

  constructor(document: DocumentStore) {
    this.#document = document;
    document.subscribe((changes) => this.#receive(changes));
  }

  // ============================================================================
  // The document: reads
  // ============================================================================

  getFeature(id: string): Feature | undefined {
    return this.#document.getFeature(id);
  }
  listFeatures(): Feature[] {
    return this.#document.listFeatures();
  }
  listFeaturesInOrder(): Feature[] {
    return this.#document.listFeaturesInOrder();
  }
  getLayer(id: string): Layer | undefined {
    return this.#document.getLayer(id);
  }
  listLayers(): Layer[] {
    return this.#document.listLayers();
  }
  getLayerOrder(): readonly string[] {
    return this.#document.getLayerOrder();
  }
  getGroup(id: string): Group | undefined {
    return this.#document.getGroup(id);
  }
  listGroups(): Group[] {
    return this.#document.listGroups();
  }
  getFile(id: string): FileData | undefined {
    return this.#document.getFile(id);
  }
  listFiles(): FileData[] {
    return this.#document.listFiles();
  }
  getMetadata(): Metadata {
    return this.#document.getMetadata();
  }

  // ============================================================================
  // The document: writes (gated by read-only)
  // ============================================================================

  createFeature(feature: Feature): boolean {
    return this.#write(() => this.#document.createFeature(feature));
  }
  updateFeature(id: string, updates: Partial<Feature>, options?: UpdateFeatureOptions): boolean {
    return this.#write(() => this.#document.updateFeature(id, updates, options));
  }
  abortIntermediateUpdates(ids: string[]): void {
    this.#document.abortIntermediateUpdates?.(ids);
  }
  deleteFeature(id: string): boolean {
    return this.#write(() => {
      this.#document.deleteFeature(id);
      // At once, so that the rest of a transaction already sees the selection without it
      this.#forget(id);
    });
  }

  createLayer(layer: Layer): boolean {
    return this.#write(() => this.#document.createLayer(layer));
  }
  updateLayer(id: string, updates: Partial<Layer>): boolean {
    return this.#write(() => this.#document.updateLayer(id, updates));
  }
  deleteLayer(id: string): boolean {
    return this.#write(() => this.#document.deleteLayer(id));
  }
  setLayerOrder(order: string[]): boolean {
    return this.#write(() => this.#document.setLayerOrder(order));
  }
  reorderInLayer(itemId: string, layerId: string, newIndex: number): boolean {
    return this.#write(() => this.#document.reorderInLayer(itemId, layerId, newIndex));
  }
  reorderInGroup(featureId: string, groupId: string, newIndex: number): boolean {
    return this.#write(() => this.#document.reorderInGroup(featureId, groupId, newIndex));
  }

  createGroup(group: Group): boolean {
    return this.#write(() => this.#document.createGroup(group));
  }
  updateGroup(id: string, updates: Partial<Group>): boolean {
    return this.#write(() => this.#document.updateGroup(id, updates));
  }
  deleteGroup(id: string): boolean {
    return this.#write(() => this.#document.deleteGroup(id));
  }

  createFile(file: FileData): boolean {
    return this.#write(() => this.#document.createFile(file));
  }
  deleteFile(id: string): boolean {
    return this.#write(() => this.#document.deleteFile(id));
  }

  setMetadata(metadata: Partial<Metadata>): boolean {
    return this.#write(() => this.#document.setMetadata(metadata));
  }

  // ============================================================================
  // The local state
  // ============================================================================

  getSelection(): Selection {
    return this.#ui.getSelection();
  }
  setSelection(type: SelectionType | null, ids: string[]): void {
    this.#ui.setSelection(type, ids);
  }

  getEditingIds(): readonly string[] {
    return this.#ui.getEditingIds();
  }
  startEditing(ids: string[]): void {
    this.#ui.startEditing(ids);
  }
  endEditing(ids: string[]): void {
    this.#ui.endEditing(ids);
  }

  getTentative(): TentativeState | null {
    return this.#ui.getTentative();
  }
  setTentative(state: TentativeState | null): void {
    this.#ui.setTentative(state);
  }

  getBoxSelection(): BoxSelection | null {
    return this.#ui.getBoxSelection();
  }
  setBoxSelection(box: BoxSelection | null): void {
    this.#ui.setBoxSelection(box);
  }

  getDragState(): DragState | null {
    return this.#ui.getDragState();
  }
  setDragState(state: DragState | null): void {
    this.#ui.setDragState(state);
  }

  getVertexSelection(): VertexSelection | null {
    return this.#ui.getVertexSelection();
  }
  setSelectedVertices(selection: VertexSelection | null): void {
    this.#ui.setSelectedVertices(selection);
  }

  getFollowedVertices(): VertexSelection[] | null {
    return this.#ui.getFollowedVertices();
  }
  setFollowedVertices(selections: VertexSelection[] | null): void {
    this.#ui.setFollowedVertices(selections);
  }

  getMode(): Mode {
    return this.#ui.getMode();
  }
  setMode(mode: Mode): void {
    this.#ui.setMode(mode);
  }

  isReadOnly(): boolean {
    return this.#ui.isReadOnly();
  }
  setReadOnly(value: boolean): void {
    this.#ui.setReadOnly(value);
  }

  isInteractionLocked(): boolean {
    return this.#ui.isInteractionLocked();
  }
  setInteractionLock(value: boolean): void {
    this.#ui.setInteractionLock(value);
  }

  isHidden(id: string): boolean {
    return this.#ui.isHidden(id);
  }
  listHidden(): ReadonlySet<string> {
    return this.#ui.listHidden();
  }
  setLocallyHidden(id: string, hidden: boolean): void {
    this.#bus.transact(() => {
      this.#ui.setLocallyHidden(id, hidden);
      if (hidden) this.#pruneInvisible();
    }, 'local');
  }

  // ============================================================================
  // Subscription and transactions
  // ============================================================================

  subscribe(listener: (changes: StateChanges) => void): () => void {
    return this.#bus.subscribe(listener);
  }

  transact<T>(fn: () => T, source: UpdateSource = 'local'): T {
    return this.#bus.transact(() => this.#document.transact(fn, source), source);
  }

  // ============================================================================
  // Private
  // ============================================================================

  /** Runs one document write unless read-only; true when it ran */
  #write(fn: () => void): boolean {
    if (this.#ui.isReadOnly()) return false;
    this.transact(fn);
    return true;
  }

  /**
   * Takes a notification of the document into the notification of this Store, together with
   * the local state it changes (one notification with the document's source when it did not
   * come from a transaction of this Store)
   */
  #receive(changes: StateChanges): void {
    this.#bus.transact(() => {
      this.#bus.merge(documentPart(changes));
      for (const feature of changes.features?.deleted ?? []) this.#forget(feature.id);
      for (const group of changes.groups?.deleted ?? []) this.#forget(group.id);
      for (const layer of changes.layers?.deleted ?? []) this.#forget(layer.id);
      if (mayHide(changes)) this.#pruneInvisible();
      this.#pruneVertices(changes);
    }, changes.source ?? 'local');
  }

  /** Removes an id that no longer names anything from the local state */
  #forget(id: string): void {
    if (this.#document.getFeature(id) || this.#document.getGroup(id)) return;
    if (this.#document.getLayer(id)) return;
    this.#ui.removeFromSelection(id);
    this.#ui.removeFromEditing(id);
    this.#ui.removeFromLocallyHidden(id);
  }

  /**
   * Takes out of the selection what cannot be seen (see isShown); a hidden item never keeps
   * its handles, its vertex hits or its place in a Delete
   */
  #pruneInvisible(): void {
    const selection = this.#ui.getSelection();
    const type = selection.type;
    if (type === null || selection.ids.length === 0) return;
    const shown = createShownLookup(this.#document, this.#ui);
    const kept = selection.ids.filter((id) => shown(type, id));
    if (kept.length !== selection.ids.length) {
      this.#ui.setSelection(kept.length > 0 ? type : null, kept);
    }
  }

  /**
   * Ends the vertex selection when its feature is gone or its coordinates changed other than
   * by a local drag (a change from elsewhere, an edit through the API): the indices it holds
   * would name other vertices
   */
  #pruneVertices(changes: StateChanges): void {
    const vertices = this.#ui.getVertexSelection();
    if (!vertices) return;
    const featureId = vertices.featureId;
    if (!this.#document.getFeature(featureId)) {
      this.#ui.setSelectedVertices(null);
      return;
    }
    const local = changes.source !== 'remote';
    for (const entry of changes.features?.updated ?? []) {
      if (entry.id !== featureId) continue;
      // The frames and the commit of a local drag keep the vertices being dragged selected
      if (local && (entry.isIntermediate || this.#ui.getDragState() !== null)) continue;
      if (sameCoordinates(coordinatesOf(entry.feature), coordinatesOf(entry.previous))) continue;
      this.#ui.setSelectedVertices(null);
      return;
    }
  }
}

/**
 * Whether a notification can hide something that was visible: a change of the visible flag
 * of a feature, or of its place (a feature moved into a hidden layer or group), and any
 * update of a group or a layer
 */
function mayHide(changes: StateChanges): boolean {
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
function createShownLookup(
  document: DocumentStore,
  ui: { isHidden(id: string): boolean },
): (type: SelectionType, id: string) => boolean {
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
function groupLayerId(document: DocumentStore, group: Group): string | undefined {
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

/** The categories of a notification that belong to the document */
function documentPart(changes: StateChanges): StateChanges {
  const part: StateChanges = {};
  if (changes.features) part.features = changes.features;
  if (changes.layers) part.layers = changes.layers;
  if (changes.groups) part.groups = changes.groups;
  if (changes.layerReorder) part.layerReorder = changes.layerReorder;
  if (changes.groupReorder) part.groupReorder = changes.groupReorder;
  if (changes.metadata) part.metadata = changes.metadata;
  if (changes.uiStateChanged) part.uiStateChanged = true;
  return part;
}
