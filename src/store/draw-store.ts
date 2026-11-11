// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DrawStore
 *
 * The Store core works with: a {@link StoreContract} (the in-memory one, or one the host gave)
 * and the state only the drawing reads, behind one gate. It reaches the contract only through
 * the members of the public `Store`.
 *
 *   - Read-only is enforced here, at the write methods of the document. A refused write
 *     returns false and touches nothing. Changes applied to the contract from elsewhere are not
 *     stopped by it.
 *   - The notifications of the contract are forwarded into the ChangeBus of this Store, so a
 *     listener gets one StoreChange per transaction with every kind of change.
 *   - What the contract returns and notifies is read in the shape of the public types: an
 *     optional field it gives as `null` (`Feature.groupId`, `Layer.metadata`,
 *     `Layer.styleRule`) is read as `undefined`. The normalized object is kept per object of
 *     the contract, so the same object of the contract always reads as the same object here.
 *   - Deletions reach the state of this client: the id of a deleted feature, group or layer
 *     leaves the selection, the features being edited and the locally hidden set, whatever
 *     deleted it, through the writes of the contract.
 *   - The selection holds only what can be seen: a change that hides a selected item (its own
 *     visible flag, the one of its group or layer, or local hiding) takes it out of the
 *     selection, and the vertex selection ends when its feature is deleted or its coordinates
 *     change other than by a drag. This is the only place that keeps these invariants; the
 *     modes and the public API rely on it.
 */

import type { VertexId } from '../api/state.js';
import type { FeatureTables, RowWrite } from '../api/tables.js';
import { type BulkOperation, planBulk } from '../feature-table/bulk-plan.js';
import {
  isRowLocked,
  isRowShown,
  type RowContainers,
  rowsByLayerInOrder,
} from '../feature-table/bulk-rows.js';
import {
  type FeatureTablesInternals,
  featureTablesInternals,
} from '../feature-table/feature-tables.js';
import {
  tableGroupMemberCount,
  tableGroupMemberIds,
  tableLayerFeatureCount,
  tableLayerFeatureIds,
} from '../feature-table/item-ids.js';
import { TableSelection } from '../feature-table/selection.js';
import { coordinatesOf } from '../shared/utils/coordinates.js';
import { rowsOfSummary, summaryOf } from './bulk-selection.js';
import { insertGroup } from './item-lists.js';
import { ChangeBus } from './memory/change-bus.js';
import { MemoryDrawingState } from './memory/ui-state.js';
import { moveItemsByLists } from './move-items.js';
import { BULK_SLICE_ROWS, type RowSteps, rowStepsOf } from './row-steps.js';
import { settleSelectionValues, valueOfSelection } from './selection-value.js';
import type {
  EditResult,
  FeatureEdit,
  GeometryTransforms,
  SlicedWrite,
  Store,
  StoreContract,
} from './store.js';
import {
  setTransformFieldsOfStore,
  type TransformFieldsRegistry,
  transformFieldsOfStore,
} from './transform-roles.js';
import type {
  BoxSelection,
  DragState,
  Feature,
  FeatureType,
  FileData,
  Group,
  ItemPlacement,
  Layer,
  Metadata,
  Mode,
  RowValues,
  Selection,
  SelectionBulk,
  SelectionType,
  SelectionValue,
  StoreChange,
  UpdateSource,
  VertexRef,
  VertexSelection,
} from './types.js';
import { type QueuedWrite, WriteQueue } from './write-queue.js';

/**
 * The most features of rows the selection lists the IDs of: a selection of more is selected in
 * bulk, by the states of its rows only (`Selection.bulk`)
 *
 * @internal
 */
export const SELECTION_IDS_LIMIT = 2000;

/**
 * Returns the Store for a store option: a Store of core is used as it is, a Store of the host
 * gets the drawing state and the read-only gate of core around it
 *
 * @internal
 */
export function toStore(store: StoreContract | Store): Store {
  return store instanceof DrawStore ? store : new DrawStore(store);
}

/**
 * The options of the Store of core
 *
 * @internal
 */
export interface DrawStoreOptions {
  /**
   * The most features of rows the selection lists the IDs of (`SELECTION_IDS_LIMIT` when
   * omitted)
   */
  readonly selectionIdsLimit?: number;
}

/**
 * What a vertex selection names its vertices by: their IDs, when the Store gives its vertices IDs
 * (null otherwise), the layout of the vertices of its feature (`vertexLayout`) and its coordinates
 */
interface VertexTargets {
  readonly featureId: string;
  readonly ids: readonly VertexId[] | null;
  readonly layout: string;
  /** The coordinates of the feature, as they were when the vertices were last named */
  readonly coordinates: unknown;
}

/**
 * Features selected in bulk: the type of the selection (features, or the groups or layers whose
 * features are many), its rows, and the summary given with the selection
 */
interface BulkState {
  readonly type: SelectionType;
  readonly rows: TableSelection;
  summary: SelectionBulk;
}

/**
 * The Store of core over a {@link StoreContract}
 *
 * @internal
 */
export class DrawStore implements Store {
  readonly #contract: StoreContract;
  readonly #bus = new ChangeBus();
  readonly #drawing = new MemoryDrawingState(this.#bus);
  /** The normalized copy of each object of the contract that gave `null` for an optional field */
  readonly #normalized = new WeakMap<object, object>();
  /**
   * What the vertex selection names its vertices by (null while no vertex is selected): their IDs
   * when the Store gives its vertices IDs (`getVertexIds`), and the layout of the vertices of the
   * feature otherwise (see `#pruneVertices`)
   */
  #vertexTargets: VertexTargets | null = null;
  /** The features selected in bulk (null while the selection lists its features) */
  #bulk: BulkState | null = null;
  /**
   * The writes of this client made over several tasks, in their order (`write-queue.ts`): a
   * restore of rows written in steps (`row-steps.ts`), whose notification this Store holds, or the
   * write of a drag let go (`operations/bulk-sliced.ts`)
   */
  readonly #queue = new WriteQueue();
  /** Whether the selection is being written here (its notification does not prune it) */
  #selecting = false;
  /** Whether a feature selected in bulk is locked, as read last (null: to be read again) */
  #bulkUnlocked: TableSelection | null = null;
  /** The selection as this Store told it last (what a change of it tells as the one before) */
  #toldSelection: Selection;
  /** The value of the selection this Store told last (made when first asked) */
  #toldValue: SelectionValue | null = null;
  /** The value this Store told last as the one before (`#toldValue` before it) */
  #toldBefore: SelectionValue | null = null;
  /**
   * Whether the writes of this client of the document are taken (not while another document is
   * shown in its place); the writes in a transaction from elsewhere (`remote`) always are
   */
  #documentWritable = true;
  /** The transactions from elsewhere (`remote`) under way */
  #remoteDepth = 0;
  readonly selectionIdsLimit: number;

