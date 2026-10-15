// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The in-memory Store that holds its features as rows of columns
 *
 * Every layer of it is held as rows (`TableLayer`): its features are the rows of the tables it
 * hands out (`tables`), written with the writer of the tables, and a row is a feature only while
 * it is held (selected, edited) or when one is asked for (`getFeature`). It is the example of a
 * Store of rows for a host without a document of its own elsewhere, and what the tests of core
 * run a Store of rows with.
 *
 * - The writes of the features go to the rows: a write of a feature held writes its feature
 *   (`applyOpened`), a write of a row that is not held writes the row (`apply`). A new feature is
 *   put at the end of its layer (or of its group), with a key after the last one
 * - The writes in the middle of an edit (`isIntermediate`) are shown and kept apart from the
 *   values others write meanwhile; `abortIntermediateUpdates` writes back the values without
 *   them
 * - One notification per outermost transaction. A row is in it once: as a change of its feature
 *   when it is held when the transaction ends, as a change of its row otherwise. A row created
 *   and held in the same transaction is a feature created
 * - Every write of rows of this client (not `remote`), through the Store or its writer, reads the
 *   values the rows that are not held had for the fields it writes, other than their place (the
 *   layer, the group and the keys of the order, which the changes of the order tell), and the
 *   notification carries them (`previousValues`): the rows that were there when the transaction
 *   began, with the values they had then. A write through `applyRows` carries the values it is
 *   given
 * - The rows and the groups this client deletes (a group with its features, left by its last
 *   feature, or dissolved) are kept by the token of the transaction (`features.restore`,
 *   `groups.restore`); what is deleted from elsewhere is not
 * - The writes of rows from elsewhere go through the writer it returns, in a transaction with
 *   their source (`store.transact(() => writer.apply(patch), 'remote')`)
 * - `listFeatures` and `listFeaturesInOrder` throw: the rows are read from the tables
 */

import type {
  FeatureTables,
  FeatureTablesWriter,
  RowApplyOptions,
  RowField,
  RowHandle,
  RowWrite,
  TableGroupPatch,
} from '../api/tables.js';
import { featureFields, featureWithFields } from '../feature-table/feature-fields.js';
import {
  createFeatureTablesStore,
  type FeatureTablesInternalOptions,
  type FeatureTablesInternals,
  featureTablesInternals,
} from '../feature-table/feature-tables.js';
import { ItemWalk } from '../feature-table/item-walk.js';
import { rowFeature } from '../feature-table/row-read.js';
import { ROW_FLAG_DELETED } from '../table/row-group-types.js';
import { utf8ColumnFromStrings, utf8String } from '../table/utf8-column.js';
import { DrawStore } from './draw-store.js';
import { ChangeBus } from './memory/change-bus.js';
import { FileStore } from './memory/file-store.js';
import { frozenCopy } from './memory/frozen.js';
import { MemoryClientState } from './memory/ui-state.js';
import { keyAfter, keysBetween } from './order-keys.js';
import { combineValuesBefore } from './row-values-before.js';
import type { Store, StoreContract } from './store.js';
import type {
  Feature,
  FileData,
  Group,
  ItemPlacement,
  Layer,
  LayerRowsChange,
  Metadata,
  Mode,
  RestoreToken,
  RowsChange,
  RowValues,
  Selection,
  SelectionType,
  StoreChange,
  TableGroup,
  TableLayer,
  UpdateFeatureOptions,
  UpdateSource,
  VertexSelection,
} from './types.js';

/**
 * The options of a Store of rows: those of its tables, but the notifications, which the Store
 * takes
 *
 * @internal
 */
export type TableStoreOptions = Omit<FeatureTablesInternalOptions, 'onChange' | 'onRelease'> & {
  /** The most features opened at once for the selection (`HOLD_LIMIT` when omitted) */
  readonly holdLimit?: number;
};

/**
 * Creates an empty in-memory Store that holds its features as rows of columns
 *
 * @param options The options of its tables (the Worker of the host that builds the rows)
 * @returns The Store, and the writer of its tables: what writes rows from elsewhere (in a
 *   transaction of the Store with their source) and takes row groups in (`adopt`)
 *
 * @internal
 */
export function createTableStore(options: TableStoreOptions = {}): {
  store: Store;
  writer: FeatureTablesWriter;
} {
  const { holdLimit, ...tableOptions } = options;
  const contract = new TableContractStore(tableOptions);
  return {
    store: new DrawStore(contract, holdLimit === undefined ? {} : { holdLimit }),
    writer: contract.writer,
  };
}

/**
 * The rows deleted from elsewhere whose ids are kept (their handles are forgotten past it, the
 * oldest first)
 *
 * @internal
 */
export const REMOTE_DELETED_KEPT = 10_000;

/**
 * The fields of the place of a row: a write of them is told by the changes of the order, not by
 * the values before
 */
const PLACE_FIELDS: ReadonlySet<RowField> = new Set(['layerId', 'groupId', 'order', 'member']);

/**
 * The in-memory {@link StoreContract} of rows
 *
 * @internal
 */
export class TableContractStore implements StoreContract {
  readonly #bus = new ChangeBus();
  readonly #client = new MemoryClientState(this.#bus);
  readonly #files = new FileStore();
  readonly #listeners = new Set<(changes: StoreChange) => void>();
  readonly tables: FeatureTables;
  /** The writer of the tables, through which every write reads the values before it writes */
  readonly writer: FeatureTablesWriter;
  /** The writer of the tables as they make it */
  readonly #writer: FeatureTablesWriter;
  readonly #internals: FeatureTablesInternals;
  readonly #layers = new Map<string, TableLayer>();
  #order: string[] = [];
  readonly #groups = new Map<string, TableGroup>();
  #nextGroup = 0;
  #metadata: Metadata = {};
  /** The values the writes of this transaction read before they wrote, in their order */
  #before: RowValues[] = [];
  /** The rows this transaction wrote, and whether each was there when it began */
  #written = new Map<RowHandle, boolean>();
  /** The depth of the writes of the document being made */
  #depth = 0;
  /** What keeps the rows deleted in this transaction (made at the first deletion) */
  #retain: RestoreToken | null = null;
  /** The rows deleted from elsewhere, the oldest first, whose ids are kept a while */
  #remoteDeleted: RowHandle[] = [];
  /** The groups features left in the write being made (deleted at its end when empty) */
  readonly #leftGroups = new Set<string>();

