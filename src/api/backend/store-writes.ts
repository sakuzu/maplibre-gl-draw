// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Operations on values (`ValueOperation`) written to a Store, the keys of the order as they are:
 * what puts the document here as a storage of the first shape has it (the take-out of a commit it
 * refused, and what it sends from elsewhere)
 *
 * A layer of rows keeps the keys of its rows and groups in its tables: they are written there by
 * the writer of the rows. A layer of objects keeps lists: an item is put at the place its key
 * gives among the keys kept by `CommitValues`, and its key is kept there before the notification
 * of the write is read, so that it stays the key the storage has.
 *
 * The caller writes in one transaction of the Store; nothing here checks the locks nor read-only.
 *
 * @internal
 */

import { valueFromJSON } from '@sakuzu/tabane';
import { compareKeys } from '../../store/order-keys.js';
import type { Store } from '../../store/store.js';
import { tablesWriterOf } from '../../store/table-memory.js';
import type { Layer, Feature as StoredFeature } from '../../store/types.js';
import { storedFeatureOf } from '../impl/feature-shape.js';
import type { Feature, StyleRule } from '../model.js';
import type { RowField } from '../tables.js';
import type { CommitValues } from './commit-values.js';
import { type KeptRecords, type PlacementKeys, placementOf, withPlacement } from './kept.js';
import {
  type FeatureRecord,
  type GroupRecord,
  type LayerRecord,
  setFeature,
  type ValueOperation,
} from './values.js';

const FIELD_PREFIX = 'maplibre-gl-draw:';

/**
 * Writes operations to a Store, in their order, inside a transaction the caller opened: as the
 * storage applies them to the document it has (`applyOperations`), read by the rules of
 * `kept.ts`. What the document has that is not shown is kept in `kept`
 *
 * @param values - What keeps the keys of the items of the layers of objects, and of the layers
 * @param keepKeys - False for a commit of this client made of them (a refusal made again): the
 *   items of objects and the layers are put where their keys say, and take keys of their own
 * @param kept - What is kept aside (the one of `values` by default)
 */
export function writeOperations(
  store: Store,
  values: CommitValues,
  operations: readonly ValueOperation[],
  keepKeys = true,
  kept: KeptRecords = values.kept,
): { readonly failed: readonly unknown[] } {
  const writes = new StoreWrites(store, values, keepKeys, kept);
  // One that the Store refuses is left out: the others are written
  const failed: unknown[] = [];
  for (const operation of operations) {
    try {
      writes.write(operation);
    } catch (error) {
      failed.push(error);
    }
  }
  return { failed };
}

/**
 * Follows a commit of this client, which the Store already holds, in what is kept: what the
 * storage shows once it applies it that the Store does not (what was kept in a layer or a group it
 * made again), and what it keeps that the Store shows (a feature it made whose ID the storage
 * keeps). Writes to the Store inside a transaction the caller opened, only when something is kept
 *
 * @returns The features the commit made that the storage keeps as it had them (it leaves out
 *   their creation): taking the commit back does not delete them
 */
export function followCommit(
  store: Store,
  values: CommitValues,
  operations: readonly ValueOperation[],
): ReadonlySet<string> {
  const kept = new Set<string>();
  if (values.kept.empty) return kept;
  const writes = new StoreWrites(store, values, true, values.kept);
  for (const operation of operations) {
    try {
      if (writes.follow(operation)) kept.add((operation as { id: string }).id);
    } catch {
      // What the Store refuses to write is left as the commit left it
    }
  }
  return kept;
}

/** The writes of operations to one Store */
class StoreWrites {
  constructor(
    private readonly store: Store,
    private readonly values: CommitValues,
    private readonly keepKeys: boolean,
    private readonly kept: KeptRecords,
  ) {}

