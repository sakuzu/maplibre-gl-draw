// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The events of the draw instance: the emitter of `DrawEvents`, fed by the notifications of
 * the Store and by the signals of the engine
 *
 * One transaction of the Store is one notification. From it come first the events of each
 * resource (features, layers, groups, metadata, selection, editing, vertex selection, mode, hidden,
 * read-only, interaction lock, the shape being drawn), in that order, and last one
 * `document.changed`, in the words of the features, when the transaction changed the document,
 * with the changes of the subscribers of `draw.document.subscribe`. The engine announces the rest
 * on its internal emitter (snapping, clicks, images, the stacking order, failed loads,
 * drags), and each is passed on under its name here. `options.changed` comes from
 * `draw.options`, which emits it on the same hub.
 */

import { DRAW_PROPERTY_KEYS } from '../../shared/properties.js';
import { geometryFromCoordinates } from '../../shared/utils/coordinates.js';
import type { EngineSignals, EventEmitter } from '../../shared/utils/event-emitter.js';
import { countWork, type WorkCounts } from '../../shared/work-counts.js';
import type { InstanceDocument } from '../../store/document-access.js';
import type {
  FeatureCoordinates,
  StoreChange,
  Feature as StoredFeature,
  VertexSelection as StoredVertexSelection,
  TentativeState,
} from '../../store/types.js';
import type { DocumentSubscribeOptions } from '../document.js';
import { DrawError } from '../errors.js';
import type { DocumentChange, DrawEventListener, DrawEvents } from '../events.js';
import type { Hit } from '../extension/provider.js';
import type { UpdateSource } from '../extension/store.js';
import type { ChangedIds, Feature, FeatureInput, Group, MoveTarget } from '../model.js';
import type { SnapResult } from '../state.js';
import { type ChangeSummary, summaryOfChange, watchChanges } from './document-access.js';
import { groupChangesOf, valuesOfChange } from './feature-values.js';
import { makeIdSet } from './id-set.js';
import { toDatasetRow } from './rows.js';
import { createValuesKeeper, type ValuesKeeper } from './values-keeper.js';

/**
 * The emitter of `DrawEvents` of one instance
 *
 * @internal
 */
export interface EventHub {
  /** Subscribes to an event and returns the function that unsubscribes */
  on<K extends keyof DrawEvents>(event: K, listener: DrawEventListener<K>): () => void;
  /** Unsubscribes a listener, whether it was given to `on` or to `once` */
  off<K extends keyof DrawEvents>(event: K, listener: DrawEventListener<K>): void;
  /** Subscribes to the next occurrence only and returns the function that unsubscribes */
  once<K extends keyof DrawEvents>(event: K, listener: DrawEventListener<K>): () => void;
  /** Calls the listeners of an event, each one isolated from the errors of the others */
  emit<K extends keyof DrawEvents>(event: K, payload: DrawEvents[K]): void;
  /** Whether an event has a listener */
  has(event: keyof DrawEvents): boolean;
  /**
   * Subscribes to the changes of the document, as `draw.document.subscribe` does
   *
   * @returns The function that unsubscribes
   * @throws `DrawError` with the code `invalidInput` for a listener that is not a function, or
   *   options of the wrong shape
   */
  subscribe(
    listener: (change: DocumentChange) => void,
    options?: DocumentSubscribeOptions,
  ): () => void;
  /** The subscribers of the changes of the document, in the order they subscribed */
  subscribers(): readonly DocumentSubscriber[];
  /** What the values before the changes given to the subscribers keep, until they let go */
  readonly values: ValuesKeeper;
  /** Drops every listener */
  clear(): void;
}

/**
 * A subscriber of the changes of the document
 *
 * @internal
 */
export interface DocumentSubscriber {
  /** Called with each change */
  readonly listener: (change: DocumentChange) => void;
  /** Whether the change carries the values the features had before it, asked before it writes */
  asks(change: { readonly source: UpdateSource; readonly operationId: number }): boolean;
}

