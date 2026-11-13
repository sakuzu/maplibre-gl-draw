// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tables of the features of a document held as rows of columns
 *
 * The reading and writing sides are declared in `api/tables.ts`. The tables themselves are those
 * of `tables-store.ts` (`TablesStore`); here is what the library makes of their rows: the
 * features of the reading side (`FeatureTables`, `LayerTableView`), the state of the rows of the
 * library (`RowStateSets`), the boxes of the types whose rows are not boxed by their points, and
 * the sketches drawn over the rows. The drawing and the hit testing read them through
 * `featureTablesInternals`.
 */

import type {
  GroupRef,
  ScheduleIdleWork,
  RowValues as TablesRowValues,
  TableScanOptions as TablesScanOptions,
  TablesWrite,
  TablesWriter,
} from '@sakuzu/kasane';
import { KasaneError, type TablesOptions } from '@sakuzu/kasane';
import type { RowGroup, RowTable } from '@sakuzu/kasane/render';
import {
  type DeltaInput,
  type Pages,
  ROW_FLAG_DELETED,
  type RowPlace,
  RowTableView,
  TablesStore,
} from '@sakuzu/kasane/render';
import { byteColumnFromStrings, utf8String } from '@sakuzu/tabane';
import type { Geometry, Position } from 'geojson';
import type {
  FeatureTables,
  FeatureTablesOptions,
  ItemHandles,
  LayerTableView,
  RowField,
  RowRef,
  TableScanOptions,
} from '../api/tables.js';
import type { BBox } from '../geometry/types.js';
import type { Feature, FeatureStyle, FeatureType, RowValues } from '../shared/types/model.js';
import { drawErrorOf } from '../table/draw-error-of.js';
import {
  type FeatureRowInput,
  rowInputOfFeature,
  shapeOfGeometry,
} from '../table/feature-row-blocks.js';
import {
  PROPERTY_FIELD,
  ROW_FLAG_HIDDEN,
  ROW_FLAG_LOCKED,
  styleColumnOf,
} from '../table/feature-row-columns.js';
import { fieldsToRead, rowValuesOfTables } from '../table/tables-values.js';
import { FeatureCache } from './feature-cache.js';
import { featureFields } from './feature-fields.js';
import { RowStateSets, STATE_HIDDEN_SKETCH } from './feature-row-states.js';
import { rowGeometry, rowInputOf, rowPoint, rowType, rowValue } from './row-read.js';
import type { TableSelection } from './selection.js';

/**
 * The options of the tables, with the ones core keeps to itself (the tests and the measurements
 * set them)
 *
 * @internal
 */
export interface FeatureTablesInternalOptions extends FeatureTablesOptions {
  /** The number of strings read from the columns that are kept (50,000 when omitted) */
  readonly stringCacheSize?: number;
  /**
   * When the tables run their work, a slice at a time: the build of the index of the boxes of the
   * rows (none: it is left to the first search). The tables of the library run it while the page
   * is idle when omitted (`requestIdleCallback`, or a timer); a test runs the slices itself
   */
  readonly scheduleIdleWork?: ScheduleIdleWork;
}

/**
 * The box of the rows of a value of the type of the rows, from a row read as a feature, or
 * undefined for a type whose rows take the box of their points. The tables ask it once per type
 * until they are told to read the boxes again (`refreshBoxes`); a box that is not finite is no box
 *
 * @internal
 */
export type RowBoxes = (type: string) => ((feature: Feature) => BBox) | undefined;

/**
 * The options of the tables (`createTables`): those of core, and what the user of the tables
 * declares of its rows
 *
 * @internal
 */
export interface TablesInternalOptions
  extends Omit<FeatureTablesInternalOptions, 'worker'>,
    TablesOptions {
  /**
   * The boxes of the rows whose boxes come from more than their points (none: every row takes
   * the box of its points)
   */
  readonly rowBoxes?: RowBoxes;
}

/**
 * Creates the tables of the features of a document, as their reading side and the writer of the
 * tables, which returns what it wrote and tells nobody (`TablesWriter`)
 *
 * @internal
 */
