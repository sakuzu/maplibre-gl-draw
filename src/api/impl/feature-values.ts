// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The values the features had before a change (`FeatureValues`), as a subscriber of
 * `draw.document.subscribe` that asked for them receives them: what `features.restore` takes back
 *
 * The values hold what the change did, read once when it is told:
 *
 * - the values the rows it wrote had before it, by layer, as the Store gave them with its change
 *   (the arrays are not copied), and the rows it created;
 * - the ID of each of those rows, one array that points at the strings the Store holds, so that a
 *   row is written back only while its reference still names it;
 * - for the geometry of each row it wrote, how it is taken back: whole (the geometry before, kept
 *   in the arrays of the Store, with no record per feature: a move, a rotation, a scaling, a
 *   change of the type, the parts or the rings of a part), or vertex by vertex (the vertices it
 *   moved, added and deleted, and the geometry after it, which the changes since follow);
 * - the groups it created, deleted, moved and whose values it changed, with where they were.
 *
 * Every subscriber that asks gets an object of its own over the same arrays, which are not
 * copied: the arrays are held once, and counted by the objects that hold them, so that they go
 * once every object has let go of them. What `features.restore` wrote of the values is marked per
 * object, from the first `restore` that writes them.
 */

import {
  compareRings,
  diffVertices,
  type VertexDiff,
  type VertexEntries,
  type VertexGeometry,
} from '../../shared/utils/vertex-changes.js';
import type { FeatureTables, GeometryColumn, RowValues } from '../../store/built-in/types.js';
import type { Group } from '../../store/types.js';
import type { FeatureValues } from '../model.js';

/** The geometry of a row is not written back (the change did not change it) */
export const GEOMETRY_KEPT = 0;
/** The geometry of a row is written back whole: the geometry before */
export const GEOMETRY_WHOLE = 1;
/** The geometry of a row is written back vertex by vertex */
export const GEOMETRY_VERTICES = 2;

/** The indices of the geometries of polygons in `GeometryColumn.types` (Polygon, MultiPolygon) */
const POLYGON_TYPES: ReadonlySet<number> = new Set([2, 5]);

/**
 * The rows of one layer in the values: the rows the change wrote, with their values before, or
 * the rows it created
 *
 * @internal
 */
export interface ValueRows {
  /** The layer the rows were in after the change */
  readonly layerId: string;
  /** The references of the rows */
  readonly rows: Int32Array;
  /**
   * The values the rows had before the change; undefined for the rows it created. A field it
   * wrote of some of the rows only says which (`RowValues.written`): the others are not written
   * back
   */
  readonly before: RowValues | undefined;
  /** Where these rows start among the rows of the values (their slots) */
  readonly start: number;
  /**
   * How the geometry of each row is written back (`GEOMETRY_KEPT`, `GEOMETRY_WHOLE`,
   * `GEOMETRY_VERTICES`); undefined when the change wrote no geometry of these rows
   */
  readonly geometryKinds: Uint8Array | undefined;
  /**
   * The parents the rows had before the change (their layers and their groups), each once, with
   * the layer each one was or was in when the change was told: what a row whose group is gone by
   * the time it is written back goes back into. Undefined when the change wrote no parent of these
   * rows; a group whose layer could not be read then (one with no row in it) has none
   */
  readonly placesBefore: ReadonlyMap<string, string | undefined> | undefined;
}

/**
 * What a change did to the geometry of one row, vertex by vertex, as the geometry is now
 *
 * @internal
 */
export interface TrackedGeometry {
  /** The vertices the change moved, added and deleted, followed along the changes since */
  diff: VertexDiff;
  /** The geometry the diff is written against: the one after the change, then after each since */
  last: VertexGeometry;
}

/**
 * What a change did to the groups
 *
 * @internal
 */
export interface GroupChanges {
  /** The groups it created */
  readonly created: readonly string[];
  /** The groups it deleted, with their values and where they were */
  readonly deleted: ReadonlyArray<{
    readonly group: Group;
    readonly layerId: string;
    readonly key: string;
  }>;
  /** The groups it moved, with where they were */
  readonly moved: ReadonlyArray<{
    readonly id: string;
    readonly layerId: string;
    readonly key: string;
  }>;
  /** The groups whose values it changed, with the values before of the keys it wrote */
  readonly updated: ReadonlyArray<{
    readonly id: string;
    readonly patch: Readonly<Partial<Pick<Group, 'name' | 'visible' | 'locked'>>>;
  }>;
}

