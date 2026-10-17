// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reads the bytes of a row block of the Tabane format into columns of typed arrays
 *
 * The columns are those of the rows of the tables (`RowBlock`): the geometry in the layout of
 * GeoArrow, the styles as a dictionary of their canonical bytes, the attributes as a column of
 * values per key. Reading writes every value once into its array: no object is made per row.
 *
 * A pure module: it depends on nothing outside `/table`, so it runs in a Worker as well.
 */

import { strideOf } from '../coordinates.js';
import type { TableGeometry, TableMixedGeometry } from '../types.js';
import type { Utf8Column } from '../utf8-column.js';
import {
  VALUE_ABSENT,
  VALUE_FALSE,
  VALUE_NESTED,
  VALUE_NULL,
  VALUE_NUMBER,
  VALUE_OTHER,
  VALUE_STRING,
  VALUE_TRUE,
  type ValueColumn,
} from '../value-column.js';
import { ByteSource, formatError } from './bytes.js';
import { POW10 } from './decimals.js';
import { originOf } from './ids.js';
import {
  DIMENSIONS,
  GEOMETRY_TYPES,
  TAG_ABSENT,
  TAG_FALSE,
  TAG_FLOAT,
  TAG_INTEGER,
  TAG_NESTED,
  TAG_NULL,
  TAG_OTHER,
  TAG_STRING,
  TAG_TRUE,
} from './row-block-write.js';
import type {
  TabaneFills,
  TabaneRevision,
  TabaneRevisions,
  TabaneRowBlock,
  TabaneRowBlockData,
} from './types.js';
import { XorSource } from './xor.js';

/** The kind of a value of the rows, by the tag of the format */
const VALUE_OF_TAG = [
  VALUE_ABSENT,
  VALUE_NULL,
  VALUE_FALSE,
  VALUE_TRUE,
  VALUE_NUMBER,
  VALUE_STRING,
  VALUE_NESTED,
  VALUE_NUMBER,
  VALUE_OTHER,
];

/** The most rows of a row block */
export const MAX_ROW_BLOCK_ROWS = 1 << 20;

/**
 * Reads a row block
 *
 * @param bytes The bytes of the row block (`[start, end)`)
 * @throws `DrawError` with the code `unsupported-format` when the bytes are not a row block
 *
 * @experimental
 */
export function readTabaneRowBlock(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): TabaneRowBlock {
  return readRowBlockData(bytes, start, end);
}

/**
 * Reads a row block with every column
 *
 * @internal
 */