export function createTables(options: TablesInternalOptions): {
  tables: FeatureTables;
  writer: TablesWriter;
} {
  const store = new FeatureTablesStore(options);
  // A read through the reading side lets the user finish what it writes first (`beforeRead`);
  // core reads the rows through the internals
  const gate = options.beforeRead ?? noRead;
  // The views and the scans handed out read through the gate at each of their reads (a view kept
  // from before a write is read later); the drawing reads the views of the internals
  const gated = new WeakMap<LayerTableView, LayerTableView>();
  const tables: FeatureTables = {
    get: (layerId) => {
      try {
        gate();
        const view = store.view(layerId);
        if (!view) return undefined;
        let out = gated.get(view);
        if (!out) {
          out = new GatedLayerView(view, gate);
          gated.set(view, out);
        }
        return out;
      } catch (error) {
        throw tablesError(error);
      }
    },
    getRowRef: (id) => {
      try {
        gate();
        return store.handleOf(id);
      } catch (error) {
        throw tablesError(error);
      }
    },
    getRowId: (handle) => {
      try {
        gate();
        return store.ids.idOf(handle);
      } catch (error) {
        throw tablesError(error);
      }
    },
    getGroupId: (groupHandle) => {
      try {
        gate();
        return store.groups.idOf(groupHandle);
      } catch (error) {
        throw tablesError(error);
      }
    },
    findGroup: (id) => {
      try {
        gate();
        const group = store.groups.handleOfId(id);
        return group >= 0 ? group : undefined;
      } catch (error) {
        throw tablesError(error);
      }
    },
    getGroupKey: (groupHandle) => {
      try {
        gate();
        return store.getGroupKey(groupHandle);
      } catch (error) {
        throw tablesError(error);
      }
    },
    scan: (options) => {
      try {
        gate();
        const cursor = store.scan(tableScanOf(options ?? {}));
        return {
          next: () => {
            try {
              gate();
              return cursor.next();
            } catch (error) {
              throw tablesError(error);
            }
          },
        };
      } catch (error) {
        throw tablesError(error);
      }
    },
    readValues: (rows) => {
      try {
        gate();
        return store.readRowValues(rows);
      } catch (error) {
        throw tablesError(error);
      }
    },
    release: (token) => {
      try {
        gate();
        store.release(token);
      } catch (error) {
        throw tablesError(error);
      }
    },
  };
  INTERNALS.set(tables, store);
  return { tables, writer: store };
}

/**
 * What a read or a write of the reading and writing sides threw, as they throw it: an error of
 * the tables (`KasaneError`) as a `DrawError` of the same code (`drawErrorOf`), anything else
 * (a `DrawError`, what a function given to the tables threw) as it is. The internals are not
 * wrapped: core reads and writes them inside its own entries, which wrap what they throw
 */
function tablesError(error: unknown): unknown {
  return error instanceof KasaneError ? drawErrorOf(error) : error;
}

/** A scan of the reading side as a scan of the tables: the layers are the tables */
function tableScanOf(options: TableScanOptions): TablesScanOptions {
  return {
    tableIds: options.layerIds,
    bbox: options.bbox,
    order: options.order === 'any' ? 'any' : 'table',
    batchSize: options.batchSize,
  };
}

/** What is called before a read when the user gives nothing (`beforeRead`) */
function noRead(): void {}

/**
 * A view of a layer handed out by the reading side of the tables: each read calls what the user
 * gives first (`TablesInternalOptions.beforeRead`), and throws an error of the tables as a
 * `DrawError` (`tablesError`)
 */
class GatedLayerView implements LayerTableView {
  constructor(
    private readonly view: LayerTableView,
    private readonly gate: () => void,
  ) {}