/** No change of a group */
const NO_GROUP_CHANGES: GroupChanges = Object.freeze({
  created: [],
  deleted: [],
  moved: [],
  updated: [],
});

/**
 * What `features.restore` wrote of the values of one subscriber
 *
 * @internal
 */
export interface RestoreMarks {
  /** One entry per row of the values: 1 once it was written back (or cannot be), from the first `restore` */
  written: Uint8Array | null;
  /** Whether the groups the change deleted, moved and changed were written back */
  groupsWritten: boolean;
  /** Whether the values were written back whole: given again, `restore` refuses them */
  usedUp: boolean;
}

/** The bytes of a diff of vertices, an estimate */
function diffBytes(diff: VertexDiff): number {
  const entries = (e: VertexEntries) =>
    e.parts.byteLength + e.rings.byteLength + e.indices.byteLength + e.positions.byteLength;
  return entries(diff.moved) + entries(diff.deleted) + entries(diff.added);
}

/** The bytes of a geometry held, an estimate */
function geometryBytes(g: VertexGeometry): number {
  return 8 * (g.coordinates.length + g.ringStarts.length + g.positionStarts.length);
}

/**
 * The values before of one change, held once for every subscriber that asked for them
 *
 * @internal
 */
export class SharedValues {
  /** The values the rows had before the change, by the id of their layer */
  readonly byLayer: ReadonlyMap<string, RowValues>;
  /** The rows of the values, by layer: those the change wrote, then those it created */
  readonly rows: readonly ValueRows[];
  /** The ID of each row of the values, by its slot (the rows one after another) */
  readonly ids: readonly string[];
  /** What the change did to the geometries written back vertex by vertex, by their slots */
  readonly tracked: ReadonlyMap<number, TrackedGeometry>;
  /** What the change did to the groups */
  readonly groups: GroupChanges;
  /** The memory the arrays take, in bytes (an estimate) */
  readonly byteLength: number;
  /** The number of rows they hold values of */
  readonly rowCount: number;
  /** How many objects of the subscribers hold them */
  #holders = 0;
  /** The references of the rows in rising order, and the slot of each, made at the first lookup */
  #sorted: { readonly refs: Int32Array; readonly slots: Int32Array } | null = null;

  constructor(
    byLayer: ReadonlyMap<string, RowValues>,
    content: {
      readonly rows?: readonly ValueRows[];
      readonly ids?: readonly string[];
      readonly tracked?: ReadonlyMap<number, TrackedGeometry>;
      readonly groups?: GroupChanges;
    } = {},
  ) {
    this.byLayer = byLayer;
    this.rows = content.rows ?? [];
    this.ids = content.ids ?? [];
    this.tracked = content.tracked ?? new Map();
    this.groups = content.groups ?? NO_GROUP_CHANGES;
    let bytes = 0;
    let rows = 0;
    for (const values of byLayer.values()) {
      rows += values.rows.length;
      bytes += values.rows.byteLength;
      if (values.deleted) bytes += values.deleted.byteLength;
      for (const column of values.fields.values()) bytes += 8 * column.length;
      for (const marks of values.written?.values() ?? []) bytes += marks.byteLength;
      const geometry = values.geometry;
      if (geometry) {
        bytes +=
          geometry.types.byteLength +
          geometry.coordinates.byteLength +
          geometry.partStarts.byteLength +
          geometry.ringStarts.byteLength +
          geometry.positionStarts.byteLength;
      }
    }
    for (const part of this.rows) {
      if (!part.before) {
        rows += part.rows.length;
        bytes += part.rows.byteLength;
      }
      if (part.geometryKinds) bytes += part.geometryKinds.byteLength;
    }
    // The IDs point at the strings the Store holds: one entry of the array per row
    bytes += 8 * this.ids.length;
    for (const tracked of this.tracked.values()) {
      bytes += diffBytes(tracked.diff) + geometryBytes(tracked.last);
    }
    this.byteLength = bytes;
    this.rowCount = rows;
  }