  constructor(options: TableStoreOptions = {}) {
    const { tables, writer } = createFeatureTablesStore({
      ...options,
      onChange: (change) => this.#bus.merge(change as StoreChange),
      // Nothing else needs the ids of the rows deleted that nothing keeps any more
      onRelease: (handles) => this.#writer.forget(handles),
    });
    this.tables = tables;
    this.#writer = writer;
    this.writer = {
      lookup: (id) => writer.lookup(id),
      createRestoreToken: () => writer.createRestoreToken(),
      forget: (handles) => writer.forget(handles),
      allocateHandles: (ids, hashes) => writer.allocateHandles(ids, hashes),
      addBlocks: (layerId, blocks) => writer.addBlocks(layerId, blocks),
      raiseDimensions: (layerId, dimensions) => writer.raiseDimensions(layerId, dimensions),
      apply: (patch, options) => this.transact(() => this.#applyRows(patch, options)),
      applyGroups: (patch, options) => this.#applyGroups(patch, options),
      applyOpened: (id, feature, options) => writer.applyOpened(id, feature, options),
      getGroupOrder: (groupHandle) => writer.getGroupOrder(groupHandle),
      clear: () => this.transact(() => writer.clear(), 'remote'),
    };
    this.#internals = featureTablesInternals(tables) as FeatureTablesInternals;
    this.#bus.subscribe((changes) => this.#deliver(changes));
  }

  // ==========================================================================
  // The document: reads
  // ==========================================================================

  getFeature(id: string): Feature | undefined {
    const held = this.#internals.getOpenedFeature(id);
    if (held) return held;
    const handle = this.tables.findRow(id);
    return handle === undefined ? undefined : this.#rowFeature(handle);
  }
  listFeatures(): Feature[] {
    throw new Error('The Store holds its features as rows: read them from its tables (scan)');
  }
  listFeaturesInOrder(): Feature[] {
    throw new Error('The Store holds its features as rows: read them from its tables (scan)');
  }
  getLayer(id: string): Layer | undefined {
    return this.#layers.get(id);
  }
  listLayers(): Layer[] {
    return [...this.#layers.values()];
  }
  getLayerOrder(): readonly string[] {
    return [...this.#order];
  }
  getGroup(id: string): Group | undefined {
    return this.#groups.get(id);
  }
  listGroups(): Group[] {
    return [...this.#groups.values()];
  }
  getFile(id: string): FileData | undefined {
    return this.#files.get(id);
  }
  listFiles(): FileData[] {
    return this.#files.getAll();
  }
  getMetadata(): Metadata {
    return this.#metadata;
  }

  // ==========================================================================
  // The document: writes
  // ==========================================================================

  createFeature(feature: Feature): boolean {
    return this.#apply(() => {
      if (this.tables.findRow(feature.id) !== undefined) {
        throw new Error(`Feature with id "${feature.id}" already exists`);
      }
      if (!this.#layers.has(feature.layerId)) {
        throw new Error(`Layer with id "${feature.layerId}" not found`);
      }
      const group = feature.groupId ? this.#groups.get(feature.groupId) : undefined;
      if (feature.groupId && !group) {
        throw new Error(`Group with id "${feature.groupId}" not found`);
      }
      const [handle] = this.writer.allocateHandles(utf8ColumnFromStrings([feature.id]));
      // A row deleted and kept is created again at the place it had in its layer and its group
      const kept = this.#internals.placeOf(handle);
      const keptGroup = kept ? kept.group.data.groups[kept.row] : -1;
      const sameLayer = kept?.layer.layerId === feature.layerId;
      const fields = new Map<RowField, unknown>([
        ['type', feature.type],
        ['layerId', feature.layerId],
        ['geometry', feature.geometry],
        [
          'order',
          kept && sameLayer
            ? utf8String(kept.group.data.itemKeys, kept.row)
            : keyAfter(this.#lastItemKey(feature.layerId)),
        ],
        ['style', feature.style ?? {}],
        ['visible', feature.visible !== false],
        ['locked', feature.locked === true],
      ]);
      if (group) {
        const handleOfGroup = this.#internals.groups.handleOfId(group.id);
        fields.set('groupId', group.id);
        fields.set(
          'member',
          kept && sameLayer && keptGroup >= 0 && keptGroup === handleOfGroup
            ? utf8String(kept.group.data.memberKeys, kept.row)
            : keyAfter(this.#lastMemberKey(group)),
        );
      }
      for (const [key, value] of Object.entries(feature.properties ?? {})) {
        if (value !== undefined) fields.set(`property:${key}`, value);
      }
      this.#write(handle, fields);
    });
  }

  updateFeature(id: string, updates: Partial<Feature>, options?: UpdateFeatureOptions): boolean {
    return this.#apply(() => {
      const handle = this.tables.findRow(id);
      if (handle === undefined) throw new Error(`Feature with id "${id}" not found`);
      const held = this.#internals.getOpenedFeature(id);
      const current = held ?? (this.#rowFeature(handle) as Feature);
      // The place: another layer or group goes at its end, with the key of the order
      const place = new Map<RowField, unknown>();
      const layerId = updates.layerId ?? current.layerId;
      const groupId = 'groupId' in updates ? updates.groupId || undefined : current.groupId;
      if (layerId !== current.layerId || groupId !== current.groupId) {
        if (!this.#layers.has(layerId)) throw new Error(`Layer with id "${layerId}" not found`);
        const group = groupId ? this.#groups.get(groupId) : undefined;
        if (groupId && !group) throw new Error(`Group with id "${groupId}" not found`);
        if (current.groupId && current.groupId !== groupId) this.#leftGroups.add(current.groupId);
        place.set('layerId', layerId);
        place.set('order', keyAfter(this.#lastItemKey(layerId)));
        place.set('groupId', group?.id ?? '');
        place.set('member', group ? keyAfter(this.#lastMemberKey(group)) : undefined);
      }
      if (!held) {
        const next = { ...current, ...updates, id, layerId, groupId } as Feature;
        const fields = featureFields(current, next);
        for (const [field, value] of place) fields.set(field, value);
        if (fields.size > 0) this.#write(handle, fields);
        return;
      }
      if (place.size > 0) this.#write(handle, place);
      const moved = this.#internals.getOpenedFeature(id) as Feature;
      if (options?.isIntermediate) {
        this.writer.applyOpened(id, { ...moved, ...updates, id, layerId, groupId } as Feature, {
          intermediate: true,
        });
        return;
      }
      // The values an edit ends with: over the values without the ones of its middle
      const committed = this.#internals.heldCommitted(id) ?? moved;
      this.writer.applyOpened(id, {
        ...committed,
        ...updates,
        id,
        layerId: moved.layerId,
        groupId: moved.groupId,
      } as Feature);
    });
  }

  abortIntermediateUpdates(ids: string[]): void {
    this.transact(() => {
      for (const id of ids) {
        const committed = this.#internals.heldCommitted(id);
        const held = this.#internals.getOpenedFeature(id);
        if (committed && held && committed !== held) this.writer.applyOpened(id, committed);
      }
    });
  }

  deleteFeature(id: string): boolean {
    return this.#apply(() => {
      const handle = this.tables.findRow(id);
      if (handle === undefined) throw new Error(`Feature with id "${id}" not found`);
      const group = this.#groupIdOfRow(handle);
      if (group !== undefined) this.#leftGroups.add(group);
      this.writer.apply(
        { handles: Int32Array.of(handle), fields: new Map(), deleted: Uint8Array.of(1) },
        this.#keeping(),
      );
    });
  }

  createLayer(layer: Layer): boolean {
    return this.#apply(() => {
      if (this.#layers.has(layer.id)) throw new Error(`Layer with id "${layer.id}" already exists`);
      const created = tableLayerOf(layer);
      this.#layers.set(layer.id, created);
      const previous = [...this.#order];
      if (!this.#order.includes(layer.id)) this.#order.push(layer.id);
      this.#bus.merge({
        layers: {
          created: [created],
          ...(previous.length !== this.#order.length && {
            orderChanged: { order: [...this.#order], previous },
          }),
        },
      });
    });
  }

  updateLayer(id: string, updates: Partial<Layer>): boolean {
    return this.#apply(() => {
      const previous = this.#layers.get(id);
      if (!previous) throw new Error(`Layer with id "${id}" not found`);
      if ('items' in updates && updates.items !== undefined) {
        throw new Error(`The items of the layer "${id}" are its rows: they are not listed`);
      }
      const { kind: _kind, ...fields } = updates as Partial<TableLayer>;
      const layer = frozenCopy({ ...previous, ...fields, id, kind: 'table' as const });
      this.#layers.set(id, layer);
      this.#bus.merge({ layers: { updated: [{ id, layer, previous }] } });
    });
  }

  deleteLayer(id: string): boolean {
    return this.#apply(() => {
      const layer = this.#layers.get(id);
      if (!layer) throw new Error(`Layer with id "${id}" not found`);
      // Its rows are deleted, then its groups; they are kept as they are (created again, the
      // layer gets them back where they were)
      const cursor = this.tables.scan({ layerIds: [id] });
      for (let batch = cursor.next(); batch; batch = cursor.next()) {
        this.writer.apply(
          { handles: batch, fields: new Map(), deleted: new Uint8Array(batch.length).fill(1) },
          this.#keeping(),
        );
      }
      const groups = [...this.#groups.values()].filter((group) => group.layerId === id);
      this.#deleteGroups(groups);
      this.#layers.delete(id);
      const previous = [...this.#order];
      this.#order = this.#order.filter((entry) => entry !== id);
      this.#bus.merge({
        layers: {
          deleted: [layer],
          ...(previous.length !== this.#order.length && {
            orderChanged: { order: [...this.#order], previous },
          }),
        },
      });
    });
  }

  setLayerOrder(order: string[]): boolean {
    return this.#apply(() => {
      const previous = [...this.#order];
      this.#order = [...new Set(order.filter((id) => typeof id === 'string' && id !== ''))];
      this.#bus.merge({ layers: { orderChanged: { order: [...this.#order], previous } } });
    });
  }

  reorderInLayer(): boolean {
    throw new Error('The items of a layer held as rows are moved by the keys of their order');
  }

  reorderInGroup(): boolean {
    throw new Error('The features of a group held as rows are moved by the keys of their order');
  }

  moveItem(itemId: string, to: ItemPlacement): boolean {
    return this.moveItems([itemId], to);
  }

  /**
   * Writes rows for this client (see the public `Store.applyRows`): the new rows get handles,
   * the rows put in a place get keys made at once between the items around it, the rows deleted
   * are kept by the token of the transaction, and the values before go with the notification
   */
  applyRows(write: RowWrite): boolean {
    return this.#apply(() => {
      const { patch, created, place } = write;
      if (!created && !place) {
        // Values of rows there (a change of many rows selected): written as given
        this.#leaveGroups(patch);
        const deletes = patch.deleted?.some((value) => value !== 0) ?? false;
        this.writer.apply(patch, { before: write.before, ...(deletes && this.#keeping()) });
        return;
      }
      const handles: number[] = Array.from(patch.handles);
      const indexOf = new Map(handles.map((handle, i) => [handle, i]));
      const fields = new Map<RowField, unknown[]>();
      for (const [field, values] of patch.fields) fields.set(field, [...values]);
      const deleted = patch.deleted ? Array.from(patch.deleted) : null;
      const row = (handle: number): number => {
        let at = indexOf.get(handle);
        if (at !== undefined) return at;
        at = handles.length;
        handles.push(handle);
        indexOf.set(handle, at);
        deleted?.push(0);
        return at;
      };
      const set = (field: RowField, at: number, value: unknown): void => {
        let values = fields.get(field);
        if (!values) {
          values = [];
          fields.set(field, values);
        }
        values[at] = value;
      };
      // The new rows
      const createdHandles = created ? this.writer.allocateHandles(created.ids) : new Int32Array(0);
      createdHandles.forEach((handle, k) => {
        const at = row(handle);
        for (const [field, values] of created?.fields ?? []) set(field, at, values[k]);
      });
      this.#leaveGroups(patch);
      // The rows put in a place, the new ones after them
      if (place) {
        const to = place.to;
        if (!this.#layers.has(to.layerId)) {
          throw new Error(`Layer with id "${to.layerId}" not found`);
        }
        const group = to.groupId === undefined ? undefined : this.#groups.get(to.groupId);
        if (to.groupId !== undefined && !group) {
          throw new Error(`Group with id "${to.groupId}" not found`);
        }
        const placed = [...place.rows, ...createdHandles];
        const keys = this.#keysAt(
          to,
          group,
          new Set(placed.map((handle) => handle * 2)),
          placed.length,
        );
        placed.forEach((handle, k) => {
          const at = row(handle);
          const left = this.#groupIdOfRow(handle);
          if (left !== undefined && left !== group?.id) this.#leftGroups.add(left);
          set('layerId', at, to.layerId);
          set('groupId', at, group?.id ?? '');
          if (group) {
            set('member', at, keys[k]);
          } else {
            set('order', at, keys[k]);
            set('member', at, undefined);
          }
        });
      }
      for (const values of fields.values()) values.length = handles.length;
      const deletes = deleted?.some((value) => value !== 0) ?? false;
      this.writer.apply(
        {
          handles: Int32Array.from(handles),
          fields,
          ...(deleted && { deleted: Uint8Array.from(deleted) }),
        },
        { before: write.before, ...(deletes && this.#keeping()) },
      );
    });
  }

  /** A row deleted leaves its group, and so does a row whose group changes */
  #leaveGroups(patch: RowValues): void {
    patch.deleted?.forEach((flag, i) => {
      const left = flag !== 0 ? this.#groupIdOfRow(patch.handles[i]) : undefined;
      if (left !== undefined) this.#leftGroups.add(left);
    });
    const groupIds = patch.fields.get('groupId');
    if (groupIds) {
      patch.handles.forEach((handle, i) => {
        const left = this.#groupIdOfRow(handle);
        if (left !== undefined && (groupIds[i] || undefined) !== left) this.#leftGroups.add(left);
      });
    }
  }

  /**
   * Puts items in a place (see `DocumentStore.moveItems`): the keys of their order are made at
   * once, between the keys of the items just below and above the place, and written with their
   * layer and group (a group of another layer goes there with its members)
   */
  moveItems(itemIds: readonly string[], to: ItemPlacement): boolean {
    return this.#apply(() => {
      const ids = [...new Set(itemIds)];
      if (!this.#layers.has(to.layerId)) throw new Error(`Layer with id "${to.layerId}" not found`);
      const group = to.groupId === undefined ? undefined : this.#groups.get(to.groupId);
      if (to.groupId !== undefined && !group) {
        throw new Error(`Group with id "${to.groupId}" not found`);
      }
      if (group && group.layerId !== to.layerId) {
        throw new Error(`The group "${group.id}" is not in the layer "${to.layerId}"`);
      }
      const codes = ids.map((id) => {
        const code = this.#codeOfId(id);
        if (code < 0) throw new Error(`Item with id "${id}" not found`);
        if (group && (code & 1) === 1) {
          throw new Error(`The group "${id}" cannot go into the group "${group.id}"`);
        }
        return code;
      });
      if (codes.length === 0) return;
      const keys = this.#keysAt(to, group, new Set(codes), codes.length);
      // The members of the groups that go to another layer go with them
      const groupWrites: Array<{ handle: number; key: string; group: TableGroup }> = [];
      const members: number[] = [];
      codes.forEach((code, k) => {
        if ((code & 1) === 0) return;
        const id = ids[k];
        const moved = this.#groups.get(id) as TableGroup;
        groupWrites.push({ handle: code >> 1, key: keys[k], group: moved });
        if (moved.layerId === to.layerId) return;
        const view = this.tables.get(moved.layerId);
        const handle = code >> 1;
        if (view) members.push(...view.listGroupMembers(handle, 0, view.countGroupMembers(handle)));
      });
      if (members.length > 0) {
        this.writer.apply({
          handles: Int32Array.from(members),
          fields: new Map([['layerId', members.map(() => to.layerId)]]),
        });
      }
      if (groupWrites.length > 0) {
        this.#writer.applyGroups({
          handles: Int32Array.from(groupWrites, (write) => write.handle),
          fields: new Map<'order' | 'layerId', unknown[]>([
            ['order', groupWrites.map((write) => write.key)],
            ['layerId', groupWrites.map(() => to.layerId)],
          ]),
        });
        for (const { group: moved } of groupWrites) {
          if (moved.layerId === to.layerId) continue;
          const updated = frozenCopy({ ...moved, layerId: to.layerId });
          this.#groups.set(moved.id, updated);
          this.#bus.merge({
            groups: { updated: [{ id: moved.id, group: updated, previous: moved }] },
          });
        }
      }
      // The features
      const rows: number[] = [];
      const rowKeys: string[] = [];
      codes.forEach((code, k) => {
        if ((code & 1) !== 0) return;
        const handle = code >> 1;
        const left = this.#groupIdOfRow(handle);
        if (left !== undefined && left !== group?.id) this.#leftGroups.add(left);
        rows.push(handle);
        rowKeys.push(keys[k]);
      });
      if (rows.length === 0) return;
      const fields = new Map<RowField, unknown[]>([
        ['layerId', rows.map(() => to.layerId)],
        ['groupId', rows.map(() => group?.id ?? '')],
      ]);
      if (group) {
        fields.set('member', rowKeys);
      } else {
        fields.set('order', rowKeys);
        fields.set(
          'member',
          rows.map(() => undefined),
        );
      }
      this.writer.apply({ handles: Int32Array.from(rows), fields });
    });
  }

  createGroup(group: Group): boolean {
    return this.#apply(() => {
      if (this.#groups.has(group.id)) throw new Error(`Group with id "${group.id}" already exists`);
      if (!this.#layers.has(group.layerId)) {
        throw new Error(`Layer with id "${group.layerId}" not found`);
      }
      // The features listed join the group, which takes the place of the first of them
      const members = group.kind === 'table' ? [] : group.featureIds;
      const first = members.length > 0 ? this.tables.findRow(members[0]) : undefined;
      // Its layer is the one of its first member, when it has one
      const firstLayer = first === undefined ? undefined : this.getFeature(members[0])?.layerId;
      const created = tableGroupOf(firstLayer ? { ...group, layerId: firstLayer } : group);
      // A group deleted whose rows are kept is created again with its handle and the key it had
      const kept = this.#internals.groups.handleOfId(created.id);
      const handle = kept >= 0 ? kept : this.#nextGroup++;
      const keptOrder = kept >= 0 ? this.#writer.getGroupOrder(kept) : undefined;
      this.#writer.applyGroups({
        handles: Int32Array.of(handle),
        fields: new Map<'id' | 'order' | 'layerId' | 'visible' | 'locked', unknown[]>([
          ['id', [created.id]],
          [
            'order',
            [
              keptOrder ??
                (first === undefined
                  ? keyAfter(this.#lastItemKey(created.layerId))
                  : this.#itemKeyOf(first)),
            ],
          ],
          ['layerId', [created.layerId]],
          ['visible', [created.visible]],
          ['locked', [created.locked]],
        ]),
      });
      this.#groups.set(created.id, created);
      this.#bus.merge({ groups: { created: [created] } });
      // The members join it in one write, in their order, with the keys of their places in it
      // made at once (one change of the order, as a deletion of a group puts them back)
      if (members.length > 0)
        this.moveItems(members, { layerId: created.layerId, groupId: created.id });
    });
  }

  updateGroup(id: string, updates: Partial<Group>): boolean {
    return this.#apply(() => {
      const previous = this.#groups.get(id);
      if (!previous) throw new Error(`Group with id "${id}" not found`);
      if ('featureIds' in updates && updates.featureIds !== undefined) {
        throw new Error(`The features of the group "${id}" join it by their rows`);
      }
      if (updates.layerId !== undefined && updates.layerId !== previous.layerId) {
        throw new Error(`The group "${id}" moves to another layer by the keys of its rows`);
      }
      const { kind: _kind, ...fields } = updates as Partial<TableGroup>;
      const group = frozenCopy({ ...previous, ...fields, id, kind: 'table' as const });
      const handle = this.#internals.groups.handleOfId(id);
      if (handle >= 0 && (group.visible !== previous.visible || group.locked !== previous.locked)) {
        this.#writer.applyGroups({
          handles: Int32Array.of(handle),
          fields: new Map<'visible' | 'locked', unknown[]>([
            ['visible', [group.visible]],
            ['locked', [group.locked]],
          ]),
        });
      }
      this.#groups.set(id, group);
      this.#bus.merge({ groups: { updated: [{ id, group, previous }] } });
    });
  }

  /**
   * Deletes a group: its members leave it and take its place in the order of its layer, in their
   * order (keys made between the items just below and above the group)
   */
  deleteGroup(id: string): boolean {
    return this.#apply(() => {
      const group = this.#groups.get(id);
      if (!group) throw new Error(`Group with id "${id}" not found`);
      const handle = this.#internals.groups.handleOfId(id);
      const view = this.tables.get(group.layerId);
      const members =
        handle >= 0 && view ? view.listGroupMembers(handle, 0, view.countGroupMembers(handle)) : [];
      if (members.length > 0) {
        const place = this.#neighborsOf(group.layerId, handle * 2 + 1);
        const keys = keysBetween(place.below, place.above, members.length);
        this.writer.apply({
          handles: Int32Array.from(members),
          fields: new Map<RowField, unknown[]>([
            ['groupId', Array.from(members, () => '')],
            ['member', Array.from(members, () => undefined)],
            ['order', keys],
          ]),
        });
      }
      this.#deleteGroups([group]);
    });
  }

  createFile(file: FileData): boolean {
    return this.#apply(() => {
      this.#files.create(file);
      this.#bus.merge({ files: { created: [this.#files.get(file.id) as FileData] } });
    });
  }

  deleteFile(id: string): boolean {
    return this.#apply(() => {
      const file = this.#files.get(id);
      this.#files.delete(id);
      if (file) this.#bus.merge({ files: { deleted: [file] } });
    });
  }

  setMetadata(metadata: Partial<Metadata>): boolean {
    return this.#apply(() => {
      const previous = this.#metadata;
      const next: Metadata = { ...previous };
      for (const [key, value] of Object.entries(metadata)) {
        if (value === undefined) delete (next as Record<string, unknown>)[key];
        else (next as Record<string, unknown>)[key] = value;
      }
      this.#metadata = frozenCopy(next);
      this.#bus.merge({ metadata: { metadata: this.#metadata, previous } });
    });
  }

  // ==========================================================================
  // The state of this client
  // ==========================================================================

  getSelection(): Selection {
    return this.#client.getSelection();
  }
  setSelection(type: SelectionType | null, ids: string[]): void {
    this.#client.setSelection(type, ids);
  }
  getEditingIds(): readonly string[] {
    return this.#client.getEditingIds();
  }
  startEditing(ids: string[]): void {
    this.#client.startEditing(ids);
  }
  endEditing(ids: string[]): void {
    this.#client.endEditing(ids);
  }
  getVertexSelection(): VertexSelection | null {
    return this.#client.getVertexSelection();
  }
  setSelectedVertices(selection: VertexSelection | null): void {
    this.#client.setSelectedVertices(selection);
  }
  getMode(): Mode {
    return this.#client.getMode();
  }
  setMode(mode: Mode): void {
    this.#client.setMode(mode);
  }
  isReadOnly(): boolean {
    return this.#client.isReadOnly();
  }
  setReadOnly(value: boolean): void {
    this.#client.setReadOnly(value);
  }
  isInteractionLocked(): boolean {
    return this.#client.isInteractionLocked();
  }
  setInteractionLock(value: boolean): void {
    this.#client.setInteractionLock(value);
  }
  isHidden(id: string): boolean {
    return this.#client.isHidden(id);
  }
  listHidden(): ReadonlySet<string> {
    return this.#client.listHidden();
  }
  setLocallyHidden(id: string, hidden: boolean): void {
    this.#client.setLocallyHidden(id, hidden);
    // A row hidden on this client is hidden in its state, and the rows of a group by the group
    const handle = this.tables.findRow(id);
    if (handle !== undefined) this.#internals.states.setHidden(Int32Array.of(handle), hidden);
    else if (this.tables.findGroup(id) !== undefined || !hidden) {
      this.#internals.setGroupHidden(id, hidden);
    }
  }

  // ==========================================================================
  // Subscription and transactions
  // ==========================================================================

  subscribe(listener: (changes: StoreChange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  transact<T>(fn: () => T, source: UpdateSource = 'local'): T {
    return this.#bus.transact(fn, source);
  }

  // ==========================================================================
  // Private
  // ==========================================================================

  /**
   * Runs one write of the document; true once it applied. A group a feature left empty is deleted
   * at its end (in the same notification)
   */
  #apply(write: () => void): boolean {
    this.transact(() => {
      this.#depth++;
      try {
        write();
      } finally {
        this.#depth--;
        if (this.#depth === 0) this.#deleteEmptyGroups();
      }
    });
    return true;
  }

  /**
   * What keeps the rows and the groups a deletion of this client deletes: the token of the
   * transaction (none for a deletion from elsewhere, which nothing undoes here)
   */
  #keeping(): { restoreToken?: RestoreToken } {
    if (this.#bus.source === 'remote') return {};
    this.#retain ??= this.writer.createRestoreToken();
    return { restoreToken: this.#retain };
  }

  /**
   * Forgets the ids of the rows deleted from elsewhere past the most kept (the oldest first): a
   * change of such a row that comes later is a new row
   */
  #forgetRemote(changes: StoreChange): void {
    for (const change of changes.rows?.layers.values() ?? []) {
      for (const handle of change.deleted) this.#remoteDeleted.push(handle);
    }
    for (const feature of changes.features?.deleted ?? []) {
      const found = this.writer.lookup(feature.id);
      if (found?.deleted) this.#remoteDeleted.push(found.handle);
    }
    const excess = this.#remoteDeleted.length - REMOTE_DELETED_KEPT;
    if (excess <= 0) return;
    this.writer.forget(Int32Array.from(this.#remoteDeleted.slice(0, excess)));
    this.#remoteDeleted = this.#remoteDeleted.slice(excess);
  }

  /**
   * Writes values of groups of features given to its writer (the writes from elsewhere, in a
   * transaction of their source): written to the tables, and the groups of the document created,
   * changed (their layer, name, shown and locked) and deleted as the values say, in the
   * notification (`groups`)
   */
  #applyGroups(patch: TableGroupPatch, options?: RowApplyOptions): void {
    this.transact(() => {
      const groups = this.#internals.groups;
      const idsBefore = Array.from(patch.handles, (handle) => groups.idOf(handle));
      this.#writer.applyGroups(patch, options);
      const names = patch.fields.get('name');
      const created: TableGroup[] = [];
      const updated: Array<{ id: string; group: TableGroup; previous: TableGroup }> = [];
      const deleted: TableGroup[] = [];
      patch.handles.forEach((handle, i) => {
        if (patch.deleted?.[i]) {
          const id = idsBefore[i];
          const group = id === undefined ? undefined : this.#groups.get(id);
          if (id === undefined || !group) return;
          this.#groups.delete(id);
          deleted.push(group);
          return;
        }
        const id = groups.idOf(handle);
        if (id === undefined) return;
        // The handles given from elsewhere are not given again to the groups created here
        this.#nextGroup = Math.max(this.#nextGroup, handle + 1);
        const previous = this.#groups.get(id);
        const name = names?.[i];
        const fields = {
          id,
          name: typeof name === 'string' ? name : (previous?.name ?? ''),
          layerId: groups.layerOf(handle) as string,
          visible: groups.isVisible(handle),
          locked: groups.isLocked(handle),
        };
        if (!previous) {
          const group = frozenCopy({ ...fields, kind: 'table' as const });
          this.#groups.set(id, group);
          created.push(group);
          return;
        }
        if (
          previous.name === fields.name &&
          previous.layerId === fields.layerId &&
          previous.visible === fields.visible &&
          previous.locked === fields.locked
        ) {
          return;
        }
        const group = frozenCopy({ ...previous, ...fields, kind: 'table' as const });
        this.#groups.set(id, group);
        updated.push({ id, group, previous });
      });
      if (created.length > 0 || updated.length > 0 || deleted.length > 0) {
        this.#bus.merge({
          groups: {
            ...(created.length > 0 && { created }),
            ...(updated.length > 0 && { updated }),
            ...(deleted.length > 0 && { deleted }),
          },
        });
      }
    }, options?.source);
  }

  /** Deletes the groups features left that have no member left */
  #deleteEmptyGroups(): void {
    if (this.#leftGroups.size === 0) return;
    const left = [...this.#leftGroups];
    this.#leftGroups.clear();
    const empty: TableGroup[] = [];
    for (const id of left) {
      const group = this.#groups.get(id);
      if (!group) continue;
      const handle = this.#internals.groups.handleOfId(id);
      const view = this.tables.get(group.layerId);
      if (handle >= 0 && view && view.countGroupMembers(handle) > 0) continue;
      empty.push(group);
    }
    this.#deleteGroups(empty);
  }

  /** The id of the group of features a row is in (undefined outside a group) */
  #groupIdOfRow(handle: RowHandle): string | undefined {
    const place = this.#internals.placeOf(handle);
    const group = place ? place.group.data.groups[place.row] : -1;
    return group >= 0 ? this.#internals.groups.idOf(group) : undefined;
  }

  /** The number of an item: twice the handle of a row, twice the handle of a group plus one */
  #codeOfId(id: string): number {
    const handle = this.tables.findRow(id);
    if (handle !== undefined) return handle * 2;
    if (!this.#groups.has(id)) return -1;
    const group = this.#internals.groups.handleOfId(id);
    return group >= 0 ? group * 2 + 1 : -1;
  }

  /** The walk of the items of a layer (null for a layer that holds no row) */
  #walk(layerId: string): ItemWalk | null {
    const table = this.#internals.layerTable(layerId);
    return table ? new ItemWalk(table, this.#internals) : null;
  }

  /** The key of an item in a layer (its own key, the key of a group), or in a group */
  #keyOfCode(code: number, inGroup: boolean): string {
    const handle = code >> 1;
    // The key written of a group (its members may be read where the key before puts them)
    if ((code & 1) === 1) return this.#writer.getGroupOrder(handle) ?? '';
    const place = this.#internals.placeOf(handle);
    if (!place) return '';
    return utf8String(inGroup ? place.group.data.memberKeys : place.group.data.itemKeys, place.row);
  }

  /** The keys of the items just below and above an item of a layer */
  #neighborsOf(layerId: string, code: number): { below: string | null; above: string | null } {
    const walk = this.#walk(layerId);
    const below = walk?.below(code, -1) ?? null;
    const above = walk?.above(code, -1) ?? null;
    return {
      below: below === null ? null : this.#keyOfCode(below, false),
      above: above === null ? null : this.#keyOfCode(above, false),
    };
  }

  /**
   * `n` keys for items put in a place, between the keys of the items just below and above it
   * among the items that stay (the items put there left out), read from the items next to the
   * place
   */
  #keysAt(
    to: ItemPlacement,
    group: TableGroup | undefined,
    moving: ReadonlySet<number>,
    n: number,
  ): string[] {
    const container = group ? this.#internals.groups.handleOfId(group.id) : -1;
    const walk = this.#walk(to.layerId);
    const inGroup = group !== undefined;
    const keyOf = (code: number | null | undefined): string | null =>
      code === null || code === undefined ? null : this.#keyOfCode(code, inGroup);
    /** The item of an id that stays in the container (-1 for none) */
    const itemOf = (id: string | null | undefined): number => {
      if (id === null || id === undefined || !walk) return -1;
      const code = this.#codeOfId(id);
      return code >= 0 && !moving.has(code) && walk.span(code, container) ? code : -1;
    };
    if (group && container < 0) return keysBetween(null, null, n);
    if (to.below === null) return keysBetween(null, keyOf(walk?.bottom(container, moving)), n);
    const below = itemOf(to.below);
    if (below >= 0) {
      return keysBetween(keyOf(below), keyOf(walk?.above(below, container, moving)), n);
    }
    const above = to.above === null ? -1 : itemOf(to.above);
    if (above >= 0) {
      return keysBetween(keyOf(walk?.below(above, container, moving)), keyOf(above), n);
    }
    return keysBetween(keyOf(walk?.top(container, moving)), null, n);
  }

  /** Writes fields of one row */
  #write(handle: RowHandle, fields: ReadonlyMap<RowField, unknown>): void {
    const columns = new Map<RowField, readonly unknown[]>();
    for (const [field, value] of fields) columns.set(field, [value]);
    this.writer.apply({ handles: Int32Array.of(handle), fields: columns });
  }

  /**
   * Writes rows, after reading the values the rows there were when the transaction began and are
   * not held have for the fields written other than their place (none for a write from
   * elsewhere): the values given (`before`) instead, when there are
   */
  #applyRows(patch: RowValues, options: RowApplyOptions = {}): RowsChange {
    const { before: given, ...rest } = options;
    const before = given ?? (this.#bus.source === 'remote' ? null : this.#readBefore(patch));
    // Only the rows that were not there are noted (a row not noted was there)
    for (const handle of patch.handles) {
      if (!this.#written.has(handle) && !this.#isThere(handle)) this.#written.set(handle, false);
    }
    const change = this.#writer.apply(patch, rest);
    if (before && before.handles.length > 0) this.#before.push(before);
    return change;
  }

  /**
   * The values the rows of a patch that were there when the transaction began and are not held
   * have for the fields it writes other than their place (null for none)
   */
  #readBefore(patch: RowValues): RowValues | null {
    const fields = [...patch.fields.keys()].filter((field) => !PLACE_FIELDS.has(field));
    if (fields.length === 0 && !patch.deleted) return null;
    const rows: number[] = [];
    for (const handle of patch.handles) {
      if (this.#internals.isHeld(handle) || !(this.#written.get(handle) ?? true)) continue;
      if (this.#isThere(handle)) rows.push(handle);
    }
    if (rows.length === 0) return null;
    return this.tables.readValues({
      handles: Int32Array.from(rows),
      fields: new Map(fields.map((field) => [field, []])),
      ...(patch.deleted && { deleted: new Uint8Array(0) }),
    });
  }

  /** Whether a row is there (a row, not deleted) */
  #isThere(handle: RowHandle): boolean {
    const place = this.#internals.placeOf(handle);
    return !!place && (place.group.data.flags[place.row] & ROW_FLAG_DELETED) === 0;
  }

  /** A row not held as a feature (undefined for a deleted row) */
  #rowFeature(handle: RowHandle): Feature | undefined {
    const place = this.#internals.placeOf(handle);
    if (!place || (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0) return undefined;
    return rowFeature(this.#internals.readContext, place.layer.layerId, place.group, place.row);
  }

  /** The key of the order of the last item of a layer (null for none) */
  #lastItemKey(layerId: string): string | null {
    // The keys of the items are in their order; the last one may be a group
    const top = this.#walk(layerId)?.top(-1) ?? null;
    if (top === null) return null;
    let last: string | null = this.#keyOfCode(top, false);
    // A group without members is not an item of the rows; its key may come after
    for (const group of this.#groups.values()) {
      if (group.layerId !== layerId) continue;
      const key = this.#writer.getGroupOrder(this.#internals.groups.handleOfId(group.id));
      if (key !== undefined && (last === null || key > last)) last = key;
    }
    return last;
  }

  /** The key of the order of a row */
  #itemKeyOf(handle: RowHandle): string {
    const place = this.#internals.placeOf(handle);
    return place ? utf8String(place.group.data.itemKeys, place.row) : keyAfter(null);
  }

  /** The key of the last member of a group (null for none) */
  #lastMemberKey(group: TableGroup): string | null {
    const handle = this.#internals.groups.handleOfId(group.id);
    if (handle < 0) return null;
    const last = this.#walk(group.layerId)?.top(handle) ?? null;
    return last === null ? null : this.#keyOfCode(last, true);
  }

  /**
   * Deletes groups of features with the rows that name them. A group this client deletes (not
   * from elsewhere) is kept by the token of the transaction, as its rows deleted are, so that
   * `draw.groups.restore` brings it back at the place it had
   */
  #deleteGroups(groups: readonly TableGroup[]): void {
    if (groups.length === 0) return;
    for (const group of groups) {
      const handle = this.#internals.groups.handleOfId(group.id);
      const view = this.tables.get(group.layerId);
      if (handle >= 0 && view && view.countGroupMembers(handle) > 0) {
        throw new Error(`The group "${group.id}" has members: its rows leave it first`);
      }
    }
    const handles = groups
      .map((group) => this.#internals.groups.handleOfId(group.id))
      .filter((handle) => handle >= 0);
    if (handles.length > 0) {
      this.#writer.applyGroups(
        {
          handles: Int32Array.from(handles),
          fields: new Map(),
          deleted: new Uint8Array(handles.length).fill(1),
        },
        this.#keeping(),
      );
    }
    for (const group of groups) this.#groups.delete(group.id);
    this.#bus.merge({ groups: { deleted: [...groups] } });
  }

  /**
   * Delivers a notification with each row in it once: a row held when the transaction ended is a
   * change of its feature, a row that is not a change of its row
   */
  #deliver(changes: StoreChange): void {
    const before = this.#before;
    this.#before = [];
    this.#written = new Map();
    this.#retain = null;
    if (changes.source === 'remote') this.#forgetRemote(changes);
    const out = reconcile(changes, this.tables, this.#internals, before);
    for (const listener of [...this.#listeners]) {
      try {
        listener(out);
      } catch (error) {
        console.error('Error in a store listener:', error);
      }
    }
  }
}

