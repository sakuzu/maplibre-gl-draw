// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `features.restore`: the values of features before changes, written back as one bulk edit
 *
 * The target is the rows of the values, given to the bulk edits as references of rows (the
 * deleted rows the values keep among them): a row is in it while its reference still names the
 * ID the values hold, and a row that is not there any more is left out and counted nowhere. The
 * edit is written in parts as any other, with the rows of each batch written as columns through
 * the layer (`writeRowValues`), one write per layer and per kind of write.
 *
 * - A row that several values hold is written once, with all of them, from the last value to
 *   the first: the values of its fields key by key (the first value given wins for a key two of
 *   them wrote), its deletion, and its geometry, whole, or vertex by vertex on the geometry the
 *   later values left, the diff followed to it first.
 * - A row written back with its parent goes into the layer of that parent, whichever layer it is
 *   in now: the parent itself when it is a layer, the layer of the group when the group is there,
 *   and the layer the group was in when the change was told when the group is gone (at the front
 *   of that layer). A parent before whose layer is gone refuses the values (`notFound`).
 * - The groups are written back the first time the edit writes (or at its end when it has no
 *   row), for every value from the last to the first: the groups deleted come back where they
 *   were, those moved go back, and those whose values changed take them back. The groups the
 *   changes created are deleted at the end, once every row is written.
 * - What is written of the values is marked per row, from the start of the first `restore` of
 *   them: one that stopped leaves the rest, which the next `restore` of the same values writes;
 *   one that wrote everything uses them up.
 * - The keys of `properties` the options name are not written on the rows that are there: their
 *   values before are used up with the rest, and a row the values hold nothing else of is not
 *   written. A row that comes back (deleted now) comes back with every key. The keys are those
 *   of one call, not kept with the values.
 * - The values are checked when `restore` is called and again when it is about to write (a
 *   `restore` queued before it may have used them up), and are held until it ends.
 */

import type { BulkRowWork } from '../../operations/bulk-work.js';
import {
  compareRings,
  followVertexDiff,
  revertVertexDiff,
  type VertexGeometry,
} from '../../shared/utils/vertex-changes.js';
import { countWork, type WorkCounts } from '../../shared/work-counts.js';
import type {
  FeatureRowField,
  FeatureTables,
  GeometryColumn,
  RowValues,
} from '../../store/built-in/types.js';
import type { InstanceDocument } from '../../store/document-access.js';
import { DrawError } from '../errors.js';
import type { EditCounts, RestoreOptions } from '../features.js';
import type { BulkEdits } from './bulk-edits.js';
import {
  GEOMETRY_VERTICES,
  GEOMETRY_WHOLE,
  geometryOfRow,
  type RestoreMarks,
  restoreMarksOf,
  type SharedValues,
  sharedValuesOf,
  type ValueRows,
} from './feature-values.js';
import {
  groupLocked,
  invalidInput,
  isRecord,
  layerLocked,
  notFound,
  onlyLockOrVisibility,
} from './shared.js';
import type { ValuesKeeper } from './values-keeper.js';

/**
 * What `features.restore` is written with
 *
 * @internal
 */
export interface RestoreDeps {
  /** The layer over the Store */
  readonly layer: InstanceDocument;
  /** The bulk edits of the instance */
  readonly edits: BulkEdits;
  /** What the values before the changes keep */
  readonly values: ValuesKeeper;
  /** The amounts of work of the Store of the instance */
  readonly counts: WorkCounts | undefined;
}

/** The values given, each with what is written of it */
interface Given {
  readonly value: object;
  readonly shared: SharedValues;
  readonly marks: RestoreMarks;
}

/** A field not written back for a row (its value now is written) */
const NOT_GIVEN: unique symbol = Symbol('not given');

/** No key left as it is */
const NO_FIELDS: ReadonlySet<FeatureRowField> = new Set();

/** The index of the geometry of a row that is not one of the geometries before (`GeometryBuilder`) */
const NO_SOURCE = -1;

/** Geometries put together as one column */
class GeometryBuilder {
  types: Uint8Array;
  partStarts: Int32Array;
  ringStarts: Int32Array;
  positionStarts: Int32Array;
  coordinates: Float64Array;
  rows = 0;
  parts = 0;
  rings = 0;
  positions = 0;
  readonly valuesPerPosition: number;