  /** Whether the Store holds its features as rows */
  get #rows(): boolean {
    return this.store.tables !== undefined;
  }

  write(operation: ValueOperation): void {
    switch (operation.type) {
      case 'create':
        switch (operation.kind) {
          case 'feature':
            if (this.#hasFeature(operation.id)) return;
            this.#settle(
              operation.id,
              placementOf(operation.record),
              operation.record.key,
              operation.record,
            );
            return;
          case 'layer':
            this.#createLayer(operation.id, operation.record);
            return;
          case 'group':
            if (this.store.getGroup(operation.id) || this.kept.groups.has(operation.id)) return;
            // Shown once a member comes
            this.kept.groups.set(operation.id, operation.record);
            this.#settleMembersOf(operation.id);
            return;
          case 'file':
            if (this.store.getFile(operation.id)) return;
            this.store.createFile({
              id: operation.id,
              mimeType: operation.record.mediaType,
              dataURL: `data:${operation.record.mediaType};base64,${operation.record.content}`,
            });
            return;
        }
        return;
      case 'set':
        this.#set(operation);
        return;
      case 'place':
        operation.ids.forEach((id, i) => {
          const key = operation.keys[i];
          if (key === undefined || operation.parentId === null) {
            if (operation.kind === 'layer' && key !== undefined && this.store.getLayer(id)) {
              this.#placeLayer(id, key);
            }
            return;
          }
          if (operation.kind === 'layer') return;
          if (operation.kind === 'group') this.#placeGroup(id, operation.parentId, key);
          else this.#placeFeature(id, operation.parentId, key);
        });
        return;
      case 'delete':
        for (const id of operation.ids) this.#delete(operation.kind, id);
        return;
    }
  }

  /**
   * Follows an operation of a commit of this client the Store holds (see `followCommit`)
   *
   * @returns Whether it is the creation of a feature the storage keeps as it had it
   */
  follow(operation: ValueOperation): boolean {
    const kept = this.kept;
    switch (operation.type) {
      case 'create':
        if (operation.kind === 'layer') this.#showUnder(operation.id);
        else if (operation.kind === 'group') {
          kept.groups.delete(operation.id);
          this.#settleMembersOf(operation.id);
        } else if (operation.kind === 'feature') {
          const record = kept.features.get(operation.id);
          if (!record) return false;
          if (this.store.getFeature(operation.id)) this.#deleteShown(operation.id);
          this.#settle(operation.id, placementOf(record), record.key, record);
          return true;
        }
        return false;
      case 'delete':
        if (operation.kind === 'group') {
          for (const id of operation.ids) this.#settleMembersOf(id);
        }
        return false;
      default:
        return false;
    }
  }

  // ==========================================================================
  // The document of the storage, read from the Store and what is kept
  // ==========================================================================

  /** Whether the document has a feature (shown or kept) */
  #hasFeature(id: string): boolean {
    return this.store.getFeature(id) !== undefined || this.kept.features.has(id);
  }

  /** A group of the document (shown or kept) */
  #groupOf(id: string): GroupRecord | undefined {
    return this.store.getGroup(id) ? this.values.recordOf('group', id) : this.kept.groups.get(id);
  }

  /** The key of a feature (shown or kept) */
  #keyOf(id: string): string {
    if (this.store.getFeature(id)) return this.values.placeOf('feature', id)?.key ?? '';
    return this.kept.features.get(id)?.key ?? '';
  }

  /**
   * Where a feature whose keys are those given is shown: in its group (in the layer of the group),
   * in its layer when its group is not there; null when that layer is not there
   */
  #shownAt(keys: PlacementKeys): PlacementKeys | null {
    if (keys.groupId !== undefined) {
      const group = this.#groupOf(keys.groupId);
      if (group) {
        return this.store.getLayer(group.layerId)
          ? { layerId: group.layerId, groupId: keys.groupId }
          : null;
      }
    }
    return this.store.getLayer(keys.layerId) ? { layerId: keys.layerId, groupId: undefined } : null;
  }

  /** The members of a group the Store holds */
  #membersOf(groupId: string): string[] {
    const store = this.store;
    const group = store.getGroup(groupId);
    if (!group) return [];
    if (group.kind !== 'table') return [...group.featureIds];
    const tables = store.tables;
    const view = tables?.get(group.layerId);
    const ref = tables?.getGroupRef(groupId);
    if (!tables || !view || ref === undefined) return [];
    const out: string[] = [];
    for (const row of view.listGroupMembers(ref, 0, view.countGroupMembers(ref))) {
      const id = tables.getRowId(row);
      if (id !== undefined) out.push(id);
    }
    return out;
  }

  /** The record of a feature the Store holds, with the keys the document has */
  #recordOf(id: string): FeatureRecord | undefined {
    const record = this.values.recordOf('feature', id);
    const keys = this.kept.placements.get(id);
    return record && keys ? withPlacement(record, keys) : record;
  }

  // ==========================================================================
  // Features
  // ==========================================================================

  /**
   * Puts a feature where the document has it now (its keys and its key): shown where the rules
   * say, created there from `record` when the Store does not hold it, or kept when its layer is
   * not there
   */
  #settle(id: string, keys: PlacementKeys, key: string, record?: FeatureRecord): void {
    const store = this.store;
    const kept = this.kept;
    const at = this.#shownAt(keys);
    const stored = store.getFeature(id);
    if (!at) {
      const whole = stored ? this.#recordOf(id) : record;
      if (stored) this.#deleteShown(id);
      kept.placements.delete(id);
      if (whole) kept.features.set(id, withPlacement({ ...whole, key }, keys));
      return;
    }
    const groupShown = at.groupId === undefined || store.getGroup(at.groupId) !== undefined;
    if (!groupShown) {
      this.#showGroupWith(at.groupId as string, at.layerId, id, key, stored ? undefined : record);
    } else if (!stored) {
      if (!record) return;
      this.#createShown(id, record, at, key);
    } else {
      // Where it is now among the items of its parent, as the keys are kept
      const place = this.values.placeOf('feature', id);
      if (
        stored.layerId !== at.layerId ||
        stored.groupId !== at.groupId ||
        place?.parentId !== (at.groupId ?? at.layerId) ||
        place.key !== key
      ) {
        this.#move(id, at, key);
      }
    }
    kept.features.delete(id);
    if (keys.layerId === at.layerId && keys.groupId === at.groupId) kept.placements.delete(id);
    else kept.placements.set(id, keys);
  }

  /** Creates a feature in the Store where it is shown */
  #createShown(id: string, record: FeatureRecord, at: PlacementKeys, key: string): void {
    const stored = storedOfRecord(id, { ...record, key });
    this.store.createFeature({ ...stored, layerId: at.layerId, groupId: at.groupId });
    if (this.#rows) this.#writeRowPlaces([id], at.groupId ?? at.layerId, [key]);
    else this.#putObject(id, at.layerId, at.groupId, key);
  }

  /** Puts a feature the Store holds elsewhere */
  #move(id: string, at: PlacementKeys, key: string): void {
    const settle = this.#leaving(id);
    if (this.#rows) this.#writeRowPlaces([id], at.groupId ?? at.layerId, [key]);
    else this.#putObject(id, at.layerId, at.groupId, key);
    settle();
  }

  /** Deletes a feature the Store holds */
  #deleteShown(id: string): void {
    const settle = this.#leaving(id);
    this.store.deleteFeature(id);
    settle();
  }

  /**
   * What keeps the group a feature leaves once the Store no longer shows it (a group with no
   * member is not shown): call it after the feature leaves
   */
  #leaving(id: string): () => void {
    const store = this.store;
    const groupId = store.getFeature(id)?.groupId;
    if (groupId === undefined) return () => {};
    const record = this.values.recordOf('group', groupId);
    return () => {
      if (!record || this.kept.groups.has(groupId)) return;
      const group = store.getGroup(groupId);
      if (group && this.#membersOf(groupId).length > 0) return;
      if (group) store.deleteGroup(groupId);
      this.kept.groups.set(groupId, record);
    };
  }

  /**
   * Shows a group kept, with its first member, each where its key says (a layer of objects holds
   * no group without a member)
   */
  #showGroupWith(
    groupId: string,
    layerId: string,
    member: string,
    key: string,
    record: FeatureRecord | undefined,
  ): void {
    const store = this.store;
    const group = this.kept.groups.get(groupId);
    if (!group) return;
    const fields = {
      id: groupId,
      layerId,
      name: group.name,
      visible: group.visible,
      locked: group.locked,
    };
    if (this.#rows) {
      store.createGroup({ ...fields, kind: 'table' });
      this.#writeGroupPlace(groupId, layerId, group.key);
      this.kept.groups.delete(groupId);
      if (store.getFeature(member)) this.#move(member, { layerId, groupId }, key);
      else if (record) this.#createShown(member, record, { layerId, groupId }, key);
      return;
    }
    // Into its layer first, where the group comes
    const at = { layerId, groupId: undefined };
    if (store.getFeature(member)) this.#move(member, at, group.key);
    else if (record) this.#createShown(member, record, at, group.key);
    if (!store.getFeature(member)) return;
    this.kept.groups.delete(groupId);
    store.createGroup({ ...fields, featureIds: [member] });
    // Listed now where its key says: a group no layer lists would be put at the end of the
    // transaction where its member stood when it was created
    this.#putObject(groupId, layerId, undefined, group.key);
    if (this.keepKeys) this.values.keepPlace(member, groupId, key);
  }

  /** Puts again the features kept that name a group as theirs, now that it is there or gone */
  #settleMembersOf(groupId: string): void {
    const kept = this.kept;
    for (const [id, record] of [...kept.features]) {
      const keys = placementOf(record);
      if (keys.groupId === groupId) this.#settle(id, keys, record.key, record);
    }
    for (const [id, keys] of [...kept.placements]) {
      if (keys.groupId === groupId) this.#settle(id, keys, this.#keyOf(id));
    }
  }

  #placeFeature(id: string, parentId: string, key: string): void {
    const store = this.store;
    let keys: PlacementKeys;
    if (store.getLayer(parentId)) keys = { layerId: parentId, groupId: undefined };
    else {
      const group = this.#groupOf(parentId);
      if (!group) return;
      keys = { layerId: group.layerId, groupId: parentId };
    }
    if (store.getFeature(id)) {
      this.kept.placements.delete(id);
      this.#settle(id, keys, key);
      return;
    }
    const record = this.kept.features.get(id);
    if (record) this.#settle(id, keys, key, record);
  }

  #set(operation: Extract<ValueOperation, { type: 'set' }>): void {
    const store = this.store;
    switch (operation.kind) {
      case 'feature':
        for (const id of operation.ids) {
          const kept = this.kept.features.get(id);
          if (kept) {
            const record = setFeature(kept, operation.set, operation.unset);
            this.kept.features.set(id, record);
            this.#settle(id, placementOf(record), record.key, record);
            continue;
          }
          const record = this.#recordOf(id);
          if (!record) continue;
          const written = setFeature(record, operation.set, operation.unset);
          const now = storedOfRecord(id, written);
          store.updateFeature(id, {
            type: now.type,
            geometry: now.geometry,
            properties: now.properties,
            style: now.style,
            visible: now.visible,
            locked: now.locked,
          });
          // A write of the keys of its place puts it elsewhere
          const before = placementOf(record);
          const after = placementOf(written);
          if (before.layerId !== after.layerId || before.groupId !== after.groupId) {
            this.#settle(id, after, this.#keyOf(id));
          }
        }
        return;
      case 'layer':
        for (const id of operation.ids) {
          if (!store.getLayer(id)) continue;
          const { name, visible, locked, opacity, styleRule } = operation.set;
          store.updateLayer(id, {
            ...(name !== undefined && { name }),
            ...(visible !== undefined && { visible }),
            ...(locked !== undefined && { locked }),
            ...(opacity !== undefined && { opacity }),
            ...(styleRule !== undefined && { styleRule: ruleOfRecord(styleRule) }),
          });
        }
        return;
      case 'group':
        for (const id of operation.ids) {
          const { name, visible, locked } = operation.set;
          const fields = {
            ...(name !== undefined && { name }),
            ...(visible !== undefined && { visible }),
            ...(locked !== undefined && { locked }),
          };
          const kept = this.kept.groups.get(id);
          if (kept) this.kept.groups.set(id, { ...kept, ...fields });
          else if (store.getGroup(id)) store.updateGroup(id, fields);
        }
        return;
      case 'document': {
        const { title, description } = operation.set;
        store.setMetadata({
          ...(title !== undefined && { title }),
          ...(description !== undefined && { description }),
        });
        return;
      }
    }
  }

  // ==========================================================================
  // Layers and groups
  // ==========================================================================

  #createLayer(id: string, record: LayerRecord): void {
    if (this.store.getLayer(id)) return;
    const fields = {
      id,
      name: record.name,
      visible: record.visible,
      locked: record.locked,
      opacity: record.opacity,
      metadata: undefined,
      styleRule: ruleOfRecord(record.styleRule),
    };
    const layer: Layer = this.#rows ? { ...fields, kind: 'table' } : { ...fields, items: [] };
    this.store.createLayer(layer);
    this.#placeLayer(id, record.key);
    this.#showUnder(id);
  }

  /** Shows again with a layer what was kept because it was not there */
  #showUnder(id: string): void {
    if (this.kept.empty) return;
    for (const [groupId, group] of [...this.kept.groups]) {
      if (group.layerId === id) this.#settleMembersOf(groupId);
    }
    for (const [featureId, kept] of [...this.kept.features]) {
      if (!this.kept.features.has(featureId)) continue;
      const keys = placementOf(kept);
      if (this.#shownAt(keys)) this.#settle(featureId, keys, kept.key, kept);
    }
  }

  #placeGroup(id: string, parentId: string, key: string): void {
    const store = this.store;
    const layerId = store.getLayer(parentId) ? parentId : this.#groupOf(parentId)?.layerId;
    if (layerId === undefined) return;
    const kept = this.kept.groups.get(id);
    if (kept) {
      this.kept.groups.set(id, { ...kept, layerId, key });
      if (store.getLayer(layerId)) this.#settleMembersOf(id);
      return;
    }
    const group = store.getGroup(id);
    if (!group) return;
    const from = group.layerId;
    const members = this.#membersOf(id);
    // Where the document has its members: their keys stay (the storage writes the group only)
    const keys = new Map(
      members.map((member) => [
        member,
        this.kept.placements.get(member) ?? { layerId: from, groupId: id },
      ]),
    );
    if (!store.getLayer(layerId)) {
      // Kept with its members until its layer is there
      const record = this.values.recordOf('group', id);
      for (const member of members) {
        const whole = this.#recordOf(member);
        const memberKeys = keys.get(member) as PlacementKeys;
        if (whole) this.kept.features.set(member, withPlacement(whole, memberKeys));
        this.kept.placements.delete(member);
      }
      for (const member of members) store.deleteFeature(member);
      if (store.getGroup(id)) store.deleteGroup(id);
      if (record) this.kept.groups.set(id, { ...record, layerId, key });
      return;
    }
    if (this.#rows) this.#writeGroupPlace(id, layerId, key);
    else this.#putObject(id, layerId, undefined, key);
    if (layerId === from) return;
    for (const [member, memberKeys] of keys) {
      if (memberKeys.layerId === layerId && memberKeys.groupId === id) {
        this.kept.placements.delete(member);
      } else {
        this.kept.placements.set(member, memberKeys);
      }
    }
  }

  #placeLayer(id: string, key: string): void {
    const store = this.store;
    let found: { id: string; key: string } | null = null;
    for (const entry of this.values.keysUnder(null)) {
      if (entry.id === id || compareItems(entry, { id, key }) >= 0) continue;
      if (!found || compareItems(entry, found) > 0) found = entry;
    }
    const below = found?.id ?? null;
    const order = store.getLayerOrder().filter((entry) => entry !== id);
    const at = below === null ? firstLayerAt(order, store) : order.indexOf(below) + 1;
    order.splice(at, 0, id);
    if (this.keepKeys) this.values.keepPlace(id, null, key);
    store.setLayerOrder(order);
  }

  // ==========================================================================
  // Places
  // ==========================================================================

  /** Puts an item of a layer of objects where its key says among the items of its parent */
  #putObject(id: string, layerId: string, groupId: string | undefined, key: string): void {
    const parentId = groupId ?? layerId;
    // The item of the greatest key below its key (the group it leaves is not one: a group a
    // feature leaves empty is deleted with the move)
    const from = this.store.getFeature(id)?.groupId;
    const left = from === undefined ? undefined : this.store.getGroup(from);
    const leaves = left && left.kind !== 'table' && left.featureIds.length === 1 ? from : undefined;
    let below: { id: string; key: string } | null = null;
    for (const entry of this.values.keysUnder(parentId)) {
      if (entry.id === id || entry.id === leaves || compareItems(entry, { id, key }) >= 0) continue;
      if (!below || compareItems(entry, below) > 0) below = entry;
    }
    if (this.keepKeys) this.values.keepPlace(id, parentId, key);
    this.store.moveItems([id], {
      layerId,
      ...(groupId !== undefined && { groupId }),
      below: below?.id ?? null,
    });
  }

  /** Writes the parent and the key of rows */
  #writeRowPlaces(ids: readonly string[], parentId: string, keys: readonly string[]): void {
    const writer = tablesWriterOf(this.store);
    const tables = this.store.tables;
    if (!writer || !tables) return;
    const rows: number[] = [];
    const kept: string[] = [];
    ids.forEach((id, i) => {
      const row = tables.getRowRef(id);
      if (row === undefined) return;
      rows.push(row as number);
      kept.push(keys[i]);
    });
    if (rows.length === 0) return;
    writer.writeRows({
      rows: Int32Array.from(rows),
      fields: new Map<RowField, unknown[]>([
        ['parent', rows.map(() => parentId)],
        ['key', kept],
      ]),
    });
  }

  /** Writes the layer and the key of a group of rows */
  #writeGroupPlace(id: string, layerId: string, key: string): void {
    const writer = tablesWriterOf(this.store);
    const ref = this.store.tables?.getGroupRef(id);
    if (!writer || ref === undefined) return;
    writer.writeGroups({
      groups: Int32Array.of(ref as number),
      fields: new Map<'parent' | 'key', unknown[]>([
        ['parent', [layerId]],
        ['key', [key]],
      ]),
    });
  }

  // ==========================================================================
  // Deletions
  // ==========================================================================

  #delete(kind: 'feature' | 'layer' | 'group' | 'file', id: string): void {
    const store = this.store;
    const kept = this.kept;
    switch (kind) {
      case 'feature':
        if (store.getFeature(id)) this.#deleteShown(id);
        kept.features.delete(id);
        kept.placements.delete(id);
        return;
      case 'group':
        this.#deleteGroup(id);
        return;
      case 'layer':
        this.#deleteLayer(id);
        return;
      case 'file':
        if (store.getFile(id)) store.deleteFile(id);
        return;
    }
  }

  /**
   * Deletes a group, and only it: its members the deletion does not name are in their own layer at
   * their own keys, and go back into it should it come back
   */
  #deleteGroup(id: string): void {
    const store = this.store;
    const group = store.getGroup(id);
    if (this.kept.groups.delete(id) || !group) {
      this.#settleMembersOf(id);
      return;
    }
    const from = group.layerId;
    const members = this.#membersOf(id).map((member) => ({
      member,
      keys: this.kept.placements.get(member) ?? { layerId: from, groupId: id },
      key: this.#keyOf(member),
    }));
    store.deleteGroup(id);
    for (const { member, keys, key } of members) this.#settle(member, keys, key);
  }

  /**
   * Deletes a layer, and only it: what is in it that the deletion does not name is kept, and shown
   * again should the layer come back
   */
  #deleteLayer(id: string): void {
    const store = this.store;
    const layer = store.getLayer(id);
    if (!layer) return;
    const groups = store.listGroups().filter((group) => group.layerId === id);
    const features: string[] = [];
    if (layer.kind === 'table') {
      const tables = store.tables;
      const view = tables?.get(id);
      // The rows of the layer, those deleted (kept for an undo, an ID made again among them) left
      // out
      if (tables && view && view.rowCount > 0) {
        for (const row of view.listRowRefs(0, view.rowCountWithDeleted)) {
          const featureId = tables.getRowId(row);
          if (featureId !== undefined && tables.getRowRef(featureId) === row) {
            features.push(featureId);
          }
        }
      }
    } else {
      for (const item of layer.items) {
        if (store.getFeature(item)) features.push(item);
      }
      for (const group of groups) features.push(...this.#membersOf(group.id));
    }
    for (const featureId of features) {
      const record = this.#recordOf(featureId);
      if (record) this.kept.features.set(featureId, record);
      this.kept.placements.delete(featureId);
    }
    for (const group of groups) {
      const record = this.values.recordOf('group', group.id);
      if (record) this.kept.groups.set(group.id, record);
    }
    store.deleteLayer(id);
  }
}