  get layerId(): string {
    return this.view.layerId;
  }
  get rowCount(): number {
    try {
      this.gate();
      return this.view.rowCount;
    } catch (error) {
      throw tablesError(error);
    }
  }
  get rowCountWithDeleted(): number {
    try {
      this.gate();
      return this.view.rowCountWithDeleted;
    } catch (error) {
      throw tablesError(error);
    }
  }
  get itemCount(): number {
    try {
      this.gate();
      return this.view.itemCount;
    } catch (error) {
      throw tablesError(error);
    }
  }
  listDrawnRows(bbox: BBox): Int32Array {
    try {
      this.gate();
      return this.view.listDrawnRows(bbox);
    } catch (error) {
      throw tablesError(error);
    }
  }
  getRowBBox(handle: RowRef): BBox | null {
    try {
      this.gate();
      return this.view.getRowBBox(handle);
    } catch (error) {
      throw tablesError(error);
    }
  }
  getRowType(handle: RowRef): FeatureType | null {
    try {
      this.gate();
      return this.view.getRowType(handle);
    } catch (error) {
      throw tablesError(error);
    }
  }
  getRowPoint(handle: RowRef): Position | null {
    try {
      this.gate();
      return this.view.getRowPoint(handle);
    } catch (error) {
      throw tablesError(error);
    }
  }
  getRowValue(handle: RowRef, key: string): unknown {
    try {
      this.gate();
      return this.view.getRowValue(handle, key);
    } catch (error) {
      throw tablesError(error);
    }
  }
  getRowStyle(handle: RowRef): Readonly<FeatureStyle> | undefined {
    try {
      this.gate();
      return this.view.getRowStyle(handle);
    } catch (error) {
      throw tablesError(error);
    }
  }
  getRow(handle: RowRef): Feature | undefined {
    try {
      this.gate();
      return this.view.getRow(handle);
    } catch (error) {
      throw tablesError(error);
    }
  }
  getDrawnRowsRevision(): number {
    try {
      this.gate();
      return this.view.getDrawnRowsRevision();
    } catch (error) {
      throw tablesError(error);
    }
  }
  listRowHandles(start: number, count: number): Int32Array {
    try {
      this.gate();
      return this.view.listRowHandles(start, count);
    } catch (error) {
      throw tablesError(error);
    }
  }
  listItems(start: number, count: number): ItemHandles {
    try {
      this.gate();
      return this.view.listItems(start, count);
    } catch (error) {
      throw tablesError(error);
    }
  }
  countGroupMembers(groupHandle: number): number {
    try {
      this.gate();
      return this.view.countGroupMembers(groupHandle);
    } catch (error) {
      throw tablesError(error);
    }
  }
  listGroupMembers(groupHandle: number, start: number, count: number): Int32Array {
    try {
      this.gate();
      return this.view.listGroupMembers(groupHandle, start, count);
    } catch (error) {
      throw tablesError(error);
    }
  }
}

/**
 * What core reads of the tables besides the reading side (the drawing, the hit testing): the
 * internals of the tables, and what the library makes of them
 *
 * @internal
 */
