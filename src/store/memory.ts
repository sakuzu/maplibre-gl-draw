// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MemoryStore
 *
 * The in-memory Store: a DrawStore over a MemoryDocumentStore.
 *
 * MemoryDocumentStore is the in-memory implementation of the DocumentStore contract.
 * Keeping Feature / Layer / Group consistent (cascading updates on deletion, cascading
 * updates when groupId changes, etc.) is the responsibility of this file. Transactions and
 * listeners are delegated to memory/change-bus.ts and File CRUD to memory/file-store.ts.
 *
 * What it returns is frozen and never changed afterwards: a feature is stored as a frozen
 * copy of what it was given, and a layer or a group whose order changes is replaced by a
 * copy (copied once per notification, so that a bulk import stays linear) and frozen when
 * the notification goes out.
 */

import { DrawStore } from './draw-store.js';
import { ChangeBus } from './memory/change-bus.js';
import { FileStore } from './memory/file-store.js';
import { frozenCopy, frozenFeature } from './memory/frozen.js';
import type { DocumentStore, Store } from './store.js';
import type {
  Feature,
  FileData,
  Group,
  Layer,
  Metadata,
  StoreChange,
  UpdateFeatureOptions,
  UpdateSource,
} from './types.js';

/**
 * The in-memory Store, the default
 *
 * `new MemoryStore()` is a complete Store (the document and the local state); it is what
 * `createDraw` uses when no store is given.
 *
 * It keeps its own copy of what it is given and freezes what it returns. A feature, a layer
 * or a group it has returned or notified never changes afterwards (a change replaces it), and
 * writing into one throws a `TypeError` instead of changing the store behind its
 * notifications.
 */
export interface MemoryStore extends Store {}

/** Creates an empty in-memory Store */
export const MemoryStore: { new (): MemoryStore; readonly prototype: MemoryStore } =
  class extends DrawStore {
    constructor() {
      super(new MemoryDocumentStore());
    }
  };

/**
 * The in-memory DocumentStore
 *
 * @internal
 */
export class MemoryDocumentStore implements DocumentStore {
  readonly #features = new Map<string, Feature>();
  readonly #layers = new Map<string, Layer>();
  readonly #groups = new Map<string, Group>();
  #layerOrder: string[] = [];
  #metadata: Metadata = {};

  /**
   * The content set of layer.items (layer ID -> the set of IDs listed in order).
   *
   * It is an index whose only purpose is to make membership tests O(1), and it always keeps
   * the same content as `#layers.get(id).items` (an invariant). Because membership used to be
   * tested with `layer.items.includes()`, inserting N entries at once into a layer whose order
   * was already populated cost O(N^2) in total (the main cause of draw.load going quadratic).
   *
   * The order arrays the store returns are frozen, so the outside cannot rewrite them behind
   * this index.
   */
  readonly #layerOrderIndex = new Map<string, Set<string>>();

  /** The content set of group.featureIds. The group version of #layerOrderIndex (same invariant) */
  readonly #groupFeatureIndex = new Map<string, Set<string>>();

  /**
   * Placements settled at the end of the outermost store operation (see #withinOperation).
   *
   * When a change of layerId / groupId makes a feature standalone, or a group is created that
   * no layer lists, the store must list it somewhere so that it stays reachable. Callers
   * inside a transaction often place the item themselves right after (at a chosen index), so
   * listing it at once would duplicate it. The store therefore only records the item here
   * and lists it at the end of the operation when nobody has listed it by then.
   */
  readonly #pendingFeaturePlacement = new Set<string>();
  readonly #pendingGroupPlacement = new Map<string, { layerId: string; index: number }>();
  #operationDepth = 0;

  /**
   * Layers and groups whose stored object was copied during the current notification. Their
   * order / featureIds may still be changed in place until the notification goes out, when
   * they are frozen (#freezeFresh).
   */
  readonly #freshLayers = new Set<string>();
  readonly #freshGroups = new Set<string>();

  readonly #bus = new ChangeBus(() => this.#freezeFresh());
  readonly #fileStore = new FileStore();

  // ============================================================================
  // Feature
  // ============================================================================

  getFeature(id: string): Feature | undefined {
    return this.#features.get(id);
  }

