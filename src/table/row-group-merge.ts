// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Merges rows of row groups into new row groups (`mergeRowBlock`)
 *
 * The next version of a row group is the rows of the group that stay, and the rows that come into
 * its range, in the order of the table. Both are rows of groups already built: the rows of the
 * group itself, and rows built on their own (the rows changed since). The merge copies their
 * columns as they are, so nothing is computed again for a row that did not change: the numbers of
 * its caches are copied from its group (they are made only where a row was built), its bbox is
 * copied, its attributes are copied as their bytes (no value is decoded and written again). A merge too large for one group is cut into groups of the target sizes at once.
 *
 * The rows of the sources must hold the numbers of the table of styles of the document (a group
 * built in a Worker gets them when it is taken in), so a merge keeps the numbers as they are.
 *
 * A pure module: it depends on nothing outside `/table`, so it runs in a Worker as well, the
 * same function the main thread runs.
 */

import {
  type CoordinateDimensions,
  dimsWithin,
  type PropertyColumns,
  Utf8ColumnBuilder,
  VALUE_ABSENT,
  type ValueColumn,
  ValueColumnBuilder,
  valueEntryOf,
} from '@sakuzu/tabane';
import { KasaneError } from './kasane-error.js';
import { cacheNumbersOf, holdsCacheNumbers, RowCacheWriter } from './row-caches.js';
import {
  ChildBuilder,
  type GroupEntry,
  groupKeySource,
  ROW_BLOCK_TARGET_ROWS,
  ROW_BLOCK_TARGET_VERTICES,
} from './row-group-builder.js';
import type {
  RowBlock,
  RowBlockData,
  RowBlockDictionary,
  RowBlockValues,
  RowBlockWhole,
} from './row-group-types.js';
import { compareRowKeys, type GroupKeySource } from './row-keys.js';
import { INT8_FORMS, type ShapeColumn } from './shape-reader.js';

/**
 * What {@link mergeRowBlock} merges
 */
export interface RowBlockMerge {
  /**
   * The row blocks the rows are taken from (the values of their columns kept by the tables
   * numbered: no `dictionary`)
   */
  readonly sources: readonly RowBlock[];
  /**
   * The rows taken, two numbers each: the source and the row there (`[source, row, ...]`). A row
   * is taken once
   */
  readonly rows: Int32Array;
  /** The groups of features the rows name (their keys order their members) */
  readonly groups?: readonly GroupEntry[] | null;
  /** Whether the rows are put in the order of the table (true when omitted) */
  readonly sort?: boolean;
  /** The target number of rows of a row block ({@link ROW_BLOCK_TARGET_ROWS} when omitted) */
  readonly targetRows?: number;
  /** The target number of coordinates of a row block ({@link ROW_BLOCK_TARGET_VERTICES} when omitted) */
  readonly targetVertices?: number;
  /**
   * The share of the targets past which the rows are cut into row blocks of the target sizes (1 when
   * omitted: cut at the targets). The next version of a row block is cut only past twice the targets
   * (2), so a row block that grew a little stays one row block
   */
  readonly cutPast?: number;
  /**
   * The dimensions of the coordinates of the new row blocks: those of the table. A source of fewer
   * dimensions is copied with NaN for the others (a table whose dimensions were raised). Every
   * source has the same when omitted
   */
  readonly dimensions?: CoordinateDimensions;
  /**
   * The number of coordinates a row that draws a ring around its point (a row of a Point with a
   * fill) is counted as when the rows are cut into row blocks (`RowRings.ringVertices`; 1 when
   * omitted)
   */
  readonly ringVertices?: number;
}

/**
 * What the tables merge: row blocks with every column, and the groups of features as the tables
 * read them
 *
 * @internal
 */
export interface RowBlockDataMerge extends Omit<RowBlockMerge, 'sources' | 'groups'> {
  readonly sources: readonly RowBlockData[];
  readonly groups?: readonly GroupEntry[] | GroupKeySource | null;
}

/**
 * Merges rows of row blocks into new row blocks, in the order of the table
 *
 * @returns The new row blocks (none for no row); their handles are those of the rows
 * @throws `KasaneError` with the code `invalid-input` when a source holds styles not numbered yet,
 *   or `not-found` when a row names a group of features the keys do not give
 */
export function mergeRowBlock(merge: RowBlockMerge): RowBlock[] {
  return mergeRowBlockData(merge as RowBlockDataMerge);
}