export function readRowBlockData(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): TabaneRowBlockData {
  const r = new ByteSource(bytes, start, end);
  const n = r.uint();
  if (n < 1 || n > MAX_ROW_BLOCK_ROWS) throw formatError(`a row block of ${n} rows`);

  const originCount = r.count(8);
  const origins: string[] = [];
  for (let k = 0; k < originCount; k++) origins.push(originOf(r.take(8)));
  const originAt = (): string => {
    const i = r.uint();
    if (i >= origins.length) throw formatError('an origin out of the table');
    return origins[i];
  };

  // The ids
  const runCount = r.count(3);
  const ids: (readonly [string, number, number])[] = [];
  let covered = 0;
  for (let k = 0; k < runCount; k++) {
    const origin = originAt();
    const first = r.uint();
    const count = r.uint();
    if (first < 1 || count < 1 || first + count - 1 > Number.MAX_SAFE_INTEGER)
      throw formatError('a run of ids out of their range');
    ids.push([origin, first, count]);
    covered += count;
  }
  if (covered !== n) throw formatError('the runs of ids do not cover the rows');

  // The place
  const parent = r.string();
  const keyMode = r.byte();
  if (keyMode !== 0) throw formatError(`a form of the keys of ${keyMode}`);
  const head = r.string();
  const firstIndex = r.uint();

  // What created the rows
  let created: (readonly [TabaneRevision, number])[] | null = null;
  const createdMode = r.byte();
  if (createdMode === 1) {
    created = [];
    const runs = r.count(4);
    let sum = 0;
    for (let k = 0; k < runs; k++) {
      const sequence = r.uint();
      const origin = originAt();
      const step = r.uint();
      const count = r.uint();
      if (count < 1) throw formatError('an empty run of revisions');
      created.push([[sequence, origin, step], count]);
      sum += count;
    }
    if (sum !== n) throw formatError('the runs of what created the rows do not cover them');
  } else if (createdMode !== 0) {
    throw formatError(`a form of what created the rows of ${createdMode}`);
  }

  // The flags of the rows: the deleted rows, the hidden rows, the locked rows
  const flagsMode = r.byte();
  if (flagsMode > 7) throw formatError(`a form of the flags of the rows of ${flagsMode}`);
  const [deleted, hidden, locked] = [1, 2, 4].map((bit) => {
    if ((flagsMode & bit) === 0) return null;
    const bits = r.take((n + 7) >> 3).slice();
    if (n & 7 && bits[bits.length - 1] >> (n & 7)) throw formatError('a bit past the rows');
    return bits;
  });

  // The types
  const typeCount = r.count();
  if (typeCount < 1 || typeCount > 255) throw formatError('a row block of no type or of too many');
  const typeNames: string[] = [];
  for (let k = 0; k < typeCount; k++) typeNames.push(r.string());
  const types = typeCount > 1 ? r.take(n).slice() : new Uint8Array(n);
  if (typeCount > 1)
    for (const t of types) if (t >= typeCount) throw formatError('a type out of the names');

  // The geometry and the fills
  const dimsCode = r.byte();
  const dimensions = DIMENSIONS[dimsCode];
  if (!dimensions) throw formatError(`dimensions of ${dimsCode}`);
  const geometry = readGeometry(r, n, strideOf(dimensions), dimensions);
  const fillsMode = r.byte();
  let fills: TabaneFills | null = null;
  if (fillsMode === 1) fills = readFills(r, n, geometry);
  else if (fillsMode !== 0) throw formatError(`a form of the fills of ${fillsMode}`);

  // The styles
  const styleCount = r.count();
  if (styleCount < 1) throw formatError('a row block of no style');
  const styleDictionary = readDictionary(r, styleCount);
  for (let k = 0; k < styleCount; k++) {
    const at = styleDictionary.offsets[k];
    if (at === styleDictionary.offsets[k + 1] || styleDictionary.bytes[at] !== 7)
      throw formatError('a style that is not an object');
  }
  const styles = new Uint32Array(n);
  if (styleCount > 1) {
    for (let i = 0; i < n; i++) {
      const s = r.uint();
      if (s >= styleCount) throw formatError('a style out of the dictionary');
      styles[i] = s;
    }
  }

  // The attributes
  const columnCount = r.count();
  const keys: string[] = [];
  const columns: ValueColumn[] = [];
  for (let c = 0; c < columnCount; c++) {
    keys.push(r.string());
    columns.push(readColumn(r, n));
  }

  // The cells changed after their rows were created
  const revisions = readRevisions(r, n, origins);

  if (!r.done) throw formatError('bytes are left after the row block');
  return {
    length: n,
    ids,
    place: { parent, head, firstIndex },
    created,
    deleted,
    hidden,
    locked,
    typeNames,
    types,
    dimensions,
    geometry,
    fills,
    styleDictionary,
    styles,
    properties: { keys, columns },
    revisions,
  };
}

/** A dictionary of `count` runs of bytes, as a column */
function readDictionary(r: ByteSource, count: number): Utf8Column {
  const offsets = new Int32Array(count + 1);
  const start = r.pos;
  // The lengths first, to make one array of the bytes; the runs are copied byte by byte, so no
  // view is made for each
  let total = 0;
  for (let k = 0; k < count; k++) {
    const len = r.uint();
    r.skip(len);
    total += len;
    offsets[k + 1] = total;
  }
  const bytes = new Uint8Array(total);
  const source = r.buf;
  r.pos = start;
  for (let k = 0; k < count; k++) {
    const len = r.uint();
    const from = r.skip(len);
    const to = offsets[k];
    for (let j = 0; j < len; j++) bytes[to + j] = source[from + j];
  }
  return { offsets, bytes };
}

// === Geometry ===

function readGeometry(
  r: ByteSource,
  n: number,
  stride: number,
  dimensions: TableGeometry['dimensions'],
): TableMixedGeometry {
  const childCount = r.count();
  if (childCount > GEOMETRY_TYPES.length) throw formatError('too many geometry columns');
  const childTypes: number[] = [];
  for (let c = 0; c < childCount; c++) {
    const t = r.byte();
    if (t >= GEOMETRY_TYPES.length || childTypes.includes(t))
      throw formatError(`a geometry column of ${t}`);
    childTypes.push(t);
  }
  const types = new Int8Array(n).fill(-1);
  const offsets = new Int32Array(n);
  const childRows = new Int32Array(childCount);
  if (childCount > 0) {
    const of = r.take(n);
    for (let i = 0; i < n; i++) {
      const c = of[i];
      if (c > childCount) throw formatError('a row of a geometry column that is not there');
      if (c === 0) continue;
      types[i] = c - 1;
      offsets[i] = childRows[c - 1]++;
    }
  }
  const children: TableGeometry[] = [];
  for (let c = 0; c < childCount; c++) {
    children.push(readChild(r, childTypes[c], childRows[c], stride, dimensions));
  }
  return { type: 'Mixed', types, offsets, children };
}

