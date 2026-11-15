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
import type { Group, Layer, Feature as StoredFeature } from '../../store/types.js';
import { storedFeatureOf } from '../impl/feature-shape.js';
import type { Feature, StyleRule } from '../model.js';
import type { RowField } from '../tables.js';
import type { CommitValues } from './commit-values.js';
import {
  type FeatureRecord,
  type GroupRecord,
  type LayerRecord,
  setFeature,
  type ValueOperation,
} from './values.js';

const FIELD_PREFIX = 'maplibre-gl-draw:';

/**
 * Writes operations to a Store, in their order, inside a transaction the caller opened
 *
 * @param values - What keeps the keys of the items of the layers of objects, and of the layers
 * @param keepKeys - False for a commit of this client made of them (a refusal made again): the
 *   items of objects and the layers are put where their keys say, and take keys of their own
 */
export function writeOperations(
  store: Store,
  values: CommitValues,
  operations: readonly ValueOperation[],
  keepKeys = true,
): {
  readonly failed: readonly unknown[];
  readonly unplaced: ReadonlyArray<{ readonly kind: 'feature' | 'group'; readonly id: string }>;
  readonly uncreated: ReadonlyArray<{ readonly kind: 'feature' | 'group'; readonly id: string }>;
} {
  const writes = new StoreWrites(store, values, keepKeys);
  // One that the Store refuses is left out: the others are written
  const failed: unknown[] = [];
  for (const operation of operations) {
    try {
      writes.write(operation);
    } catch (error) {
      failed.push(error);
    }
  }
  return { failed, unplaced: writes.unplaced, uncreated: writes.uncreated };
}

/** The writes of operations to one Store */
class StoreWrites {
  constructor(
    private readonly store: Store,
    private readonly values: CommitValues,
    private readonly keepKeys: boolean,
  ) {}

  /**
   * The groups of objects to create, until their first member comes: a layer of objects holds no
   * group without a member
   */
  readonly #groupsToCome = new Map<string, GroupRecord>();
  /** The items not put in a place because their parent is gone: they stay where they are */
  readonly unplaced: Array<{ readonly kind: 'feature' | 'group'; readonly id: string }> = [];
  /** The items not created because their layer is gone */
  readonly uncreated: Array<{ readonly kind: 'feature' | 'group'; readonly id: string }> = [];

