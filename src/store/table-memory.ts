// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The in-memory Store that holds its features as rows of columns
 *
 * Every layer of it is held as rows (`TableLayer`): its features are the rows of the tables it
 * hands out (`tables`), written with the writer of the tables, and a row is a feature only when one
 * is asked for (`getFeature`), made of the row each time (kept by the version of the row,
 * `feature-cache.ts`). It is the example of a
 * Store of rows for a host without a document of its own elsewhere, and what the tests of core
 * run a Store of rows with.
 *
 * - The writes of the features go to the rows (`writeRows`). A new feature is put at the end of its
 *   layer (or of its group), with a key after the last one
 * - One notification per outermost transaction. A row is in it once, as a change of its row
 * - Every write of rows of this client (not `remote`), through the Store or its writer, reads the
 *   values the rows had for the fields it writes, other than their place (the
 *   layer, the group and the keys of the order, which the changes of the order tell), and the
 *   notification carries them (`previousValues`): the rows that were there when the transaction
 *   began, with the values they had then. A write through `applyRows` carries the values it is
 *   given
 * - The rows and the groups this client deletes (a group with its features, left by its last
 *   feature, or dissolved) are kept by the token of the transaction (`features.restore`,
 *   `groups.restore`); what is deleted from elsewhere is not
 * - The writes of rows from elsewhere go through the writer it returns, in a transaction with
 *   their source (`store.transact(() => writer.writeRows(patch), 'remote')`)
 * - `listFeatures` and `listFeaturesInOrder` throw: the rows are read from the tables
 * - A restore of many rows is written in steps, as one transaction told once (`row-steps.ts`)
 * - The write mark of the rows goes up once in each frame that writes values: an outermost
 *   transaction, a step of a restore written in steps, a call of its writer outside a
 *   transaction. The Store keeps it (`write-mark-keeper.ts`) and gives it to its tables, which
 *   stamp it on the rows they write (`write-marks.ts`)
 */

import type { ScheduleIdleWork } from '@sakuzu/kasane';
import type { ItemWalk } from '@sakuzu/kasane/render';
import { ROW_FLAG_DELETED, rowProperties } from '@sakuzu/kasane/render';
import { byteColumnFromStrings, utf8String } from '@sakuzu/tabane';
import type {
  FeatureTables,
  FeatureTablesWriter,
  RowApplyOptions,
  RowField,
  RowRef,
  RowWrite,
  TableGroupField,
  TableGroupPatch,
} from '../api/tables.js';
import { featureFields, featureWithFields } from '../feature-table/feature-fields.js';
import { createFeatureRowTables } from '../feature-table/feature-row-tables.js';
import {
  type FeatureTablesInternalOptions,
  type FeatureTablesInternals,
  featureTablesInternals,
} from '../feature-table/feature-tables.js';
import {
  createFeatureTablesWriter,
  type FeatureTablesStoreWriter,
} from '../feature-table/feature-tables-writer.js';
import type { RowsPlacement } from '../feature-table/item-order.js';
import { asFeatureValues } from '../shared/feature-values.js';
import { whenIdle } from '../shared/utils/idle.js';
import { isGroupHidden, isGroupLocked } from '../table/feature-row-columns.js';
import { DrawStore } from './draw-store.js';
import {
  checkEdits,
  DEFAULT_TRANSFORMS,
  type FeatureUpdate,
  featureIdsOf,
  featureUpdatesOfEdit,
  hasTransformEdits,
  isTransformEdit,
  transformedFeatureFields,
  transformedFields,
  updatesOfEdits,
} from './feature-edits.js';
import { ChangeBus } from './memory/change-bus.js';
import { FileStore } from './memory/file-store.js';
import { frozenCopy } from './memory/frozen.js';
import { MemoryClientState } from './memory/ui-state.js';
import { compareKeys, keyAfter, keysBetween } from './order-keys.js';
import {
  type Containers,
  HeldSnapshot,
  type LastingSnapshot,
  type SnapshotSource,
} from './read-snapshot.js';
import { setRowPlaceKeys } from './row-places.js';
import {
  BULK_SLICE_BUDGET_MS,
  BULK_SLICE_ROWS,
  heldWritesOf,
  rowStepsOf,
  sliceRowValues,
} from './row-steps.js';
import { combineValuesBefore } from './row-values-before.js';
import type {
  EditResult,
  FeatureEdit,
  GeometryTransforms,
  Store,
  StoreContract,
  TransformEdit,
} from './store.js';
import {
  type TransformFieldsRegistry,
  takeTransformFields,
  transformRoleFields,
} from './transform-roles.js';
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
  UpdateSource,
  VertexSelection,
} from './types.js';
import { createWriteMarkKeeper, type WriteMarkKeeper } from './write-mark-keeper.js';

/**
 * The options of a Store of rows: those of its tables, but the notifications, which the Store
 * takes
 *
 * @internal
 */
export type TableStoreOptions = Omit<FeatureTablesInternalOptions, 'onRelease'> & {
  /**
   * The most features the selection lists the IDs of (`SELECTION_IDS_LIMIT` when omitted): past
   * it, the rows selected are read by their states only
   */
  readonly selectionIdsLimit?: number;
  /** The computation of the edits that move, rotate and scale features (the library's when none) */
  readonly transforms?: GeometryTransforms;
};

/**
 * A row an edit that moves, rotates or scales features read, as the edits before leave it: its
 * type, its geometry, the keys of `properties` read and the fields written
 */
