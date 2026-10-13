// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The values of the rows of a group written since the group was built
 *
 * The columns of a row group are read-only in their shape: an attribute column cannot take a
 * string of another length, a number where it holds none, or a key it does not have; a geometry
 * column cannot take a row of another number of coordinates. A row written in place keeps such
 * values here, per group, until the next version of the group folds them into its columns:
 *
 * - `ValueOverrides`: the attributes written, by row and key (a value, or absent for a key taken
 *   off the row)
 * - `GeometryOverrides`: the geometry of a row whose number of coordinates or rings changed, as a
 *   column of one row, and the triangles of a row whose triangulation does not fit the cache of
 *   the group any more
 *
 * Every reader of the values of a row (`row-read.ts`) looks here first. The values are held as
 * their own bytes, so the dictionaries of the columns (which only grow) never take a value
 * written on the way. The bytes held are counted against one limit per group for both, past
 * which the group is due for its next version.
 */

import { decodeCanonicalValue, encodeCanonicalValue } from '../table/canonical-value.js';
import { GeometryColumnReader } from '../table/table.js';
import type { TableGeometry } from '../table/types.js';
import { utf8Bytes } from '../table/utf8-column.js';
import {
  VALUE_ABSENT,
  VALUE_FALSE,
  VALUE_NESTED,
  VALUE_NULL,
  VALUE_NUMBER,
  VALUE_STRING,
  VALUE_TRUE,
} from '../table/value-column.js';

/**
 * The bytes the values written in place may take per row group (attributes and geometry
 * together) before the group is due for its next version
 *
 * A first estimate (25 groups of a large layer at the limit hold about 6 MB), to be set from
 * the measurement of the writes of attributes.
 *
 * @internal
 */
export const OVERRIDE_BYTES_LIMIT = 256 * 1024;

/** What one entry costs besides its bytes (the entry of the maps and its object; an estimate) */
const ENTRY_OVERHEAD_BYTES = 48;

/** What the geometry of a row costs besides its arrays (an estimate) */
const GEOMETRY_OVERHEAD_BYTES = 96;

/**
 * One attribute written: its kind (`VALUE_ABSENT` to `VALUE_NESTED` of `value-column.ts`), with
 * its number or its bytes (UTF-8 for a string, canonical for a nested value)
 *
 * @internal
 */
export interface OverrideValue {
  readonly tag: number;
  readonly number: number;
  readonly bytes: Uint8Array | null;
}

/** The geometry of a row written with another shape */
interface GeometryOverride {
  readonly column: TableGeometry;
  readonly reader: GeometryColumnReader;
}

const DECODER = new TextDecoder();

/**
 * Encodes a value of an attribute (`undefined` takes the key off the row)
 *
 * @throws when the value is not one of the kinds of the canonical form
 * @internal
 */
export function encodeOverrideValue(value: unknown): OverrideValue {
  if (value === undefined) return { tag: VALUE_ABSENT, number: 0, bytes: null };
  if (value === null) return { tag: VALUE_NULL, number: 0, bytes: null };
  if (value === false) return { tag: VALUE_FALSE, number: 0, bytes: null };
  if (value === true) return { tag: VALUE_TRUE, number: 0, bytes: null };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`ValueOverrides: ${value} is not a value`);
    return { tag: VALUE_NUMBER, number: value, bytes: null };
  }
  if (typeof value === 'string') return { tag: VALUE_STRING, number: 0, bytes: utf8Bytes(value) };
  return { tag: VALUE_NESTED, number: 0, bytes: encodeCanonicalValue(value) };
}

/**
 * Decodes a value of an attribute written (undefined for a key taken off the row)
 *
 * @internal
 */
export function decodeOverrideValue(value: OverrideValue): unknown {
  switch (value.tag) {
    case VALUE_NULL:
      return null;
    case VALUE_FALSE:
      return false;
    case VALUE_TRUE:
      return true;
    case VALUE_NUMBER:
      return value.number;
    case VALUE_STRING:
      return DECODER.decode(value.bytes as Uint8Array);
    case VALUE_NESTED:
      return decodeCanonicalValue(value.bytes as Uint8Array);
    default:
      return undefined;
  }
}

/**
 * Whether two values written are the same value
 *
 * @internal
 */
export function sameOverrideValue(a: OverrideValue, b: OverrideValue): boolean {
  if (a.tag !== b.tag) return false;
  if (a.tag === VALUE_NUMBER) return a.number === b.number;
  if (a.bytes === null || b.bytes === null) return a.bytes === b.bytes;
  if (a.bytes.length !== b.bytes.length) return false;
  for (let i = 0; i < a.bytes.length; i++) if (a.bytes[i] !== b.bytes[i]) return false;
  return true;
}

