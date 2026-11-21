// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The local state of a client, in memory
 *
 * ClientState: the state of this client (selection, editing, vertex selection, mode, read-only,
 * interaction lock, local visibility). The instance holds it; the Store holds only the document,
 * so a Store of the host never reads or writes it. It tells its changes in the categories of a
 * notification of the layer over the Store (`selection`, `editing`, `mode`, and uiStateChanged for
 * the rest) to the notification of the layer it is attached to, and, once per outermost
 * operation, to its own subscribers.
 */

import type { IdSet } from '../../api/model.js';
import { DrawError } from '../../shared/errors.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import type {
  Feature,
  Group,
  Layer,
  Mode,
  Selection,
  SelectionType,
  StoreChange,
  VertexSelection,
} from '../types.js';

/** A change of the state of this client, in the categories of a notification of the Store */
export type ClientChange = Pick<StoreChange, 'selection' | 'editing' | 'mode' | 'uiStateChanged'>;

/** What the rules of the state of this client read of the document */
export interface ClientDocument {
  /** A feature by ID, or `undefined` */
  getFeature(id: string): Feature | undefined;
  /** A group by ID, or `undefined` */
  getGroup(id: string): Group | undefined;
  /** A layer by ID, or `undefined` */
  getLayer(id: string): Layer | undefined;
  /** Every layer */
  listLayers(): Layer[];
  /**
   * The set of the items of a type named, in the order given, each once: for features, a set of
   * their rows (an ID that names no feature is left out, and a set of rows made by the same layer
   * is given back as it is)
   */
  idSetOf(type: SelectionType, ids: Iterable<string> | IdSet): IdSet;
  /** The set without the IDs `leaves` says leave it (the set itself when none does) */
  idSetWithout(type: SelectionType, ids: IdSet, leaves: (id: string) => boolean): IdSet;
  /**
   * The set of features without those that cannot be seen (see `pruneInvisible`), read from the
   * rows without the features being made (the set itself when every one is seen)
   */
  shownFeatureSetOf(ids: IdSet): IdSet;
}

/**
 * Where the state of this client is told and grouped: the notification of the Store the state
 * is attached to
 */
export interface ClientNotification {
  /** The document the rules read */
  readonly document: ClientDocument;
  /** Adds a change to the notification being built */
  merge(change: ClientChange): void;
  /** Runs `fn` as one operation, so that its changes go out as one notification */
  transact(fn: () => void): void;
}

/**
 * The state of this client, held by the instance
 *
 * The draw instance makes one and hands it to the Store it works with (`toStore`), which
 * attaches it to its notifications: a change of the state goes out in the notification of the
 * operation it belongs to, as before, and the subscribers of the state (the mode manager, the
 * rendering) hear of it once the operation and its notification are over. The Store a host
 * gives is never asked for it.
 *
 * It also keeps the rules of the state: an ID that no longer names anything leaves the
 * selection, the features being edited and the hidden items, whatever deleted it (a write of
 * the instance or a change made outside it); the selection holds only what can be seen; and
 * the vertex selection ends when its feature is gone or its coordinates change other than by a
 * drag (see {@link ClientState.followDocument}).
 *
 * @internal
 */
export class ClientState {
  #selection: Selection = { type: null, ids: new OwnIdSet([]) };
  #editingIds: string[] = [];
  #selectedVertices: VertexSelection | null = null;
  #mode: Mode = 'select';
  // Read-only (forbids local writes to the document). Local state, not part of the document.
  #readOnly = false;
  // Interaction lock (selection is allowed, but starting an edit operation is suppressed).
  // Local state that is orthogonal to readOnly and not part of the document. It does not stop writes
  // to the Store; it only rejects the start of an editing interaction from user input, for a
  // screen where the drawing is looked at and selected but not edited.
  #interactionLocked = false;
  // The set of hidden ids for this client only (feature / group / layer). It is a layer separate
  // from the visible flag of the document, and rendering, hit testing and box selection all
  // respect it. Not part of the document.
  readonly #locallyHidden = new Set<string>();

  #notification: ClientNotification | null = null;
  readonly #listeners = new Set<(change: ClientChange) => void>();
  /** The depth of the operations that hold the changes back from the subscribers */
  #held = 0;
  #pending: ClientChange = {};

  /**
   * Attaches the state to the notification of a Store; a later call replaces the earlier one
   *
   * Until it is attached, a change is told to the subscribers only, and the rules that read the
   * document do nothing.
   */
  attach(notification: ClientNotification): void {
    this.#notification = notification;
  }