/** How a subscriber asks for the values before (see `DocumentSubscribeOptions.previousValues`) */
function asksOf(previousValues: unknown): DocumentSubscriber['asks'] {
  if (previousValues === undefined || previousValues === false) return () => false;
  if (previousValues === true) return () => true;
  if (typeof previousValues === 'function') {
    return (change) => {
      try {
        return (previousValues as (change: object) => unknown)(change) === true;
      } catch (error) {
        console.error('Error in a subscriber of the document asked for the values before:', error);
        return false;
      }
    };
  }
  const sourcesOf = (list: unknown, what: string): ReadonlySet<string> => {
    if (!Array.isArray(list) || list.some((source) => typeof source !== 'string')) {
      throw new DrawError('invalidInput', `subscribe: ${what} is not an array of sources`);
    }
    return new Set(list as string[]);
  };
  if (Array.isArray(previousValues)) {
    const sources = sourcesOf(previousValues, 'previousValues');
    return (change) => sources.has(change.source);
  }
  if (typeof previousValues === 'object' && previousValues !== null) {
    const except = sourcesOf(
      (previousValues as { except?: unknown }).except,
      'previousValues.except',
    );
    return (change) => !except.has(change.source);
  }
  throw new DrawError(
    'invalidInput',
    'subscribe: previousValues is neither a boolean, sources, { except } nor a function',
  );
}

interface Entry {
  readonly listener: (payload: never) => void;
  readonly once: boolean;
}

/**
 * Creates the emitter of `DrawEvents`
 *
 * @internal
 */
export function createEventHub(): EventHub {
  const listeners = new Map<keyof DrawEvents, Entry[]>();
  const values = createValuesKeeper();
  let subscribers: readonly DocumentSubscriber[] = [];

  const add = <K extends keyof DrawEvents>(
    event: K,
    listener: DrawEventListener<K>,
    once: boolean,
  ): (() => void) => {
    if (typeof listener !== 'function') {
      throw new DrawError('invalidInput', 'The listener must be a function');
    }
    const entry: Entry = { listener, once };
    const list = listeners.get(event) ?? [];
    list.push(entry);
    listeners.set(event, list);
    return () => remove(event, (candidate) => candidate === entry);
  };

  const remove = (event: keyof DrawEvents, match: (entry: Entry) => boolean): void => {
    const list = listeners.get(event);
    if (!list) return;
    const index = list.findIndex(match);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) listeners.delete(event);
  };

  return {
    on: (event, listener) => add(event, listener, false),
    once: (event, listener) => add(event, listener, true),
    off(event, listener) {
      remove(event, (entry) => entry.listener === listener);
    },
    emit(event, payload) {
      const list = listeners.get(event);
      if (!list) return;
      // A snapshot: listeners added or removed during the emit take effect from the next one
      for (const entry of [...list]) {
        if (entry.once) remove(event, (candidate) => candidate === entry);
        try {
          (entry.listener as DrawEventListener<typeof event>)(payload);
        } catch (error) {
          console.error(`Error in the listener of "${String(event)}":`, error);
        }
      }
    },
    has: (event) => (listeners.get(event)?.length ?? 0) > 0,
    subscribe(listener, options) {
      if (typeof listener !== 'function') {
        throw new DrawError('invalidInput', 'The listener must be a function');
      }
      if (options !== undefined && (typeof options !== 'object' || options === null)) {
        throw new DrawError('invalidInput', 'subscribe: the options are not an object');
      }
      const subscriber: DocumentSubscriber = {
        listener,
        asks: asksOf(options?.previousValues),
      };
      // A new list each time: a change being told goes on with the subscribers it started with
      subscribers = [...subscribers, subscriber];
      return () => {
        subscribers = subscribers.filter((candidate) => candidate !== subscriber);
      };
    },
    subscribers: () => subscribers,
    values,
    clear() {
      listeners.clear();
      subscribers = [];
    },
  };
}

// ============================================================================
// The notifications of the Store
// ============================================================================

/**
 * Passes the notifications of the Store on as events
 *
 * Each change of the layer over the Store gives first the events of each resource, then
 * `document.changed` and the changes of the subscribers of `draw.document.subscribe`, in the
 * words of the features: the IDs of what changed, from the summary the layer keeps with the
 * change. The events of one feature are made only while they have a listener.
 *
 * @returns The function that stops
 * @internal
 */