/**
 * Merges rows of row blocks into new row blocks, as the tables merge them
 *
 * @internal
 */
export function mergeRowBlockData(merge: RowBlockDataMerge): RowBlockData[] {
  const { sources, rows } = merge;
  for (const source of sources) {
    for (const whole of source.wholes) {
      if (whole && 'dictionary' in whole && whole.dictionary) {
        throw new KasaneError(
          'invalid-input',
          'mergeRowBlock: the values of a column of a source are not numbered',
        );
      }
    }
  }
  const count = rows.length / 2;
  if (count === 0) return [];
  const dims = mergeDims(sources, merge.dimensions);
  const shape: MergeShape = {
    dims,
    ringVertices: merge.ringVertices ?? 1,
    shapes: sources[0].shapes.length,
    wholes: sources[0].wholes.length,
    keyed: sources[0].keyed.length,
  };
  const keys = isKeySource(merge.groups)
    ? merge.groups
    : groupKeySource((merge.groups as readonly GroupEntry[] | null | undefined) ?? []);
  // The rows in the order of the table
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  if (merge.sort !== false) {
    order.sort((a, b) =>
      compareRowKeys(
        sources[rows[a * 2]],
        rows[a * 2 + 1],
        sources[rows[b * 2]],
        rows[b * 2 + 1],
        keys,
      ),
    );
  }
  const vertices = new Int32Array(count);
  let total = 0;
  for (let i = 0; i < count; i++) {
    vertices[i] = vertexCountOf(sources[rows[i * 2]], rows[i * 2 + 1], shape.ringVertices);
    total += vertices[i];
  }
  const targetRows = Math.max(1, merge.targetRows ?? ROW_BLOCK_TARGET_ROWS);
  const targetVertices = Math.max(1, merge.targetVertices ?? ROW_BLOCK_TARGET_VERTICES);
  const past = Math.max(1, merge.cutPast ?? 1);
  // One group while the rows are within the targets times the share
  if (count <= targetRows * past && total <= targetVertices * past) {
    return [copyRows(sources, rows, order, vertices, shape)];
  }
  const out: RowBlockData[] = [];
  let start = 0;
  while (start < count) {
    let end = start;
    let sum = 0;
    while (end < count && end - start < targetRows) {
      const n = vertices[order[end]];
      if (end > start && sum + n > targetVertices) break;
      sum += n;
      end++;
    }
    out.push(copyRows(sources, rows, order.subarray(start, end), vertices, shape));
    start = end;
  }
  return out;
}

/** What the new groups of a merge are made of */
interface MergeShape {
  readonly dims: CoordinateDimensions;
  readonly ringVertices: number;
  /** The number of columns of each kind (the same in every source) */
  readonly shapes: number;
  readonly wholes: number;
  readonly keyed: number;
}

/**
 * The dimensions of the new groups of a merge: the ones given, which hold those of every source,
 * or the ones every source has
 *
 * @throws when a source has a dimension the ones given do not, or when the sources have
 *   different ones and none are given
 */
function mergeDims(
  sources: readonly RowBlockData[],
  given: CoordinateDimensions | undefined,
): CoordinateDimensions {
  let dims = given;
  for (const source of sources) {
    for (const child of source.shapes.flatMap((shape) => shape?.children ?? [])) {
      const own = child.dimensions ?? 'xy';
      if (dims === undefined) dims = own;
      else if (given === undefined ? own !== dims : !dimsWithin(own, dims)) {
        throw new KasaneError(
          'invalid-input',
          `mergeRowBlock: a source has coordinates of ${own}, the merge ${given === undefined ? 'has' : 'makes'} ${dims}`,
        );
      }
    }
  }
  return dims ?? 'xy';
}

/** Whether the groups of a merge are given as the keys themselves */
function isKeySource(groups: RowBlockDataMerge['groups']): groups is GroupKeySource {
  return groups !== null && groups !== undefined && !Array.isArray(groups);
}

/**
 * The number of points a row draws (the estimate of the work of a group), of its shapes: a
 * single point with numbers in a cache draws a ring around it
 */