  constructor(rows: number, valuesPerPosition: number) {
    this.valuesPerPosition = valuesPerPosition;
    this.types = new Uint8Array(rows);
    this.partStarts = new Int32Array(rows + 1);
    this.ringStarts = new Int32Array(rows + 1);
    this.positionStarts = new Int32Array(rows + 1);
    this.coordinates = new Float64Array(rows * valuesPerPosition * 4);
  }

  /** Room for `count` more entries in an array of starts */
  static #grown(array: Int32Array, needed: number): Int32Array {
    if (needed <= array.length) return array;
    const out = new Int32Array(Math.max(needed, array.length * 2));
    out.set(array);
    return out;
  }

  /** Adds a geometry: the rows of a column read in place, or one of its own */
  add(g: VertexGeometry, type: number): void {
    const n = this.valuesPerPosition;
    const parts = g.ringStarts.length - 1;
    const firstRing = parts >= 0 ? g.ringStarts[0] : 0;
    const ringCount = parts >= 0 ? g.ringStarts[parts] - firstRing : 0;
    const firstPosition = g.positionStarts[firstRing] ?? 0;
    const positionCount =
      (g.positionStarts[firstRing + ringCount] ?? firstPosition) - firstPosition;
    this.types[this.rows] = type;
    this.ringStarts = GeometryBuilder.#grown(this.ringStarts, this.parts + parts + 1);
    for (let p = 1; p <= parts; p++) {
      this.ringStarts[this.parts + p] = this.rings + (g.ringStarts[p] - firstRing);
    }
    this.positionStarts = GeometryBuilder.#grown(this.positionStarts, this.rings + ringCount + 1);
    for (let r = 1; r <= ringCount; r++) {
      this.positionStarts[this.rings + r] =
        this.positions + (g.positionStarts[firstRing + r] - firstPosition);
    }
    const needed = (this.positions + positionCount) * n;
    if (needed > this.coordinates.length) {
      const out = new Float64Array(Math.max(needed, this.coordinates.length * 2));
      out.set(this.coordinates);
      this.coordinates = out;
    }
    const from = firstPosition * n;
    for (let k = 0; k < positionCount * n; k++) {
      this.coordinates[this.positions * n + k] = g.coordinates[from + k];
    }
    this.parts += Math.max(parts, 0);
    this.rings += ringCount;
    this.positions += positionCount;
    this.rows += 1;
    this.partStarts[this.rows] = this.parts;
  }

  /** The column */
  build(): GeometryColumn {
    return {
      types: this.types.subarray(0, this.rows),
      coordinates: this.coordinates.subarray(0, this.positions * this.valuesPerPosition),
      valuesPerPosition: this.valuesPerPosition,
      partStarts: this.partStarts.subarray(0, this.rows + 1),
      ringStarts: this.ringStarts.subarray(0, this.parts + 1),
      positionStarts: this.positionStarts.subarray(0, this.rings + 1),
    };
  }
}

/**
 * The fields of the keys of `properties` a `restore` leaves as they are on the rows that are
 * there (`exceptProperties`); throws `invalidInput` unless they are an array of strings
 */
function exceptedFields(options: unknown): ReadonlySet<FeatureRowField> {
  if (!isRecord(options) || options.exceptProperties === undefined) return NO_FIELDS;
  const keys: unknown = options.exceptProperties;
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) {
    throw invalidInput('restore: exceptProperties must be an array of strings');
  }
  if (keys.length === 0) return NO_FIELDS;
  return new Set(keys.map((key) => `properties:${key as string}` as const));
}

/** Throws unless the values can be written back */
function checkValues(
  deps: RestoreDeps,
  given: readonly Given[],
  options: { readonly released: boolean },
): void {
  const { layer, values } = deps;
  for (const { value, marks } of given) {
    if (options.released && values.isReleased(value)) {
      throw invalidInput('restore: values that were let go of cannot be written back');
    }
    if (marks.usedUp) {
      throw invalidInput(
        'restore: values that were written back whole cannot be written back again',
      );
    }
  }
  for (const { shared, marks } of given) {
    for (const rows of shared.rows) {
      const gone = layer.getLayer(rows.layerId) ? layerGoneBefore(layer, rows) : rows.layerId;
      if (gone === undefined) continue;
      const written = marks.written;
      let left = written === null;
      for (let s = 0; !left && s < rows.rows.length; s++) left = written?.[rows.start + s] === 0;
      if (left) throw notFound('layer', gone);
    }
  }
}

