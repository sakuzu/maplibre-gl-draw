// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The copy of the state of the rows as the user of the tables declares it, with meanings of its
 * own (not those of the library)
 *
 * - The bits of each handle are the lowest of the copy, written with `setRowStates`; the bits of a
 *   group with `setGroupStates`, taken by its members; the bits from values come from a flag of a
 *   row, a flag of its group and values of a `whole` column
 * - `hiddenMask` leaves rows out of the rows drawn; the deleted rows are left out anyway
 * - Neither write raises the write mark; both raise the state version of the pages
 * - The declarations and the writes are checked
 */

import { KasaneError } from '@sakuzu/kasane';
import { STATE_DELETED } from '@sakuzu/kasane/render';
import { describe, expect, it } from 'vitest';
import type { BBox } from '../geometry/types.js';
import { FEATURE_GROUP_COLUMNS, FEATURE_TABLE_COLUMNS } from '../table/tabane/columns.js';
import { featureRowDataBuilder as createPageDataBuilder, orderKey } from '../test-utils.js';
import {
  createTables,
  type FeatureTablesInternals,
  featureTablesInternals,
  type TablesInternalOptions,
} from './feature-tables.js';

const MARKED = 0b01;
const PICKED = 0b10;
const GROUP_MARK = 1 << 4;
const SHUT = 1 << 5;
const SHUT_GROUP = 1 << 6;
const ROUND = 1 << 7;
const ALL: BBox = [-10, -10, 10, 10];

/** Tables of four rows (the third in a group, the last deleted) with states of their own */
function statesTables(options: Partial<TablesInternalOptions> = {}) {
  const { tables, writer } = createTables({
    columns: FEATURE_TABLE_COLUMNS,
    groupColumns: FEATURE_GROUP_COLUMNS,
    rowStateBits: 2,
    hiddenMask: MARKED | SHUT | SHUT_GROUP | GROUP_MARK,
    stateByte: (state) => state & 0xff,
    valueStates: {
      rowFlags: [{ column: 'hidden', states: SHUT }],
      groupFlags: [{ column: 'hidden', states: SHUT_GROUP }],
      columnValues: [{ column: 'type', values: ['Circle', 'Marker'], states: ROUND }],
    },
    ...options,
  });
  writer.writeGroups({
    groups: Int32Array.of(50),
    fields: new Map<'id' | 'parent' | 'key', unknown[]>([
      ['id', ['g']],
      ['parent', ['layer']],
      ['key', [orderKey(9)]],
    ]),
  });
  const builder = createPageDataBuilder({
    columns: FEATURE_TABLE_COLUMNS,
    groups: [{ group: 50, id: 'g', key: orderKey(9) }],
  });
  const point = { type: 'Point' as const, coordinates: [0, 0] };
  builder.addRow({ id: 'a', type: 'Point', geometry: point, key: orderKey(0) });
  builder.addRow({ id: 'b', type: 'Circle', geometry: point, key: orderKey(1), hidden: true });
  builder.addRow({ id: 'c', type: 'Point', geometry: point, key: orderKey(2), group: 50 });
  builder.addRow({ id: 'd', type: 'Marker', geometry: point, key: orderKey(3), deleted: true });
  writer.addPages('layer', builder.finish());
  const internals = featureTablesInternals(tables) as FeatureTablesInternals;
  internals.addQueuedPages();
  const handle = (id: string) => internals.ids.handleOf(id);
  const stateOf = (id: string): number => {
    const place = internals.placeOf(handle(id));
    return place ? place.group.state[place.row] : -1;
  };
  const drawn = () =>
    Array.from(tables.get('layer')?.listDrawnRows(ALL) ?? []).map((h) => tables.getRowId(h));
  return { tables, writer, internals, handle, stateOf, drawn };
}

