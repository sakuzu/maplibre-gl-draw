// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The implementation of the features of a document held as rows of columns
 *
 * The reading and writing sides are declared in `api/tables.ts`. Here are the tables
 * themselves: the ids and their handles, the styles, the groups of features, the state of the
 * rows, and the row groups of every layer. The drawing and the hit testing read them through
 * `featureTablesInternals`.
 */

import type {
  FeatureTables,
  FeatureTablesOptions,
  FeatureTablesWriter,
  LayerTableView,
  RowHandle,
} from '../api/tables.js';
import type { BBox } from '../geometry/types.js';
import type { Feature, FeatureType } from '../shared/types/model.js';
import { ROW_FLAG_DELETED, ROW_FLAG_VISIBLE, type RowGroupData } from '../table/row-group-types.js';
import { utf8ColumnLength } from '../table/utf8-column.js';
import { ValueStringCache } from '../table/value-column.js';
import { GroupTable } from './group-table.js';
import { IdIndex } from './id-index.js';
import { createRowGroup, LayerTable, type RowGroup } from './layer-table.js';
import { type RowReadContext, rowFeature, rowPoint, rowType, rowValue } from './row-read.js';
import {
  RowStateSets,
  STATE_HIDDEN_DELETED,
  STATE_HIDDEN_GROUP,
  STATE_HIDDEN_INVISIBLE,
  STATE_HIDDEN_MASK,
  STATE_UNIFORM,
  toGpuState,
} from './row-state.js';
import { StyleTable } from './style-table.js';
import type { RowGroupHandle, TableWorkBudget } from './types.js';

/**
 * Creates the tables of the features of a document, as its reading and writing sides (the
 * implementation of `createFeatureTables`)
 *
 * @internal
 */
export function createFeatureTablesStore(options: FeatureTablesOptions = {}): {
  tables: FeatureTables;
  writer: FeatureTablesWriter;
} {
  const store = new FeatureTablesStore(options);
  const tables: FeatureTables = {
    layer: (layerId) => store.view(layerId),
    handleOf: (id) => store.handleOf(id),
    idOf: (handle) => store.ids.idOf(handle),
  };
  const writer: FeatureTablesWriter = {
    allocateHandles: (ids, hashes) => store.ids.allocate(ids, hashes),
    adopt: (layerId, groups) => store.adopt(layerId, groups),
  };
  INTERNALS.set(tables, store);
  return { tables, writer };
}

/**
 * What core reads of the tables besides the reading side (the drawing, the hit testing)
 *
 * @internal
 */
export interface FeatureTablesInternals {
  readonly ids: IdIndex;
  readonly styles: StyleTable;
  readonly groups: GroupTable;
  readonly states: RowStateSets;
  readonly strings: ValueStringCache;
  readonly readContext: RowReadContext;
  /** Changes with every change of the rows drawn of any layer */
  readonly revision: number;
  /** The rows of a layer (undefined for a layer that holds none) */
  layerTable(layerId: string): LayerTable | undefined;
  /** The layer and the row group of a handle of a row group */
  rowGroup(handle: RowGroupHandle): { layer: LayerTable; group: RowGroup } | undefined;
  /** The handles of the row groups of a set of rows, the rows by group */
  groupsOfRows(handles: Int32Array): Map<RowGroupHandle, number[]>;
  /** Whether row groups given to `adopt` are still waiting to be taken in */
  readonly hasPendingAdoption: boolean;
  /**
   * Takes in the row groups waiting, one group per step, within the budget of the frame (at
   * least one group per call). A group that cannot be taken in is left out and reported
   *
   * @returns Whether groups are still waiting
   */
  advanceAdoption(budget: TableWorkBudget): boolean;
  /**
   * Takes in every row group waiting at once (a host without frames, the tests)
   *
   * @throws when a group cannot be taken in (the groups after it keep waiting)
   */
  flushAdoption(): void;
  /**
   * Calls `listener` when row groups start waiting, so the drawing asks for a frame
   *
   * @returns The function that stops the calls
   */
  onPendingWork(listener: () => void): () => void;
}