/**
 * The layer a parent the rows had before their change puts them back into, when it is not there:
 * the parent itself when it was a layer, or the layer its group was in when the group is gone
 * (undefined when every parent before is there, or puts them into a layer that is)
 */
function layerGoneBefore(layer: InstanceDocument, rows: ValueRows): string | undefined {
  if (!rows.placesBefore) return undefined;
  for (const [parent, layerThen] of rows.placesBefore) {
    if (layer.getLayer(parent) || layer.getGroup(parent)) continue;
    if (layerThen !== undefined && !layer.getLayer(layerThen)) return layerThen;
  }
  return undefined;
}

/**
 * The layer a row goes back into when it is written back with a parent: the parent when it is a
 * layer, the layer of the group when the group is there, and the layer the group was in when the
 * change was told when it is gone (undefined when that is not known)
 */
function layerOfParent(
  layer: InstanceDocument,
  parent: string,
  rows: ValueRows,
): string | undefined {
  if (layer.getLayer(parent)) return parent;
  const group = layer.getGroup(parent);
  if (group) return group.layerId;
  return rows.placesBefore?.get(parent);
}

/**
 * Starts `features.restore`: checks the values, holds them until it ends, and writes them back
 * as one bulk edit
 *
 * @internal
 */
export function startRestore(
  deps: RestoreDeps,
  values: unknown,
  options: RestoreOptions | undefined,
): Promise<EditCounts | null> {
  const { layer, edits, keeper } = { ...deps, keeper: deps.values };
  if (!Array.isArray(values)) throw invalidInput('restore: the values must be an array');
  // Read once: the keys of this call, whatever the caller does with its array meanwhile
  const except = exceptedFields(options);
  // Each value once, in the order given
  const given: Given[] = [];
  const seen = new Set<object>();
  for (const value of values as unknown[]) {
    const shared = sharedValuesOf(value);
    const marks = restoreMarksOf(value);
    if (!shared || !marks || !keeper.owns(shared)) {
      throw invalidInput('restore: a value is not one this instance gave to a subscriber');
    }
    if (seen.has(value as object)) continue;
    seen.add(value as object);
    given.push({ value: value as object, shared, marks });
  }
  checkValues(deps, given, { released: true });
  const tables = layer.getTables();
  // The rows of the values from the last to the first, while their references name them
  let total = 0;
  for (const { shared, marks } of given) {
    marks.written ??= new Uint8Array(shared.slotCount);
    total += shared.slotCount;
  }
  const target = new Int32Array(total);
  let count = 0;
  for (let v = given.length - 1; v >= 0; v--) {
    const { shared, marks } = given[v];
    const written = marks.written as Uint8Array;
    for (const rows of shared.rows) {
      for (let i = 0; i < rows.rows.length; i++) {
        const slot = rows.start + i;
        if (written[slot] === 1) continue;
        const ref = rows.rows[i];
        if (tables.getRowId(ref) !== shared.ids[slot]) continue;
        target[count++] = ref;
      }
    }
  }
  countWork(deps.counts, 'objectsCreated', 2);
  const list = given.map(({ value }) => value);
  keeper.hold(list);
  let started: Promise<EditCounts | null>;
  try {
    started = edits.start(
      [],
      options,
      (_start, read) => restoreWork(deps, given, read.ignoreLocks, except),
      {
        targetRows: target.subarray(0, count),
      },
    );
  } catch (error) {
    keeper.unhold(list);
    throw error;
  }
  return started.then(
    (result) => {
      keeper.unhold(list);
      return result;
    },
    (error: unknown) => {
      keeper.unhold(list);
      throw error;
    },
  );
}

/**
 * The work of a `restore`: writes the rows of its batches, with the groups first and last, and
 * leaves the fields `except` names as they are on the rows that are there
 */