export interface FeatureTablesInternals extends Pages<FeatureStyle> {
  /** The state of the rows of the library, written to the tables (`feature-row-states.ts`) */
  readonly states: RowStateSets;
  /**
   * The features made of rows, kept by the versions of their rows (`feature-cache.ts`): what the
   * reads of one row at a time make features through
   */
  readonly featureCache: FeatureCache;
  /** The reads of the rows of a layer without making features (undefined for a layer of none) */
  view(layerId: string): LayerTableView | undefined;
  /** The values the rows of `rows` have now, for its fields (see `FeatureTables.readValues`) */
  readRowValues(rows: RowValues): RowValues;
  /**
   * Calls `listener` with the rows of a selection of many features once it is decided (a box let
   * go of, every feature selected), and with null once there is none: what moves them on the
   * terrain (the moving parts of the drape) starts being built then, before they are pressed
   *
   * @returns The function that stops the calls
   */
  onBulkSelected(listener: (rows: TableSelection | null) => void): () => void;
  /** Tells the listeners of `onBulkSelected` the rows of a selection of many features decided */
  bulkSelected(rows: TableSelection | null): void;
  /**
   * Draws the sketches of features in the places of their rows, for this client only: the ones drawn
   * before and not given now are no longer drawn. A sketch of a feature of a row is drawn in its
   * place, the row hidden by the mark of the sketches (`STATE_HIDDEN_SKETCH`); a sketch of a new
   * feature is drawn at the keys given (`SketchOverlay.place`), or at the end of its layer. Nothing
   * is written
   */
  showSketches(sketches: readonly SketchOverlay[]): void;
  /**
   * The differences between the sketches drawn and the features that should have one drawn over
   * their rows (`expected`, by id): each such row is hidden by the mark of the sketches, the sketch is
   * drawn over it at its keys and nothing else is, and no other row has the mark
   */
  checkSketches(expected: ReadonlySet<string>): string[];
  /**
   * The geometry the sketch of a feature is drawn with, as its row of the delta reads it (undefined
   * when no sketch of it is drawn)
   */
  sketchGeometryOf(id: string): Geometry | null | undefined;
  /** The geometry of the row of a feature, as it is read (undefined for an id of no row) */
  rowGeometryOf(id: string): Geometry | null | undefined;
  /**
   * The key of the order of a group of features last written: the one not in the order read yet
   * (its members are read in the order before until its reorder goes in), or the one of the table
   * of the groups (undefined for an unknown group)
   */
  getGroupKey(group: GroupRef): string | undefined;
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

/**
 * Runs reads of many rows one after the other (a page of a list, every feature in order): they
 * give the features kept of rows, and keep no more (`FeatureCache.withoutKeeping`)
 *
 * @internal
 */
export function readWithoutKeeping<T>(tables: FeatureTables | undefined, read: () => T): T {
  const cache = featureTablesInternals(tables)?.featureCache;
  return cache ? cache.withoutKeeping(read) : read();
}

/**
 * Keeps the features of rows about to be selected by their IDs, found by them
 * (`FeatureCache.keepSelected`): the selection set next finds its rows by the handles given
 *
 * @internal
 */
export function keepSelectedRows(
  tables: FeatureTables | undefined,
  handles: readonly RowRef[],
  ids: readonly string[],
): void {
  featureTablesInternals(tables)?.featureCache.keepSelected(handles, ids);
}

/** The owner of the features drawn for the sketches (`showSketches`) */
const SKETCH_OWNER = '\u0000sketches';

/**
 * The keys of the order a feature of no row is drawn at: the key of the order of its layer, and in
 * a group of features its group and the key of its order there
 *
 * @internal
 */
export interface OverlayPlace {
  /** The key of its order: among the members of its group when it has one, else in its layer */
  readonly key: string;
  readonly group?: number;
}

/**
 * A feature drawn over the rows (`showSketches`): over the row of its id, or for a
 * feature of no row at the keys given (`place`), or at the end of its layer
 *
 * @internal
 */
export interface SketchOverlay {
  readonly feature: Feature;
  readonly place?: OverlayPlace;
}

interface OverlayEntry {
  /** The row of the delta it is drawn as */
  readonly handle: RowRef;
  /** Where the row it is drawn over was when it was drawn */
  overPlace: { readonly group: RowGroup; readonly row: number } | undefined;
  /** Its layer */
  readonly layer: string;
  /** The row it is drawn over (undefined for a feature of no row) */
  readonly over: RowRef | undefined;
}

/** The implementation of the tables of the library: the tables, and what the library reads of them */
class FeatureTablesStore extends TablesStore<FeatureStyle> implements FeatureTablesInternals {
  readonly states: RowStateSets;
  private readonly views = new Map<string, LayerTableView>();
  readonly featureCache: FeatureCache;
  /** The features of the sketches drawn over rows for this client, by id */
  private sketchEntries = new Map<string, OverlayEntry>();
  /** The features of the sketches drawn over rows, as they were given last */
  private sketchInputs: readonly SketchOverlay[] = [];
  /** The rows a sketch is drawn over */
  private sketchedRows = new Set<RowRef>();
  /** The boxes of the rows whose boxes come from more than their points (`rowBoxes`) */
  private readonly boxesGiven: RowBoxes | undefined;
  /**
   * The box each type of row is given by (`rowBoxes`), null for a type whose rows take the box of
   * their points: asked once per type until the boxes are read again (`refreshBoxes`)
   */
  private readonly boxOfType = new Map<string, ((feature: Feature) => BBox) | null>();

  /**
   * The box the rows of a type are given by (`rowBoxes`), or null for a type whose rows take the
   * box of their points
   */
  private boxOfTypeOf(type: string): ((feature: Feature) => BBox) | null {
    const given = this.boxesGiven;
    if (!given) return null;
    let boxOf = this.boxOfType.get(type);
    if (boxOf === undefined) {
      boxOf = given(type) ?? null;
      this.boxOfType.set(type, boxOf);
    }
    return boxOf;
  }

  view(layerId: string): LayerTableView | undefined {
    const layer = this.rowTable(layerId);
    if (!layer) return undefined;
    let view = this.views.get(layerId);
    if (!view) {
      view = new LayerTableViewImpl(this, layer);
      this.views.set(layerId, view);
    }
    return view;
  }

  /** The values the rows of `rows` have now, for its fields, as a feature holds them */
  readRowValues(rows: RowValues): RowValues {
    return rowValuesOfTables(this.readValues(rows.handles, fieldsToRead(rows)));
  }