  /** The number of the objects that hold them */
  get holders(): number {
    return this.#holders;
  }

  /** The number of the rows of the values (their slots) */
  get slotCount(): number {
    return this.ids.length;
  }

  /** An object of a subscriber of its own over the same arrays */
  hold(): FeatureValues {
    this.#holders += 1;
    return new HeldValues(this) as unknown as FeatureValues;
  }

  /** The slot of the row of a reference among the rows of the values, or -1 */
  slotOf(ref: number): number {
    const sorted = this.#sorted ?? this.#sort();
    let lo = 0;
    let hi = sorted.refs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted.refs[mid] < ref) lo = mid + 1;
      else hi = mid;
    }
    return lo < sorted.refs.length && sorted.refs[lo] === ref ? sorted.slots[lo] : -1;
  }

  /** The rows of the values a slot is in */
  rowsOf(slot: number): ValueRows {
    let lo = 0;
    let hi = this.rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.rows[mid].start <= slot) lo = mid;
      else hi = mid - 1;
    }
    return this.rows[lo];
  }

  /** Sorts the references of the rows once, with their slots */
  #sort(): { readonly refs: Int32Array; readonly slots: Int32Array } {
    const count = this.ids.length;
    const refs = new Int32Array(count);
    for (const part of this.rows) refs.set(part.rows, part.start);
    const order = new Int32Array(count);
    for (let i = 0; i < count; i++) order[i] = i;
    order.sort((a, b) => refs[a] - refs[b]);
    const sortedRefs = new Int32Array(count);
    for (let i = 0; i < count; i++) sortedRefs[i] = refs[order[i]];
    this.#sorted = { refs: sortedRefs, slots: order };
    return this.#sorted;
  }
}

/** The values of one subscriber, over the arrays held once */
class HeldValues {
  readonly #shared: SharedValues;
  /** What `features.restore` wrote of them */
  readonly #marks: RestoreMarks = { written: null, groupsWritten: false, usedUp: false };

  constructor(shared: SharedValues) {
    this.#shared = shared;
    Object.freeze(this);
  }

  get byteLength(): number {
    return this.#shared.byteLength;
  }

  get featureCount(): number {
    return this.#shared.rowCount;
  }

  /** The values held once that an object of a subscriber is over (undefined for another object) */
  static sharedOf(values: unknown): SharedValues | undefined {
    return typeof values === 'object' && values !== null && #shared in values
      ? (values as HeldValues).#shared
      : undefined;
  }

  /** What `features.restore` wrote of the values of a subscriber (undefined for another object) */
  static marksOf(values: unknown): RestoreMarks | undefined {
    return typeof values === 'object' && values !== null && #marks in values
      ? (values as HeldValues).#marks
      : undefined;
  }
}

/**
 * The values held once that the values of a subscriber are over: what `features.restore` reads
 * (undefined for an object that is not values of features)
 *
 * @internal
 */
export function sharedValuesOf(values: unknown): SharedValues | undefined {
  return HeldValues.sharedOf(values);
}

/**
 * What `features.restore` wrote of the values of a subscriber (undefined for an object that is
 * not values of features)
 *
 * @internal
 */
export function restoreMarksOf(values: unknown): RestoreMarks | undefined {
  return HeldValues.marksOf(values);
}

// ============================================================================
// The geometries of the rows
// ============================================================================

/**
 * The geometry of row `i` of a column, read in place: its rings are the entries of the parts of
 * the row, its positions those of the column
 *
 * @internal
 */
export function geometryOfRow(column: GeometryColumn, i: number): VertexGeometry {
  const firstPart = column.partStarts[i];
  const endPart = column.partStarts[i + 1];
  const type = column.types[i];
  return {
    coordinates: column.coordinates,
    valuesPerPosition: column.valuesPerPosition,
    ringStarts: column.ringStarts.subarray(firstPart, endPart + 1),
    positionStarts: column.positionStarts,
    closedRings: POLYGON_TYPES.has(type),
    type,
  };
}

/**
 * A geometry of its own, copied from one read in place (its starts begin at 0)
 *
 * @internal
 */