/** The order of two items by their keys, and by their IDs among the same keys */
function compareItems(
  a: { readonly id: string; readonly key: string },
  b: { readonly id: string; readonly key: string },
): number {
  const order = compareKeys(a.key, b.key);
  if (order !== 0) return order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Where the first layer goes among the entries of the order of the layers (its back) */
function firstLayerAt(order: readonly string[], store: Store): number {
  const at = order.findIndex((entry) => store.getLayer(entry) !== undefined);
  return at < 0 ? order.length : at;
}

/**
 * A record of a feature as a feature of the Store: its values of JSON as values, the keys of the
 * library read into its fields
 *
 * @internal
 */
export function storedOfRecord(id: string, record: FeatureRecord): StoredFeature {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record.properties)) {
    // The keys of the library hold JSON; the others hold values in their JSON form
    Object.defineProperty(properties, key, {
      value: key.startsWith(FIELD_PREFIX) ? value : valueFromJSON(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const feature = { type: 'Feature', id, geometry: record.geometry, properties } as Feature;
  return storedFeatureOf(feature);
}

/**
 * The style rule of a layer from a record (told apart by `type`, the colors of the categories
 * under `colors`) in the shape of the core of this version (`kind`, `map`)
 *
 * @internal
 */
export function ruleOfRecord(rule: LayerRecord['styleRule']): StyleRule | undefined {
  if (!rule) return undefined;
  switch (rule.type) {
    case 'single':
      return { kind: 'single', color: rule.color };
    case 'categorical':
      return {
        kind: 'categorical',
        property: rule.property,
        map: { ...rule.colors },
        other: rule.other,
      };
    case 'graduated':
      return {
        kind: 'graduated',
        property: rule.property,
        breaks: [...rule.breaks],
        colors: [...rule.colors],
        other: rule.other,
      };
    case 'continuous':
      return {
        kind: 'continuous',
        property: rule.property,
        min: rule.min,
        max: rule.max,
        ramp: [rule.ramp[0], rule.ramp[1]],
        other: rule.other,
      };
  }
}