  override readValues(rows: Int32Array, read: readonly RowField[]): TablesRowValues {
    const n = rows.length;
    const fields = new Map<RowField, unknown[]>();
    let deleted: Uint8Array | undefined;
    for (const field of read) {
      if (field === 'deleted') deleted ??= new Uint8Array(n);
      else fields.set(field, new Array(n).fill(undefined));
    }
    for (let i = 0; i < n; i++) {
      const place = this.placeOf(rows[i]);
      if (!place) {
        if (deleted) deleted[i] = 1;
        continue;
      }
      const { group, row } = place;
      const data = group.data;
      if (deleted) deleted[i] = (data.flags[row] & ROW_FLAG_DELETED) !== 0 ? 1 : 0;
      for (const [field, values] of fields) values[i] = this.fieldOf(place, field);
    }
    return { rows: Int32Array.from(rows), fields, ...(deleted && { deleted }) };
  }

  /** The value of a field of a row, as a feature holds it */
  private fieldOf(place: RowPlace, field: RowField): unknown {
    const { group, row } = place;
    const data = group.data;
    const featureGroup = data.groups[row];
    switch (field) {
      case 'type':
        return rowType(data, row);
      case 'parent':
        return featureGroup >= 0 ? this.groups.idOf(featureGroup) : place.table.tableId;
      case 'key':
        return utf8String(data.keys, row);
      case 'geometry':
        return rowGeometry(group, row) ?? undefined;
      case 'hidden':
        return (data.flags[row] & ROW_FLAG_HIDDEN) !== 0;
      case 'locked':
        return (data.flags[row] & ROW_FLAG_LOCKED) !== 0;
      case 'style':
        return this.styles.get(styleColumnOf(data).indexes[row]);
      default:
        return rowValue(group, row, field.slice(PROPERTY_FIELD.length), this.strings);
    }
  }

  private readonly bulkListeners = new Set<(rows: TableSelection | null) => void>();

  onBulkSelected(listener: (rows: TableSelection | null) => void): () => void {
    this.bulkListeners.add(listener);
    return () => {
      this.bulkListeners.delete(listener);
    };
  }

  bulkSelected(rows: TableSelection | null): void {
    for (const listener of this.bulkListeners) listener(rows);
  }

  showSketches(sketches: readonly SketchOverlay[]): void {
    if (this.writeSketchesInPlace(sketches)) return;
    this.sketchInputs = sketches;
    this.syncSketches();
  }

  /**
   * Whether a field of a feature of the sketches is written over its row of the delta: its
   * geometry, and an attribute that places no row again (`orderFields`)
   */
  private writtenOverSketch(field: RowField): boolean {
    if (field === 'geometry') return true;
    return field.startsWith(PROPERTY_FIELD) && !this.orderFields.has(field);
  }

  /**
   * Draws features of the sketches that changed nothing but their geometry and their attributes by
   * writing those over the rows of the delta they are drawn as, as a write of a row does: the
   * same features, drawn over the same places, so that a frame of a drag of vertices draws again the
   * coordinates that moved and no more. The rows stay drawn and not read: nothing is told, and no
   * mark is stamped
   *
   * @returns false when something else changed, and the delta is to be made again
   */
  private writeSketchesInPlace(sketches: readonly SketchOverlay[]): boolean {
    const before = this.sketchInputs;
    const entries = this.sketchEntries;
    if (before.length !== sketches.length || sketches.length === 0) return false;
    const writes: Array<{ place: RowPlace; fields: Map<RowField, readonly unknown[]> }> = [];
    for (let i = 0; i < sketches.length; i++) {
      const { feature, place: given } = sketches[i];
      const previous = before[i].feature;
      if (given !== undefined || before[i].place !== undefined) return false;
      if (previous === feature) continue;
      const fields = new Map<RowField, readonly unknown[]>();
      for (const [field, value] of featureFields(previous, feature)) {
        if (!this.writtenOverSketch(field)) return false;
        fields.set(field, [field === 'geometry' ? shapeOfGeometry(value) : value]);
      }
      if (previous.layerId !== feature.layerId) return false;
      if ((previous.groupId ?? undefined) !== (feature.groupId ?? undefined)) return false;
      const entry = entries.get(feature.id);
      const place = entry && this.placeOf(entry.handle);
      if (!entry || !place || !this.overSamePlace(entry)) return false;
      if (fields.size > 0) writes.push({ place, fields });
    }
    this.sketchInputs = sketches;
    this.writeDrawnRows(writes);
    return true;
  }

  /** Whether the row a feature of the sketches is drawn over is where it was when it was drawn */
  private overSamePlace(entry: OverlayEntry): boolean {
    if (entry.over === undefined) return entry.overPlace === undefined;
    const place = this.placeOf(entry.over);
    return place?.group === entry.overPlace?.group && place?.row === entry.overPlace?.row;
  }