export function ownGeometry(g: VertexGeometry): VertexGeometry {
  const parts = g.ringStarts.length - 1;
  const firstRing = parts >= 0 ? g.ringStarts[0] : 0;
  const ringCount = parts >= 0 ? g.ringStarts[parts] - firstRing : 0;
  const firstPosition = g.positionStarts[firstRing] ?? 0;
  const endPosition = g.positionStarts[firstRing + ringCount] ?? firstPosition;
  const ringStarts = new Int32Array(Math.max(parts, 0) + 1);
  for (let p = 0; p <= parts; p++) ringStarts[p] = g.ringStarts[p] - firstRing;
  const positionStarts = new Int32Array(ringCount + 1);
  for (let r = 0; r <= ringCount; r++) {
    positionStarts[r] = g.positionStarts[firstRing + r] - firstPosition;
  }
  const n = g.valuesPerPosition;
  const coordinates = Float64Array.from(
    { length: (endPosition - firstPosition) * n },
    (_, k) => g.coordinates[firstPosition * n + k],
  );
  return {
    coordinates,
    valuesPerPosition: n,
    ringStarts,
    positionStarts,
    closedRings: g.closedRings,
    type: g.type,
  };
}

/** Whether a diff of vertices holds no vertex */
function isEmptyDiff(diff: VertexDiff): boolean {
  return (
    diff.moved.indices.length === 0 &&
    diff.deleted.indices.length === 0 &&
    diff.added.indices.length === 0
  );
}

/**
 * How the geometries a change wrote are written back: whole for a change that wrote whole
 * geometries (or for the rows it wrote whole geometries of), and for a row deleted or one whose
 * type, parts or rings changed; vertex by vertex otherwise, with what the change did to them (a
 * row whose geometry did not change, or that the change did not write the geometry of, is not
 * written back)
 *
 * @param before - The values before of the rows of one layer, their geometries among them
 * @param after - The geometries of the rows there after the change (`readValues`), for the
 *   positions given
 * @param positions - The position in `before` of each row read in `after`
 * @param wholeGeometry - Whether the change wrote whole geometries: every geometry it wrote when
 *   true, those of the rows `isWhole` tells otherwise
 * @param start - The slot of the first row of `before`
 * @param tracked - Takes the rows written back vertex by vertex, by their slots
 * @param isWhole - Whether the change wrote the geometry of a row (by its reference) whole
 * @internal
 */
export function geometryKindsOf(
  before: RowValues,
  after: GeometryColumn | undefined,
  positions: Int32Array,
  wholeGeometry: boolean,
  start: number,
  tracked: Map<number, TrackedGeometry>,
  isWhole: (ref: number) => boolean = () => false,
): Uint8Array {
  const column = before.geometry as GeometryColumn;
  const kinds = new Uint8Array(before.rows.length).fill(GEOMETRY_WHOLE);
  // A row the change did not write the geometry of is not written back
  const written = before.written?.get('geometry');
  if (written) {
    for (let i = 0; i < kinds.length; i++) if (written[i] === 0) kinds[i] = GEOMETRY_KEPT;
  }
  if (wholeGeometry || !after) return kinds;
  for (let k = 0; k < positions.length; k++) {
    const i = positions[k];
    if (written?.[i] === 0 || isWhole(before.rows[i])) continue;
    const was = geometryOfRow(column, i);
    const now = geometryOfRow(after, k);
    if (column.types[i] === 255 || after.types[k] === 255) continue;
    const spans = compareRings(was, now);
    if (!spans.sameStructure) continue;
    const diff = diffVertices(was, now, spans);
    if (isEmptyDiff(diff)) {
      kinds[i] = GEOMETRY_KEPT;
      continue;
    }
    kinds[i] = GEOMETRY_VERTICES;
    tracked.set(start + i, { diff, last: ownGeometry(now) });
  }
  return kinds;
}

// ============================================================================
// The values of a change
// ============================================================================

/**
 * The values of a change, read when it is told: the values before of the rows it wrote, the rows
 * it created, the ID of each, how their geometries are written back, and what it did to the
 * groups (null for a change that wrote no feature and no group)
 *
 * @param input.before - The values the rows had before the change, by layer
 * @param input.created - The rows the change created
 * @param input.tables - The tables of the Store, read as the change is told
 * @param input.layerIds - The layers there are, where the rows created are looked for (read once
 *   when the change created rows)
 * @param input.wholeGeometry - Whether the change wrote whole geometries
 * @param input.wholeRows - The rows it wrote whole geometries of, when not every geometry it wrote
 * @param input.groups - What the change did to the groups
 * @param input.made - Counts an object made (an array)
 * @internal
 */
