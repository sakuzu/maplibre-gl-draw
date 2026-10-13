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
  ItemRefs,
  LayerTableView,
  RowApplyOptions,
  RowCursor,
  RowHandle,
  RowPatch,
  TableScanOptions,
} from '../api/tables.js';
import type { BBox } from '../geometry/types.js';
import { drawPropertyKey } from '../shared/properties.js';
import type { Feature, FeatureStyle, FeatureType } from '../shared/types/model.js';
import {
  ROW_FLAG_DELETED,
  ROW_FLAG_LOCKED,
  ROW_FLAG_VISIBLE,
  type RowGroupData,
} from '../table/row-group-types.js';
import { utf8ColumnLength } from '../table/utf8-column.js';
import { ValueStringCache } from '../table/value-column.js';
import { GroupTable } from './group-table.js';
import { IdIndex } from './id-index.js';
import { createRowGroup, LayerTable, overrideBytesOf, type RowGroup } from './layer-table.js';
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
import {
  type GeometryWrite,
  isRadiusKey,
  refreshRowShape,
  writeRowGeometry,
  writeRowValue,
} from './row-write.js';
import { StyleTable } from './style-table.js';
import {
  ROW_WRITE_GEOMETRY,
  ROW_WRITE_STATE,
  ROW_WRITE_STYLE,
  ROW_WRITE_VALUES,
  type RowGroupHandle,
  type RowWrite,
  type TableWorkBudget,
} from './types.js';
import { OVERRIDE_BYTES_LIMIT } from './value-overrides.js';

/** The key of the created zoom: the cutting of the rows into chunks reads it */
const CREATED_ZOOM_KEY = drawPropertyKey('createdZoom');

/** The fields of a row that are not written in place yet (they move the row in the order) */
const FIELDS_NOT_IN_PLACE = new Set(['type', 'layerId', 'groupId', 'order', 'member']);

