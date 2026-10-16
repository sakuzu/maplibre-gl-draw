// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Writes the bytes of a row block of the Tabane format (`README.md` of this folder, "A
 * row block")
 *
 * Every choice the writer makes is fixed by the rows, so the same rows always give the same
 * bytes, in every implementation of the format.
 *
 * A pure module: it depends on nothing outside `/table`, so it runs in a Worker as well.
 */

import { DrawError } from '../../shared/draw-error.js';
import { encodeCanonicalValue } from '../canonical-value.js';
import { type CoordinateDimensions, strideOf } from '../coordinates.js';
import {
  polygonRanges,
  type RowGeometry,
  ringOffsetsOf,
  toRowGeometry,
  triangulateRow,
} from '../row-geometry.js';
import type { GeometryType } from '../types.js';
import { VALUE_OTHER, valueTagOf } from '../value-column.js';
import { wellFormed } from '../value-kinds.js';
import { ByteSink, compareBytes, utf8Of } from './bytes.js';
import { decimalAt, fewestDecimals } from './decimals.js';
import { originBytes, parseTabaneId } from './ids.js';
import type { TabanePlace, TabaneRevision, TabaneRow } from './types.js';
import { XorSink } from './xor.js';

/** The geometry types, by their number in the format */
export const GEOMETRY_TYPES: readonly GeometryType[] = [
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
];

/** The dimensions, by their number in the format */
export const DIMENSIONS: readonly CoordinateDimensions[] = ['xy', 'xyz', 'xym', 'xyzm'];

/** The kinds of the entries of a column of values */
export const TAG_ABSENT = 0;
export const TAG_NULL = 1;
export const TAG_FALSE = 2;
export const TAG_TRUE = 3;
export const TAG_FLOAT = 4;
export const TAG_STRING = 5;
export const TAG_NESTED = 6;
export const TAG_INTEGER = 7;
export const TAG_OTHER = 8;

/**
 * What a row block is written from
 *
 * @internal
 */
export interface RowBlockInput {
  readonly place: TabanePlace;
  readonly dimensions: CoordinateDimensions;
  readonly rows: readonly TabaneRow[];
  /** Whether the fills of the polygon rows are written */
  readonly fills: boolean;
}

function invalid(message: string): DrawError {
  return new DrawError('invalid-input', `Tabane: ${message}`);
}

/** The origins a row block names, numbered in the order they are first named */
class Origins {
  readonly list: string[] = [];
  private readonly index = new Map<string, number>();

  of(origin: string): number {
    let i = this.index.get(origin);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(origin);
      this.index.set(origin, i);
    }
    return i;
  }
}

function sameRevision(a: TabaneRevision, b: TabaneRevision): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function checkRevision(r: TabaneRevision): void {
  if (
    !Array.isArray(r) ||
    r.length !== 3 ||
    !Number.isSafeInteger(r[0]) ||
    r[0] < 0 ||
    !Number.isSafeInteger(r[2]) ||
    r[2] < 0
  )
    throw invalid(`not a revision: ${JSON.stringify(r)}`);
  originBytes(r[1]);
}

/**
 * The bytes of a row block
 *
 * @throws `DrawError` with the code `invalid-input` when a row cannot be written
 * @internal
 */