interface TransformedRow {
  readonly handle: RowRef;
  readonly type: string;
  geometry: Feature['geometry'];
  readonly properties: Map<string, unknown>;
  readonly fields: Map<RowField, unknown>;
}

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
  const { selectionIdsLimit, transforms, ...tableOptions } = options;
  const contract = new TableContractStore(tableOptions, transforms);
  return {
    store: new DrawStore(contract, selectionIdsLimit === undefined ? {} : { selectionIdsLimit }),
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

/** No values of rows: what a run of a restore written in steps reads before (see `#beginSteps`) */
const NO_VALUES: RowValues = { handles: new Int32Array(0), fields: new Map() };

/** A restore of rows written in steps (`row-steps.ts`) */
interface RestoreSteps {
  readonly patch: RowValues;
  /** The first row not written yet */
  at: number;
  /** Whether it deletes rows (they are kept by the token of the transaction) */
  readonly deletes: boolean;
  readonly onEnd: () => void;
  /** The next step waiting */
  timer: ReturnType<typeof setTimeout> | null;
  /** Tells the changes of the order of the whole restore (once its last rows are written) */
  readonly tellOrder: () => void;
}

/**
 * The fields of the place of a row: a write of them is told by the changes of the order, not by
 * the values before
 */
const PLACE_FIELDS: ReadonlySet<RowField> = new Set(['parent', 'key']);

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
  /**
   * The writer of the features over the writer of the tables, which adds what it writes to the
   * notification of the transaction
   */
  readonly #tablesWriter: FeatureTablesStoreWriter;
  /** The writer of the features, its writes of values in the frames of the marks */
  readonly #writer: FeatureTablesWriter;
  readonly #internals: FeatureTablesInternals;
  /** The write mark of the rows, and the frames of writes */
  readonly #marks: WriteMarkKeeper;
  readonly #layers = new Map<string, TableLayer>();
  #order: string[] = [];
  readonly #groups = new Map<string, TableGroup>();
  #nextGroup = 0;
  #metadata: Metadata = {};
  /** The values the writes of this transaction read before they wrote, in their order */
  #before: RowValues[] = [];
  /** The rows this transaction wrote, and whether each was there when it began */
  #written = new Map<RowRef, boolean>();
  /** The depth of the writes of the document being made */
  #depth = 0;
  /** What keeps the rows deleted in this transaction (made at the first deletion) */
  #retain: RestoreToken | null = null;
  /** The rows deleted from elsewhere, the oldest first, whose ids are kept a while */
  #remoteDeleted: RowRef[] = [];
  /** The groups features left in the write being made (deleted at its end when empty) */
  readonly #leftGroups = new Set<string>();
  /**
   * The writes of rows in parts under way (`HeldWrites.beginRowParts`): the groups their parts
   * leave empty are deleted at their end
   */
  #groupsHeld = 0;
  /**
   * Where the rows of the values that put rows in a place in parts (`HeldWrites.placeRows`) are
   * once written, for the changes of the order of their parts
   */
  readonly #placements = new WeakMap<RowValues, RowsPlacement>();
  /** What runs the idle work of the tables */
  #idleScheduler: ScheduleIdleWork = whenIdle;
  /** The idle work of the tables that came while a write over several tasks was held */
  readonly #idleWaiting = new Set<{ cancel: () => void; run: (deadline: number) => void }>();
  /** The restore of rows written in steps under way (`row-steps.ts`) */
  #steps: RestoreSteps | null = null;
  /** Whether a step of it is being written (its own writes and reads do not finish it) */
  #inStep = false;
  /**
   * The document as it was when the write over several tasks under way began (`read-snapshot.ts`),
   * kept until its last step
   */
  #snapshot: HeldSnapshot | null = null;
  /** The snapshots transactions keep from their beginning to the end of their functions */
  readonly #lasting = new Set<HeldSnapshot>();
  /** The depth of the reads of the snapshot: their reads of the tables finish nothing */
  #through = 0;

  /** The computation of the edits that move, rotate and scale features (the library's when none) */
  readonly transforms?: GeometryTransforms;
  /** The fields the custom types of the instance declare, which the edits read (none: no instance) */
  #transformFields: TransformFieldsRegistry | null = null;

  constructor(
    options: Omit<TableStoreOptions, 'selectionIdsLimit' | 'transforms'> = {},
    transforms?: GeometryTransforms,
  ) {
    if (transforms) this.transforms = transforms;
    takeTransformFields(this, (fields) => {
      this.#transformFields = fields;
    });
    const idle = options.scheduleIdleWork ?? whenIdle;
    this.#idleScheduler = idle;
    const { tables, writer: tablesWriter } = createFeatureRowTables({
      ...options,
      // The work of the tables while the page is idle waits for the end of a write over several
      // tasks: it runs once after its last step, not once between each two of them
      scheduleIdleWork: (task) => {
        const entry = { cancel: (): void => {}, run: (_deadline: number): void => {} };
        entry.run = (deadline) => {
          if (this.#bus.held) {
            this.#idleWaiting.add(entry);
            return;
          }
          task(deadline);
        };
        entry.cancel = idle(entry.run);
        return () => {
          entry.cancel();
          this.#idleWaiting.delete(entry);
        };
      },
      // Nothing else needs the ids of the rows deleted that nothing keeps any more
      onRelease: (handles) => this.#writer.forget(handles),
      // A read of the rows comes after the restore under way, finished first
      beforeRead: () => this.#readGate(),
    });
    this.tables = tables;
    this.#internals = featureTablesInternals(tables) as FeatureTablesInternals;
    const writer = createFeatureTablesWriter(
      tablesWriter,
      this.#internals,
      (change) => this.#bus.merge(change),
      (id) => this.#layers.has(id),
    );
    this.#tablesWriter = writer;
    const marks = createWriteMarkKeeper(tables, this.#internals);
    this.#marks = marks;
    // Every write of values of the tables raises the mark of its frame (once a frame)
    this.#writer = {
      ...writer,
      // The snapshot of a write over several tasks keeps what each write changes before it
      addPages: (layerId, blocks) => {
        for (const snapshot of this.#snapshots()) snapshot.invalidate();
        return marks.write(() => writer.addPages(layerId, blocks));
      },
      writeRows: (patch, options) => {
        for (const snapshot of this.#snapshots()) snapshot.beforeRows(patch);
        return marks.write(() => writer.writeRows(patch, options));
      },
      writeGroups: (patch, options) => {
        for (const snapshot of this.#snapshots()) snapshot.beforeGroups(patch);
        return marks.write(() => writer.writeGroups(patch, options));
      },
      clear: () => {
        for (const snapshot of this.#snapshots()) snapshot.invalidate();
        return marks.write(() => writer.clear());
      },
    };
    const own = this.#writer;
    this.writer = {
      lookup: (id) => own.lookup(id),
      createRestoreToken: () => own.createRestoreToken(),
      forget: (handles) => own.forget(handles),
      allocateHandles: (ids, hashes) => own.allocateHandles(ids, hashes),
      addPages: (layerId, blocks) => this.transact(() => own.addPages(layerId, blocks)),
      writeRows: (patch, options) => this.transact(() => this.#applyRows(patch, options)),
      writeGroups: (patch, options) => this.#applyGroups(patch, options),
      clear: () => this.transact(() => own.clear(), 'remote'),
    };
    this.#bus.subscribe((changes) => this.#deliver(changes));
    rowStepsOf.set(this, {
      begin: (write, onEnd) => this.#beginSteps(write, onEnd),
      finish: () => this.#finishSteps(),
    });
    heldWritesOf.set(this, {
      hold: (finish) => this.#bus.hold(finish),
      // Each step is a frame of the write marks, as a step of a restore is
      step: (fn) => this.#marks.frame(() => this.#bus.continueHeld(fn)),
      release: () => {
        this.#endSnapshot();
        this.#bus.release();
        this.#runIdleWaiting();
      },
      openSnapshot: () => this.#openSnapshot(),
      closeSnapshot: () => this.#endSnapshot(),
      snapshot: () => (this.#snapshot?.valid ? this.#snapshot : null),
      openLasting: () => this.#openLasting(),
      placeRows: (rows, to) => {
        const placed = Array.from(rows);
        const moving = new Set(placed.map((handle) => handle * 2));
        const { parent, keys } = this.#placing(placed, to, moving);
        const values: RowValues = {
          handles: Int32Array.from(rows),
          fields: new Map<RowField, unknown[]>([
            ['parent', new Array<unknown>(rows.length).fill(parent)],
            ['key', keys],
          ]),
        };
        // Where they are once written, for the changes of the order of their parts
        const group = to.groupId === undefined ? undefined : this.#groups.get(to.groupId);
        this.#placements.set(values, this.#rowsPlacement(to, group, moving));
        return values;
      },
      beginRowParts: (patch) => {
        const placement = this.#placements.get(patch);
        const tellOrder = placement
          ? this.#tablesWriter.watchPlacementOf(patch, placement)
          : this.#tablesWriter.watchOrderOf(patch);
        this.#groupsHeld++;
        return () => {
          this.#groupsHeld--;
          tellOrder();
          if (this.#groupsHeld === 0) this.transact(() => this.#deleteEmptyGroups());
        };
      },
    });
    setRowPlaceKeys(tables, (to) => this.#placeKeys(to));
  }

  /**
   * The keys of the order a new feature put in a place gets, among the items there now (see
   * `row-places.ts`): null when the layer or the group is not there
   */
  #placeKeys(to: ItemPlacement): { key: string; group?: number } | null {
    if (!this.#layers.has(to.layerId)) return null;
    const group = to.groupId === undefined ? undefined : this.#groups.get(to.groupId);
    if (to.groupId !== undefined && (!group || group.layerId !== to.layerId)) return null;
    const [key] = this.#keysAt(to, group, new Set(), 1);
    if (!group) return { key };
    // The key of a member is its key among the members of its group
    return { key, group: this.#internals.groups.handleOfId(group.id) };
  }

  // ==========================================================================
  // The document: reads
  // ==========================================================================

  getFeature(id: string): Feature | undefined {
    // A read comes after the restore under way, as through the tables
    this.#readGate();
    const selected = this.#internals.featureCache.selectedFeatureOf(id);
    if (selected) return selected;
    const handle = this.tables.getRowRef(id);
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
    return this.createFeatures([feature]);
  }

  /**
   * Creates features, one after the other in the order given (see the public
   * `Store.createFeatures`): every one is checked before any is written, the keys of their order
   * are made at once after the last key of each layer and group read once (short, `EndKeys`),
   * and the rows of each layer are written in one write of the tables, so that many features
   * cost their own rows rather than the rows of their layer once per feature
   */
  createFeatures(features: readonly Feature[]): boolean {
    return this.#apply(() => {
      const ids = new Set<string>();
      const groups: Array<TableGroup | undefined> = [];
      for (const feature of features) {
        if (ids.has(feature.id) || this.tables.getRowRef(feature.id) !== undefined) {
          throw new Error(`Feature with id "${feature.id}" already exists`);
        }
        ids.add(feature.id);
        if (!this.#layers.has(feature.layerId)) {
          throw new Error(`Layer with id "${feature.layerId}" not found`);
        }
        const group = feature.groupId ? this.#groups.get(feature.groupId) : undefined;
        if (feature.groupId && !group) {
          throw new Error(`Group with id "${feature.groupId}" not found`);
        }
        groups.push(group);
      }
      if (features.length === 0) return;
      const handles = this.writer.allocateHandles(
        byteColumnFromStrings(features.map((feature) => feature.id)),
      );
      // The keys of the ends of the layers and the groups, from their last keys read once: the
      // new rows put at an end one after the other get keys made at once, short
      const layerEnds = new Map<string, EndKeys>();
      const groupEnds = new Map<TableGroup, EndKeys>();
      const layerEnd = (layerId: string): EndKeys => {
        let end = layerEnds.get(layerId);
        if (!end) {
          end = new EndKeys(this.#lastItemKey(layerId));
          layerEnds.set(layerId, end);
        }
        return end;
      };
      const groupEnd = (group: TableGroup): EndKeys => {
        let end = groupEnds.get(group);
        if (!end) {
          end = new EndKeys(this.#lastMemberKey(group));
          groupEnds.set(group, end);
        }
        return end;
      };
      // The rows of each layer, in the order given
      const writes = new Map<string, Array<{ handle: RowRef; fields: Map<RowField, unknown> }>>();
      features.forEach((feature, i) => {
        const handle = handles[i];
        const group = groups[i];
        // A row deleted and kept is created again at the place it had in its layer and its group
        const kept = this.#internals.placeOf(handle);
        const keptGroup = kept ? kept.group.data.groups[kept.row] : -1;
        const sameLayer = kept?.table.tableId === feature.layerId;
        const fields = new Map<RowField, unknown>([
          ['type', feature.type],
          ['parent', group ? group.id : feature.layerId],
          ['geometry', feature.geometry],
          ['key', undefined],
          ['style', feature.style ?? {}],
          ['hidden', feature.visible === false],
          ['locked', feature.locked === true],
        ]);
        if (group) {
          // A member is ordered among the members of its group
          const handleOfGroup = this.#internals.groups.handleOfId(group.id);
          const members = groupEnd(group);
          if (kept && sameLayer && keptGroup >= 0 && keptGroup === handleOfGroup) {
            const key = utf8String(kept.group.data.keys, kept.row);
            fields.set('key', key);
            members.keep(key);
          } else {
            members.add((key) => fields.set('key', key));
          }
        } else {
          const end = layerEnd(feature.layerId);
          if (kept && sameLayer) {
            // A row that was a member stands where its group stands
            const key =
              keptGroup >= 0
                ? (this.#internals.getGroupKey(keptGroup) ?? keyAfter(end.first))
                : utf8String(kept.group.data.keys, kept.row);
            fields.set('key', key);
            end.keep(key);
          } else {
            end.add((key) => fields.set('key', key));
          }
        }
        for (const [key, value] of Object.entries(feature.properties ?? {})) {
          if (value !== undefined) fields.set(`properties:${key}`, value);
        }
        if (kept) {
          // The properties the row deleted and kept had and the feature has not are written away,
          // so that the write tells them (one deleted and created again in a transaction is told
          // as updated, its fields written being the ones it changed)
          for (const key of Object.keys(rowProperties(kept.group, kept.row))) {
            if (!fields.has(`properties:${key}`)) fields.set(`properties:${key}`, undefined);
          }
        }
        let rows = writes.get(feature.layerId);
        if (!rows) {
          rows = [];
          writes.set(feature.layerId, rows);
        }
        rows.push({ handle, fields });
      });
      for (const end of layerEnds.values()) end.finish();
      for (const end of groupEnds.values()) end.finish();
      for (const rows of writes.values()) this.#writeRows(rows);
    });
  }

  updateFeature(id: string, updates: Partial<Feature>): boolean {
    return this.#apply(() => {
      const { handle, fields } = this.#updatedFields(id, updates);
      if (fields.size > 0) this.#write(handle, fields);
    });
  }

  /**
   * Updates features one after the other, as `updateFeature` does each: the ones that stay where
   * they are and write the same fields as the one before are written in one write
   */
  #updateFeatures(updates: ReadonlyArray<{ id: string; updates: Partial<Feature> }>): void {
    this.#apply(() => {
      let run: Array<{ handle: RowRef; fields: ReadonlyMap<RowField, unknown> }> = [];
      let runFields = '';
      const inRun = new Set<string>();
      const flush = (): void => {
        if (run.length > 0) this.#writeRows(run);
        run = [];
        runFields = '';
        inRun.clear();
      };
      for (const { id, updates: changes } of updates) {
        // A feature updated again is read as the write before leaves it
        if (inRun.has(id)) flush();
        let updated: { handle: RowRef; fields: Map<RowField, unknown>; moved: boolean };
        try {
          updated = this.#updatedFields(id, changes);
        } catch (error) {
          flush();
          throw error;
        }
        const { handle, fields, moved } = updated;
        if (fields.size === 0) continue;
        if (moved) {
          // Put at the end of a layer or a group: after the writes before it
          flush();
          this.#write(handle, fields);
          continue;
        }
        const names = [...fields.keys()].join('\u0000');
        if (names !== runFields) {
          flush();
          runFields = names;
        }
        run.push({ handle, fields });
        inRun.add(id);
      }
      flush();
    });
  }

  /**
   * The fields an update of a feature writes, and whether it puts the feature in another layer or
   * group (at its end, with the key of the order)
   */
  #updatedFields(
    id: string,
    updates: Partial<Feature>,
  ): { handle: RowRef; fields: Map<RowField, unknown>; moved: boolean } {
    const handle = this.tables.getRowRef(id);
    const current = handle === undefined ? undefined : this.#rowFeature(handle);
    if (handle === undefined || !current) throw new Error(`Feature with id "${id}" not found`);
    // The place: another layer or group goes at its end, with the key of the order
    const place = new Map<RowField, unknown>();
    const layerId = updates.layerId ?? current.layerId;
    const groupId = 'groupId' in updates ? updates.groupId || undefined : current.groupId;
    if (layerId !== current.layerId || groupId !== current.groupId) {
      if (!this.#layers.has(layerId)) throw new Error(`Layer with id "${layerId}" not found`);
      const group = groupId ? this.#groups.get(groupId) : undefined;
      if (groupId && !group) throw new Error(`Group with id "${groupId}" not found`);
      if (current.groupId && current.groupId !== groupId) this.#leftGroups.add(current.groupId);
      place.set('parent', group?.id ?? layerId);
      place.set('key', keyAfter(group ? this.#lastMemberKey(group) : this.#lastItemKey(layerId)));
    }
    const next = { ...current, ...updates, id, layerId, groupId } as Feature;
    const fields = featureFields(current, next);
    for (const [field, value] of place) fields.set(field, value);
    return { handle, fields, moved: place.size > 0 };
  }

  /**
   * Applies edits of features (see the public `Store.applyEdits`): every edit is checked before
   * one is written. The edits of one feature are made into the updates of the features. The rows
   * an edit that moves, rotates or scales features names are read and written as rows, with no
   * feature made (a feature an edit of one feature edited before is moved as that feature):
   * their type, geometry and fields of the roles read at once, the geometry and those fields
   * written in one write
   */
  applyEdits(edits: readonly FeatureEdit[]): EditResult {
    const transforms = this.transforms ?? DEFAULT_TRANSFORMS;
    if (!hasTransformEdits(edits)) {
      // The edits of one feature only: made into the updates of the features
      const { updates, dropped } = updatesOfEdits(
        edits,
        (id) => this.getFeature(id),
        transforms,
        this.#transformFields,
      );
      if (updates.length > 0) this.transact(() => this.#updateFeatures(updates));
      return { dropped };
    }
    const computed = checkEdits(edits, transforms);
    // The features as the edits before leave them, and the rows not made features
    const edited = new Map<string, Feature>();
    const rows = new Map<string, TransformedRow>();
    const updates: FeatureUpdate[] = [];
    let dropped = 0;
    /** A feature as the edits before leave it, made of its row when it was read as one */
    const featureOf = (id: string): Feature | undefined => {
      const made = edited.get(id);
      if (made) return made;
      const feature = this.getFeature(id);
      const row = rows.get(id);
      if (!feature || !row) return feature;
      // The row was edited as a row: the fields written so far go with the feature
      rows.delete(id);
      const written = featureWithFields(feature, row.fields);
      const fields: Partial<Feature> = {};
      if (row.fields.has('geometry')) fields.geometry = written.geometry;
      if (row.fields.size > (row.fields.has('geometry') ? 1 : 0)) {
        fields.properties = written.properties;
      }
      updates.push({ id, updates: fields });
      return written;
    };
    edits.forEach((edit, i) => {
      if (!isTransformEdit(edit)) {
        const feature = featureOf(edit.featureId);
        if (!feature) {
          dropped++;
          return;
        }
        const fields = featureUpdatesOfEdit(feature, edit);
        edited.set(feature.id, { ...feature, ...fields });
        updates.push({ id: feature.id, updates: fields });
        return;
      }
      const transform = computed[i] as TransformEdit;
      const ids = featureIdsOf(edit);
      this.#readRows(ids, edited, rows);
      for (const id of ids) {
        const row = rows.get(id);
        if (row) {
          this.#transformRow(transforms, transform, id, row);
          continue;
        }
        const feature = featureOf(id);
        if (!feature) {
          dropped++;
          continue;
        }
        const fields = transformedFeatureFields(
          transforms,
          transform,
          feature,
          this.#transformFields,
        );
        if (!fields) continue;
        edited.set(feature.id, { ...feature, ...fields });
        updates.push({ id: feature.id, updates: fields });
      }
    });
    const written = [...rows.values()].filter((row) => row.fields.size > 0);
    if (updates.length > 0 || written.length > 0) {
      this.transact(() => {
        for (const { id, updates: fields } of updates) this.updateFeature(id, fields);
        if (written.length > 0) this.#writeRows(written);
      });
    }
    return { dropped };
  }

  /**
   * Reads the rows of features an edit that moves, rotates or scales features names that are not
   * made features yet (not edited as features), at once: their type, geometry and the
   * keys of `properties` of the roles
   */
  #readRows(
    ids: readonly string[],
    edited: ReadonlyMap<string, Feature>,
    rows: Map<string, TransformedRow>,
  ): void {
    const handles: number[] = [];
    const named: string[] = [];
    for (const id of ids) {
      if (edited.has(id) || rows.has(id)) continue;
      const handle = this.tables.getRowRef(id);
      if (handle === undefined) continue;
      handles.push(handle);
      named.push(id);
    }
    if (handles.length === 0) return;
    const keys = transformRoleFields(this.#transformFields);
    const read = this.tables.readValues({
      handles: Int32Array.from(handles),
      fields: new Map<RowField, unknown[]>([
        ['type', []],
        ['geometry', []],
        ...keys.map((key): [RowField, unknown[]] => [`properties:${key}`, []]),
      ]),
    });
    const types = read.fields.get('type') as readonly unknown[];
    const geometries = read.fields.get('geometry') as readonly unknown[];
    const values = keys.map((key) => read.fields.get(`properties:${key}`) as readonly unknown[]);
    named.forEach((id, i) => {
      const properties = new Map<string, unknown>();
      keys.forEach((key, k) => {
        const value = values[k]?.[i];
        if (value !== undefined) properties.set(key, value);
      });
      rows.set(id, {
        handle: handles[i] as number,
        type: types[i] as string,
        geometry: geometries[i] as Feature['geometry'],
        properties,
        fields: new Map(),
      });
    });
  }

  /** Applies an edit that moves, rotates or scales features to a row read as one */
  #transformRow(
    transforms: GeometryTransforms,
    edit: TransformEdit,
    id: string,
    row: TransformedRow,
  ): void {
    const fields = transformedFields(
      transforms,
      edit,
      id,
      row.type,
      row.geometry,
      (key) => row.properties.get(key),
      this.#transformFields,
    );
    if (!fields) return;
    if (fields.geometry !== undefined) {
      row.geometry = fields.geometry;
      row.fields.set('geometry', fields.geometry);
    }
    for (const [key, value] of fields.properties) {
      row.properties.set(key, value);
      row.fields.set(`properties:${key}`, value);
    }
  }

  deleteFeature(id: string): boolean {
    return this.#apply(() => {
      const handle = this.tables.getRowRef(id);
      if (handle === undefined) throw new Error(`Feature with id "${id}" not found`);
      const group = this.#groupIdOfRow(handle);
      if (group !== undefined) this.#leftGroups.add(group);
      this.writer.writeRows(
        { handles: Int32Array.of(handle), fields: new Map(), deleted: Uint8Array.of(1) },
        this.#keeping(),
      );
    });
  }

  createLayer(layer: Layer): boolean {
    return this.#apply(() => {
      if (this.#layers.has(layer.id)) throw new Error(`Layer with id "${layer.id}" already exists`);
      // A layer and a group are named in one space: the parent of a row names one or the other
      if (this.#groups.has(layer.id)) {
        throw new Error(`Layer with id "${layer.id}" already exists as the id of a group`);
      }
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
      // layer gets them back where they were). The rows are deleted in one write: a write of each
      // batch the scan reads made the notification fold the rows and the values before of a
      // thousand writes for a layer of a million rows
      const batches: Int32Array[] = [];
      let count = 0;
      const cursor = this.tables.scan({ layerIds: [id] });
      for (let batch = cursor.next(); batch; batch = cursor.next()) {
        batches.push(batch);
        count += batch.length;
      }
      if (count > 0) {
        const handles = new Int32Array(count);
        let at = 0;
        for (const batch of batches) {
          handles.set(batch, at);
          at += batch.length;
        }
        this.writer.writeRows(
          { handles, fields: new Map(), deleted: new Uint8Array(count).fill(1) },
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
        this.writer.writeRows(patch, { before: write.before, ...(deletes && this.#keeping()) });
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
        const placed = [...place.rows, ...createdHandles];
        const { parent, keys } = this.#placing(placed, place.to);
        placed.forEach((handle, k) => {
          const at = row(handle);
          const left = this.#groupIdOfRow(handle);
          if (left !== undefined && left !== parent) this.#leftGroups.add(left);
          set('parent', at, parent);
          set('key', at, keys[k]);
        });
      }
      for (const values of fields.values()) values.length = handles.length;
      const deletes = deleted?.some((value) => value !== 0) ?? false;
      this.writer.writeRows(
        {
          handles: Int32Array.from(handles),
          fields,
          ...(deleted && { deleted: Uint8Array.from(deleted) }),
        },
        { before: write.before, ...(deletes && this.#keeping()) },
      );
    });
  }

  /**
   * The parent (the group, or the layer) and the keys of the order rows put in a place get,
   * among the items there now, in the order of the rows
   *
   * @param moving - The numbers of the rows as items (made from them when left out)
   */
  #placing(
    placed: readonly number[],
    to: ItemPlacement,
    moving: ReadonlySet<number> = new Set(placed.map((handle) => handle * 2)),
  ): { parent: string; keys: string[] } {
    if (!this.#layers.has(to.layerId)) {
      throw new Error(`Layer with id "${to.layerId}" not found`);
    }
    const group = to.groupId === undefined ? undefined : this.#groups.get(to.groupId);
    if (to.groupId !== undefined && !group) {
      throw new Error(`Group with id "${to.groupId}" not found`);
    }
    const keys = this.#keysAt(to, group, moving, placed.length);
    return { parent: group?.id ?? to.layerId, keys };
  }

  /** A row deleted leaves its group, and so does a row whose group changes */
  #leaveGroups(patch: RowValues): void {
    patch.deleted?.forEach((flag, i) => {
      const left = flag !== 0 ? this.#groupIdOfRow(patch.handles[i]) : undefined;
      if (left !== undefined) this.#leftGroups.add(left);
    });
    const parents = patch.fields.get('parent');
    if (parents) {
      patch.handles.forEach((handle, i) => {
        const parent = parents[i];
        if (parent === undefined) return;
        const left = this.#groupIdOfRow(handle);
        if (left !== undefined && parent !== left) this.#leftGroups.add(left);
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
      // The groups (the members of a group that goes to another layer go there with it)
      const groupWrites: Array<{ handle: number; key: string; group: TableGroup }> = [];
      codes.forEach((code, k) => {
        if ((code & 1) === 0) return;
        const moved = this.#groups.get(ids[k]) as TableGroup;
        groupWrites.push({ handle: code >> 1, key: keys[k], group: moved });
      });
      if (groupWrites.length > 0) {
        this.#writer.writeGroups({
          handles: Int32Array.from(groupWrites, (write) => write.handle),
          fields: new Map<TableGroupField, unknown[]>([
            ['key', groupWrites.map((write) => write.key)],
            ['parent', groupWrites.map(() => to.layerId)],
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
        ['parent', rows.map(() => group?.id ?? to.layerId)],
        ['key', rowKeys],
      ]);
      this.writer.writeRows({ handles: Int32Array.from(rows), fields });
    });
  }

  createGroup(group: Group): boolean {
    return this.#apply(() => {
      if (this.#groups.has(group.id)) throw new Error(`Group with id "${group.id}" already exists`);
      // A layer and a group are named in one space: the parent of a row names one or the other
      if (this.#layers.has(group.id)) {
        throw new Error(`Group with id "${group.id}" already exists as the id of a layer`);
      }
      if (!this.#layers.has(group.layerId)) {
        throw new Error(`Layer with id "${group.layerId}" not found`);
      }
      // The features listed join the group, which takes the place of the first of them
      const members = group.kind === 'table' ? [] : group.featureIds;
      const first = members.length > 0 ? this.tables.getRowRef(members[0]) : undefined;
      // Its layer is the one of its first member, when it has one
      const firstLayer = first === undefined ? undefined : this.getFeature(members[0])?.layerId;
      const created = tableGroupOf(firstLayer ? { ...group, layerId: firstLayer } : group);
      // A group deleted whose rows are kept is created again with its handle and the key it had
      const kept = this.#internals.groups.handleOfId(created.id);
      const handle = kept >= 0 ? kept : this.#nextGroup++;
      const keptOrder = kept >= 0 ? this.#internals.getGroupKey(kept) : undefined;
      this.#writer.writeGroups({
        handles: Int32Array.of(handle),
        fields: new Map<TableGroupField, unknown[]>([
          ['id', [created.id]],
          [
            'key',
            [
              keptOrder ??
                (first === undefined
                  ? keyAfter(this.#lastItemKey(created.layerId))
                  : this.#itemKeyOf(first)),
            ],
          ],
          ['parent', [created.layerId]],
          ['hidden', [!created.visible]],
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
        this.#writer.writeGroups({
          handles: Int32Array.of(handle),
          fields: new Map<TableGroupField, unknown[]>([
            ['hidden', [!group.visible]],
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
        this.writer.writeRows({
          handles: Int32Array.from(members),
          fields: new Map<RowField, unknown[]>([
            ['parent', Array.from(members, () => group.layerId)],
            ['key', keys],
          ]),
        });
      }
      this.#deleteGroups([group]);
    });
  }

  /**
   * Creates groups at the places of their features (see the public `Store.createGroups`): every
   * one is checked before any is written; each takes the key of the frontmost of its features
   * that is an item of its layer (keys made at once after the last item for the ones that go to
   * the front), the groups are written in one write, and the features that join them in one
   * write per layer, in their order, with the keys of their places made at once. A group deleted
   * whose rows are kept is created again with its handle and the key it had
   */
  createGroups(groups: readonly Group[]): boolean {
    return this.#apply(() => {
      const ids = new Set<string>();
      const joining = new Set<RowRef>();
      const plans: Array<{ created: TableGroup; members: RowRef[] }> = [];
      for (const group of groups) {
        if (ids.has(group.id) || this.#groups.has(group.id)) {
          throw new Error(`Group with id "${group.id}" already exists`);
        }
        if (this.#layers.has(group.id)) {
          throw new Error(`Group with id "${group.id}" already exists as the id of a layer`);
        }
        ids.add(group.id);
        if (!this.#layers.has(group.layerId)) {
          throw new Error(`Layer with id "${group.layerId}" not found`);
        }
        const members = (group.kind === 'table' ? [] : group.featureIds).map((id) => {
          const handle = this.tables.getRowRef(id);
          if (handle === undefined) throw new Error(`Item with id "${id}" not found`);
          if (joining.has(handle)) throw new Error(`The feature "${id}" joins two groups`);
          joining.add(handle);
          return handle;
        });
        // Its layer is the one of its first member, when it has one
        const firstLayer =
          members.length > 0 ? this.#internals.placeOf(members[0])?.table.tableId : undefined;
        plans.push({
          created: tableGroupOf(firstLayer ? { ...group, layerId: firstLayer } : group),
          members,
        });
      }
      if (plans.length === 0) return;
      // The places, read before anything is written: the key of the frontmost member that is an
      // item of the layer, or the front
      const ends = new Map<string, EndKeys>();
      const endOf = (layerId: string): EndKeys => {
        let end = ends.get(layerId);
        if (!end) {
          end = new EndKeys(this.#lastItemKey(layerId));
          ends.set(layerId, end);
        }
        return end;
      };
      const handles: number[] = [];
      const orders: string[] = [];
      for (const [i, { created, members }] of plans.entries()) {
        const kept = this.#internals.groups.handleOfId(created.id);
        handles.push(kept >= 0 ? kept : this.#nextGroup++);
        orders.push('');
        const keptOrder = kept >= 0 ? this.#internals.getGroupKey(kept) : undefined;
        if (keptOrder !== undefined) {
          orders[i] = keptOrder;
          continue;
        }
        const walk = this.#walk(created.layerId);
        let front = -1;
        for (const handle of members) {
          const code = handle * 2;
          if (!walk?.span(code, -1)) continue;
          if (front < 0 || walk.compare(code, front) > 0) front = code;
        }
        if (front >= 0) orders[i] = this.#keyOfCode(front);
        else endOf(created.layerId).add((key) => (orders[i] = key));
      }
      for (const end of ends.values()) end.finish();
      this.#writer.writeGroups({
        handles: Int32Array.from(handles),
        fields: new Map<TableGroupField, unknown[]>([
          ['id', plans.map(({ created }) => created.id)],
          ['key', orders],
          ['parent', plans.map(({ created }) => created.layerId)],
          ['hidden', plans.map(({ created }) => !created.visible)],
          ['locked', plans.map(({ created }) => created.locked)],
        ]),
      });
      for (const { created } of plans) this.#groups.set(created.id, created);
      this.#bus.merge({ groups: { created: plans.map(({ created }) => created) } });
      // The members join their groups in one write per layer, in their order, with the keys of
      // their places made at once after the last member there is
      const writes = new Map<string, { rows: number[]; groups: string[]; keys: string[] }>();
      for (const { created, members } of plans) {
        if (members.length === 0) continue;
        const keys = keysBetween(this.#lastMemberKey(created), null, members.length);
        let write = writes.get(created.layerId);
        if (!write) {
          write = { rows: [], groups: [], keys: [] };
          writes.set(created.layerId, write);
        }
        members.forEach((handle, k) => {
          const left = this.#groupIdOfRow(handle);
          if (left !== undefined && left !== created.id) this.#leftGroups.add(left);
          write.rows.push(handle);
          write.groups.push(created.id);
          write.keys.push(keys[k]);
        });
      }
      for (const write of writes.values()) {
        this.writer.writeRows({
          handles: Int32Array.from(write.rows),
          fields: new Map<RowField, unknown[]>([
            ['parent', write.groups],
            ['key', write.keys],
          ]),
        });
      }
    });
  }

  /**
   * Deletes groups (see the public `Store.deleteGroups`): the members of the groups of a layer
   * that stand next to each other take the place of them all, in the order of the groups and of
   * their members, with keys made at once between the items just below and above them, in one
   * write per layer
   */
  deleteGroups(ids: readonly string[]): boolean {
    return this.#apply(() => {
      const groups = [...new Set(ids)].map((id) => {
        const group = this.#groups.get(id);
        if (!group) throw new Error(`Group with id "${id}" not found`);
        return group;
      });
      const byLayer = new Map<string, Array<{ handle: number; members: Int32Array }>>();
      for (const group of groups) {
        const handle = this.#internals.groups.handleOfId(group.id);
        const view = this.tables.get(group.layerId);
        if (handle < 0 || !view) continue;
        const members = view.listGroupMembers(handle, 0, view.countGroupMembers(handle));
        // A group without a member is not an item: nothing takes its place
        if (members.length === 0) continue;
        let list = byLayer.get(group.layerId);
        if (!list) {
          list = [];
          byLayer.set(group.layerId, list);
        }
        list.push({ handle, members });
      }
      for (const [layerId, list] of byLayer) {
        const walk = this.#walk(layerId);
        if (!walk) continue;
        const codeOf = (entry: { handle: number }): number => entry.handle * 2 + 1;
        list.sort((a, b) => walk.compare(codeOf(a), codeOf(b)));
        const rows: number[] = [];
        const keys: string[] = [];
        let run: typeof list = [];
        const finishRun = (): void => {
          if (run.length === 0) return;
          const below = walk.below(codeOf(run[0]), -1);
          const above = walk.above(codeOf(run[run.length - 1]), -1);
          const members = run.flatMap((entry) => Array.from(entry.members));
          const made = keysBetween(
            below === null ? null : this.#keyOfCode(below),
            above === null ? null : this.#keyOfCode(above),
            members.length,
          );
          rows.push(...members);
          keys.push(...made);
          run = [];
        };
        for (const entry of list) {
          // The groups next to each other are one run
          const last = run[run.length - 1];
          if (last && walk.below(codeOf(entry), -1) !== codeOf(last)) finishRun();
          run.push(entry);
        }
        finishRun();
        this.writer.writeRows({
          handles: Int32Array.from(rows),
          fields: new Map<RowField, unknown[]>([
            ['parent', rows.map(() => layerId)],
            ['key', keys],
          ]),
        });
      }
      this.#deleteGroups(groups);
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
    const handle = this.tables.getRowRef(id);
    if (handle !== undefined) this.#internals.states.setHidden(Int32Array.of(handle), hidden);
    else if (this.tables.findGroup(id) !== undefined || !hidden) {
      this.#internals.states.setGroupHidden(id, hidden);
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
    // A write comes after the restore under way, finished first (in a transaction too)
    if (this.#steps && !this.#inStep) this.#finishSteps();
    // The snapshots of the transactions keep the layers, groups and metadata it may change
    for (const snapshot of this.#lasting) snapshot.keepContainers();
    // The outermost transaction is a frame of the write marks
    return this.#marks.frame(() => this.#bus.transact(fn, source));
  }

  // ==========================================================================
  // Private
  // ==========================================================================

  /**
   * Writes the rows of a restore in steps (see `row-steps.ts`), in a transaction: the first step
   * now; when rows are left, the notification is held and the next step goes in a later task
   */
  #beginSteps(write: RowWrite, onEnd: () => void): boolean {
    this.#finishSteps();
    // What is read until its last step reads the document before it
    this.#openSnapshot();
    const { patch, before } = write;
    const steps: RestoreSteps = {
      patch,
      at: 0,
      deletes: patch.deleted?.some((value) => value !== 0) ?? false,
      onEnd,
      timer: null,
      // The order is told as by one write of every row (a part of a few rows tells each of its
      // rows created or deleted as a move of its own, read among the rows of the other parts)
      tellOrder: this.#tablesWriter.watchOrderOf(patch),
    };
    this.#steps = steps;
    // The values before go with the notification as one part (the runs give none of their own)
    if (before.handles.length > 0) this.#before.push(before);
    this.#writeSteps(steps, performance.now() + BULK_SLICE_BUDGET_MS);
    if (steps.at >= patch.handles.length) {
      this.#steps = null;
      this.#endSnapshot();
      steps.tellOrder();
      this.#deleteEmptyGroups();
      return false;
    }
    this.#bus.hold(() => this.#finishSteps());
    steps.timer = setTimeout(() => this.#nextStep(steps), 0);
    return true;
  }

  /** Writes the next step of a restore, in its transaction, and the end after the last one */
  #nextStep(steps: RestoreSteps): void {
    if (this.#steps !== steps) return;
    // Each step is a frame of the write marks
    this.#marks.frame(() =>
      this.#bus.continueHeld(() =>
        this.#writeSteps(steps, performance.now() + BULK_SLICE_BUDGET_MS),
      ),
    );
    if (steps.at < steps.patch.handles.length) {
      steps.timer = setTimeout(() => this.#nextStep(steps), 0);
      return;
    }
    this.#endSteps(steps);
  }

  /** Writes the rest of the restore under way now, and its end */
  #finishSteps(): void {
    const steps = this.#steps;
    if (!steps || this.#inStep) return;
    this.#marks.frame(() =>
      this.#bus.continueHeld(() => this.#writeSteps(steps, Number.POSITIVE_INFINITY)),
    );
    this.#endSteps(steps);
  }

  /**
   * Writes the rows of a restore from where it is, a run at a time, until a time (the rows of a
   * run with the values they had before, as `applyRows` writes values of rows there)
   */
  #writeSteps(steps: RestoreSteps, deadline: number): void {
    const n = steps.patch.handles.length;
    this.#inStep = true;
    try {
      while (steps.at < n) {
        const from = steps.at;
        const to = Math.min(n, from + BULK_SLICE_ROWS);
        const patch = sliceRowValues(steps.patch, from, to);
        steps.at = to;
        this.#leaveGroups(patch);
        this.#applyRows(patch, { before: NO_VALUES, ...(steps.deletes && this.#keeping()) });
        if (performance.now() >= deadline) break;
      }
    } finally {
      this.#inStep = false;
    }
  }

  /**
   * Ends a restore written in steps: the groups its rows left with no member are deleted, the
   * notification goes out (or into the transaction under way), and the end is told
   */
  #endSteps(steps: RestoreSteps): void {
    if (this.#steps !== steps) return;
    this.#steps = null;
    if (steps.timer !== null) clearTimeout(steps.timer);
    this.#marks.frame(() =>
      this.#bus.continueHeld(() => {
        steps.tellOrder();
        this.#deleteEmptyGroups();
      }),
    );
    this.#endSnapshot();
    this.#bus.release();
    this.#runIdleWaiting();
    steps.onEnd();
  }

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
        if (this.#depth === 0 && this.#groupsHeld === 0) this.#deleteEmptyGroups();
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
      this.#writer.writeGroups(patch, options);
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
          layerId: groups.tableOf(handle) as string,
          visible: !isGroupHidden(groups, handle),
          locked: isGroupLocked(groups, handle),
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
  #groupIdOfRow(handle: RowRef): string | undefined {
    const place = this.#internals.placeOf(handle);
    const group = place ? place.group.data.groups[place.row] : -1;
    return group >= 0 ? this.#internals.groups.idOf(group) : undefined;
  }

  /** The number of an item: twice the handle of a row, twice the handle of a group plus one */
  #codeOfId(id: string): number {
    const handle = this.tables.getRowRef(id);
    if (handle !== undefined) return handle * 2;
    if (!this.#groups.has(id)) return -1;
    const group = this.#internals.groups.handleOfId(id);
    return group >= 0 ? group * 2 + 1 : -1;
  }

  /** The walk of the items of a layer (null for a layer that holds no row) */
  #walk(layerId: string): ItemWalk | null {
    return this.#internals.walkItems(layerId);
  }

  /** The key of an item in a layer (its own key, the key of a group), or in a group (its key) */
  #keyOfCode(code: number): string {
    const handle = code >> 1;
    // The key written of a group (its members may be read where the key before puts them)
    if ((code & 1) === 1) return this.#internals.getGroupKey(handle) ?? '';
    const place = this.#internals.placeOf(handle);
    if (!place) return '';
    // A row is ordered by its key among the members of its group, or among the items of its layer
    return utf8String(place.group.data.keys, place.row);
  }

  /** The keys of the items just below and above an item of a layer */
  #neighborsOf(layerId: string, code: number): { below: string | null; above: string | null } {
    const walk = this.#walk(layerId);
    const below = walk?.below(code, -1) ?? null;
    const above = walk?.above(code, -1) ?? null;
    return {
      below: below === null ? null : this.#keyOfCode(below),
      above: above === null ? null : this.#keyOfCode(above),
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
    const { below, above } = this.#placeBetween(to, group, moving);
    const keyOf = (code: number | null): string | null =>
      code === null ? null : this.#keyOfCode(code);
    return keysBetween(keyOf(below), keyOf(above), n);
  }

  /**
   * The items that stay just below and above a place (null for none), the items put there left
   * out: the keys of the items put there go between theirs
   */
  #placeBetween(
    to: ItemPlacement,
    group: TableGroup | undefined,
    moving: ReadonlySet<number>,
  ): { below: number | null; above: number | null } {
    const container = group ? this.#internals.groups.handleOfId(group.id) : -1;
    const walk = this.#walk(to.layerId);
    /** The item of an id that stays in the container (-1 for none) */
    const itemOf = (id: string | null | undefined): number => {
      if (id === null || id === undefined || !walk) return -1;
      const code = this.#codeOfId(id);
      return code >= 0 && !moving.has(code) && walk.span(code, container) ? code : -1;
    };
    if ((group && container < 0) || !walk) return { below: null, above: null };
    if (to.below === null) return { below: null, above: walk.bottom(container, moving) };
    const below = itemOf(to.below);
    if (below >= 0) return { below, above: walk.above(below, container, moving) };
    const above = to.above === null ? -1 : itemOf(to.above);
    if (above >= 0) return { below: walk.below(above, container, moving), above };
    return { below: walk.top(container, moving), above: null };
  }

  /**
   * Where rows put in a place together are once they are written, as the changes of the order
   * tell it (`RowsPlacement`): the items just below and above them then are the ones around the
   * place, a group of features whose every member is put there passed (it is no item once they
   * have left it)
   */
  #rowsPlacement(
    to: ItemPlacement,
    group: TableGroup | undefined,
    moving: ReadonlySet<number>,
  ): RowsPlacement {
    const container = group ? this.#internals.groups.handleOfId(group.id) : -1;
    const walk = this.#walk(to.layerId);
    let { below, above } = this.#placeBetween(to, group, moving);
    if (walk && container < 0) {
      const passed = new Set(moving);
      /** Whether every member of a group of features is put in the place */
      const emptied = (code: number): boolean =>
        (code & 1) === 1 &&
        this.#internals.membersIn(to.layerId, code >> 1).every((member) => moving.has(member * 2));
      while (below !== null && emptied(below)) {
        passed.add(below);
        below = walk.below(below, container, passed);
      }
      while (above !== null && emptied(above)) {
        passed.add(above);
        above = walk.above(above, container, passed);
      }
    }
    return {
      layerId: group?.layerId ?? to.layerId,
      groupId: group?.id,
      below,
      above,
    };
  }

  /** Writes fields of one row */
  #write(handle: RowRef, fields: ReadonlyMap<RowField, unknown>): void {
    this.#writeRows([{ handle, fields }]);
  }

  /**
   * Writes fields of rows in one write: each field written of any of them, in the order the rows
   * first give it, with nothing (undefined) for a row that does not give it
   */
  #writeRows(
    rows: ReadonlyArray<{ handle: RowRef; fields: ReadonlyMap<RowField, unknown> }>,
  ): void {
    const columns = new Map<RowField, unknown[]>();
    rows.forEach(({ fields }, i) => {
      for (const [field, value] of fields) {
        let values = columns.get(field);
        if (!values) {
          values = new Array<unknown>(rows.length).fill(undefined);
          columns.set(field, values);
        }
        values[i] = value;
      }
    });
    this.writer.writeRows({
      handles: Int32Array.from(rows, (row) => row.handle),
      fields: columns,
    });
  }

  /**
   * Writes rows, after reading the values the rows there were when the transaction began have for
   * the fields written other than their place (none for a write from
   * elsewhere): the values given (`before`) instead, when there are
   */
  #applyRows(patch: RowValues, options: RowApplyOptions = {}): RowsChange {
    const { before: given, ...rest } = options;
    const before = given ?? (this.#bus.source === 'remote' ? null : this.#readBefore(patch));
    // The rows that were not there are noted, and the rows there that the patch deletes (a row
    // deleted and created again in the transaction was there when it began); a row not noted was
    // there or is there
    const { handles, deleted } = patch;
    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i];
      if (this.#written.has(handle)) continue;
      if (!this.#isThere(handle)) this.#written.set(handle, false);
      else if (deleted?.[i]) this.#written.set(handle, true);
    }
    const change = this.#writer.writeRows(patch, rest);
    if (before && before.handles.length > 0) this.#before.push(before);
    return change;
  }

  /**
   * The values the rows of a patch that were there when the transaction began have for the fields
   * it writes other than their place (null for none)
   */
  #readBefore(patch: RowValues): RowValues | null {
    const fields = [...patch.fields.keys()].filter((field) => !PLACE_FIELDS.has(field));
    if (fields.length === 0 && !patch.deleted) return null;
    const rows: number[] = [];
    for (const handle of patch.handles) {
      const atStart = this.#written.get(handle);
      if (atStart === false) continue;
      // A row deleted in the transaction and created again holds its values while it is kept
      if (atStart === true || this.#isThere(handle)) rows.push(handle);
    }
    if (rows.length === 0) return null;
    return this.tables.readValues({
      handles: Int32Array.from(rows),
      fields: new Map(fields.map((field) => [field, []])),
      ...(patch.deleted && { deleted: new Uint8Array(0) }),
    });
  }

  /** Whether a row is there (a row, not deleted) */
  #isThere(handle: RowRef): boolean {
    const place = this.#internals.placeOf(handle);
    return !!place && (place.group.data.flags[place.row] & ROW_FLAG_DELETED) === 0;
  }

  /** Schedules again the idle work that waited for the end of a write over several tasks */
  #runIdleWaiting(): void {
    if (this.#bus.held || this.#idleWaiting.size === 0) return;
    const idle = this.#idleScheduler;
    for (const entry of [...this.#idleWaiting]) {
      this.#idleWaiting.delete(entry);
      entry.cancel = idle(entry.run);
    }
  }

  /**
   * Begins the snapshot of a write over several tasks (in its first step, before it writes): the
   * document as it is now, read until its last step
   */
  #openSnapshot(): void {
    this.#snapshot = new HeldSnapshot(this.#snapshotSource(), this.#containers());
  }

  /** The layers, the groups, the stacking order and the metadata as they are now */
  #containers(): Containers {
    return {
      layers: this.#layers,
      order: this.#order,
      groups: this.#groups,
      metadata: this.#metadata,
    };
  }

  /** The snapshots that follow the writes */
  #snapshots(): HeldSnapshot[] {
    const out = [...this.#lasting];
    if (this.#snapshot) out.push(this.#snapshot);
    return out;
  }

  /**
   * Ends the snapshot of the write over several tasks under way (at its last step, before its
   * notification): frozen when a lasting snapshot began during it
   */
  #endSnapshot(): void {
    this.#snapshot?.end();
    this.#snapshot = null;
  }

  /**
   * Begins the snapshot of a transaction (`Store.openSnapshot`): the document as the reads of the
   * instance read it now (the one before the write over several tasks under way, if any)
   */
  #openLasting(): LastingSnapshot {
    const parent = this.#snapshot?.valid ? this.#snapshot : null;
    const snapshot = new HeldSnapshot(this.#snapshotSource(), parent ? parent.containers : null, {
      parent,
      lasting: true,
    });
    this.#lasting.add(snapshot);
    let released = false;
    return {
      snapshot: () => (snapshot.valid && snapshot.changed ? snapshot : undefined),
      release: () => {
        if (released) return;
        released = true;
        this.#lasting.delete(snapshot);
        snapshot.release();
      },
    };
  }

  /** What the snapshots read of this Store */
  #snapshotSource(): SnapshotSource {
    return {
      tables: this.tables,
      internals: this.#internals,
      before: () => this.#before,
      written: () => this.#written,
      through: (fn) => {
        this.#through++;
        try {
          return fn();
        } finally {
          this.#through--;
        }
      },
      liveFeature: (handle) => this.#rowFeature(handle),
      containers: () => this.#containers(),
    };
  }

  /**
   * Finishes the restore under way, or the write over several tasks held, before a read of the
   * rows: no read sees them half written. The layers, the groups and the metadata are read
   * without it (the drawing reads them every frame): a write over several tasks leaves them as
   * they are until its last step (see `Store.writeInSteps`)
   */
  #readGate(): void {
    // A read of the snapshot reads the rows the write did not change where they are
    if (this.#through > 0) return;
    if (this.#steps) {
      if (!this.#inStep) this.#finishSteps();
      return;
    }
    // Inside a transaction, the writes held are the ones being made
    this.#bus.finishHeld();
  }

  /** The feature of a row, kept or made (undefined for a deleted row) */
  #rowFeature(handle: RowRef): Feature | undefined {
    const place = this.#internals.placeOf(handle);
    if (!place || (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0) return undefined;
    return this.#internals.featureCache.featureOf(place.table.tableId, place.group, place.row);
  }

  /** The key of the order of the last item of a layer (null for none) */
  #lastItemKey(layerId: string): string | null {
    // The keys of the items are in their order; the last one may be a group
    const top = this.#walk(layerId)?.top(-1) ?? null;
    if (top === null) return null;
    let last: string | null = this.#keyOfCode(top);
    // A group without members is not an item of the rows; its key may come after
    for (const group of this.#groups.values()) {
      if (group.layerId !== layerId) continue;
      const key = this.#internals.getGroupKey(this.#internals.groups.handleOfId(group.id));
      if (key !== undefined && (last === null || key > last)) last = key;
    }
    return last;
  }

  /** The key a row is ordered by among the items of its layer: its own, or the one of its group */
  #itemKeyOf(handle: RowRef): string {
    const place = this.#internals.placeOf(handle);
    if (!place) return keyAfter(null);
    const group = place.group.data.groups[place.row];
    if (group >= 0) return this.#internals.getGroupKey(group) ?? keyAfter(null);
    return utf8String(place.group.data.keys, place.row);
  }

  /** The key of the last member of a group (null for none) */
  #lastMemberKey(group: TableGroup): string | null {
    const handle = this.#internals.groups.handleOfId(group.id);
    if (handle < 0) return null;
    const last = this.#walk(group.layerId)?.top(handle) ?? null;
    return last === null ? null : this.#keyOfCode(last);
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
      this.#writer.writeGroups(
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

  /** Delivers a notification with each row in it once */
  #deliver(changes: StoreChange): void {
    const before = this.#before;
    this.#before = [];
    this.#written = new Map();
    this.#retain = null;
    if (changes.source === 'remote') this.#forgetRemote(changes);
    const out = reconcile(changes, this.tables, before);
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
 * The values the rows had when the transaction began (see `TableContractStore`): the values the
 * writes read; a field of a row no write read had the value it has now
 */