export function connectStoreEvents(hub: EventHub, store: InstanceDocument): () => void {
  // The state of this client is held by the instance; its changes arrive in the notification of
  // the operation they belong to
  const { client } = store;
  let vertexSelection = client.getVertexSelection();
  let hidden: readonly string[] = Object.freeze([...client.listHidden()]);
  let readOnly = client.isReadOnly();
  let locked = client.isInteractionLocked();
  const readsChanges = (): boolean => hub.has('document.changed') || hub.subscribers().length > 0;
  // The geometries the values before write back vertex by vertex follow the changes of their rows
  const follows = (): boolean => hub.values.following();
  const counts = watchChanges(store, {
    wanted: () => readsChanges() || hub.has('feature.moved') || hub.has('group.moved') || follows(),
    deletedFeatures: () => hub.has('feature.deleted'),
    asksValues(change) {
      const asking = hub.subscribers().filter((subscriber) => subscriber.asks(change));
      return asking.length > 0 ? asking : null;
    },
  });
  const stop = store.subscribe((changes) => {
    const summary = summaryOfChange(changes);
    // The sets of IDs are made before any listener can write
    const ids =
      summary && (readsChanges() || hub.has('feature.moved') || follows()) ? summary.ids() : null;
    // The values before given earlier follow what this change did to their geometries
    if (ids && follows()) {
      hub.values.follow(changes.reset ? null : ids.updated, store.getTables());
    }
    emitResourceEvents(hub, store, changes, summary, ids, counts);

    const nextVertexSelection = client.getVertexSelection();
    if (!sameVertexSelection(vertexSelection, nextVertexSelection)) {
      const previous = vertexSelection;
      vertexSelection = nextVertexSelection;
      hub.emit('vertexSelection.changed', { selection: nextVertexSelection, previous });
    }

    // The state of this client that the notifications do not describe is compared with the
    // state the previous notification left
    const nextHidden = client.listHidden();
    if (!sameIds(hidden, nextHidden)) {
      hidden = Object.freeze([...nextHidden]);
      hub.emit('hidden.changed', { ids: makeIdSet(hidden) });
    }
    const nextReadOnly = client.isReadOnly();
    if (nextReadOnly !== readOnly) {
      readOnly = nextReadOnly;
      hub.emit('readOnly.changed', { readOnly });
    }
    const nextLocked = client.isInteractionLocked();
    if (nextLocked !== locked) {
      locked = nextLocked;
      hub.emit('interactionLock.changed', { locked });
    }

    // The shape being drawn, once per notification that set or cleared it
    const tentative = changes.tentative;
    if (tentative && (tentative.state !== null || tentative.previous !== null)) {
      hub.emit('preview.changed', toPreviewPayload(tentative.state));
    }

    if (!summary || !ids) return;
    const change = toDocumentChange(changes, summary, ids, store);
    hub.emit('document.changed', change);
    tellSubscribers(hub, change, summary, changes, store, counts);
  });
  return () => {
    stop();
    watchChanges(store, null);
  };
}

/** The changes of the subscribers of `draw.document.subscribe`: each with values of its own */
function tellSubscribers(
  hub: EventHub,
  change: DocumentChange,
  summary: ChangeSummary,
  changes: StoreChange,
  store: InstanceDocument,
  counts: WorkCounts | undefined,
): void {
  const subscribers = hub.subscribers();
  if (subscribers.length === 0) return;
  const asked = Array.isArray(summary.askedBy) ? (summary.askedBy as unknown[]) : [];
  // Held once for every subscriber that asked for them; none for a change that wrote no feature
  // and no group
  const shared =
    asked.length > 0
      ? valuesOfChange({
          before: summary.valuesBefore,
          created: store.rowsOfFeatureSet(change.features.created).slice(),
          tables: store.getTables(),
          layerIds: () => store.getLayerOrder(),
          wholeGeometry: summary.wholeGeometry,
          groups: groupChangesOf(changes.groups, summary.groupsMoved, summary.groupsDeleted),
          made: (count) => countWork(counts, 'objectsCreated', count),
        })
      : null;
  if (shared) hub.values.adopt(shared);
  // The rows the change deleted stay while the values given to the subscribers keep them (the
  // layer lets go of them once the change is told, when they were not taken)
  const release = shared ? summary.claimDeletedRows() : undefined;
  if (shared && release) hub.values.keep(shared, release);
  for (const subscriber of subscribers) {
    const own: DocumentChange =
      shared && asked.includes(subscriber) ? { ...change, previousValues: shared.hold() } : change;
    try {
      subscriber.listener(own);
    } catch (error) {
      console.error('Error in a subscriber of the document:', error);
    }
  }
  // Values no subscriber holds, or that every subscriber let go of while it was told, keep nothing
  if (shared && release) hub.values.settle(shared);
}