  /**
   * Draws again the features of the sketches over the rows (`showSketches`): each is a row of the
   * delta of its layer drawn and not read (`drawnOnlyRows`), with the keys of the row it is drawn
   * over, the keys given (`OverlayPlace`), or at the end of its layer. A row a sketch is drawn over
   * is not drawn (`STATE_HIDDEN_SKETCH`). The rows are not written
   */
  private syncSketches(): void {
    const leaving = new Map<string, Set<RowRef>>();
    const coming = new Map<string, DeltaInput[]>();
    const leave = (layer: string, handle: RowRef): void => {
      let set = leaving.get(layer);
      if (!set) {
        set = new Set();
        leaving.set(layer, set);
      }
      set.add(handle);
    };
    {
      const before = this.sketchEntries;
      const next = new Map<string, OverlayEntry>();
      for (const { feature, place: given } of this.sketchInputs) {
        const over = given ? undefined : this.handleOf(feature.id);
        const id = `\u0000overlay\u0000${SKETCH_OWNER}\u0000${feature.id}`;
        const [handle] = this.ids.allocate(byteColumnFromStrings([id]));
        const place = over === undefined ? undefined : this.placeOf(over);
        const layer = feature.layerId;
        let base: FeatureRowInput;
        if (place) base = rowInputOf(this.readContext, place.group, place.row);
        else if (given) {
          base = {
            id,
            type: feature.type,
            geometry: null,
            key: given.key,
            ...(given.group === undefined ? {} : { group: given.group }),
          };
        } else {
          base = { id, type: feature.type, geometry: null, key: this.keyAfterLast(layer) };
        }
        const input: FeatureRowInput = {
          ...base,
          id,
          type: feature.type,
          geometry: feature.geometry,
          style: (feature.style ?? {}) as Readonly<Record<string, unknown>>,
          properties: feature.properties ?? {},
          hidden: feature.visible === false,
          locked: feature.locked === true,
          deleted: false,
        };
        const previous = before.get(feature.id);
        if (previous && previous.layer !== layer) leave(previous.layer, previous.handle);
        let list = coming.get(layer);
        if (!list) {
          list = [];
          coming.set(layer, list);
        }
        list.push({ handle, input: rowInputOfFeature(input) });
        next.set(feature.id, {
          handle,
          layer,
          over: place ? over : undefined,
          overPlace: undefined,
        });
      }
      for (const [id, previous] of before) {
        if (!next.has(id)) leave(previous.layer, previous.handle);
      }
      this.sketchEntries = next;
    }
    this.drawRows(leaving, coming);
    // The rows drawn over are not drawn
    const sketchedNow = new Set<RowRef>();
    for (const entry of this.sketchEntries.values()) {
      const place = entry.over === undefined ? undefined : this.placeOf(entry.over);
      entry.overPlace = place && { group: place.group, row: place.row };
      if (entry.over !== undefined) sketchedNow.add(entry.over);
    }
    const on = [...sketchedNow].filter((handle) => !this.sketchedRows.has(handle));
    const off = [...this.sketchedRows].filter((handle) => !sketchedNow.has(handle));
    if (on.length > 0) this.states.setSketched(Int32Array.from(on), true);
    if (off.length > 0) this.states.setSketched(Int32Array.from(off), false);
    this.sketchedRows = sketchedNow;
  }

  checkSketches(expected: ReadonlySet<string>): string[] {
    const problems: string[] = [];
    const entries = this.sketchEntries;
    /** The features drawn over each row */
    const over = new Map<RowRef, number>();
    for (const entry of entries.values()) {
      if (entry.over !== undefined) over.set(entry.over, (over.get(entry.over) ?? 0) + 1);
    }
    const keysOf = (place: RowPlace): string => {
      const data = place.group.data;
      return JSON.stringify([utf8String(data.keys, place.row), data.groups[place.row]]);
    };
    for (const id of expected) {
      const handle = this.handleOf(id);
      const place = handle === undefined ? undefined : this.placeOf(handle);
      if (handle === undefined || !place) {
        problems.push(`the feature "${id}" has a sketch drawn, and no row`);
        continue;
      }
      if ((place.group.state[place.row] & STATE_HIDDEN_SKETCH) === 0) {
        problems.push(`the row of the feature "${id}" is not hidden by the mark of its sketch`);
      }
      const entry = entries.get(id);
      if (!entry || entry.over !== handle) {
        problems.push(`the sketch of the feature "${id}" is not drawn over its row`);
        continue;
      }
      if ((over.get(handle) ?? 0) !== 1) {
        problems.push(`${over.get(handle)} features are drawn over the row of the feature "${id}"`);
      }
      const drawn = this.placeOf(entry.handle);
      if (!drawn || drawn.table !== place.table) {
        problems.push(`the sketch of the feature "${id}" is not drawn in the layer of its row`);
        continue;
      }
      if (keysOf(drawn) !== keysOf(place)) {
        problems.push(
          `the sketch of the feature "${id}" is drawn at the keys ${keysOf(drawn)}, and its row is at ${keysOf(place)}`,
        );
      }
    }
    for (const handle of this.sketchedRows) {
      const id = this.ids.idOf(handle);
      if (id === undefined || !expected.has(id)) {
        problems.push(`the row ${handle} ("${id}") is hidden by the mark of a sketch it has not`);
      }
    }
    return problems;
  }