export function writeRowBlock(input: RowBlockInput): Uint8Array {
  const { rows, place, dimensions } = input;
  const n = rows.length;
  if (n === 0) throw invalid('a row block holds at least one row');
  const out = new ByteSink(n * 64);
  const origins = new Origins();

  // The ids, as runs
  const idRuns: number[] = [];
  for (let i = 0; i < n; ) {
    const id = parseTabaneId(rows[i].id);
    if (!id) throw invalid(`not an id: ${rows[i].id}`);
    let len = 1;
    while (i + len < n) {
      const next = parseTabaneId(rows[i + len].id);
      if (!next) throw invalid(`not an id: ${rows[i + len].id}`);
      if (next.origin !== id.origin || next.number !== id.number + len) break;
      len++;
    }
    idRuns.push(origins.of(id.origin), id.number, len);
    i += len;
  }

  // What created the rows, as runs
  const createdRuns: number[] = [];
  const withCreated = rows.filter((r) => r.created !== undefined).length;
  if (withCreated !== 0 && withCreated !== n)
    throw invalid('every row of a row block says what created it, or none does');
  if (withCreated === n) {
    for (let i = 0; i < n; ) {
      const created = rows[i].created as TabaneRevision;
      checkRevision(created);
      let len = 1;
      while (i + len < n && sameRevision(rows[i + len].created as TabaneRevision, created)) len++;
      createdRuns.push(created[0], origins.of(created[1]), created[2], len);
      i += len;
    }
  }

  // The cells changed after their rows were created
  const cellNames = new Set<string>();
  for (const row of rows) {
    if (!row.revisions) continue;
    for (const [name, r] of Object.entries(row.revisions)) {
      checkRevision(r);
      cellNames.add(name);
    }
  }
  const names = sortedByUtf8([...cellNames]);
  const nameIndex = new Map(names.map((name, i) => [name, i]));
  const revisionEntries: number[] = [];
  rows.forEach((row, r) => {
    if (!row.revisions) return;
    const entries = Object.entries(row.revisions).map(
      ([name, rev]) => [nameIndex.get(name) as number, rev] as const,
    );
    entries.sort((a, b) => a[0] - b[0]);
    for (const [cell, rev] of entries) {
      revisionEntries.push(r, cell, rev[0], origins.of(rev[1]), rev[2]);
    }
  });

  // Every origin is numbered by now (the ids, what created the rows, the revisions, in this order):
  // the table of the origins, then the ids
  out.uint(n);
  out.uint(origins.list.length);
  for (const origin of origins.list) out.bytes(originBytes(origin));
  out.uint(idRuns.length / 3);
  for (const v of idRuns) out.uint(v);

  // The place
  if (!Number.isSafeInteger(place.firstIndex) || place.firstIndex < 0)
    throw invalid(`not the number of a row: ${place.firstIndex}`);
  out.string(place.parent);
  out.byte(0);
  out.string(place.head);
  out.uint(place.firstIndex);

  // What created the rows
  if (createdRuns.length === 0) {
    out.byte(0);
  } else {
    out.byte(1);
    out.uint(createdRuns.length / 4);
    for (const v of createdRuns) out.uint(v);
  }

  // The flags of the rows: the deleted rows, the hidden rows, the locked rows, each written when
  // a row has it
  const flags: ((row: TabaneRow) => boolean)[] = [
    (row) => row.deleted === true,
    (row) => row.visible === false,
    (row) => row.locked === true,
  ];
  const present = flags.map((has) => rows.some(has));
  out.byte(present.reduce((sum, on, k) => sum | (on ? 1 << k : 0), 0));
  flags.forEach((has, k) => {
    if (!present[k]) return;
    const bits = new Uint8Array((n + 7) >> 3);
    rows.forEach((row, i) => {
      if (has(row)) bits[i >> 3] |= 1 << (i & 7);
    });
    out.bytes(bits);
  });

  // The types
  const typeNames: string[] = [];
  const typeIndex = new Map<string, number>();
  const types = new Uint8Array(n);
  rows.forEach((row, i) => {
    if (typeof row.type !== 'string') throw invalid(`the type of the row ${row.id}`);
    let t = typeIndex.get(row.type);
    if (t === undefined) {
      if (typeNames.length >= 255) throw invalid('more than 255 types in a row block');
      t = typeNames.length;
      typeNames.push(row.type);
      typeIndex.set(row.type, t);
    }
    types[i] = t;
  });
  out.uint(typeNames.length);
  for (const name of typeNames) out.string(name);
  if (typeNames.length > 1) out.bytes(types);

  // The geometry, and the fills of its polygons
  const geometries = rows.map((row) => {
    if (row.geometry === null || row.geometry === undefined) return null;
    try {
      return toRowGeometry(row.geometry, dimensions);
    } catch (e) {
      throw invalid(`the geometry of the row ${row.id}: ${(e as Error).message}`);
    }
  });
  writeGeometry(out, dimensions, geometries);
  if (input.fills) {
    out.byte(1);
    writeFills(out, rows, geometries);
  } else {
    out.byte(0);
  }

  // The styles
  const styleEntries: Uint8Array[] = [];
  const styleIndex = new Map<string, number>();
  const styleOf = new Array<number>(n);
  rows.forEach((row, i) => {
    let bytes: Uint8Array;
    try {
      bytes = encodeCanonicalValue(row.style ?? {});
    } catch (e) {
      throw invalid(`the style of the row ${row.id}: ${(e as Error).message}`);
    }
    if (bytes[0] !== 7) throw invalid(`the style of the row ${row.id} is not an object`);
    const key = bytesKey(bytes);
    let s = styleIndex.get(key);
    if (s === undefined) {
      s = styleEntries.length;
      styleEntries.push(bytes);
      styleIndex.set(key, s);
    }
    styleOf[i] = s;
  });
  out.uint(styleEntries.length);
  for (const bytes of styleEntries) out.run(bytes);
  if (styleEntries.length > 1) for (const s of styleOf) out.uint(s);

  // The attributes
  writeProperties(out, rows);

  // The cells changed after their rows were created
  out.uint(names.length);
  for (const name of names) out.string(name);
  out.uint(revisionEntries.length / 5);
  let previousRow = 0;
  for (let k = 0; k < revisionEntries.length; k += 5) {
    const row = revisionEntries[k];
    out.uint(row - previousRow);
    previousRow = row;
    out.uint(revisionEntries[k + 1]);
    out.uint(revisionEntries[k + 2]);
    out.uint(revisionEntries[k + 3]);
    out.uint(revisionEntries[k + 4]);
  }

  return out.finish();
}