  constructor(contract: StoreContract, options: DrawStoreOptions = {}) {
    this.#contract = contract;
    this.selectionIdsLimit = options.selectionIdsLimit ?? SELECTION_IDS_LIMIT;
    this.#toldSelection = contract.getSelection();
    contract.subscribe((changes) => this.#receive(changes));
  }

  // ============================================================================
  // The document: reads
  // ============================================================================

  /** The features of the layers the contract holds as rows of columns */
  get tables(): FeatureTables | undefined {
    return this.#contract.tables;
  }

  getFeature(id: string): Feature | undefined {
    const feature = this.#contract.getFeature(id);
    return feature && this.#feature(feature);
  }
  listFeatures(): Feature[] {
    return this.#features(this.#contract.listFeatures());
  }
  listFeaturesInOrder(): Feature[] {
    return this.#features(this.#contract.listFeaturesInOrder());
  }
  getLayer(id: string): Layer | undefined {
    const layer = this.#contract.getLayer(id);
    return layer && this.#layer(layer);
  }
  listLayers(): Layer[] {
    const layers = this.#contract.listLayers();
    return layers.some(hasNullLayerField) ? layers.map((layer) => this.#layer(layer)) : layers;
  }
  getLayerOrder(): readonly string[] {
    return this.#contract.getLayerOrder();
  }
  getGroup(id: string): Group | undefined {
    return this.#contract.getGroup(id);
  }
  listGroups(): Group[] {
    return this.#contract.listGroups();
  }
  getFile(id: string): FileData | undefined {
    return this.#contract.getFile(id);
  }
  listFiles(): FileData[] {
    return this.#contract.listFiles();
  }
  getMetadata(): Metadata {
    return this.#contract.getMetadata();
  }

  // ============================================================================
  // The document: writes (gated by read-only)
  // ============================================================================

  createFeature(feature: Feature): boolean {
    return this.#write(() => this.#contract.createFeature(feature));
  }
  createFeatures(features: readonly Feature[]): boolean {
    return this.#write(() => {
      const contract = this.#contract;
      if (contract.createFeatures) return contract.createFeatures(features);
      // A Store that does not create many features at once: one at a time
      for (const feature of features) contract.createFeature(feature);
      return true;
    });
  }
  updateFeature(id: string, updates: Partial<Feature>): boolean {
    return this.#write(() => this.#contract.updateFeature(id, updates));
  }
  applyEdits(edits: readonly FeatureEdit[]): EditResult | null {
    if (this.#contract.isReadOnly() || !this.#takesWrites()) return null;
    return this.transact(() => this.#contract.applyEdits(this.#withSelectionResolved(edits)));
  }
  /** The computation of the edits that move, rotate and scale features of the contract */
  get transforms(): GeometryTransforms | undefined {
    return this.#contract.transforms;
  }
  /**
   * The fields the custom types of the instance this Store belongs to declare (null while it
   * belongs to none): what the drags read, and what the edits of a contract of the library read
   */
  get transformFields(): TransformFieldsRegistry | null {
    return transformFieldsOfStore(this);
  }
  /**
   * Sets the fields the custom types of the instance declare, for the drags and for a contract of
   * the library, which takes them (`takeTransformFields`); the contract of an application decides
   * the fields of its edits itself
   */
  setTransformFields(fields: TransformFieldsRegistry | null): void {
    setTransformFieldsOfStore(this, this.#contract, fields);
  }
  /** The IDs the contract gives vertices (undefined when it gives none) */
  get getVertexIds(): Store['getVertexIds'] {
    const contract = this.#contract;
    if (typeof contract.getVertexIds !== 'function') return undefined;
    return (featureId, vertices) =>
      (contract.getVertexIds as NonNullable<Store['getVertexIds']>)(featureId, vertices);
  }
  /** The places of vertices by the IDs the contract gives them (undefined when it gives none) */
  get findVertices(): Store['findVertices'] {
    const contract = this.#contract;
    if (typeof contract.findVertices !== 'function') return undefined;
    return (featureId, ids) =>
      (contract.findVertices as NonNullable<Store['findVertices']>)(featureId, ids);
  }
  selectedFeatureIds(): readonly string[] {
    return this.#selectedFeatureIds();
  }
  deleteFeature(id: string): boolean {
    return this.#write(() => {
      const deleted = this.#contract.deleteFeature(id);
      // At once, so that the rest of a transaction already sees the selection without it
      if (deleted) this.#forget(id);
      return deleted;
    });
  }

  createLayer(layer: Layer): boolean {
    return this.#write(() => this.#contract.createLayer(layer));
  }
  updateLayer(id: string, updates: Partial<Layer>): boolean {
    return this.#write(() => this.#contract.updateLayer(id, updates));
  }
  deleteLayer(id: string): boolean {
    return this.#write(() => this.#contract.deleteLayer(id));
  }
  setLayerOrder(order: string[]): boolean {
    return this.#write(() => this.#contract.setLayerOrder(order));
  }
  reorderInLayer(itemId: string, layerId: string, newIndex: number): boolean {
    return this.#write(() => this.#contract.reorderInLayer(itemId, layerId, newIndex));
  }
  reorderInGroup(featureId: string, groupId: string, newIndex: number): boolean {
    return this.#write(() => this.#contract.reorderInGroup(featureId, groupId, newIndex));
  }
  moveItem(itemId: string, to: ItemPlacement): boolean {
    return this.moveItems([itemId], to);
  }
  moveItems(itemIds: readonly string[], to: ItemPlacement): boolean {
    return this.#write(() => {
      const contract = this.#contract;
      if (contract.moveItems) return contract.moveItems(itemIds, to);
      // A Store of objects that does not put items in a place: its lists are written
      moveItemsByLists(contract, itemIds, to);
      return true;
    });
  }
  applyRows(write: RowWrite): boolean {
    const contract = this.#contract;
    if (!contract.tables || !contract.applyRows) {
      throw new Error('The Store does not hold its features as rows: it writes no rows');
    }
    return this.#write(() => (contract.applyRows as (w: RowWrite) => boolean)(write));
  }
  restoreRows(patch: RowValues): RowValues | null {
    const tables = this.#contract.tables;
    if (!tables || !this.#contract.applyRows) {
      throw new Error('The Store does not hold its features as rows: it writes no rows');
    }
    if (this.#contract.isReadOnly() || !this.#takesWrites()) return null;
    this.#queue.finish();
    const before = tables.readValues(patch);
    // Many rows are written in steps by a Store of core that has them, as one transaction
    const steps = rowStepsOf.get(this.#contract);
    if (steps && patch.handles.length > BULK_SLICE_ROWS) {
      return this.#write(() => this.#restoreInSteps(steps, { patch, before })) ? before : null;
    }
    return this.applyRows({ patch, before }) ? before : null;
  }

  /**
   * Begins a restore of rows written in steps (in a transaction of this Store): when steps are
   * left, the notification of this Store is held with the one of the contract, and let go of once
   * the contract wrote the last rows and told them
   */
  #restoreInSteps(steps: RowSteps, write: RowWrite): boolean {
    const restore: QueuedWrite = { finish: () => steps.finish(), holdsNotification: true };
    let ended = false;
    const going = steps.begin(write, () => {
      ended = true;
      if (this.#queue.remove(restore)) this.#bus.release();
    });
    if (!going || ended) return true;
    this.#queue.add(restore);
    // Anything else that comes to this Store finishes it first
    this.#bus.hold(() => restore.finish());
    return true;
  }

  createGroup(group: Group): boolean {
    return this.#write(() => this.#contract.createGroup(group));
  }
  createGroups(groups: readonly Group[]): boolean {
    return this.#write(() => {
      const contract = this.#contract;
      if (contract.createGroups) return contract.createGroups(groups);
      // A Store that does not create many groups at once: one at a time, each put in its place
      for (const group of groups) insertGroup(this, group);
      return true;
    });
  }
  updateGroup(id: string, updates: Partial<Group>): boolean {
    return this.#write(() => this.#contract.updateGroup(id, updates));
  }
  deleteGroup(id: string): boolean {
    return this.#write(() => this.#contract.deleteGroup(id));
  }
  deleteGroups(ids: readonly string[]): boolean {
    return this.#write(() => {
      const contract = this.#contract;
      if (contract.deleteGroups) return contract.deleteGroups(ids);
      for (const id of ids) contract.deleteGroup(id);
      return true;
    });
  }

  createFile(file: FileData): boolean {
    return this.#write(() => this.#contract.createFile(file));
  }
  deleteFile(id: string): boolean {
    return this.#write(() => this.#contract.deleteFile(id));
  }

  setMetadata(metadata: Partial<Metadata>): boolean {
    return this.#write(() => this.#contract.setMetadata(metadata));
  }

  // ============================================================================
  // The numbers of generated names (optional members of the contract)
  // ============================================================================

  getMaxNameNumber(type: FeatureType | 'Layer' | 'Group'): number | undefined {
    return this.#contract.getMaxNameNumber?.(type);
  }
  recordNameNumber(type: FeatureType | 'Layer' | 'Group', number: number): void {
    this.#contract.recordNameNumber?.(type, number);
  }
  acceptsId(id: string): boolean {
    return this.#contract.acceptsId?.(id) ?? true;
  }

  // ============================================================================
  // The state of this client (kept by the contract)
  // ============================================================================

  getSelection(): Selection {
    const selection = this.#contract.getSelection();
    const bulk = this.#bulk;
    if (!bulk) return selection;
    return {
      type: bulk.type,
      ids: bulk.type === 'feature' ? [] : selection.ids,
      bulk: bulk.summary,
    };
  }
  setSelection(type: SelectionType | null, ids: string[]): void {
    // Read from the rows a restore under way leaves (see `#local`)
    this.#queue.finishHeld();
    // A selection of more features of rows than it lists the IDs of is selected in bulk
    const internals = featureTablesInternals(this.#contract.tables);
    if (internals && type !== null && this.#featureCount(type, ids) > this.selectionIdsLimit) {
      this.#selectBulk(type, ids, this.#rowsOfSelection(internals, type, ids));
      return;
    }
    this.#select(type, ids);
  }

  getSelectedRows(): TableSelection | null {
    return this.#bulk?.rows ?? null;
  }

  rowsOfSelection(selection: Selection = this.getSelection()): TableSelection | null {
    const internals = featureTablesInternals(this.#contract.tables);
    if (!internals) return null;
    const rows = rowsOfSummary(selection.bulk);
    if (rows) return rows;
    const { type, ids } = selection;
    return type === null ? TableSelection.empty : this.#rowsOfSelection(internals, type, ids);
  }

  isSelectedRowLocked(): boolean {
    const rows = this.getSelectedRows();
    const unlocked = this.getUnlockedSelectedRows();
    return rows !== null && unlocked !== null && unlocked.count < rows.count;
  }

  getUnlockedSelectedRows(): TableSelection | null {
    this.#queue.finishHeld();
    const bulk = this.#bulk;
    const internals = featureTablesInternals(this.#contract.tables);
    if (!bulk || !internals) return null;
    if (this.#bulkUnlocked === null) {
      const containers = this.#containers();
      this.#bulkUnlocked = bulk.rows.filter(
        (handle) => !isRowLocked(internals, containers, handle),
      );
    }
    return this.#bulkUnlocked;
  }

  selectRows(rows: TableSelection): void {
    this.#queue.finishHeld();
    const internals = featureTablesInternals(this.#contract.tables);
    if (!internals) return;
    const containers = this.#containers();
    const shown = rows.filter((handle) => isRowShown(internals, containers, handle));
    if (shown.count > this.selectionIdsLimit) {
      this.#selectBulk('feature', [], shown);
      return;
    }
    const ids: string[] = [];
    for (const handles of rowsByLayerInOrder(internals, shown).values()) {
      for (const handle of handles) ids.push(internals.ids.idOf(handle) as string);
    }
    this.#select(ids.length > 0 ? 'feature' : null, ids);
  }

  restoreSelection(selection: Selection): void {
    this.#queue.finishHeld();
    const rows = rowsOfSummary(selection.bulk);
    if (rows && selection.type === 'feature') {
      this.selectRows(rows);
      return;
    }
    const type = selection.type;
    if (type === null) {
      this.#select(null, []);
      return;
    }
    const contract = this.#contract;
    const shown = createShownLookup(contract);
    const ids = selection.ids.filter((id) => {
      const there =
        type === 'feature'
          ? contract.getFeature(id)
          : type === 'group'
            ? contract.getGroup(id)
            : contract.getLayer(id);
      return there !== undefined && shown(type, id);
    });
    this.setSelection(ids.length > 0 ? type : null, ids);
  }

  beginSlicedWrite(write: SlicedWrite): void {
    this.#queue.add(write);
  }
  endSlicedWrite(write: SlicedWrite): void {
    if (!this.#queue.remove(write)) return;
    // The extent of the features selected in bulk, kept while they were written in steps (they
    // are drawn by it moved as they are, until the last of them is written)
    if (this.#bulk) this.#refreshSummary(null);
  }
  finishSlicedWrite(): void {
    this.#queue.finish();
  }
  runSlicedStep<T>(fn: () => T): T {
    return this.#queue.runStep(fn);
  }
  get slicedWritePending(): boolean {
    return this.#queue.pending;
  }

  applyBulk(op: BulkOperation, rows?: TableSelection): boolean {
    // Planned from the values the rows have once the writes queued are made
    this.#queue.finish();
    const contract = this.#contract;
    const target = rows ?? this.#bulk?.rows;
    const internals = featureTablesInternals(contract.tables);
    if (!target || !internals || !contract.applyRows) return false;
    if (contract.isReadOnly() || contract.isInteractionLocked()) return false;
    const write = planBulk(internals, op, target, this.#containers());
    if (!write) return false;
    return this.applyRows(write);
  }

  getEditingIds(): readonly string[] {
    return this.#contract.getEditingIds();
  }
  startEditing(ids: string[]): void {
    this.#local(() => this.#contract.startEditing(ids));
  }
  endEditing(ids: string[]): void {
    this.#local(() => this.#contract.endEditing(ids));
  }

  getVertexSelection(): VertexSelection | null {
    return this.#contract.getVertexSelection();
  }
  setSelectedVertices(selection: VertexSelection | null): void {
    this.#local(() => {
      this.#contract.setSelectedVertices(selection);
      this.#vertexTargets = selection && this.#vertexTargetsOf(selection);
    }, true);
  }

  getMode(): Mode {
    return this.#contract.getMode();
  }
  setMode(mode: Mode): void {
    this.#local(() => this.#contract.setMode(mode));
  }

  isReadOnly(): boolean {
    // Read-only too while another document is shown in place of the document
    return this.#contract.isReadOnly() || !this.#documentWritable;
  }
  setReadOnly(value: boolean): void {
    if (this.#contract.isReadOnly() === value) return;
    this.#local(() => this.#contract.setReadOnly(value), true);
  }

  isInteractionLocked(): boolean {
    return this.#contract.isInteractionLocked();
  }
  setInteractionLock(value: boolean): void {
    if (this.#contract.isInteractionLocked() === value) return;
    this.#local(() => this.#contract.setInteractionLock(value), true);
  }

  isHidden(id: string): boolean {
    return this.#contract.isHidden(id);
  }
  listHidden(): ReadonlySet<string> {
    return this.#contract.listHidden();
  }
  setLocallyHidden(id: string, hidden: boolean): void {
    if (this.#contract.isHidden(id) === hidden) return;
    this.#local(() => {
      this.#contract.setLocallyHidden(id, hidden);
      if (hidden) {
        this.#pruneInvisible();
        this.#pruneBulk(null);
      }
    }, true);
  }

  // ============================================================================
  // The state only the drawing reads (kept here)
  // ============================================================================

  getBoxSelection(): BoxSelection | null {
    return this.#drawing.getBoxSelection();
  }
  setBoxSelection(box: BoxSelection | null): void {
    this.#drawing.setBoxSelection(box);
  }

  getDragState(): DragState | null {
    return this.#drawing.getDragState();
  }
  setDragState(state: DragState | null): void {
    this.#drawing.setDragState(state);
  }

  getFollowedVertices(): VertexSelection[] | null {
    return this.#drawing.getFollowedVertices();
  }
  setFollowedVertices(selections: VertexSelection[] | null): void {
    this.#bus.transact(() => {
      this.#drawing.setFollowedVertices(selections);
    }, 'local');
  }

  // ============================================================================
  // Subscription and transactions
  // ============================================================================

  subscribe(listener: (changes: StoreChange) => void): () => void {
    return this.#bus.subscribe(listener);
  }

  /**
   * Sets what is called once each notification of this Store has gone to every listener: once
   * per outermost transaction, or per write outside one (null for nothing). What it throws
   * reaches the write or the transaction that ended
   *
   * @internal
   */
  setAfterNotify(fn: ((changes: StoreChange) => void) | null): void {
    this.#bus.setAfterFlush(fn);
  }

  transact<T>(fn: () => T, source: UpdateSource = 'local'): T {
    // A write of this client comes after the writes over several tasks queued
    if (source !== 'remote') this.#queue.finish();
    if (source !== 'remote') {
      return this.#bus.transact(() => this.#contract.transact(fn, source), source);
    }
    this.#remoteDepth++;
    try {
      return this.#bus.transact(() => this.#contract.transact(fn, source), source);
    } finally {
      this.#remoteDepth--;
    }
  }

  // ============================================================================
  // Private
  // ============================================================================

  /** Runs one document write unless read-only; what the contract returned */
  #write(fn: () => boolean): boolean {
    if (this.#contract.isReadOnly() || !this.#takesWrites()) return false;
    return this.transact(fn);
  }

  /** Whether a write of the document is taken now (see `#documentWritable`) */
  #takesWrites(): boolean {
    return this.#documentWritable || this.#remoteDepth > 0;
  }

  setDocumentWritable(writable: boolean): void {
    if (this.#documentWritable === writable) return;
    // Told as a change of read-only (`isReadOnly`)
    this.#local(() => {
      this.#documentWritable = writable;
    }, true);
  }

  /**
   * Runs a write of the state of this client as one notification of this Store. `redraw` marks
   * the notification for a state the categories do not describe (the vertex selection,
   * read-only, the interaction lock, local visibility), in case the contract notifies it with no
   * category or not at all.
   */
  #local(fn: () => void, redraw = false): void {
    // A write of the state of this client comes after the rows of a restore under way (the
    // selection reads them), in the same transaction too
    this.#queue.finishHeld();
    this.#bus.transact(() => {
      fn();
      if (redraw) this.#bus.merge({ uiStateChanged: true });
    }, 'local');
  }

  /**
   * Selects items by their IDs (none in bulk): the features selected in bulk before, if any, are
   * no longer
   */
  #select(type: SelectionType | null, ids: string[]): void {
    this.#local(() => {
      const previous = this.getSelection();
      this.#selecting = true;
      try {
        this.#setBulk(null);
        this.#setContractSelection(type, ids);
      } finally {
        this.#selecting = false;
      }
      if (previous.bulk) this.#notifySelection(previous);
    });
  }

  /**
   * Selects features in bulk: `rows` are the features, and `type` and `ids` the items selected
   * (the groups or the layers whose features they are; none for features)
   */
  #selectBulk(type: SelectionType, ids: string[], rows: TableSelection): void {
    if (rows.count === 0) {
      this.#select(null, []);
      return;
    }
    this.#local(() => {
      const previous = this.getSelection();
      this.#selecting = true;
      try {
        this.#setBulk({ type, rows });
        this.#setContractSelection(
          type === 'feature' ? null : type,
          type === 'feature' ? [] : [...ids],
        );
      } finally {
        this.#selecting = false;
      }
      this.#notifySelection(previous);
    });
  }

  /**
   * Makes rows the features selected in bulk (none: no feature is), marking them for the drawing
   */
  #setBulk(next: { type: SelectionType; rows: TableSelection } | null): void {
    const internals = featureTablesInternals(this.#contract.tables);
    const before = this.#bulk?.rows ?? TableSelection.empty;
    const after = next?.rows ?? TableSelection.empty;
    if (internals && !before.equals(after)) {
      const dropped = before.handles.filter((handle) => !after.has(handle));
      const added = after.handles.filter((handle) => !before.has(handle));
      if (dropped.length > 0) internals.states.setBulk(dropped, false);
      if (added.length > 0) internals.states.setBulk(added, true);
    }
    const had = this.#bulk !== null;
    this.#bulk =
      next && internals && next.rows.count > 0
        ? { type: next.type, rows: next.rows, summary: summaryOf(internals, next.rows) }
        : null;
    this.#bulkUnlocked = null;
    // What moves them on the terrain starts being built once they are selected
    if (internals && (this.#bulk || had) && !before.equals(after)) {
      internals.bulkSelected(this.#bulk?.rows ?? null);
    }
  }

  /**
   * Tells the selection now, and the one this Store told before it, in the notification being
   * made (the contract tells its own, which holds no feature selected in bulk)
   */
  #notifySelection(_previous?: Selection): void {
    const change = this.#selectionChange();
    if (change) this.#bus.merge({ selection: change });
  }

  /**
   * The change of the selection from the one this Store told last to the one now (null when it
   * is the same), which becomes the one told
   */
  #selectionChange(): StoreChange['selection'] | null {
    const now = this.getSelection();
    const previous = this.#toldSelection;
    if (
      now.type === previous.type &&
      now.bulk === previous.bulk &&
      now.ids.length === previous.ids.length &&
      now.ids.every((id, i) => id === previous.ids[i])
    ) {
      return null;
    }
    const previousValue = this.#toldValue ?? valueOfSelection(this, previous);
    const value = valueOfSelection(this, now);
    this.#toldSelection = {
      type: now.type,
      ids: [...now.ids],
      ...(now.bulk && { bulk: now.bulk }),
    };
    this.#toldBefore = previousValue;
    this.#toldValue = value;
    return {
      type: now.type,
      ids: [...now.ids],
      previousType: previous.type,
      previousIds: [...previous.ids],
      ...(now.bulk && { bulk: now.bulk }),
      ...(previous.bulk && { previousBulk: previous.bulk }),
      value,
      previousValue,
    };
  }

  /** What the rows read of the layers, the groups and what this client hides */
  #containers(): RowContainers {
    const contract = this.#contract;
    return {
      layerVisible: (layerId) => contract.getLayer(layerId)?.visible === true,
      layerLocked: (layerId) => contract.getLayer(layerId)?.locked === true,
      hidden: (id) => contract.isHidden(id),
    };
  }

  /**
   * Edits whose target is the selection (`{ selection: true }`) made edits of the features
   * selected now, by their IDs: the edits are given as they are when none is
   */
  #withSelectionResolved(edits: readonly FeatureEdit[]): readonly FeatureEdit[] {
    if (!Array.isArray(edits)) return edits;
    let selected: readonly string[] | null = null;
    let out: FeatureEdit[] | null = null;
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      const target = (edit as { target?: unknown } | null | undefined)?.target;
      if (
        typeof target !== 'object' ||
        target === null ||
        (target as { selection?: unknown }).selection !== true ||
        Object.keys(target).length !== 1
      ) {
        continue;
      }
      selected ??= this.#selectedFeatureIds();
      out ??= [...edits];
      out[i] = { ...edit, target: { featureIds: selected } } as FeatureEdit;
    }
    return out ?? edits;
  }

  /**
   * The IDs of the features selected: the rows selected in bulk, or the features, the members of
   * the groups or the features of the layers selected
   */
  #selectedFeatureIds(): readonly string[] {
    const contract = this.#contract;
    const tables = contract.tables;
    const bulk = this.#bulk;
    if (bulk && tables) {
      const ids: string[] = [];
      for (const handle of bulk.rows.handles) {
        const id = tables.getRowId(handle);
        if (id !== undefined) ids.push(id);
      }
      return ids;
    }
    const { type, ids } = contract.getSelection();
    if (type === 'feature') return [...ids];
    const out: string[] = [];
    const membersOf = (group: Group): readonly string[] =>
      group.kind === 'table' ? tableGroupMemberIds(tables, group) : group.featureIds;
    if (type === 'group') {
      for (const id of ids) {
        const group = contract.getGroup(id);
        if (group) out.push(...membersOf(group));
      }
    } else if (type === 'layer') {
      for (const id of ids) {
        const layer = contract.getLayer(id);
        if (!layer) continue;
        if (layer.kind === 'table') {
          out.push(...tableLayerFeatureIds(tables, id));
          continue;
        }
        for (const item of layer.items) {
          const group = contract.getGroup(item);
          if (group) out.push(...membersOf(group));
          else out.push(item);
        }
      }
    }
    return out;
  }

  /** The rows of the features of a selection (the members of the groups and the layers) */
  #rowsOfSelection(
    internals: FeatureTablesInternals,
    type: SelectionType,
    ids: readonly string[],
  ): TableSelection {
    const tables = this.#contract.tables as FeatureTables;
    const handles: number[] = [];
    if (type === 'feature') {
      for (const id of ids) {
        const handle = tables.getRowRef(id);
        if (handle !== undefined) handles.push(handle);
      }
    } else if (type === 'group') {
      for (const id of ids) {
        const group = this.#contract.getGroup(id);
        const handle = group ? internals.groups.handleOfId(group.id) : -1;
        const view = group ? tables.get(group.layerId) : undefined;
        if (handle < 0 || !view) continue;
        handles.push(...view.listGroupMembers(handle, 0, view.countGroupMembers(handle)));
      }
    } else {
      const cursor = tables.scan({ layerIds: [...ids] });
      for (let batch = cursor.next(); batch; batch = cursor.next()) handles.push(...batch);
    }
    const containers = this.#containers();
    return TableSelection.of(handles).filter((handle) => isRowShown(internals, containers, handle));
  }

  /**
   * Keeps the features selected in bulk what the selection holds after a change of the document:
   * the rows that were deleted or can no longer be seen leave it, and the features of the groups
   * and the layers selected are read again when what is in them may have changed. Only the rows
   * the change names are looked at, but after a change of a layer or a group, or of what this
   * client hides, when every row is
   *
   * @param changes The change, or null to look at every row
   */
  #pruneBulk(changes: StoreChange | null): void {
    const bulk = this.#bulk;
    const internals = featureTablesInternals(this.#contract.tables);
    if (!bulk || !internals || this.#selecting) return;
    const previous = this.getSelection();
    if (bulk.type !== 'feature') {
      const selection = this.#contract.getSelection();
      if (selection.type !== bulk.type || selection.ids.length === 0) {
        this.#setBulk(null);
        this.#notifySelection(previous);
        return;
      }
      if (changes && !membersMayChange(changes)) {
        this.#refreshSummary(changes);
        return;
      }
      const rows = this.#rowsOfSelection(internals, selection.type, selection.ids);
      if (rows.equals(bulk.rows)) {
        this.#refreshSummary(changes);
        return;
      }
      // Few enough: the groups or the layers are selected by their IDs again
      this.#setBulk(rows.count > this.selectionIdsLimit ? { type: bulk.type, rows } : null);
      this.#notifySelection(previous);
      return;
    }
    const containers = this.#containers();
    const checked = changes ? rowsToCheck(internals, changes) : null;
    const keep = (handle: number): boolean => isRowShown(internals, containers, handle);
    const rows =
      checked === null
        ? bulk.rows.filter(keep)
        : bulk.rows.without(checked.filter((handle) => bulk.rows.has(handle) && !keep(handle)));
    if (rows === bulk.rows) {
      this.#refreshSummary(changes);
      return;
    }
    if (rows.count > this.selectionIdsLimit) {
      this.#setBulk({ type: 'feature', rows });
      this.#notifySelection(previous);
      return;
    }
    // Few enough: they are selected by their IDs
    const ids: string[] = [];
    for (const handles of rowsByLayerInOrder(internals, rows).values()) {
      for (const handle of handles) ids.push(internals.ids.idOf(handle) as string);
    }
    this.#selecting = true;
    try {
      this.#setBulk(null);
      this.#setContractSelection(ids.length > 0 ? 'feature' : null, ids);
    } finally {
      this.#selecting = false;
    }
    this.#notifySelection(previous);
  }

  /**
   * Makes the summary of the features selected in bulk again when a change wrote the geometry or
   * the layer of one of them (their extent and their layers)
   */
  #refreshSummary(changes: StoreChange | null): void {
    const bulk = this.#bulk;
    const internals = featureTablesInternals(this.#contract.tables);
    if (!bulk || !internals || (changes !== null && this.#queue.pending)) return;
    let touched = changes === null;
    for (const change of changes?.rows?.layers.values() ?? []) {
      if (touched) break;
      if (!change.fields.has('geometry') && !change.fields.has('parent')) continue;
      touched = change.updated.some((handle) => bulk.rows.has(handle));
    }
    if (touched) bulk.summary = summaryOf(internals, bulk.rows);
  }

  /**
   * The number of features of rows a selection holds (0 for a Store without rows)
   */
  #featureCount(type: SelectionType | null, ids: readonly string[]): number {
    const tables = this.#contract.tables;
    if (!tables) return 0;
    if (type === 'group') {
      let count = 0;
      for (const id of ids) {
        const group = this.#contract.getGroup(id);
        if (group) count += tableGroupMemberCount(tables, group);
      }
      return count;
    }
    if (type === 'layer') {
      let count = 0;
      for (const id of ids) count += tableLayerFeatureCount(tables, id);
      return count;
    }
    return ids.length;
  }

  /**
   * The rows were taken out of the tables, to come back (`FeatureTablesWriter.clear`): the
   * features selected in bulk are let go of. The features selected by their IDs stay selected
   */
  #rowsReplaced(): void {
    if (this.#bulk) {
      this.#selecting = true;
      try {
        this.#setBulk(null);
        this.#setContractSelection(null, []);
      } finally {
        this.#selecting = false;
      }
      this.#notifySelection();
    }
  }

  /**
   * Takes a notification of the contract into the notification of this Store, together with
   * the state of this client it changes (one notification with the contract's source when it
   * did not come from a transaction of this Store)
   */
  #receive(changes: StoreChange): void {
    this.#bulkUnlocked = null;
    // The values of the selection told keep the document as it was when they were told
    settleSelectionValues(this, changes, [this.#toldValue, this.#toldBefore]);
    // The notification of a restore written in steps goes into the one this Store holds
    const run = <T>(fn: () => T, source: UpdateSource): T =>
      this.#queue.holding ? this.#bus.continueHeld(fn) : this.#bus.transact(fn, source);
    run(() => {
      const normalized = this.#normalizeChanges(withoutSource(changes));
      if (normalized.selection) {
        // The selection as this Store reads it, from the one it told before
        const change = this.#selectionChange();
        if (change) normalized.selection = change;
        else delete normalized.selection;
      }
      this.#bus.merge(normalized);
      if (changes.reset === true && this.#contract.tables) this.#rowsReplaced();
      this.#forgetDeleted(changes);
      if (mayHide(changes)) this.#pruneInvisible();
      if (this.#bulk) this.#pruneBulk(changes);
      this.#pruneVertices(changes);
    }, changes.source ?? 'local');
  }

  // ============================================================================
  // Reading the contract in the shape of the public types
  // ============================================================================

  /** The feature with `groupId: null` read as `undefined` (the same object when it has none) */
  #feature(feature: Feature): Feature {
    if (!hasNullFeatureField(feature)) return feature;
    const known = this.#normalized.get(feature) as Feature | undefined;
    if (known) return known;
    const normalized: Feature = { ...feature, groupId: undefined };
    this.#normalized.set(feature, normalized);
    return normalized;
  }

  #features(features: Feature[]): Feature[] {
    return features.some(hasNullFeatureField)
      ? features.map((feature) => this.#feature(feature))
      : features;
  }

  /** The layer with `metadata` and `styleRule` of `null` read as `undefined` */
  #layer(layer: Layer): Layer {
    if (!hasNullLayerField(layer)) return layer;
    const known = this.#normalized.get(layer) as Layer | undefined;
    if (known) return known;
    const normalized: Layer = {
      ...layer,
      metadata: layer.metadata ?? undefined,
      styleRule: layer.styleRule ?? undefined,
    };
    this.#normalized.set(layer, normalized);
    return normalized;
  }

  /**
   * A notification of the contract with its features and layers read like the getters. An
   * update of a layer or a group that changed nothing but its list of items (`items`,
   * `featureIds`) is left out: the change of the order is told by `order` alone, in every kind
   * of layer (a layer held as rows has no list)
   */
  #normalizeChanges(changes: StoreChange): StoreChange {
    const normalized: StoreChange = { ...changes };
    withoutListOnlyUpdates(normalized);
    const { features, layers } = normalized;
    if (features) {
      normalized.features = {
        ...features,
        ...(features.created && { created: features.created.map((f) => this.#feature(f)) }),
        ...(features.updated && {
          updated: features.updated.map((entry) => ({
            ...entry,
            feature: this.#feature(entry.feature),
            previous: this.#feature(entry.previous),
          })),
        }),
        ...(features.deleted && { deleted: features.deleted.map((f) => this.#feature(f)) }),
      };
    }
    if (layers) {
      normalized.layers = {
        ...layers,
        ...(layers.created && { created: layers.created.map((l) => this.#layer(l)) }),
        ...(layers.updated && {
          updated: layers.updated.map((entry) => ({
            ...entry,
            layer: this.#layer(entry.layer),
            previous: this.#layer(entry.previous),
          })),
        }),
        ...(layers.deleted && { deleted: layers.deleted.map((l) => this.#layer(l)) }),
      };
    }
    return normalized;
  }

  /** Removes an id that no longer names anything from the state of this client */
  #forget(id: string): void {
    const contract = this.#contract;
    if (contract.getFeature(id) || contract.getGroup(id) || contract.getLayer(id)) return;
    const selection = contract.getSelection();
    if (selection.ids.includes(id)) {
      const ids = selection.ids.filter((selected) => selected !== id);
      this.#setContractSelection(ids.length === 0 ? null : selection.type, ids);
    }
    if (contract.getEditingIds().includes(id)) {
      contract.endEditing([id]);
    }
    if (contract.isHidden(id)) {
      contract.setLocallyHidden(id, false);
      this.#bus.merge({ uiStateChanged: true });
    }
  }

  /**
   * Removes the ids that no longer name anything from the state of this client, at once (see
   * `#forget`): only the ids the state holds are looked at, and the selection is set once however
   * many of its items are gone
   */
  #forgetAll(ids: readonly string[]): void {
    if (ids.length === 1) {
      this.#forget(ids[0] as string);
      return;
    }
    const contract = this.#contract;
    const selection = contract.getSelection();
    const editingIds = contract.getEditingIds();
    const hidden = contract.listHidden();
    if (selection.ids.length === 0 && editingIds.length === 0 && hidden.size === 0) return;
    const named = new Set(ids);
    const gone = new Set<string>();
    const look = (id: string): void => {
      if (!named.has(id) || gone.has(id)) return;
      if (!contract.getFeature(id) && !contract.getGroup(id) && !contract.getLayer(id)) {
        gone.add(id);
      }
    };
    for (const id of selection.ids) look(id);
    for (const id of editingIds) look(id);
    for (const id of hidden) look(id);
    if (gone.size === 0) return;
    if (selection.ids.some((id) => gone.has(id))) {
      const kept = selection.ids.filter((id) => !gone.has(id));
      this.#setContractSelection(kept.length === 0 ? null : selection.type, kept);
    }
    const ended = editingIds.filter((id) => gone.has(id));
    if (ended.length > 0) contract.endEditing(ended);
    let unhidden = false;
    for (const id of gone) {
      if (!contract.isHidden(id)) continue;
      contract.setLocallyHidden(id, false);
      unhidden = true;
    }
    if (unhidden) this.#bus.merge({ uiStateChanged: true });
  }

  /**
   * Removes the items a notification deleted from the state of this client (see `#forgetAll`): the
   * features, the groups and the layers it names, and the rows it tells by their handles, looked
   * for among the IDs the state holds
   */
  #forgetDeleted(changes: StoreChange): void {
    const named: string[] = [];
    for (const feature of changes.features?.deleted ?? []) named.push(feature.id);
    if (hasRowsDeleted(changes)) {
      const contract = this.#contract;
      const selection = contract.getSelection();
      if (selection.type === 'feature') for (const id of selection.ids) named.push(id);
      for (const id of contract.getEditingIds()) named.push(id);
      for (const id of contract.listHidden()) named.push(id);
    }
    for (const group of changes.groups?.deleted ?? []) named.push(group.id);
    for (const layer of changes.layers?.deleted ?? []) named.push(layer.id);
    if (named.length > 0) this.#forgetAll(named);
  }

  /** Sets the selection the contract keeps, and the rows whose features are kept for it */
  #setContractSelection(type: SelectionType | null, ids: string[]): void {
    this.#contract.setSelection(type, ids);
    this.#keepSelectedRows();
  }

  /**
   * Keeps the features of the rows the selection lists, while they are selected
   * (`FeatureCache.keepSelected`): the rows of the features it lists, or of the groups and the
   * layers it lists, up to the features the selection lists the IDs of (`selectionIdsLimit`);
   * none past it, nor for a selection in bulk
   */
  #keepSelectedRows(): void {
    const internals = featureTablesInternals(this.#contract.tables);
    if (!internals) return;
    const { type, ids } = this.#contract.getSelection();
    const rows = this.#rowsToKeep(internals, type, ids);
    internals.featureCache.keepSelected(rows?.handles ?? null, rows?.ids);
  }

  /** The rows of a selection whose features are kept (null for none, see `#keepSelectedRows`) */
  #rowsToKeep(
    internals: FeatureTablesInternals,
    type: SelectionType | null,
    ids: readonly string[],
  ): { handles: number[]; ids?: string[] } | null {
    if (type === null || ids.length === 0) return null;
    const tables = this.#contract.tables as FeatureTables;
    const limit = this.selectionIdsLimit;
    const handles: number[] = [];
    if (type === 'feature') {
      if (ids.length > limit) return null;
      const found: string[] = [];
      for (const id of ids) {
        const handle = tables.getRowRef(id);
        if (handle === undefined) continue;
        handles.push(handle);
        found.push(id);
      }
      return { handles, ids: found };
    }
    if (type === 'group') {
      for (const id of ids) {
        const group = this.#contract.getGroup(id);
        const handle = group ? internals.groups.handleOfId(group.id) : -1;
        const view = group ? tables.get(group.layerId) : undefined;
        if (handle < 0 || !view) continue;
        const count = view.countGroupMembers(handle);
        if (handles.length + count > limit) return null;
        handles.push(...view.listGroupMembers(handle, 0, count));
      }
      return { handles };
    }
    let count = 0;
    for (const id of ids) count += tables.get(id)?.rowCount ?? 0;
    if (count > limit) return null;
    const cursor = tables.scan({ layerIds: [...ids] });
    for (let batch = cursor.next(); batch; batch = cursor.next()) handles.push(...batch);
    return { handles };
  }

  /**
   * Takes out of the selection what cannot be seen (see isShown); a hidden item never keeps
   * its handles, its vertex hits or its place in a Delete
   */
  #pruneInvisible(): void {
    const selection = this.#contract.getSelection();
    const type = selection.type;
    if (type === null || selection.ids.length === 0) return;
    const shown = createShownLookup(this.#contract);
    const kept = selection.ids.filter((id) => shown(type, id));
    if (kept.length !== selection.ids.length) {
      this.#setContractSelection(kept.length > 0 ? type : null, kept);
    }
  }

  /**
   * What a vertex selection names its vertices by: their IDs when the Store gives its vertices IDs,
   * and the layout of the vertices of its feature (null for a feature that is not there)
   */
  #vertexTargetsOf(selection: VertexSelection): VertexTargets | null {
    const feature = this.#contract.getFeature(selection.featureId);
    if (!feature) return null;
    const getVertexIds = this.getVertexIds;
    return {
      featureId: selection.featureId,
      ids: getVertexIds && this.findVertices ? getVertexIds(feature.id, selection.vertices) : null,
      layout: vertexLayout(feature),
      coordinates: coordinatesOf(feature),
    };
  }

  /**
   * Keeps the vertex selection on its vertices after a change of its feature from elsewhere or by a
   * local drag, and ends it when the feature is gone, or when this client changes its coordinates
   * other than by a drag (a move by the arrow keys, an edit through the API). Named by their IDs,
   * their places are read again (`findVertices`): a vertex that is no longer there leaves the
   * selection, which ends once none is left, and a vertex added or moved elsewhere keeps it. Named
   * by their places, it ends when the vertices of the feature are no longer as many in each ring
   * and part: a vertex moved keeps it
   */
  #pruneVertices(changes: StoreChange): void {
    const vertices = this.#contract.getVertexSelection();
    if (!vertices) {
      this.#vertexTargets = null;
      return;
    }
    const featureId = vertices.featureId;
    const feature = this.#contract.getFeature(featureId);
    if (!feature) {
      this.#endVertexSelection();
      return;
    }
    const targets = this.#vertexTargets;
    if (!targets || targets.featureId !== featureId) {
      this.#vertexTargets = this.#vertexTargetsOf(vertices);
      return;
    }
    if (!this.#featureChanged(changes, featureId)) return;
    const coordinates = coordinatesOf(feature);
    const remote = changes.source === 'remote';
    const dragged = !remote && this.#drawing.getDragState() !== null;
    if (!remote && !dragged && !sameCoordinates(coordinates, targets.coordinates)) {
      this.#endVertexSelection();
      return;
    }
    const layout = vertexLayout(feature);
    const findVertices = this.findVertices;
    if (targets.ids && findVertices) {
      const places = findVertices(featureId, targets.ids);
      const kept: VertexRef[] = [];
      const ids: VertexId[] = [];
      places.forEach((place, i) => {
        if (!place) return;
        kept.push(place);
        ids.push(targets.ids?.[i] as VertexId);
      });
      if (kept.length === 0) {
        this.#endVertexSelection();
        return;
      }
      this.#vertexTargets = { featureId, ids, layout, coordinates };
      if (!sameVertexRefs(kept, vertices.vertices)) {
        this.#contract.setSelectedVertices({ featureId, vertices: kept });
        this.#bus.merge({ uiStateChanged: true });
      }
      return;
    }
    // The commit of a local drag keeps the vertices being dragged selected
    if (layout !== targets.layout && !dragged) {
      this.#endVertexSelection();
      return;
    }
    this.#vertexTargets = { ...targets, layout, coordinates };
  }

  /** Whether a notification wrote a feature: as a feature, or as its row */
  #featureChanged(changes: StoreChange, id: string): boolean {
    if (changes.reset) return true;
    if (changes.features?.updated?.some((entry) => entry.id === id)) return true;
    const handle = changes.rows ? this.#contract.tables?.getRowRef(id) : undefined;
    if (handle === undefined) return false;
    for (const rows of changes.rows?.layers.values() ?? []) {
      if (rows.updated.includes(handle) || rows.created.includes(handle)) return true;
    }
    return false;
  }

  /** Clears the vertex selection, marking the notification for the drawing */
  #endVertexSelection(): void {
    this.#vertexTargets = null;
    this.#contract.setSelectedVertices(null);
    this.#bus.merge({ uiStateChanged: true });
  }
}

/** Whether two objects hold the same value for every key but one */
function sameBut(a: object, b: object, key: string): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const name of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (name !== key && left[name] !== right[name]) return false;
  }
  return true;
}

/**
 * Takes out of a notification the updates of the layers and the groups that changed only their
 * list of items, and the categories they leave empty
 */
function withoutListOnlyUpdates(changes: StoreChange): void {
  const { layers, groups } = changes;
  if (layers?.updated) {
    const updated = layers.updated.filter(
      (entry) => !sameBut(entry.layer, entry.previous, 'items'),
    );
    if (updated.length !== layers.updated.length) {
      const { updated: _all, ...rest } = layers;
      const next = updated.length > 0 ? { ...rest, updated } : rest;
      if (Object.keys(next).length > 0) changes.layers = next;
      else delete changes.layers;
    }
  }
  if (groups?.updated) {
    const updated = groups.updated.filter(
      (entry) => !sameBut(entry.group, entry.previous, 'featureIds'),
    );
    if (updated.length !== groups.updated.length) {
      const { updated: _all, ...rest } = groups;
      const next = updated.length > 0 ? { ...rest, updated } : rest;
      if (Object.keys(next).length > 0) changes.groups = next;
      else delete changes.groups;
    }
  }
}

/**
 * Whether a notification can hide something that was visible: a change of the visible flag
 * of a feature, or of its place (a feature moved into a hidden layer or group), and any
 * update of a group or a layer
 */
function mayHide(changes: StoreChange): boolean {
  if (changes.layers?.updated?.length || changes.groups?.updated?.length) return true;
  for (const { feature, previous } of changes.features?.updated ?? []) {
    if (feature.visible !== previous.visible) return true;
    if (feature.layerId !== previous.layerId || feature.groupId !== previous.groupId) return true;
  }
  for (const rows of changes.rows?.layers.values() ?? []) {
    if (rows.updated.length === 0) continue;
    if (rows.fields.has('hidden') || rows.fields.has('parent')) {
      return true;
    }
  }
  return false;
}

/** Whether a notification tells rows deleted */
function hasRowsDeleted(changes: StoreChange): boolean {
  for (const rows of changes.rows?.layers.values() ?? []) {
    if (rows.deleted.length > 0) return true;
  }
  return false;
}

/**
 * The layout of the vertices of a feature: how many positions each ring and part has, which a
 * vertex selection by places keeps (a vertex moved keeps it, one added or deleted does not)
 */
function vertexLayout(feature: Feature): string {
  const out: number[] = [];
  const walk = (value: unknown): void => {
    if (!Array.isArray(value) || value.length === 0 || typeof value[0] === 'number') return;
    out.push(value.length);
    for (const item of value) walk(item);
  };
  walk(coordinatesOf(feature));
  return out.join(',');
}

/** Whether two nested arrays of coordinates hold the same numbers */
function sameCoordinates(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sameCoordinates(a[i], b[i])) return false;
  }
  return true;
}