  sketchGeometryOf(id: string): Geometry | null | undefined {
    const entry = this.sketchEntries.get(id);
    const place = entry ? this.placeOf(entry.handle) : undefined;
    return place ? rowInputOf(this.readContext, place.group, place.row).geometry : undefined;
  }

  rowGeometryOf(id: string): Geometry | null | undefined {
    const handle = this.handleOf(id);
    const place = handle === undefined ? undefined : this.placeOf(handle);
    return place ? rowInputOf(this.readContext, place.group, place.row).geometry : undefined;
  }

  /** A key of the order after every item of a layer (a feature drawn at its end) */
  private keyAfterLast(layerId: string): string {
    // The last row of the order, read from the rows at its end
    const last = this.rowTable(layerId)?.lastRow();
    if (!last) return 'V';
    const data = last.group.data;
    const row = last.row;
    const group = data.groups[row];
    const key = group >= 0 ? (this.groups.orderOf(group) ?? '') : utf8String(data.keys, row);
    // Any key the last one is a beginning of comes after it
    return `${key}~`;
  }

  /** The fields whose new value places a row again (`orderFields`) */
  private readonly orderFields: ReadonlySet<string>;

  constructor(options: TablesInternalOptions) {
    super(options);
    this.orderFields = new Set(options.orderFields);
    this.states = new RowStateSets(this);
    this.featureCache = new FeatureCache({
      writeMarks: this.writeMarks,
      readContext: this.readContext,
      placeOf: (handle) => this.placeOf(handle),
      idsVersion: () => this.ids.version,
      revision: () => this.revision,
    });
    this.boxesGiven = options.rowBoxes;
  }

  /** The box of a row given for its type (`rowBoxes`), read from the row as a feature */
  protected override givenRowBox(
    place: RowPlace,
    out: Float64Array,
    inBuild: boolean,
  ): boolean | null {
    const { table, group, row } = place;
    const boxOf = this.boxOfTypeOf(rowType(group.data, row));
    if (!boxOf) return null;
    // A feature made for a build of every box is not kept
    const feature = inBuild
      ? this.featureCache.withoutKeeping(() =>
          this.featureCache.featureOf(table.tableId, group, row),
        )
      : this.featureCache.featureOf(table.tableId, group, row);
    const box = boxOf(feature);
    if (!box.every(Number.isFinite)) return false;
    out[0] = box[0];
    out[1] = box[1];
    out[2] = box[2];
    out[3] = box[3];
    return true;
  }

  /** Whether the box of a row is given for its type (`rowBoxes`): it reads the feature */
  protected override hasGivenBox(group: RowGroup, row: number): boolean {
    return this.boxOfTypeOf(rowType(group.data, row)) !== null;
  }

  override refreshBoxes(): void {
    this.boxOfType.clear();
    super.refreshBoxes();
  }

  override clear(): TablesWrite {
    this.featureCache.clear();
    // The features drawn in the places of rows, and the marks of the rows selected in bulk and
    // dragged by their values (the marks of the rows hidden on this client stay with their
    // handles, which the rows of the same ids get again)
    if (this.sketchedRows.size > 0)
      this.states.setSketched(Int32Array.from(this.sketchedRows), false);
    this.sketchEntries = new Map();
    this.sketchInputs = [];
    this.sketchedRows = new Set();
    const marked = Int32Array.from(this.states.bulkHandles());
    if (marked.length > 0) {
      this.states.setBulk(marked, false);
      this.states.setByValues(marked, false);
    }
    this.views.clear();
    return super.clear();
  }

