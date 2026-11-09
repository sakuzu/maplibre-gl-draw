// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The events of the draw instance: the emitter of `DrawEvents`, fed by the notifications of
 * the Store and by the signals of the engine, and the observables of its values
 *
 * One transaction of the Store is one notification. From it come first one `change` with the
 * IDs of what the commit changed, when it changed the document, then the signals of the values of
 * this client the observables follow (the selection, the mode, the vertex selection, what is
 * hidden here), and last the events of read-only and of the interaction lock. The engine
 * announces the rest on its internal emitter (snapping, clicks, images, the stacking order,
 * failed loads, drags), and each is passed on under its name here. The signals of the options,
 * the sketches, the datasets and the shapes as they are drawn come from their resources, on the
 * same hub.
 */

import { featureFields, featureWithFields } from '../../feature-table/feature-fields.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import { rowFeature } from '../../feature-table/row-read.js';
import type { EngineSignals, EventEmitter } from '../../shared/utils/event-emitter.js';
import { bulkSelectionValue, valueOfSelection } from '../../store/selection-value.js';
import type { Store } from '../../store/store.js';
import type {
  ItemOrderChange,
  ItemPosition,
  RowField,
  RowValues,
  SelectionValue,
  StoreChange,
  Feature as StoredFeature,
  VertexSelection as StoredVertexSelection,
} from '../../store/types.js';
import { drawErrorOf } from '../../table/draw-error-of.js';
import type { Dataset } from '../datasets.js';
import { DrawError } from '../errors.js';
import type { Change, ChangedIds, DrawEvents, Observable } from '../events.js';
import type { Hit } from '../extension/provider.js';
import type { Feature } from '../model.js';
import type { RuntimeOptions } from '../options.js';
import type { Sketch, SketchEndReason } from '../sketches.js';
import type { Mode, SnapResult, VertexSelection } from '../state.js';
import { toDatasetRow } from './rows.js';

/**
 * What the parts of the instance tell one another on the hub, besides the events: the changes of
 * the values its observables follow. They are not events of `draw.on`
 *
 * @internal
 */
export interface InstanceSignals {
  /** The selection changed: the new one and the one before it, as `draw.selection.value` gives them */
  'selection.changed': { selection: SelectionValue; previous: SelectionValue };
  /** The vertex selection changed */
  'vertexSelection.changed': {
    selection: VertexSelection | null;
    previous: VertexSelection | null;
  };
  /** The mode changed */
  'mode.changed': { mode: Mode; previous: Mode };
  /** The items this client hides changed; `ids` is the whole set after the change */
  'hidden.changed': { ids: ReadonlySet<string> };
  /** `draw.options.update` changed the options (an update that changes nothing is not told) */
  'options.changed': { options: Readonly<RuntimeOptions>; previous: Readonly<RuntimeOptions> };
  /** A sketch was added */
  'sketch.added': { sketch: Sketch };
  /** A sketch changed, or edits of it were left out (`dropped`) */
  'sketch.updated': { sketch: Sketch; dropped: number };
  /** A sketch ended */
  'sketch.removed': { sketch: Sketch; reason: SketchEndReason; dropped: number };
  /** A dataset was added */
  'dataset.added': { dataset: Dataset };
  /** A dataset was removed */
  'dataset.removed': { datasetId: string };
  /** The stacking order of the datasets changed */
  'dataset.reordered': { order: readonly string[]; previous: readonly string[] };
  /** The shapes of features as they are drawn changed, once a draw that draws them is done */
  'rendered.changed': { ids: readonly string[] };
}

/**
 * Everything the hub carries: the events and the signals of the instance
 *
 * @internal
 */
export type HubEvents = DrawEvents & InstanceSignals;

/** A function that receives the payload of an event or a signal of the hub */
type HubListener<K extends keyof HubEvents> = (payload: HubEvents[K]) => void;

/**
 * The emitter of `DrawEvents` and of the signals of one instance
 *
 * @internal
 */
