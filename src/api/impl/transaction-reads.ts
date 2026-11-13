// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The reads of a transaction: the document committed with what the transaction wrote over it
 *
 * A transaction keeps its writes until its function ends, and makes them at its commit. Its reads
 * (`tx.features.list`, `count`, `bbox`, `tx.layers.listItems`, `tx.groups.listMembers`...) read the
 * document the reads of the instance read (the one committed: the one before a commit over several
 * tasks until its last step) with its writes over it, as they will be once it is committed:
 *
 * - The features it created, changed, put elsewhere or deleted, by their IDs or as rows selected in
 *   bulk, read as it wrote them (`Overlay`, in `write.ts`)
 * - The order: the writes that change it (a creation, a placement, a deletion, a group made, put
 *   elsewhere, the result of an operation on areas) are kept in their order, and played over the
 *   order of the rows of each layer when a read needs it, by the rules the Store puts items by: a
 *   new feature at the front of its layer or of its group, an item put by the items just below or
 *   above it, a group made where its frontmost member was, a result in the place of its input
 *
 * What an import writes is known at the commit only: the reads of the transaction do not see it.
 * The rows the transaction did not write are read where they are, without making features.
 */

import type { TableSelection } from '../../feature-table/selection.js';
import type { ItemPlacement } from '../../shared/types/model.js';
import { layerIdsInOrder } from '../../store/feature-stream.js';
import { type DocumentSnapshot, snapshotOf } from '../../store/read-snapshot.js';
import type { Store } from '../../store/store.js';
import type {
  Feature as StoredFeature,
  Group as StoredGroup,
  Layer as StoredLayer,
} from '../../store/types.js';

/**
 * A write of a transaction that changes the order of the items, kept in the order of the writes
 *
 * @internal
 */
export type OrderWrite =
  /** Features deleted */
  | { readonly kind: 'remove'; readonly ids: readonly string[] }
  /** Rows deleted (features selected in bulk) */
  | { readonly kind: 'removeRows'; readonly rows: TableSelection }
  /** Features created (`created`) or put in a place, one after the other in their order */
  | {
      readonly kind: 'put';
      readonly ids: readonly string[];
      readonly to: ItemPlacement;
      readonly created?: boolean;
    }
  /** Rows put in a place, one after the other in their order */
  | { readonly kind: 'putRows'; readonly rows: TableSelection; readonly to: ItemPlacement }
  /** Features taken out of their groups: just in front of their group, in their order */
  | { readonly kind: 'ungroup'; readonly ids: readonly string[] }
  /** A group made of features, where its frontmost member was */
  | { readonly kind: 'group'; readonly groupId: string; readonly members: readonly string[] }
  /** A group put in a place, its members with it */
  | { readonly kind: 'putGroup'; readonly groupId: string; readonly to: ItemPlacement }
  /**
   * Results of an operation on features: the first just in front of its input (`anchor`), each
   * other just in front of the one before; then the inputs removed
   */
  | {
      readonly kind: 'result';
      readonly anchor: string;
      readonly ids: readonly string[];
      readonly removed: readonly string[];
    };

/**
 * What a transaction wrote over the document, as its reads read it
 *
 * @internal
 */
export interface OverlayState {
  readonly features: ReadonlyMap<string, StoredFeature | null>;
  readonly groups: ReadonlyMap<string, StoredGroup | null>;
  readonly layers: ReadonlyMap<string, StoredLayer | null>;
  readonly members: ReadonlyMap<string, string>;
  readonly bulk: ReadonlyArray<{ readonly rows: TableSelection }>;
  /** The writes that change the order, in their order */
  readonly order: readonly OrderWrite[];
  /** The Store with what the transaction wrote over it (its features, layers, groups) */
  readonly view: Store;
  /** Changes with every write of the transaction */
  readonly version: number;
}

/** A feature in the order of a layer as the transaction reads it */
interface Entry {
  readonly id: string;
  /** Its row (-1 for a feature the transaction created) */
  readonly handle: number;
  /** Its feature as the document committed reads it, when it differs from its row (else null) */
  readonly base: StoredFeature | null;
  /** Its group as the transaction reads it */
  groupId: string | undefined;
  /** Its layer and its group in the document committed (a feature put elsewhere is read anew) */
  readonly baseLayerId: string | undefined;
  readonly baseGroupId: string | undefined;
  /** Taken out (deleted, or put elsewhere) */
  gone: boolean;
}