/** A key of a map for bytes */
function bytesKey(b: Uint8Array): string {
  let s = '';
  for (let k = 0; k < b.length; k += 4096) {
    s += String.fromCharCode(...b.subarray(k, k + 4096));
  }
  return s;
}

/** Strings in the order of their UTF-8 */
export function sortedByUtf8(list: string[]): string[] {
  const keyed = list.map((s) => [utf8Of(s), s] as const);
  keyed.sort((a, b) => compareBytes(a[0], b[0]));
  return keyed.map((k) => k[1]);
}

// === Geometry ===

/** The geometry of the rows of one type */
interface Child {
  readonly type: number;
  /** The rows of the child, in order */
  readonly rows: RowGeometry[];
}

function writeGeometry(
  out: ByteSink,
  dimensions: CoordinateDimensions,
  geometries: readonly (RowGeometry | null)[],
): void {
  const children: Child[] = [];
  const childOf = new Map<GeometryType, number>();
  const rowChild = new Uint8Array(geometries.length);
  geometries.forEach((g, i) => {
    if (!g) return;
    let c = childOf.get(g.type);
    if (c === undefined) {
      c = children.length;
      children.push({ type: GEOMETRY_TYPES.indexOf(g.type), rows: [] });
      childOf.set(g.type, c);
    }
    children[c].rows.push(g);
    rowChild[i] = c + 1;
  });
  out.byte(DIMENSIONS.indexOf(dimensions));
  out.uint(children.length);
  for (const child of children) out.byte(child.type);
  if (children.length > 0) out.bytes(rowChild);
  const stride = strideOf(dimensions);
  for (const child of children) writeChild(out, child, stride);
}

function writeChild(out: ByteSink, child: Child, stride: number): void {
  // The counts of the levels, outermost first
  const levels = [new ByteSink(), new ByteSink(), new ByteSink()];
  const type = GEOMETRY_TYPES[child.type];
  let depth = 0;
  for (const g of child.rows) {
    switch (type) {
      case 'Point':
        break;
      case 'LineString':
      case 'MultiPoint':
        depth = 1;
        levels[0].uint(g.coords.length / stride);
        break;
      case 'Polygon':
      case 'MultiLineString':
        depth = 2;
        levels[0].uint(g.parts.length);
        for (const p of g.parts) levels[1].uint(p);
        break;
      case 'MultiPolygon': {
        depth = 3;
        levels[0].uint(g.polygons.length);
        for (const p of g.polygons) levels[1].uint(p);
        for (const p of g.parts) levels[2].uint(p);
        break;
      }
    }
  }
  for (let l = 0; l < depth; l++) out.run(levels[l].finish());

  // The scale: the most digits a row of decimal values needs
  const rowScale = child.rows.map((g) => {
    let d = 0;
    const c = g.coords;
    for (let k = 0; k < c.length; k++) {
      const fewest = fewestDecimals(c[k]);
      if (fewest < 0) return -1;
      if (fewest > d) d = fewest;
    }
    return d;
  });
  let scale = -1;
  for (const d of rowScale) if (d > scale) scale = d;
  out.int(scale);
  const decimals = Array.from({ length: stride }, () => new ByteSink());
  const xors = Array.from({ length: stride }, () => new XorSink());
  const previous = new Array<number>(stride).fill(0);
  const modes = scale >= 0 ? new Uint8Array((child.rows.length + 7) >> 3) : null;
  const ints: number[] = [];
  child.rows.forEach((g, r) => {
    const c = g.coords;
    let decimal = false;
    if (modes && rowScale[r] >= 0) {
      ints.length = 0;
      decimal = true;
      for (let k = 0; k < c.length; k++) {
        const v = decimalAt(c[k], scale);
        if (v === null) {
          decimal = false;
          break;
        }
        ints.push(v);
      }
    }
    if (decimal && modes) {
      modes[r >> 3] |= 1 << (r & 7);
      for (let k = 0; k < ints.length; k++) {
        const dim = k % stride;
        decimals[dim].int(ints[k] - previous[dim]);
        previous[dim] = ints[k];
      }
    } else {
      for (let k = 0; k < c.length; k++) xors[k % stride].put(c[k]);
    }
  });
  if (modes) {
    out.bytes(modes);
    for (const d of decimals) out.run(d.finish());
  }
  for (const x of xors) out.run(x.finish());
}

