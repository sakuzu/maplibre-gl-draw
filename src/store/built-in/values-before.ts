// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The values rows had before the writes of one transaction (`StoreChange.previousValues`), from
 * the values each write read before it wrote
 *
 * Only a transaction a listener asked them for reads them. Each write of rows reads, before it
 * writes, the values its rows have for every field the transaction has written so far, its own
 * included, and their deletion; when a write brings a field no write wrote before, the rows read
 * before are read for it as well (no write wrote it, so they still have the values they had). So
 * every row read has a value for every field, and the value before of a row and a field is the
 * one the first read of them read. A row the change lists that no write read (a member of a group
 * moved with it) is read once the transaction ends: no write wrote its fields.
 *
 * The values are held as the columns they are read in: the geometries as the columns of their
 * positions (`GeometryColumn`), never an object per row. A transaction of one write gives the
 * values that write read as they are.
 *
 * Each read keeps the fields its write wrote, with the rows of each when the write marks them
 * (`RowValues.written`): the values before tell, by field, the rows the transaction wrote it of
 * (`written`, an entry only for a field some rows were not written; the geometry is `'geometry'`
 * and the deletion `'deleted'`). A read again for a field a later write brought wrote nothing.
 *
 * @internal
 */

import { countWork, type WorkCounts } from '../../shared/work-counts.js';
import type { FeatureRowField, GeometryColumn, LayerRowsChange, RowValues } from './types.js';

/**
 * Reads values of rows for the values before: the fields given (`geometry` read as the
 * geometries), and the deletion, the deleted rows nothing keeps included
 *
 * @internal
 */
export type ReadBefore = (rows: Int32Array, fields: readonly FeatureRowField[]) => RowValues;

/**
 * The values read before the writes of one transaction
 *
 * @internal
 */
export interface ValuesBefore {
  /** The fields read, in the order they were first written (`geometry` among them) */
  readonly fields: FeatureRowField[];
  /** The same fields, to look up */
  readonly known: Set<FeatureRowField>;
  /** What each read read, in the order of the reads */
  readonly parts: RowValues[];
  /** What the write of each read wrote, in the same order (see `WrittenOfRead`) */
  readonly writtenOf: WrittenOfRead[];
}

/**
 * What the write of one read wrote: its fields (`'geometry'` and `'deleted'` among them), and
 * for a field it wrote of some of its rows only, those rows (one entry per row of the read)
 *
 * @internal
 */
export interface WrittenOfRead {
  readonly fields: ReadonlySet<string>;
  readonly marks: ReadonlyMap<string, Uint8Array> | undefined;
}

/** A read that wrote nothing (a read again for a field a later write brought) */
const WROTE_NOTHING: WrittenOfRead = Object.freeze({ fields: new Set<string>(), marks: undefined });

/** The deletion, named among the fields a write wrote */
const DELETED = 'deleted';

/**
 * Nothing read yet
 *
 * @internal
 */
export function createValuesBefore(): ValuesBefore {
  return { fields: [], known: new Set(), parts: [], writtenOf: [] };
}

/** The rows of parts, one after the other */
function joinedRows(parts: readonly RowValues[]): Int32Array {
  if (parts.length === 1) return parts[0].rows;
  let length = 0;
  for (const part of parts) length += part.rows.length;
  const out = new Int32Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part.rows, at);
    at += part.rows.length;
  }
  return out;
}

/**
 * Reads the values rows have before a write writes the fields given
 *
 * @param written - The fields the write writes (`'deleted'` for its deletion, which is not read
 *   as a field)
 * @param options.marks - The rows the write writes each field of, when not all (one entry per
 *   row, as `RowValues.written`)
 * @internal
 */