describe('the copy of the state of the rows', () => {
  it('makes the copy from the bits of the tables and from the values declared', () => {
    const { internals, handle, stateOf, drawn } = statesTables();
    expect(stateOf('a')).toBe(0);
    expect(stateOf('b')).toBe(SHUT | ROUND);
    expect(stateOf('c')).toBe(0);
    expect(stateOf('d')).toBe(STATE_DELETED | ROUND);
    const place = internals.placeOf(handle('b'));
    expect(place?.group.gpuState[place.row]).toBe((SHUT | ROUND) & 0xff);
    expect(drawn()).toEqual(['a', 'c']);
  });

  it('writes the bits of handles and of groups without a write mark', () => {
    const { tables, writer, internals, handle, stateOf, drawn } = statesTables();
    const place = internals.placeOf(handle('a'));
    const mark = place?.group.mark;
    const version = place?.group.stateVersion as number;
    const revision = tables.get('layer')?.getDrawnRowsRevision();
    writer.setRowStates(Int32Array.of(handle('a'), handle('c')), MARKED | PICKED, PICKED);
    expect([stateOf('a'), stateOf('c')]).toEqual([PICKED, PICKED]);
    expect(drawn()).toEqual(['a', 'c']);
    writer.setRowStates(Int32Array.of(handle('a')), MARKED, MARKED);
    expect(stateOf('a')).toBe(MARKED | PICKED);
    expect(drawn()).toEqual(['c']);
    writer.setGroupStates(Int32Array.of(50), GROUP_MARK, GROUP_MARK);
    expect(stateOf('c')).toBe(PICKED | GROUP_MARK);
    expect(internals.groups.statesOf(50)).toBe(GROUP_MARK);
    expect(drawn()).toEqual([]);
    expect(place?.group.mark).toBe(mark);
    expect(place?.group.stateVersion).toBeGreaterThan(version);
    expect(tables.get('layer')?.getDrawnRowsRevision()).not.toBe(revision);
  });

  it('gives the members the bits of the flag of their group as it is written', () => {
    const { writer, stateOf } = statesTables();
    writer.writeGroups({ groups: Int32Array.of(50), fields: new Map([['hidden', [true]]]) });
    expect(stateOf('c')).toBe(SHUT_GROUP);
    writer.writeGroups({ groups: Int32Array.of(50), fields: new Map([['locked', [true]]]) });
    expect(stateOf('c')).toBe(SHUT_GROUP);
    writer.writeGroups({ groups: Int32Array.of(50), fields: new Map([['hidden', [false]]]) });
    expect(stateOf('c')).toBe(0);
  });

  it('refuses bits beyond those declared, and declarations of columns of another kind', () => {
    const { writer, handle } = statesTables();
    expect(() => writer.setRowStates(Int32Array.of(handle('a')), 0b100, 0b100)).toThrow(
      KasaneError,
    );
    expect(() => writer.setGroupStates(Int32Array.of(50), MARKED, MARKED)).toThrow(KasaneError);
    expect(() => writer.setGroupStates(Int32Array.of(50), STATE_DELETED, 0)).toThrow(KasaneError);
    expect(() => writer.setGroupStates(Int32Array.of(51), GROUP_MARK, 0)).toThrow(KasaneError);
    expect(() => statesTables({ hiddenMask: STATE_DELETED })).toThrow(KasaneError);
    expect(() =>
      statesTables({ valueStates: { rowFlags: [{ column: 'type', states: SHUT }] } }),
    ).toThrow(KasaneError);
    expect(() =>
      statesTables({ valueStates: { groupFlags: [{ column: 'id', states: SHUT }] } }),
    ).toThrow(KasaneError);
    expect(() =>
      statesTables({
        valueStates: { columnValues: [{ column: 'style', values: [{}], states: SHUT }] },
      }),
    ).toThrow(KasaneError);
    expect(() =>
      statesTables({ valueStates: { rowFlags: [{ column: 'hidden', states: MARKED }] } }),
    ).toThrow(KasaneError);
  });
});