/**
 * The value of a field of a row as a feature holds it (undefined for the keys of the order, which
 * a feature does not hold)
 */
function featureValue(feature: Feature, field: RowField): { value: unknown } | undefined {
  switch (field) {
    case 'type':
      return { value: feature.type };
    case 'layerId':
      return { value: feature.layerId };
    case 'groupId':
      return { value: feature.groupId || undefined };
    case 'geometry':
      return { value: feature.geometry };
    case 'style':
      return { value: feature.style ?? {} };
    case 'visible':
      return { value: feature.visible !== false };
    case 'locked':
      return { value: feature.locked === true };
    case 'order':
    case 'member':
      return undefined;
    default:
      return {
        value: (feature.properties as Record<string, unknown> | undefined)?.[
          field.slice('property:'.length)
        ],
      };
  }
}

/**
 * The values the rows had when the transaction began (see `TableContractStore`): the values the
 * writes read, and the values the features of the rows held when they were written had before
 * (the rows no longer held at its end); a field of a row no write read had the value its feature
 * had before when it was held, the one it has now otherwise
 */
function valuesBefore(
  parts: readonly RowValues[],
  updated: readonly { id: string; feature: Feature; previous: Feature }[],
  released: readonly { id: string; feature: Feature; previous: Feature }[],
  tables: FeatureTables,
): RowValues | undefined {
  const fromFeatures: RowValues[] = [];
  for (const entry of released) {
    const handle = tables.findRow(entry.id);
    if (handle === undefined) continue;
    const fields = featureFields(entry.feature, entry.previous);
    if (fields.size === 0) continue;
    fromFeatures.push({
      handles: Int32Array.of(handle),
      fields: new Map([...fields].map(([field, value]) => [field, [value]])),
    });
  }
  const previous = new Map(updated.map((entry) => [entry.id, entry.previous]));
  return combineValuesBefore([...parts, ...fromFeatures], {
    field: (handles, field) => {
      const now = tables.readValues({ handles, fields: new Map([[field, []]]) }).fields.get(field);
      return Array.from(handles, (handle, k) => {
        const feature = previous.get(tables.getRowId(handle) as string);
        const value = feature && featureValue(feature, field);
        return value ? value.value : now?.[k];
      });
    },
    deleted: (handles) =>
      tables.readValues({ handles, fields: new Map(), deleted: new Uint8Array(0) }).deleted ??
      new Uint8Array(handles.length),
  });
}

