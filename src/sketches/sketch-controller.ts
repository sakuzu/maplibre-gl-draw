// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sketches of an instance (`SketchController`): the edits shown over the document before they
 * are written (`draw.sketches`)
 *
 * A sketch holds edits (`SketchEdit`). What it shows is the features it edits as its edits leave
 * them over their values of now, worked out again whenever the Store writes one of them: at the
 * end of each frame of writes (each notification of the Store), from the write marks of the rows
 * of a Store of rows (`write-mark-keeper.ts`) and from the features a Store of objects tells written. A
 * sketch is never carried over what was written: it is applied again over it.
 *
 * A sketch of this client (`owner` null) edits only what it can write. A feature of it deleted,
 * locked, hidden or put into a layer that cannot be written is left out (counted as dropped), a
 * vertex it edits that is no longer there likewise, and the sketch ends once nothing of it is left.
 * The sketches with an owner pass no gate and cannot be committed; they are drawn under the
 * sketches of this client, in the order they came. A commit makes the edits of a sketch the edits of
 * the Store (`applyEdits`) and its features to create the features of the Store, in one
 * transaction.
 *
 * Every sketch ends in one place (`#end`), and what an operation changed is drawn and told once it
 * is done: the features shown are worked out again, then the events go out, in their order.
 *
 * A sketch of this client of one edit that moves, rotates or scales features draws the rows of a
 * Store of rows on the GPU, whatever their number (`sketch-motion.ts`): they are not worked out
 * here, and a read of one of them makes it where it is drawn (`RenderedShapes`). Over the features
 * selected in bulk (`{ selection: true }`) the features are not listed: the sketch moves the rows
 * selected that are not locked, and follows them.
 *
 * What a drag of the select mode shows is written by the drag, through the writes of the Store,
 * and the sketch ends with the write (`commitWith`). What the drag edits is not hit while it goes
 * on (`dragged`), and the drag ends with the selection of what it edits.
 */

import type { InstanceSignals } from '../api/impl/events.js';
import type { StoredFeatureInput as FeatureInput } from '../api/model.js';
import type {
  Sketch,
  SketchEdit,
  SketchEndReason,
  SketchInput,
  SketchPatch,
} from '../api/sketches.js';
import {
  BULK_MOVE_SET,
  type RowStateSets,
  SKETCH_MOVE_SET,
  STATE_MOVE_MASK,
  STATE_MOVE_SHIFT,
} from '../feature-table/feature-row-states.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { TableSelection } from '../feature-table/selection.js';
import { DrawError } from '../shared/draw-error.js';
import { describeStyleProblem } from '../shared/style-validation.js';
import type { FeatureStyle } from '../shared/types/model.js';
import { coordinatesOf } from '../shared/utils/coordinates.js';
import { isVertexOf } from '../shared/utils/vertex-edits.js';
import { DEFAULT_TRANSFORMS, type FeatureUpdate, updatesOfEdits } from '../store/feature-edits.js';
import { itemNeighbors } from '../store/item-lists.js';
import { isLocallyHidden } from '../store/local-visibility.js';
import { isFeatureLocked } from '../store/lock.js';
import type {
  FeatureEdit,
  GeometryTransforms,
  Store,
  TransformEdit,
  VertexTarget,
} from '../store/store.js';
import { transformFieldsOfStore } from '../store/transform-roles.js';
import type { Feature, StoreChange, VertexRef } from '../store/types.js';
import { isWritableLayer } from '../store/writable-layer.js';
import { writeMarkKeeperOf } from '../store/write-mark-keeper.js';
import {
  type CreateEdit,
  checkSketchEdits,
  featureEditsOf,
  featureIdsOfEdit,
  isDrawingEdit,
  isSelectionEdit,
  isVertexEdit,
  mapVertices,
  vertexFeatureIds,
  vertexShapeOf,
  verticesOf,
  withoutFeatures,
  withoutVertices,
} from './sketch-edits.js';
import { rowsByValues, type SketchMotion } from './sketch-motion.js';
import {
  type DrawnCreate,
  type ShapeBeingDrawn,
  SketchView,
  shapeBeingDrawnOf,
} from './sketch-view.js';

/** The keys of the input of a sketch */
const INPUT_KEYS: readonly string[] = ['id', 'edits', 'owner', 'previewStyle'];

/** The keys of a patch of a sketch */
const PATCH_KEYS: readonly string[] = ['edits', 'previewStyle'];

/** The order the reasons a feature is left out are told in, when several leave a sketch empty */
const DROP_REASONS: readonly SketchEndReason[] = ['deleted', 'locked', 'layerUnavailable'];

/**
 * The events of the sketches
 *
 * @internal
 */
export type SketchEventName = 'sketch.added' | 'sketch.updated' | 'sketch.removed';

/**
 * What the sketches read and are told of the instance
 *
 * @internal
 */
export interface SketchControllerDeps {
  /** The Store of the instance */
  readonly store: Store;
  /** Makes an ID: of a sketch given none, and of a feature created with none */
  readonly generateId: () => string;
  /** The layer a feature created goes into when its input names neither layer nor group */
  readonly getActiveLayerId: () => string;
  /**
   * Checks the input of a feature created and makes the feature as `features.create` stores it
   *
   * @param id The ID it gets when its input has none
   * @param layerId The layer it goes into when its input names neither layer nor group
   * @param partial Whether it is a shape being drawn, whose geometry may have fewer positions
   * @throws DrawError as `features.create` does for a wrong input
   */
  readonly prepareFeature: (
    input: FeatureInput,
    id: string,
    layerId: string,
    partial?: boolean,
  ) => Feature;
}

/**
 * Compares what a sketch drew with what its commit wrote (the checks of the state): the problems
 * found, given to the check
 *
 * @internal
 */
export type SketchCommitCheck = (problems: string[]) => void;

/**
 * What the drag of this client edits: not hit while it goes on
 *
 * @internal
 */
export interface DraggedFeatures {
  /** Whether a feature is one of them */
  hasFeature(id: string): boolean;
  /** Whether the row of a handle is one of them */
  hasRow(handle: number): boolean;
  /** The features it names (the rows selected in bulk it edits are not listed) */
  readonly ids: readonly string[];
}

/** The edit of a sketch that moves, rotates or scales features */
type MovingEdit = Extract<SketchEdit, { kind: TransformEdit['kind'] }>;