function vertexCountOf(data: RowBlockData, row: number, ringVertices: number): number {
  let count = 0;
  for (const shape of data.shapes) {
    if (!shape) continue;
    const child = shape.types[row];
    if (child < 0) continue;
    const column = shape.children[child];
    const at = shape.offsets[row];
    if (column.type === 'Point') {
      // A row of a single point that keeps numbers in a cache draws a ring around it
      count += holdsCacheNumbers(data.caches, row) ? ringVertices : 1;
      continue;
    }
    let first = at;
    let end = at + 1;
    for (const level of column.offsets ?? []) {
      first = level[first];
      end = level[end];
    }
    count += end - first;
  }
  return count;
}

/** Copies the rows `order` (indices into the pairs of `rows`) into one group */
function copyRows(
  sources: readonly RowBlockData[],
  rows: Int32Array,
  order: Int32Array,
  vertices: Int32Array,
  shape: MergeShape,
): RowBlockData {
  const length = order.length;
  const handles = new Int32Array(length);
  const ids = new Utf8ColumnBuilder(length);
  const idHashes = new Uint32Array(length);
  const keys = new Utf8ColumnBuilder(length);
  const groups = new Int32Array(length);
  const flags = new Uint8Array(length);
  const shapes = Array.from({ length: shape.shapes }, () => new ShapeCopy(length, shape.dims));
  const wholes = Array.from({ length: shape.wholes }, (_, w) => wholeCopyOf(sources, w, length));
  const keyed = Array.from({ length: shape.keyed }, () => new Map<string, ValueColumnBuilder>());
  const rowBounds = new Float64Array(length * 4);
  const caches = cacheWritersOf(sources, length);
  // The column of each cache in each source (null for a source that does not hold it)
  const columnsOf = sources.map((source) =>
    caches.map((cache) => source.caches.find((c) => c.name === cache.name) ?? null),
  );
  let vertexCount = 0;

  for (let r = 0; r < length; r++) {
    const pair = order[r];
    const data = sources[rows[pair * 2]];
    const row = rows[pair * 2 + 1];
    handles[r] = data.handles[row];
    ids.addEntry(data.ids, row);
    idHashes[r] = data.idHashes[row];
    keys.addEntry(data.keys, row);
    groups[r] = data.groups[row];
    flags[r] = data.flags[row];
    for (let w = 0; w < wholes.length; w++) wholes[w]?.copy(r, data.wholes[w], row);

    // The values of the keyed columns, by key, copied as their bytes (no value is decoded)
    for (let k = 0; k < keyed.length; k++) {
      const from = data.keyed[k];
      if (!from) continue;
      const { keys, columns } = from;
      const builders = keyed[k];
      for (let c = 0; c < keys.length; c++) {
        const column = columns[c] as ValueColumn;
        const entry = valueEntryOf(column, row);
        if (entry < 0 || column.tags[entry] === VALUE_ABSENT) continue;
        let builder = builders.get(keys[c]);
        if (!builder) {
          builder = new ValueColumnBuilder(length);
          builders.set(keys[c], builder);
        }
        builder.copy(r, column, entry);
      }
    }

    for (let k = 0; k < 4; k++) rowBounds[r * 4 + k] = data.rowBounds[row * 4 + k];
    // The numbers of the caches, in the column of the same name (a row keeps them as wide as they
    // were)
    const cacheColumns = columnsOf[rows[pair * 2]];
    for (let c = 0; c < caches.length; c++) {
      const column = cacheColumns[c];
      if (!column) {
        caches[c].writer.skip(r);
        continue;
      }
      const numbers = cacheNumbersOf(column, row);
      caches[c].writer.put(r, numbers, 0, numbers.length, numbers instanceof Uint32Array);
    }

    for (let k = 0; k < shapes.length; k++) shapes[k].copy(r, data.shapes[k], row);
    vertexCount += vertices[pair];
  }

  return {
    length,
    handles,
    ids: ids.finish(),
    idHashes,
    shapes: shapes.map((copy) => copy.finish()),
    wholes: wholes.map((copy) => copy?.finish() ?? null),
    keyed: keyed.map((builders): PropertyColumns | null => {
      if (builders.size === 0) return null;
      const keys = [...builders.keys()];
      return {
        keys,
        columns: keys.map((key) => (builders.get(key) as ValueColumnBuilder).finish()),
      };
    }),
    keys: keys.finish(),
    groups,
    flags,
    rowBounds,
    caches: caches.map((cache) => cache.writer.finish()),
    vertexCount,
  };
}