/** The counts of a level as offsets (`count + 1` values from 0) */
function levelOffsets(r: ByteSource, count: number): Int32Array {
  const run = r.run();
  const s = new ByteSource(run);
  const out = new Int32Array(count + 1);
  let at = 0;
  for (let k = 0; k < count; k++) {
    at += s.uint();
    if (at > 0x7fffffff) throw formatError('a geometry too large');
    out[k + 1] = at;
  }
  if (!s.done) throw formatError('bytes are left after the counts of a level');
  return out;
}

function readChild(
  r: ByteSource,
  typeCode: number,
  rows: number,
  stride: number,
  dimensions: TableGeometry['dimensions'],
): TableGeometry {
  const type = GEOMETRY_TYPES[typeCode];
  let levels: Int32Array[] = [];
  let vertices = rows;
  switch (type) {
    case 'Point':
      break;
    case 'LineString':
    case 'MultiPoint': {
      const l0 = levelOffsets(r, rows);
      levels = [l0];
      vertices = l0[rows];
      break;
    }
    case 'Polygon':
    case 'MultiLineString': {
      const l0 = levelOffsets(r, rows);
      const l1 = levelOffsets(r, l0[rows]);
      levels = [l0, l1];
      vertices = l1[l0[rows]];
      break;
    }
    case 'MultiPolygon': {
      const l0 = levelOffsets(r, rows);
      const l1 = levelOffsets(r, l0[rows]);
      const l2 = levelOffsets(r, l1[l0[rows]]);
      levels = [l0, l1, l2];
      vertices = l2[l1[l0[rows]]];
      break;
    }
  }
  // The vertices of each row of the child
  const rowVertex = (row: number): number => {
    let v = row;
    for (const l of levels) v = l[v];
    return v;
  };

  const scale = r.int();
  if (scale < -1 || scale >= POW10.length) throw formatError(`a scale of ${scale}`);
  let modes: Uint8Array | null = null;
  const decimals: ByteSource[] = [];
  // Every value takes at least a byte of the decimals or a bit of the floats
  let bound = 0;
  if (scale >= 0) {
    modes = r.take((rows + 7) >> 3);
    if (rows & 7 && modes[modes.length - 1] >> (rows & 7)) throw formatError('a bit past the rows');
    for (let d = 0; d < stride; d++) {
      const run = r.run();
      bound += run.length;
      decimals.push(new ByteSource(run));
    }
  }
  const xors: XorSource[] = [];
  for (let d = 0; d < stride; d++) {
    const run = r.run();
    bound += run.length * 8;
    xors.push(new XorSource(run));
  }
  if (vertices * stride > bound) throw formatError('more coordinates than their bytes hold');
  const coords = new Float64Array(vertices * stride);
  const divisor = scale >= 0 ? POW10[scale] : 1;
  const previous = new Array<number>(stride).fill(0);
  let at = 0;
  for (let row = 0; row < rows; row++) {
    const end = rowVertex(row + 1) * stride;
    if (modes && modes[row >> 3] & (1 << (row & 7))) {
      for (; at < end; at += stride) {
        for (let d = 0; d < stride; d++) {
          previous[d] += decimals[d].int();
          coords[at + d] = previous[d] / divisor;
        }
      }
    } else {
      for (; at < end; at += stride) {
        for (let d = 0; d < stride; d++) coords[at + d] = xors[d].get();
      }
    }
  }
  for (const s of decimals) if (!s.done) throw formatError('bytes are left after the coordinates');
  for (const x of xors)
    if (!x.finished()) throw formatError('bytes are left after the coordinates');
  return levels.length > 0
    ? { type, coords, dimensions, offsets: levels }
    : { type, coords, dimensions };
}

// === Fills ===

function readFills(r: ByteSource, n: number, geometry: TableMixedGeometry): TabaneFills {
  const heads = new ByteSource(r.run());
  const indexRun = r.run();
  const indexSource = new ByteSource(indexRun);
  const vertices = new Int32Array(n).fill(-1);
  const offsets = new Int32Array(n + 1);
  // At most one index per byte
  const indices = new Uint32Array(indexRun.length);
  let at = 0;
  for (let i = 0; i < n; i++) {
    const c = geometry.types[i];
    const type = c >= 0 ? geometry.children[c].type : null;
    if (type === 'Polygon' || type === 'MultiPolygon') {
      const v = heads.uint();
      const pairs = heads.uint();
      vertices[i] = v;
      for (let k = 0; k < pairs * 4; k++) {
        const index = indexSource.uint();
        if (index >= v) throw formatError('an index of a fill past its vertices');
        indices[at++] = index;
      }
    }
    offsets[i + 1] = at;
  }
  if (!heads.done || !indexSource.done) throw formatError('bytes are left after the fills');
  return { vertices, offsets, indices: indices.slice(0, at) };
}

