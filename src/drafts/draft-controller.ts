// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The drafts of an instance (`DraftController`): the edits shown over the document before they
 * are written (`draw.drafts`)
 *
 * A draft holds edits (`DraftEdit`). What it shows is the features it edits as its edits leave
 * them over their values of now, worked out again whenever the Store writes one of them: at the
 * end of each frame of writes (each notification of the Store), from the write marks of the rows
 * of a Store of rows (`write-marks.ts`) and from the features a Store of objects tells written. A
 * draft is never carried over what was written: it is applied again over it.
 *
 * A draft of this client (`owner` null) edits only what it can write. A feature of it deleted,
 * locked, hidden or put into a layer that cannot be written is left out (counted as dropped), a
 * vertex it edits that is no longer there likewise, and the draft ends once nothing of it is left.
 * The drafts with an owner pass no gate and cannot be committed; they are drawn under the
 * drafts of this client, in the order they came. A commit makes the edits of a draft the edits of
 * the Store (`applyEdits`) and its features to create the features of the Store, in one
 * transaction.
 *
 * Every draft ends in one place (`#end`), and what an operation changed is drawn and told once it
 * is done: the features shown are worked out again, then the events go out, in their order.
 */

import type { Draft, DraftEdit, DraftEndReason, DraftInput, DraftPatch } from '../api/drafts.js';
import type { DrawEvents } from '../api/events.js';
import type { FeatureInput } from '../api/model.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { writeMarkKeeperOf } from '../feature-table/write-marks.js';
import { DrawError } from '../shared/draw-error.js';
import { coordinatesOf } from '../shared/utils/coordinates.js';
import { isVertexOf } from '../shared/utils/vertex-edits.js';
import { DEFAULT_TRANSFORMS, updatesOfEdits } from '../store/feature-edits.js';
import { itemNeighbors } from '../store/item-lists.js';
import { isLocallyHidden } from '../store/local-visibility.js';
import { isFeatureLocked } from '../store/lock.js';
import type { FeatureEdit, GeometryTransforms, Store, VertexTarget } from '../store/store.js';
import type { Feature, StoreChange, VertexRef } from '../store/types.js';
import { isWritableLayer } from '../store/writable-layer.js';
import {
  type CreateEdit,
  checkDraftEdits,
  featureEditsOf,
  featureIdsOfEdit,
  isSelectionEdit,
  mapVertices,
  vertexFeatureIds,
  vertexShapeOf,
  verticesOf,
  withoutFeatures,
  withoutVertices,
} from './draft-edits.js';
import { DraftView, type DrawnCreate } from './draft-view.js';

/** The keys of the input of a draft */
const INPUT_KEYS: readonly string[] = ['id', 'edits', 'owner'];

/** The keys of a patch of a draft */
const PATCH_KEYS: readonly string[] = ['edits'];

/** The order the reasons a feature is left out are told in, when several leave a draft empty */
const DROP_REASONS: readonly DraftEndReason[] = ['deleted', 'locked', 'layer-unavailable'];

/**
 * The events of the drafts
 *
 * @internal
 */
export type DraftEventName = 'draft.added' | 'draft.updated' | 'draft.removed';

/**
 * What the drafts read and are told of the instance
 *
 * @internal
 */
export interface DraftControllerDeps {
  /** The Store of the instance */
  readonly store: Store;
  /** Makes an ID: of a draft given none, and of a feature created with none */
  readonly generateId: () => string;
  /** The layer a feature created goes into when its input names neither layer nor group */
  readonly getActiveLayerId: () => string;
  /**
   * Checks the input of a feature created and makes the feature as `features.create` stores it
   *
   * @param id The ID it gets when its input has none
   * @param layerId The layer it goes into when its input names neither layer nor group
   * @throws DrawError as `features.create` does for a wrong input
   */
  readonly prepareFeature: (input: FeatureInput, id: string, layerId: string) => Feature;
}

/**
 * Compares what a draft drew with what its commit wrote (the checks of the state): the problems
 * found, given to the check
 *
 * @internal
 */
export type DraftCommitCheck = (problems: string[]) => void;

/** A draft and what is kept with it */
interface Entry {
  draft: Draft;
  /** The order it was added in */
  readonly seq: number;
  /** The edits of it left out so far */
  dropped: number;
  /**
   * The shape of the vertices of each feature its vertex edits name, as they were given (a Store
   * that gives its vertices no IDs takes them by their places while it stays the same)
   */
  shapes: Map<string, string>;
  /** The layer of each feature it creates whose input names neither layer nor group, by edit */
  createLayers: Map<number, string>;
}

/** A draft checked, before it is added or changed */
interface Prepared {
  readonly edits: readonly DraftEdit[];
  readonly shapes: Map<string, string>;
  readonly createLayers: Map<number, string>;
  /** The features it edits (the ones selected now for `{ selection: true }`) */
  readonly touched: readonly string[];
}

/**
 * The drafts of an instance
 *
 * @internal
 */