/**
 * The writers of the caches of the rows of a merge: one per name of a cache of the sources, of
 * the width of the first that holds it, in the order of the first sources
 */
function cacheWritersOf(
  sources: readonly RowBlockData[],
  length: number,
): Array<{ name: string; writer: RowCacheWriter }> {
  const out: Array<{ name: string; writer: RowCacheWriter }> = [];
  for (const source of sources) {
    for (const column of source.caches) {
      if (out.some((cache) => cache.name === column.name)) continue;
      const width = column.numbers instanceof Uint32Array ? 32 : 16;
      out.push({ name: column.name, writer: new RowCacheWriter(column.name, width, length) });
    }
  }
  return out;
}

/** The rows of a `shape` column copied into a new row block (null when no row has a shape) */
class ShapeCopy {
  /** The form of each row: an `Int8Array`, made an `Int16Array` past `INT8_FORMS` forms */
  private types: Int8Array | Int16Array;
  private readonly rows: Int32Array;
  private readonly children: ChildBuilder[] = [];
  /** The place of each form in `children`, by its depth and its name */
  private readonly childIndex = new Map<string, number>();

  constructor(
    length: number,
    private readonly dims: CoordinateDimensions,
  ) {
    this.types = new Int8Array(length).fill(-1);
    this.rows = new Int32Array(length);
  }

  /** Copies the shape of a row of a source to row `r` */
  copy(r: number, from: ShapeColumn | null, row: number): void {
    if (!from) return;
    const child = from.types[row];
    if (child < 0) return;
    const column = from.children[child];
    const depth = column.offsets?.length ?? 0;
    const key = `${depth}:${column.type}`;
    let target = this.childIndex.get(key);
    if (target === undefined) {
      target = this.children.length;
      if (target === INT8_FORMS && this.types instanceof Int8Array) {
        const wide = new Int16Array(this.types.length);
        wide.set(this.types);
        this.types = wide;
      }
      this.children.push(new ChildBuilder(column.type, depth, this.dims));
      this.childIndex.set(key, target);
    }
    this.types[r] = target;
    this.rows[r] = this.children[target].addOfColumn(column, from.offsets[row]);
  }

  finish(): ShapeColumn | null {
    if (this.children.length === 0) return null;
    return {
      types: this.types,
      offsets: this.rows,
      children: this.children.map((child) => child.finish()),
    };
  }
}

/**
 * The rows of a `whole` column copied into a new row block: the numbers of the tables as they
 * are (a column the tables keep the values of), or the values each different one once (a column
 * each row block keeps the values of). Null for a column no source holds
 */
function wholeCopyOf(
  sources: readonly RowBlockData[],
  w: number,
  length: number,
): NumberCopy | ValueCopy | null {
  for (const source of sources) {
    const whole = source.wholes[w];
    if (whole) return 'values' in whole ? new ValueCopy(length) : new NumberCopy(length);
  }
  return null;
}

/** The numbers of the tables of the rows of a `whole` column, copied as they are */
class NumberCopy {
  private readonly indexes: Uint32Array;
  private any = false;

  constructor(length: number) {
    this.indexes = new Uint32Array(length);
  }

  copy(r: number, from: RowBlockWhole | null, row: number): void {
    if (!from) return;
    this.indexes[r] = from.indexes[row];
    this.any = true;
  }

  finish(): RowBlockDictionary | null {
    return this.any ? { indexes: this.indexes, dictionary: null } : null;
  }
}

/** The values of the rows of a `whole` column, each different value once */
class ValueCopy {
  private readonly indexes: Uint8Array;
  private readonly values: unknown[] = [];
  private readonly index = new Map<unknown, number>();

  constructor(length: number) {
    this.indexes = new Uint8Array(length);
  }

  copy(r: number, from: RowBlockWhole | null, row: number): void {
    if (!from) return;
    const value = (from as RowBlockValues).values[from.indexes[row]];
    let at = this.index.get(value);
    if (at === undefined) {
      if (this.values.length >= 255) {
        throw new KasaneError(
          'invalid-input',
          'mergeRowBlock: more than 255 values of a column in a row block',
        );
      }
      at = this.values.length;
      this.values.push(value);
      this.index.set(value, at);
    }
    this.indexes[r] = at;
  }

  finish(): RowBlockValues | null {
    return this.values.length > 0 ? { indexes: this.indexes, values: this.values } : null;
  }
}
