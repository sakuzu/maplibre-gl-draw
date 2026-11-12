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

import type { FileData, Metadata } from '../../shared/types/model.js';
import { createId } from '../../shared/utils/id.js';
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
import type { TaskOptions, Write } from '../write.js';
import { withLocksIgnored } from './shared.js';
import { commitOf, queueCommit, runCommit } from './write.js';

/** What `draw.undo` and `draw.redo` are made with */
export interface History {
  undo(options?: TaskOptions): Write<void>;
  redo(options?: TaskOptions): Write<void>;
  /** Drops every step */
  clear(): void;
  /** Stops following the Store */
  stop(): void;
}

/** The limits of the steps kept */
export interface HistoryOptions {
  /** The most steps kept, the oldest let go of first; 0 for no local undo */
  readonly maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 100;

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
  readonly parts: Inverse[];
}

/**
 * Creates the history of the commits of this client
 *
 * @internal
 */
export function createHistory(store: Store, options: HistoryOptions | undefined): History {
  const maxSteps = options?.maxSteps ?? DEFAULT_MAX_STEPS;
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

  const follow = (change: StoreChange): void => {
    if (applying) {
      const inverse = inverseOf(change);
      if (inverse) applying.parts.push(inverse);
      return;
    }
    const source = change.source ?? 'local';
    if (source === 'remote' || source === 'silent') return;
    if (source === 'undo' || source === 'redo') {
      const inverse = taken?.direction === source ? inverseOf(change) : null;
      if (taken && inverse) taken.step.parts.push(inverse);
      return;
    }
    if (source === 'open' || change.reset === true) {
      open = null;
      taken = null;
      dropAll(undoSteps);
      dropAll(redoSteps);
      return;
    }
    const commit = commitOf(store);
    if (commit && !commit.undo) return;
    const inverse = inverseOf(change);
    if (!inverse) return;
    taken = null;
    if (open) {
      open.parts.push(inverse);
    } else {
      open = { label: commit?.label, parts: [inverse] };
      undoSteps.push(open);
      while (undoSteps.length > maxSteps) {
        const dropped = undoSteps.shift();
        if (dropped) release(dropped);
      }
      dropAll(redoSteps);
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
        if (!step) throw new DrawError('invalid-state', `There is nothing to ${direction}`);
        if (store.isReadOnly()) {
          from.push(step);
          throw new DrawError('not-editable', 'The document is read-only');
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
        const reversed: Step = { label: step.label, parts };
        (direction === 'undo' ? redoSteps : undoSteps).push(reversed);
        taken = { direction, step: reversed };
        return { value: undefined, skipped: 0 };
      });
    })();
    const done = result.then(() => undefined);
    return Object.assign(done, { id, result }) as Write<void>;
  };

  return {
    undo: (taskOptions) => take('undo', taskOptions),
    redo: (taskOptions) => take('redo', taskOptions),
    clear() {
      open = null;
      taken = null;
      dropAll(undoSteps);
      dropAll(redoSteps);
    },
    stop() {
      stopListening();
      dropAll(undoSteps);
      dropAll(redoSteps);
    },
  };
}

// ============================================================================
// What takes a notification back
// ============================================================================

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
    if (store.getGroup(group.id)) continue;
    if ('featureIds' in group) {
      store.createGroup({ ...group, featureIds: [] } as StoredGroup);
    } else {
      store.createGroup({ ...group } as StoredGroup);
    }
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
  if (tables && inverse.rowsBefore && inverse.rowsBefore.handles.length > 0) {
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
  // again with the key it had in a Store that keeps the keys of the order (1.): it is not moved
  const groupsBack = new Set(inverse.groupsDeleted.map((group) => group.id));
  for (let i = inverse.moves.length - 1; i >= 0; i--) {
    const move = inverse.moves[i];
    if (tables && move.kind === 'item' && move.to === null && groupsBack.has(move.itemId)) {
      continue;
    }
    if (move.kind === 'rows') {
      if (tables) store.restoreRows(move.before);
      continue;
    }
    if (move.before && tables) {
      store.restoreRows(move.before);
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
        handles: Int32Array.from(handles),
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

/** An item next to which an item goes back, when it is still there (else the end) */
function neighbor(store: Store, id: string | null): string | null {
  if (id === null) return null;
  return store.getFeature(id) !== undefined || store.getGroup(id) !== undefined ? id : null;
}