/** The edit of a sketch of the vertices of one feature */
type VertexEdit = Extract<SketchEdit, { kind: 'vertexMove' | 'vertexInsert' | 'vertexDelete' }>;

/** A sketch and what is kept with it */
interface Entry {
  sketch: Sketch;
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
  /**
   * The vertices its edits of vertices named when a drag took it on, by feature: the frames of the
   * drag give a position for each of them, whichever are left
   */
  dragVertices?: ReadonlyMap<string, readonly VertexTarget[]>;
}

/** A sketch checked, before it is added or changed */
interface Prepared {
  readonly edits: readonly SketchEdit[];
  readonly shapes: Map<string, string>;
  readonly createLayers: Map<number, string>;
  /** The features it edits (the ones selected now for `{ selection: true }`) */
  readonly touched: readonly string[];
  /** Whether it moves the rows selected in bulk (they are not listed in `touched`) */
  readonly bulk: boolean;
}

/**
 * The sketches of an instance
 *
 * @internal
 */
export class SketchController {
  readonly #deps: SketchControllerDeps;
  readonly #store: Store;
  /** What the sketches draw */
  readonly view: SketchView;
  /** The sketches, in the order they were added */
  readonly #entries = new Map<string, Entry>();
  #seq = 0;
  /** The features sketches edit, as the sketches leave them, by ID */
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
  #events: Array<[SketchEventName, InstanceSignals[SketchEventName]]> = [];
  #listener: (<K extends SketchEventName>(event: K, payload: InstanceSignals[K]) => void) | null =
    null;
  #unsubscribe: (() => void) | null = null;
  #commitCheck: SketchCommitCheck | null = null;
  #afterOperate: (() => void) | null = null;
  /** The rows each sketch moves by a moving set, by the ID of the sketch */
  readonly #motions = new Map<string, SketchMotion>();
  /** The sketch the drag of this client going on is shown by (null: none) */
  #dragged: string | null = null;
  /** The features selected the drag of this client edits (it ends with the last of them) */
  #draggedSelected: readonly string[] = [];
  /** The sketch the arrow keys of this client show, and what writes it once the selection changes */
  #nudged: { readonly id: string; readonly write: () => void } | null = null;
  /** What the drag of this client edits as read last, and what it was read from */
  #draggedRead: {
    readonly sketch: Sketch;
    readonly rows: TableSelection | undefined;
    readonly features: DraggedFeatures;
  } | null = null;

  constructor(deps: SketchControllerDeps) {
    this.#deps = deps;
    this.#store = deps.store;
    this.view = new SketchView(deps.store);
    this.#readOnly = deps.store.isReadOnly();
  }

  /** Follows the writes of the Store: the sketches are applied again at the end of each frame */
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

  /** Sets what the events of the sketches are told to (null: nothing) */
  setListener(
    listener: (<K extends SketchEventName>(event: K, payload: InstanceSignals[K]) => void) | null,
  ): void {
    this.#listener = listener;
  }

  /** Sets what compares the sketches drawn with what their commits write (null: nothing) */
  setCommitCheck(check: SketchCommitCheck | null): void {
    this.#commitCheck = check;
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  get(id: string): Sketch | undefined {
    return this.#entries.get(id)?.sketch;
  }

  /** The sketches in the order they are drawn: the ones with an owner first */
  list(): Sketch[] {
    return this.#ordered().map((entry) => entry.sketch);
  }

  count(): number {
    return this.#entries.size;
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  /** A feature of the Store as the sketches edit it (the feature itself when none does) */
  appliedFeature(id: string): Feature | undefined {
    return this.#applied.get(id) ?? this.#store.getFeature(id);
  }

  /**
   * The features sketches edit that are shown, as the sketches leave them: what is drawn in their
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

  /**
   * What a sketch of this client edits over the features as they are now: the fields each feature
   * takes, as a write of it gives them
   *
   * @throws DrawError `notFound` when there is no sketch with this ID; `invalidInput` when an
   *   edit gives a feature what it cannot have
   */
  updatesOf(id: string): FeatureUpdate[] {
    const [entry] = this.#requireAll([id]);
    return updatesOfEdits(
      featureEditsOf(entry.sketch.edits, () => this.#selected(), this.#vertexFinder()),
      (featureId) => this.#store.getFeature(featureId),
      this.#transforms(),
      transformFieldsOfStore(this.#store),
    ).updates;
  }

  /**
   * Sets the sketch the drag of this client going on is shown by (null when none is)
   *
   * @param selected The features selected it edits: a feature no longer selected is left out, and
   *   it ends (`deselected`) with the last of them
   */
  setDragged(id: string | null, selected: readonly string[] = []): void {
    this.#dragged = id;
    this.#draggedSelected = selected;
    const entry = id === null ? undefined : this.#entries.get(id);
    if (!entry) return;
    const vertices = new Map<string, readonly VertexTarget[]>();
    for (const featureId of vertexFeatureIds(entry.sketch.edits)) {
      vertices.set(featureId, verticesOf(entry.sketch.edits, featureId));
    }
    entry.dragVertices = vertices;
  }

  /**
   * Sets the sketch the arrow keys of this client show (null when none does): once the selection
   * changes, `write` writes it, before the sketches follow the selection
   */
  setNudged(id: string | null, write: (() => void) | null = null): void {
    this.#nudged = id === null || write === null ? null : { id, write };
  }

  /**
   * What the drag of this client edits (null when no drag is shown by a sketch), read once for each
   * change of its sketch: a frame of the snapping asks it for each feature it reads
   */
  dragged(): DraggedFeatures | null {
    const entry = this.#dragged === null ? undefined : this.#entries.get(this.#dragged);
    if (!entry) return this.#extensionDragged();
    const rows = this.#motions.get(entry.sketch.id)?.rows;
    const read = this.#draggedRead;
    if (read?.sketch === entry.sketch && read.rows === rows) return read.features;
    const features = this.#draggedOf(entry, rows);
    this.#draggedRead = { sketch: entry.sketch, rows, features };
    return features;
  }

  /**
   * What the drag of a handle of an extension edits by sketches of its own (null when none does):
   * the features of the sketches of this client while it goes on
   */
  #extensionDragged(): DraggedFeatures | null {
    if (this.#store.getDragState()?.operation !== 'auxiliary') return null;
    const listed = new Set<string>();
    for (const entry of this.#entries.values()) {
      if (entry.sketch.owner !== null) continue;
      for (const id of this.#touchedBy(entry)) listed.add(id);
    }
    if (listed.size === 0) return null;
    const tables = this.#store.tables;
    return {
      ids: [...listed],
      hasFeature: (id) => listed.has(id),
      hasRow(handle) {
        const id = tables?.getRowId(handle);
        return id !== undefined && listed.has(id);
      },
    };
  }

  #draggedOf(entry: Entry, rows: TableSelection | undefined): DraggedFeatures {
    const tables = this.#store.tables;
    const listed = this.#touchedBy(entry);
    const ids = new Set(listed);
    return {
      ids: listed,
      hasFeature(id) {
        if (ids.has(id)) return true;
        const handle = rows ? tables?.getRowRef(id) : undefined;
        return handle !== undefined && rows?.has(handle) === true;
      },
      hasRow(handle) {
        if (rows?.has(handle)) return true;
        const id = ids.size > 0 ? tables?.getRowId(handle) : undefined;
        return id !== undefined && ids.has(id);
      },
    };
  }

  /**
   * The problems of the rows the sketches draw moved (the check `sketches`): each row is in the
   * moving set of its sketch, and the set moves by the edit of the sketch
   */
  checkMotions(): string[] {
    const states = featureTablesInternals(this.#store.tables)?.states;
    const problems: string[] = [];
    for (const [id, motion] of this.#motions) {
      const edit = this.#entries.get(id)?.sketch.edits[0];
      if (!states || !isMovingEdit(edit)) {
        problems.push(`the sketch "${id}" draws rows moved, and does not move features`);
        continue;
      }
      if (JSON.stringify(states.transform(motion.set)) !== JSON.stringify(transformOf(edit))) {
        problems.push(
          `the moving set ${motion.set} is not moved by the edit of the sketch "${id}"`,
        );
      }
      for (const handle of motion.rows.handles) {
        if ((states.stateOf(handle) & STATE_MOVE_MASK) >> STATE_MOVE_SHIFT === motion.set) continue;
        problems.push(`the row ${handle} of the sketch "${id}" is not in its moving set`);
        break;
      }
    }
    return problems;
  }

  /** Sets what is called once each operation of the sketches is done (null: nothing) */
  setAfterOperate(fn: (() => void) | null): void {
    this.#afterOperate = fn;
  }

  // ==========================================================================
  // Writes
  // ==========================================================================

  add(input: SketchInput): Sketch | null {
    return this.#operate(() => this.#addAll([input], 'add')?.[0] ?? null);
  }

  addMany(inputs: readonly SketchInput[]): Sketch[] | null {
    if (!Array.isArray(inputs)) throw invalidInput('The inputs must be an array');
    return this.#operate(() => this.#addAll(inputs, 'addMany'));
  }

  update(id: string, patch: SketchPatch): Sketch | null {
    return this.#operate(() => this.#updateAll([{ id, patch }])?.[0] ?? null);
  }

  updateMany(patches: readonly { id: string; patch: SketchPatch }[]): Sketch[] | null {
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
        this.#end(entry.sketch.id, entry.sketch.owner === null ? 'cancelled' : 'withdrawn');
      }
      return true;
    });
  }

  /**
   * Ends a sketch for a reason (the input of a mode ends its sketch so: `deselected`), without
   * writing it
   *
   * @throws DrawError `notFound` when there is no sketch with this ID
   */
  end(id: string, reason: Exclude<SketchEndReason, 'committed'>): void {
    this.#requireAll([id]);
    this.#operate(() => this.#end(id, reason));
  }

  /**
   * Changes the edits of the sketch of a drag, over what it edits now: a frame of the drag. An edit
   * that moves, rotates or scales features costs the same whatever their number, the rows moved on
   * the GPU, and an edit of vertices takes the positions of the vertices alone, with no check of
   * what it names. Any other edit is changed as `update` changes it
   *
   * @returns false when the sketch is gone or the computation of the Store does not take the edit:
   *   the edits before stay
   */
  setDragEdits(id: string, edits: readonly SketchEdit[]): boolean {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    const [before] = entry.sketch.edits;
    if (isMovingEdit(before)) {
      const edit = transformOf(edits[0]);
      return edit !== null && this.#setMovingEdit(entry, before, edit);
    }
    if (edits.every(isVertexEdit)) {
      this.#operate(() => {
        entry.sketch = sketchOf(id, positionsGiven(entry, edits), entry.sketch);
        this.#queue('sketch.updated', { sketch: entry.sketch, dropped: 0 });
        this.#dirty = true;
      });
      return true;
    }
    return this.update(id, { edits }) !== null;
  }

  /** Changes the edit of a sketch of one edit that moves, rotates or scales features */
  #setMovingEdit(entry: Entry, before: MovingEdit, edit: TransformEdit): boolean {
    if (!this.#transforms().accepts(edit)) return false;
    const { id } = entry.sketch;
    this.#operate(() => {
      const next = { ...edit, target: before.target } as SketchEdit;
      entry.sketch = sketchOf(id, [next], entry.sketch);
      this.#queue('sketch.updated', { sketch: entry.sketch, dropped: 0 });
      const motion = this.#motions.get(id);
      if (!motion || motion.slow.length > 0) {
        this.#dirty = true;
        return;
      }
      featureTablesInternals(this.#store.tables)?.states.setTransform(motion.set, edit);
      this.view.redraw();
    });
    return true;
  }

  commit(id: string): boolean {
    return this.commitMany([id]);
  }

  /**
   * Ends a sketch of this client written by the one that made it: what it drew goes first, `write`
   * writes it through the writes of the Store (from `updatesOf`, or as it writes the rows selected
   * in bulk), and the sketch ends `committed`, told once it is written. What it drew is compared
   * with what is written (`sketchCommits`)
   *
   * @param keepRows Whether the rows it edits are given to `write`, the ones in a moving set staying
   *   there for it to take them out (a write in steps takes each row out as it writes it)
   * @throws DrawError `notFound` when there is no sketch with this ID
   */
  commitWith(id: string, write: (kept: TableSelection | null) => void, keepRows = false): void {
    const [entry] = this.#requireAll([id]);
    this.#operate(() => {
      const drawn = this.#commitCheck
        ? this.#drawnBefore([{ entry, creates: [], edits: [] }])
        : null;
      // What is written is every row it edits, a row drawn on the slow path too (one another sketch
      // edits as well is in no moving set)
      const motion = this.#motions.get(id);
      const kept = keepRows
        ? (this.#store.getUnlockedSelectedRows() ?? motion?.rows ?? null)
        : null;
      if (kept) this.#motions.delete(id);
      this.#end(id, 'committed');
      this.#refresh();
      write(kept);
      if (drawn) this.#compareCommitted(drawn);
    });
  }

  commitMany(ids: readonly string[]): boolean {
    const entries = this.#requireAll(ids);
    return this.#operate(() => {
      if (entries.some((entry) => entry.sketch.owner !== null)) return false;
      if (this.#store.isReadOnly()) return false;
      return this.#commitEntries(entries);
    });
  }

  // ==========================================================================
  // Adding and changing
  // ==========================================================================

  /** Adds sketches, all of them or none (null when one of this client is refused) */
  #addAll(inputs: readonly SketchInput[], what: string): Sketch[] | null {
    const taken = new Set<string>();
    const checked = inputs.map((input) => {
      if (!isRecord(input)) throw invalidInput('The input must be an object');
      onlyKeys(input, INPUT_KEYS, 'The input');
      let id: string;
      if (input.id === undefined) id = this.#deps.generateId();
      else {
        id = requireId(input.id);
        if (this.#entries.has(id) || taken.has(id)) {
          throw new DrawError('alreadyExists', `The ID ${JSON.stringify(id)} is already taken`, {
            ids: [id],
          });
        }
      }
      taken.add(id);
      const owner = input.owner === undefined || input.owner === null ? null : input.owner;
      if (owner !== null) requireId(owner, 'The owner');
      const previewStyle = previewStyleOf(input.previewStyle, 'The input');
      return { id, owner, previewStyle, prepared: this.#prepare(id, input.edits, owner) };
    });
    // Two sketches of this client of a feature, given at once
    const touchedBy = new Map<string, string>();
    for (const { id, owner, prepared } of checked) {
      if (owner !== null) continue;
      for (const featureId of prepared.touched) {
        if (touchedBy.has(featureId)) {
          throw invalidInput(
            `The sketches ${touchedBy.get(featureId)} and ${id} of ${what} both edit the feature ${featureId}`,
          );
        }
        touchedBy.set(featureId, id);
      }
    }
    if (checked.some(({ owner, prepared }) => owner === null && !this.#allowed(prepared))) {
      return null;
    }
    // A second sketch of this client of a feature commits the first one
    const own = checked.filter(({ owner }) => owner === null);
    const before = this.#ownTouching(
      own.flatMap(({ prepared }) => prepared.touched),
      new Set(),
      own.some(({ prepared }) => prepared.bulk),
    );
    if (before.length > 0) {
      if (!this.#store.isReadOnly()) this.#commitEntries(before);
      if (checked.some(({ owner, prepared }) => owner === null && !this.#allowed(prepared))) {
        return null;
      }
    }
    const sketches: Sketch[] = [];
    for (const { id, owner, previewStyle, prepared } of checked) {
      const entry: Entry = {
        sketch: sketchOf(id, prepared.edits, { owner, previewStyle }),
        seq: this.#seq++,
        dropped: 0,
        shapes: prepared.shapes,
        createLayers: prepared.createLayers,
      };
      this.#entries.set(id, entry);
      sketches.push(entry.sketch);
      this.#queue('sketch.added', { sketch: entry.sketch });
    }
    this.#dirty = true;
    return sketches;
  }

  /** Changes sketches, all of them or none (null when one of this client is refused) */
  #updateAll(patches: readonly { id: string; patch: SketchPatch }[]): Sketch[] | null {
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
      const edits = patch.edits === undefined ? found.sketch.edits : patch.edits;
      const previewStyle =
        patch.previewStyle === undefined
          ? found.sketch.previewStyle
          : previewStyleOf(patch.previewStyle, 'The patch');
      return {
        entry: found,
        previewStyle,
        prepared: this.#prepare(id, edits, found.sketch.owner),
      };
    });
    const own = checked.filter(({ entry }) => entry.sketch.owner === null);
    if (own.some(({ prepared }) => !this.#allowed(prepared))) return null;
    const changing = new Set(checked.map(({ entry }) => entry.sketch.id));
    const before = this.#ownTouching(
      own.flatMap(({ prepared }) => prepared.touched),
      changing,
      own.some(({ prepared }) => prepared.bulk),
    );
    if (before.length > 0) {
      if (!this.#store.isReadOnly()) this.#commitEntries(before);
      if (own.some(({ prepared }) => !this.#allowed(prepared))) return null;
    }
    const sketches: Sketch[] = [];
    for (const { entry, previewStyle, prepared } of checked) {
      entry.sketch = sketchOf(entry.sketch.id, prepared.edits, {
        owner: entry.sketch.owner,
        previewStyle,
      });
      entry.shapes = prepared.shapes;
      entry.createLayers = prepared.createLayers;
      sketches.push(entry.sketch);
      this.#queue('sketch.updated', { sketch: entry.sketch, dropped: 0 });
    }
    this.#dirty = true;
    return sketches;
  }

  /**
   * Checks the edits of a sketch and what it is kept with: the features and the vertices they
   * name are there and take the edits (each edit applied over the features as they are now)
   *
   * @throws DrawError `invalidInput` for edits that cannot apply, `notFound` for a feature, a
   *   layer or a group that is not there
   */
  #prepare(id: string, given: unknown, owner: string | null): Prepared {
    const store = this.#store;
    const transforms = this.#transforms();
    checkSketchEdits(given, store.getVertexIds !== undefined, transforms);
    let edits: readonly SketchEdit[] = given;
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
      // The input is checked as it is created (a shape being drawn may have fewer positions)
      this.#deps.prepareFeature(input, createKey(id, i), layerId ?? '', isDrawingEdit(edit));
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
            throw invalidInput(`The feature ${featureId} has no vertex ${JSON.stringify(place)}`);
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
            throw invalidInput(`The feature ${featureId} has no vertex ${JSON.stringify(vertex)}`);
          }
        });
      }
    }
    // Each edit is applied over the features as they are now: one that cannot apply throws (the
    // rows selected in bulk are not listed: they are not made features for it)
    const bulk = movesBulk(edits, owner) && this.#store.getSelectedRows() !== null;
    updatesOfEdits(
      featureEditsOf(edits, () => (bulk ? [] : this.#selected()), this.#vertexFinder()),
      (featureId) => store.getFeature(featureId),
      transforms,
      transformFieldsOfStore(store),
    );
    const shapes = new Map<string, string>();
    if (!findVertices) {
      for (const featureId of vertexFeatureIds(edits)) {
        const feature = store.getFeature(featureId);
        if (feature) shapes.set(featureId, vertexShapeOf(feature.geometry));
      }
    }
    const touched = new Set<string>();
    for (const edit of bulk ? [] : edits) {
      for (const featureId of featureIdsOfEdit(edit, () => this.#selected()))
        touched.add(featureId);
    }
    return { edits, shapes, createLayers, touched: [...touched], bulk };
  }

  /**
   * Whether a sketch of this client may be added or changed so: the document is not read-only, the
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
      if (isSelectionEdit(edit) && this.#noneSelected()) return false;
    }
    let ok = true;
    prepared.edits.forEach((edit, i) => {
      if (edit.kind === 'create' && !this.#createWritable(edit, prepared.createLayers.get(i))) {
        ok = false;
      }
    });
    return ok;
  }

  /**
   * The sketches of this client that edit any of the features, other than the ones given
   *
   * @param bulk Whether the rows selected in bulk are edited too (the sketches of them are told by
   *   their edits: their features are not listed)
   */
  #ownTouching(featureIds: readonly string[], except: ReadonlySet<string>, bulk: boolean): Entry[] {
    if (featureIds.length === 0 && !bulk) return [];
    const ids = new Set(featureIds);
    const out: Entry[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.sketch.owner !== null || except.has(entry.sketch.id)) continue;
      if (
        (bulk && this.#movesBulkRows(entry)) ||
        this.#touchedBy(entry).some((featureId) => ids.has(featureId))
      ) {
        out.push(entry);
      }
    }
    return out;
  }

  // ==========================================================================
  // Committing
  // ==========================================================================

  /**
   * Writes sketches of this client in one transaction: the features they create created in their
   * places, and their edits given to the Store (`applyEdits`, once for each sketch). A sketch that
   * creates a feature in a layer that cannot be written ends (`layerUnavailable`) and nothing is
   * written then
   */
  #commitEntries(entries: readonly Entry[]): boolean {
    const store = this.#store;
    const unavailable = entries.filter((entry) =>
      entry.sketch.edits.some(
        (edit, i) =>
          edit.kind === 'create' && !this.#createWritable(edit, entry.createLayers.get(i)),
      ),
    );
    if (unavailable.length > 0) {
      for (const entry of unavailable) this.#end(entry.sketch.id, 'layerUnavailable');
      return false;
    }
    const writes = entries.map((entry) => {
      const creates: Array<{ feature: Feature; below: string | null | undefined; key: string }> =
        [];
      entry.sketch.edits.forEach((edit, i) => {
        if (edit.kind !== 'create') return;
        const layerId = entry.createLayers.get(i) ?? '';
        const feature = this.#deps.prepareFeature(
          edit.feature,
          edit.feature.id ?? this.#deps.generateId(),
          layerId,
        );
        creates.push({ feature, below: edit.below, key: createKey(entry.sketch.id, i) });
      });
      // A Store that gives its vertices IDs takes them by their IDs
      const edits = featureEditsOf(entry.sketch.edits, () => this.#selected());
      return { entry, creates, edits };
    });
    const drawn = this.#commitCheck ? this.#drawnBefore(writes) : null;
    // What the sketches drew goes with them, before the Store is written
    for (const { entry } of writes) this.#entries.delete(entry.sketch.id);
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
      this.#queue('sketch.removed', {
        sketch: entry.sketch,
        reason: dropped === null ? 'readOnly' : 'committed',
        dropped: entry.dropped,
      });
    });
    if (drawn) this.#compareCommitted(drawn);
    return results.every((dropped) => dropped !== null);
  }

  /**
   * Puts a feature just created just above an item of its layer or group (at the back for null; it
   * stays at the front where it was created for undefined)
   */
  #place(feature: Feature, below: string | null | undefined): void {
    if (below === undefined) return;
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

  /** Ends a sketch: the one place a sketch ends, its end told once the operation is done */
  #end(id: string, reason: SketchEndReason): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    this.#entries.delete(id);
    this.#dirty = true;
    this.#queue('sketch.removed', { sketch: entry.sketch, reason, dropped: entry.dropped });
  }

  // ==========================================================================
  // Applying again
  // ==========================================================================

  /**
   * Applies the sketches again at the end of a frame of writes of the Store: over the features it
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
        this.#nudged = null;
        for (const entry of [...this.#entries.values()]) {
          this.#end(entry.sketch.id, 'documentReplaced');
        }
        return;
      }
      // The moves of the arrow keys are written once the selection changes, before the sketches
      // follow it
      const nudged = this.#nudged;
      if (changes.selection !== undefined && nudged) {
        this.#nudged = null;
        if (this.#entries.has(nudged.id)) nudged.write();
      }
      const store = this.#store;
      const readOnly = store.isReadOnly();
      if (readOnly && !this.#readOnly) {
        for (const entry of [...this.#entries.values()]) {
          if (entry.sketch.owner === null) this.#end(entry.sketch.id, 'readOnly');
        }
      }
      this.#readOnly = readOnly;
      const hidden = changes.uiStateChanged === true ? this.#hiddenNow() : this.#hidden;
      const all =
        changes.layers !== undefined || changes.groups !== undefined || hidden !== this.#hidden;
      this.#hidden = hidden;
      const written = all ? null : this.#writtenIds(changes);
      const selection = changes.selection !== undefined || all;
      if (selection) this.#followDraggedSelection();
      for (const entry of [...this.#entries.values()]) {
        if (selection || hasDocumentChange(changes)) this.#followRows(entry);
        if (!this.#entries.has(entry.sketch.id)) continue;
        const touched = this.#touchedBy(entry);
        const named = written === null ? touched : touched.filter((id) => written.has(id));
        const selects = selection && entry.sketch.edits.some(isSelectionEdit);
        if (named.length > 0 || selects) this.#applyAgain(entry, named);
      }
      if (
        written === null ||
        [...written].some((id) => this.#applied.has(id) || this.#marks.has(id)) ||
        selection ||
        (this.#hasCreates() && hasDocumentChange(changes))
      ) {
        this.#dirty = true;
      }
    });
  }

  /**
   * Follows the features selected the drag of this client edits: a feature no longer selected is
   * left out, the sketch going on with the others, and it ends with the last of them
   */
  #followDraggedSelection(): void {
    const entry = this.#dragged === null ? undefined : this.#entries.get(this.#dragged);
    if (!entry || this.#draggedSelected.length === 0) return;
    const selected = new Set(this.#store.selectedFeatureIds());
    const left = this.#draggedSelected.filter((id) => selected.has(id));
    if (left.length === this.#draggedSelected.length) return;
    const gone = new Set(this.#draggedSelected.filter((id) => !selected.has(id)));
    this.#draggedSelected = left;
    const kept = withoutFeatures(entry.sketch.edits, gone);
    entry.dropped += kept.dropped;
    if (left.length === 0) {
      this.#end(entry.sketch.id, 'deselected');
      return;
    }
    entry.sketch = sketchOf(entry.sketch.id, kept.edits, entry.sketch);
    this.#dirty = true;
    this.#queue('sketch.updated', { sketch: entry.sketch, dropped: kept.dropped });
  }

  /**
   * Follows the rows selected in bulk a sketch moves: the ones no longer selected, or locked, are
   * left out, the sketch going on with the others, and it ends once they are all locked (it ends
   * with the selection as any sketch of the features selected does)
   */
  #followRows(entry: Entry): void {
    if (!this.#movesBulkRows(entry)) return;
    const rows = this.#store.getUnlockedSelectedRows();
    const motion = this.#motions.get(entry.sketch.id);
    if (!rows || !motion) {
      this.#dirty = true;
      return;
    }
    if (rows.count === 0) {
      entry.dropped += motion.rows.count;
      this.#end(entry.sketch.id, 'locked');
      return;
    }
    if (rows.equals(motion.rows)) return;
    let dropped = 0;
    for (const handle of motion.rows.handles) if (!rows.has(handle)) dropped++;
    this.#dirty = true;
    if (dropped === 0) return;
    entry.dropped += dropped;
    this.#queue('sketch.updated', { sketch: entry.sketch, dropped });
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
   * Applies a sketch again over the features named written: the ones gone or that cannot be written
   * left out (the sketch ends once nothing of it is left), and its vertices found again
   */
  #applyAgain(entry: Entry, named: readonly string[]): void {
    const store = this.#store;
    const own = entry.sketch.owner === null;
    const gone = new Map<string, SketchEndReason>();
    for (const id of named) {
      const feature = store.getFeature(id);
      const reason = !feature ? 'deleted' : own ? this.#unavailable(feature) : null;
      if (reason) gone.set(id, reason);
    }
    let edits: readonly SketchEdit[] = entry.sketch.edits;
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
        this.#end(entry.sketch.id, 'verticesRemoved');
        return;
      }
    }
    dropped += verticesDropped;
    const hadVertices = vertexFeatureIds(entry.sketch.edits).size > 0;
    if (verticesDropped > 0 && hadVertices && vertexFeatureIds(edits).size === 0) {
      entry.dropped += dropped;
      this.#end(entry.sketch.id, 'verticesRemoved');
      return;
    }
    if (edits.length === 0 && entry.sketch.edits.length > 0) {
      entry.dropped += dropped;
      const reasons = new Set(gone.values());
      this.#end(
        entry.sketch.id,
        DROP_REASONS.find((reason) => reasons.has(reason)) ?? 'verticesRemoved',
      );
      return;
    }
    // A sketch of the features selected ends once none is
    if (edits.length > 0 && edits.every(isSelectionEdit) && this.#noneSelected()) {
      entry.dropped += dropped;
      this.#end(entry.sketch.id, 'deselected');
      return;
    }
    if (dropped === 0) return;
    entry.dropped += dropped;
    entry.sketch = sketchOf(entry.sketch.id, edits, entry.sketch);
    this.#dirty = true;
    this.#queue('sketch.updated', { sketch: entry.sketch, dropped });
  }

  // ==========================================================================
  // What the sketches show
  // ==========================================================================

  /**
   * Works out again the features the sketches edit as they leave them, and what the sketches draw: the
   * sketches applied one after the other in the order they are drawn, over the features as they are
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
    this.#moveRows(ordered);
    for (const entry of ordered) {
      // Only what cannot be moved on the GPU is worked out here
      const motion = this.#motions.get(entry.sketch.id);
      const slow = motion ? motion.slow : this.#movesBulkRows(entry) ? [] : null;
      if (slow?.length === 0) continue;
      const edits: readonly SketchEdit[] = slow
        ? [{ ...entry.sketch.edits[0], target: { featureIds: slow } } as SketchEdit]
        : entry.sketch.edits;
      for (const id of slow ?? this.#touchedBy(entry)) {
        const feature = live(id);
        if (feature) applied.set(id, feature);
      }
      let updates: ReturnType<typeof updatesOfEdits>['updates'];
      try {
        updates = updatesOfEdits(
          featureEditsOf(edits, () => this.#selected(), findVertex),
          live,
          transforms,
          transformFieldsOfStore(this.#store),
        ).updates;
      } catch {
        // A sketch whose edits no longer apply over the features as they are (the sketches of other
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
      // The features worked out, and the ones moved on the GPU: a write of one is followed too
      const followed = [...applied.keys()];
      for (const motion of this.#motions.values()) followed.push(...motion.ids);
      for (const id of followed) {
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
    this.view.set(drawn, this.#drawnCreates(), this.#drawings());
  }

  /**
   * Draws the rows of the sketches of one edit that moves, rotates or scales features moved on the
   * GPU, as far as there are moving sets for them, and the rows of the others where they are
   */
  #moveRows(ordered: readonly Entry[]): void {
    const states = featureTablesInternals(this.#store.tables)?.states;
    if (!states) return;
    const wanted = new Map<string, SketchMotion>();
    const taken = new Set<number>();
    for (const entry of ordered) {
      const motion = this.#motionOf(entry, ordered, taken, states);
      if (!motion) continue;
      taken.add(motion.set);
      wanted.set(entry.sketch.id, motion);
    }
    if (wanted.size === 0 && this.#motions.size === 0) return;
    for (const [id, motion] of [...this.#motions]) {
      if (wanted.has(id)) continue;
      this.#motions.delete(id);
      letGoRows(motion, states);
    }
    for (const [id, motion] of wanted) {
      const before = this.#motions.get(id);
      if (before?.set !== motion.set || before.rows !== motion.rows) {
        if (before) letGoRows(before, states);
        states.setMoving(motion.rows.handles, motion.set);
        if (motion.byValues.length > 0) states.setByValues(motion.byValues, true);
      }
      this.#motions.set(id, motion);
      states.setTransform(motion.set, transformOf(this.#entries.get(id)?.sketch.edits[0]));
    }
    this.view.redraw();
  }

  /**
   * The rows a sketch moves on the GPU, and the features of it drawn on the slow path; null for a
   * sketch that moves none: with an owner, of another edit, or whose moving set is taken
   */
  #motionOf(
    entry: Entry,
    ordered: readonly Entry[],
    taken: ReadonlySet<number>,
    states: RowStateSets,
  ): SketchMotion | null {
    const store = this.#store;
    const tables = store.tables;
    const { sketch } = entry;
    const edit = sketch.edits[0];
    if (!tables || sketch.owner !== null || sketch.edits.length !== 1 || !isMovingEdit(edit)) {
      return null;
    }
    const selected = this.#movesBulkRows(entry) ? store.getUnlockedSelectedRows() : null;
    const set = selected ? BULK_MOVE_SET : SKETCH_MOVE_SET;
    const before = this.#motions.get(sketch.id);
    if (taken.has(set) || (before?.set !== set && states.movingCount(set) > 0)) return null;
    const others = new Set<string>();
    for (const other of ordered) {
      if (other !== entry) for (const id of this.#touchedBy(other)) others.add(id);
    }
    const ids = new Set<string>();
    const slow: string[] = [];
    let rows: TableSelection;
    if (selected) {
      const shared: number[] = [];
      for (const id of others) {
        const handle = tables.getRowRef(id);
        if (handle === undefined || !selected.has(handle)) continue;
        shared.push(handle);
        slow.push(id);
      }
      rows = selected.without(shared);
    } else {
      const handles: number[] = [];
      for (const id of this.#touchedBy(entry)) {
        const handle = tables.getRowRef(id);
        if (handle === undefined || others.has(id)) slow.push(id);
        else {
          handles.push(handle);
          ids.add(id);
        }
      }
      rows = TableSelection.of(handles);
    }
    // The same rows keep what was found of them, so that they are not put in their set again
    const same = before?.set === set && before.kind === edit.kind && before.rows.equals(rows);
    return {
      set,
      rows: same ? before.rows : rows,
      byValues: same ? before.byValues : rowsByValues(store, rows, edit.kind),
      kind: edit.kind,
      ids,
      slow,
    };
  }

  /**
   * The features the sketches create, as they are drawn (the ones whose layer is not shown left
   * out, and the shapes being drawn, which are drawn apart)
   */
  #drawnCreates(): DrawnCreate[] {
    const out: DrawnCreate[] = [];
    for (const entry of this.#ordered()) {
      entry.sketch.edits.forEach((edit, i) => {
        if (edit.kind !== 'create' || isDrawingEdit(edit)) return;
        const key = createKey(entry.sketch.id, i);
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

  /**
   * The shapes being drawn (`isDrawingEdit`), in the order they are drawn: in the layer each will
   * be created in, whatever its layer shows; a shape whose layer or group is gone is left out
   */
  #drawings(): ShapeBeingDrawn[] {
    const out: ShapeBeingDrawn[] = [];
    for (const entry of this.#ordered()) {
      entry.sketch.edits.forEach((edit, i) => {
        if (edit.kind !== 'create' || !isDrawingEdit(edit)) return;
        const key = createKey(entry.sketch.id, i);
        let feature: Feature;
        try {
          feature = this.#deps.prepareFeature(
            edit.feature,
            key,
            entry.createLayers.get(i) ?? '',
            true,
          );
        } catch {
          return;
        }
        out.push(shapeBeingDrawnOf(feature, edit, entry.sketch.owner, entry.sketch.previewStyle));
      });
    }
    return out;
  }

  /** The sketches of this client that hold a shape being drawn, in the order they were added */
  ownDrawings(): Sketch[] {
    const out: Sketch[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.sketch.owner === null && entry.sketch.edits.some(isDrawingEdit)) {
        out.push(entry.sketch);
      }
    }
    return out;
  }

  /** Whether the sketches have features to create */
  #hasCreates(): boolean {
    for (const entry of this.#entries.values()) {
      if (entry.sketch.edits.some((edit) => edit.kind === 'create')) return true;
    }
    return false;
  }

  // ==========================================================================
  // The checks of the state
  // ==========================================================================

  /** What the sketches drew of the features their commits write, before they are written */
  #drawnBefore(
    writes: ReadonlyArray<{
      entry: Entry;
      creates: ReadonlyArray<{ feature: Feature; key: string }>;
      edits: readonly FeatureEdit[];
    }>,
  ): Array<{ id: string; drawn: unknown }> | null {
    const store = this.#store;
    // A write the sketches were not applied again over yet is not compared
    if (!this.#fresh()) return null;
    const others = new Set<string>();
    for (const entry of this.#entries.values()) {
      if (entry.sketch.owner !== null) for (const id of this.#touchedBy(entry)) others.add(id);
    }
    const tables = featureTablesInternals(store.tables);
    const drawnOf = (id: string): unknown =>
      tables ? tables.sketchGeometryOf(id) : this.view.drawnFeature(id)?.geometry;
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

  /** Compares what the sketches drew with what their commits wrote (`SketchCommitCheck`) */
  #compareCommitted(drawn: ReadonlyArray<{ id: string; drawn: unknown }>): void {
    const tables = featureTablesInternals(this.#store.tables);
    const problems: string[] = [];
    for (const { id, drawn: before } of drawn) {
      const written = tables ? tables.rowGeometryOf(id) : this.#store.getFeature(id)?.geometry;
      if (!sameBits(before, written)) {
        problems.push(
          `the feature "${id}" was drawn as ${JSON.stringify(before)} before its sketch was committed, and is written as ${JSON.stringify(written)}`,
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

  #queue<K extends SketchEventName>(event: K, payload: InstanceSignals[K]): void {
    this.#events.push([event, payload]);
  }

  /** The sketches in the order they are drawn: the ones with an owner first, each in its order */
  #ordered(): Entry[] {
    const entries = [...this.#entries.values()];
    return [
      ...entries.filter((entry) => entry.sketch.owner !== null),
      ...entries.filter((entry) => entry.sketch.owner === null),
    ];
  }

  /**
   * The features a sketch edits (the ones selected now for `{ selection: true }`; the rows selected
   * in bulk it moves are not listed)
   */
  #touchedBy(entry: Entry): string[] {
    if (this.#movesBulkRows(entry)) return [];
    const out = new Set<string>();
    for (const edit of entry.sketch.edits) {
      for (const id of featureIdsOfEdit(edit, () => this.#selected())) out.add(id);
    }
    return [...out];
  }

  /** Whether a sketch moves the rows selected in bulk now */
  #movesBulkRows(entry: Entry): boolean {
    return (
      movesBulk(entry.sketch.edits, entry.sketch.owner) && this.#store.getSelectedRows() !== null
    );
  }

  /** Whether `{ selection: true }` edits no feature now */
  #noneSelected(): boolean {
    const rows = this.#store.getUnlockedSelectedRows();
    return rows ? rows.count === 0 : this.#selected().length === 0;
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
   * Why a feature cannot take a sketch of this client: locked (itself, its group or its layer),
   * hidden or in a layer that cannot be written (`layerUnavailable`); null when it can
   */
  #unavailable(feature: Feature): SketchEndReason | null {
    const store = this.#store;
    if (isFeatureLocked(feature, store)) return 'locked';
    if (!this.#shown(feature)) return 'layerUnavailable';
    if (!isWritableLayer(store.getLayer(feature.layerId), store)) return 'layerUnavailable';
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
    const handle = tables?.getRowRef(id);
    if (!internals || handle === undefined) return undefined;
    const place = internals.placeOf(handle);
    return place ? place.group.marks[place.row] : undefined;
  }

  /** The IDs hidden on this client, joined */
  #hiddenNow(): string {
    return [...this.#store.listHidden()].sort().join('\u0000');
  }

  /** The sketches of the IDs, each there (all or none) */
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

/**
 * The edits of a sketch of a drag with the positions a frame of the drag gives: the vertices stay
 * the ones the sketch names (each edit given names the vertices of its feature as the drag took
 * them on, and a vertex no longer there has left the sketch)
 */
function positionsGiven(entry: Entry, given: readonly SketchEdit[]): SketchEdit[] {
  const byFeature = new Map<string, VertexEdit>();
  for (const edit of given) if (isVertexEdit(edit)) byFeature.set(edit.featureId, edit);
  return entry.sketch.edits.map((edit) => {
    if (!isVertexEdit(edit)) return edit;
    const next = byFeature.get(edit.featureId);
    if (edit.kind === 'vertexInsert') {
      return next?.kind === 'vertexInsert' ? { ...edit, position: next.position } : edit;
    }
    if (edit.kind !== 'vertexMove' || next?.kind !== 'vertexMove') return edit;
    if (next.positions.length === edit.positions.length) {
      return { ...edit, positions: next.positions };
    }
    const named = entry.dragVertices?.get(edit.featureId) ?? [];
    const positions = edit.vertices.map((vertex, i) => {
      const at = named.indexOf(vertex);
      return at >= 0 ? next.positions[at] : edit.positions[i];
    });
    return { ...edit, positions };
  });
}

/** Whether an edit of a sketch moves, rotates or scales features */
function isMovingEdit(edit: SketchEdit | undefined): edit is MovingEdit {
  return edit?.kind === 'translate' || edit?.kind === 'rotate' || edit?.kind === 'scale';
}

/** The edit that moves features, without the features it names */
function transformOf(edit: SketchEdit | undefined): TransformEdit | null {
  if (!isMovingEdit(edit)) return null;
  const { target: _target, ...transform } = edit;
  return transform as TransformEdit;
}

/** Whether the edits of a sketch are one edit of this client that moves the features selected */
function movesBulk(edits: readonly SketchEdit[], owner: string | null): boolean {
  return (
    owner === null && edits.length === 1 && isMovingEdit(edits[0]) && isSelectionEdit(edits[0])
  );
}

/** Takes the rows of a sketch out of their moving set */
function letGoRows(motion: SketchMotion, states: RowStateSets): void {
  states.setMoving(motion.rows.handles, 0);
  if (motion.byValues.length > 0) states.setByValues(motion.byValues, false);
}

/** A sketch, frozen: its edits, with its owner and its look kept from before or given */
function sketchOf(
  id: string,
  edits: readonly SketchEdit[],
  {
    owner,
    previewStyle,
  }: { owner: string | null; previewStyle?: Sketch['previewStyle'] | undefined },
): Sketch {
  return Object.freeze({
    id,
    edits: Object.freeze([...edits]),
    owner,
    ...(previewStyle !== undefined && { previewStyle }),
  });
}

/**
 * The look a sketch is given (`previewStyle`), checked and copied, frozen
 *
 * @throws DrawError `invalidInput` when it is not a style
 */
function previewStyleOf(given: unknown, what: string): Readonly<Partial<FeatureStyle>> | undefined {
  if (given === undefined) return undefined;
  const problem = describeStyleProblem(given);
  if (problem) throw invalidInput(`The previewStyle of ${what.toLowerCase()} is ${problem}`);
  return Object.freeze({ ...(given as Partial<FeatureStyle>) });
}

/** The ID a feature a sketch creates is drawn with: an ID of no feature of the document */
function createKey(sketchId: string, index: number): string {
  return `\u0000sketch\u0000${sketchId}\u0000${index}`;
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
function invalidInput(message: string): DrawError {
  return new DrawError('invalidInput', message);
}

/** The error for an ID of no sketch, or of no feature */
function notFound(id: unknown, kind = 'sketch'): DrawError {
  return new DrawError('notFound', `There is no ${kind} with the ID ${JSON.stringify(id)}`, {
    ids: typeof id === 'string' ? [id] : [],
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