  override handleOf(id: string): RowRef | undefined {
    // A row selected by the handle its id was found to have, while no id got or lost a handle
    const cache = this.featureCache;
    let handle = cache.selectedHandleOf(id);
    if (handle === undefined) {
      handle = this.ids.handleOf(id);
      if (handle < 0) return undefined;
      cache.noteSelectedId(id, handle);
    }
    const place = this.placeOf(handle);
    if (!place) return undefined;
    return (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0 ? undefined : handle;
  }

  /** What the library keeps of the state of a handle freed is let go of */
  protected override statesForgotten(handle: RowRef, bits: number): void {
    this.states.forgotten(handle, bits);
  }
}

/**
 * The rows of one layer, read without making features: the view of a table of the tables, in the
 * words of the layers, and the rows read as a feature reads them
 */
class LayerTableViewImpl implements LayerTableView {
  /** The view of the table of the tables */
  private readonly view: RowTableView;

  constructor(
    private readonly store: FeatureTablesStore,
    private readonly table: RowTable,
  ) {
    this.view = new RowTableView(store, table);
  }

  get layerId(): string {
    return this.table.tableId;
  }

  get rowCount(): number {
    return this.view.rowCount;
  }

  get rowCountWithDeleted(): number {
    return this.view.rowCountWithDeleted;
  }

  get itemCount(): number {
    return this.view.itemCount;
  }

  listDrawnRows(bbox: BBox): Int32Array {
    return this.view.listVisibleRows(bbox);
  }

  getRowBBox(handle: RowRef): BBox | null {
    return this.view.getRowBBox(handle);
  }

  getDrawnRowsRevision(): number {
    return this.view.getVisibleRowsVersion();
  }

  listRowHandles(start: number, count: number): Int32Array {
    return this.view.listRowRefs(start, count);
  }

  listItems(start: number, count: number): ItemHandles {
    const items = this.view.listItems(start, count);
    return { kinds: items.types, handles: items.refs };
  }

  countGroupMembers(groupHandle: number): number {
    return this.view.countGroupMembers(groupHandle);
  }

  listGroupMembers(groupHandle: number, start: number, count: number): Int32Array {
    return this.view.listGroupMembers(groupHandle, start, count);
  }

  /**
   * Whether a row is read from this layer: its group and row are then the ones the tables found
   * (`foundGroup`, `foundRow`), read at once
   */
  private locate(row: RowRef): boolean {
    return this.store.findPlace(row) && this.store.foundTable === this.table;
  }

  getRowType(handle: RowRef): FeatureType | null {
    // A new row not built yet is read from what was written (its creation is not built for it)
    const input = this.store.newRowInputOf(handle);
    if (input) return input.values.type as FeatureType;
    if (!this.locate(handle)) return null;
    return rowType((this.store.foundGroup as RowGroup).data, this.store.foundRow);
  }

  getRowPoint(handle: RowRef): Position | null {
    if (!this.locate(handle)) return null;
    return rowPoint(this.store.foundGroup as RowGroup, this.store.foundRow);
  }

  getRowValue(handle: RowRef, key: string): unknown {
    // A new row not built yet: a value that is not an object is read from what was written, as the
    // row would give it back (an object is read from the row, a copy of its own)
    const input = this.store.newRowInputOf(handle);
    if (input) {
      const properties = input.values.properties as Readonly<Record<string, unknown>> | undefined;
      const value = properties?.[key];
      if (value === null || typeof value !== 'object') return value;
    }
    if (!this.locate(handle)) return undefined;
    return rowValue(
      this.store.foundGroup as RowGroup,
      this.store.foundRow,
      key,
      this.store.strings,
    );
  }

  getRowStyle(handle: RowRef): Readonly<FeatureStyle> | undefined {
    if (!this.locate(handle)) return undefined;
    const group = this.store.foundGroup as RowGroup;
    return this.store.styles.get(styleColumnOf(group.data).indexes[this.store.foundRow]);
  }

  getRow(handle: RowRef): Feature | undefined {
    if (!this.locate(handle)) return undefined;
    const group = this.store.foundGroup as RowGroup;
    const row = this.store.foundRow;
    if ((group.data.flags[row] & ROW_FLAG_DELETED) !== 0) return undefined;
    return this.store.featureCache.featureOf(this.table.tableId, group, row);
  }
}