export interface EventHub {
  /** Subscribes to an event and returns the function that unsubscribes */
  on<K extends keyof HubEvents>(event: K, listener: HubListener<K>): () => void;
  /** Unsubscribes a listener, whether it was given to `on` or to `once` */
  off<K extends keyof HubEvents>(event: K, listener: HubListener<K>): void;
  /** Subscribes to the next occurrence only and returns the function that unsubscribes */
  once<K extends keyof HubEvents>(event: K, listener: HubListener<K>): () => void;
  /** Calls the listeners of an event, each one isolated from the errors of the others */
  emit<K extends keyof HubEvents>(event: K, payload: HubEvents[K]): void;
  /** Drops every listener */
  clear(): void;
}

interface Entry {
  readonly listener: (payload: never) => void;
  readonly once: boolean;
}

/** Every event of `draw.on` */
const EVENT_KEYS = {
  change: true,
  'document.loaded': true,
  'drag.started': true,
  'drag.ended': true,
  'readOnly.changed': true,
  'interactionLock.changed': true,
  'snap.changed': true,
  'map.clicked': true,
  'dataset.clicked': true,
  'image.requested': true,
  'layerStack.changed': true,
  error: true,
} satisfies Record<keyof DrawEvents, true>;

/** The names of the events of `draw.on` */
const EVENTS: ReadonlySet<string> = new Set(Object.keys(EVENT_KEYS));

/**
 * Throws unless the name is one of the events of `draw.on`
 *
 * @throws DrawError `invalid-input` for any other name
 * @internal
 */
export function requireEventName(event: unknown): asserts event is keyof DrawEvents {
  if (typeof event !== 'string' || !EVENTS.has(event)) {
    throw new DrawError('invalid-input', `There is no event ${String(event)}`, { event });
  }
}

/**
 * Creates the emitter of `DrawEvents` and of the signals of the instance
 *
 * @internal
 */