/**
 * A notification with each row in it once (see `TableContractStore`): the rows written that are
 * held at its end are changes of their features (a row created and held a feature created, not
 * held), and the features of rows no longer held are changes of their rows; the values the rows
 * had before go with them (`previousValues`), and make the features before of the rows held
 */
function reconcile(
  changes: StoreChange,
  tables: FeatureTables,
  internals: FeatureTablesInternals,
  parts: readonly RowValues[],
): StoreChange {
  const rows = changes.rows;
  const updatedFeatures = changes.features?.updated;
  if (!rows && !updatedFeatures?.length && parts.length === 0) return changes;
  const out: StoreChange = { ...changes };
  // The features no longer held at the end are changes of their rows
  const released = (updatedFeatures ?? []).filter((entry) => {
    const handle = tables.findRow(entry.id);
    return handle === undefined || !internals.isHeld(handle);
  });
  const before = valuesBefore(parts, updatedFeatures ?? [], released, tables);
  /** The places of the rows in the values before (made once a row held asks) */
  let beforeRows: Map<RowHandle, number> | null = null;
  /** The feature of a row held before the transaction, from the values before */
  const previousOf = (handle: RowHandle, feature: Feature): Feature => {
    beforeRows ??= new Map(Array.from(before?.handles ?? [], (h, i) => [h, i]));
    const i = beforeRows.get(handle);
    if (!before || i === undefined) return feature;
    const fields = new Map<RowField, unknown>();
    for (const [field, values] of before.fields) fields.set(field, values[i]);
    return featureWithFields(feature, fields);
  };
  const created: Feature[] = [...(changes.features?.created ?? [])];
  const updated = [...(updatedFeatures ?? [])];
  const createdIds = new Set<string>();
  const layers = new Map<string, LayerRowsChange>();
  // The rows held at the end are changes of their features
  /** The feature a row held at the end is (its id read only for a row held) */
  const heldFeature = (handle: RowHandle): { id: string; feature: Feature } | undefined => {
    if (!internals.isHeld(handle)) return undefined;
    const id = tables.getRowId(handle) as string;
    const feature = internals.getOpenedFeature(id);
    return feature ? { id, feature } : undefined;
  };
  for (const [layerId, change] of rows?.layers ?? []) {
    if (internals.heldCount === 0) {
      // No row is held: the rows of the change are changes of rows
      if (change.created.length + change.updated.length + change.deleted.length > 0) {
        layers.set(layerId, change);
      }
      continue;
    }
    // The rows of the change as they are when none of them is held (most of a change of many)
    let keptCreated: number[] | null = null;
    let keptUpdated: number[] | null = null;
    change.created.forEach((handle, i) => {
      const held = heldFeature(handle);
      if (!held) {
        keptCreated?.push(handle);
        return;
      }
      keptCreated ??= Array.from(change.created.subarray(0, i));
      created.push(held.feature);
      createdIds.add(held.id);
    });
    change.updated.forEach((handle, i) => {
      const held = heldFeature(handle);
      if (!held) {
        keptUpdated?.push(handle);
        return;
      }
      keptUpdated ??= Array.from(change.updated.subarray(0, i));
      if (!updated.some((entry) => entry.id === held.id)) {
        updated.push({
          id: held.id,
          feature: held.feature,
          previous: previousOf(handle, held.feature),
        });
      }
    });
    const keep = {
      created: keptCreated ? Int32Array.from(keptCreated) : change.created,
      updated: keptUpdated ? Int32Array.from(keptUpdated) : change.updated,
      deleted: change.deleted,
    };
    if (keep.created.length + keep.updated.length + keep.deleted.length === 0) continue;
    layers.set(layerId, { ...change, ...keep });
  }
  for (const entry of released) {
    const handle = tables.findRow(entry.id);
    if (handle === undefined) continue;
    const layer = entry.feature.layerId;
    const change = layers.get(layer) ?? {
      created: new Int32Array(0),
      updated: new Int32Array(0),
      deleted: new Int32Array(0),
      fields: new Set<RowField>(),
      styleKeys: new Set<string>(),
    };
    if (change.updated.includes(handle)) continue;
    const fields = new Set<RowField>(change.fields);
    for (const field of featureFields(entry.previous, entry.feature).keys()) fields.add(field);
    layers.set(layer, {
      ...change,
      updated: Int32Array.from([...change.updated, handle]),
      fields,
    });
  }
  const kept = updated.filter((entry) => !released.includes(entry));
  const features = { ...changes.features };
  if (created.length > 0) features.created = created;
  else delete features.created;
  if (kept.length > 0) features.updated = kept;
  else delete features.updated;
  if (Object.keys(features).length > 0) out.features = features;
  else delete out.features;
  // The values before go with the rows (whether each row is a feature or a row at the end)
  if (layers.size > 0) out.rows = { layers } as RowsChange;
  else delete out.rows;
  if (before) out.previousValues = before;
  else delete out.previousValues;
  // A row created and held is a feature created, not a row made a feature
  if (out.opened && createdIds.size > 0) {
    out.opened = {
      added: out.opened.added.filter((feature) => !createdIds.has(feature.id)),
      removed: out.opened.removed,
    };
  }
  return out;
}

/** A layer given to the Store, as a layer held as rows (the items it lists are not kept) */
function tableLayerOf(layer: Layer): TableLayer {
  const { kind: _kind, ...fields } = layer as Layer & { items?: unknown };
  delete (fields as { items?: unknown }).items;
  return frozenCopy({ ...(fields as Omit<TableLayer, 'kind'>), kind: 'table' });
}

/** A group given to the Store, as a group of a layer held as rows */
function tableGroupOf(group: Group): TableGroup {
  const { kind: _kind, ...fields } = group as Group & { featureIds?: unknown };
  delete (fields as { featureIds?: unknown }).featureIds;
  return frozenCopy({ ...(fields as Omit<TableGroup, 'kind'>), kind: 'table' });
}
