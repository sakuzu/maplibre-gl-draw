// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The implementation of the features of a document held as rows of columns
 *
 * The reading and writing sides are declared in `api/tables.ts`. Here are the tables
 * themselves: the ids and their handles, the styles, the groups of features, the state of the
 * rows, the row groups of every layer and the rows changed since (the delta of each layer). The
 * drawing and the hit testing read them through `featureTablesInternals`.
 *
 * A row is read from one place: its row in its group, or its copy in the delta of a layer when
 * it has one (the copy in its group is hidden then, `STATE_HIDDEN_DELTA`). A write that fits the
 * columns of its row is written in place; a write that moves the row in the order or to another
 * layer, and a new row, put a copy of the row in the delta.
 */

import type {
  FeatureTables,
  FeatureTablesOptions,
  FeatureTablesWriter,
  ItemRefs,
  LayerRowsChange,
  LayerTableView,
  RowApplyOptions,
  RowCursor,
  RowField,
  RowHandle,
  RowPatch,
  RowsChange,
  TableScanOptions,
} from '../api/tables.js';
import type { BBox } from '../geometry/types.js';
import { drawPropertyKey } from '../shared/properties.js';
import type { Feature, FeatureStyle, FeatureType } from '../shared/types/model.js';
import { createRowGroupBuilder, type RowInput } from '../table/row-group-builder.js';
import { mergeRowGroup } from '../table/row-group-merge.js';
import {
  ROW_FLAG_DELETED,
  ROW_FLAG_LOCKED,
  ROW_FLAG_VISIBLE,
  type RowGroupData,
} from '../table/row-group-types.js';
import { utf8ColumnLength, utf8String } from '../table/utf8-column.js';
import { ValueStringCache } from '../table/value-column.js';
import { GroupTable } from './group-table.js';
import { IdIndex } from './id-index.js';
import { createRowGroup, LayerTable, overrideBytesOf, type RowGroup } from './layer-table.js';
import {
  type RowReadContext,
  rowFeature,
  rowInputOf,
  rowPoint,
  rowType,
  rowValue,
} from './row-read.js';
import {
  RowStateSets,
  STATE_HIDDEN_DELETED,
  STATE_HIDDEN_DELTA,
  STATE_HIDDEN_GROUP,
  STATE_HIDDEN_INVISIBLE,
  STATE_HIDDEN_MASK,
  STATE_HIDDEN_WAIT,
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

/** The attributes the cutting of the rows into chunks reads (a write of one moves the row) */
const CLASSIFY_KEYS: ReadonlySet<string> = new Set([CREATED_ZOOM_KEY]);

/** The fields that place a row in the order of its layer or in another layer */
const PLACE_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'layerId',
  'groupId',
  'order',
  'member',
]);

/** The number of handles a scan reads at a time when not told */
const SCAN_BATCH = 1024;

/** A size no group of rows reaches: the rows of a delta are one group */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

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
 * Where a row is read: its group (a group of a layer, or the group of the delta of a layer) and
 * its row there
 *
 * @internal
 */
