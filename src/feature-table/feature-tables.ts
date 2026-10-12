// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The features of a document held as rows of columns (`FeatureTables`)
 *
 * A Store can hold the features of its layers as rows rather than as objects: every layer is a
 * {@link LayerTableView} of rows in row groups, built in a Worker and taken in without a copy.
 * The drawing, the hit testing and the readers of many rows read the columns; a row becomes a
 * feature only when one is asked for.
 *
 * `createFeatureTables` returns the two halves: `tables`, the reading side, which the Store
 * hands out as its `tables`, and `writer`, which only the implementation of the Store keeps and
 * calls (after it has recorded what it writes). Nothing else writes the tables.
 */

import type { BoundingBox, Coordinate, Feature, FeatureType } from '../shared/types/model.js';
import { searchPackedRTree } from '../table/packed-rtree.js';
import { ROW_FLAG_DELETED, ROW_FLAG_VISIBLE, type RowGroupData } from '../table/row-group-types.js';
import { type Utf8Column, utf8ColumnLength } from '../table/utf8-column.js';
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
import type { RowGroupHandle, RowHandle } from './types.js';

/**
 * The rows of one layer, read without making features
 */
export interface LayerTableView {
  /** The layer */
  readonly layerId: string;
  /** The number of rows (deleted ones included until they are dropped) */
  readonly rowCount: number;
  /**
   * The handles of the rows drawn whose bbox meets a box, in the order of the layer (a hidden
   * row is not drawn)
   */
  listDrawnRows(bounds: BoundingBox): Int32Array;
  /** The bbox of a row (null for a row without a geometry or not in this layer) */
  getRowBounds(handle: RowHandle): BoundingBox | null;
  /** The type of a row (null for a row not in this layer) */
  getRowType(handle: RowHandle): FeatureType | null;
  /** The coordinate of a row whose geometry is a Point (null for any other row) */
  getRowPoint(handle: RowHandle): Coordinate | null;
  /** The value of an attribute of a row (undefined when it does not hold the key) */
  valueAt(handle: RowHandle, key: string): unknown;
  /**
   * A row as a feature: a new object every call, so read the values above for what is read
   * often (undefined for a deleted row or one not in this layer)
   */
  getRow(handle: RowHandle): Feature | undefined;
  /** Changes whenever the rows drawn may have changed (added, hidden, shown) */
  getDrawnRowsRevision(): number;
  /** The handles of `count` rows from the `start`-th one, in the order of the layer */
  rowsInOrder(start: number, count: number): Int32Array;
}

/**
 * The reading side of the features held as rows: what a Store hands out as its `tables`
 */
export interface FeatureTables {
  /** The rows of a layer (undefined for a layer that holds no rows) */
  layer(layerId: string): LayerTableView | undefined;
  /** The handle of the row of an id (undefined for an unknown or deleted row) */
  handleOf(id: string): RowHandle | undefined;
  /** The id of the row of a handle (undefined for an unknown handle) */
  idOf(handle: RowHandle): string | undefined;
}

/**
 * The writing side of the features held as rows: kept by the implementation of the Store only
 */
export interface FeatureTablesWriter {
  /**
   * The handle of the row of each id, given to the ids not seen yet
   *
   * @param hashes The hashes of the ids (`RowGroupData.idHashes`; computed when omitted)
   */
  allocateHandles(ids: Utf8Column, hashes?: Uint32Array): Int32Array;
  /**
   * Takes row groups into a layer, without copying their columns
   *
   * The rows that have no handle yet (-1) get one, the styles of a group built in a Worker are
   * numbered in the table of styles, and every group is put at its place in the order of the
   * layer. The groups are kept as they are: do not change their arrays afterwards.
   *
   * @throws when an id is already a row of the document, when a row names a group of features
   *   that is not known, when the rows of a group are not in the order of their keys, or when
   *   the keys of a group overlap those of another group of the layer
   */
  adopt(layerId: string, groups: readonly RowGroupData[]): void;
}

/**
 * The options of {@link createFeatureTables}
 */
export interface FeatureTablesOptions {
  /** The number of strings read from the columns that are kept (50,000 when omitted) */
  readonly stringCacheSize?: number;
}

/**
 * Creates the tables of the features of a document, as its reading and writing sides
 */
export function createFeatureTables(options: FeatureTablesOptions = {}): {
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

  adopt(layerId: string, groups: readonly RowGroupData[]): void {
    let layer = this.layers.get(layerId);
    if (!layer) {
      layer = new LayerTable(layerId, this.groups);
      this.layers.set(layerId, layer);
    }
    for (const data of groups) this.adoptGroup(layer, data);
  }

  private adoptGroup(layer: LayerTable, data: RowGroupData): void {
    checkShape(data);
    if (data.handles.some((handle) => handle < 0)) {
      data.handles.set(this.ids.allocate(data.ids, data.idHashes));
    }
    for (let r = 0; r < data.length; r++) {
      const handle = data.handles[r];
      if (!this.ids.has(handle)) throw new Error(`FeatureTables: the handle ${handle} is unknown`);
      if (this.ids.mainGroup(handle) >= 0) {
        throw new Error(`FeatureTables: "${this.ids.idOf(handle)}" is already a row`);
      }
      const group = data.groups[r];
      if (group >= 0 && !this.groups.has(group)) {
        throw new Error(`FeatureTables: a row names the group ${group}, which is unknown`);
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

  listDrawnRows(bounds: BoundingBox): Int32Array {
    const out: number[] = [];
    const rows: number[] = [];
    for (let g = 0; g < this.table.groupCount; g++) {
      const group = this.table.groupAt(g);
      rows.length = 0;
      searchPackedRTree(group.data.index, bounds.minX, bounds.minY, bounds.maxX, bounds.maxY, rows);
      rows.sort((a, b) => a - b);
      for (const row of rows) {
        if ((group.state[row] & STATE_HIDDEN_MASK) === 0) out.push(group.data.handles[row]);
      }
    }
    return Int32Array.from(out);
  }

  getRowBounds(handle: RowHandle): BoundingBox | null {
    const at = this.locate(handle);
    if (!at) return null;
    const b = at.group.data.rowBounds;
    const i = at.row * 4;
    if (Number.isNaN(b[i])) return null;
    return { minX: b[i], minY: b[i + 1], maxX: b[i + 2], maxY: b[i + 3] };
  }

  getRowType(handle: RowHandle): FeatureType | null {
    const at = this.locate(handle);
    return at ? rowType(at.group.data, at.row) : null;
  }

  getRowPoint(handle: RowHandle): Coordinate | null {
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