export function readBeforeWrite(
  before: ValuesBefore,
  read: ReadBefore,
  rows: Int32Array,
  written: Iterable<FeatureRowField | typeof DELETED>,
  options: { readonly marks?: ReadonlyMap<string, Uint8Array> } = {},
): void {
  const added: FeatureRowField[] = [];
  const own = new Set<string>();
  for (const field of written) {
    own.add(field);
    if (field === DELETED || before.known.has(field)) continue;
    before.known.add(field);
    before.fields.push(field);
    added.push(field);
  }
  // The rows read before have the values they had for the fields no write wrote yet
  if (added.length > 0 && before.parts.length > 0) {
    before.parts.push(read(joinedRows(before.parts), added));
    before.writtenOf.push(WROTE_NOTHING);
  }
  if (rows.length > 0) {
    before.parts.push(read(rows, [...before.fields]));
    before.writtenOf.push({
      fields: own,
      marks: options.marks && options.marks.size > 0 ? options.marks : undefined,
    });
  }
}

/** The geometries of rows taken from the geometries of other rows, into new columns */
function gatherGeometry(
  sources: readonly (GeometryColumn | undefined)[],
  from: Int32Array,
  at: Int32Array,
  valuesPerPosition: number,
  counts: readonly WorkCounts[],
): GeometryColumn {
  const n = from.length;
  let parts = 0;
  let rings = 0;
  let positions = 0;
  // The first walk counts, the second copies
  for (let i = 0; i < n; i++) {
    const source = sources[from[i]];
    if (!source || source.types[at[i]] === 255) continue;
    const p0 = source.partStarts[at[i]];
    const p1 = source.partStarts[at[i] + 1];
    parts += p1 - p0;
    rings += source.ringStarts[p1] - source.ringStarts[p0];
    positions +=
      source.positionStarts[source.ringStarts[p1]] - source.positionStarts[source.ringStarts[p0]];
  }
  const types = new Uint8Array(n).fill(255);
  const partStarts = new Int32Array(n + 1);
  const ringStarts = new Int32Array(parts + 1);
  const positionStarts = new Int32Array(rings + 1);
  const coordinates = new Float64Array(positions * valuesPerPosition).fill(Number.NaN);
  for (const list of counts) countWork(list, 'objectsCreated', 6);
  let part = 0;
  let ring = 0;
  let position = 0;
  for (let i = 0; i < n; i++) {
    const source = sources[from[i]];
    if (source && source.types[at[i]] !== 255) {
      types[i] = source.types[at[i]];
      const stride = source.valuesPerPosition;
      const width = Math.min(stride, valuesPerPosition);
      for (let p = source.partStarts[at[i]]; p < source.partStarts[at[i] + 1]; p++) {
        for (let r = source.ringStarts[p]; r < source.ringStarts[p + 1]; r++) {
          for (let q = source.positionStarts[r]; q < source.positionStarts[r + 1]; q++) {
            for (let v = 0; v < width; v++) {
              coordinates[position * valuesPerPosition + v] = source.coordinates[q * stride + v];
            }
            position += 1;
          }
          ring += 1;
          positionStarts[ring] = position;
        }
        part += 1;
        ringStarts[part] = ring;
      }
    }
    partStarts[i + 1] = part;
  }
  return { types, coordinates, valuesPerPosition, partStarts, ringStarts, positionStarts };
}

/**
 * The values before of the rows a change lists, by layer: the rows updated and deleted of each
 * layer (a row created by the transaction has none), with every field read, and their deletion
 * when the layer has a row deleted or brought back
 *
 * @param rows - The rows the change lists, by layer
 * @param valuesPerPosition - The number of values of a position of a layer
 * @param counts - Where the work is counted
 * @returns The values before, by layer (empty when the change lists no row there was before)
 * @internal
 */