export interface RowPlace {
  readonly layer: LayerTable;
  readonly group: RowGroup;
  readonly row: number;
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
  /** Where the row of a handle is read (undefined for a handle of no row) */
  placeOf(handle: RowHandle): RowPlace | undefined;
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
   * into the chunks that draw them (the rows of the delta of a layer name the handle of the
   * delta, `DeltaRows.handle`)
   *
   * @returns The function that stops the calls
   */
  onRowsWritten(listener: (layerId: string, writes: readonly RowWrite[]) => void): () => void;
  /**
   * Calls `listener` when the rows of the delta of a layer came in, left or were made again, so
   * the drawing packs them again before its next frame
   *
   * @returns The function that stops the calls
   */
  onDeltaChanged(listener: (layerId: string) => void): () => void;
  /**
   * Puts rows of groups into the delta of their layer as they are: rows whose change the
   * drawing could not write into their places (more coordinates than the place holds, another
   * kind of run). Their copy in their group is hidden from then on
   */
  toDelta(handles: readonly RowHandle[]): void;
  /**
   * The row groups whose values written in place hold more than `OVERRIDE_BYTES_LIMIT` bytes:
   * they are due for their next version
   */
  readonly groupsDue: ReadonlySet<RowGroupHandle>;
  /** The bytes the values written in place of every row group hold */
  overrideBytes(): number;
  /** The rows moved since their row groups were built, over every layer */
  movedRowCount(): number;
  /** The rows held by the deltas of every layer */
  deltaRowCount(): number;
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

/** A row of a patch that comes into the delta of a layer */
interface DeltaInput {
  readonly handle: RowHandle;
  readonly input: RowInput;
}

/** What a change wrote to the rows of one layer, as it is gathered */
interface LayerChangeDraft {
  readonly created: number[];
  readonly updated: number[];
  readonly deleted: number[];
  readonly fields: Set<RowField>;
  readonly styleKeys: Set<string>;
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
  /** The layers by their serial number */
  private readonly layerList: LayerTable[] = [];
  private readonly views = new Map<string, LayerTableView>();
  private readonly rowGroups = new Map<RowGroupHandle, { layer: LayerTable; group: RowGroup }>();
  private nextGroup = 0;
  private revisionCount = 0;
  /** The number of the last change written (the rows of the delta keep the one they were in) */
  private writeCount = 0;
  /** The row groups given to `adopt` and not taken in yet, in the order they were given */
  private readonly adoptions: Array<{ layer: LayerTable; data: RowGroupData }> = [];
  private readonly workListeners = new Set<() => void>();
  private readonly writeListeners = new Set<
    (layerId: string, writes: readonly RowWrite[]) => void
  >();
  private readonly deltaListeners = new Set<(layerId: string) => void>();
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