/**
 * The payload of `preview.changed`: the shape being drawn, with the options `preview.set` was
 * given (each left out when it was not given, both when the shape is cleared)
 *
 * @internal
 */
export function toPreviewPayload(state: TentativeState | null): DrawEvents['preview.changed'] {
  const payload: DrawEvents['preview.changed'] = { feature: toPreviewFeature(state) };
  if (state?.confirmedCount !== undefined) payload.confirmedVertices = state.confirmedCount;
  if (state?.highlightedVertexIndex !== undefined) {
    payload.highlightVertex = state.highlightedVertexIndex;
  }
  return payload;
}

/**
 * The shape being drawn in the shape of the API: its type, geometry and layer, the ID it will
 * be created with, and the radius of a circle
 *
 * @internal
 */
export function toPreviewFeature(state: TentativeState | null): FeatureInput | null {
  if (!state) return null;
  const coordinates = structuredClone(state.coordinates) as FeatureCoordinates;
  const feature: FeatureInput = {
    type: state.type,
    geometry: geometryFromCoordinates(state.type, coordinates),
    layerId: state.layerId,
  };
  if (state.pendingFeatureId !== undefined) feature.id = state.pendingFeatureId;
  const properties: Record<string, number> = {};
  if (state.radiusMeters !== undefined) {
    properties[DRAW_PROPERTY_KEYS.radiusMeters] = state.radiusMeters;
  }
  if (state.radiusHandleAngle !== undefined) {
    properties[DRAW_PROPERTY_KEYS.radiusHandleAngle] = state.radiusHandleAngle;
  }
  if (Object.keys(properties).length > 0) {
    feature.properties = properties as FeatureInput['properties'];
  }
  return feature;
}

/** Whether a list of IDs holds the same IDs as a set */
function sameIds(list: readonly string[], set: ReadonlySet<string>): boolean {
  return list.length === set.size && list.every((id) => set.has(id));
}

/**
 * Whether a layer or a group changed in one of its own values (not in the order of what it
 * holds, which is not one of its fields)
 */
function ownValuesChanged(value: object, previous: object): boolean {
  const a = value as Record<string, unknown>;
  const b = previous as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] === b[key]) continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return true;
  }
  return false;
}