export function createEventHub(): EventHub {
  const listeners = new Map<keyof HubEvents, Entry[]>();

  const add = <K extends keyof HubEvents>(
    event: K,
    listener: HubListener<K>,
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

  const remove = (event: keyof HubEvents, match: (entry: Entry) => boolean): void => {
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
          (entry.listener as (payload: HubEvents[typeof event]) => void)(payload);
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

/**
 * An observable of a value of the instance: `value` reads it, and `subscribe` calls the function
 * with it at once and each time one of the signals tells it changed. A subscriber that throws is
 * isolated from the others, as a listener is
 *
 * @param read - Reads the value now
 * @param options - `kept`: the value read is kept until one of the signals tells it changed, so
 *   that the same value is the same object (for a value read as a new object each time)
 * @internal
 */
export function observe<T>(
  hub: Pick<EventHub, 'on'>,
  signals: readonly (keyof HubEvents)[],
  read: () => T,
  options: { readonly kept?: boolean } = {},
): Observable<T> {
  if (options.kept) {
    const fresh = read;
    let kept: { value: T } | null = null;
    for (const signal of signals) {
      hub.on(signal, () => {
        kept = null;
      });
    }
    read = () => {
      kept ??= { value: fresh() };
      return kept.value;
    };
  }
  return {
    get value() {
      return read();
    },
    subscribe(run) {
      if (typeof run !== 'function') {
        throw new DrawError('invalid-input', 'The function to call must be a function');
      }
      const call = (): void => {
        try {
          run(read());
        } catch (error) {
          console.error('Error in a subscriber:', error);
        }
      };
      const stops = signals.map((signal) => hub.on(signal, call));
      call();
      return () => {
        for (const stop of stops.splice(0)) stop();
      };
    },
  };
}

// ============================================================================
// The notifications of the Store
// ============================================================================

/**
 * Passes the notifications of the Store on as the signals of the values of this client and as
 * `change`
 *
 * @returns The function that stops
 * @internal
 */
export function connectStoreEvents(hub: EventHub, store: Store): () => void {
  let vertexSelection = store.getVertexSelection();
  let hidden: ReadonlySet<string> = new Set(store.listHidden());
  let readOnly = store.isReadOnly();
  let locked = store.isInteractionLocked();
  return store.subscribe((changes) => {
    // The commit first, then the values of this client it moved: a listener of a value (the
    // selection) reads what the commit wrote as already told
    const change = toChange(changes, store);
    if (change) hub.emit('change', change);

    const selection = selectionChangeOf(changes, store);
    if (selection) hub.emit('selection.changed', selection);
    if (changes.mode) {
      hub.emit('mode.changed', { mode: changes.mode.mode, previous: changes.mode.previous });
    }

    const nextVertexSelection = store.getVertexSelection();
    if (!sameVertexSelection(vertexSelection, nextVertexSelection)) {
      const previous = vertexSelection;
      vertexSelection = nextVertexSelection;
      hub.emit('vertexSelection.changed', { selection: nextVertexSelection, previous });
    }

    // The state of this client that the notifications do not describe is compared with the
    // state the previous notification left
    const nextHidden = store.listHidden();
    if (!sameIds(hidden, nextHidden)) {
      hidden = new Set(nextHidden);
      hub.emit('hidden.changed', { ids: hidden });
    }
    const nextReadOnly = store.isReadOnly();
    if (nextReadOnly !== readOnly) {
      readOnly = nextReadOnly;
      hub.emit('readOnly.changed', { readOnly });
    }
    const nextLocked = store.isInteractionLocked();
    if (nextLocked !== locked) {
      locked = nextLocked;
      hub.emit('interactionLock.changed', { locked });
    }
  });
}

/** Whether two sets hold the same IDs */
function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * The items a list of moves of the order put in another place: where each was before its first
 * move and is after its last one, in the order of their first moves (an item created or deleted
 * in the list is left out, as are the moves of many rows at once)
 */
function movesOf(
  order: readonly ItemOrderChange[] | undefined,
): Map<string, { from: ItemPosition; to: ItemPosition }> {
  const moves = new Map<string, { from: ItemPosition | null; to: ItemPosition | null }>();
  for (const move of order ?? []) {
    if (move.kind !== 'item') continue;
    const known = moves.get(move.itemId);
    if (known) known.to = move.to;
    else moves.set(move.itemId, { from: move.from, to: move.to });
  }
  const out = new Map<string, { from: ItemPosition; to: ItemPosition }>();
  for (const [itemId, { from, to }] of moves) {
    if (from && to) out.set(itemId, { from, to });
  }
  return out;
}

/**
 * The change of the selection a notification tells, as `draw.selection.value` gives the selections
 * (null when it tells none)
 */
function selectionChangeOf(
  changes: StoreChange,
  store: Store,
): { selection: SelectionValue; previous: SelectionValue } | null {
  const change = changes.selection;
  if (!change) return null;
  return {
    selection:
      change.value ??
      valueOfSelection(store, {
        type: change.type,
        ids: change.ids,
        ...(change.bulk && { bulk: change.bulk }),
      }),
    previous:
      change.previousValue ??
      valueOfSelection(store, {
        type: change.previousType,
        ids: change.previousIds,
        ...(change.previousBulk && { bulk: change.previousBulk }),
      }),
  };
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

/** The categories of a notification that belong to the document */
const DOCUMENT_KEYS = [
  'features',
  'rows',
  'previousValues',
  'layers',
  'groups',
  'order',
  'metadata',
  'files',
] as const satisfies ReadonlyArray<keyof StoreChange>;

const NO_IDS: readonly string[] = Object.freeze([]);

/** The fields of a row that hold its place in the stacking order */
const PLACE_FIELDS: ReadonlySet<RowField> = new Set<RowField>([
  'layerId',
  'groupId',
  'order',
  'member',
]);

/** Whether the fields written to the rows of a layer are those of their places only */
function onlyPlaced(fields: ReadonlySet<RowField>): boolean {
  if (fields.size === 0) return false;
  for (const field of fields) if (!PLACE_FIELDS.has(field)) return false;
  return true;
}

/** The same IDs, or the empty list shared by every change */
function idsOf(list: string[]): readonly string[] {
  return list.length === 0 ? NO_IDS : list;
}

/** The IDs listed, without those in a set */
function without(list: string[], out: ReadonlySet<string>): string[] {
  return out.size === 0 ? list : list.filter((id) => !out.has(id));
}

/**
 * The IDs of a list whose place among the others changed from an order before: those out of the
 * longest run kept in the same relative order (an ID created or deleted is left out)
 */
function reordered(order: readonly string[], previous: readonly string[]): string[] {
  const before = new Map(previous.map((id, index) => [id, index]));
  const kept = order.filter((id) => before.has(id));
  // The longest increasing run of the places before, by patience sorting
  const places = kept.map((id) => before.get(id) as number);
  const tails: number[] = [];
  const tailOf: number[] = [];
  const parent = new Array<number>(places.length).fill(-1);
  places.forEach((place, i) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tails[middle] < place) low = middle + 1;
      else high = middle;
    }
    tails[low] = place;
    tailOf[low] = i;
    parent[i] = low > 0 ? tailOf[low - 1] : -1;
  });
  const stays = new Set<number>();
  for (let i = tails.length > 0 ? tailOf[tails.length - 1] : -1; i >= 0; i = parent[i]) {
    stays.add(i);
  }
  return kept.filter((_id, i) => !stays.has(i));
}

/**
 * The change a notification carries for `change`: the IDs of what it changed, and what a feature
 * was before; null when the notification changed nothing of the document
 *
 * The IDs of the rows written are read from their handles while the notification goes out (a
 * row deleted from elsewhere is forgotten later on).
 *
 * @internal
 */
export function toChange(changes: StoreChange, store: Store): Change | null {
  const reset = changes.reset === true;
  if (!reset && !DOCUMENT_KEYS.some((key) => changes[key] !== undefined)) return null;
  const tables = store.tables;

  const created: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  const placedFeatures: string[] = [];
  // The features of a Store of objects, each told once for the commit as a whole: what it was
  // before the commit is the one before its first write
  const before = foldFeatures(changes, store, {
    created,
    updated,
    deleted,
    placed: placedFeatures,
  });

  const ofRows = (handles: Int32Array, out: string[]): void => {
    if (!tables) return;
    for (const handle of handles) {
      const id = tables.getRowId(handle);
      if (id !== undefined) out.push(id);
    }
  };
  // A row whose only fields written are those of its place was put in another place, and nothing
  // else of it changed: it is told as placed, as a feature of a Store of objects is
  for (const rows of changes.rows?.layers.values() ?? []) {
    ofRows(rows.created, created);
    ofRows(rows.updated, onlyPlaced(rows.fields) ? placedFeatures : updated);
    ofRows(rows.deleted, deleted);
  }

  // The features and the groups put in another place of the order, each once
  const placedGroups: string[] = [];
  if (changes.order) {
    const seen = new Set<string>(placedFeatures);
    const add = (id: string, out: string[]): void => {
      if (seen.has(id)) return;
      seen.add(id);
      out.push(id);
    };
    for (const [itemId] of movesOf(changes.order)) {
      if (store.getGroup(itemId)) add(itemId, placedGroups);
      else add(itemId, placedFeatures);
    }
    for (const move of changes.order) {
      if (move.kind !== 'rows' || !tables) continue;
      for (const handle of move.handles) {
        const id = tables.getRowId(handle);
        if (id !== undefined) add(id, placedFeatures);
      }
    }
  }
  const featureIds: ChangedIds = {
    created: idsOf(created),
    updated: idsOf(updated),
    deleted: idsOf(deleted),
    placed: idsOf(
      placedFeatures.length === 0
        ? placedFeatures
        : without(placedFeatures, new Set([...created, ...deleted])),
    ),
  };

  const layers = changes.layers;
  const order = layers?.orderChanged ? stackingOrderOf(layers.orderChanged, store, layers) : null;
  const layerIds: ChangedIds = {
    created: idsOf((layers?.created ?? []).map((layer) => layer.id)),
    updated: idsOf((layers?.updated ?? []).map((update) => update.id)),
    deleted: idsOf((layers?.deleted ?? []).map((layer) => layer.id)),
    placed: idsOf(order?.placed ?? []),
  };
  const groups = changes.groups;
  const groupsCreated = (groups?.created ?? []).map((group) => group.id);
  const groupsDeleted = (groups?.deleted ?? []).map((group) => group.id);
  const groupIds: ChangedIds = {
    created: idsOf(groupsCreated),
    updated: idsOf((groups?.updated ?? []).map((update) => update.id)),
    deleted: idsOf(groupsDeleted),
    placed: idsOf(without(placedGroups, new Set([...groupsCreated, ...groupsDeleted]))),
  };

  let rowsBefore: RowsBefore | null = null;
  return {
    source: changes.source ?? 'local',
    features: featureIds,
    layers: layerIds,
    groups: groupIds,
    // A change of the metadata or of the files, the whole document replaced, or an entry that is
    // not a layer (a dataset, an entry of the application) put in or out of the stacking order of
    // the layers, or in another place of it
    document:
      reset ||
      changes.metadata !== undefined ||
      changes.files !== undefined ||
      order?.otherEntries === true,
    previous(id) {
      if (typeof id !== 'string') return undefined;
      const found = before.get(id);
      if (found || !changes.rows) return found;
      rowsBefore ??= rowsBeforeOf(changes, store);
      return rowsBefore.previous(id);
    },
    ...(changes.rows && { rows: changes.rows }),
  };
}

/**
 * The features of a Store of objects a notification tells, folded over the commit: a feature once,
 * created (written after included), updated, deleted (written before included) or put in another
 * place only, and none for a feature created and deleted in the commit, or written back to what it
 * was. What each was before the commit is returned by its ID
 */
function foldFeatures(
  changes: StoreChange,
  store: Store,
  out: { created: string[]; updated: string[]; deleted: string[]; placed: string[] },
): Map<string, Feature> {
  const features = changes.features;
  const before = new Map<string, Feature>();
  if (!features) return before;
  const created = new Set<string>();
  for (const feature of features.created ?? []) created.add(feature.id);
  const deleted = new Map<string, StoredFeature>();
  for (const feature of features.deleted ?? []) deleted.set(feature.id, feature);
  // The first state before and the last state after of each feature written
  const written = new Map<string, { previous: StoredFeature; feature: StoredFeature }>();
  for (const update of features.updated ?? []) {
    const known = written.get(update.id);
    if (known) known.feature = update.feature;
    else written.set(update.id, { previous: update.previous, feature: update.feature });
  }
  for (const id of created) {
    if (!deleted.has(id)) {
      out.created.push(id);
      continue;
    }
    // Created and deleted: deleted then made again (it is there), or made and gone
    const now = store.getFeature(id);
    if (!now) continue;
    const was = deleted.get(id) as StoredFeature;
    before.set(id, was as Feature);
    if (featureFields(was, now).size > 0) out.updated.push(id);
    if (was.layerId !== now.layerId || was.groupId !== now.groupId) out.placed.push(id);
  }
  for (const [id, feature] of deleted) {
    if (created.has(id)) continue;
    out.deleted.push(id);
    before.set(id, (written.get(id)?.previous ?? feature) as Feature);
  }
  for (const [id, { previous, feature }] of written) {
    if (created.has(id) || deleted.has(id)) continue;
    const changed = featureFields(previous, feature).size > 0;
    const moved = previous.layerId !== feature.layerId || previous.groupId !== feature.groupId;
    if (!changed && !moved) continue;
    before.set(id, previous as Feature);
    if (changed) out.updated.push(id);
    if (moved) out.placed.push(id);
  }
  return before;
}

/**
 * A change of the stacking order of the layers: the layers whose place among the layers changed,
 * and whether an entry that is not a layer was put in or out of it, or in another place of it
 */
function stackingOrderOf(
  change: { order: readonly string[]; previous: readonly string[] },
  store: Store,
  layers: NonNullable<StoreChange['layers']>,
): { placed: string[]; otherEntries: boolean } {
  const gone = new Set((layers.deleted ?? []).map((layer) => layer.id));
  const isLayer = (id: string): boolean => gone.has(id) || store.getLayer(id) !== undefined;
  const placed = reordered(change.order.filter(isLayer), change.previous.filter(isLayer));
  // The other entries, each with its place among all the entries
  const placesOf = (list: readonly string[]): string =>
    list.flatMap((id, index) => (isLayer(id) ? [] : [`${index}:${id}`])).join('\n');
  return { placed, otherEntries: placesOf(change.order) !== placesOf(change.previous) };
}

/** What the rows of a change were before it, read when one is asked for */
interface RowsBefore {
  previous(id: string): Feature | undefined;
}

/**
 * The features of the rows a change wrote as they were before it: the row as it is (a row deleted
 * is kept as it was) with the values the Store gave for before this client's write over it. A row
 * created, and one written from elsewhere (no value before is kept), have none
 */
function rowsBeforeOf(changes: StoreChange, store: Store): RowsBefore {
  const tables = store.tables;
  const internals = featureTablesInternals(tables);
  const values = changes.previousValues as RowValues | undefined;
  // The handle of each row the change updated or deleted, by its ID
  const handles = new Map<string, number>();
  for (const rows of changes.rows?.layers.values() ?? []) {
    for (const list of [rows.updated, rows.deleted]) {
      for (const handle of list) {
        const id = tables?.getRowId(handle);
        if (id !== undefined) handles.set(id, handle);
      }
    }
  }
  let indexOf: Map<number, number> | null = null;
  // The place of each row moved before its first move (its layer and group), by its handle
  let placeOf: Map<number, Map<RowField, unknown>> | null = null;
  const placesBefore = (): Map<number, Map<RowField, unknown>> => {
    const out = new Map<number, Map<RowField, unknown>>();
    const take = (before: RowValues | undefined): void => {
      if (!before) return;
      before.handles.forEach((handle, index) => {
        if (out.has(handle)) return;
        const fields = new Map<RowField, unknown>();
        for (const field of ['layerId', 'groupId'] as const) {
          const list = before.fields.get(field);
          if (list) fields.set(field, list[index] ?? null);
        }
        out.set(handle, fields);
      });
    };
    for (const move of changes.order ?? []) take(move.before);
    return out;
  };
  return {
    previous(id) {
      const handle = handles.get(id);
      if (handle === undefined || !internals) return undefined;
      const fields = new Map<RowField, unknown>();
      if (values) {
        indexOf ??= new Map(Array.from(values.handles, (row, index) => [row, index]));
        const index = indexOf.get(handle);
        if (index !== undefined) {
          for (const [field, list] of values.fields) fields.set(field, list[index]);
        }
      }
      placeOf ??= placesBefore();
      for (const [field, value] of placeOf.get(handle) ?? []) fields.set(field, value);
      if (fields.size === 0) return undefined;
      const place = internals.placeOf(handle);
      if (!place) return undefined;
      let now: StoredFeature;
      try {
        now = rowFeature(internals.readContext, place.layer.layerId, place.group, place.row);
      } catch {
        return undefined;
      }
      return featureWithFields(now, fields) as Feature;
    },
  };
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
    hub.emit('error', { error: toDrawError(error), source, featureId });
  });
  listen('drag.started', ({ kind, featureIds, bulk }) => {
    hub.emit('drag.started', {
      kind,
      featureIds: [...featureIds],
      ...(bulk && { bulk: bulkSelectionValue(bulk) }),
    });
  });
  listen('drag.ended', ({ kind, featureIds, bulk, cancelled }) => {
    hub.emit('drag.ended', {
      kind,
      featureIds: [...featureIds],
      ...(bulk && { bulk: bulkSelectionValue(bulk) }),
      cancelled,
    });
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
  const wrapped = drawErrorOf(error);
  if (wrapped instanceof DrawError) return wrapped;
  const message = error instanceof Error ? error.message : String(error);
  return new DrawError('unsupported-format', message, { cause: error });
}