  /**
   * Subscribes to the changes of the state: once per outermost operation, after its
   * notification of the Store, with every change it made
   *
   * @returns The function that unsubscribes
   */
  subscribe(listener: (change: ClientChange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Runs `fn` and tells the changes of the state it made to the subscribers when the outermost
   * call ends (after the notification of the Store `fn` makes)
   */
  hold<T>(fn: () => T): T {
    this.#held++;
    try {
      return fn();
    } finally {
      this.#held--;
      if (this.#held === 0) this.#flush();
    }
  }

  // Selection

  /** The selection: its IDs are a set that never changes, the same one until the selection does */
  getSelection(): Selection {
    return { type: this.#selection.type, ids: this.#selection.ids };
  }

  /** Replaces the selection (`null`, or no ID, clears it) */
  setSelection(type: SelectionType | null, ids: readonly string[] | IdSet): void {
    this.#write(() => this.#select(type, this.#setOf(type, ids)));
  }

  // Editing

  getEditingIds(): readonly string[] {
    // Returning the internal array as is would let a retained snapshot be rewritten by a later
    // startEditing/endEditing, so a defensive copy is returned.
    return [...this.#editingIds];
  }

  startEditing(ids: string[]): void {
    const newIds = ids.filter((id) => !this.#editingIds.includes(id));
    if (newIds.length === 0) return;
    this.#write(() => {
      this.#editingIds.push(...newIds);
      this.#changed({ editing: { started: newIds } });
    });
  }

  endEditing(ids: string[]): void {
    const endedIds = ids.filter((id) => this.#editingIds.includes(id));
    if (endedIds.length === 0) return;
    this.#write(() => {
      this.#editingIds = this.#editingIds.filter((id) => !ids.includes(id));
      this.#changed({ editing: { ended: endedIds } });
    });
  }

  // VertexSelection

  getVertexSelection(): VertexSelection | null {
    return this.#selectedVertices;
  }

  setSelectedVertices(selection: VertexSelection | null): void {
    this.#write(() => {
      this.#selectedVertices = selection
        ? {
            featureId: selection.featureId,
            vertices: selection.vertices.map((ref) => ({ ...ref })),
          }
        : null;
      this.#changed({ uiStateChanged: true });
    });
  }

  // Mode

  getMode(): Mode {
    return this.#mode;
  }

  setMode(mode: Mode): void {
    const previous = this.#mode;
    if (mode === previous) return;
    this.#write(() => {
      this.#mode = mode;
      this.#changed({ mode: { mode, previous } });
    });
  }

  // ReadOnly

  isReadOnly(): boolean {
    return this.#readOnly;
  }

  setReadOnly(value: boolean): void {
    if (this.#readOnly === value) return;
    this.#write(() => {
      this.#readOnly = value;
      // Whether handles are shown depends on read-only, so prompt a re-render.
      this.#changed({ uiStateChanged: true });
    });
  }

  // InteractionLock

  isInteractionLocked(): boolean {
    return this.#interactionLocked;
  }

  setInteractionLock(value: boolean): void {
    if (this.#interactionLocked === value) return;
    this.#write(() => {
      this.#interactionLocked = value;
      // While the interaction lock is on, no handles are shown (only the selection box), so
      // prompt a re-render.
      this.#changed({ uiStateChanged: true });
    });
  }

  // LocallyHidden

  isHidden(id: string): boolean {
    return this.#locallyHidden.has(id);
  }

  /** The hidden IDs: the set itself, changed in place (a reader copies what it keeps) */
  listHidden(): ReadonlySet<string> {
    return this.#locallyHidden;
  }

  /** Hides or shows an item; an item hidden leaves the selection (see pruneInvisible) */
  setLocallyHidden(id: string, hidden: boolean): void {
    if (this.#locallyHidden.has(id) === hidden) return;
    this.#write(() => {
      if (hidden) this.#locallyHidden.add(id);
      else this.#locallyHidden.delete(id);
      this.#changed({ uiStateChanged: true });
      if (hidden) this.pruneInvisible();
    });
  }

  // The rules

  /**
   * Removes an ID that no longer names anything in the document from the selection, the
   * features being edited and the hidden items
   */
  forget(id: string): void {
    const document = this.#notification?.document;
    if (!document) return;
    if (document.getFeature(id) || document.getGroup(id) || document.getLayer(id)) return;
    this.#write(() => {
      const { type, ids: selected } = this.#selection;
      if (type !== null && selected.has(id)) {
        const ids = document.idSetWithout(type, selected, (other) => other === id);
        this.#select(ids.count() === 0 ? null : type, ids);
      }
      if (this.#editingIds.includes(id)) this.endEditing([id]);
      if (this.#locallyHidden.delete(id)) this.#changed({ uiStateChanged: true });
    });
  }

  /**
   * Removes the IDs of a set that no longer name anything in the document from the selection, the
   * features being edited and the hidden items, in one write: each of them is read once, and the
   * work is that of the IDs this client holds and of the set, not of the one times the other
   */
  forgetAll(ids: ReadonlySet<string>): void {
    const document = this.#notification?.document;
    if (!document || ids.size === 0) return;
    const gone = (id: string): boolean =>
      ids.has(id) && !document.getFeature(id) && !document.getGroup(id) && !document.getLayer(id);
    this.#write(() => {
      const { type, ids: selected } = this.#selection;
      if (type !== null && selected.count() > 0) {
        const kept = document.idSetWithout(type, selected, gone);
        if (kept !== selected) this.#select(kept.count() === 0 ? null : type, kept);
      }
      if (this.#editingIds.length > 0) {
        const ended = this.#editingIds.filter(gone);
        if (ended.length > 0) this.endEditing(ended);
      }
      let unhidden = false;
      for (const id of [...this.#locallyHidden]) {
        if (gone(id)) {
          this.#locallyHidden.delete(id);
          unhidden = true;
        }
      }
      if (unhidden) this.#changed({ uiStateChanged: true });
    });
  }

  /**
   * Takes out of the selection what cannot be seen: an item that no longer exists, whose own
   * visible flag or the one of its group or layer is off, or that is hidden here with its group
   * or its layer. A hidden item never keeps its handles, its vertex hits or its place in a Delete
   */
  pruneInvisible(): void {
    const document = this.#notification?.document;
    const { type, ids } = this.#selection;
    if (!document || type === null || ids.count() === 0) return;
    let kept: IdSet;
    if (type === 'feature') {
      // Read from the rows, without the features being made
      kept = document.shownFeatureSetOf(ids);
    } else {
      const shown = createShownLookup(document, this.#locallyHidden);
      kept = document.idSetWithout(type, ids, (id) => !shown(type, id));
    }
    if (kept !== ids) {
      this.#write(() => this.#select(kept.count() > 0 ? type : null, kept));
    }
  }

  /**
   * Follows a change of the document, whatever wrote it: the IDs it deleted are forgotten,
   * what it hid leaves the selection, and the vertex selection ends when its feature is gone or
   * its coordinates changed other than by a drag of this client
   *
   * @param dragging Whether a drag of this client is under way (its frames and its commit keep
   *   the vertices being dragged selected)
   */
  followDocument(changes: StoreChange, dragging: boolean): void {
    this.#write(() => {
      if (changes.reset === true) {
        // What the replacement took out is not listed whole: each ID the state holds is asked
        this.#forgetGone();
      } else if (
        changes.features?.deleted?.length ||
        changes.groups?.deleted?.length ||
        changes.layers?.deleted?.length
      ) {
        // What the change deleted leaves the state in one write, the selection read once
        const deleted = new Set<string>();
        for (const feature of changes.features?.deleted ?? []) deleted.add(feature.id);
        for (const group of changes.groups?.deleted ?? []) deleted.add(group.id);
        for (const layer of changes.layers?.deleted ?? []) deleted.add(layer.id);
        this.forgetAll(deleted);
      }
      if (mayHide(changes)) this.pruneInvisible();
      this.#pruneVertices(changes, dragging);
    });
  }

  // Private

  /**
   * Forgets the IDs of the selection, of the features being edited and of the hidden items that
   * no longer name anything, each asked of the document: nothing is read while the state holds
   * none, and an ID written again by the change stays
   */
  #forgetGone(): void {
    if (
      this.#selection.ids.count() === 0 &&
      this.#editingIds.length === 0 &&
      this.#locallyHidden.size === 0
    ) {
      return;
    }
    const ids = new Set([
      ...this.#selection.ids.iterate(),
      ...this.#editingIds,
      ...this.#locallyHidden,
    ]);
    this.forgetAll(ids);
  }

  /** Runs a write of the state as one operation of the Store it is attached to */
  #write(fn: () => void): void {
    this.hold(() => {
      const notification = this.#notification;
      if (notification) notification.transact(fn);
      else fn();
    });
  }

  /** Replaces the selection: the sets never change, so the change holds them as they are */
  #select(type: SelectionType | null, ids: IdSet): void {
    const previousType = this.#selection.type;
    const previousIds = this.#selection.ids;
    const selected = type === null ? this.#setOf(null, []) : ids;
    this.#selection = { type: selected.count() === 0 ? null : type, ids: selected };
    this.#changed({
      selection: { type: this.#selection.type, ids: selected, previousType, previousIds },
    });
  }

  /**
   * The set of a selection: made by the layer the state is attached to (the features as their
   * rows), or a copy of the IDs before it is attached
   */
  #setOf(type: SelectionType | null, ids: readonly string[] | IdSet): IdSet {
    const document = this.#notification?.document;
    if (type === null) return document ? document.idSetOf('feature', []) : new OwnIdSet([]);
    if (document) return document.idSetOf(type, ids);
    return new OwnIdSet(Array.isArray(ids) ? ids : [...(ids as IdSet).iterate()]);
  }

  /** Tells a change to the notification of the Store, and keeps it for the subscribers */
  #changed(change: ClientChange): void {
    this.#notification?.merge(change);
    appendClientChange(this.#pending, change);
  }

  /** Tells the subscribers what the operation changed */
  #flush(): void {
    if (Object.keys(this.#pending).length === 0) return;
    // A new container for what a subscriber changes while it is told
    const change = this.#pending;
    this.#pending = {};
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch (error) {
        console.error('Error in a listener of the state of this client:', error);
      }
    }
  }

  /**
   * Ends the vertex selection when its feature is gone or its coordinates changed other than by
   * a local drag (a change from elsewhere, an edit through the API): the indices it holds would
   * name other vertices
   */
  #pruneVertices(changes: StoreChange, dragging: boolean): void {
    const vertices = this.#selectedVertices;
    const document = this.#notification?.document;
    if (!vertices || !document) return;
    const featureId = vertices.featureId;
    if (!document.getFeature(featureId)) {
      this.setSelectedVertices(null);
      return;
    }
    const local = changes.source !== 'remote';
    for (const entry of changes.features?.updated ?? []) {
      if (entry.id !== featureId) continue;
      // The frames and the commit of a local drag keep the vertices being dragged selected
      if (local && (entry.isIntermediate || dragging)) continue;
      if (sameCoordinates(coordinatesOf(entry.feature), coordinatesOf(entry.previous))) continue;
      this.setSelectedVertices(null);
      return;
    }
  }
}