const INTERNALS = new WeakMap<FeatureTables, FeatureTablesStore>();

/**
 * The internals of tables made by {@link createFeatureTables} (undefined for an object made
 * elsewhere)
 *
 * @internal
 */
export function featureTablesInternals(
  tables: FeatureTables | undefined,
): FeatureTablesInternals | undefined {
  return tables ? INTERNALS.get(tables) : undefined;
}

/** The implementation of the tables */
class FeatureTablesStore implements FeatureTablesInternals {
  readonly ids = new IdIndex();
  readonly styles = new StyleTable();
  readonly groups = new GroupTable();
  readonly strings: ValueStringCache;
  readonly states: RowStateSets;
  readonly readContext: RowReadContext;
  private readonly layers = new Map<string, LayerTable>();
  private readonly views = new Map<string, LayerTableView>();
  private readonly rowGroups = new Map<RowGroupHandle, { layer: LayerTable; group: RowGroup }>();
  private nextGroup = 0;
  private revisionCount = 0;
  /** The row groups given to `adopt` and not taken in yet, in the order they were given */
  private readonly adoptions: Array<{ layer: LayerTable; data: RowGroupData }> = [];
  private readonly workListeners = new Set<() => void>();

  constructor(options: FeatureTablesOptions) {
    this.strings = new ValueStringCache(options.stringCacheSize);
    this.states = new RowStateSets((handles) => this.refreshStates(handles));
    this.readContext = { styles: this.styles, groups: this.groups, strings: this.strings };
  }

  get revision(): number {
    return this.revisionCount;
  }

  layerTable(layerId: string): LayerTable | undefined {
    return this.layers.get(layerId);
  }

  rowGroup(handle: RowGroupHandle): { layer: LayerTable; group: RowGroup } | undefined {
    return this.rowGroups.get(handle);
  }

  view(layerId: string): LayerTableView | undefined {
    const layer = this.layers.get(layerId);
    if (!layer) return undefined;
    let view = this.views.get(layerId);
    if (!view) {
      view = new LayerTableViewImpl(this, layer);
      this.views.set(layerId, view);
    }
    return view;
  }

  handleOf(id: string): RowHandle | undefined {
    const handle = this.ids.handleOf(id);
    if (handle < 0) return undefined;
    const placed = this.rowGroups.get(this.ids.mainGroup(handle));
    if (!placed) return undefined;
    const row = this.ids.mainRow(handle);
    return (placed.group.data.flags[row] & ROW_FLAG_DELETED) !== 0 ? undefined : handle;
  }

  groupsOfRows(handles: Int32Array): Map<RowGroupHandle, number[]> {
    const out = new Map<RowGroupHandle, number[]>();
    for (const handle of handles) {
      const group = this.ids.mainGroup(handle);
      if (group < 0) continue;
      let rows = out.get(group);
      if (!rows) {
        rows = [];
        out.set(group, rows);
      }
      rows.push(this.ids.mainRow(handle));
    }
    return out;
  }

  /**
   * Checks the row groups and queues them: they are taken in a group at a time within the
   * budget of the frames (`advanceAdoption`), so a large file does not hold a frame
   */
  adopt(layerId: string, groups: readonly RowGroupData[]): void {
    // The checks of the shape of the groups are cheap and done here, so that a group made wrong
    // is refused before anything is queued; the checks of the rows are done when it is taken in
    for (const data of groups) {
      checkShape(data);
      if (data.length === 0) throw new Error('FeatureTables: an empty row group');
      for (let r = 0; r < data.length; r++) {
        const group = data.groups[r];
        if (group >= 0 && !this.groups.has(group)) {
          throw new Error(`FeatureTables: a row names the group ${group}, which is unknown`);
        }
      }
    }
    let layer = this.layers.get(layerId);
    if (!layer) {
      layer = new LayerTable(layerId, this.groups);
      this.layers.set(layerId, layer);
    }
    const wasPending = this.adoptions.length > 0;
    for (const data of groups) this.adoptions.push({ layer, data });
    if (!wasPending && this.adoptions.length > 0) {
      for (const listener of this.workListeners) listener();
    }
  }