function restoreWork(
  deps: RestoreDeps,
  given: readonly Given[],
  ignoreLocks: boolean,
  except: ReadonlySet<FeatureRowField>,
): BulkRowWork {
  const { layer } = deps;
  const tables = layer.getTables();
  let groupsWritten = false;
  let skipped = 0;

  /** Writes back the groups deleted, moved and changed, from the last value to the first */
  const writeGroups = (): void => {
    if (groupsWritten) return;
    groupsWritten = true;
    for (let v = given.length - 1; v >= 0; v--) {
      const { shared, marks } = given[v];
      if (marks.groupsWritten) continue;
      marks.groupsWritten = true;
      const { groups } = shared;
      for (const { group, layerId, key } of groups.deleted) {
        if (layer.getGroup(group.id)) continue;
        const target = layer.getLayer(layerId);
        if (!target || layerLocked(layer, target)) continue;
        layer.placeGroup(group, layerId, key);
      }
      for (const { id, layerId, key } of groups.moved) {
        const group = layer.getGroup(id);
        const target = layer.getLayer(layerId);
        if (!group || !target || groupLocked(layer, group) || layerLocked(layer, target)) continue;
        layer.placeGroup(group, layerId, key);
      }
      for (const { id, patch } of groups.updated) {
        const group = layer.getGroup(id);
        if (!group) continue;
        if (groupLocked(layer, group) && !onlyLockOrVisibility(patch)) continue;
        layer.updateGroup(id, patch);
      }
    }
  };

  /** Deletes the groups the changes created, from the last value to the first */
  const deleteCreatedGroups = (): void => {
    for (let v = given.length - 1; v >= 0; v--) {
      for (const id of given[v].shared.groups.created) {
        const group = layer.getGroup(id);
        if (!group || groupLocked(layer, group)) continue;
        layer.deleteGroup(id);
      }
    }
  };

  /** The layer of rows there, found from the layer of the values first */
  let lastLayer: string | undefined;
  const layerOfRowThere = (ref: number, hint: string): string | undefined => {
    for (const layerId of [lastLayer, hint]) {
      if (layerId !== undefined && tables.get(layerId)?.getRowType(ref) != null) {
        lastLayer = layerId;
        return layerId;
      }
    }
    for (const layerId of layer.getLayerOrder()) {
      if (tables.get(layerId)?.getRowType(ref) != null) {
        lastLayer = layerId;
        return layerId;
      }
    }
    return undefined;
  };

  return {
    prepare() {
      // A `restore` queued before may have used the values up, or their layers may be gone
      checkValues(deps, given, { released: false });
    },
    writeRows(rows, changed) {
      writeGroups();
      writeBatch(rows, changed);
    },
    end(stopped) {
      // A `restore` that stops leaves the rest, the groups included, to the next one
      if (stopped) return undefined;
      writeGroups();
      deleteCreatedGroups();
      for (const { marks } of given) marks.usedUp = true;
      return undefined;
    },
    skippedVertexCount: () => skipped,
  };

  /** Writes the rows of a batch */
  function writeBatch(rows: Int32Array, changed: Uint8Array): void {
    const valueCount = given.length;
    // The values that hold each row, from the last to the first: entries `k * valueCount` on
    const holders = new Int32Array(rows.length * valueCount);
    const slots = new Int32Array(rows.length * valueCount);
    const holderCount = new Int32Array(rows.length);
    /**
     * The layers the rows are in and go into, by their index in `layers`: a write of the Store
     * takes the rows of one layer, which a new parent may put in another
     */
    const layers: string[] = [];
    const layerOf = new Int32Array(rows.length).fill(-1);
    const targetOf = new Int32Array(rows.length).fill(-1);
    const deletedNow = new Uint8Array(rows.length);
    /** The rows deleted now, by the layer of the values, whose parents are read at once */
    const deletedRows = new Map<string, number[]>();
    for (let k = 0; k < rows.length; k++) {
      const ref = rows[k];
      const id = tables.getRowId(ref);
      if (id === undefined) continue;
      for (let v = valueCount - 1; v >= 0; v--) {
        const { shared, marks } = given[v];
        const slot = shared.slotOf(ref);
        if (slot < 0 || marks.written?.[slot] === 1 || shared.ids[slot] !== id) continue;
        holders[k * valueCount + holderCount[k]] = v;
        slots[k * valueCount + holderCount[k]] = slot;
        holderCount[k] += 1;
      }
      if (holderCount[k] === 0) continue;
      const first = given[holders[k * valueCount]].shared.rowsOf(slots[k * valueCount]);
      if (tables.getRowRef(id) === ref) {
        const layerId = layerOfRowThere(ref, first.layerId);
        if (layerId !== undefined) layerOf[k] = indexOf(layers, layerId);
      } else {
        deletedNow[k] = 1;
        let list = deletedRows.get(first.layerId);
        if (!list) {
          list = [];
          deletedRows.set(first.layerId, list);
        }
        list.push(k);
      }
    }
    // A deleted row is in the layer of its parent: a layer, or the layer of its group; a row whose
    // group is gone goes back into the layer it was in (the layer gives it a place there)
    for (const [layerId, list] of deletedRows) {
      const parents = parentsOf(
        tables,
        Int32Array.from(list, (k) => rows[k]),
      );
      list.forEach((k, j) => {
        const parent = parents[j];
        const there = layer.getLayer(parent)
          ? parent
          : layer.getGroup(parent)
            ? layer.getGroup(parent)?.layerId
            : undefined;
        if (there !== undefined) {
          layerOf[k] = indexOf(layers, there);
        } else if (layer.getLayer(layerId)) {
          layerOf[k] = indexOf(layers, layerId);
        } else {
          // Its layer is gone since the edit started: the row is passed over, as written
          markWritten(k);
        }
      });
    }
    // A row written back with a parent goes into the layer of that parent, whichever layer it is
    // in now; the others stay in theirs
    for (let k = 0; k < rows.length; k++) {
      if (layerOf[k] < 0) continue;
      const h = parentHolderOf(k);
      if (h < 0) {
        targetOf[k] = layerOf[k];
        continue;
      }
      const slot = slots[k * valueCount + h];
      const part = given[holders[k * valueCount + h]].shared.rowsOf(slot);
      const parent = part.before?.fields.get('parent')?.[slot - part.start] as string;
      const target = layerOfParent(layer, parent, part);
      targetOf[k] = target === undefined ? layerOf[k] : indexOf(layers, target);
    }
    // The rows by the layer they are in and the one they go into, one write for each
    const writes = new Map<number, number[]>();
    for (let k = 0; k < rows.length; k++) {
      if (targetOf[k] < 0) continue;
      const key = layerOf[k] * layers.length + targetOf[k];
      let list = writes.get(key);
      if (!list) {
        list = [];
        writes.set(key, list);
      }
      list.push(k);
    }
    countWork(deps.counts, 'objectsCreated', 8);

    for (const [key, inLayer] of writes) {
      const target = layers[key % layers.length];
      if (layer.getLayer(target)) writeLayer(target, inLayer);
      else for (const k of inLayer) markWritten(k);
    }

    /**
     * The holder of a row whose value gives the parent it is written back with (the first value
     * given wins, as for any key): -1 when no value writes its parent
     */
    function parentHolderOf(k: number): number {
      let out = -1;
      for (let h = 0; h < holderCount[k]; h++) {
        const slot = slots[k * valueCount + h];
        const part = given[holders[k * valueCount + h]].shared.rowsOf(slot);
        if (typeof part.before?.fields.get('parent')?.[slot - part.start] === 'string') out = h;
      }
      return out;
    }

    /** Marks the slots of a row written in every value that holds it */
    function markWritten(k: number): void {
      for (let h = 0; h < holderCount[k]; h++) {
        const written = given[holders[k * valueCount + h]].marks.written;
        if (written) written[slots[k * valueCount + h]] = 1;
      }
    }

    /** Writes the rows of a batch that are in one layer */
    function writeLayer(layerId: string, inLayer: readonly number[]): void {
      const n = tables.getValuesPerPosition(layerId) ?? 2;
      const deleteRows: number[] = [];
      const withGeometry: number[] = [];
      const others: number[] = [];
      /** The values of the fields of each row, `NOT_GIVEN` for a key no value wrote */
      const fieldValues = new Map<FeatureRowField, unknown[]>();
      /** Whether each row is deleted once written back */
      const deletedAfter = new Uint8Array(rows.length);
      /** The geometry before each row takes whole: the value and its position, or `NO_SOURCE` */
      const wholeFrom = new Int32Array(rows.length).fill(NO_SOURCE);
      const wholeAt = new Int32Array(rows.length);
      /** Whether each row is written back vertex by vertex (its geometry is read first) */
      const byVertices = new Uint8Array(rows.length);
      let anyWhole = false;
      for (const k of inLayer) {
        deletedAfter[k] = deletedNow[k];
        let geometryWritten = false;
        // The keys left as they are, on a row that is there (one that comes back has every key)
        const leaves = except.size > 0 && deletedNow[k] === 0;
        let left = false;
        let fieldGiven = false;
        for (let h = 0; h < holderCount[k]; h++) {
          const v = holders[k * valueCount + h];
          const slot = slots[k * valueCount + h];
          const part = given[v].shared.rowsOf(slot);
          const at = slot - part.start;
          const before = part.before;
          if (!before) {
            // A row the change created is deleted
            deletedAfter[k] = 1;
            continue;
          }
          if (before.deleted) deletedAfter[k] = before.deleted[at] === 0 ? 0 : 1;
          for (const [field, column] of before.fields) {
            if (leaves && except.has(field)) {
              left = true;
              continue;
            }
            fieldGiven = true;
            let list = fieldValues.get(field);
            if (!list) {
              list = new Array<unknown>(rows.length).fill(NOT_GIVEN);
              fieldValues.set(field, list);
            }
            list[k] = column[at];
          }
          const kind = part.geometryKinds?.[at];
          if (kind === GEOMETRY_WHOLE || kind === GEOMETRY_VERTICES) geometryWritten = true;
          if (kind === GEOMETRY_VERTICES) byVertices[k] = 1;
          if (kind === GEOMETRY_WHOLE) anyWhole = true;
        }
        if (deletedAfter[k] === 1) {
          if (deletedNow[k] === 0) deleteRows.push(k);
          else markWritten(k);
        } else if (geometryWritten) {
          withGeometry.push(k);
        } else if (left && !fieldGiven) {
          // The values hold nothing else of the row: it is not written, and they are used up
          markWritten(k);
        } else {
          others.push(k);
        }
      }

      if (deleteRows.length > 0) {
        const values: RowValues = {
          rows: Int32Array.from(deleteRows, (k) => rows[k]),
          fields: new Map(),
          deleted: new Uint8Array(deleteRows.length).fill(1),
        };
        takeWritten(deleteRows, layer.writeRowValues(layerId, values, { ignoreLocks }));
      }
      for (const list of apart(withGeometry)) writeGeometries(list);
      for (const list of apart(others)) {
        writeRows(layerId, list, fieldValues, deletedAfter, undefined);
      }

      /**
       * The rows that are there apart from those that come back, when keys are left as they are:
       * a key written to a row that comes back is not written to the others
       */
      function apart(list: readonly number[]): ReadonlyArray<readonly number[]> {
        if (list.length === 0) return [];
        if (except.size === 0) return [list];
        const there = list.filter((k) => deletedNow[k] === 0);
        const back = list.filter((k) => deletedNow[k] === 1);
        return [there, back].filter((part) => part.length > 0);
      }

      /** Writes rows with their geometries */
      function writeGeometries(withGeometry: readonly number[]): void {
        const geometry = new GeometryBuilder(withGeometry.length, n);
        // The geometries now of the rows written back vertex by vertex
        const vertexRows = withGeometry.filter((k) => byVertices[k] === 1);
        const now =
          vertexRows.length > 0
            ? tables.readValues(
                Int32Array.from(vertexRows, (k) => rows[k]),
                ['geometry'],
              ).geometry
            : undefined;
        const nowAt = new Map<number, number>();
        vertexRows.forEach((k, j) => {
          nowAt.set(k, j);
        });
        for (const k of withGeometry) {
          wholeFrom[k] = NO_SOURCE;
          // The geometry as the later values leave it: the one now, or a geometry before taken whole
          let current: VertexGeometry | null = null;
          const nowIndex = nowAt.get(k);
          if (now && nowIndex !== undefined) current = geometryOfRow(now, nowIndex);
          for (let h = 0; h < holderCount[k]; h++) {
            const v = holders[k * valueCount + h];
            const slot = slots[k * valueCount + h];
            const shared = given[v].shared;
            const part = shared.rowsOf(slot);
            const at = slot - part.start;
            const kind = part.geometryKinds?.[at];
            const column = part.before?.geometry;
            if (!column) continue;
            if (kind === GEOMETRY_WHOLE) {
              wholeFrom[k] = v;
              wholeAt[k] = slot;
              current = null;
            } else if (kind === GEOMETRY_VERTICES) {
              const tracked = shared.tracked.get(slot);
              if (!tracked) continue;
              if (current === null && wholeFrom[k] !== NO_SOURCE) {
                const from = given[wholeFrom[k]].shared.rowsOf(wholeAt[k]);
                const fromColumn = from.before?.geometry as GeometryColumn;
                current = geometryOfRow(fromColumn, wholeAt[k] - from.start);
              }
              if (current === null) continue;
              // The diff, followed to the geometry the later values left
              const diff = followVertexDiff(tracked.diff, compareRings(tracked.last, current));
              const reverted = revertVertexDiff(current, diff);
              skipped += reverted.skippedVertexCount;
              current = { ...reverted.geometry, type: current.type };
              wholeFrom[k] = NO_SOURCE;
            }
          }
          if (current !== null) {
            geometry.add(current, Number(current.type ?? 255));
          } else if (wholeFrom[k] !== NO_SOURCE) {
            const from = given[wholeFrom[k]].shared.rowsOf(wholeAt[k]);
            const fromColumn = from.before?.geometry as GeometryColumn;
            const at = wholeAt[k] - from.start;
            geometry.add(geometryOfRow(fromColumn, at), fromColumn.types[at]);
          }
        }
        // A part that wrote whole geometries takes them back whole the other way too
        if (anyWhole) layer.markWholeGeometry();
        writeRows(layerId, withGeometry, fieldValues, deletedAfter, geometry.build());
      }
    }

    /** Writes rows of one layer, the keys no value wrote taking the values they have now */
    function writeRows(
      layerId: string,
      list: readonly number[],
      fieldValues: ReadonlyMap<FeatureRowField, unknown[]>,
      deletedAfter: Uint8Array,
      geometry: GeometryColumn | undefined,
    ): void {
      const refs = Int32Array.from(list, (k) => rows[k]);
      const names = [...fieldValues.keys()].filter((field) =>
        list.some((k) => fieldValues.get(field)?.[k] !== NOT_GIVEN),
      );
      const missing = names.filter((field) =>
        list.some((k) => fieldValues.get(field)?.[k] === NOT_GIVEN),
      );
      const now = missing.length > 0 ? readFields(tables, refs, missing) : undefined;
      const fields = new Map<FeatureRowField, unknown[]>();
      for (const field of names) {
        const given = fieldValues.get(field) as unknown[];
        const current = now?.get(field);
        fields.set(
          field,
          list.map((k, j) => (given[k] === NOT_GIVEN ? current?.[j] : given[k])),
        );
      }
      const back = list.some((k) => deletedNow[k] === 1);
      if (names.length === 0 && !geometry && !back) {
        // Nothing to write: the values hold nothing more for these rows
        for (const k of list) markWritten(k);
        return;
      }
      const values: RowValues = {
        rows: refs,
        fields,
        ...(geometry && { geometry }),
        ...(back && { deleted: Uint8Array.from(list, (k) => deletedAfter[k]) }),
      };
      takeWritten(list, layer.writeRowValues(layerId, values, { ignoreLocks }));
    }

    /** Marks the rows written, as the layer gave them back */
    function takeWritten(list: readonly number[], written: Int32Array): void {
      if (written.length === 0) return;
      const done = new Set(written);
      for (const k of list) {
        if (!done.has(rows[k])) continue;
        changed[k] = 1;
        markWritten(k);
      }
    }
  }
}

