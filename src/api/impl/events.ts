// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The events of the draw instance: the emitter of `DrawEvents`, fed by the notifications of
 * the Store and by the signals of the engine
 *
 * One transaction of the Store is one notification. From it come first the events of each
 * resource (features, layers, groups, metadata, selection, vertex selection, mode), in that
 * order, and last one `document.changed` with the whole change. The engine announces the rest
 * on its internal emitter (snapping, clicks, images, the stacking order, failed loads,
 * drags), and each is passed on under its name here.
 */

import type { EngineSignals, EventEmitter } from '../../shared/utils/event-emitter.js';
import type { Store } from '../../store/store.js';
import type {
  StoreChange,
  Feature as StoredFeature,
  VertexSelection as StoredVertexSelection,
} from '../../store/types.js';
import { DrawError } from '../errors.js';
import type { DocumentChange, DrawEventListener, DrawEvents } from '../events.js';
import type { Feature, MoveTarget } from '../model.js';
import type { SnapResult } from '../state.js';
import { toDatasetRow } from './rows.js';

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
  /** Drops every listener */
  clear(): void;
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

  const add = <K extends keyof DrawEvents>(
    event: K,
    listener: DrawEventListener<K>,
    once: boolean,
  ): (() => void) => {
    if (typeof listener !== 'function') {
      throw new DrawError('invalid-input', 'The listener must be a function');
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
    clear() {
      listeners.clear();
    },
  };
}

// ============================================================================
// The notifications of the Store
// ============================================================================

/**
 * Passes the notifications of the Store on as events
 *
 * @returns The function that stops
 * @internal
 */
export function connectStoreEvents(hub: EventHub, store: Store): () => void {
  let vertexSelection = store.getVertexSelection();
  return store.subscribe((changes) => {
    emitResourceEvents(hub, store, changes);

    const nextVertexSelection = store.getVertexSelection();
    if (!sameVertexSelection(vertexSelection, nextVertexSelection)) {
      const previous = vertexSelection;
      vertexSelection = nextVertexSelection;
      hub.emit('vertexSelection.changed', { selection: nextVertexSelection, previous });
    }

    const change = toDocumentChange(changes);
    if (change) hub.emit('document.changed', change);
  });
}

/** The events of each resource of one notification */
function emitResourceEvents(hub: EventHub, store: Store, changes: StoreChange): void {
  const source = changes.source ?? 'local';

  const { features, layers, groups } = changes;
  for (const feature of features?.created ?? []) {
    hub.emit('feature.created', { feature: feature as Feature, source });
  }
  for (const update of features?.updated ?? []) {
    hub.emit('feature.updated', {
      feature: update.feature as Feature,
      previous: update.previous as Feature,
      source,
      intermediate: update.isIntermediate === true,
    });
    const move = describeMove(store, changes, update.previous, update.feature);
    if (move) hub.emit('feature.moved', { feature: update.feature as Feature, ...move, source });
  }
  for (const feature of features?.deleted ?? []) {
    hub.emit('feature.deleted', { feature: feature as Feature, source });
  }

  for (const layer of layers?.created ?? []) hub.emit('layer.created', { layer, source });
  const updatedLayers = new Set<string>();
  for (const { id, layer, previous } of layers?.updated ?? []) {
    updatedLayers.add(id);
    hub.emit('layer.updated', { layer, previous, source });
  }
  // A reorder within a layer changes its items
  if (changes.layerReorder && !updatedLayers.has(changes.layerReorder.layerId)) {
    const layer = store.getLayer(changes.layerReorder.layerId);
    if (layer) {
      hub.emit('layer.updated', {
        layer,
        previous: { ...layer, items: [...changes.layerReorder.previous] },
        source,
      });
    }
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
  const updatedGroups = new Set<string>();
  for (const { id, group, previous } of groups?.updated ?? []) {
    updatedGroups.add(id);
    hub.emit('group.updated', { group, previous, source });
  }
  // A reorder within a group changes its features
  if (changes.groupReorder && !updatedGroups.has(changes.groupReorder.groupId)) {
    const group = store.getGroup(changes.groupReorder.groupId);
    if (group) {
      hub.emit('group.updated', {
        group,
        previous: { ...group, featureIds: [...changes.groupReorder.previous] },
        source,
      });
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
    hub.emit('selection.changed', {
      selection: { type: changes.selection.type, ids: [...changes.selection.ids] },
      previous: { type: changes.selection.previousType, ids: [...changes.selection.previousIds] },
    });
  }

  if (changes.mode) {
    hub.emit('mode.changed', { mode: changes.mode.mode, previous: changes.mode.previous });
  }
}

/**
 * Where a feature moved from and to, when an update changed its layer or its group; null
 * otherwise
 */
function describeMove(
  store: Store,
  changes: StoreChange,
  previous: StoredFeature,
  feature: StoredFeature,
): { from: MoveTarget; to: MoveTarget } | null {
  if (previous.layerId === feature.layerId && previous.groupId === feature.groupId) return null;

  const previousLayer = changes.layers?.updated?.find((u) => u.id === previous.layerId)?.previous;
  const previousGroup = previous.groupId
    ? changes.groups?.updated?.find((u) => u.id === previous.groupId)?.previous
    : undefined;
  const from: MoveTarget = previous.groupId
    ? withIndex({ groupId: previous.groupId }, previousGroup?.featureIds, previous.id)
    : withIndex({ layerId: previous.layerId }, previousLayer?.items, previous.id);

  let to: MoveTarget;
  if (feature.groupId) {
    to = withIndex(
      { groupId: feature.groupId },
      store.getGroup(feature.groupId)?.featureIds,
      feature.id,
    );
  } else if (previous.groupId && previous.layerId === feature.layerId) {
    // Out of its group, in the same layer
    to = withIndex({ groupId: null }, store.getLayer(feature.layerId)?.items, feature.id);
  } else {
    to = withIndex(
      { layerId: feature.layerId },
      store.getLayer(feature.layerId)?.items,
      feature.id,
    );
  }
  return { from, to };
}

/** A target with the position of the ID in the list, when the list holds it */
function withIndex<T extends MoveTarget>(
  target: T,
  list: readonly string[] | undefined,
  id: string,
): T {
  const index = list?.indexOf(id) ?? -1;
  return index >= 0 ? { ...target, index } : target;
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

/** The categories of a notification that `document.changed` carries */
const CHANGE_KEYS = [
  'features',
  'layers',
  'groups',
  'layerReorder',
  'groupReorder',
  'selection',
  'editing',
  'mode',
  'metadata',
] as const satisfies ReadonlyArray<keyof DocumentChange & keyof StoreChange>;

/**
 * The change a notification carries, without the state that only the drawing reads (the
 * geometry being drawn, the drag); null when nothing is left
 *
 * @internal
 */
export function toDocumentChange(changes: StoreChange): DocumentChange | null {
  const change: DocumentChange = {};
  let any = false;
  for (const key of CHANGE_KEYS) {
    if (changes[key] === undefined) continue;
    (change as Record<string, unknown>)[key] = changes[key];
    any = true;
  }
  if (!any) return null;
  change.source = changes.source ?? 'local';
  return change;
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
export function connectEngineEvents(hub: EventHub, emitter: EventEmitter): () => void {
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
    hub.emit('map.clicked', { lngLat: [lngLat[0], lngLat[1]], point: [point.x, point.y] });
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
    hub.emit('error', { error: toDrawError(error), source, featureId });
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
  return new DrawError('unsupported-format', message, { cause: error });
}