/** Whether two lists of vertices name the same vertices */
function sameVertexRefs(a: readonly VertexRef[], b: readonly VertexRef[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (vertex, i) =>
        (vertex.part ?? 0) === (b[i].part ?? 0) &&
        vertex.ring === b[i].ring &&
        vertex.index === b[i].index,
    )
  );
}

/**
 * Whether a selected item can be seen: it exists, its own visible flag and the ones of its
 * group and layer are on, and neither it nor its group nor its layer is hidden locally.
 * Each layer and group is looked up once per call site (a document can take time to read a
 * layer).
 */
function createShownLookup(document: StoreContract): (type: SelectionType, id: string) => boolean {
  const ui = document;
  const layers = new Map<string, boolean>();
  const groups = new Map<string, boolean>();

  const layerShown = (id: string): boolean => {
    let shown = layers.get(id);
    if (shown === undefined) {
      const layer = document.getLayer(id);
      shown = layer?.visible === true && !ui.isHidden(id);
      layers.set(id, shown);
    }
    return shown;
  };

  const groupShown = (id: string): boolean => {
    let shown = groups.get(id);
    if (shown === undefined) {
      const group = document.getGroup(id);
      const layerId = group?.layerId;
      shown =
        group?.visible === true &&
        !ui.isHidden(id) &&
        (layerId === undefined || layerShown(layerId));
      groups.set(id, shown);
    }
    return shown;
  };

  return (type, id) => {
    if (type === 'layer') return layerShown(id);
    if (type === 'group') return groupShown(id);
    const feature = document.getFeature(id);
    if (!feature?.visible || ui.isHidden(id)) return false;
    if (feature.groupId && !groupShown(feature.groupId)) return false;
    return layerShown(feature.layerId);
  };
}