/** The events of each resource of one notification */
function emitResourceEvents(
  hub: EventHub,
  store: InstanceDocument,
  changes: StoreChange,
  summary: ChangeSummary | undefined,
  ids: ChangedIds | null,
  counts: WorkCounts | undefined,
): void {
  const source = changes.source ?? 'local';
  const hasMoreParts = summary?.hasMoreParts ?? false;
  /** The payload of an event of one feature is an object made for its listeners */
  const made = (): void => countWork(counts, 'objectsCreated');

  const { features, layers, groups } = changes;
  const tellDeleted = (): void => {
    if (!hub.has('feature.deleted')) return;
    for (const feature of features?.deleted ?? []) {
      made();
      hub.emit('feature.deleted', { feature: feature as Feature, source, hasMoreParts });
    }
  };
  // A change that replaces the whole document tells what it took out before what it writes
  const reset = changes.reset === true;
  if (reset) tellDeleted();
  if (hub.has('feature.created')) {
    for (const feature of features?.created ?? []) {
      made();
      hub.emit('feature.created', { feature: feature as Feature, source, hasMoreParts });
    }
  }
  const movesTold = hub.has('feature.moved');
  /** The features whose move was told with their update */
  const moved = new Set<string>();
  if (hub.has('feature.updated') || movesTold) {
    for (const update of features?.updated ?? []) {
      if (hub.has('feature.updated')) {
        made();
        hub.emit('feature.updated', {
          feature: update.feature as Feature,
          previous: update.previous as Feature,
          source,
          intermediate: update.isIntermediate === true,
        });
      }
      if (!movesTold) continue;
      const move = describeMove(store, summary, update.previous, update.feature);
      if (!move) continue;
      moved.add(update.id);
      made();
      hub.emit('feature.moved', {
        feature: update.feature as Feature,
        ...move,
        source,
        hasMoreParts,
      });
    }
  }
  // The features that took another position in their layer or their group
  if (movesTold && ids) {
    for (const id of ids.moved.iterate()) {
      if (moved.has(id)) continue;
      const feature = store.getFeature(id);
      if (!feature) continue;
      const move = describeMoveWithin(store, summary, feature);
      made();
      hub.emit('feature.moved', { feature, ...move, source, hasMoreParts });
    }
  }
  if (!reset) tellDeleted();

  for (const layer of layers?.created ?? []) hub.emit('layer.created', { layer, source });
  for (const { layer, previous } of layers?.updated ?? []) {
    // A change of the order of its items alone is told by the moves
    if (ownValuesChanged(layer, previous)) hub.emit('layer.updated', { layer, previous, source });
  }
  for (const layer of layers?.deleted ?? []) hub.emit('layer.deleted', { layer, source });
  if (layers?.orderChanged) {
    hub.emit('layer.reordered', {
      order: [...layers.orderChanged.order],
      previous: [...layers.orderChanged.previous],
      source,
    });
  }

  for (const group of groups?.created ?? []) hub.emit('group.created', { group, source });
  for (const { group, previous } of groups?.updated ?? []) {
    // A change of the order of its features alone is told by the moves
    if (ownValuesChanged(group, previous)) hub.emit('group.updated', { group, previous, source });
  }
  if (summary && hub.has('group.moved')) {
    for (const entry of groupMoves(store, summary)) {
      hub.emit('group.moved', { group: entry.group, from: entry.from, to: entry.to, source });
    }
  }
  for (const group of groups?.deleted ?? []) hub.emit('group.deleted', { group, source });

  if (changes.metadata) {
    hub.emit('metadata.updated', {
      metadata: changes.metadata.metadata,
      previous: changes.metadata.previous,
      source,
    });
  }

  if (changes.selection) {
    // The operation of the change of the document it came with, or null for the selection alone
    hub.emit('selection.changed', {
      // The sets never change: they are given as they are, without a copy
      selection: { type: changes.selection.type, ids: changes.selection.ids },
      previous: { type: changes.selection.previousType, ids: changes.selection.previousIds },
      operationId: summary ? summary.operationId : null,
    });
  }

  if (changes.editing) {
    hub.emit('editingFeatures.changed', { ids: makeIdSet(store.client.getEditingIds()) });
  }

  if (changes.mode) {
    hub.emit('mode.changed', { mode: changes.mode.mode, previous: changes.mode.previous });
  }
}

/** The groups a change moved, where each was and where it is now */
function groupMoves(
  store: InstanceDocument,
  summary: ChangeSummary,
): Array<{ id: string; group: Group; from: MoveTarget; to: MoveTarget }> {
  const out: Array<{ id: string; group: Group; from: MoveTarget; to: MoveTarget }> = [];
  for (const [id, before] of summary.groupsMoved) {
    const group = store.getGroup(id);
    if (!group) continue;
    out.push({
      id,
      group,
      from: atPositionBefore(store, { layerId: before.layerId }, before.layerId, id),
      to: atPositionNow(store, summary, { layerId: group.layerId }, group.layerId, id),
    });
  }
  return out;
}

/**
 * Where a feature moved from and to, when an update changed its layer or its group; null
 * otherwise. The position it left is counted as its container was before the change, and the
 * position it went to is read from the order right after the change.
 */
function describeMove(
  store: InstanceDocument,
  summary: ChangeSummary | undefined,
  previous: StoredFeature,
  feature: StoredFeature,
): { from: MoveTarget; to: MoveTarget } | null {
  if (previous.layerId === feature.layerId && previous.groupId === feature.groupId) return null;

  const from: MoveTarget = previous.groupId
    ? atPositionBefore(store, { groupId: previous.groupId }, previous.groupId, previous.id)
    : atPositionBefore(store, { layerId: previous.layerId }, previous.layerId, previous.id);

  let to: MoveTarget;
  if (feature.groupId) {
    to = atPositionNow(store, summary, { groupId: feature.groupId }, feature.groupId, feature.id);
  } else if (previous.groupId && previous.layerId === feature.layerId) {
    // Out of its group, in the same layer
    to = atPositionNow(store, summary, { groupId: null }, feature.layerId, feature.id);
  } else {
    to = atPositionNow(store, summary, { layerId: feature.layerId }, feature.layerId, feature.id);
  }
  return { from, to };
}

