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
 *   (`writeHeld`), a write of a row that is not held writes the row (`apply`). A new feature is
 *   put at the end of its layer (or of its group), with a key after the last one
 * - The writes in the middle of an edit (`isIntermediate`) are shown and kept apart from the
 *   values others write meanwhile; `abortIntermediateUpdates` writes back the values without
 *   them
 * - One notification per outermost transaction. A row is in it once: as a change of its feature
 *   when it is held when the transaction ends, as a change of its row otherwise. A row created
 *   and held in the same transaction is a feature created
 * - The writes of rows from elsewhere go through the writer it returns, in a transaction with
 *   their source (`store.transact(() => writer.apply(patch), 'remote')`)
 * - `listFeatures` and `listFeaturesInOrder` throw: the rows are read from the tables
 */

import type {
  FeatureTables,
  FeatureTablesOptions,
  FeatureTablesWriter,
  RowField,
  RowHandle,
} from '../api/tables.js';
import { featureFields } from '../feature-table/feature-fields.js';
import {
  createFeatureTablesStore,
  type FeatureTablesInternals,
  featureTablesInternals,
} from '../feature-table/feature-tables.js';
import { rowFeature } from '../feature-table/row-read.js';
import { ROW_FLAG_DELETED } from '../table/row-group-types.js';
import { utf8ColumnFromStrings, utf8String } from '../table/utf8-column.js';
import { DrawStore } from './draw-store.js';
import { ChangeBus } from './memory/change-bus.js';
import { FileStore } from './memory/file-store.js';
import { frozenCopy } from './memory/frozen.js';
import { MemoryClientState } from './memory/ui-state.js';
import { keyAfter } from './order-keys.js';
import type { Store, StoreContract } from './store.js';
import type {
  Feature,
  FileData,
  Group,
  Layer,
  LayerRowsChange,
  Metadata,
  Mode,
  RowsChange,
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
 * Creates an empty in-memory Store that holds its features as rows of columns
 *
 * @param options The options of its tables (the Worker of the host that builds the rows)
 * @returns The Store, and the writer of its tables: what writes rows from elsewhere (in a
 *   transaction of the Store with their source) and takes row groups in (`adopt`)
 *
 * @internal
 */
export function createTableMemoryStore(options: Omit<FeatureTablesOptions, 'hooks'> = {}): {
  store: Store;
  writer: FeatureTablesWriter;
} {
  const contract = new TableContractStore(options);
  return { store: new DrawStore(contract), writer: contract.writer };
}

/** The writes of a feature not held, by row, with the feature before them (one transaction) */
type Before = Map<RowHandle, Feature>;

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
  readonly writer: FeatureTablesWriter;
  readonly #internals: FeatureTablesInternals;
  readonly #layers = new Map<string, TableLayer>();
  #order: string[] = [];
  readonly #groups = new Map<string, TableGroup>();
  #nextGroup = 0;
  #metadata: Metadata = {};
  /** The features before the writes of this transaction of the rows not held */
  #before: Before = new Map();

  constructor(options: Omit<FeatureTablesOptions, 'hooks'> = {}) {
    const { tables, writer } = createFeatureTablesStore({
      ...options,
      hooks: { emit: (change) => this.#bus.merge(change as StoreChange) },
    });
    this.tables = tables;
    this.writer = writer;
    this.#internals = featureTablesInternals(tables) as FeatureTablesInternals;
    this.#bus.subscribe((changes) => this.#deliver(changes));
  }

  // ==========================================================================
  // The document: reads
  // ==========================================================================

  getFeature(id: string): Feature | undefined {
    const held = this.tables.heldFeature(id);
    if (held) return held;
    const handle = this.tables.handleOf(id);
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
      if (this.tables.handleOf(feature.id) !== undefined) {
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
      const fields = new Map<RowField, unknown>([
        ['type', feature.type],
        ['layerId', feature.layerId],
        ['geometry', feature.geometry],
        ['order', keyAfter(this.#lastItemKey(feature.layerId))],
        ['style', feature.style ?? {}],
        ['visible', feature.visible !== false],
        ['locked', feature.locked === true],
      ]);
      if (group) {
        fields.set('groupId', group.id);
        fields.set('member', keyAfter(this.#lastMemberKey(group)));
      }
      for (const [key, value] of Object.entries(feature.properties ?? {})) {
        if (value !== undefined) fields.set(`property:${key}`, value);
      }
      this.#write(handle, fields);
    });
  }

  updateFeature(id: string, updates: Partial<Feature>, options?: UpdateFeatureOptions): boolean {
    return this.#apply(() => {
      const handle = this.tables.handleOf(id);
      if (handle === undefined) throw new Error(`Feature with id "${id}" not found`);
      const held = this.tables.heldFeature(id);
      const current = held ?? (this.#rowFeature(handle) as Feature);
      // The place: another layer or group goes at its end, with the key of the order
      const place = new Map<RowField, unknown>();
      const layerId = updates.layerId ?? current.layerId;
      const groupId = 'groupId' in updates ? updates.groupId || undefined : current.groupId;
      if (layerId !== current.layerId || groupId !== current.groupId) {
        if (!this.#layers.has(layerId)) throw new Error(`Layer with id "${layerId}" not found`);
        const group = groupId ? this.#groups.get(groupId) : undefined;
        if (groupId && !group) throw new Error(`Group with id "${groupId}" not found`);
        place.set('layerId', layerId);
        place.set('order', keyAfter(this.#lastItemKey(layerId)));
        place.set('groupId', group?.id ?? '');
        place.set('member', group ? keyAfter(this.#lastMemberKey(group)) : undefined);
      }
      if (!held) {
        this.#rememberBefore(handle, current);
        const next = { ...current, ...updates, id, layerId, groupId } as Feature;
        const fields = featureFields(current, next);
        for (const [field, value] of place) fields.set(field, value);
        if (fields.size > 0) this.#write(handle, fields);
        return;
      }
      if (place.size > 0) this.#write(handle, place);
      const moved = this.tables.heldFeature(id) as Feature;
      if (options?.isIntermediate) {
        this.writer.writeHeld(id, { ...moved, ...updates, id, layerId, groupId } as Feature, {
          intermediate: true,
        });
        return;
      }
      // The values an edit ends with: over the values without the ones of its middle
      const committed = this.#internals.heldCommitted(id) ?? moved;
      this.writer.writeHeld(id, {
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
        const held = this.tables.heldFeature(id);
        if (committed && held && committed !== held) this.writer.writeHeld(id, committed);
      }
    });
  }

  deleteFeature(id: string): boolean {
    return this.#apply(() => {
      const handle = this.tables.handleOf(id);
      if (handle === undefined) throw new Error(`Feature with id "${id}" not found`);
      this.writer.apply({
        handles: Int32Array.of(handle),
        fields: new Map(),
        deleted: Uint8Array.of(1),
      });
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
      // Its rows are deleted, then its groups
      const cursor = this.tables.scan({ layerIds: [id] });
      for (let batch = cursor.next(); batch; batch = cursor.next()) {
        this.writer.apply({
          handles: batch,
          fields: new Map(),
          deleted: new Uint8Array(batch.length).fill(1),
        });
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

  createGroup(group: Group): boolean {
    return this.#apply(() => {
      if (this.#groups.has(group.id)) throw new Error(`Group with id "${group.id}" already exists`);
      if (!this.#layers.has(group.layerId)) {
        throw new Error(`Layer with id "${group.layerId}" not found`);
      }
      // The features listed join the group, which takes the place of the first of them
      const members = group.kind === 'table' ? [] : group.featureIds;
      const first = members.length > 0 ? this.tables.handleOf(members[0]) : undefined;
      // Its layer is the one of its first member, when it has one
      const firstLayer = first === undefined ? undefined : this.getFeature(members[0])?.layerId;
      const created = tableGroupOf(firstLayer ? { ...group, layerId: firstLayer } : group);
      const handle = this.#nextGroup++;
      this.writer.applyGroups({
        handles: Int32Array.of(handle),
        fields: new Map<'id' | 'order' | 'layerId' | 'visible' | 'locked', unknown[]>([
          ['id', [created.id]],
          [
            'order',
            [
              first === undefined
                ? keyAfter(this.#lastItemKey(created.layerId))
                : this.#itemKeyOf(first),
            ],
          ],
          ['layerId', [created.layerId]],
          ['visible', [created.visible]],
          ['locked', [created.locked]],
        ]),
      });
      this.#groups.set(created.id, created);
      this.#bus.merge({ groups: { created: [created] } });
      for (const id of members) this.updateFeature(id, { groupId: created.id });
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
        this.writer.applyGroups({
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

  deleteGroup(id: string): boolean {
    return this.#apply(() => {
      const group = this.#groups.get(id);
      if (!group) throw new Error(`Group with id "${id}" not found`);
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
    // A row hidden on this client is hidden in its state
    const handle = this.tables.handleOf(id);
    if (handle !== undefined) this.#internals.states.setHidden(Int32Array.of(handle), hidden);
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

  /** Runs one write of the document; true once it applied */
  #apply(write: () => void): boolean {
    this.transact(write);
    return true;
  }

  /** Writes fields of one row */
  #write(handle: RowHandle, fields: ReadonlyMap<RowField, unknown>): void {
    const columns = new Map<RowField, readonly unknown[]>();
    for (const [field, value] of fields) columns.set(field, [value]);
    this.writer.apply({ handles: Int32Array.of(handle), fields: columns });
  }

  /** A row not held as a feature (undefined for a deleted row) */
  #rowFeature(handle: RowHandle): Feature | undefined {
    const place = this.#internals.placeOf(handle);
    if (!place || (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0) return undefined;
    return rowFeature(this.#internals.readContext, place.layer.layerId, place.group, place.row);
  }

  /** Keeps the feature of a row before the first write of it in this transaction */
  #rememberBefore(handle: RowHandle, feature?: Feature): void {
    if (this.#before.has(handle)) return;
    const before = feature ?? this.#rowFeature(handle);
    if (before) this.#before.set(handle, before);
  }

  /** The key of the order of the last item of a layer (null for none) */
  #lastItemKey(layerId: string): string | null {
    const view = this.tables.layer(layerId);
    if (!view || view.itemCount === 0) return null;
    let last: string | null = null;
    // The keys of the items are in their order; the last one may be a group
    const items = view.itemsInOrder(view.itemCount - 1, 1);
    if (items.kinds[0] === 0) {
      const place = this.#internals.placeOf(items.handles[0]);
      if (place) last = utf8String(place.group.data.itemKeys, place.row);
    } else {
      last = this.#internals.groups.orderOf(items.handles[0]) ?? null;
    }
    // A group without members is not an item of the rows; its key may come after
    for (const group of this.#groups.values()) {
      if (group.layerId !== layerId) continue;
      const key = this.#internals.groups.orderOf(this.#internals.groups.handleOfId(group.id));
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
    const view = this.tables.layer(group.layerId);
    const handle = this.#internals.groups.handleOfId(group.id);
    if (!view || handle < 0) return null;
    const count = view.groupMemberCount(handle);
    if (count === 0) return null;
    const [last] = view.groupMembersInOrder(handle, count - 1, 1);
    const place = this.#internals.placeOf(last);
    return place ? utf8String(place.group.data.memberKeys, place.row) : null;
  }

  /** Deletes groups of features with the rows that name them */
  #deleteGroups(groups: readonly TableGroup[]): void {
    if (groups.length === 0) return;
    for (const group of groups) {
      const handle = this.#internals.groups.handleOfId(group.id);
      const view = this.tables.layer(group.layerId);
      if (handle >= 0 && view && view.groupMemberCount(handle) > 0) {
        throw new Error(`The group "${group.id}" has members: its rows leave it first`);
      }
    }
    const handles = groups
      .map((group) => this.#internals.groups.handleOfId(group.id))
      .filter((handle) => handle >= 0);
    if (handles.length > 0) {
      this.writer.applyGroups({
        handles: Int32Array.from(handles),
        fields: new Map(),
        deleted: new Uint8Array(handles.length).fill(1),
      });
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
    this.#before = new Map();
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
 * A notification with each row in it once (see `TableContractStore`): the rows written that are
 * held at its end are changes of their features (a row created and held a feature created, not
 * held), and the features of rows no longer held are changes of their rows
 */
function reconcile(
  changes: StoreChange,
  tables: FeatureTables,
  internals: FeatureTablesInternals,
  before: Before,
): StoreChange {
  const rows = changes.rows;
  const updatedFeatures = changes.features?.updated;
  if (!rows && !updatedFeatures?.length) return changes;
  const out: StoreChange = { ...changes };
  const created: Feature[] = [...(changes.features?.created ?? [])];
  const updated = [...(updatedFeatures ?? [])];
  const createdIds = new Set<string>();
  const layers = new Map<string, LayerRowsChange>();
  // The rows held at the end are changes of their features
  for (const [layerId, change] of rows?.layers ?? []) {
    const keep = { created: [] as number[], updated: [] as number[], deleted: [] as number[] };
    for (const handle of change.created) {
      const id = tables.idOf(handle) as string;
      const feature = internals.isHeld(handle) ? tables.heldFeature(id) : undefined;
      if (!feature) keep.created.push(handle);
      else {
        created.push(feature);
        createdIds.add(id);
      }
    }
    for (const handle of change.updated) {
      const id = tables.idOf(handle) as string;
      const feature = internals.isHeld(handle) ? tables.heldFeature(id) : undefined;
      if (!feature) keep.updated.push(handle);
      else if (!updated.some((entry) => entry.id === id)) {
        updated.push({ id, feature, previous: before.get(handle) ?? feature });
      }
    }
    keep.deleted.push(...change.deleted);
    if (keep.created.length + keep.updated.length + keep.deleted.length === 0) continue;
    layers.set(layerId, {
      ...change,
      created: Int32Array.from(keep.created),
      updated: Int32Array.from(keep.updated),
      deleted: Int32Array.from(keep.deleted),
    });
  }
  // The features no longer held at the end are changes of their rows
  const released = updated.filter((entry) => {
    const handle = tables.handleOf(entry.id);
    return handle === undefined || !internals.isHeld(handle);
  });
  for (const entry of released) {
    const handle = tables.handleOf(entry.id);
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
  if (layers.size > 0) out.rows = { layers } as RowsChange;
  else delete out.rows;
  // A row created and held is a feature created, not a row made a feature
  if (out.held && createdIds.size > 0) {
    out.held = {
      added: out.held.added.filter((feature) => !createdIds.has(feature.id)),
      removed: out.held.removed,
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