  listFeatures(): Feature[] {
    return Array.from(this.#features.values());
  }

  createFeature(feature: Feature): void {
    if (this.#features.has(feature.id)) {
      throw new Error(`Feature with id "${feature.id}" already exists`);
    }
    // A feature must be reachable from exactly one container (its group, or else its layer).
    // A reference to a container that does not exist would leave it stored but never drawn,
    // hit or exported in order, so it is rejected before anything is written.
    this.#assertLayerExists(feature.layerId);
    if (feature.groupId && !this.#groups.has(feature.groupId)) {
      throw new Error(`Group with id "${feature.groupId}" not found`);
    }

    const stored = frozenFeature(undefined, feature);
    this.#features.set(stored.id, stored);
    this.#addToContainer(stored);

    this.#bus.merge({ features: { created: [stored] } });
  }

  /**
   * Updates a feature
   *
   * options.isIntermediate has no effect on the application of the update (an intermediate
   * state is applied as usual). Only when it is set is it passed through to
   * StoreChange.features.updated, so that the receiver can tell an intermediate update from
   * a final one.
   *
   * When layerId or groupId changes the container of the feature (its group, or else its
   * layer), the feature leaves the order of the old container at once. It joins the group at
   * the tail at once; it joins the order of its layer at the tail at the end of the
   * operation, unless the caller has listed it by then. A layerId that does not exist is
   * rejected. A groupId whose group does not exist yet
   * is accepted, because replaying recorded changes can set groupId before the group is
   * created again (createGroup then lists the feature from its featureIds).
   */
  updateFeature(id: string, updates: Partial<Feature>, options?: UpdateFeatureOptions): void {
    const previous = this.#features.get(id);
    if (!previous) {
      throw new Error(`Feature with id "${id}" not found`);
    }
    if ('layerId' in updates && updates.layerId !== previous.layerId) {
      this.#assertLayerExists(updates.layerId);
    }

    const updated = frozenFeature(previous, { ...updates, id });

    this.#withinOperation(() => {
      this.#features.set(id, updated);

      if (containerKey(previous) !== containerKey(updated)) {
        this.#removeFromContainer(previous);
        if (updated.groupId) {
          this.#addFeatureToGroupOrder(id, updated.groupId);
        } else {
          this.#pendingFeaturePlacement.add(id);
        }
      }
    });