/** Where a feature that took another position in its layer or its group was, and is now */
function describeMoveWithin(
  store: InstanceDocument,
  summary: ChangeSummary | undefined,
  feature: StoredFeature,
): { from: MoveTarget; to: MoveTarget } {
  if (feature.groupId) {
    const { groupId } = feature;
    return {
      from: atPositionBefore(store, { groupId }, groupId, feature.id),
      to: atPositionNow(store, summary, { groupId }, groupId, feature.id),
    };
  }
  const { layerId } = feature;
  return {
    from: atPositionBefore(store, { layerId }, layerId, feature.id),
    to: atPositionNow(store, summary, { layerId }, layerId, feature.id),
  };
}

/**
 * A target with the position the item has right after the change in a container, when it is in
 * that container: counted before a later write when the change was told after it, read from its
 * place alone otherwise
 */
function atPositionNow<T extends MoveTarget>(
  store: InstanceDocument,
  summary: ChangeSummary | undefined,
  target: T,
  containerId: string,
  id: string,
): T {
  const fixed = summary?.positionAfter(id);
  const at = fixed === undefined ? store.getItemPosition(id) : fixed;
  return at?.containerId === containerId ? { ...target, index: at.index } : target;
}

/**
 * A target with the position the item had in a container before the change being told, when it
 * was in that container
 */
function atPositionBefore<T extends MoveTarget>(
  store: InstanceDocument,
  target: T,
  containerId: string,
  id: string,
): T {
  const at = store.getItemPositionBefore(id);
  return at?.containerId === containerId ? { ...target, index: at.index } : target;
}

/** Whether two vertex selections hold the same vertices of the same feature */
function sameVertexSelection(
  a: StoredVertexSelection | null,
  b: StoredVertexSelection | null,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.featureId !== b.featureId || a.vertices.length !== b.vertices.length) {
    return false;
  }
  return a.vertices.every((vertex, i) => {
    const other = b.vertices[i];
    return (
      (vertex.part ?? 0) === (other.part ?? 0) &&
      vertex.ring === other.ring &&
      vertex.index === other.index
    );
  });
}

/**
 * The change a notification carries, in the words of the features: the IDs of the features it
 * wrote, the layers, the groups, the metadata and the files it changed
 *
 * @internal
 */
export function toDocumentChange(
  changes: StoreChange,
  summary: ChangeSummary,
  ids: ChangedIds,
  store: InstanceDocument,
): DocumentChange {
  const change: DocumentChange = {
    source: changes.source ?? 'local',
    operationId: summary.operationId,
    hasMoreParts: summary.hasMoreParts,
    stopped: summary.stopped,
    reset: changes.reset === true,
    features: ids,
  };
  const layers: NonNullable<DocumentChange['layers']> = {};
  if (changes.layers?.created) layers.created = changes.layers.created;
  const layersUpdated = changes.layers?.updated?.filter((entry) =>
    ownValuesChanged(entry.layer, entry.previous),
  );
  if (layersUpdated && layersUpdated.length > 0) layers.updated = layersUpdated;
  if (changes.layers?.deleted) layers.deleted = changes.layers.deleted;
  // A change that creates or deletes a layer always carries the order, as the Store wrote it
  const orderChanged =
    changes.layers?.orderChanged ??
    (layers.created || layers.deleted ? summary.layerOrder : undefined);
  if (orderChanged) {
    layers.orderChanged = { order: [...orderChanged.order], previous: [...orderChanged.previous] };
  }
  if (Object.keys(layers).length > 0) change.layers = layers;

  const groups: NonNullable<DocumentChange['groups']> = {};
  if (changes.groups?.created) groups.created = changes.groups.created;
  const groupsUpdated = changes.groups?.updated?.filter((entry) =>
    ownValuesChanged(entry.group, entry.previous),
  );
  if (groupsUpdated && groupsUpdated.length > 0) groups.updated = groupsUpdated;
  if (changes.groups?.deleted) groups.deleted = changes.groups.deleted;
  const moved = groupMoves(store, summary);
  if (moved.length > 0) groups.moved = moved;
  if (Object.keys(groups).length > 0) change.groups = groups;

  if (changes.metadata) {
    change.metadata = {
      metadata: changes.metadata.metadata,
      previous: changes.metadata.previous,
      keys: summary.metadataKeys ?? metadataKeysOf(changes.metadata),
    };
  }
  if (changes.files) change.files = changes.files;
  return change;
}