export class DraftController {
  readonly #deps: DraftControllerDeps;
  readonly #store: Store;
  /** What the drafts draw */
  readonly view: DraftView;
  /** The drafts, in the order they were added */
  readonly #entries = new Map<string, Entry>();
  #seq = 0;
  /** The features drafts edit, as the drafts leave them, by ID */
  #applied = new Map<string, Feature>();
  /** The feature of the Store each feature of `#applied` was worked out over */
  #basis = new Map<string, Feature>();
  /** The write mark of the row of each feature of `#applied` when it was worked out (rows) */
  #marks = new Map<string, number>();
  /** The write mark of the Store read last (rows) */
  #seenMark = -1;
  #readOnly: boolean;
  /** The IDs hidden on this client, as read last (joined) */
  #hidden = '';
  /** The depth of the operations under way, and whether the features shown are to be made again */
  #depth = 0;
  #dirty = false;
  /** The events of the operation under way, told once it is done */
  #events: Array<[DraftEventName, DrawEvents[DraftEventName]]> = [];
  #listener: (<K extends DraftEventName>(event: K, payload: DrawEvents[K]) => void) | null = null;
  #unsubscribe: (() => void) | null = null;
  #commitCheck: DraftCommitCheck | null = null;
  #afterOperate: (() => void) | null = null;

  constructor(deps: DraftControllerDeps) {
    this.#deps = deps;
    this.#store = deps.store;
    this.view = new DraftView(deps.store);
    this.#readOnly = deps.store.isReadOnly();
  }

