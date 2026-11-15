// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.undo` and `draw.redo`: the steps of the commits of this client, taken back and made again
 *
 * Each commit of this client that changed the document is one step (a write over several tasks,
 * the drag of features selected in bulk once let go, is one step with all its tasks). A step is
 * what the commit told the Store wrote, as it was before: the features, layers and groups created
 * (deleted to take it back), deleted (created again where they were) and changed (written back),
 * the items put in another place (put back, from the last one), the order of the layers, the
 * metadata and the files, and for the rows of a layer held as rows the values they had before (a
 * row deleted is kept by the Store until its step is let go of) and the rows created (written
 * deleted). Taking a step back is a commit too, told with the source `undo`; what it wrote is
 * the step that makes it again (`redo`).
 *
 * A commit from elsewhere is no step; a commit of `draw.write` with `undo: false` is none either.
 * Opening a document drops every step.
 *
 * With `maxSteps` 0 there is no local undo (the undo of the document is elsewhere, such as the
 * history of a backend that keeps the Store in step): no step is recorded and nothing of the
 * commits is kept, not even what keeps the rows a deletion deleted, which stay with the Store
 * until it is cleared for whatever takes the deletion back.
 */

import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import type { FileData, Metadata } from '../../shared/types/model.js';
import { createId } from '../../shared/utils/id.js';
import { commitOf, runCommit } from '../../store/commit-scope.js';
import type { Store } from '../../store/store.js';
import type {
  ItemOrderChange,
  RowValues,
  StoreChange,
  Feature as StoredFeature,
  Group as StoredGroup,
  Layer as StoredLayer,
} from '../../store/types.js';
import { DrawError } from '../errors.js';
import type { HistoryState } from '../status.js';
import type { TaskOptions, Write } from '../write.js';
import { MEMORY_FACTORS } from './memory.js';
import { writeOf } from './saving.js';
import { withLocksIgnored } from './shared.js';
import { queueCommit } from './write.js';

/** What `draw.undo` and `draw.redo` are made with */
export interface History {
  undo(options?: TaskOptions): Write<void>;
  redo(options?: TaskOptions): Write<void>;
  /** Drops every step */
  clear(): void;
  /**
   * Drops the steps of commits the storage refused (those of the commits that took them back or
   * made them again included): they are taken out of the document
   */
  drop(commits: ReadonlySet<string>): void;
  /** Gives the features of the steps the IDs the storage gave them, from the old to the new */
  rename(ids: ReadonlyMap<string, string>): void;
  /** Stops following the Store */
  stop(): void;
  /** The steps there are to take back and to make again */
  state(): HistoryState;
  /**
   * Calls `listener` each time the steps change
   *
   * @returns The function that stops calling it
   */
  onChange(listener: () => void): () => void;
}

