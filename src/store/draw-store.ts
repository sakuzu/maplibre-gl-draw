// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DrawStore
 *
 * The Store core works with: a {@link StoreContract} (the in-memory one, or one the host gave)
 * that keeps the document, the state of this client the instance holds ({@link ClientState}),
 * and the state only the drawing reads, behind one gate. It reaches the contract only through
 * the members of the public `Store`, which hold the document alone.
 *
 *   - Read-only is the one of the instance: the writes of the document are not called on the
 *     contract while it is on. A refused write returns false and touches nothing. Changes
 *     applied to the contract from elsewhere are not stopped by it.
 *   - The notifications of the contract are forwarded into the ChangeBus of this Store, so a
 *     listener gets one StoreChange per transaction with every kind of change, the changes of
 *     the state of this client included.
 *   - What the contract returns and notifies is read in the shape of the public types: an
 *     optional field it gives as `null` (`Feature.groupId`, `Layer.metadata`,
 *     `Layer.styleRule`) is read as `undefined`. The normalized object is kept per object of
 *     the contract, so the same object of the contract always reads as the same object here.
 *   - Every change of the document, whatever wrote it, is handed to the state of this client,
 *     which keeps its rules (a deleted ID leaves the selection, the features being edited and
 *     the hidden items; the selection holds only what can be seen; the vertex selection ends
 *     with its feature or its coordinates).
 *   - The members of the state of this client are those of the {@link ClientState} it was
 *     given, read and written there.
 */

import { createWorkCounts, holdWorkCounts, type WorkCounts } from '../shared/work-counts.js';
import { ChangeBus } from './memory/change-bus.js';
import { type ClientDocument, ClientState, MemoryDrawingState } from './memory/ui-state.js';
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
 * Returns the Store for a store option: a Store of core is used as it is (with the state of
 * this client it holds), a Store of the host gets the state of this client given, the drawing
 * state and the read-only gate of core around it
 *
 * @param client The state of this client of the instance
 * @internal
 */
export function toStore(store: StoreContract | Store, client?: ClientState): Store {
  return store instanceof DrawStore ? store : new DrawStore(store, undefined, client);
}

/**
 * The Store of core over a {@link StoreContract}
 *
 * @internal
 */
export class DrawStore implements Store {
  readonly #client: ClientState;
  readonly #contract: StoreContract;
  readonly #bus: ChangeBus;
  readonly #drawing: MemoryDrawingState;
  /** The normalized copy of each object of the contract that gave `null` for an optional field */
  readonly #normalized = new WeakMap<object, object>();

  /**
   * @param counts The numbers of this Store, shared with the contract that made them
   * @param client The state of this client the instance holds (a new one when left out)
   */
  constructor(
    contract: StoreContract,
    counts: WorkCounts = createWorkCounts(),
    client: ClientState = new ClientState(),
  ) {
    holdWorkCounts(this, counts);
    this.#bus = new ChangeBus(undefined, counts);
    this.#drawing = new MemoryDrawingState(this.#bus);
    this.#contract = contract;
    this.#client = client;
    const bus = this.#bus;
    client.attach({
      document: contract as unknown as ClientDocument,
      merge: (change) => bus.merge(change),
      transact: (fn) => bus.transact(fn, 'local'),
    });
    contract.subscribe((changes) => this.#receive(changes as unknown as StoreChange));
  }

  /** The state of this client, held by the instance */
  get client(): ClientState {
    return this.#client;
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
    const layer = this.#contract.getLayer(id) as Layer | undefined;
    return layer && this.#layer(layer);
  }
  listLayers(): Layer[] {
    const layers = this.#contract.listLayers() as Layer[];
    return layers.some(hasNullLayerField) ? layers.map((layer) => this.#layer(layer)) : layers;
  }
  getLayerOrder(): readonly string[] {
    return this.#contract.getLayerOrder();
  }
  getGroup(id: string): Group | undefined {
    return this.#contract.getGroup(id) as Group | undefined;
  }
  listGroups(): Group[] {
    return this.#contract.listGroups() as Group[];
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
      if (deleted) this.client.forget(id);
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
  // The state of this client (held by the instance, see ClientState)
  // ============================================================================

  getSelection(): Selection {
    return this.client.getSelection();
  }
  setSelection(type: SelectionType | null, ids: string[]): void {
    this.client.setSelection(type, ids);
  }

  getEditingIds(): readonly string[] {
    return this.client.getEditingIds();
  }
  startEditing(ids: string[]): void {
    this.client.startEditing(ids);
  }
  endEditing(ids: string[]): void {
    this.client.endEditing(ids);
  }

  getVertexSelection(): VertexSelection | null {
    return this.client.getVertexSelection();
  }
  setSelectedVertices(selection: VertexSelection | null): void {
    this.client.setSelectedVertices(selection);
  }

  getMode(): Mode {
    return this.client.getMode();
  }
  setMode(mode: Mode): void {
    this.client.setMode(mode);
  }

  isReadOnly(): boolean {
    return this.client.isReadOnly();
  }
  setReadOnly(value: boolean): void {
    this.client.setReadOnly(value);
  }

  isInteractionLocked(): boolean {
    return this.client.isInteractionLocked();
  }
  setInteractionLock(value: boolean): void {
    this.client.setInteractionLock(value);
  }

  isHidden(id: string): boolean {
    return this.client.isHidden(id);
  }
  listHidden(): ReadonlySet<string> {
    return this.client.listHidden();
  }
  setLocallyHidden(id: string, hidden: boolean): void {
    this.client.setLocallyHidden(id, hidden);
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
    // The subscribers of the state of this client hear of its changes after the notification
    return this.client.hold(() =>
      this.#bus.transact(() => this.#contract.transact(fn, source), source),
    );
  }

  // ============================================================================
  // Private
  // ============================================================================

  /** Runs one document write unless read-only (that of the instance); what the contract returned */
  #write(fn: () => boolean): boolean {
    if (this.client.isReadOnly()) return false;
    return this.transact(fn);
  }

  /**
   * Takes a notification of the contract into the notification of this Store, together with
   * the state of this client it changes (one notification with the contract's source when it
   * did not come from a transaction of this Store)
   */
  #receive(changes: StoreChange): void {
    this.client.hold(() =>
      this.#bus.transact(() => {
        this.#bus.merge(this.#normalizeChanges(withoutSource(changes)));
        this.client.followDocument(changes, this.#drawing.getDragState() !== null);
      }, changes.source ?? 'local'),
    );
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