  get hasPendingAdoption(): boolean {
    return this.adoptions.length > 0;
  }

  advanceAdoption(budget: TableWorkBudget): boolean {
    while (this.adoptions.length > 0 && budget.canStep()) {
      const next = this.adoptions.shift() as { layer: LayerTable; data: RowGroupData };
      budget.step(() => {
        try {
          this.adoptGroup(next.layer, next.data);
        } catch (error) {
          // There is no caller to throw to any more: the group is left out
          console.error(error);
        }
      });
    }
    return this.adoptions.length > 0;
  }

  flushAdoption(): void {
    while (this.adoptions.length > 0) {
      const next = this.adoptions.shift() as { layer: LayerTable; data: RowGroupData };
      this.adoptGroup(next.layer, next.data);
    }
  }

  onPendingWork(listener: () => void): () => void {
    this.workListeners.add(listener);
    return () => {
      this.workListeners.delete(listener);
    };
  }

  /** Takes in one row group: the handles, the numbers of its styles, the state of its rows */
  private adoptGroup(layer: LayerTable, data: RowGroupData): void {
    if (data.handles.some((handle) => handle < 0)) {
      data.handles.set(this.ids.allocate(data.ids, data.idHashes));
    }
    for (let r = 0; r < data.length; r++) {
      const handle = data.handles[r];
      if (!this.ids.has(handle)) throw new Error(`FeatureTables: the handle ${handle} is unknown`);
      if (this.ids.mainGroup(handle) >= 0) {
        throw new Error(`FeatureTables: "${this.ids.idOf(handle)}" is already a row`);
      }
    }
    // The styles of a group built in a Worker get the numbers of the table of styles
    const dictionary = data.styleDictionary;
    if (dictionary) {
      const numbers = new Uint32Array(utf8ColumnLength(dictionary));
      for (let i = 0; i < numbers.length; i++) {
        numbers[i] = this.styles.internBytes(
          dictionary.bytes,
          dictionary.offsets[i],
          dictionary.offsets[i + 1],
        );
      }
      for (let r = 0; r < data.length; r++) data.styles[r] = numbers[data.styles[r]];
      data.styleDictionary = null;
    }

    const group = createRowGroup(this.nextGroup++, data);
    for (let r = 0; r < data.length; r++) this.writeState(group, r);
    layer.insert(group);
    this.rowGroups.set(group.handle, { layer, group });
    for (let r = 0; r < data.length; r++) {
      const handle = data.handles[r];
      this.ids.setMain(handle, group.handle, r);
      this.ids.rehome(handle, data.ids, r);
    }
    this.revisionCount++;
  }

  /** Makes the copy of the state of a row again */
  private writeState(group: RowGroup, row: number): void {
    const data = group.data;
    const flags = data.flags[row];
    let state = this.states.stateOf(data.handles[row]);
    if ((flags & ROW_FLAG_VISIBLE) === 0) state |= STATE_HIDDEN_INVISIBLE;
    if ((flags & ROW_FLAG_DELETED) !== 0) state |= STATE_HIDDEN_DELETED;
    const featureGroup = data.groups[row];
    if (featureGroup >= 0 && !this.groups.isVisible(featureGroup)) state |= STATE_HIDDEN_GROUP;
    if (rowType(data, row) === 'Circle') state |= STATE_UNIFORM;
    group.state[row] = state;
    group.gpuState[row] = toGpuState(state);
  }

  /** Makes the copies of the rows whose state changed again */
  private refreshStates(handles: Int32Array): void {
    for (const [handle, rows] of this.groupsOfRows(handles)) {
      const placed = this.rowGroups.get(handle);
      if (!placed) continue;
      for (const row of rows) this.writeState(placed.group, row);
      placed.group.stateVersion++;
    }
    this.revisionCount++;
  }
}