/** The keys whose values differ between the metadata after and before a change */
function metadataKeysOf(metadata: NonNullable<StoreChange['metadata']>): readonly string[] {
  const after = metadata.metadata as unknown as Record<string, unknown>;
  const before = metadata.previous as unknown as Record<string, unknown>;
  return [...new Set([...Object.keys(after), ...Object.keys(before)])].filter(
    (key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]),
  );
}

// ============================================================================
// The signals of the engine
// ============================================================================

/**
 * Passes the signals the engine announces on its internal emitter on as events
 *
 * @returns The function that stops
 * @internal
 */
export function connectEngineEvents(
  hub: EventHub,
  emitter: EventEmitter,
  engine: {
    /** The frontmost hit at a point on the screen, for `map.clicked` */
    hitAt(point: { x: number; y: number }): Hit | null;
  } = { hitAt: () => null },
): () => void {
  const stops: Array<() => void> = [];
  const listen = <K extends keyof EngineSignals>(
    event: K,
    listener: (data: EngineSignals[K]) => void,
  ) => {
    emitter.on(event, listener);
    stops.push(() => emitter.off(event, listener));
  };

  listen('snap.change', (result) => {
    hub.emit('snap.changed', { result: result.target ? toSnapResult(result) : null });
  });
  listen('map.click', ({ lngLat, point }) => {
    hub.emit('map.clicked', {
      lngLat: [lngLat[0], lngLat[1]],
      point: [point.x, point.y],
      hit: engine.hitAt(point),
    });
  });
  listen('dataset.click', (payload) => {
    if (payload.datasetId === null || payload.feature === null || payload.row === null) return;
    hub.emit('dataset.clicked', {
      datasetId: payload.datasetId,
      rowIndex: payload.row,
      row: toDatasetRow(payload.feature),
      lngLat: [payload.lngLat[0], payload.lngLat[1]],
      point: payload.point ? [payload.point.x, payload.point.y] : [Number.NaN, Number.NaN],
    });
  });
  listen('image.request', ({ coordinate, zoom, layerId }) => {
    hub.emit('image.requested', { lngLat: [coordinate[0], coordinate[1]], zoom, layerId });
  });
  listen('layerStack.change', ({ slots }) => {
    hub.emit('layerStack.changed', {
      entries: slots.map(({ layerId, from, to }) => ({ layerId, from, to })),
    });
  });
  listen('load.error', ({ source, featureId, error }) => {
    hub.emit('image.failed', { error: toDrawError(error), source, featureId });
  });
  listen('drag.started', ({ kind, featureIds }) => {
    hub.emit('drag.started', { kind, featureIds: [...featureIds] });
  });
  listen('drag.ended', ({ kind, featureIds, cancelled }) => {
    hub.emit('drag.ended', { kind, featureIds: [...featureIds], cancelled });
  });

  return () => {
    for (const stop of stops.splice(0)) stop();
  };
}

/** The snapping result of the engine in the shape of the API */
function toSnapResult(result: EngineSignals['snap.change']): SnapResult {
  const snap: SnapResult = { lngLat: [result.lngLat.lng, result.lngLat.lat] };
  const target = result.target;
  if (!target) return snap;
  snap.target = { kind: target.kind };
  if (target.featureId !== undefined) snap.target.featureId = target.featureId;
  if (target.datasetId !== undefined) snap.target.datasetId = target.datasetId;
  if (target.description !== undefined) snap.target.description = target.description;
  if (target.vertex !== undefined) snap.target.vertex = { ...target.vertex };
  if (target.segment !== undefined) {
    snap.target.segment = {
      start: [...target.segment.start],
      end: [...target.segment.end],
    };
  }
  return snap;
}

/** A failure of a load as a DrawError, with what was thrown as its cause */
function toDrawError(error: unknown): DrawError {
  if (error instanceof DrawError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new DrawError('unsupportedFormat', message, { cause: error });
}