export function valuesOfChange(input: {
  readonly before: ReadonlyMap<string, RowValues> | undefined;
  readonly created: Int32Array;
  readonly tables: FeatureTables;
  readonly layerIds: () => readonly string[];
  readonly wholeGeometry: boolean;
  readonly wholeRows?: readonly Int32Array[];
  readonly groups: GroupChanges;
  readonly made?: (count: number) => void;
}): SharedValues | null {
  const { tables } = input;
  const isWhole = wholeRowsLookup(input.wholeRows ?? []);
  const rows: ValueRows[] = [];
  const ids: string[] = [];
  const tracked = new Map<number, TrackedGeometry>();
  for (const [layerId, before] of input.before ?? []) {
    if (before.rows.length === 0) continue;
    const start = ids.length;
    // The rows there after the change, whose geometries are compared with those before
    const alive: number[] = [];
    for (let i = 0; i < before.rows.length; i++) {
      const ref = before.rows[i];
      const id = tables.getRowId(ref) ?? '';
      ids.push(id);
      if (before.geometry && tables.getRowRef(id) === ref) alive.push(i);
    }
    let geometryKinds: Uint8Array | undefined;
    if (before.geometry) {
      const positions = Int32Array.from(alive);
      const after =
        positions.length > 0 && !input.wholeGeometry
          ? tables.readValues(
              Int32Array.from(positions, (i) => before.rows[i]),
              ['geometry'],
            ).geometry
          : undefined;
      geometryKinds = geometryKindsOf(
        before,
        after,
        positions,
        input.wholeGeometry,
        start,
        tracked,
        isWhole,
      );
      input.made?.(3);
    }
    const placesBefore = placesBeforeOf(before, input);
    rows.push({ layerId, rows: before.rows, before, start, geometryKinds, placesBefore });
  }
  // The rows created, by the layer they are in
  if (input.created.length > 0) {
    const byLayer = new Map<string, number[]>();
    const layerIds = input.layerIds();
    let last: string | undefined;
    for (let i = 0; i < input.created.length; i++) {
      const ref = input.created[i];
      if (last === undefined || tables.get(last)?.getRowType(ref) == null) {
        last = layerIds.find((layerId) => tables.get(layerId)?.getRowType(ref) != null);
      }
      if (last === undefined) continue;
      let list = byLayer.get(last);
      if (!list) {
        list = [];
        byLayer.set(last, list);
      }
      list.push(ref);
    }
    for (const [layerId, list] of byLayer) {
      const start = ids.length;
      const refs = Int32Array.from(list);
      for (let i = 0; i < refs.length; i++) ids.push(tables.getRowId(refs[i]) ?? '');
      rows.push({
        layerId,
        rows: refs,
        before: undefined,
        start,
        geometryKinds: undefined,
        placesBefore: undefined,
      });
    }
    input.made?.(2 * byLayer.size + 1);
  }
  const { groups } = input;
  const groupCount =
    groups.created.length + groups.deleted.length + groups.moved.length + groups.updated.length;
  if (ids.length === 0 && groupCount === 0) return null;
  input.made?.(3);
  return new SharedValues(input.before ?? new Map(), { rows, ids, tracked, groups });
}

/**
 * Whether a row (by its reference) is among rows, looked up in them sorted once (false for none)
 */
function wholeRowsLookup(lists: readonly Int32Array[]): (ref: number) => boolean {
  let total = 0;
  for (const list of lists) total += list.length;
  if (total === 0) return () => false;
  const sorted = new Int32Array(total);
  let at = 0;
  for (const list of lists) {
    sorted.set(list, at);
    at += list.length;
  }
  sorted.sort();
  return (ref) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < ref) lo = mid + 1;
      else hi = mid;
    }
    return lo < sorted.length && sorted[lo] === ref;
  };
}

/**
 * The parents rows had before a change, each once, with the layer each one was or was in when the
 * change is told (see `ValueRows.placesBefore`): a layer is its own; a group there is in the layer
 * that holds its rows, and a group the change deleted in the layer it was deleted from. Undefined
 * when the change wrote no parent of the rows
 */