/**
 * The reads of a transaction, as a snapshot: what the reads of the document of the instance read
 * a transaction through (`readThroughSnapshot`)
 *
 * @param base - The Store as the reads of the instance read it (`publishedStore`)
 * @internal
 */
export function transactionReads(base: Store, state: OverlayState): DocumentSnapshot {
  let played: { version: number; layers: Map<string, Entry[]> } | null = null;
  const tables = (): NonNullable<Store['tables']> => base.tables as NonNullable<Store['tables']>;
  /** The snapshot the document committed is read from (a commit over several tasks under way) */
  const baseSnapshot = (): DocumentSnapshot | undefined => snapshotOf(base);
  const read = <T>(fn: () => T): T => {
    const snapshot = baseSnapshot();
    return snapshot ? snapshot.read(fn) : fn();
  };
  const groupsDeleted = (): ReadonlySet<string> => {
    const out = new Set<string>();
    for (const [id, group] of state.groups) if (group === null) out.add(id);
    return out;
  };

  /** The rows of a layer in the order of the document committed, as `DocumentSnapshot` visits */
  const forEachBaseRow = (
    layerId: string,
    visit: (handle: number, changed: StoredFeature | null) => boolean,
  ): boolean => {
    const snapshot = baseSnapshot();
    if (snapshot) return snapshot.forEachRow(layerId, visit);
    const cursor = tables().scan({ layerIds: [layerId] });
    for (let batch = cursor.next(); batch; batch = cursor.next()) {
      for (const handle of batch) if (!visit(handle, null)) return false;
    }
    return true;
  };

  /** The group of a row as the document committed reads it */
  const baseGroupOf = (handle: number, changed: StoredFeature | null): string | undefined => {
    if (changed) return changed.groupId;
    const snapshot = baseSnapshot();
    if (snapshot) return snapshot.groupOfRow(handle);
    const id = tables().getRowId(handle);
    return id === undefined ? undefined : base.getFeature(id)?.groupId;
  };

  /** Whether the transaction wrote a feature of a row (or the group it is in) */
  const touchedOf = (): ((id: string, handle: number, groupId: string | undefined) => boolean) => {
    const deleted = groupsDeleted();
    return (id, handle, groupId) =>
      state.features.has(id) ||
      state.members.has(id) ||
      (handle >= 0 && state.bulk.some(({ rows }) => rows.has(handle))) ||
      (groupId !== undefined && deleted.has(groupId));
  };

  /** Plays the writes that change the order over the rows of every layer */
  const play = (): Map<string, Entry[]> => {
    if (played && played.version === state.version) return played.layers;
    const layers = new Map<string, Entry[]>();
    const byId = new Map<string, { layerId: string; entry: Entry }>();
    const byHandle = new Map<number, Entry>();
    const ids = tables();
    const layerOf = (layerId: string): Entry[] => {
      let list = layers.get(layerId);
      if (!list) {
        list = [];
        layers.set(layerId, list);
      }
      return list;
    };
    for (const layerId of layerIdsInOrder(base)) {
      const list = layerOf(layerId);
      forEachBaseRow(layerId, (handle, changed) => {
        const id = changed ? changed.id : (ids.getRowId(handle) as string);
        const groupId = baseGroupOf(handle, changed);
        const entry: Entry = {
          id,
          handle,
          base: changed,
          groupId,
          baseLayerId: layerId,
          baseGroupId: groupId,
          gone: false,
        };
        list.push(entry);
        byId.set(id, { layerId, entry });
        byHandle.set(handle, entry);
        return true;
      });
    }
    const take = (id: string): Entry | undefined => {
      const found = byId.get(id);
      if (!found || found.entry.gone) return undefined;
      found.entry.gone = true;
      byId.delete(id);
      return found.entry;
    };
    /** The entries of features in the order they stand now (by layer, then in each layer) */
    const inOrder = (wanted: readonly string[]): string[] => {
      const set = new Set(wanted);
      const out: string[] = [];
      for (const list of layers.values()) {
        for (const entry of list) if (!entry.gone && set.has(entry.id)) out.push(entry.id);
      }
      // The ones not there yet (created) after, in the order given
      for (const id of wanted) if (!byId.has(id)) out.push(id);
      return out;
    };
    /** Puts entries in a place, one after the other */
    const put = (entries: Entry[], to: ItemPlacement): void => {
      const list = layerOf(to.layerId);
      for (const entry of entries) entry.groupId = to.groupId;
      const at = placeIndex(list, to);
      const made = entries.map((entry) => ({ ...entry, gone: false }));
      list.splice(at, 0, ...made);
      for (const entry of made) {
        byId.set(entry.id, { layerId: to.layerId, entry });
        if (entry.handle >= 0) byHandle.set(entry.handle, entry);
      }
    };
    for (const write of state.order) {
      switch (write.kind) {
        case 'remove':
          for (const id of write.ids) take(id);
          break;
        case 'removeRows':
          for (const handle of write.rows.handles) {
            const entry = byHandle.get(handle);
            if (entry && !entry.gone) take(entry.id);
          }
          break;
        case 'put': {
          const entries: Entry[] = [];
          for (const id of write.created ? write.ids : inOrder(write.ids)) {
            const entry = write.created
              ? {
                  id,
                  handle: -1,
                  base: null,
                  groupId: undefined,
                  baseLayerId: undefined,
                  baseGroupId: undefined,
                  gone: false,
                }
              : take(id);
            if (entry) entries.push(entry);
          }
          put(entries, write.to);
          break;
        }
        case 'putRows': {
          const named: string[] = [];
          for (const handle of write.rows.handles) {
            const entry = byHandle.get(handle);
            if (entry && !entry.gone) named.push(entry.id);
          }
          const entries = inOrder(named)
            .map((id) => take(id))
            .filter((entry): entry is Entry => entry !== undefined);
          put(entries, write.to);
          break;
        }
        case 'ungroup': {
          const blocks = new Map<string, string[]>();
          for (const id of inOrder(write.ids)) {
            const groupId = byId.get(id)?.entry.groupId;
            if (groupId === undefined) continue;
            const block = blocks.get(groupId) ?? [];
            block.push(id);
            blocks.set(groupId, block);
          }
          for (const [groupId, block] of blocks) {
            const layerId = byId.get(block[0])?.layerId as string;
            const list = layerOf(layerId);
            // Just in front of the group: after its last member, the ones taken out included
            let at = list.length;
            for (let i = list.length - 1; i >= 0; i--) {
              if (!list[i].gone && list[i].groupId === groupId) {
                at = i + 1;
                break;
              }
            }
            const entries = block
              .map((id) => take(id))
              .filter((entry): entry is Entry => entry !== undefined);
            const made = entries.map((entry) => ({ ...entry, groupId: undefined, gone: false }));
            list.splice(at, 0, ...made);
            for (const entry of made) {
              byId.set(entry.id, { layerId, entry });
              if (entry.handle >= 0) byHandle.set(entry.handle, entry);
            }
          }
          break;
        }
        case 'group': {
          const members = inOrder(write.members);
          const front = members[members.length - 1];
          const found = front === undefined ? undefined : byId.get(front);
          if (!found) break;
          const list = layerOf(found.layerId);
          const set = new Set(members);
          // Where the frontmost member was, among the items that stay
          const frontAt = list.indexOf(found.entry);
          let at = 0;
          for (let i = 0; i < frontAt; i++) if (!list[i].gone && !set.has(list[i].id)) at++;
          const entries = members
            .map((id) => take(id))
            .filter((entry): entry is Entry => entry !== undefined);
          const kept = list.filter((entry) => !entry.gone);
          const made = entries.map((entry) => ({ ...entry, groupId: write.groupId, gone: false }));
          kept.splice(Math.min(at, kept.length), 0, ...made);
          layers.set(found.layerId, kept);
          for (const entry of made) {
            byId.set(entry.id, { layerId: found.layerId, entry });
            if (entry.handle >= 0) byHandle.set(entry.handle, entry);
          }
          break;
        }
        case 'putGroup': {
          const members: string[] = [];
          for (const list of layers.values()) {
            for (const entry of list) {
              if (!entry.gone && entry.groupId === write.groupId) members.push(entry.id);
            }
          }
          const entries = members
            .map((id) => take(id))
            .filter((entry): entry is Entry => entry !== undefined);
          put(entries, { ...write.to, groupId: write.groupId });
          break;
        }
        case 'result': {
          const anchor = byId.get(write.anchor);
          if (!anchor) break;
          const list = layerOf(anchor.layerId);
          let at = list.indexOf(anchor.entry) + 1;
          for (const id of write.ids) {
            const entry: Entry = {
              id,
              handle: -1,
              base: null,
              groupId: anchor.entry.groupId,
              baseLayerId: undefined,
              baseGroupId: undefined,
              gone: false,
            };
            list.splice(at, 0, entry);
            byId.set(id, { layerId: anchor.layerId, entry });
            at++;
          }
          for (const id of write.removed) take(id);
          break;
        }
      }
    }
    // The members of a group the transaction deleted, keeping them, are items of their layer
    const deleted = groupsDeleted();
    for (const [layerId, list] of layers) {
      const kept = list.filter((entry) => !entry.gone);
      if (deleted.size > 0) {
        for (const entry of kept) {
          if (entry.groupId !== undefined && deleted.has(entry.groupId)) entry.groupId = undefined;
        }
      }
      layers.set(layerId, kept);
    }
    played = { version: state.version, layers };
    return layers;
  };

  return {
    getFeature: (id) => state.view.getFeature(id),
    getLayer: (id) => state.view.getLayer(id),
    listLayers: () => state.view.listLayers(),
    getLayerOrder: () => state.view.getLayerOrder(),
    getGroup: (id) => state.view.getGroup(id),
    listGroups: () => {
      const out = base.listGroups().filter((group) => state.groups.get(group.id) !== null);
      for (const [id, group] of state.groups) {
        if (group !== null && !out.some((other) => other.id === id)) out.push(group);
      }
      return out.map((group) => state.groups.get(group.id) ?? group);
    },
    getMetadata: () => base.getMetadata(),
    read,
    groupOfRow: (handle) => {
      const snapshot = baseSnapshot();
      if (snapshot) return snapshot.groupOfRow(handle);
      const id = tables().getRowId(handle);
      return id === undefined ? undefined : base.getFeature(id)?.groupId;
    },
    forEachRow(layerId, visit) {
      return read(() => {
        const touched = touchedOf();
        if (state.order.length === 0) {
          const ids = tables();
          return forEachBaseRow(layerId, (handle, changed) => {
            const id = changed ? changed.id : (ids.getRowId(handle) as string);
            if (!touched(id, handle, baseGroupOf(handle, changed))) return visit(handle, changed);
            const feature = state.view.getFeature(id);
            return feature === undefined || visit(handle, feature);
          });
        }
        for (const entry of play().get(layerId) ?? []) {
          // A feature written, or put in another layer or group, is read as the transaction reads it
          const changed =
            entry.handle < 0 ||
            entry.baseLayerId !== layerId ||
            entry.groupId !== entry.baseGroupId ||
            touched(entry.id, entry.handle, entry.baseGroupId)
              ? state.view.getFeature(entry.id)
              : entry.base;
          if (changed === undefined) continue;
          if (!visit(entry.handle, changed)) return false;
        }
        return true;
      });
    },
  };
}

/**
 * Where items put in a place go in the order of a layer: by the item just below or above them
 * (the members of a group as one item), at the front or the back of the layer or of the group
 */
function placeIndex(list: readonly Entry[], to: ItemPlacement): number {
  const live = (i: number): boolean => !list[i].gone;
  const isItem = (entry: Entry, id: string): boolean => entry.id === id || entry.groupId === id;
  if (typeof to.below === 'string') {
    const below = to.below;
    for (let i = list.length - 1; i >= 0; i--) if (live(i) && isItem(list[i], below)) return i + 1;
  }
  if (typeof to.above === 'string') {
    const above = to.above;
    for (let i = 0; i < list.length; i++) if (live(i) && isItem(list[i], above)) return i;
  }
  const inGroup = (i: number): boolean => live(i) && list[i].groupId === to.groupId;
  const back = to.below === null && to.above === undefined;
  if (to.groupId !== undefined) {
    if (back) {
      for (let i = 0; i < list.length; i++) if (inGroup(i)) return i;
    } else {
      for (let i = list.length - 1; i >= 0; i--) if (inGroup(i)) return i + 1;
    }
  }
  return back ? 0 : list.length;
}
