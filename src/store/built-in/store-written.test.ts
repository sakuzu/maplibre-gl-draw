// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows a change wrote each field of (`RowValues.written`), in the values before of the
 * changes of a Store without a map (`createStore`):
 *
 * - A transaction that writes a field of some rows only tells them, for the fields, the
 *   geometry and the deletion; one that writes every row every field tells nothing apart
 * - A write with marks writes a field to the rows marked only: the other rows keep the value
 *   given (the one they have), and are not in the values before for that field
 * - Marks of the wrong shape refuse the write
 */

import { describe, expect, it } from 'vitest';
import type { Layer } from '../../api/model.js';
import { DrawError } from '../../shared/errors.js';
import { createStore } from './create-store.js';
import type { FeatureRowField, GeometryColumn, RowValues, Store, StoreChange } from './types.js';

function layer(id: string): Layer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
  };
}

/** Points, one per row, as one column */
function points(count: number): GeometryColumn {
  const starts = Int32Array.from({ length: count + 1 }, (_, i) => i);
  return {
    types: new Uint8Array(count),
    coordinates: Float64Array.from({ length: count * 2 }, (_, i) => i),
    valuesPerPosition: 2,
    partStarts: starts,
    ringStarts: starts,
    positionStarts: starts,
  };
}

/** A Store with the points a, b and c in the layer `l`, a name each */
function storeOfThree(): { store: Store; ref: (id: string) => number } {
  const store = createStore();
  store.createLayer(layer('l'));
  const ids = ['a', 'b', 'c'];
  store.createRows({
    ids,
    fields: new Map<FeatureRowField, unknown[]>([
      ['type', ids.map(() => 'Point')],
      ['parent', ids.map(() => 'l')],
      ['orderKey', ['a0', 'a1', 'a2']],
      ['properties:name', ids.map((id) => id.toUpperCase())],
    ]),
    geometry: points(3),
  });
  return { store, ref: (id) => store.tables.getRowRef(id) as number };
}

/** The values before of the next change, by the ids of their rows */
function nextValues(store: Store): () => { ids: string[]; values: RowValues } {
  const changes: StoreChange[] = [];
  store.subscribe((change) => changes.push(change), { previousValues: true });
  return () => {
    const values = changes[changes.length - 1]?.previousValues?.get('l') as RowValues;
    return { ids: Array.from(values.rows, (r) => store.tables.getRowId(r) ?? ''), values };
  };
}

/** The marks of a field, by the ids of the rows */
const marksOf = (read: { ids: string[]; values: RowValues }, field: string) => {
  const marks = read.values.written?.get(field as FeatureRowField);
  return marks && Object.fromEntries(read.ids.map((id, i) => [id, marks[i]]));
};

describe('the rows a change wrote each field of', () => {
  it('tells the rows of a field written of some of them, the geometry and the deletion', () => {
    const { store, ref } = storeOfThree();
    const last = nextValues(store);
    store.transact(() => {
      store.writeRows({
        rows: Int32Array.of(ref('a')),
        fields: new Map<FeatureRowField, unknown[]>([['properties:name', ['A2']]]),
        geometry: points(1),
      });
      store.writeRows({
        rows: Int32Array.of(ref('b')),
        fields: new Map<FeatureRowField, unknown[]>([['properties:k', [1]]]),
      });
      store.writeRows({
        rows: Int32Array.of(ref('c')),
        fields: new Map(),
        deleted: Uint8Array.of(1),
      });
    }, 'local');
    const read = last();
    expect(marksOf(read, 'properties:name')).toEqual({ a: 1, b: 0, c: 0 });
    expect(marksOf(read, 'properties:k')).toEqual({ a: 0, b: 1, c: 0 });
    expect(marksOf(read, 'geometry')).toEqual({ a: 1, b: 0, c: 0 });
    expect(marksOf(read, 'deleted')).toEqual({ a: 0, b: 0, c: 1 });
    // The values of the rows not written are those they had
    const names = read.values.fields.get('properties:name') ?? [];
    expect(Object.fromEntries(read.ids.map((id, i) => [id, names[i]]))).toEqual({
      a: 'A',
      b: 'B',
      c: 'C',
    });
  });

  it('tells nothing apart for a field written of every row', () => {
    const { store, ref } = storeOfThree();
    const last = nextValues(store);
    store.transact(() => {
      store.writeRows({
        rows: Int32Array.of(ref('a'), ref('b')),
        fields: new Map<FeatureRowField, unknown[]>([['properties:name', ['A2', 'B2']]]),
      });
      store.writeRows({
        rows: Int32Array.of(ref('c')),
        fields: new Map<FeatureRowField, unknown[]>([['properties:name', ['C2']]]),
      });
    }, 'local');
    expect(last().values.written).toBeUndefined();
  });
});

describe('a write with marks', () => {
  it('writes a field to the rows marked only, and leaves the others out of the values before', () => {
    const { store, ref } = storeOfThree();
    const last = nextValues(store);
    store.writeRows({
      rows: Int32Array.of(ref('a'), ref('b')),
      fields: new Map<FeatureRowField, unknown[]>([
        ['properties:name', ['A2', 'B']],
        ['properties:k', [1, 2]],
      ]),
      written: new Map([['properties:name', Uint8Array.of(1, 0)]]),
    });
    const read = last();
    expect(marksOf(read, 'properties:name')).toEqual({ a: 1, b: 0 });
    expect(marksOf(read, 'properties:k')).toBeUndefined();
    const now = store.tables.readValues(Int32Array.of(ref('a'), ref('b')), ['properties:name']);
    expect(now.fields.get('properties:name')).toEqual(['A2', 'B']);
  });

  it('refuses marks of the wrong shape, and writes nothing', () => {
    const { store, ref } = storeOfThree();
    const write = (written: unknown) => () =>
      store.writeRows({
        rows: Int32Array.of(ref('a'), ref('b')),
        fields: new Map<FeatureRowField, unknown[]>([['properties:name', ['X', 'Y']]]),
        written,
      } as RowValues);
    for (const written of [
      {},
      new Map([['properties:name', [1, 0]]]),
      new Map([['properties:name', Uint8Array.of(1)]]),
    ]) {
      expect(write(written)).toThrow(DrawError);
    }
    const now = store.tables.readValues(Int32Array.of(ref('a')), ['properties:name']);
    expect(now.fields.get('properties:name')).toEqual(['A']);
  });
});