// === Attributes ===

function readColumn(r: ByteSource, n: number): ValueColumn {
  const form = r.byte();
  if (form !== 0 && form !== 1) throw formatError(`a form of a column of ${form}`);
  let rows: Int32Array | null = null;
  let count = n;
  if (form === 1) {
    count = r.count();
    if (count > n) throw formatError('a sparse column of more entries than rows');
    rows = new Int32Array(count);
    let previous = -1;
    for (let k = 0; k < count; k++) {
      previous += r.uint() + 1;
      if (previous >= n) throw formatError('an entry past the rows');
      rows[k] = previous;
    }
  }
  const tagBytes = r.take(count);
  const integers = new ByteSource(r.run());
  const floats = new XorSource(r.run());
  const refSource = new ByteSource(r.run());
  const dictionaryCount = r.count();
  const dictionary = readDictionary(r, dictionaryCount);
  let textEntries = 0;

  const tags = new Uint8Array(count);
  let numbers: Float64Array | null = null;
  let refs: Int32Array | null = null;
  for (let k = 0; k < count; k++) {
    const tag = tagBytes[k];
    if (tag > TAG_OTHER) throw formatError(`a value of the tag ${tag}`);
    if (tag === TAG_ABSENT && rows) throw formatError('an absent entry in a sparse column');
    tags[k] = VALUE_OF_TAG[tag];
    switch (tag) {
      case TAG_INTEGER:
        numbers ??= new Float64Array(count);
        numbers[k] = integers.int();
        break;
      case TAG_FLOAT:
        numbers ??= new Float64Array(count);
        numbers[k] = floats.get();
        break;
      case TAG_STRING:
      case TAG_NESTED:
      case TAG_OTHER: {
        refs ??= new Int32Array(count);
        const ref = refSource.uint();
        if (ref >= dictionaryCount) throw formatError('a value out of the dictionary');
        // A nested value is an array or an object, a value of another kind one of the kinds 8 to
        // 15 of the canonical bytes
        if (tag !== TAG_STRING) {
          const kind =
            dictionary.offsets[ref] < dictionary.offsets[ref + 1]
              ? dictionary.bytes[dictionary.offsets[ref]]
              : -1;
          const nested = kind === 6 || kind === 7;
          const other = kind >= 8 && kind <= 15;
          if (tag === TAG_NESTED ? !nested : !other) {
            throw formatError(`a value of the kind ${kind} under the tag ${tag}`);
          }
        }
        refs[k] = ref;
        textEntries++;
        break;
      }
      case TAG_NULL:
      case TAG_FALSE:
      case TAG_TRUE:
      case TAG_ABSENT:
        break;
    }
  }
  if (!integers.done || !floats.finished() || !refSource.done)
    throw formatError('bytes are left after a column');
  if (textEntries === 0 && dictionaryCount > 0) throw formatError('a dictionary no entry names');
  return {
    form: rows ? 'sparse' : 'dense',
    length: n,
    rows,
    tags,
    numbers,
    refs,
    values: refs ? dictionary : null,
  };
}

// === Revisions ===

function readRevisions(r: ByteSource, n: number, origins: readonly string[]): TabaneRevisions {
  const nameCount = r.count();
  const names: string[] = [];
  for (let k = 0; k < nameCount; k++) names.push(r.string());
  const count = r.count(5);
  const rows = new Int32Array(count);
  const cells = new Int32Array(count);
  const sequences = new Float64Array(count);
  const originIndex = new Int32Array(count);
  const steps = new Float64Array(count);
  let row = 0;
  for (let k = 0; k < count; k++) {
    row += r.uint();
    if (row >= n) throw formatError('a revision past the rows');
    rows[k] = row;
    cells[k] = r.uint();
    if (cells[k] >= nameCount) throw formatError('a revision of a cell out of the names');
    sequences[k] = r.uint();
    originIndex[k] = r.uint();
    if (originIndex[k] >= origins.length) throw formatError('an origin out of the table');
    steps[k] = r.uint();
  }
  return { names, rows, cells, sequences, origins, originIndex, steps };
}