export function valuesBeforeOf(
  before: ValuesBefore,
  read: ReadBefore,
  rows: ReadonlyMap<string, LayerRowsChange>,
  valuesPerPosition: (layerId: string) => number,
  counts: readonly WorkCounts[],
): Map<string, RowValues> {
  const out = new Map<string, RowValues>();
  // The rows of each layer, one after the other: the place of each row there
  const layers: Array<{ id: string; rows: Int32Array; deletedRows: number; from: number }> = [];
  let total = 0;
  for (const [id, change] of rows) {
    const length = change.updated.length + change.deleted.length;
    if (length === 0) continue;
    let listed = change.updated;
    if (change.deleted.length > 0) {
      listed = new Int32Array(length);
      listed.set(change.updated);
      listed.set(change.deleted, change.updated.length);
    }
    layers.push({ id, rows: listed, deletedRows: change.deleted.length, from: total });
    total += length;
  }
  if (total === 0) return out;
  const placeOf = new Map<number, number>();
  for (const layer of layers) {
    for (let i = 0; i < layer.rows.length; i++) placeOf.set(layer.rows[i], layer.from + i);
  }
  for (const list of counts) countWork(list, 'objectsCreated', 2);

  const parts = before.parts;
  // One read of exactly the rows of one layer: its values, as they are
  if (
    parts.length === 1 &&
    layers.length === 1 &&
    parts[0].rows.length === total &&
    before.writtenOf[0]?.marks === undefined &&
    before.writtenOf[0] !== WROTE_NOTHING
  ) {
    const seen = new Uint8Array(total);
    let all = true;
    for (const row of parts[0].rows) {
      const place = placeOf.get(row);
      if (place === undefined || seen[place]) {
        all = false;
        break;
      }
      seen[place] = 1;
    }
    if (all) {
      out.set(
        layers[0].id,
        withDeletion(parts[0], parts[0].deleted, layers[0].deletedRows, 0, total),
      );
      return out;
    }
  }

  // The first read of each row and field
  const fields = before.fields.filter((field) => field !== 'geometry');
  const geometry = before.known.has('geometry');
  const values = fields.map(() => new Array<unknown>(total));
  const have = fields.map(() => new Uint8Array(total));
  const from = new Int32Array(total).fill(-1);
  const at = new Int32Array(total);
  const deleted = new Uint8Array(total);
  const taken = new Uint8Array(total);
  // The rows each field was written of: the fields, then the geometry, then the deletion
  const marks = Array.from({ length: fields.length + 2 }, () => new Uint8Array(total));
  for (const list of counts) countWork(list, 'objectsCreated', 3 * fields.length + 6);
  const take = (part: RowValues, index: number): void => {
    const columns = fields.map((field) => part.fields.get(field));
    const wrote = before.writtenOf[index] ?? WROTE_NOTHING;
    // For each field and the geometry and the deletion: whether the write wrote it, and of which rows
    const writtenColumns = [...fields, 'geometry', DELETED].map((field) =>
      wrote.fields.has(field) ? (wrote.marks?.get(field) ?? null) : undefined,
    );
    for (let i = 0; i < part.rows.length; i++) {
      const place = placeOf.get(part.rows[i]);
      if (place === undefined) continue;
      for (let f = 0; f < writtenColumns.length; f++) {
        const column = writtenColumns[f];
        if (column === undefined) continue;
        if (column === null || column[i] !== 0) marks[f][place] = 1;
      }
      for (let f = 0; f < fields.length; f++) {
        const column = columns[f];
        if (!column || have[f][place]) continue;
        values[f][place] = column[i];
        have[f][place] = 1;
      }
      if (part.geometry && from[place] < 0) {
        from[place] = index;
        at[place] = i;
      }
      if (!taken[place]) {
        deleted[place] = part.deleted?.[i] ? 1 : 0;
        taken[place] = 1;
      }
    }
  };
  const sources: Array<GeometryColumn | undefined> = parts.map((part) => part.geometry);
  for (let index = 0; index < parts.length; index++) take(parts[index], index);
  // The rows no write read: no write wrote their fields
  const missing: number[] = [];
  for (const layer of layers) {
    for (let i = 0; i < layer.rows.length; i++) {
      if (!taken[layer.from + i]) missing.push(layer.rows[i]);
    }
  }
  if (missing.length > 0) {
    const last = read(Int32Array.from(missing), before.fields);
    sources.push(last.geometry);
    take(last, sources.length - 1);
  }

  for (const layer of layers) {
    const start = layer.from;
    const end = start + layer.rows.length;
    const whole = layers.length === 1;
    const layerFields = new Map<FeatureRowField, readonly unknown[]>();
    fields.forEach((field, f) => {
      layerFields.set(field, whole ? values[f] : values[f].slice(start, end));
    });
    const layerValues: RowValues = {
      rows: layer.rows,
      fields: layerFields,
      ...(geometry && {
        geometry: gatherGeometry(
          sources,
          from.subarray(start, end),
          at.subarray(start, end),
          valuesPerPosition(layer.id),
          counts,
        ),
      }),
    };
    for (const list of counts) countWork(list, 'objectsCreated', 2 + fields.length);
    const withDeleted = withDeletion(layerValues, deleted, layer.deletedRows, start, end);
    const written = writtenOfLayer(withDeleted, fields, marks, start, end, counts);
    out.set(layer.id, written ? { ...withDeleted, written } : withDeleted);
  }
  return out;
}