  /** Whether the Store holds its features as rows */
  get #rows(): boolean {
    return this.store.tables !== undefined;
  }

  write(operation: ValueOperation): void {
    switch (operation.type) {
      case 'create':
        switch (operation.kind) {
          case 'feature':
            this.#createFeature(operation.id, operation.record);
            return;
          case 'layer':
            this.#createLayer(operation.id, operation.record);
            return;
          case 'group':
            this.#createGroup(operation.id, operation.record);
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
          this.#place(operation.kind, id, operation.parentId, operation.keys[i]);
        });
        return;
      case 'delete':
        for (const id of operation.ids) this.#delete(operation.kind, id);
        return;
    }
  }

  // ==========================================================================
  // Features
  // ==========================================================================

  #createFeature(id: string, record: FeatureRecord): void {
    const store = this.store;
    if (store.getFeature(id)) return;
    const stored = storedOfRecord(id, record);
    if (!store.getLayer(stored.layerId)) {
      this.uncreated.push({ kind: 'feature', id });
      return;
    }
    const groupId = stored.groupId;
    const toCome = groupId === undefined ? undefined : this.#groupsToCome.get(groupId);
    if (toCome || (groupId !== undefined && !store.getGroup(groupId))) {
      // Created in its layer: where its group goes, then the group comes with it; at the back of
      // its layer when its group is gone
      store.createFeature({ ...stored, groupId: undefined });
      if (toCome && groupId !== undefined) {
        this.#putObject(id, toCome.layerId, undefined, toCome.key);
        this.#joinGroupToCome(groupId, toCome, id, record.key);
      } else {
        this.unplaced.push({ kind: 'feature', id });
      }
      return;
    }
    store.createFeature(stored);
    const parentId = groupId ?? stored.layerId;
    if (this.#rows) this.#writeRowPlaces([id], parentId, [record.key]);
    else this.#putObject(id, stored.layerId, groupId, record.key);
  }

  /** Creates a group of objects with its first member, each where its key says */
  #joinGroupToCome(groupId: string, record: GroupRecord, member: string, key: string): void {
    this.#groupsToCome.delete(groupId);
    this.store.createGroup({
      id: groupId,
      layerId: record.layerId,
      name: record.name,
      visible: record.visible,
      locked: record.locked,
      featureIds: [member],
    });
    // Listed now where its key says: a group no layer lists would be put at the end of the
    // transaction where its member stood when it was created
    this.#putObject(groupId, record.layerId, undefined, record.key);
    if (this.keepKeys) this.values.keepPlace(member, groupId, key);
  }

  #set(operation: Extract<ValueOperation, { type: 'set' }>): void {
    const store = this.store;
    switch (operation.kind) {
      case 'feature':
        for (const id of operation.ids) {
          const record = this.values.recordOf('feature', id);
          if (!record) continue;
          const now = storedOfRecord(id, setFeature(record, operation.set, operation.unset));
          store.updateFeature(id, {
            type: now.type,
            geometry: now.geometry,
            properties: now.properties,
            style: now.style,
            visible: now.visible,
            locked: now.locked,
          });
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
          if (!store.getGroup(id)) continue;
          const { name, visible, locked } = operation.set;
          store.updateGroup(id, {
            ...(name !== undefined && { name }),
            ...(visible !== undefined && { visible }),
            ...(locked !== undefined && { locked }),
          });
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
  }

  #createGroup(id: string, record: GroupRecord): void {
    const store = this.store;
    if (store.getGroup(id)) return;
    if (!store.getLayer(record.layerId)) {
      this.uncreated.push({ kind: 'group', id });
      return;
    }
    const fields = {
      id,
      layerId: record.layerId,
      name: record.name,
      visible: record.visible,
      locked: record.locked,
    };
    if (!this.#rows) {
      // Created with its first member
      this.#groupsToCome.set(id, record);
      return;
    }
    const group: Group = { ...fields, kind: 'table' };
    store.createGroup(group);
    this.#writeGroupPlace(id, record.layerId, record.key);
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

  #place(
    kind: 'feature' | 'layer' | 'group',
    id: string,
    parentId: string | null,
    key: string | undefined,
  ): void {
    if (key === undefined) return;
    const store = this.store;
    if (kind === 'layer') {
      if (store.getLayer(id)) this.#placeLayer(id, key);
      return;
    }
    if (parentId === null) return;
    const toCome = this.#groupsToCome.get(parentId);
    if (toCome) {
      if (kind === 'feature' && store.getFeature(id) && store.getLayer(toCome.layerId)) {
        // Into its layer first, where the group comes
        this.#putObject(id, toCome.layerId, undefined, toCome.key);
        this.#joinGroupToCome(parentId, toCome, id, key);
      }
      return;
    }
    const group = store.getGroup(parentId);
    const layerId = group ? group.layerId : parentId;
    if (!store.getLayer(layerId)) {
      const there = kind === 'group' ? store.getGroup(id) : store.getFeature(id);
      if (there) this.unplaced.push({ kind, id });
      return;
    }
    if (kind === 'group') {
      if (!store.getGroup(id)) return;
      if (this.#rows) this.#writeGroupPlace(id, layerId, key);
      else this.#putObject(id, layerId, undefined, key);
      return;
    }
    if (!store.getFeature(id)) return;
    if (this.#rows) this.#writeRowPlaces([id], parentId, [key]);
    else this.#putObject(id, layerId, group?.id, key);
  }

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
    switch (kind) {
      case 'feature':
        if (store.getFeature(id)) store.deleteFeature(id);
        return;
      case 'group':
        if (store.getGroup(id)) store.deleteGroup(id);
        return;
      case 'layer':
        if (store.getLayer(id)) store.deleteLayer(id);
        return;
      case 'file':
        if (store.getFile(id)) store.deleteFile(id);
        return;
    }
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
