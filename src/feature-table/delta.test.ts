// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows of a layer changed since their row groups were built (the delta)
 *
 * - A row placed elsewhere in the order (its key, its group of features, its type) goes to the
 *   delta of its layer, and is read there at its new place; its copy in its group is hidden and
 *   not read
 * - A row moved to another layer goes to the delta of that layer
 * - A new row (a handle without a row, with its type, layer, geometry and key) goes to the delta
 * - A row of the delta written again is written in place there, with the write mark of the write
 * - What the drawing could not write into its place goes to the delta as it is
 * - The change written is returned by layer
 * - Rows that come in a few at a time find their places among the rows that stay
 * - Writes of every kind at random, applied to the tables and to a reference sorted by the keys:
 *   every read of the tables gives the reference
 */

import { utf8ColumnFromStrings } from '@sakuzu/tabane';
import type { Geometry } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  expectTablesMatch,
  referenceKey as key,
  rowPatch as patchOf,
  type ReferenceRow,
  randomReferenceRow as randomRow,
  randomRowWrites,
  randomReference as referenceOf,
  seededRandom,
  tablesOfReference as tablesOf,
} from '../test-utils.js';
import { STATE_HIDDEN_DELTA } from './feature-row-states.js';

describe('the delta of a layer', () => {
  it('reads a row placed elsewhere in the order at its new place, and hides its copy', () => {
    const random = seededRandom(1);
    const reference = referenceOf(random, 60, ['a']);
    const { tables, writer, internals, groupHandleOf } = tablesOf(reference, ['a']);
    const row = reference.rows.get('r10') as ReferenceRow;
    const handle = tables.findRow('r10') as number;
    const before = internals.placeOf(handle);
    writer.apply(patchOf([handle], { key: [key(999_999)] }));
    row.order = key(999_999);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
    expect(internals.deltaRowCount()).toBe(1);
    expect(internals.placeOf(handle)?.group.delta).toBe(true);
    // The copy in its group is hidden from the drawing and the readers
    expect(before && (before.group.state[before.row] & STATE_HIDDEN_DELTA) !== 0).toBe(true);
    expect(tables.get('a')?.listDrawnRows([-100, -100, 100, 100]).includes(handle)).toBe(true);
    const drawn = Array.from(tables.get('a')?.listDrawnRows([-100, -100, 100, 100]) ?? []);
    expect(drawn.filter((h) => h === handle)).toHaveLength(1);
  });

  it('keeps the rows and their places in order as rows come in a few at a time', () => {
    const random = seededRandom(21);
    const reference = referenceOf(random, 120, ['a']);
    const { tables, writer, internals, groupHandleOf } = tablesOf(reference, ['a']);
    for (let part = 0; part < 12; part++) {
      const ids = Array.from({ length: 5 }, (_, i) => `r${part * 5 + i}`);
      const handles = ids.map((id) => tables.findRow(id) as number);
      const orders = ids.map(() => key(Math.floor(random() * 1_000_000)));
      writer.apply(patchOf(handles, { key: orders }));
      ids.forEach((id, i) => {
        // The key of a member orders it among the members of its group
        const row = reference.rows.get(id) as ReferenceRow;
        if (row.groupId !== undefined) row.member = orders[i];
        else row.order = orders[i];
      });
      // Read between the writes, so that the places are known when the delta is made again
      expectTablesMatch(tables, reference, ['a'], groupHandleOf);
    }
    expect(internals.deltaRowCount()).toBe(60);
  });

  it('reads a row moved to another layer there, and a new row at its place', () => {
    const random = seededRandom(2);
    const reference = referenceOf(random, 40, ['a', 'b']);
    const { tables, writer, internals, groupHandleOf } = tablesOf(reference, ['a', 'b']);
    const moved = tables.findRow('r3') as number;
    writer.apply(patchOf([moved], { parent: ['b'], key: [key(10)] }));
    Object.assign(reference.rows.get('r3') as ReferenceRow, { layerId: 'b', order: key(10) });
    const [fresh] = writer.allocateHandles(utf8ColumnFromStrings(['new']));
    const geometry: Geometry = { type: 'Point', coordinates: [1, 2] };
    const change = writer.apply(
      patchOf([fresh], {
        type: ['Point'],
        parent: ['a'],
        geometry: [geometry],
        key: [key(500_000)],
      }),
    );
    reference.rows.set('new', {
      ...randomRow(random, 'new', 'a'),
      type: 'Point',
      geometry,
      order: key(500_000),
      style: {},
      properties: {},
    });
    expectTablesMatch(tables, reference, ['a', 'b'], groupHandleOf);
    expect(Array.from(change.layers.get('a')?.created ?? [])).toEqual([fresh]);
    expect(internals.deltaRowCount()).toBe(2);
  });

  it('writes a row of the delta in place there, with the write mark of the write', () => {
    const random = seededRandom(3);
    const reference = referenceOf(random, 30, ['a']);
    const { tables, writer, internals } = tablesOf(reference, ['a']);
    const handle = tables.findRow('r5') as number;
    internals.setWriteMark(1);
    writer.apply(patchOf([handle], { key: [key(1)] }));
    const delta = internals.rowTable('a')?.delta;
    const slot = internals.ids.deltaSlot(handle);
    expect(delta?.group?.marks[slot]).toBe(1);
    const group = delta?.group;
    const revision = delta?.revision;
    const writes: unknown[] = [];
    internals.onRowsWritten((_layer, list) => writes.push(...list));
    internals.setWriteMark(2);
    writer.apply(
      patchOf([handle], { 'properties:name': ['written'], style: [{ pointColor: '#00ff00' }] }),
    );
    // In place: the rows of the delta are not made again
    expect(delta?.group).toBe(group);
    expect(delta?.revision).toBe(revision);
    expect(delta?.group?.marks[slot]).toBe(2);
    expect(delta?.group?.mark).toBe(2);
    expect(tables.get('a')?.getRowValue(handle, 'name')).toBe('written');
    expect(writes).toHaveLength(1);
    expect((writes[0] as { group: number }).group).toBe(delta?.handle);
  });

  it('puts rows the drawing could not write into their places into the delta as they are', () => {
    const random = seededRandom(4);
    const reference = referenceOf(random, 30, ['a']);
    const { tables, internals, groupHandleOf } = tablesOf(reference, ['a']);
    const handles = ['r1', 'r2', 'r20'].map((id) => tables.findRow(id) as number);
    internals.toDelta(handles);
    expect(internals.deltaRowCount()).toBe(3);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
  });

  it('returns what it wrote by layer: the rows, the fields and the keys of the styles', () => {
    const random = seededRandom(5);
    const reference = referenceOf(random, 20, ['a', 'b']);
    const { tables, writer } = tablesOf(reference, ['a', 'b']);
    const a = tables.findRow('r0') as number;
    const b = tables.findRow('r1') as number;
    const change = writer.apply(
      patchOf(
        [a, b],
        { style: [{ strokeColor: '#00ff00' }, { strokeColor: '#ff0000', fillColor: '#000000' }] },
        [0, 1],
      ),
    );
    expect(Array.from(change.layers.get('a')?.updated ?? [])).toEqual([a]);
    expect(Array.from(change.layers.get('b')?.deleted ?? [])).toEqual([b]);
    expect([...(change.layers.get('a')?.styleKeys ?? [])]).toEqual(['strokeColor']);
    expect([...(change.layers.get('b')?.styleKeys ?? [])]).toEqual(['fillColor']);
    expect([...(change.layers.get('a')?.fields ?? [])]).toEqual(['style']);
  });

  it('reads every row as the reference after writes of every kind at random', () => {
    for (const seed of [11, 12, 13, 14]) {
      const random = seededRandom(seed);
      const layerIds = ['a', 'b'];
      const reference = referenceOf(random, 80, layerIds);
      const { tables, writer, internals, groupHandleOf } = tablesOf(reference, layerIds);
      const writes = randomRowWrites(random, { tables, writer, internals, reference, layerIds });
      for (let step = 0; step < 150; step++) {
        writes.step(step);
        if (step % 10 === 9) expectTablesMatch(tables, reference, layerIds, groupHandleOf);
      }
      expectTablesMatch(tables, reference, layerIds, groupHandleOf);
      expect(internals.deltaRowCount()).toBeGreaterThan(20);
    }
  });
});