/** Adds a change to the changes kept for the subscribers, as the notification of the Store does */
function appendClientChange(target: ClientChange, change: ClientChange): void {
  if (change.selection) target.selection = change.selection;
  if (change.editing) {
    const editing = target.editing ?? {};
    if (change.editing.started) {
      editing.started = [...(editing.started ?? []), ...change.editing.started];
    }
    if (change.editing.ended) editing.ended = [...(editing.ended ?? []), ...change.editing.ended];
    target.editing = editing;
  }
  if (change.mode) target.mode = change.mode;
  if (change.uiStateChanged) target.uiStateChanged = true;
}

/**
 * Whether a notification can hide something that was visible: a change of the visible flag
 * of a feature, or of its place (a feature moved into a hidden layer or group), a group or a
 * layer whose visible flag turned off, and a group moved to another layer. A change of only the
 * name or the order of a group or a layer hides nothing
 */
function mayHide(changes: StoreChange): boolean {
  for (const { layer, previous } of changes.layers?.updated ?? []) {
    if (previous.visible && !layer.visible) return true;
  }
  for (const { group, previous } of changes.groups?.updated ?? []) {
    if (previous.visible && !group.visible) return true;
    if (group.layerId !== previous.layerId) return true;
  }
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
  document: ClientDocument,
  hidden: ReadonlySet<string>,
): (type: SelectionType, id: string) => boolean {
  const layers = new Map<string, boolean>();
  const groups = new Map<string, boolean>();

  const layerShown = (id: string): boolean => {
    let shown = layers.get(id);
    if (shown === undefined) {
      const layer = document.getLayer(id);
      shown = layer?.visible === true && !hidden.has(id);
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
        !hidden.has(id) &&
        (layerId === undefined || layerShown(layerId));
      groups.set(id, shown);
    }
    return shown;
  };

  return (type, id) => {
    if (type === 'layer') return layerShown(id);
    if (type === 'group') return groupShown(id);
    const feature = document.getFeature(id);
    if (!feature?.visible || hidden.has(id)) return false;
    if (feature.groupId && !groupShown(feature.groupId)) return false;
    return layerShown(feature.layerId);
  };
}

/** The layer of a group: the one of its members, or the layer that lists an empty group */
function groupLayerId(document: ClientDocument, group: Group): string | undefined {
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

/** The most IDs `toArray` gives in one array */
const ARRAY_LIMIT = 10_000;

/**
 * A set of IDs the state holds before it is attached to a layer: a copy of them, in order, each
 * once (once attached, the layer makes the sets)
 */
class OwnIdSet implements IdSet {
  readonly #ids: readonly string[];
  #lookup: Set<string> | null = null;

  constructor(ids: readonly string[]) {
    this.#ids = [...new Set(ids)];
  }

  count(): number {
    return this.#ids.length;
  }

  has(id: string): boolean {
    this.#lookup ??= new Set(this.#ids);
    return this.#lookup.has(id);
  }

  iterate(): IterableIterator<string> {
    return this.#ids[Symbol.iterator]();
  }

  toArray(): string[] {
    if (this.#ids.length > ARRAY_LIMIT) {
      throw new DrawError(
        'tooManyItems',
        `The set holds ${this.#ids.length} IDs, more than ${ARRAY_LIMIT} for one array; read them with iterate`,
      );
    }
    return [...this.#ids];
  }
}