    this.#bus.merge({
      features: {
        updated: [
          {
            id,
            feature: updated,
            previous,
            // Add the key only for an intermediate state (a final update has no such key)
            ...(options?.isIntermediate ? { isIntermediate: true } : {}),
          },
        ],
      },
    });
  }

  deleteFeature(id: string): void {
    const feature = this.#features.get(id);
    if (!feature) {
      throw new Error(`Feature with id "${id}" not found`);
    }

    this.#features.delete(id);
    this.#removeItemFromLayerOrder(id, feature.layerId);

    if (feature.groupId) {
      this.#removeFeatureFromGroupOrder(id, feature.groupId);
    }

    this.#bus.merge({ features: { deleted: [feature] } });
  }

  listFeaturesInOrder(): Feature[] {
    const result: Feature[] = [];
    for (const layerId of this.#layerOrder) {
      const layer = this.#layers.get(layerId);
      if (!layer) continue;
      for (const itemId of layer.items) {
        const group = this.#groups.get(itemId);
        if (group) {
          for (const featureId of group.featureIds) {
            const feature = this.#features.get(featureId);
            if (feature) result.push(feature);
          }
        } else {
          const feature = this.#features.get(itemId);
          if (feature) result.push(feature);
        }
      }
    }
    return result;
  }

  // ============================================================================
  // Layer
  // ============================================================================

  getLayer(id: string): Layer | undefined {
    return this.#layers.get(id);
  }

  listLayers(): Layer[] {
    return Array.from(this.#layers.values());
  }

  createLayer(layer: Layer): void {
    if (this.#layers.has(layer.id)) {
      throw new Error(`Layer with id "${layer.id}" already exists`);
    }
    // The order stays open for the members created in the same notification
    const stored: Layer = { ...frozenFields(layer), items: [...layer.items] };
    this.#layers.set(layer.id, stored);
    this.#freshLayers.add(layer.id);
    this.#layerOrderIndex.set(layer.id, new Set(layer.items));
    // An id the application already placed on the stacking order keeps its position
    if (!this.#layerOrder.includes(layer.id)) this.#layerOrder.push(layer.id);
    this.#syncGroupLayers(stored);
    // The created entry is the layer as it was created (the stored one may still gain members
    // in the same notification)
    const created = Object.freeze({ ...stored, items: Object.freeze([...stored.items]) });
    this.#bus.merge({ layers: { created: [created as Layer] } });
  }

  updateLayer(id: string, updates: Partial<Layer>): void {
    const previous = this.#layers.get(id);
    if (!previous) {
      throw new Error(`Layer with id "${id}" not found`);
    }
    const updated: Layer = {
      ...previous,
      ...frozenFields(updates),
      id,
      items: [...(updates.items ?? previous.items)],
    };
    if (this.#freshLayers.has(id)) Object.freeze(Object.freeze(previous).items);
    this.#layers.set(id, updated);
    this.#freshLayers.add(id);
    // Rebuild the index only when order has been replaced (if it is left as is, it is the same
    // array as previous.items, so the index also stays valid).
    if (updates.items) this.#layerOrderIndex.set(id, new Set(updated.items));
    this.#bus.merge({ layers: { updated: [{ id, layer: updated, previous }] } });
    if (updates.items) this.#syncGroupLayers(updated);
  }

  deleteLayer(id: string): void {
    const layer = this.#layers.get(id);
    if (!layer) {
      throw new Error(`Layer with id "${id}" not found`);
    }

    // Delete the features and groups in the layer
    for (const itemId of [...layer.items]) {
      const group = this.#groups.get(itemId);
      if (group) {
        for (const featureId of [...group.featureIds]) {
          this.deleteFeature(featureId);
        }
        // An empty group is deleted automatically the moment the last feature in the group is
        // removed, so delete it explicitly only when it still remains.
        if (this.#groups.has(itemId)) {
          this.deleteGroup(itemId);
        }
      } else if (this.#features.has(itemId)) {
        this.deleteFeature(itemId);
      }
    }

    // The last state of the layer (its order has emptied as its members left)
    const deleted = this.#layers.get(id) ?? layer;
    Object.freeze(Object.freeze(deleted).items);
    this.#freshLayers.delete(id);
    this.#layers.delete(id);
    this.#layerOrderIndex.delete(id);

    const idx = this.#layerOrder.indexOf(id);
    if (idx !== -1) this.#layerOrder.splice(idx, 1);

    this.#bus.merge({ layers: { deleted: [deleted] } });
  }

  getLayerOrder(): readonly string[] {
    // Returning the internal array as is would let the outside rewrite it and break the SSoT,
    // so a defensive copy is returned (consistent with getSelection / getMetadata).
    return [...this.#layerOrder];
  }

  /**
   * Replaces the stacking order (see {@link DocumentStore.setLayerOrder})
   *
   * The entries are not only layer IDs: the entries of the application
   * (datasets, separators) are kept as they are. Only what cannot be an entry is dropped:
   * a value that is not a non-empty string, and a repeated entry after its first position.
   *
   * The membership index within a layer (#layerOrderIndex) is an index over the layer.items of
   * each layer, which is a different thing from this sequence, so it is not touched.
   */
  setLayerOrder(order: string[]): void {
    const previous = [...this.#layerOrder];
    this.#layerOrder = [...new Set(order.filter((id) => typeof id === 'string' && id !== ''))];
    this.#bus.merge({
      layers: { orderChanged: { order: [...this.#layerOrder], previous } },
    });
  }

  reorderInLayer(itemId: string, layerId: string, newIndex: number): void {
    const current = this.#layers.get(layerId);
    if (!current) {
      throw new Error(`Layer with id "${layerId}" not found`);
    }
    const currentIndex = current.items.indexOf(itemId);
    if (currentIndex === -1) {
      throw new Error(`Item "${itemId}" not found in layer "${layerId}"`);
    }

    const previousOrder = [...current.items];
    const layer = this.#writableLayer(current);
    layer.items.splice(currentIndex, 1);
    layer.items.splice(newIndex, 0, itemId);
    // An update of this layer already stacked in the notification carries the new object
    if (this.#bus.hasPendingLayerUpdate(layerId)) this.#bus.mergeLayerUpdate(layer, undefined);

    // Emit the dedicated layerReorder (not layers.updated)
    this.#bus.merge({
      layerReorder: { layerId, order: [...layer.items], previous: previousOrder },
    });
  }

  reorderInGroup(featureId: string, groupId: string, newIndex: number): void {
    const current = this.#groups.get(groupId);
    if (!current) {
      throw new Error(`Group with id "${groupId}" not found`);
    }
    const currentIndex = current.featureIds.indexOf(featureId);
    if (currentIndex === -1) {
      throw new Error(`Feature "${featureId}" not found in group "${groupId}"`);
    }

    const previousFeatureIds = [...current.featureIds];
    const group = this.#writableGroup(current);
    group.featureIds.splice(currentIndex, 1);
    group.featureIds.splice(newIndex, 0, featureId);
    if (this.#bus.hasPendingGroupUpdate(groupId)) this.#bus.mergeGroupUpdate(group, undefined);

    this.#bus.merge({
      groupReorder: { groupId, featureIds: [...group.featureIds], previous: previousFeatureIds },
    });
  }

  // ============================================================================
  // Group
  // ============================================================================

  getGroup(id: string): Group | undefined {
    return this.#groups.get(id);
  }

  listGroups(): Group[] {
    return Array.from(this.#groups.values());
  }

  createGroup(group: Group): void {
    if (this.#groups.has(group.id)) {
      throw new Error(`Group with id "${group.id}" already exists`);
    }
    this.#withinOperation(() => this.#createGroup(group));
  }

  #createGroup(group: Group): void {
    const featureIdsCopy = [...group.featureIds];
    // The layer of a group is the layer that lists it; a group that no layer lists yet is
    // placed in the layer of its first member at the end of the operation
    const layerId =
      this.#layerListing(group.id) ?? this.#firstMemberLayer(featureIdsCopy) ?? group.layerId;
    const stored: Group = { ...frozenFields(group), layerId, featureIds: [...featureIdsCopy] };
    this.#groups.set(group.id, stored);
    this.#freshGroups.add(group.id);
    this.#groupFeatureIndex.set(group.id, new Set(featureIdsCopy));

    // The members leave the order of their layer below (their container becomes the group),
    // so a group that no layer lists takes the place of its first member at the end of the
    // operation. A caller that lists the group itself (at the position it chose) wins.
    this.#scheduleGroupPlacement(group.id, featureIdsCopy);

    // Set groupId on the features in the group
    for (const featureId of featureIdsCopy) {
      if (this.#features.has(featureId)) {
        this.updateFeature(featureId, { groupId: group.id });
      }
    }

    this.#bus.merge({
      groups: {
        created: [Object.freeze({ ...stored, featureIds: Object.freeze(featureIdsCopy) }) as Group],
      },
    });
  }

  updateGroup(id: string, updates: Partial<Group>): void {
    const previous = this.#groups.get(id);
    if (!previous) {
      throw new Error(`Group with id "${id}" not found`);
    }
    const updated: Group = {
      ...previous,
      ...frozenFields(updates),
      id,
      featureIds: [...(updates.featureIds ?? previous.featureIds)],
    };
    if (this.#freshGroups.has(id)) Object.freeze(Object.freeze(previous).featureIds);
    this.#groups.set(id, updated);
    this.#freshGroups.add(id);
    // Rebuild the index only when featureIds has been replaced (same reason as updateLayer).
    if (updates.featureIds) this.#groupFeatureIndex.set(id, new Set(updated.featureIds));
    this.#bus.merge({ groups: { updated: [{ id, group: updated, previous }] } });
  }

  deleteGroup(id: string): void {
    const group = this.#groups.get(id);
    if (!group) {
      throw new Error(`Group with id "${id}" not found`);
    }

    // Delete the group itself first. This prevents #removeFeatureFromGroupOrder from
    // recursively invoking the automatic deletion of an empty group while the groupId of the
    // members is cleared (it returns early because the group is already gone).
    Object.freeze(Object.freeze(group).featureIds);
    this.#freshGroups.delete(id);
    this.#groups.delete(id);
    this.#groupFeatureIndex.delete(id);

    // Put the members where the group was in the order of its layer, so that they stay
    // reachable after the group is gone. A member whose layerId names another layer is left
    // to the cascade of updateFeature below, which appends it to its own layer.
    for (const layer of [...this.#layers.values()]) {
      const index = this.#layerOrderSet(layer);
      if (!index.has(id)) continue;
      const idx = layer.items.indexOf(id);
      if (idx === -1) continue;
      const members = group.featureIds.filter(
        (fid) => this.#features.get(fid)?.layerId === layer.id && !index.has(fid),
      );
      if (members.length === 0) continue;
      this.#mutateLayerOrder(layer, (order) => {
        order.splice(idx, 0, ...members);
      });
      for (const fid of members) index.add(fid);
    }

    // Remove groupId from the features in the group
    // updateFeature modifies group.featureIds, so iterate over a copy of the array
    for (const featureId of [...group.featureIds]) {
      if (this.#features.has(featureId)) {
        this.updateFeature(featureId, { groupId: undefined });
      }
    }

    // Remove the group ID from the order of every layer (the index skips layers that do not
    // hold it in O(1))
    for (const layer of [...this.#layers.values()]) {
      const index = this.#layerOrderSet(layer);
      if (!index.has(id)) continue;

      const idx = layer.items.indexOf(id);
      if (idx === -1) continue;

      this.#mutateLayerOrder(layer, (order) => {
        order.splice(idx, 1);
      });
      index.delete(id);
    }

    this.#bus.merge({ groups: { deleted: [group] } });
  }

  // ============================================================================
  // File (delegated to FileStore)
  // ============================================================================

  createFile(file: FileData): void {
    this.#fileStore.create(file);
  }
  getFile(id: string): FileData | undefined {
    return this.#fileStore.get(id);
  }
  listFiles(): FileData[] {
    return this.#fileStore.getAll();
  }
  deleteFile(id: string): void {
    this.#fileStore.delete(id);
  }

  // ============================================================================
  // Metadata
  // ============================================================================

  getMetadata(): Metadata {
    return { ...this.#metadata };
  }

  setMetadata(metadata: Partial<Metadata>): void {
    const previous = { ...this.#metadata };
    this.#metadata = { ...this.#metadata, ...frozenFields(metadata) };
    // Delete the keys whose value is undefined
    for (const key of Object.keys(this.#metadata) as Array<keyof Metadata>) {
      if (this.#metadata[key] === undefined) {
        delete this.#metadata[key];
      }
    }
    this.#bus.merge({ metadata: { metadata: { ...this.#metadata }, previous } });
  }

  // ============================================================================
  // Subscribe / Transaction (delegated to ChangeBus)
  // ============================================================================

  subscribe(listener: (changes: StoreChange) => void): () => void {
    return this.#bus.subscribe(listener);
  }

  transact<T>(fn: () => T, source: UpdateSource = 'local'): T {
    return this.#bus.transact(() => this.#withinOperation(fn), source);
  }

  // ============================================================================
  // Private helpers (keeping consistency)
  // ============================================================================

  /**
   * Changes the order of a layer and notifies it as layers.updated
   *
   * The change goes into the layer's copy for the current notification (#writableLayer), so
   * an object already returned or notified never changes. The copy is made once per
   * notification, because copying the whole order every time a single feature is created
   * would make the amount copied during a bulk import O(N^2) and reach the heap limit.
   * previous is the state before the first change of the notification.
   */
  #mutateLayerOrder(current: Layer, mutate: (order: string[]) => void): void {
    const hadUpdate = this.#bus.hasPendingLayerUpdate(current.id);
    const fresh = this.#freshLayers.has(current.id);
    const previous = hadUpdate
      ? undefined
      : fresh
        ? { ...current, items: [...current.items] }
        : current;
    const layer = this.#writableLayer(current);
    mutate(layer.items);
    this.#bus.mergeLayerUpdate(layer, previous);
  }

  /** The group.featureIds version of #mutateLayerOrder */
  #mutateGroupFeatureIds(current: Group, mutate: (featureIds: string[]) => void): void {
    const hadUpdate = this.#bus.hasPendingGroupUpdate(current.id);
    const fresh = this.#freshGroups.has(current.id);
    const previous = hadUpdate
      ? undefined
      : fresh
        ? { ...current, featureIds: [...current.featureIds] }
        : current;
    const group = this.#writableGroup(current);
    mutate(group.featureIds);
    this.#bus.mergeGroupUpdate(group, previous);
  }

  /** The layer's copy for the current notification (made on the first change) */
  #writableLayer(current: Layer): Layer {
    if (this.#freshLayers.has(current.id)) return current;
    const layer: Layer = { ...current, items: [...current.items] };
    this.#layers.set(layer.id, layer);
    this.#freshLayers.add(layer.id);
    return layer;
  }

  /** The group's copy for the current notification (made on the first change) */
  #writableGroup(current: Group): Group {
    if (this.#freshGroups.has(current.id)) return current;
    const group: Group = { ...current, featureIds: [...current.featureIds] };
    this.#groups.set(group.id, group);
    this.#freshGroups.add(group.id);
    return group;
  }

  /** Freezes the layers and groups copied for the notification that is going out */
  #freezeFresh(): void {
    for (const id of this.#freshLayers) {
      const layer = this.#layers.get(id);
      if (layer) Object.freeze(Object.freeze(layer).items);
    }
    this.#freshLayers.clear();
    for (const id of this.#freshGroups) {
      const group = this.#groups.get(id);
      if (group) Object.freeze(Object.freeze(group).featureIds);
    }
    this.#freshGroups.clear();
  }

  /**
   * Returns the content set of layer.items (if not registered, builds it from order and
   * registers it).
   *
   * On the regular paths (createLayer / updateLayer) it is always registered already, so this
   * lazy construction is a defensive fallback.
   */
  #layerOrderSet(layer: Layer): Set<string> {
    let index = this.#layerOrderIndex.get(layer.id);
    if (!index) {
      index = new Set(layer.items);
      this.#layerOrderIndex.set(layer.id, index);
    }
    return index;
  }

  /** Returns the content set of group.featureIds (the group version of #layerOrderSet) */
  #groupFeatureSet(group: Group): Set<string> {
    let index = this.#groupFeatureIndex.get(group.id);
    if (!index) {
      index = new Set(group.featureIds);
      this.#groupFeatureIndex.set(group.id, index);
    }
    return index;
  }

  /**
   * Runs fn as one store operation. When the outermost operation (a transact, or a mutator
   * called outside one) ends, the pending placements are settled, inside the same flush when
   * it is a transaction.
   */
  #withinOperation<T>(fn: () => T): T {
    this.#operationDepth++;
    try {
      return fn();
    } finally {
      this.#operationDepth--;
      if (this.#operationDepth === 0) this.#settlePlacements();
    }
  }

  /** Records where a new group goes when no layer lists it: the place of its first member */
  #scheduleGroupPlacement(groupId: string, featureIds: readonly string[]): void {
    const first = featureIds
      .map((fid) => this.#features.get(fid))
      .find((f): f is Feature => f !== undefined);
    const layer = first && this.#layers.get(first.layerId);
    if (!first || !layer) return;
    const idx = layer.items.indexOf(first.id);
    this.#pendingGroupPlacement.set(groupId, {
      layerId: layer.id,
      index: idx === -1 ? layer.items.length : idx,
    });
  }

  /** Lists what is still unlisted: groups at their recorded place, features at the tail */
  #settlePlacements(): void {
    if (this.#pendingGroupPlacement.size === 0 && this.#pendingFeaturePlacement.size === 0) {
      return;
    }
    const groups = [...this.#pendingGroupPlacement];
    const features = [...this.#pendingFeaturePlacement];
    this.#pendingGroupPlacement.clear();
    this.#pendingFeaturePlacement.clear();

    for (const [groupId, { layerId, index }] of groups) {
      if (!this.#groups.has(groupId) || this.#isListedInAnyLayer(groupId)) continue;
      const layer = this.#layers.get(layerId);
      if (!layer) continue;
      this.#mutateLayerOrder(layer, (order) => {
        order.splice(Math.min(index, order.length), 0, groupId);
      });
      this.#layerOrderSet(layer).add(groupId);
      this.#setGroupLayer(groupId, layer.id);
    }

    for (const id of features) {
      const feature = this.#features.get(id);
      if (!feature || feature.groupId) continue;
      this.#addItemToLayerOrder(id, feature.layerId);
    }
  }

  /** The ID of the layer whose items list the item, or undefined */
  #layerListing(itemId: string): string | undefined {
    for (const layer of this.#layers.values()) {
      if (this.#layerOrderSet(layer).has(itemId)) return layer.id;
    }
    return undefined;
  }

  /** The layer of the first of the features that exists, or undefined */
  #firstMemberLayer(featureIds: readonly string[]): string | undefined {
    for (const featureId of featureIds) {
      const feature = this.#features.get(featureId);
      if (feature) return feature.layerId;
    }
    return undefined;
  }

  /** Moves every group the items of the layer list to the layer (`Group.layerId`) */
  #syncGroupLayers(layer: Layer): void {
    if (this.#groups.size === 0) return;
    for (const itemId of layer.items) {
      if (this.#groups.has(itemId)) this.#setGroupLayer(itemId, layer.id);
    }
  }

  /**
   * Sets the layer of a group and notifies it as groups.updated, when it changes
   *
   * The change goes into the group's copy for the current notification, like a change of its
   * featureIds (#mutateGroupFeatureIds).
   */
  #setGroupLayer(groupId: string, layerId: string): void {
    const current = this.#groups.get(groupId);
    if (!current || current.layerId === layerId) return;
    const hadUpdate = this.#bus.hasPendingGroupUpdate(groupId);
    const fresh = this.#freshGroups.has(groupId);
    const previous = hadUpdate
      ? undefined
      : fresh
        ? { ...current, featureIds: [...current.featureIds] }
        : current;
    const group = this.#writableGroup(current);
    group.layerId = layerId;
    this.#bus.mergeGroupUpdate(group, previous);
  }

  #isListedInAnyLayer(itemId: string): boolean {
    for (const layer of this.#layers.values()) {
      if (this.#layerOrderSet(layer).has(itemId)) return true;
    }
    return false;
  }

  #assertLayerExists(layerId: string | undefined): void {
    if (layerId === undefined || !this.#layers.has(layerId)) {
      throw new Error(`Layer with id "${layerId}" not found`);
    }
  }

  /** Lists the feature in the order of its container (its group, or else its layer) */
  #addToContainer(feature: Feature): void {
    if (feature.groupId) {
      this.#addFeatureToGroupOrder(feature.id, feature.groupId);
    } else {
      this.#addItemToLayerOrder(feature.id, feature.layerId);
    }
  }

  /** Removes the feature from the order of its container (its group, or else its layer) */
  #removeFromContainer(feature: Feature): void {
    if (feature.groupId) {
      this.#removeFeatureFromGroupOrder(feature.id, feature.groupId);
    } else {
      this.#removeItemFromLayerOrder(feature.id, feature.layerId);
    }
  }

  #addItemToLayerOrder(itemId: string, layerId: string): void {
    const layer = this.#layers.get(layerId);
    if (!layer) return;

    const index = this.#layerOrderSet(layer);
    if (index.has(itemId)) return;

    this.#mutateLayerOrder(layer, (order) => {
      order.push(itemId);
    });
    index.add(itemId);
  }

  #removeItemFromLayerOrder(itemId: string, layerId: string): void {
    const layer = this.#layers.get(layerId);
    if (!layer) return;

    // Most IDs, such as features belonging to a group, are not listed in order, so they are
    // rejected by the index before the traversal (indexOf itself is needed to locate the
    // splice position).
    const index = this.#layerOrderSet(layer);
    if (!index.has(itemId)) return;

    const idx = layer.items.indexOf(itemId);
    if (idx === -1) return;

    this.#mutateLayerOrder(layer, (order) => {
      order.splice(idx, 1);
    });
    index.delete(itemId);
  }

  #addFeatureToGroupOrder(featureId: string, groupId: string): void {
    const group = this.#groups.get(groupId);
    if (!group) return;

    const index = this.#groupFeatureSet(group);
    if (index.has(featureId)) return;

    this.#mutateGroupFeatureIds(group, (featureIds) => {
      featureIds.push(featureId);
    });
    index.add(featureId);
  }

  #removeFeatureFromGroupOrder(featureId: string, groupId: string): void {
    const group = this.#groups.get(groupId);
    if (!group) return;

    const index = this.#groupFeatureSet(group);
    if (!index.has(featureId)) return;

    const idx = group.featureIds.indexOf(featureId);
    if (idx === -1) return;

    this.#mutateGroupFeatureIds(group, (featureIds) => {
      featureIds.splice(idx, 1);
    });
    index.delete(featureId);

    // A group that has become empty is deleted automatically (the standard behavior of
    // canvas-style tools). A group is a container of elements, and an empty group only
    // clutters the layer tree.
    if (index.size === 0) {
      this.deleteGroup(groupId);
    }
  }
}

/**
 * Identifies the container that lists a feature: its group when it has one, otherwise its
 * layer. A feature is listed in exactly this container.
 */
function containerKey(feature: Feature): string {
  return feature.groupId ? `group:${feature.groupId}` : `layer:${feature.layerId}`;
}

/**
 * A shallow copy whose object and array fields are frozen copies (the fields of a layer,
 * a group or the metadata other than the order they keep)
 */
function frozenFields<T extends object>(value: T): T {
  const copy = { ...value } as Record<string, unknown>;
  for (const key of Object.keys(copy)) copy[key] = frozenCopy(copy[key]);
  return copy as T;
}