/** The index of a layer in a list, added when it is not there */
function indexOf(list: string[], layerId: string): number {
  const at = list.indexOf(layerId);
  if (at >= 0) return at;
  list.push(layerId);
  return list.length - 1;
}

/**
 * Values of fields of rows, read at once, or one row at a time when the rows are not read as those
 * of one layer (a deleted row whose group is gone among them)
 */
function readFields(
  tables: FeatureTables,
  refs: Int32Array,
  fields: readonly FeatureRowField[],
): ReadonlyMap<FeatureRowField, readonly unknown[]> {
  try {
    return tables.readValues(refs, fields).fields;
  } catch (error) {
    if (!(error instanceof DrawError)) throw error;
    const out = new Map<FeatureRowField, unknown[]>(fields.map((field) => [field, []]));
    for (const ref of refs) {
      const one = tables.readValues(Int32Array.of(ref), fields).fields;
      for (const field of fields) out.get(field)?.push(one.get(field)?.[0]);
    }
    return out;
  }
}

/** The parents of deleted rows that are kept, read at once when they are in one layer */
function parentsOf(tables: FeatureTables, refs: Int32Array): string[] {
  try {
    const parents = tables.readValues(refs, ['parent']).fields.get('parent') ?? [];
    return Array.from(refs, (_, i) => String(parents[i]));
  } catch (error) {
    if (!(error instanceof DrawError)) throw error;
    // Rows of several layers: read one at a time
    return Array.from(refs, (ref) =>
      String(tables.readValues(Int32Array.of(ref), ['parent']).fields.get('parent')?.[0]),
    );
  }
}