/** The limits of the steps kept */
export interface HistoryOptions {
  /** The most steps kept, the oldest let go of first; 0 for no local undo */
  readonly maxSteps?: number;
  /**
   * The bytes the steps to take back and to make again keep, as one budget (an estimate): past
   * it, the oldest steps are let go of first, the last one kept. No limit when it is left out
   */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_STEPS = 100;

/** The state when there is no step of undo */
const NO_STEPS: HistoryState = {
  canUndo: false,
  canRedo: false,
  undoLabel: undefined,
  redoLabel: undefined,
};

/** What takes one notification of the Store back */
interface Inverse {
  readonly layersCreated: string[];
  readonly layersDeleted: StoredLayer[];
  readonly layersBefore: Map<string, StoredLayer>;
  readonly layerOrder: string[] | null;
  readonly groupsCreated: string[];
  readonly groupsDeleted: StoredGroup[];
  readonly groupsBefore: Map<string, StoredGroup>;
  readonly featuresCreated: string[];
  readonly featuresDeleted: StoredFeature[];
  readonly featuresBefore: Map<string, StoredFeature>;
  readonly moves: readonly ItemOrderChange[];
  readonly metadata: { readonly previous: Metadata; readonly now: Metadata } | null;
  readonly filesCreated: string[];
  readonly filesDeleted: FileData[];
  /** The values of the rows before (the rows deleted come back with them) */
  readonly rowsBefore: RowValues | null;
  /** The handles of the rows created, by layer (copied, read only when the step is taken) */
  readonly rowsCreated: Int32Array[];
  /** What keeps the rows the commit deleted */
  readonly token: number | undefined;
}

/** A step: the inverses of its notifications, in the order they came */
interface Step {
  readonly label: string | undefined;
  /** The ID of the commit it takes back (or makes again) */
  readonly commit: string | undefined;
  readonly parts: Inverse[];
  /** An estimate of the bytes its parts keep, counted only under a limit of the bytes */
  bytes: number;
}

/**
 * Creates the history of the commits of this client
 *
 * @internal
 */
export function createHistory(store: Store, options: HistoryOptions | undefined): History {
  const maxSteps = options?.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxBytes = options?.maxBytes;
  const undoSteps: Step[] = [];
  const redoSteps: Step[] = [];
  // What a step being taken back or made again records: the step that reverses it
  let applying: { direction: 'undo' | 'redo'; parts: Inverse[] } | null = null;
  // A step whose commit is still being written over several tasks
  let open: Step | null = null;
  // The step the last undo or redo made, which a notification of it told after its commit (a
  // write of many rows the Store tells later) joins
  let taken: { direction: 'undo' | 'redo'; step: Step } | null = null;

  const release = (step: Step): void => {
    const tables = store.tables;
    if (!tables) return;
    for (const part of step.parts)
      if (part.token !== undefined) tables.release(part.token as never);
  };
  const dropAll = (steps: Step[]): void => {
    for (const step of steps.splice(0)) release(step);
  };
  /** Adds a part to a step, and counts its bytes under a limit of the bytes */
  const addPart = (step: Step, inverse: Inverse): void => {
    step.parts.push(inverse);
    if (maxBytes !== undefined) step.bytes += inverseBytes(store, inverse);
  };
  /**
   * Keeps the steps within the limit of the bytes: the oldest step to take back is let go of
   * first, then the farthest one to make again, the last one kept
   *
   * @returns Whether a step was let go of
   */
  const keepBytes = (): boolean => {
    if (maxBytes === undefined) return false;
    let total = 0;
    for (const step of undoSteps) total += step.bytes;
    for (const step of redoSteps) total += step.bytes;
    let dropped = false;
    while (total > maxBytes && undoSteps.length + redoSteps.length > 1) {
      const step = (undoSteps.length > 1 ? undoSteps : redoSteps).shift() as Step;
      total -= step.bytes;
      release(step);
      if (open === step) open = null;
      if (taken?.step === step) taken = null;
      dropped = true;
    }
    return dropped;
  };
  const listeners = new Set<() => void>();
  let told: HistoryState = NO_STEPS;
  const state = (): HistoryState => {
    const undoStep = undoSteps[undoSteps.length - 1] as Step | undefined;
    const redoStep = redoSteps[redoSteps.length - 1] as Step | undefined;
    const now: HistoryState = {
      canUndo: undoStep !== undefined,
      canRedo: redoStep !== undefined,
      undoLabel: undoStep?.label,
      redoLabel: redoStep?.label,
    };
    if (
      now.canUndo === told.canUndo &&
      now.canRedo === told.canRedo &&
      now.undoLabel === told.undoLabel &&
      now.redoLabel === told.redoLabel
    ) {
      return told;
    }
    told = now;
    return now;
  };
  /** Tells the listeners once the steps changed */
  const changed = (): void => {
    const was = told;
    if (state() === was) return;
    for (const listener of [...listeners]) listener();
  };

  const follow = (change: StoreChange): void => {
    if (applying) {
      const inverse = inverseOf(change);
      if (inverse) applying.parts.push(inverse);
      return;
    }
    const source = change.source ?? 'local';
    if (source === 'remote' || source === 'silent' || source === 'refused') return;
    if (source === 'undo' || source === 'redo') {
      const inverse = taken?.direction === source ? inverseOf(change) : null;
      if (taken && inverse) {
        addPart(taken.step, inverse);
        if (keepBytes()) changed();
      }
      return;
    }
    if (source === 'open' || change.reset === true) {
      open = null;
      taken = null;
      dropAll(undoSteps);
      dropAll(redoSteps);
      changed();
      return;
    }
    const commit = commitOf(store);
    if (commit && !commit.undo) return;
    const inverse = inverseOf(change);
    if (!inverse) return;
    taken = null;
    if (open) {
      addPart(open, inverse);
      if (keepBytes()) changed();
    } else {
      open = { label: commit?.label, commit: commit?.id, parts: [], bytes: 0 };
      addPart(open, inverse);
      undoSteps.push(open);
      while (undoSteps.length > maxSteps) {
        const dropped = undoSteps.shift();
        if (dropped) release(dropped);
      }
      dropAll(redoSteps);
      keepBytes();
      changed();
    }
    if (!store.slicedWritePending) open = null;
  };
  // No local undo: the commits are not followed
  const stopListening = maxSteps === 0 ? () => {} : store.subscribe(follow);

  const take = (direction: 'undo' | 'redo', taskOptions?: TaskOptions): Write<void> => {
    const id = createId();
    const result = (async () => {
      // A write over several tasks under way is finished first: it is the last step
      store.finishSlicedWrite();
      open = null;
      if (taskOptions?.signal?.aborted) {
        throw new DrawError('aborted', `The ${direction} was stopped by its signal`);
      }
      return queueCommit(store, () => {
        const from = direction === 'undo' ? undoSteps : redoSteps;
        const step = from.pop();
        if (!step) throw new DrawError('invalidState', `There is nothing to ${direction}`);
        if (store.isReadOnly()) {
          from.push(step);
          throw new DrawError('notEditable', 'The document is read-only');
        }
        const parts: Inverse[] = [];
        applying = { direction, parts };
        try {
          runCommit(store, { id, label: step.label, undo: false }, direction, () =>
            withLocksIgnored(store, () => {
              for (let i = step.parts.length - 1; i >= 0; i--) applyInverse(store, step.parts[i]);
            }),
          );
        } finally {
          applying = null;
        }
        release(step);
        // Its parts in the order they were told: taken back from the last one, as a step is
        let bytes = 0;
        if (maxBytes !== undefined) for (const part of parts) bytes += inverseBytes(store, part);
        const reversed: Step = { label: step.label, commit: id, parts, bytes };
        (direction === 'undo' ? redoSteps : undoSteps).push(reversed);
        taken = { direction, step: reversed };
        keepBytes();
        changed();
        // A step of many rows is written over several tasks: it settles once its last rows are
        // written, so that what reads after it reads them
        const result = { value: undefined, skipped: 0 };
        return store.slicedWritePending ? store.whenWritten().then(() => result) : result;
      });
    })();
    return writeOf(store, id, result);
  };

  return {
    undo: (taskOptions) => take('undo', taskOptions),
    redo: (taskOptions) => take('redo', taskOptions),
    clear() {
      open = null;
      taken = null;
      dropAll(undoSteps);
      dropAll(redoSteps);
      changed();
    },
    drop(commits) {
      let dropped = false;
      for (const steps of [undoSteps, redoSteps]) {
        for (let i = steps.length - 1; i >= 0; i--) {
          const step = steps[i];
          if (step.commit === undefined || !commits.has(step.commit)) continue;
          steps.splice(i, 1);
          release(step);
          if (open === step) open = null;
          if (taken?.step === step) taken = null;
          dropped = true;
        }
      }
      if (dropped) changed();
    },
    rename(ids) {
      if (ids.size === 0) return;
      for (const steps of [undoSteps, redoSteps]) {
        for (const step of steps) {
          for (let i = 0; i < step.parts.length; i++)
            step.parts[i] = renamedInverse(step.parts[i], ids);
        }
      }
    },
    stop() {
      stopListening();
      dropAll(undoSteps);
      dropAll(redoSteps);
      listeners.clear();
    },
    state,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ============================================================================
// What takes a notification back
// ============================================================================

/**
 * An estimate of the bytes a part of a step keeps: its features, layers, groups, files and
 * metadata as values, the values of its rows and their handles, and the rows it deleted, which
 * the Store keeps for it (as many bytes as a row of the document takes, on average)
 */
function inverseBytes(store: Store, inverse: Inverse): number {
  const { token, ...kept } = inverse;
  let n = valueBytes(kept);
  const before = inverse.rowsBefore;
  if (token !== undefined && before) {
    let deleted = before.rows.length;
    if (before.deleted) {
      deleted = 0;
      for (const flag of before.deleted) if (flag !== 0) deleted++;
    }
    const size = featureTablesInternals(store.tables)?.size();
    const positions = size && size.rows > 0 ? size.positions / size.rows : 0;
    const { jsPerFeature, jsPerPosition } = MEMORY_FACTORS.rows;
    n += Math.round(deleted * (jsPerFeature + positions * jsPerPosition));
  }
  return n;
}

/**
 * An estimate of the bytes a value takes in the heap: 8 for a number and the like, 2 for each
 * character of a string, the bytes of a typed array, and the sum of the members of an array, a
 * map and an object (with their keys)
 */
function valueBytes(value: unknown): number {
  if (typeof value === 'string') return 16 + value.length * 2;
  if (value === null || typeof value !== 'object') return 8;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  let n = 16;
  if (Array.isArray(value)) {
    for (const item of value) n += valueBytes(item);
    return n;
  }
  if (value instanceof Map) {
    for (const [key, item] of value) n += valueBytes(key) + valueBytes(item);
    return n;
  }
  for (const key in value) {
    n += valueBytes(key) + valueBytes((value as Record<string, unknown>)[key]);
  }
  return n;
}

/** The first value of each ID: what it was before its first write of the notification */
function firstOf<T>(entries: readonly { id: string; previous: T }[] | undefined): Map<string, T> {
  const out = new Map<string, T>();
  for (const { id, previous } of entries ?? []) if (!out.has(id)) out.set(id, previous);
  return out;
}

/** What takes a notification of the Store back; null for one that changed nothing of the document */
function inverseOf(change: StoreChange): Inverse | null {
  const { features, layers, groups } = change;
  const rows = change.rows;
  // Only the handles are kept: nothing is read of the rows until the step is taken
  const rowsCreated: Int32Array[] = [];
  for (const layer of rows?.layers.values() ?? []) {
    if (layer.created.length > 0) rowsCreated.push(layer.created.slice());
  }
  const inverse: Inverse = {
    layersCreated: (layers?.created ?? []).map((layer) => layer.id),
    layersDeleted: [...(layers?.deleted ?? [])],
    layersBefore: firstOf(layers?.updated),
    layerOrder: layers?.orderChanged ? [...layers.orderChanged.previous] : null,
    groupsCreated: (groups?.created ?? []).map((group) => group.id),
    groupsDeleted: [...(groups?.deleted ?? [])],
    groupsBefore: firstOf(groups?.updated),
    featuresCreated: (features?.created ?? []).map((feature) => feature.id),
    featuresDeleted: [...(features?.deleted ?? [])],
    featuresBefore: firstOf(features?.updated),
    moves: [...(change.order ?? [])],
    metadata: change.metadata
      ? { previous: change.metadata.previous, now: change.metadata.metadata }
      : null,
    filesCreated: (change.files?.created ?? []).map((file) => file.id),
    filesDeleted: [...(change.files?.deleted ?? [])],
    rowsBefore: (change.previousValues as RowValues | undefined) ?? null,
    rowsCreated,
    token: change.restoreToken as number | undefined,
  };
  const empty =
    inverse.layersCreated.length +
      inverse.layersDeleted.length +
      inverse.layersBefore.size +
      inverse.groupsCreated.length +
      inverse.groupsDeleted.length +
      inverse.groupsBefore.size +
      inverse.featuresCreated.length +
      inverse.featuresDeleted.length +
      inverse.featuresBefore.size +
      inverse.moves.length +
      inverse.filesCreated.length +
      inverse.filesDeleted.length +
      inverse.rowsCreated.length ===
      0 &&
    inverse.layerOrder === null &&
    inverse.metadata === null &&
    inverse.rowsBefore === null;
  return empty ? null : inverse;
}

/** The fields of a feature without its place (its place is put back by the moves) */
function featureFields(feature: StoredFeature): Partial<StoredFeature> {
  const { id: _id, layerId: _layer, groupId: _group, ...fields } = feature;
  return fields;
}

/** Takes one notification back, in the transaction of the caller */
function applyInverse(store: Store, inverse: Inverse): void {
  const tables = store.tables;
  // 1. What was deleted comes back: the layers, the groups, then the features in them
  for (const layer of inverse.layersDeleted) {
    if (store.getLayer(layer.id)) continue;
    store.createLayer(
      'items' in layer ? ({ ...layer, items: [] } as StoredLayer) : ({ ...layer } as StoredLayer),
    );
  }
  for (const group of inverse.groupsDeleted) {
    if (!store.getGroup(group.id)) createGroupAgain(store, group);
  }
  for (const feature of inverse.featuresDeleted) {
    if (store.getFeature(feature.id)) continue;
    const groupId =
      feature.groupId && store.getGroup(feature.groupId) ? feature.groupId : undefined;
    store.createFeature({ ...feature, groupId });
  }
  for (const file of inverse.filesDeleted) store.createFile(file);

  // 2. The rows: their values before (a row deleted comes back with them), then the rows created
  // deleted again
  if (tables && inverse.rowsBefore && inverse.rowsBefore.rows.length > 0) {
    store.restoreRows(inverse.rowsBefore);
  }

  // 3. What was changed is written back
  for (const [id, before] of inverse.featuresBefore) {
    if (store.getFeature(id)) store.updateFeature(id, featureFields(before));
  }
  for (const [id, before] of inverse.groupsBefore) {
    if (!store.getGroup(id)) continue;
    const { id: _id, ...fields } = before as StoredGroup & { featureIds?: unknown };
    // Its layer and its members are put back by the moves
    delete (fields as { featureIds?: unknown }).featureIds;
    delete (fields as { layerId?: unknown }).layerId;
    delete (fields as { kind?: unknown }).kind;
    store.updateGroup(id, fields);
  }
  for (const [id, before] of inverse.layersBefore) {
    if (!store.getLayer(id)) continue;
    const { id: _id, ...fields } = before as StoredLayer & { items?: unknown };
    delete (fields as { items?: unknown }).items;
    delete (fields as { kind?: unknown }).kind;
    store.updateLayer(id, fields);
  }

  // 4. The items put in another place go back, from the last one. A group deleted is created
  // again with the key it had in a Store that keeps the keys of the order (1.): it is not moved.
  // A group deleted and created again (updated: there before the commit and after it) that the
  // items going back left empty, and so deleted, is created again as it was before the commit
  // where its deletion is taken back (in a Store that keeps the keys of the order, with the key it
  // had: it is not moved either)
  // A row put back in such a group after the items going back left it empty (a row created and
  // put in the group: it goes back to where it was created, then into the group) finds it created
  // again the same way first
  const groupsBack = new Set(inverse.groupsDeleted.map((group) => group.id));
  const restorePlaces = (before: RowValues): void => {
    for (const parent of before.fields.get('parent') ?? []) {
      if (typeof parent !== 'string' || store.getGroup(parent) || store.getLayer(parent)) continue;
      const group = inverse.groupsBefore.get(parent);
      if (group) createGroupAgain(store, group);
    }
    store.restoreRows(before);
  };
  for (let i = inverse.moves.length - 1; i >= 0; i--) {
    const move = inverse.moves[i];
    if (move.kind === 'item' && move.to === null && !store.getGroup(move.itemId)) {
      const before = inverse.groupsBefore.get(move.itemId);
      if (before) {
        createGroupAgain(store, before);
        if (tables) continue;
      }
    }
    if (tables && move.kind === 'item' && move.to === null && groupsBack.has(move.itemId)) {
      continue;
    }
    if (move.kind === 'rows') {
      if (tables) restorePlaces(move.before);
      continue;
    }
    if (move.before && tables) {
      restorePlaces(move.before);
      continue;
    }
    const from = move.from;
    if (!from) continue;
    const there = store.getFeature(move.itemId) ?? store.getGroup(move.itemId);
    if (!there || !store.getLayer(from.layerId)) continue;
    const placement = {
      layerId: from.layerId,
      ...(from.groupId !== undefined && store.getGroup(from.groupId) && { groupId: from.groupId }),
      below: neighbor(store, from.below),
      above: neighbor(store, from.above),
    };
    try {
      store.moveItem?.(move.itemId, placement);
    } catch {
      store.moveItem?.(move.itemId, { layerId: from.layerId, below: null, above: null });
    }
  }
  if (inverse.layerOrder) {
    const order = inverse.layerOrder.filter(
      (id) => store.getLayer(id) !== undefined || !inverse.layersCreated.includes(id),
    );
    for (const id of store.getLayerOrder()) if (!order.includes(id)) order.push(id);
    store.setLayerOrder(order);
  }

  // 5. What was created goes
  if (tables && inverse.rowsCreated.length > 0) {
    // The rows still there (a row the step made is written deleted)
    const handles: number[] = [];
    for (const created of inverse.rowsCreated) {
      for (const handle of created) {
        const id = tables.getRowId(handle);
        if (id !== undefined && tables.getRowRef(id) === handle) handles.push(handle);
      }
    }
    if (handles.length > 0) {
      store.restoreRows({
        rows: Int32Array.from(handles),
        fields: new Map(),
        deleted: new Uint8Array(handles.length).fill(1),
      } as RowValues);
    }
  }
  // A restore of many rows under way is written first: the groups it leaves empty are deleted
  // with it, and are no longer there to delete
  if (inverse.groupsCreated.length > 0) store.finishRowSteps();
  for (const id of inverse.featuresCreated) if (store.getFeature(id)) store.deleteFeature(id);
  for (const id of inverse.groupsCreated) if (store.getGroup(id)) store.deleteGroup(id);
  for (const id of inverse.layersCreated) if (store.getLayer(id)) store.deleteLayer(id);
  for (const id of inverse.filesCreated) store.deleteFile(id);

  // 6. The metadata
  if (inverse.metadata) {
    const patch: Record<string, unknown> = { ...inverse.metadata.previous };
    for (const key of Object.keys(inverse.metadata.now))
      if (!(key in patch)) patch[key] = undefined;
    store.setMetadata(patch as Partial<Metadata>);
  }
}

/**
 * Creates a group again as it was, with no member (its members go back by the moves and the
 * values of the rows)
 */
function createGroupAgain(store: Store, group: StoredGroup): void {
  if ('featureIds' in group) {
    store.createGroup({ ...group, featureIds: [] } as StoredGroup);
  } else {
    store.createGroup({ ...group } as StoredGroup);
  }
}

/** An item next to which an item goes back, when it is still there (else the end) */
function neighbor(store: Store, id: string | null): string | null {
  if (id === null) return null;
  return store.getFeature(id) !== undefined || store.getGroup(id) !== undefined ? id : null;
}

// ============================================================================
// The IDs the storage gave
// ============================================================================

/** A part of a step with the features named by the IDs the storage gave them */
function renamedInverse(part: Inverse, ids: ReadonlyMap<string, string>): Inverse {
  const id = (one: string): string => ids.get(one) ?? one;
  const idOrNull = (one: string | null): string | null => (one === null ? null : id(one));
  const feature = (one: StoredFeature): StoredFeature =>
    ids.has(one.id) ? { ...one, id: id(one.id) } : one;
  const group = (one: StoredGroup): StoredGroup =>
    one.kind === 'table' ? one : { ...one, featureIds: one.featureIds.map(id) };
  const layer = (one: StoredLayer): StoredLayer =>
    one.kind === 'table' ? one : { ...one, items: one.items.map(id) };
  const position = <T extends { below: string | null; above: string | null } | null>(at: T): T =>
    at === null ? at : { ...at, below: idOrNull(at.below), above: idOrNull(at.above) };
  const moves = part.moves.map((move) => {
    if (move.kind !== 'item') return move;
    return { ...move, itemId: id(move.itemId), from: position(move.from), to: position(move.to) };
  });
  const groupsBefore = new Map([...part.groupsBefore].map(([key, value]) => [key, group(value)]));
  const layersBefore = new Map([...part.layersBefore].map(([key, value]) => [key, layer(value)]));
  return {
    ...part,
    layersDeleted: part.layersDeleted.map(layer),
    layersBefore,
    groupsDeleted: part.groupsDeleted.map(group),
    groupsBefore,
    featuresCreated: part.featuresCreated.map(id),
    featuresDeleted: part.featuresDeleted.map(feature),
    featuresBefore: new Map(
      [...part.featuresBefore].map(([key, value]) => [id(key), feature(value)]),
    ),
    moves,
  };
}