/** Checks that the arrays of a group have one entry per row */
function checkShape(data: RowGroupData): void {
  const n = data.length;
  const perRow: Array<[string, number]> = [
    ['handles', data.handles.length],
    ['ids', utf8ColumnLength(data.ids)],
    ['idHashes', data.idHashes.length],
    ['types', data.types.length],
    ['geometry.types', data.geometry.types.length],
    ['geometry.offsets', data.geometry.offsets.length],
    ['itemKeys', utf8ColumnLength(data.itemKeys)],
    ['memberKeys', utf8ColumnLength(data.memberKeys)],
    ['groups', data.groups.length],
    ['flags', data.flags.length],
    ['styles', data.styles.length],
    ['rowBounds', data.rowBounds.length / 4],
    ['triangles.offsets', data.triangles.offsets.length - 1],
  ];
  for (const [name, length] of perRow) {
    if (length !== n) {
      throw new Error(`FeatureTables: ${name} has ${length} entries for ${n} rows`);
    }
  }
  for (const column of data.properties.columns) {
    if (column.length !== n)
      throw new Error('FeatureTables: an attribute column has another length');
  }
}

/** The rows of one layer, read without making features */
class LayerTableViewImpl implements LayerTableView {
  constructor(
    private readonly store: FeatureTablesStore,
    private readonly table: LayerTable,
  ) {}

  get layerId(): string {
    return this.table.layerId;
  }

  get rowCount(): number {
    return this.table.rowCount;
  }

  listDrawnRows(bbox: BBox): Int32Array {
    const out: number[] = [];
    const rows: number[] = [];
    for (let g = 0; g < this.table.groupCount; g++) {
      const group = this.table.groupAt(g);
      rows.length = 0;
      this.table.searchRows(group, bbox[0], bbox[1], bbox[2], bbox[3], rows);
      rows.sort((a, b) => a - b);
      for (const row of rows) {
        if ((group.state[row] & STATE_HIDDEN_MASK) === 0) out.push(group.data.handles[row]);
      }
    }
    return Int32Array.from(out);
  }

  getRowBounds(handle: RowHandle): BBox | null {
    const at = this.locate(handle);
    if (!at) return null;
    const b = at.group.data.rowBounds;
    const i = at.row * 4;
    if (Number.isNaN(b[i])) return null;
    return [b[i], b[i + 1], b[i + 2], b[i + 3]];
  }

  getRowType(handle: RowHandle): FeatureType | null {
    const at = this.locate(handle);
    return at ? rowType(at.group.data, at.row) : null;
  }

  getRowPoint(handle: RowHandle): [number, number] | null {
    const at = this.locate(handle);
    return at ? rowPoint(at.group, at.row) : null;
  }

  valueAt(handle: RowHandle, key: string): unknown {
    const at = this.locate(handle);
    return at ? rowValue(at.group, at.row, key, this.store.strings) : undefined;
  }

  getRow(handle: RowHandle): Feature | undefined {
    const at = this.locate(handle);
    if (!at || (at.group.data.flags[at.row] & ROW_FLAG_DELETED) !== 0) return undefined;
    return rowFeature(this.store.readContext, this.table.layerId, at.group, at.row);
  }

  getDrawnRowsRevision(): number {
    return this.store.revision;
  }

  rowsInOrder(start: number, count: number): Int32Array {
    const out = new Int32Array(Math.max(0, Math.min(count, this.table.rowCount - start)));
    let skip = Math.max(0, start);
    let written = 0;
    for (let g = 0; g < this.table.groupCount && written < out.length; g++) {
      const data = this.table.groupAt(g).data;
      if (skip >= data.length) {
        skip -= data.length;
        continue;
      }
      for (let r = skip; r < data.length && written < out.length; r++) {
        out[written++] = data.handles[r];
      }
      skip = 0;
    }
    return out;
  }

  /** The group and row of a handle, when its row is in this layer */
  private locate(handle: RowHandle): { group: RowGroup; row: number } | null {
    const placed = this.store.rowGroup(this.store.ids.mainGroup(handle));
    if (!placed || placed.layer !== this.table) return null;
    return { group: placed.group, row: this.store.ids.mainRow(handle) };
  }
}