// === Fills ===

function writeFills(
  out: ByteSink,
  rows: readonly TabaneRow[],
  geometries: readonly (RowGeometry | null)[],
): void {
  const heads = new ByteSink();
  const indices = new ByteSink();
  rows.forEach((row, i) => {
    const g = geometries[i];
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return;
    let fill = row.fill;
    if (!fill) {
      const made = triangulateRow(g.coords, ringOffsetsOf(g), polygonRanges(g), g.stride);
      fill = { vertices: made.vertices, indices: made.indices };
    }
    if (fill.indices.length % 4 !== 0) throw invalid(`the fill of the row ${row.id}`);
    heads.uint(fill.vertices);
    heads.uint(fill.indices.length / 4);
    for (const index of fill.indices) {
      if (!Number.isInteger(index) || index < 0 || index >= fill.vertices)
        throw invalid(`the fill of the row ${row.id}`);
      indices.uint(index);
    }
  });
  out.run(heads.finish());
  out.run(indices.finish());
}

// === Attributes ===

interface ColumnInput {
  readonly key: string;
  /** The rows that hold the key, ascending, and their values */
  readonly rows: number[];
  readonly values: unknown[];
}

function writeProperties(out: ByteSink, rows: readonly TabaneRow[]): void {
  const columns = new Map<string, ColumnInput>();
  rows.forEach((row, r) => {
    const properties = row.properties;
    if (!properties) return;
    for (const key of Object.keys(properties)) {
      const value = properties[key];
      if (value === undefined) continue;
      if (!wellFormed(key)) throw invalid('a key with a lone surrogate');
      let column = columns.get(key);
      if (!column) {
        column = { key, rows: [], values: [] };
        columns.set(key, column);
      }
      column.rows.push(r);
      column.values.push(value);
    }
  });
  const keys = sortedByUtf8([...columns.keys()]);
  out.uint(keys.length);
  for (const key of keys) writeColumn(out, columns.get(key) as ColumnInput, rows.length);
}

function writeColumn(out: ByteSink, column: ColumnInput, length: number): void {
  const present = column.rows.length;
  const dense = present * 2 >= length;
  out.string(column.key);
  out.byte(dense ? 0 : 1);
  const count = dense ? length : present;
  const tags = new Uint8Array(count);
  const integers = new ByteSink();
  const floats = new XorSink();
  const refs = new ByteSink();
  const dictionary: Uint8Array[] = [];
  const dictionaryIndex = new Map<string, number>();
  if (!dense) {
    out.uint(present);
    let previous = -1;
    for (const r of column.rows) {
      out.uint(r - previous - 1);
      previous = r;
    }
  }
  column.rows.forEach((r, k) => {
    const entry = dense ? r : k;
    const v = column.values[k];
    if (v === null) {
      tags[entry] = TAG_NULL;
    } else if (v === false) {
      tags[entry] = TAG_FALSE;
    } else if (v === true) {
      tags[entry] = TAG_TRUE;
    } else if (typeof v === 'number') {
      // NaN, the infinities and -0 are floats
      if (Number.isSafeInteger(v) && !(v === 0 && 1 / v < 0)) {
        tags[entry] = TAG_INTEGER;
        integers.int(v);
      } else {
        tags[entry] = TAG_FLOAT;
        floats.put(v);
      }
    } else {
      let bytes: Uint8Array;
      if (typeof v === 'string') {
        if (!wellFormed(v))
          throw invalid(`a string with a lone surrogate of the key ${column.key}`);
        tags[entry] = TAG_STRING;
        bytes = utf8Of(v);
      } else {
        // A value of a kind of its own (a date, a reference, bytes, ...) is other than nested
        tags[entry] = valueTagOf(v) === VALUE_OTHER ? TAG_OTHER : TAG_NESTED;
        try {
          bytes = encodeCanonicalValue(v);
        } catch (e) {
          throw invalid(`a value of the key ${column.key}: ${(e as Error).message}`);
        }
      }
      const key = bytesKey(bytes);
      let ref = dictionaryIndex.get(key);
      if (ref === undefined) {
        ref = dictionary.length;
        dictionary.push(bytes);
        dictionaryIndex.set(key, ref);
      }
      refs.uint(ref);
    }
  });
  out.bytes(tags);
  out.run(integers.finish());
  out.run(floats.finish());
  out.run(refs.finish());
  out.uint(dictionary.length);
  for (const bytes of dictionary) out.run(bytes);
}