/**
 * The rows of a layer each field was written of, for the fields some of them were not written
 * (undefined when every row was written every field the values hold)
 */
function writtenOfLayer(
  values: RowValues,
  fields: readonly FeatureRowField[],
  marks: readonly Uint8Array[],
  start: number,
  end: number,
  counts: readonly WorkCounts[],
): Map<FeatureRowField | typeof DELETED, Uint8Array> | undefined {
  let out: Map<FeatureRowField | typeof DELETED, Uint8Array> | undefined;
  const add = (field: FeatureRowField | typeof DELETED, mark: Uint8Array): void => {
    for (let i = start; i < end; i++) {
      if (mark[i] !== 0) continue;
      out ??= new Map();
      out.set(field, mark.slice(start, end));
      for (const list of counts) countWork(list, 'objectsCreated');
      return;
    }
  };
  fields.forEach((field, f) => {
    add(field, marks[f]);
  });
  if (values.geometry) add('geometry', marks[fields.length]);
  if (values.deleted) add(DELETED, marks[fields.length + 1]);
  if (out) for (const list of counts) countWork(list, 'objectsCreated');
  return out;
}

/**
 * Values with the deletion of their rows when the layer has a row deleted or brought back, and
 * without it otherwise
 */
function withDeletion(
  values: RowValues,
  deleted: Uint8Array | undefined,
  deletedRows: number,
  start: number,
  end: number,
): RowValues {
  const { deleted: _left, ...rest } = values;
  let any = deletedRows > 0;
  if (deleted && !any) {
    for (let i = start; i < end && !any; i++) any = deleted[i] !== 0;
  }
  if (!any || !deleted) return rest;
  return {
    ...rest,
    deleted: start === 0 && end === deleted.length ? deleted : deleted.slice(start, end),
  };
}

/**
 * The values before as one listener receives them: its own objects over the arrays every
 * listener shares, which are not copied
 *
 * @internal
 */
export function shareValuesBefore(
  values: ReadonlyMap<string, RowValues>,
  counts: readonly WorkCounts[],
): Map<string, RowValues> {
  const out = new Map<string, RowValues>();
  for (const [layerId, layer] of values) {
    out.set(layerId, {
      rows: layer.rows,
      fields: new Map(layer.fields),
      ...(layer.geometry && { geometry: { ...layer.geometry } }),
      ...(layer.deleted && { deleted: layer.deleted }),
      ...(layer.written && { written: new Map(layer.written) }),
    });
  }
  for (const list of counts) countWork(list, 'objectsCreated', 1 + 3 * values.size);
  return out;
}