/** The number of handles a scan reads at a time when not told */
const SCAN_BATCH = 1024;

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
    scan: (options) => store.scan(options ?? {}),
  };
  const writer: FeatureTablesWriter = {
    allocateHandles: (ids, hashes) => store.ids.allocate(ids, hashes),
    adopt: (layerId, groups) => store.adopt(layerId, groups),
    apply: (patch, options) => store.apply(patch, options),
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
  /**
   * Calls `listener` with the rows of a layer written in place, so the drawing writes them
   * into the chunks that draw them
   *
   * @returns The function that stops the calls
   */
  onRowsWritten(listener: (layerId: string, writes: readonly RowWrite[]) => void): () => void;
  /**
   * The row groups whose values written in place hold more than `OVERRIDE_BYTES_LIMIT` bytes:
   * they are due for their next version
   */
  readonly groupsDue: ReadonlySet<RowGroupHandle>;
  /** The bytes the values written in place of every row group hold */
  overrideBytes(): number;
  /** The rows moved since their row groups were built, over every layer */
  movedRowCount(): number;
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
  private readonly writeListeners = new Set<
    (layerId: string, writes: readonly RowWrite[]) => void
  >();
  readonly groupsDue = new Set<RowGroupHandle>();

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

  overrideBytes(): number {
    let bytes = 0;
    for (const { group } of this.rowGroups.values()) bytes += overrideBytesOf(group);
    return bytes;
  }

  movedRowCount(): number {
    let count = 0;
    for (const layer of this.layers.values()) count += layer.movedRowCount;
    return count;
  }

  onRowsWritten(listener: (layerId: string, writes: readonly RowWrite[]) => void): () => void {
    this.writeListeners.add(listener);
    return () => {
      this.writeListeners.delete(listener);
    };
  }

  /** Reads the handles of the rows of layers a batch at a time */
  scan(options: TableScanOptions): RowCursor {
    const layers = (options.layerIds ?? [...this.layers.keys()])
      .map((id) => this.layers.get(id))
      .filter((layer): layer is LayerTable => layer !== undefined);
    const batch = Math.max(1, Math.floor(options.batch ?? SCAN_BATCH));
    const bbox = options.bbox;
    const ordered = options.order !== 'any';
    let layerAt = 0;
    let groupAt = 0;
    let rows: number[] | null = null;
    let rowAt = 0;
    const found: number[] = [];
    return {
      next: (): Int32Array | null => {
        const out: number[] = [];
        while (out.length < batch && layerAt < layers.length) {
          const layer = layers[layerAt];
          if (groupAt >= layer.groupCount) {
            layerAt++;
            groupAt = 0;
            rows = null;
            continue;
          }
          const group = layer.groupAt(groupAt);
          if (!rows) {
            if (bbox) {
              found.length = 0;
              layer.searchRows(group, bbox[0], bbox[1], bbox[2], bbox[3], found);
              if (ordered) found.sort((a, b) => a - b);
              rows = found;
            } else {
              rows = [];
            }
            rowAt = 0;
          }
          const length = bbox ? rows.length : group.data.length;
          while (out.length < batch && rowAt < length) {
            const row = bbox ? rows[rowAt] : rowAt;
            rowAt++;
            if ((group.data.flags[row] & ROW_FLAG_DELETED) !== 0) continue;
            out.push(group.data.handles[row]);
          }
          if (rowAt >= length) {
            groupAt++;
            rows = null;
          }
        }
        return out.length > 0 ? Int32Array.from(out) : null;
      },
    };
  }

  /**
   * Writes values of rows in place (see `FeatureTablesWriter.apply`): every value is checked
   * before anything is written, then the rows are written and the drawing is told
   */
  apply(patch: RowPatch, _options: RowApplyOptions = {}): void {
    const { handles, fields, deleted } = patch;
    // The checks: what is not written in place yet, and rows that are not in the tables
    for (const [field, values] of fields) {
      if (FIELDS_NOT_IN_PLACE.has(field)) {
        throw new Error(`FeatureTables: the field "${field}" is not written in place yet`);
      }
      if (field === `property:${CREATED_ZOOM_KEY}`) {
        throw new Error(
          `FeatureTables: the attribute "${CREATED_ZOOM_KEY}" is not written in place yet`,
        );
      }
      if (values.length !== handles.length) {
        throw new Error(
          `FeatureTables: "${field}" has ${values.length} values for ${handles.length} rows`,
        );
      }
    }
    if (deleted && deleted.length !== handles.length) {
      throw new Error('FeatureTables: deleted has another length than the rows');
    }
    const places: Array<{ layer: LayerTable; group: RowGroup; row: number }> = [];
    for (const handle of handles) {
      const placed = this.rowGroups.get(this.ids.mainGroup(handle));
      if (!placed) {
        throw new Error(
          `FeatureTables: no row has the handle ${handle} (new rows are not written in place yet)`,
        );
      }
      places.push({ layer: placed.layer, group: placed.group, row: this.ids.mainRow(handle) });
    }
    // The values are made what the columns hold before anything is written
    const styles = fields.get('style');
    const styleNumbers = styles?.map((style) => this.styles.intern((style ?? {}) as FeatureStyle));
    const geometries = fields.get('geometry');
    geometries?.forEach((geometry, i) => {
      if (!geometry || typeof geometry !== 'object' || !('type' in geometry)) {
        throw new Error(`FeatureTables: the geometry of the row ${handles[i]} is not a geometry`);
      }
    });

    const writes = new Map<string, RowWrite[]>();
    const touched = new Set<RowGroup>();
    let stateChanged = false;
    places.forEach(({ layer, group, row }, i) => {
      const data = group.data;
      let what = 0;
      let shape: GeometryWrite = { sameShape: true, from: 0, to: 0 };
      const keys: string[] = [];
      if (geometries) {
        shape = writeRowGeometry(layer, group, row, geometries[i] as never);
        what |= ROW_WRITE_GEOMETRY;
        stateChanged = true;
      }
      if (styleNumbers) {
        const next = styleNumbers[i];
        const old = data.styles[row];
        if (next !== old) {
          this.styles.retain(next);
          this.styles.release(old);
          data.styles[row] = next;
          what |= ROW_WRITE_STYLE;
        }
      }
      let flags = data.flags[row];
      const visible = fields.get('visible');
      if (visible)
        flags = visible[i] === false ? flags & ~ROW_FLAG_VISIBLE : flags | ROW_FLAG_VISIBLE;
      const locked = fields.get('locked');
      if (locked) flags = locked[i] === true ? flags | ROW_FLAG_LOCKED : flags & ~ROW_FLAG_LOCKED;
      if (deleted && deleted[i] !== 0) flags |= ROW_FLAG_DELETED;
      if (flags !== data.flags[row]) {
        if ((flags & ROW_FLAG_DELETED) !== (data.flags[row] & ROW_FLAG_DELETED)) layer.touchItems();
        data.flags[row] = flags;
        this.writeState(group, row);
        group.stateVersion++;
        what |= ROW_WRITE_STATE;
        stateChanged = true;
      }
      for (const [field, values] of fields) {
        if (!field.startsWith('property:')) continue;
        const key = field.slice('property:'.length);
        if (!writeRowValue(group, row, key, values[i])) continue;
        what |= ROW_WRITE_VALUES;
        keys.push(key);
        if (isRadiusKey(group, row, key)) {
          // The ring of a Circle follows its radius
          const ring = refreshRowShape(layer, group, row);
          shape = { sameShape: ring.sameTriangles, from: 0, to: ring.ring };
          what |= ROW_WRITE_GEOMETRY;
          stateChanged = true;
        }
      }
      if (what === 0) return;
      touched.add(group);
      let list = writes.get(layer.layerId);
      if (!list) {
        list = [];
        writes.set(layer.layerId, list);
      }
      list.push({
        group: group.handle,
        row,
        what,
        sameShape: shape.sameShape,
        from: shape.from,
        to: shape.to,
        keys,
      });
    });
    // A style interned for a row that kept its own is not held by any row
    if (styleNumbers) {
      for (const number of styleNumbers) {
        if (this.styles.usesOf(number) === 0) this.styles.release(number);
      }
    }
    for (const group of touched) {
      if (overrideBytesOf(group) > OVERRIDE_BYTES_LIMIT) this.groupsDue.add(group.handle);
    }
    if (stateChanged) this.revisionCount++;
    for (const [layerId, list] of writes) {
      for (const listener of this.writeListeners) listener(layerId, list);
    }
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
    for (let r = 0; r < data.length; r++) {
      if (!this.styles.has(data.styles[r])) {
        throw new Error(`FeatureTables: a row names the style ${data.styles[r]}, which is unknown`);
      }
    }
    // The rows that use each style are counted (a style no row uses is given again)
    for (let r = 0; r < data.length; r++) this.styles.retain(data.styles[r]);

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

  get itemCount(): number {
    return this.table.itemsOf().kinds.length;
  }

  itemsInOrder(start: number, count: number): ItemRefs {
    const items = this.table.itemsOf();
    const from = Math.max(0, Math.min(start, items.kinds.length));
    const to = Math.max(from, Math.min(items.kinds.length, from + Math.max(0, count)));
    return { kinds: items.kinds.slice(from, to), handles: items.handles.slice(from, to) };
  }

  groupMemberCount(group: number): number {
    return this.table.itemsOf().members.get(group)?.length ?? 0;
  }

  groupMembersInOrder(group: number, start: number, count: number): Int32Array {
    const members = this.table.itemsOf().members.get(group);
    if (!members) return new Int32Array(0);
    const from = Math.max(0, Math.min(start, members.length));
    return members.slice(from, Math.max(from, Math.min(members.length, from + Math.max(0, count))));
  }

  /** The group and row of a handle, when its row is in this layer */
  private locate(handle: RowHandle): { group: RowGroup; row: number } | null {
    const placed = this.store.rowGroup(this.store.ids.mainGroup(handle));
    if (!placed || placed.layer !== this.table) return null;
    return { group: placed.group, row: this.store.ids.mainRow(handle) };
  }
}