/** The bytes an attribute written takes */
function valueBytes(value: OverrideValue): number {
  return ENTRY_OVERHEAD_BYTES + (value.bytes?.length ?? 0);
}

/** The bytes the arrays of a geometry column take */
function columnBytes(column: TableGeometry): number {
  let bytes = column.coords.byteLength;
  for (const offsets of column.offsets ?? []) bytes += offsets.byteLength;
  return bytes;
}

/**
 * The attributes written in place of the rows of one group (`ValueOverrides`), with the bytes
 * they take
 *
 * @internal
 */
export class ValueOverrides {
  /** The attributes written, by key then row */
  private readonly values = new Map<string, Map<number, OverrideValue>>();
  private size = 0;

  /** The bytes held */
  get bytes(): number {
    return this.size;
  }

  /** Whether nothing is held */
  get empty(): boolean {
    return this.values.size === 0;
  }

  /** The attribute written of a row under a key (undefined when it is not written) */
  get(row: number, key: string): OverrideValue | undefined {
    return this.values.get(key)?.get(row);
  }

  /** Whether an attribute of a row is written */
  has(row: number): boolean {
    for (const rows of this.values.values()) if (rows.has(row)) return true;
    return false;
  }

  /** Calls `visit` with every attribute written of a row */
  forEach(row: number, visit: (key: string, value: OverrideValue) => void): void {
    for (const [key, rows] of this.values) {
      const value = rows.get(row);
      if (value) visit(key, value);
    }
  }

  /** Writes an attribute of a row */
  set(row: number, key: string, value: OverrideValue): void {
    let rows = this.values.get(key);
    if (!rows) {
      rows = new Map();
      this.values.set(key, rows);
    }
    const old = rows.get(row);
    if (old) this.size -= valueBytes(old);
    rows.set(row, value);
    this.size += valueBytes(value);
  }

  /** Takes off what is written of an attribute of a row (the column is read again) */
  delete(row: number, key: string): void {
    const rows = this.values.get(key);
    const old = rows?.get(row);
    if (!rows || !old) return;
    rows.delete(row);
    this.size -= valueBytes(old);
    if (rows.size === 0) this.values.delete(key);
  }
}

/**
 * The geometry written in place of the rows of one group that does not fit its columns
 * (`GeometryOverrides`): the geometry of a row whose number of coordinates, rings or parts
 * changed, as a column of one row, and the triangles of a row whose triangulation does not fit
 * the cache of the group, with the bytes they take
 *
 * @internal
 */
export class GeometryOverrides {
  /** The geometry of the rows written with another shape */
  private readonly geometries = new Map<number, GeometryOverride>();
  /** The triangles of the rows whose triangulation does not fit the cache of the group */
  private readonly triangles = new Map<number, Uint16Array | Uint32Array>();
  private size = 0;

  /** The bytes held */
  get bytes(): number {
    return this.size;
  }

  /** Whether nothing is held */
  get empty(): boolean {
    return this.geometries.size === 0 && this.triangles.size === 0;
  }

  /** The geometry column of one row a row is read from (undefined when not written) */
  geometry(row: number): GeometryColumnReader | undefined {
    return this.geometries.get(row)?.reader;
  }

  /** Writes the geometry of a row as a column of one row */
  setGeometry(row: number, column: TableGeometry): void {
    this.deleteGeometry(row);
    const reader = new GeometryColumnReader(column, undefined, 'geometry');
    this.geometries.set(row, { column, reader });
    this.size += GEOMETRY_OVERHEAD_BYTES + columnBytes(column);
  }

  /** Takes off the geometry written of a row */
  deleteGeometry(row: number): void {
    const old = this.geometries.get(row);
    if (!old) return;
    this.geometries.delete(row);
    this.size -= GEOMETRY_OVERHEAD_BYTES + columnBytes(old.column);
  }

  /** The triangles written of a row (undefined when they are the ones of the cache) */
  rowTriangles(row: number): Uint16Array | Uint32Array | undefined {
    return this.triangles.get(row);
  }

  /** Writes the triangles of a row */
  setTriangles(row: number, indices: Uint16Array | Uint32Array): void {
    this.deleteTriangles(row);
    this.triangles.set(row, indices);
    this.size += ENTRY_OVERHEAD_BYTES + indices.byteLength;
  }

  /** Takes off the triangles written of a row */
  deleteTriangles(row: number): void {
    const old = this.triangles.get(row);
    if (!old) return;
    this.triangles.delete(row);
    this.size -= ENTRY_OVERHEAD_BYTES + old.byteLength;
  }
}