  /** Follows the writes of the Store: the drafts are applied again at the end of each frame */
  attach(): void {
    if (this.#unsubscribe) return;
    this.#readOnly = this.#store.isReadOnly();
    this.#hidden = this.#hiddenNow();
    this.#unsubscribe = this.#store.subscribe((changes) => this.#onStoreChange(changes));
  }

  /** Stops following the Store */
  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /** Sets what the events of the drafts are told to (null: nothing) */
  setListener(
    listener: (<K extends DraftEventName>(event: K, payload: DrawEvents[K]) => void) | null,
  ): void {
    this.#listener = listener;
  }

  /** Sets what compares the drafts drawn with what their commits write (null: nothing) */
  setCommitCheck(check: DraftCommitCheck | null): void {
    this.#commitCheck = check;
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  get(id: string): Draft | undefined {
    return this.#entries.get(id)?.draft;
  }

  /** The drafts in the order they are drawn: the ones with an owner first */
  list(): Draft[] {
    return this.#ordered().map((entry) => entry.draft);
  }

  count(): number {
    return this.#entries.size;
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  /** A feature of the Store as the drafts edit it (the feature itself when none does) */
  appliedFeature(id: string): Feature | undefined {
    return this.#applied.get(id) ?? this.#store.getFeature(id);
  }

  /**
   * The features drafts edit that are shown, as the drafts leave them: what is drawn in their
   * places (the checks compare what is drawn with it)
   */
  expectedDrawn(): Map<string, Feature> {
    const out = new Map<string, Feature>();
    for (const [id, feature] of this.#applied) {
      const own = this.#store.getFeature(id);
      if (own && this.#shown(own)) out.set(id, feature);
    }
    return out;
  }

  /** Sets what is called once each operation of the drafts is done (null: nothing) */
  setAfterOperate(fn: (() => void) | null): void {
    this.#afterOperate = fn;
  }

  // ==========================================================================
  // Writes
  // ==========================================================================

  add(input: DraftInput): Draft | null {
    return this.#operate(() => this.#addAll([input], 'add')?.[0] ?? null);
  }

  addMany(inputs: readonly DraftInput[]): Draft[] | null {
    if (!Array.isArray(inputs)) throw invalidInput('The inputs must be an array');
    return this.#operate(() => this.#addAll(inputs, 'addMany'));
  }

  update(id: string, patch: DraftPatch): Draft | null {
    return this.#operate(() => this.#updateAll([{ id, patch }])?.[0] ?? null);
  }

  updateMany(patches: readonly { id: string; patch: DraftPatch }[]): Draft[] | null {
    if (!Array.isArray(patches)) throw invalidInput('The patches must be an array');
    return this.#operate(() => this.#updateAll(patches));
  }

  remove(id: string): boolean {
    return this.removeMany([id]);
  }

  removeMany(ids: readonly string[]): boolean {
    const entries = this.#requireAll(ids);
    return this.#operate(() => {
      for (const entry of entries) {
        this.#end(entry.draft.id, entry.draft.owner === null ? 'cancelled' : 'withdrawn');
      }
      return true;
    });
  }

  /**
   * Ends a draft for a reason (the input of a mode ends its draft so: `deselected`), without
   * writing it
   *
   * @throws DrawError `not-found` when there is no draft with this ID
   */
  end(id: string, reason: Exclude<DraftEndReason, 'committed'>): void {
    this.#requireAll([id]);
    this.#operate(() => this.#end(id, reason));
  }

  commit(id: string): boolean {
    return this.commitMany([id]);
  }

  commitMany(ids: readonly string[]): boolean {
    const entries = this.#requireAll(ids);
    return this.#operate(() => {
      if (entries.some((entry) => entry.draft.owner !== null)) return false;
      if (this.#store.isReadOnly()) return false;
      return this.#commitEntries(entries);
    });
  }

  // ==========================================================================
  // Adding and changing
  // ==========================================================================

  /** Adds drafts, all of them or none (null when one of this client is refused) */
  #addAll(inputs: readonly DraftInput[], what: string): Draft[] | null {
    const taken = new Set<string>();
    const checked = inputs.map((input) => {
      if (!isRecord(input)) throw invalidInput('The input must be an object');
      onlyKeys(input, INPUT_KEYS, 'The input');
      let id: string;
      if (input.id === undefined) id = this.#deps.generateId();
      else {
        id = requireId(input.id);
        if (this.#entries.has(id) || taken.has(id)) {
          throw new DrawError('already-exists', `The ID ${JSON.stringify(id)} is already taken`, {
            id,
          });
        }
      }
      taken.add(id);
      const owner = input.owner === undefined || input.owner === null ? null : input.owner;
      if (owner !== null) requireId(owner, 'The owner');
      return { id, owner, prepared: this.#prepare(id, input.edits) };
    });
    // Two drafts of this client of a feature, given at once
    const touchedBy = new Map<string, string>();
    for (const { id, owner, prepared } of checked) {
      if (owner !== null) continue;
      for (const featureId of prepared.touched) {
        if (touchedBy.has(featureId)) {
          throw invalidInput(
            `The drafts ${touchedBy.get(featureId)} and ${id} of ${what} both edit the feature ${featureId}`,
          );
        }
        touchedBy.set(featureId, id);
      }
    }
    if (checked.some(({ owner, prepared }) => owner === null && !this.#allowed(prepared))) {
      return null;
    }
    // A second draft of this client of a feature commits the first one
    const before = this.#ownTouching(
      checked.filter(({ owner }) => owner === null).flatMap(({ prepared }) => prepared.touched),
      new Set(),
    );
    if (before.length > 0) {
      if (!this.#store.isReadOnly()) this.#commitEntries(before);
      if (checked.some(({ owner, prepared }) => owner === null && !this.#allowed(prepared))) {
        return null;
      }
    }
    const drafts: Draft[] = [];
    for (const { id, owner, prepared } of checked) {
      const entry: Entry = {
        draft: draftOf(id, prepared.edits, owner),
        seq: this.#seq++,
        dropped: 0,
        shapes: prepared.shapes,
        createLayers: prepared.createLayers,
      };
      this.#entries.set(id, entry);
      drafts.push(entry.draft);
      this.#queue('draft.added', { draft: entry.draft });
    }
    this.#dirty = true;
    return drafts;
  }

  /** Changes drafts, all of them or none (null when one of this client is refused) */
  #updateAll(patches: readonly { id: string; patch: DraftPatch }[]): Draft[] | null {
    const seen = new Set<string>();
    const checked = patches.map((entry) => {
      if (!isRecord(entry)) throw invalidInput('Each entry must be an object');
      const id = requireId((entry as { id: unknown }).id);
      const found = this.#entries.get(id);
      if (!found) throw notFound(id);
      if (seen.has(id)) throw invalidInput(`The ID ${id} is given twice`);
      seen.add(id);
      const patch = entry.patch as unknown;
      if (!isRecord(patch)) throw invalidInput('The patch must be an object');
      onlyKeys(patch, PATCH_KEYS, 'The patch');
      const edits = patch.edits === undefined ? found.draft.edits : patch.edits;
      return { entry: found, prepared: this.#prepare(id, edits) };
    });
    const own = checked.filter(({ entry }) => entry.draft.owner === null);
    if (own.some(({ prepared }) => !this.#allowed(prepared))) return null;
    const changing = new Set(checked.map(({ entry }) => entry.draft.id));
    const before = this.#ownTouching(
      own.flatMap(({ prepared }) => prepared.touched),
      changing,
    );
    if (before.length > 0) {
      if (!this.#store.isReadOnly()) this.#commitEntries(before);
      if (own.some(({ prepared }) => !this.#allowed(prepared))) return null;
    }
    const drafts: Draft[] = [];
    for (const { entry, prepared } of checked) {
      entry.draft = draftOf(entry.draft.id, prepared.edits, entry.draft.owner);
      entry.shapes = prepared.shapes;
      entry.createLayers = prepared.createLayers;
      drafts.push(entry.draft);
      this.#queue('draft.updated', { draft: entry.draft, dropped: 0 });
    }
    this.#dirty = true;
    return drafts;
  }

  /**
   * Checks the edits of a draft and what it is kept with: the features and the vertices they
   * name are there and take the edits (each edit applied over the features as they are now)
   *
   * @throws DrawError `invalid-input` for edits that cannot apply, `not-found` for a feature, a
   *   layer or a group that is not there
   */
  #prepare(id: string, given: unknown): Prepared {
    const store = this.#store;
    const transforms = this.#transforms();
    checkDraftEdits(given, store.getVertexIds !== undefined, transforms);
    let edits: readonly DraftEdit[] = given;
    const createLayers = new Map<number, string>();
    edits.forEach((edit, i) => {
      if (edit.kind !== 'create') {
        for (const featureId of featureIdsOfEdit(edit, () => [])) {
          if (!store.getFeature(featureId)) throw notFound(featureId, 'feature');
        }
        return;
      }
      const input = edit.feature;
      const layerId =
        input.layerId === undefined && input.groupId === undefined
          ? this.#deps.getActiveLayerId()
          : undefined;
      if (layerId !== undefined) createLayers.set(i, layerId);
      // The input is checked as it is created
      this.#deps.prepareFeature(input, createKey(id, i), layerId ?? '');
    });
    // The vertices of a Store that gives its vertices IDs are kept by their IDs
    const getVertexIds = store.getVertexIds;
    const findVertices = store.findVertices;
    if (getVertexIds && findVertices) {
      for (const featureId of vertexFeatureIds(edits)) {
        const targets = verticesOf(edits, featureId);
        const places = targets.filter((target): target is VertexRef => typeof target !== 'string');
        const feature = store.getFeature(featureId) as Feature;
        for (const place of places) {
          if (!isVertexOf(feature.geometry.type, coordinatesOf(feature), place)) {
            throw invalidInput(`The feature ${featureId} has no vertex ${JSON.stringify(place)}`, {
              id: featureId,
              vertex: place,
            });
          }
        }
        const ids = places.length > 0 ? getVertexIds(featureId, places) : [];
        const idOf = new Map<VertexTarget, VertexTarget>();
        places.forEach((place, i) => {
          idOf.set(place, ids[i]);
        });
        edits = mapVertices(edits, featureId, (vertex) => idOf.get(vertex) ?? vertex);
        const named = verticesOf(edits, featureId) as string[];
        const found = findVertices(featureId, named);
        named.forEach((vertex, i) => {
          if (found[i] == null) {
            throw invalidInput(`The feature ${featureId} has no vertex ${JSON.stringify(vertex)}`, {
              id: featureId,
              vertex,
            });
          }
        });
      }
    }
    // Each edit is applied over the features as they are now: one that cannot apply throws
    updatesOfEdits(
      featureEditsOf(edits, () => this.#selected(), this.#vertexFinder()),
      (featureId) => store.getFeature(featureId),
      transforms,
    );
    const shapes = new Map<string, string>();
    if (!findVertices) {
      for (const featureId of vertexFeatureIds(edits)) {
        const feature = store.getFeature(featureId);
        if (feature) shapes.set(featureId, vertexShapeOf(feature.geometry));
      }
    }
    const touched = new Set<string>();
    for (const edit of edits) {
      for (const featureId of featureIdsOfEdit(edit, () => this.#selected()))
        touched.add(featureId);
    }
    return { edits, shapes, createLayers, touched: [...touched] };
  }

  /**
   * Whether a draft of this client may be added or changed so: the document is not read-only, the
   * features it edits can be written, there are features selected for `{ selection: true }`, and
   * the layers it creates features in can be written
   */
  #allowed(prepared: Prepared): boolean {
    const store = this.#store;
    if (store.isReadOnly()) return false;
    for (const featureId of prepared.touched) {
      const feature = store.getFeature(featureId);
      if (!feature || this.#unavailable(feature) !== null) return false;
    }
    for (const edit of prepared.edits) {
      if (isSelectionEdit(edit) && this.#selected().length === 0) return false;
    }
    let ok = true;
    prepared.edits.forEach((edit, i) => {
      if (edit.kind === 'create' && !this.#createWritable(edit, prepared.createLayers.get(i))) {
        ok = false;
      }
    });
    return ok;
  }

  /** The drafts of this client that edit any of the features, other than the ones given */
  #ownTouching(featureIds: readonly string[], except: ReadonlySet<string>): Entry[] {
    if (featureIds.length === 0) return [];
    const ids = new Set(featureIds);
    const out: Entry[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.draft.owner !== null || except.has(entry.draft.id)) continue;
      if (this.#touchedBy(entry).some((featureId) => ids.has(featureId))) out.push(entry);
    }
    return out;
  }

  // ==========================================================================
  // Committing
  // ==========================================================================

  /**
   * Writes drafts of this client in one transaction: the features they create created in their
   * places, and their edits given to the Store (`applyEdits`, once for each draft). A draft that
   * creates a feature in a layer that cannot be written ends (`layer-unavailable`) and nothing is
   * written then
   */
  #commitEntries(entries: readonly Entry[]): boolean {
    const store = this.#store;
    const unavailable = entries.filter((entry) =>
      entry.draft.edits.some(
        (edit, i) =>
          edit.kind === 'create' && !this.#createWritable(edit, entry.createLayers.get(i)),
      ),
    );
    if (unavailable.length > 0) {
      for (const entry of unavailable) this.#end(entry.draft.id, 'layer-unavailable');
      return false;
    }
    const writes = entries.map((entry) => {
      const creates: Array<{ feature: Feature; below: string | null; key: string }> = [];
      entry.draft.edits.forEach((edit, i) => {
        if (edit.kind !== 'create') return;
        const layerId = entry.createLayers.get(i) ?? '';
        const feature = this.#deps.prepareFeature(
          edit.feature,
          edit.feature.id ?? this.#deps.generateId(),
          layerId,
        );
        creates.push({ feature, below: edit.below, key: createKey(entry.draft.id, i) });
      });
      // A Store that gives its vertices IDs takes them by their IDs
      const edits = featureEditsOf(entry.draft.edits, () => this.#selected());
      return { entry, creates, edits };
    });
    const drawn = this.#commitCheck ? this.#drawnBefore(writes) : null;
    // What the drafts drew goes with them, before the Store is written
    for (const { entry } of writes) this.#entries.delete(entry.draft.id);
    this.#refresh();
    const results: Array<number | null> = [];
    store.transact(() => {
      for (const { creates, edits } of writes) {
        for (const create of creates) {
          store.createFeature(create.feature);
          this.#place(create.feature, create.below);
        }
        results.push(edits.length > 0 ? (store.applyEdits(edits)?.dropped ?? null) : 0);
      }
    });
    writes.forEach(({ entry }, i) => {
      const dropped = results[i];
      entry.dropped += dropped ?? 0;
      this.#queue('draft.removed', {
        draft: entry.draft,
        reason: dropped === null ? 'read-only' : 'committed',
        dropped: entry.dropped,
      });
    });
    if (drawn) this.#compareCommitted(drawn);
    return results.every((dropped) => dropped !== null);
  }

  /** Puts a feature just created just above an item of its layer or group (at the back for null) */
  #place(feature: Feature, below: string | null): void {
    const store = this.#store;
    const { layerId, groupId } = feature;
    const now = itemNeighbors(store, layerId, groupId, feature.id);
    if (!now || now.below === below) return;
    if (below !== null && !itemNeighbors(store, layerId, groupId, below)) return;
    store.moveItem(feature.id, { layerId, ...(groupId === undefined ? {} : { groupId }), below });
  }

  /** Whether the layer (and the group) a feature is created in can be written */
  #createWritable(edit: CreateEdit, layerId: string | undefined): boolean {
    const store = this.#store;
    const input = edit.feature;
    const group = input.groupId === undefined ? undefined : store.getGroup(input.groupId);
    if (input.groupId !== undefined && (!group || group.locked)) return false;
    const layer = store.getLayer(input.layerId ?? group?.layerId ?? layerId ?? '');
    return isWritableLayer(layer, store);
  }

  // ==========================================================================
  // Ending
  // ==========================================================================

  /** Ends a draft: the one place a draft ends, its end told once the operation is done */
  #end(id: string, reason: DraftEndReason): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    this.#entries.delete(id);
    this.#dirty = true;
    this.#queue('draft.removed', { draft: entry.draft, reason, dropped: entry.dropped });
  }

  // ==========================================================================
  // Applying again
  // ==========================================================================

  /**
   * Applies the drafts again at the end of a frame of writes of the Store: over the features it
   * wrote, the ones it deleted, locked, hid or put into a layer that cannot be written left out,
   * and over the vertices as they are now
   */
  #onStoreChange(changes: StoreChange): void {
    this.#operate(() => {
      if (this.#entries.size === 0) {
        this.#seenMark = this.#storeMark();
        return;
      }
      if (changes.reset === true) {
        for (const entry of [...this.#entries.values()]) {
          this.#end(entry.draft.id, 'document-replaced');
        }
        return;
      }
      const store = this.#store;
      const readOnly = store.isReadOnly();
      if (readOnly && !this.#readOnly) {
        for (const entry of [...this.#entries.values()]) {
          if (entry.draft.owner === null) this.#end(entry.draft.id, 'read-only');
        }
      }
      this.#readOnly = readOnly;
      const hidden = changes.uiStateChanged === true ? this.#hiddenNow() : this.#hidden;
      const all =
        changes.layers !== undefined || changes.groups !== undefined || hidden !== this.#hidden;
      this.#hidden = hidden;
      const written = all ? null : this.#writtenIds(changes);
      const selection = changes.selection !== undefined || all;
      for (const entry of [...this.#entries.values()]) {
        const touched = this.#touchedBy(entry);
        const named = written === null ? touched : touched.filter((id) => written.has(id));
        const selects = selection && entry.draft.edits.some(isSelectionEdit);
        if (named.length > 0 || selects) this.#applyAgain(entry, named);
      }
      if (
        written === null ||
        [...written].some((id) => this.#applied.has(id)) ||
        selection ||
        (this.#hasCreates() && hasDocumentChange(changes))
      ) {
        this.#dirty = true;
      }
    });
  }

  /** The features a frame of writes wrote: told by the Store, or by the marks of their rows */
  #writtenIds(changes: StoreChange): Set<string> {
    const out = new Set<string>();
    const features = changes.features;
    for (const feature of features?.created ?? []) out.add(feature.id);
    for (const { id } of features?.updated ?? []) out.add(id);
    for (const feature of features?.deleted ?? []) out.add(feature.id);
    const mark = this.#storeMark();
    if (mark !== this.#seenMark) {
      this.#seenMark = mark;
      for (const [id, seen] of this.#marks) {
        const now = this.#rowMark(id);
        if (now === undefined || now > seen) out.add(id);
      }
    }
    return out;
  }

  /**
   * Applies a draft again over the features named written: the ones gone or that cannot be written
   * left out (the draft ends once nothing of it is left), and its vertices found again
   */
  #applyAgain(entry: Entry, named: readonly string[]): void {
    const store = this.#store;
    const own = entry.draft.owner === null;
    const gone = new Map<string, DraftEndReason>();
    for (const id of named) {
      const feature = store.getFeature(id);
      const reason = !feature ? 'deleted' : own ? this.#unavailable(feature) : null;
      if (reason) gone.set(id, reason);
    }
    let edits: readonly DraftEdit[] = entry.draft.edits;
    let dropped = 0;
    if (gone.size > 0) {
      const left = withoutFeatures(edits, new Set(gone.keys()));
      edits = left.edits;
      dropped += left.dropped;
    }
    // The vertices of the features written
    const findVertices = store.findVertices;
    let verticesDropped = 0;
    const names = new Set(named);
    for (const featureId of vertexFeatureIds(edits)) {
      if (!names.has(featureId)) continue;
      const feature = store.getFeature(featureId);
      if (!feature) continue;
      if (findVertices) {
        const ids = verticesOf(edits, featureId) as string[];
        const found = findVertices(featureId, ids);
        const missing = new Set(ids.filter((_, i) => found[i] == null));
        if (missing.size === 0) continue;
        const left = withoutVertices(edits, featureId, (vertex) => !missing.has(vertex as string));
        edits = left.edits;
        verticesDropped += left.dropped;
        continue;
      }
      if (entry.shapes.get(featureId) !== vertexShapeOf(feature.geometry)) {
        this.#end(entry.draft.id, 'vertices-removed');
        return;
      }
    }
    dropped += verticesDropped;
    const hadVertices = vertexFeatureIds(entry.draft.edits).size > 0;
    if (verticesDropped > 0 && hadVertices && vertexFeatureIds(edits).size === 0) {
      entry.dropped += dropped;
      this.#end(entry.draft.id, 'vertices-removed');
      return;
    }
    if (edits.length === 0 && entry.draft.edits.length > 0) {
      entry.dropped += dropped;
      const reasons = new Set(gone.values());
      this.#end(
        entry.draft.id,
        DROP_REASONS.find((reason) => reasons.has(reason)) ?? 'vertices-removed',
      );
      return;
    }
    // A draft of the features selected ends once none is
    if (edits.length > 0 && edits.every(isSelectionEdit) && this.#selected().length === 0) {
      entry.dropped += dropped;
      this.#end(entry.draft.id, 'deselected');
      return;
    }
    if (dropped === 0) return;
    entry.dropped += dropped;
    entry.draft = draftOf(entry.draft.id, edits, entry.draft.owner);
    this.#dirty = true;
    this.#queue('draft.updated', { draft: entry.draft, dropped });
  }

  // ==========================================================================
  // What the drafts show
  // ==========================================================================

  /**
   * Works out again the features the drafts edit as they leave them, and what the drafts draw: the
   * drafts applied one after the other in the order they are drawn, over the features as they are
   * now
   */
  #refresh(): void {
    this.#dirty = false;
    const store = this.#store;
    const transforms = this.#transforms();
    const findVertex = this.#vertexFinder();
    const applied = new Map<string, Feature>();
    const basis = new Map<string, Feature>();
    const live = (id: string): Feature | undefined => {
      const feature = applied.get(id);
      if (feature) return feature;
      const own = store.getFeature(id);
      if (own) basis.set(id, own);
      return own;
    };
    const ordered = this.#ordered();
    for (const entry of ordered) {
      for (const id of this.#touchedBy(entry)) {
        const feature = live(id);
        if (feature) applied.set(id, feature);
      }
      let updates: ReturnType<typeof updatesOfEdits>['updates'];
      try {
        updates = updatesOfEdits(
          featureEditsOf(entry.draft.edits, () => this.#selected(), findVertex),
          live,
          transforms,
        ).updates;
      } catch {
        // A draft whose edits no longer apply over the features as they are (the drafts of other
        // clients pass no check) draws them as they are
        continue;
      }
      for (const { id, updates: fields } of updates) {
        const feature = applied.get(id) ?? live(id);
        if (feature) applied.set(id, { ...feature, ...fields } as Feature);
      }
    }
    this.#applied = applied;
    this.#basis = basis;
    this.#marks = new Map();
    if (store.tables) {
      for (const id of applied.keys()) {
        const mark = this.#rowMark(id);
        if (mark !== undefined) this.#marks.set(id, mark);
      }
      this.#seenMark = this.#storeMark();
    }
    const drawn = new Map<string, Feature>();
    for (const [id, feature] of applied) {
      const own = store.getFeature(id);
      if (own && this.#shown(own)) drawn.set(id, feature);
    }
    this.view.set(drawn, this.#drawnCreates());
  }

  /** The features the drafts create, as they are drawn (the ones whose layer is not shown left out) */
  #drawnCreates(): DrawnCreate[] {
    const out: DrawnCreate[] = [];
    for (const entry of this.#ordered()) {
      entry.draft.edits.forEach((edit, i) => {
        if (edit.kind !== 'create') return;
        const key = createKey(entry.draft.id, i);
        let feature: Feature;
        try {
          feature = this.#deps.prepareFeature(edit.feature, key, entry.createLayers.get(i) ?? '');
        } catch {
          // Its layer or its group is no longer there
          return;
        }
        feature = { ...feature, id: key };
        if (!this.#shown(feature)) return;
        out.push({
          key,
          feature,
          placement: {
            layerId: feature.layerId,
            ...(feature.groupId === undefined ? {} : { groupId: feature.groupId }),
            below: edit.below,
          },
        });
      });
    }
    return out;
  }

  /** Whether the drafts have features to create */
  #hasCreates(): boolean {
    for (const entry of this.#entries.values()) {
      if (entry.draft.edits.some((edit) => edit.kind === 'create')) return true;
    }
    return false;
  }

  // ==========================================================================
  // The checks of the state
  // ==========================================================================

  /** What the drafts drew of the features their commits write, before they are written */
  #drawnBefore(
    writes: ReadonlyArray<{
      entry: Entry;
      creates: ReadonlyArray<{ feature: Feature; key: string }>;
      edits: readonly FeatureEdit[];
    }>,
  ): Array<{ id: string; drawn: unknown }> | null {
    const store = this.#store;
    // A write the drafts were not applied again over yet is not compared
    if (!this.#fresh()) return null;
    const others = new Set<string>();
    for (const entry of this.#entries.values()) {
      if (entry.draft.owner !== null) for (const id of this.#touchedBy(entry)) others.add(id);
    }
    const tables = featureTablesInternals(store.tables);
    const drawnOf = (id: string): unknown =>
      tables ? tables.draftGeometryOf(id) : this.view.drawnFeature(id)?.geometry;
    const out: Array<{ id: string; drawn: unknown }> = [];
    for (const { entry, creates } of writes) {
      for (const id of this.#touchedBy(entry)) {
        if (others.has(id) || !this.view.liveFeatures().has(id)) continue;
        out.push({ id, drawn: drawnOf(id) });
      }
      for (const { feature, key } of creates) {
        if (this.view.drawnFeature(key)) out.push({ id: feature.id, drawn: drawnOf(key) });
      }
    }
    return out;
  }

  /** Compares what the drafts drew with what their commits wrote (`DraftCommitCheck`) */
  #compareCommitted(drawn: ReadonlyArray<{ id: string; drawn: unknown }>): void {
    const tables = featureTablesInternals(this.#store.tables);
    const problems: string[] = [];
    for (const { id, drawn: before } of drawn) {
      const written = tables ? tables.rowGeometryOf(id) : this.#store.getFeature(id)?.geometry;
      if (!sameBits(before, written)) {
        problems.push(
          `the feature "${id}" was drawn as ${JSON.stringify(before)} before its draft was committed, and is written as ${JSON.stringify(written)}`,
        );
      }
    }
    this.#commitCheck?.(problems);
  }

  /** Whether the features shown were worked out over the features as the Store has them now */
  #fresh(): boolean {
    const store = this.#store;
    if (store.tables) {
      for (const [id, mark] of this.#marks) if (this.#rowMark(id) !== mark) return false;
      return true;
    }
    for (const [id, feature] of this.#basis) if (store.getFeature(id) !== feature) return false;
    return true;
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Runs an operation: what it changed is drawn, and the events it made go out, once the
   * outermost one is done
   */
  #operate<T>(fn: () => T): T {
    this.#depth++;
    let result: T;
    try {
      result = fn();
    } finally {
      this.#depth--;
    }
    if (this.#depth === 0) {
      try {
        if (this.#dirty) this.#refresh();
      } finally {
        const events = this.#events.splice(0);
        for (const [event, payload] of events) this.#listener?.(event, payload as never);
      }
      this.#afterOperate?.();
    }
    return result;
  }

  #queue<K extends DraftEventName>(event: K, payload: DrawEvents[K]): void {
    this.#events.push([event, payload]);
  }

  /** The drafts in the order they are drawn: the ones with an owner first, each in its order */
  #ordered(): Entry[] {
    const entries = [...this.#entries.values()];
    return [
      ...entries.filter((entry) => entry.draft.owner !== null),
      ...entries.filter((entry) => entry.draft.owner === null),
    ];
  }

  /** The features a draft edits (the ones selected now for `{ selection: true }`) */
  #touchedBy(entry: Entry): string[] {
    const out = new Set<string>();
    for (const edit of entry.draft.edits) {
      for (const id of featureIdsOfEdit(edit, () => this.#selected())) out.add(id);
    }
    return [...out];
  }

  /**
   * The features `{ selection: true }` edits: the features selected, without the locked ones
   * (which an edit of the features selected leaves out)
   */
  #selected(): readonly string[] {
    const store = this.#store;
    return store.selectedFeatureIds().filter((id) => {
      const feature = store.getFeature(id);
      return feature !== undefined && !isFeatureLocked(feature, store);
    });
  }

  /**
   * Why a feature cannot take a draft of this client: locked (itself, its group or its layer),
   * hidden or in a layer that cannot be written (`layer-unavailable`); null when it can
   */
  #unavailable(feature: Feature): DraftEndReason | null {
    const store = this.#store;
    if (isFeatureLocked(feature, store)) return 'locked';
    if (!this.#shown(feature)) return 'layer-unavailable';
    if (!isWritableLayer(store.getLayer(feature.layerId), store)) return 'layer-unavailable';
    return null;
  }

  /** Whether a feature is shown: its own flag, its group, its layer and the local hiding */
  #shown(feature: Feature): boolean {
    const store = this.#store;
    if (!feature.visible) return false;
    if (feature.groupId !== undefined && store.getGroup(feature.groupId)?.visible === false) {
      return false;
    }
    const layer = store.getLayer(feature.layerId);
    if (!layer?.visible) return false;
    return !isLocallyHidden(feature, store);
  }

  /** Finds the vertices of a Store that gives its vertices IDs (undefined for one that gives none) */
  #vertexFinder():
    | ((featureId: string, vertices: readonly VertexTarget[]) => (VertexRef | null)[])
    | undefined {
    const findVertices = this.#store.findVertices;
    if (!findVertices) return undefined;
    return (featureId, vertices) => {
      const ids = vertices.filter((vertex): vertex is string => typeof vertex === 'string');
      const found = findVertices(featureId, ids);
      let at = 0;
      return vertices.map((vertex) =>
        typeof vertex === 'string' ? (found[at++] ?? null) : vertex,
      );
    };
  }

  #transforms(): GeometryTransforms {
    return this.#store.transforms ?? DEFAULT_TRANSFORMS;
  }

  /** The write mark of the Store of rows (-1 for a Store of objects) */
  #storeMark(): number {
    return writeMarkKeeperOf(this.#store.tables)?.mark ?? -1;
  }

  /** The write mark of the row of a feature (undefined when it has none) */
  #rowMark(id: string): number | undefined {
    const tables = this.#store.tables;
    const internals = featureTablesInternals(tables);
    const handle = tables?.findRow(id);
    if (!internals || handle === undefined) return undefined;
    const place = internals.placeOf(handle);
    return place ? place.group.marks[place.row] : undefined;
  }

  /** The IDs hidden on this client, joined */
  #hiddenNow(): string {
    return [...this.#store.listHidden()].sort().join('\u0000');
  }

  /** The drafts of the IDs, each there (all or none) */
  #requireAll(ids: readonly string[]): Entry[] {
    if (!Array.isArray(ids)) throw invalidInput('The IDs must be an array');
    const out: Entry[] = [];
    for (const id of new Set(ids)) {
      const entry = typeof id === 'string' ? this.#entries.get(id) : undefined;
      if (!entry) throw notFound(id);
      out.push(entry);
    }
    return out;
  }
}

/** A draft, frozen */
function draftOf(id: string, edits: readonly DraftEdit[], owner: string | null): Draft {
  return Object.freeze({ id, edits: Object.freeze([...edits]), owner });
}

/** The ID a feature a draft creates is drawn with: an ID of no feature of the document */
function createKey(draftId: string, index: number): string {
  return `\u0000draft\u0000${draftId}\u0000${index}`;
}

/** Whether a change of the Store changed the document */
function hasDocumentChange(changes: StoreChange): boolean {
  return (
    changes.features !== undefined ||
    changes.rows !== undefined ||
    changes.order !== undefined ||
    changes.layers !== undefined ||
    changes.groups !== undefined
  );
}

/** Whether two values are the same to the bit: numbers compared with `Object.is` */
function sameBits(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') return Object.is(a, b);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => sameBits(value, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) =>
      sameBits((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return a === b;
}

/** The error for an input of the wrong shape or value */
function invalidInput(message: string, details?: unknown): DrawError {
  return new DrawError('invalid-input', message, details);
}

/** The error for an ID of no draft, or of no feature */
function notFound(id: unknown, kind = 'draft'): DrawError {
  return new DrawError('not-found', `There is no ${kind} with the ID ${JSON.stringify(id)}`, {
    id,
  });
}

/** Whether the value is a plain object (not null, not an array) */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Throws unless the keys of the object are all among the allowed ones */
function onlyKeys(value: object, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalidInput(`${what} cannot have the key ${key}`);
  }
}

/** Throws unless the value is a non-empty string */
function requireId(value: unknown, what = 'The ID'): string {
  if (typeof value !== 'string' || value === '') {
    throw invalidInput(`${what} must be a non-empty string`);
  }
  return value;
}