function placesBeforeOf(
  before: RowValues,
  input: {
    readonly tables: FeatureTables;
    readonly layerIds: () => readonly string[];
    readonly groups: GroupChanges;
    readonly made?: (count: number) => void;
  },
): ReadonlyMap<string, string | undefined> | undefined {
  const parents = before.fields.get('parent');
  if (!parents || parents.length === 0) return undefined;
  // Only the parents of the rows the change wrote the parent of
  const written = before.written?.get('parent');
  const { tables } = input;
  const places = new Map<string, string | undefined>();
  let layers: ReadonlySet<string> | undefined;
  let last: unknown;
  for (let i = 0; i < parents.length; i++) {
    if (written?.[i] === 0) continue;
    const parent = parents[i];
    // The rows of one parent mostly follow each other: each is looked up once
    if (i > 0 && parent === last) continue;
    last = parent;
    if (typeof parent !== 'string' || places.has(parent)) continue;
    layers ??= new Set(input.layerIds());
    if (layers.has(parent)) {
      places.set(parent, parent);
      continue;
    }
    const groupRef = tables.findGroup(parent);
    let layerId: string | undefined;
    if (groupRef !== undefined) {
      for (const id of layers) {
        if ((tables.get(id)?.countGroupMembers(groupRef) ?? 0) > 0) {
          layerId = id;
          break;
        }
      }
    }
    layerId ??= input.groups.deleted.find(({ group }) => group.id === parent)?.layerId;
    places.set(parent, layerId);
  }
  input.made?.(layers ? 2 : 1);
  return places;
}

/**
 * What a change did to the groups, read from the change of the layer and its summary: the groups
 * it created, those it deleted (with where they were), those it moved (with where they were), and
 * the values before of the keys it wrote of the others
 *
 * @internal
 */
export function groupChangesOf(
  groups:
    | {
        readonly created?: readonly Group[];
        readonly updated?: ReadonlyArray<{ id: string; group: Group; previous: Group }>;
        readonly deleted?: readonly Group[];
      }
    | undefined,
  moved: ReadonlyMap<string, { readonly layerId: string; readonly key: string }>,
  deletedPlaces: ReadonlyMap<string, { readonly layerId: string; readonly key: string }>,
): GroupChanges {
  if (!groups && moved.size === 0) return NO_GROUP_CHANGES;
  const created = (groups?.created ?? []).map((group) => group.id);
  const createdSet = new Set(created);
  const deleted: Array<{ group: Group; layerId: string; key: string }> = [];
  const deletedSet = new Set<string>();
  for (const group of groups?.deleted ?? []) {
    deletedSet.add(group.id);
    const place = deletedPlaces.get(group.id);
    if (createdSet.has(group.id) || !place) continue;
    deleted.push({ group, layerId: place.layerId, key: place.key });
  }
  const movedList: Array<{ id: string; layerId: string; key: string }> = [];
  for (const [id, place] of moved) {
    if (createdSet.has(id) || deletedSet.has(id)) continue;
    movedList.push({ id, layerId: place.layerId, key: place.key });
  }
  const updated: Array<{ id: string; patch: Partial<Pick<Group, 'name' | 'visible' | 'locked'>> }> =
    [];
  for (const { id, group, previous } of groups?.updated ?? []) {
    if (createdSet.has(id) || deletedSet.has(id)) continue;
    const patch: Partial<Pick<Group, 'name' | 'visible' | 'locked'>> = {};
    if (group.name !== previous.name) patch.name = previous.name;
    if (group.visible !== previous.visible) patch.visible = previous.visible;
    if (group.locked !== previous.locked) patch.locked = previous.locked;
    if (Object.keys(patch).length > 0) updated.push({ id, patch });
  }
  // A group created and deleted in the change is in neither
  const createdLeft = created.filter((id) => !deletedSet.has(id));
  if (
    createdLeft.length === 0 &&
    deleted.length === 0 &&
    movedList.length === 0 &&
    updated.length === 0
  ) {
    return NO_GROUP_CHANGES;
  }
  return { created: createdLeft, deleted, moved: movedList, updated };
}