function valuesBefore(parts: readonly RowValues[], tables: FeatureTables): RowValues | undefined {
  return combineValuesBefore(parts, {
    field: (handles, field) => {
      const now = tables.readValues({ handles, fields: new Map([[field, []]]) }).fields.get(field);
      return Array.from(handles, (_handle, k) => now?.[k]);
    },
    deleted: (handles) =>
      tables.readValues({ handles, fields: new Map(), deleted: new Uint8Array(0) }).deleted ??
      new Uint8Array(handles.length),
  });
}

/**
 * A notification with each row in it once (see `TableContractStore`): the layers whose rows were
 * written, and the values the rows had before (`previousValues`)
 */
function reconcile(
  changes: StoreChange,
  tables: FeatureTables,
  parts: readonly RowValues[],
): StoreChange {
  const rows = changes.rows;
  if (!rows && parts.length === 0) return changes;
  const out: StoreChange = { ...changes };
  const before = valuesBefore(parts, tables);
  const layers = new Map<string, LayerRowsChange>();
  for (const [layerId, change] of rows?.layers ?? []) {
    if (change.created.length + change.updated.length + change.deleted.length > 0) {
      layers.set(layerId, change);
    }
  }
  if (layers.size > 0) out.rows = { layers } as RowsChange;
  else delete out.rows;
  if (before) out.previousValues = asFeatureValues(before);
  else delete out.previousValues;
  return out;
}

/**
 * The keys of the order of items put at the end of a container one after the other: a run of new
 * items gets its keys at once (`keysBetween`), and an item that keeps its key puts the ones after
 * it after it when it is the last
 */
class EndKeys {
  /** The last key of the container before the items */
  readonly first: string | null;
  #last: string | null;
  #run: Array<(key: string) => void> = [];

  constructor(last: string | null) {
    this.first = last;
    this.#last = last;
  }

  /** A new item: its key is given to `set` once the run it is in ends */
  add(set: (key: string) => void): void {
    this.#run.push(set);
  }

  /** An item that keeps its key */
  keep(key: string): void {
    this.#finishRun();
    if (this.#last === null || compareKeys(key, this.#last) > 0) this.#last = key;
  }

  /** Gives the keys of the last run */
  finish(): void {
    this.#finishRun();
  }

  #finishRun(): void {
    if (this.#run.length === 0) return;
    const keys = keysBetween(this.#last, null, this.#run.length);
    for (const [i, set] of this.#run.entries()) set(keys[i]);
    this.#last = keys[keys.length - 1];
    this.#run = [];
  }
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