/** Whether a feature of the contract gives `null` for an optional field */
function hasNullFeatureField(feature: Feature): boolean {
  return (feature.groupId as unknown) === null;
}

/** Whether a layer of the contract gives `null` for an optional field */
function hasNullLayerField(layer: Layer): boolean {
  return (layer.metadata as unknown) === null || (layer.styleRule as unknown) === null;
}

/** A notification of the contract without its source (the transaction here carries it) */
function withoutSource(changes: StoreChange): StoreChange {
  const { source: _source, ...rest } = changes;
  return rest;
}

/**
 * Whether a change may change what is in the groups or the layers selected: rows created,
 * deleted or moved, groups or layers changed, what this client hides
 */
function membersMayChange(changes: StoreChange): boolean {
  if (changes.reset || changes.uiStateChanged) return true;
  if (changes.features?.created?.length || changes.features?.deleted?.length) return true;
  if (changes.groups || changes.layers) return true;
  for (const rows of changes.rows?.layers.values() ?? []) {
    if (rows.created.length > 0 || rows.deleted.length > 0) return true;
    if (rows.fields.has('parent') || rows.fields.has('hidden')) {
      return true;
    }
  }
  return false;
}

/**
 * The rows a change may have hidden or deleted, or null when it may have hidden any (a change of
 * a layer or a group, of what this client hides, or a reset)
 */
function rowsToCheck(internals: FeatureTablesInternals, changes: StoreChange): Int32Array | null {
  if (changes.reset || changes.uiStateChanged) return null;
  if (changes.layers?.updated?.length || changes.layers?.deleted?.length) return null;
  if (changes.groups?.updated?.length || changes.groups?.deleted?.length) return null;
  const out: number[] = [];
  for (const rows of changes.rows?.layers.values() ?? []) {
    out.push(...rows.deleted);
    if (rows.fields.has('hidden') || rows.fields.has('parent')) {
      out.push(...rows.updated);
    }
  }
  for (const feature of changes.features?.deleted ?? []) {
    const handle = internals.ids.handleOf(feature.id);
    if (handle >= 0) out.push(handle);
  }
  for (const { feature, previous } of changes.features?.updated ?? []) {
    if (
      feature.visible !== previous.visible ||
      feature.layerId !== previous.layerId ||
      feature.groupId !== previous.groupId
    ) {
      const handle = internals.ids.handleOf(feature.id);
      if (handle >= 0) out.push(handle);
    }
  }
  return Int32Array.from(out);
}