  /** The rows of a layer, made when first written */
  private layerOf(layerId: string): LayerTable {
    let layer = this.layers.get(layerId);
    if (!layer) {
      layer = new LayerTable(layerId, this.groups, this.layerList.length, this.nextGroup++);
      this.layers.set(layerId, layer);
      this.layerList.push(layer);
    }
    return layer;
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

  placeOf(handle: RowHandle): RowPlace | undefined {
    const serial = this.ids.deltaLayer(handle);
    if (serial >= 0) {
      const layer = this.layerList[serial];
      const group = layer.delta.group;
      if (group) return { layer, group, row: this.ids.deltaSlot(handle) };
    }
    const placed = this.rowGroups.get(this.ids.mainGroup(handle));
    if (!placed) return undefined;
    return { layer: placed.layer, group: placed.group, row: this.ids.mainRow(handle) };
  }

  handleOf(id: string): RowHandle | undefined {
    const handle = this.ids.handleOf(id);
    if (handle < 0) return undefined;
    const place = this.placeOf(handle);
    if (!place) return undefined;
    return (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0 ? undefined : handle;
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
    const layer = this.layerOf(layerId);
    const wasPending = this.adoptions.length > 0;
    for (const data of groups) this.adoptions.push({ layer, data });
    if (!wasPending && this.adoptions.length > 0) this.notifyWork();
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

  private notifyWork(): void {
    for (const listener of this.workListeners) listener();
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

  deltaRowCount(): number {
    let count = 0;
    for (const layer of this.layers.values()) count += layer.delta.length;
    return count;
  }

  onRowsWritten(listener: (layerId: string, writes: readonly RowWrite[]) => void): () => void {
    this.writeListeners.add(listener);
    return () => {
      this.writeListeners.delete(listener);
    };
  }

  onDeltaChanged(listener: (layerId: string) => void): () => void {
    this.deltaListeners.add(listener);
    return () => {
      this.deltaListeners.delete(listener);
    };
  }

  /** Reads the handles of the rows of layers a batch at a time */
  scan(options: TableScanOptions): RowCursor {
    const layers = (options.layerIds ?? [...this.layers.keys()])
      .map((id) => this.layers.get(id))
      .filter((layer): layer is LayerTable => layer !== undefined);
    const batch = Math.max(1, Math.floor(options.batch ?? SCAN_BATCH));
    const bbox = options.bbox;
    let layerAt = 0;
    let handles: number[] | null = null;
    let at = 0;
    return {
      next: (): Int32Array | null => {
        const out: number[] = [];
        while (out.length < batch && layerAt < layers.length) {
          if (!handles) {
            handles = [];
            const list = handles;
            const layer = layers[layerAt];
            const take = (group: RowGroup, row: number): void => {
              if ((group.data.flags[row] & ROW_FLAG_DELETED) === 0) {
                list.push(group.data.handles[row]);
              }
            };
            if (bbox) {
              layer.searchInOrder(bbox[0], bbox[1], bbox[2], bbox[3], take);
            } else {
              const order = layer.rowOrder();
              for (let i = 0; i < order.handles.length; i++) take(order.groups[i], order.rows[i]);
            }
            at = 0;
          }
          while (out.length < batch && at < handles.length) out.push(handles[at++]);
          if (at >= handles.length) {
            layerAt++;
            handles = null;
          }
        }
        return out.length > 0 ? Int32Array.from(out) : null;
      },
    };
  }

  /** Puts rows of groups into the delta of their layer as they are */
  toDelta(handles: readonly RowHandle[]): void {
    const inputs = new Map<LayerTable, DeltaInput[]>();
    for (const handle of handles) {
      if (this.ids.deltaLayer(handle) >= 0) continue;
      const placed = this.rowGroups.get(this.ids.mainGroup(handle));
      if (!placed) continue;
      const input = rowInputOf(this.readContext, placed.group, this.ids.mainRow(handle));
      let list = inputs.get(placed.layer);
      if (!list) {
        list = [];
        inputs.set(placed.layer, list);
      }
      list.push({ handle, input });
    }
    if (inputs.size === 0) return;
    const number = ++this.writeCount;
    for (const [layer, list] of inputs) this.rebuildDelta(layer, new Set(), list, number);
    for (const list of inputs.values()) {
      for (const { handle } of list) this.refreshCopies(handle);
    }
    this.revisionCount++;
  }

  /**
   * Writes values of rows (see `FeatureTablesWriter.apply`): every value is checked before
   * anything is written; then the rows are written in place, and the rows placed elsewhere and
   * the new ones are put in the delta of their layer, and the drawing is told
   */
  apply(patch: RowPatch, _options: RowApplyOptions = {}): RowsChange {
    const { handles, fields, deleted } = patch;
    const n = handles.length;
    // The checks
    for (const [field, values] of fields) {
      if (values.length !== n) {
        throw new Error(`FeatureTables: "${field}" has ${values.length} values for ${n} rows`);
      }
    }
    if (deleted && deleted.length !== n) {
      throw new Error('FeatureTables: deleted has another length than the rows');
    }
    const geometries = fields.get('geometry');
    geometries?.forEach((geometry, i) => {
      if (geometry === undefined) return;
      if (!geometry || typeof geometry !== 'object' || !('type' in geometry)) {
        throw new Error(`FeatureTables: the geometry of the row ${handles[i]} is not a geometry`);
      }
    });
    const types = fields.get('type');
    const layerIds = fields.get('layerId');
    const orders = fields.get('order');
    const members = fields.get('member');
    const groupIds = fields.get('groupId');
    const groupHandles = groupIds?.map((id, i) => {
      if (id === undefined || id === null || id === '') return -1;
      if (typeof id !== 'string') {
        throw new Error(`FeatureTables: the group of the row ${handles[i]} is not an id`);
      }
      const group = this.groups.handleOfId(id);
      if (group < 0) throw new Error(`FeatureTables: the group "${id}" is unknown`);
      return group;
    });
    const strings: Array<[string, readonly unknown[] | undefined, boolean]> = [
      ['type', types, false],
      ['layerId', layerIds, false],
      ['order', orders, false],
      ['member', members, true],
    ];
    for (const [name, values, optional] of strings) {
      values?.forEach((value, i) => {
        if (
          typeof value === 'string' ||
          (value === undefined && (optional || !!this.placeOf(handles[i])))
        ) {
          return;
        }
        throw new Error(`FeatureTables: the ${name} of the row ${handles[i]} is not a string`);
      });
    }
    const places = Array.from(handles, (handle) => this.placeOf(handle));
    places.forEach((place, i) => {
      if (place) return;
      if (!this.ids.has(handles[i])) {
        throw new Error(`FeatureTables: no row has the handle ${handles[i]}`);
      }
      // A new row: what a feature cannot be without
      const missing = [
        ['type', types?.[i]],
        ['layerId', layerIds?.[i]],
        ['geometry', geometries?.[i]],
        ['order', orders?.[i]],
      ].filter(([, value]) => value === undefined);
      if (missing.length > 0) {
        throw new Error(
          `FeatureTables: no row has the handle ${handles[i]}, and a new row needs ${missing
            .map(([name]) => name)
            .join(', ')}`,
        );
      }
    });
    // The values are made what the columns hold before anything is written
    const styles = fields.get('style');
    const styleNumbers = styles?.map((style) => this.styles.intern((style ?? {}) as FeatureStyle));

    const number = ++this.writeCount;
    const writes = new Map<string, RowWrite[]>();
    const touched = new Set<RowGroup>();
    const moving = new Map<LayerTable, DeltaInput[]>();
    const leaving = new Map<LayerTable, Set<RowHandle>>();
    const changes = new Map<string, LayerChangeDraft>();
    let stateChanged = false;
    let created = false;

    for (let i = 0; i < n; i++) {
      const handle = handles[i];
      const place = places[i];
      const placed = place ? this.placeChanged(place, i, fields, groupHandles) : true;
      const targetLayer = (layerIds?.[i] as string | undefined) ?? place?.layer.layerId;
      const change = draftOf(changes, targetLayer as string);
      for (const field of fields.keys()) change.fields.add(field);
      if (styles && place) {
        const before = this.styles.get(place.group.data.styles[place.row]);
        for (const key of changedKeys(before, (styles[i] ?? {}) as FeatureStyle)) {
          change.styleKeys.add(key);
        }
      }
      if (!place) change.created.push(handle);
      else if (deleted?.[i] && (place.group.data.flags[place.row] & ROW_FLAG_DELETED) === 0) {
        change.deleted.push(handle);
      } else change.updated.push(handle);

      if (!placed && place) {
        // Written in place
        const write = this.writeInPlace(place, i, fields, deleted, styleNumbers);
        if (!write) continue;
        if (write.what & (ROW_WRITE_GEOMETRY | ROW_WRITE_STATE)) stateChanged = true;
        touched.add(place.group);
        if (place.group.delta) place.layer.delta.setWritten(place.row, number);
        let list = writes.get(place.layer.layerId);
        if (!list) {
          list = [];
          writes.set(place.layer.layerId, list);
        }
        list.push(write);
        continue;
      }
      // Placed elsewhere, or new: a copy in the delta of its layer
      const input = this.patchedInput(handle, place, i, fields, deleted, groupHandles);
      const layer = this.layerOf(targetLayer as string);
      let list = moving.get(layer);
      if (!list) {
        list = [];
        moving.set(layer, list);
      }
      list.push({ handle, input });
      if (place?.group.delta) {
        let set = leaving.get(place.layer);
        if (!set) {
          set = new Set();
          leaving.set(place.layer, set);
        }
        set.add(handle);
      }
      if (!place) created = true;
    }

    // A style interned for a row that kept its own is not held by any row
    if (styleNumbers) {
      for (const style of styleNumbers) {
        if (this.styles.usesOf(style) === 0) this.styles.release(style);
      }
    }
    for (const group of touched) {
      if (!group.delta && overrideBytesOf(group) > OVERRIDE_BYTES_LIMIT) {
        this.groupsDue.add(group.handle);
      }
    }
    // The deltas
    const layers = new Set<LayerTable>([...moving.keys(), ...leaving.keys()]);
    for (const layer of layers) {
      this.rebuildDelta(layer, leaving.get(layer) ?? new Set(), moving.get(layer) ?? [], number);
    }
    for (const list of moving.values()) {
      for (const { handle } of list) this.refreshCopies(handle);
    }
    if (stateChanged || layers.size > 0 || created) this.revisionCount++;
    for (const [layerId, list] of writes) {
      for (const listener of this.writeListeners) listener(layerId, list);
    }
    return { layers: finishChanges(changes) };
  }

  /**
   * Whether a patch places a row elsewhere (another key, group, layer or type, or an attribute
   * the cutting of the rows reads): it then goes to the delta rather than being written in place
   */
  private placeChanged(
    place: RowPlace,
    i: number,
    fields: ReadonlyMap<RowField, readonly unknown[]>,
    groupHandles: number[] | undefined,
  ): boolean {
    const data = place.group.data;
    const row = place.row;
    for (const [field, values] of fields) {
      const value = values[i];
      if (PLACE_FIELDS.has(field)) {
        if (value === undefined && field !== 'member' && field !== 'groupId') continue;
        switch (field) {
          case 'type':
            if (value !== rowType(data, row)) return true;
            break;
          case 'layerId':
            if (value !== place.layer.layerId) return true;
            break;
          case 'order':
            if (value !== utf8String(data.itemKeys, row)) return true;
            break;
          case 'member':
            if ((value ?? '') !== utf8String(data.memberKeys, row)) return true;
            break;
          case 'groupId':
            if ((groupHandles as number[])[i] !== data.groups[row]) return true;
            break;
        }
        continue;
      }
      if (field.startsWith('property:') && CLASSIFY_KEYS.has(field.slice('property:'.length))) {
        if (rowValue(place.group, row, field.slice('property:'.length)) !== value) return true;
      }
    }
    return false;
  }

  /** The values of a row with a patch written over them, as the builder takes them */
  private patchedInput(
    handle: RowHandle,
    place: RowPlace | undefined,
    i: number,
    fields: ReadonlyMap<RowField, readonly unknown[]>,
    deleted: Uint8Array | undefined,
    groupHandles: number[] | undefined,
  ): RowInput {
    const base: RowInput = place
      ? rowInputOf(this.readContext, place.group, place.row)
      : { id: this.ids.idOf(handle) ?? '', type: 'Point', geometry: null, order: '' };
    const out: {
      -readonly [K in keyof RowInput]: RowInput[K];
    } = { ...base, properties: { ...(base.properties ?? {}) } };
    for (const [field, values] of fields) {
      const value = values[i];
      switch (field) {
        case 'type':
          if (value !== undefined) out.type = value as string;
          break;
        case 'geometry':
          if (value !== undefined) out.geometry = value as RowInput['geometry'];
          break;
        case 'order':
          if (value !== undefined) out.order = value as string;
          break;
        case 'member':
          out.member = value as string | undefined;
          break;
        case 'groupId':
          out.group = (groupHandles as number[])[i];
          break;
        case 'style':
          out.style = (value ?? {}) as Readonly<Record<string, unknown>>;
          break;
        case 'visible':
          if (value !== undefined) out.visible = value !== false;
          break;
        case 'locked':
          if (value !== undefined) out.locked = value === true;
          break;
        case 'layerId':
          break;
        default: {
          const key = field.slice('property:'.length);
          const properties = out.properties as Record<string, unknown>;
          if (value === undefined) delete properties[key];
          else properties[key] = value;
        }
      }
    }
    if (deleted?.[i]) out.deleted = true;
    if (out.group === undefined || out.group < 0) out.member = undefined;
    return out;
  }

  /**
   * Writes the values of a row in place
   *
   * @returns What was written, as the drawing is told (null when nothing changed)
   */
  private writeInPlace(
    place: RowPlace,
    i: number,
    fields: ReadonlyMap<RowField, readonly unknown[]>,
    deleted: Uint8Array | undefined,
    styleNumbers: number[] | undefined,
  ): RowWrite | null {
    const { layer, group, row } = place;
    const data = group.data;
    let what = 0;
    let shape: GeometryWrite = { sameShape: true, from: 0, to: 0 };
    const keys: string[] = [];
    const geometry = fields.get('geometry')?.[i];
    if (geometry !== undefined) {
      shape = writeRowGeometry(layer, group, row, geometry as never);
      what |= ROW_WRITE_GEOMETRY;
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
    const visible = fields.get('visible')?.[i];
    if (visible !== undefined) {
      flags = visible === false ? flags & ~ROW_FLAG_VISIBLE : flags | ROW_FLAG_VISIBLE;
    }
    const locked = fields.get('locked')?.[i];
    if (locked !== undefined) {
      flags = locked === true ? flags | ROW_FLAG_LOCKED : flags & ~ROW_FLAG_LOCKED;
    }
    if (deleted && deleted[i] !== 0) flags |= ROW_FLAG_DELETED;
    if (flags !== data.flags[row]) {
      if ((flags & ROW_FLAG_DELETED) !== (data.flags[row] & ROW_FLAG_DELETED)) layer.touchItems();
      data.flags[row] = flags;
      this.writeState(group, row);
      group.stateVersion++;
      what |= ROW_WRITE_STATE;
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
      }
    }
    if (what === 0) return null;
    return {
      group: group.handle,
      row,
      what,
      sameShape: shape.sameShape,
      from: shape.from,
      to: shape.to,
      keys,
    };
  }

  /**
   * Makes the rows of the delta of a layer again: its rows but the ones leaving it, and the rows
   * coming into it (written in the change `number`). A row of the delta written in place is
   * built again with its values, so the new rows hold no values written in place
   */
  private rebuildDelta(
    layer: LayerTable,
    leaving: ReadonlySet<RowHandle>,
    coming: readonly DeltaInput[],
    number: number,
  ): void {
    const delta = layer.delta;
    const old = delta.group;
    const sources: RowGroupData[] = [];
    const pairs: number[] = [];
    const writtenOf = new Map<RowHandle, number>();
    const inputs: RowInput[] = [];
    const comingHandles = new Set(coming.map((entry) => entry.handle));
    if (old) {
      sources.push(old.data);
      for (let r = 0; r < old.data.length; r++) {
        const handle = old.data.handles[r];
        if (leaving.has(handle) || comingHandles.has(handle)) continue;
        writtenOf.set(handle, delta.writtenOf(r));
        if (old.values?.has(r) || old.geometries?.geometry(r) || old.geometries?.rowTriangles(r)) {
          inputs.push(rowInputOf(this.readContext, old, r));
        } else {
          pairs.push(0, r);
        }
      }
    }
    for (const entry of coming) {
      inputs.push(entry.input);
      writtenOf.set(entry.handle, number);
    }
    if (inputs.length > 0) {
      const built = this.buildRows(inputs);
      if (built) {
        sources.push(built);
        for (let r = 0; r < built.length; r++) pairs.push(sources.length - 1, r);
      }
    }
    const merged = mergeRowGroup({
      sources,
      rows: Int32Array.from(pairs),
      groups: this.groups,
      targetRows: UNBOUNDED,
      targetVertices: UNBOUNDED,
    });
    const group = merged.length > 0 ? createRowGroup(delta.handle, merged[0], true) : null;
    const written = new Float64Array(group?.data.length ?? 0);
    if (group) {
      for (let r = 0; r < group.data.length; r++) {
        written[r] = writtenOf.get(group.data.handles[r]) ?? number;
        this.styles.retain(group.data.styles[r]);
      }
    }
    if (old) {
      for (let r = 0; r < old.data.length; r++) {
        const handle = old.data.handles[r];
        this.styles.release(old.data.styles[r]);
        if (this.ids.deltaLayer(handle) === layer.serial) this.ids.setDelta(handle, -1, -1);
      }
      layer.dropMoved(old);
    }
    if (group) {
      for (let r = 0; r < group.data.length; r++) {
        this.ids.setDelta(group.data.handles[r], layer.serial, r);
      }
      for (let r = 0; r < group.data.length; r++) this.writeState(group, r);
    }
    delta.rebuild(group, written);
    layer.touchItems();
    // The copies the rows leaving the delta had in their groups are read again
    for (const handle of leaving) {
      if (this.ids.deltaLayer(handle) < 0) this.refreshCopies(handle);
    }
    for (const listener of this.deltaListeners) listener(layer.layerId);
  }

  /** Builds rows into one row group, numbered and with their handles (null for no row) */
  private buildRows(inputs: readonly RowInput[]): RowGroupData | null {
    const builder = createRowGroupBuilder({
      groups: this.groups.keyList(),
      targetRows: UNBOUNDED,
      targetVertices: UNBOUNDED,
    });
    for (const input of inputs) builder.addRow(input);
    const [data] = builder.finish();
    if (!data) return null;
    this.numberStyles(data);
    data.handles.set(this.ids.allocate(data.ids, data.idHashes));
    return data;
  }

  /** Gives the styles of a group built in a Worker the numbers of the table of styles */
  private numberStyles(data: RowGroupData): void {
    const dictionary = data.styleDictionary;
    if (!dictionary) return;
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

  /** Takes in one row group: the handles, the numbers of its styles, the state of its rows */
  private adoptGroup(layer: LayerTable, data: RowGroupData): void {
    if (data.handles.some((handle) => handle < 0)) {
      data.handles.set(this.ids.allocate(data.ids, data.idHashes));
    }
    for (let r = 0; r < data.length; r++) {
      const handle = data.handles[r];
      if (!this.ids.has(handle)) throw new Error(`FeatureTables: the handle ${handle} is unknown`);
      if (this.ids.mainGroup(handle) >= 0 || this.ids.deltaLayer(handle) >= 0) {
        throw new Error(`FeatureTables: "${this.ids.idOf(handle)}" is already a row`);
      }
    }
    // The styles of a group built in a Worker get the numbers of the table of styles
    this.numberStyles(data);
    for (let r = 0; r < data.length; r++) {
      if (!this.styles.has(data.styles[r])) {
        throw new Error(`FeatureTables: a row names the style ${data.styles[r]}, which is unknown`);
      }
    }
    const group = createRowGroup(this.nextGroup++, data);
    layer.insert(group);
    // The rows that use each style are counted (a style no row uses is given again)
    for (let r = 0; r < data.length; r++) this.styles.retain(data.styles[r]);
    this.rowGroups.set(group.handle, { layer, group });
    for (let r = 0; r < data.length; r++) {
      const handle = data.handles[r];
      this.ids.setMain(handle, group.handle, r);
      this.ids.rehome(handle, data.ids, r);
    }
    for (let r = 0; r < data.length; r++) this.writeState(group, r);
    this.revisionCount++;
  }

  /** Makes the copy of the state of a row again */
  private writeState(group: RowGroup, row: number): void {
    const data = group.data;
    const handle = data.handles[row];
    const flags = data.flags[row];
    let state = this.states.stateOf(handle);
    if ((flags & ROW_FLAG_VISIBLE) === 0) state |= STATE_HIDDEN_INVISIBLE;
    if ((flags & ROW_FLAG_DELETED) !== 0) state |= STATE_HIDDEN_DELETED;
    const featureGroup = data.groups[row];
    if (featureGroup >= 0 && !this.groups.isVisible(featureGroup)) state |= STATE_HIDDEN_GROUP;
    if (rowType(data, row) === 'Circle') state |= STATE_UNIFORM;
    if (!group.delta) {
      // The copy of a row read elsewhere: in the delta, or in another group until it is in this
      if (this.ids.deltaLayer(handle) >= 0) state |= STATE_HIDDEN_DELTA;
      if (this.ids.mainGroup(handle) !== group.handle) state |= STATE_HIDDEN_WAIT;
    }
    group.state[row] = state;
    group.gpuState[row] = toGpuState(state);
  }

  /** Makes the copies of the state of the row of a handle again (in its group and its delta) */
  private refreshCopies(handle: RowHandle): void {
    const placed = this.rowGroups.get(this.ids.mainGroup(handle));
    if (placed) {
      this.writeState(placed.group, this.ids.mainRow(handle));
      placed.group.stateVersion++;
      placed.layer.touchItems();
    }
    const serial = this.ids.deltaLayer(handle);
    const delta = serial >= 0 ? this.layerList[serial].delta.group : null;
    if (delta) {
      this.writeState(delta, this.ids.deltaSlot(handle));
      delta.stateVersion++;
    }
  }

  /** Makes the copies of the rows whose state changed again */
  private refreshStates(handles: Int32Array): void {
    for (const handle of handles) {
      const placed = this.rowGroups.get(this.ids.mainGroup(handle));
      if (placed) {
        this.writeState(placed.group, this.ids.mainRow(handle));
        placed.group.stateVersion++;
      }
      const serial = this.ids.deltaLayer(handle);
      const delta = serial >= 0 ? this.layerList[serial].delta.group : null;
      if (delta) {
        this.writeState(delta, this.ids.deltaSlot(handle));
        delta.stateVersion++;
      }
    }
    this.revisionCount++;
  }
}

/** The draft of the change of a layer */
function draftOf(changes: Map<string, LayerChangeDraft>, layerId: string): LayerChangeDraft {
  let draft = changes.get(layerId);
  if (!draft) {
    draft = {
      created: [],
      updated: [],
      deleted: [],
      fields: new Set(),
      styleKeys: new Set(),
    };
    changes.set(layerId, draft);
  }
  return draft;
}

/** The changes of the layers, as the writer returns them */
function finishChanges(changes: Map<string, LayerChangeDraft>): Map<string, LayerRowsChange> {
  const out = new Map<string, LayerRowsChange>();
  for (const [layerId, draft] of changes) {
    out.set(layerId, {
      created: Int32Array.from(draft.created),
      updated: Int32Array.from(draft.updated),
      deleted: Int32Array.from(draft.deleted),
      fields: draft.fields,
      styleKeys: draft.styleKeys,
    });
  }
  return out;
}

/** The keys whose values differ between two styles */
function changedKeys(a: FeatureStyle, b: FeatureStyle): string[] {
  const out: string[] = [];
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) out.push(key);
  }
  return out;
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
    this.table.searchInOrder(bbox[0], bbox[1], bbox[2], bbox[3], (group, row) => {
      if ((group.state[row] & STATE_HIDDEN_MASK) === 0) out.push(group.data.handles[row]);
    });
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
    const handles = this.table.rowOrder().handles;
    const from = Math.max(0, Math.min(start, handles.length));
    return handles.slice(from, Math.max(from, Math.min(handles.length, from + Math.max(0, count))));
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

  /** The group and row a handle is read from, when its row is in this layer */
  private locate(handle: RowHandle): { group: RowGroup; row: number } | null {
    const place = this.store.placeOf(handle);
    if (!place || place.layer !== this.table) return null;
    return { group: place.group, row: place.row };
  }
}
